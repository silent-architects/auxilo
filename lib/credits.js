'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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

// ─── AUD-CAC: shared lot provenance (ruling R-F) ─────────────────────────────
//
// Every lot, unit or dollar, carries the same base provenance fields — this
// is the "lot schema unification" (spec unit 1, ruling R-F). Additive only:
// no existing unit-lot field (unit_price_usd, remaining) is renamed or
// removed by any of this.

function round6(v) {
    return Math.round((v + Number.EPSILON) * 1e6) / 1e6;
}
const normalizeUsd = round6;

function genLotId() {
    return 'lot_' + crypto.randomBytes(6).toString('hex');
}

function stampLotProvenance(lot, now, opts = {}) {
    lot.purchase_id = opts.purchase_id || null;
    lot.stripe_payment_intent = opts.stripe_payment_intent || null;
    lot.purchased_at = new Date(now).toISOString();
    lot.last_activity_at = lot.purchased_at;
    lot.frozen = false;
    lot.frozen_at = null;
    lot.frozen_reason = null;
    return lot;
}

function touchLot(lot, now = Date.now()) {
    lot.last_activity_at = new Date(now).toISOString();
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
        record.unlock_lots.push(stampLotProvenance({
            unit_price_usd: deriveLegacyUnitPrice(accountId),
            remaining: record.purchased_unlocks - lotTotal,
            legacy: true,
        }, Date.now()));
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
 * AUD-CAC: a frozen lot (a dispute in progress on its purchase) is skipped —
 * it behaves as though it had zero remaining for spending purposes, exactly
 * like a frozen dollar lot (spec test 21).
 */
function consumeUnlockLot(record, now = Date.now()) {
    const lot = record.unlock_lots.find(l => l.remaining > 0 && !l.frozen && l.unit_price_usd > 0)
        || record.unlock_lots.find(l => l.remaining > 0 && !l.frozen);
    if (!lot) return DEFAULT_UNLOCK_UNIT_PRICE_USD; // unreachable after the spendability check in deductCredit; defensive
    lot.remaining--;
    touchLot(lot, now);
    const price = lot.unit_price_usd;
    if (lot.remaining === 0) {
        record.unlock_lots = record.unlock_lots.filter(l => l.remaining > 0);
    }
    return price;
}

// ─── AUD-CAC: Dollar Lots (Credits-as-Cash, spec §1/§2) ──────────────────────
//
// A dollar lot holds a US dollar amount, rounded to six decimal places on
// every write. Two kinds: 'dollar_paid' (real Stripe money) and
// 'dollar_promo' (a free grant — never sold, never collected). Spending
// always drains paid lots before promotional ones, oldest first within each
// kind (array insertion order == FIFO, lots are always pushed to the end).
//
// A drained dollar lot is kept at remaining_usd 0 rather than spliced out —
// unlike a unit lot, its history (stripe_payment_intent, funded_unlocks)
// must remain findable for a later refund or dispute event to match it.

function ensureDollarLots(record) {
    if (!Array.isArray(record.dollar_lots)) record.dollar_lots = [];
}

/**
 * The account's real dollar balance, split by kind. Both numbers are read
 * directly off the lot arrays — never derived from the other, and never
 * derived from the unit-lot count (ruling L8/R-I).
 */
function summarizeCreditBalance(record) {
    ensureDollarLots(record);
    let paid = 0, promo = 0;
    for (const lot of record.dollar_lots) {
        if (lot.kind === 'dollar_paid') paid += lot.remaining_usd || 0;
        else if (lot.kind === 'dollar_promo') promo += lot.remaining_usd || 0;
    }
    paid = normalizeUsd(paid);
    promo = normalizeUsd(promo);
    return { paid_usd: paid, promo_usd: promo, total_usd: normalizeUsd(paid + promo) };
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
 * AUD19-10 compensation mirror for the dollar-lot path: a post-payment
 * delivery failure restores the exact amount drawn, split back the same way
 * it was drawn (paid vs promo), as fresh lots — the same "push a new lot"
 * idiom refundCredit already uses for a unit lot, not an attempt to find and
 * un-debit the original lot (which may have been touched by other spends
 * since). Never called from anywhere but the unlock handler's delivery-
 * failure compensation arm.
 */
async function refundDollarDraw(accountId, paidUsd, promoUsd) {
    const release = await acquireAccountLock(accountId);
    try {
        const now = Date.now();
        const credits = loadCredits();
        if (!credits[accountId]) credits[accountId] = createFreshRecord(now);
        resetIfNewPeriod(credits[accountId], now);
        const record = credits[accountId];
        ensureDollarLots(record);

        const paid = normalizeUsd(paidUsd || 0);
        const promo = normalizeUsd(promoUsd || 0);
        if (paid > 0) {
            record.dollar_lots.push(stampLotProvenance({
                lot_id: genLotId(), kind: 'dollar_paid',
                original_usd: paid, remaining_usd: paid, funded_unlocks: [],
                refunded_at: new Date(now).toISOString(),
            }, now));
        }
        if (promo > 0) {
            record.dollar_lots.push(stampLotProvenance({
                lot_id: genLotId(), kind: 'dollar_promo',
                original_usd: promo, remaining_usd: promo, funded_unlocks: [],
                refunded_at: new Date(now).toISOString(),
            }, now));
        }
        saveCredits(credits);
        return { success: true, paid_restored: paid, promo_restored: promo };
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
async function recordLotFunding(accountId, draws, info) {
    const paidDraws = (draws || []).filter(d => d && d.kind === 'dollar_paid' && d.amount > 0);
    if (paidDraws.length === 0) return;
    const release = await acquireAccountLock(accountId);
    try {
        const now = Date.now();
        const credits = loadCredits();
        const record = credits[accountId];
        if (!record) return;
        ensureDollarLots(record);

        const totalPaid = normalizeUsd(paidDraws.reduce((s, d) => s + d.amount, 0));
        let allocatedContributor = 0;
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
            lot.funded_unlocks.push({
                learning_id: info.learning_id || null,
                contributor_account_id: info.contributor_account_id || null,
                contributor_wallet: info.contributor_wallet || null,
                contributor_amount: contributorShare,
                platform_amount: platformShare,
                reversed: false,
                ts: info.ts || new Date(now).toISOString(),
            });
            touchLot(lot, now);
        });
        saveCredits(credits);
    } finally {
        release();
    }
}

// ─── AUD-CAC: refunds and disputes (spec §4, Part 2) ─────────────────────────
//
// Scoped to dollar lots: a unit lot created via a real Stripe purchase in
// this build never carries a stripe_payment_intent (the webhook's unit-lot
// branch is unchanged from today — see server.js), so a dispute or refund
// event, which only ever names a payment intent, can only ever match a
// dollar lot. This mirrors the spec's own test framing (§8 tests 21-27 all
// set up "a paid dollar lot").

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
 * Lost dispute or a plain refund (spec tests 22/23): remove whatever remains
 * of the lot and hand back the funded_unlocks entries not yet reversed, so
 * the caller (lib/earnings-reversal.js) can reverse each builder's share.
 * This function never touches earnings itself — lib/credits.js never
 * imports lib/earnings.js (ruling L11).
 *
 * Idempotent: each funded_unlocks entry is marked `reversed: true` here, so
 * a Stripe retry of the same dispute.closed/charge.refunded event (or a
 * lost-then-somehow-reprocessed event) finds nothing left to reverse and
 * returns an empty funded_unlocks array rather than double-crediting a
 * second reversal.
 */
async function removeDollarLotRemainder(accountId, paymentIntent) {
    const release = await acquireAccountLock(accountId);
    try {
        const now = Date.now();
        const credits = loadCredits();
        const record = credits[accountId];
        if (!record) return { success: false, reason: 'account_not_found' };
        ensureDollarLots(record);
        const lot = record.dollar_lots.find(l => l.stripe_payment_intent === paymentIntent);
        if (!lot) return { success: false, reason: 'lot_not_found' };
        const removedUsd = lot.remaining_usd || 0;
        lot.remaining_usd = 0;
        lot.frozen = false;
        lot.frozen_at = null;
        lot.frozen_reason = null;
        touchLot(lot, now);
        if (!Array.isArray(lot.funded_unlocks)) lot.funded_unlocks = [];
        const toReverse = lot.funded_unlocks.filter(f => !f.reversed);
        for (const f of toReverse) f.reversed = true;
        saveCredits(credits);
        return {
            success: true,
            lot_id: lot.lot_id,
            kind: lot.kind,
            removed_usd: removedUsd,
            funded_unlocks: toReverse,
        };
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
    // PACKS grants unlocks only now, and the sole production caller
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
        // Ensure purchased fields exist (backward compat for pre-0.4 records)
        if (typeof record.purchased_queries !== 'number') record.purchased_queries = 0;
        if (typeof record.purchased_unlocks !== 'number') record.purchased_unlocks = 0;
        ensureDollarLots(record);

        // 1. Unit lots first, always, exactly as today — for as long as any
        //    UNFROZEN unit lot remains on the account. AUD-CAC: a unit lot
        //    frozen by a dispute is skipped, same as a frozen dollar lot.
        if (record.purchased_unlocks > 0) {
            ensureUnlockLots(record, accountId);
            const unitSpendable = record.unlock_lots.some(l => l.remaining > 0 && !l.frozen);
            if (unitSpendable) {
                const unitPrice = consumeUnlockLot(record, now);
                record.purchased_unlocks--;
                record.unlocks_used++;
                record.last_deducted_at = now;
                saveCredits(credits);
                return {
                    success: true,
                    remaining: record.purchased_unlocks,
                    source: 'purchased',
                    lot_kind: 'unit',
                    unit_price_usd: unitPrice,
                };
            }
            // every remaining unit lot is frozen — fall through to dollar
            // lots exactly as if this account had none.
        }

        // 2. AUD-CAC: once every unit lot is empty (or frozen), dollar lots,
        //    paid before promotional, debited at the listed price.
        const price = normalizeUsd((typeof listedPriceUsd === 'number' && Number.isFinite(listedPriceUsd) && listedPriceUsd > 0) ? listedPriceUsd : 0);
        if (price > 0) {
            const draw = debitDollarLots(record, price, now);
            if (draw.success) {
                saveCredits(credits);
                return {
                    success: true,
                    source: 'dollar',
                    lot_kind: 'dollar',
                    paid_drawn: draw.paidDrawn,
                    promo_drawn: draw.promoDrawn,
                    total_drawn: price,
                    draws: draw.draws,
                };
            }
        }

        // 3. Insufficient balance. L12: byte-identical to today for an
        //    account that never held a dollar lot.
        const hasEverHadDollarLot = record.dollar_lots.length > 0;
        if (!hasEverHadDollarLot) {
            return {
                success: false,
                message: `All unlock credits exhausted. Buy a credit pack or pay per-call via x402.`,
                status: {
                    purchased_queries: record.purchased_queries,
                    purchased_unlocks: record.purchased_unlocks,
                    queries_used: record.queries_used,
                    unlocks_used: record.unlocks_used,
                    period_end: record.period_end
                }
            };
        }
        const balance = summarizeCreditBalance(record);
        return {
            success: false,
            message: `Insufficient balance. Your account holds $${balance.total_usd.toFixed(6)} and this unlock costs $${price.toFixed(6)}. Buy a credit pack or pay per-call via x402.`,
            status: {
                unlocks: { used: record.unlocks_used, purchased: record.purchased_unlocks },
                credit_balance: balance,
                period_end: record.period_end,
            }
        };
    } finally {
        release();
    }
}

// ─── AUD19-10: Compensating Refund ───────────────────────────────────────────

/**
 * Refund one credit after a post-deduction delivery failure. Restores BOTH the
 * authoritative count AND (for unlock credits) the consumed lot at the unit
 * price it was consumed at — a refunded $0 grant credit comes back at $0, a
 * $0.40 starter-pack credit comes back at $0.40. Without the lot restore the
 * AUD19-2 basis accounting drifts: the retry would consume a different lot at
 * a different price than the buyer actually holds.
 *
 * Runs under the same per-account mutex as deductCredit. Throws only on disk
 * failure — callers on error paths must wrap this (the unlock handler treats a
 * refund failure as log + ops-alert, never a crash).
 *
 * @param {string} accountId
 * @param {'unlock'|'query'} creditType
 * @param {number} [unitPriceUsd] - the unit price the consumed credit carried
 *        (from deductCredit's unit_price_usd). Normalized; defaults defensively.
 */
async function refundCredit(accountId, creditType, unitPriceUsd) {
    const release = await acquireAccountLock(accountId);
    try {
        const now = Date.now();
        const credits = loadCredits();

        if (!credits[accountId]) {
            credits[accountId] = createFreshRecord(now);
        }

        resetIfNewPeriod(credits[accountId], now);

        const record = credits[accountId];
        if (typeof record.purchased_queries !== 'number') record.purchased_queries = 0;
        if (typeof record.purchased_unlocks !== 'number') record.purchased_unlocks = 0;

        const usedKey = creditType === 'unlock' ? 'unlocks_used' : 'queries_used';
        const purchasedKey = creditType === 'unlock' ? 'purchased_unlocks' : 'purchased_queries';

        if (creditType === 'unlock') {
            // Reconcile lots against the CURRENT count first, so the restored
            // lot is strictly additive on top of a consistent state.
            ensureUnlockLots(record, accountId);
            record.unlock_lots.push(stampLotProvenance({
                unit_price_usd: normalizeUnitPrice(unitPriceUsd),
                remaining: 1,
                refunded_at: now,
            }, now));
        }

        record[purchasedKey]++;
        record[usedKey] = Math.max(0, (record[usedKey] || 0) - 1);
        saveCredits(credits);

        return { success: true, remaining: record[purchasedKey] };
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
            record.unlock_lots.push(stampLotProvenance({
                unit_price_usd: normalizeUnitPrice(opts.unlock_unit_price_usd),
                remaining: unlocks,
                added_at: now,
            }, now, { purchase_id: opts.purchase_id, stripe_payment_intent: opts.stripe_payment_intent }));
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
        // AUD-CAC (ruling L8/R-I): a real unit count and a real dollar amount,
        // read independently off their own lot arrays — neither is ever
        // derived from the other.
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
    refundCredit,
    getCreditStatus,
    addPurchasedCredits,
    DEFAULT_UNLOCK_UNIT_PRICE_USD,
    // AUD-CAC: dollar lots (spec §1/§2, Part 1)
    ensureDollarLots,
    summarizeCreditBalance,
    debitDollarLots,
    addDollarLot,
    refundDollarDraw,
    recordLotFunding,
    // AUD-CAC: refunds and disputes (spec §4, Part 2)
    findAccountAndLotByPaymentIntent,
    freezeDollarLot,
    unfreezeDollarLot,
    removeDollarLotRemainder,
    // Exported for testing only:
    loadCredits,
    saveCredits,
    computePeriod,
    getOrInitCredits,
    resetIfNewPeriod,
    ensureUnlockLots,
    consumeUnlockLot,
    deriveLegacyUnitPrice,
    stampLotProvenance,
    touchLot,
    round6,
};
