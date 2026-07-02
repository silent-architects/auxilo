/**
 * lib/similarity.js — LW-14
 *
 * Near-duplicate detection for learning submissions. No external infra:
 * the catalog is a small JSON-file store, so an O(catalog) linear scan with
 * cheap string ops per submission is fine at current scale.
 *
 * Scoring: Jaccard overlap of 3-token shingles over normalized title+body.
 * Texts under SHORT_TEXT_TOKENS tokens fall back to token-set Jaccard
 * (shingle sets are too sparse to be meaningful on very short texts).
 *
 * Thresholds (spec LW-14):
 *   score >= REJECT_THRESHOLD (0.85) → 'reject' (409 at submission)
 *   score >= FLAG_THRESHOLD   (0.60) → 'flag'   (accept, pending_review,
 *                                                possible_duplicate_of)
 *   otherwise                        → 'clean'
 *
 * SCALING CEILING: linear scan. At ~10k+ catalog entries or sustained
 * submission QPS this needs an inverted shingle index or MinHash sketches.
 */

'use strict';

const REJECT_THRESHOLD = 0.85;
const FLAG_THRESHOLD = 0.60;
const SHINGLE_SIZE = 3;
const SHORT_TEXT_TOKENS = 8;

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function shingleSet(tokens) {
  const set = new Set();
  for (let i = 0; i + SHINGLE_SIZE <= tokens.length; i++) {
    set.add(tokens.slice(i, i + SHINGLE_SIZE).join(' '));
  }
  return set;
}

function jaccard(a, b) {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const item of small) if (large.has(item)) inter++;
  return inter / (a.size + b.size - inter);
}

/**
 * Similarity score in [0,1] between two learnings ({title, body}).
 * Shingle Jaccard on title+body; token-set Jaccard fallback for short texts.
 */
function similarityScore(a, b) {
  const tokensA = tokenize(`${a.title || ''} ${a.body || ''}`);
  const tokensB = tokenize(`${b.title || ''} ${b.body || ''}`);
  if (tokensA.length < SHORT_TEXT_TOKENS || tokensB.length < SHORT_TEXT_TOKENS) {
    return jaccard(new Set(tokensA), new Set(tokensB));
  }
  return jaccard(shingleSet(tokensA), shingleSet(tokensB));
}

/**
 * Scan the catalog for a near-duplicate of `candidate`.
 * Compares only same-category, non-rejected entries.
 *
 * @param {{title:string, body:string, category:string}} candidate
 * @param {Array<object>} catalog  existing learnings
 * @param {{rejectThreshold?:number, flagThreshold?:number, excludeId?:string}} [opts]
 * @returns {{verdict:'reject'|'flag'|'clean', match: null|{id:string, similarity:number}}}
 */
function findNearDuplicate(candidate, catalog, opts = {}) {
  const rejectAt = opts.rejectThreshold ?? REJECT_THRESHOLD;
  const flagAt = opts.flagThreshold ?? FLAG_THRESHOLD;

  // Precompute candidate sets once; O(catalog) comparisons after that.
  const candTokens = tokenize(`${candidate.title || ''} ${candidate.body || ''}`);
  const candShort = candTokens.length < SHORT_TEXT_TOKENS;
  const candSet = candShort ? new Set(candTokens) : shingleSet(candTokens);

  let best = null;
  for (const existing of catalog || []) {
    if (!existing || existing.status === 'rejected') continue;
    if (existing.category !== candidate.category) continue;
    if (opts.excludeId && existing.id === opts.excludeId) continue;

    const exTokens = tokenize(`${existing.title || ''} ${existing.body || ''}`);
    let score;
    if (candShort || exTokens.length < SHORT_TEXT_TOKENS) {
      score = jaccard(new Set(candTokens), new Set(exTokens));
    } else {
      score = jaccard(candSet, shingleSet(exTokens));
    }
    if (!best || score > best.similarity) {
      best = { id: existing.id, similarity: score };
    }
  }

  if (!best || best.similarity < flagAt) return { verdict: 'clean', match: best };
  if (best.similarity >= rejectAt) return { verdict: 'reject', match: best };
  return { verdict: 'flag', match: best };
}

module.exports = {
  similarityScore,
  findNearDuplicate,
  tokenize,
  REJECT_THRESHOLD,
  FLAG_THRESHOLD,
  SHINGLE_SIZE,
  SHORT_TEXT_TOKENS,
};
