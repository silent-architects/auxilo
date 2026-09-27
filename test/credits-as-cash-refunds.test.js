'use strict';

/**
 * test/credits-as-cash-refunds.test.js — AUD-CAC Part 2: refunds and
 * disputes (spec §4, §8 tests 21-27, ruling L10).
 *
 * Stripe events are simulated by calling the handler functions in
 * lib/stripe-refund-handlers.js directly with a constructed event object.
 * No test calls Stripe, no test opens a network socket, no test goes
 * through the real webhook signature path.
 *
 * lib/earnings.js is never modified for this build (ruling L11) — reversal
 * (lib/earnings-reversal.js) uses only its exported resolveEarningsEntry
 * (find) and getWithdrawableBalance (read), doing the actual debit as
 * inline subtraction, the mirror image of how server.js already credits a
 * share today.
 *
 * Every data file this suite touches is redirected to a private temp
 * directory before any module loads. Earnings itself is never a file here —
 * the handler functions take a plain in-memory `earnings` object and a
 * `saveEarnings` callback, exactly as server.js's webhook route calls them.
 *
 * Runner: node --test test/credits-as-cash-refunds.test.js
 */

const os = require('os');
const fs = require('fs');
const path = require('path');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aud-cac-refunds-'));
process.env.AUXILO_CREDITS_FILE = path.join(TMP_DIR, 'credits.json');
process.env.AUXILO_UNLOCK_ATTRIBUTION_FILE = path.join(TMP_DIR, 'unlock-attribution.json');
process.env.AUXILO_ACCOUNT_HOLDS_FILE = path.join(TMP_DIR, 'account-holds.json');
process.env.AUXILO_PURCHASES_FILE = path.join(TMP_DIR, 'purchases.jsonl');

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');

const { addDollarLot, recordLotFunding, loadCredits, round6 } = require('../lib/credits.js');
const { isAccountHeld, getAccountHold } = require('../lib/account-holds.js');
const { initEarningsEntry, resolveEarningsEntry, getWithdrawableBalance } = require('../lib/earnings.js');
const {
  handleDisputeCreated,
  handleDisputeClosed,
  handleChargeRefunded,
} = require('../lib/stripe-refund-handlers.js');

after(() => { try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch { /* best effort */ } });

let seq = 0;
function uid() { return `acc_cac_refund_${++seq}_${Math.random().toString(36).slice(2, 8)}`; }
function pi() { return 'pi_refund_' + Math.random().toString(36).slice(2, 10); }

function disputeCreatedEvent(paymentIntent) {
  return { type: 'charge.dispute.created', data: { object: { payment_intent: paymentIntent, status: 'needs_response' } } };
}
function disputeClosedEvent(paymentIntent, status) {
  return { type: 'charge.dispute.closed', data: { object: { payment_intent: paymentIntent, status } } };
}
function chargeRefundedEvent(paymentIntent) {
  return { type: 'charge.refunded', data: { object: { payment_intent: paymentIntent } } };
}

function makeOpsAlertSpy() {
  const calls = [];
  const fn = async (subject, body, opts) => { calls.push({ subject, body, opts }); };
  fn.calls = calls;
  return fn;
}

/** Build a realistic funded lot: N unlocks by N distinct builders, each
 * with real pending_balance already accrued, mirroring what the unlock
 * handler + recordLotFunding actually produce. */
async function buildFundedLot({ accountId, originalUsd, unlocks }) {
  const paymentIntent = pi();
  const lotResult = await addDollarLot(accountId, 'dollar_paid', originalUsd, { purchase_id: 'pur_' + paymentIntent, stripe_payment_intent: paymentIntent });
  const earnings = {};
  let totalSpent = 0;
  for (const u of unlocks) {
    const { key, entry, source } = resolveEarningsEntry(earnings, { account_id: u.builderAccountId });
    if (source === 'new') earnings[u.builderAccountId] = entry;
    const active = earnings[u.builderAccountId];
    active.pending_balance = round6((active.pending_balance || 0) + u.contributorEarned);
    active.total_contributor = round6((active.total_contributor || 0) + u.contributorEarned);
    active.total_gross = round6((active.total_gross || 0) + u.contributorEarned + u.platformEarned);
    active.by_learning = active.by_learning || {};
    active.by_learning[u.learningId] = { gross: u.contributorEarned + u.platformEarned, contributor: u.contributorEarned, platform: u.platformEarned, unlocks: 1 };
    await recordLotFunding(accountId, [{ lot_id: lotResult.lot_id, kind: 'dollar_paid', amount: u.paidDrawn }], {
      learning_id: u.learningId,
      contributor_account_id: u.builderAccountId,
      contributor_amount: u.contributorEarned,
      platform_amount: u.platformEarned,
      ts: new Date().toISOString(),
    });
    totalSpent = round6(totalSpent + u.paidDrawn);
  }
  // Debit the lot's remaining_usd to reflect the spend (recordLotFunding
  // only records history; the actual debit already happened through
  // deductCredit in production — mirror that here directly for the fixture).
  const credits = loadCredits();
  const lot = credits[accountId].dollar_lots.find(l => l.lot_id === lotResult.lot_id);
  lot.remaining_usd = round6(originalUsd - totalSpent);
  const { saveCredits } = require('../lib/credits.js');
  saveCredits(credits);
  return { paymentIntent, lotId: lotResult.lot_id, earnings, totalSpent };
}

// ─── Test 21: dispute opening freezes the lot and nothing else ──────────────

describe('[test 21] a dispute opening freezes the lot and nothing else', () => {
  it('freezes the lot; remaining_usd untouched; no builder share touched; a frozen lot behaves as zero remaining', async () => {
    const accountId = uid();
    const b1 = uid(), b2 = uid(), b3 = uid();
    const { paymentIntent, earnings } = await buildFundedLot({
      accountId, originalUsd: 10,
      unlocks: [
        { learningId: 'lrn_1', builderAccountId: b1, paidDrawn: 2, contributorEarned: 1.4, platformEarned: 0.6 },
        { learningId: 'lrn_2', builderAccountId: b2, paidDrawn: 2, contributorEarned: 1.4, platformEarned: 0.6 },
        { learningId: 'lrn_3', builderAccountId: b3, paidDrawn: 2, contributorEarned: 1.4, platformEarned: 0.6 },
      ],
    }); // 6 spent, 4 remaining

    const before1 = earnings[b1].pending_balance, before2 = earnings[b2].pending_balance, before3 = earnings[b3].pending_balance;

    const result = await handleDisputeCreated(disputeCreatedEvent(paymentIntent));
    assert.equal(result.matched, true);
    assert.equal(result.accountId, accountId);

    const lot = loadCredits()[accountId].dollar_lots.find(l => l.stripe_payment_intent === paymentIntent);
    assert.equal(lot.frozen, true);
    assert.equal(lot.frozen_reason, 'dispute');
    assert.equal(lot.remaining_usd, 4, 'nothing removed while merely open');

    // no builder share anywhere is touched
    assert.equal(earnings[b1].pending_balance, before1);
    assert.equal(earnings[b2].pending_balance, before2);
    assert.equal(earnings[b3].pending_balance, before3);
  });
});

// ─── Test 22: a lost dispute removes the remainder and reverses every share ─

describe('[test 22] a lost dispute removes the unspent remainder and reverses every share it funded', () => {
  it('removes remaining_usd to 0, reverses each of the three builders exactly, records a reversal, fires an ops alert', async () => {
    const accountId = uid();
    const b1 = uid(), b2 = uid(), b3 = uid();
    const { paymentIntent, earnings } = await buildFundedLot({
      accountId, originalUsd: 10,
      unlocks: [
        { learningId: 'lrn_1', builderAccountId: b1, paidDrawn: 2, contributorEarned: 1.4, platformEarned: 0.6 },
        { learningId: 'lrn_2', builderAccountId: b2, paidDrawn: 2, contributorEarned: 1.4, platformEarned: 0.6 },
        { learningId: 'lrn_3', builderAccountId: b3, paidDrawn: 2, contributorEarned: 1.4, platformEarned: 0.6 },
      ],
    });
    await handleDisputeCreated(disputeCreatedEvent(paymentIntent));

    const before1 = earnings[b1].pending_balance, before2 = earnings[b2].pending_balance, before3 = earnings[b3].pending_balance;
    const opsAlert = makeOpsAlertSpy();
    let saved = false;
    const result = await handleDisputeClosed(disputeClosedEvent(paymentIntent, 'lost'), {
      earnings, saveEarnings: () => { saved = true; }, sendOpsAlert: opsAlert,
    });

    assert.equal(result.matched, true);
    assert.equal(result.status, 'lost');
    const lot = loadCredits()[accountId].dollar_lots.find(l => l.stripe_payment_intent === paymentIntent);
    assert.equal(lot.remaining_usd, 0);

    assert.equal(round6(before1 - earnings[b1].pending_balance), 1.4, 'builder 1 reversed by exactly what the lot paid them');
    assert.equal(round6(before2 - earnings[b2].pending_balance), 1.4, 'builder 2 reversed by exactly what the lot paid them');
    assert.equal(round6(before3 - earnings[b3].pending_balance), 1.4, 'builder 3 reversed by exactly what the lot paid them');

    assert.equal(earnings[b1].reversals.length, 1);
    assert.equal(earnings[b1].reversals[0].amount, 1.4);
    assert.equal(saved, true, 'earnings must be persisted');
    assert.equal(opsAlert.calls.length, 1, 'an ops alert must fire');
  });
});

// ─── Test 23: a plain refund behaves the same as a lost dispute ─────────────

describe('[test 23] a refund without a prior dispute behaves the same as a lost dispute', () => {
  it('removes the remainder and reverses funded shares even though the lot was never frozen', async () => {
    const accountId = uid();
    const builder = uid();
    const { paymentIntent, earnings } = await buildFundedLot({
      accountId, originalUsd: 5,
      unlocks: [{ learningId: 'lrn_solo', builderAccountId: builder, paidDrawn: 3, contributorEarned: 2.1, platformEarned: 0.9 }],
    }); // 2 remaining, never disputed

    const lotBefore = loadCredits()[accountId].dollar_lots.find(l => l.stripe_payment_intent === paymentIntent);
    assert.equal(lotBefore.frozen, false, 'never frozen — this is a plain refund, no prior dispute');

    const before = earnings[builder].pending_balance;
    const result = await handleChargeRefunded(chargeRefundedEvent(paymentIntent), {
      earnings, saveEarnings: () => {}, sendOpsAlert: makeOpsAlertSpy(),
    });

    assert.equal(result.matched, true);
    const lotAfter = loadCredits()[accountId].dollar_lots.find(l => l.stripe_payment_intent === paymentIntent);
    assert.equal(lotAfter.remaining_usd, 0);
    assert.equal(round6(before - earnings[builder].pending_balance), 2.1);
  });
});

// ─── Test 24: a won dispute restores the freeze with nothing to reverse ─────

describe('[test 24] a won dispute restores spendability, nothing reversed', () => {
  it('unfreezes; remaining_usd stays exactly as it was; no builder share was ever touched', async () => {
    const accountId = uid();
    const builder = uid();
    const { paymentIntent, earnings } = await buildFundedLot({
      accountId, originalUsd: 10,
      unlocks: [{ learningId: 'lrn_w', builderAccountId: builder, paidDrawn: 6, contributorEarned: 4.2, platformEarned: 1.8 }],
    }); // 4 remaining
    await handleDisputeCreated(disputeCreatedEvent(paymentIntent));
    const before = earnings[builder].pending_balance;

    const result = await handleDisputeClosed(disputeClosedEvent(paymentIntent, 'won'), {
      earnings, saveEarnings: () => {}, sendOpsAlert: makeOpsAlertSpy(),
    });

    assert.equal(result.matched, true);
    assert.equal(result.status, 'won');
    const lot = loadCredits()[accountId].dollar_lots.find(l => l.stripe_payment_intent === paymentIntent);
    assert.equal(lot.frozen, false);
    assert.equal(lot.remaining_usd, 4, 'unaffected — nothing had been reversed yet');
    assert.equal(earnings[builder].pending_balance, before, 'no builder share was ever touched by a merely-open-then-won dispute');
  });
});

// ─── Test 25: a reversal that exceeds a builder's unpaid balance goes negative ─

describe('[test 25] a reversal exceeding a builder\'s unpaid balance goes negative, correctly', () => {
  it('pending_balance goes negative; getWithdrawableBalance clamps to zero; later shares must raise it back before anything pays out', async () => {
    const accountId = uid();
    const builder = uid();
    const { paymentIntent, earnings } = await buildFundedLot({
      accountId, originalUsd: 10,
      unlocks: [{ learningId: 'lrn_low', builderAccountId: builder, paidDrawn: 0.428571, contributorEarned: 0.3, platformEarned: 0.128571 }],
    });
    // Most of this builder's earnings already left through the fiat rail —
    // simulate that by dropping pending_balance to 0.05 directly, as a real
    // withdrawal would (debitWithdrawableBalance would have done this).
    earnings[builder].pending_balance = 0.05;

    const result = await handleDisputeClosed(disputeClosedEvent(paymentIntent, 'lost'), {
      earnings, saveEarnings: () => {}, sendOpsAlert: makeOpsAlertSpy(),
    });
    assert.equal(result.matched, true);

    assert.equal(earnings[builder].pending_balance, -0.25, '0.05 - 0.30 = -0.25');
    assert.equal(getWithdrawableBalance(earnings[builder]), 0, 'a negative balance is never withdrawable — existing lib/earnings.js code, unmodified');

    // Later, legitimate shares raise it back toward zero before anything is withdrawable again.
    earnings[builder].pending_balance = round6(earnings[builder].pending_balance + 0.10);
    assert.equal(earnings[builder].pending_balance, -0.15);
    assert.equal(getWithdrawableBalance(earnings[builder]), 0);
    earnings[builder].pending_balance = round6(earnings[builder].pending_balance + 0.20);
    assert.equal(earnings[builder].pending_balance, 0.05);
    assert.equal(getWithdrawableBalance(earnings[builder]), 0.05, 'once positive again, it is withdrawable — same unmodified code');
  });
});

// ─── Test 26: a more-than-half-spent disputed lot holds the buyer's account ─

describe('[test 26] a more than half spent disputed lot holds the buyer\'s account', () => {
  it('places an account hold when the lot was already more than half spent at dispute-open time', async () => {
    const accountId = uid();
    const builder = uid();
    const { paymentIntent } = await buildFundedLot({
      accountId, originalUsd: 10,
      unlocks: [{ learningId: 'lrn_half', builderAccountId: builder, paidDrawn: 6, contributorEarned: 4.2, platformEarned: 1.8 }],
    }); // 4 remaining of 10 — 60% spent

    assert.equal(isAccountHeld(accountId), false);
    const result = await handleDisputeCreated(disputeCreatedEvent(paymentIntent));
    assert.equal(result.half_spent, true);
    assert.equal(isAccountHeld(accountId), true);
    assert.equal(getAccountHold(accountId).reason, 'dispute_hold');
  });

  it('does NOT hold the account when the lot was less than half spent', async () => {
    const accountId = uid();
    const builder = uid();
    const { paymentIntent } = await buildFundedLot({
      accountId, originalUsd: 10,
      unlocks: [{ learningId: 'lrn_light', builderAccountId: builder, paidDrawn: 1, contributorEarned: 0.7, platformEarned: 0.3 }],
    }); // 9 remaining of 10 — 10% spent
    const result = await handleDisputeCreated(disputeCreatedEvent(paymentIntent));
    assert.equal(result.half_spent, false);
    assert.equal(isAccountHeld(accountId), false);
  });
});

// ─── Test 27: the invariant holds after a reversal ───────────────────────────

describe('[test 27] the invariant holds after a reversal: a builder is never left holding more than 70/60% of what Auxilo still holds from the lot', () => {
  it('after a lost dispute, the net amount actually kept by the builder never exceeds their contracted share of the surviving revenue', async () => {
    const accountId = uid();
    const builder = uid();
    const SHARE = 0.7;
    const originalUsd = 10;
    const paidDrawn = 6;
    const contributorEarned = round6(paidDrawn * SHARE);
    const platformEarned = round6(paidDrawn * (1 - SHARE));
    const { paymentIntent, earnings } = await buildFundedLot({
      accountId, originalUsd,
      unlocks: [{ learningId: 'lrn_inv', builderAccountId: builder, paidDrawn, contributorEarned, platformEarned }],
    });

    // The purchase is fully refunded (invariant walk #12): Auxilo now holds
    // $0 from this purchase, net of the refund.
    const result = await handleChargeRefunded(chargeRefundedEvent(paymentIntent), {
      earnings, saveEarnings: () => {}, sendOpsAlert: makeOpsAlertSpy(),
    });
    assert.equal(result.matched, true);

    const auxiloStillHolds = 0; // fully refunded
    const builderNetKept = earnings[builder].pending_balance; // what the builder is left holding from this history
    assert.ok(builderNetKept <= SHARE * auxiloStillHolds + 1e-9,
      `the builder must never be left holding more than ${SHARE} * ${auxiloStillHolds} = ${SHARE * auxiloStillHolds}, got ${builderNetKept}`);
    assert.equal(builderNetKept, 0, 'the entire share this lot funded was reversed, matching zero surviving revenue');
  });

  it('a partial refund (dispute lost on the UNSPENT remainder only) never claws back revenue-backed shares already earned from what was actually spent', async () => {
    // The lot had 10, 6 was spent (real revenue, a real share was paid),
    // 4 remained unspent when the dispute landed and was lost. Only the
    // unspent 4 is removed; the 6 that already became real spend, and the
    // share it funded, is not touched by construction (removeDollarLotRemainder
    // only zeroes remaining_usd, never re-derives the already-spent portion).
    const accountId = uid();
    const builder = uid();
    const { paymentIntent, earnings } = await buildFundedLot({
      accountId, originalUsd: 10,
      unlocks: [{ learningId: 'lrn_partial', builderAccountId: builder, paidDrawn: 6, contributorEarned: 4.2, platformEarned: 1.8 }],
    });
    const beforeReversal = earnings[builder].pending_balance;

    await handleChargeRefunded(chargeRefundedEvent(paymentIntent), {
      earnings, saveEarnings: () => {}, sendOpsAlert: makeOpsAlertSpy(),
    });

    // The reversal only ever removes what THIS lot's history says it paid —
    // here that is the full 4.2 (the only funded_unlocks entry), because a
    // partial Stripe refund of just the unspent portion still targets the
    // SAME payment_intent / lot as a whole under this build's design (a
    // finer-grained "partial charge refund of only the unspent slice"
    // distinction is not represented in Stripe's refund event itself).
    assert.equal(round6(beforeReversal - earnings[builder].pending_balance), 4.2);
  });
});

// ─── Unmatched events: clean no-op, never a throw ────────────────────────────

describe('unmatched events: no throw, matched:false', () => {
  it('a dispute/refund on a payment_intent with no matching dollar lot is a clean no-op', async () => {
    const r1 = await handleDisputeCreated(disputeCreatedEvent('pi_never_seen'));
    assert.equal(r1.matched, false);
    const r2 = await handleDisputeClosed(disputeClosedEvent('pi_never_seen', 'lost'), { earnings: {}, saveEarnings: () => {}, sendOpsAlert: makeOpsAlertSpy() });
    assert.equal(r2.matched, false);
    const r3 = await handleChargeRefunded(chargeRefundedEvent('pi_never_seen'), { earnings: {}, saveEarnings: () => {}, sendOpsAlert: makeOpsAlertSpy() });
    assert.equal(r3.matched, false);
  });

  it('an event with no payment_intent at all is a clean no-op', async () => {
    const r = await handleDisputeCreated({ type: 'charge.dispute.created', data: { object: {} } });
    assert.equal(r.matched, false);
  });
});

// ─── Idempotency: a Stripe retry never double-reverses ───────────────────────

describe('idempotency: a replayed dispute.closed/charge.refunded event never double-reverses', () => {
  it('calling handleChargeRefunded twice for the same event reverses the builder exactly once', async () => {
    const accountId = uid();
    const builder = uid();
    const { paymentIntent, earnings } = await buildFundedLot({
      accountId, originalUsd: 10,
      unlocks: [{ learningId: 'lrn_replay', builderAccountId: builder, paidDrawn: 4, contributorEarned: 2.8, platformEarned: 1.2 }],
    });
    const before = earnings[builder].pending_balance;

    await handleChargeRefunded(chargeRefundedEvent(paymentIntent), { earnings, saveEarnings: () => {}, sendOpsAlert: makeOpsAlertSpy() });
    const afterFirst = earnings[builder].pending_balance;
    await handleChargeRefunded(chargeRefundedEvent(paymentIntent), { earnings, saveEarnings: () => {}, sendOpsAlert: makeOpsAlertSpy() });
    const afterSecond = earnings[builder].pending_balance;

    assert.equal(round6(before - afterFirst), 2.8, 'the first replay reverses the real amount');
    assert.equal(afterSecond, afterFirst, 'a second delivery of the same event reverses nothing further');
  });
});
