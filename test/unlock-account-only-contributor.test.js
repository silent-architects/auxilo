'use strict';

/**
 * test/unlock-account-only-contributor.test.js — BUILD-SPEC-EMFR-A1-NULL-WALLET-GUARD-001.
 *
 * Defect: on a Balance (dollar-lot) paid unlock of a learning whose
 * contributor_account_id is set and contributor_wallet is null (the shape
 * API-key contribute writes: `contributor_wallet: walletLower || null`), with
 * NO earnings entry yet for that account, server.js's `earningsSource ===
 * 'new'` branch called `contribWallet.toLowerCase()` on null. The TypeError
 * landed in the AUD19-10 catch, which refunded the buyer and returned HTTP 500
 * DELIVERY_FAILED_CREDIT_REFUNDED -- the learning could never be delivered by
 * Balance until an earnings entry existed for that account.
 *
 *   T1  account-only contributor, no earnings entry  -> 200, entry created,
 *       no wallet index written, buyer debited once, no refund log line.
 *   T2  account + wallet contributor, no entry       -> entry created AND
 *       __wallet_index[wallet] === account (regression).
 *   T3  account-only contributor, entry already there -> entry updated, no
 *       throw (regression).
 *
 * A local staged server only (test/helpers/staged-server.js), isolated data
 * dir, a free reserved port, never port 3000, never the live site, no network.
 *
 * Runner: node --test test/unlock-account-only-contributor.test.js
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  bootServer,
  reservePort,
  stageServer,
  stopServer,
} = require('./helpers/staged-server');

const REPO = path.join(__dirname, '..');
const { CURRENT_TOS_VERSION } = require('../lib/accounts.js');

const ACC_X = 'acc_x';
const ACC_Y = 'acc_y';
const ACC_Z = 'acc_z';
const WALLET_Y = '0xabc0000000000000000000000000000000000abc';
const BUYER_ID = 'acc_a1_buyer';
const RAW_BUYER_KEY = `axl_${'a'.repeat(40)}`;
const FIXED_AT = '2026-09-27T00:00:00.000Z';
const PRICE = 0.86;

function apiKeyEntry(raw, id, label, scope) {
  return {
    id,
    hash: crypto.createHash('sha256').update(raw).digest('hex'),
    label,
    scope,
    scope_version: 2,
    created_at: FIXED_AT,
    active: true,
  };
}

function accountEntry(id, extra = {}) {
  return {
    id, email: `${id}@test.local`, created_at: FIXED_AT,
    tos_version: CURRENT_TOS_VERSION, accepted_at: Date.parse(FIXED_AT), accepted_affirmed: true,
    ...extra,
  };
}

function baseLearning(id, contributorAccountId, contributorWallet) {
  return {
    id,
    title: `A1 fixture ${id}`,
    body: `Full fixture body for ${id}.`,
    snippet: `Fixture snippet for ${id}.`,
    category: 'code-execution',
    tags: ['emfr-a1', id],
    task_context: 'EMFR A1 null-wallet guard fixture.',
    outcome: 'success',
    status: 'approved',
    visibility: 'public',
    contributor_account_id: contributorAccountId,
    contributor_wallet: contributorWallet,
    contributor_agent: 'fixture-agent',
    contributor_key_label: 'fixture-contributor-key',
    related_skills: ['testing'],
    unlock_price: PRICE,
    pricing: { current_price: PRICE, floor_price: 0.05, ceiling_price: 20 },
    demand: { search_impressions_7d: 0, search_impressions_30d: 0, unlocks_7d: 0, unlocks_30d: 0 },
    earnings: { gross_usd: 0, contributor_share_usd: 0, platform_share_usd: 0 },
    quality: { unlocks: 0, unlocks_total: 0, ratings: 0, avg_helpfulness: 0, helpfulness_scores: [], score: 0 },
    created_at: FIXED_AT,
    updated_at: FIXED_AT,
  };
}

function writeJson(file, value) { fs.writeFileSync(file, JSON.stringify(value, null, 2)); }
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }

async function getJson(url, opts) {
  const response = await fetch(url, opts);
  const text = await response.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: response.status, body, text };
}

describe('EMFR A1: Balance unlock of an account-only contributor (staged live server)', { timeout: 180_000 }, () => {
  let tmpDir, child, baseUrl, getServerOutput, dataDir, liveSkipReason;

  before(async () => {
    const honoEntry = require.resolve('hono', { paths: [REPO] });
    const nodeModulesDir = honoEntry.slice(0, honoEntry.lastIndexOf(`${path.sep}node_modules${path.sep}`) + '/node_modules'.length);
    const reservation = await reservePort();
    if ('skipReason' in reservation) { liveSkipReason = reservation.skipReason; return; }
    const { port } = reservation;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emfr-a1-'));
    const staged = stageServer({
      repoRoot: REPO, tmpDir, nodeModulesDir, port,
      rootFiles: ['server.js', 'seed-knowledge.json', 'skills.json', 'openapi.json', 'package.json', 'model_config.json'],
      linkDirs: [],
      copyDirs: ['lib', 'public', 'prompts', 'config'],
      replacements: [],
    });
    dataDir = staged.dataDir;

    writeJson(path.join(dataDir, 'accounts.json'), {
      [ACC_X]: accountEntry(ACC_X),
      [ACC_Y]: accountEntry(ACC_Y, { wallet: WALLET_Y }),
      [ACC_Z]: accountEntry(ACC_Z),
      [BUYER_ID]: accountEntry(BUYER_ID, {
        api_keys: [apiKeyEntry(RAW_BUYER_KEY, 'key_a1_buyer', 'buyer', 'contribute')],
      }),
    });
    writeJson(path.join(dataDir, 'learnings.json'), [
      baseLearning('lrn_a1_t1', ACC_X, null),
      baseLearning('lrn_a1_t2', ACC_Y, WALLET_Y),
      baseLearning('lrn_a1_t3', ACC_Z, null),
    ]);
    // T1 and T2 start with NO earnings entry for their account; T3 starts with
    // an existing entry (wallet null) for ACC_Z.
    writeJson(path.join(dataDir, 'earnings.json'), {
      [ACC_Z]: {
        account_id: ACC_Z, wallet: null, total_gross: 0, total_contributor: 0, total_platform: 0,
        by_learning: {}, last_updated: FIXED_AT, pending_balance: 0, unassented_pending: 0,
        total_withdrawn: 0, withdrawal_count: 0, processed_settlements: [],
      },
    });
    writeJson(path.join(dataDir, 'credits.json'), {});
    writeJson(path.join(dataDir, 'unlock-attribution.json'), {});
    writeJson(path.join(dataDir, 'purchase-ledger.json'), {});
    writeJson(path.join(dataDir, 'verified-wallets.json'), {});

    const boot = await bootServer({
      tmpDir, port,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        // Safe standalone, not only under the isolated suite runner: the child
        // never resolves the operator's real home.
        HOME: tmpDir,
        AUXILO_HOME: tmpDir,
        WALLET_PRIVATE_KEY: `0x${'11'.repeat(32)}`,
        SESSION_SECRET: 'emfr-a1-test-session-secret',
        CONTENT_MODERATION_ENABLED: 'false',
        AUXILO_DATA_DIR: dataDir,
        AUXILO_ACCOUNTS_FILE: path.join(dataDir, 'accounts.json'),
        AUXILO_CREDITS_FILE: path.join(dataDir, 'credits.json'),
        AUXILO_UNLOCK_ATTRIBUTION_FILE: path.join(dataDir, 'unlock-attribution.json'),
        AUXILO_PURCHASE_LEDGER_FILE: path.join(dataDir, 'purchase-ledger.json'),
      },
      timeoutMs: 60_000, maxAttempts: 3,
    });
    if ('skipReason' in boot) { liveSkipReason = boot.skipReason; return; }
    child = boot.child; getServerOutput = boot.getOutput; baseUrl = boot.baseUrl;
  });

  after(async () => {
    if (child) await stopServer(child);
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function seedBuyerBalance(amountUsd) {
    const file = path.join(dataDir, 'credits.json');
    const credits = readJson(file);
    credits[BUYER_ID] = {
      queries_used: 0, unlocks_used: 0, purchased_queries: 0, purchased_unlocks: 0,
      period_start: '2026-09-01T00:00:00.000Z', period_end: '2099-01-01T00:00:00.000Z',
      created_at: Date.now(), last_deducted_at: null,
      dollar_lots: [{
        lot_id: 'lot_' + crypto.randomBytes(6).toString('hex'),
        kind: 'dollar_paid', purchase_id: null, stripe_payment_intent: null,
        purchased_at: FIXED_AT, last_activity_at: FIXED_AT,
        frozen: false, frozen_at: null, frozen_reason: null,
        original_usd: amountUsd, remaining_usd: amountUsd, funded_unlocks: [],
      }],
    };
    writeJson(file, credits);
  }

  function buyerRemaining() {
    const lots = readJson(path.join(dataDir, 'credits.json'))[BUYER_ID].dollar_lots;
    return Math.round(lots.reduce((s, l) => s + l.remaining_usd, 0) * 1e6) / 1e6;
  }

  it('[T1] account-only contributor, no earnings entry: 200, entry created, no wallet index, buyer debited once, no refund', async (t) => {
    if (liveSkipReason) { t.skip(liveSkipReason); return; }
    seedBuyerBalance(10);
    const logFrom = getServerOutput().length;
    const res = await getJson(`${baseUrl}/knowledge/lrn_a1_t1`, { headers: { 'X-API-Key': RAW_BUYER_KEY } });
    assert.equal(res.status, 200, `${res.text}\n--- server log ---\n${getServerOutput().slice(logFrom)}`);
    const earnings = readJson(path.join(dataDir, 'earnings.json'));
    assert.ok(earnings[ACC_X], 'an earnings entry must now exist for the account-only contributor');
    assert.equal(earnings[ACC_X].by_learning.lrn_a1_t1.unlocks, 1);
    assert.equal(Object.prototype.hasOwnProperty.call(earnings, '__wallet_index'), false, 'a null wallet must not write a wallet-index key');
    assert.equal(buyerRemaining(), Math.round((10 - PRICE) * 1e6) / 1e6, 'buyer debited exactly once');
    const out = getServerOutput().slice(logFrom);
    assert.ok(!/credit refunded to/.test(out), 'no refund log line');
    assert.ok(!/unlock delivery failed/.test(out), 'no delivery-failure log line');
  });

  it('[T2] account + wallet contributor, no earnings entry: entry created AND wallet index maps the wallet to the account', async (t) => {
    if (liveSkipReason) { t.skip(liveSkipReason); return; }
    seedBuyerBalance(10);
    const res = await getJson(`${baseUrl}/knowledge/lrn_a1_t2`, { headers: { 'X-API-Key': RAW_BUYER_KEY } });
    assert.equal(res.status, 200, res.text);
    const earnings = readJson(path.join(dataDir, 'earnings.json'));
    assert.ok(earnings[ACC_Y], 'an earnings entry must exist for the account');
    assert.equal(earnings[ACC_Y].by_learning.lrn_a1_t2.unlocks, 1);
    assert.equal(earnings.__wallet_index[WALLET_Y], ACC_Y);
  });

  it('[T3] account-only contributor with an existing earnings entry: entry updated, no throw', async (t) => {
    if (liveSkipReason) { t.skip(liveSkipReason); return; }
    seedBuyerBalance(10);
    const logFrom = getServerOutput().length;
    const res = await getJson(`${baseUrl}/knowledge/lrn_a1_t3`, { headers: { 'X-API-Key': RAW_BUYER_KEY } });
    assert.equal(res.status, 200, res.text);
    const earnings = readJson(path.join(dataDir, 'earnings.json'));
    assert.equal(earnings[ACC_Z].by_learning.lrn_a1_t3.unlocks, 1);
    assert.ok(earnings[ACC_Z].total_gross > 0, 'gross was booked on the existing entry');
    assert.ok(!/unlock delivery failed/.test(getServerOutput().slice(logFrom)), 'no delivery-failure log line');
  });
});
