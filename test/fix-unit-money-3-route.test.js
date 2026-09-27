'use strict';

/**
 * test/fix-unit-money-3-route.test.js — FIX-UNIT-MONEY-3.md, ruling N17,
 * proved through the REAL POST /webhook/stripe route on a staged live
 * server (test/helpers/staged-server.js). A local staged server only, on a
 * free reserved port, never port 3000, never the live site, never a real
 * Stripe call, never a real purchase.
 *
 * Runner: node --test test/fix-unit-money-3-route.test.js
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

const SESSION_SECRET = 'fix-unit-money-3-route-test-session-secret';
const FAKE_SECRET_KEY = 'not_a_real_stripe_key_format_placeholder_00000000';
const WEBHOOK_SECRET = 'whsec_' + 'e'.repeat(32);
const FIXED_AT = '2026-09-27T00:00:00.000Z';

function writeJson(file, value) { fs.writeFileSync(file, JSON.stringify(value, null, 2)); }

function signedWebhookEvent(payloadObj) {
  const payload = JSON.stringify(payloadObj);
  const header = Stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
  return { payload, header };
}

async function postWebhook(baseUrl, payloadObj) {
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

async function getJson(url, headers = {}) {
  const res = await fetch(url, { headers });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, body: json, text };
}

describe('FIX-UNIT-MONEY-3 ruling N17: post-credit webhook bookkeeping never fails the webhook (staged live server)', { timeout: 180_000 }, () => {
  let tmpDir, child, baseUrl, dataDir, liveSkipReason;

  before(async () => {
    const honoEntry = require.resolve('hono', { paths: [REPO] });
    const nodeModulesDir = honoEntry.slice(0, honoEntry.lastIndexOf(`${path.sep}node_modules${path.sep}`) + '/node_modules'.length);
    const reservation = await reservePort();
    if ('skipReason' in reservation) { liveSkipReason = reservation.skipReason; return; }
    const { port } = reservation;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fum3-route-'));
    const staged = stageServer({
      repoRoot: REPO, tmpDir, nodeModulesDir, port,
      rootFiles: ['server.js', 'seed-knowledge.json', 'skills.json', 'openapi.json', 'package.json', 'model_config.json'],
      linkDirs: [],
      copyDirs: ['lib', 'public', 'prompts', 'config'],
      replacements: [],
    });
    dataDir = staged.dataDir;

    writeJson(path.join(dataDir, 'learnings.json'), []);
    writeJson(path.join(dataDir, 'accounts.json'), {});
    writeJson(path.join(dataDir, 'earnings.json'), {});
    writeJson(path.join(dataDir, 'credits.json'), {});
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
        AUXILO_ADMIN_TOKEN: 'fum3-admin-test-token-0000000000000000',
      },
      timeoutMs: 60_000, maxAttempts: 3,
    });
    if ('skipReason' in boot) { liveSkipReason = boot.skipReason; return; }
    child = boot.child; baseUrl = boot.baseUrl;
  });

  after(async () => {
    if (child) await stopServer(child);
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function readCredits() { return JSON.parse(fs.readFileSync(path.join(dataDir, 'credits.json'), 'utf8')); }
  function readAccountHolds() {
    const p = path.join(dataDir, 'account-holds.json');
    return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {};
  }

  async function makeAccount(prefix) {
    const id = `acc_${prefix}_${crypto.randomBytes(4).toString('hex')}`;
    const accounts = JSON.parse(fs.readFileSync(path.join(dataDir, 'accounts.json'), 'utf8'));
    accounts[id] = {
      id, email: `${id}@test.local`, created_at: FIXED_AT,
      tos_version: CURRENT_TOS_VERSION, accepted_at: Date.now(), accepted_affirmed: true,
    };
    writeJson(path.join(dataDir, 'accounts.json'), accounts);
    const token = await new SignJWT({ accountId: id, email: accounts[id].email })
      .setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime('24h').sign(Buffer.from(SESSION_SECRET));
    return { id, token };
  }

  it('[ruling N17] a corrupt checkout-sessions.json never fails the webhook: the pack credits once, the cap check still runs, and a Stripe retry still 200s', async (t) => {
    if (liveSkipReason) { t.skip(liveSkipReason); return; }
    const { id: accountId, token } = await makeAccount('n17_sessfile');
    const sessionsFile = path.join(dataDir, 'checkout-sessions.json');

    // A healthy sessions file exists (from earlier tests / server writes),
    // then goes corrupt BEFORE any webhook for this account arrives.
    const goodSessions = fs.existsSync(sessionsFile) ? fs.readFileSync(sessionsFile, 'utf8') : '{}';
    fs.writeFileSync(sessionsFile, '{ not valid json, corrupted mid-write');
    t.after(() => { try { fs.writeFileSync(sessionsFile, goodSessions); } catch { /* best effort */ } });

    // 21 x $100 Pro packs = $2,100 -- crosses the $2,000 balance cap on the
    // 21st. Every single delivery must still return 200: the credit lands,
    // and clearPendingSession's own failure (the file is corrupt) must
    // never propagate into a 500.
    for (let i = 0; i < 21; i++) {
      const res = await postWebhook(baseUrl, {
        id: `evt_n17_${i}`, type: 'checkout.session.completed',
        data: {
          object: {
            id: `cs_n17_${i}`, payment_intent: `pi_n17_${i}`,
            metadata: { account_id: accountId, pack_id: 'pro' },
          },
        },
      });
      assert.equal(res.status, 200, `delivery ${i} must return 200 despite the corrupt sessions file, got ${res.status}: ${res.text}`);
      assert.equal(res.body.processed, true, `delivery ${i} must still be processed`);
    }

    // The credit ran: all 21 packs are on the balance.
    const balance = await getJson(`${baseUrl}/account/credits`, { Authorization: `Bearer ${token}` });
    assert.equal(balance.status, 200, balance.text);
    assert.equal(balance.body.credit_balance.total_usd, 2100, 'the pack is credited once per delivery -- all 21 landed');

    // Exactly one lot per payment_intent -- no double credit from any
    // retry-shaped path.
    const credits = readCredits();
    const piCount = new Set(credits[accountId].dollar_lots.map((l) => l.stripe_payment_intent)).size;
    assert.equal(credits[accountId].dollar_lots.length, piCount, 'no duplicate lot for any single payment_intent');

    // checkBalanceCap/checkDailyCap themselves read checkout-sessions.json
    // (pending sessions count toward the cap too). Ruling L-b: the
    // webhook's post-credit check now tolerates that read failing -- it
    // falls back to 0 pending sessions and still evaluates the account's
    // recorded balance/purchases alone, rather than skipping the check
    // outright. $2,100 of recorded balance already crosses the $2,000 cap
    // on its own (with zero pending sessions counted), so the hold still
    // gets placed even though the sessions file stayed corrupt for every
    // delivery. What N17 guarantees, and what matters here too, is that
    // none of this is allowed to fail the webhook itself: execution still
    // reaches every later step (the referral grant, the response) instead
    // of dying with a 500 -- proved by every one of the 21 deliveries above
    // returning 200 with the credit landed.
    const holds = readAccountHolds();
    assert.ok(holds[accountId], 'L-b: the cap overage is still caught and held even with checkout-sessions.json corrupt for every delivery');
    assert.equal(holds[accountId].reason, 'cap_overage');

    // A Stripe retry of the FIRST event (already processed) also returns
    // 200, not 500 -- the already-processed branch's own clearPendingSession
    // call is wrapped too.
    const retry = await postWebhook(baseUrl, {
      id: 'evt_n17_0_retry', type: 'checkout.session.completed',
      data: { object: { id: 'cs_n17_0', payment_intent: 'pi_n17_0', metadata: { account_id: accountId, pack_id: 'pro' } } },
    });
    assert.equal(retry.status, 200, `a Stripe retry of an already-processed session must 200, got ${retry.status}: ${retry.text}`);
    assert.equal(retry.body.already_processed, true);

    // Balance is unaffected by the retry -- no double credit.
    const balanceAfterRetry = await getJson(`${baseUrl}/account/credits`, { Authorization: `Bearer ${token}` });
    assert.equal(balanceAfterRetry.body.credit_balance.total_usd, 2100);
  });

  it('[ruling N17] a corrupt account-holds.json never fails the webhook either -- the credit and cap check still run', async (t) => {
    if (liveSkipReason) { t.skip(liveSkipReason); return; }
    const { id: accountId, token } = await makeAccount('n17_holdsfile');
    const holdsFile = path.join(dataDir, 'account-holds.json');

    const goodHolds = fs.existsSync(holdsFile) ? fs.readFileSync(holdsFile, 'utf8') : '{}';
    fs.writeFileSync(holdsFile, '{ also not valid json');
    t.after(() => { try { fs.writeFileSync(holdsFile, goodHolds); } catch { /* best effort */ } });

    // Enough packs to cross the balance cap and trigger holdAccount, which
    // will throw on the corrupt file -- the webhook must still 200 and
    // still credit every pack.
    for (let i = 0; i < 21; i++) {
      const res = await postWebhook(baseUrl, {
        id: `evt_n17h_${i}`, type: 'checkout.session.completed',
        data: {
          object: {
            id: `cs_n17h_${i}`, payment_intent: `pi_n17h_${i}`,
            metadata: { account_id: accountId, pack_id: 'pro' },
          },
        },
      });
      assert.equal(res.status, 200, `delivery ${i} must return 200 despite the corrupt holds file, got ${res.status}: ${res.text}`);
      assert.equal(res.body.processed, true);
    }

    const balance = await getJson(`${baseUrl}/account/credits`, { Authorization: `Bearer ${token}` });
    assert.equal(balance.status, 200, balance.text);
    assert.equal(balance.body.credit_balance.total_usd, 2100, 'the credit ran in full despite holdAccount itself failing');
  });
});
