'use strict';

/**
 * lib/credit-caps.js — purchase caps.
 *
 * Two numbers, checked before a new pack purchase is allowed to start, and
 * again by the webhook as a second line of defense. They answer a legal
 * requirement (a ceiling on prepaid stored value), not a product choice.
 *
 *   - Balance cap:  the sum of every unfrozen dollar lot's remaining_usd on
 *                   an account must not exceed BALANCE_CAP_USD after a new
 *                   purchase lands.
 *   - Daily cap:    the sum of amount_usd across every purchase an account
 *                   made in the trailing 24 hours, plus the new pack's
 *                   price, must not exceed DAILY_PURCHASE_CAP_USD.
 *
 * Frozen lots (a dispute in progress) still count toward the balance cap —
 * the money is still Auxilo's obligation until the dispute resolves — but
 * are excluded from nothing here; they simply cannot be SPENT (see
 * lib/credits.js).
 */

const { loadCredits, ensureDollarLots } = require('./credits.js');
// Ruling M3: both caps also count unpaid, unexpired Checkout sessions --
// money not yet collected but that WOULD land if every open session paid.
const { getPendingSessionsTotalUsd } = require('./checkout-sessions.js');

/**
 * L-b: a corrupt/unreadable checkout-sessions.json makes
 * getPendingSessionsTotalUsd throw (lib/checkout-sessions.js's own load()
 * refuses to treat that as "no pending sessions"). Ruling N7 wants that
 * throw to keep refusing a NEW purchase outright while the file stays bad
 * (fail closed -- no money has moved yet, so blocking is free) -- but the
 * webhook's post-credit check runs AFTER Stripe has already collected the
 * money; its only job at that point is deciding whether to place a hold,
 * and skipping it entirely (the pre-fix behavior) places no hold even on a
 * real overage. `tolerateMissingPendingSessions` opts a caller into a
 * fallback of 0 pending sessions instead of the throw -- it can undercount
 * a session opened moments ago, but it still evaluates and still holds a
 * real overage. Only the webhook's post-credit call passes it; the
 * pre-Checkout call keeps N7's fail-closed default. lib/checkout-sessions.js's
 * own load() already alerts on the corrupt file itself either way.
 */
function pendingSessionsTotalUsd(accountId, nowMs, tolerateMissingPendingSessions) {
    if (!tolerateMissingPendingSessions) return getPendingSessionsTotalUsd(accountId, nowMs);
    try {
        return getPendingSessionsTotalUsd(accountId, nowMs);
    } catch (err) {
        console.error('[credit-caps] pending-sessions total unavailable (checkout-sessions.json unreadable/corrupt) -- falling back to 0 pending for this check:', err && err.message);
        return 0;
    }
}

const BALANCE_CAP_USD = 2000;
const DAILY_PURCHASE_CAP_USD = 2000;
const DAY_MS = 24 * 60 * 60 * 1000;

function round6(v) {
    return Math.round((v + Number.EPSILON) * 1e6) / 1e6;
}

/**
 * The account's current total stored value: every dollar lot's
 * remaining_usd. No figure here is derived from GET /account/credits or vice
 * versa — both read the same underlying lot array independently.
 */
function computeAccountBalanceUsd(accountId) {
    const credits = loadCredits();
    const record = credits[accountId];
    if (!record) return 0;

    ensureDollarLots(record);

    let total = 0;
    for (const lot of record.dollar_lots || []) {
        total += lot.remaining_usd || 0;
    }
    return round6(total);
}

/**
 * Sum of amount_usd across every purchase this account made in the trailing
 * 24 hours (from data/purchases.jsonl via lib/stripe.js).
 */
function computeDailyPurchaseTotalUsd(accountId, nowMs = Date.now()) {
    // Lazy require: mirrors lib/credits.js's own lazy require of lib/stripe.js
    // (keeps module-load order independent between the two files).
    const { getPurchasesForAccount } = require('./stripe.js');
    const purchases = getPurchasesForAccount(accountId) || [];
    const cutoff = nowMs - DAY_MS;
    let total = 0;
    for (const p of purchases) {
        if (!p || typeof p.amount_usd !== 'number') continue;
        const ts = p.timestamp ? new Date(p.timestamp).getTime() : NaN;
        if (Number.isFinite(ts) && ts >= cutoff) total += p.amount_usd;
    }
    return round6(total);
}

/**
 * Would adding `newAmountUsd` to this account's current balance cross the
 * $2,000 balance cap? Returns the numbers so the caller can build a plain
 * message naming the cap and the account's current total (spec test 13).
 *
 * Ruling M3: "current" also counts this account's unpaid, unexpired
 * Checkout sessions -- opening several sessions while under the cap must
 * not let their combined payment cross it, since each individually passed
 * this same check.
 *
 * L-b: pass `{ tolerateMissingPendingSessions: true }` to fall back to 0
 * pending sessions (rather than throw) when checkout-sessions.json cannot
 * be read -- see pendingSessionsTotalUsd above. Only the webhook's
 * post-credit call does this; the default keeps N7's fail-closed throw.
 */
function checkBalanceCap(accountId, newAmountUsd, nowMs = Date.now(), opts = {}) {
    const current = round6(computeAccountBalanceUsd(accountId) + pendingSessionsTotalUsd(accountId, nowMs, opts.tolerateMissingPendingSessions));
    const projected = round6(current + newAmountUsd);
    return {
        ok: projected <= BALANCE_CAP_USD,
        current,
        projected,
        limit: BALANCE_CAP_USD,
    };
}

/**
 * Would adding `newAmountUsd` to this account's trailing-24h purchase total
 * cross the $2,000 daily purchase cap? (spec test 14) Ruling M3: "current"
 * also counts this account's unpaid, unexpired Checkout sessions, for the
 * same reason as checkBalanceCap above. L-b: same `opts.tolerateMissing-
 * PendingSessions` fallback, same default.
 */
function checkDailyCap(accountId, newAmountUsd, nowMs = Date.now(), opts = {}) {
    const current = round6(computeDailyPurchaseTotalUsd(accountId, nowMs) + pendingSessionsTotalUsd(accountId, nowMs, opts.tolerateMissingPendingSessions));
    const projected = round6(current + newAmountUsd);
    return {
        ok: projected <= DAILY_PURCHASE_CAP_USD,
        current,
        projected,
        limit: DAILY_PURCHASE_CAP_USD,
    };
}

module.exports = {
    BALANCE_CAP_USD,
    DAILY_PURCHASE_CAP_USD,
    computeAccountBalanceUsd,
    computeDailyPurchaseTotalUsd,
    checkBalanceCap,
    checkDailyCap,
};
