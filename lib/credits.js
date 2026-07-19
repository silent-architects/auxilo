'use strict';

const fs = require('fs');
const path = require('path');

// ─── Constants ────────────────────────────────────────────────────────────────

// AUXILO_CREDITS_FILE override: test isolation only (unset in production).
const CREDITS_FILE = process.env.AUXILO_CREDITS_FILE
    || path.join(__dirname, '..', 'data', 'credits.json');

// AUD19-2: fallback pro-rata unit price for unlock credits whose purchase price
// is unknown (pre-lot legacy balances with no purchase history, or callers that
// don't pass one). $0.10 == growth/pro pack rate, the conservative middle.
const DEFAULT_UNLOCK_UNIT_PRICE_USD = 0.10;

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

// ─── AUD19-2: Unlock Credit Lots ─────────────────────────────────────────────
//
// Every unlock credit belongs to a LOT carrying the pro-rata USD price the
// buyer actually paid for it (pack price / unlocks in the pack; $0.00 for
// referral/free grants). The unlock accrual basis is min(list price, lot unit
// price), so contributor obligations can never exceed collected revenue.
// `purchased_unlocks` remains the authoritative COUNT everywhere (exhaustion
// checks, status); lots always reconcile to it.

function normalizeUnitPrice(v, fallback = DEFAULT_UNLOCK_UNIT_PRICE_USD) {
    return (typeof v === 'number' && Number.isFinite(v) && v >= 0) ? v : fallback;
}

/**
 * Derive the legacy (pre-lot) unit price for an account from its purchase
 * history: Σ amount_usd / Σ unlocks_added across recorded pack purchases.
 * Falls back to DEFAULT_UNLOCK_UNIT_PRICE_USD when there is no usable history.
 */
function deriveLegacyUnitPrice(accountId) {
    try {
        // Lazy require: keeps module-load order independent of lib/stripe.js.
        const { getPurchasesForAccount } = require('./stripe.js');
        const purchases = getPurchasesForAccount(accountId) || [];
        let usd = 0, unlocks = 0;
        for (const p of purchases) {
            if (p && typeof p.amount_usd === 'number' && typeof p.unlocks_added === 'number' && p.unlocks_added > 0) {
                usd += p.amount_usd;
                unlocks += p.unlocks_added;
            }
        }
        if (unlocks > 0 && Number.isFinite(usd) && usd >= 0) return usd / unlocks;
    } catch { /* fall through to default */ }
    return DEFAULT_UNLOCK_UNIT_PRICE_USD;
}

/**
 * Reconcile a record's unlock_lots with its authoritative purchased_unlocks
 * count. Pre-lot balances get ONE legacy lot at the derived unit price
 * (persisted lazily on first touch — same idiom as the pre-0.4 field guards).
 * If lots ever exceed the count (defensive), trim from the tail.
 */
function ensureUnlockLots(record, accountId) {
    if (!Array.isArray(record.unlock_lots)) record.unlock_lots = [];
    record.unlock_lots = record.unlock_lots.filter(l =>
        l && typeof l.remaining === 'number' && l.remaining > 0 && typeof l.unit_price_usd === 'number');
    let lotTotal = record.unlock_lots.reduce((s, l) => s + l.remaining, 0);
    if (lotTotal < record.purchased_unlocks) {
        record.unlock_lots.push({
            unit_price_usd: deriveLegacyUnitPrice(accountId),
            remaining: record.purchased_unlocks - lotTotal,
            legacy: true,
        });
    } else if (lotTotal > record.purchased_unlocks) {
        let excess = lotTotal - record.purchased_unlocks;
        for (let i = record.unlock_lots.length - 1; i >= 0 && excess > 0; i--) {
            const take = Math.min(record.unlock_lots[i].remaining, excess);
            record.unlock_lots[i].remaining -= take;
            excess -= take;
        }
        record.unlock_lots = record.unlock_lots.filter(l => l.remaining > 0);
    }
}

/**
 * Consume one unlock credit from the lots and return its unit price.
 * Ordering rule (decision-doc test 7 pin): PAID lots first (FIFO among paid),
 * then $0 grant lots — the buyer spends what they paid for before freebies.
 */
function consumeUnlockLot(record) {
    const lot = record.unlock_lots.find(l => l.remaining > 0 && l.unit_price_usd > 0)
        || record.unlock_lots.find(l => l.remaining > 0);
    if (!lot) return DEFAULT_UNLOCK_UNIT_PRICE_USD; // unreachable after ensureUnlockLots; defensive
    lot.remaining--;
    const price = lot.unit_price_usd;
    if (lot.remaining === 0) {
        record.unlock_lots = record.unlock_lots.filter(l => l.remaining > 0);
    }
    return price;
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
            // AUD19-2: unlock credits carry a lot price — consume paid lots
            // first and surface the consumed credit's pro-rata unit price so
            // the unlock handler can accrue on the amount actually paid.
            let unitPrice;
            if (creditType === 'unlock') {
                ensureUnlockLots(record, accountId);
                unitPrice = consumeUnlockLot(record);
            }
            record[purchasedKey]--;
            record[usedKey]++;
            record.last_deducted_at = now;
            saveCredits(credits);
            const result = { success: true, remaining: record[purchasedKey], source: 'purchased' };
            if (creditType === 'unlock') result.unit_price_usd = unitPrice;
            return result;
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

async function addPurchasedCredits(accountId, queries, unlocks, opts = {}) {
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

        // AUD19-2: lot the new unlocks with their real pro-rata unit price.
        // Reconcile legacy (pre-lot) balance against the OLD count first so the
        // derived-price legacy lot sits ahead of this one in FIFO order.
        if (unlocks > 0) {
            ensureUnlockLots(record, accountId);
            record.unlock_lots.push({
                unit_price_usd: normalizeUnitPrice(opts.unlock_unit_price_usd),
                remaining: unlocks,
                added_at: now,
            });
        }

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
    DEFAULT_UNLOCK_UNIT_PRICE_USD,
    // Exported for testing only:
    loadCredits,
    saveCredits,
    computePeriod,
    getOrInitCredits,
    resetIfNewPeriod,
    ensureUnlockLots,
    consumeUnlockLot,
    deriveLegacyUnitPrice
};
