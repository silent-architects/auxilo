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
    const result = await deductCredit(id, 'query');
    assert.equal(result.success, false, 'Deduction must fail with no credits');
    assert.ok(result.message, 'Must include an error message');
    assert.ok(result.message.includes('x402'), 'Must mention x402 as alternative');
    deleteRecord(id);
});

// 2. Purchased Credits — Queries
// ---------------------------------------------------------------------------

test('Deduction: purchased query credit decrements and increments queries_used', async () => {
    const id = uid();
    writeRecord(id, { purchased_queries: 10 });

    const r = await deductCredit(id, 'query');
    assert.equal(r.success, true);
    assert.equal(r.remaining, 9);
    assert.equal(r.source, 'purchased');

    const store = loadCredits();
    assert.equal(store[id].purchased_queries, 9);
    assert.equal(store[id].queries_used, 1);

    deleteRecord(id);
});

test('Deduction: ten sequential query deductions leave correct counts', async () => {
    const id = uid();
    writeRecord(id, { purchased_queries: 50 });

    for (let i = 0; i < 10; i++) {
        const r = await deductCredit(id, 'query');
        assert.equal(r.success, true, `Deduction ${i + 1} must succeed`);
    }

    const store = loadCredits();
    assert.equal(store[id].purchased_queries, 40);
    assert.equal(store[id].queries_used, 10);

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

test('Deduction: query and unlock pools are fully independent', async () => {
    const id = uid();
    writeRecord(id, { purchased_queries: 3, purchased_unlocks: 5 });

    // Exhaust queries
    for (let i = 0; i < 3; i++) await deductCredit(id, 'query');
    // Unlock deduction still works
    const r = await deductCredit(id, 'unlock');
    assert.equal(r.success, true, 'Unlock must succeed when queries are exhausted');

    deleteRecord(id);
});

// 4. Purchased Credits — Add and Accumulate
// ---------------------------------------------------------------------------

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

test('Purchased credits are deducted correctly', async () => {
    const id = uid();
    writeRecord(id, { purchased_queries: 10 });

    const r = await deductCredit(id, 'query');
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

    await deductCredit(id, 'query'); // triggers reset + deduction
    const store = loadCredits();
    assert.equal(store[id].purchased_queries, 24,
        'purchased_queries must survive the period reset (minus 1 deduction)');
    assert.equal(store[id].purchased_unlocks, 8,
        'purchased_unlocks must survive the period reset');

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

test('Deduction: fails gracefully when purchased credits exhausted', async () => {
    const id = uid();
    writeRecord(id, {
        purchased_queries: 0,
        purchased_unlocks: 0,
    });

    const qr = await deductCredit(id, 'query');
    assert.equal(qr.success, false);
    assert.ok(qr.message,   'Must include an error message');
    assert.ok(qr.message.includes('query'),  'Message must mention "query"');
    assert.ok(qr.message.includes('x402'),   'Must mention x402 as alternative');
    assert.ok(qr.status,    'Must include a status snapshot');

    const ur = await deductCredit(id, 'unlock');
    assert.equal(ur.success, false);
    assert.ok(ur.message.includes('unlock'), 'Message must mention "unlock"');

    deleteRecord(id);
});

test('Deduction: credits never go below zero', async () => {
    const id = uid();
    writeRecord(id, {
        purchased_queries: 1,
    });

    await deductCredit(id, 'query'); // consumes the last one
    const r2 = await deductCredit(id, 'query'); // must fail, not go negative
    assert.equal(r2.success, false);

    const store = loadCredits();
    assert.ok(store[id].purchased_queries >= 0, 'purchased_queries must not be negative');

    deleteRecord(id);
});

test('Deduction: exhaustion message differs for query vs unlock', async () => {
    const id = uid();
    writeRecord(id, {
        purchased_queries: 0,
        purchased_unlocks: 0,
    });

    const qr = await deductCredit(id, 'query');
    const ur = await deductCredit(id, 'unlock');
    assert.notEqual(qr.message, ur.message, 'Messages should differ by credit type');

    deleteRecord(id);
});

// 7. Concurrency — mutex prevents over-deduction
// ---------------------------------------------------------------------------

test('Concurrency: simultaneous deductions do not over-deduct (mutex)', async () => {
    const id = uid();
    const AVAILABLE = 3;
    writeRecord(id, {
        purchased_queries: AVAILABLE,
    });

    const TOTAL = 10;
    const results = await Promise.all(
        Array.from({ length: TOTAL }, () => deductCredit(id, 'query'))
    );

    const successes = results.filter(r => r.success).length;
    const failures  = results.filter(r => !r.success).length;
    assert.equal(successes, AVAILABLE, `Exactly ${AVAILABLE} deductions must succeed`);
    assert.equal(failures,  TOTAL - AVAILABLE);

    const store = loadCredits();
    assert.equal(store[id].purchased_queries, 0);

    deleteRecord(id);
});
