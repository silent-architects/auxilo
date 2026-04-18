'use strict';

const fs = require('fs');
const path = require('path');

// ─── Constants ────────────────────────────────────────────────────────────────

const CREDITS_FILE = path.join(__dirname, '..', 'data', 'credits.json');

// ─── File I/O ─────────────────────────────────────────────────────────────────

function loadCredits() {
    try { return JSON.parse(fs.readFileSync(CREDITS_FILE, 'utf8')); }
    catch { return {}; }
}

function saveCredits(credits) {
    const tmp = CREDITS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(credits, null, 2));
    fs.renameSync(tmp, CREDITS_FILE);
}

// ─── Period Calculation ───────────────────────────────────────────────────────

function computePeriod(now) {
    const d = new Date(now);
    const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
    const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
    return {
        period_start: start.toISOString(),
        period_end: end.toISOString()
    };
}

// ─── Credit Record Helpers ────────────────────────────────────────────────────

function createFreshRecord(now) {
    const { period_start, period_end } = computePeriod(now);
    return {
        queries_used: 0,
        unlocks_used: 0,
        purchased_queries: 0,
        purchased_unlocks: 0,
        period_start,
        period_end,
        created_at: now,
        last_deducted_at: null
    };
}

function resetIfNewPeriod(record, now) {
    if (now >= new Date(record.period_end).getTime()) {
        const { period_start, period_end } = computePeriod(now);
        record.queries_used = 0;
        record.unlocks_used = 0;
        // purchased_queries and purchased_unlocks intentionally NOT reset
        record.period_start = period_start;
        record.period_end = period_end;
    }
    return record;
}

function getOrInitCredits(accountId, now) {
    const credits = loadCredits();
    if (!credits[accountId]) {
        credits[accountId] = createFreshRecord(now);
        saveCredits(credits);
        return credits[accountId];
    }
    const oldPeriodEnd = credits[accountId].period_end;
    resetIfNewPeriod(credits[accountId], now);
    // Persist if reset occurred (period boundary crossed)
    if (credits[accountId].period_end !== oldPeriodEnd) {
        saveCredits(credits);
    }
    return credits[accountId];
}

// ─── Per-Account Mutex ────────────────────────────────────────────────────────

const accountMutexes = new Map();

function acquireAccountLock(accountId) {
    if (!accountMutexes.has(accountId)) {
        accountMutexes.set(accountId, { chain: Promise.resolve(), count: 0 });
    }
    const entry = accountMutexes.get(accountId);
    let release;
    const newChain = new Promise((resolve) => {
        release = () => {
            entry.count--;
            if (entry.count === 0) accountMutexes.delete(accountId);
            resolve();
        };
    });
    const acquire = entry.chain.then(() => release);
    entry.chain = newChain;
    entry.count++;
    return acquire;
}

// ─── Core Operations ──────────────────────────────────────────────────────────

async function deductCredit(accountId, creditType) {
    const release = await acquireAccountLock(accountId);
    try {
        const now = Date.now();
        const credits = loadCredits();

        if (!credits[accountId]) {
            credits[accountId] = createFreshRecord(now);
        }

        resetIfNewPeriod(credits[accountId], now);

        const record = credits[accountId];
        // Ensure purchased fields exist (backward compat for pre-0.4 records)
        if (typeof record.purchased_queries !== 'number') record.purchased_queries = 0;
        if (typeof record.purchased_unlocks !== 'number') record.purchased_unlocks = 0;

        const usedKey = creditType === 'unlock' ? 'unlocks_used' : 'queries_used';
        const purchasedKey = creditType === 'unlock' ? 'purchased_unlocks' : 'purchased_queries';
        const typeName = creditType === 'unlock' ? 'unlock' : 'query';

        // Deduct from purchased credits
        if (record[purchasedKey] > 0) {
            record[purchasedKey]--;
            record[usedKey]++;
            record.last_deducted_at = now;
            saveCredits(credits);
            return { success: true, remaining: record[purchasedKey], source: 'purchased' };
        }

        // No credits available
        return {
            success: false,
            message: `All ${typeName} credits exhausted. Buy a credit pack or pay per-call via x402.`,
            status: {
                purchased_queries: record.purchased_queries,
                purchased_unlocks: record.purchased_unlocks,
                queries_used: record.queries_used,
                unlocks_used: record.unlocks_used,
                period_end: record.period_end
            }
        };
    } finally {
        release();
    }
}

// ─── Add Purchased Credits ───────────────────────────────────────────────────

async function addPurchasedCredits(accountId, queries, unlocks) {
    const release = await acquireAccountLock(accountId);
    try {
        const now = Date.now();
        const credits = loadCredits();

        if (!credits[accountId]) {
            credits[accountId] = createFreshRecord(now);
        }

        resetIfNewPeriod(credits[accountId], now);

        const record = credits[accountId];
        // Ensure purchased fields exist
        if (typeof record.purchased_queries !== 'number') record.purchased_queries = 0;
        if (typeof record.purchased_unlocks !== 'number') record.purchased_unlocks = 0;

        record.purchased_queries += queries;
        record.purchased_unlocks += unlocks;
        saveCredits(credits);

        return {
            success: true,
            purchased_queries: record.purchased_queries,
            purchased_unlocks: record.purchased_unlocks,
        };
    } finally {
        release();
    }
}

// ─── Credit Status ────────────────────────────────────────────────────────────

function getCreditStatus(accountId) {
    const now = Date.now();
    const record = getOrInitCredits(accountId, now);
    return {
        unlocks: {
            used: record.unlocks_used,
            purchased: record.purchased_unlocks || 0,
        },
        period: {
            start: record.period_start,
            end: record.period_end
        },
        plan: 'funded'
    };
}

module.exports = {
    deductCredit,
    getCreditStatus,
    addPurchasedCredits,
    // Exported for testing only:
    loadCredits,
    saveCredits,
    computePeriod,
    getOrInitCredits,
    resetIfNewPeriod
};
