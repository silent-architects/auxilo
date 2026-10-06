'use strict';

/**
 * test/fix-unit-money-2-route.test.js — FIX-UNIT-MONEY-2.md, the rulings
 * that need a REAL learning + API key unlocked through the real route on a
 * staged live server: N1's route-level proof (p14 case C), N4 (the
 * counter-gate write failure), and X1 (the missing route-level delivery-
 * failure coverage).
 *
 * Mirrors REVIEW-MONEY-PATH.md's p14-staged.js harness: a local staged
 * server (test/helpers/staged-server.js) on a reserved free port (never
 * 3000), an isolated data folder, a deliberately malformed Stripe secret
 * (no live probe, no network) and locally signed webhook events
 * (Stripe.webhooks.generateTestHeaderString — pure local HMAC, no network).
 *
 * Runner: node --test test/fix-unit-money-2-route.test.js
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

const SESSION_SECRET = 'fix-unit-money-2-route-test-session-secret';
const FAKE_SECRET_KEY = 'sk_test_bad'; // Known test mode; too short to permit API probes.
const WEBHOOK_SECRET = 'whsec_' + 'a'.repeat(32);

const CONTRIB_ID = 'acc_fum2_contrib';
const CONTRIB_WALLET = '0x' + '7'.repeat(40);
const N1_BUYER_ID = 'acc_fum2_n1_buyer';
const GATE_BUYER_ID = 'acc_fum2_gate_buyer';
const X1_BUYER_ID = 'acc_fum2_x1_buyer';
const FIXED_AT = '2026-09-27T00:00:00.000Z';

const K_N1 = 'axl_' + 'a1'.repeat(20);
const K_GATE = 'axl_' + 'a2'.repeat(20);
const K_X1 = 'axl_' + 'a3'.repeat(20);

const PI_N1 = 'pi_fum2_n1_partial';

function apiKeyFixture(rawKey, id) {
  return {
    id, hash: crypto.createHash('sha256').update(rawKey).digest('hex'),
    label: id, scope: 'contribute', scope_version: 2, created_at: FIXED_AT, active: true,
  };
}

function learningFixture(id, priceUsd) {
  return {
    id, title: 'fum2 ' + id, body: 'body ' + id, snippet: 's', category: 'code-execution',
    tags: ['r'], task_context: 't', outcome: 'success', status: 'approved', visibility: 'public',
    contributor_account_id: CONTRIB_ID, contributor_wallet: CONTRIB_WALLET,
    contributor_agent: 'a', contributor_key_label: 'k', related_skills: ['testing'],
    unlock_price: priceUsd, pricing: { current_price: priceUsd, floor_price: 0.05, ceiling_price: 20 },
    demand: { search_impressions_7d: 0, search_impressions_30d: 0, unlocks_7d: 0, unlocks_30d: 0 },
    earnings: { gross_usd: 0, contributor_share_usd: 0, platform_share_usd: 0 },
    quality: { unlocks: 0, unlocks_total: 0, ratings: 0, avg_helpfulness: 0, helpfulness_scores: [], score: 0 },
    created_at: FIXED_AT, updated_at: FIXED_AT,
  };
}

function lotFixture(pi, usd) {
  return {
    lot_id: 'lot_' + pi, kind: 'dollar_paid', purchase_id: 'pur_' + pi, stripe_payment_intent: pi,
    purchased_at: FIXED_AT, last_activity_at: FIXED_AT, frozen: false, frozen_at: null, frozen_reason: null,
    original_usd: usd, remaining_usd: usd, funded_unlocks: [], uncovered_usd: 0,
  };
}

function creditsRecord(lots) {
  return {
    queries_used: 0, unlocks_used: 0, purchased_queries: 0, purchased_unlocks: 0,
    period_start: '2026-09-01T00:00:00.000Z', period_end: '2099-01-01T00:00:00.000Z',
    created_at: Date.now(), last_deducted_at: null, dollar_lots: lots,
  };
}

function writeJson(file, value) { fs.writeFileSync(file, JSON.stringify(value, null, 2)); }

let migrationFixtureDir;
const migrationFixture = require('./helpers/stripe-migration-fixture');
async function postWebhook(baseUrl, payloadObj) {
  migrationFixture.prepareEvent(migrationFixtureDir, payloadObj);
  const payload = JSON.stringify(payloadObj);
  const header = Stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
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

async function unlockAs(baseUrl, apiKey, learningId) {
  const res = await fetch(`${baseUrl}/knowledge/${learningId}`, { headers: { 'X-API-Key': apiKey } });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, body: json, text };
}

describe('FIX-UNIT-MONEY-2 route-level: ruling N1 (partial refund then unlock), N4 (counter-gate write failure), X1 (delivery-failure coverage)', { timeout: 180_000 }, () => {
  let tmpDir, child, baseUrl, dataDir, liveSkipReason;

  before(async () => {
    const honoEntry = require.resolve('hono', { paths: [REPO] });
    const nodeModulesDir = honoEntry.slice(0, honoEntry.lastIndexOf(`${path.sep}node_modules${path.sep}`) + '/node_modules'.length);
    const reservation = await reservePort();
    if ('skipReason' in reservation) { liveSkipReason = reservation.skipReason; return; }
    const { port } = reservation;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fum2-route-'));
    const staged = stageServer({
      repoRoot: REPO, tmpDir, nodeModulesDir, port,
      rootFiles: ['server.js', 'seed-knowledge.json', 'skills.json', 'openapi.json', 'package.json', 'model_config.json'],
      linkDirs: [],
      copyDirs: ['lib', 'public', 'prompts', 'config'],
      replacements: [],
    });
    dataDir = staged.dataDir;
    migrationFixtureDir = dataDir;

    const now = Date.now();
    const accounts = {
      [CONTRIB_ID]: { id: CONTRIB_ID, email: 'fum2-c@test.local', wallet: CONTRIB_WALLET, created_at: FIXED_AT, tos_version: CURRENT_TOS_VERSION, accepted_at: now, accepted_affirmed: true },
      [N1_BUYER_ID]: { id: N1_BUYER_ID, email: 'fum2-n1@test.local', created_at: FIXED_AT, tos_version: CURRENT_TOS_VERSION, accepted_at: now, accepted_affirmed: true, api_keys: [apiKeyFixture(K_N1, 'k_n1')] },
      [GATE_BUYER_ID]: { id: GATE_BUYER_ID, email: 'fum2-gate@test.local', created_at: FIXED_AT, tos_version: CURRENT_TOS_VERSION, accepted_at: now, accepted_affirmed: true, api_keys: [apiKeyFixture(K_GATE, 'k_gate')] },
      [X1_BUYER_ID]: { id: X1_BUYER_ID, email: 'fum2-x1@test.local', created_at: FIXED_AT, tos_version: CURRENT_TOS_VERSION, accepted_at: now, accepted_affirmed: true, api_keys: [apiKeyFixture(K_X1, 'k_x1')] },
    };
    writeJson(path.join(dataDir, 'accounts.json'), accounts);
    writeJson(path.join(dataDir, 'learnings.json'), [
      learningFixture('lrn_fum2_n1', 10),
      learningFixture('lrn_fum2_gate', 10),
      learningFixture('lrn_fum2_x1', 10),
    ]);
    writeJson(path.join(dataDir, 'earnings.json'), {});
    writeJson(path.join(dataDir, 'purchase-ledger.json'), {});
    writeJson(path.join(dataDir, 'credits.json'), {
      [N1_BUYER_ID]: creditsRecord([lotFixture(PI_N1, 100)]),
      [GATE_BUYER_ID]: creditsRecord([lotFixture('pi_fum2_gate', 50)]),
      [X1_BUYER_ID]: creditsRecord([lotFixture('pi_fum2_x1', 50)]),
    });

    migrationFixture.initialize(dataDir);
    const boot = await bootServer({
      tmpDir, port,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        WALLET_PRIVATE_KEY: `0x${'11'.repeat(32)}`,
        SESSION_SECRET,
        CONTENT_MODERATION_ENABLED: 'false',
        STRIPE_SECRET_KEY: FAKE_SECRET_KEY,
        STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
        AUXILO_DATA_DIR: dataDir,
        AUXILO_ACCOUNTS_FILE: path.join(dataDir, 'accounts.json'),
        AUXILO_CREDITS_FILE: path.join(dataDir, 'credits.json'),
        AUXILO_PURCHASE_LEDGER_FILE: path.join(dataDir, 'purchase-ledger.json'),
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
  function readEarnings() { return JSON.parse(fs.readFileSync(path.join(dataDir, 'earnings.json'), 'utf8')); }

  // ── ruling N1, through the real route (REVIEW-MONEY-PATH.md p14 case C) ──

  it('[ruling N1] a partial refund the remaining balance covers, then an unlock, pays the builder in full and it stays', async (t) => {
    if (liveSkipReason) { t.skip(liveSkipReason); return; }

    const refundRes = await postWebhook(baseUrl, {
      id: 'evt_fum2_n1_refund', type: 'charge.refunded',
      data: { object: { payment_intent: PI_N1, amount: 10000, amount_refunded: 500, refunded: false } },
    });
    assert.equal(refundRes.status, 200, refundRes.text);
    assert.equal(refundRes.body.processed, true);
    assert.equal(readCredits()[N1_BUYER_ID].dollar_lots[0].remaining_usd, 95, '$100 pack, $5 refunded, $95 remains');

    const unlockRes = await unlockAs(baseUrl, K_N1, 'lrn_fum2_n1');
    assert.equal(unlockRes.status, 200, unlockRes.text);
    assert.equal(unlockRes.body._revenue.contributor_earned_usd, 7, 'the builder is paid $7.000000 for the $10 unlock');

    const lotAfter = readCredits()[N1_BUYER_ID].dollar_lots[0];
    assert.equal(lotAfter.remaining_usd, 85, '$95 - $10 spent');
    assert.equal(lotAfter.uncovered_usd, 0, 'the refund was fully covered by the remaining balance -- no uncovered amount');
    const fundedEntry = lotAfter.funded_unlocks.find((f) => f.learning_id === 'lrn_fum2_n1');
    assert.ok(fundedEntry, 'the funding record exists');
    assert.equal(fundedEntry.pending_reversal, false, 'and it is NOT marked for reversal');
    assert.equal(fundedEntry.reversed, false);

    const contribEarnings = readEarnings()[CONTRIB_ID];
    assert.equal(contribEarnings.pending_balance, 7, 'the $7 share is on the builder\'s ledger, on disk');

    // The share stays: a later, unrelated event (a duplicate delivery of
    // the SAME refund, which no_ops) never claws it back.
    const replay = await postWebhook(baseUrl, {
      id: 'evt_fum2_n1_refund_replay', type: 'charge.refunded',
      data: { object: { payment_intent: PI_N1, amount: 10000, amount_refunded: 500, refunded: false } },
    });
    assert.equal(replay.status, 200, replay.text);
    assert.equal(readEarnings()[CONTRIB_ID].pending_balance, 7, 'it stays');
  });

  // ── ruling N4: the counter gate can never fail an unlock ──────────────────

  it('[ruling N4] a write failure on the counter-gate file never fails the unlock -- the buyer is charged once and gets 200', async (t) => {
    if (liveSkipReason) { t.skip(liveSkipReason); return; }
    const gateFile = path.join(dataDir, 'unlock-counter-gate.json');
    // Force the gate's own write to throw (EISDIR) without touching credits.json.
    fs.rmSync(gateFile, { force: true });
    fs.mkdirSync(gateFile + '.tmp');
    t.after(() => { try { fs.rmSync(gateFile + '.tmp', { recursive: true, force: true }); } catch { /* best effort */ } });

    const before = readCredits()[GATE_BUYER_ID].dollar_lots[0].remaining_usd;
    const res = await unlockAs(baseUrl, K_GATE, 'lrn_fum2_gate');
    assert.equal(res.status, 200, res.text);
    const after = readCredits()[GATE_BUYER_ID].dollar_lots.reduce((s, l) => s + l.remaining_usd, 0);
    assert.equal(before - after, 10, 'the buyer is charged exactly once, despite the gate write failure');
    assert.equal(readCredits()[GATE_BUYER_ID].dollar_lots.length, 1, 'no phantom second lot or draw');
  });

  // ── ruling X1: missing route-level coverage for a delivery failure ────────

  it('[ruling X1] a delivery failure through the real route leaves the buyer\'s balance and the builder\'s earnings exactly where they started', async (t) => {
    if (liveSkipReason) { t.skip(liveSkipReason); return; }
    const learningsTmp = path.join(dataDir, 'learnings.json.tmp');
    // Force safeWrite(LEARNINGS_FILE, ...) to throw (EISDIR) AFTER the
    // buyer has already been debited inside dualAuthDynamic -- the exact
    // AUD19-10 delivery-failure arm.
    fs.rmSync(learningsTmp, { recursive: true, force: true });
    fs.mkdirSync(learningsTmp);
    t.after(() => { try { fs.rmSync(learningsTmp, { recursive: true, force: true }); } catch { /* best effort */ } });

    const balanceBefore = readCredits()[X1_BUYER_ID].dollar_lots.reduce((s, l) => s + l.remaining_usd, 0);
    const earningsBefore = (readEarnings()[CONTRIB_ID] || {}).pending_balance || 0;

    const res = await unlockAs(baseUrl, K_X1, 'lrn_fum2_x1');
    assert.equal(res.status, 500, res.text);
    assert.equal(res.body.code, 'DELIVERY_FAILED_CREDIT_REFUNDED');
    assert.equal(res.body.credit_refunded, true);

    const balanceAfter = readCredits()[X1_BUYER_ID].dollar_lots.reduce((s, l) => s + l.remaining_usd, 0);
    const earningsAfter = (readEarnings()[CONTRIB_ID] || {}).pending_balance || 0;
    assert.equal(balanceAfter, balanceBefore, 'the buyer\'s balance ends exactly where it started');
    assert.equal(earningsAfter, earningsBefore, 'the builder\'s earnings end exactly where they started -- nothing was kept for content never delivered');

    // Repair the file and prove the SAME learning unlocks cleanly on retry
    // (the buyer's draw was genuinely restored, not just reported as such).
    fs.rmSync(learningsTmp, { recursive: true, force: true });
    const retry = await unlockAs(baseUrl, K_X1, 'lrn_fum2_x1');
    assert.equal(retry.status, 200, retry.text);
    assert.equal(retry.body._revenue.contributor_earned_usd, 7);
  });
});
