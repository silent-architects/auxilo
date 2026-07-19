'use strict';

/**
 * lib/review.js — LW-15 `auxilo review` network layer
 *
 * Pure network functions for the contributor self-review queue. Mirrors the
 * `recordConsent` shape in lib/installer.js: X-API-Key auth, injectable
 * fetchImpl for hermetic tests, throws on non-2xx. No stdin, no home-directory
 * access, no filesystem — the binding layer (bin/auxilo-cli.js) supplies the
 * real home, fetch, and prompts.
 *
 *   extract -> pending_review -> `auxilo review` (this) -> approve/reject
 *
 * That loop is what keeps background extraction safe to leave on: anything a
 * platform screen flags stays 'pending_review' (out of the public catalog)
 * until the contributor personally approves it here. Clean extractions publish
 * seamlessly with a 7-day retraction window and never enter this queue; manual
 * mode (account settings) routes every draft through it instead.
 */

const DEFAULT_BASE_URL = 'https://auxilo.io';

function normBase(baseUrl) {
  return (baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

/**
 * GET /account/pending — fetch the caller's own pending_review learnings.
 *
 * @param {object} opts
 * @param {string} opts.apiKey
 * @param {string} [opts.baseUrl]
 * @param {number} [opts.limit]
 * @param {number} [opts.offset]
 * @param {Function} [opts.fetchImpl]
 * @returns {Promise<{account_id:string, pending_count:number, limit:number, offset:number, learnings:object[]}>}
 */
async function fetchPending(opts = {}) {
  const { apiKey } = opts;
  if (!apiKey) throw new Error('fetchPending: apiKey is required');
  const baseUrl = normBase(opts.baseUrl);
  const fetchImpl = opts.fetchImpl || fetch;

  const qs = new URLSearchParams();
  if (opts.limit != null) qs.set('limit', String(opts.limit));
  if (opts.offset != null) qs.set('offset', String(opts.offset));
  const suffix = qs.toString() ? `?${qs}` : '';

  const res = await fetchImpl(`${baseUrl}/account/pending${suffix}`, {
    method: 'GET',
    headers: { 'X-API-Key': apiKey },
  });
  let body = {};
  try { body = await res.json(); } catch { /* non-JSON error body */ }
  if (!res.ok) {
    throw new Error(`Fetch pending failed (HTTP ${res.status}): ${body.error || 'unknown error'}`);
  }
  return body;
}

/**
 * POST /account/pending/:id/approve|reject — submit a self-review decision.
 *
 * @param {object} opts
 * @param {string} opts.apiKey
 * @param {string} opts.id
 * @param {'approve'|'reject'} opts.decision
 * @param {string} [opts.reason]    only sent on reject
 * @param {string} [opts.baseUrl]
 * @param {Function} [opts.fetchImpl]
 * @returns {Promise<object>} server response body
 */
async function submitDecision(opts = {}) {
  const { apiKey, id, decision, reason } = opts;
  if (!apiKey) throw new Error('submitDecision: apiKey is required');
  if (!id) throw new Error('submitDecision: id is required');
  if (decision !== 'approve' && decision !== 'reject') {
    throw new Error('submitDecision: decision must be "approve" or "reject"');
  }
  const baseUrl = normBase(opts.baseUrl);
  const fetchImpl = opts.fetchImpl || fetch;

  const init = {
    method: 'POST',
    headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
  };
  // reject accepts an optional reason; approve takes no body.
  if (decision === 'reject') {
    init.body = JSON.stringify(reason ? { reason } : {});
  }

  const res = await fetchImpl(`${baseUrl}/account/pending/${encodeURIComponent(id)}/${decision}`, init);
  let body = {};
  try { body = await res.json(); } catch { /* non-JSON error body */ }
  if (!res.ok) {
    throw new Error(`${decision} failed for ${id} (HTTP ${res.status}): ${body.error || 'unknown error'}`);
  }
  return body;
}

/**
 * Render a one-line safety-flag summary for a pending learning, or '' if clean.
 * Shared by the CLI's interactive and --list views so the human always sees the
 * injection / near-duplicate signals before deciding.
 *
 * @param {object} l  a projected pending learning
 * @returns {string}
 */
function formatFlags(l) {
  const parts = [];
  if (Array.isArray(l.injection_flags) && l.injection_flags.length > 0) {
    const ids = l.injection_flags.map((f) => f.pattern_id || f.pattern || 'flag').join(', ');
    parts.push(`injection: ${ids}`);
  }
  if (l.possible_duplicate_of) {
    const sim = l.possible_duplicate_similarity != null ? ` (${l.possible_duplicate_similarity})` : '';
    parts.push(`possible duplicate of ${l.possible_duplicate_of}${sim}`);
  }
  return parts.join(' · ');
}

// ── Review-seamless additions (2026-07-18) ──────────────────────────────────
//
// Summary + bulk network calls, plus the pure approve-clean selection logic
// shared by the CLI, the MCP auxilo_review tool, and the triage report script.
// One selection implementation everywhere, so what a dry run PRINTS is exactly
// what a confirmed run DOES.

/** Server-enforced max decisions per bulk call; clients chunk at this size. */
const BULK_CHUNK = 100;

/** Default approve-clean quality threshold (repo quality gate: total >= 14/20). */
const DEFAULT_QUALITY_THRESHOLD = 14;

/**
 * GET /account/pending/summary: compact triage rows + counts (no bodies).
 *
 * @param {object} opts  { apiKey, baseUrl?, fetchImpl? }
 * @returns {Promise<object>} summary body (pending_count, clean_count, items, ...)
 */
async function fetchPendingSummary(opts = {}) {
  const { apiKey } = opts;
  if (!apiKey) throw new Error('fetchPendingSummary: apiKey is required');
  const baseUrl = normBase(opts.baseUrl);
  const fetchImpl = opts.fetchImpl || fetch;

  const res = await fetchImpl(`${baseUrl}/account/pending/summary`, {
    method: 'GET',
    headers: { 'X-API-Key': apiKey },
  });
  let body = {};
  try { body = await res.json(); } catch { /* non-JSON error body */ }
  if (!res.ok) {
    throw new Error(`Fetch pending summary failed (HTTP ${res.status}): ${body.error || 'unknown error'}`);
  }
  return body;
}

/**
 * POST /account/pending/bulk: submit ONE chunk of decisions (<= BULK_CHUNK).
 * confirm_count is set to decisions.length here because by the time this is
 * called, the human-facing layer has already shown the exact list and count
 * and received the operator's counted confirmation. This function never
 * invents decisions; it transmits what was confirmed.
 *
 * @param {object} opts  { apiKey, decisions, baseUrl?, fetchImpl? }
 * @returns {Promise<object>} server response (counts + per-id results)
 */
async function submitBulk(opts = {}) {
  const { apiKey, decisions } = opts;
  if (!apiKey) throw new Error('submitBulk: apiKey is required');
  if (!Array.isArray(decisions) || decisions.length === 0) {
    throw new Error('submitBulk: decisions must be a non-empty array');
  }
  if (decisions.length > BULK_CHUNK) {
    throw new Error(`submitBulk: at most ${BULK_CHUNK} decisions per call (use chunkDecisions)`);
  }
  const baseUrl = normBase(opts.baseUrl);
  const fetchImpl = opts.fetchImpl || fetch;

  const res = await fetchImpl(`${baseUrl}/account/pending/bulk`, {
    method: 'POST',
    headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ decisions, confirm_count: decisions.length }),
  });
  let body = {};
  try { body = await res.json(); } catch { /* non-JSON error body */ }
  if (!res.ok) {
    throw new Error(`Bulk review failed (HTTP ${res.status}): ${body.error || 'unknown error'}`);
  }
  return body;
}

/** Split an array into chunks of at most `size` (default BULK_CHUNK). */
function chunkDecisions(list, size = BULK_CHUNK) {
  const n = Math.max(1, size);
  const out = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
}

/**
 * Submit decisions through the bulk endpoint in sequential chunks, aggregating
 * counts and per-id results. onChunk (optional) is called after each chunk for
 * progress rendering. A failed chunk stops the run (already-applied chunks
 * stay applied; the endpoint is idempotent per id, so re-running is safe).
 *
 * @param {object} opts  { apiKey, decisions, baseUrl?, fetchImpl?, onChunk? }
 * @returns {Promise<{approved:number, rejected:number, idempotent:number, failed:number, results:Array<object>}>}
 */
async function submitBulkChunked(opts = {}) {
  const { decisions } = opts;
  const totals = { approved: 0, rejected: 0, idempotent: 0, failed: 0, results: [] };
  const chunks = chunkDecisions(decisions || []);
  for (let i = 0; i < chunks.length; i++) {
    const resp = await submitBulk({ ...opts, decisions: chunks[i] });
    totals.approved += resp.approved || 0;
    totals.rejected += resp.rejected || 0;
    totals.idempotent += resp.idempotent || 0;
    totals.failed += resp.failed || 0;
    if (Array.isArray(resp.results)) totals.results.push(...resp.results);
    if (typeof opts.onChunk === 'function') {
      opts.onChunk({ chunkIndex: i, chunkCount: chunks.length, chunkSize: chunks[i].length, response: resp });
    }
  }
  return totals;
}

/** True when a summary row's quality clears the threshold (threshold <= 0 accepts unscored). */
function qualityClears(row, minQuality) {
  if (minQuality <= 0) return true;
  return row.quality != null && row.quality >= minQuality;
}

/**
 * THE approve-clean selection. Operates on summary rows (screens_passed,
 * flags, quality) from GET /account/pending/summary.
 *
 * mode 'clean' (approve-clean): screens_passed AND quality >= minQuality.
 * mode 'all': every row EXCEPT screens-flagged ones unless includeFlagged
 * is set; no quality gate.
 *
 * Returns the selection plus what was excluded and why, so every confirmation
 * surface can show the operator the exact consequences before anything runs.
 *
 * @param {Array<object>} rows
 * @param {object} [opts]  { mode: 'clean'|'all', minQuality, includeFlagged }
 * @returns {{selected:Array<object>, excluded_flagged:Array<object>, excluded_low_quality:Array<object>, excluded_unscored:Array<object>, min_quality:number|null}}
 */
function selectForBulkApprove(rows, opts = {}) {
  const mode = opts.mode === 'all' ? 'all' : 'clean';
  const minQuality = mode === 'clean'
    ? (Number.isFinite(opts.minQuality) ? opts.minQuality : DEFAULT_QUALITY_THRESHOLD)
    : null;
  const includeFlagged = mode === 'all' && opts.includeFlagged === true;

  const selected = [];
  const excluded_flagged = [];
  const excluded_low_quality = [];
  const excluded_unscored = [];

  for (const row of rows || []) {
    if (!row || !row.id) continue;
    if (!row.screens_passed && !includeFlagged) {
      excluded_flagged.push(row);
      continue;
    }
    if (mode === 'clean' && !qualityClears(row, minQuality)) {
      (row.quality == null ? excluded_unscored : excluded_low_quality).push(row);
      continue;
    }
    selected.push(row);
  }

  return { selected, excluded_flagged, excluded_low_quality, excluded_unscored, min_quality: minQuality };
}

module.exports = {
  DEFAULT_BASE_URL,
  BULK_CHUNK,
  DEFAULT_QUALITY_THRESHOLD,
  fetchPending,
  submitDecision,
  formatFlags,
  fetchPendingSummary,
  submitBulk,
  chunkDecisions,
  submitBulkChunked,
  qualityClears,
  selectForBulkApprove,
};
