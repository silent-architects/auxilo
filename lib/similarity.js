/**
 * lib/similarity.js — LW-14
 *
 * Near-duplicate detection for learning submissions. No external infra:
 * the catalog is a small JSON-file store, so an O(catalog) linear scan with
 * cheap string ops per submission is fine at current scale.
 *
 * Detection is deterministic and zero-inference. The original 3-token shingle
 * channel remains, and SPEC3-F1 adds the frozen Phase-0 near-verbatim composite:
 * normalized-token TF cosine plus unigram and title corroborators.
 *
 * A match is a HOLD signal only. This module never returns an auto-reject
 * verdict; callers persist the contributor-only evidence and land the learning
 * in pending_review.
 *
 * SCALING CEILING: linear scan. At ~10k+ catalog entries or sustained
 * submission QPS this needs an inverted shingle index or MinHash sketches.
 */

'use strict';

const DISABLED_NEAR_VERBATIM_CONFIG = Object.freeze({
  SHINGLE_FLAG_THRESHOLD: 0.60,
  UNIGRAM_FLAG_THRESHOLD: Number.POSITIVE_INFINITY,
  TF_COSINE_FLAG_THRESHOLD: Number.POSITIVE_INFINITY,
  TITLE_FLAG_THRESHOLD: Number.POSITIVE_INFINITY,
  COMPOSITE_FLAG_THRESHOLD: Number.POSITIVE_INFINITY,
  CONTENT_WEIGHT: 1,
  TITLE_WEIGHT: 0,
});

function loadNearDuplicateConfig(
  load = () => require('../config/near-duplicate.json'),
  log = console.error,
) {
  try {
    const loaded = load();
    const required = [
      'SHINGLE_FLAG_THRESHOLD',
      'UNIGRAM_FLAG_THRESHOLD',
      'TF_COSINE_FLAG_THRESHOLD',
      'TITLE_FLAG_THRESHOLD',
      'COMPOSITE_FLAG_THRESHOLD',
      'CONTENT_WEIGHT',
      'TITLE_WEIGHT',
    ];
    if (required.some((key) => typeof loaded[key] !== 'number' ||
        !Number.isFinite(loaded[key]))) {
      throw new Error('all near-duplicate config values must be finite numbers');
    }
    return Object.freeze({ ...loaded });
  } catch (error) {
    // RUNBOOK 2026-07-26: a config data failure must not block submissions.
    // Retain the longstanding shingle hold and loudly disable only the new
    // near-verbatim channel.
    log(
      `[BOOT] near-duplicate config unavailable; TF/composite channel disabled: ${error.message}`,
    );
    return DISABLED_NEAR_VERBATIM_CONFIG;
  }
}

const NEAR_DUPLICATE_CONFIG = loadNearDuplicateConfig();

// Retained for the Phase-0 current-algorithm diagnosis. Runtime detection is
// hold-only and does not use the legacy reject threshold.
const REJECT_THRESHOLD = 0.85;
const FLAG_THRESHOLD = NEAR_DUPLICATE_CONFIG.SHINGLE_FLAG_THRESHOLD;
const TF_COSINE_FLAG_THRESHOLD = NEAR_DUPLICATE_CONFIG.TF_COSINE_FLAG_THRESHOLD;
const COMPOSITE_FLAG_THRESHOLD = NEAR_DUPLICATE_CONFIG.COMPOSITE_FLAG_THRESHOLD;
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

function combinedText(learning) {
  return `${learning.title || ''} ${learning.body || ''}`;
}

function tokenSet(text) {
  return new Set(tokenize(text));
}

function unigramJaccard(a, b) {
  return jaccard(tokenSet(combinedText(a)), tokenSet(combinedText(b)));
}

function termFrequency(tokens) {
  const counts = new Map();
  for (const token of tokens) counts.set(token, (counts.get(token) || 0) + 1);
  return counts;
}

function cosineFromTermFrequencies(aTf, bTf) {
  if (aTf.size === 0 || bTf.size === 0) return 0;

  let aNorm = 0;
  let bNorm = 0;
  for (const value of aTf.values()) aNorm += value * value;
  for (const value of bTf.values()) bNorm += value * value;

  let dot = 0;
  const [small, large] = aTf.size <= bTf.size ? [aTf, bTf] : [bTf, aTf];
  for (const [token, value] of small) dot += value * (large.get(token) || 0);
  return dot / Math.sqrt(aNorm * bNorm);
}

function tfCosine(a, b) {
  return cosineFromTermFrequencies(
    termFrequency(tokenize(combinedText(a))),
    termFrequency(tokenize(combinedText(b))),
  );
}

function titleJaccard(a, b) {
  return jaccard(tokenSet(a.title || ''), tokenSet(b.title || ''));
}

function calibrateCosine(cosine) {
  if (cosine <= 0) return 0;
  if (cosine >= 1) return 1;
  return cosine / (2 - cosine);
}

function scoreChannels(a, b) {
  const d1 = similarityScore(a, b);
  const d2 = unigramJaccard(a, b);
  const d3 = tfCosine(a, b);
  const d4 = titleJaccard(a, b);
  const content = Math.max(d1, d2, calibrateCosine(d3));
  const composite = Math.max(
    content,
    (NEAR_DUPLICATE_CONFIG.CONTENT_WEIGHT * content) +
      (NEAR_DUPLICATE_CONFIG.TITLE_WEIGHT * d4),
  );
  return { d1, d2, d3, d4, content, composite };
}

function prepareLearning(learning) {
  const combinedTokens = tokenize(combinedText(learning));
  const short = combinedTokens.length < SHORT_TEXT_TOKENS;
  return {
    learning,
    combinedTokens,
    shingleOrTokenSet: short
      ? new Set(combinedTokens)
      : shingleSet(combinedTokens),
    short,
    unigramSet: new Set(combinedTokens),
    termFrequency: termFrequency(combinedTokens),
    titleSet: tokenSet(learning.title || ''),
  };
}

function scorePrepared(a, b) {
  const d1 = (a.short || b.short)
    ? jaccard(new Set(a.combinedTokens), new Set(b.combinedTokens))
    : jaccard(a.shingleOrTokenSet, b.shingleOrTokenSet);
  const d2 = jaccard(a.unigramSet, b.unigramSet);
  const d3 = cosineFromTermFrequencies(a.termFrequency, b.termFrequency);
  const d4 = jaccard(a.titleSet, b.titleSet);
  const content = Math.max(d1, d2, calibrateCosine(d3));
  const composite = Math.max(
    content,
    (NEAR_DUPLICATE_CONFIG.CONTENT_WEIGHT * content) +
      (NEAR_DUPLICATE_CONFIG.TITLE_WEIGHT * d4),
  );
  return { d1, d2, d3, d4, content, composite };
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
 * Scan the full catalog for a near-verbatim match of `candidate`.
 * Rejected and cross-category predecessors are intentionally included.
 *
 * @param {{title:string, body:string, category:string}} candidate
 * @param {Array<object>} catalog  existing learnings
 * @param {{flagThreshold?:number, tfCosineThreshold?:number,
 *   compositeThreshold?:number, excludeId?:string}} [opts]
 * @returns {{verdict:'flag'|'clean', match: null|object}}
 */
function findNearDuplicate(candidate, catalog, opts = {}) {
  const flagAt = opts.flagThreshold ?? FLAG_THRESHOLD;
  const tfCosineAt = opts.tfCosineThreshold ?? TF_COSINE_FLAG_THRESHOLD;
  const compositeAt = opts.compositeThreshold ?? COMPOSITE_FLAG_THRESHOLD;
  const candidatePrepared = prepareLearning(candidate);

  let best = null;
  for (const existing of catalog || []) {
    if (!existing) continue;
    if (opts.excludeId && existing.id === opts.excludeId) continue;

    const channels = scorePrepared(candidatePrepared, prepareLearning(existing));
    const shingleFlagged = channels.d1 >= flagAt;
    if (!best || channels.composite > best.similarity ||
        (channels.composite === best.similarity &&
          String(existing.id).localeCompare(String(best.id)) < 0)) {
      best = {
        id: existing.id,
        status: existing.status || null,
        category: existing.category || null,
        similarity: channels.composite,
        channel: shingleFlagged ? 'shingle' : 'near_verbatim',
        channels,
      };
    }
  }

  if (!best) return { verdict: 'clean', match: null };
  const flagged = best.channels.d1 >= flagAt ||
    best.channels.d3 >= tfCosineAt ||
    best.channels.composite >= compositeAt;
  if (!flagged) return { verdict: 'clean', match: best };
  return { verdict: 'flag', match: best };
}

module.exports = {
  similarityScore,
  findNearDuplicate,
  tokenize,
  tokenSet,
  jaccard,
  setJaccard: jaccard,
  unigramJaccard,
  termFrequency,
  tfCosine,
  titleJaccard,
  calibrateCosine,
  scoreChannels,
  prepareLearning,
  scorePrepared,
  NEAR_DUPLICATE_CONFIG,
  DISABLED_NEAR_VERBATIM_CONFIG,
  loadNearDuplicateConfig,
  REJECT_THRESHOLD,
  FLAG_THRESHOLD,
  TF_COSINE_FLAG_THRESHOLD,
  COMPOSITE_FLAG_THRESHOLD,
  SHINGLE_SIZE,
  SHORT_TEXT_TOKENS,
};
