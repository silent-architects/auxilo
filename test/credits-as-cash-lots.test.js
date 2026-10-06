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
fs.writeFileSync(process.env.AUXILO_PURCHASES_FILE, '');

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const credits = require('../lib/credits.js');
const {
  deductCredit,
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
  finalizePendingReversals,
  stampDisputeStatus,
  round6,
} = credits;
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

// RETIRED (credits-as-cash follow-up, SITE-PM 2026-09-27): two tests pinned
// unit-lot provenance stamping via addPurchasedCredits (deleted — pins a
// model the product no longer has). Reasons:
//   - 'a unit lot from a real purchase carries the real ids; a free-grant
//     unit lot carries null for both' — called addPurchasedCredits, which
//     created a unit lot; no code path creates a unit lot anymore.
//   - 'last_activity_at updates on the next spend (unit lot)' — same.
// Dollar-lot provenance (the only lot kind left) is proved below and is
// unaffected by this build.
describe('lot schema: every lot carries purchase_id, stripe_payment_intent, purchased_at, last_activity_at [spec test 28]', () => {
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

// RETIRED (credits-as-cash follow-up, SITE-PM 2026-09-27): four tests pinned
// the retired unit-lot-before-dollar-lot spending order:
//   - '[test 1] a unit lot unlock behaves exactly as today: whole unit, own
//     price' — spent a unit lot via addPurchasedCredits/deductCredit; no
//     unit lot spend path exists anymore.
//   - '[test 2] an account with both a unit lot and a dollar lot spends the
//     unit lot first, dollar lot untouched' — same; there is one balance.
//   - '[test 3] once the last unit lot empties, the next unlock draws the
//     dollar lot at the listed price' — same; every unlock draws the
//     dollar balance directly, there is no unit lot to empty first.
//   - 'a frozen unit lot is skipped — spend falls through to dollar lots as
//     though it had zero remaining' — froze a unit lot to prove a fallback
//     order that no longer exists.
// Dollar-only spending (tests 4/6/7/8 and the paid-before-promo FIFO test)
// is unaffected by this build and stays below, unchanged except that
// deductCredit no longer returns a lot_kind field (there is one kind left).
describe('unified spend: dollar lots, paid before promo', () => {
  it('[test 4] paid dollar lot, direct unlock: debits the listed price from the paid lot', async () => {
    const id = uid();
    await addDollarLot(id, 'dollar_paid', 10);
    const r = await deductCredit(id, 'unlock', 0.86);
    assert.equal(r.success, true);
    assert.equal(r.paid_drawn, 0.86);
    assert.equal(loadCredits()[id].dollar_lots[0].remaining_usd, 9.14);
  });

  it('[test 6] promotional dollar lot only: debits the listed price, all promo-sourced', async () => {
    const id = uid();
    await addDollarLot(id, 'dollar_promo', 5);
    const r = await deductCredit(id, 'unlock', 1.16);
    assert.equal(r.success, true);
    assert.equal(r.paid_drawn, 0);
    assert.equal(r.promo_drawn, 1.16);
    assert.equal(round6(loadCredits()[id].dollar_lots[0].remaining_usd), 3.84);
  });

  it('[test 7] mixed draw: paid lot runs out mid-unlock, promo lot covers the rest', async () => {
    const id = uid();
    await addDollarLot(id, 'dollar_paid', 0.30);
    await addDollarLot(id, 'dollar_promo', 5);
    const r = await deductCredit(id, 'unlock', 0.86);
    assert.equal(r.success, true);
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
});

// ─── 3. Reporting: two real numbers, never one derived from the other [spec test 32, ruling L8] ─

// RETIRED (credits-as-cash follow-up, SITE-PM 2026-09-27): 'reports a real
// unit count and a real dollar balance side by side' called addPurchasedCredits
// and asserted status.unlocks.purchased — the unlocks field is gone from
// GET /account/credits (F-7); '[L12] an account with no dollar lot reports a
// zero credit_balance, byte-shape unchanged otherwise' pinned ruling L12's
// switch-off byte-identical promise, itself retired with the switch. Fresh
// coverage of the dollar-only shape is in test/credits-one-balance.test.js.
describe('reporting: GET-account/credits shape (getCreditStatus)', () => {
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
});

// ─── 4. Insufficient balance messaging ──────────────────────────────────────
//
// RETIRED (credits-as-cash follow-up): both tests here pinned ruling L12's
// two-shape promise (a legacy exhaustion message and status when no dollar
// lot ever existed, a dollar-aware one otherwise) — that promise existed
// only to keep the switch-off state byte-identical to the pre-cash product.
// There is one model now: every insufficient-balance response describes a
// dollar shortfall. Fresh coverage is in test/credits-one-balance.test.js.
describe('insufficient balance: one shape, always a dollar shortfall', () => {
  it('describes the dollar shortfall and the account\'s real balance', async () => {
    const id = uid();
    const r = await deductCredit(id, 'unlock', 0.86);
    assert.equal(r.success, false);
    assert.match(r.message, /Insufficient balance/);
    assert.match(r.message, /x402/);
    assert.deepEqual(Object.keys(r.status).sort(), ['credit_balance', 'period_end'].sort());
    // L3: frozen_usd is now reported alongside the other three figures.
    assert.deepEqual(r.status.credit_balance, { paid_usd: 0, promo_usd: 0, total_usd: 0, frozen_usd: 0 });
  });
});

// ─── 5. AUD19-10 refund path: dollar draws restore correctly ────────────────

// FIX-UNIT-MONEY M1: refundDollarDraw no longer pushes fresh lots -- it
// restores the exact amounts drawn back onto the SAME lots they came from
// (the `draws` array debitDollarLots returned for the original debit), and
// skips any draw whose lot a refund has since removed.
describe('refundDollarDraw: restores drawn amounts onto the SAME lots (ruling M1)', () => {
  it('restores both a paid and a promo draw back onto their own lots', async () => {
    const id = uid();
    const paidLot = await addDollarLot(id, 'dollar_paid', 1);
    const promoLot = await addDollarLot(id, 'dollar_promo', 1);
    // The exact shape debitDollarLots' own `draws` return carries -- the
    // unlock handler stashes this verbatim as creditDollarDraws.
    const draws = [
      { lot_id: paidLot.lot_id, kind: 'dollar_paid', amount: 0.30 },
      { lot_id: promoLot.lot_id, kind: 'dollar_promo', amount: 0.56 },
    ];
    await refundDollarDraw(id, draws);
    const balance = summarizeCreditBalance(loadCredits()[id]);
    assert.equal(balance.paid_usd, 1.30, 'the paid lot got its own draw back, on top of its own remaining balance');
    assert.equal(balance.promo_usd, 1.56, 'the promo lot got its own draw back, on top of its own remaining balance');
  });

  it('a zero-amount draw entry adds nothing', async () => {
    const id = uid();
    const lot = await addDollarLot(id, 'dollar_paid', 1);
    await refundDollarDraw(id, [{ lot_id: lot.lot_id, kind: 'dollar_paid', amount: 0 }]);
    const balance = summarizeCreditBalance(loadCredits()[id]);
    assert.equal(balance.paid_usd, 1);
  });

  it('ruling N1: a failed-delivery restore pays down the lot\'s uncovered amount FIRST, never handing back money a refund already took', async () => {
    const id = uid();
    const lot = await addDollarLot(id, 'dollar_paid', 10, { stripe_payment_intent: pi() });
    // Simulate a refund whose excess already reached PAST this draw before
    // any funding record existed for it to reverse (removeDollarLotRemainder
    // leaves this as the lot's uncovered amount -- ruling N1 replaces the
    // old blanket `removed_at` stamp with this running, consumable figure).
    const credits = loadCredits();
    credits[id].dollar_lots[0].uncovered_usd = 5;
    credits[id].dollar_lots[0].remaining_usd = 0;
    saveCredits(credits);
    const result = await refundDollarDraw(id, [{ lot_id: lot.lot_id, kind: 'dollar_paid', amount: 5 }]);
    assert.equal(result.paid_restored, 0, 'the uncovered amount consumes the whole restore -- nothing reaches the buyer');
    assert.equal(result.skipped_usd, 5);
    assert.equal(loadCredits()[id].dollar_lots[0].remaining_usd, 0, 'the lot stays at 0 -- the money already left Auxilo by the refund');
    assert.equal(loadCredits()[id].dollar_lots[0].uncovered_usd, 0, 'fully consumed by this one restore');
  });

  it('ruling N1: a restore bigger than the uncovered amount pays it down and hands the REST back to the buyer', async () => {
    const id = uid();
    const lot = await addDollarLot(id, 'dollar_paid', 10, { stripe_payment_intent: pi() });
    const credits = loadCredits();
    credits[id].dollar_lots[0].uncovered_usd = 2;
    credits[id].dollar_lots[0].remaining_usd = 0;
    saveCredits(credits);
    const result = await refundDollarDraw(id, [{ lot_id: lot.lot_id, kind: 'dollar_paid', amount: 5 }]);
    assert.equal(result.paid_restored, 3, '5 - 2 uncovered');
    assert.equal(result.skipped_usd, 2);
    assert.equal(loadCredits()[id].dollar_lots[0].remaining_usd, 3);
    assert.equal(loadCredits()[id].dollar_lots[0].uncovered_usd, 0);
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

  // FIX-UNIT-MONEY L5: NO CHANGE ruling -- the Terms say "at least half",
  // so the boundary (exactly half spent) correctly counts as half_spent.
  // Pinned per the ruling's own instruction.
  it('[ruling L5, NO CHANGE] a lot spent EXACTLY half places a hold -- "at least half" per the Terms', async () => {
    const id = uid();
    const intent = pi();
    await addDollarLot(id, 'dollar_paid', 10, { stripe_payment_intent: intent });
    await deductCredit(id, 'unlock', 5); // exactly half of 10
    const result = await freezeDollarLot(id, intent, 'dispute');
    assert.equal(result.half_spent, true, 'exactly half spent must count as "at least half"');
    assert.equal(result.remaining_usd, 5);
  });

  it('[ruling L5, NO CHANGE] one cent short of half does NOT place a hold', async () => {
    const id = uid();
    const intent = pi();
    await addDollarLot(id, 'dollar_paid', 10, { stripe_payment_intent: intent });
    await deductCredit(id, 'unlock', 4.99);
    const result = await freezeDollarLot(id, intent, 'dispute');
    assert.equal(result.half_spent, false, 'just under half must not count as "at least half"');
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

  it('removeDollarLotRemainder zeroes remaining_usd and returns pending-reversal funded_unlocks exactly once (idempotent) [ruling H1/L6]', async () => {
    const id = uid();
    const intent = pi();
    const lotResult = await addDollarLot(id, 'dollar_paid', 10, { stripe_payment_intent: intent });
    await recordLotFunding(id, [{ lot_id: lotResult.lot_id, kind: 'dollar_paid', amount: 4 }], {
      learning_id: 'lrn_r', contributor_account_id: 'acc_r', contributor_amount: 2.8, platform_amount: 1.2, ts: new Date().toISOString(),
    });
    // Mirror what a real unlock does: the $4 draw actually debited
    // remaining_usd (recordLotFunding only records the funding HISTORY,
    // never the debit itself -- deductCredit/debitDollarLots does that).
    const creditsBefore = loadCredits();
    creditsBefore[id].dollar_lots[0].remaining_usd = 6; // 10 - 4 spent
    saveCredits(creditsBefore);

    const first = await removeDollarLotRemainder(id, intent); // default = full (Infinity, capped at original_usd)
    assert.equal(first.success, true);
    assert.equal(first.removed_usd, 6, 'only the unspent remainder is removed by "remove"');
    assert.equal(first.funded_unlocks.length, 1, 'the $4 funded entry is fully within the $10 - $6 = $4 excess -- reversed in full');
    assert.equal(first.funded_unlocks[0].pending_reversal, true);
    assert.equal(loadCredits()[id].dollar_lots[0].remaining_usd, 0);

    // The caller (lib/stripe-refund-handlers.js) would now reverse earnings
    // and call finalizePendingReversals -- simulate that here so the next
    // check (a Stripe retry) proves the FULL idempotency chain.
    await finalizePendingReversals(id, first.lot_id);

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

  // RETIRED (credits-as-cash follow-up, SITE-PM 2026-09-27): '[test 15]
  // balance cap counts a unit lot's notional value, not only a dollar lot'
  // pinned unit-lot valuation in the cap. F-9 removes it — the balance cap
  // now counts dollar lots only (there is nothing else to count).

  it('[test 14] daily purchase cap refuses a purchase that would push the trailing-24h total over $2,000', () => {
    const id = uid();
    const now = Date.now();
    appendPurchase({ stripe_platform: 'legacy', stripe_platform_account_id: 'acct_1TCbMe0Jj0R41QQV', id: 'pur_a', account_id: id, pack_id: 'pro', amount_usd: 1950, stripe_session_id: 'cs_a', stripe_payment_intent: null, timestamp: new Date(now - 60_000).toISOString() });
    const check = checkDailyCap(id, 100, now); // 1950 + 100 = 2050, over the cap
    assert.equal(check.ok, false);
    assert.equal(check.current, 1950);
  });

  it('a purchase older than 24h does not count toward the daily cap', () => {
    const id = uid();
    const now = Date.now();
    appendPurchase({ stripe_platform: 'legacy', stripe_platform_account_id: 'acct_1TCbMe0Jj0R41QQV', id: 'pur_b', account_id: id, pack_id: 'pro', amount_usd: 1950, stripe_session_id: 'cs_b', stripe_payment_intent: null, timestamp: new Date(now - 25 * 60 * 60 * 1000).toISOString() });
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

// RETIRED IN FULL (credits-as-cash follow-up, SITE-PM 2026-09-27):
//   - section 10, 'creditsAsCashEnabled: off by default, on only when
//     exactly "true"' (3 tests) — lib/credits-flag.js is deleted; there is
//     no flag.
//   - section 11, 'createCheckoutSession: lotKind stamps metadata.lot_kind
//     and the Stripe-visible description' (2 tests) — createCheckoutSession
//     takes no lotKind argument anymore; every session's description always
//     states the dollar amount added to the balance (proved in
//     test/credits-one-balance.test.js and test/credits-control-part1.test.js).

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
      'async function addDollarLot(accountId, kind, amountUsd, opts = {})',
      // FIX-UNIT-MONEY M1: refundDollarDraw now restores onto the SAME lots
      // the money was drawn from (a `draws` array), not fresh lots from
      // plain paid/promo totals.
      'async function refundDollarDraw(accountId, draws)',
      'async function recordLotFunding(accountId, draws, info)',
      'async function freezeDollarLot(accountId, paymentIntent, reason, context)',
      'async function unfreezeDollarLot(accountId, paymentIntent, context)',
      // FIX-UNIT-MONEY H1: amount-aware (ruling H1) -- a third parameter,
      // defaulted to Infinity (capped at the lot's own original_usd), so a
      // 2-argument call still means "full removal", today's behavior.
      'async function removeDollarLotRemainder(accountId, paymentIntent, amountUsd = Infinity, context)',
      'async function finalizePendingReversals(accountId, lotId)',
      'async function stampDisputeStatus(accountId, paymentIntent, disputeId, status, context)',
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
  // FIX-UNIT-MONEY L10: the old test here was titled "has exactly one call
  // site" but asserted 0 call sites of consumeUnlockLot -- a function that
  // was deleted with the unit-lot model and was never coming back, so the
  // assertion passed whatever server.js contained (title and assertion
  // disagreed, and neither meant anything). Replaced with a real,
  // non-tautological proof: no retired unit-lot vocabulary is called
  // anywhere in the codebase, checked with a positive control (BUILDER-
  // RULES: every absence check needs a same-test proof the detector can
  // actually find a match).
  it('no retired unit-lot debit function is called anywhere — spending is exclusively through debitDollarLots (positive-control checked)', () => {
    const RETIRED_UNIT_VOCAB = ['consumeUnlockLot', 'ensureUnlockLots', 'addPurchasedCredits', 'deriveLegacyUnitPrice'];
    for (const name of RETIRED_UNIT_VOCAB) {
      assert.equal((SERVER_SRC.match(new RegExp(`${name}\\(`, 'g')) || []).length, 0,
        `${name} must never be called in server.js — no unit-lot model exists`);
      assert.equal((CREDITS_SRC.match(new RegExp(`${name}\\(`, 'g')) || []).length, 0,
        `${name} must never be called in lib/credits.js — no unit-lot model exists`);
    }
    // Positive control: the SAME style of check finds a real, still-present name.
    assert.ok((CREDITS_SRC.match(/debitDollarLots\(/g) || []).length > 0,
      'positive control: the real dollar-lot debit function must be found by the same detector');
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
  // RETIRED (credits-as-cash follow-up, SITE-PM 2026-09-27): the old
  // assertion pinned addDollarLot to exactly ONE call site (the webhook) —
  // that was true only while referral grants still called the now-deleted
  // addPurchasedCredits. F-2 moves those grants onto addDollarLot too, so
  // the count is now three, none of them crypto or router code. The
  // three-call-site count is also proved in test/credits-one-balance.test.js.
  it('addDollarLot has exactly three call sites in server.js — the webhook and the two referral grants — never loaded from crypto', () => {
    const dispatcher = fs.readFileSync(path.join(__dirname, '../lib/stripe-event-dispatch.js'), 'utf8');
    const callSites = (SERVER_SRC.match(/await addDollarLot\(/g) || []).length + (dispatcher.match(/await addDollarLot\(/g) || []).length;
    assert.equal(callSites, 3, 'addDollarLot must have exactly three call sites across dispatcher and referrals');
    const webhookStart = SERVER_SRC.indexOf("app.post('/webhook/stripe'");
    const webhookEnd = SERVER_SRC.indexOf("app.get('/account/purchases'");
    const webhookSlice = dispatcher;
    assert.equal((webhookSlice.match(/await addDollarLot\(/g) || []).length, 1,
      'exactly one of the three call sites sits inside the webhook route');
    // None of the three sites sits inside verifyPaymentOrReject or the
    // router settlement branch of the unlock handler.
    const routerFnStart = SERVER_SRC.indexOf('async function verifyPaymentOrReject(');
    const routerFnEnd = SERVER_SRC.indexOf('\n}', routerFnStart);
    const routerSlice = SERVER_SRC.slice(routerFnStart, routerFnEnd);
    assert.ok(!routerSlice.includes('addDollarLot('), 'verifyPaymentOrReject (x402) must never credit a lot');
  });
  it('the lot-credit function is not reachable from x402Router settlement code', () => {
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
      assert.ok(!slice.includes('deductCredit(') && !slice.includes('addDollarLot('),
        `${label} must not call any credits-module function`);
    }
  });
});
