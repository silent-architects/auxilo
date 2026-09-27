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
    addDollarLot,
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

test('New account: starts with a zero dollar balance', () => {
    const id = uid();
    const status = getCreditStatus(id);
    assert.deepEqual(status.credit_balance, { paid_usd: 0, promo_usd: 0, total_usd: 0, frozen_usd: 0 }); // L3: frozen_usd now reported
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

test('Deduction: legacy purchased_queries/purchased_unlocks fields survive a real dollar-lot deduction untouched', async () => {
    const id = uid();
    writeRecord(id, { purchased_queries: 10, purchased_unlocks: 5 });
    await addDollarLot(id, 'dollar_paid', 1);

    const r = await deductCredit(id, 'unlock', 1);
    assert.equal(r.success, true);

    const store = loadCredits();
    assert.equal(store[id].purchased_queries, 10, 'legacy query balance is read-only now, never touched');
    assert.equal(store[id].purchased_unlocks, 5, 'legacy unlock count is read-only now, never touched');
    assert.equal(store[id].dollar_lots[0].remaining_usd, 0, 'the real dollar balance still deducts normally');

    deleteRecord(id);
});

test('getOrInitCredits: a pre-existing record carrying only legacy query fields still loads without error', () => {
    const id = uid();
    // Simulate a pre-retirement record shape: purchased_queries/queries_used
    // present, no dollar_lots yet. Must be readable, not migrated/stripped.
    writeRecord(id, { purchased_queries: 7, queries_used: 3, purchased_unlocks: 0 });

    const status = getCreditStatus(id);
    assert.deepEqual(status.credit_balance, { paid_usd: 0, promo_usd: 0, total_usd: 0, frozen_usd: 0 }); // L3: frozen_usd now reported

    const store = loadCredits();
    assert.equal(store[id].purchased_queries, 7, 'legacy field survives a read cycle unchanged');
    assert.equal(store[id].queries_used, 3, 'legacy field survives a read cycle unchanged');

    deleteRecord(id);
});

// 3. Purchased Credits — Unlocks
// ---------------------------------------------------------------------------
//
// RETIRED (credits-as-cash follow-up, SITE-PM 2026-09-27): both tests here
// pinned deductCredit() spending a unit lot off purchased_unlocks — that
// path is gone. The unlock path debits the account's dollar balance only
// (test/credits-as-cash-lots.test.js, test/credits-one-balance.test.js).
//   - 'Deduction: purchased unlock credit decrements and increments
//     unlocks_used'
//   - 'Deduction: unlock deduction succeeds regardless of a legacy
//     purchased_queries balance'

// 4. Purchased Credits — Add and Accumulate
// ---------------------------------------------------------------------------
//
// RETIRED (credits-as-cash follow-up): addPurchasedCredits() is deleted — no
// code path creates a unit lot anymore (F-3). All four tests here called it
// directly or relied on it having run:
//   - 'addPurchasedCredits: adds queries and unlocks to the account'
//   - 'addPurchasedCredits: accumulates across multiple calls'
//   - 'addPurchasedCredits: production call shape (0 queries, N unlocks)
//     only credits unlocks'
//   - 'Purchased credits are deducted correctly'
//   - 'getCreditStatus: shows purchased credits in the status response' —
//     also asserted status.unlocks.purchased, a field F-7 removes from
//     GET /account/credits.

// 5. Period Reset
// ---------------------------------------------------------------------------
//
// RETIRED (credits-as-cash follow-up): 'Period reset: purchased credits are
// NOT reset across periods' drove its assertion through deductCredit(),
// which no longer reads or spends purchased_unlocks — the "minus 1
// deduction" it expected never happens. resetIfNewPeriod's own field-survival
// behavior is proved directly below, unaffected by this build.
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

test('Deduction: repeated deductions with no dollar balance never go negative', async () => {
    const id = uid();
    writeRecord(id, {
        purchased_unlocks: 1,
    });

    // purchased_unlocks is a leftover field the dollar-only unlock path
    // never reads or spends (F-6) — with no dollar lot on the account,
    // every deduction fails, and nothing here can ever go negative.
    await deductCredit(id, 'unlock');
    const r2 = await deductCredit(id, 'unlock');
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
//
// RETIRED (credits-as-cash follow-up, SITE-PM 2026-09-27): 'Concurrency:
// simultaneous deductions do not over-deduct (mutex)' sized a unit lot
// (purchased_unlocks: 3) and expected exactly 3 of 10 concurrent deductions
// to succeed — the unlock path no longer spends purchased_unlocks, so every
// deduction here would fail instead. The account-lock mutex is proved
// against a real dollar balance in test/credits-as-cash-lots.test.js
// ('concurrency: two simultaneous unlocks against an exact dollar balance').
