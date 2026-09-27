'use strict';

/**
 * test/wave1-money-closures.test.js — Wave 1 (2026-07-19)
 *
 * Covers BUILD-SPEC-WAVE1-2026-07-19 (PUNCH-LIST rows):
 *   1.1 AUD19-15 — discovery-premium attribution reads the POST-auth identity
 *       (the pre-auth read left the 60% share dead on the API-key path).
 *   1.2 AUD19-10 — compensating credit refund on post-deduction delivery
 *       failure: abortWal + in-memory rollback + refundDollarDraw (restores
 *       the exact paid/promo split the debit drew).
 *   1.3 LW-7 — rating requires auth + proof of prior unlock via the durable
 *       purchase ledger; cooldowns re-keyed from IP to account.
 *   1.4 AUD19-13 rem. — static dualAuth (+ its only dependency x402Gate)
 *       deleted: zero callers.
 *   1.5 Reviewer debt — _custodialAccepts helper (three-way consistency lives
 *       in test/aud19-payment-contract.test.js), X-Payment-Required on all
 *       402s, eip712 interval .unref(), per-category ops-alert rate limits.
 *
 * Style matches the aud19 suites: pure-logic tests against libs (env-file
 * isolation) + source-level wiring assertions against server.js (it hardcodes
 * PORT/DATA_DIR, so endpoints are only assertable statically).
 *
 * Runner: node --test test/wave1-money-closures.test.js
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ─── Env-file isolation (must precede the lib requires) ──────────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'auxilo-wave1-'));
process.env.AUXILO_CREDITS_FILE = path.join(TMP, 'credits.json');
process.env.AUXILO_PURCHASE_LEDGER_FILE = path.join(TMP, 'purchase-ledger.json');
process.env.AUXILO_WAL_DIR = path.join(TMP, 'wal');

const credits = require('../lib/credits.js');
const ledger = require('../lib/purchase-ledger.js');
const wal = require('../lib/wal.js');
const opsAlert = require('../lib/ops-alert.js');

const SERVER_SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf-8');
const MCP_SRC = fs.readFileSync(path.join(__dirname, '..', 'mcp-server.js'), 'utf-8');
const EIP712_SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'eip712.js'), 'utf-8');

after(() => {
  delete process.env.AUXILO_WAL_DIR;
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
});

function unlockHandlerSlice() {
  const start = SERVER_SRC.indexOf("app.get('/knowledge/:id'");
  const end = SERVER_SRC.indexOf("app.post('/knowledge/:id/rate'", start);
  assert.ok(start !== -1 && end !== -1);
  return SERVER_SRC.slice(start, end);
}

function rateHandlerSlice() {
  const start = SERVER_SRC.indexOf("app.post('/knowledge/:id/rate'");
  const end = SERVER_SRC.indexOf("app.get('/pricing/categories'", start);
  assert.ok(start !== -1 && end !== -1);
  return SERVER_SRC.slice(start, end);
}

// ════════════════════════════════════════════════════════════════════════════
// 1.1 AUD19-15 — discovery attribution on POST-auth identity
// ════════════════════════════════════════════════════════════════════════════

describe('AUD19-15: discovery-premium cache read uses the POST-auth identity', () => {
  let h;
  // CH-7: computed in before() — a failed slice exits 1, never fail-0/exit-0.
  before(() => { h = unlockHandlerSlice(); });

  it('the cache read sits AFTER dualAuthDynamic (no pre-auth read remains)', () => {
    const auth = h.indexOf('await dualAuthDynamic(');
    const read = h.indexOf('searchSourceCache.get(');
    assert.ok(auth !== -1 && read !== -1, 'both auth and cache read must exist');
    assert.ok(read > auth, 'the discovery read must run after authentication sets accountId');
    // Exactly one read — the stale pre-auth one is gone.
    assert.equal(h.split('searchSourceCache.get(').length - 1, 1,
      'exactly one cache read (post-auth) may exist in the unlock handler');
  });

  it('the read keys on buyerAccountId and is credit-path-only (x402/router can never consult it)', () => {
    assert.ok(h.includes('const discoveryCacheKey = `${buyerAccountId}:${id}`;'),
      'cache key must be the post-auth buyerAccountId');
    assert.ok(/const cachedAt = \(fundingSource === 'credit_pack' && buyerAccountId\)\s*\n\s*\? searchSourceCache\.get\(discoveryCacheKey\) : undefined;/.test(h),
      'the read must be gated on the credit funding source');
    assert.ok(h.includes('if (isFromSearch) searchSourceCache.delete(discoveryCacheKey); // single-use'),
      'single-use consumption preserved');
  });

  it('share selection and basis composition survive verbatim (60/40 on discovery, on the PAID basis)', () => {
    assert.ok(h.includes("const CONTRIBUTOR_SHARE = (source === 'search') ? CONTRIBUTOR_SHARE_DISCOVERY : CONTRIBUTOR_SHARE_STANDARD;"));
    // FIX-UNIT-MONEY L1: remainder-allocated -- the platform share is
    // round6(accrualBasis - contributorEarned), not its own independent
    // rounding, so the two always sum to exactly round6(accrualBasis).
    assert.ok(h.includes('const contributorEarned = round6(accrualBasis * CONTRIBUTOR_SHARE);'));
    assert.ok(h.includes('const platformEarned = round6(accrualBasis - contributorEarned);'));
  });

  it('pre-settlement consumers quote the STANDARD share (router bps + 402 description)', () => {
    assert.ok(h.includes('contributorBps: Math.round(CONTRIBUTOR_SHARE_STANDARD * 10000)'),
      'router split must be pinned to the standard share BEFORE settlement');
    assert.ok(h.includes('70% goes to contributor'),
      'the x402 challenge description quotes the standard share');
    assert.ok(!h.includes('shareLabel'), 'the pre-auth shareLabel selection is gone');
  });

  it('write/read key parity: the search route authenticates BEFORE recording attribution', () => {
    assert.ok(SERVER_SRC.includes("app.post('/knowledge', optionalAuth(), apiKeyRateLimitMiddleware('/knowledge')"),
      'POST /knowledge must keep optionalAuth so recordSearchSource sees the account');
    assert.ok(SERVER_SRC.includes('function recordSearchSource(accountId, learningId)'));
    assert.ok(SERVER_SRC.includes('const key = `${accountId}:${learningId}`;'),
      'write key shape must match the unlock-side read key shape');
  });

  it('the stale pre-auth callerAccountId capture is gone from the unlock handler', () => {
    assert.ok(!h.includes('callerAccountId'),
      'no pre-auth identity capture may remain in the unlock handler');
    assert.ok(h.includes("const buyerAccountId = c.get('accountId') || null;"),
      'buyerAccountId is the single post-auth identity read');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 1.2 AUD19-10 — compensating refund machinery (pure lib tests)
// ════════════════════════════════════════════════════════════════════════════

// RETIRED (credits-as-cash follow-up, SITE-PM 2026-09-27): all three tests
// here pinned refundCredit()'s unit-lot restore at "the consumed unit
// price" — refundCredit and addPurchasedCredits are both deleted (F-3, F-4).
// A delivery-failure refund now always restores the exact paid/promo split
// the debit drew, via refundDollarDraw, proved fresh below.
// FIX-UNIT-MONEY M1: refundDollarDraw no longer takes plain (paidUsd,
// promoUsd) totals and pushes brand-new lots with no payment intent -- it
// takes the exact `draws` array the original debit returned and restores
// each amount onto the SAME lot it came from, so the restored balance stays
// tied to the Stripe purchase behind it (a later refund or lost dispute of
// that pack can still find and remove it -- see test/credits-as-cash-lots.
// test.js and test/credits-as-cash-refunds.test.js S2/S2b for the
// refund-after-restore proofs this signature change exists to support).
describe('[ruling M1] refundDollarDraw restores the exact draws onto the SAME lots', () => {
  it('paid balance round-trip: deduct → delivery-failure restore → next deduct sees the same balance, same lot', async () => {
    const acct = 'acc_w1_refund_paid';
    const lot = await credits.addDollarLot(acct, 'dollar_paid', 0.40);
    const d1 = await credits.deductCredit(acct, 'unlock', 0.40);
    assert.equal(d1.success, true);
    assert.equal(d1.paid_drawn, 0.40);
    assert.equal(credits.loadCredits()[acct].dollar_lots[0].remaining_usd, 0);

    const r = await credits.refundDollarDraw(acct, d1.draws);
    assert.equal(r.success, true);
    assert.equal(r.paid_restored, 0.40);

    const record = credits.loadCredits()[acct];
    assert.equal(record.dollar_lots.length, 1, 'restored onto the SAME lot -- no second lot created');
    assert.equal(record.dollar_lots[0].lot_id, lot.lot_id);
    const balance = credits.summarizeCreditBalance(record);
    assert.equal(balance.paid_usd, 0.40, 'the restored balance must carry the original paid amount — basis accounting cannot drift');

    const d2 = await credits.deductCredit(acct, 'unlock', 0.40);
    assert.equal(d2.success, true);
    assert.equal(d2.paid_drawn, 0.40);
  });

  it('a refunded promotional draw comes back as promotional, not paid, onto its own lot', async () => {
    const acct = 'acc_w1_refund_grant';
    const lot = await credits.addDollarLot(acct, 'dollar_promo', 1);
    const d1 = await credits.deductCredit(acct, 'unlock', 1);
    assert.equal(d1.promo_drawn, 1);
    assert.equal(d1.paid_drawn, 0);
    const r = await credits.refundDollarDraw(acct, d1.draws);
    assert.equal(r.promo_restored, 1);
    const record = credits.loadCredits()[acct];
    assert.equal(record.dollar_lots[0].lot_id, lot.lot_id);
    const balance = credits.summarizeCreditBalance(record);
    assert.equal(balance.promo_usd, 1, 'a promotional draw refunds as promotional');
    assert.equal(balance.paid_usd, 0);
  });

  it('a draw whose lot a refund has since removed is skipped, not fabricated onto a phantom lot', async () => {
    const acct = 'acc_w1_refund_removed';
    const lot = await credits.addDollarLot(acct, 'dollar_paid', 10, { stripe_payment_intent: 'pi_w1_removed' });
    const d1 = await credits.deductCredit(acct, 'unlock', 4);
    assert.equal(d1.success, true);
    // Simulate the lot having already been refunded away entirely (what
    // removeDollarLotRemainder stamps) BEFORE the delivery-failure
    // compensation runs.
    const credsBefore = credits.loadCredits();
    credsBefore[acct].dollar_lots[0].removed_at = new Date().toISOString();
    credsBefore[acct].dollar_lots[0].remaining_usd = 0;
    credits.saveCredits(credsBefore);

    const r = await credits.refundDollarDraw(acct, d1.draws);
    assert.equal(r.paid_restored, 0, 'the removed lot must not receive money back');
    assert.equal(r.skipped_usd, 4, 'that money already left Auxilo by way of the refund');
    assert.equal(credits.loadCredits()[acct].dollar_lots[0].remaining_usd, 0);
    void lot;
  });
});

describe('AUD19-10: abortWal guarantees no replay', () => {
  it('created → aborted → absent from pending; double abort and unknown-id abort return true', () => {
    const id = wal.createWalEntry('wave1-test', { marker: 'aud19-10' });
    assert.ok(wal.getPendingWalEntries().some(e => e.id === id), 'entry pending after create');
    assert.equal(wal.abortWal(id), true);
    assert.ok(!wal.getPendingWalEntries().some(e => e.id === id), 'aborted entry must never replay');
    assert.equal(wal.abortWal(id), true, 'already-gone = nothing can replay = true');
    assert.equal(wal.abortWal('no-such-id'), true);
  });
});

describe('AUD19-10: unlock handler compensation wiring (source)', () => {
  let h;
  before(() => { h = unlockHandlerSlice(); });

  it('the delivery section is wrapped and the catch compensates the credit path only', () => {
    assert.ok(h.includes('} catch (deliveryErr) {'), 'delivery try/catch exists');
    const catchBlock = h.slice(h.indexOf('} catch (deliveryErr) {'));
    assert.ok(catchBlock.includes("if (fundingSource !== 'credit_pack' || !buyerAccountId) {"),
      'x402/router arm is separated');
    assert.ok(catchBlock.includes('throw deliveryErr;'),
      'x402/router path rethrows — the WAL replay is the designed recovery for settled money');
    assert.ok(catchBlock.includes('refundDollarDraw(buyerAccountId,'), 'credit path restores the drawn balance');
    assert.ok(catchBlock.includes('credit_refunded: true'), 'buyer told the credit came back');
  });

  it('WAL is cancelled FIRST, and a failed abort refuses the refund (never double-pay)', () => {
    const catchBlock = h.slice(h.indexOf('} catch (deliveryErr) {'));
    const abortAt = catchBlock.indexOf('abortWal(walId)');
    const refundAt = catchBlock.indexOf('refundDollarDraw(');
    assert.ok(abortAt !== -1 && refundAt !== -1 && abortAt < refundAt,
      'abort must precede refund');
    assert.ok(catchBlock.includes('if (!walCancelled) {'), 'failed abort is a distinct arm');
    const noRefundArm = catchBlock.slice(catchBlock.indexOf('if (!walCancelled) {'), catchBlock.indexOf('// 2.'));
    assert.ok(noRefundArm.includes('credit_refunded: false'),
      'when the WAL survives, the credit is NOT refunded (replay will land the accrual)');
    assert.ok(!noRefundArm.includes('refundDollarDraw('), 'no refund call in the abort-failed arm');
  });

  it('the error path never crashes: refund failure logs + ops-alerts in its own category', () => {
    const catchBlock = h.slice(h.indexOf('} catch (deliveryErr) {'));
    assert.ok(catchBlock.includes('} catch (refundErr) {'), 'refund failure is caught');
    assert.equal(catchBlock.split("category: 'unlock-refund'").length - 1, 2,
      'both ops-alerts (abort-failed + refund-failed) use the unlock-refund category');
  });

  // RETIRED (credits-as-cash follow-up, SITE-PM 2026-09-27): 'the
  // accrual-cap un-arm is gated on this request having armed it' pinned
  // accrualArmed/unrecordAccrual — lib/unlock-attribution.js is deleted
  // (F-5); there is no repeat-accrual cap left to un-arm.

  it('in-memory ledger rollback exists (phantom accruals cannot flush later)', () => {
    const catchBlock = h.slice(h.indexOf('} catch (deliveryErr) {'));
    assert.ok(catchBlock.includes('learning.quality.unlocks = _rb.qualityUnlocks;'));
    assert.ok(catchBlock.includes('delete earnings[_rb.earningsKey];'),
      'a newly-created earnings entry is removed on rollback');
  });

  // FIX-UNIT-MONEY L7: the old rollback restored a whole-entry SNAPSHOT
  // taken before this request's mutation, which would silently overwrite
  // any OTHER concurrent mutation to the same entry (a reversal landing
  // during the `await recordLotFunding` window, for example). The rollback
  // now subtracts THIS request's own amounts instead -- there is no
  // snapshot left to take or restore.
  it('[ruling L7] rollback undoes by SUBTRACTING this request\'s own amounts, not by restoring a snapshot', () => {
    assert.ok(!h.includes('_rb.earningsSnapshot'), 'the whole-entry snapshot mechanism must be gone');
    assert.ok(!h.includes('JSON.parse(JSON.stringify(activeEntry))'), 'no deep-clone snapshot of the live entry is taken');
    const catchBlock = h.slice(h.indexOf('} catch (deliveryErr) {'));
    assert.ok(catchBlock.includes('rbEntry.total_gross = round6((rbEntry.total_gross || 0) - accrualBasis);'),
      'the existing-entry rollback arm subtracts this request\'s own accrualBasis/contributorEarned/platformEarned');
    assert.ok(catchBlock.includes('rbEntry.pending_balance = round6((rbEntry.pending_balance || 0) - contributorEarned);'));
  });
});

// FIX-UNIT-MONEY L10: "the delivery-failure compensation is covered only by
// source-string checks, which is why M1 was not caught." This describe
// proves M1's actual FIX with real lib calls in the exact sequence the
// unlock handler now runs them (debit -> [delivery fails] -> refundDollarDraw
// with the real draws array -> recordLotFunding never runs because the
// handler returns before reaching it), matching server.js's own ordering
// after this build: recordLotFunding only ever runs AFTER commitWal, so a
// delivery failure (which throws before ever reaching that point) means it
// never runs at all for that request.
describe('[ruling M1] delivery-failure compensation restores onto the SAME lot, real lib sequence', () => {
  it('a failed delivery restores the drawn amount onto the ORIGINAL lot (same payment_intent) -- not a fresh, unlinked lot', async () => {
    const acct = 'acc_w1_m1_real';
    const pi = 'pi_w1_m1_real';
    await credits.addDollarLot(acct, 'dollar_paid', 10, { stripe_payment_intent: pi });

    // The unlock handler's own sequence: debit first...
    const draw = await credits.deductCredit(acct, 'unlock', 10);
    assert.equal(draw.success, true);
    assert.equal(credits.loadCredits()[acct].dollar_lots[0].remaining_usd, 0);

    // ...then delivery fails BEFORE the WAL commits, so recordLotFunding
    // (moved to run only after commitWal by this build) never executes --
    // the compensation arm restores the draw with nothing else to undo.
    const restore = await credits.refundDollarDraw(acct, draw.draws);
    assert.equal(restore.success, true);
    assert.equal(restore.paid_restored, 10);

    const record = credits.loadCredits()[acct];
    assert.equal(record.dollar_lots.length, 1, 'restored onto the SAME lot -- no second lot, no null payment_intent lot');
    assert.equal(record.dollar_lots[0].stripe_payment_intent, pi, 'the restored balance stays tied to its Stripe purchase');
    assert.equal(record.dollar_lots[0].remaining_usd, 10);

    // Because it is the SAME lot, a later refund of that purchase still
    // finds it (the M1 defect this build fixes: the old code pushed a
    // fresh lot with stripe_payment_intent: null, which a refund could
    // never find).
    const { handleChargeRefunded } = require('../lib/stripe-refund-handlers.js');
    const refundResult = await handleChargeRefunded(
      { data: { object: { payment_intent: pi } } },
      { earnings: {}, saveEarnings: () => {}, sendOpsAlert: async () => {} },
    );
    assert.equal(refundResult.matched, true, 'the refund must find the restored lot by its Stripe payment_intent');
    assert.equal(refundResult.removed_usd, 10);
    assert.equal(credits.loadCredits()[acct].dollar_lots[0].remaining_usd, 0, 'the pack is now fully refunded, no leftover phantom balance');
  });

  it('recordLotFunding leaves no funding record when it never runs (M1: recorded only after commit)', async () => {
    const acct = 'acc_w1_m1_norecord';
    const pi = 'pi_w1_m1_norecord';
    await credits.addDollarLot(acct, 'dollar_paid', 10, { stripe_payment_intent: pi });
    const draw = await credits.deductCredit(acct, 'unlock', 10);
    assert.equal(draw.success, true);
    // Simulate the delivery failure: recordLotFunding is never called at
    // all (server.js only reaches it after commitWal, which a delivery
    // failure never reaches), then the compensation restores the draw.
    await credits.refundDollarDraw(acct, draw.draws);

    const lot = credits.loadCredits()[acct].dollar_lots[0];
    assert.equal((lot.funded_unlocks || []).length, 0,
      'no stale funding record survives -- there was never a chance for one to be written before the restore');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 1.3 LW-7 — purchase ledger + rating auth
// ════════════════════════════════════════════════════════════════════════════

describe('LW-7: purchase ledger is durable proof of delivered unlocks', () => {
  // Wave 2b F4: recordPurchase is now async (store-level write mutex) — the
  // call sites are fire-and-forget, but tests await for determinism.
  it('record/has round-trip; repeat unlocks bump count and preserve first_ts', async () => {
    const acct = 'acc_w1_ledger';
    const lrn = 'lrn_w1_ledger';
    assert.equal(ledger.hasPurchase(acct, lrn), false);
    await ledger.recordPurchase(acct, lrn, 1000);
    assert.equal(ledger.hasPurchase(acct, lrn), true);
    await ledger.recordPurchase(acct, lrn, 2000);
    const entry = ledger.loadLedger()[`${acct}:${lrn}`];
    assert.equal(entry.count, 2);
    assert.equal(entry.first_ts, 1000, 'first purchase timestamp preserved');
    assert.equal(entry.last_ts, 2000);
  });

  it('durability: a record far older than the 30-day accrual-cap window still proves purchase', async () => {
    const acct = 'acc_w1_ledger_old';
    const lrn = 'lrn_w1_ledger_old';
    const ninetyDaysAgo = Date.now() - 90 * 24 * 60 * 60 * 1000;
    await ledger.recordPurchase(acct, lrn, ninetyDaysAgo);
    assert.equal(ledger.hasPurchase(acct, lrn), true,
      'the ledger is never pruned — rating rights do not expire');
  });

  it('missing identities are never eligible', () => {
    assert.equal(ledger.hasPurchase(null, 'lrn_x'), false);
    assert.equal(ledger.hasPurchase('acc_x', null), false);
  });
});

describe('LW-7: rating endpoint requires auth + proof of prior unlock (source)', () => {
  let r;
  before(() => { r = rateHandlerSlice(); });

  it('route registers requireSessionOrApiKey and gates on hasPurchase', () => {
    assert.ok(SERVER_SRC.includes("app.post('/knowledge/:id/rate', requireSessionOrApiKey('read'), async (c) => {"),
      'rating requires a session or an API key at read scope');
    assert.ok(r.includes('if (!hasPurchase(raterAccountId, id)) {'), 'proof-of-purchase gate');
    assert.ok(r.includes("code: 'UNLOCK_REQUIRED_TO_RATE'"), 'machine-readable refusal');
    assert.ok(/\}, 403\)/.test(r), 'refusal is a 403');
  });

  it('cooldown is keyed by account, not IP', () => {
    assert.ok(r.includes('const rateKey = `${raterAccountId}:${id}`;'));
    assert.ok(!r.includes('getClientIp(c)'), 'no IP-keyed cooldown remains in the rate handler');
  });

  it('the ratings JSONL carries the rater account id', () => {
    assert.ok(r.includes('rater_account_id: raterAccountId'));
  });

  // AUD-CAC (credits-as-cash follow-up, SITE-PM 2026-09-27): the capped-repeat
  // branch (and its own recordPurchase call) is gone — F-5 removes the
  // 30-day repeat-accrual cap, so there is only the one main-path recording
  // site left. The self-unlock exclusion and the post-commit ordering it
  // proved still hold and are re-asserted against the real remaining
  // boundaries.
  it('unlock handler records purchases on delivery success only (main path, never self-unlock)', () => {
    const h = unlockHandlerSlice();
    assert.equal(h.split('recordPurchase(buyerAccountId, id)').length - 1, 1,
      'exactly one recording site: the main path');
    const selfBlock = h.slice(h.indexOf('if (isSelfUnlock) {'), h.indexOf('learning.earnings.gross_usd'));
    assert.ok(!selfBlock.includes('recordPurchase('),
      'self-unlocks never mint rating rights — contributors cannot rate their own learnings');
    const commitAt = h.indexOf('commitWal(walId);');
    const mainRecordAt = h.lastIndexOf('recordPurchase(buyerAccountId, id)');
    assert.ok(commitAt !== -1 && mainRecordAt > commitAt,
      'main-path recording sits AFTER the WAL commit — a refunded failure cannot mint rating rights');
  });

  it('MCP auxilo_rate still authenticates and its description states the new contract', () => {
    const rateCase = MCP_SRC.slice(MCP_SRC.indexOf("case 'auxilo_rate': {"), MCP_SRC.indexOf("case 'auxilo_verify_wallet': {"));
    assert.ok(rateCase.includes('baseHeaders()'), 'the MCP client sends the API key with rate calls');
    const desc = MCP_SRC.slice(MCP_SRC.indexOf("name: 'auxilo_rate'"), MCP_SRC.indexOf("name: 'auxilo_verify_wallet'"));
    assert.ok(desc.includes('prior unlock'), 'tool description must state the unlock requirement');
    assert.ok(desc.includes('API key'), 'tool description must state the auth requirement');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 1.4 AUD19-13 remainder — dead static auth pair deleted
// ════════════════════════════════════════════════════════════════════════════

describe('AUD19-13: static dualAuth + x402Gate are gone (zero callers, INFO-5)', () => {
  it('neither function is defined; the live dynamic path remains', () => {
    assert.ok(!SERVER_SRC.includes('function dualAuth('), 'static dualAuth deleted');
    assert.ok(!SERVER_SRC.includes('function x402Gate('), 'x402Gate (only caller was dualAuth) deleted');
    assert.ok(SERVER_SRC.includes('async function dualAuthDynamic('), 'live path intact');
    assert.ok(SERVER_SRC.includes('async function verifyPaymentOrReject('), 'live path intact');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 1.5 Reviewer debt
// ════════════════════════════════════════════════════════════════════════════

describe('Wave-1 reviewer debt: eip712 interval + ops-alert categories', () => {
  it('the eip712 nonce-cleanup interval is unref()d (node --test must not hang on require)', () => {
    assert.ok(/setInterval\(\(\) => \{[\s\S]*?\}, 60_000\)\.unref\(\);/.test(EIP712_SRC),
      'the module-level cleanup interval must not hold the event loop open');
  });

  it('ops-alert rate limit is per-category: same category suppressed, others independent', () => {
    opsAlert._resetOpsAlertStateForTests();
    const t0 = 1_000_000;
    assert.equal(opsAlert._categoryRateLimited('crash', t0), false, 'first crash alert allowed');
    assert.equal(opsAlert._categoryRateLimited('crash', t0 + 1000), true, 'second crash alert inside window suppressed');
    assert.equal(opsAlert._categoryRateLimited('pending-review', t0 + 2000), false,
      'a different category must NOT be consumed by the crash slot');
    assert.equal(opsAlert._categoryRateLimited('crash', t0 + opsAlert.ALERT_MIN_INTERVAL_MS + 1), false,
      'window expiry re-allows the category');
  });

  it('missing/invalid category falls back to the shared default bucket', () => {
    opsAlert._resetOpsAlertStateForTests();
    const t0 = 2_000_000;
    assert.equal(opsAlert._categoryRateLimited(undefined, t0), false);
    assert.equal(opsAlert._categoryRateLimited(null, t0 + 1000), true, 'null and undefined share the default bucket');
    assert.equal(opsAlert._categoryRateLimited('', t0 + 2000), true, 'empty string shares the default bucket');
  });

  it('sendOpsAlert keeps the never-throws contract and accepts opts (unconfigured no-op)', async () => {
    const savedKey = process.env.RESEND_API_KEY;
    const savedTo = process.env.OPS_ALERT_EMAIL;
    delete process.env.RESEND_API_KEY;
    delete process.env.OPS_ALERT_EMAIL;
    try {
      const res = await opsAlert.sendOpsAlert('wave1 test', 'body', { category: 'crash' });
      assert.deepEqual(res, { ok: false, skipped: 'unconfigured' });
    } finally {
      if (savedKey !== undefined) process.env.RESEND_API_KEY = savedKey;
      if (savedTo !== undefined) process.env.OPS_ALERT_EMAIL = savedTo;
    }
  });

  it('every categorized caller passes a category (crash alerts can never be starved)', () => {
    for (const cat of ['ofac', 'geo-embargo', 'pending-review', 'extraction-spend', 'crash', 'unlock-refund']) {
      assert.ok(SERVER_SRC.includes(`category: '${cat}'`), `server.js must categorize '${cat}' alerts`);
    }
  });
});
