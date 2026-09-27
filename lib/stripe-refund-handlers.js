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
 * the live, in-memory `earnings` object, no per-entry lock, synchronous
 * read-then-write with no await between them) — lib/earnings-reversal.js's
 * reverseOneFundedUnlock is itself fully synchronous, so passing it the
 * live shared object here carries the identical safety profile as today's
 * crediting code, not a new race.
 */

const {
    findAccountAndLotByPaymentIntent,
    freezeDollarLot,
    unfreezeDollarLot,
    removeDollarLotRemainder,
} = require('./credits.js');
const { holdAccount } = require('./account-holds.js');
const { reverseLotFunding } = require('./earnings-reversal.js');

function extractPaymentIntent(stripeObject) {
    if (!stripeObject) return null;
    if (typeof stripeObject.payment_intent === 'string') return stripeObject.payment_intent;
    if (stripeObject.payment_intent && typeof stripeObject.payment_intent.id === 'string') return stripeObject.payment_intent.id;
    return null;
}

async function _reverseAndAlert(found, removal, ctx, alertTitle, alertCategory) {
    let totalReversed = 0;
    if (removal.funded_unlocks.length > 0 && ctx && ctx.earnings) {
        const { totalReversed: reversed } = reverseLotFunding(ctx.earnings, removal.funded_unlocks);
        totalReversed = reversed;
        if (reversed > 0 && typeof ctx.saveEarnings === 'function') ctx.saveEarnings();
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
 * charge.dispute.created (spec test 21, 26): freeze the affected lot.
 * Nothing about it is removed or reversed yet — the dispute has not been
 * decided. When the lot was already more than half spent, place an account
 * hold (spec test 26): the buyer's account is refused any further spend or
 * purchase until the dispute resolves.
 */
async function handleDisputeCreated(event) {
    const dispute = event && event.data && event.data.object;
    const paymentIntent = extractPaymentIntent(dispute);
    if (!paymentIntent) return { matched: false };

    const found = findAccountAndLotByPaymentIntent(paymentIntent);
    if (!found) return { matched: false };

    const result = await freezeDollarLot(found.accountId, paymentIntent, 'dispute');
    if (!result.success) return { matched: false };

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
 * charge.dispute.closed (spec test 22, 24): status 'won' unfreezes with
 * nothing to reverse (nothing was ever removed while merely open). Any
 * other terminal status ('lost', Stripe's only other closed status) removes
 * the lot's unspent remainder and reverses every builder share it funded,
 * exactly like a plain refund (invariant walk #12).
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

    if (status === 'won') {
        const result = await unfreezeDollarLot(found.accountId, paymentIntent);
        return { matched: result.success, status: 'won', accountId: found.accountId, lot_id: result.lot_id };
    }

    const removal = await removeDollarLotRemainder(found.accountId, paymentIntent);
    if (!removal.success) return { matched: false };

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
 * charge.refunded (spec test 23): a refund without a prior dispute behaves
 * exactly like a lost dispute — remove the lot's unspent remainder and
 * reverse every builder share it funded.
 */
async function handleChargeRefunded(event, ctx = {}) {
    const charge = event && event.data && event.data.object;
    const paymentIntent = extractPaymentIntent(charge);
    if (!paymentIntent) return { matched: false };

    const found = findAccountAndLotByPaymentIntent(paymentIntent);
    if (!found) return { matched: false };

    const removal = await removeDollarLotRemainder(found.accountId, paymentIntent);
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
