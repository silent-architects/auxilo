'use strict';
/*
 * scripts/extract-local.js — CLIENT-SIDE learning extraction using the user's OWN model.
 *
 * Auxilo does not pay to extract. At session end, the agent that just did the work
 * (itself an LLM) extracts reusable learnings AND self-screens them for sensitivity,
 * using the local client's model (`claude -p` for Claude Code). Finished learnings are
 * then submitted to POST /learn by the runner. Zero cost to Auxilo.
 *
 * RECURSION SAFETY: `claude -p` starts a headless Claude Code turn, which will itself
 * fire the SessionEnd hook. We set AUXILO_EXTRACTING=1 on the child env so that child's
 * runner no-ops immediately (runner.js checks it). runner.js also sets it in-process
 * before we're called; we set it on the child explicitly as belt-and-suspenders.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  loadIndexForExtraction,
  readExtractionIndex,
  buildPromptMemory,
  filterIndexedNearDuplicates,
  rankIndexRowsForCandidate,
  estimatePromptTokens,
} = require('../lib/extraction-index.js');
const providers = require('./providers/index.js');
const claudeCodeProvider = require('./providers/claude-code.js');

// CI-5 (PUNCH-LIST §30, 2026-07-19): Auxilo is TECHNICAL-ONLY. The learning
// taxonomy is these six tech categories; `communication` and `content-generation`
// are RETIRED — the server 400s them (CATEGORY_OUT_OF_SCOPE) and this extractor
// must never emit them. This file ships standalone in the npm package, so the
// lists are duplicated here from lib/category-scope-migration.js (server truth);
// test/ci5-scope-enforcement.test.js pins the copies equal.
const CATEGORIES = ['data-processing', 'web-interaction', 'code-execution', 'storage-state', 'payment-financial', 'monitoring'];
const PRIVATE_CATEGORIES = [...CATEGORIES, 'non-technical'];
const RETIRED_CATEGORIES = ['communication', 'content-generation'];

/**
 * SPEC3 slice A1 gate — score-at-extraction, ON BY DEFAULT since 0.9.12
 * (CLEAN-LANE-FLIP Phase B). Explicit opt-out only: AUXILO_SCORE_EXTRACTION=0
 * (or 'false') disables scoring; any other value, including unset, scores.
 *
 * ┌─ SEQUENCING CONSTRAINT — SATISFIED (SPEC3-BUILDER-REVIEW-LOOP §3.1/§8) ──┐
 * │ This gate shipped dark (opt-in via AUXILO_SCORE_EXTRACTION=1) because   │
 * │ under a server WITHOUT the B1 extraction-channel hold, a clean /learn    │
 * │ submission carrying a floor-passing quality_self_assessment published   │
 * │ IMMEDIATELY (seamlessEligible) — arming scoring would have silently      │
 * │ flipped hook extraction from "everything held" to "clean items           │
 * │ auto-publish", an unrecorded consent change (2026-06-10 class).          │
 * │                                                                          │
 * │ B1 SHIPPED (lib/clean-lane.js; server.js /learn): every submission       │
 * │ carrying submission_channel:'extraction' (runner.js stamps it            │
 * │ unconditionally) is HELD with reason 'standing_consent_off' unless the   │
 * │ account holds an active standing-consent grant — regardless of the       │
 * │ score. The server brake, not the absence of a score, is what keeps       │
 * │ unconsented items out of the catalog, so default-on scoring is safe:     │
 * │ the score can only move a held item into the ready_to_publish lane (one  │
 * │ counted approve away) or, under an active grant, into the clean lane the │
 * │ contributor explicitly opted into. Without a score every extraction      │
 * │ submission held awaiting_quality forever, so a stock install could never │
 * │ enter the clean lane at all — that was the Phase B defect this closes.   │
 * └──────────────────────────────────────────────────────────────────────────┘
 */
function scoreExtractionEnabled(env = process.env) {
  const raw = env.AUXILO_SCORE_EXTRACTION;
  if (raw === undefined || raw === null) return true;
  const v = String(raw).trim().toLowerCase();
  return !(v === '0' || v === 'false');
}

const EXTRACTION_PROMPT_BASE = `You are extracting reusable OPERATIONAL LEARNINGS from an AI agent's session transcript, to publish to a PUBLIC knowledge marketplace read by other AI agents.

Extract 0 to 5 GENUINE learnings: non-obvious solutions, workarounds, API quirks, error root-causes, integration gotchas — the kind of thing that cost real debugging or combined multiple sources. SKIP trivial lookups, well-documented standard approaches, opinions, and conversation.

HARD SCOPE RULE — TECHNICAL LEARNINGS ONLY (the marketplace accepts nothing else): extract ONLY technical/operational learnings — APIs, developer tools, code, infrastructure, data pipelines, monitoring/observability, payment/crypto TECHNOLOGY, debugging. NEVER extract interpersonal or communication strategy, copywriting/content/marketing insights, business or negotiation strategy, personal matters, or creative-writing technique — DROP such candidates entirely, do not relabel them. A technical learning about a messaging/email/notification API belongs under "web-interaction" or "code-execution"; content/data pipeline TECH belongs under "data-processing".

SYSTEM-FACT TEST (CI-7): Extract ONLY when a system and a symptom are at the core — an error, an undocumented limitation, a reproducible behavior of an external tool/API/OS. If the candidate is advice about how to work (process, workflow, methodology, decision practice), do NOT extract it. "Odesli cannot resolve Tidal artist URLs" is a learning; "use a two-phase consultation workflow" is not, no matter how well it would score.

MANDATORY SENSITIVITY SELF-SCREEN (the marketplace is PUBLIC): NEVER include secrets, credentials, API keys, tokens, private keys, or seed phrases; personal data (real people's names, emails, phone numbers, wallet addresses); private filesystem paths, internal hostnames, or infrastructure identifiers; proprietary, confidential, or client-specific business content. Rewrite specifics into generic placeholders (/Users/USER/..., API_KEY, "a client") or omit them. If a learning cannot be generalized without leaking private material, DROP it entirely.

Output STRICT JSON ONLY — an object with:
  "learnings": an array (possibly empty []) of objects with these keys:
  "title": concise, >= 10 chars
  "body": >= 50 chars — what was tried, what worked, what failed
  "category": one of ${JSON.stringify(CATEGORIES)}
  "tags": array of lowercase keyword strings
  "task_context": one sentence describing the task
  "outcome": one of "success","partial","failure","workaround"
  "dedup_drops": an array (possibly empty []) used ONLY for candidates dropped
  because they match PREVIOUSLY CAPTURED LESSONS. Each entry must be:
    {"candidate": <the complete learning object above>,
     "matched_index_id": "<exact id from the memory list>",
     "matched_title": "<exact matched title>"}
  Scope/quality/sensitivity skips are not dedup_drops.`;

const PUBLIC_SCOPE_BLOCK = `HARD SCOPE RULE — TECHNICAL LEARNINGS ONLY (the marketplace accepts nothing else): extract ONLY technical/operational learnings — APIs, developer tools, code, infrastructure, data pipelines, monitoring/observability, payment/crypto TECHNOLOGY, debugging. NEVER extract interpersonal or communication strategy, copywriting/content/marketing insights, business or negotiation strategy, personal matters, or creative-writing technique — DROP such candidates entirely, do not relabel them. A technical learning about a messaging/email/notification API belongs under "web-interaction" or "code-execution"; content/data pipeline TECH belongs under "data-processing".

SYSTEM-FACT TEST (CI-7): Extract ONLY when a system and a symptom are at the core — an error, an undocumented limitation, a reproducible behavior of an external tool/API/OS. If the candidate is advice about how to work (process, workflow, methodology, decision practice), do NOT extract it. "Odesli cannot resolve Tidal artist URLs" is a learning; "use a two-phase consultation workflow" is not, no matter how well it would score.`;

const PRIVATE_SCOPE_BLOCK = `PRIVATE CAPTURE SCOPE — OWNER-ONLY: extract reusable technical OR non-technical operational learnings. Non-technical process, workflow, communication, content, business, or creative learnings may use category "non-technical"; do not drop a genuine reusable candidate solely because it is non-technical. This private lane is never published unless the owner later sanitizes and promotes an item through public review. The mandatory sensitivity screen still applies without exception.`;

function promptBaseForVisibility(captureVisibility) {
  if (captureVisibility !== 'private') return EXTRACTION_PROMPT_BASE;
  return EXTRACTION_PROMPT_BASE
    .replace(
      "to publish to a PUBLIC knowledge marketplace read by other AI agents.",
      "for the owner's private, owner-only knowledge lane."
    )
    .replace(PUBLIC_SCOPE_BLOCK, PRIVATE_SCOPE_BLOCK)
    .replace(JSON.stringify(CATEGORIES), JSON.stringify(PRIVATE_CATEGORIES));
}

/** A1: rubric addendum — appended ONLY when scoreExtractionEnabled(). */
const QUALITY_RUBRIC_ADDENDUM = `
  "quality_self_assessment": an object scoring the learning honestly on four
  dimensions, each an INTEGER 1-5: "specificity" (precise and detailed, not
  vague), "actionability" (another agent can directly use it), "novelty"
  (non-obvious; an LLM would likely get it wrong), "completeness" (context,
  reproduction steps, caveats), plus "total" (the exact sum of the four).
  A learning worth publishing scores at least 14/20 with no dimension below 3.
  High scores REQUIRE a system+symptom anchor — a named external system and a
  concrete error/limitation/behavior; process or workflow advice cannot score
  high no matter how polished (CI-7 system-fact test).
  If a learning honestly scores below that bar, DROP it from learnings rather
  than inflating the numbers.`;

const PROMPT_SUFFIX = `
No prose, no explanation, no markdown code fences — just the raw JSON object
{"learnings":[...],"dedup_drops":[...]}.

TRANSCRIPT:
`;

/** Build the extraction prompt for the current (or injected) gate state. */
function buildExtractionPrompt(opts = {}) {
  const withScore = opts.scoreExtraction !== undefined
    ? Boolean(opts.scoreExtraction)
    : scoreExtractionEnabled();
  const memory = typeof opts.previousLessonsSection === 'string'
    ? opts.previousLessonsSection
    : '';
  return promptBaseForVisibility(opts.captureVisibility) +
    (withScore ? QUALITY_RUBRIC_ADDENDUM : '') +
    (memory ? `\n\n${memory}` : '') +
    PROMPT_SUFFIX;
}

/** Back-compat export: the default (gate-evaluated-at-call) prompt. */
const EXTRACTION_PROMPT = buildExtractionPrompt({ scoreExtraction: false });

// resolveClaudeBin, claudeChildEnv, checkClaudeAuthStatus, extractWithClaudeCode
// MOVED to scripts/providers/claude-code.js (EXTRACT-PER-CLIENT W1 PART A).
// Re-exported below (module.exports) from claudeCodeProvider — required because
// test/ext-0806b-silent-skip.test.js imports them directly from this module.

/**
 * A1: validate a model-emitted quality_self_assessment. Returns the normalized
 * object, or null when malformed/missing — the caller then OMITS the field
 * entirely (never fabricate; the server's `awaiting_quality` hold is the
 * correct fallback and is deliberately not a 400 — AUD19-6 quarantines rather
 * than bounces).
 */
const QUALITY_DIMENSIONS = ['specificity', 'actionability', 'novelty', 'completeness'];
function validateQualityAssessment(qa) {
  if (!qa || typeof qa !== 'object' || Array.isArray(qa)) return null;
  const out = {};
  let sum = 0;
  for (const dim of QUALITY_DIMENSIONS) {
    const v = qa[dim];
    if (!Number.isInteger(v) || v < 1 || v > 5) return null;
    out[dim] = v;
    sum += v;
  }
  if (!Number.isInteger(qa.total) || qa.total !== sum) return null;
  out.total = sum;
  return out;
}

function extractJsonValue(raw) {
  let s = String(raw || '').trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  try {
    return JSON.parse(s);
  } catch {
    const objectStart = s.indexOf('{');
    const arrayStart = s.indexOf('[');
    const starts = [objectStart, arrayStart].filter((value) => value >= 0);
    if (!starts.length) return null;
    const start = Math.min(...starts);
    const opener = s[start];
    const end = opener === '{' ? s.lastIndexOf('}') : s.lastIndexOf(']');
    if (end < start) return null;
    try {
      return JSON.parse(s.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

/**
 * Normalize model-emitted learning objects.
 * A1: `quality_self_assessment` is attached ONLY when (a) the score gate is on
 * and (b) the assessment validates. Gate OFF strips the field even if emitted.
 */
function normalizeLearningArray(arr, opts = {}) {
  const withScore = opts.scoreExtraction !== undefined
    ? Boolean(opts.scoreExtraction)
    : scoreExtractionEnabled();
  if (!Array.isArray(arr)) return [];
  const shaped = arr
    .filter(l => l && typeof l.title === 'string' && typeof l.body === 'string' && l.title.length >= 10 && l.body.length >= 50);
  // CI-5 post-parse scope validation (defense-in-depth against prompt drift):
  // a candidate whose category is outside the tech set is DROPPED entirely.
  // The old coerce-unknown-to-'code-execution' fallback is gone — coercion
  // would launder a non-tech candidate (e.g. one the model labeled
  // 'communication') into the catalog wearing a tech label. Category-based,
  // so it applies identically in BOTH score-gate states.
  const allowedCategories = opts.captureVisibility === 'private' ? PRIVATE_CATEGORIES : CATEGORIES;
  const inScope = shaped.filter(l => allowedCategories.includes(l.category));
  // Gate-A F5: make the drop observable — count to stderr (never stdout; the
  // hook log captures it) so a silently over-dropping prompt is diagnosable.
  const dropped = shaped.length - inScope.length;
  if (dropped > 0) {
    const scope = opts.captureVisibility === 'private' ? 'private category set' : 'technical category set (CI-5 scope)';
    console.error(`[extract-local] dropped ${dropped} candidate(s) outside the ${scope}`);
  }
  return inScope
    .map(l => {
      const out = {
        title: l.title,
        body: l.body,
        category: l.category,
        tags: Array.isArray(l.tags) ? l.tags.slice(0, 8).map(String) : [],
        task_context: typeof l.task_context === 'string' ? l.task_context : '',
        outcome: ['success', 'partial', 'failure', 'workaround'].includes(l.outcome) ? l.outcome : 'success',
      };
      if (withScore) {
        const qa = validateQualityAssessment(l.quality_self_assessment);
        if (qa) out.quality_self_assessment = qa;
      }
      return out;
    });
}

/**
 * Rev 3 output envelope. Arrays remain accepted for backward compatibility;
 * they simply carry no prompt-memory drop audit rows.
 */
function parseExtractionOutput(raw, opts = {}) {
  const value = extractJsonValue(raw);
  if (Array.isArray(value)) {
    return { learnings: normalizeLearningArray(value, opts), prompt_drops: [] };
  }
  if (!value || typeof value !== 'object' || !Array.isArray(value.learnings)) {
    return { learnings: [], prompt_drops: [] };
  }
  return {
    learnings: normalizeLearningArray(value.learnings, opts),
    prompt_drops: Array.isArray(value.dedup_drops) ? value.dedup_drops : [],
  };
}

function parseLearnings(raw, opts = {}) {
  return parseExtractionOutput(raw, opts).learnings;
}

const DEFAULT_EXTRACT_LOG_PATH = path.join(os.homedir(), '.auxilo', 'extract.log');
const JUDGE_TOP_K = 10;

function loudLocal(opts, message) {
  try {
    (opts.log || console.error)(`[extract-local] ${message}`);
  } catch {
    // Logging failure must not turn dedup into a submission block.
  }
}

function auditText(value, max = 500) {
  return String(value || '').replace(/[\r\n]+/g, ' ').trim().slice(0, max);
}

/**
 * Write the local-only audit row BEFORE honoring a drop. If the audit cannot be
 * written, the caller keeps the candidate (fail-open and nothing vanishes
 * silently). The runner injects its `log` function, which appends this line to
 * ~/.auxilo/extract.log; direct callers fall back to that path here.
 */
function recordDropAudit(candidate, stage, match, opts = {}) {
  const entry = {
    title: auditText(candidate && candidate.title),
    drop_stage: stage,
    matched_index_title: auditText(match && match.title),
    matched_index_id: auditText(match && (match.id || match.matched_index_id)),
  };
  if (!entry.title || !entry.matched_index_title || !entry.matched_index_id) {
    loudLocal(opts, `dedup audit row incomplete at stage=${stage}; keeping candidate`);
    return { ok: false, entry };
  }
  const line = `[dedup-drop] ${JSON.stringify(entry)}`;
  try {
    const sink = opts.auditLog || opts.log;
    if (typeof sink === 'function') {
      sink(line);
    } else {
      fs.mkdirSync(path.dirname(DEFAULT_EXTRACT_LOG_PATH), { recursive: true, mode: 0o700 });
      fs.appendFileSync(
        DEFAULT_EXTRACT_LOG_PATH,
        `[${new Date().toISOString()}] ${line}\n`,
        { encoding: 'utf8', mode: 0o600 }
      );
    }
    return { ok: true, entry };
  } catch (error) {
    loudLocal(opts, `dedup audit write failed at stage=${stage}; keeping candidate: ${error.message}`);
    return { ok: false, entry };
  }
}

function applyPromptMemoryDrops(promptDrops, promptMemory, opts = {}) {
  const byId = new Map(
    (promptMemory.included_rows || []).map((row) => [String(row.id), row])
  );
  const restored = [];
  const dropped = [];
  for (const raw of Array.isArray(promptDrops) ? promptDrops : []) {
    const candidate = normalizeLearningArray([raw && raw.candidate], opts)[0];
    if (!candidate) {
      loudLocal(opts, 'malformed prompt-memory drop audit; no valid candidate payload was available');
      continue;
    }
    const matched = byId.get(String(raw.matched_index_id || ''));
    if (!matched) {
      loudLocal(opts, `prompt-memory drop named an unknown index id; keeping "${candidate.title}"`);
      restored.push(candidate);
      continue;
    }
    const audit = recordDropAudit(candidate, 'prompt_memory', matched, opts);
    if (audit.ok) dropped.push({ candidate, match: matched, audit: audit.entry });
    else restored.push(candidate);
  }
  return { restored, dropped };
}

function buildAnchoredJudgePrompt(candidates, indexRows, opts = {}) {
  const topK = Number.isFinite(opts.topK) ? opts.topK : JUDGE_TOP_K;
  const rankings = candidates.map((candidate) =>
    rankIndexRowsForCandidate(candidate, indexRows, { topK })
  );
  const payload = candidates.map((candidate, index) => ({
    candidate_index: index,
    candidate: {
      title: candidate.title,
      body: candidate.body,
      category: candidate.category,
    },
    previously_captured_top_k: rankings[index].map((row) => ({
      id: row.id,
      title: row.title,
    })),
  }));
  const prompt = `You are a binary deduplication judge for operational learnings.
For each candidate, decide whether it is a re-statement of ANY listed previously
captured lesson. The same operational insight in different words is YES.
A genuinely new fact is NO only when it would change what another agent does.

Return STRICT JSON ONLY:
{"decisions":[{"candidate_index":0,"duplicate":true,"matched_index_id":"..."}]}
Return exactly one decision for every candidate_index. When duplicate=false,
omit matched_index_id. When duplicate=true, matched_index_id MUST be one of that
candidate's listed ids. No prose and no markdown.

${JSON.stringify(payload)}`;
  return { prompt, rankings };
}

// invokeJudgeWithClaudeCode MOVED into scripts/providers/claude-code.js's
// runModel(mode:'judge') (EXTRACT-PER-CLIENT W1 PART A). Not re-exported here —
// grep confirmed no test imports it directly from this module (no dead surface
// carried).
//
// judgeUsage's Claude/Anthropic-specific summing (input_tokens +
// cache_creation_input_tokens + cache_read_input_tokens) moved with it, into
// claude-code.js's normalizeJudgeUsage() — that's the provider-specific half.
// This slimmer, provider-agnostic remainder is what's left once a provider's
// runModel already returns usage normalized to {input_tokens, output_tokens}
// (or null): apply the SAME text-length-estimate fallback the original judgeUsage
// used, generically, for whichever provider ran.
function judgeUsage(usage, prompt, completion) {
  const numeric = usage && typeof usage === 'object' ? usage : {};
  const directInput = Number(numeric.input_tokens) || 0;
  const output = Number(numeric.output_tokens) || 0;
  return {
    prompt_tokens: directInput || estimatePromptTokens(prompt),
    completion_tokens: output || estimatePromptTokens(completion),
  };
}

/**
 * PART C — resolve the extraction_model identity for a runModel result.
 * Prefers the additive `identity` field a provider's runModel result may
 * carry (byo-key.js always sets one: {provider:'byo-key', model, version,
 * vendor}). claude-code.js/codex-cli.js shipped (PART A/B) before this stamp
 * existed and don't set one — rather than touch those provider modules
 * (outside this part's disjoint file scope, AGENTS.md's one-build rule),
 * this falls back to the resolved provider id alone (model/version/vendor
 * null) so every provider gets SOME stamp, never silently none. Best-effort:
 * a resolution failure here must never block extraction itself.
 */
async function resolveExtractionModelIdentity(runModelResult, opts) {
  if (runModelResult && runModelResult.identity && typeof runModelResult.identity === 'object') {
    return runModelResult.identity;
  }
  try {
    const resolved = await providers.resolveProvider(opts);
    if (resolved && resolved.ok && resolved.id) {
      return { provider: resolved.id, model: null, version: null, vendor: null };
    }
  } catch { /* identity is best-effort; never block extraction on it */ }
  return null;
}

/**
 * Default invokeModel (extractLocally) — routes through the resolved provider's
 * runModel(mode:'extract'), mapped back to the legacy {ok, out, reason,
 * reasonCode, authStatus} shape extractLocally's caller already expects. opts
 * (spawnSyncImpl/claudeBin/etc.) thread straight through so the injection
 * pattern used by every extractLocally test still works when a test exercises
 * this default path instead of supplying its own opts.invokeModel.
 */
async function defaultInvokeModel(transcript, invokeOpts, opts) {
  const result = await providers.runModel({
    ...opts,
    prompt: invokeOpts.prompt,
    input: transcript,
    timeoutMs: 120000,
    log: opts.log,
    mode: 'extract',
  });
  return {
    ok: result.ok,
    out: result.text,
    reason: result.reason,
    reasonCode: result.reasonCode,
    authStatus: result.authStatus,
    extractionModel: await resolveExtractionModelIdentity(result, opts),
    ...(result.authDiscrepancy !== undefined && { authDiscrepancy: result.authDiscrepancy }),
  };
}

/**
 * Default invokeJudge (runAnchoredJudge) — routes through the resolved
 * provider's runModel(mode:'judge'), mapped back to the legacy {ok, out, usage,
 * reason} shape runAnchoredJudge already consumes. Same opts thread-through as
 * defaultInvokeModel above.
 */
function defaultInvokeJudge(opts) {
  return async (prompt) => {
    const result = await providers.runModel({
      ...opts,
      prompt,
      timeoutMs: 120000,
      log: opts.log,
      mode: 'judge',
    });
    return { ok: result.ok, out: result.text, usage: result.usage, reason: result.reason };
  };
}

function parseJudgeDecisions(raw, candidates, rankings) {
  const value = extractJsonValue(raw);
  if (!value || typeof value !== 'object' || !Array.isArray(value.decisions) ||
      value.decisions.length !== candidates.length) {
    return { ok: false, reason: 'judge response must contain one decision per candidate' };
  }
  const byIndex = new Map();
  for (const decision of value.decisions) {
    if (!decision || !Number.isInteger(decision.candidate_index) ||
        decision.candidate_index < 0 ||
        decision.candidate_index >= candidates.length ||
        typeof decision.duplicate !== 'boolean' ||
        byIndex.has(decision.candidate_index)) {
      return { ok: false, reason: 'judge response contains an invalid/duplicate candidate_index' };
    }
    if (decision.duplicate) {
      const allowed = rankings[decision.candidate_index];
      const matched = allowed.find(
        (row) => row.id === String(decision.matched_index_id || '')
      );
      if (!matched) {
        return { ok: false, reason: 'judge duplicate decision names an id outside its top-K list' };
      }
      byIndex.set(decision.candidate_index, { duplicate: true, matched });
    } else {
      byIndex.set(decision.candidate_index, { duplicate: false, matched: null });
    }
  }
  return {
    ok: true,
    decisions: candidates.map((_, index) => byIndex.get(index)),
  };
}

async function runAnchoredJudge(candidates, indexState, opts = {}) {
  const input = Array.isArray(candidates) ? candidates : [];
  const empty = {
    kept: input.slice(),
    dropped: [],
    called: false,
    prompt_tokens: 0,
    completion_tokens: 0,
  };
  if (!input.length || !indexState || !indexState.usable ||
      !Array.isArray(indexState.rows) || !indexState.rows.length) {
    return empty;
  }

  const { prompt, rankings } = buildAnchoredJudgePrompt(input, indexState.rows, opts);
  if (rankings.some((rows) => rows.length === 0)) return empty;
  const invokeJudge = typeof opts.invokeJudge === 'function'
    ? opts.invokeJudge
    : defaultInvokeJudge(opts);
  let result;
  try {
    result = await invokeJudge(prompt, { candidates: input, rankings });
  } catch (error) {
    loudLocal(opts, `anchored judge unavailable; keeping all candidates: ${error.message}`);
    return empty;
  }
  if (!result || !result.ok) {
    loudLocal(opts, `anchored judge unavailable; keeping all candidates: ${result && result.reason ? result.reason : 'unknown error'}`);
    return empty;
  }
  const parsed = parseJudgeDecisions(result.out, input, rankings);
  const usage = judgeUsage(result.usage, prompt, result.out);
  if (!parsed.ok) {
    loudLocal(opts, `anchored judge malformed; keeping all candidates: ${parsed.reason}`);
    return { ...empty, called: true, ...usage };
  }

  const kept = [];
  const dropped = [];
  for (let index = 0; index < input.length; index += 1) {
    const decision = parsed.decisions[index];
    if (!decision.duplicate) {
      kept.push(input[index]);
      continue;
    }
    const audit = recordDropAudit(
      input[index],
      'anchored_judge',
      decision.matched,
      opts
    );
    if (audit.ok) {
      dropped.push({
        candidate: input[index],
        match: decision.matched,
        audit: audit.entry,
      });
    } else {
      kept.push(input[index]);
    }
  }
  return { kept, dropped, called: true, ...usage };
}

/**
 * Extract learnings locally. Returns { learnings: [...] } or { learnings: [], skipped }.
 *
 * EXT-GATE: every capture source id runs the client-local extractor. The
 * extractor is transcript-text based (buildExtractionPrompt carries no
 * per-source branch), so nothing here depends on WHICH client captured.
 * Unknown ids still short-circuit: a `--source` value the registry does not
 * know is a misconfigured shim, not a client, and the skip message below is
 * matched by runner.js and test/uc6-codex-capture.test.js — do not change it.
 *
 * The list is static on purpose: lib/installer.js is not in RUNNER_STACK, so
 * this file cannot enumerate the registry at runtime. The closure test
 * (test/ext-gate-closure.test.js) derives the expected set from the two live
 * enumerations — scripts/sources/*.js adapter ids ∪ installer hook-client
 * source ids — and is the authority; a new adapter or hook client that is not
 * added here turns CI red.
 */
const EXTRACTABLE_SOURCE_IDS = Object.freeze([
  'antigravity',
  'claude-code',
  'cline',
  'codex-cli',
  'continue',
  'copilot',
  'cursor',
  'factory',
  'gemini-cli',
  'openclaw',
  'roo-code',
  'windsurf',
]);

// Gate-A 2026-09-05: the exported set is IMMUTABLE. It stays a real Set (same
// name, `.has()` / iteration / `instanceof Set` unchanged) but its own
// add/delete/clear shadow the prototype's and throw, so no importer can widen
// or narrow the allowlist at runtime — the frozen id array above is the only
// source and the closure test is the only authority.
function immutableSet(ids) {
  const set = new Set(ids);
  const refuse = (op) => function () {
    throw new TypeError(`EXTRACTABLE_SOURCES is immutable (${op} refused)`);
  };
  Object.defineProperties(set, {
    add: { value: refuse('add'), writable: false, configurable: false, enumerable: false },
    delete: { value: refuse('delete'), writable: false, configurable: false, enumerable: false },
    clear: { value: refuse('clear'), writable: false, configurable: false, enumerable: false },
  });
  return Object.freeze(set);
}

const EXTRACTABLE_SOURCES = immutableSet(EXTRACTABLE_SOURCE_IDS);

async function extractLocally(transcript, sourceType, opts = {}) {
  if (sourceType && !EXTRACTABLE_SOURCES.has(sourceType)) {
    return { learnings: [], skipped: `local extraction not implemented for "${sourceType}" — agent contributes via auxilo_contribute` };
  }

  const indexOpts = {
    ...(opts.indexPath && { indexPath: opts.indexPath }),
    ...(opts.fsImpl && { fsImpl: opts.fsImpl }),
    ...(opts.fetchImpl && { fetchImpl: opts.fetchImpl }),
    ...(opts.baseUrl && { baseUrl: opts.baseUrl }),
    ...(opts.apiKey && { apiKey: opts.apiKey }),
    log: opts.log || console.error,
  };
  const indexState = await loadIndexForExtraction(indexOpts);
  const promptMemory = indexState.usable
    ? buildPromptMemory(indexState.rows, {
      transcript,
      ...(opts.promptMemoryMaxTokens !== undefined && {
        maxTokens: opts.promptMemoryMaxTokens,
      }),
      ...(opts.promptMemoryMaxRows !== undefined && {
        maxRows: opts.promptMemoryMaxRows,
      }),
    })
    : {
      section: '',
      estimated_tokens: 0,
      included_count: 0,
      included_rows: [],
    };
  const prompt = buildExtractionPrompt({
    previousLessonsSection: promptMemory.section,
    captureVisibility: opts.captureVisibility,
    ...(opts.scoreExtraction !== undefined && { scoreExtraction: opts.scoreExtraction }),
  });
  const invokeModel = typeof opts.invokeModel === 'function'
    ? opts.invokeModel
    : (text, invokeOpts) => defaultInvokeModel(text, invokeOpts, opts);
  const modelResult = await invokeModel(transcript, { prompt });
  const { ok, out, reason } = modelResult;
  if (!ok) {
    return {
      learnings: [],
      skipped: reason,
      ...(modelResult.reasonCode !== undefined && { reasonCode: modelResult.reasonCode }),
      ...(modelResult.authStatus !== undefined && { authStatus: modelResult.authStatus }),
      ...(modelResult.authDiscrepancy !== undefined && {
        authDiscrepancy: modelResult.authDiscrepancy,
      }),
    };
  }
  // PART C: which provider/model actually ran this extraction, stamped onto
  // every learning it produces (below). Absent when the caller supplied its
  // own opts.invokeModel that doesn't report one (every existing test does
  // this) — extraction_model then simply never appears, byte-identical to
  // pre-PART-C behavior.
  const extractionModel = modelResult.extractionModel || null;
  const parsed = parseExtractionOutput(out, opts);
  const promptDropResult = applyPromptMemoryDrops(
    parsed.prompt_drops,
    promptMemory,
    opts
  );
  const candidates = [...parsed.learnings, ...promptDropResult.restored].map((l) => (
    extractionModel ? { ...l, extraction_model: extractionModel } : l
  ));

  // Re-read immediately before the lexical filter. If the index is deleted,
  // becomes unreadable, or is corrupted while the model runs, the filter is
  // disabled and every candidate continues to submission.
  const filterState = readExtractionIndex(indexOpts);
  if (indexState.usable && !filterState.usable) {
    try {
      (opts.log || console.error)(
        `[extract-local] extraction index became ${filterState.state} during extraction; lexical dedup disabled for this run`
      );
    } catch { /* logging cannot block extraction */ }
  }
  const filtered = filterIndexedNearDuplicates(candidates, filterState, indexOpts);
  const lexicalDropped = [];
  const lexicalKept = filtered.kept.slice();
  for (const drop of filtered.dropped) {
    const audit = recordDropAudit(
      drop.candidate,
      'lexical_filter',
      drop.match,
      opts
    );
    if (audit.ok) {
      lexicalDropped.push({ ...drop, audit: audit.entry });
    } else {
      lexicalKept.push(drop.candidate);
    }
  }
  const judged = await runAnchoredJudge(lexicalKept, filterState, opts);
  const allDropped = [
    ...promptDropResult.dropped,
    ...lexicalDropped,
    ...judged.dropped,
  ];
  if (allDropped.length > 0) {
    loudLocal(
      opts,
      `dropped ${allDropped.length} candidate(s): prompt_memory=${promptDropResult.dropped.length}, ` +
      `lexical_filter=${lexicalDropped.length}, anchored_judge=${judged.dropped.length}`
    );
  }
  return {
    learnings: judged.kept,
    dedup_dropped: allDropped.length,
    drop_audit: allDropped.map((drop) => drop.audit),
    prompt_memory_tokens: promptMemory.estimated_tokens,
    prompt_memory_rows: promptMemory.included_count,
    judge_calls: judged.called ? 1 : 0,
    judge_prompt_tokens: judged.prompt_tokens,
    judge_completion_tokens: judged.completion_tokens,
  };
}

module.exports = {
  extractLocally, EXTRACTABLE_SOURCES, EXTRACTABLE_SOURCE_IDS,
  parseLearnings, parseExtractionOutput,
  CATEGORIES, PRIVATE_CATEGORIES, RETIRED_CATEGORIES,
  EXTRACTION_PROMPT, buildExtractionPrompt, scoreExtractionEnabled,
  validateQualityAssessment, QUALITY_DIMENSIONS,
  buildAnchoredJudgePrompt, parseJudgeDecisions, runAnchoredJudge,
  recordDropAudit, JUDGE_TOP_K,
  // Re-exported from scripts/providers/claude-code.js (moved there in PART A) —
  // kept here ONLY because test/ext-0806b-silent-skip.test.js imports these
  // three directly from this module (grep-confirmed; invokeJudgeWithClaudeCode
  // and judgeUsage had no such importer and are NOT carried forward).
  extractWithClaudeCode: claudeCodeProvider.extractWithClaudeCode,
  checkClaudeAuthStatus: claudeCodeProvider.checkClaudeAuthStatus,
  resolveClaudeBin: claudeCodeProvider.resolveClaudeBin,
};
