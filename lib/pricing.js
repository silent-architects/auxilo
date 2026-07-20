'use strict';

/**
 * lib/pricing.js — Dynamic Pricing Engine (v2)
 *
 * Implements the full v2 pricing formula from PRICING-STRATEGY-V2.md:
 *
 *   base_price = (token_cost_saved + time_value_saved) × uniqueness × quality
 *   current_price = base_price × demand × freshness × rating
 *
 * Bounds:
 *   floor: max(base × 0.5, $0.05)
 *   ceiling: min(base × 3.0, $50.00)
 *
 * All multipliers are transparent and debuggable.
 */

// ─── Price Constants ──────────────────────────────────────────────────────────

const MIN_UNLOCK_PRICE = 0.05;   // minimum viable learning price
const MAX_UNLOCK_PRICE = 50.00;  // above this, hire a consultant

// ─── Category/Complexity Token Cost Table (V2 Section 1) ─────────────────────

const CATEGORY_BASE_COST = {
  'web-interaction':   { simple: 0.05, moderate: 0.30, complex: 1.50 },
  'code-execution':    { simple: 0.08, moderate: 0.50, complex: 3.00 },
  'data-processing':   { simple: 0.05, moderate: 0.40, complex: 2.00 },
  // CI-5 (2026-07-19): 'communication' and 'content-generation' are RETIRED
  // learning categories (technical-only scope; lib/category-scope-migration.js).
  // No NEW item can be born with these labels — /learn 400s them — but the
  // store retains non-visible historical items (rejected/retracted audit
  // record) wearing them, and the daily cron may price over stored items.
  // The rows are KEPT, frozen, so legacy items never silently alias onto the
  // web-interaction fallback table (a price shift with no product benefit).
  'communication':     { simple: 0.03, moderate: 0.20, complex: 1.00 },
  'storage-state':     { simple: 0.05, moderate: 0.35, complex: 2.00 },
  'content-generation':{ simple: 0.10, moderate: 0.60, complex: 3.00 },
  'payment-financial': { simple: 0.08, moderate: 0.50, complex: 5.00 },
  'monitoring':        { simple: 0.05, moderate: 0.30, complex: 1.50 },
};

// Time value saved per complexity tier (V2 Section 1, Component 2)
const TIME_VALUE_SAVED = {
  simple: 0.04,
  moderate: 0.30,
  complex: 1.20,
};

// ─── Complexity Classification (V2 Section 1) ────────────────────────────────

/**
 * Classify a learning as simple | moderate | complex.
 * Uses quality_self_assessment scores + body length.
 */
function classifyComplexity(learning) {
  const qa = learning.quality_self_assessment;
  if (!qa) return 'moderate';
  const total = (qa.specificity || 0) + (qa.actionability || 0) + (qa.novelty || 0) + (qa.completeness || 0);
  const bodyLength = (learning.body || '').length;
  if (total <= 10 && bodyLength < 500) return 'simple';
  if (total >= 16 && bodyLength > 2000) return 'complex';
  return 'moderate';
}

// ─── Uniqueness Multiplier (V2 Section 1, Component 3) ───────────────────────
// PRICING-DENSITY (2026-07-19, Tyler-ratified): the uniqueness premium is
// density-gated. In a sparse catalog everything is "first of its kind", so the
// 3.0x premium was vacuous — 100% of the 58-item shelf carried it and 52/58
// failed calculateVerdict as "expensive" (CAT-1 catalog-health pass). Premium
// tiers (> SPARSE_CAP) now apply only when uniqueness is informative:
//   (a) the visible catalog has reached MIN_MARKET_SIZE items, AND
//   (b) the item has >= MIN_TAG_NEIGHBORS same-category visible items sharing
//       at least one tag — real comparables to be unique AGAINST.
// The gate is a pure function of (catalog size, neighbor count) — no dates, no
// flags — so it self-relaxes as the catalog grows. Spec:
// ~/.auxilo/handoffs/BUILD-SPEC-PRICING-DENSITY-2026-07-19.md

const DENSITY_GATE = {
  MIN_MARKET_SIZE: 200,   // visible catalog items required before premium tiers apply
  MIN_TAG_NEIGHBORS: 3,   // same-category visible items sharing >= 1 tag (mirrors the >=3-ratings corroboration convention)
  SPARSE_CAP: 1.5,        // max uniqueness multiplier while the gate is closed
};

/**
 * Market-visibility predicate — mirrors server.js visibleCatalog() (S21-2/LW-QA):
 * legacy items without a status field are treated as approved. Pending/rejected/
 * retracted items are not purchasable, so they are not market density and must
 * not open the gate, count as neighbors, or count as similar.
 */
function isMarketVisible(l) {
  return !!l && (!l.status || l.status === 'approved');
}

/**
 * Count same-category market-visible learnings sharing >= 1 normalized tag
 * (excluding the learning itself). This is the "comparables exist" evidence
 * that makes a zero similar-count informative: any >=0.4-tag-Jaccard similar
 * item necessarily shares a tag, so similar ⊂ neighbor — neighbors capture the
 * band below near-duplicate where genuine uniqueness is measured.
 *
 * @param {object} learning
 * @param {object[]} market - pre-filtered visible catalog
 * @returns {number} neighbor count
 */
function countTagNeighbors(learning, market) {
  if (!market || market.length === 0) return 0;
  const myTags = new Set((learning.tags || []).map(t => String(t).toLowerCase()));
  if (myTags.size === 0) return 0;

  let neighbors = 0;
  for (const other of market) {
    if (other.id === learning.id) continue;
    if (other.category !== learning.category) continue;
    // F2 (Gate-A 2026-07-19): same-contributor items can never OPEN the gate.
    // Attack: post-200, a contributor submits 3 one-shared-tag fillers in their
    // category (tag-Jaccard ~0.14 — under the 0.4 similarity threshold),
    // self-approves, and the whole cluster earns the 3.0x premium. Exclusion is
    // ONE-DIRECTIONAL by design: own items still count as SIMILAR in
    // countSimilarLearnings (self-duplicates keep LOWERING premiums), they just
    // never count as the independent comparables that justify raising one.
    // Truthiness guards keep anonymous items (no account, no wallet) matching
    // nothing — null never equals null here.
    if ((learning.contributor_account_id &&
         other.contributor_account_id === learning.contributor_account_id) ||
        (learning.contributor_wallet &&
         other.contributor_wallet === learning.contributor_wallet)) continue;
    const otherTags = (other.tags || []);
    if (otherTags.some(t => myTags.has(String(t).toLowerCase()))) neighbors++;
  }
  return neighbors;
}

/**
 * Density-gated uniqueness: premium tiers (above SPARSE_CAP) require a dense
 * catalog AND real tag-neighbors; the gate only ever caps, never raises.
 *
 * @param {number} similarCount  - same-category items with >=0.4 tag-Jaccard
 * @param {number} marketSize    - count of market-visible catalog items
 * @param {number} neighborCount - same-category visible items sharing >=1 tag
 * @returns {number} effective uniqueness multiplier
 */
function effectiveUniquenessMultiplier(similarCount, marketSize, neighborCount) {
  const raw = uniquenessMultiplier(similarCount);
  if (raw <= DENSITY_GATE.SPARSE_CAP) return raw;
  if (marketSize >= DENSITY_GATE.MIN_MARKET_SIZE &&
      neighborCount >= DENSITY_GATE.MIN_TAG_NEIGHBORS) {
    return raw;
  }
  return DENSITY_GATE.SPARSE_CAP;
}

/**
 * Count learnings with 40%+ Jaccard tag overlap in the same category.
 */
function countSimilarLearnings(learning, catalog) {
  if (!catalog || catalog.length === 0) return 0;
  const myTags = new Set((learning.tags || []).map(t => t.toLowerCase()));
  if (myTags.size === 0) return 0;

  let similar = 0;
  for (const other of catalog) {
    if (other.id === learning.id) continue;
    if (other.category !== learning.category) continue;
    const otherTags = new Set((other.tags || []).map(t => t.toLowerCase()));
    if (otherTags.size === 0) continue;
    const intersection = [...myTags].filter(t => otherTags.has(t)).length;
    const union = new Set([...myTags, ...otherTags]).size;
    const jaccard = union > 0 ? intersection / union : 0;
    if (jaccard >= 0.4) similar++;
  }
  return similar;
}

function uniquenessMultiplier(similarCount) {
  if (similarCount === 0)        return 3.0;  // First of its kind
  if (similarCount <= 3)         return 2.0;  // Rare
  if (similarCount <= 10)        return 1.0;  // Normal
  return 0.5;                                 // Commodity
}

// ─── Quality Multiplier (V2 Section 1, Component 4) ──────────────────────────

function calculateQualityMultiplier(learning) {
  const qa = learning.quality_self_assessment;
  const selfScore = qa ? (((qa.total || 0) / 20)) : 0.6;
  const communityScore = ((learning.quality && learning.quality.avg_helpfulness) || 2.5) / 5;
  const hasRatings = ((learning.quality && learning.quality.ratings) || 0) >= 3;
  const blend = hasRatings
    ? (selfScore * 0.4) + (communityScore * 0.6)
    : selfScore;
  return 0.6 + (blend * 0.9); // Range: 0.6x - 1.5x
}

// ─── Base Price Calculation (V2 Section 1, Full Formula) ─────────────────────

/**
 * Calculate the base price for a learning using the V2 value-based formula.
 * This is set at submission and recalculated weekly.
 *
 * @param {object} learning - The learning object
 * @param {object[]} catalog - Array of all learnings (for uniqueness calculation)
 * @returns {number} base_price in USD
 */
function calculateLearningPrice(learning, catalog) {
  const complexity = classifyComplexity(learning);
  const category = learning.category || 'web-interaction';

  // Component 1: Token cost saved
  const categoryTable = CATEGORY_BASE_COST[category] || CATEGORY_BASE_COST['web-interaction'];
  const tokenCostSaved = categoryTable[complexity] || categoryTable.moderate;

  // Component 2: Time value saved
  const timeValueSaved = TIME_VALUE_SAVED[complexity] || TIME_VALUE_SAVED.moderate;

  // Component 3: Uniqueness — density-gated (PRICING-DENSITY 2026-07-19).
  // All three inputs are computed over the market-visible catalog only:
  // pending/rejected/retracted items are not purchasable, so they are not
  // density, not neighbors, and not similar.
  const market = (catalog || []).filter(isMarketVisible);
  const similarCount = countSimilarLearnings(learning, market);
  const neighborCount = countTagNeighbors(learning, market);
  const uniqueness = effectiveUniquenessMultiplier(similarCount, market.length, neighborCount);

  // Component 4: Quality
  const quality = calculateQualityMultiplier(learning);

  const basePrice = (tokenCostSaved + timeValueSaved) * uniqueness * quality;

  // Clamp: min $0.05, max $50.00
  return Number(Math.max(MIN_UNLOCK_PRICE, Math.min(MAX_UNLOCK_PRICE, basePrice)).toFixed(6));
}

// ─── Dynamic Axes (V2 Section 2) ─────────────────────────────────────────────

/**
 * Demand multiplier using sigmoid curve (V2 Section 2, Axis 1).
 * Range: 0.75 - 1.25
 */
function calculateDemandMultiplier(learning, catalog) {
  const recentUnlocks = (learning.demand && learning.demand.unlocks_7d) || 0;

  // Category average unlock rate (per learning per 7 days)
  const category = learning.category;
  let categoryAvgRate = 0.5; // default if no data
  if (catalog && catalog.length > 0) {
    const inCategory = catalog.filter(l => l.category === category && l.demand);
    if (inCategory.length > 0) {
      categoryAvgRate = Math.max(0.5,
        inCategory.reduce((sum, l) => sum + ((l.demand && l.demand.unlocks_7d) || 0), 0) / inCategory.length
      );
    }
  }

  const velocityRatio = recentUnlocks / categoryAvgRate;

  // Sigmoid: asymptotes at 0.75x (cold) and 1.25x (hot)
  const raw = 1.0 + 0.25 * ((2 / (1 + Math.exp(-1.5 * (velocityRatio - 1)))) - 1);
  return Math.max(0.75, Math.min(1.25, raw));
}

/**
 * Freshness multiplier using age brackets (V2 Section 2, Axis 2).
 */
function calculateFreshnessMultiplier(learning) {
  if (!learning.created_at) return 1.0;
  const ageDays = (Date.now() - new Date(learning.created_at).getTime()) / 86400000;
  if (ageDays < 7)   return 1.25; // First week premium
  if (ageDays < 14)  return 1.15;
  if (ageDays < 30)  return 1.05;
  if (ageDays > 365) return 0.85; // Stale discount
  if (ageDays > 180) return 0.95;
  return 1.0;
}

/**
 * Rating multiplier triggered after 3+ community ratings (V2 Section 2, Axis 3).
 */
function calculateRatingMultiplier(learning) {
  if (!learning.quality || (learning.quality.ratings || 0) < 3) return 1.0;
  const avg = learning.quality.avg_helpfulness || 0;
  if (avg >= 4.5) return 1.10;
  if (avg >= 4.0) return 1.05;
  if (avg < 2.0)  return 0.70;
  if (avg < 2.5)  return 0.85;
  return 1.0;
}

// ─── Full Current Price (V2 Section 2, Complete Formula) ─────────────────────

/**
 * Calculate current_price with all multipliers applied.
 * Uses the stored base_price if available; falls back to calculateLearningPrice.
 *
 * @param {object} learning
 * @param {object[]} catalog - Array of all learnings
 * @returns {number} current_price in USD
 */
function getCurrentPrice(learning, catalog) {
  // PRICING-DENSITY base refresh (2026-07-19): when a catalog is supplied and
  // the learning has a stored base_price, re-derive the base through the full
  // (density-gated) formula instead of trusting the submission-time snapshot.
  // This implements the module header's "recalculated weekly" contract via the
  // existing daily cron — which passes the catalog and applies its 15%/day
  // move cap — so existing items CONVERGE to gated prices with no shock.
  // Request-path callers short-circuit on stored pricing.current_price before
  // reaching this function, so the recompute branch is cron-only in practice.
  // Items WITHOUT a pricing object keep the unlock_price short-circuit: they
  // are live-quoted with no cron damping, so the gate must never instantly
  // reprice them (their formula path stays gated for genuinely computed cases).
  const hasCatalog = Array.isArray(catalog) && catalog.length > 0;
  const base = (hasCatalog && learning.pricing && learning.pricing.base_price)
    ? calculateLearningPrice(learning, catalog)
    : ((learning.pricing && learning.pricing.base_price)
      || learning.unlock_price
      || calculateLearningPrice(learning, catalog));

  const demand  = calculateDemandMultiplier(learning, catalog);
  const fresh   = calculateFreshnessMultiplier(learning);
  const rating  = calculateRatingMultiplier(learning);

  let price = base * demand * fresh * rating;

  // Enforce bounds relative to base
  price = Math.max(base * 0.5, price);    // Never below 50% of base
  price = Math.min(base * 3.0, price);    // Never above 300% of base

  // Global floor and ceiling
  price = Math.max(MIN_UNLOCK_PRICE, price);
  price = Math.min(MAX_UNLOCK_PRICE, price);

  // Rounding: sub-cent precision below $0.10, cent precision above
  return price < 0.10
    ? Math.round(price * 1000) / 1000
    : Math.round(price * 100) / 100;
}

// ─── DIY-cost + normalized quality (buyer value signal) ──────────────────────

/**
 * Estimate the DIY cost an agent avoids by unlocking this learning instead of
 * re-deriving it: token cost saved + time value saved, keyed off complexity and
 * category (V2 Section 1, Components 1+2). This is the same quantity calculateVerdict
 * compares price against — exported so the search-result value_signal reports a real
 * positive number instead of the never-written token_cost_estimate/time_value_estimate.
 *
 * @param {object} learning
 * @returns {number} estimated DIY cost in USD (always > 0 for a known category)
 */
function estimateDiyCost(learning) {
  const complexity = classifyComplexity(learning);
  const category = (learning && learning.category) || 'web-interaction';
  const categoryTable = CATEGORY_BASE_COST[category] || CATEGORY_BASE_COST['web-interaction'];
  const tokenCostSaved = categoryTable[complexity] || categoryTable.moderate;
  const timeValueSaved = TIME_VALUE_SAVED[complexity] || TIME_VALUE_SAVED.moderate;
  return Number((tokenCostSaved + timeValueSaved).toFixed(6));
}

/**
 * Normalized 0–1 quality score for the buyer value signal. calculateQualityMultiplier
 * returns 0.6–1.5 (self-assessment blended with community ratings once 3+ exist); this
 * maps that onto [0,1] so the search-result quality_score is a real number instead of
 * the never-written pricing.quality_multiplier (which always resolved to null).
 *
 * @param {object} learning
 * @returns {number} quality score in [0, 1]
 */
function qualityScore01(learning) {
  const mult = calculateQualityMultiplier(learning); // 0.6 – 1.5
  const norm = (mult - 0.6) / 0.9;                    // → 0 – 1
  return Number(Math.max(0, Math.min(1, norm)).toFixed(4));
}

// ─── Verdict (V2 Section 7B) ──────────────────────────────────────────────────

/**
 * Calculate the buyer verdict for a learning.
 * Compares current_price to estimated DIY cost.
 *
 * @param {object} learning
 * @returns {'strong_buy' | 'recommended' | 'consider' | 'expensive'}
 */
function calculateVerdict(learning) {
  const diyCost = estimateDiyCost(learning);

  const currentPrice = (learning.pricing && learning.pricing.current_price) || learning.unlock_price || 0;

  if (currentPrice === 0) return 'recommended';

  const ratio = currentPrice / diyCost;

  if (ratio < 0.3)  return 'strong_buy';   // Less than 30% of DIY cost — obvious win
  if (ratio < 0.75) return 'recommended';  // Less than 75% — clear value
  if (ratio < 1.5)  return 'consider';     // Within 1.5x of DIY — borderline
  return 'expensive';                       // More than 1.5x DIY — overprice signal
}

// ─── Legacy Functions (preserved for backward compatibility) ─────────────────

/**
 * Token cost factor: proxy for tokens saved by reading vs re-deriving.
 * ~1000 chars ≈ 250 tokens ≈ $0.002 saved
 * @deprecated Use calculateLearningPrice() instead
 */
function tokenCostFactor(bodyLength) {
  return (bodyLength / 1000) * 0.002;
}

/**
 * Time value factor: how much time the outcome type typically saves.
 * @deprecated Use calculateLearningPrice() instead
 */
function timeValueFactor(outcome) {
  const map = { success: 0.01, workaround: 0.02, failure: 0.005, partial: 0.008 };
  return map[outcome] || 0.01;
}

/**
 * Uniqueness multiplier based on category scarcity in catalog stats object.
 * @deprecated Use calculateLearningPrice() with full catalog array instead
 */
function uniquenessFactor(category, catalogStats) {
  if (!catalogStats || !catalogStats.total || catalogStats.total === 0) return 1.0;
  const categoryCount = (catalogStats.categoryCounts && catalogStats.categoryCounts[category]) || 0;
  const scarcity = 1 - (categoryCount / catalogStats.total);
  return 1.0 + (0.1 * scarcity);
}

/**
 * Quality multiplier: based on quality score (0-5).
 * @deprecated Use calculateQualityMultiplier() instead
 */
function qualityFactor(qualityScore) {
  const score = Math.max(0, Math.min(5, qualityScore || 0));
  return score / 10 + 0.5;
}

/**
 * Demand factor: based on total unlock count.
 * @deprecated Use calculateDemandMultiplier() instead
 */
function demandFactor(unlocksLast24h) {
  return 1.0 + (0.05 * (unlocksLast24h || 0));
}

/**
 * Freshness factor: loses 50% value over 6 months, floors at 0.5.
 * @deprecated Use calculateFreshnessMultiplier() instead
 */
function freshnessFactor(createdAt) {
  if (!createdAt) return 1.0;
  const ageMs = Date.now() - new Date(createdAt).getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  return Math.max(0.5, 1.0 - (ageDays / 180));
}

/**
 * Compute the raw dynamic price for a learning (legacy formula).
 * @deprecated Use calculateLearningPrice() for new learnings
 */
function computeDynamicPrice(learning, catalogStats) {
  const body = learning.body || '';
  const outcome = learning.outcome || 'success';
  const category = learning.category || '';
  const qScore = (learning.quality && learning.quality.score) || 0;
  const unlocks24h = (learning.quality && learning.quality.unlocks) || 0;
  const created = learning.created_at;

  const base = tokenCostFactor(body.length) + timeValueFactor(outcome);
  const price = base
    * uniquenessFactor(category, catalogStats)
    * qualityFactor(qScore)
    * demandFactor(unlocks24h)
    * freshnessFactor(created);

  return price;
}

/**
 * Compute the final clamped price for a learning (legacy, uses catalogStats shape).
 * Falls back gracefully for learnings without a pricing.base_price.
 */
function computeCurrentPrice(learning, catalogStats) {
  // Prefer the new-style pricing object if available
  if (learning.pricing && learning.pricing.base_price) {
    return getCurrentPrice(learning, null);
  }
  // Legacy path: use old factor-based formula
  const dynamicPrice = computeDynamicPrice(learning, catalogStats);
  const contributorPrice = learning.unlock_price || 0;
  const rawPrice = Math.max(contributorPrice, dynamicPrice);
  return Math.round(Math.max(MIN_UNLOCK_PRICE, Math.min(MAX_UNLOCK_PRICE, rawPrice)) * 10000) / 10000;
}

// ─── Price-Lock Cache ─────────────────────────────────────────────────────────

const priceLockCache = new Map(); // learning_id → { price, locked_at }
const PRICE_LOCK_TTL = 300_000;   // 5 minutes

function getLockedPrice(learningId) {
  const entry = priceLockCache.get(learningId);
  if (entry && Date.now() - entry.locked_at < PRICE_LOCK_TTL) return entry.price;
  return null;
}

function lockPrice(learningId, price) {
  priceLockCache.set(learningId, { price, locked_at: Date.now() });
}

// Cleanup expired locks every 60 seconds
const priceLockCleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of priceLockCache) {
    if (now - entry.locked_at > PRICE_LOCK_TTL) priceLockCache.delete(id);
  }
}, 60_000);
priceLockCleanupInterval.unref();

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  // V2 API (primary)
  calculateLearningPrice,
  getCurrentPrice,
  classifyComplexity,
  calculateDemandMultiplier,
  calculateFreshnessMultiplier,
  calculateRatingMultiplier,
  calculateVerdict,
  calculateQualityMultiplier,
  estimateDiyCost,
  qualityScore01,

  // PRICING-DENSITY gate (2026-07-19)
  DENSITY_GATE,
  effectiveUniquenessMultiplier,
  countTagNeighbors,
  isMarketVisible,

  // Legacy API (preserved for backward compatibility)
  computeDynamicPrice,
  computeCurrentPrice,
  getLockedPrice,
  lockPrice,

  // Constants
  MIN_UNLOCK_PRICE,
  MAX_UNLOCK_PRICE,
};
