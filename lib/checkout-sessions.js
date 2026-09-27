'use strict';

/**
 * lib/checkout-sessions.js — ruling M3, ruling N2, ruling N7.
 *
 * Both purchase caps (lib/credit-caps.js) were checked only when a Checkout
 * session was CREATED, and nothing was reserved for it -- a buyer could open
 * many sessions while under the cap, each one individually passing the
 * pre-check, then pay all of them and land far over the cap before the
 * webhook's second check (defense in depth) ever saw a problem. Sequential
 * requests are closed by the cap check alone (each one sees the sessions
 * the ones before it recorded). PARALLEL requests are not: each can run its
 * own check before any of them has recorded anything.
 *
 * ruling M3's fix: acquireCheckoutLock(accountId) serializes the
 * check-then-reserve sequence for one account. reservePendingSession
 * records a placeholder reservation (a local id, the amount, the time) --
 * counted by getPendingSessionsTotalUsd exactly like a real session --
 * BEFORE the caller ever calls Stripe. promoteReservation replaces it with
 * the real session once Stripe confirms one; clearPendingSession deletes it
 * (by either kind of id) on any failure. The lock is held only across the
 * check + reservation, never across the Stripe network round trip.
 *
 * ruling N2: a session or reservation is counted only until its OWN
 * expires_at (a reservation gets a short bound of its own, until it is
 * promoted or deleted; a real session is counted until the expiry Stripe
 * itself returned for it) -- never a fixed local window assumed to match
 * what Stripe enforces.
 *
 * The webhook's SECOND check (server.js, after the credit has already
 * landed) is unchanged by this module: it still credits in full, holds, and
 * alerts (ruling M3) -- it just reads a more complete picture of what's
 * pending now.
 *
 * ruling N7: this file follows the SAME read rule as the other ledger files
 * (lib/credits.js, lib/account-holds.js) -- a missing file (first use) is
 * the only case that reads as empty; any other read/parse failure refuses
 * (throws, alerted) rather than silently reading as "nothing pending",
 * which would undercount both caps and let a purchase through that a
 * healthy read would have refused. That refusal only ever reaches a NEW
 * purchase (the pre-check, before any Stripe call) -- the webhook's CREDIT
 * itself (addDollarLot) never reads this file, so a purchase already paid
 * is always credited regardless of this file's state. The webhook DOES
 * still write to this file right after crediting (clearPendingSession, so
 * the just-paid session stops counting as pending) -- ruling N17: that
 * write is wrapped in its own try/catch in server.js and can never fail
 * the webhook itself, so a corrupt file here costs only this bookkeeping
 * step (and a rate-limited ops alert), never the credit, never the second
 * cap check, never the referral grant. Entries past their own expiry are
 * dropped on every write, so the file does not grow forever with every
 * session ever opened.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// AUXILO_CHECKOUT_SESSIONS_FILE override: test isolation only (unset in production).
const SESSIONS_FILE = process.env.AUXILO_CHECKOUT_SESSIONS_FILE
    || path.join(__dirname, '..', 'data', 'checkout-sessions.json');

// N2: a placeholder reservation's own bound, before the real Stripe expiry
// is known -- long enough to cover a slow Checkout-session creation call,
// short enough that a request that dies before promoting or deleting it (a
// crash, not a clean failure) cannot hold a phantom reservation against the
// caps for long.
const RESERVATION_TTL_MS = 5 * 60 * 1000; // 5 minutes

function round6(v) {
    return Math.round((v + Number.EPSILON) * 1e6) / 1e6;
}

// N7: see the file header. Only ENOENT (first use) reads as empty.
function load() {
    let raw;
    try {
        raw = fs.readFileSync(SESSIONS_FILE, 'utf8');
    } catch (err) {
        if (err && err.code === 'ENOENT') return {};
        console.error('[checkout-sessions] refusing to treat a read failure as no pending sessions:', err && err.message);
        try { require('./ops-alert.js').sendOpsAlert(
            'checkout-sessions.json unreadable',
            `error=${err && err.code || 'unknown'} message=${err && err.message}`,
            { category: 'credits-corrupt-file' }
        ).catch(() => {}); } catch { /* best effort -- never let alerting mask the real error */ }
        throw err;
    }
    try {
        return JSON.parse(raw);
    } catch (err) {
        console.error('[checkout-sessions] refusing to treat a corrupt file as no pending sessions:', err && err.message);
        try { require('./ops-alert.js').sendOpsAlert(
            'checkout-sessions.json corrupt (parse failure)',
            `message=${err && err.message}`,
            { category: 'credits-corrupt-file' }
        ).catch(() => {}); } catch { /* best effort */ }
        throw err;
    }
}

// N7: drop every entry past its own expiry on each write.
function pruneExpired(state, nowMs = Date.now()) {
    for (const id of Object.keys(state)) {
        const s = state[id];
        if (!s || typeof s.expires_at !== 'number' || nowMs >= s.expires_at) delete state[id];
    }
    return state;
}

function save(state, nowMs = Date.now()) {
    const pruned = pruneExpired(state, nowMs);
    const tmp = SESSIONS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(pruned, null, 2));
    fs.renameSync(tmp, SESSIONS_FILE);
}

function recordSession(id, accountId, amountUsd, expiresAtMs, nowMs = Date.now()) {
    if (!id) return;
    const state = load();
    state[id] = { account_id: accountId, amount_usd: amountUsd, created_at: nowMs, expires_at: expiresAtMs };
    save(state, nowMs);
}

// ─── M3: per-account lock over the check-then-reserve sequence ─────────────

const accountMutexes = new Map();

function acquireCheckoutLock(accountId) {
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

/**
 * Record a placeholder reservation (a local id, the amount, the time) --
 * call this UNDER acquireCheckoutLock(accountId), after the cap checks pass
 * and BEFORE the Stripe call. Returns the reservation id; the caller
 * promotes it (promoteReservation) on success or deletes it
 * (clearPendingSession) on any failure.
 */
function reservePendingSession(accountId, amountUsd, nowMs = Date.now()) {
    const id = 'resv_' + crypto.randomBytes(9).toString('hex');
    recordSession(id, accountId, amountUsd, nowMs + RESERVATION_TTL_MS, nowMs);
    return id;
}

/**
 * Replace a placeholder reservation with the real Checkout session, counted
 * from here on under Stripe's OWN expiry (ruling N2), not the reservation's
 * short local bound.
 */
function promoteReservation(reservationId, sessionId, accountId, amountUsd, expiresAtSeconds, nowMs = Date.now()) {
    clearPendingSession(reservationId);
    if (!sessionId) return;
    const expiresAtMs = (typeof expiresAtSeconds === 'number' && Number.isFinite(expiresAtSeconds))
        ? expiresAtSeconds * 1000
        : nowMs + RESERVATION_TTL_MS;
    recordSession(sessionId, accountId, amountUsd, expiresAtMs, nowMs);
}

/** Called once a session's webhook has credited the account, or a
 * reservation/session is otherwise no longer relevant (any failure after
 * reservePendingSession, self-healing on a duplicate webhook delivery) — it
 * stops counting toward either cap. Works on either kind of id. */
function clearPendingSession(id) {
    if (!id) return;
    const state = load();
    if (id in state) {
        delete state[id];
        save(state);
    }
}

/** Sum of amount_usd across this account's unpaid, unexpired sessions
 * (including any live reservation placeholder). */
function getPendingSessionsTotalUsd(accountId, nowMs = Date.now()) {
    const state = load();
    let total = 0;
    for (const s of Object.values(state)) {
        if (!s || s.account_id !== accountId) continue;
        if (nowMs >= s.expires_at) continue;
        total += s.amount_usd || 0;
    }
    return round6(total);
}

module.exports = {
    acquireCheckoutLock,
    reservePendingSession,
    promoteReservation,
    clearPendingSession,
    getPendingSessionsTotalUsd,
    RESERVATION_TTL_MS,
    SESSIONS_FILE,
    // Exported for testing only:
    load,
    save,
    pruneExpired,
};
