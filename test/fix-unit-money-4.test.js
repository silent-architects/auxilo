'use strict';

/**
 * test/fix-unit-money-4.test.js — MONEYFIX4, rulings proved at the
 * lib/source level: N20, L-a (scripts/reconcile-ledgers.js), L-b
 * (lib/credit-caps.js), L-d (lib/credits.js replayLotFundingFromWalEntry).
 *
 * Route/server-level proof for N19 (boot-time pending-reversal completion)
 * and L-c (the unlock path's on-the-spot reversal save) lives in
 * test/fix-unit-money-4-route.test.js.
 *
 * Every data file this suite touches is redirected to a private temp
 * directory before any module loads. No network call, no real Stripe SDK,
 * no real HOME.
 *
 * Runner: node --test test/fix-unit-money-4.test.js
 */

const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-unit-money-4-'));
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
const creditCaps = require('../lib/credit-caps.js');
const reconcileLedgers = require('../scripts/reconcile-ledgers.js');

function resetCreditsFile() { fs.writeFileSync(process.env.AUXILO_CREDITS_FILE, '{}'); }

// Same harness shape test/fix-unit-money-3.test.js uses -- replicates
// server.js's unlock money-steps IN ORDER using the real lib functions.
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
  const holds = (a, pi) => {
    const L = lot(a, pi);
    const disputeLost = Object.values(L.dispute_lost_by_id || {}).reduce((s, v) => s + (v || 0), 0);
    return credits.round6(Math.max(0, (L.original_usd || 0) - (L.refunded_usd || 0) - disputeLost));
  };
  return { earnings, ctx, unlock, refund, dcreated, dclosed, pend, bal, lot, holds };
}

function assertInvariant(ownedTotal, heldTotal, label) {
  assert.ok(ownedTotal <= heldTotal + 1e-6, `${label}: owed ${ownedTotal} must not exceed holds ${heldTotal}`);
  assert.ok(ownedTotal <= 0.7 * heldTotal + 1e-6, `${label}: owed ${ownedTotal} must not exceed 0.7 x holds ${heldTotal}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// N20: a running total (refunded_usd, and each dispute's own lost amount)
// never goes down -- it is always the larger of what is stored and what the
// event reports.
// ═══════════════════════════════════════════════════════════════════════════

describe('[ruling N20] a late, older refund/dispute event never lowers the stored running total', () => {
  it("the review's own p35 sequence: refunds reach $30, a stale $10 refund event is redelivered, then the dispute lost for the unrefunded $70 -- the builder ends at exactly zero, not $14", async () => {
    resetCreditsFile();
    const H = makeHarness();
    await credits.addDollarLot('n20_p35', 'dollar_paid', 100, { stripe_payment_intent: 'pi_n20_p35' });
    const u1 = await H.unlock('n20_p35', 'L1', 'r1', 40);
    assert.equal(u1.ce, 28);

    await H.refund('pi_n20_p35', 1000); // $10
    await H.refund('pi_n20_p35', 3000); // cumulative $30
    assert.equal(H.lot('n20_p35', 'pi_n20_p35').refunded_usd, 30);

    // The OLDER $10 event is delivered again, late (a failed delivery
    // Stripe retries, arriving after the $30 event already landed).
    const stale = await H.refund('pi_n20_p35', 1000);
    assert.equal(stale.matched, true);
    assert.equal(H.lot('n20_p35', 'pi_n20_p35').refunded_usd, 30, 'N20: the stale, smaller cumulative figure must never overwrite the larger stored total');
    assert.equal(H.pend('r1'), 28, 'nothing was reversed yet -- $30 of $60 unspent remainder fully absorbs the refunds so far');

    // Dispute lost for the unrefunded $70 -- combined with the $30 already
    // refunded, that is the full original $100.
    const d1 = await H.dclosed('pi_n20_p35', 'lost', { amount: 7000 });
    assert.equal(d1.matched, true);
    assert.equal(H.holds('n20_p35', 'pi_n20_p35'), 0, 'the full $100 is now accounted for');
    assert.equal(H.pend('r1'), 0, 'the builder ends at exactly zero -- Auxilo holds nothing from this pack (the bug left this at $14)');
    assertInvariant(H.pend('r1'), H.holds('n20_p35', 'pi_n20_p35'), 'after the stale-event-then-dispute sequence');

    // The same stale event yet again changes nothing further.
    const staleAgain = await H.refund('pi_n20_p35', 1000);
    assert.equal(staleAgain.matched, true);
    assert.equal(H.pend('r1'), 0);
    assert.equal(H.lot('n20_p35', 'pi_n20_p35').refunded_usd, 30);
  });

  it("a late, smaller dispute.closed event for the SAME dispute id never lowers that dispute's own stored lost amount", async () => {
    resetCreditsFile();
    const H = makeHarness();
    await credits.addDollarLot('n20_dispute', 'dollar_paid', 100, { stripe_payment_intent: 'pi_n20_dispute' });
    await H.dcreated('pi_n20_dispute', 'needs_response', 'du_n20');

    // Stripe escalates the disputed amount over two closed deliveries for
    // the SAME dispute id (e.g. a corrected/retried webhook payload) --
    // the larger figure lands first, then a stale smaller one is retried.
    await H.dclosed('pi_n20_dispute', 'lost', { amount: 6000 }, 'du_n20');
    assert.equal(H.lot('n20_dispute', 'pi_n20_dispute').dispute_lost_by_id.du_n20, 60);

    await H.dclosed('pi_n20_dispute', 'lost', { amount: 2000 }, 'du_n20');
    assert.equal(H.lot('n20_dispute', 'pi_n20_dispute').dispute_lost_by_id.du_n20, 60, 'N20 applies the same rule to a dispute\'s own running total');
    assert.equal(H.holds('n20_dispute', 'pi_n20_dispute'), 40);
  });

  it('every one of the six delivery orders of three events (two refunds, one dispute) ends at the identical ledger', async () => {
    const events = [
      { kind: 'refund', cents: 2000 }, // a refund event reporting cumulative $20
      { kind: 'refund', cents: 5000 }, // a LATER, larger cumulative report ($50) -- delivery order between the two is not guaranteed
      { kind: 'dispute', cents: 5000, id: 'du_order' }, // a separate $50 lost dispute
    ];

    function permutations(arr) {
      if (arr.length <= 1) return [arr];
      const out = [];
      for (let i = 0; i < arr.length; i++) {
        const rest = arr.slice(0, i).concat(arr.slice(i + 1));
        for (const p of permutations(rest)) out.push([arr[i], ...p]);
      }
      return out;
    }

    const results = [];
    let seq = 0;
    for (const order of permutations(events)) {
      resetCreditsFile();
      const H = makeHarness();
      const acct = 'n20_order_' + (++seq);
      const pi = 'pi_n20_order_' + seq;
      await credits.addDollarLot(acct, 'dollar_paid', 100, { stripe_payment_intent: pi });
      const u1 = await H.unlock(acct, 'L1', 'x1', 40);
      assert.equal(u1.ce, 28);

      for (const ev of order) {
        if (ev.kind === 'refund') await H.refund(pi, ev.cents);
        else await H.dclosed(pi, 'lost', { amount: ev.cents }, ev.id);
      }

      const L = H.lot(acct, pi);
      const disputeLost = Object.values(L.dispute_lost_by_id || {}).reduce((s, v) => s + (v || 0), 0);
      results.push({
        order: order.map((e) => e.kind + ':' + e.cents).join('>'),
        remaining_usd: L.remaining_usd,
        refunded_usd: L.refunded_usd,
        dispute_lost: disputeLost,
        x1_pending: H.pend('x1'),
        holds: H.holds(acct, pi),
      });
      assertInvariant(H.pend('x1'), H.holds(acct, pi), results[results.length - 1].order);
    }

    const first = results[0];
    for (const r of results.slice(1)) {
      assert.equal(r.remaining_usd, first.remaining_usd, `order ${r.order} vs ${first.order}: remaining_usd must agree`);
      assert.equal(r.refunded_usd, first.refunded_usd, `order ${r.order} vs ${first.order}: refunded_usd must agree`);
      assert.equal(r.dispute_lost, first.dispute_lost, `order ${r.order} vs ${first.order}: dispute_lost must agree`);
      assert.equal(r.x1_pending, first.x1_pending, `order ${r.order} vs ${first.order}: the builder's kept balance must agree`);
      assert.equal(r.holds, first.holds, `order ${r.order} vs ${first.order}: holds must agree`);
    }
    // Sanity: the six orders actually reach the fully-accounted-for state
    // ($50 refund + $50 dispute = the full $100), not some other coincidental
    // agreement.
    assert.equal(first.refunded_usd, 50);
    assert.equal(first.dispute_lost, 50);
    assert.equal(first.holds, 0);
    assert.equal(first.x1_pending, 0);
    assert.equal(results.length, 6);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// L-d: recovery logs "lot funding replayed" only when something was
// actually recorded.
// ═══════════════════════════════════════════════════════════════════════════

describe('[the LOW finding, L-d] replayLotFundingFromWalEntry reports `recorded` only when it actually wrote something new', () => {
  it('an origin/main-shape entry with no dollar_draws is applicable but records nothing', () => {
    const result = credits.replayLotFundingFromWalEntry({
      id: 'wal_l-d_old_shape',
      payload: { funding_source: 'credit_pack', purchaser_account_id: 'ld_buyer' }, // no dollar_draws field
      steps_completed: ['update_learnings', 'update_earnings', 'unlock_event_appended'],
    });
    assert.equal(result.applicable, true);
    assert.equal(result.already_done, false);
    assert.equal(result.recorded, false, 'L-d: nothing was recorded for this entry -- draws.length is 0');
  });

  it('an entry whose funding already landed live (the step marker was merely missing) is applicable but records nothing further', async () => {
    resetCreditsFile();
    await credits.addDollarLot('ld_landed', 'dollar_paid', 10, { stripe_payment_intent: 'pi_ld_landed' });
    const draw = await credits.deductCredit('ld_landed', 'unlock', 10);
    assert.equal(draw.success, true);
    const info = {
      learning_id: 'L1', contributor_account_id: 'ld_builder', contributor_wallet: null,
      contributor_amount: 7, platform_amount: 3, unlock_id: 'wal_ld_landed_1',
    };
    // The funding already landed live, moments before the "crash" --
    // recordLotFundingSync was already called once for this unlock id.
    credits.recordLotFundingSync('ld_landed', draw.draws, info);
    assert.equal(credits.loadCredits()['ld_landed'].dollar_lots[0].funded_unlocks.length, 1);

    // Recovery finds the WAL entry's own step marker missing (a crash
    // between the live call above and markStepComplete) and replays it --
    // but the per-unlock-id guard means nothing new is written.
    const result = credits.replayLotFundingFromWalEntry({
      // Same id the live call above used as its unlock_id -- replay must
      // recognize this WAL entry IS the one that already landed live (a
      // crash between that live write and markStepComplete leaves the
      // step marker missing, not the funding record itself).
      id: 'wal_ld_landed_1',
      payload: {
        funding_source: 'credit_pack', purchaser_account_id: 'ld_landed',
        learning_id: 'L1', contributor_account_id: 'ld_builder', builder_wallet: null,
        contributor_earned: 7, platform_earned: 3, dollar_draws: draw.draws,
      },
      steps_completed: ['update_learnings', 'update_earnings', 'unlock_event_appended'],
    });
    assert.equal(result.applicable, true);
    assert.equal(result.already_done, false);
    assert.equal(result.recorded, false, 'L-d: recordedCount stays 0 -- the per-unlock-id guard skipped every draw, nothing new was written');
    assert.equal(credits.loadCredits()['ld_landed'].dollar_lots[0].funded_unlocks.length, 1, 'still exactly one entry -- nothing duplicated');
  });

  it('a genuine crash-recovery replay (the funding record was never written) reports recorded: true', async () => {
    resetCreditsFile();
    await credits.addDollarLot('ld_crash', 'dollar_paid', 10, { stripe_payment_intent: 'pi_ld_crash' });
    const draw = await credits.deductCredit('ld_crash', 'unlock', 10);
    assert.equal(draw.success, true);

    const result = credits.replayLotFundingFromWalEntry({
      id: 'wal_ld_crash_1',
      payload: {
        funding_source: 'credit_pack', purchaser_account_id: 'ld_crash',
        learning_id: 'L1', contributor_account_id: 'ld_builder2', builder_wallet: null,
        contributor_earned: 7, platform_earned: 3, dollar_draws: draw.draws,
      },
      steps_completed: ['update_learnings', 'update_earnings', 'unlock_event_appended'],
    });
    assert.equal(result.applicable, true);
    assert.equal(result.already_done, false);
    assert.equal(result.recorded, true, 'L-d: a real, first-time recording sets recorded: true');
    assert.equal(credits.loadCredits()['ld_crash'].dollar_lots[0].funded_unlocks.length, 1);
  });

  it('a non-credit_pack (x402/router) entry is never applicable, and recorded is false', () => {
    const result = credits.replayLotFundingFromWalEntry({
      id: 'wal_ld_x402', payload: { funding_source: 'x402' }, steps_completed: [],
    });
    assert.equal(result.applicable, false);
    assert.equal(result.recorded, false);
  });

  it('an entry whose step marker already shows lot_funding_recorded is already_done and recorded is false', () => {
    const result = credits.replayLotFundingFromWalEntry({
      id: 'wal_ld_done', payload: { funding_source: 'credit_pack' }, steps_completed: ['lot_funding_recorded'],
    });
    assert.equal(result.applicable, true);
    assert.equal(result.already_done, true);
    assert.equal(result.recorded, false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// L-b: a corrupt checkout-sessions.json must never skip the webhook's
// post-credit cap check outright -- fall back to 0 pending sessions and
// still evaluate the account's recorded balance/purchases. The PRE-Checkout
// check (ruling N7) keeps its fail-closed throw by default.
// ═══════════════════════════════════════════════════════════════════════════

describe('[the LOW finding, L-b] checkBalanceCap/checkDailyCap tolerate a corrupt checkout-sessions.json only when asked to', () => {
  it('by default (the pre-Checkout path, ruling N7), a corrupt sessions file still throws -- fail closed', async () => {
    resetCreditsFile();
    await credits.addDollarLot('lb_default', 'dollar_paid', 10, {});
    fs.writeFileSync(process.env.AUXILO_CHECKOUT_SESSIONS_FILE, '{ not valid json');
    assert.throws(() => creditCaps.checkBalanceCap('lb_default', 0));
    assert.throws(() => creditCaps.checkDailyCap('lb_default', 0));
    fs.rmSync(process.env.AUXILO_CHECKOUT_SESSIONS_FILE, { force: true });
  });

  it('with tolerateMissingPendingSessions, a corrupt sessions file falls back to 0 pending and still evaluates the recorded balance', async () => {
    resetCreditsFile();
    // $2,100 recorded balance, already over the $2,000 cap on its own.
    await credits.addDollarLot('lb_tolerant', 'dollar_paid', 2100, {});
    fs.writeFileSync(process.env.AUXILO_CHECKOUT_SESSIONS_FILE, '{ still not valid json');

    const result = creditCaps.checkBalanceCap('lb_tolerant', 0, Date.now(), { tolerateMissingPendingSessions: true });
    assert.equal(result.current, 2100, 'falls back to 0 pending sessions, not a throw');
    assert.equal(result.ok, false, 'the recorded balance alone is enough to catch the overage');

    const daily = creditCaps.checkDailyCap('lb_tolerant', 0, Date.now(), { tolerateMissingPendingSessions: true });
    assert.equal(daily.ok, true, 'no purchases.jsonl history recorded for this account in this fixture -- daily cap alone is not crossed');
    fs.rmSync(process.env.AUXILO_CHECKOUT_SESSIONS_FILE, { force: true });
  });

  it('with a healthy sessions file, the tolerant path behaves identically to the default path', async () => {
    resetCreditsFile();
    await credits.addDollarLot('lb_healthy', 'dollar_paid', 10, {});
    fs.writeFileSync(process.env.AUXILO_CHECKOUT_SESSIONS_FILE, '{}');
    const a = creditCaps.checkBalanceCap('lb_healthy', 0);
    const b = creditCaps.checkBalanceCap('lb_healthy', 0, Date.now(), { tolerateMissingPendingSessions: true });
    assert.deepEqual(a, b);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// L-a: scripts/reconcile-ledgers.js measures spend from the pack itself and
// flags the classes the old script could never see.
// ═══════════════════════════════════════════════════════════════════════════

describe('[the LOW finding, L-a] reconcile-ledgers.js measures spend from the pack and flags what the old script missed', () => {
  // No assert in this helper's own body (CH-7: a helper called from an it()
  // must never itself be callable from describe scope with a silently-
  // ignored assert) -- it returns the before/after file contents so each
  // it() below asserts read-only-ness itself, in its own test body. The
  // script's read-only contract is also covered directly, once, by the
  // pre-existing R1 describe block in test/fix-unit-money-3.test.js.
  function runFixture(creditsFixture, earningsFixture = {}) {
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-l-a-'));
    try {
      fs.writeFileSync(path.join(fixtureDir, 'credits.json'), JSON.stringify(creditsFixture));
      fs.writeFileSync(path.join(fixtureDir, 'earnings.json'), JSON.stringify(earningsFixture));
      const before = {
        credits: fs.readFileSync(path.join(fixtureDir, 'credits.json'), 'utf8'),
        earnings: fs.readFileSync(path.join(fixtureDir, 'earnings.json'), 'utf8'),
      };
      const report = reconcileLedgers.reconcile(fixtureDir);
      const output = reconcileLedgers.formatReport(fixtureDir, report);
      const after = {
        credits: fs.readFileSync(path.join(fixtureDir, 'credits.json'), 'utf8'),
        earnings: fs.readFileSync(path.join(fixtureDir, 'earnings.json'), 'utf8'),
      };
      return { report, output, before, after };
    } finally {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
  }

  it("the review's own p32 fixture: pack #1 (over cap) flagged, pack #2 (healthy, large unspent remainder) NOT flagged, pack #3 (double-funded, N16/N19 class) flagged, pack #4 (a spend with no funding record) flagged", () => {
    const lot = (id, pi, orig, remaining, funded) => ({
      lot_id: id, kind: 'dollar_paid', stripe_payment_intent: pi,
      original_usd: orig, remaining_usd: remaining, funded_unlocks: funded,
      refunded_usd: 0, dispute_lost_by_id: {}, uncovered_usd: 0, inflight_usd: 0,
    });
    const share = (contributor) => ({
      contributor_account_id: 'acc_builder', contributor_amount: 7, platform_amount: 3,
      reversed: false, pending_reversal: false, ...(contributor || {}),
    });
    const creditsFixture = {
      acc_buyer: {
        dollar_lots: [
          // Pack #1: a full refund removed everything (removed_usd: 100 --
          // none of the drop in remaining_usd was an actual spend), but one
          // share was never reversed -- $10 of basis kept on $0 still
          // collected, and (correctly) $0 actually spent vs $10 recorded.
          { ...lot('lot_1', 'pi_1', 100, 0, [share()]), refunded_usd: 100, removed_usd: 100 },
          // Pack #2: healthy -- $10 actually spent, $10 recorded, $90 still
          // sits unspent in the buyer's own balance (never flagged just for
          // having a large unspent remainder).
          lot('lot_2', 'pi_2', 100, 90, [share()]),
          // Pack #3: $20 of shares recorded (two entries) for only $10
          // actually drawn from remaining_usd -- the double-funding class.
          lot('lot_3', 'pi_3', 100, 90, [share(), share()]),
          // Pack #4: $20 actually drawn from remaining_usd, but only $10 of
          // funding was ever recorded -- the N16/N19 missing-record class.
          lot('lot_4', 'pi_4', 100, 80, [share()]),
        ],
      },
    };
    const { report, output, before, after } = runFixture(creditsFixture, { acc_builder: { pending_balance: 42 } });
    assert.equal(after.credits, before.credits, 'read-only -- credits.json unchanged');
    assert.equal(after.earnings, before.earnings, 'read-only -- earnings.json unchanged');
    const [p1, p2, p3, p4] = report.packs;

    assert.equal(p1.flagged, true, 'pack #1 stays flagged (over the 70% cap)');
    assert.equal(p1.over70pct, true);
    assert.equal(p1.spendMismatch, true, 'L-a: $0 actually spent (the refund removed it) vs $10 recorded -- the orphan-share class is itself a spend/recorded mismatch');

    assert.equal(p2.flagged, false, 'pack #2 must NOT be flagged just for holding a large unspent remainder');

    assert.equal(p3.flagged, true, 'pack #3 (double-funded) is now flagged');
    assert.equal(p3.spendMismatch, true, 'L-a: spend ($10) does not match shares recorded ($20)');

    assert.equal(p4.flagged, true, 'pack #4 (missing funding record) is now flagged');
    assert.equal(p4.spendMismatch, true, 'L-a: spend ($20) does not match shares recorded ($10)');

    assert.match(output, /Packs found:\s*4/);
    assert.match(output, /Packs where money actually spent does not match shares recorded:\s*3/, 'packs #1, #3 and #4 all show a spend/recorded gap');

    // Public repo: no account id, email, wallet, or key ever appears.
    assert.doesNotMatch(output, /acc_buyer/);
    assert.doesNotMatch(output, /acc_builder/);
    assert.doesNotMatch(output, /@/, 'no email-shaped string');
    assert.doesNotMatch(output, /0x[0-9a-fA-F]{20,}/, 'no wallet-shaped string');
  });

  it('flags a lot with money still marked in flight or uncovered, and a lot with a reversal still pending', () => {
    const creditsFixture = {
      acc_buyer2: {
        dollar_lots: [
          {
            lot_id: 'lot_inflight', kind: 'dollar_paid', stripe_payment_intent: 'pi_inflight',
            original_usd: 20, remaining_usd: 0, funded_unlocks: [],
            refunded_usd: 0, dispute_lost_by_id: {}, uncovered_usd: 0, inflight_usd: 10,
          },
          {
            lot_id: 'lot_pending', kind: 'dollar_paid', stripe_payment_intent: 'pi_pending',
            original_usd: 20, remaining_usd: 10,
            funded_unlocks: [{ contributor_account_id: 'acc_b2', contributor_amount: 7, platform_amount: 3, reversed: false, pending_reversal: true }],
            refunded_usd: 10, dispute_lost_by_id: {}, uncovered_usd: 0, inflight_usd: 0,
          },
        ],
      },
    };
    const { report, output, before, after } = runFixture(creditsFixture);
    assert.equal(after.credits, before.credits, 'read-only -- credits.json unchanged');
    const [inFlightPack, pendingPack] = report.packs;
    assert.equal(inFlightPack.flagged, true);
    assert.equal(inFlightPack.inFlightOrUncovered, true);
    assert.equal(pendingPack.flagged, true);
    assert.equal(pendingPack.pendingReversalCount, 1);
    assert.match(output, /Packs with money still marked in flight or uncovered:\s*1/);
    assert.match(output, /Packs with a reversal still pending:\s*1/);
  });

  it('handles a data folder with no ledger files yet, and refuses with no data folder given (unchanged CLI contract)', () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-l-a-empty-'));
    try {
      const output = execFileSync(process.execPath, [path.join(REPO, 'scripts', 'reconcile-ledgers.js'), emptyDir], { encoding: 'utf8' });
      assert.match(output, /Packs found:\s*0/);
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
    assert.throws(() => execFileSync(process.execPath, [path.join(REPO, 'scripts', 'reconcile-ledgers.js')], { encoding: 'utf8' }));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// L-c: the unlock path's on-the-spot reversal saves earnings BEFORE marking
// a reversal done, on every path through it, the same as the webhook path
// (N15). Functional end-to-end proof through the real staged server lives
// in test/fix-unit-money-4-route.test.js; this covers the exact source
// shape of the fix, plus a deterministic proof of the underlying mechanism
// it now relies on (reverseLotFunding still reports the entry as found and
// finalizable even when it reversed nothing new).
// ═══════════════════════════════════════════════════════════════════════════

describe('[the LOW finding, L-c] the unlock path saves earnings unconditionally after an on-the-spot reversal', () => {
  it('server.js no longer guards the on-the-spot save behind `if (totalReversed > 0)`', () => {
    const source = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');
    assert.doesNotMatch(
      source,
      /if\s*\(\s*totalReversed\s*>\s*0\s*\)\s*safeWrite\(EARNINGS_FILE,\s*earnings\)/,
      'L-c: the save must never be conditioned on totalReversed -- a racing delivery can have already applied the same entry id in memory (totalReversed 0) while its own save never reached disk',
    );

    // The fixed call site: inside the unlock handler's needsReversal
    // branch, `await reverseCreditLotFunding(...)` is followed (within a
    // small window, allowing only comments between them) by an
    // UNCONDITIONAL safeWrite(EARNINGS_FILE, earnings), before
    // finalizePendingReversals runs.
    const anchor = source.indexOf('fundResult.needsReversal.length > 0');
    assert.ok(anchor > 0, 'the on-the-spot reversal branch must still exist');
    const window = source.slice(anchor, anchor + 1200);
    assert.match(window, /await reverseCreditLotFunding\(earnings, fundResult\.needsReversal\)/);
    assert.match(
      window,
      /await reverseCreditLotFunding\(earnings, fundResult\.needsReversal\);(?:\s*\/\/[^\n]*\n|\s*\n)*\s*safeWrite\(EARNINGS_FILE, earnings\);/,
      'L-c: safeWrite must run right after the reversal, unconditionally (only comments/whitespace between them)',
    );
    assert.match(window, /finalizePendingReversals\(buyerAccountId, affectedLotId\)/);
  });

  it('the underlying mechanism: reverseOneFundedUnlock reports found:true (finalizable) even when the entry\'s id was already applied and nothing new was reversed', async () => {
    const earnings = {};
    earnings['lc_builder'] = initEarningsEntry('lc_builder', null);
    earnings['lc_builder'].pending_balance = 7;
    earnings['lc_builder'].reversals = [{ id: 'fu_already_applied', amount: 7, platform_amount: 3, reason: 'dollar_lot_reversal', ts: new Date().toISOString() }];

    // A second delivery hands back the SAME entry (same id) -- exactly what
    // a racing refund/dispute delivery that already reversed it in memory
    // would produce. This must not double-subtract, but the caller (which
    // L-c fixed) must still be told there is something to durably finalize
    // and must still save -- the old, buggy `if (totalReversed > 0)` guard
    // would have skipped the save on exactly this result.
    const result = await earningsReversal.reverseOneFundedUnlock(earnings, {
      id: 'fu_already_applied', contributor_account_id: 'lc_builder', contributor_wallet: null,
      contributor_amount: 7, platform_amount: 3, learning_id: 'L1',
    });
    assert.equal(result.reversed, 0, 'nothing new to reverse -- already applied');
    assert.equal(result.found, true, 'the entry is found -- finalizePendingReversals must still run for it');
    assert.equal(result.alreadyApplied, true);
    assert.equal(earnings['lc_builder'].pending_balance, 7, 'not double-subtracted');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// W1: the single-process assumption is written down.
// ═══════════════════════════════════════════════════════════════════════════

describe('[ruling W1] README.md documents the single-process assumption', () => {
  it('has a "One machine" section stating the ledgers are single-process and a second machine/overlapping deploy must not run', () => {
    const readme = fs.readFileSync(path.join(REPO, 'README.md'), 'utf8');
    assert.match(readme, /^#{2,3} One machine$/m, 'a "One machine" heading must exist');
    const section = readme.slice(readme.indexOf('One machine'));
    assert.match(section, /\block/i, 'must say the ledgers are guarded by locks');
    assert.match(section, /\bone process\b/i, 'must say the locks are held in one process');
    assert.match(section, /\bone machine\b/i, 'must say the server runs as one machine');
    assert.match(section, /second machine|overlapping deploy/i, 'must warn against a second machine or an overlapping deploy');
  });
});
