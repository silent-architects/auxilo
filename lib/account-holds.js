'use strict';

/**
 * lib/account-holds.js — AUD-CAC account holds (spec §2 test 16, §8 test 26).
 *
 * A tiny, independent store recording that an account is temporarily
 * blocked from starting a NEW purchase (POST /checkout/session refuses with
 * a plain message). Two distinct reasons place a hold, both requiring a
 * human to clear it before purchasing resumes:
 *
 *   - 'cap_overage'   — the webhook's second cap check (defense in depth)
 *                       found a purchase crossed the balance or daily cap
 *                       after the money was already collected by Stripe.
 *   - 'dispute_hold'  — a dispute opened on a lot that was already more
 *                       than half spent (spec test 26).
 *
 * A hold NEVER blocks spending an existing balance or receiving a refund —
 * only starting a new purchase. Clearing a hold is a manual ops action
 * (clearAccountHold), never automatic.
 */

const fs = require('fs');
const path = require('path');

// AUXILO_ACCOUNT_HOLDS_FILE override: test isolation only (unset in production).
const HOLDS_FILE = process.env.AUXILO_ACCOUNT_HOLDS_FILE
    || path.join(__dirname, '..', 'data', 'account-holds.json');

// L11: a missing file (first use -- nobody has ever been held) reads as
// empty. Any other read/parse failure must not be silently treated as "no
// holds exist" -- the next holdAccount/clearAccountHold write would then
// overwrite the file and erase every other account's hold. Refuse instead:
// throw (logged once here, plus an ops alert), so the caller's request
// fails loudly rather than silently lifting every hold.
function loadHolds() {
    let raw;
    try {
        raw = fs.readFileSync(HOLDS_FILE, 'utf8');
    } catch (err) {
        if (err && err.code === 'ENOENT') return {};
        console.error('[account-holds] refusing to treat a read failure as no holds:', err && err.message);
        try { require('./ops-alert.js').sendOpsAlert(
            'account-holds.json unreadable',
            `error=${err && err.code || 'unknown'} message=${err && err.message}`,
            { category: 'credits-corrupt-file' }
        ).catch(() => {}); } catch { /* best effort */ }
        throw err;
    }
    try {
        return JSON.parse(raw);
    } catch (err) {
        console.error('[account-holds] refusing to treat a corrupt file as no holds:', err && err.message);
        try { require('./ops-alert.js').sendOpsAlert(
            'account-holds.json corrupt (parse failure)',
            `message=${err && err.message}`,
            { category: 'credits-corrupt-file' }
        ).catch(() => {}); } catch { /* best effort */ }
        throw err;
    }
}

function saveHolds(holds) {
    fs.mkdirSync(path.dirname(HOLDS_FILE), { recursive: true });
    const tmp = HOLDS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(holds, null, 2));
    fs.renameSync(tmp, HOLDS_FILE);
}

/**
 * Place (or refresh) a hold on an account. Idempotent — a second hold for
 * the same reason just refreshes the timestamp and detail.
 */
function holdAccount(accountId, reason, detail = null) {
    const holds = loadHolds();
    holds[accountId] = {
        reason,
        detail,
        held_at: new Date().toISOString(),
    };
    saveHolds(holds);
    return holds[accountId];
}

function isAccountHeld(accountId) {
    const holds = loadHolds();
    return !!holds[accountId];
}

function getAccountHold(accountId) {
    const holds = loadHolds();
    return holds[accountId] || null;
}

/** Manual ops action — clears a hold once the overage/shortfall is resolved. */
function clearAccountHold(accountId) {
    const holds = loadHolds();
    if (!holds[accountId]) return false;
    delete holds[accountId];
    saveHolds(holds);
    return true;
}

module.exports = {
    holdAccount,
    isAccountHeld,
    getAccountHold,
    clearAccountHold,
    // Exported for testing only:
    loadHolds,
    saveHolds,
    HOLDS_FILE,
};
