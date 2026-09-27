'use strict';

/**
 * lib/checkout-sessions.js — ruling M3.
 *
 * Both purchase caps (lib/credit-caps.js) were checked only when a Checkout
 * session was CREATED, and nothing was reserved for it -- a buyer could open
 * many sessions while under the cap, each one individually passing the
 * pre-check, then pay all of them and land far over the cap before the
 * webhook's second check (defense in depth) ever saw a problem.
 *
 * This module records every Checkout session at the moment it is created
 * (id, amount, created time) so both cap checks can count unpaid, unexpired
 * sessions alongside real balance/purchase history. Each session gets a
 * 30-minute expiry, matching the `expires_at` set on the Stripe session
 * itself (lib/stripe.js) -- after that, a session can no longer be paid, so
 * it stops counting.
 *
 * A session is cleared the moment its webhook delivers a successful credit
 * (server.js) -- from then on the money it represents is counted the normal
 * way, as a real dollar lot and a real purchase record, never twice.
 *
 * The webhook's SECOND check (server.js, after the credit has already
 * landed) is unchanged by this module: it still credits in full, holds, and
 * alerts (ruling M3) -- it just reads a more complete picture of what's
 * pending now.
 *
 * Own data file, created on first use. A missing file reads as no pending
 * sessions.
 */

const fs = require('fs');
const path = require('path');

// AUXILO_CHECKOUT_SESSIONS_FILE override: test isolation only (unset in production).
const SESSIONS_FILE = process.env.AUXILO_CHECKOUT_SESSIONS_FILE
    || path.join(__dirname, '..', 'data', 'checkout-sessions.json');

const PENDING_SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes

function load() {
    try { return JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')); }
    catch { return {}; }
}

function save(state) {
    const tmp = SESSIONS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, SESSIONS_FILE);
}

/** Record a just-created Checkout session (id, account, amount, created time). */
function recordPendingSession(sessionId, accountId, amountUsd, nowMs = Date.now()) {
    if (!sessionId) return;
    const state = load();
    state[sessionId] = { account_id: accountId, amount_usd: amountUsd, created_at: nowMs };
    save(state);
}

/** Called once a session's webhook has credited the account (or the session
 * is otherwise no longer relevant) — it stops counting toward either cap. */
function clearPendingSession(sessionId) {
    if (!sessionId) return;
    const state = load();
    if (sessionId in state) {
        delete state[sessionId];
        save(state);
    }
}

/** Sum of amount_usd across this account's unpaid, unexpired sessions. */
function getPendingSessionsTotalUsd(accountId, nowMs = Date.now()) {
    const state = load();
    let total = 0;
    for (const s of Object.values(state)) {
        if (!s || s.account_id !== accountId) continue;
        if ((nowMs - s.created_at) >= PENDING_SESSION_TTL_MS) continue;
        total += s.amount_usd || 0;
    }
    return Math.round((total + Number.EPSILON) * 1e6) / 1e6;
}

module.exports = {
    recordPendingSession,
    clearPendingSession,
    getPendingSessionsTotalUsd,
    PENDING_SESSION_TTL_MS,
    SESSIONS_FILE,
    // Exported for testing only:
    load,
    save,
};
