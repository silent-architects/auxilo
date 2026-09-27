'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ─── Constants ────────────────────────────────────────────────────────────────

// AUXILO_CREDITS_FILE override: test isolation only (unset in production).
const CREDITS_FILE = process.env.AUXILO_CREDITS_FILE
    || path.join(__dirname, '..', 'data', 'credits.json');

// ─── File I/O ─────────────────────────────────────────────────────────────────

// L11: a missing file (first use, or nothing purchased yet on this box) is
// the ONLY case that reads as empty. Any other read/parse failure (a
// truncated or corrupted file) must never be silently treated as "nobody
// has any money" -- the very next write (any purchase, any spend) would
// then overwrite the file with just that one account, discarding every
// other account's balance. Refuse the operation instead: throw, so the
// caller's request fails loudly, and alert so a human looks at the file.
function loadCredits() {
    let raw;
    try {
        raw = fs.readFileSync(CREDITS_FILE, 'utf8');
    } catch (err) {
        if (err && err.code === 'ENOENT') return {};
        console.error('[credits] refusing to treat a read failure as an empty ledger:', err && err.message);
        try { require('./ops-alert.js').sendOpsAlert(
            'credits.json unreadable',
            `error=${err && err.code || 'unknown'} message=${err && err.message}`,
            { category: 'credits-corrupt-file' }
        ).catch(() => {}); } catch { /* best effort -- never let alerting mask the real error */ }
        throw err;
    }
    try {
        return JSON.parse(raw);
    } catch (err) {
        console.error('[credits] refusing to treat a corrupt ledger as empty:', err && err.message);
        try { require('./ops-alert.js').sendOpsAlert(
            'credits.json corrupt (parse failure)',
            `message=${err && err.message}`,
            { category: 'credits-corrupt-file' }
        ).catch(() => {}); } catch { /* best effort */ }
        throw err;
    }
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

// ─── Lot provenance ───────────────────────────────────────────────────────────
//
// Every lot carries the same base provenance fields: when it was funded, the
// Stripe purchase (if any) behind it, when it was last touched, and its
// freeze state for a dispute in progress.

function round6(v) {
    return Math.round((v + Number.EPSILON) * 1e6) / 1e6;
}
const normalizeUsd = round6;

function genLotId() {
    return 'lot_' + crypto.randomBytes(6).toString('hex');
}

// N3: every funded-unlock entry gets its own id, written into the builder's
// earnings entry (in a `reversals` list) the moment it is reversed, so a
// second attempt at reversing the SAME entry -- a Stripe retry after an
// earnings-save failure, or an on-the-spot reversal racing a second
// refund/dispute event for the same payment -- can recognize the id is
// already there and skip, rather than subtracting the share twice.
function genEntryId() {
    return 'fu_' + crypto.randomBytes(6).toString('hex');
}

function stampLotProvenance(lot, now, opts = {}) {
    lot.purchase_id = opts.purchase_id || null;
    lot.stripe_payment_intent = opts.stripe_payment_intent || null;
    lot.purchased_at = new Date(now).toISOString();
    lot.last_activity_at = lot.purchased_at;
    lot.frozen = false;
    lot.frozen_at = null;
    lot.frozen_reason = null;
    // N1: the running amount a refund's reach into already-spent money has
    // not yet found a recorded share to reverse against -- see
    // removeDollarLotRemainder and recordLotFunding below.
    lot.uncovered_usd = 0;
    return lot;
}

/**
 * N1: consumes up to a lot's uncovered amount from one contributor/platform
 * amount pair, in proportion, and reduces the lot's uncovered amount by
 * what it takes. Used both when a NEW share is about to be recorded against
 * a lot that still carries an uncovered amount from an earlier refund
 * (recordLotFunding) and when a failed delivery restores a draw onto a lot
 * that carries one (refundDollarDraw pays the uncovered amount down first,
 * via the same math, inline).
 */
function splitAgainstUncovered(lot, contributorAmount, platformAmount) {
    const uncovered = normalizeUsd(lot.uncovered_usd || 0);
    const basis = normalizeUsd((contributorAmount || 0) + (platformAmount || 0));
    if (uncovered <= 1e-9 || basis <= 0) {
        return { reversedContributor: 0, reversedPlatform: 0, keptContributor: contributorAmount || 0, keptPlatform: platformAmount || 0 };
    }
    if (basis <= uncovered + 1e-9) {
        lot.uncovered_usd = normalizeUsd(uncovered - basis);
        return { reversedContributor: contributorAmount || 0, reversedPlatform: platformAmount || 0, keptContributor: 0, keptPlatform: 0 };
    }
    const proportion = uncovered / basis;
    const reversedContributor = normalizeUsd((contributorAmount || 0) * proportion);
    const reversedPlatform = normalizeUsd((platformAmount || 0) * proportion);
    lot.uncovered_usd = 0;
    return {
        reversedContributor,
        reversedPlatform,
        keptContributor: normalizeUsd((contributorAmount || 0) - reversedContributor),
        keptPlatform: normalizeUsd((platformAmount || 0) - reversedPlatform),
    };
}

function touchLot(lot, now = Date.now()) {
    lot.last_activity_at = new Date(now).toISOString();
}

// ─── Dollar lots (the balance) ────────────────────────────────────────────────
//
// A dollar lot holds a US dollar amount, rounded to six decimal places on
// every write. Two kinds: 'dollar_paid' (real Stripe money) and
// 'dollar_promo' (a free grant — never sold, never collected). Spending
// always drains paid lots before promotional ones, oldest first within each
// kind (array insertion order == FIFO, lots are always pushed to the end).
//
// A drained dollar lot is kept at remaining_usd 0 rather than spliced out —
// its history (stripe_payment_intent, funded_unlocks) must remain findable
// for a later refund or dispute event to match it.

function ensureDollarLots(record) {
    if (!Array.isArray(record.dollar_lots)) record.dollar_lots = [];
}

/**
 * The account's real dollar balance, split by kind. Both numbers are read
 * directly off the lot arrays, never derived from the other.
 *
 * L3: a frozen lot (a dispute in progress) is reported separately as
 * `frozen_usd` and is excluded from `total_usd` -- it is not spendable, so
 * it must not be counted as if it were.
 */
function summarizeCreditBalance(record) {
    ensureDollarLots(record);
    let paid = 0, promo = 0, frozen = 0;
    for (const lot of record.dollar_lots) {
        if (lot.frozen) {
            frozen += lot.remaining_usd || 0;
            continue;
        }
        if (lot.kind === 'dollar_paid') paid += lot.remaining_usd || 0;
        else if (lot.kind === 'dollar_promo') promo += lot.remaining_usd || 0;
    }
    paid = normalizeUsd(paid);
    promo = normalizeUsd(promo);
    frozen = normalizeUsd(frozen);
    return { paid_usd: paid, promo_usd: promo, total_usd: normalizeUsd(paid + promo), frozen_usd: frozen };
}

/**
 * Debit `amountUsd` from an account's dollar lots: paid before promotional,
 * oldest first within each kind, skipping frozen lots (a frozen lot behaves
 * as zero remaining). Splits across more than one lot when it has to.
 * Mutates `record` in place; the caller persists. Returns success:false
 * (mutating nothing) when the unfrozen dollar balance can't cover the amount.
 */
function debitDollarLots(record, amountUsd, now = Date.now()) {
    ensureDollarLots(record);
    const need = normalizeUsd(amountUsd);
    const spendable = (lot) => !lot.frozen && (lot.remaining_usd || 0) > 0;
    const totalAvailable = record.dollar_lots.reduce((s, l) => s + (spendable(l) ? l.remaining_usd : 0), 0);
    if (normalizeUsd(totalAvailable) < need - 1e-9) {
        return { success: false, paidDrawn: 0, promoDrawn: 0, draws: [] };
    }

    let remaining = need;
    let paidDrawn = 0, promoDrawn = 0;
    const draws = [];
    for (const kind of ['dollar_paid', 'dollar_promo']) {
        if (remaining <= 1e-9) break;
        for (const lot of record.dollar_lots) {
            if (remaining <= 1e-9) break;
            if (lot.kind !== kind || !spendable(lot)) continue;
            const take = normalizeUsd(Math.min(lot.remaining_usd, remaining));
            if (take <= 0) continue;
            lot.remaining_usd = normalizeUsd(lot.remaining_usd - take);
            remaining = normalizeUsd(remaining - take);
            touchLot(lot, now);
            draws.push({ lot_id: lot.lot_id, kind: lot.kind, amount: take });
            if (kind === 'dollar_paid') paidDrawn = normalizeUsd(paidDrawn + take);
            else promoDrawn = normalizeUsd(promoDrawn + take);
        }
    }
    return { success: remaining <= 1e-9, paidDrawn, promoDrawn, draws };
}

/**
 * AUD-CAC (R-F, "never loaded with a crypto payment"): create a new dollar
 * lot on an account. This is THE lot-credit function for dollar money — it
 * has exactly one call site in server.js, the Stripe webhook's
 * checkout.session.completed branch, for a purchase whose session metadata
 * says it became a dollar lot. Never called from x402, the router, or any
 * wallet-funded path. `opts.purchase_id` / `opts.stripe_payment_intent` are
 * required for a real purchase; omit both only for a free (promotional)
 * grant with no underlying charge.
 */
async function addDollarLot(accountId, kind, amountUsd, opts = {}) {
    if (kind !== 'dollar_paid' && kind !== 'dollar_promo') {
        throw new RangeError(`addDollarLot: invalid kind '${kind}'`);
    }
    const amount = normalizeUsd(amountUsd);
    const release = await acquireAccountLock(accountId);
    try {
        const now = Date.now();
        const credits = loadCredits();
        if (!credits[accountId]) credits[accountId] = createFreshRecord(now);
        resetIfNewPeriod(credits[accountId], now);
        const record = credits[accountId];
        ensureDollarLots(record);

        // M7: idempotent on the Stripe payment id, inside this same account
        // lock. If the webhook's own write (appendPurchase, which is how
        // isSessionProcessed later recognizes this session) fails AFTER the
        // credit already landed, Stripe retries the whole delivery -- the
        // retry calls addDollarLot again with the SAME stripe_payment_intent
        // before isSessionProcessed can see the never-written purchase
        // record. A second lot for a payment already credited would double
        // the pack; return the existing lot instead of creating another.
        if (kind === 'dollar_paid' && opts.stripe_payment_intent) {
            const already = record.dollar_lots.find(l =>
                l.kind === 'dollar_paid' && l.stripe_payment_intent === opts.stripe_payment_intent);
            if (already) {
                return { success: true, lot_id: already.lot_id, kind, remaining_usd: already.remaining_usd, already_credited: true };
            }
        }

        const lot = stampLotProvenance({
            lot_id: genLotId(),
            kind,
            original_usd: amount,
            remaining_usd: amount,
            funded_unlocks: [],
        }, now, opts);
        record.dollar_lots.push(lot);
        saveCredits(credits);
        return { success: true, lot_id: lot.lot_id, kind, remaining_usd: lot.remaining_usd };
    } finally {
        release();
    }
}

/**
 * AUD19-10 compensation mirror for the dollar-lot path (ruling M1): a
 * post-payment delivery failure restores the exact amounts drawn back onto
 * the SAME lots they were drawn from -- `draws` is the exact array
 * `debitDollarLots` returned for this debit (each entry `{lot_id, kind,
 * amount}`), the same array the unlock handler stashes as
 * `creditDollarDraws` and later hands to recordLotFunding. Restoring onto
 * the original lot (rather than pushing a fresh lot with no payment intent)
 * keeps the restored balance tied to its Stripe purchase, so a later refund
 * or lost dispute on that purchase still finds and removes it.
 *
 * N1: a lot with no unfunded remainder can still carry an uncovered amount
 * -- a refund whose excess reached past this same in-flight draw before it
 * had a funding record to reverse. That uncovered amount is money that
 * already left Auxilo, so it is paid down FIRST out of what this restore
 * would otherwise hand back to the buyer, and only the amount left over (if
 * any) reaches the buyer's spendable balance. When the lot has no uncovered
 * amount (the ordinary case), this restores the draw in full, exactly as
 * before.
 *
 * Never called from anywhere but the unlock handler's delivery-failure
 * compensation arm.
 */
async function refundDollarDraw(accountId, draws) {
    const release = await acquireAccountLock(accountId);
    try {
        const now = Date.now();
        const credits = loadCredits();
        if (!credits[accountId]) credits[accountId] = createFreshRecord(now);
        resetIfNewPeriod(credits[accountId], now);
        const record = credits[accountId];
        ensureDollarLots(record);

        let paidRestored = 0, promoRestored = 0, skippedUsd = 0;
        for (const draw of (draws || [])) {
            if (!draw || !(draw.amount > 0)) continue;
            const lot = record.dollar_lots.find(l => l.lot_id === draw.lot_id);
            if (!lot) {
                // Lot gone entirely -- nothing to restore onto.
                skippedUsd = normalizeUsd(skippedUsd + draw.amount);
                continue;
            }
            const split = splitAgainstUncovered(lot, draw.amount, 0);
            const consumedByUncovered = split.reversedContributor; // the amount, if any, this restore paid toward the uncovered amount
            const restoreAmount = split.keptContributor;
            if (restoreAmount > 0) {
                lot.remaining_usd = normalizeUsd((lot.remaining_usd || 0) + restoreAmount);
                touchLot(lot, now);
            }
            if (lot.kind === 'dollar_paid') paidRestored = normalizeUsd(paidRestored + restoreAmount);
            else promoRestored = normalizeUsd(promoRestored + restoreAmount);
            if (consumedByUncovered > 0) skippedUsd = normalizeUsd(skippedUsd + consumedByUncovered);
        }
        saveCredits(credits);
        return { success: true, paid_restored: paidRestored, promo_restored: promoRestored, skipped_usd: skippedUsd };
    } finally {
        release();
    }
}

/**
 * Append a funding record to each dollar_paid lot a debit drew from,
 * allocating the contributor/platform share proportionally when a single
 * unlock split across more than one paid lot (the common case is exactly
 * one lot, an even 100% allocation). This is what lets a later refund or
 * lost dispute (lib/earnings-reversal.js) reverse EXACTLY what a specific
 * lot funded, per builder, without re-deriving it from the WAL. Promotional
 * draws are never recorded here — they never funded a builder share.
 *
 * `info.contributor_account_id` / `info.contributor_wallet` are stored
 * verbatim so a later reversal can call lib/earnings.js's own
 * resolveEarningsEntry({account_id, wallet}) — the SAME identifiers the
 * original credit resolved its entry with — rather than re-deriving identity
 * from a single ambiguous key.
 */
/**
 * @returns {{needsReversal: Array}} entries this call reverses on the spot
 *   because the lot they fund still carries an uncovered amount (ruling N1)
 *   -- the leftover of a refund or lost/partial dispute that reached past
 *   this lot's unspent remainder and past every share already recorded on
 *   it, BEFORE this funding entry existed to be found and reversed by that
 *   event. Each entry carries `lot_id` and its own `id`, and is marked
 *   `pending_reversal: true` on the lot itself (durable -- ruling L6), so
 *   the caller must reverse it against earnings and then call
 *   finalizePendingReversals for that lot. A share is reversed only up to
 *   the lot's uncovered amount, in proportion -- the rest of a partially
 *   covered share, and every share once the uncovered amount is spent,
 *   stands as an ordinary funding record.
 */
async function recordLotFunding(accountId, draws, info) {
    const paidDraws = (draws || []).filter(d => d && d.kind === 'dollar_paid' && d.amount > 0);
    if (paidDraws.length === 0) return { needsReversal: [] };
    const release = await acquireAccountLock(accountId);
    try {
        const now = Date.now();
        const credits = loadCredits();
        const record = credits[accountId];
        if (!record) return { needsReversal: [] };
        ensureDollarLots(record);

        const totalPaid = normalizeUsd(paidDraws.reduce((s, d) => s + d.amount, 0));
        let allocatedContributor = 0;
        const needsReversal = [];
        paidDraws.forEach((d, i) => {
            const lot = record.dollar_lots.find(l => l.lot_id === d.lot_id);
            if (!lot) return;
            if (!Array.isArray(lot.funded_unlocks)) lot.funded_unlocks = [];
            const isLast = i === paidDraws.length - 1;
            const contributorShare = isLast
                ? normalizeUsd((info.contributor_amount || 0) - allocatedContributor)
                : normalizeUsd(totalPaid > 0 ? (d.amount / totalPaid) * (info.contributor_amount || 0) : 0);
            if (!isLast) allocatedContributor = normalizeUsd(allocatedContributor + contributorShare);
            const platformShare = normalizeUsd(totalPaid > 0 ? (d.amount / totalPaid) * (info.platform_amount || 0) : 0);
            const baseEntry = {
                learning_id: info.learning_id || null,
                contributor_account_id: info.contributor_account_id || null,
                contributor_wallet: info.contributor_wallet || null,
                ts: info.ts || new Date(now).toISOString(),
            };

            // N1: a refund or lost/partial dispute whose excess outran the
            // shares recorded on this lot so far left an uncovered amount
            // behind -- an unlock still mid-flight, with no funding record
            // yet. Only while that amount is above zero does THIS new share
            // get reversed, and only up to it, in proportion, which then
            // reduces the uncovered amount for the next one.
            const split = splitAgainstUncovered(lot, contributorShare, platformShare);
            if (split.reversedContributor > 0 || split.reversedPlatform > 0) {
                const reversedEntry = {
                    ...baseEntry,
                    id: genEntryId(),
                    contributor_amount: split.reversedContributor,
                    platform_amount: split.reversedPlatform,
                    reversed: false,
                    pending_reversal: true,
                };
                lot.funded_unlocks.push(reversedEntry);
                needsReversal.push({ ...reversedEntry, lot_id: lot.lot_id });
            }
            if (split.keptContributor > 0 || split.keptPlatform > 0) {
                lot.funded_unlocks.push({
                    ...baseEntry,
                    id: genEntryId(),
                    contributor_amount: split.keptContributor,
                    platform_amount: split.keptPlatform,
                    reversed: false,
                    pending_reversal: false,
                });
            }
            touchLot(lot, now);
        });
        saveCredits(credits);
        return { needsReversal };
    } finally {
        release();
    }
}

// ─── Refunds and disputes ─────────────────────────────────────────────────────
//
// A dispute or refund event names a Stripe payment intent, so it can only
// ever match a dollar lot — every purchase creates one.

/** Find which account holds the dollar lot for a given Stripe payment intent. */
function findAccountAndLotByPaymentIntent(paymentIntent) {
    if (!paymentIntent) return null;
    const credits = loadCredits();
    for (const accountId of Object.keys(credits)) {
        const record = credits[accountId];
        if (!record || !Array.isArray(record.dollar_lots)) continue;
        const lot = record.dollar_lots.find(l => l.stripe_payment_intent === paymentIntent);
        if (lot) return { accountId, lot };
    }
    return null;
}

/**
 * Freeze a dollar lot (spec test 21): nothing further can be spent from it,
 * nothing about it is removed or reversed yet. Also reports whether the lot
 * was already more than half spent, so the caller can place an account hold
 * (spec test 26).
 */
async function freezeDollarLot(accountId, paymentIntent, reason) {
    const release = await acquireAccountLock(accountId);
    try {
        const now = Date.now();
        const credits = loadCredits();
        const record = credits[accountId];
        if (!record) return { success: false, reason: 'account_not_found' };
        ensureDollarLots(record);
        const lot = record.dollar_lots.find(l => l.stripe_payment_intent === paymentIntent);
        if (!lot) return { success: false, reason: 'lot_not_found' };
        const halfSpent = (lot.original_usd || 0) > 0 && lot.remaining_usd <= (lot.original_usd / 2);
        lot.frozen = true;
        lot.frozen_at = new Date(now).toISOString();
        lot.frozen_reason = reason;
        touchLot(lot, now);
        saveCredits(credits);
        return { success: true, lot_id: lot.lot_id, remaining_usd: lot.remaining_usd, original_usd: lot.original_usd, half_spent: halfSpent };
    } finally {
        release();
    }
}

/** Won dispute (spec test 24): clear the freeze, nothing to reverse. */
async function unfreezeDollarLot(accountId, paymentIntent) {
    const release = await acquireAccountLock(accountId);
    try {
        const now = Date.now();
        const credits = loadCredits();
        const record = credits[accountId];
        if (!record) return { success: false, reason: 'account_not_found' };
        ensureDollarLots(record);
        const lot = record.dollar_lots.find(l => l.stripe_payment_intent === paymentIntent);
        if (!lot) return { success: false, reason: 'lot_not_found' };
        lot.frozen = false;
        lot.frozen_at = null;
        lot.frozen_reason = null;
        touchLot(lot, now);
        saveCredits(credits);
        return { success: true, lot_id: lot.lot_id, remaining_usd: lot.remaining_usd };
    } finally {
        release();
    }
}

/**
 * Lost dispute or a refund, amount-aware (ruling H1). `amountUsd` is the
 * CUMULATIVE amount Stripe reports as refunded or reversed for this charge
 * so far (Stripe's own `charge.amount_refunded` semantics -- cumulative,
 * not incremental; omit it, or pass Infinity, for a full refund or a lost
 * dispute, which always means "the whole charge"). It is capped at the
 * lot's own `original_usd`.
 *
 * Step 1: remove up to `amountUsd` from the lot's own unspent remainder.
 * Step 2: only the amount BEYOND what remained is treated as not collected
 * for the Unlocks that lot paid for -- reversed newest Unlock first, a
 * whole Unlock at a time, the last one in proportion (Terms 7.6 item 3). A
 * full refund (amountUsd >= original_usd) reduces exactly to the old
 * behavior: remove everything that remained and reverse every funded share
 * in full, because the "beyond what remained" amount then equals the whole
 * spent history.
 *
 * Idempotent: the lot stores how much of its original amount has already
 * been accounted for (`refunded_usd_so_far`) -- a replay of the same
 * cumulative amount removes and reverses nothing further, and a second,
 * larger partial refund on the same charge handles only the increase.
 *
 * A newly-identified-for-reversal entry is marked `pending_reversal: true`,
 * not `reversed: true` (ruling L6): the caller must reverse it against
 * earnings and persist that, THEN call finalizePendingReversals to mark it
 * durably done. This function never touches earnings itself — lib/credits.js
 * never imports lib/earnings.js.
 *
 * The returned `funded_unlocks` is every entry on this lot currently marked
 * `pending_reversal` -- not only ones this call newly marked. A crash
 * between this save and the caller finishing the earnings-side reversal
 * leaves the marker in place; the next delivery of the SAME Stripe event (a
 * retry after our own non-2xx, or a fresh call once this function returns
 * `no_op: true` because there is nothing NEW to remove) still finds and
 * completes it, rather than losing the reversal for good.
 */
async function removeDollarLotRemainder(accountId, paymentIntent, amountUsd = Infinity) {
    const release = await acquireAccountLock(accountId);
    try {
        const now = Date.now();
        const credits = loadCredits();
        const record = credits[accountId];
        if (!record) return { success: false, reason: 'account_not_found' };
        ensureDollarLots(record);
        const lot = record.dollar_lots.find(l => l.stripe_payment_intent === paymentIntent);
        if (!lot) return { success: false, reason: 'lot_not_found' };
        if (!Array.isArray(lot.funded_unlocks)) lot.funded_unlocks = [];

        const cumulative = normalizeUsd(Math.min(Math.max(amountUsd, 0), lot.original_usd || 0));
        const priorRefunded = normalizeUsd(lot.refunded_usd_so_far || 0);
        const newlyRefunded = normalizeUsd(cumulative - priorRefunded);

        let removedFromRemaining = 0;
        if (newlyRefunded > 0) {
            removedFromRemaining = normalizeUsd(Math.min(newlyRefunded, lot.remaining_usd || 0));
            lot.remaining_usd = normalizeUsd((lot.remaining_usd || 0) - removedFromRemaining);
            lot.refunded_usd_so_far = cumulative;
            // N5: a refund never changes whether a lot is frozen -- only the
            // dispute handlers (freezeDollarLot / unfreezeDollarLot) do. A
            // partial refund landing while a dispute or inquiry is open must
            // not unfreeze the rest of the lot.
            touchLot(lot, now);

            let excess = normalizeUsd(newlyRefunded - removedFromRemaining);
            if (excess > 0) {
                // Newest Unlock first, a whole Unlock at a time, the last
                // one in proportion (Terms 7.6 item 3 / ruling H1).
                const candidates = lot.funded_unlocks.filter(f => !f.reversed && !f.pending_reversal).slice().reverse();
                for (const entry of candidates) {
                    if (excess <= 1e-9) break;
                    const entryBasis = normalizeUsd((entry.contributor_amount || 0) + (entry.platform_amount || 0));
                    if (entryBasis <= 0) continue;
                    if (entryBasis <= excess + 1e-9) {
                        if (!entry.id) entry.id = genEntryId(); // N3: backfill so a reversal can be deduped
                        entry.pending_reversal = true;
                        excess = normalizeUsd(excess - entryBasis);
                    } else {
                        const proportion = excess / entryBasis;
                        const partialContributor = normalizeUsd(entry.contributor_amount * proportion);
                        const partialPlatform = normalizeUsd(entry.platform_amount * proportion);
                        lot.funded_unlocks.push({
                            id: genEntryId(),
                            learning_id: entry.learning_id,
                            contributor_account_id: entry.contributor_account_id,
                            contributor_wallet: entry.contributor_wallet,
                            contributor_amount: partialContributor,
                            platform_amount: partialPlatform,
                            reversed: false,
                            pending_reversal: true,
                            ts: entry.ts,
                            split_from_ts: entry.ts,
                        });
                        entry.contributor_amount = normalizeUsd(entry.contributor_amount - partialContributor);
                        entry.platform_amount = normalizeUsd(entry.platform_amount - partialPlatform);
                        excess = 0;
                    }
                }
            }

            // N1: whatever excess is left, after reversing every share this
            // lot has recorded so far, reaches past money nothing has
            // funded yet -- an unlock still mid-debit, with no funding
            // record on this lot at all. Track it as the lot's uncovered
            // amount rather than a blanket "every future share on this lot
            // is reversed" stamp: only while it is above zero does a share
            // recorded LATER against this lot get reversed (recordLotFunding),
            // and only up to it, in proportion, which then pays it down. A
            // partial refund the remaining balance fully covered (excess
            // never went positive) leaves it at zero, so the rest of the
            // pack stays fully spendable and every later share stands.
            if (excess > 1e-9) {
                lot.uncovered_usd = normalizeUsd((lot.uncovered_usd || 0) + excess);
            }
            saveCredits(credits);
        }

        const pending = lot.funded_unlocks.filter(f => f.pending_reversal);

        return {
            success: true,
            lot_id: lot.lot_id,
            kind: lot.kind,
            removed_usd: removedFromRemaining,
            funded_unlocks: pending,
            no_op: newlyRefunded <= 0,
        };
    } finally {
        release();
    }
}

/**
 * Ruling L6: marks every entry currently pending_reversal on the named lot
 * as durably reversed, once the caller has reversed each against earnings
 * and persisted that write. Idempotent -- an entry with no pending_reversal
 * marker is left untouched.
 */
async function finalizePendingReversals(accountId, lotId) {
    const release = await acquireAccountLock(accountId);
    try {
        const credits = loadCredits();
        const record = credits[accountId];
        if (!record) return { success: false, reason: 'account_not_found' };
        ensureDollarLots(record);
        const lot = record.dollar_lots.find(l => l.lot_id === lotId);
        if (!lot || !Array.isArray(lot.funded_unlocks)) return { success: false, reason: 'lot_not_found' };
        let finalized = 0;
        for (const entry of lot.funded_unlocks) {
            if (entry.pending_reversal) {
                entry.pending_reversal = false;
                entry.reversed = true;
                finalized++;
            }
        }
        if (finalized > 0) saveCredits(credits);
        return { success: true, finalized };
    } finally {
        release();
    }
}

/**
 * Ruling M5: stamps the dispute id (when Stripe gives one) and its current
 * status on the lot, so a late/retried charge.dispute.created delivered
 * after the SAME dispute already closed can be recognized and ignored
 * instead of re-freezing the lot forever.
 */
async function stampDisputeStatus(accountId, paymentIntent, disputeId, status) {
    const release = await acquireAccountLock(accountId);
    try {
        const credits = loadCredits();
        const record = credits[accountId];
        if (!record) return { success: false, reason: 'account_not_found' };
        ensureDollarLots(record);
        const lot = record.dollar_lots.find(l => l.stripe_payment_intent === paymentIntent);
        if (!lot) return { success: false, reason: 'lot_not_found' };
        if (disputeId) lot.dispute_id = disputeId;
        lot.dispute_status = status || null;
        saveCredits(credits);
        return { success: true };
    } finally {
        release();
    }
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

async function deductCredit(accountId, creditType, listedPriceUsd) {
    // CREDITS-QUERIES-RESIDUAL: query credits are retired — lib/stripe.js
    // PACKS grants dollars only now, and the sole production caller
    // (dualAuthDynamic, server.js) always passes 'unlock'. Reject any other
    // creditType outright (fail fast, before taking the account lock) rather
    // than silently draining a purchased_queries balance that no longer
    // means anything.
    if (creditType !== 'unlock') {
        return {
            success: false,
            message: `Unsupported credit type '${creditType}'. Query credits are retired; only unlock credits can be deducted.`,
        };
    }
    const release = await acquireAccountLock(accountId);
    try {
        const now = Date.now();
        const credits = loadCredits();

        if (!credits[accountId]) {
            credits[accountId] = createFreshRecord(now);
        }

        resetIfNewPeriod(credits[accountId], now);

        const record = credits[accountId];
        ensureDollarLots(record);

        // The balance is dollars. Every unlock debits the listed price from
        // the account's dollar lots, paid before promotional.
        const price = normalizeUsd((typeof listedPriceUsd === 'number' && Number.isFinite(listedPriceUsd) && listedPriceUsd > 0) ? listedPriceUsd : 0);
        if (price > 0) {
            const draw = debitDollarLots(record, price, now);
            if (draw.success) {
                saveCredits(credits);
                return {
                    success: true,
                    paid_drawn: draw.paidDrawn,
                    promo_drawn: draw.promoDrawn,
                    total_drawn: price,
                    draws: draw.draws,
                };
            }
        }

        // Insufficient balance.
        const balance = summarizeCreditBalance(record);
        return {
            success: false,
            message: `Insufficient balance. Your account holds $${balance.total_usd.toFixed(6)} and this unlock costs $${price.toFixed(6)}. Buy a credit pack or pay per-call via x402.`,
            status: {
                credit_balance: balance,
                period_end: record.period_end,
            }
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
        // The balance is dollars: paid, promotional, and total spendable —
        // each read directly off the lot arrays, never derived from the other.
        credit_balance: summarizeCreditBalance(record),
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
    // Dollar lots — the balance
    ensureDollarLots,
    summarizeCreditBalance,
    debitDollarLots,
    addDollarLot,
    refundDollarDraw,
    recordLotFunding,
    // Refunds and disputes
    findAccountAndLotByPaymentIntent,
    freezeDollarLot,
    unfreezeDollarLot,
    removeDollarLotRemainder,
    finalizePendingReversals,
    stampDisputeStatus,
    // Exported for testing only:
    loadCredits,
    saveCredits,
    computePeriod,
    getOrInitCredits,
    resetIfNewPeriod,
    stampLotProvenance,
    touchLot,
    round6,
};
