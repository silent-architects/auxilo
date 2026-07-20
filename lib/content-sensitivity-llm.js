/**
 * lib/content-sensitivity-llm.js — LW-16 LLM semantic-sensitivity layer
 *
 * WHY THIS EXISTS: the regex classifier in lib/content-sensitivity.js only
 * achieves ~78% recall against the 374 confidential learnings that leaked on
 * 2026-06-10. The 82 misses are the "proprietary-context phrased generically"
 * class — content that reveals a specific company/client/person/brand/project,
 * internal strategy, proprietary R&D, security findings, or financials WITHOUT
 * any literal name, email, or path for a regex to latch onto. A regex cannot
 * see that semantically; an LLM can.
 *
 * This module adds a single fast Anthropic call that reads the learning as a
 * strict confidentiality classifier and returns a sensitive/clean verdict. It
 * is COMBINED with the regex layer as a UNION (either flags → review), never a
 * replacement. The combiner lives in combineSensitivity() below.
 *
 * SECURITY BIAS — FAIL CLOSED, ALWAYS:
 *   - On timeout, network error, API error, malformed response, or a MISSING
 *     API key, this returns { sensitive: true, ... }. A broken or unreachable
 *     classifier must HOLD for review, never wave content through. The two error
 *     modes are not symmetric: a false positive costs one extra review click; a
 *     false negative re-causes the mass-publish incident.
 *   - The prompt instructs the model to bias toward sensitive when uncertain.
 *
 * TOGGLE: LLM_SENSITIVITY_ENABLED (default TRUE in prod). When set to the string
 * 'false', isLlmSensitivityEnabled() returns false and callers SKIP the LLM call,
 * falling back to regex-only. Regex-only is NOT leak-safe for auto-publish (it
 * misses ~22% of the confidential class) — the toggle exists for tests and for
 * an ops break-glass, and the gate documents that fallback is not leak-safe.
 *
 * Pure-ish module: the network call is injectable (llmCall param) so unit tests
 * mock it and never hit the real API. The default client reuses the same
 * Anthropic Messages API shape as lib/providers/anthropic.js.
 *
 * @module content-sensitivity-llm
 */

'use strict';

const CONTENT_SENSITIVITY_LLM_VERSION = '1.0.0';

// Small/cheap/fast model — keep latency and cost low. This is a binary
// classification, not generation, so Haiku is the right tool.
const DEFAULT_MODEL = 'claude-haiku-4-5';

// Hard timeout for the classification call. The gate sits in the /learn and
// /extract hot path, so a slow model must not stall the request — it times out
// and FAILS CLOSED (sensitive=true).
const DEFAULT_TIMEOUT_MS = 6000;

// Output token ceiling. The response is a tiny JSON object, so this is generous.
const MAX_TOKENS = 256;

// Bodies can be long; the confidentiality signal is overwhelmingly in the
// opening context, title, and tags. Cap what we send to control cost/latency.
// (A 12k-char window comfortably covers every learning in the corpus.)
const MAX_BODY_CHARS = 12000;

// ─── Prompt ──────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT =
  'You are a strict confidentiality classifier for a PUBLIC knowledge marketplace. ' +
  'Learnings are auto-published to the public internet unless you flag them. ' +
  'Your only job: decide whether a learning is SAFE to publish publicly, or whether ' +
  'it reveals or depends on something confidential.\n\n' +
  'Flag as SENSITIVE (sensitive=true) if the learning reveals or depends on ANY of:\n' +
  '  - a specific, identifiable company, client, customer, employer, person, brand, ' +
  'or named project/product (even if referred to obliquely or by industry, and even ' +
  'when NO literal name, email, handle, or file path is present);\n' +
  '  - internal business strategy, roadmap, pricing strategy, deal terms, partnerships, ' +
  'org/team structure, or go-to-market plans;\n' +
  '  - proprietary or in-house R&D, unreleased techniques, or a competitive moat the ' +
  "author's organization would not want public;\n" +
  '  - security findings, vulnerabilities, threat models, audit results, or infra ' +
  'topology tied to a real system;\n' +
  '  - financials, revenue, costs, margins, forecasts, or compensation;\n' +
  '  - personal data about an identifiable individual.\n\n' +
  'Pass as CLEAN (sensitive=false) ONLY when the learning is genuinely generic, ' +
  'reusable technical knowledge that any engineer could have written about widely-used ' +
  'public tools, APIs, languages, or formats, with no dependence on a specific private ' +
  'company, client, person, or proprietary context. A learning that names only public ' +
  'tech (e.g. Stripe, PostgreSQL, macOS, Google Apps Script) and describes a general ' +
  'technique is CLEAN.\n\n' +
  'CRITICAL BIAS: when you are uncertain, output sensitive=true. Under-flagging ' +
  'publishes private content to the public internet and is unacceptable; over-flagging ' +
  'merely sends a learning to human review. Fail toward sensitive.\n\n' +
  // CI-7 (PUNCH-LIST §30): SECOND verdict in the SAME call — no extra API call,
  // no extra latency. The system-fact test the quality rubric cannot see.
  'SECOND CLASSIFICATION (same response, independent of the confidentiality verdict) — ' +
  'the SYSTEM-FACT TEST: a marketplace learning must be a reusable, verifiable fact ' +
  'about an external system or reproducible technical behavior, anchored to a ' +
  'symptom/error/blocker an agent would SEARCH mid-task. Classify learning_type:\n' +
  '  - "system_fact": a system and a symptom are at the core — an error message, an ' +
  'undocumented limitation, a reproducible behavior of an external tool/API/OS. ' +
  'Example: "Odesli cannot resolve Tidal artist URLs" is a system_fact.\n' +
  '  - "process_advice": advice about how to work — process, workflow, methodology, ' +
  'decision practice, project decision logs, agent-design opinions, best-practice ' +
  'essays. Example: "use a two-phase consultation workflow for mastering" is ' +
  'process_advice, no matter how well-written or highly scored.\n' +
  'If no error message, system limitation, or reproducible behavior is at the core, ' +
  'the learning_type is process_advice.\n\n' +
  'Respond with ONLY a JSON object, no prose, no markdown fences:\n' +
  '{"sensitive": <true|false>, "reason": "<short phrase, <=100 chars>", ' +
  '"confidence": <0.0-1.0>, "learning_type": <"system_fact"|"process_advice">}';

/**
 * Build the user-message text for one learning.
 * @param {string} title
 * @param {string} body
 * @param {string[]} tags
 * @returns {string}
 */
function buildUserMessage(title, body, tags) {
  const safeTitle = typeof title === 'string' ? title : '';
  const safeBody = typeof body === 'string' ? body.slice(0, MAX_BODY_CHARS) : '';
  const safeTags = Array.isArray(tags) ? tags.filter((t) => typeof t === 'string').join(', ') : '';
  return (
    'Classify this learning for confidentiality.\n\n' +
    `TITLE: ${safeTitle}\n\n` +
    `TAGS: ${safeTags}\n\n` +
    `BODY:\n${safeBody}`
  );
}

// ─── Response parsing ────────────────────────────────────────────────────────

/**
 * Parse the model's text into a normalized verdict. Tolerant of markdown fences
 * and surrounding prose. Returns null if no usable verdict can be extracted
 * (caller treats null as fail-closed).
 *
 * @param {string} raw
 * @returns {{ sensitive: boolean, reason: string, confidence: number } | null}
 */
function parseVerdict(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return null;

  let obj = null;
  // Direct parse first.
  try {
    obj = JSON.parse(raw);
  } catch {
    // Fallback: extract the first {...} block.
    const first = raw.indexOf('{');
    const last = raw.lastIndexOf('}');
    if (first !== -1 && last !== -1 && last > first) {
      try {
        obj = JSON.parse(raw.slice(first, last + 1));
      } catch {
        obj = null;
      }
    }
  }

  if (!obj || typeof obj !== 'object' || typeof obj.sensitive !== 'boolean') {
    return null;
  }

  const reason =
    typeof obj.reason === 'string' && obj.reason.length > 0
      ? obj.reason.slice(0, 100)
      : obj.sensitive
        ? 'llm flagged sensitive'
        : 'llm verdict clean';

  let confidence = typeof obj.confidence === 'number' ? obj.confidence : 0.5;
  if (Number.isNaN(confidence)) confidence = 0.5;
  confidence = Math.max(0, Math.min(1, confidence));

  // CI-7: second verdict from the SAME response. Normalized to the two-value
  // enum; anything else (missing field, drift) → null, which the caller treats
  // as "screen did not run" and FAILS CLOSED to a hold (the human is the
  // appeal path — a hold costs one review click, never a bounced fact).
  const learning_type =
    obj.learning_type === 'system_fact' || obj.learning_type === 'process_advice'
      ? obj.learning_type
      : null;

  return { sensitive: obj.sensitive, reason, confidence, learning_type };
}

// ─── Default Anthropic client (injectable) ───────────────────────────────────

/**
 * Default LLM call: a single Anthropic Messages API request with a hard timeout.
 * Mirrors the request shape in lib/providers/anthropic.js. Returns the response
 * text, or throws on any error (caller fails closed).
 *
 * @param {object} params
 * @param {string} params.userMessage
 * @param {string} params.model
 * @param {number} params.timeoutMs
 * @param {string} params.apiKey
 * @returns {Promise<string>} response text
 */
async function defaultLlmCall({ userMessage, model, timeoutMs, apiKey }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: MAX_TOKENS,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userMessage }],
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Anthropic API error ${res.status}: ${errText.slice(0, 200)}`);
    }
    const data = await res.json();
    const text = data && data.content && data.content[0] && data.content[0].text;
    if (typeof text !== 'string') {
      throw new Error('Anthropic response missing content text');
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Public: isLlmSensitivityEnabled ─────────────────────────────────────────

/**
 * Whether the LLM layer is enabled. Default TRUE (prod). Disabled ONLY when
 * LLM_SENSITIVITY_ENABLED is exactly the string 'false'. When disabled, callers
 * fall back to regex-only — which is NOT leak-safe for auto-publish.
 *
 * @param {object} [env] - defaults to process.env (injectable for tests)
 * @returns {boolean}
 */
function isLlmSensitivityEnabled(env = process.env) {
  return env.LLM_SENSITIVITY_ENABLED !== 'false';
}

// ─── Public: classifySensitivityLLM ──────────────────────────────────────────

/**
 * Classify a learning's CONTENT for confidentiality using an LLM.
 *
 * FAILS CLOSED on every error path: missing API key, timeout, network/API error,
 * or an unparseable response all yield { sensitive: true, ... }.
 *
 * @param {string} title
 * @param {string} body
 * @param {string[]} [tags]
 * @param {object} [opts]
 * @param {function} [opts.llmCall] - async ({userMessage, model, timeoutMs, apiKey}) => string.
 *        Injected in tests so the real API is never hit. Defaults to defaultLlmCall.
 * @param {string}   [opts.apiKey]  - defaults to process.env.ANTHROPIC_API_KEY
 * @param {string}   [opts.model]   - defaults to DEFAULT_MODEL (claude-haiku-4-5)
 * @param {number}   [opts.timeoutMs] - defaults to DEFAULT_TIMEOUT_MS (6000)
 * @returns {Promise<{ sensitive: boolean, reason: string, confidence: number }>}
 */
async function classifySensitivityLLM(title, body, tags, opts = {}) {
  const apiKey = opts.apiKey !== undefined ? opts.apiKey : process.env.ANTHROPIC_API_KEY;
  const model = opts.model || DEFAULT_MODEL;
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const llmCall = opts.llmCall || defaultLlmCall;

  // Missing API key → fail closed (never fail open).
  if (!apiKey) {
    return {
      sensitive: true,
      reason: 'llm unavailable: ANTHROPIC_API_KEY not configured (fail-closed)',
      confidence: 1,
    };
  }

  const userMessage = buildUserMessage(title, body, tags);

  try {
    const raw = await llmCall({ userMessage, model, timeoutMs, apiKey });
    const verdict = parseVerdict(raw);
    if (!verdict) {
      // Unparseable → fail closed.
      return {
        sensitive: true,
        reason: 'llm response unparseable (fail-closed)',
        confidence: 1,
      };
    }
    return verdict;
  } catch (err) {
    // Timeout / network / API error → fail closed.
    const isAbort = err && (err.name === 'AbortError' || /abort/i.test(err.message || ''));
    return {
      sensitive: true,
      reason: isAbort
        ? `llm timeout after ${timeoutMs}ms (fail-closed)`
        : `llm error: ${(err && err.message ? err.message : String(err)).slice(0, 80)} (fail-closed)`,
      confidence: 1,
    };
  }
}

// ─── Public: combineSensitivity ──────────────────────────────────────────────

/**
 * Combine the regex verdict and the LLM verdict into the final gate verdict.
 *
 * UNION semantics: sensitive when EITHER layer flags. The regex is the cheap
 * first pass; when it already flags, the LLM can be SHORT-CIRCUITED (skipped) to
 * save cost — pass llm=null/undefined to indicate "not consulted". But when the
 * regex says clean, the LLM MUST have run before auto-approve, so a clean-regex +
 * absent-llm combination is treated as fail-closed (sensitive=true): we never
 * auto-approve on regex-clean without an LLM verdict (unless the LLM layer is
 * explicitly disabled — that decision is the caller's, and it's documented as
 * NOT leak-safe).
 *
 * sensitivity_source records which layer(s) flagged: 'regex' | 'llm' | 'both' |
 * 'none'. When llmConsulted is false because the LLM layer is DISABLED, source is
 * 'regex' (regex-only fallback) and the union is just the regex verdict.
 *
 * @param {object} params
 * @param {{ sensitive: boolean, signals?: string[] }} params.regex - regex verdict (required)
 * @param {{ sensitive: boolean, reason?: string, confidence?: number } | null} [params.llm]
 *        - LLM verdict, or null when the LLM was not consulted.
 * @param {boolean} [params.llmEnabled=true] - whether the LLM layer is enabled.
 *        When false, a null llm means "intentionally skipped" (regex-only fallback),
 *        NOT fail-closed.
 * @returns {{ sensitive: boolean, sensitivity_source: 'regex'|'llm'|'both'|'none',
 *            sensitivity_signals: string[], llm_reason: string|null,
 *            llm_confidence: number|null }}
 */
function combineSensitivity({ regex, llm, llmEnabled = true }) {
  const regexSensitive = !!(regex && regex.sensitive);
  const regexSignals = (regex && Array.isArray(regex.signals)) ? regex.signals.slice() : [];

  let llmSensitive = false;
  let llmReason = null;
  let llmConfidence = null;
  // CI-7: second verdict from the same LLM call. null = "not judged" — because
  // the LLM was short-circuited (regex already flagged → item holds anyway),
  // disabled (regex-only fallback; screen degrades with the layer, same class
  // as sensitivity), errored (fail-closed sensitive=true holds the item), or
  // the model omitted the field (caller fails closed to a hold).
  let learningType = null;

  if (llm) {
    llmSensitive = !!llm.sensitive;
    llmReason = typeof llm.reason === 'string' ? llm.reason : null;
    llmConfidence = typeof llm.confidence === 'number' ? llm.confidence : null;
    if (llm.learning_type === 'system_fact' || llm.learning_type === 'process_advice') {
      learningType = llm.learning_type;
    }
  } else if (llmEnabled && !regexSensitive) {
    // Regex clean AND LLM enabled but NOT consulted → we must not auto-approve
    // without an LLM verdict. Fail closed.
    llmSensitive = true;
    llmReason = 'llm enabled but not consulted on regex-clean content (fail-closed)';
    llmConfidence = 1;
  }
  // else: llm absent because regex already flagged (short-circuit) OR the LLM
  // layer is disabled (regex-only fallback) → no synthetic LLM flag.

  const sensitive = regexSensitive || llmSensitive;

  let source = 'none';
  if (regexSensitive && llmSensitive) source = 'both';
  else if (regexSensitive) source = 'regex';
  else if (llmSensitive) source = 'llm';

  // Compose the recorded signals: the regex signal names plus an explicit
  // 'llm_semantic' marker when the LLM is what flagged.
  const sensitivity_signals = regexSignals.slice();
  if (llmSensitive && !sensitivity_signals.includes('llm_semantic')) {
    sensitivity_signals.push('llm_semantic');
  }

  return {
    sensitive,
    sensitivity_source: source,
    sensitivity_signals,
    llm_reason: llmReason,
    llm_confidence: llmConfidence,
    // CI-7: 'system_fact' | 'process_advice' | null (null = not judged; the
    // caller's screen fails closed to a hold only when the LLM ran clean).
    learning_type: learningType,
  };
}

module.exports = {
  classifySensitivityLLM,
  combineSensitivity,
  isLlmSensitivityEnabled,
  // exported for tests / introspection
  parseVerdict,
  buildUserMessage,
  SYSTEM_PROMPT,
  DEFAULT_MODEL,
  DEFAULT_TIMEOUT_MS,
  CONTENT_SENSITIVITY_LLM_VERSION,
};
