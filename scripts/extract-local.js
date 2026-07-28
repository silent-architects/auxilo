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
const { spawnSync } = require('child_process');
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
 * SPEC3 slice A1 gate — score-at-extraction, BUILT BUT DARK by default.
 *
 * ┌─ CRITICAL SEQUENCING CONSTRAINT (SPEC3-BUILDER-REVIEW-LOOP §3.1/§8) ──────┐
 * │ Under a server WITHOUT the B1 extraction-channel hold, a clean /learn     │
 * │ submission carrying a floor-passing quality_self_assessment publishes    │
 * │ IMMEDIATELY (seamlessEligible). Turning this gate on against such a      │
 * │ server silently flips hook extraction from "everything held" to "clean   │
 * │ items auto-publish" — an unrecorded consent change (2026-06-10 class).   │
 * │ Do NOT set AUXILO_SCORE_EXTRACTION=1 until the server holds              │
 * │ submission_channel:'extraction' items behind standing consent (B1).      │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
function scoreExtractionEnabled(env = process.env) {
  return env.AUXILO_SCORE_EXTRACTION === '1';
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

/** Resolve the `claude` binary — hook/launchd env may have a minimal PATH. */
function resolveClaudeBin() {
  const candidates = [
    'claude',
    path.join(os.homedir(), '.claude', 'local', 'claude'),
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
    path.join(os.homedir(), '.local', 'bin', 'claude'),
  ];
  for (const c of candidates) {
    try {
      if (c === 'claude') return c; // let PATH resolve it; spawn will ENOENT if absent
      if (fs.existsSync(c)) return c;
    } catch (_) { /* ignore */ }
  }
  return 'claude';
}

/**
 * Invoke the local Claude Code model headlessly (uses the USER's subscription auth).
 * Prompt+transcript go via stdin. Returns { ok, out, reason } — never throws, so the
 * SessionEnd hook degrades gracefully (the proactive auxilo_contribute path is the
 * reliable primary; this deterministic hook is best-effort).
 */
function extractWithClaudeCode(transcript, opts = {}) {
  const bin = resolveClaudeBin();
  const prompt = typeof opts.prompt === 'string'
    ? opts.prompt
    : buildExtractionPrompt({
      previousLessonsSection: opts.previousLessonsSection,
      captureVisibility: opts.captureVisibility,
      ...(opts.scoreExtraction !== undefined && { scoreExtraction: opts.scoreExtraction }),
    });
  const input = prompt + String(transcript).slice(0, 200000);
  // Do NOT pass ANTHROPIC_API_KEY through — we want the user's logged-in Claude
  // subscription (OAuth), not an API key (which would bill someone). Delete it.
  const childEnv = { ...process.env, AUXILO_EXTRACTING: '1' };
  delete childEnv.ANTHROPIC_API_KEY;
  const res = spawnSync(bin, ['-p'], { input, encoding: 'utf-8', env: childEnv, timeout: 120000, maxBuffer: 20 * 1024 * 1024 });
  const out = String(res.stdout || '');
  if (res.error) return { ok: false, out: '', reason: `spawn failed (${bin}): ${res.error.message}` };
  // Claude prints auth failures ("API Error: 401 ... Please run /login") to stdout.
  if (/Please run \/login|authentication_error|401/i.test(out) || /Please run \/login|authentication_error/i.test(String(res.stderr || ''))) {
    return { ok: false, out, reason: 'local model not authenticated in this context (run `claude` and /login once); skipping deterministic extraction' };
  }
  if (res.status !== 0) return { ok: false, out, reason: `local model exited ${res.status}: ${(out || String(res.stderr || '')).slice(0, 160)}` };
  return { ok: true, out, reason: null };
}

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

function judgeUsage(usage, prompt, completion) {
  const numeric = usage && typeof usage === 'object' ? usage : {};
  const directInput = Number(numeric.input_tokens) || 0;
  const cacheCreation = Number(numeric.cache_creation_input_tokens) || 0;
  const cacheRead = Number(numeric.cache_read_input_tokens) || 0;
  const output = Number(numeric.output_tokens) || 0;
  return {
    prompt_tokens: directInput + cacheCreation + cacheRead ||
      estimatePromptTokens(prompt),
    completion_tokens: output || estimatePromptTokens(completion),
  };
}

function invokeJudgeWithClaudeCode(prompt) {
  const bin = resolveClaudeBin();
  const childEnv = { ...process.env, AUXILO_EXTRACTING: '1' };
  delete childEnv.ANTHROPIC_API_KEY;
  const res = spawnSync(
    bin,
    ['-p', '--output-format', 'json', '--no-session-persistence', '--tools', ''],
    {
      input: prompt,
      encoding: 'utf8',
      env: childEnv,
      timeout: 120000,
      maxBuffer: 20 * 1024 * 1024,
    }
  );
  const stdout = String(res.stdout || '');
  if (res.error) {
    return { ok: false, out: '', reason: `judge spawn failed (${bin}): ${res.error.message}` };
  }
  if (/Please run \/login|authentication_error|401/i.test(stdout) ||
      /Please run \/login|authentication_error/i.test(String(res.stderr || ''))) {
    return { ok: false, out: '', reason: 'local judge model is not authenticated' };
  }
  if (res.status !== 0) {
    return {
      ok: false,
      out: '',
      reason: `local judge exited ${res.status}: ${(stdout || String(res.stderr || '')).slice(0, 160)}`,
    };
  }
  let wrapper;
  try {
    wrapper = JSON.parse(stdout);
  } catch {
    return { ok: false, out: '', reason: 'local judge returned malformed JSON wrapper' };
  }
  if (!wrapper || typeof wrapper.result !== 'string' || wrapper.is_error === true) {
    return { ok: false, out: '', reason: 'local judge returned no successful result' };
  }
  return { ok: true, out: wrapper.result, usage: wrapper.usage || null, reason: null };
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
    : invokeJudgeWithClaudeCode;
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
 * Claude Code and Codex rollout captures use the existing client-local Claude
 * extractor; other clients rely on the agent's proactive auxilo_contribute
 * (MCP) call.
 */
const EXTRACTABLE_SOURCES = new Set(['claude-code', 'codex-cli']);

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
    : (text, invokeOpts) => extractWithClaudeCode(text, invokeOpts);
  const { ok, out, reason } = await invokeModel(transcript, { prompt });
  if (!ok) return { learnings: [], skipped: reason };
  const parsed = parseExtractionOutput(out, opts);
  const promptDropResult = applyPromptMemoryDrops(
    parsed.prompt_drops,
    promptMemory,
    opts
  );
  const candidates = [...parsed.learnings, ...promptDropResult.restored];

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
  extractLocally, parseLearnings, parseExtractionOutput, resolveClaudeBin,
  CATEGORIES, PRIVATE_CATEGORIES, RETIRED_CATEGORIES,
  EXTRACTION_PROMPT, buildExtractionPrompt, scoreExtractionEnabled,
  validateQualityAssessment, QUALITY_DIMENSIONS,
  buildAnchoredJudgePrompt, parseJudgeDecisions, runAnchoredJudge,
  recordDropAudit, invokeJudgeWithClaudeCode, JUDGE_TOP_K,
};
