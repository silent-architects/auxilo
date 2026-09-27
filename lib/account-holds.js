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

function loadHolds() {
    try { return JSON.parse(fs.readFileSync(HOLDS_FILE, 'utf8')); }
    catch { return {}; }
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
