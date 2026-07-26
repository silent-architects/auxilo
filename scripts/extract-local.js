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
} = require('../lib/extraction-index.js');

// CI-5 (PUNCH-LIST §30, 2026-07-19): Auxilo is TECHNICAL-ONLY. The learning
// taxonomy is these six tech categories; `communication` and `content-generation`
// are RETIRED — the server 400s them (CATEGORY_OUT_OF_SCOPE) and this extractor
// must never emit them. This file ships standalone in the npm package, so the
// lists are duplicated here from lib/category-scope-migration.js (server truth);
// test/ci5-scope-enforcement.test.js pins the copies equal.
const CATEGORIES = ['data-processing', 'web-interaction', 'code-execution', 'storage-state', 'payment-financial', 'monitoring'];
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

Output STRICT JSON ONLY — an array (possibly empty []) of objects with these keys:
  "title": concise, >= 10 chars
  "body": >= 50 chars — what was tried, what worked, what failed
  "category": one of ${JSON.stringify(CATEGORIES)}
  "tags": array of lowercase keyword strings
  "task_context": one sentence describing the task
  "outcome": one of "success","partial","failure","workaround"`;

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
  If a learning honestly scores below that bar, DROP it from the array rather
  than inflating the numbers.`;

const PROMPT_SUFFIX = `
No prose, no explanation, no markdown code fences — just the raw JSON array.

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
  return EXTRACTION_PROMPT_BASE +
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

/**
 * Defensively parse a JSON array of learnings out of model output.
 * A1: `quality_self_assessment` is attached ONLY when (a) the score gate is on
 * (opts.scoreExtraction, default = env AUXILO_SCORE_EXTRACTION) AND (b) the
 * assessment validates. Gate OFF strips the field even if the model emits one,
 * so a dark 0.9.3 client can never arm seamless publish (see the sequencing
 * constraint at scoreExtractionEnabled).
 */
function parseLearnings(raw, opts = {}) {
  const withScore = opts.scoreExtraction !== undefined
    ? Boolean(opts.scoreExtraction)
    : scoreExtractionEnabled();
  let s = String(raw || '').trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const start = s.indexOf('[');
  const end = s.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) return [];
  let arr;
  try { arr = JSON.parse(s.slice(start, end + 1)); } catch (_) { return []; }
  if (!Array.isArray(arr)) return [];
  const shaped = arr
    .filter(l => l && typeof l.title === 'string' && typeof l.body === 'string' && l.title.length >= 10 && l.body.length >= 50);
  // CI-5 post-parse scope validation (defense-in-depth against prompt drift):
  // a candidate whose category is outside the tech set is DROPPED entirely.
  // The old coerce-unknown-to-'code-execution' fallback is gone — coercion
  // would launder a non-tech candidate (e.g. one the model labeled
  // 'communication') into the catalog wearing a tech label. Category-based,
  // so it applies identically in BOTH score-gate states.
  const inScope = shaped.filter(l => CATEGORIES.includes(l.category));
  // Gate-A F5: make the drop observable — count to stderr (never stdout; the
  // hook log captures it) so a silently over-dropping prompt is diagnosable.
  const dropped = shaped.length - inScope.length;
  if (dropped > 0) console.error(`[extract-local] dropped ${dropped} candidate(s) outside the technical category set (CI-5 scope)`);
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
 * Extract learnings locally. Returns { learnings: [...] } or { learnings: [], skipped }.
 * Only claude-code has a local extractor today; other clients rely on the agent's
 * proactive auxilo_contribute (MCP) call.
 */
async function extractLocally(transcript, sourceType, opts = {}) {
  if (sourceType && sourceType !== 'claude-code') {
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
    : { section: '', estimated_tokens: 0, included_count: 0 };
  const prompt = buildExtractionPrompt({
    previousLessonsSection: promptMemory.section,
    ...(opts.scoreExtraction !== undefined && { scoreExtraction: opts.scoreExtraction }),
  });
  const invokeModel = typeof opts.invokeModel === 'function'
    ? opts.invokeModel
    : (text, invokeOpts) => extractWithClaudeCode(text, invokeOpts);
  const { ok, out, reason } = await invokeModel(transcript, { prompt });
  if (!ok) return { learnings: [], skipped: reason };
  const parsed = parseLearnings(out, opts);

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
  const filtered = filterIndexedNearDuplicates(parsed, filterState, indexOpts);
  if (filtered.dropped.length > 0) {
    try {
      (opts.log || console.error)(
        `[extract-local] dropped ${filtered.dropped.length} candidate(s) matching the local extraction index`
      );
    } catch { /* logging cannot block extraction */ }
  }
  return {
    learnings: filtered.kept,
    dedup_dropped: filtered.dropped.length,
    prompt_memory_tokens: promptMemory.estimated_tokens,
    prompt_memory_rows: promptMemory.included_count,
  };
}

module.exports = {
  extractLocally, parseLearnings, resolveClaudeBin, CATEGORIES, RETIRED_CATEGORIES,
  EXTRACTION_PROMPT, buildExtractionPrompt, scoreExtractionEnabled,
  validateQualityAssessment, QUALITY_DIMENSIONS,
};
