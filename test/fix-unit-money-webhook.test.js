'use strict';

/**
 * test/fix-unit-money-webhook.test.js — FIX-UNIT-MONEY ruling L10.
 *
 * "No test drives the three new webhook branches or the webhook's second
 * cap check through POST /webhook/stripe; the handlers are called
 * directly." This file closes that gap: every event here is POSTed to the
 * REAL POST /webhook/stripe route on a staged live server, signed with
 * Stripe.webhooks.generateTestHeaderString — a pure local HMAC computation,
 * no network call, no real Stripe SDK call. STRIPE_SECRET_KEY is set to a
 * deliberately malformed placeholder (fails lib/stripe.js's own format
 * check), so the server's boot-time usability probe never fires a live
 * request to Stripe's API; STRIPE_WEBHOOK_SECRET is a real, valid-shaped
 * test secret so signature verification (pure local crypto) succeeds.
 *
 * Also covers ruling M3 (both purchase caps count pending Checkout
 * sessions, through the real POST /checkout/session pre-check) and ruling
 * M4 (the admin hold-clearance route), both through the real server.
 *
 * A local staged server only, on a free reserved port, via
 * test/helpers/staged-server.js. Never port 3000, never the live site,
 * never a real Stripe call, never a real purchase.
 *
 * Runner: node --test test/fix-unit-money-webhook.test.js
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Stripe = require('stripe');
const { SignJWT } = require('jose');
const {
  bootServer,
  reservePort,
  stageServer,
  stopServer,
} = require('./helpers/staged-server');

const REPO = path.join(__dirname, '..');
const { CURRENT_TOS_VERSION } = require('../lib/accounts.js');

const SESSION_SECRET = 'fix-unit-money-webhook-test-session-secret';
// Known test mode with deliberately malformed key length. The staged-only
// registry below uses an explicit fake client; no test reaches Stripe's API.
const FAKE_SECRET_KEY = 'sk_test_bad';
const WEBHOOK_SECRET = 'whsec_' + 'f'.repeat(32);

const BUYER_ID = 'acc_fum_buyer';
// A separate account holds the pre-seeded funded lots the H1/H2 tests
// reverse against, so resetAccountCredits(BUYER_ID) (used by the
// checkout-credit tests) never touches them.
const LOTS_ACCOUNT_ID = 'acc_fum_lots';
const CONTRIB_ID = 'acc_fum_contrib';
const CONTRIB_WALLET = '0x' + '5'.repeat(40);
const FIXED_AT = '2026-09-27T00:00:00.000Z';
const platformContext = { stripe_platform: 'legacy', stripe_platform_account_id: 'acct_1TCbMe0Jj0R41QQV', mode: 'test', livemode: false };
let originStore;

// server.js loads earnings.json into an in-memory object ONCE at boot and
// only ever writes it back on its own mutations -- a file write to
// earnings.json AFTER boot is invisible to the running process. Every
// funded lot this suite needs (a lot whose history a refund/dispute test
// must reverse) is therefore pre-seeded, alongside its matching earnings
// entry, into the FIXTURE files written BEFORE bootServer() starts. Each
// test reads its own known payment_intent and compares a before/after
// DELTA on the shared CONTRIB_ID entry (the same pattern
// test/credits-as-cash-unlock.test.js already uses for a shared boot).
const PI_H1_PARTIAL_REFUND = 'pi_fum_fixture_h1';
const PI_H2_LOST = 'pi_fum_fixture_h2_lost';
const PI_H2_WARNING_CLOSED = 'pi_fum_fixture_h2_wc';

function fundedLotFixture(paymentIntent, originalUsd, unlocks) {
  let spent = 0;
  const funded_unlocks = unlocks.map((u) => {
    spent += u.paidDrawn;
    return {
      learning_id: u.learningId, contributor_account_id: u.builderAccountId, contributor_wallet: null,
      contributor_amount: u.contributorEarned, platform_amount: u.platformEarned, reversed: false, ts: FIXED_AT,
    };
  });
  return {
    lot_id: 'lot_' + paymentIntent, kind: 'dollar_paid', purchase_id: 'pur_' + paymentIntent,
    ...platformContext, stripe_payment_intent: paymentIntent, purchased_at: FIXED_AT, last_activity_at: FIXED_AT,
    frozen: false, frozen_at: null, frozen_reason: null,
    original_usd: originalUsd, remaining_usd: originalUsd - spent, funded_unlocks,
  };
}

function applyToEarnings(earnings, builderAccountId, learningId, contributorEarned, platformEarned) {
  if (!earnings[builderAccountId]) {
    earnings[builderAccountId] = {
      account_id: builderAccountId, wallet: null, total_gross: 0, total_contributor: 0, total_platform: 0,
      by_learning: {}, last_updated: null, pending_balance: 0, unassented_pending: 0, total_withdrawn: 0,
      withdrawal_count: 0, processed_settlements: [],
    };
  }
  const e = earnings[builderAccountId];
  e.pending_balance += contributorEarned;
  e.total_contributor += contributorEarned;
  e.total_platform += platformEarned;
  e.total_gross += contributorEarned + platformEarned;
  e.by_learning[learningId] = e.by_learning[learningId] || { gross: 0, contributor: 0, platform: 0, unlocks: 0 };
  e.by_learning[learningId].gross += contributorEarned + platformEarned;
  e.by_learning[learningId].contributor += contributorEarned;
  e.by_learning[learningId].platform += platformEarned;
  e.by_learning[learningId].unlocks += 1;
}

function signedWebhookEvent(payloadObj) {
  const payload = JSON.stringify(payloadObj);
  const header = Stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
  return { payload, header };
}

function writeJson(file, value) { fs.writeFileSync(file, JSON.stringify(value, null, 2)); }

// Reads checkout-sessions.json straight off disk (the same file
// lib/checkout-sessions.js reads/writes) and sums amount_usd for one
// account's unexpired entries -- used to prove nothing is left dangling
// after a burst of requests all resolve.
function checkoutSessionsTotalFor(dataDir, accountId) {
  const file = path.join(dataDir, 'checkout-sessions.json');
  if (!fs.existsSync(file)) return 0;
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  const now = Date.now();
  let total = 0;
  for (const s of Object.values(state)) {
    if (!s || s.account_id !== accountId) continue;
    if (typeof s.expires_at === 'number' && now >= s.expires_at) continue;
    total += s.amount_usd || 0;
  }
  return Math.round((total + Number.EPSILON) * 1e6) / 1e6;
}

async function postJson(url, body, headers = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, body: json, text };
}

async function postWebhook(baseUrl, payloadObj) {
  payloadObj = structuredClone(payloadObj);
  payloadObj.livemode = false;
  const obj = payloadObj.data.object;
  obj.id ||= (payloadObj.type.startsWith('charge.dispute') ? 'dp_' : 'ch_') + obj.payment_intent;
  if (payloadObj.type === 'checkout.session.completed') {
    Object.assign(obj, { object: 'checkout.session', mode: 'payment', payment_status: 'paid', livemode: false, currency: 'usd', amount_total: obj.metadata.pack_id === 'pro' ? 10000 : obj.metadata.pack_id === 'growth' ? 2500 : 1000 });
    if (!originStore.find(platformContext, 'checkout_session', obj.id)) originStore.record({ ...platformContext, object_kind: 'checkout_session', provider_id: obj.id, account_id: obj.metadata.account_id, evidence_ref: 'synthetic-paid-fixture', first_observed_at: FIXED_AT, provenance_version: 1 });
  }
  const { payload, header } = signedWebhookEvent(payloadObj);
  const res = await fetch(`${baseUrl}/webhook/stripe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'stripe-signature': header },
    body: payload,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, body: json, text };
}

async function getJson(url, headers = {}) {
  const res = await fetch(url, { headers });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, body: json, text };
}

describe('FIX-UNIT-MONEY ruling L10: webhook branches + second cap check, ruling M3 pre-check, ruling M4 admin route (staged live server)', { timeout: 180_000 }, () => {
  let tmpDir, child, baseUrl, dataDir, liveSkipReason, buyerToken;

  before(async () => {
    const honoEntry = require.resolve('hono', { paths: [REPO] });
    const nodeModulesDir = honoEntry.slice(0, honoEntry.lastIndexOf(`${path.sep}node_modules${path.sep}`) + '/node_modules'.length);
    const reservation = await reservePort();
    if ('skipReason' in reservation) { liveSkipReason = reservation.skipReason; return; }
    const { port } = reservation;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fum-webhook-'));
    const staged = stageServer({
      repoRoot: REPO, tmpDir, nodeModulesDir, port,
      rootFiles: ['server.js', 'seed-knowledge.json', 'skills.json', 'openapi.json', 'package.json', 'model_config.json'],
      linkDirs: [],
      copyDirs: ['lib', 'public', 'prompts', 'config'],
      replacements: [],
    });
    dataDir = staged.dataDir;
    const manifest = { checkpoint_id: 'synthetic-webhook', manifest_sha256: 'a'.repeat(64), inventory_complete: true, approval_ref: 'synthetic-approval' };
    originStore = require('../lib/stripe-object-origins').initializeOrigins(path.join(dataDir, 'stripe-object-origins.json'), manifest);
    require('../lib/stripe-event-receipts').initializeEventReceipts(path.join(dataDir, 'stripe-event-receipts.json'), manifest);
    require('../lib/stripe-checkout-intents').initializeCheckoutIntents(path.join(dataDir, 'stripe-checkout-intents.json'), manifest);
    fs.writeFileSync(path.join(dataDir, 'purchases.jsonl'), '');
    // A staged-only provider fixture: no production module or environment bypass.
    fs.appendFileSync(path.join(tmpDir, 'lib/stripe-platforms.js'), `
const fakeDir = process.env.AUXILO_DATA_DIR;
module.exports.__setRegistryForTest(module.exports.createPlatformRegistry({
 env: {...process.env, STRIPE_SECRET_KEY: 'sk_test_' + 'f'.repeat(40)},
 clientFactory: () => ({
   accounts: { retrieve: async () => ({id:'acct_1TCbMe0Jj0R41QQV'}) },
   balance: { retrieve: async () => ({livemode:false}) },
   webhooks: require('stripe').webhooks,
   checkout: { sessions: { create: async (params) => {
     require('fs').appendFileSync(require('path').join(fakeDir, 'fake-provider-calls.jsonl'), JSON.stringify({account:params.metadata.account_id})+'\\n');
     if(params.metadata.account_id.startsWith('acc_fum_par_')) throw Error('synthetic response lost');
     return {id:'cs_fixture_'+params.metadata.auxilo_checkout_intent_id.replaceAll('-',''),object:'checkout.session',mode:'payment',payment_status:'unpaid',livemode:false,amount_total:params.line_items[0].price_data.unit_amount,currency:'usd',metadata:params.metadata,expires_at:params.expires_at,url:'https://checkout.example.test/synthetic'};
   } } }
 })
}));
`);

    const now = Date.now();
    const accounts = {
      [BUYER_ID]: {
        id: BUYER_ID, email: 'fum-buyer@test.local', created_at: FIXED_AT,
        tos_version: CURRENT_TOS_VERSION, accepted_at: now, accepted_affirmed: true,
      },
      [CONTRIB_ID]: {
        id: CONTRIB_ID, email: 'fum-contrib@test.local', wallet: CONTRIB_WALLET, created_at: FIXED_AT,
        tos_version: CURRENT_TOS_VERSION, accepted_at: now, accepted_affirmed: true,
      },
      [LOTS_ACCOUNT_ID]: {
        id: LOTS_ACCOUNT_ID, email: 'fum-lots@test.local', created_at: FIXED_AT,
        tos_version: CURRENT_TOS_VERSION, accepted_at: now, accepted_affirmed: true,
      },
    };
    writeJson(path.join(dataDir, 'learnings.json'), []);
    writeJson(path.join(dataDir, 'accounts.json'), accounts);

    // Pre-seed the funded lots this suite's H1/H2 tests reverse against,
    // and CONTRIB_ID's matching earnings entry, BEFORE boot (see the
    // comment at the constants above -- earnings.json is loaded once into
    // memory at boot, so this must exist before the process starts).
    const initialEarnings = {};
    const initialCredits = {
      [LOTS_ACCOUNT_ID]: {
        queries_used: 0, unlocks_used: 0, purchased_queries: 0, purchased_unlocks: 0,
        period_start: '2026-09-01T00:00:00.000Z', period_end: '2099-01-01T00:00:00.000Z',
        created_at: Date.now(), last_deducted_at: null,
        dollar_lots: [
          fundedLotFixture(PI_H1_PARTIAL_REFUND, 100, [
            { learningId: 'lrn_fum_h1', builderAccountId: CONTRIB_ID, paidDrawn: 10, contributorEarned: 7, platformEarned: 3 },
          ]),
          fundedLotFixture(PI_H2_LOST, 10, [
            { learningId: 'lrn_fum_h2', builderAccountId: CONTRIB_ID, paidDrawn: 4, contributorEarned: 2.8, platformEarned: 1.2 },
          ]),
          fundedLotFixture(PI_H2_WARNING_CLOSED, 10, [
            { learningId: 'lrn_fum_wc', builderAccountId: CONTRIB_ID, paidDrawn: 4, contributorEarned: 2.8, platformEarned: 1.2 },
          ]),
        ],
      },
    };
    applyToEarnings(initialEarnings, CONTRIB_ID, 'lrn_fum_h1', 7, 3);
    applyToEarnings(initialEarnings, CONTRIB_ID, 'lrn_fum_h2', 2.8, 1.2);
    applyToEarnings(initialEarnings, CONTRIB_ID, 'lrn_fum_wc', 2.8, 1.2);
    writeJson(path.join(dataDir, 'earnings.json'), initialEarnings);
    writeJson(path.join(dataDir, 'credits.json'), initialCredits);
    writeJson(path.join(dataDir, 'purchase-ledger.json'), {});

    const boot = await bootServer({
      tmpDir, port,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        WALLET_PRIVATE_KEY: `0x${'11'.repeat(32)}`,
        SESSION_SECRET,
        STRIPE_SECRET_KEY: FAKE_SECRET_KEY,
        STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
        AUXILO_DATA_DIR: dataDir,
        AUXILO_ACCOUNTS_FILE: path.join(dataDir, 'accounts.json'),
        AUXILO_CREDITS_FILE: path.join(dataDir, 'credits.json'),
        AUXILO_PURCHASE_LEDGER_FILE: path.join(dataDir, 'purchase-ledger.json'),
        AUXILO_ADMIN_TOKEN: 'fum-admin-test-token-0000000000000000',
      },
      timeoutMs: 60_000, maxAttempts: 3,
    });
    if ('skipReason' in boot) { liveSkipReason = boot.skipReason; return; }
    child = boot.child; baseUrl = boot.baseUrl;

    buyerToken = await new SignJWT({ accountId: BUYER_ID, email: accounts[BUYER_ID].email })
      .setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime('24h').sign(Buffer.from(SESSION_SECRET));
  });

  after(async () => {
    if (child) await stopServer(child);
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function readCredits() { return JSON.parse(fs.readFileSync(path.join(dataDir, 'credits.json'), 'utf8')); }
  function writeCredits(v) { writeJson(path.join(dataDir, 'credits.json'), v); }
  function readEarnings() { return JSON.parse(fs.readFileSync(path.join(dataDir, 'earnings.json'), 'utf8')); }
  function writeEarnings(v) { writeJson(path.join(dataDir, 'earnings.json'), v); }
  function resetAccountCredits(accountId) {
    const credits = readCredits();
    delete credits[accountId];
    writeCredits(credits);
  }

  // ── checkout.session.completed: credits the account for real, through the route ──

  it('checkout.session.completed credits the account through the real webhook route', async (t) => {
    if (liveSkipReason) { t.skip(liveSkipReason); return; }
    resetAccountCredits(BUYER_ID);
    const sessionId = 'cs_fum_' + crypto.randomBytes(6).toString('hex');
    const piId = 'pi_fum_' + crypto.randomBytes(6).toString('hex');
    const res = await postWebhook(baseUrl, {
      id: 'evt_fum_1', type: 'checkout.session.completed',
      data: { object: { id: sessionId, payment_intent: piId, metadata: { account_id: BUYER_ID, pack_id: 'starter' } } },
    });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.processed, true);

    const balance = await getJson(`${baseUrl}/account/credits`, { Authorization: `Bearer ${buyerToken}` });
    assert.equal(balance.status, 200, balance.text);
    assert.equal(balance.body.credit_balance.total_usd, 10);
    assert.equal(balance.body.credit_balance.paid_usd, 10);
    assert.equal(balance.body.credit_balance.frozen_usd, 0);
  });

  // ── ruling M7: a duplicate delivery of the SAME session never double-credits ──

  it('[ruling M7] replaying the SAME checkout.session.completed event never double-credits', async (t) => {
    if (liveSkipReason) { t.skip(liveSkipReason); return; }
    resetAccountCredits(BUYER_ID);
    const sessionId = 'cs_fum_dup_' + crypto.randomBytes(6).toString('hex');
    const piId = 'pi_fum_dup_' + crypto.randomBytes(6).toString('hex');
    const event = {
      id: 'evt_fum_dup', type: 'checkout.session.completed',
      data: { object: { id: sessionId, payment_intent: piId, metadata: { account_id: BUYER_ID, pack_id: 'starter' } } },
    };
    const first = await postWebhook(baseUrl, event);
    assert.equal(first.status, 200, first.text);
    assert.equal(first.body.processed, true);
    const second = await postWebhook(baseUrl, event);
    assert.equal(second.status, 200, second.text);
    assert.equal(second.body.already_processed, true);

    const balance = await getJson(`${baseUrl}/account/credits`, { Authorization: `Bearer ${buyerToken}` });
    assert.equal(balance.body.credit_balance.total_usd, 10, 'exactly one pack credited, never two');
    const credits = readCredits();
    assert.equal(credits[BUYER_ID].dollar_lots.filter((l) => l.stripe_payment_intent === piId).length, 1,
      'exactly one lot exists for this payment_intent');
  });

  // ── charge.refunded (H1): a genuinely partial refund through the real route ──

  it('[ruling H1] charge.refunded with a real amount_refunded removes only the unspent remainder through the real route', async (t) => {
    if (liveSkipReason) { t.skip(liveSkipReason); return; }
    const piId = PI_H1_PARTIAL_REFUND;
    const beforeEarnings = readEarnings()[CONTRIB_ID].pending_balance;

    const res = await postWebhook(baseUrl, {
      id: 'evt_fum_refund', type: 'charge.refunded',
      data: { object: { payment_intent: piId, amount: 10000, amount_refunded: 500, refunded: false } },
    });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.processed, true);

    const credits = readCredits();
    const lot = credits[LOTS_ACCOUNT_ID].dollar_lots.find((l) => l.stripe_payment_intent === piId);
    assert.equal(lot.remaining_usd, 85, '90 remained, $5 refunded, 85 left');
    const afterEarnings = readEarnings()[CONTRIB_ID].pending_balance;
    assert.equal(afterEarnings, beforeEarnings, 'the $5 partial refund never exceeded the $90 that remained -- nothing clawed back');
  });

  // ── charge.dispute.created -> charge.dispute.closed('lost') (H2) ──

  it('[ruling H2] a dispute lost through the real route removes the remainder and reverses the funded share', async (t) => {
    if (liveSkipReason) { t.skip(liveSkipReason); return; }
    const piId = PI_H2_LOST;
    const beforeEarnings = readEarnings()[CONTRIB_ID].pending_balance;

    const created = await postWebhook(baseUrl, {
      id: 'evt_fum_created', type: 'charge.dispute.created',
      data: { object: { payment_intent: piId, status: 'needs_response' } },
    });
    assert.equal(created.status, 200, created.text);
    assert.equal(created.body.processed, true);
    assert.equal(readCredits()[LOTS_ACCOUNT_ID].dollar_lots.find((l) => l.stripe_payment_intent === piId).frozen, true);

    const closed = await postWebhook(baseUrl, {
      id: 'evt_fum_lost', type: 'charge.dispute.closed',
      data: { object: { payment_intent: piId, status: 'lost' } },
    });
    assert.equal(closed.status, 200, closed.text);
    assert.equal(closed.body.processed, true);

    const lot = readCredits()[LOTS_ACCOUNT_ID].dollar_lots.find((l) => l.stripe_payment_intent === piId);
    assert.equal(lot.remaining_usd, 0);
    assert.equal(lot.frozen, false);
    const afterEarnings = readEarnings()[CONTRIB_ID].pending_balance;
    assert.equal(Math.round((beforeEarnings - afterEarnings) * 1e6) / 1e6, 2.8, 'the funded share is reversed in full on a loss');
  });

  // ── ruling H2: warning_closed unfreezes and reverses nothing ──

  it("[ruling H2] an inquiry closed 'warning_closed' through the real route unfreezes and reverses nothing", async (t) => {
    if (liveSkipReason) { t.skip(liveSkipReason); return; }
    const piId = PI_H2_WARNING_CLOSED;
    const beforeEarnings = readEarnings()[CONTRIB_ID].pending_balance;

    await postWebhook(baseUrl, {
      id: 'evt_fum_wc_created', type: 'charge.dispute.created',
      data: { object: { payment_intent: piId, status: 'warning_needs_response' } },
    });
    const closed = await postWebhook(baseUrl, {
      id: 'evt_fum_wc_closed', type: 'charge.dispute.closed',
      data: { object: { payment_intent: piId, status: 'warning_closed' } },
    });
    assert.equal(closed.status, 200, closed.text);
    assert.equal(closed.body.processed, true);

    const lot = readCredits()[LOTS_ACCOUNT_ID].dollar_lots.find((l) => l.stripe_payment_intent === piId);
    assert.equal(lot.frozen, false);
    assert.equal(lot.remaining_usd, 6, 'nothing removed');
    assert.equal(readEarnings()[CONTRIB_ID].pending_balance, beforeEarnings, 'nothing reversed');
  });

  // ── ruling M3: the webhook's second cap check (defense in depth) ──

  it('[ruling M3] the webhook\'s second check holds the account once credited purchases cross the $2,000 balance cap', async (t) => {
    if (liveSkipReason) { t.skip(liveSkipReason); return; }
    const capAccount = 'acc_fum_cap_' + crypto.randomBytes(4).toString('hex');
    const accounts = JSON.parse(fs.readFileSync(path.join(dataDir, 'accounts.json'), 'utf8'));
    accounts[capAccount] = {
      id: capAccount, email: `${capAccount}@test.local`, created_at: FIXED_AT,
      tos_version: CURRENT_TOS_VERSION, accepted_at: Date.now(), accepted_affirmed: true,
    };
    writeJson(path.join(dataDir, 'accounts.json'), accounts);

    // 20 x $100 Pro packs = exactly $2,000 -- allowed. The 21st crosses it.
    for (let i = 0; i < 21; i++) {
      const res = await postWebhook(baseUrl, {
        id: `evt_fum_cap_${i}`, type: 'checkout.session.completed',
        data: {
          object: {
            id: `cs_fum_cap_${i}`, payment_intent: `pi_fum_cap_${i}`,
            metadata: { account_id: capAccount, pack_id: 'pro' },
          },
        },
      });
      assert.equal(res.status, 200, `delivery ${i} must still 200 -- money already collected`);
    }
    // Money was already collected by Stripe each time -- the account must be
    // credited in full (not refused), just held from any FURTHER purchase.
    const capBalance = await getJson(`${baseUrl}/account/credits`, {
      Authorization: `Bearer ${await new SignJWT({ accountId: capAccount, email: accounts[capAccount].email })
        .setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime('24h').sign(Buffer.from(SESSION_SECRET))}`,
    });
    assert.equal(capBalance.body.credit_balance.total_usd, 2100, 'all 21 packs credited in full');

    const heldRes = await postJson(`${baseUrl}/checkout/session`, { pack: 'starter' }, {
      Authorization: `Bearer ${await new SignJWT({ accountId: capAccount, email: accounts[capAccount].email })
        .setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime('24h').sign(Buffer.from(SESSION_SECRET))}`,
    });
    assert.equal(heldRes.status, 403);
    assert.equal(heldRes.body.code, 'ACCOUNT_HELD');
    assert.equal(heldRes.body.reason, 'cap_overage');
  });

  // ── ruling M3: pending, unpaid Checkout sessions count toward the PRE-check ──

  it('[ruling M3] unpaid, unexpired Checkout sessions count toward the pre-check, refusing a purchase before any Stripe call', async (t) => {
    if (liveSkipReason) { t.skip(liveSkipReason); return; }
    const sessAccount = 'acc_fum_sess_' + crypto.randomBytes(4).toString('hex');
    const accounts = JSON.parse(fs.readFileSync(path.join(dataDir, 'accounts.json'), 'utf8'));
    accounts[sessAccount] = {
      id: sessAccount, email: `${sessAccount}@test.local`, created_at: FIXED_AT,
      tos_version: CURRENT_TOS_VERSION, accepted_at: Date.now(), accepted_affirmed: true,
    };
    writeJson(path.join(dataDir, 'accounts.json'), accounts);
    const token = await new SignJWT({ accountId: sessAccount, email: accounts[sessAccount].email })
      .setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime('24h').sign(Buffer.from(SESSION_SECRET));

    // Seed 19 unpaid, unexpired $100 sessions directly (what reservePendingSession
    // / promoteReservation would have written the moment each Checkout
    // session was created or confirmed -- ruling N2's own expires_at, not a
    // fixed window) -- $1,900 pending, none of it a real dollar lot yet.
    const sessions = {};
    for (let i = 0; i < 19; i++) {
      sessions[`cs_fum_pending_${i}`] = { account_id: sessAccount, amount_usd: 100, created_at: Date.now(), expires_at: Date.now() + 35 * 60 * 1000 };
    }
    writeJson(path.join(dataDir, 'checkout-sessions.json'), sessions);

    // A new $100 Pro pack would push the (pending + real) total to $2,000 --
    // still allowed (the balance cap check is "<=", not "<").
    const atCap = await postJson(`${baseUrl}/checkout/session`, { pack: 'pro' }, { Authorization: `Bearer ${token}` });
    // The synthetic provider confirms this Checkout, proving exact-cap
    // admission. A subsequent different pack is still checked against all
    // pending sessions and cannot use the open-session retry shortcut.
    assert.notEqual(atCap.status, 400, 'exactly at the cap must not be refused by the cap check');

    // One more pending session pushes it over -- refused BEFORE any Stripe call.
    sessions.cs_fum_pending_19 = { account_id: sessAccount, amount_usd: 100, created_at: Date.now(), expires_at: Date.now() + 35 * 60 * 1000 };
    writeJson(path.join(dataDir, 'checkout-sessions.json'), sessions);
    const overCap = await postJson(`${baseUrl}/checkout/session`, { pack: 'starter' }, { Authorization: `Bearer ${token}` });
    assert.equal(overCap.status, 400);
    assert.equal(overCap.body.code, 'BALANCE_CAP_EXCEEDED');
    assert.equal(overCap.body.current_usd, 2000, 'the 20 pending sessions ($2,000) are counted even though none has paid yet');
  });

  // ── ruling M4: the admin route clears a hold ──

  it('[ruling M4] the admin route clears an account hold and it stops blocking new purchases', async (t) => {
    if (liveSkipReason) { t.skip(liveSkipReason); return; }
    const holdAccount = 'acc_fum_hold_' + crypto.randomBytes(4).toString('hex');
    const accounts = JSON.parse(fs.readFileSync(path.join(dataDir, 'accounts.json'), 'utf8'));
    accounts[holdAccount] = {
      id: holdAccount, email: `${holdAccount}@test.local`, created_at: FIXED_AT,
      tos_version: CURRENT_TOS_VERSION, accepted_at: Date.now(), accepted_affirmed: true,
    };
    writeJson(path.join(dataDir, 'accounts.json'), accounts);
    const token = await new SignJWT({ accountId: holdAccount, email: accounts[holdAccount].email })
      .setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime('24h').sign(Buffer.from(SESSION_SECRET));

    writeJson(path.join(dataDir, 'account-holds.json'), {
      [holdAccount]: { reason: 'cap_overage', detail: { balance_usd: 2010 }, held_at: FIXED_AT },
    });

    const blocked = await postJson(`${baseUrl}/checkout/session`, { pack: 'starter' }, { Authorization: `Bearer ${token}` });
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.code, 'ACCOUNT_HELD');

    // No admin token at all -- refused.
    const noAuth = await fetch(`${baseUrl}/admin/account-holds/${holdAccount}/clear`, { method: 'POST' });
    assert.equal(noAuth.status, 401);

    const clearRes = await fetch(`${baseUrl}/admin/account-holds/${holdAccount}/clear`, {
      method: 'POST',
      headers: { Authorization: 'Bearer fum-admin-test-token-0000000000000000' },
    });
    const clearBody = await clearRes.json();
    assert.equal(clearRes.status, 200, JSON.stringify(clearBody));
    assert.equal(clearBody.cleared, true);
    assert.equal(clearBody.previous_hold_reason, 'cap_overage');

    const holds = JSON.parse(fs.readFileSync(path.join(dataDir, 'account-holds.json'), 'utf8'));
    assert.equal(holdAccount in holds, false);

    // ruling N9: the durable log gets a line too, not just the (rate-limited,
    // possibly-unconfigured) ops alert.
    const logPath = path.join(dataDir, 'hold-clear-log.jsonl');
    assert.ok(fs.existsSync(logPath), 'the hold-clear log is created on first use');
    const logRows = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const ourRow = logRows.find((r) => r.account_id === holdAccount);
    assert.ok(ourRow, 'a durable row exists for this clear');
    assert.equal(ourRow.reason, 'cap_overage');
    assert.equal(ourRow.admin_scope, 'admin');
    assert.ok(ourRow.cleared_at, 'the time is recorded');

    // A second clear on an already-cleared account finds nothing.
    const secondClear = await fetch(`${baseUrl}/admin/account-holds/${holdAccount}/clear`, {
      method: 'POST',
      headers: { Authorization: 'Bearer fum-admin-test-token-0000000000000000' },
    });
    assert.equal(secondClear.status, 404);
  });

  // ── ruling M3: real concurrent requests exercise the SAME route order,
  // reservation included -- see the note below on why the pass/refuse split
  // itself is proved at the lib level, not by asserting on HTTP status here ──

  it('[ruling M3] 50 REAL parallel POST /checkout/session requests each reserve or refuse under the SAME per-account lock the route uses, never crossing the cap', async (t) => {
    if (liveSkipReason) { t.skip(liveSkipReason); return; }
    // Simulate provider response loss after one call. The durable intent
    // and reservation remain; all queued requests refuse without another call.
    const parAccount = 'acc_fum_par_' + crypto.randomBytes(4).toString('hex');
    const accounts = JSON.parse(fs.readFileSync(path.join(dataDir, 'accounts.json'), 'utf8'));
    accounts[parAccount] = {
      id: parAccount, email: `${parAccount}@test.local`, created_at: FIXED_AT,
      tos_version: CURRENT_TOS_VERSION, accepted_at: Date.now(), accepted_affirmed: true,
    };
    writeJson(path.join(dataDir, 'accounts.json'), accounts);
    const token = await new SignJWT({ accountId: parAccount, email: accounts[parAccount].email })
      .setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime('24h').sign(Buffer.from(SESSION_SECRET));

    const results = await Promise.all(Array.from({ length: 50 }, () =>
      postJson(`${baseUrl}/checkout/session`, { pack: 'pro' }, { Authorization: `Bearer ${token}` })));
    for (const r of results) {
      const isCapRefusal = r.status === 400 && r.body && r.body.code === 'BALANCE_CAP_EXCEEDED';
      const isStripeUnusable = [409,503].includes(r.status) && r.body && r.body.code === 'CHECKOUT_RECONCILIATION_REQUIRED';
      assert.ok(isCapRefusal || isStripeUnusable, `every response is one of the two documented outcomes, got ${r.status} ${JSON.stringify(r.body)}`);
      if (isCapRefusal) assert.ok(r.body.current_usd <= 2000, 'a refusal never reports counting past the cap for this single check');
    }
    // The unresolved reservation remains until authoritative reconciliation.
    assert.equal(checkoutSessionsTotalFor(dataDir, parAccount), 100, 'one unresolved provider attempt retains its reservation');
    const calls = fs.readFileSync(path.join(dataDir, 'fake-provider-calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(calls.filter(row => row.account === parAccount).length, 1, 'all repeated requests make zero additional provider writes');
    const attempts = JSON.parse(fs.readFileSync(path.join(dataDir, 'stripe-checkout-intents.json'))).intents;
    const ours = Object.values(attempts).filter(row => row.account_id === parAccount);
    assert.equal(ours.length, 1); assert.equal(ours[0].state, 'unknown');
  });

  // ── ruling N7: a corrupt checkout-sessions.json refuses a NEW purchase, never a purchase already paid ──

  it('[ruling N7] a corrupt checkout-sessions.json refuses the pre-check on a new purchase, but never touches money already credited', async (t) => {
    if (liveSkipReason) { t.skip(liveSkipReason); return; }
    const n7Account = 'acc_fum_n7_' + crypto.randomBytes(4).toString('hex');
    const accounts = JSON.parse(fs.readFileSync(path.join(dataDir, 'accounts.json'), 'utf8'));
    accounts[n7Account] = {
      id: n7Account, email: `${n7Account}@test.local`, created_at: FIXED_AT,
      tos_version: CURRENT_TOS_VERSION, accepted_at: Date.now(), accepted_affirmed: true,
    };
    writeJson(path.join(dataDir, 'accounts.json'), accounts);
    const token = await new SignJWT({ accountId: n7Account, email: accounts[n7Account].email })
      .setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime('24h').sign(Buffer.from(SESSION_SECRET));

    // A real purchase, paid and credited BEFORE the file is corrupted.
    const paidRes = await postWebhook(baseUrl, {
      id: 'evt_fum_n7', type: 'checkout.session.completed',
      data: { object: { id: 'cs_fum_n7', payment_intent: 'pi_fum_n7', metadata: { account_id: n7Account, pack_id: 'starter' } } },
    });
    assert.equal(paidRes.status, 200, paidRes.text);
    assert.equal(paidRes.body.processed, true);

    const sessionsFile = path.join(dataDir, 'checkout-sessions.json');
    const goodSessions = fs.existsSync(sessionsFile) ? fs.readFileSync(sessionsFile, 'utf8') : '{}';
    fs.writeFileSync(sessionsFile, '{ not valid json');
    t.after(() => { fs.writeFileSync(sessionsFile, goodSessions); });

    // A NEW purchase is refused -- it never reaches Stripe.
    const newPurchase = await postJson(`${baseUrl}/checkout/session`, { pack: 'starter' }, { Authorization: `Bearer ${token}` });
    assert.equal(newPurchase.status, 503, 'the corrupt file refuses the pre-check rather than silently reading as no pending sessions');

    // The purchase already paid is untouched -- the balance the webhook
    // credited before the corruption is exactly what /account/credits still
    // reports (a route that never reads checkout-sessions.json at all).
    const balance = await getJson(`${baseUrl}/account/credits`, { Authorization: `Bearer ${token}` });
    assert.equal(balance.status, 200, balance.text);
    assert.equal(balance.body.credit_balance.total_usd, 10, 'the already-paid $10 pack is untouched');
  });
});
