'use strict';

/**
 * test/wave1-money-closures.test.js — Wave 1 (2026-07-19)
 *
 * Covers BUILD-SPEC-WAVE1-2026-07-19 (PUNCH-LIST rows):
 *   1.1 AUD19-15 — discovery-premium attribution reads the POST-auth identity
 *       (the pre-auth read left the 60% share dead on the API-key path).
 *   1.2 AUD19-10 — compensating credit refund on post-deduction delivery
 *       failure: abortWal + in-memory rollback + refundCredit (count AND lot)
 *       + unrecordAccrual.
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
process.env.AUXILO_UNLOCK_ATTRIBUTION_FILE = path.join(TMP, 'unlock-attribution.json');
process.env.AUXILO_PURCHASE_LEDGER_FILE = path.join(TMP, 'purchase-ledger.json');

const credits = require('../lib/credits.js');
const attribution = require('../lib/unlock-attribution.js');
const ledger = require('../lib/purchase-ledger.js');
const wal = require('../lib/wal.js');
const opsAlert = require('../lib/ops-alert.js');

const SERVER_SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf-8');
const MCP_SRC = fs.readFileSync(path.join(__dirname, '..', 'mcp-server.js'), 'utf-8');
const EIP712_SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'eip712.js'), 'utf-8');

after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ } });

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
  const h = unlockHandlerSlice();

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
    assert.ok(h.includes('const contributorEarned = accrualBasis * CONTRIBUTOR_SHARE;'));
    assert.ok(h.includes('const platformEarned = accrualBasis * (1 - CONTRIBUTOR_SHARE);'));
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

describe('AUD19-10: refundCredit restores count AND lot at the consumed unit price', () => {
  it('paid credit round-trip: deduct → refund → next deduct sees the same unit price', async () => {
    const acct = 'acc_w1_refund_paid';
    await credits.addPurchasedCredits(acct, 0, 1, { unlock_unit_price_usd: 0.40 });
    const d1 = await credits.deductCredit(acct, 'unlock');
    assert.equal(d1.success, true);
    assert.equal(d1.unit_price_usd, 0.40);
    assert.equal(d1.remaining, 0);

    const r = await credits.refundCredit(acct, 'unlock', d1.unit_price_usd);
    assert.equal(r.success, true);
    assert.equal(r.remaining, 1);

    const rec = credits.loadCredits()[acct];
    assert.equal(rec.purchased_unlocks, 1);
    assert.equal(rec.unlocks_used, 0, 'usage counter must be reversed');

    const d2 = await credits.deductCredit(acct, 'unlock');
    assert.equal(d2.success, true);
    assert.equal(d2.unit_price_usd, 0.40, 'the restored lot must carry the original unit price — basis accounting cannot drift');
  });

  it('a refunded $0 grant credit comes back at $0, not the default rate', async () => {
    const acct = 'acc_w1_refund_grant';
    await credits.addPurchasedCredits(acct, 0, 1, { unlock_unit_price_usd: 0 });
    const d1 = await credits.deductCredit(acct, 'unlock');
    assert.equal(d1.unit_price_usd, 0);
    await credits.refundCredit(acct, 'unlock', d1.unit_price_usd);
    const d2 = await credits.deductCredit(acct, 'unlock');
    assert.equal(d2.unit_price_usd, 0, 'grant lots refund at $0');
  });

  it('defensive: refund with no prior record creates one; used counter floors at 0', async () => {
    const acct = 'acc_w1_refund_fresh';
    const r = await credits.refundCredit(acct, 'unlock', 0.10);
    assert.equal(r.success, true);
    const rec = credits.loadCredits()[acct];
    assert.equal(rec.purchased_unlocks, 1);
    assert.equal(rec.unlocks_used, 0, 'never negative');
  });
});

describe('AUD19-10: unrecordAccrual un-arms the cap this request armed', () => {
  it('record → capped; unrecord → uncapped; unrecord of a missing key is a no-op', () => {
    const acct = 'acc_w1_cap';
    const lrn = 'lrn_w1_cap';
    assert.equal(attribution.isAccrualCapped(acct, lrn), false);
    attribution.recordAccrual(acct, lrn);
    assert.equal(attribution.isAccrualCapped(acct, lrn), true);
    attribution.unrecordAccrual(acct, lrn);
    assert.equal(attribution.isAccrualCapped(acct, lrn), false, 'a refunded failure must not cost the retry its accrual');
    attribution.unrecordAccrual(acct, 'lrn_never_recorded'); // must not throw
    attribution.unrecordAccrual(null, lrn); // must not throw
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
  const h = unlockHandlerSlice();

  it('the delivery section is wrapped and the catch compensates the credit path only', () => {
    assert.ok(h.includes('} catch (deliveryErr) {'), 'delivery try/catch exists');
    const catchBlock = h.slice(h.indexOf('} catch (deliveryErr) {'));
    assert.ok(catchBlock.includes("if (fundingSource !== 'credit_pack' || !buyerAccountId) {"),
      'x402/router arm is separated');
    assert.ok(catchBlock.includes('throw deliveryErr;'),
      'x402/router path rethrows — the WAL replay is the designed recovery for settled money');
    assert.ok(catchBlock.includes("refundCredit(buyerAccountId, 'unlock'"), 'credit path refunds');
    assert.ok(catchBlock.includes('unrecordAccrual(buyerAccountId, id)'), 'cap un-armed on refund');
    assert.ok(catchBlock.includes('credit_refunded: true'), 'buyer told the credit came back');
  });

  it('WAL is cancelled FIRST, and a failed abort refuses the refund (never double-pay)', () => {
    const catchBlock = h.slice(h.indexOf('} catch (deliveryErr) {'));
    const abortAt = catchBlock.indexOf('abortWal(walId)');
    const refundAt = catchBlock.indexOf('refundCredit(');
    assert.ok(abortAt !== -1 && refundAt !== -1 && abortAt < refundAt,
      'abort must precede refund');
    assert.ok(catchBlock.includes('if (!walCancelled) {'), 'failed abort is a distinct arm');
    const noRefundArm = catchBlock.slice(catchBlock.indexOf('if (!walCancelled) {'), catchBlock.indexOf('// 2.'));
    assert.ok(noRefundArm.includes('credit_refunded: false'),
      'when the WAL survives, the credit is NOT refunded (replay will land the accrual)');
    assert.ok(!noRefundArm.includes('refundCredit('), 'no refund call in the abort-failed arm');
  });

  it('the error path never crashes: refund failure logs + ops-alerts in its own category', () => {
    const catchBlock = h.slice(h.indexOf('} catch (deliveryErr) {'));
    assert.ok(catchBlock.includes('} catch (refundErr) {'), 'refund failure is caught');
    assert.equal(catchBlock.split("category: 'unlock-refund'").length - 1, 2,
      'both ops-alerts (abort-failed + refund-failed) use the unlock-refund category');
  });

  it('the accrual-cap un-arm is gated on this request having armed it', () => {
    assert.ok(h.includes('accrualArmed = true;'), 'arm flag set at the recordAccrual site');
    assert.ok(h.includes('if (accrualArmed) unrecordAccrual(buyerAccountId, id);'),
      'un-arm only when this request recorded the accrual');
  });

  it('in-memory ledger rollback exists (phantom accruals cannot flush later)', () => {
    assert.ok(h.includes('_rb.earningsSnapshot'), 'earnings entry snapshot taken');
    const catchBlock = h.slice(h.indexOf('} catch (deliveryErr) {'));
    assert.ok(catchBlock.includes('learning.quality.unlocks = _rb.qualityUnlocks;'));
    assert.ok(catchBlock.includes('delete earnings[_rb.earningsKey];'),
      'a newly-created earnings entry is removed on rollback');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 1.3 LW-7 — purchase ledger + rating auth
// ════════════════════════════════════════════════════════════════════════════

describe('LW-7: purchase ledger is durable proof of delivered unlocks', () => {
  it('record/has round-trip; repeat unlocks bump count and preserve first_ts', () => {
    const acct = 'acc_w1_ledger';
    const lrn = 'lrn_w1_ledger';
    assert.equal(ledger.hasPurchase(acct, lrn), false);
    ledger.recordPurchase(acct, lrn, 1000);
    assert.equal(ledger.hasPurchase(acct, lrn), true);
    ledger.recordPurchase(acct, lrn, 2000);
    const entry = ledger.loadLedger()[`${acct}:${lrn}`];
    assert.equal(entry.count, 2);
    assert.equal(entry.first_ts, 1000, 'first purchase timestamp preserved');
    assert.equal(entry.last_ts, 2000);
  });

  it('durability: a record far older than the 30-day accrual-cap window still proves purchase', () => {
    const acct = 'acc_w1_ledger_old';
    const lrn = 'lrn_w1_ledger_old';
    const ninetyDaysAgo = Date.now() - 90 * 24 * 60 * 60 * 1000;
    ledger.recordPurchase(acct, lrn, ninetyDaysAgo);
    assert.equal(ledger.hasPurchase(acct, lrn), true,
      'the ledger is never pruned — rating rights do not expire');
  });

  it('missing identities are never eligible', () => {
    assert.equal(ledger.hasPurchase(null, 'lrn_x'), false);
    assert.equal(ledger.hasPurchase('acc_x', null), false);
  });
});

describe('LW-7: rating endpoint requires auth + proof of prior unlock (source)', () => {
  const r = rateHandlerSlice();

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

  it('unlock handler records purchases on delivery success only (main + capped, never self-unlock)', () => {
    const h = unlockHandlerSlice();
    assert.equal(h.split('recordPurchase(buyerAccountId, id)').length - 1, 2,
      'exactly two recording sites: main path + capped repeat');
    const selfBlock = h.slice(h.indexOf('if (isSelfUnlock) {'), h.indexOf('if (accrualCapped) {'));
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
