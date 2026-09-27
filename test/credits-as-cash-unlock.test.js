'use strict';

/**
 * test/credits-as-cash-unlock.test.js — AUD-CAC dollar-lot unlock economics,
 * proved end to end against a REAL staged server (spec §4 invariant walk
 * #2-4, §8 tests 4-7, 34a/34b). Lot mechanics (draws, splits, ordering) are
 * already proved at the lib level in test/credits-as-cash-lots.test.js; this
 * file proves the SERVER-LEVEL accrual math — the builder/platform share a
 * real unlock over HTTP actually books to earnings.json — the part that
 * only exists inside server.js's unlock handler.
 *
 * A local staged server only, on a free reserved port, via
 * test/helpers/staged-server.js (the same harness test/envelope-0831.test.js
 * and test/credits-control-part1.test.js already use) — never port 3000,
 * never the live site, never a real Stripe call.
 *
 * Runner: node --test test/credits-as-cash-unlock.test.js
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  BOOT_SANDBOX_SKIP_REASON,
  bootServer,
  reservePort,
  stageServer,
  stopServer,
} = require('./helpers/staged-server');

const REPO = path.join(__dirname, '..');
const { CURRENT_TOS_VERSION } = require('../lib/accounts.js');

const CONTRIB_ID = 'acc_cac_contrib';
const CONTRIB_WALLET = '0x7777777777777777777777777777777777777a';
const BUYER_ID = 'acc_cac_buyer';
const RAW_BUYER_KEY = `axl_${'b'.repeat(40)}`;
const SELF_ID = 'acc_cac_self';
const RAW_SELF_KEY = `axl_${'s'.repeat(40)}`;
const FIXED_AT = '2026-09-27T00:00:00.000Z';

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

function baseLearning(id, priceUsd, contributorAccountId, contributorWallet) {
  return {
    id,
    title: `AUD-CAC fixture ${id}`,
    body: `Full fixture body for ${id}.`,
    snippet: `Fixture snippet for ${id}.`,
    category: 'code-execution',
    tags: ['aud-cac', id],
    task_context: 'AUD-CAC dollar-lot unlock economics fixture.',
    outcome: 'success',
    status: 'approved',
    visibility: 'public',
    contributor_account_id: contributorAccountId,
    contributor_wallet: contributorWallet,
    contributor_agent: 'fixture-agent',
    contributor_key_label: 'fixture-contributor-key',
    related_skills: ['testing'],
    unlock_price: priceUsd,
    pricing: { current_price: priceUsd, floor_price: 0.05, ceiling_price: 20 },
    demand: { search_impressions_7d: 0, search_impressions_30d: 0, unlocks_7d: 0, unlocks_30d: 0 },
    earnings: { gross_usd: 0, contributor_share_usd: 0, platform_share_usd: 0 },
    quality: { unlocks: 0, unlocks_total: 0, ratings: 0, avg_helpfulness: 0, helpfulness_scores: [], score: 0 },
    created_at: FIXED_AT,
    updated_at: FIXED_AT,
  };
}

function writeJson(file, value) { fs.writeFileSync(file, JSON.stringify(value, null, 2)); }

async function getJson(url, opts, getServerOutput) {
  const response = await fetch(url, opts);
  const text = await response.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: response.status, body, text, getServerOutput };
}

describe('AUD-CAC dollar-lot unlock economics (staged live server)', { timeout: 180_000 }, () => {
  let tmpDir, child, baseUrl, getServerOutput, dataDir, liveSkipReason;

  before(async () => {
    const honoEntry = require.resolve('hono', { paths: [REPO] });
    const nodeModulesDir = honoEntry.slice(0, honoEntry.lastIndexOf(`${path.sep}node_modules${path.sep}`) + '/node_modules'.length);
    const reservation = await reservePort();
    if ('skipReason' in reservation) { liveSkipReason = reservation.skipReason; return; }
    const { port } = reservation;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aud-cac-unlock-'));
    const staged = stageServer({
      repoRoot: REPO, tmpDir, nodeModulesDir, port,
      rootFiles: ['server.js', 'seed-knowledge.json', 'skills.json', 'openapi.json', 'package.json', 'model_config.json'],
      linkDirs: [],
      copyDirs: ['lib', 'public', 'prompts', 'config'],
      replacements: [],
    });
    dataDir = staged.dataDir;

    const accounts = {
      [CONTRIB_ID]: {
        id: CONTRIB_ID, email: 'cac-contrib@test.local', wallet: CONTRIB_WALLET,
        created_at: FIXED_AT, tos_version: CURRENT_TOS_VERSION,
        accepted_at: Date.parse(FIXED_AT), accepted_affirmed: true,
      },
      [BUYER_ID]: {
        id: BUYER_ID, email: 'cac-buyer@test.local', created_at: FIXED_AT,
        tos_version: CURRENT_TOS_VERSION, accepted_at: Date.parse(FIXED_AT), accepted_affirmed: true,
        api_keys: [apiKeyEntry(RAW_BUYER_KEY, 'key_cac_buyer', 'buyer', 'contribute')],
      },
      // No `wallet` field: DR8's provable-ownership recall requires a
      // LINKED wallet (account.wallet, set only by the real AUD19-3
      // link flow). This account instead sends a bare X-Wallet-Address
      // claim at request time (spec test 12), which is a DIFFERENT,
      // still-paid path (the M-2 wash guard), not the free recall.
      [SELF_ID]: {
        id: SELF_ID, email: 'cac-self@test.local', created_at: FIXED_AT,
        tos_version: CURRENT_TOS_VERSION, accepted_at: Date.parse(FIXED_AT), accepted_affirmed: true,
        api_keys: [apiKeyEntry(RAW_SELF_KEY, 'key_cac_self', 'self', 'contribute')],
      },
    };

    const learnings = [
      baseLearning('lrn_cac_t4', 0.86, CONTRIB_ID, CONTRIB_WALLET),
      baseLearning('lrn_cac_t5', 0.86, CONTRIB_ID, CONTRIB_WALLET),
      baseLearning('lrn_cac_t6', 1.16, CONTRIB_ID, CONTRIB_WALLET),
      baseLearning('lrn_cac_t7', 0.86, CONTRIB_ID, CONTRIB_WALLET),
      baseLearning('lrn_cac_t34a', 0.86, CONTRIB_ID, CONTRIB_WALLET),
      baseLearning('lrn_cac_t34b', 0.86, CONTRIB_ID, CONTRIB_WALLET),
      baseLearning('lrn_cac_t8', 0.86, CONTRIB_ID, CONTRIB_WALLET),
      baseLearning('lrn_cac_m9', 1, CONTRIB_ID, CONTRIB_WALLET),
      baseLearning('lrn_cac_m6', 1, CONTRIB_ID, CONTRIB_WALLET),
      // Owned by CONTRIB_ID, not SELF_ID — so SELF_ID's own API key does
      // NOT match contributor_account_id and DR8's free owner-recall never
      // triggers; only the bare X-Wallet-Address claim at request time
      // routes this into the M-2 wash guard (spec test 12).
      baseLearning('lrn_cac_self', 1.16, CONTRIB_ID, CONTRIB_WALLET),
    ];

    writeJson(path.join(dataDir, 'learnings.json'), learnings);
    writeJson(path.join(dataDir, 'accounts.json'), accounts);
    writeJson(path.join(dataDir, 'earnings.json'), {});
    writeJson(path.join(dataDir, 'credits.json'), {});
    writeJson(path.join(dataDir, 'unlock-attribution.json'), {});
    writeJson(path.join(dataDir, 'purchase-ledger.json'), {});
    writeJson(path.join(dataDir, 'verified-wallets.json'), {});

    const boot = await bootServer({
      tmpDir, port,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        WALLET_PRIVATE_KEY: `0x${'11'.repeat(32)}`,
        SESSION_SECRET: 'aud-cac-unlock-test-session-secret',
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

  function seedDollarLot(accountId, kind, amountUsd, extra = {}) {
    const credits = JSON.parse(fs.readFileSync(path.join(dataDir, 'credits.json'), 'utf8'));
    if (!credits[accountId]) {
      credits[accountId] = {
        queries_used: 0, unlocks_used: 0, purchased_queries: 0, purchased_unlocks: 0,
        period_start: '2026-09-01T00:00:00.000Z', period_end: '2099-01-01T00:00:00.000Z',
        created_at: Date.now(), last_deducted_at: null,
      };
    }
    if (!Array.isArray(credits[accountId].dollar_lots)) credits[accountId].dollar_lots = [];
    credits[accountId].dollar_lots.push({
      lot_id: 'lot_' + crypto.randomBytes(6).toString('hex'),
      kind,
      purchase_id: null,
      stripe_payment_intent: null,
      purchased_at: FIXED_AT,
      last_activity_at: FIXED_AT,
      frozen: false, frozen_at: null, frozen_reason: null,
      original_usd: amountUsd,
      remaining_usd: amountUsd,
      funded_unlocks: [],
      ...extra,
    });
    writeJson(path.join(dataDir, 'credits.json'), credits);
  }

  function readEarningsFor(accountId) {
    const earnings = JSON.parse(fs.readFileSync(path.join(dataDir, 'earnings.json'), 'utf8'));
    return earnings[accountId] || null;
  }

  // This suite shares one boot across all its `it()`s, so an account's
  // dollar_lots from an earlier test would otherwise bleed into a later one
  // (paid lots drain before promo, so a leftover paid balance would silently
  // fund a "promo-only" test). Reset before every test that needs a clean
  // account.
  function resetDollarLots(accountId) {
    const credits = JSON.parse(fs.readFileSync(path.join(dataDir, 'credits.json'), 'utf8'));
    if (credits[accountId]) credits[accountId].dollar_lots = [];
    writeJson(path.join(dataDir, 'credits.json'), credits);
  }

  it('[test 4] paid dollar lot, direct unlock: builder 0.602000, platform 0.258000', async (t) => {
    if (liveSkipReason) { t.skip(liveSkipReason); return; }
    resetDollarLots(BUYER_ID);
    seedDollarLot(BUYER_ID, 'dollar_paid', 10);
    const res = await getJson(`${baseUrl}/knowledge/lrn_cac_t4`, { headers: { 'X-API-Key': RAW_BUYER_KEY } }, getServerOutput);
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body._revenue.contributor_earned_usd, 0.602);
    assert.equal(res.body._revenue.platform_earned_usd, 0.258);
    const entry = readEarningsFor(CONTRIB_ID);
    assert.equal(entry.pending_balance, 0.602);
    const credits = JSON.parse(fs.readFileSync(path.join(dataDir, 'credits.json'), 'utf8'));
    assert.equal(credits[BUYER_ID].dollar_lots[0].remaining_usd, 9.14);
  });

  it('[test 5] discovery-driven unlock via a search hit: builder 0.516000, platform 0.344000', async (t) => {
    if (liveSkipReason) { t.skip(liveSkipReason); return; }
    resetDollarLots(BUYER_ID);
    seedDollarLot(BUYER_ID, 'dollar_paid', 10);
    // Prime the discovery-premium cache with a real search hit for this learning.
    const search = await getJson(`${baseUrl}/knowledge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': RAW_BUYER_KEY },
      body: JSON.stringify({ query: 'lrn_cac_t5' }),
    }, getServerOutput);
    assert.equal(search.status, 200, search.text);
    assert.ok(search.body.results.some(r => r.id === 'lrn_cac_t5'), 'the search must surface the fixture learning');

    const res = await getJson(`${baseUrl}/knowledge/lrn_cac_t5`, { headers: { 'X-API-Key': RAW_BUYER_KEY } }, getServerOutput);
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body._revenue.contributor_earned_usd, 0.516);
    assert.equal(res.body._revenue.platform_earned_usd, 0.344);
  });

  it('[test 6] promotional dollar lot only: builder 0, platform 0', async (t) => {
    if (liveSkipReason) { t.skip(liveSkipReason); return; }
    resetDollarLots(BUYER_ID);
    seedDollarLot(BUYER_ID, 'dollar_promo', 5);
    const res = await getJson(`${baseUrl}/knowledge/lrn_cac_t6`, { headers: { 'X-API-Key': RAW_BUYER_KEY } }, getServerOutput);
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body._revenue.contributor_earned_usd, 0);
    assert.equal(res.body._revenue.platform_earned_usd, 0);
    const credits = JSON.parse(fs.readFileSync(path.join(dataDir, 'credits.json'), 'utf8'));
    assert.equal(Math.round(credits[BUYER_ID].dollar_lots[0].remaining_usd * 1e6) / 1e6, 3.84);
  });

  it('[test 7] mixed draw: builder share computed on the paid portion only (0.300000 paid → 0.210000/0.090000)', async (t) => {
    if (liveSkipReason) { t.skip(liveSkipReason); return; }
    resetDollarLots(BUYER_ID);
    seedDollarLot(BUYER_ID, 'dollar_paid', 0.30);
    seedDollarLot(BUYER_ID, 'dollar_promo', 5);
    const res = await getJson(`${baseUrl}/knowledge/lrn_cac_t7`, { headers: { 'X-API-Key': RAW_BUYER_KEY } }, getServerOutput);
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body._revenue.contributor_earned_usd, 0.21);
    assert.equal(res.body._revenue.platform_earned_usd, 0.09);
  });

  it('[test 8 / §5 / L9] balance one cent short: HTTP 402, no lot touched, no share recorded', async (t) => {
    if (liveSkipReason) { t.skip(liveSkipReason); return; }
    resetDollarLots(BUYER_ID);
    seedDollarLot(BUYER_ID, 'dollar_paid', 0.85);
    const before = readEarningsFor(CONTRIB_ID)?.pending_balance || 0;
    const res = await getJson(`${baseUrl}/knowledge/lrn_cac_t8`, { headers: { 'X-API-Key': RAW_BUYER_KEY } }, getServerOutput);
    assert.equal(res.status, 402);
    assert.equal(res.body.error, 'Credits exhausted');
    assert.ok(res.body.message, 'must carry a plain message');
    assert.ok(res.body.accepts && res.body.accepts.length > 0, 'must still carry the x402 fallback challenge (ruling L9)');
    const credits = JSON.parse(fs.readFileSync(path.join(dataDir, 'credits.json'), 'utf8'));
    assert.equal(credits[BUYER_ID].dollar_lots.find(l => l.kind === 'dollar_paid').remaining_usd, 0.85, 'nothing drawn on a refused unlock');
    const after = readEarningsFor(CONTRIB_ID)?.pending_balance || 0;
    assert.equal(after, before, 'no share was ever recorded (this suite shares state, so compare the delta, not an absolute null)');
  });

  // FIX-UNIT-MONEY L12: this test used to be titled "paid self-unlock via
  // an unverified wallet claim: full debit, builder share zero" and
  // asserted the builder's share was zeroed -- that WAS the defect: any
  // buyer could zero a builder's share by sending that builder's wallet in
  // X-Wallet-Address, on the BALANCE path, where the caller is always
  // authenticated and there is no reason to ever consult an unverified
  // header. SELF_ID is not lrn_cac_self's contributor (CONTRIB_ID is) --
  // it is simply a different, unrelated buyer account sending CONTRIB_ID's
  // wallet in the header. Ownership on the Balance path is now decided by
  // the signed-in account only: the full debit still happens, but the
  // builder is paid the SAME share it would be paid with no header at all.
  it('[ruling L12] a balance unlock sending ANOTHER builder\'s wallet in the header still pays that builder the share', async (t) => {
    if (liveSkipReason) { t.skip(liveSkipReason); return; }
    seedDollarLot(SELF_ID, 'dollar_paid', 10);
    const before = readEarningsFor(CONTRIB_ID)?.pending_balance || 0;
    const res = await getJson(`${baseUrl}/knowledge/lrn_cac_self`, {
      headers: { 'X-API-Key': RAW_SELF_KEY, 'X-Wallet-Address': CONTRIB_WALLET },
    }, getServerOutput);
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body._revenue.contributor_earned_usd, 0.812, '70% of 1.16 -- the normal direct-unlock share, not zeroed by the header claim');
    assert.equal(res.body._revenue.platform_earned_usd, 0.348);
    assert.notEqual(res.body._revenue.self_unlock, true, 'SELF_ID is not lrn_cac_self\'s contributor -- this must never be treated as a self-unlock on the Balance path');
    const credits = JSON.parse(fs.readFileSync(path.join(dataDir, 'credits.json'), 'utf8'));
    assert.equal(credits[SELF_ID].dollar_lots[0].remaining_usd, 10 - 1.16, 'the full listed price is debited, same as any other buyer');
    const after = readEarningsFor(CONTRIB_ID).pending_balance;
    assert.equal(Math.round((after - before) * 1e6) / 1e6, 0.812, 'the contributor actually received the share -- this suite shares state, so compare the delta');
  });

  // RETIRED (credits-as-cash follow-up, SITE-PM 2026-09-27): '[test 34a]
  // unit-lot repeat unlock inside 30 days still gets capped' pinned the
  // 30-day repeat-accrual cap and the unit-lot spend path — both removed.
  // There is one model now and no repeat cap (F-5): test 34b below already
  // proves a repeat unlock from a balance earns the share both times.

  it('[test 34b, ruling L3 design 2] dollar-lot repeat unlock inside 30 days is NOT capped — full share both times', async (t) => {
    if (liveSkipReason) { t.skip(liveSkipReason); return; }
    resetDollarLots(BUYER_ID);
    seedDollarLot(BUYER_ID, 'dollar_paid', 10);
    const before = readEarningsFor(CONTRIB_ID)?.pending_balance || 0;

    const first = await getJson(`${baseUrl}/knowledge/lrn_cac_t34b`, { headers: { 'X-API-Key': RAW_BUYER_KEY } }, getServerOutput);
    assert.equal(first.status, 200, first.text);
    assert.equal(first.body._revenue.contributor_earned_usd, 0.602);

    const second = await getJson(`${baseUrl}/knowledge/lrn_cac_t34b`, { headers: { 'X-API-Key': RAW_BUYER_KEY } }, getServerOutput);
    assert.equal(second.status, 200, second.text);
    assert.equal(second.body._revenue.contributor_earned_usd, 0.602,
      'the repeat still pays the builder in full — dollar lots have no 30-day repeat cap (ruling L3, design 2)');
    assert.notEqual(second.body._revenue.accrual_capped, true);

    // This suite shares one server/data dir across its `it()`s, so pending_balance
    // accumulates prior tests' accruals too — assert the DELTA this test caused,
    // not the absolute total.
    const after = readEarningsFor(CONTRIB_ID).pending_balance;
    assert.equal(Math.round((after - before) * 1e6) / 1e6, 1.204, 'both unlocks accrued — the delta reflects two full 0.602 shares');
  });

  function readLearning(id) {
    const learnings = JSON.parse(fs.readFileSync(path.join(dataDir, 'learnings.json'), 'utf8'));
    return learnings.find((l) => l.id === id);
  }

  it('[ruling M9] a repeat unlock inside 30 days earns the share in full BOTH times, but moves the ranking/demand counters only once', async (t) => {
    if (liveSkipReason) { t.skip(liveSkipReason); return; }
    resetDollarLots(BUYER_ID);
    seedDollarLot(BUYER_ID, 'dollar_paid', 10);
    const before = readEarningsFor(CONTRIB_ID)?.pending_balance || 0;
    const beforeUnlocks = readLearning('lrn_cac_m9').quality.unlocks || 0;
    const beforeDemand = readLearning('lrn_cac_m9').demand.unlocks_7d || 0;

    const first = await getJson(`${baseUrl}/knowledge/lrn_cac_m9`, { headers: { 'X-API-Key': RAW_BUYER_KEY } }, getServerOutput);
    assert.equal(first.status, 200, first.text);
    assert.equal(first.body._revenue.contributor_earned_usd, 0.7, 'the charge and the share are money -- M9 never touches either');

    const second = await getJson(`${baseUrl}/knowledge/lrn_cac_m9`, { headers: { 'X-API-Key': RAW_BUYER_KEY } }, getServerOutput);
    assert.equal(second.status, 200, second.text);
    assert.equal(second.body._revenue.contributor_earned_usd, 0.7, 'the repeat is charged and earns in full, exactly like test 34b');

    const after = readEarningsFor(CONTRIB_ID).pending_balance;
    assert.equal(Math.round((after - before) * 1e6) / 1e6, 1.4, 'both unlocks moved real money -- M9 gates counters only, never the charge or the share');

    const learningAfter = readLearning('lrn_cac_m9');
    assert.equal((learningAfter.quality.unlocks || 0) - beforeUnlocks, 1,
      'the ranking counter counts this (buyer, learning) pair only ONCE inside the 30-day window, even though it was unlocked and paid for twice');
    assert.equal((learningAfter.demand.unlocks_7d || 0) - beforeDemand, 1,
      'the demand counter (price multiplier basis) is gated the same way');
    assert.equal(learningAfter.quality.unlocks_total >= 2, true,
      'the ops-only raw counter still bumps on every unlock, uncapped');
  });

  // FIX-UNIT-MONEY M6: NO CHANGE ruling -- the Terms say one search result
  // qualifies one Unlock (single-use), so only the FIRST unlock after a
  // search pays 60%; repeats inside the same hour are direct unlocks (70%).
  // Pinned per the ruling's own instruction, driven through the real route.
  it('[ruling M6, NO CHANGE] one search, then three unlocks in the hour: shares 60%, 70%, 70%', async (t) => {
    if (liveSkipReason) { t.skip(liveSkipReason); return; }
    resetDollarLots(BUYER_ID);
    seedDollarLot(BUYER_ID, 'dollar_paid', 10);

    const search = await getJson(`${baseUrl}/knowledge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': RAW_BUYER_KEY },
      body: JSON.stringify({ query: 'lrn_cac_m6' }),
    }, getServerOutput);
    assert.equal(search.status, 200, search.text);
    assert.ok(search.body.results.some((r) => r.id === 'lrn_cac_m6'));

    const first = await getJson(`${baseUrl}/knowledge/lrn_cac_m6`, { headers: { 'X-API-Key': RAW_BUYER_KEY } }, getServerOutput);
    assert.equal(first.status, 200, first.text);
    assert.equal(first.body._revenue.contributor_earned_usd, 0.6, 'the search-qualified unlock pays 60%');

    const second = await getJson(`${baseUrl}/knowledge/lrn_cac_m6`, { headers: { 'X-API-Key': RAW_BUYER_KEY } }, getServerOutput);
    assert.equal(second.status, 200, second.text);
    assert.equal(second.body._revenue.contributor_earned_usd, 0.7, 'a repeat inside the hour, with no new search, is a direct unlock -- 70%');

    const third = await getJson(`${baseUrl}/knowledge/lrn_cac_m6`, { headers: { 'X-API-Key': RAW_BUYER_KEY } }, getServerOutput);
    assert.equal(third.status, 200, third.text);
    assert.equal(third.body._revenue.contributor_earned_usd, 0.7, 'still 70% -- one search result qualifies exactly one Unlock');
  });
});
