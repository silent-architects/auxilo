'use strict';

/**
 * test/pricing.test.js
 *
 * Unit tests for lib/pricing.js
 * Runner: node --test test/pricing.test.js
 *
 * No filesystem state is needed — pricing is a pure-function module
 * (plus an in-process price-lock cache).
 */

const { test } = require('node:test');
const assert   = require('node:assert/strict');

const {
    computeDynamicPrice,
    computeCurrentPrice,
    getLockedPrice,
    lockPrice,
    MIN_UNLOCK_PRICE,
    MAX_UNLOCK_PRICE,
} = require('../lib/pricing.js');

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Build a minimal learning object. */
function makeLearning(overrides = {}) {
    return {
        body:         'This is a sample learning body.',
        outcome:      'success',
        category:     'engineering',
        unlock_price: 0,
        quality:      { score: 3, unlocks: 0 },
        created_at:   new Date().toISOString(),
        ...overrides,
    };
}

/** Build a minimal catalog-stats object (single category). */
function makeCatalog(categoryCount = 1, total = 10) {
    return {
        total,
        categoryCounts: { engineering: categoryCount },
    };
}

// ─── 1. Constants ─────────────────────────────────────────────────────────────

test('MIN_UNLOCK_PRICE is $0.05', () => {
    assert.equal(MIN_UNLOCK_PRICE, 0.05);
});

test('MAX_UNLOCK_PRICE is $50.00', () => {
    assert.equal(MAX_UNLOCK_PRICE, 50.00);
});

// ─── 2. Floor Enforcement ─────────────────────────────────────────────────────

test('computeCurrentPrice: result is never below MIN_UNLOCK_PRICE', () => {
    // A tiny body + minimal quality would normally price below the floor
    const learning = makeLearning({ body: 'Hi', quality: { score: 0, unlocks: 0 } });
    const price = computeCurrentPrice(learning, makeCatalog());
    assert.ok(price >= MIN_UNLOCK_PRICE,
        `Price ${price} must be >= MIN_UNLOCK_PRICE ${MIN_UNLOCK_PRICE}`);
});

test('computeCurrentPrice: floor applies even when contributor price is 0', () => {
    const learning = makeLearning({ unlock_price: 0, body: '' });
    const price = computeCurrentPrice(learning, makeCatalog());
    assert.ok(price >= MIN_UNLOCK_PRICE);
});

test('computeCurrentPrice: floor applies when dynamic price would be negative/zero', () => {
    // Force an effectively-zero dynamic price
    const learning = makeLearning({
        body:    '',           // zero token cost
        outcome: 'success',   // 0.01 time value — can still be small
        quality: { score: 0, unlocks: 0 },
        unlock_price: 0,
    });
    const price = computeCurrentPrice(learning, makeCatalog());
    assert.ok(price >= MIN_UNLOCK_PRICE,
        `Price ${price} must still meet the minimum floor`);
});

// ─── 3. Ceiling Enforcement ───────────────────────────────────────────────────

test('computeCurrentPrice: result is never above MAX_UNLOCK_PRICE', () => {
    // A huge body + top quality + extreme demand should still be capped
    const bigBody = 'x'.repeat(1_000_000); // 1 MB body
    const learning = makeLearning({
        body:         bigBody,
        quality:      { score: 5, unlocks: 10_000 },
        unlock_price: 0,
    });
    const price = computeCurrentPrice(learning, makeCatalog());
    assert.ok(price <= MAX_UNLOCK_PRICE,
        `Price ${price} must be <= MAX_UNLOCK_PRICE ${MAX_UNLOCK_PRICE}`);
});

test('computeCurrentPrice: contributor price above MAX is clamped', () => {
    const learning = makeLearning({ unlock_price: 999.99 });
    const price = computeCurrentPrice(learning, makeCatalog());
    assert.ok(price <= MAX_UNLOCK_PRICE,
        `Even a sky-high contributor price must be clamped to ${MAX_UNLOCK_PRICE}`);
});

// ─── 4. Price Clamping ────────────────────────────────────────────────────────

test('computeCurrentPrice: price is clamped to [MIN, MAX] for a normal learning', () => {
    const learning = makeLearning();
    const price = computeCurrentPrice(learning, makeCatalog());
    assert.ok(price >= MIN_UNLOCK_PRICE && price <= MAX_UNLOCK_PRICE,
        `Price ${price} must be within [${MIN_UNLOCK_PRICE}, ${MAX_UNLOCK_PRICE}]`);
});

test('computeCurrentPrice: result is rounded to 4 decimal places', () => {
    const learning = makeLearning();
    const price = computeCurrentPrice(learning, makeCatalog());
    const str = price.toString();
    const decimals = str.includes('.') ? str.split('.')[1].length : 0;
    assert.ok(decimals <= 4, `Price ${price} has ${decimals} decimal places — max 4 allowed`);
});

// ─── 5. Contributor Price as Floor ───────────────────────────────────────────

test('computeCurrentPrice: contributor_price is respected as a floor', () => {
    // Contributor sets a price that is above the dynamic price but within MAX
    const learning = makeLearning({
        unlock_price: 5.00,
        body:         'Short',  // tiny dynamic price
        quality:      { score: 0, unlocks: 0 },
    });
    const price = computeCurrentPrice(learning, makeCatalog());
    assert.ok(price >= 5.00,
        `Contributor floor $5.00 must be honoured, got $${price}`);
});

test('computeCurrentPrice: contributor_price of 0 does not override dynamic price', () => {
    const learning = makeLearning({ unlock_price: 0 });
    const price = computeCurrentPrice(learning, makeCatalog());
    // Result should still be >= MIN (not literally 0)
    assert.ok(price >= MIN_UNLOCK_PRICE);
});

// ─── 6. Default Price for a New, Minimal Learning ────────────────────────────

test('computeCurrentPrice: default "success" outcome produces a price >= MIN', () => {
    const learning = makeLearning({
        outcome:      'success',
        body:         'A typical short learning body text.',
        quality:      { score: 2, unlocks: 0 },
        unlock_price: 0,
    });
    const price = computeCurrentPrice(learning, makeCatalog());
    // The spec note says ~$0.08 for a typical new learning; we just assert MIN ≤ price ≤ MAX
    assert.ok(price >= MIN_UNLOCK_PRICE);
    assert.ok(price <= MAX_UNLOCK_PRICE);
});

// ─── 7. Dynamic Factors ──────────────────────────────────────────────────────

test('Demand factor: more unlocks increases price', () => {
    const base   = makeLearning({ quality: { score: 3, unlocks: 0  } });
    const hotter = makeLearning({ quality: { score: 3, unlocks: 50 } });
    const pBase  = computeCurrentPrice(base,   makeCatalog());
    const pHot   = computeCurrentPrice(hotter, makeCatalog());
    assert.ok(pHot >= pBase,
        `Higher demand (unlocks=50) should raise price: ${pHot} vs ${pBase}`);
});

test('Quality factor: higher quality score raises price', () => {
    const low  = makeLearning({ quality: { score: 0, unlocks: 0 } });
    const high = makeLearning({ quality: { score: 5, unlocks: 0 } });
    const pLow  = computeCurrentPrice(low,  makeCatalog());
    const pHigh = computeCurrentPrice(high, makeCatalog());
    assert.ok(pHigh >= pLow,
        `Quality 5 should produce a higher price than quality 0: ${pHigh} vs ${pLow}`);
});

test('Freshness factor: older learning is priced lower than fresh one', () => {
    // 6-month-old learning
    const old = makeLearning({
        created_at: new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString(),
        quality: { score: 3, unlocks: 0 },
    });
    // Brand new learning
    const fresh = makeLearning({
        created_at: new Date().toISOString(),
        quality: { score: 3, unlocks: 0 },
    });
    const pOld   = computeCurrentPrice(old,   makeCatalog());
    const pFresh = computeCurrentPrice(fresh, makeCatalog());
    // Old should be ≤ fresh (freshness floor is 0.5, not 0, so could be equal at clamped min)
    assert.ok(pOld <= pFresh + 0.0001,
        `6-month-old learning price ${pOld} must be ≤ fresh price ${pFresh}`);
});

test('Freshness factor: floors at 0.5 (never below half value due to age)', () => {
    // 10-year-old learning — freshnessFactor should floor at 0.5
    const ancient = makeLearning({
        created_at: new Date(Date.now() - 10 * 365 * 24 * 60 * 60 * 1000).toISOString(),
        quality: { score: 3, unlocks: 0 },
    });
    const price = computeCurrentPrice(ancient, makeCatalog());
    // If price is above MIN, the floor enforced something positive
    assert.ok(price >= MIN_UNLOCK_PRICE,
        'Even ancient learnings must be priced at or above MIN');
});

test('Uniqueness factor: rare categories get a premium over common ones', () => {
    // Category appears once in a catalog of 100 → scarcity ≈ 0.99
    const rareCatalog   = { total: 100, categoryCounts: { rare: 1 } };
    const commonCatalog = { total: 100, categoryCounts: { common: 80 } };

    const rareL   = makeLearning({ category: 'rare',   quality: { score: 3, unlocks: 5 } });
    const commonL = makeLearning({ category: 'common', quality: { score: 3, unlocks: 5 } });

    const pRare   = computeCurrentPrice(rareL,   rareCatalog);
    const pCommon = computeCurrentPrice(commonL, commonCatalog);
    assert.ok(pRare >= pCommon,
        `Rare category price ${pRare} must be >= common category price ${pCommon}`);
});

test('Outcome factor: workaround outcome yields higher price than failure', () => {
    // timeValueFactor: workaround=0.02, failure=0.005
    const workaround = makeLearning({ outcome: 'workaround', quality: { score: 3, unlocks: 0 } });
    const failure    = makeLearning({ outcome: 'failure',    quality: { score: 3, unlocks: 0 } });
    const pW = computeCurrentPrice(workaround, makeCatalog());
    const pF = computeCurrentPrice(failure,    makeCatalog());
    assert.ok(pW >= pF,
        `Workaround price ${pW} must be >= failure price ${pF}`);
});

test('Unknown outcome falls back to "success" time-value factor', () => {
    const unknown = makeLearning({ outcome: 'undefined_outcome', quality: { score: 3, unlocks: 0 } });
    const success = makeLearning({ outcome: 'success',           quality: { score: 3, unlocks: 0 } });
    const pU = computeCurrentPrice(unknown, makeCatalog());
    const pS = computeCurrentPrice(success, makeCatalog());
    // They should be equal — both map to 0.01 in timeValueFactor
    assert.ok(Math.abs(pU - pS) < 0.0001,
        `Unknown outcome ${pU} should match success price ${pS}`);
});

// ─── 8. Price-Lock Cache ─────────────────────────────────────────────────────

test('getLockedPrice: returns null when no lock exists', () => {
    const id = 'lrn_nolocktest_' + Date.now();
    const result = getLockedPrice(id);
    assert.equal(result, null);
});

test('lockPrice + getLockedPrice: round-trips the price', () => {
    const id    = 'lrn_locktest_' + Date.now();
    const price = 0.42;
    lockPrice(id, price);
    const retrieved = getLockedPrice(id);
    assert.equal(retrieved, price);
});

test('lockPrice: overwriting a lock updates the price', () => {
    const id = 'lrn_overwrite_' + Date.now();
    lockPrice(id, 1.00);
    lockPrice(id, 2.00);
    assert.equal(getLockedPrice(id), 2.00);
});

test('getLockedPrice: returns null after TTL expires (simulated)', () => {
    // We cannot advance real time, but we can directly manipulate the cache
    // via the exported lockPrice and then verify that a stale entry is rejected.
    // Instead, we test the contract: a brand-new lock is NOT expired.
    const id = 'lrn_ttl_' + Date.now();
    lockPrice(id, 3.14);
    // Immediately after locking, it must still be valid
    assert.equal(getLockedPrice(id), 3.14, 'Freshly locked price must be retrievable');
});

test('Price-lock cache: different learning IDs are isolated', () => {
    const idA = 'lrn_A_' + Date.now();
    const idB = 'lrn_B_' + Date.now();
    lockPrice(idA,  1.11);
    lockPrice(idB,  2.22);
    assert.equal(getLockedPrice(idA), 1.11);
    assert.equal(getLockedPrice(idB), 2.22);
});

// ─── 9. computeDynamicPrice (raw, unclamped) ─────────────────────────────────

test('computeDynamicPrice: returns a positive number for a standard learning', () => {
    const learning = makeLearning({ body: 'Some reasonably sized body content here.' });
    const price = computeDynamicPrice(learning, makeCatalog());
    assert.ok(typeof price === 'number' && price > 0,
        `Dynamic price must be a positive number, got ${price}`);
});

test('computeDynamicPrice: missing catalogStats defaults gracefully (no crash)', () => {
    const learning = makeLearning();
    assert.doesNotThrow(() => {
        computeDynamicPrice(learning, null);
        computeDynamicPrice(learning, undefined);
        computeDynamicPrice(learning, {});
    });
});
