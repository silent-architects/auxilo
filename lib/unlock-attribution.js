'use strict';

// ─── AUD19-2: per-(buyer, learning) accrual-cap store ─────────────────────────
//
// One credited contributor accrual per (buyer account, learning) per 30 days.
// This caps the ACCRUAL only — a repeat unlock still serves content and still
// burns the buyer's credit; the contributor simply doesn't accrue again, and
// the demand counters don't pump. Applied on the account (credit) path only:
// anonymous x402 settles real money at full list price, so accrual there is
// revenue-backed and needs no cap for solvency (decision doc §4.1).
//
// Store: data/unlock-attribution.json — flat map
//   "<buyerAccountId>:<learningId>" -> last credited-accrual timestamp (ms).
// Expired entries are pruned on every write so the file cannot grow unbounded.
// Read-per-call + tmp/rename atomic save, same idiom as lib/credits.js.

const fs = require('fs');
const path = require('path');

// AUXILO_UNLOCK_ATTRIBUTION_FILE override: test isolation only (unset in production).
const ATTRIBUTION_FILE = process.env.AUXILO_UNLOCK_ATTRIBUTION_FILE
    || path.join(__dirname, '..', 'data', 'unlock-attribution.json');

// 1 credited accrual per (buyer, learning) per 30 days.
const ACCRUAL_CAP_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

function loadAttribution() {
    try { return JSON.parse(fs.readFileSync(ATTRIBUTION_FILE, 'utf8')); }
    catch { return {}; }
}

function saveAttribution(map) {
    fs.mkdirSync(path.dirname(ATTRIBUTION_FILE), { recursive: true });
    const tmp = ATTRIBUTION_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(map, null, 2));
    fs.renameSync(tmp, ATTRIBUTION_FILE);
}

function capKey(buyerAccountId, learningId) {
    return `${buyerAccountId}:${learningId}`;
}

/**
 * True when this (buyer, learning) pair already produced a credited contributor
 * accrual inside the cap window. Never true for missing identities — the cap
 * fails open to "not capped" (the basis fix, not the cap, is the primary
 * economic control; decision doc §3).
 */
function isAccrualCapped(buyerAccountId, learningId, now = Date.now()) {
    if (!buyerAccountId || !learningId) return false;
    const map = loadAttribution();
    const ts = map[capKey(buyerAccountId, learningId)];
    return typeof ts === 'number' && (now - ts) < ACCRUAL_CAP_WINDOW_MS;
}

/**
 * Record a credited accrual for (buyer, learning), arming the cap for the
 * window. Prunes expired entries on write.
 */
function recordAccrual(buyerAccountId, learningId, now = Date.now()) {
    if (!buyerAccountId || !learningId) return;
    const map = loadAttribution();
    for (const k of Object.keys(map)) {
        if (typeof map[k] !== 'number' || (now - map[k]) >= ACCRUAL_CAP_WINDOW_MS) delete map[k];
    }
    map[capKey(buyerAccountId, learningId)] = now;
    saveAttribution(map);
}

/**
 * AUD19-10: un-arm the cap after a refunded delivery failure. ONLY safe when
 * the SAME request armed it: reaching recordAccrual proves no live in-window
 * entry existed for the pair (a live entry routes the handler to the capped
 * early-return before recordAccrual), and the arm→compensation window in the
 * unlock handler contains no await, so no interleaved request can have
 * re-armed it. Deleting the key therefore cannot erase an older grant — it
 * removes exactly the arm this failed (and refunded) request created, so the
 * buyer's successful retry accrues normally instead of $0.
 */
function unrecordAccrual(buyerAccountId, learningId) {
    if (!buyerAccountId || !learningId) return;
    const map = loadAttribution();
    const key = capKey(buyerAccountId, learningId);
    if (Object.prototype.hasOwnProperty.call(map, key)) {
        delete map[key];
        saveAttribution(map);
    }
}

module.exports = {
    isAccrualCapped,
    recordAccrual,
    unrecordAccrual,
    ACCRUAL_CAP_WINDOW_MS,
    // Exported for testing only:
    loadAttribution,
    saveAttribution,
    ATTRIBUTION_FILE,
};
