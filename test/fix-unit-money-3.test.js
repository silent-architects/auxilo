'use strict';

/**
 * test/fix-unit-money-3.test.js — FIX-UNIT-MONEY-3.md, rulings proved at the
 * lib/source level: N14, N15, N16, N18 (the one LOW finding in the final
 * confirm), and R1 (the reconcile-ledgers script).
 *
 * Route-level proof for N17 (a corrupt checkout-sessions.json through the
 * real POST /webhook/stripe route) lives in
 * test/fix-unit-money-3-route.test.js.
 *
 * Every data file this suite touches is redirected to a private temp
 * directory before any module loads. No network call, no real Stripe SDK,
 * no real HOME.
 *
 * Runner: node --test test/fix-unit-money-3.test.js
 */

const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-unit-money-3-'));
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

after(() => { try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch { /* best effort */ } });

const credits = require('../lib/credits.js');
const refundHandlers = require('../lib/stripe-refund-handlers.js');
const earningsReversal = require('../lib/earnings-reversal.js');
const { resolveEarningsEntry, initEarningsEntry } = require('../lib/earnings.js');
const wal = require('../lib/wal.js');

function resetCreditsFile() { fs.writeFileSync(process.env.AUXILO_CREDITS_FILE, '{}'); }

// A small harness replicating the unlock handler's money steps IN ORDER
// (server.js: debit; compute the split; credit the earnings entry; commit;
// mark draws in flight right after the debit (N18); recordLotFunding AFTER
// commit, stamped with the unlock's own id (N16); an on-the-spot M2/N1
// reversal if recordLotFunding found one) — the same order
// REVIEW-MONEY-PATH.md's proof scripts and test/fix-unit-money-2.test.js
// replicate.
function makeHarness() {
  const earnings = {};
  const ctx = { earnings, saveEarnings: () => {}, sendOpsAlert: async () => {} };
  let unlockCounter = 0;

  async function unlock(buyer, learningId, builder, price, opts = {}) {
    const share = opts.share || 0.7;
    const r = await credits.deductCredit(buyer, 'unlock', price);
    if (!r.success) return { ok: false, r };
    if (r.draws && r.draws.length > 0) {
      await credits.markDrawsInFlight(buyer, r.draws);
    }
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

    const unlockId = opts.unlockId || ('wal_test_' + (++unlockCounter));

    if (opts.skipFunding) {
      // Simulates the process dying between commit and recordLotFunding
      // (ruling N16): the money accounting above already landed, but
      // nothing records which lot funded it.
      return { ok: true, ce, pe, r, unlockId, skipped: true };
    }

    const f = await credits.recordLotFunding(buyer, r.draws, {
      learning_id: learningId, contributor_account_id: builder, contributor_wallet: null,
      contributor_amount: ce, platform_amount: pe, unlock_id: unlockId,
    });
    let spot = 0;
    if (f.needsReversal.length) {
      const { totalReversed } = await earningsReversal.reverseLotFunding(earnings, f.needsReversal);
      spot = totalReversed;
      for (const lotId of new Set(f.needsReversal.map((e) => e.lot_id))) {
        await credits.finalizePendingReversals(buyer, lotId);
      }
    }
    return { ok: true, ce, pe, spot, r, unlockId };
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
  // "Auxilo holds" -- the true, ground-truth money still collected for this
  // pack: original minus everything refunded/lost, never touched by which
  // shares are or aren't yet recorded.
  const holds = (a, pi) => {
    const L = lot(a, pi);
    const disputeLost = Object.values(L.dispute_lost_by_id || {}).reduce((s, v) => s + (v || 0), 0);
    return credits.round6(Math.max(0, (L.original_usd || 0) - (L.refunded_usd || 0) - disputeLost));
  };
  return { earnings, ctx, unlock, refund, dcreated, dclosed, pend, bal, lot, holds };
}

// Invariant: builders never keep more than 70% of what Auxilo still holds
// for the pack, and never more than holds itself.
function assertInvariant(ownedTotal, heldTotal, label) {
  assert.ok(ownedTotal <= heldTotal + 1e-6, `${label}: owed ${ownedTotal} must not exceed holds ${heldTotal}`);
  assert.ok(ownedTotal <= 0.7 * heldTotal + 1e-6, `${label}: owed ${ownedTotal} must not exceed 0.7 x holds ${heldTotal}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// N14: refunds and lost disputes share ONE running total, on the pack, not
// two independent per-source fields that overwrite each other.
// ═══════════════════════════════════════════════════════════════════════════

describe('[ruling N14] refunds and lost disputes each keep their own running total, combined before anything is removed or reversed', () => {
  it('Walk C: dispute opens, $40 spent across two builders, a $5 refund lands while the dispute is open, then the dispute is lost for $60', async () => {
    resetCreditsFile();
    const H = makeHarness();
    await credits.addDollarLot('n14_walkc', 'dollar_paid', 100, { stripe_payment_intent: 'pi_n14_walkc' });

    // dispute opens, $40 spent
    const u1 = await H.unlock('n14_walkc', 'L1', 'c1', 20);
    const u2 = await H.unlock('n14_walkc', 'L2', 'c2', 20);
    assert.equal(u1.ce, 14); assert.equal(u2.ce, 14);
    await H.dcreated('pi_n14_walkc');
    assert.equal(H.bal('n14_walkc').total_usd, 0, 'frozen -- nothing spendable');
    assert.equal(H.bal('n14_walkc').frozen_usd, 60);
    assert.equal(H.pend('c1'), 14); assert.equal(H.pend('c2'), 14);
    assert.equal(H.holds('n14_walkc', 'pi_n14_walkc'), 100);
    assertInvariant(H.pend('c1') + H.pend('c2'), H.holds('n14_walkc', 'pi_n14_walkc'), 'step 1');

    // $5 refund while the dispute is open
    const r1 = await H.refund('pi_n14_walkc', 500);
    assert.equal(r1.matched, true);
    assert.equal(H.bal('n14_walkc').frozen_usd, 55, 'refund reduces the frozen remainder, still frozen');
    assert.equal(H.pend('c1'), 14); assert.equal(H.pend('c2'), 14);
    assert.equal(H.holds('n14_walkc', 'pi_n14_walkc'), 95);
    assertInvariant(H.pend('c1') + H.pend('c2'), H.holds('n14_walkc', 'pi_n14_walkc'), 'step 2');

    // dispute lost for $60 -- a SEPARATE $60, not cumulative with the $5
    // refund. True money gone = 5 + 60 = 65; true holds = 35.
    const d1 = await H.dclosed('pi_n14_walkc', 'lost', { amount: 6000 });
    assert.equal(d1.matched, true);
    assert.equal(H.holds('n14_walkc', 'pi_n14_walkc'), 35, 'holds = 100 - 5 (refund) - 60 (dispute), the two totals summed');
    // excess beyond remaining (35 held - 40 spent... the excess against what
    // remained after the refund) reverses c2 (newest) partially: c1 stays
    // 14, c2 loses 3.5 (14 -> 10.5). owed = 24.5 = 0.7 x 35 exactly.
    assert.equal(H.pend('c1'), 14);
    assert.equal(H.pend('c2'), 10.5);
    assertInvariant(H.pend('c1') + H.pend('c2'), H.holds('n14_walkc', 'pi_n14_walkc'), 'step 3');
    assert.equal(credits.round6(H.pend('c1') + H.pend('c2')), 24.5);

    // Same event again: no increase, nothing doubles.
    const d1again = await H.dclosed('pi_n14_walkc', 'lost', { amount: 6000 });
    assert.equal(d1again.matched, true);
    assert.equal(H.pend('c1'), 14);
    assert.equal(H.pend('c2'), 10.5);
    assert.equal(H.holds('n14_walkc', 'pi_n14_walkc'), 35);
  });

  it('Walk C variant: $95 spent with one builder, a $5 refund, then the dispute is lost for the remaining $95', async () => {
    resetCreditsFile();
    const H = makeHarness();
    await credits.addDollarLot('n14_walkc2', 'dollar_paid', 100, { stripe_payment_intent: 'pi_n14_walkc2' });

    const u1 = await H.unlock('n14_walkc2', 'L1', 'e1', 95);
    assert.equal(u1.ce, 66.5);
    assert.equal(H.pend('e1'), 66.5);
    assert.equal(H.holds('n14_walkc2', 'pi_n14_walkc2'), 100);

    const r1 = await H.refund('pi_n14_walkc2', 500);
    assert.equal(r1.matched, true);
    assert.equal(H.pend('e1'), 66.5, 'the $5 refund is fully covered by the $5 unspent remainder');
    assert.equal(H.holds('n14_walkc2', 'pi_n14_walkc2'), 95);
    assertInvariant(H.pend('e1'), H.holds('n14_walkc2', 'pi_n14_walkc2'), 'after refund');

    // Dispute lost for the remaining $95 -- combined total = 5 + 95 = 100 = original.
    const d1 = await H.dclosed('pi_n14_walkc2', 'lost', { amount: 9500 });
    assert.equal(d1.matched, true);
    assert.equal(H.holds('n14_walkc2', 'pi_n14_walkc2'), 0, 'the platform holds nothing from this pack');
    assert.equal(H.pend('e1'), 0, 'e1\'s entire share is reversed -- the platform never owes money it does not hold');
    assertInvariant(H.pend('e1'), H.holds('n14_walkc2', 'pi_n14_walkc2'), 'after dispute lost');
  });

  it('dispute-first case: the dispute is lost BEFORE the refund arrives, and the two orders reach the same final state', async () => {
    resetCreditsFile();
    const H = makeHarness();
    await credits.addDollarLot('n14_dfirst', 'dollar_paid', 100, { stripe_payment_intent: 'pi_n14_dfirst' });

    const u1 = await H.unlock('n14_dfirst', 'L1', 'c1', 20);
    const u2 = await H.unlock('n14_dfirst', 'L2', 'c2', 20);
    assert.equal(u1.ce, 14); assert.equal(u2.ce, 14);
    await H.dcreated('pi_n14_dfirst');

    // Dispute lost for $60 FIRST (no refund yet).
    const d1 = await H.dclosed('pi_n14_dfirst', 'lost', { amount: 6000 });
    assert.equal(d1.matched, true);
    assert.equal(H.holds('n14_dfirst', 'pi_n14_dfirst'), 40, 'holds = 100 - 60');
    assert.equal(H.pend('c1'), 14); assert.equal(H.pend('c2'), 14);
    assertInvariant(H.pend('c1') + H.pend('c2'), H.holds('n14_dfirst', 'pi_n14_dfirst'), 'after dispute lost');

    // THEN a $5 refund of the undisputed rest.
    const r1 = await H.refund('pi_n14_dfirst', 500);
    assert.equal(r1.matched, true);
    assert.equal(H.holds('n14_dfirst', 'pi_n14_dfirst'), 35, 'holds = 100 - 60 - 5, the same combined total as refund-first');
    assert.equal(H.pend('c1'), 14);
    assert.equal(H.pend('c2'), 10.5, 'the newest share (c2) absorbs the $5 excess, same outcome as Walk C');
    assertInvariant(H.pend('c1') + H.pend('c2'), H.holds('n14_dfirst', 'pi_n14_dfirst'), 'after refund');
    assert.equal(credits.round6(H.pend('c1') + H.pend('c2')), 24.5, 'dispute-then-refund reaches the SAME final total as refund-then-dispute');
  });

  it('the review\'s p26 mirror case: a $40 refund of the undisputed rest after a $60 lost dispute is no longer ignored', async () => {
    resetCreditsFile();
    const H = makeHarness();
    await credits.addDollarLot('n14_p26', 'dollar_paid', 100, { stripe_payment_intent: 'pi_n14_p26' });
    await H.dcreated('pi_n14_p26');
    const d1 = await H.dclosed('pi_n14_p26', 'lost', { amount: 6000 });
    assert.equal(d1.removed_usd, 60);
    assert.equal(H.holds('n14_p26', 'pi_n14_p26'), 40);

    const r1 = await H.refund('pi_n14_p26', 4000);
    assert.equal(r1.matched, true);
    assert.equal(r1.removed_usd, 40, 'the $40 refund is now processed in full, not ignored as "below the stored 60"');
    assert.equal(H.bal('n14_p26').total_usd, 0, 'no phantom spendable balance is left');
    assert.equal(H.holds('n14_p26', 'pi_n14_p26'), 0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// N15: a failed earnings save followed by a retry must not mark a reversal
// done without ever saving it.
// ═══════════════════════════════════════════════════════════════════════════

describe('[ruling N15] the earnings save happens before a reversal is marked done, on every retry path', () => {
  it('fail the save once, retry, restart from disk: the builder is at exactly the right amount with one reversal recorded', async () => {
    resetCreditsFile();
    const H = makeHarness();
    await credits.addDollarLot('n15_buyer', 'dollar_paid', 10, { stripe_payment_intent: 'pi_n15' });
    await H.unlock('n15_buyer', 'L1', 'n15_builder', 10);
    assert.equal(H.pend('n15_builder'), 7);

    let disk = JSON.parse(JSON.stringify(H.earnings));
    let fail = true;
    let successfulSaves = 0;
    H.ctx.saveEarnings = () => {
      if (fail) { fail = false; throw new Error('EIO: simulated disk write failure'); }
      disk = JSON.parse(JSON.stringify(H.earnings));
      successfulSaves++;
    };

    // First delivery: the save throws. The reversal must not be marked done.
    await assert.rejects(() => H.refund('pi_n15', 1000));
    assert.equal(H.pend('n15_builder'), 0, 'in memory, the reversal already applied');
    assert.equal(disk.n15_builder.pending_balance, 7, 'on disk, the failed save never persisted it');
    let lotEntries = H.lot('n15_buyer', 'pi_n15').funded_unlocks;
    assert.equal(lotEntries.filter((f) => f.reversed).length, 0, 'not yet durably finalized');

    // Stripe's retry: reverseLotFunding finds the entry's id already applied
    // in memory (reversed 0 this time), but the save must still run.
    const retry = await H.refund('pi_n15', 1000);
    assert.equal(retry.matched, true);
    assert.equal(successfulSaves, 1, 'the retry\'s save succeeds this time');
    assert.equal(disk.n15_builder.pending_balance, 0, 'now persisted to disk');
    lotEntries = H.lot('n15_buyer', 'pi_n15').funded_unlocks;
    assert.equal(lotEntries.filter((f) => f.reversed).length, 1, 'exactly one reversal recorded, durably');

    // Restart: memory reloads from disk (now correctly 0).
    for (const k of Object.keys(H.earnings)) delete H.earnings[k];
    Object.assign(H.earnings, disk);

    // A further delivery of the SAME event finds nothing pending -- no-op.
    const again = await H.refund('pi_n15', 1000);
    assert.equal(again.matched, true);
    assert.equal(again.reversed_usd, 0);
    assert.equal(H.pend('n15_builder'), 0, 'the builder is at exactly the right amount after restart');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// N16: a crash between an unlock's commit and the record of which lot paid
// for it.
// ═══════════════════════════════════════════════════════════════════════════

describe('[ruling N16] the unlock\'s draws survive in its recovery log entry, and recovery records the funding if not already recorded', () => {
  it('recordLotFundingSync is idempotent on the unlock id: a second call for the SAME unlock records nothing further', async () => {
    resetCreditsFile();
    await credits.addDollarLot('n16_idem', 'dollar_paid', 10, { stripe_payment_intent: 'pi_n16_idem' });
    const draw = await credits.deductCredit('n16_idem', 'unlock', 10);
    assert.equal(draw.success, true);

    const info = {
      learning_id: 'L1', contributor_account_id: 'n16_builder', contributor_wallet: null,
      contributor_amount: 7, platform_amount: 3, unlock_id: 'wal_fixed_id_1',
    };
    const first = credits.recordLotFundingSync('n16_idem', draw.draws, info);
    assert.equal(first.needsReversal.length, 0);
    const second = credits.recordLotFundingSync('n16_idem', draw.draws, info);
    assert.equal(second.needsReversal.length, 0);

    const entries = credits.loadCredits()['n16_idem'].dollar_lots[0].funded_unlocks;
    assert.equal(entries.length, 1, 'the second call recorded nothing further for the same unlock id');
    assert.equal(entries[0].contributor_amount, 7);
  });

  it('replayLotFundingFromWalEntry: a crash between commit and the funding record, recovery records it from the SAME WAL payload, then a full refund ends the builder at zero', async () => {
    resetCreditsFile();
    const H = makeHarness();
    await credits.addDollarLot('n16_crash', 'dollar_paid', 10, { stripe_payment_intent: 'pi_n16_crash' });

    // The unlock's money steps run (debit, earnings credit) but the process
    // "dies" before recordLotFunding -- exactly server.js's own sequence,
    // simulated the same way the review's own proof scripts did.
    const u1 = await H.unlock('n16_crash', 'L1', 'n16_builder', 10, { skipFunding: true, unlockId: 'wal_crash_1' });
    assert.equal(u1.ce, 7);
    assert.equal(H.pend('n16_builder'), 7, 'earnings already credited -- the crash landed AFTER that step');
    assert.equal(H.lot('n16_crash', 'pi_n16_crash').funded_unlocks.length, 0, 'no funding record yet -- this is the crash window');

    // Build the SAME WAL entry server.js would have left on disk: the
    // draws are in the payload (written before the commit), and
    // 'lot_funding_recorded' is missing.
    const walId = wal.createWalEntry('unlock', {
      learning_id: 'L1',
      builder_wallet: null,
      contributor_account_id: 'n16_builder',
      funding_source: 'credit_pack',
      purchaser_account_id: 'n16_crash',
      contributor_earned: u1.ce,
      platform_earned: u1.pe,
      dollar_draws: u1.r.draws,
      unlocked_at: new Date().toISOString(),
    });
    wal.markStepComplete(walId, 'update_learnings');
    wal.markStepComplete(walId, 'update_earnings');
    wal.markStepComplete(walId, 'unlock_event_appended');

    // Recovery: the entry is still pending (never committed -- the crash
    // means commitWal never ran).
    const pendingBefore = wal.getPendingWalEntries().find((e) => e.id === walId);
    assert.ok(pendingBefore, 'the WAL entry survives the crash');
    const replay = credits.replayLotFundingFromWalEntry(pendingBefore);
    assert.equal(replay.applicable, true);
    assert.equal(replay.already_done, false);
    assert.equal(replay.needsReversal.length, 0);
    wal.commitWal(walId);

    // The funding is now recorded -- a later refund can find and reverse it.
    // (unlock_id on the recorded entry is the WAL entry's OWN id, walId --
    // the same identity replayLotFundingFromWalEntry uses to dedupe.)
    const lotEntries = H.lot('n16_crash', 'pi_n16_crash').funded_unlocks;
    assert.equal(lotEntries.length, 1);
    assert.equal(lotEntries[0].contributor_amount, 7);
    assert.equal(lotEntries[0].unlock_id, walId);

    // Replaying the SAME entry again is a no-op (idempotent).
    const replayAgain = credits.replayLotFundingFromWalEntry({ ...pendingBefore, steps_completed: ['update_learnings', 'update_earnings', 'unlock_event_appended'] });
    assert.equal(replayAgain.applicable, true);
    assert.equal(H.lot('n16_crash', 'pi_n16_crash').funded_unlocks.length, 1, 'still exactly one entry');

    // The pack is refunded in full: the builder ends at exactly zero,
    // because the funding record survived to be found and reversed.
    const refundResult = await H.refund('pi_n16_crash', 1000);
    assert.equal(refundResult.matched, true);
    assert.equal(refundResult.reversed_usd, 7);
    assert.equal(H.pend('n16_builder'), 0, 'the builder ends at zero -- Auxilo holds nothing from this pack');
  });

  it('a non-credit_pack WAL entry (x402/router) is left untouched by the replay', () => {
    const result = credits.replayLotFundingFromWalEntry({
      id: 'wal_x402', payload: { funding_source: 'x402' }, steps_completed: [],
    });
    assert.equal(result.applicable, false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// N18 (the one LOW finding in the final confirm): an in-flight draw counts
// as the newest thing on the lot when a refund/dispute's excess is
// allocated.
// ═══════════════════════════════════════════════════════════════════════════

describe('[the LOW finding, N18] an in-flight (debited, not yet funded) draw is treated as the newest draw when excess is allocated', () => {
  it('a partial excess is attributed to the in-flight draw BEFORE reversing an already-recorded, older share', async () => {
    resetCreditsFile();
    const H = makeHarness();
    await credits.addDollarLot('n18_buyer', 'dollar_paid', 20, { stripe_payment_intent: 'pi_n18' });

    // An older unlock, fully recorded.
    const older = await H.unlock('n18_buyer', 'L_older', 'n18_older', 10);
    assert.equal(older.ce, 7);

    // A newer unlock, debited and marked in flight, but funding not yet recorded.
    const newer = await H.unlock('n18_buyer', 'L_newer', 'n18_newer', 10, { skipFunding: true });
    assert.equal(newer.ce, 7);
    assert.equal(H.lot('n18_buyer', 'pi_n18').inflight_usd, 10, 'the newer draw is marked in flight');
    assert.equal(H.lot('n18_buyer', 'pi_n18').remaining_usd, 0);

    // A full $20 refund: excess after removing the (already-zero) remainder
    // is $20. It must go to the in-flight $10 draw FIRST (the newest thing
    // on the lot), then to the older, already-recorded $10 entry.
    const r1 = await H.refund('pi_n18', 2000);
    assert.equal(r1.matched, true);
    assert.equal(r1.reversed_usd, 7, 'only the OLDER, already-recorded entry is reversed on the spot');
    assert.equal(H.pend('n18_older'), 0);
    assert.equal(H.lot('n18_buyer', 'pi_n18').uncovered_usd, 10, 'the in-flight $10 is attributed to uncovered_usd, ready for the newer unlock to find');

    // When the newer unlock's funding finally gets recorded, it finds the
    // uncovered amount and is reversed on the spot too -- it was the
    // newest draw all along, so it is the first (not the last) to be
    // reversed, matching Terms 7.6 item 3.
    const f = await credits.recordLotFunding('n18_buyer', newer.r.draws, {
      learning_id: 'L_newer', contributor_account_id: 'n18_newer', contributor_wallet: null,
      contributor_amount: newer.ce, platform_amount: newer.pe, unlock_id: newer.unlockId,
    });
    assert.equal(f.needsReversal.length, 1);
    const { totalReversed } = await earningsReversal.reverseLotFunding(H.earnings, f.needsReversal);
    assert.equal(totalReversed, 7);
    assert.equal(H.pend('n18_newer'), 0, 'the newer (in-flight-at-refund-time) share is the one reversed, not kept');
    assert.equal(H.lot('n18_buyer', 'pi_n18').inflight_usd, 0, 'cleared once recorded');
    assert.equal(H.lot('n18_buyer', 'pi_n18').uncovered_usd, 0);
  });

  it('markDrawsInFlight failing (account not found) never throws and never blocks the caller', async () => {
    resetCreditsFile();
    const result = await credits.markDrawsInFlight('no_such_account', [{ lot_id: 'lot_x', kind: 'dollar_paid', amount: 1 }]);
    assert.equal(result.success, false);
    assert.equal(result.reason, 'account_not_found');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// R1: the two ledgers are never reconciled -- scripts/reconcile-ledgers.js
// ═══════════════════════════════════════════════════════════════════════════

describe('[ruling R1] scripts/reconcile-ledgers.js reads both ledgers, changes nothing, and never prints an account/email/wallet/key', () => {
  it('reports, per pack, paid dollars spent / shares recorded / shares reversed, and flags a pack over the 70% cap, against a small fixture', () => {
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-fixture-'));
    try {
      const creditsFixture = {
        acc_buyer_1: {
          dollar_lots: [
            {
              lot_id: 'lot_healthy', kind: 'dollar_paid', stripe_payment_intent: 'pi_healthy',
              original_usd: 100, remaining_usd: 90, refunded_usd: 0, dispute_lost_by_id: {},
              funded_unlocks: [
                { contributor_account_id: 'acc_builder_1', contributor_amount: 7, platform_amount: 3, reversed: false, pending_reversal: false },
              ],
            },
            {
              // A pack whose builder kept more than 70% of what is still
              // held -- the review's Walk C outcome BEFORE the excess
              // reversal would have run (constructed directly here so the
              // fixture exercises the flag without depending on the fix
              // above).
              lot_id: 'lot_broken', kind: 'dollar_paid', stripe_payment_intent: 'pi_broken',
              original_usd: 100, remaining_usd: 0, refunded_usd: 5, dispute_lost_by_id: { du_1: 60 },
              funded_unlocks: [
                { contributor_account_id: 'acc_builder_2', contributor_amount: 14, platform_amount: 6, reversed: false, pending_reversal: false },
                { contributor_account_id: 'acc_builder_2', contributor_amount: 14, platform_amount: 6, reversed: false, pending_reversal: false },
              ],
            },
          ],
        },
      };
      const earningsFixture = {
        acc_builder_1: { pending_balance: 7 },
        acc_builder_2: { pending_balance: 20 }, // less than the 28 credits-ledger shows kept -- a drift
      };
      fs.writeFileSync(path.join(fixtureDir, 'credits.json'), JSON.stringify(creditsFixture));
      fs.writeFileSync(path.join(fixtureDir, 'earnings.json'), JSON.stringify(earningsFixture));

      const beforeCredits = fs.readFileSync(path.join(fixtureDir, 'credits.json'), 'utf8');
      const beforeEarnings = fs.readFileSync(path.join(fixtureDir, 'earnings.json'), 'utf8');

      const output = execFileSync(process.execPath, [path.join(REPO, 'scripts', 'reconcile-ledgers.js'), fixtureDir], { encoding: 'utf8' });

      // It changes nothing.
      assert.equal(fs.readFileSync(path.join(fixtureDir, 'credits.json'), 'utf8'), beforeCredits);
      assert.equal(fs.readFileSync(path.join(fixtureDir, 'earnings.json'), 'utf8'), beforeEarnings);

      // Per-pack totals.
      assert.match(output, /Packs found:\s*2/);
      assert.match(output, /10\.000000/, 'paid dollars spent on the healthy pack ($7+$3)');
      assert.match(output, /28\.000000/, 'shares recorded on the broken pack (14+14)');
      assert.match(output, /Packs where shares kept exceed 70% of money still collected:\s*1/);

      // No account, email, wallet, or key appears anywhere in the output.
      assert.doesNotMatch(output, /acc_buyer_1/);
      assert.doesNotMatch(output, /acc_builder_1/);
      assert.doesNotMatch(output, /acc_builder_2/);
      assert.doesNotMatch(output, /@/, 'no email-shaped string');
      assert.doesNotMatch(output, /0x[0-9a-fA-F]{20,}/, 'no wallet-shaped string');
    } finally {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  it('handles a data folder with no ledger files yet (missing file, not an error)', () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-empty-'));
    try {
      const output = execFileSync(process.execPath, [path.join(REPO, 'scripts', 'reconcile-ledgers.js'), emptyDir], { encoding: 'utf8' });
      assert.match(output, /Packs found:\s*0/);
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it('refuses with a clear error when no data folder is given', () => {
    assert.throws(() => execFileSync(process.execPath, [path.join(REPO, 'scripts', 'reconcile-ledgers.js')], { encoding: 'utf8' }));
  });
});
