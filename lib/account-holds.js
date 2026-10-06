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
 * (clearAccountHold) called from the admin route, with ONE automatic
 * exception (ruling H2): a dispute_hold clears itself when the SAME
 * dispute that placed it closes 'won' or 'warning_closed' — never a
 * dispute_hold a different, still-open dispute placed (ruling N6).
 */

const fs = require('fs');
const path = require('path');

// AUXILO_ACCOUNT_HOLDS_FILE override: test isolation only (unset in production).
const HOLDS_FILE = process.env.AUXILO_ACCOUNT_HOLDS_FILE
    || path.join(process.env.AUXILO_DATA_DIR || path.join(__dirname, '..', 'data'), 'account-holds.json');

// N9: the durable record of who cleared a hold and when -- a line appended
// on every clear, never overwritten. The admin route's ops alert (kept
// alongside this) is rate-limited and can be a no-op when alerting is
// unconfigured; this file is the record that survives both.
// AUXILO_HOLD_CLEAR_LOG_FILE override: test isolation only (unset in production).
const HOLD_CLEAR_LOG_FILE = process.env.AUXILO_HOLD_CLEAR_LOG_FILE
    || path.join(process.env.AUXILO_DATA_DIR || path.join(__dirname, '..', 'data'), 'hold-clear-log.jsonl');

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
        const value = JSON.parse(raw);
        const { plainObject } = require('./stripe-transfer-persistence');
        if (!plainObject(value) || Object.values(value).some(record => !plainObject(record))) throw new Error('Invalid financial primary schema');
        return value;
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
    require('./stripe-transfer-persistence').writeJSONAtomic(HOLDS_FILE, holds);
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

/**
 * N9: append one durable line recording who cleared a hold and when — the
 * account, the hold's own reason, the time, and the admin scope that
 * cleared it. Own file, created on first use (mkdir + append, same idiom
 * as lib/tos-acceptance-log.js). Never blocks the clear that already
 * happened: a write failure here is logged, not thrown.
 */
function appendHoldClearLog({ accountId, reason, clearedAt, adminScope }) {
    const row = {
        account_id: accountId,
        reason: reason || null,
        cleared_at: clearedAt || new Date().toISOString(),
        admin_scope: adminScope || 'admin',
    };
    try {
        fs.mkdirSync(path.dirname(HOLD_CLEAR_LOG_FILE), { recursive: true });
        fs.appendFileSync(HOLD_CLEAR_LOG_FILE, JSON.stringify(row) + '\n');
    } catch (err) {
        console.error('[account-holds] hold-clear log append failed (non-fatal):', err && err.message);
    }
    return row;
}

/** Test/ops helper: every durable hold-clear row on file, oldest first. A
 * missing file (nothing cleared yet) reads as empty. */
function loadHoldClearLog() {
    try {
        return fs.readFileSync(HOLD_CLEAR_LOG_FILE, 'utf8')
            .split('\n').filter(Boolean).map((line) => JSON.parse(line));
    } catch (err) {
        if (err && err.code === 'ENOENT') return [];
        console.error('[account-holds] hold-clear log read failed:', err && err.message);
        return [];
    }
}

// Synchronous read/compare/write: a stale event cannot clear a replacement hold.
function sameDisputeIdentity(actual, expected) {
    if (!actual || !expected || !actual.payment_intent || actual.payment_intent !== expected.payment_intent) return false;
    if (expected.stripe_platform) {
        require('./stripe-object-origins').validateContext(expected);
        if (actual.stripe_platform !== expected.stripe_platform || actual.stripe_platform_account_id !== expected.stripe_platform_account_id) return false;
    } else if (actual.stripe_platform || actual.stripe_platform_account_id) return false;
    return !(actual.dispute_id && expected.dispute_id && actual.dispute_id !== expected.dispute_id);
}
function placeDisputeHoldIfCompatible(accountId, detail) {
    const holds = loadHolds();
    const current = holds[accountId];
    if (detail.stripe_platform) require('./stripe-object-origins').validateContext(detail);
    if (current && (current.reason !== 'dispute_hold' || !sameDisputeIdentity(current.detail, detail))) {
        return { placed: false, conflict: true, reason: 'existing_hold_identity_conflict' };
    }
    holds[accountId] = {reason:'dispute_hold',detail,held_at:current ? current.held_at : new Date().toISOString()};
    saveHolds(holds);
    return {placed:true,conflict:false,hold:holds[accountId]};
}
function clearDisputeHoldIfMatches(accountId, expectedIdentity) {
    const holds = loadHolds();
    const current = holds[accountId];
    if (!current || current.reason !== 'dispute_hold' || !sameDisputeIdentity(current.detail, expectedIdentity)) return false;
    delete holds[accountId];
    saveHolds(holds);
    return true;
}

module.exports = {
    placeDisputeHoldIfCompatible,
    clearDisputeHoldIfMatches,
    holdAccount,
    isAccountHeld,
    getAccountHold,
    clearAccountHold,
    appendHoldClearLog,
    loadHoldClearLog,
    HOLD_CLEAR_LOG_FILE,
    // Exported for testing only:
    loadHolds,
    saveHolds,
    HOLDS_FILE,
};
