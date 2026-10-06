'use strict';

/**
 * test/credits-one-balance.test.js — the follow-up unit that removes the old
 * unit-credit model and the CREDITS_AS_CASH_ENABLED switch (SITE-PM,
 * 2026-09-27, "let's make credits same as cash", final state, one model).
 *
 * Proves, fresh, the behaviour F-1 through F-3 and F-7 of that unit require:
 *   - F-1: the switch is gone; a pack purchase always creates a paid dollar
 *     lot; the Checkout description always states dollars.
 *   - F-2: a grant always creates a promotional dollar lot.
 *   - F-3: no code path creates a unit lot.
 *   - F-7: GET /account/credits reports dollars only; a purchase record
 *     carries no unit field; a leftover record with old unit fields is
 *     reported as its dollar balance only, and an unlock against it with no
 *     dollar lot gets the insufficient-balance response.
 *
 * Every data file this suite touches is redirected to a private temp
 * directory before any module loads, same idiom as the other AUD-CAC suites.
 * No network call, no real Stripe SDK, no real HOME.
 *
 * Runner: node --test test/credits-one-balance.test.js
 */

const os = require('os');
const fs = require('fs');
const path = require('path');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'credits-one-balance-'));
process.env.AUXILO_CREDITS_FILE = path.join(TMP_DIR, 'credits.json');
process.env.AUXILO_ACCOUNT_HOLDS_FILE = path.join(TMP_DIR, 'account-holds.json');
process.env.AUXILO_PURCHASES_FILE = path.join(TMP_DIR, 'purchases.jsonl');

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const {
  deductCredit,
  addDollarLot,
  summarizeCreditBalance,
  getCreditStatus,
  loadCredits,
  saveCredits,
} = require('../lib/credits.js');

after(() => { try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch { /* best effort */ } });

let seq = 0;
function uid() { return `acc_one_balance_${++seq}_${Math.random().toString(36).slice(2, 8)}`; }

const REPO_ROOT = path.join(__dirname, '..');
const SERVER_SRC = fs.readFileSync(path.join(REPO_ROOT, 'server.js'), 'utf-8');
const STRIPE_LIB_SRC = fs.readFileSync(path.join(REPO_ROOT, 'lib', 'stripe.js'), 'utf-8');
const DISPATCH_SRC = fs.readFileSync(path.join(REPO_ROOT, 'lib', 'stripe-event-dispatch.js'), 'utf8');
const CREDITS_SRC = fs.readFileSync(path.join(REPO_ROOT, 'lib', 'credits.js'), 'utf-8');

// ─── F-1: the switch is gone; a pack purchase always creates a dollar lot ──

describe('F-1: the switch is gone, there is one model', () => {
  it('lib/credits-flag.js no longer exists', () => {
    assert.ok(!fs.existsSync(path.join(REPO_ROOT, 'lib', 'credits-flag.js')));
  });

  it('nothing in server.js or lib/ reads CREDITS_AS_CASH_ENABLED or names the switch', () => {
    assert.ok(!SERVER_SRC.includes('CREDITS_AS_CASH_ENABLED'));
    assert.ok(!SERVER_SRC.includes('creditsAsCashEnabled'));
    assert.ok(!SERVER_SRC.includes('credits-flag'));
  });

  it('the dashboard/pricing pack-data injection no longer carries window.__AUXILO_CREDITS_AS_CASH__', () => {
    assert.ok(!SERVER_SRC.includes('__AUXILO_CREDITS_AS_CASH__'));
  });

  it('createCheckoutSession takes no lot-kind argument and its description always states dollars added to the balance', () => {
    assert.ok(STRIPE_LIB_SRC.includes('async function createCheckoutSession(accountId, packId, baseUrl, { context, idempotencyKey, intentId } = {}) {'),
      'no 4th lotKind parameter remains');
    assert.ok(STRIPE_LIB_SRC.includes('const description = `$${pack.price_usd.toFixed(2)} added to your Auxilo balance`;'),
      'the description is always the dollar-balance wording, unconditionally');
    assert.ok(!STRIPE_LIB_SRC.includes('${pack.unlocks} unlocks`'),
      'no unit-lot description branch survives');
  });

  it('the session metadata carries only account_id and pack_id — no lot_kind, no pack_unlocks stamp', () => {
    const start = STRIPE_LIB_SRC.indexOf('metadata: {');
    const end = STRIPE_LIB_SRC.indexOf('}', start);
    const metadataBlock = STRIPE_LIB_SRC.slice(start, end);
    assert.ok(!metadataBlock.includes('lot_kind'));
    assert.ok(!metadataBlock.includes('pack_unlocks'));
    assert.ok(metadataBlock.includes('account_id: accountId,'));
    assert.ok(metadataBlock.includes('pack_id: pack.id,'));
  });

  it('the webhook always calls addDollarLot for a completed checkout session — never a unit-lot branch', () => {
    const webhookBlock = DISPATCH_SRC;
    assert.ok(webhookBlock.includes("addDollarLot(owner,'dollar_paid',pack.price_usd"));
    assert.ok(!webhookBlock.includes('isDollarLot'), 'no branch on lot kind remains');
  });
});

// ─── F-2: a grant always creates a promotional dollar lot ──────────────────

describe('F-2: a grant creates a promotional dollar lot', () => {
  it('both referral grant call sites in server.js create a $5.00 promotional dollar lot', () => {
    assert.match(SERVER_SRC, /await addDollarLot\(referee_account_id, 'dollar_promo', REFEREE_CREDIT_USD\);/);
    assert.match(SERVER_SRC, /await addDollarLot\(referrerId, 'dollar_promo', REFERRER_CREDIT_USD\);/);
    assert.match(SERVER_SRC, /const REFERRER_CREDIT_USD = 5;/);
    assert.match(SERVER_SRC, /const REFEREE_CREDIT_USD = 5;/);
  });

  it('a $5.00 grant lands as a real promotional dollar lot that accrues nothing when spent', async () => {
    const id = uid();
    const grant = await addDollarLot(id, 'dollar_promo', 5);
    assert.equal(grant.success, true);
    assert.equal(grant.kind, 'dollar_promo');
    const balance = summarizeCreditBalance(loadCredits()[id]);
    assert.equal(balance.promo_usd, 5);
    assert.equal(balance.paid_usd, 0);
    assert.equal(balance.total_usd, 5);

    const draw = await deductCredit(id, 'unlock', 1.16);
    assert.equal(draw.success, true);
    assert.equal(draw.paid_drawn, 0, 'a promotional grant funds delivery but is never a paid draw');
    assert.equal(draw.promo_drawn, 1.16);
  });
});

// ─── F-3: no code path creates a unit lot ───────────────────────────────────

describe('F-3: no code path creates a unit lot (structural)', () => {
  it('lib/credits.js exports no function that creates or spends a unit lot', () => {
    for (const gone of ['addPurchasedCredits', 'refundCredit', 'ensureUnlockLots', 'consumeUnlockLot', 'deriveLegacyUnitPrice']) {
      assert.ok(!CREDITS_SRC.includes(`function ${gone}(`), `${gone} must not exist — it created or spent a unit lot`);
    }
    assert.ok(!CREDITS_SRC.includes('unlock_lots'), 'no code in lib/credits.js reads or writes unlock_lots anymore');
  });

  it('server.js never calls addPurchasedCredits and never writes an unlock_lots array', () => {
    assert.ok(!SERVER_SRC.includes('addPurchasedCredits('));
    assert.ok(!SERVER_SRC.includes('unlock_lots'));
  });

  it('addDollarLot has exactly three call sites in server.js: the webhook and the two referral grants', () => {
    const callSites = ((SERVER_SRC + DISPATCH_SRC).match(/await addDollarLot\(/g) || []).length;
    assert.equal(callSites, 3);
  });

  it('deductCredit debits dollar lots only — no unit-lot branch remains in its source', () => {
    const start = CREDITS_SRC.indexOf('async function deductCredit(');
    const end = CREDITS_SRC.indexOf('\n// ─── Credit Status', start);
    const fnSrc = CREDITS_SRC.slice(start, end);
    assert.ok(fnSrc.includes('debitDollarLots('));
    assert.ok(!fnSrc.includes('purchased_unlocks'));
    assert.ok(!fnSrc.includes('lot_kind'));
  });
});

// ─── F-7: reporting is dollars only ─────────────────────────────────────────

describe('F-7: GET /account/credits and GET /account/purchases report dollars only', () => {
  it('getCreditStatus (the /account/credits shape) has no unit count fields, only credit_balance/period/plan', () => {
    const id = uid();
    const status = getCreditStatus(id);
    assert.deepEqual(Object.keys(status).sort(), ['credit_balance', 'period', 'plan'].sort());
    // L3: frozen_usd is now reported alongside the other three figures.
    assert.deepEqual(Object.keys(status.credit_balance).sort(), ['paid_usd', 'promo_usd', 'total_usd', 'frozen_usd'].sort());
  });

  it('a real balance reports paid, promotional, and total spendable, all real dollar numbers', async () => {
    const id = uid();
    await addDollarLot(id, 'dollar_paid', 12.5);
    await addDollarLot(id, 'dollar_promo', 5);
    const status = getCreditStatus(id);
    assert.equal(status.credit_balance.paid_usd, 12.5);
    assert.equal(status.credit_balance.promo_usd, 5);
    assert.equal(status.credit_balance.total_usd, 17.5);
  });

  it('the /account/purchases response mapping in server.js carries no unlocks_added or other unit field', () => {
    const start = SERVER_SRC.indexOf("app.get('/account/purchases'");
    const end = SERVER_SRC.indexOf('\napp.', start + 10);
    const routeSrc = SERVER_SRC.slice(start, end);
    assert.ok(!routeSrc.includes('unlocks_added'));
    assert.ok(routeSrc.includes('amount_usd: p.amount_usd,'));
  });

  it('a new purchase record written by the webhook carries no unlocks_added or unit field', () => {
    const start = DISPATCH_SRC.indexOf('const purchase=');
    const end = DISPATCH_SRC.indexOf('appendPurchase(purchase);', start);
    const purchaseSrc = DISPATCH_SRC.slice(start, end);
    assert.ok(!purchaseSrc.includes('unlocks_added'));
    assert.ok(purchaseSrc.includes('amount_usd:pack.price_usd,'));
  });

  it('a record left over from before, carrying unit fields, is reported as its dollar balance only', () => {
    const id = uid();
    const credits = loadCredits();
    credits[id] = {
      queries_used: 0,
      unlocks_used: 3,
      purchased_queries: 0,
      purchased_unlocks: 5,
      unlock_lots: [{ unit_price_usd: 0.10, remaining: 5, added_at: Date.now() }],
      period_start: new Date(Date.now() - 1000).toISOString(),
      period_end: new Date(Date.now() + 86400000).toISOString(),
      created_at: Date.now(),
      last_deducted_at: null,
    };
    saveCredits(credits);

    const status = getCreditStatus(id);
    assert.deepEqual(status.credit_balance, { paid_usd: 0, promo_usd: 0, total_usd: 0, frozen_usd: 0 },
      'the leftover unit fields are never read into the reported balance');
  });

  it('an unlock against a leftover-unit-fields record with no dollar lot gets the insufficient balance response, and the leftover fields are untouched on disk', async () => {
    const id = uid();
    const credits = loadCredits();
    credits[id] = {
      queries_used: 0,
      unlocks_used: 0,
      purchased_queries: 0,
      purchased_unlocks: 5,
      unlock_lots: [{ unit_price_usd: 0.10, remaining: 5, added_at: Date.now() }],
      period_start: new Date(Date.now() - 1000).toISOString(),
      period_end: new Date(Date.now() + 86400000).toISOString(),
      created_at: Date.now(),
      last_deducted_at: null,
    };
    saveCredits(credits);

    const r = await deductCredit(id, 'unlock', 0.86);
    assert.equal(r.success, false);
    assert.match(r.message, /Insufficient balance/);

    const after = loadCredits()[id];
    assert.equal(after.purchased_unlocks, 5, 'the leftover unit count is not deleted');
    assert.equal(after.unlock_lots.length, 1, 'the leftover unit lot is not deleted');
    assert.equal(after.unlock_lots[0].remaining, 5, 'the leftover unit lot is not spent');
  });
});
