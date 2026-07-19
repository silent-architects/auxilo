'use strict';

/**
 * test/pricing-density-gate.test.js — PRICING-DENSITY (2026-07-19)
 *
 * Density-gated uniqueness multiplier (Tyler-ratified 2026-07-19):
 * premium uniqueness tiers (> 1.5x) apply only when the visible catalog has
 * >= 200 items AND the item has >= 3 same-category tag-neighbors. Driven by
 * the CAT-1 catalog-health finding: at 58 items with zero tag-similar pairs,
 * 100% of the shelf carried the 3.0x "first of its kind" premium and 52/58
 * items failed calculateVerdict as "expensive".
 *
 * Spec: ~/.auxilo/handoffs/BUILD-SPEC-PRICING-DENSITY-2026-07-19.md
 * Runner: node --test test/pricing-density-gate.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const pricing = require('../lib/pricing.js');
const {
  calculateLearningPrice,
  getCurrentPrice,
  calculateVerdict,
  effectiveUniquenessMultiplier,
  countTagNeighbors,
  isMarketVisible,
  DENSITY_GATE,
  MIN_UNLOCK_PRICE,
  MAX_UNLOCK_PRICE,
} = pricing;

const DAY = 86400000;
const EPS = 1e-9;

// Cold-demand sigmoid at zero velocity: 1 + 0.25*((2/(1+e^1.5))-1)
const COLD_DEMAND = 1.0 + 0.25 * ((2 / (1 + Math.exp(1.5))) - 1); // ~0.8412

// ─── Builders ────────────────────────────────────────────────────────────────

/** Quality self-assessments by total. */
const QA18 = { specificity: 5, actionability: 5, novelty: 4, completeness: 4, total: 18 };
const QA14 = { specificity: 4, actionability: 4, novelty: 3, completeness: 3, total: 14 };
const QA8  = { specificity: 2, actionability: 2, novelty: 2, completeness: 2, total: 8 };

/** Minimal catalog learning; tags default to disjoint per-id triples. */
function baseLearning(id, category, overrides = {}) {
  return {
    id,
    title: `Learning ${id}`,
    body: 'B'.repeat(600), // moderate band (500-2000) regardless of QA total
    category,
    tags: [`t-${id}-a`, `t-${id}-b`, `t-${id}-c`],
    status: 'approved',
    quality: { unlocks: 0, ratings: 0, avg_helpfulness: 0, helpfulness_scores: [], score: 0 },
    demand: { search_impressions_7d: 0, unlocks_7d: 0 },
    created_at: new Date(Date.now() - 40 * DAY).toISOString(), // freshness 1.0 band
    ...overrides,
  };
}

/** Disjoint-tag filler catalog: `count` visible items, half in `category`. */
function fillerCatalog(count, category = 'code-execution') {
  const cat = [];
  for (let i = 0; i < count; i++) {
    cat.push(baseLearning(`lrn_f${i}`, i % 2 === 0 ? category : 'web-interaction'));
  }
  return cat;
}

/** Candidate under test (no QA → quality multiplier 1.14, moderate → cost 0.80). */
function candidate(overrides = {}) {
  return baseLearning('lrn_cand', 'code-execution', {
    tags: ['cand-a', 'cand-b', 'cand-c'],
    ...overrides,
  });
}

/** Tag-neighbor of the candidate: shares ONE tag, Jaccard 1/7 ≈ 0.14 < 0.4. */
function neighborOf(i) {
  return baseLearning(`lrn_nb${i}`, 'code-execution', {
    tags: ['cand-a', `nb-${i}-1`, `nb-${i}-2`, `nb-${i}-3`, `nb-${i}-4`],
  });
}

/** Tag-similar item: identical tags → Jaccard 1.0 >= 0.4. */
function similarOf(i, overrides = {}) {
  return baseLearning(`lrn_sim${i}`, 'code-execution', {
    tags: ['cand-a', 'cand-b', 'cand-c'],
    ...overrides,
  });
}

const NOQA_Q = 1.14;      // quality multiplier with no self-assessment
const CODE_COST = 0.80;   // code-execution moderate: 0.50 token + 0.30 time

// ─── 1-6. Gate behavior through calculateLearningPrice ───────────────────────

test('gate: sparse catalog (58 visible, 0 neighbors) caps first-of-kind at 1.5x', () => {
  const price = calculateLearningPrice(candidate(), fillerCatalog(58));
  assert.ok(Math.abs(price - CODE_COST * 1.5 * NOQA_Q) < EPS,
    `expected ${CODE_COST * 1.5 * NOQA_Q} (1.5x cap), got ${price}`);
});

test('gate: dense catalog (210 visible) + 3 tag-neighbors restores full 3.0x', () => {
  const cat = [...fillerCatalog(207), neighborOf(1), neighborOf(2), neighborOf(3)];
  const price = calculateLearningPrice(candidate(), cat);
  assert.ok(Math.abs(price - CODE_COST * 3.0 * NOQA_Q) < EPS,
    `expected ${CODE_COST * 3.0 * NOQA_Q} (full premium), got ${price}`);
});

test('gate: density without neighbors stays capped at 1.5x', () => {
  const price = calculateLearningPrice(candidate(), fillerCatalog(210));
  assert.ok(Math.abs(price - CODE_COST * 1.5 * NOQA_Q) < EPS);
});

test('gate: neighbors without density stays capped at 1.5x', () => {
  const cat = [...fillerCatalog(55), neighborOf(1), neighborOf(2), neighborOf(3)];
  const price = calculateLearningPrice(candidate(), cat);
  assert.ok(Math.abs(price - CODE_COST * 1.5 * NOQA_Q) < EPS);
});

test('gate never raises: normal (1.0x) and commodity (0.5x) tiers unchanged in sparse AND dense catalogs', () => {
  // 4 similar → raw 1.0
  const sims4 = [1, 2, 3, 4].map(similarOf);
  const sparse4 = calculateLearningPrice(candidate(), [...fillerCatalog(50), ...sims4]);
  const dense4 = calculateLearningPrice(candidate(), [...fillerCatalog(206), ...sims4]);
  assert.ok(Math.abs(sparse4 - CODE_COST * 1.0 * NOQA_Q) < EPS, `sparse 4-similar: ${sparse4}`);
  assert.ok(Math.abs(dense4 - CODE_COST * 1.0 * NOQA_Q) < EPS, `dense 4-similar: ${dense4}`);

  // 11 similar → raw 0.5
  const sims11 = Array.from({ length: 11 }, (_, i) => similarOf(i + 10));
  const sparse11 = calculateLearningPrice(candidate(), [...fillerCatalog(40), ...sims11]);
  const dense11 = calculateLearningPrice(candidate(), [...fillerCatalog(199), ...sims11]);
  assert.ok(Math.abs(sparse11 - CODE_COST * 0.5 * NOQA_Q) < EPS, `sparse 11-similar: ${sparse11}`);
  assert.ok(Math.abs(dense11 - CODE_COST * 0.5 * NOQA_Q) < EPS, `dense 11-similar: ${dense11}`);
});

test('gate: rare tier (2.0x) capped to 1.5x in sparse catalog, restored in dense', () => {
  const sims2 = [similarOf(1), similarOf(2)];
  // sparse: 2 similar → raw 2.0 → capped
  const sparse = calculateLearningPrice(candidate(), [...fillerCatalog(50), ...sims2]);
  assert.ok(Math.abs(sparse - CODE_COST * 1.5 * NOQA_Q) < EPS, `sparse rare: ${sparse}`);
  // dense with >= 3 neighbors (2 similar are neighbors too, +1 plain neighbor)
  const dense = calculateLearningPrice(candidate(), [...fillerCatalog(205), ...sims2, neighborOf(1)]);
  assert.ok(Math.abs(dense - CODE_COST * 2.0 * NOQA_Q) < EPS, `dense rare: ${dense}`);
});

// ─── 7. Exact boundaries ─────────────────────────────────────────────────────

test('gate boundaries: exactly (200 visible, 3 neighbors) opens; 199 or 2 stays closed', () => {
  assert.equal(effectiveUniquenessMultiplier(0, 200, 3), 3.0);
  assert.equal(effectiveUniquenessMultiplier(0, 199, 3), 1.5);
  assert.equal(effectiveUniquenessMultiplier(0, 200, 2), 1.5);
  // rare tier through the same gate
  assert.equal(effectiveUniquenessMultiplier(2, 200, 3), 2.0);
  assert.equal(effectiveUniquenessMultiplier(2, 199, 3), 1.5);
  // sub-cap tiers pass through untouched
  assert.equal(effectiveUniquenessMultiplier(5, 0, 0), 1.0);
  assert.equal(effectiveUniquenessMultiplier(11, 0, 0), 0.5);
});

test('DENSITY_GATE constants are the ratified frame (200 / 3 / 1.5)', () => {
  assert.equal(DENSITY_GATE.MIN_MARKET_SIZE, 200);
  assert.equal(DENSITY_GATE.MIN_TAG_NEIGHBORS, 3);
  assert.equal(DENSITY_GATE.SPARSE_CAP, 1.5);
});

// ─── 8-9. Visibility semantics ───────────────────────────────────────────────

test('visibility: pending items count toward neither density, neighbors, nor similarity', () => {
  // (a) 210 raw but only 100 approved → gate closed even with approved neighbors
  const mostlyPending = [
    ...fillerCatalog(97),
    neighborOf(1), neighborOf(2), neighborOf(3),
    ...fillerCatalog(110).map((l, i) => ({ ...l, id: `lrn_p${i}`, status: 'pending_review' })),
  ];
  const a = calculateLearningPrice(candidate(), mostlyPending);
  assert.ok(Math.abs(a - CODE_COST * 1.5 * NOQA_Q) < EPS, `pending density leaked: ${a}`);

  // (b) dense catalog but the only neighbors are pending → gate closed
  const pendingNeighbors = [
    ...fillerCatalog(210),
    { ...neighborOf(1), id: 'lrn_pn1', status: 'pending_review' },
    { ...neighborOf(2), id: 'lrn_pn2', status: 'pending_review' },
    { ...neighborOf(3), id: 'lrn_pn3', status: 'pending_review' },
  ];
  const b = calculateLearningPrice(candidate(), pendingNeighbors);
  assert.ok(Math.abs(b - CODE_COST * 1.5 * NOQA_Q) < EPS, `pending neighbors leaked: ${b}`);

  // (c) a pending near-duplicate does NOT suppress a visible item's premium
  const withPendingDup = [
    ...fillerCatalog(207), neighborOf(1), neighborOf(2), neighborOf(3),
    similarOf(99, { status: 'pending_review' }),
  ];
  const c = calculateLearningPrice(candidate(), withPendingDup);
  assert.ok(Math.abs(c - CODE_COST * 3.0 * NOQA_Q) < EPS, `pending dup suppressed premium: ${c}`);
});

test('visibility: legacy items without a status field count as visible (server predicate parity)', () => {
  const legacy = fillerCatalog(207).map(l => { const { status, ...rest } = l; return rest; });
  const cat = [...legacy, neighborOf(1), neighborOf(2), neighborOf(3)];
  const price = calculateLearningPrice(candidate(), cat);
  assert.ok(Math.abs(price - CODE_COST * 3.0 * NOQA_Q) < EPS);
  assert.equal(isMarketVisible({ id: 'x' }), true);
  assert.equal(isMarketVisible({ id: 'x', status: 'approved' }), true);
  assert.equal(isMarketVisible({ id: 'x', status: 'pending_review' }), false);
  assert.equal(isMarketVisible({ id: 'x', status: 'rejected' }), false);
  assert.equal(isMarketVisible({ id: 'x', status: 'retracted' }), false);
});

test('countTagNeighbors: same-category >= 1 shared tag, self and other-category excluded', () => {
  const me = candidate();
  const market = [
    me, // self — excluded
    neighborOf(1),
    baseLearning('lrn_othercat', 'web-interaction', { tags: ['cand-a', 'x1', 'x2'] }), // other category
    baseLearning('lrn_noshare', 'code-execution', { tags: ['z1', 'z2', 'z3'] }),       // no shared tag
  ];
  assert.equal(countTagNeighbors(me, market), 1);
});

// ─── 10-13. getCurrentPrice base refresh (the repricing rollout) ─────────────

test('getCurrentPrice + catalog: stored (ungated) base_price is re-derived through the gate', () => {
  const l = candidate({
    pricing: { base_price: 2.736, current_price: 2.30, builder_override_price: null, complexity: 'moderate' },
    unlock_price: 2.30,
  });
  const price = getCurrentPrice(l, [...fillerCatalog(57), l]);
  // gated base 0.80*1.5*1.14 = 1.368 → × cold demand 0.8412 → $1.15
  assert.equal(price, 1.15);
});

test('getCurrentPrice + null catalog: stored base_price honored (legacy path byte-identical)', () => {
  const l = candidate({
    pricing: { base_price: 2.736, current_price: 2.30, builder_override_price: null, complexity: 'moderate' },
    unlock_price: 2.30,
  });
  const price = getCurrentPrice(l, null);
  // stored base 2.736 × cold demand 0.8412 → $2.30 (the live shelf echo)
  assert.equal(price, 2.30);
});

test('getCurrentPrice: no-pricing item keeps unlock_price short-circuit — no undamped gate shock', () => {
  // The 6 live default-priced items: no pricing object, no cron damping.
  const l = candidate({ unlock_price: 0.08 });
  delete l.pricing;
  const price = getCurrentPrice(l, fillerCatalog(58));
  assert.equal(price, 0.067); // $0.08 × 0.8412, 3dp — unchanged by the gate
});

test('getCurrentPrice: item with neither base nor unlock_price computes through the gated formula', () => {
  const l = candidate();
  delete l.pricing;
  delete l.unlock_price;
  const price = getCurrentPrice(l, fillerCatalog(58));
  assert.equal(price, 1.15); // gated 1.368 × 0.8412
});

// ─── 14. Floor / ceiling interactions ────────────────────────────────────────

test('bounds: gated base still clamps to the $0.05 floor and price to $50 ceiling', () => {
  // Tiny item: communication simple (0.07 cost) × commodity 0.5 × min quality 0.6
  // → raw 0.021 → base clamps to $0.05; price floor holds at $0.05.
  const tiny = baseLearning('lrn_tiny', 'communication', {
    tags: ['tiny-a', 'tiny-b', 'tiny-c'],
    body: 'short',
    quality_self_assessment: QA8,
  });
  const sims = Array.from({ length: 11 }, (_, i) =>
    baseLearning(`lrn_ts${i}`, 'communication', { tags: ['tiny-a', 'tiny-b', 'tiny-c'] }));
  const base = calculateLearningPrice(tiny, [...fillerCatalog(40), ...sims]);
  assert.equal(base, MIN_UNLOCK_PRICE);
  const price = getCurrentPrice({ ...tiny, pricing: { base_price: base, current_price: base } },
    [...fillerCatalog(40), ...sims]);
  assert.ok(price >= MIN_UNLOCK_PRICE);

  // Ceiling: hot demand + first-week freshness on a high stored base still caps at $50.
  const hot = candidate({
    created_at: new Date().toISOString(),
    demand: { search_impressions_7d: 0, unlocks_7d: 50 },
    pricing: { base_price: 49, current_price: 49 },
  });
  const hotPrice = getCurrentPrice(hot, null); // null catalog → stored base
  assert.ok(hotPrice <= MAX_UNLOCK_PRICE, `ceiling violated: ${hotPrice}`);
});

// ─── 15-17. Fixture A: the CAT-1 58-item shelf, before/after ────────────────

/** Sparse shelf mirroring the live 2026-07-19 catalog composition (CAT-1 §1). */
function sparseShelf() {
  const shelf = [];
  let n = 0;
  const add = (count, category, currentPrice, basePrice, qa) => {
    for (let i = 0; i < count; i++) {
      n++;
      shelf.push(baseLearning(`lrn_a${n}`, category, {
        ...(qa ? { quality_self_assessment: qa } : {}),
        pricing: {
          base_price: basePrice,
          current_price: currentPrice,
          builder_override_price: null,
          complexity: 'moderate',
          last_repriced_at: new Date().toISOString(),
        },
        unlock_price: currentPrice,
      }));
    }
  };
  // 46 no-QA formula-echo items (quality mult 1.14, uniqueness 3.0, cold demand)
  add(23, 'code-execution', 2.30, 2.736);       // the $2.30 = 39.7% cluster
  add(9,  'web-interaction', 1.73, 2.052);
  add(5,  'data-processing', 2.01, 2.394);
  add(4,  'storage-state',   1.87, 2.223);
  add(4,  'monitoring',      1.73, 2.052);
  add(1,  'communication',   1.44, 1.71);
  // 6 QA'd organics
  add(3, 'code-execution',  2.85, 3.384, QA18);
  add(3, 'web-interaction', 1.86, 2.214, QA14);
  // 6 default-priced items with NO pricing object (live-computed, $0.067 class)
  for (let i = 0; i < 6; i++) {
    n++;
    shelf.push(baseLearning(`lrn_d${n}`, 'web-interaction', { unlock_price: 0.08 }));
  }
  return shelf;
}

/** One daily-cron step exactly as server.js runDailyPricingCron applies it. */
function cronStep(l, catalog) {
  const oldPrice = l.pricing.current_price;
  const newPrice = getCurrentPrice(l, catalog);
  const maxUp = oldPrice * 1.15;
  const maxDown = oldPrice * 0.85;
  let adjusted = Math.max(maxDown, Math.min(maxUp, newPrice));
  adjusted = Math.max(MIN_UNLOCK_PRICE, Math.min(MAX_UNLOCK_PRICE, adjusted));
  return Number(adjusted.toFixed(6));
}

/** Verdict the way the search path computes it (resolved current price). */
function shelfVerdict(l, catalog) {
  const resolved = (l.pricing && l.pricing.current_price) || getCurrentPrice(l, catalog);
  return calculateVerdict({ ...l, pricing: { ...(l.pricing || {}), current_price: resolved } });
}

function tally(verdicts) {
  return verdicts.reduce((acc, v) => { acc[v] = (acc[v] || 0) + 1; return acc; }, {});
}

test('fixture BEFORE: stored ungated prices reproduce the live 52-expensive / 6-strong_buy shelf', () => {
  const shelf = sparseShelf();
  assert.equal(shelf.length, 58);
  const t = tally(shelf.map(l => shelfVerdict(l, shelf)));
  assert.equal(t.expensive, 52, `expected 52 expensive, got ${JSON.stringify(t)}`);
  assert.equal(t.strong_buy, 6, `expected 6 strong_buy, got ${JSON.stringify(t)}`);
});

test('fixture AFTER: cron convergence flips the shelf to majority-approvable (H4 < 30% expensive)', () => {
  const shelf = sparseShelf().map(l => l.pricing ? { ...l, pricing: { ...l.pricing } } : l);
  // Run daily cron steps to convergence (server caps at 15%/day; skips no-pricing items)
  for (let day = 0; day < 30; day++) {
    for (const l of shelf) {
      if (!l.pricing) continue;
      const next = cronStep(l, shelf);
      l.pricing.current_price = next;
      l.unlock_price = next;
    }
  }
  const t = tally(shelf.map(l => shelfVerdict(l, shelf)));
  const approvable = (t.strong_buy || 0) + (t.recommended || 0) + (t.consider || 0);

  assert.equal(t.strong_buy, 6, 'the 6 default-priced items must stay strong_buy');
  assert.ok((t.expensive || 0) <= 10, `expensive must collapse: ${JSON.stringify(t)}`);
  assert.ok(approvable >= 45, `shelf must be majority-approvable: ${JSON.stringify(t)}`);
  assert.ok((t.expensive || 0) / shelf.length < 0.30,
    `H4: expensive share must drop below 30%, got ${JSON.stringify(t)}`);
  // The typical (no-QA moderate) item lands "consider": $1.15 / $0.80 DIY = 1.4375
  assert.equal(shelf[0].pricing.current_price, 1.15);
  assert.equal(shelfVerdict(shelf[0], shelf), 'consider');
});

test('residual pin (spec §2.5): a cold 18/20 self-scored item remains "expensive" at the 1.5 cap', () => {
  // Deliberate property of the ratified 1.5 frame, pinned so it is visible:
  // ratio = 1.5 × 1.41 × 0.8412 ≈ 1.78 > 1.5. Watch under CAT-1 H4 as triage drains.
  const l = candidate({ quality_self_assessment: QA18 });
  delete l.pricing;
  delete l.unlock_price;
  const price = getCurrentPrice(l, fillerCatalog(58));
  const v = calculateVerdict({ ...l, pricing: { current_price: price } });
  assert.equal(v, 'expensive');
});

// ─── 18-19. Convergence math (requirement 3) ─────────────────────────────────

test('convergence: a $2.30 shelf item reaches its gated $1.15 target in exactly 5 cron runs', () => {
  const shelf = sparseShelf();
  const l = { ...shelf[0], pricing: { ...shelf[0].pricing } };
  const target = getCurrentPrice(l, shelf);
  assert.equal(target, 1.15);

  const path = [l.pricing.current_price];
  let steps = 0;
  while (Math.abs(l.pricing.current_price - target) > EPS && steps < 30) {
    l.pricing.current_price = cronStep(l, shelf);
    path.push(l.pricing.current_price);
    steps++;
  }
  assert.equal(steps, 5, `expected 5 daily runs, path: ${path.join(' → ')}`);
  // monotone decrease
  for (let i = 1; i < path.length; i++) assert.ok(path[i] <= path[i - 1] + EPS);
});

test('convergence: no single cron step ever moves more than 15%', () => {
  const shelf = sparseShelf();
  const l = { ...shelf[0], pricing: { ...shelf[0].pricing } };
  for (let day = 0; day < 10; day++) {
    const before = l.pricing.current_price;
    const after = cronStep(l, shelf);
    assert.ok(after >= before * 0.85 - EPS && after <= before * 1.15 + EPS,
      `day ${day}: ${before} → ${after} exceeds the 15% cap`);
    l.pricing.current_price = after;
  }
});

// ─── 20-21. Structural guards: the server-side facts this design relies on ───

test('structural: daily cron still feeds getCurrentPrice the catalog, caps at 15%/day, skips no-pricing items', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const cronStart = src.indexOf('async function runDailyPricingCron');
  assert.ok(cronStart !== -1, 'runDailyPricingCron must exist — the rollout mechanism');
  const cronSrc = src.slice(cronStart, cronStart + 3000);
  assert.ok(cronSrc.includes('pricingEngine.getCurrentPrice(learning, catalog)'),
    'cron must pass the catalog so the base refresh (density gate) reaches stored items');
  assert.ok(cronSrc.includes('oldPrice * 1.15') && cronSrc.includes('oldPrice * 0.85'),
    'cron must keep the 15%/day move cap — the no-shock rollout depends on it');
  assert.ok(cronSrc.includes('if (!learning.pricing) continue;'),
    'cron must keep skipping no-pricing items (they are quoted live via unlock_price, undamped)');
});

test('structural: submission path prices through calculateLearningPrice (gate active at submission)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(src.includes('pricingEngine.calculateLearningPrice(syntheticForPricing, learnings)'),
    'new submissions must flow through the density-gated formula');
});

// ─── F1 (Gate-A): loud request-path pins ─────────────────────────────────────
// The zero-server.js rollout (spec §2.3) RELIES on every request-path caller
// short-circuiting on stored pricing.current_price BEFORE any engine call —
// otherwise the base refresh would fire on hot paths with no 15%/day damping.
// These are loud test()-level pins (describe-body asserts can print ✖ yet
// exit 0 under the npm test flags — see the r01-launch-blockers reviewer note).
// Whitespace-normalized exact-chain matching: a reorder mutation (engine
// first) changes the string and fails the pin.

function normalizedServerSource() {
  return fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8').replace(/\s+/g, ' ');
}

test('request-path pin: SEARCH resolves stored current_price BEFORE the engine (no engine-first reorder)', () => {
  const src = normalizedServerSource();
  assert.ok(src.includes(
    'const resolvedPrice = r.pricing?.current_price || pricingEngine.getCurrentPrice?.(r, learnings) || r.unlock_price || DEFAULT_UNLOCK_PRICE;'),
    'search result chain must be pricing?.current_price -> engine -> unlock_price -> default, in that order');
});

test('request-path pin: UNLOCK resolves stored current_price BEFORE the engine (no engine-first reorder)', () => {
  const src = normalizedServerSource();
  assert.ok(src.includes(
    'UNLOCK_PRICE = learning.pricing?.current_price || pricingEngine.getCurrentPrice?.(learning, learnings) || learning.unlock_price || DEFAULT_UNLOCK_PRICE;'),
    'unlock charge chain must be pricing?.current_price -> engine -> unlock_price -> default, in that order');
});

test('request-path pin: HOMEPAGE displayPrice resolves stored current_price BEFORE the engine (no engine-first reorder)', () => {
  const src = normalizedServerSource();
  assert.ok(src.includes('function displayPrice(l)'), 'displayPrice helper must exist');
  assert.ok(src.includes(
    'p = l.pricing?.current_price || pricingEngine.getCurrentPrice?.(l, learnings) || l.unlock_price || DEFAULT_UNLOCK_PRICE;'),
    'homepage display chain must be pricing?.current_price -> engine -> unlock_price -> default, in that order');
});

// ─── F2 (Gate-A): same-contributor items can never open the gate ─────────────

test('F2: a contributor cannot farm their own tag-neighbors to open the gate (account id)', () => {
  // Post-200 attack: 3 self-approved one-shared-tag fillers (Jaccard ~0.14,
  // under the 0.4 similar threshold) from the SAME account as the candidate.
  const me = candidate({ contributor_account_id: 'acc_attacker', contributor_wallet: '0xaaa' });
  const ownFillers = [1, 2, 3].map(i => ({
    ...neighborOf(i), contributor_account_id: 'acc_attacker', contributor_wallet: '0xaaa',
  }));
  const price = calculateLearningPrice(me, [...fillerCatalog(207), ...ownFillers]);
  assert.ok(Math.abs(price - CODE_COST * 1.5 * NOQA_Q) < EPS,
    `own-account farm must stay capped at 1.5x, got ${price}`);
});

test('F2: wallet-only match is also excluded (either identity axis blocks the farm)', () => {
  const me = candidate({ contributor_wallet: '0xfarmwallet' });
  const ownFillers = [1, 2, 3].map(i => ({ ...neighborOf(i), contributor_wallet: '0xfarmwallet' }));
  const price = calculateLearningPrice(me, [...fillerCatalog(207), ...ownFillers]);
  assert.ok(Math.abs(price - CODE_COST * 1.5 * NOQA_Q) < EPS,
    `own-wallet farm must stay capped at 1.5x, got ${price}`);
});

test('F2: genuine third-party neighbors still open the gate; own fillers neither help nor block', () => {
  const me = candidate({ contributor_account_id: 'acc_attacker' });
  const genuine = [1, 2, 3].map(i => ({ ...neighborOf(i), contributor_account_id: `acc_other_${i}` }));
  const own = [4, 5, 6].map(i => ({ ...neighborOf(i), contributor_account_id: 'acc_attacker' }));
  const price = calculateLearningPrice(me, [...fillerCatalog(204), ...genuine, ...own]);
  assert.ok(Math.abs(price - CODE_COST * 3.0 * NOQA_Q) < EPS,
    `3 genuine neighbors must still open the gate, got ${price}`);
});

test('F2 is one-directional: own near-duplicates still count as SIMILAR and lower the premium', () => {
  // 4 same-contributor identical-tag items → similarCount 4 → raw 1.0 tier.
  // Self-duplicates keep LOWERING premiums; they only stop RAISING them.
  const me = candidate({ contributor_account_id: 'acc_attacker' });
  const ownDups = [1, 2, 3, 4].map(i => ({ ...similarOf(i), contributor_account_id: 'acc_attacker' }));
  const price = calculateLearningPrice(me, [...fillerCatalog(206), ...ownDups]);
  assert.ok(Math.abs(price - CODE_COST * 1.0 * NOQA_Q) < EPS,
    `own duplicates must still drop the tier to 1.0x, got ${price}`);
});

test('F2 null-safety: anonymous items (no account, no wallet) never match each other', () => {
  // Candidate with no contributor identity + identity-less neighbors: the
  // exclusion must not fire on null===null, so genuine anonymous neighbors
  // still open the gate. (Also pins the submission-time semantics: the
  // submission synthetic carries no contributor fields — flagged for the
  // server.js wave to add them so the farm is blocked at submission too,
  // not just from the first cron refresh.)
  const me = candidate(); // no contributor fields
  const anonNeighbors = [1, 2, 3].map(i => neighborOf(i)); // no contributor fields
  const price = calculateLearningPrice(me, [...fillerCatalog(207), ...anonNeighbors]);
  assert.ok(Math.abs(price - CODE_COST * 3.0 * NOQA_Q) < EPS,
    `anonymous neighbors must still count (no null identity matching), got ${price}`);
});
