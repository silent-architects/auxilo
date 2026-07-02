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
 * That loop is what makes background extraction safe to re-enable: nothing the
 * contributor extracted goes public until they personally approve it here.
 */

const DEFAULT_BASE_URL = 'https://api.auxilo.io';

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

module.exports = {
  DEFAULT_BASE_URL,
  fetchPending,
  submitDecision,
  formatFlags,
};
