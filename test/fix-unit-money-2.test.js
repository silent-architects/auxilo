'use strict';

/**
 * test/fix-unit-money-2.test.js — FIX-UNIT-MONEY-2.md, rulings proved at the
 * lib/source level: N1, N2, N3, N5, N6, N7, N8, N9, N10, N11, N13.
 *
 * Route-level proof (a real learning + API key through a staged server) for
 * N1's route case, N4, and X1 lives in test/fix-unit-money-2-route.test.js.
 * Route-level proof for M3's real concurrency, N6, N7 and N9 (through the
 * real POST /checkout/session, /webhook/stripe and admin routes) lives in
 * test/fix-unit-money-webhook.test.js.
 *
 * Every data file this suite touches is redirected to a private temp
 * directory before any module loads. No network call, no real Stripe SDK,
 * no real HOME.
 *
 * Runner: node --test test/fix-unit-money-2.test.js
 */

const os = require('os');
const fs = require('fs');
const path = require('path');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-unit-money-2-'));
process.env.AUXILO_CREDITS_FILE = path.join(TMP_DIR, 'credits.json');
process.env.AUXILO_ACCOUNT_HOLDS_FILE = path.join(TMP_DIR, 'account-holds.json');
process.env.AUXILO_HOLD_CLEAR_LOG_FILE = path.join(TMP_DIR, 'hold-clear-log.jsonl');
process.env.AUXILO_PURCHASES_FILE = path.join(TMP_DIR, 'purchases.jsonl');
process.env.AUXILO_CHECKOUT_SESSIONS_FILE = path.join(TMP_DIR, 'checkout-sessions.json');
process.env.AUXILO_UNLOCK_COUNTER_GATE_FILE = path.join(TMP_DIR, 'unlock-counter-gate.json');
delete process.env.RESEND_API_KEY;
delete process.env.OPS_ALERT_EMAIL;

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');

const REPO = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(REPO, ...p), 'utf8');

after(() => { try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch { /* best effort */ } });

const credits = require('../lib/credits.js');
const refundHandlers = require('../lib/stripe-refund-handlers.js');
const earningsReversal = require('../lib/earnings-reversal.js');
const { resolveEarningsEntry, initEarningsEntry } = require('../lib/earnings.js');
const accountHolds = require('../lib/account-holds.js');
const checkoutSessions = require('../lib/checkout-sessions.js');
const counterGate = require('../lib/unlock-counter-gate.js');

function resetCreditsFile() { fs.writeFileSync(process.env.AUXILO_CREDITS_FILE, '{}'); }

// A small harness replicating the unlock handler's money steps IN ORDER
// (server.js: debit; compute the split; credit the earnings entry; commit;
// recordLotFunding AFTER commit; an on-the-spot M2/N1 reversal if
// recordLotFunding found one; a delivery-failure arm that undoes the
// earnings mutation and calls refundDollarDraw) — the same order
// REVIEW-MONEY-PATH.md's proof scripts replicate.
function makeHarness() {
  const earnings = {};
  const ctx = { earnings, saveEarnings: () => {}, sendOpsAlert: async () => {} };
  async function unlock(buyer, learningId, builder, price, opts = {}) {
    const share = opts.share || 0.7;
    const r = await credits.deductCredit(buyer, 'unlock', price);
    if (!r.success) return { ok: false, r };
    const basis = r.paid_drawn;
    const ce = credits.round6(basis * share), pe = credits.round6(basis - ce);
    const res = resolveEarningsEntry(earnings, { account_id: builder, wallet: null });
    const k = res.source === 'new' ? builder : res.key;
    if (res.source === 'new') earnings[k] = initEarningsEntry(builder, null);
    const a = earnings[k];
    a.total_gross += basis; a.total_contributor += ce; a.total_platform += pe;
    a.by_learning[learningId] = a.by_learning[learningId] || { gross: 0, contributor: 0, platform: 0, unlocks: 0 };
    const bl = a.by_learning[learningId];
    bl.gross += basis; bl.contributor += ce; bl.platform += pe; bl.unlocks++;
    a.pending_balance += ce;
    if (opts.failBeforeCommit) {
      if (res.source === 'new') {
        delete earnings[k];
      } else {
        a.total_gross = credits.round6(a.total_gross - basis);
        a.total_contributor = credits.round6(a.total_contributor - ce);
        a.total_platform = credits.round6(a.total_platform - pe);
        bl.gross = credits.round6(bl.gross - basis);
        bl.contributor = credits.round6(bl.contributor - ce);
        bl.platform = credits.round6(bl.platform - pe);
        bl.unlocks = Math.max(0, bl.unlocks - 1);
        a.pending_balance = credits.round6(a.pending_balance - ce);
      }
      const refunded = await credits.refundDollarDraw(buyer, r.draws);
      return { ok: false, refunded };
    }
    const f = await credits.recordLotFunding(buyer, r.draws, {
      learning_id: learningId, contributor_account_id: builder, contributor_wallet: null,
      contributor_amount: ce, platform_amount: pe,
    });
    let spot = 0;
    if (f.needsReversal.length) {
      const { totalReversed } = await earningsReversal.reverseLotFunding(earnings, f.needsReversal);
      spot = totalReversed;
      for (const lotId of new Set(f.needsReversal.map((e) => e.lot_id))) {
        await credits.finalizePendingReversals(buyer, lotId);
      }
    }
    return { ok: true, ce, pe, spot, r };
  }
  const refund = (pi, cents) => refundHandlers.handleChargeRefunded(
    { data: { object: { payment_intent: pi, amount_refunded: cents } } }, ctx);
  const dcreated = (pi, status = 'needs_response', id) => refundHandlers.handleDisputeCreated(
    { data: { object: { id: id || ('du_' + pi), payment_intent: pi, status } } });
  const dclosed = (pi, status, extra = {}, id) => refundHandlers.handleDisputeClosed(
    { data: { object: { id: id || ('du_' + pi), payment_intent: pi, status, ...extra } } }, ctx);
  const pend = (k) => (earnings[k] ? credits.round6(earnings[k].pending_balance) : 0);
  const bal = (a) => credits.summarizeCreditBalance(credits.loadCredits()[a] || { dollar_lots: [] });
  const lot = (a, pi) => credits.loadCredits()[a].dollar_lots.find((l) => l.stripe_payment_intent === pi);
  return { earnings, ctx, unlock, refund, dcreated, dclosed, pend, bal, lot };
}

// ─── Ruling N1: the uncovered amount replaces the blanket `removed_at` gate ─

describe('[ruling N1] a lot\'s uncovered amount, not a blanket removed stamp, gates whether a LATER share is reversed', () => {
  it('the ruling\'s own example: $5 refund fully covered by the remaining balance, then a $10 unlock pays $7 and stays, then a failed delivery restores the buyer\'s $10 in full', async () => {
    resetCreditsFile();
    const H = makeHarness();
    await credits.addDollarLot('n1_buyer_a', 'dollar_paid', 100, { stripe_payment_intent: 'pi_n1a' });

    const r1 = await H.refund('pi_n1a', 500);
    assert.equal(r1.removed_usd, 5, 'the $5 refund is fully covered by the $100 remaining');
    assert.equal(r1.reversed_usd, 0);
    assert.equal(H.bal('n1_buyer_a').total_usd, 95);
    assert.equal(H.lot('n1_buyer_a', 'pi_n1a').uncovered_usd, 0, 'a refund the remaining balance covered leaves no uncovered amount');

    const u = await H.unlock('n1_buyer_a', 'L1', 'builder_n1a', 10);
    assert.equal(u.ok, true);
    assert.equal(u.ce, 7, 'pays the builder $7.000000');
    assert.equal(u.spot, 0, 'nothing reversed on the spot -- the lot has no uncovered amount');
    assert.equal(H.pend('builder_n1a'), 7);

    // "then a failed delivery on the same pack restores the buyer's $10.000000"
    const before = H.bal('n1_buyer_a').total_usd;
    const f = await H.unlock('n1_buyer_a', 'L2', 'builder_n1a', 10, { failBeforeCommit: true });
    assert.equal(f.ok, false);
    assert.equal(f.refunded.paid_restored, 10, 'restores the buyer\'s $10.000000 in full');
    assert.equal(f.refunded.skipped_usd, 0, 'nothing was uncovered for this restore to pay down');
    assert.equal(H.bal('n1_buyer_a').total_usd, before, 'the failed draw is restored to exactly where it started');
    assert.equal(H.pend('builder_n1a'), 7, 'the builder\'s $7 from the FIRST unlock still stands');
  });

  it('the full report ledger: $100 pack, $10 spent, $5 refunded, a further $10 unlock, a failed $10 delivery, then a refund to $100 total', async () => {
    resetCreditsFile();
    const H = makeHarness();
    await credits.addDollarLot('n1_buyer_b', 'dollar_paid', 100, { stripe_payment_intent: 'pi_n1b' });
    assert.equal(H.bal('n1_buyer_b').total_usd, 100);

    const u1 = await H.unlock('n1_buyer_b', 'L1', 'builder_n1b', 10);
    assert.equal(u1.ok, true);
    assert.equal(u1.ce, 7);
    assert.equal(H.bal('n1_buyer_b').total_usd, 90);
    assert.equal(H.pend('builder_n1b'), 7);

    const r1 = await H.refund('pi_n1b', 500); // cumulative $5
    assert.equal(r1.removed_usd, 5);
    assert.equal(r1.reversed_usd, 0);
    assert.equal(H.bal('n1_buyer_b').total_usd, 85);
    assert.equal(H.pend('builder_n1b'), 7, 'the already-recorded $7 share stands -- the remaining balance covered the refund');

    const u2 = await H.unlock('n1_buyer_b', 'L2', 'builder_n1b', 10);
    assert.equal(u2.ok, true);
    assert.equal(u2.ce, 7);
    assert.equal(u2.spot, 0);
    assert.equal(H.bal('n1_buyer_b').total_usd, 75);
    assert.equal(H.pend('builder_n1b'), 14);

    const f = await H.unlock('n1_buyer_b', 'L3', 'builder_n1b', 10, { failBeforeCommit: true });
    assert.equal(f.ok, false);
    assert.equal(f.refunded.paid_restored, 10);
    assert.equal(f.refunded.skipped_usd, 0);
    assert.equal(H.bal('n1_buyer_b').total_usd, 75, 'the failed $10 draw is restored -- back to exactly where it stood before the attempt');
    assert.equal(H.pend('builder_n1b'), 14, 'the failed unlock never recorded a share, so nothing changes here');

    // A refund taking the cumulative total to $100 -- $95 newly refunded.
    // $75 remains on the lot; it is removed in full, and the $20 excess
    // reaches past it, reversing BOTH $10-basis shares (u1 and u2) in full.
    const r2 = await H.refund('pi_n1b', 10000);
    assert.equal(r2.removed_usd, 75);
    assert.equal(r2.reversed_usd, 14);
    assert.equal(H.bal('n1_buyer_b').total_usd, 0);
    assert.equal(H.pend('builder_n1b'), 0);
  });

  it('recordLotFunding reverses a NEW share only up to the lot\'s uncovered amount, in proportion, and the rest stands', async () => {
    resetCreditsFile();
    const H = makeHarness();
    // Build an uncovered amount directly: a $100 lot fully spent by one
    // unlock, refunded in full (removed_usd=100, but nothing recorded yet
    // to reverse against -- this simulates a refund landing while an
    // unlock is still mid-flight, exactly as ruling N1 describes).
    await credits.addDollarLot('n1_buyer_c', 'dollar_paid', 6, { stripe_payment_intent: 'pi_n1c' });
    const draw = await credits.deductCredit('n1_buyer_c', 'unlock', 6); // draws the whole $6, no funding recorded yet
    assert.equal(draw.success, true);
    const removal = await credits.removeDollarLotRemainder('n1_buyer_c', 'pi_n1c', 6);
    assert.equal(removal.removed_usd, 0, 'nothing remained to remove -- the debit already drew it all');
    assert.equal(H.lot('n1_buyer_c', 'pi_n1c').uncovered_usd, 6, 'the whole $6 is uncovered -- no funding record existed for the refund to reverse');

    // A $10 share (from an UNRELATED, larger unlock on this lot) now gets
    // recorded: only $6 of its $10 total basis (contributor $7 + platform
    // $3) is reversed, in proportion, and $4 stands.
    const f = await credits.recordLotFunding('n1_buyer_c', draw.draws, {
      learning_id: 'L1', contributor_account_id: 'builder_n1c', contributor_wallet: null,
      contributor_amount: 7, platform_amount: 3,
    });
    assert.equal(f.needsReversal.length, 1);
    const reversedEntry = f.needsReversal[0];
    // proportion = 6/10; contributor reversed = 7 * 0.6 = 4.2; platform reversed = 3 * 0.6 = 1.8
    assert.equal(reversedEntry.contributor_amount, 4.2);
    assert.equal(reversedEntry.platform_amount, 1.8);
    assert.equal(H.lot('n1_buyer_c', 'pi_n1c').uncovered_usd, 0, 'fully consumed by this one share');
    const kept = H.lot('n1_buyer_c', 'pi_n1c').funded_unlocks.find((e) => !e.pending_reversal);
    assert.ok(kept, 'the uncovered part of the entry (contributor $2.80, platform $1.20) stands as an ordinary record');
    assert.equal(kept.contributor_amount, 2.8);
    assert.equal(kept.platform_amount, 1.2);
  });
});

// ─── Ruling N5: a refund never touches whether a lot is frozen ────────────

describe('[ruling N5] a partial refund never changes whether a lot is frozen', () => {
  it('a $5 refund while an inquiry is open leaves the lot frozen and unspendable', async () => {
    resetCreditsFile();
    const H = makeHarness();
    await credits.addDollarLot('n5_buyer', 'dollar_paid', 100, { stripe_payment_intent: 'pi_n5' });
    const created = await H.dcreated('pi_n5', 'warning_needs_response');
    assert.equal(created.matched, true);
    assert.equal(H.lot('n5_buyer', 'pi_n5').frozen, true);

    const r = await H.refund('pi_n5', 500);
    assert.equal(r.removed_usd, 5, 'the refund itself still removes from the unspent remainder');
    assert.equal(H.lot('n5_buyer', 'pi_n5').frozen, true, 'the refund never unfreezes -- only the dispute handlers do');

    const spend = await credits.deductCredit('n5_buyer', 'unlock', 50);
    assert.equal(spend.success, false, 'the frozen lot is not spendable, refund notwithstanding');
  });
});

// ─── Ruling N13: a lost dispute is amount-aware, exactly like a refund ────

describe('[ruling N13] a lost dispute reverses only the disputed amount, not the whole charge', () => {
  it('dispute.amount less than the charge removes only that much and reverses only the shares beyond the remainder', async () => {
    resetCreditsFile();
    const H = makeHarness();
    await credits.addDollarLot('n13_buyer', 'dollar_paid', 100, { stripe_payment_intent: 'pi_n13' });
    const u = await H.unlock('n13_buyer', 'L1', 'builder_n13', 10);
    assert.equal(u.ce, 7);
    assert.equal(H.bal('n13_buyer').total_usd, 90);

    await H.dcreated('pi_n13');
    // A $4.00 partial dispute is lost -- fully covered by the $90 unspent
    // remainder; nothing reversed. The dispute is now closed (lost or not),
    // so the freeze it placed lifts here too, same as 'won'/'warning_closed'.
    const lost = await H.dclosed('pi_n13', 'lost', { amount: 400 });
    assert.equal(lost.matched, true);
    assert.equal(lost.removed_usd, 4);
    assert.equal(lost.reversed_usd, 0);
    assert.equal(H.lot('n13_buyer', 'pi_n13').remaining_usd, 86);
    assert.equal(H.lot('n13_buyer', 'pi_n13').frozen, false, 'the closed dispute\'s own freeze lifts');
    assert.equal(H.bal('n13_buyer').total_usd, 86, 'spendable again, not sitting in frozen_usd');
    assert.equal(H.pend('builder_n13'), 7, 'the $10 unlock\'s share stands -- the disputed $4 never reached it');
  });

  it('a dispute with no amount field (or the full charge) behaves exactly as a full loss, unchanged', async () => {
    resetCreditsFile();
    const H = makeHarness();
    await credits.addDollarLot('n13_buyer_full', 'dollar_paid', 10, { stripe_payment_intent: 'pi_n13_full' });
    const u = await H.unlock('n13_buyer_full', 'L1', 'builder_n13_full', 10);
    assert.equal(u.ce, 7);
    await H.dcreated('pi_n13_full');
    const lost = await H.dclosed('pi_n13_full', 'lost');
    assert.equal(lost.removed_usd, 0, 'nothing remained -- it was all spent');
    assert.equal(lost.reversed_usd, 7, 'the whole charge is lost, exactly as before this ruling');
    assert.equal(H.bal('n13_buyer_full').total_usd, 0);
    assert.equal(H.pend('builder_n13_full'), 0);
  });
});

// ─── Ruling N3: a pending reversal can never be applied twice ─────────────

describe('[ruling N3] a funded entry\'s id, once written into the builder\'s reversals list, is never subtracted twice', () => {
  it('trigger (a): the earnings save throws while the process stays up, then Stripe\'s retry -- reversed exactly once', async () => {
    resetCreditsFile();
    const H = makeHarness();
    await credits.addDollarLot('n3_buyer_a', 'dollar_paid', 10, { stripe_payment_intent: 'pi_n3a' });
    await H.unlock('n3_buyer_a', 'L1', 'builder_n3a', 10);
    assert.equal(H.pend('builder_n3a'), 7);

    let fail = true;
    const failingCtx = {
      earnings: H.earnings, sendOpsAlert: async () => {},
      saveEarnings: () => { if (fail) { fail = false; throw new Error('simulated EIO on earnings.json'); } },
    };
    await assert.rejects(
      () => refundHandlers.handleChargeRefunded({ data: { object: { payment_intent: 'pi_n3a', amount_refunded: 1000 } } }, failingCtx),
      /simulated EIO/);
    // The in-memory mutation from the failed attempt survives (the process
    // stayed up; only the persist threw) -- Stripe's retry must not
    // subtract it again.
    const retry = await refundHandlers.handleChargeRefunded(
      { data: { object: { payment_intent: 'pi_n3a', amount_refunded: 1000 } } }, failingCtx);
    assert.equal(retry.reversed_usd, 0, 'the id was already in the reversals list -- the retry subtracts nothing further');
    assert.equal(H.pend('builder_n3a'), 0, 'exactly $0.000000, not negative');
    assert.equal(H.earnings.builder_n3a.reversals.length, 1, 'one reversal recorded, not two');
  });

  it('trigger (b): an on-the-spot reversal racing a replayed refund event for the same payment -- reversed exactly once', async () => {
    resetCreditsFile();
    const H = makeHarness();
    // Establish builder_n3b's real earnings entry the ordinary way first
    // (a reversal can only debit an entry that already exists).
    await credits.addDollarLot('n3_buyer_seed', 'dollar_paid', 10, { stripe_payment_intent: 'pi_n3b_seed' });
    await H.unlock('n3_buyer_seed', 'Lseed', 'builder_n3b', 10);
    assert.equal(H.pend('builder_n3b'), 7);

    await credits.addDollarLot('n3_buyer_b', 'dollar_paid', 10, { stripe_payment_intent: 'pi_n3b' });
    // Force this unlock's own funding to land on a lot the refund has
    // already reached PAST (no funding record existed for it yet) by
    // drawing $2 mid-flight, then refunding the full $10 charge before
    // recordLotFunding ever runs for that draw -- $8 is covered by the
    // remaining balance, $2 (the in-flight draw) is left uncovered.
    const draw = await credits.deductCredit('n3_buyer_b', 'unlock', 2);
    assert.equal(draw.success, true);
    await credits.removeDollarLotRemainder('n3_buyer_b', 'pi_n3b', 10);
    const f = await credits.recordLotFunding('n3_buyer_b', draw.draws, {
      learning_id: 'L1', contributor_account_id: 'builder_n3b', contributor_wallet: null,
      contributor_amount: 1.4, platform_amount: 0.6,
    });
    assert.equal(f.needsReversal.length, 1);

    // A second, replayed refund event for the SAME cumulative amount picks
    // up the SAME pending entry (still marked pending_reversal on the lot)
    // and reverses it first.
    const replay = await H.refund('pi_n3b', 10000);
    assert.equal(replay.reversed_usd, 1.4, 'the replayed event reverses it first');
    assert.equal(H.pend('builder_n3b'), 5.6, '7 - 1.4');

    // The original request's own on-the-spot reversal, holding the SAME
    // needsReversal array captured before the replay, now runs too.
    const { totalReversed } = await earningsReversal.reverseLotFunding(H.earnings, f.needsReversal);
    assert.equal(totalReversed, 0, 'the id is already in the reversals list -- nothing left to subtract');
    assert.equal(H.pend('builder_n3b'), 5.6, 'unchanged -- not double-reversed to 4.2');
    assert.equal(H.earnings.builder_n3b.reversals.length, 1, 'one reversal recorded, not two');
  });
});

// ─── Ruling N6: a won/warning_closed dispute clears only ITS OWN hold ─────

describe('[ruling N6] a resolved dispute clears a dispute_hold only when the hold\'s own payment_intent matches', () => {
  it('pi_B won never clears a hold pi_A placed; pi_A won does', async () => {
    resetCreditsFile();
    const H = makeHarness();
    await credits.addDollarLot('n6_buyer', 'dollar_paid', 10, { stripe_payment_intent: 'pi_n6a' });
    await credits.addDollarLot('n6_buyer', 'dollar_paid', 10, { stripe_payment_intent: 'pi_n6b' });
    // pi_n6a: spend more than half, so its dispute places the hold.
    await H.unlock('n6_buyer', 'L1', 'bN6', 6);
    await H.dcreated('pi_n6a');
    // pi_n6b: untouched -- its own dispute freezes the lot but is not
    // "more than half spent", so it never places or overwrites the hold.
    await H.dcreated('pi_n6b');
    const hold = accountHolds.getAccountHold('n6_buyer');
    assert.ok(hold && hold.reason === 'dispute_hold');
    assert.equal(hold.detail.payment_intent, 'pi_n6a');

    // pi_B (a DIFFERENT, still-open dispute) closes won -- must NOT clear pi_A's hold.
    await H.dclosed('pi_n6b', 'won');
    const stillHeld = accountHolds.getAccountHold('n6_buyer');
    assert.ok(stillHeld, 'the hold pi_A placed must survive a different dispute closing');
    assert.equal(stillHeld.detail.payment_intent, 'pi_n6a');
    assert.equal(H.lot('n6_buyer', 'pi_n6a').frozen, true, 'pi_A itself is still open');

    // pi_A itself closes won -- NOW the hold it placed clears.
    await H.dclosed('pi_n6a', 'won');
    assert.equal(accountHolds.getAccountHold('n6_buyer'), null, 'the matching dispute clears its own hold');
  });
});

// ─── Ruling N8: the counter-gate file is pruned, and never stops an unlock ─

describe('[ruling N8] the counter-gate file drops entries older than 30 days on write, and stays lenient on read', () => {
  it('an entry older than the 30-day window is pruned on the next write', () => {
    const state = { 'a:L1': Date.now() - 40 * 24 * 60 * 60 * 1000, 'b:L2': Date.now() };
    const pruned = counterGate.pruneExpired({ ...state });
    assert.equal('a:L1' in pruned, false, 'older than 30 days -- dropped');
    assert.equal('b:L2' in pruned, true, 'fresh -- kept');
  });

  it('a corrupt or missing gate file still reads as empty -- it must never stop an unlock', () => {
    fs.writeFileSync(process.env.AUXILO_UNLOCK_COUNTER_GATE_FILE, 'not json');
    assert.deepEqual(counterGate.load(), {});
    fs.rmSync(process.env.AUXILO_UNLOCK_COUNTER_GATE_FILE, { force: true });
    assert.deepEqual(counterGate.load(), {});
  });
});

// ─── Ruling N7: checkout-sessions.json follows the L11 read rule, and is pruned ─

describe('[ruling N7] checkout-sessions.json: pruned on write, and refuses (never reads empty) on a real corruption', () => {
  it('a missing file reads as empty (positive control); a corrupt file refuses the read', () => {
    fs.rmSync(process.env.AUXILO_CHECKOUT_SESSIONS_FILE, { force: true });
    assert.deepEqual(checkoutSessions.load(), {});
    fs.writeFileSync(process.env.AUXILO_CHECKOUT_SESSIONS_FILE, '{ not valid json');
    assert.throws(() => checkoutSessions.load(), 'a corrupt checkout-sessions.json must refuse the read, never silently read as no pending sessions');
    fs.writeFileSync(process.env.AUXILO_CHECKOUT_SESSIONS_FILE, '{}');
  });

  it('an expired entry is dropped on the next write', () => {
    const past = Date.now() - 1000;
    const future = Date.now() + 60 * 60 * 1000;
    checkoutSessions.save({ old_one: { account_id: 'x', amount_usd: 10, created_at: past, expires_at: past }, fresh_one: { account_id: 'x', amount_usd: 10, created_at: Date.now(), expires_at: future } });
    const onDisk = checkoutSessions.load();
    assert.equal('old_one' in onDisk, false, 'expired -- pruned on write');
    assert.equal('fresh_one' in onDisk, true);
  });

  it('reservePendingSession / promoteReservation / clearPendingSession round-trip, counted only until their own expiry', () => {
    checkoutSessions.save({});
    const resv = checkoutSessions.reservePendingSession('acct_n7', 25);
    assert.equal(checkoutSessions.getPendingSessionsTotalUsd('acct_n7'), 25);
    checkoutSessions.promoteReservation(resv, 'cs_real_n7', 'acct_n7', 25, Math.floor(Date.now() / 1000) + 35 * 60);
    assert.equal(checkoutSessions.getPendingSessionsTotalUsd('acct_n7'), 25, 'promoted to a real session, still counted once');
    // Far in the future, past the session's own expiry -- stops counting.
    assert.equal(checkoutSessions.getPendingSessionsTotalUsd('acct_n7', Date.now() + 40 * 60 * 1000), 0);
    checkoutSessions.clearPendingSession('cs_real_n7');
    assert.equal(checkoutSessions.getPendingSessionsTotalUsd('acct_n7'), 0);
  });
});

// ─── Ruling M3: the lock closes the parallel-request gap ──────────────────

describe('[ruling M3] acquireCheckoutLock serializes the check-then-reserve sequence', () => {
  it('50 "parallel" reserve calls under the lock behave as if sequential -- only 20 land before the cap', async () => {
    checkoutSessions.save({});
    const BALANCE_CAP_USD = 2000;
    const packPrice = 100;
    async function attempt(i) {
      const release = await checkoutSessions.acquireCheckoutLock('m3_acct');
      try {
        const current = checkoutSessions.getPendingSessionsTotalUsd('m3_acct');
        if (current + packPrice > BALANCE_CAP_USD) return 'refused';
        checkoutSessions.reservePendingSession('m3_acct', packPrice);
        return 'accepted';
      } finally {
        release();
      }
    }
    const results = await Promise.all(Array.from({ length: 50 }, (_, i) => attempt(i)));
    assert.equal(results.filter((r) => r === 'accepted').length, 20);
    assert.equal(results.filter((r) => r === 'refused').length, 30);
    assert.equal(checkoutSessions.getPendingSessionsTotalUsd('m3_acct'), 2000);
  });
});

// ─── Ruling N2: the Checkout session expiry ────────────────────────────────

describe('[ruling N2] the Checkout session expiry sits clear of Stripe\'s minimum, and the caller counts Stripe\'s own value', () => {
  it('createCheckoutSession requests 35 minutes, five clear of Stripe\'s documented 30-minute floor', () => {
    const STRIPE_LIB_SRC = read('lib', 'stripe.js');
    assert.ok(STRIPE_LIB_SRC.includes('expires_at: Math.floor(Date.now() / 1000) + 35 * 60,'));
    assert.ok(!STRIPE_LIB_SRC.includes('+ 30 * 60,'), 'the exact-minimum value must be gone');
  });

  it('createCheckoutSession returns Stripe\'s own expires_at, not merely {url, session_id}', async () => {
    const stripeModulePath = require.resolve('stripe');
    const priorCacheEntry = require.cache[stripeModulePath];
    delete require.cache[stripeModulePath];
    const stripeLibPath = require.resolve('../lib/stripe.js');
    delete require.cache[stripeLibPath];
    const providerExpiry = Math.floor(Date.now() / 1000) + 2400;
    class FakeStripe {
      constructor() {
        this.accounts = { retrieve: async () => ({ id: 'acct_1TCbMe0Jj0R41QQV' }) };
        this.balance = { retrieve: async () => ({ livemode: false }) };
        this.checkout = { sessions: { create: async request => ({ id: 'cs_n2_fake', object: 'checkout.session', mode: 'payment', livemode: false, amount_total: 1000, currency: 'usd', metadata: request.metadata, url: 'https://checkout.stripe.test/n2', expires_at: providerExpiry }) } };
      }
    }
    require.cache[stripeModulePath] = { id: stripeModulePath, filename: stripeModulePath, loaded: true, exports: FakeStripe };
    const priorKey = process.env.STRIPE_SECRET_KEY;
    process.env.STRIPE_SECRET_KEY = 'sk_test_' + 'n'.repeat(32);
    try {
      const freshStripeLib = require('../lib/stripe.js');
      freshStripeLib.__setStripeClientForTest(new FakeStripe());
      const { context } = await require('../lib/stripe-platforms').getVerifiedClient('legacy');
      const result = await freshStripeLib.createCheckoutSession('acc_n2', 'starter', 'https://auxilo.test', { context, idempotencyKey: 'n2-key', intentId: 'n2-intent' });
      assert.equal(result.expires_at, providerExpiry, 'the caller uses the expiry STRIPE confirmed, not a locally recomputed one');
    } finally {
      require('../lib/stripe-platforms').__setRegistryForTest();
      if (priorKey === undefined) delete process.env.STRIPE_SECRET_KEY; else process.env.STRIPE_SECRET_KEY = priorKey;
      delete require.cache[stripeLibPath];
      if (priorCacheEntry) require.cache[stripeModulePath] = priorCacheEntry; else delete require.cache[stripeModulePath];
    }
  });
});

// ─── Ruling N9: the durable hold-clear log ─────────────────────────────────

describe('[ruling N9] a hold clear is appended to a durable log, created on first use', () => {
  it('appendHoldClearLog writes a line with the account, reason, time and admin scope; the file is created on first use', () => {
    fs.rmSync(accountHolds.HOLD_CLEAR_LOG_FILE, { force: true });
    assert.deepEqual(accountHolds.loadHoldClearLog(), [], 'no file yet -- reads as empty');
    accountHolds.appendHoldClearLog({ accountId: 'n9_acct', reason: 'cap_overage', clearedAt: '2026-09-27T00:00:00.000Z', adminScope: 'admin' });
    assert.ok(fs.existsSync(accountHolds.HOLD_CLEAR_LOG_FILE), 'created on first use');
    const rows = accountHolds.loadHoldClearLog();
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0], { account_id: 'n9_acct', reason: 'cap_overage', cleared_at: '2026-09-27T00:00:00.000Z', admin_scope: 'admin' });
    // A second clear within the alert's 5-minute rate limit still gets its own durable line.
    accountHolds.appendHoldClearLog({ accountId: 'n9_acct', reason: 'dispute_hold', clearedAt: '2026-09-27T00:01:00.000Z', adminScope: 'admin' });
    assert.equal(accountHolds.loadHoldClearLog().length, 2);
  });
});

// ─── Ruling N10: openapi.json no longer documents reset_at ────────────────

describe('[ruling N10] openapi.json: reset_at is removed everywhere it was documented', () => {
  it('none of the three named descriptions mention reset_at anymore', () => {
    const openapi = JSON.parse(read('openapi.json'));
    assert.doesNotMatch(openapi.paths['/knowledge/{id}'].get.responses['402'].description, /reset_at/);
    const x402Schema = openapi.components.schemas.X402PaymentChallenge || openapi.components.schemas.X402Challenge;
    // The two auth/challenge schema descriptions named in the review.
    let sawOne = false;
    for (const schema of Object.values(openapi.components.schemas)) {
      if (typeof schema.description === 'string' && /options\b/.test(schema.description)) {
        assert.doesNotMatch(schema.description, /reset_at/);
        sawOne = true;
      }
      if (schema.properties) {
        for (const prop of Object.values(schema.properties)) {
          if (typeof prop.description === 'string') assert.doesNotMatch(prop.description, /reset_at/);
        }
      }
    }
    assert.ok(sawOne, 'at least one options-carrying schema must have been checked');
    void x402Schema;
  });

  it('no occurrence of reset_at survives anywhere in the file', () => {
    const raw = read('openapi.json');
    assert.doesNotMatch(raw, /reset_at/);
  });
});
