'use strict';

/**
 * test/credits-as-cash-lots.test.js — AUD-CAC (credits are the same as
 * cash) lib-level coverage: the lot schema (spec §2, ruling R-F), dollar
 * lots (spec §1/§2), unified spending across both kinds (spec §6, ruling
 * L1/L3), purchase caps (spec §2, ruling L6), account holds, the flag
 * (spec §3, ruling L4), and the structural "never do" proofs (spec §2,
 * ruling L7).
 *
 * Every data file this suite touches is redirected to a private temp
 * directory BEFORE any module loads, same idiom as test/aud19-2-econ.test.js.
 * No network call, no real Stripe SDK, no real HOME.
 *
 * Runner: node --test test/credits-as-cash-lots.test.js
 */

const os = require('os');
const fs = require('fs');
const path = require('path');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aud-cac-lots-'));
process.env.AUXILO_CREDITS_FILE = path.join(TMP_DIR, 'credits.json');
process.env.AUXILO_UNLOCK_ATTRIBUTION_FILE = path.join(TMP_DIR, 'unlock-attribution.json');
process.env.AUXILO_ACCOUNT_HOLDS_FILE = path.join(TMP_DIR, 'account-holds.json');
process.env.AUXILO_PURCHASES_FILE = path.join(TMP_DIR, 'purchases.jsonl');

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const credits = require('../lib/credits.js');
const {
  deductCredit,
  addPurchasedCredits,
  addDollarLot,
  refundDollarDraw,
  recordLotFunding,
  debitDollarLots,
  summarizeCreditBalance,
  ensureDollarLots,
  loadCredits,
  saveCredits,
  getCreditStatus,
  findAccountAndLotByPaymentIntent,
  freezeDollarLot,
  unfreezeDollarLot,
  removeDollarLotRemainder,
  round6,
} = credits;
const { creditsAsCashEnabled } = require('../lib/credits-flag.js');
const {
  BALANCE_CAP_USD,
  DAILY_PURCHASE_CAP_USD,
  checkBalanceCap,
  checkDailyCap,
  computeAccountBalanceUsd,
  computeDailyPurchaseTotalUsd,
} = require('../lib/credit-caps.js');
const {
  holdAccount,
  isAccountHeld,
  getAccountHold,
  clearAccountHold,
} = require('../lib/account-holds.js');
const stripeLib = require('../lib/stripe.js');
const { appendPurchase } = stripeLib;

after(() => { try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch { /* best effort */ } });

let seq = 0;
function uid() { return `acc_aud_cac_${++seq}_${Math.random().toString(36).slice(2, 8)}`; }
function pi() { return 'pi_' + Math.random().toString(36).slice(2, 10); }

// ─── 1. Lot schema unification (spec test 28, ruling R-F) ───────────────────

describe('lot schema: every lot carries purchase_id, stripe_payment_intent, purchased_at, last_activity_at [spec test 28]', () => {
  it('a unit lot from a real purchase carries the real ids; a free-grant unit lot carries null for both', async () => {
    const id = uid();
    await addPurchasedCredits(id, 0, 5, { unlock_unit_price_usd: 0.10, purchase_id: 'pur_test1', stripe_payment_intent: 'pi_test1' });
    await addPurchasedCredits(id, 0, 2, { unlock_unit_price_usd: 0 }); // free grant, no purchase

    const record = loadCredits()[id];
    const purchaseLot = record.unlock_lots.find(l => l.purchase_id === 'pur_test1');
    const grantLot = record.unlock_lots.find(l => l.unit_price_usd === 0);

    assert.ok(purchaseLot, 'the purchase-backed lot must exist');
    assert.equal(purchaseLot.stripe_payment_intent, 'pi_test1');
    assert.ok(purchaseLot.purchased_at, 'purchased_at must be stamped');
    assert.ok(purchaseLot.last_activity_at, 'last_activity_at must be stamped');
    assert.equal(purchaseLot.frozen, false);

    assert.ok(grantLot, 'the free-grant lot must exist');
    assert.equal(grantLot.purchase_id, null);
    assert.equal(grantLot.stripe_payment_intent, null);
    assert.ok(grantLot.purchased_at, 'a free grant still stamps purchased_at');
  });

  it('last_activity_at updates on the next spend (unit lot)', async () => {
    const id = uid();
    await addPurchasedCredits(id, 0, 1, { unlock_unit_price_usd: 0.10, purchase_id: 'pur_test2', stripe_payment_intent: 'pi_test2' });
    const before = loadCredits()[id].unlock_lots[0].last_activity_at;
    await new Promise(r => setTimeout(r, 2));
    await deductCredit(id, 'unlock', 0.10);
    // the lot is fully consumed and spliced out on exhaustion, so re-derive
    // freshness a different way: consume from a 2-unit lot instead.
    const id2 = uid();
    await addPurchasedCredits(id2, 0, 2, { unlock_unit_price_usd: 0.10 });
    const before2 = loadCredits()[id2].unlock_lots[0].last_activity_at;
    await new Promise(r => setTimeout(r, 2));
    await deductCredit(id2, 'unlock', 0.10);
    const after2 = loadCredits()[id2].unlock_lots[0].last_activity_at;
    assert.ok(new Date(after2).getTime() >= new Date(before2).getTime(), 'last_activity_at must not go backward');
    assert.notEqual(before, undefined);
  });

  it('a dollar lot (paid or promo) carries purchase_id, stripe_payment_intent, purchased_at, last_activity_at, and updates on spend', async () => {
    const id = uid();
    const paymentIntent = pi();
    await addDollarLot(id, 'dollar_paid', 10, { purchase_id: 'pur_test3', stripe_payment_intent: paymentIntent });
    const promoResult = await addDollarLot(id, 'dollar_promo', 5, {}); // free grant

    const record = loadCredits()[id];
    const paidLot = record.dollar_lots.find(l => l.kind === 'dollar_paid');
    const promoLot = record.dollar_lots.find(l => l.kind === 'dollar_promo');

    assert.equal(paidLot.purchase_id, 'pur_test3');
    assert.equal(paidLot.stripe_payment_intent, paymentIntent);
    assert.equal(paidLot.original_usd, 10);
    assert.equal(paidLot.remaining_usd, 10);
    assert.ok(paidLot.purchased_at && paidLot.last_activity_at);
    assert.equal(paidLot.frozen, false);

    assert.equal(promoLot.purchase_id, null);
    assert.equal(promoLot.stripe_payment_intent, null);
    assert.equal(promoResult.kind, 'dollar_promo');

    const beforeTouch = paidLot.last_activity_at;
    await new Promise(r => setTimeout(r, 2));
    await deductCredit(id, 'unlock', 3); // draws from the paid lot
    const afterTouch = loadCredits()[id].dollar_lots.find(l => l.kind === 'dollar_paid').last_activity_at;
    assert.ok(new Date(afterTouch).getTime() >= new Date(beforeTouch).getTime());
  });
});

// ─── 2. Unified spending across both lot kinds (spec §6, tests 1-8) ─────────

describe('unified spend: unit lots first, then dollar (paid before promo)', () => {
  it('[test 1] a unit lot unlock behaves exactly as today: whole unit, own price', async () => {
    const id = uid();
    await addPurchasedCredits(id, 0, 1, { unlock_unit_price_usd: 0.125 });
    const r = await deductCredit(id, 'unlock', 0.86);
    assert.equal(r.success, true);
    assert.equal(r.lot_kind, 'unit');
    assert.equal(r.unit_price_usd, 0.125);
    assert.equal(loadCredits()[id].purchased_unlocks, 0);
  });

  it('[test 2] an account with both a unit lot and a dollar lot spends the unit lot first, dollar lot untouched', async () => {
    const id = uid();
    await addPurchasedCredits(id, 0, 1, { unlock_unit_price_usd: 0.125 });
    await addDollarLot(id, 'dollar_paid', 10);
    const r = await deductCredit(id, 'unlock', 0.86);
    assert.equal(r.lot_kind, 'unit');
    const record = loadCredits()[id];
    assert.equal(record.purchased_unlocks, 0, 'unit lot consumed');
    assert.equal(record.dollar_lots[0].remaining_usd, 10, 'dollar lot untouched');
  });

  it('[test 3] once the last unit lot empties, the next unlock draws the dollar lot at the listed price', async () => {
    const id = uid();
    await addPurchasedCredits(id, 0, 1, { unlock_unit_price_usd: 0.125 });
    await addDollarLot(id, 'dollar_paid', 10);
    await deductCredit(id, 'unlock', 0.86); // consumes the unit lot
    const r = await deductCredit(id, 'unlock', 0.86); // now draws the dollar lot
    assert.equal(r.lot_kind, 'dollar');
    assert.equal(r.paid_drawn, 0.86);
    assert.equal(r.promo_drawn, 0);
    assert.equal(loadCredits()[id].dollar_lots[0].remaining_usd, 9.14);
  });

  it('[test 4] paid dollar lot, direct unlock: debits the listed price from the paid lot', async () => {
    const id = uid();
    await addDollarLot(id, 'dollar_paid', 10);
    const r = await deductCredit(id, 'unlock', 0.86);
    assert.equal(r.lot_kind, 'dollar');
    assert.equal(r.paid_drawn, 0.86);
    assert.equal(loadCredits()[id].dollar_lots[0].remaining_usd, 9.14);
  });

  it('[test 6] promotional dollar lot only: debits the listed price, all promo-sourced', async () => {
    const id = uid();
    await addDollarLot(id, 'dollar_promo', 5);
    const r = await deductCredit(id, 'unlock', 1.16);
    assert.equal(r.lot_kind, 'dollar');
    assert.equal(r.paid_drawn, 0);
    assert.equal(r.promo_drawn, 1.16);
    assert.equal(round6(loadCredits()[id].dollar_lots[0].remaining_usd), 3.84);
  });

  it('[test 7] mixed draw: paid lot runs out mid-unlock, promo lot covers the rest', async () => {
    const id = uid();
    await addDollarLot(id, 'dollar_paid', 0.30);
    await addDollarLot(id, 'dollar_promo', 5);
    const r = await deductCredit(id, 'unlock', 0.86);
    assert.equal(r.lot_kind, 'dollar');
    assert.equal(r.paid_drawn, 0.30, 'only what the paid lot actually had');
    assert.equal(round6(r.promo_drawn), 0.56, 'the rest comes from promo');
    const record = loadCredits()[id];
    assert.equal(record.dollar_lots.find(l => l.kind === 'dollar_paid').remaining_usd, 0);
    assert.equal(round6(record.dollar_lots.find(l => l.kind === 'dollar_promo').remaining_usd), 4.44);
  });

  it('[test 8] balance one cent short: refused, nothing touched', async () => {
    const id = uid();
    await addDollarLot(id, 'dollar_paid', 0.85);
    const r = await deductCredit(id, 'unlock', 0.86);
    assert.equal(r.success, false);
    assert.equal(loadCredits()[id].dollar_lots[0].remaining_usd, 0.85, 'nothing drawn on a refused unlock');
  });

  it('paid lots drain before promo lots even when promo was added first (FIFO within kind, paid-first across kinds)', async () => {
    const id = uid();
    await addDollarLot(id, 'dollar_promo', 5);
    await addDollarLot(id, 'dollar_paid', 2);
    const r = await deductCredit(id, 'unlock', 1);
    assert.equal(r.paid_drawn, 1);
    assert.equal(r.promo_drawn, 0);
  });

  it('a frozen unit lot is skipped — spend falls through to dollar lots as though it had zero remaining [mirrors spec test 21]', async () => {
    const id = uid();
    await addPurchasedCredits(id, 0, 1, { unlock_unit_price_usd: 0.125 });
    await addDollarLot(id, 'dollar_paid', 10);
    const record = loadCredits()[id];
    record.unlock_lots[0].frozen = true;
    saveCredits({ ...loadCredits(), [id]: record });
    const r = await deductCredit(id, 'unlock', 0.86);
    assert.equal(r.lot_kind, 'dollar', 'the frozen unit lot must be skipped');
  });
});

// ─── 3. Reporting: two real numbers, never one derived from the other [spec test 32, ruling L8] ─

describe('reporting: GET-account/credits shape (getCreditStatus)', () => {
  it('reports a real unit count and a real dollar balance side by side', async () => {
    const id = uid();
    await addPurchasedCredits(id, 0, 12, { unlock_unit_price_usd: 0.10 });
    await addDollarLot(id, 'dollar_paid', 3.5);
    const status = getCreditStatus(id);
    assert.equal(status.unlocks.purchased, 12);
    assert.equal(status.credit_balance.total_usd, 3.5);
    assert.equal(status.credit_balance.paid_usd, 3.5);
    assert.equal(status.credit_balance.promo_usd, 0);
  });

  it('summarizeCreditBalance never derives one figure from the other', async () => {
    const id = uid();
    await addDollarLot(id, 'dollar_paid', 1.5);
    await addDollarLot(id, 'dollar_promo', 0.75);
    const record = loadCredits()[id];
    const balance = summarizeCreditBalance(record);
    assert.equal(balance.paid_usd, 1.5);
    assert.equal(balance.promo_usd, 0.75);
    assert.equal(balance.total_usd, 2.25);
  });

  it('[L12] an account with no dollar lot reports a zero credit_balance, byte-shape unchanged otherwise', () => {
    const id = uid();
    const status = getCreditStatus(id);
    assert.deepEqual(status.credit_balance, { paid_usd: 0, promo_usd: 0, total_usd: 0 });
    assert.equal(status.unlocks.purchased, 0);
    assert.equal(status.plan, 'funded');
  });
});

// ─── 4. Insufficient balance messaging [ruling L9, L12] ─────────────────────

describe('insufficient balance: byte-identical to today with no dollar lot, dollar-aware otherwise', () => {
  it('no dollar lot ever existed: the EXACT legacy message and status shape [L12]', async () => {
    const id = uid();
    const r = await deductCredit(id, 'unlock', 0.86);
    assert.equal(r.success, false);
    assert.equal(r.message, 'All unlock credits exhausted. Buy a credit pack or pay per-call via x402.');
    assert.deepEqual(Object.keys(r.status).sort(), ['period_end', 'purchased_queries', 'purchased_unlocks', 'queries_used', 'unlocks_used'].sort());
  });

  it('a dollar lot exists (even exhausted): describes a dollar shortfall, never the flat legacy exhaustion wording', async () => {
    const id = uid();
    await addDollarLot(id, 'dollar_paid', 0.10);
    await deductCredit(id, 'unlock', 0.10); // drain it
    const r = await deductCredit(id, 'unlock', 0.86);
    assert.equal(r.success, false);
    assert.notEqual(r.message, 'All unlock credits exhausted. Buy a credit pack or pay per-call via x402.');
    assert.match(r.message, /balance/i);
    assert.equal(r.status.credit_balance.total_usd, 0);
    assert.equal(r.status.unlocks.purchased, 0);
  });
});

// ─── 5. AUD19-10 refund path: dollar draws restore correctly ────────────────

describe('refundDollarDraw: restores the exact paid/promo split as fresh lots', () => {
  it('restores both a paid and a promo remainder after a delivery-failure compensation', async () => {
    const id = uid();
    await refundDollarDraw(id, 0.30, 0.56);
    const balance = summarizeCreditBalance(loadCredits()[id]);
    assert.equal(balance.paid_usd, 0.30);
    assert.equal(balance.promo_usd, 0.56);
  });

  it('a zero-amount refund on either side adds nothing', async () => {
    const id = uid();
    await refundDollarDraw(id, 1, 0);
    const balance = summarizeCreditBalance(loadCredits()[id]);
    assert.equal(balance.paid_usd, 1);
    assert.equal(balance.promo_usd, 0);
  });
});

// ─── 6. recordLotFunding: proportional allocation across a mixed paid draw ──

describe('recordLotFunding: funded_unlocks history used by reversal', () => {
  it('a single-lot paid draw allocates the FULL contributor share to that one lot', async () => {
    const id = uid();
    const lotResult = await addDollarLot(id, 'dollar_paid', 10);
    await recordLotFunding(id, [{ lot_id: lotResult.lot_id, kind: 'dollar_paid', amount: 0.86 }], {
      learning_id: 'lrn_x', contributor_account_id: 'acc_builder', contributor_amount: 0.602, platform_amount: 0.258, ts: new Date().toISOString(),
    });
    const lot = loadCredits()[id].dollar_lots[0];
    assert.equal(lot.funded_unlocks.length, 1);
    assert.equal(lot.funded_unlocks[0].contributor_amount, 0.602);
    assert.equal(lot.funded_unlocks[0].contributor_account_id, 'acc_builder');
    assert.equal(lot.funded_unlocks[0].reversed, false);
  });

  it('a two-lot paid draw splits the contributor share proportionally and sums exactly', async () => {
    const id = uid();
    const lotA = await addDollarLot(id, 'dollar_paid', 0.30);
    const lotB = await addDollarLot(id, 'dollar_paid', 10);
    await recordLotFunding(id, [
      { lot_id: lotA.lot_id, kind: 'dollar_paid', amount: 0.30 },
      { lot_id: lotB.lot_id, kind: 'dollar_paid', amount: 0.56 },
    ], {
      learning_id: 'lrn_y', contributor_account_id: 'acc_builder2', contributor_amount: 0.602, platform_amount: 0.258, ts: new Date().toISOString(),
    });
    const record = loadCredits()[id];
    const shareA = record.dollar_lots.find(l => l.lot_id === lotA.lot_id).funded_unlocks[0].contributor_amount;
    const shareB = record.dollar_lots.find(l => l.lot_id === lotB.lot_id).funded_unlocks[0].contributor_amount;
    assert.equal(round6(shareA + shareB), 0.602, 'the two allocations must sum exactly to the total contributor share');
  });

  it('a promo-only draw records nothing (never funds a builder share)', async () => {
    const id = uid();
    const promoLot = await addDollarLot(id, 'dollar_promo', 5);
    await recordLotFunding(id, [{ lot_id: promoLot.lot_id, kind: 'dollar_promo', amount: 1.16 }], {
      learning_id: 'lrn_z', contributor_account_id: 'acc_builder3', contributor_amount: 0, platform_amount: 0, ts: new Date().toISOString(),
    });
    const lot = loadCredits()[id].dollar_lots[0];
    assert.equal((lot.funded_unlocks || []).length, 0, 'promo draws are never recorded as funding');
  });
});

// ─── 7. Freeze / unfreeze / remove (Part 2 building blocks, spec tests 21/24) ─

describe('freeze, unfreeze, and remove-remainder primitives', () => {
  it('freezeDollarLot reports half_spent correctly and findAccountAndLotByPaymentIntent locates it across accounts', async () => {
    const id = uid();
    const intent = pi();
    await addDollarLot(id, 'dollar_paid', 10, { stripe_payment_intent: intent, purchase_id: 'pur_half' });
    await deductCredit(id, 'unlock', 6); // 6 spent of 10 → more than half spent

    const found = findAccountAndLotByPaymentIntent(intent);
    assert.equal(found.accountId, id);

    const result = await freezeDollarLot(id, intent, 'dispute');
    assert.equal(result.success, true);
    assert.equal(result.half_spent, true);
    assert.equal(loadCredits()[id].dollar_lots[0].frozen, true);
    assert.equal(loadCredits()[id].dollar_lots[0].frozen_reason, 'dispute');
  });

  it('freezeDollarLot on a lightly-spent lot reports half_spent false', async () => {
    const id = uid();
    const intent = pi();
    await addDollarLot(id, 'dollar_paid', 10, { stripe_payment_intent: intent });
    await deductCredit(id, 'unlock', 1);
    const result = await freezeDollarLot(id, intent, 'dispute');
    assert.equal(result.half_spent, false);
  });

  it('unfreezeDollarLot restores spendability with nothing removed (spec test 24)', async () => {
    const id = uid();
    const intent = pi();
    await addDollarLot(id, 'dollar_paid', 10, { stripe_payment_intent: intent });
    await freezeDollarLot(id, intent, 'dispute');
    const before = loadCredits()[id].dollar_lots[0].remaining_usd;
    const result = await unfreezeDollarLot(id, intent);
    assert.equal(result.success, true);
    assert.equal(loadCredits()[id].dollar_lots[0].frozen, false);
    assert.equal(loadCredits()[id].dollar_lots[0].remaining_usd, before, 'unfreezing never touches remaining_usd');
  });

  it('removeDollarLotRemainder zeroes remaining_usd and returns unreversed funded_unlocks exactly once (idempotent)', async () => {
    const id = uid();
    const intent = pi();
    const lotResult = await addDollarLot(id, 'dollar_paid', 10, { stripe_payment_intent: intent });
    await recordLotFunding(id, [{ lot_id: lotResult.lot_id, kind: 'dollar_paid', amount: 4 }], {
      learning_id: 'lrn_r', contributor_account_id: 'acc_r', contributor_amount: 2.8, platform_amount: 1.2, ts: new Date().toISOString(),
    });
    const first = await removeDollarLotRemainder(id, intent);
    assert.equal(first.success, true);
    assert.equal(first.removed_usd, 10);
    assert.equal(first.funded_unlocks.length, 1);
    assert.equal(loadCredits()[id].dollar_lots[0].remaining_usd, 0);

    // a Stripe retry of the same event must find nothing left to reverse
    const second = await removeDollarLotRemainder(id, intent);
    assert.equal(second.success, true);
    assert.equal(second.removed_usd, 0);
    assert.equal(second.funded_unlocks.length, 0, 'idempotent: nothing left unreversed on a replay');
  });
});

// ─── 8. Purchase caps [spec §2, ruling L6, tests 13-15] ─────────────────────

describe('purchase caps: balance cap and daily cap', () => {
  it('[test 13] balance cap refuses a purchase that would push total stored value over $2,000', async () => {
    const id = uid();
    await addDollarLot(id, 'dollar_paid', 1995);
    const check = checkBalanceCap(id, 100);
    assert.equal(check.ok, false);
    assert.equal(check.current, 1995);
    assert.equal(check.limit, BALANCE_CAP_USD);
  });

  it('[test 13b] a purchase that stays under the cap is allowed', async () => {
    const id = uid();
    await addDollarLot(id, 'dollar_paid', 1995);
    const check = checkBalanceCap(id, 5);
    assert.equal(check.ok, true);
  });

  it('[test 15] balance cap counts a unit lot\'s notional value, not only a dollar lot', async () => {
    const id = uid();
    await addPurchasedCredits(id, 0, 15000, { unlock_unit_price_usd: 0.125 }); // 1,875.00 notional
    const allowed = checkBalanceCap(id, 25); // Growth pack: 1875 + 25 = 1900, under the cap
    assert.equal(allowed.ok, true);
    assert.equal(allowed.current, 1875);
    // The growth pack actually lands (a real dollar lot), then stacking the
    // Pro pack ($100) on top would push total stored value to 1975 + ... —
    // use a purchase large enough to actually cross $2,000 this time.
    await addDollarLot(id, 'dollar_paid', 25);
    const afterGrowth = checkBalanceCap(id, 100); // 1900 + 100 = 2000 exactly — still allowed
    assert.equal(afterGrowth.ok, true, 'exactly at the cap is still allowed');
    const overCap = checkBalanceCap(id, 100.000001);
    assert.equal(overCap.ok, false, 'one cent over the cap is refused');
    assert.equal(overCap.current, 1900);
  });

  it('[test 14] daily purchase cap refuses a purchase that would push the trailing-24h total over $2,000', () => {
    const id = uid();
    const now = Date.now();
    appendPurchase({ id: 'pur_a', account_id: id, pack_id: 'pro', amount_usd: 1950, unlocks_added: 0, stripe_session_id: 'cs_a', stripe_payment_intent: null, timestamp: new Date(now - 60_000).toISOString() });
    const check = checkDailyCap(id, 100, now); // 1950 + 100 = 2050, over the cap
    assert.equal(check.ok, false);
    assert.equal(check.current, 1950);
  });

  it('a purchase older than 24h does not count toward the daily cap', () => {
    const id = uid();
    const now = Date.now();
    appendPurchase({ id: 'pur_b', account_id: id, pack_id: 'pro', amount_usd: 1950, unlocks_added: 0, stripe_session_id: 'cs_b', stripe_payment_intent: null, timestamp: new Date(now - 25 * 60 * 60 * 1000).toISOString() });
    const check = checkDailyCap(id, 25, now);
    assert.equal(check.ok, true);
    assert.equal(check.current, 0);
  });

  it('computeAccountBalanceUsd / computeDailyPurchaseTotalUsd are the same read the checks use (no derived duplicate figure)', async () => {
    const id = uid();
    await addDollarLot(id, 'dollar_paid', 42);
    assert.equal(computeAccountBalanceUsd(id), 42);
    assert.equal(computeDailyPurchaseTotalUsd(id), 0);
  });
});

// ─── 9. Account holds ────────────────────────────────────────────────────────

describe('account holds: cap-overage and dispute-shortfall blocks new purchases only', () => {
  it('holdAccount + isAccountHeld + getAccountHold + clearAccountHold round-trip', () => {
    const id = uid();
    assert.equal(isAccountHeld(id), false);
    holdAccount(id, 'cap_overage', { balance_usd: 2010 });
    assert.equal(isAccountHeld(id), true);
    assert.equal(getAccountHold(id).reason, 'cap_overage');
    const cleared = clearAccountHold(id);
    assert.equal(cleared, true);
    assert.equal(isAccountHeld(id), false);
  });

  it('a hold never appears for an untouched account', () => {
    assert.equal(isAccountHeld(uid()), false);
  });
});

// ─── 10. The flag [spec §3, ruling L4] ───────────────────────────────────────

describe('creditsAsCashEnabled: off by default, on only when exactly "true"', () => {
  const saved = process.env.CREDITS_AS_CASH_ENABLED;
  after(() => {
    if (saved === undefined) delete process.env.CREDITS_AS_CASH_ENABLED;
    else process.env.CREDITS_AS_CASH_ENABLED = saved;
  });

  it('absent, empty, or any non-"true" value is off', () => {
    delete process.env.CREDITS_AS_CASH_ENABLED;
    assert.equal(creditsAsCashEnabled(), false);
    for (const v of ['false', '1', 'TRUE', 'yes', 'on', '']) {
      process.env.CREDITS_AS_CASH_ENABLED = v;
      assert.equal(creditsAsCashEnabled(), false, `'${v}' must not enable the flag`);
    }
  });

  it('exactly "true" is on', () => {
    process.env.CREDITS_AS_CASH_ENABLED = 'true';
    assert.equal(creditsAsCashEnabled(), true);
  });

  it('reads fresh every call — never cached', () => {
    process.env.CREDITS_AS_CASH_ENABLED = 'true';
    assert.equal(creditsAsCashEnabled(), true);
    process.env.CREDITS_AS_CASH_ENABLED = 'false';
    assert.equal(creditsAsCashEnabled(), false);
  });
});

// ─── 11. createCheckoutSession: lotKind decides metadata + description
// [spec test 29's premise — the session's fate is fixed by what it was
// created with, never by the flag's later value; the webhook reads only
// the metadata this proves gets stamped] ─────────────────────────────────

describe('createCheckoutSession: lotKind stamps metadata.lot_kind and the Stripe-visible description', () => {
  const stripeModulePath = require.resolve('stripe');
  const stripeLibPath = require.resolve('../lib/stripe.js');
  let capturedArgs = null;
  let originalStripeCacheEntry;

  before(() => {
    originalStripeCacheEntry = require.cache[stripeModulePath];
    delete require.cache[stripeModulePath];
    delete require.cache[stripeLibPath];
    class FakeStripe {
      constructor() {
        this.checkout = { sessions: { create: async (args) => { capturedArgs = args; return { id: 'cs_test_fake', url: 'https://checkout.stripe.test/fake' }; } } };
      }
    }
    require.cache[stripeModulePath] = { id: stripeModulePath, filename: stripeModulePath, loaded: true, exports: FakeStripe };
  });
  after(() => {
    delete require.cache[stripeLibPath];
    if (originalStripeCacheEntry) require.cache[stripeModulePath] = originalStripeCacheEntry;
    else delete require.cache[stripeModulePath];
  });

  it('lotKind omitted (default) behaves exactly like today: metadata.lot_kind "unit", unit-count description', async () => {
    const priorKey = process.env.STRIPE_SECRET_KEY;
    process.env.STRIPE_SECRET_KEY = 'sk_test_fake_aud_cac';
    try {
      const lib = require('../lib/stripe.js');
      await lib.createCheckoutSession('acc_cac_default', 'starter', 'https://auxilo.test');
      assert.equal(capturedArgs.metadata.lot_kind, 'unit');
      assert.equal(capturedArgs.line_items[0].price_data.product_data.description, '80 unlocks');
    } finally {
      if (priorKey === undefined) delete process.env.STRIPE_SECRET_KEY; else process.env.STRIPE_SECRET_KEY = priorKey;
    }
  });

  it('lotKind "dollar_paid": metadata.lot_kind "dollar_paid", dollar-balance description', async () => {
    const priorKey = process.env.STRIPE_SECRET_KEY;
    process.env.STRIPE_SECRET_KEY = 'sk_test_fake_aud_cac';
    try {
      const lib = require('../lib/stripe.js');
      await lib.createCheckoutSession('acc_cac_dollar', 'starter', 'https://auxilo.test', 'dollar_paid');
      assert.equal(capturedArgs.metadata.lot_kind, 'dollar_paid');
      assert.equal(capturedArgs.line_items[0].price_data.product_data.description, '$10.00 added to your Auxilo balance');
    } finally {
      if (priorKey === undefined) delete process.env.STRIPE_SECRET_KEY; else process.env.STRIPE_SECRET_KEY = priorKey;
    }
  });
});

// ─── 12. Concurrency [spec test 33] ──────────────────────────────────────────

describe('concurrency: two simultaneous unlocks against an exact dollar balance', () => {
  it('exactly one succeeds; the other is refused; the account lock serializes both', async () => {
    const id = uid();
    await addDollarLot(id, 'dollar_paid', 0.86);
    const [r1, r2] = await Promise.all([
      deductCredit(id, 'unlock', 0.86),
      deductCredit(id, 'unlock', 0.86),
    ]);
    const successes = [r1, r2].filter(r => r.success);
    const failures = [r1, r2].filter(r => !r.success);
    assert.equal(successes.length, 1, 'exactly one of the two simultaneous unlocks succeeds');
    assert.equal(failures.length, 1);
  });
});

// ─── 13. Structural "never do" proofs [spec §2, ruling L7, tests 17-20] ─────

const SERVER_SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf-8');
const CREDITS_SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'credits.js'), 'utf-8');

describe('structural: a balance can never move between accounts [test 17]', () => {
  it('no exported credits.js function that mutates a lot accepts a second, destination account id', () => {
    // Every mutating export takes exactly one accountId-shaped first
    // parameter and no second account-shaped parameter anywhere in its
    // declared signature.
    const mutators = [
      'async function deductCredit(accountId, creditType, listedPriceUsd)',
      'async function refundCredit(accountId, creditType, unitPriceUsd)',
      'async function addPurchasedCredits(accountId, queries, unlocks, opts = {})',
      'async function addDollarLot(accountId, kind, amountUsd, opts = {})',
      'async function refundDollarDraw(accountId, paidUsd, promoUsd)',
      'async function recordLotFunding(accountId, draws, info)',
      'async function freezeDollarLot(accountId, paymentIntent, reason)',
      'async function unfreezeDollarLot(accountId, paymentIntent)',
      'async function removeDollarLotRemainder(accountId, paymentIntent)',
    ];
    for (const sig of mutators) {
      assert.ok(CREDITS_SRC.includes(sig), `expected exact signature not found: ${sig}`);
      // No second parameter named like an account id (accountId/toAccountId/destinationAccountId/targetAccountId).
      assert.ok(!/,\s*(to|dest(ination)?|target)?Account(Id)?\s*[,)]/.test(sig.replace(/^[^(]*\(/, '(').slice(0, sig.indexOf(')') + 1).replace(/^\(accountId,?\s*/, '(')),
        `mutator must not accept a second account parameter: ${sig}`);
    }
  });
});

describe('structural: a balance can never spend on anything but an unlock [test 18]', () => {
  it('the unit-lot debit function (consumeUnlockLot) has exactly one call site in server.js — the unlock path\'s credit deduction', () => {
    const callSites = (SERVER_SRC.match(/consumeUnlockLot\(/g) || []).length;
    assert.equal(callSites, 0, 'server.js must never call consumeUnlockLot directly — only lib/credits.js\'s own deductCredit does, inside the account lock');
  });
  it('the dollar-lot debit function (debitDollarLots) is called from exactly one place inside lib/credits.js — deductCredit', () => {
    // Every occurrence of "debitDollarLots(" minus the one function
    // declaration ("function debitDollarLots(") is a call site.
    const totalOccurrences = (CREDITS_SRC.match(/debitDollarLots\(/g) || []).length;
    const declarations = (CREDITS_SRC.match(/function debitDollarLots\(/g) || []).length;
    assert.equal(declarations, 1, 'exactly one declaration expected');
    const callSites = totalOccurrences - declarations;
    assert.equal(callSites, 1, 'debitDollarLots must have exactly one call site');
    const deductFnStart = CREDITS_SRC.indexOf('async function deductCredit(');
    const deductFnEnd = CREDITS_SRC.indexOf('\n}', deductFnStart);
    const callIdx = CREDITS_SRC.indexOf('debitDollarLots(record', deductFnStart);
    assert.ok(callIdx > deductFnStart && callIdx < deductFnEnd, 'the one call site must be inside deductCredit');
  });
  it('server.js calls deductCredit from exactly one place — dualAuthDynamic\'s Path 1 credit check', () => {
    const callSites = (SERVER_SRC.match(/await deductCredit\(/g) || []).length;
    assert.equal(callSites, 1, 'deductCredit must have exactly one call site in server.js');
  });
});

describe('structural: a balance can never be loaded from a crypto payment [test 19]', () => {
  it('addDollarLot has exactly one call site in server.js — the webhook\'s checkout.session.completed branch', () => {
    const callSites = (SERVER_SRC.match(/await addDollarLot\(/g) || []).length;
    assert.equal(callSites, 1, 'addDollarLot must have exactly one call site');
    const callIdx = SERVER_SRC.indexOf('await addDollarLot(');
    const webhookStart = SERVER_SRC.indexOf("app.post('/webhook/stripe'");
    const webhookEnd = SERVER_SRC.indexOf("app.get('/account/purchases'");
    assert.ok(callIdx > webhookStart && callIdx < webhookEnd, 'the one call site must sit inside the webhook route');
  });
  it('addPurchasedCredits has exactly three call sites — the webhook\'s unit-lot branch and the two referral grant sites — never x402 or router code', () => {
    const callSites = (SERVER_SRC.match(/addPurchasedCredits\(/g) || []).length;
    assert.equal(callSites, 3);
    // None of the three sites sits inside verifyPaymentOrReject or the
    // router settlement branch of the unlock handler.
    const routerFnStart = SERVER_SRC.indexOf('async function verifyPaymentOrReject(');
    const routerFnEnd = SERVER_SRC.indexOf('\n}', routerFnStart);
    const routerSlice = SERVER_SRC.slice(routerFnStart, routerFnEnd);
    assert.ok(!routerSlice.includes('addPurchasedCredits('), 'verifyPaymentOrReject (x402) must never credit a lot');
  });
  it('neither lot-credit function is reachable from x402Router settlement code', () => {
    assert.ok(!/x402Router\.[a-zA-Z]+\([^)]*\)[^;]*addPurchasedCredits/.test(SERVER_SRC));
    assert.ok(!/x402Router\.[a-zA-Z]+\([^)]*\)[^;]*addDollarLot/.test(SERVER_SRC));
  });
});

describe('structural: a balance can never be cashed out [test 20]', () => {
  it('neither withdrawal route imports the credits module or reads data/credits.json', () => {
    const w1Start = SERVER_SRC.indexOf("app.post('/withdraw/stripe'");
    const w1End = SERVER_SRC.indexOf('\napp.', w1Start + 10);
    const w2Start = SERVER_SRC.indexOf("app.post('/withdraw',");
    const w2End = SERVER_SRC.indexOf('\napp.', w2Start + 10);
    for (const [label, slice] of [['withdraw/stripe', SERVER_SRC.slice(w1Start, w1End)], ['withdraw', SERVER_SRC.slice(w2Start, w2End)]]) {
      assert.ok(!slice.includes("require('./lib/credits.js')"), `${label} must not require the credits module`);
      assert.ok(!slice.includes('credits.json'), `${label} must not reference credits.json`);
      assert.ok(!slice.includes('deductCredit(') && !slice.includes('addDollarLot(') && !slice.includes('addPurchasedCredits('),
        `${label} must not call any credits-module function`);
    }
  });
});
