'use strict';

/**
 * lib/earning-notifications.js — W3 earning-notification digest queue
 * (dark behind EARNING_NOTIFICATIONS_ENABLED, default OFF).
 *
 * Mirrors lib/unlock-attribution.js's idiom: env-var file override for test
 * isolation, read-per-call, tmp/rename atomic write.
 *
 * Store shape: data/earning-notifications.json — flat map
 *   { [accountId]: { pending: [{learningId, title, amountUsd, ts}], lastSentAt: number|null, attempts: number } }
 *
 * A queued item never carries any buyer identifier (account, email, wallet,
 * key label, IP) or the search that surfaced the learning — the server.js
 * hook that calls queueAccrual() only ever passes learningId/title/amountUsd.
 * The caller (server.js) is also responsible for only queuing when
 * contributorEarned > 0 and agencyInForce is true (GOV-4 Q10: a pre-Terms
 * held receipt never notifies) — this module does not re-check either.
 */

const fs = require('fs');
const path = require('path');

// AUXILO_EARNING_NOTIFICATIONS_FILE override: test isolation only (unset in
// production).
const NOTIF_FILE = process.env.AUXILO_EARNING_NOTIFICATIONS_FILE
    || path.join(__dirname, '..', 'data', 'earning-notifications.json');

// At most one digest send per account per rolling 24 hours.
const DIGEST_WINDOW_MS = 24 * 60 * 60 * 1000;

// PM review (post-ship defect #2): a permanently failing address (bounced
// domain, provider outage that outlives the retry window) must not retry
// forever. After this many failed send attempts the queue is drained and the
// drop is logged once, without the address.
const MAX_SEND_ATTEMPTS = 5;

function load() {
    try { return JSON.parse(fs.readFileSync(NOTIF_FILE, 'utf8')); }
    catch { return {}; }
}

function save(map) {
    fs.mkdirSync(path.dirname(NOTIF_FILE), { recursive: true });
    const tmp = NOTIF_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(map, null, 2));
    fs.renameSync(tmp, NOTIF_FILE);
}

/**
 * Queue one accrued unlock for `accountId`. No-op if accountId is falsy.
 * `entry` is {learningId, title, amountUsd} — a `ts` is stamped here if the
 * caller does not supply one.
 */
function queueAccrual(accountId, entry) {
    if (!accountId) return;
    const map = load();
    if (!map[accountId]) map[accountId] = { pending: [], lastSentAt: null, attempts: 0 };
    map[accountId].pending.push({
        learningId: entry && entry.learningId != null ? entry.learningId : null,
        title: entry && entry.title != null ? entry.title : '',
        amountUsd: entry && typeof entry.amountUsd === 'number' ? entry.amountUsd : 0,
        ts: (entry && entry.ts) || Date.now(),
    });
    save(map);
}

/**
 * Accounts due for a send right now: never sent before, or last sent at
 * least DIGEST_WINDOW_MS ago, AND holding at least one pending item.
 */
function dueForDigest(now = Date.now()) {
    const map = load();
    return Object.entries(map)
        .filter(([, v]) => v && Array.isArray(v.pending) && v.pending.length > 0 &&
            (v.lastSentAt == null || (now - v.lastSentAt) >= DIGEST_WINDOW_MS))
        .map(([accountId, v]) => ({ accountId, items: v.pending.slice(), attempts: v.attempts || 0 }));
}

/**
 * Mark an account's queue as flushed: clears pending, stamps lastSentAt,
 * resets the attempt counter. Called whether or not an email actually sent
 * (e.g. the preference is off, dev mode, a fixture-domain refusal, or the
 * retry ceiling was reached) so the queue is always drained rather than
 * growing unbounded — a real send FAILURE must not call this directly; use
 * recordFailedAttempt / attemptSend instead so the next sweep retries.
 */
function markSent(accountId, now = Date.now()) {
    const map = load();
    if (!map[accountId]) return;
    map[accountId].pending = [];
    map[accountId].lastSentAt = now;
    map[accountId].attempts = 0;
    save(map);
}

/**
 * Record one failed send attempt for `accountId` (pending items are left
 * queued — the caller retries on the next sweep). Returns the new attempt
 * count. No-op (returns 0) if the account has no queue row.
 */
function recordFailedAttempt(accountId) {
    const map = load();
    if (!map[accountId]) return 0;
    map[accountId].attempts = (map[accountId].attempts || 0) + 1;
    save(map);
    return map[accountId].attempts;
}

/**
 * Orchestrates the outcome of one flush attempt for `accountId`, given the
 * items already read from dueForDigest() and a `sendFn(items)` that performs
 * the actual send and resolves to the same never-throws {ok, error?} shape
 * lib/email.js's sendEmail (and therefore sendEarningNotification) already
 * guarantees.
 *
 *   - result.ok === true              -> delivered; markSent (drain, reset attempts).
 *   - result.error is 'fixture domain'
 *     or 'no items'                   -> can never be delivered; drain
 *                                         without retrying (these are not
 *                                         provider failures, they are
 *                                         permanent by construction).
 *   - any other failure                -> leave queued, increment the
 *                                         attempt counter; once attempts
 *                                         reach MAX_SEND_ATTEMPTS, drain
 *                                         anyway (a permanently failing
 *                                         address must not retry forever).
 *
 * Returns { sent, drained, attempts, reason } — the caller (server.js) uses
 * this only to decide whether to log a single "permanently dropped" line
 * (never including the address); it never re-implements this decision.
 */
async function attemptSend(accountId, items, sendFn) {
    const result = await sendFn(items);
    if (result && result.ok) {
        markSent(accountId);
        return { sent: true, drained: true, attempts: 0, reason: null };
    }
    const reason = (result && result.error) || 'unknown error';
    if (reason === 'fixture domain' || reason === 'no items') {
        markSent(accountId);
        return { sent: false, drained: true, attempts: 0, reason };
    }
    const attempts = recordFailedAttempt(accountId);
    if (attempts >= MAX_SEND_ATTEMPTS) {
        markSent(accountId);
        return { sent: false, drained: true, attempts, reason };
    }
    return { sent: false, drained: false, attempts, reason };
}

// PM review (post-ship defect #3): the opportunistic flush (right after an
// unlock) and the hourly sweep can both observe the same due account before
// either has marked it sent — as can two unlocks for the same contributor
// arriving close together. This in-memory set is the single chokepoint that
// serializes a flush per account WITHIN ONE PROCESS (module-level state is
// deliberately not persisted — it only needs to survive one event-loop
// turn, not a restart).
const inFlightAccountIds = new Set();

/**
 * Run `fn()` for `accountId` unless a call for the SAME accountId is already
 * in flight, in which case this is a silent no-op. Always clears the id in a
 * finally, so a throw inside `fn` cannot wedge the account permanently.
 * Returns { skipped: true } if it no-op'd, or { skipped: false, result }
 * with fn's resolved value otherwise.
 */
async function withAccountLock(accountId, fn) {
    if (inFlightAccountIds.has(accountId)) return { skipped: true };
    inFlightAccountIds.add(accountId);
    try {
        const result = await fn();
        return { skipped: false, result };
    } finally {
        inFlightAccountIds.delete(accountId);
    }
}

/**
 * Remove an account's queue row entirely (GOV-2 retention: a deleted
 * account's queued learning titles/amounts must not survive the account).
 * Called from the account-deletion path (server.js executeAccountDeletion).
 * No-op if the account has no row.
 */
function removeAccount(accountId) {
    if (!accountId) return;
    const map = load();
    if (Object.prototype.hasOwnProperty.call(map, accountId)) {
        delete map[accountId];
        save(map);
    }
}

module.exports = {
    queueAccrual,
    dueForDigest,
    markSent,
    recordFailedAttempt,
    attemptSend,
    withAccountLock,
    removeAccount,
    DIGEST_WINDOW_MS,
    MAX_SEND_ATTEMPTS,
    NOTIF_FILE,
    // Exported for testing only:
    load,
    save,
};
