'use strict';

/**
 * lib/stripe-refund-handlers.js — refunds and disputes on a purchased dollar
 * balance. Each exported function takes a constructed Stripe event object
 * (or, for tests, just the fields it reads) and does exactly one thing.
 * server.js's POST /webhook/stripe route is a thin dispatcher: verify the
 * signature, then call the matching function by event.type, passing its own
 * live `earnings` object + a save callback. Tests call these functions
 * directly with a constructed event object — no Stripe SDK, no signature,
 * no network socket.
 *
 * A dispute or refund event names a payment intent, which every purchase's
 * dollar lot carries. Every function here is a clean "not matched" result
 * (never a throw) when the payment intent doesn't match any dollar lot on
 * any account — unrelated Stripe activity is simply outside scope.
 *
 * Earnings mutation mirrors the SAME pattern the unlock-crediting path
 * already uses (server.js: `activeEntry.pending_balance += ...` directly on
 * the live, in-memory `earnings` object, no per-entry lock at the time of
 * writing) — lib/earnings-reversal.js's reverseOneFundedUnlock now takes the
 * SAME acquireEarningsLock the withdrawal rails take (ruling M8), because a
 * reversal subtracts, and subtracting is exactly the half of a read-modify-
 * write a lock exists to protect (crediting only ever adds).
 */

const {
    findAccountAndLotByPaymentIntent,
    freezeDollarLot,
    unfreezeDollarLot,
    removeDollarLotRemainder,
    finalizePendingReversals,
    stampDisputeStatus,
} = require('./credits.js');
const { holdAccount, getAccountHold, clearAccountHold } = require('./account-holds.js');
const { reverseLotFunding } = require('./earnings-reversal.js');

// Ruling M5/H2: the only statuses a real Stripe dispute closes into. Any
// other status Stripe might ever send (or a status a created event should
// never itself carry) is logged and changes nothing.
const DISPUTE_TERMINAL_STATUSES = new Set(['won', 'lost', 'warning_closed']);

function extractPaymentIntent(stripeObject) {
    if (!stripeObject) return null;
    if (typeof stripeObject.payment_intent === 'string') return stripeObject.payment_intent;
    if (stripeObject.payment_intent && typeof stripeObject.payment_intent.id === 'string') return stripeObject.payment_intent.id;
    return null;
}

/**
 * Reverses every entry in `removal.funded_unlocks` (each currently marked
 * pending_reversal — ruling L6) against `ctx.earnings`, persists earnings
 * FIRST, and only once that succeeds marks them durably reversed on the lot
 * (finalizePendingReversals). A crash between the two leaves the durable
 * pending_reversal marker in place; the next delivery of the SAME Stripe
 * event (Stripe retries a non-2xx response) finds it again — removeDollar-
 * LotRemainder's own pending-entry scan returns it even when there is
 * nothing NEW to remove — and this function completes it, rather than
 * losing the reversal for good.
 */
async function _reverseAndAlert(found, removal, ctx, alertTitle, alertCategory) {
    let totalReversed = 0;
    if (removal.funded_unlocks.length > 0 && ctx && ctx.earnings) {
        const { totalReversed: reversed } = await reverseLotFunding(ctx.earnings, removal.funded_unlocks);
        totalReversed = reversed;
        if (reversed > 0 && typeof ctx.saveEarnings === 'function') ctx.saveEarnings();
        await finalizePendingReversals(found.accountId, removal.lot_id);
    }
    if (ctx && typeof ctx.sendOpsAlert === 'function') {
        ctx.sendOpsAlert(
            alertTitle,
            `account=${found.accountId} lot=${removal.lot_id} removed_usd=${removal.removed_usd.toFixed(6)} ` +
            `reversed_usd=${totalReversed.toFixed(6)} builders_affected=${removal.funded_unlocks.length}`,
            { category: alertCategory }
        ).catch(() => {});
    }
    return totalReversed;
}

/**
 * charge.dispute.created (spec test 21, 26; ruling M5): freeze the affected
 * lot. Nothing about it is removed or reversed yet — the dispute has not
 * been decided. Terms 7.6 item 1 freezes the Balance while ANY dispute
 * about the payment is open, including a card-network inquiry that has not
 * become a chargeback — so this fires (and freezes) regardless of the
 * created event's own opening status, exactly as it always has; the only
 * new guard is against a STALE/retried created event for a dispute already
 * recorded as closed (below). When the lot was already more than half
 * spent, place an account hold (spec test 26): the buyer's account is
 * refused any further NEW purchase until the dispute resolves.
 */
async function handleDisputeCreated(event) {
    const dispute = event && event.data && event.data.object;
    const paymentIntent = extractPaymentIntent(dispute);
    if (!paymentIntent) return { matched: false };
    const status = dispute && dispute.status;
    const disputeId = (dispute && dispute.id) || null;

    // M5: a created event should never itself carry an already-terminal
    // status — defend anyway; there is nothing open to freeze.
    if (DISPUTE_TERMINAL_STATUSES.has(status)) {
        return { matched: false, reason: 'already_terminal' };
    }

    const found = findAccountAndLotByPaymentIntent(paymentIntent);
    if (!found) return { matched: false };

    // M5: ignore a created event for a dispute this lot already recorded as
    // closed — a late/retried delivery of an OLD created event (or one for
    // the same already-decided dispute) must never re-freeze the lot
    // forever. Matched conservatively: only skip when we cannot tell this
    // is a genuinely DIFFERENT dispute (no id on either side, or the same
    // id on both).
    const existingLot = found.lot;
    if (existingLot && DISPUTE_TERMINAL_STATUSES.has(existingLot.dispute_status)
        && (!disputeId || !existingLot.dispute_id || disputeId === existingLot.dispute_id)) {
        return { matched: false, reason: 'dispute_already_closed' };
    }

    const result = await freezeDollarLot(found.accountId, paymentIntent, 'dispute');
    if (!result.success) return { matched: false };

    await stampDisputeStatus(found.accountId, paymentIntent, disputeId, status || 'needs_response');

    if (result.half_spent) {
        holdAccount(found.accountId, 'dispute_hold', {
            payment_intent: paymentIntent,
            remaining_usd: result.remaining_usd,
            original_usd: result.original_usd,
        });
    }

    return {
        matched: true,
        accountId: found.accountId,
        lot_id: result.lot_id,
        half_spent: !!result.half_spent,
    };
}

/**
 * charge.dispute.closed (spec test 22, 24; ruling H2): only status 'lost' is
 * a loss. 'won' and 'warning_closed' (an inquiry that closed without
 * becoming a chargeback — Terms 7.6 item 2) both unfreeze the lot, reverse
 * nothing, and clear a dispute_hold this same dispute placed. Any other
 * status is logged and changes nothing — Stripe's dispute statuses this
 * event can ever carry are exactly 'won', 'lost', and 'warning_closed'; a
 * future or unrecognized value must never be treated as a loss by default.
 *
 * @param {object} event — a Stripe event, real or constructed.
 * @param {object} ctx — { earnings, saveEarnings, sendOpsAlert } from the caller.
 */
async function handleDisputeClosed(event, ctx = {}) {
    const dispute = event && event.data && event.data.object;
    const paymentIntent = extractPaymentIntent(dispute);
    const status = dispute && dispute.status;
    if (!paymentIntent) return { matched: false };

    const found = findAccountAndLotByPaymentIntent(paymentIntent);
    if (!found) return { matched: false };

    if (status === 'won' || status === 'warning_closed') {
        const result = await unfreezeDollarLot(found.accountId, paymentIntent);
        if (!result.success) return { matched: false };
        await stampDisputeStatus(found.accountId, paymentIntent, (dispute && dispute.id) || null, status);
        // H2: the ONLY automatic hold-clearance — a dispute resolved in
        // Auxilo's favor (or an inquiry that never became a chargeback)
        // releases the stop IT placed. Any other hold (cap_overage, or a
        // dispute_hold placed by a DIFFERENT, still-open dispute on this
        // same account) needs the admin route (ruling M4) — ruling N6:
        // clear only when the hold's own payment_intent matches the
        // dispute that just closed, never any dispute_hold found on the
        // account.
        const hold = getAccountHold(found.accountId);
        if (hold && hold.reason === 'dispute_hold'
            && hold.detail && hold.detail.payment_intent === paymentIntent) {
            clearAccountHold(found.accountId);
        }
        return { matched: true, status, accountId: found.accountId, lot_id: result.lot_id };
    }

    if (status !== 'lost') {
        console.warn(`[stripe-refund-handlers] charge.dispute.closed with an unrecognized status '${status}' — no action taken (payment_intent=${paymentIntent})`);
        return { matched: false, status, reason: 'unrecognized_status' };
    }

    // status === 'lost': the money left Auxilo. Amount-aware exactly like a
    // refund (ruling H1 / N13) — Stripe's `dispute.amount` is the disputed
    // amount, which can be LESS than the full charge when only part of the
    // order is disputed; passing it through (in dollars) and handling it
    // the same way a refund of that amount is handled means a partial
    // dispute that is lost removes only that much of the lot's remainder
    // and reverses only the shares beyond it. A dispute with no `amount`
    // field (or one naming the full charge) behaves exactly as before —
    // the same cap-at-original_usd math the default (Infinity) already
    // gave every existing caller that never populated it.
    const disputedAmountUsd = (dispute && typeof dispute.amount === 'number' && Number.isFinite(dispute.amount))
        ? dispute.amount / 100
        : Infinity;
    const removal = await removeDollarLotRemainder(found.accountId, paymentIntent, disputedAmountUsd);
    if (!removal.success) return { matched: false };
    await stampDisputeStatus(found.accountId, paymentIntent, (dispute && dispute.id) || null, 'lost');
    // N5: a refund never touches whether a lot is frozen (removeDollarLot-
    // Remainder above no longer does either) -- but THIS dispute is now
    // CLOSED, lost or not, so the freeze IT placed lifts here, explicitly,
    // exactly like the 'won' / 'warning_closed' branches above. What was
    // spent stays removed; the account is simply no longer under an open
    // dispute for this payment.
    await unfreezeDollarLot(found.accountId, paymentIntent);

    const reversed_usd = await _reverseAndAlert(found, removal, ctx,
        'Dispute lost — dollar lot reversed', 'credits-dispute-lost');

    return {
        matched: true,
        status: 'lost',
        accountId: found.accountId,
        lot_id: removal.lot_id,
        removed_usd: removal.removed_usd,
        reversed_usd,
    };
}

/**
 * charge.refunded (spec test 23; ruling H1): removes the lot's remainder up
 * to the amount refunded and reverses builder shares only for the amount
 * beyond what remained. Stripe's `charge.amount_refunded` is cumulative (in
 * cents) — when present, it drives exactly how much of the pack this event
 * accounts for; a constructed/legacy event with no amount_refunded field is
 * treated as a full refund (the same cap-at-original_usd math makes "full"
 * and "no data" identical), matching today's behavior for every existing
 * caller that never populated Stripe's amount fields.
 */
async function handleChargeRefunded(event, ctx = {}) {
    const charge = event && event.data && event.data.object;
    const paymentIntent = extractPaymentIntent(charge);
    if (!paymentIntent) return { matched: false };

    const found = findAccountAndLotByPaymentIntent(paymentIntent);
    if (!found) return { matched: false };

    const amountUsd = (charge && typeof charge.amount_refunded === 'number' && Number.isFinite(charge.amount_refunded))
        ? charge.amount_refunded / 100
        : Infinity;

    const removal = await removeDollarLotRemainder(found.accountId, paymentIntent, amountUsd);
    if (!removal.success) return { matched: false };

    const reversed_usd = await _reverseAndAlert(found, removal, ctx,
        'Refund — dollar lot reversed', 'credits-refund');

    return {
        matched: true,
        accountId: found.accountId,
        lot_id: removal.lot_id,
        removed_usd: removal.removed_usd,
        reversed_usd,
    };
}

module.exports = {
    handleDisputeCreated,
    handleDisputeClosed,
    handleChargeRefunded,
    extractPaymentIntent,
};
