'use strict';

/**
 * test/aud19-2-econ.test.js — AUD19-2 credit-path revenue-share economics
 *
 * Ratified design (DECISION-AUD19-2-credit-economics-2026-07-19.md, option (a)):
 * contributor accrual basis = min(list price, credit unit price) on the credit
 * path; x402/router unchanged (basis = amount paid = list by construction);
 * referral/free-grant credits are $0-revenue lots and accrue $0; forward-only
 * cutover (old WAL entries replay stored amounts unchanged); plus a
 * 1-per-(buyer account, learning)/30-day accrual cap applied at the ACCRUAL
 * decision only (content still served, credit still burns).
 *
 * Strategy: behavioral tests where the logic lives in lib (credit lots,
 * cap store — redirected to temp files via the test-only env overrides, so
 * this file never races test/credits.test.js on data/credits.json), plus
 * structural source analysis for the server.js handler wiring (same
 * convention as test/cp6-accrual-gate.test.js / test/x402-router-server.test.js).
 *
 * Runner: node --test test/aud19-2-econ.test.js
 */

const os = require('os');
const fs = require('fs');
const path = require('path');

// Redirect BOTH stores to a private temp dir BEFORE the modules load.
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aud19-2-econ-'));
process.env.AUXILO_CREDITS_FILE = path.join(TMP_DIR, 'credits.json');
process.env.AUXILO_UNLOCK_ATTRIBUTION_FILE = path.join(TMP_DIR, 'unlock-attribution.json');

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const credits = require('../lib/credits.js');
const {
  deductCredit,
  addPurchasedCredits,
  loadCredits,
  ensureUnlockLots,
  consumeUnlockLot,
  deriveLegacyUnitPrice,
  DEFAULT_UNLOCK_UNIT_PRICE_USD,
} = credits;
const attribution = require('../lib/unlock-attribution.js');
const {
  isAccrualCapped,
  recordAccrual,
  ACCRUAL_CAP_WINDOW_MS,
  loadAttribution,
} = attribution;

after(() => { try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch { /* best effort */ } });

let seq = 0;
function uid() { return `acc_aud19_${++seq}_${Math.random().toString(36).slice(2, 8)}`; }

// ─── 1. Credit lots: unit price recorded and returned ───────────────────────────
describe('credit lots: unit price travels with the credit', () => {
  it('addPurchasedCredits records a lot; deductCredit returns its unit_price_usd', async () => {
    const id = uid();
    await addPurchasedCredits(id, 0, 5, { unlock_unit_price_usd: 0.10 });
    const r = await deductCredit(id, 'unlock');
    assert.equal(r.success, true);
    assert.equal(r.unit_price_usd, 0.10);
    assert.equal(r.remaining, 4);
  });

  it('starter-pack math: $10 / 80 unlocks = $0.125 per consumed credit', async () => {
    const id = uid();
    await addPurchasedCredits(id, 400, 80, { unlock_unit_price_usd: 10 / 80 });
    const r = await deductCredit(id, 'unlock');
    assert.equal(r.unit_price_usd, 0.125);
  });

  it('referral grant lot ($0) burns the credit, serves success, and prices at $0.00', async () => {
    const id = uid();
    await addPurchasedCredits(id, 0, 40, { unlock_unit_price_usd: 0 });
    const r = await deductCredit(id, 'unlock');
    assert.equal(r.success, true, 'the buyer still gets their unlock');
    assert.equal(r.unit_price_usd, 0, 'referral lots accrue on a $0 basis');
    const store = loadCredits();
    assert.equal(store[id].purchased_unlocks, 39, 'the credit still burned');
  });

  it('CREDITS-QUERIES-RESIDUAL: query deductions are rejected outright, lots and unlock pool untouched', async () => {
    const id = uid();
    await addPurchasedCredits(id, 2, 1, { unlock_unit_price_usd: 0.10 });
    const q = await deductCredit(id, 'query');
    assert.equal(q.success, false, 'query credits are retired — deductCredit rejects the type');
    assert.equal(q.unit_price_usd, undefined);
    const store = loadCredits();
    assert.equal(store[id].purchased_unlocks, 1, 'unlock pool untouched by the rejected query deduct');
    assert.equal(store[id].purchased_queries, 2, 'legacy purchased_queries balance untouched by the rejection');
  });
});

// ─── 2. Paid-lots-first ordering (decision-doc test 7 pin) ──────────────────────
describe('lot consumption order: paid lots before $0 grant lots', () => {
  it('grant-then-paid insertion still consumes the paid lot first', async () => {
    const id = uid();
    await addPurchasedCredits(id, 0, 2, { unlock_unit_price_usd: 0 });     // referral grant first
    await addPurchasedCredits(id, 0, 2, { unlock_unit_price_usd: 0.125 }); // then a paid pack
    assert.equal((await deductCredit(id, 'unlock')).unit_price_usd, 0.125);
    assert.equal((await deductCredit(id, 'unlock')).unit_price_usd, 0.125);
    // paid exhausted — now the freebies
    assert.equal((await deductCredit(id, 'unlock')).unit_price_usd, 0);
    assert.equal((await deductCredit(id, 'unlock')).unit_price_usd, 0);
    assert.equal((await deductCredit(id, 'unlock')).success, false, 'all burned');
  });

  it('FIFO among paid lots (pure record)', () => {
    const record = { purchased_unlocks: 3, unlock_lots: [
      { unit_price_usd: 0.125, remaining: 1 },
      { unit_price_usd: 0.10, remaining: 2 },
    ] };
    assert.equal(consumeUnlockLot(record), 0.125);
    assert.equal(consumeUnlockLot(record), 0.10);
  });
});

// ─── 3. Legacy (pre-lot) migration ──────────────────────────────────────────────
describe('legacy migration: pre-lot balances get a derived-price lot on first touch', () => {
  it('no purchase history → default $0.10 lot', async () => {
    const id = uid();
    // Simulate a pre-AUD19-2 record: a raw count, no lots.
    const store = loadCredits();
    store[id] = {
      queries_used: 0, unlocks_used: 0,
      purchased_queries: 0, purchased_unlocks: 3,
      period_start: new Date(Date.now() - 1000).toISOString(),
      period_end: new Date(Date.now() + 86400000).toISOString(),
      created_at: Date.now(), last_deducted_at: null,
    };
    credits.saveCredits(store);
    const r = await deductCredit(id, 'unlock');
    assert.equal(r.success, true);
    assert.equal(r.unit_price_usd, DEFAULT_UNLOCK_UNIT_PRICE_USD);
    const after1 = loadCredits()[id];
    assert.ok(Array.isArray(after1.unlock_lots), 'migration persisted lazily on first touch');
    assert.equal(after1.unlock_lots[0].legacy, true);
  });

  it('purchase history present → unit derived as Σ amount_usd / Σ unlocks_added', () => {
    // Monkey-patch the lazily-required stripe helper — no disk, no real purchases.jsonl.
    const stripe = require('../lib/stripe.js');
    const orig = stripe.getPurchasesForAccount;
    try {
      stripe.getPurchasesForAccount = () => [
        { amount_usd: 10, unlocks_added: 80 }, // starter
      ];
      assert.equal(deriveLegacyUnitPrice('acc_whatever'), 0.125);
      stripe.getPurchasesForAccount = () => [];
      assert.equal(deriveLegacyUnitPrice('acc_whatever'), DEFAULT_UNLOCK_UNIT_PRICE_USD);
    } finally {
      stripe.getPurchasesForAccount = orig;
    }
  });

  it('lot/count invariant holds after mixed operations', async () => {
    const id = uid();
    await addPurchasedCredits(id, 0, 3, { unlock_unit_price_usd: 0.10 });
    await deductCredit(id, 'unlock');
    await addPurchasedCredits(id, 0, 2, { unlock_unit_price_usd: 0 });
    await deductCredit(id, 'unlock');
    const rec = loadCredits()[id];
    const lotTotal = rec.unlock_lots.reduce((s, l) => s + l.remaining, 0);
    assert.equal(lotTotal, rec.purchased_unlocks, 'sum(lots.remaining) === purchased_unlocks');
    assert.equal(rec.purchased_unlocks, 3);
  });

  it('ensureUnlockLots trims excess lots down to the authoritative count (defensive)', () => {
    const record = { purchased_unlocks: 1, unlock_lots: [
      { unit_price_usd: 0.10, remaining: 2 },
      { unit_price_usd: 0, remaining: 3 },
    ] };
    ensureUnlockLots(record, 'acc_none');
    const lotTotal = record.unlock_lots.reduce((s, l) => s + l.remaining, 0);
    assert.equal(lotTotal, 1);
  });
});

// ─── 4. Accrual cap store ───────────────────────────────────────────────────────
describe('per-(buyer, learning) accrual cap — 1 credited accrual / 30 days', () => {
  it('fresh pair is not capped; after recordAccrual it is capped within the window', () => {
    const buyer = uid();
    assert.equal(isAccrualCapped(buyer, 'lrn_a'), false);
    recordAccrual(buyer, 'lrn_a');
    assert.equal(isAccrualCapped(buyer, 'lrn_a'), true);
  });

  it('cap expires after the 30-day window and expired entries are pruned on write', () => {
    const buyer = uid();
    const t0 = Date.now();
    recordAccrual(buyer, 'lrn_old', t0);
    const later = t0 + ACCRUAL_CAP_WINDOW_MS + 1;
    assert.equal(isAccrualCapped(buyer, 'lrn_old', later), false, 'window elapsed → accrues again');
    // Any later write prunes the stale entry.
    recordAccrual(uid(), 'lrn_other', later);
    const map = loadAttribution();
    assert.equal(map[`${buyer}:lrn_old`], undefined, 'expired entry pruned');
  });

  it('cap is keyed per (buyer, learning) — never bleeds across buyers or learnings', () => {
    const a = uid(), b = uid();
    recordAccrual(a, 'lrn_x');
    assert.equal(isAccrualCapped(b, 'lrn_x'), false, 'distinct buyer not capped');
    assert.equal(isAccrualCapped(a, 'lrn_y'), false, 'distinct learning not capped');
  });

  it('missing identity never caps (fails open — basis fix is the primary control)', () => {
    assert.equal(isAccrualCapped(null, 'lrn_x'), false);
    assert.equal(isAccrualCapped('acc_x', null), false);
  });

  it('the record survives a reload from disk (restart safety)', () => {
    const buyer = uid();
    recordAccrual(buyer, 'lrn_restart');
    const raw = JSON.parse(fs.readFileSync(process.env.AUXILO_UNLOCK_ATTRIBUTION_FILE, 'utf8'));
    assert.equal(typeof raw[`${buyer}:lrn_restart`], 'number', 'persisted, enforceable across restarts');
  });
});

// ─── 5. Server wiring (structural — same approach as the CP-6 suite) ────────────
const SERVER_SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf-8');

function unlockHandlerSlice() {
  const start = SERVER_SRC.indexOf("app.get('/knowledge/:id'");
  const end = SERVER_SRC.indexOf("app.post('/knowledge/:id/rate'", start);
  assert.ok(start !== -1 && end !== -1);
  return SERVER_SRC.slice(start, end);
}

describe('server.js: accrual basis = min(list, credit unit price), credit path only', () => {
  let h;
  // CH-7: computed in before() — a failed slice exits 1, never fail-0/exit-0.
  before(() => { h = unlockHandlerSlice(); });

  it('basis is min(UNLOCK_PRICE, creditUnit) on the credit path, UNLOCK_PRICE otherwise (x402/router unchanged)', () => {
    assert.ok(/const accrualBasis = \(fundingSource === 'credit_pack'\)\s*\n\s*\? Math\.min\(UNLOCK_PRICE,/.test(h),
      'credit path takes min(list, unit)');
    assert.ok(/: UNLOCK_PRICE;/.test(h), 'x402/router basis stays the list price by construction');
  });

  it('funding source distinguishes router / credit_pack / x402', () => {
    assert.ok(/const fundingSource = routerSettlement \? 'router'\s*\n\s*: \(c\.get\('authMethod'\) === 'api_key' \? 'credit_pack' : 'x402'\);/.test(h));
  });

  it('contributor/platform earned are computed from the PAID basis (70/60 selection untouched)', () => {
    assert.ok(h.includes('const contributorEarned = accrualBasis * CONTRIBUTOR_SHARE;'));
    assert.ok(h.includes('const platformEarned = accrualBasis * (1 - CONTRIBUTOR_SHARE);'));
    assert.ok(SERVER_SRC.includes("const CONTRIBUTOR_SHARE = (source === 'search') ? CONTRIBUTOR_SHARE_DISCOVERY : CONTRIBUTOR_SHARE_STANDARD;"),
      'discovery-share selection unchanged');
  });

  it('all three gross booking sites book the basis, not the list price (cash-true ledger)', () => {
    assert.ok(h.includes('learning.earnings.gross_usd = (learning.earnings.gross_usd || 0) + accrualBasis;'));
    assert.ok(h.includes('activeEntry.total_gross += accrualBasis;'));
    assert.ok(h.includes('by_learning[id].gross += accrualBasis;'));
    assert.ok(!h.includes('total_gross += UNLOCK_PRICE'), 'no list-price gross booking remains');
  });

  it('dualAuthDynamic surfaces the consumed credit unit price to the handler', () => {
    assert.ok(/c\.set\('creditUnitPrice', creditResult\.unit_price_usd\);/.test(SERVER_SRC));
  });
});

describe('server.js: per-(buyer, learning) accrual cap wiring', () => {
  let h;
  before(() => { h = unlockHandlerSlice(); });

  it('cap consulted only on the credit path with a known buyer', () => {
    assert.ok(/const accrualCapped = \(fundingSource === 'credit_pack'\) && !!buyerAccountId\s*\n\s*&& isAccrualCapped\(buyerAccountId, id\);/.test(h));
  });

  it('capped repeat serves content, accrues $0, writes no WAL', () => {
    const capBlock = h.slice(h.indexOf('if (accrualCapped) {'), h.indexOf('learning.earnings.gross_usd'));
    assert.ok(capBlock.length > 0, 'capped early-return exists before any earnings mutation');
    assert.ok(capBlock.includes('safeWrite(LEARNINGS_FILE, learnings)'), 'persists the unlock counter');
    assert.ok(capBlock.includes('accrual_capped: true'), 'response flags the capped accrual');
    assert.ok(capBlock.includes('contributor_earned_usd: 0'), 'contributor accrues nothing');
    assert.ok(!capBlock.includes('createWalEntry'), 'no WAL for a $0 accrual');
    assert.ok(!capBlock.includes('pending_balance'), 'no ledger credit of any kind');
  });

  it('capped and self unlocks do not pump the demand counters (Wave 2b: gated on countersCredited)', () => {
    // Wave 2b task-#13(b) strengthened the gate: demand (and the credited
    // ranking counter) bump only when !accrualCapped && !isSelfUnlock.
    assert.ok(h.includes('const countersCredited = !accrualCapped && !isSelfUnlock;'),
      'the credited predicate must combine the cap AND the wash guard');
    assert.ok(/if \(countersCredited\) \{\s*\n\s*learning\.quality\.unlocks = \(learning\.quality\.unlocks \|\| 0\) \+ 1;\s*\n\s*learning\.demand\.unlocks_7d\+\+;\s*\n\s*learning\.demand\.unlocks_30d\+\+;\s*\n\s*\}/.test(h),
      'ranking counter + demand increments are gated on countersCredited');
  });

  it('the accrual is recorded against the cap BEFORE the WAL write (crash-conservative)', () => {
    const rec = h.indexOf('recordAccrual(buyerAccountId, id);');
    const wal = h.indexOf("createWalEntry('unlock'");
    assert.ok(rec !== -1 && wal !== -1 && rec < wal);
    assert.ok(/if \(fundingSource === 'credit_pack' && buyerAccountId\) \{\s*\n\s*recordAccrual\(buyerAccountId, id\);/.test(h),
      'recorded only for credit-path accruals');
  });

  it('cap sits AFTER the M-2 wash guard (self-unlock precedence unchanged)', () => {
    const self = h.indexOf('if (isSelfUnlock) {');
    const cap = h.indexOf('if (accrualCapped) {');
    assert.ok(self !== -1 && cap !== -1 && self < cap);
  });
});

describe('server.js: M-2 wash guard uses the POST-auth buyer identity', () => {
  let h;
  before(() => { h = unlockHandlerSlice(); });

  it('buyerAccountId is re-read after dualAuthDynamic (the pre-auth read is null on the credit path)', () => {
    const auth = h.indexOf('await dualAuthDynamic(');
    const buyer = h.indexOf("const buyerAccountId = c.get('accountId')");
    assert.ok(auth !== -1 && buyer !== -1 && auth < buyer,
      'identity must be read after authentication sets accountId');
  });

  it('the self-unlock account arm compares buyerAccountId', () => {
    assert.ok(/\(buyerAccountId && contribAccountId && buyerAccountId === contribAccountId\)/.test(h));
    assert.ok(h.includes('if (isSelfUnlock) {'), 'M-2 guard intact');
  });
});

describe('server.js: WAL determinism (forward-only cutover)', () => {
  it('WAL payload stores the basis + funding source + purchaser identity', () => {
    const h = unlockHandlerSlice();
    for (const field of ['amount_paid_usd: accrualBasis', 'funding_source: fundingSource',
      'purchaser_account_id: buyerAccountId', 'purchaser_ip_redacted:', 'purchaser_ua:']) {
      assert.ok(h.includes(field), `WAL payload must carry ${field}`);
    }
  });

  it('replayUnlock books gross from the STORED amount_paid_usd, never recomputes', () => {
    const r = SERVER_SRC.slice(SERVER_SRC.indexOf('function replayUnlock(entry)'), SERVER_SRC.indexOf('function replayPipelineApprove'));
    assert.ok(r.includes("const grossAmount = (typeof amount_paid_usd === 'number') ? amount_paid_usd : unlock_price;"),
      'stored basis when present; pre-cutover entries fall back to unlock_price unchanged');
    assert.ok(r.includes('total_gross += grossAmount'));
    assert.ok(r.includes('by_learning[learning_id].gross += grossAmount'));
    assert.ok(r.includes('pending_balance += contributor_earned'),
      'contributor amounts still replayed verbatim from the stored payload');
    assert.ok(!/accrualBasis/.test(r) && !/Math\.min\(/.test(r) && !/getCurrentPrice/.test(r),
      'replay never recomputes a basis from price or credits');
  });

  it('CP-6 interplay: held-vs-pending routing credits the SAME capped/based contributorEarned in both branches', () => {
    const h = unlockHandlerSlice();
    assert.ok(h.includes('activeEntry.pending_balance += contributorEarned;'));
    assert.ok(h.includes('activeEntry.unassented_pending = (activeEntry.unassented_pending || 0) + contributorEarned;'));
    assert.ok(h.includes('agency_in_force: agencyInForce'), 'CP-6 WAL field untouched');
  });
});

describe('server.js: $0 referral lots + pack pricing at the grant sites', () => {
  it('both referral grant sites mint $0-revenue lots', () => {
    const grants = SERVER_SRC.match(/addPurchasedCredits\((referee_account_id|referrerId), 0, 40, \{ unlock_unit_price_usd: 0 \}\)/g) || [];
    assert.equal(grants.length, 2, 'referee + referrer grants both carry unit_price 0');
  });

  it('the Stripe webhook lots unlocks at the pack pro-rata unit price', () => {
    assert.ok(/PACKS\[pack_id\]\.price_usd \/ unlocks/.test(SERVER_SRC));
    // CREDITS-QUERIES-RESIDUAL: the webhook now always passes 0 for the
    // retired queries argument (packs grant unlocks only).
    assert.ok(/addPurchasedCredits\(account_id, 0, unlocks, \{ unlock_unit_price_usd: unlockUnitPrice \}\)/.test(SERVER_SRC));
  });
});
