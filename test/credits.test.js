'use strict';

/**
 * test/credits.test.js
 *
 * Unit tests for lib/credits.js
 * Runner: node --test test/credits.test.js
 *
 * Strategy: each test redirects the module to a temp credits file by
 * writing a known fixture via saveCredits() / loadCredits() and then
 * asserting against the results.  We never touch data/credits.json.
 *
 * NOTE: Free tier has been killed. Every account starts with 0 credits
 * and must purchase a credit pack. Discovery/search are free (no credits
 * needed). Only unlocks consume credits.
 *
 * CREDITS-QUERIES-RESIDUAL (2026-09-06): query credits are retired — packs
 * grant unlocks only, and deductCredit() now rejects creditType 'query'
 * outright regardless of any purchased_queries balance. The legacy
 * purchased_queries / queries_used fields stay in the record shape (older
 * ledger entries carry them) and must remain READABLE — writeRecord() below
 * still seeds them so the reader-tolerance tests have something to tolerate.
 * Nothing in this suite exercises deductCredit(id, 'query') expecting
 * success anymore; where earlier revisions did, the currency under test was
 * switched to 'unlock' (the only currency still live) or the test was
 * repurposed to assert the rejection.
 */

const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ─── Temp file shim ──────────────────────────────────────────────────────────
// lib/credits.js hard-codes its file path, so we use the exported helpers
// (loadCredits / saveCredits) which operate on that path.
// To keep tests isolated we back up and restore data/credits.json.

const CREDITS_FILE = path.join(__dirname, '..', 'data', 'credits.json');
const BACKUP_FILE  = CREDITS_FILE + '.test-backup';

// Unique test-account prefix to avoid collisions with real data
const PREFIX = 'acc_test_cred_';

function uid() {
    return PREFIX + Math.random().toString(36).slice(2, 10);
}

// ─── Setup / Teardown ─────────────────────────────────────────────────────────

before(() => {
    // Back up the real credits file if it exists
    if (fs.existsSync(CREDITS_FILE)) {
        fs.copyFileSync(CREDITS_FILE, BACKUP_FILE);
    }
    // Ensure data dir exists
    fs.mkdirSync(path.dirname(CREDITS_FILE), { recursive: true });
    // Start tests with an empty credits store
    fs.writeFileSync(CREDITS_FILE, '{}');
});

after(() => {
    if (fs.existsSync(BACKUP_FILE)) {
        fs.copyFileSync(BACKUP_FILE, CREDITS_FILE);
        fs.unlinkSync(BACKUP_FILE);
    } else {
        // No original — leave a clean empty file
        fs.writeFileSync(CREDITS_FILE, '{}');
    }
});

// Re-require the module fresh after the before() hook has set up the empty file.
// Node caches modules, which is fine — we just use the exported helpers directly.
const credits = require('../lib/credits.js');
const {
    deductCredit,
    addPurchasedCredits,
    getCreditStatus,
    loadCredits,
    saveCredits,
    computePeriod,
    resetIfNewPeriod,
} = credits;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makePeriod(now = Date.now()) {
    return computePeriod(now);
}

function writeRecord(accountId, overrides = {}) {
    const now = Date.now();
    const { period_start, period_end } = makePeriod(now);
    const base = {
        queries_used: 0,
        unlocks_used: 0,
        purchased_queries: 0,
        purchased_unlocks: 0,
        period_start,
        period_end,
        created_at: now,
        last_deducted_at: null,
        ...overrides,
    };
    const store = loadCredits();
    store[accountId] = base;
    saveCredits(store);
    return base;
}

function deleteRecord(accountId) {
    const store = loadCredits();
    delete store[accountId];
    saveCredits(store);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

// 1. New Account Initialization (no free tier)
// ---------------------------------------------------------------------------

test('New account: starts with 0 purchased credits', () => {
    const id = uid();
    const status = getCreditStatus(id);
    assert.equal(status.unlocks.purchased, 0);
    assert.equal(status.unlocks.used, 0);
    deleteRecord(id);
});

test('New account: deduction fails immediately (no credits)', async () => {
    const id = uid();
    const result = await deductCredit(id, 'unlock');
    assert.equal(result.success, false, 'Deduction must fail with no credits');
    assert.ok(result.message, 'Must include an error message');
    assert.ok(result.message.includes('x402'), 'Must mention x402 as alternative');
    deleteRecord(id);
});

// 2. Query Credits — Retired (CREDITS-QUERIES-RESIDUAL)
// ---------------------------------------------------------------------------
// Nothing sells or spends query credits anymore. deductCredit() rejects the
// 'query' creditType unconditionally; the legacy purchased_queries /
// queries_used fields stay in the record shape and must remain readable and
// untouched by unrelated (unlock) activity.

test('Deduction: creditType "query" is rejected even when purchased_queries > 0', async () => {
    const id = uid();
    writeRecord(id, { purchased_queries: 10 });

    const r = await deductCredit(id, 'query');
    assert.equal(r.success, false, 'query credits are retired — must be rejected outright');
    assert.ok(r.message, 'Must include an error message');
    assert.ok(!/x402/.test(r.message), 'a rejection is not an exhaustion — no x402 fallback offered');

    const store = loadCredits();
    assert.equal(store[id].purchased_queries, 10, 'the rejected deduction must not touch the legacy balance');
    assert.equal(store[id].queries_used || 0, 0, 'queries_used must not increment on a rejected deduction');

    deleteRecord(id);
});

test('Deduction: legacy purchased_queries/queries_used fields survive unrelated unlock deductions untouched', async () => {
    const id = uid();
    writeRecord(id, { purchased_queries: 10, purchased_unlocks: 5 });

    const r = await deductCredit(id, 'unlock');
    assert.equal(r.success, true);

    const store = loadCredits();
    assert.equal(store[id].purchased_queries, 10, 'legacy query balance is read-only now, never touched');
    assert.equal(store[id].queries_used, 0, 'legacy queries_used is read-only now, never touched');
    assert.equal(store[id].purchased_unlocks, 4, 'unlock pool still deducts normally');

    deleteRecord(id);
});

test('getOrInitCredits: a pre-existing record carrying only legacy query fields still loads without error', () => {
    const id = uid();
    // Simulate a pre-retirement record shape: purchased_queries/queries_used
    // present, no unlock_lots yet. Must be readable, not migrated/stripped.
    writeRecord(id, { purchased_queries: 7, queries_used: 3, purchased_unlocks: 0 });

    const status = getCreditStatus(id);
    assert.equal(status.unlocks.purchased, 0);
    assert.equal(status.unlocks.used, 0);

    const store = loadCredits();
    assert.equal(store[id].purchased_queries, 7, 'legacy field survives a read cycle unchanged');
    assert.equal(store[id].queries_used, 3, 'legacy field survives a read cycle unchanged');

    deleteRecord(id);
});

// 3. Purchased Credits — Unlocks
// ---------------------------------------------------------------------------

test('Deduction: purchased unlock credit decrements and increments unlocks_used', async () => {
    const id = uid();
    writeRecord(id, { purchased_unlocks: 5 });

    const r = await deductCredit(id, 'unlock');
    assert.equal(r.success, true);
    assert.equal(r.remaining, 4);
    assert.equal(r.source, 'purchased');

    const store = loadCredits();
    assert.equal(store[id].purchased_unlocks, 4);
    assert.equal(store[id].unlocks_used, 1);
    assert.equal(store[id].purchased_queries, 0, 'Query pool untouched');

    deleteRecord(id);
});

test('Deduction: unlock deduction succeeds regardless of a legacy purchased_queries balance', async () => {
    const id = uid();
    writeRecord(id, { purchased_queries: 3, purchased_unlocks: 5 });

    const r = await deductCredit(id, 'unlock');
    assert.equal(r.success, true, 'Unlock deduction is unaffected by the retired query pool');

    const store = loadCredits();
    assert.equal(store[id].purchased_queries, 3, 'legacy query balance untouched');
    assert.equal(store[id].purchased_unlocks, 4);

    deleteRecord(id);
});

// 4. Purchased Credits — Add and Accumulate
// ---------------------------------------------------------------------------
// addPurchasedCredits() keeps its generic (queries, unlocks) signature at the
// lib layer — no production caller passes a nonzero queries count anymore
// (the Stripe webhook always passes 0; see test/aud19-2-econ.test.js), but
// the lib function itself is not the enforcement point, so these tests still
// exercise it directly to prove the field stays writable/readable.

test('addPurchasedCredits: adds queries and unlocks to the account', async () => {
    const id = uid();
    writeRecord(id);

    const r = await addPurchasedCredits(id, 100, 20);
    assert.equal(r.success, true);
    assert.equal(r.purchased_queries, 100);
    assert.equal(r.purchased_unlocks, 20);

    const store = loadCredits();
    assert.equal(store[id].purchased_queries, 100);
    assert.equal(store[id].purchased_unlocks, 20);

    deleteRecord(id);
});

test('addPurchasedCredits: accumulates across multiple calls', async () => {
    const id = uid();
    writeRecord(id, { purchased_queries: 10, purchased_unlocks: 5 });

    await addPurchasedCredits(id, 50, 10);
    const store = loadCredits();
    assert.equal(store[id].purchased_queries, 60);
    assert.equal(store[id].purchased_unlocks, 15);

    deleteRecord(id);
});

test('addPurchasedCredits: production call shape (0 queries, N unlocks) only credits unlocks', async () => {
    const id = uid();
    writeRecord(id);

    // Mirrors the webhook's actual call: addPurchasedCredits(account_id, 0, unlocks, opts)
    const r = await addPurchasedCredits(id, 0, 80, { unlock_unit_price_usd: 0.125 });
    assert.equal(r.success, true);
    assert.equal(r.purchased_queries, 0, 'a pack purchase grants unlocks only');
    assert.equal(r.purchased_unlocks, 80);

    deleteRecord(id);
});

test('Purchased credits are deducted correctly', async () => {
    const id = uid();
    writeRecord(id, { purchased_unlocks: 10 });

    const r = await deductCredit(id, 'unlock');
    assert.equal(r.success, true);
    assert.equal(r.source, 'purchased');
    assert.equal(r.remaining, 9);

    deleteRecord(id);
});

test('getCreditStatus: shows purchased credits in the status response', async () => {
    const id = uid();
    writeRecord(id, { purchased_queries: 5, purchased_unlocks: 2 });

    const status = getCreditStatus(id);
    assert.equal(status.unlocks.purchased, 2);

    deleteRecord(id);
});

// 5. Period Reset
// ---------------------------------------------------------------------------

test('Period reset: purchased credits are NOT reset across periods', async () => {
    const id = uid();
    writeRecord(id, {
        purchased_queries: 25,
        purchased_unlocks: 8,
        period_start:      '2020-01-01T00:00:00.000Z',
        period_end:        '2020-02-01T00:00:00.000Z',
    });

    await deductCredit(id, 'unlock'); // triggers reset + deduction
    const store = loadCredits();
    assert.equal(store[id].purchased_unlocks, 7,
        'purchased_unlocks must survive the period reset (minus 1 deduction)');
    assert.equal(store[id].purchased_queries, 25,
        'legacy purchased_queries must survive the period reset untouched (retired currency, still readable)');

    deleteRecord(id);
});

test('resetIfNewPeriod: updates period_start, period_end and clears used counters', () => {
    const record = {
        queries_used: 45,
        unlocks_used: 4,
        purchased_queries: 10,
        purchased_unlocks: 3,
        period_start: '2020-01-01T00:00:00.000Z',
        period_end:   '2020-02-01T00:00:00.000Z',
    };

    const future = new Date('2020-03-15T00:00:00.000Z').getTime();
    const updated = resetIfNewPeriod(record, future);

    assert.equal(updated.queries_used, 0);
    assert.equal(updated.unlocks_used, 0);
    assert.equal(updated.purchased_queries, 10, 'purchased_queries must not be reset');
    assert.equal(updated.purchased_unlocks, 3, 'purchased_unlocks must not be reset');
    assert.ok(updated.period_end > '2020-02-01T00:00:00.000Z',
        'period_end must advance past the old end');
});

test('computePeriod: December → January rollover is correct', () => {
    const dec15 = new Date(Date.UTC(2025, 11, 15)).getTime(); // Dec 15, 2025
    const { period_start, period_end } = computePeriod(dec15);
    assert.equal(period_start, '2025-12-01T00:00:00.000Z');
    assert.equal(period_end,   '2026-01-01T00:00:00.000Z');
});

// 6. Deduction Fails Gracefully — no negative credits
// ---------------------------------------------------------------------------

test('Deduction: fails gracefully when purchased unlock credits exhausted', async () => {
    const id = uid();
    writeRecord(id, {
        purchased_queries: 0,
        purchased_unlocks: 0,
    });

    const ur = await deductCredit(id, 'unlock');
    assert.equal(ur.success, false);
    assert.ok(ur.message,   'Must include an error message');
    assert.ok(ur.message.includes('unlock'), 'Message must mention "unlock"');
    assert.ok(ur.message.includes('x402'),   'Must mention x402 as alternative');
    assert.ok(ur.status,    'Must include a status snapshot');

    deleteRecord(id);
});

test('Deduction: credits never go below zero', async () => {
    const id = uid();
    writeRecord(id, {
        purchased_unlocks: 1,
    });

    await deductCredit(id, 'unlock'); // consumes the last one
    const r2 = await deductCredit(id, 'unlock'); // must fail, not go negative
    assert.equal(r2.success, false);

    const store = loadCredits();
    assert.ok(store[id].purchased_unlocks >= 0, 'purchased_unlocks must not be negative');

    deleteRecord(id);
});

test('Deduction: rejected-query message differs from unlock-exhaustion message', async () => {
    const id = uid();
    writeRecord(id, {
        purchased_queries: 0,
        purchased_unlocks: 0,
    });

    const qr = await deductCredit(id, 'query');
    const ur = await deductCredit(id, 'unlock');
    assert.equal(qr.success, false, 'query is rejected outright (retired currency)');
    assert.equal(ur.success, false, 'unlock fails because the pool is exhausted');
    assert.notEqual(qr.message, ur.message, 'Messages should differ: rejection vs exhaustion');

    deleteRecord(id);
});

// 7. Concurrency — mutex prevents over-deduction
// ---------------------------------------------------------------------------

test('Concurrency: simultaneous deductions do not over-deduct (mutex)', async () => {
    const id = uid();
    const AVAILABLE = 3;
    writeRecord(id, {
        purchased_unlocks: AVAILABLE,
    });

    const TOTAL = 10;
    const results = await Promise.all(
        Array.from({ length: TOTAL }, () => deductCredit(id, 'unlock'))
    );

    const successes = results.filter(r => r.success).length;
    const failures  = results.filter(r => !r.success).length;
    assert.equal(successes, AVAILABLE, `Exactly ${AVAILABLE} deductions must succeed`);
    assert.equal(failures,  TOTAL - AVAILABLE);

    const store = loadCredits();
    assert.equal(store[id].purchased_unlocks, 0);

    deleteRecord(id);
});
