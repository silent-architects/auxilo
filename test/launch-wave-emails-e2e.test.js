'use strict';

/**
 * test/launch-wave-emails-e2e.test.js — Wave 3, Unit B (dashboard-reorder
 * wave): staged-server cases for the two new transactional emails and the
 * setting that turns one of them off. See test/launch-wave-emails.test.js
 * for the pure-logic and source-inspection cases.
 *
 * Two staged servers are booted: BOOT_ON (both WELCOME_EMAIL_ENABLED and
 * EARNING_NOTIFICATIONS_ENABLED = 'true') for the feature-behavior cases,
 * and BOOT_OFF (neither flag set) for the dark-by-default cases. Both set
 * RESEND_API_KEY: '' (dev mode — no network call), per the existing
 * staged-server convention (test/seed-attr-auth.test.js).
 *
 * Runner: node --test test/launch-wave-emails-e2e.test.js
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SignJWT } = require('jose');
const {
  BOOT_SANDBOX_SKIP_REASON,
  bootServer,
  reservePort,
  stageServer,
  stopServer,
} = require('./helpers/staged-server');

const ROOT = path.join(__dirname, '..');
const SESSION_SECRET = 'launch-wave-emails-e2e-session-secret-32b';
const FIXED_AT = '2026-08-01T00:00:00.000Z';
const CURRENT_TOS_VERSION = '2026-09-27-credit-balance-a2';
const ROUTER_ADDRESS = '0x3333333333333333333333333333333333333333';

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function apiKeyEntry(raw, id, label, scope) {
  return {
    id,
    hash: sha256(raw),
    label,
    scope,
    scope_version: 2,
    created_at: FIXED_AT,
    active: true,
  };
}

// AUD-CAC (credits-as-cash follow-up, SITE-PM 2026-09-27): the balance is
// dollars now — this grants a dollar_paid lot sized to cover `unlocks`
// unlocks at `unitPrice` each (the fixture learnings below are all priced
// at $1 by default), rather than a unit lot. Call-site shape unchanged.
function creditRecord(unlocks, unitPrice = 1) {
  return {
    queries_used: 0,
    unlocks_used: 0,
    purchased_queries: 0,
    purchased_unlocks: 0,
    dollar_lots: [{
      lot_id: 'lot_lwe_fixture_' + Math.random().toString(36).slice(2, 8),
      kind: 'dollar_paid',
      purchase_id: null,
      stripe_payment_intent: null,
      purchased_at: FIXED_AT,
      last_activity_at: FIXED_AT,
      frozen: false, frozen_at: null, frozen_reason: null,
      original_usd: unlocks * unitPrice,
      remaining_usd: unlocks * unitPrice,
      funded_unlocks: [],
    }],
    period_start: '2026-08-01T00:00:00.000Z',
    period_end: '2099-09-01T00:00:00.000Z',
    created_at: Date.parse(FIXED_AT),
    last_deducted_at: null,
  };
}

function fixtureLearning(id, { contributorAccountId = null, contributorWallet = null, price = 1 } = {}) {
  return {
    id,
    title: `Launch-wave fixture ${id}`,
    body: `Full body for ${id}.`,
    snippet: `Snippet for ${id}.`,
    category: 'code-execution',
    tags: ['launch-wave-emails'],
    task_context: 'Pin the earning-notification hook.',
    outcome: 'success',
    status: 'approved',
    visibility: 'public',
    contributor_account_id: contributorAccountId,
    contributor_wallet: contributorWallet,
    contributor_agent: 'fixture-agent',
    contributor_key_label: 'fixture-contributor-key',
    related_skills: ['testing'],
    unlock_price: price,
    pricing: { current_price: price, floor_price: 0.05, ceiling_price: 20 },
    demand: { search_impressions_7d: 0, search_impressions_30d: 0, unlocks_7d: 0, unlocks_30d: 0 },
    earnings: { gross_usd: 0, contributor_share_usd: 0, platform_share_usd: 0 },
    quality: { unlocks: 0, unlocks_total: 0, ratings: 0, avg_helpfulness: 0, helpfulness_scores: [], score: 0 },
    created_at: FIXED_AT,
    updated_at: FIXED_AT,
  };
}

async function getJson(url, headers = {}) {
  const response = await fetch(url, { headers });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: response.status, body, text };
}

async function postJson(url, payload, headers = {}) {
  const response = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: response.status, body, text };
}

async function postForm(url, formBody) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(formBody).toString(),
  });
  const text = await response.text();
  return { status: response.status, text };
}

async function sessionToken(accountId, email) {
  return new SignJWT({ accountId, email })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(Buffer.from(SESSION_SECRET));
}

async function patchJson(url, payload, headers = {}) {
  const response = await fetch(url, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: response.status, body, text };
}

async function boot({ envExtra = {}, accounts = {}, learnings = [], credits = {}, verifiedWallets = {}, magicLinks = {} }) {
  const honoEntry = require.resolve('hono', { paths: [ROOT] });
  const nodeModulesDir = honoEntry.slice(0, honoEntry.lastIndexOf(`${path.sep}node_modules${path.sep}`) + '/node_modules'.length);
  const reservation = await reservePort();
  if ('skipReason' in reservation) return { skipReason: reservation.skipReason };

  const { port } = reservation;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auxilo-launch-wave-emails-'));
  const { dataDir } = stageServer({
    repoRoot: ROOT,
    tmpDir,
    nodeModulesDir,
    port,
    rootFiles: ['server.js', 'seed-knowledge.json', 'skills.json', 'openapi.json', 'package.json', 'model_config.json'],
    linkDirs: [],
    copyDirs: ['lib', 'public', 'prompts', 'config'],
  });

  writeJson(path.join(dataDir, 'learnings.json'), learnings);
  writeJson(path.join(dataDir, 'accounts.json'), accounts);
  writeJson(path.join(dataDir, 'earnings.json'), {});
  writeJson(path.join(dataDir, 'credits.json'), credits);
  writeJson(path.join(dataDir, 'unlock-attribution.json'), {});
  writeJson(path.join(dataDir, 'purchase-ledger.json'), {});
  writeJson(path.join(dataDir, 'verified-wallets.json'), verifiedWallets);
  writeJson(path.join(dataDir, 'magic_links.json'), magicLinks);
  writeJson(path.join(dataDir, 'earning-notifications.json'), {});

  const boot = await bootServer({
    tmpDir,
    port,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PAYMENTS_ENABLED: 'true',
      WALLET_PRIVATE_KEY: `0x${'11'.repeat(32)}`,
      SESSION_SECRET,
      RESEND_API_KEY: '',
      CONTENT_MODERATION_ENABLED: 'true',
      LLM_SENSITIVITY_ENABLED: 'false',
      AUXILO_ACCOUNTS_FILE: path.join(dataDir, 'accounts.json'),
      AUXILO_CREDITS_FILE: path.join(dataDir, 'credits.json'),
      AUXILO_UNLOCK_ATTRIBUTION_FILE: path.join(dataDir, 'unlock-attribution.json'),
      AUXILO_PURCHASE_LEDGER_FILE: path.join(dataDir, 'purchase-ledger.json'),
      AUXILO_EARNING_NOTIFICATIONS_FILE: path.join(dataDir, 'earning-notifications.json'),
      ...envExtra,
    },
    timeoutMs: 60_000,
    maxAttempts: 3,
  });
  if ('skipReason' in boot) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    return { skipReason: boot.skipReason };
  }
  return { ...boot, tmpDir, dataDir };
}

// ─────────────────────────────────────────────────────────────────────────
// BOOT_OFF: both flags unset — the dark-by-default cases.
// ─────────────────────────────────────────────────────────────────────────
describe('LAUNCH-WAVE-EMAILS-E2E: both flags OFF (dark by default)', { timeout: 180_000 }, () => {
  const CONTRIB_ID = 'acc_lwe_off_contrib';
  const CONTRIB_WALLET = '0x' + '7f'.repeat(20);
  const BUYER_ID = 'acc_lwe_off_buyer';
  const RAW_BUYER_KEY = `axl_${'f'.repeat(40)}`;
  const LEARNING_ID = 'lrn_lwe_off_1';

  let ctx;

  before(async () => {
    ctx = await boot({
      accounts: {
        [CONTRIB_ID]: {
          id: CONTRIB_ID, email: 'lwe-off-contrib@test.local', wallet: CONTRIB_WALLET,
          created_at: FIXED_AT, tos_version: CURRENT_TOS_VERSION,
          accepted_at: Date.parse(FIXED_AT), accepted_affirmed: true, api_keys: [],
        },
        [BUYER_ID]: {
          id: BUYER_ID, email: 'lwe-off-buyer@test.local', created_at: FIXED_AT,
          api_keys: [apiKeyEntry(RAW_BUYER_KEY, 'key_lwe_off_buyer', 'buyer', 'read')],
        },
      },
      learnings: [fixtureLearning(LEARNING_ID, { contributorAccountId: CONTRIB_ID, contributorWallet: CONTRIB_WALLET })],
      credits: { [BUYER_ID]: creditRecord(1) },
    });
  });

  after(async () => { if (ctx && ctx.child) { await stopServer(ctx.child); fs.rmSync(ctx.tmpDir, { recursive: true, force: true }); } });

  it('EARNING_NOTIFICATIONS_ENABLED unset: a real accruing unlock queues nothing, and GET /account/settings reports earning_notifications_available: false', async () => {
    if (ctx.skipReason) return; // sandboxed environment
    const unlock = await getJson(`${ctx.baseUrl}/knowledge/${LEARNING_ID}`, { 'X-API-Key': RAW_BUYER_KEY });
    assert.equal(unlock.status, 200, JSON.stringify(unlock.body));
    assert.equal(unlock.body._revenue.contributor_earned_usd, 0.7);

    const notifFile = path.join(ctx.dataDir, 'earning-notifications.json');
    const queued = readJson(notifFile);
    assert.deepEqual(queued, {}, 'no queue write while the flag is unset');

    const settings = await getJson(`${ctx.baseUrl}/account/settings`, { 'X-API-Key': RAW_BUYER_KEY });
    assert.equal(settings.status, 200);
    assert.equal(settings.body.earning_notifications_available, false);
    assert.equal(settings.body.earning_notifications_enabled, true, 'default true when unset on the account');
  });

  it('WELCOME_EMAIL_ENABLED unset: first sign-in sends nothing and writes nothing (no dev-mode log line naming the recipient)', async () => {
    if (ctx.skipReason) return;
    const rawToken = crypto.randomBytes(32).toString('base64url');
    const magicLinksFile = path.join(ctx.dataDir, 'magic_links.json');
    const links = readJson(magicLinksFile);
    links[sha256(rawToken)] = { email: 'lwe-off-new-signup@test.local', expires_at: Date.now() + 900_000 };
    writeJson(magicLinksFile, links);

    const verify = await getJson(`${ctx.baseUrl}/auth/verify?token=${rawToken}`);
    assert.equal(verify.status, 200);
    assert.match(ctx.getOutput(), /Verified magic link for lwe-off-new-signup@test\.local.*\(new\)/);
    assert.ok(!/Welcome email/.test(ctx.getOutput()), 'no welcome-email log line at all while the flag is unset');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// BOOT_ON: both flags 'true' — the feature-behavior cases.
// ─────────────────────────────────────────────────────────────────────────
describe('LAUNCH-WAVE-EMAILS-E2E: both flags ON', { timeout: 180_000 }, () => {
  const CONTRIB_NORMAL = 'acc_lwe_contrib_normal';
  const CONTRIB_NORMAL_WALLET = '0x' + '7a'.repeat(20);
  const CONTRIB_HELD = 'acc_lwe_contrib_held';
  const CONTRIB_HELD_WALLET = '0x' + '7b'.repeat(20);
  const CONTRIB_DIGEST = 'acc_lwe_contrib_digest';
  const CONTRIB_DIGEST_WALLET = '0x' + '7c'.repeat(20);
  const CONTRIB_OPTOUT = 'acc_lwe_contrib_optout';
  const CONTRIB_OPTOUT_WALLET = '0x' + '7d'.repeat(20);

  const BUYER_NORMAL = 'acc_lwe_buyer_normal';
  const BUYER_SELF = 'acc_lwe_buyer_self';
  const BUYER_PLATFORM = 'acc_lwe_buyer_platform';
  const BUYER_HELD = 'acc_lwe_buyer_held';
  const BUYER_DIGEST_A = 'acc_lwe_buyer_digest_a';
  const BUYER_DIGEST_B = 'acc_lwe_buyer_digest_b';
  const BUYER_SETTINGS = 'acc_lwe_buyer_settings';
  const BUYER_TOKENS = 'acc_lwe_buyer_tokens';
  const BUYER_DELETE_TARGET = 'acc_lwe_buyer_delete_target';
  const BUYER_OPTOUT = 'acc_lwe_buyer_optout';

  const RAW = (n) => `axl_${n.repeat(40)}`;
  const RAW_BUYER_NORMAL = RAW('1');
  const RAW_BUYER_SELF = RAW('2');
  const RAW_BUYER_PLATFORM = RAW('4');
  const RAW_BUYER_HELD = RAW('5');
  const RAW_BUYER_DIGEST_A = RAW('6');
  const RAW_BUYER_DIGEST_B = RAW('7');
  const RAW_BUYER_SETTINGS = RAW('8');
  const RAW_BUYER_TOKENS = RAW('9');
  const RAW_BUYER_DELETE_TARGET = RAW('e');
  const RAW_BUYER_OPTOUT = RAW('f');

  const LEARNING_NORMAL = 'lrn_lwe_normal';
  const LEARNING_SELF = 'lrn_lwe_self';
  const LEARNING_PLATFORM = 'lrn_lwe_platform';
  const LEARNING_HELD = 'lrn_lwe_held';
  const LEARNING_DIGEST_A = 'lrn_lwe_digest_a';
  const LEARNING_DIGEST_B = 'lrn_lwe_digest_b';
  const LEARNING_OPTOUT = 'lrn_lwe_optout';

  function buyerAccount(id, email, rawKey, label) {
    return { id, email, created_at: FIXED_AT, api_keys: [apiKeyEntry(rawKey, `key_${id}`, label, 'read')] };
  }

  let ctx;

  before(async () => {
    ctx = await boot({
      envExtra: { WELCOME_EMAIL_ENABLED: 'true', EARNING_NOTIFICATIONS_ENABLED: 'true', X402_ROUTER_ADDRESS: ROUTER_ADDRESS },
      accounts: {
        [CONTRIB_NORMAL]: {
          id: CONTRIB_NORMAL, email: 'lwe-contrib-normal@test.local', wallet: CONTRIB_NORMAL_WALLET,
          created_at: FIXED_AT, tos_version: CURRENT_TOS_VERSION,
          accepted_at: Date.parse(FIXED_AT), accepted_affirmed: true, api_keys: [],
        },
        // Agency NOT in force (no tos_version/accepted_at) — the "held"
        // fixture. Its wallet IS verified and X402_ROUTER_ADDRESS IS set, so
        // routerCtx bypasses the pre-payment CONTRIBUTOR_NOT_ONBOARDED gate;
        // the buyer still pays by CREDIT (not on-chain), so routerSettlement
        // stays null and the custodial branch runs isPayeeAgencyInForce ->
        // false -> unassented_pending (held), never pending_balance.
        [CONTRIB_HELD]: {
          id: CONTRIB_HELD, email: 'lwe-contrib-held@test.local', wallet: CONTRIB_HELD_WALLET,
          created_at: FIXED_AT, api_keys: [],
        },
        [CONTRIB_DIGEST]: {
          id: CONTRIB_DIGEST, email: 'lwe-contrib-digest@test.local', wallet: CONTRIB_DIGEST_WALLET,
          created_at: FIXED_AT, tos_version: CURRENT_TOS_VERSION,
          accepted_at: Date.parse(FIXED_AT), accepted_affirmed: true, api_keys: [],
        },
        // L7: preference is off — the queue write itself must never happen,
        // so no title/amount is ever stored for this contributor.
        [CONTRIB_OPTOUT]: {
          id: CONTRIB_OPTOUT, email: 'lwe-contrib-optout@test.local', wallet: CONTRIB_OPTOUT_WALLET,
          created_at: FIXED_AT, tos_version: CURRENT_TOS_VERSION,
          accepted_at: Date.parse(FIXED_AT), accepted_affirmed: true, api_keys: [],
          earning_notifications_enabled: false,
        },
        [BUYER_NORMAL]: buyerAccount(BUYER_NORMAL, 'lwe-buyer-normal@test.local', RAW_BUYER_NORMAL, 'buyer-normal'),
        [BUYER_SELF]: buyerAccount(BUYER_SELF, 'lwe-buyer-self@test.local', RAW_BUYER_SELF, 'buyer-self'),
        [BUYER_PLATFORM]: buyerAccount(BUYER_PLATFORM, 'lwe-buyer-platform@test.local', RAW_BUYER_PLATFORM, 'buyer-platform'),
        [BUYER_HELD]: buyerAccount(BUYER_HELD, 'lwe-buyer-held@test.local', RAW_BUYER_HELD, 'buyer-held'),
        [BUYER_DIGEST_A]: buyerAccount(BUYER_DIGEST_A, 'lwe-buyer-digest-a@test.local', RAW_BUYER_DIGEST_A, 'buyer-digest-a'),
        [BUYER_DIGEST_B]: buyerAccount(BUYER_DIGEST_B, 'lwe-buyer-digest-b@test.local', RAW_BUYER_DIGEST_B, 'buyer-digest-b'),
        [BUYER_SETTINGS]: buyerAccount(BUYER_SETTINGS, 'lwe-buyer-settings@test.local', RAW_BUYER_SETTINGS, 'buyer-settings'),
        [BUYER_TOKENS]: buyerAccount(BUYER_TOKENS, 'lwe-buyer-tokens@test.local', RAW_BUYER_TOKENS, 'buyer-tokens'),
        [BUYER_DELETE_TARGET]: buyerAccount(BUYER_DELETE_TARGET, 'lwe-buyer-delete-target@test.local', RAW_BUYER_DELETE_TARGET, 'buyer-delete-target'),
        [BUYER_OPTOUT]: buyerAccount(BUYER_OPTOUT, 'lwe-buyer-optout@test.local', RAW_BUYER_OPTOUT, 'buyer-optout'),
      },
      learnings: [
        fixtureLearning(LEARNING_NORMAL, { contributorAccountId: CONTRIB_NORMAL, contributorWallet: CONTRIB_NORMAL_WALLET }),
        fixtureLearning(LEARNING_SELF, { contributorAccountId: CONTRIB_NORMAL, contributorWallet: CONTRIB_NORMAL_WALLET }),
        fixtureLearning(LEARNING_PLATFORM, { contributorAccountId: null, contributorWallet: null }),
        fixtureLearning(LEARNING_HELD, { contributorAccountId: CONTRIB_HELD, contributorWallet: CONTRIB_HELD_WALLET }),
        fixtureLearning(LEARNING_DIGEST_A, { contributorAccountId: CONTRIB_DIGEST, contributorWallet: CONTRIB_DIGEST_WALLET }),
        fixtureLearning(LEARNING_DIGEST_B, { contributorAccountId: CONTRIB_DIGEST, contributorWallet: CONTRIB_DIGEST_WALLET }),
        fixtureLearning(LEARNING_OPTOUT, { contributorAccountId: CONTRIB_OPTOUT, contributorWallet: CONTRIB_OPTOUT_WALLET }),
      ],
      credits: {
        [BUYER_NORMAL]: creditRecord(1),
        [BUYER_SELF]: creditRecord(1),
        [BUYER_PLATFORM]: creditRecord(1),
        [BUYER_HELD]: creditRecord(1),
        [BUYER_DIGEST_A]: creditRecord(1),
        [BUYER_DIGEST_B]: creditRecord(1),
        [BUYER_OPTOUT]: creditRecord(1),
      },
      verifiedWallets: { [CONTRIB_HELD_WALLET.toLowerCase()]: true },
    });
  });

  after(async () => { if (ctx && ctx.child) { await stopServer(ctx.child); fs.rmSync(ctx.tmpDir, { recursive: true, force: true }); } });

  function notifQueue() {
    return readJson(path.join(ctx.dataDir, 'earning-notifications.json'));
  }

  it('a real, non-self, non-capped unlock queues exactly one item with the correct learningId/title/amountUsd', async () => {
    if (ctx.skipReason) return;
    const unlock = await getJson(`${ctx.baseUrl}/knowledge/${LEARNING_NORMAL}`, { 'X-API-Key': RAW_BUYER_NORMAL });
    assert.equal(unlock.status, 200, JSON.stringify(unlock.body));
    assert.equal(unlock.body._revenue.contributor_earned_usd, 0.7);

    // The opportunistic flush (dev mode, RESEND_API_KEY='') fires and drains
    // the queue synchronously-fast; by the time this request returns, either
    // the item is still pending or it has already been logged and cleared.
    // Either way, this is the FIRST accrual this contributor ever queued, so
    // its dev-mode log line must have appeared exactly once.
    assert.match(ctx.getOutput(), /\[earning-digest\] dev mode: 1 item\(s\) for <redacted>@test\.local/);
  });

  it('a self-unlock (matching X-Wallet-Address claim) queues nothing', async () => {
    if (ctx.skipReason) return;
    const before = ctx.getOutput().length;
    const unlock = await getJson(`${ctx.baseUrl}/knowledge/${LEARNING_SELF}`, {
      'X-API-Key': RAW_BUYER_SELF,
      'X-Wallet-Address': CONTRIB_NORMAL_WALLET,
    });
    assert.equal(unlock.status, 200, JSON.stringify(unlock.body));
    assert.equal(unlock.body._revenue.self_unlock, true);
    assert.equal(unlock.body._revenue.contributor_earned_usd, 0);
    const newOutput = ctx.getOutput().slice(before);
    assert.ok(!/earning-digest/.test(newOutput), 'self-unlock must never queue or flush a digest');
  });

  // RETIRED (credits-as-cash follow-up, SITE-PM 2026-09-27): 'an
  // accrual-capped repeat unlock (same buyer + learning within 30 days)
  // queues nothing on the second call' pinned the retired 30-day
  // repeat-accrual cap (F-5) — a repeat unlock now earns the builder's
  // share and queues a digest entry like any other real unlock. The
  // BUYER_CAP/LEARNING_CAP fixtures existed only for this test.

  it('an unlock of a platform-owned learning (no contributor_account_id) queues nothing', async () => {
    if (ctx.skipReason) return;
    const before = ctx.getOutput().length;
    const unlock = await getJson(`${ctx.baseUrl}/knowledge/${LEARNING_PLATFORM}`, { 'X-API-Key': RAW_BUYER_PLATFORM });
    assert.equal(unlock.status, 200, JSON.stringify(unlock.body));
    const newOutput = ctx.getOutput().slice(before);
    assert.ok(!/earning-digest/.test(newOutput), 'a platform-owned learning must never queue or flush a digest');
  });

  it('an accrual held pending Terms acceptance (agencyInForce false) queues nothing', async () => {
    if (ctx.skipReason) return;
    const before = ctx.getOutput().length;
    const unlock = await getJson(`${ctx.baseUrl}/knowledge/${LEARNING_HELD}`, { 'X-API-Key': RAW_BUYER_HELD });
    assert.equal(unlock.status, 200, JSON.stringify(unlock.body));
    assert.equal(unlock.body._revenue.contributor_earned_usd, 0.7, 'the accrual itself still happens (held, not refused)');
    const newOutput = ctx.getOutput().slice(before);
    assert.ok(!/earning-digest/.test(newOutput), 'a held (pre-Terms) accrual must never queue or flush a digest (GOV-4 Q10)');
    const queue = notifQueue();
    assert.ok(!queue[CONTRIB_HELD], 'no queue row was ever created for the held contributor');
  });

  it('L7: a real, non-self, non-capped unlock for a contributor with earning_notifications_enabled: false queues nothing (no title/amount ever stored)', async () => {
    if (ctx.skipReason) return;
    const before = ctx.getOutput().length;
    const unlock = await getJson(`${ctx.baseUrl}/knowledge/${LEARNING_OPTOUT}`, { 'X-API-Key': RAW_BUYER_OPTOUT });
    assert.equal(unlock.status, 200, JSON.stringify(unlock.body));
    assert.equal(unlock.body._revenue.contributor_earned_usd, 0.7, 'the accrual itself still happens — only the notification is skipped');
    const newOutput = ctx.getOutput().slice(before);
    assert.ok(!/earning-digest/.test(newOutput), 'an opted-out contributor must never queue or flush a digest');
    const queue = notifQueue();
    assert.ok(!queue[CONTRIB_OPTOUT], 'no queue row (and therefore no stored title/amount) was ever created for the opted-out contributor');
  });

  it('two real unlocks of two different learnings by the same held-back contributor batch into ONE queued entry with both titles, when a send is not yet due', async () => {
    if (ctx.skipReason) return;
    // Pre-seed lastSentAt to "just now" so BOTH opportunistic flushes below
    // see "not due yet" and skip — this is the deterministic way to observe
    // true batching without racing the two requests against each other.
    const notifFile = path.join(ctx.dataDir, 'earning-notifications.json');
    const seeded = readJson(notifFile);
    seeded[CONTRIB_DIGEST] = { pending: [], lastSentAt: Date.now() };
    writeJson(notifFile, seeded);

    const unlockA = await getJson(`${ctx.baseUrl}/knowledge/${LEARNING_DIGEST_A}`, { 'X-API-Key': RAW_BUYER_DIGEST_A });
    assert.equal(unlockA.status, 200, JSON.stringify(unlockA.body));
    const unlockB = await getJson(`${ctx.baseUrl}/knowledge/${LEARNING_DIGEST_B}`, { 'X-API-Key': RAW_BUYER_DIGEST_B });
    assert.equal(unlockB.status, 200, JSON.stringify(unlockB.body));

    const queue = notifQueue();
    assert.ok(queue[CONTRIB_DIGEST], 'the contributor has a queue row');
    assert.equal(queue[CONTRIB_DIGEST].pending.length, 2, 'both accruals are batched, neither sent yet');
    const titles = queue[CONTRIB_DIGEST].pending.map((i) => i.title).sort();
    assert.deepEqual(titles, [`Launch-wave fixture ${LEARNING_DIGEST_A}`, `Launch-wave fixture ${LEARNING_DIGEST_B}`].sort());
    for (const item of queue[CONTRIB_DIGEST].pending) {
      assert.equal(item.amountUsd, 0.7);
      assert.ok(item.learningId === LEARNING_DIGEST_A || item.learningId === LEARNING_DIGEST_B);
    }
  });

  it('GET /account/settings reports earning_notifications_available: true when the flag is on, and PATCH round-trips the preference', async () => {
    if (ctx.skipReason) return;
    const jwt = await sessionToken(BUYER_SETTINGS, 'lwe-buyer-settings@test.local');
    const get1 = await getJson(`${ctx.baseUrl}/account/settings`, { 'X-API-Key': RAW_BUYER_SETTINGS });
    assert.equal(get1.status, 200);
    assert.equal(get1.body.earning_notifications_available, true);
    assert.equal(get1.body.earning_notifications_enabled, true, 'default true when unset');

    // PATCH /account/settings uses requireAuth (a Bearer session JWT), not
    // requireSessionOrApiKey — an API key alone is not accepted here.
    const patch = await patchJson(`${ctx.baseUrl}/account/settings`, { earning_notifications_enabled: false }, { Authorization: `Bearer ${jwt}` });
    assert.equal(patch.status, 200, JSON.stringify(patch.body));
    assert.equal(patch.body.current.earning_notifications_enabled, false);

    const get2 = await getJson(`${ctx.baseUrl}/account/settings`, { 'X-API-Key': RAW_BUYER_SETTINGS });
    assert.equal(get2.body.earning_notifications_enabled, false, 'persisted across requests');
  });

  it('PATCH /account/settings with a non-boolean earning_notifications_enabled returns 400 and does not mutate the account', async () => {
    if (ctx.skipReason) return;
    const jwt = await sessionToken(BUYER_TOKENS, 'lwe-buyer-tokens@test.local');
    const before = await getJson(`${ctx.baseUrl}/account/settings`, { 'X-API-Key': RAW_BUYER_TOKENS });
    const patch = await patchJson(`${ctx.baseUrl}/account/settings`, { earning_notifications_enabled: 'yes' }, { Authorization: `Bearer ${jwt}` });
    assert.equal(patch.status, 400);
    const after1 = await getJson(`${ctx.baseUrl}/account/settings`, { 'X-API-Key': RAW_BUYER_TOKENS });
    assert.deepEqual(after1.body, before.body, 'no mutation on a 400');
  });

  it('each preference change appends one opt-out record with its source and timestamp, and the list never exceeds 20', async () => {
    if (ctx.skipReason) return;
    const jwt = await sessionToken(BUYER_TOKENS, 'lwe-buyer-tokens@test.local');
    for (let i = 0; i < 25; i++) {
      const patch = await patchJson(`${ctx.baseUrl}/account/settings`, { earning_notifications_enabled: i % 2 === 0 }, { Authorization: `Bearer ${jwt}` });
      assert.equal(patch.status, 200, JSON.stringify(patch.body));
    }
    const accounts = readJson(path.join(ctx.dataDir, 'accounts.json'));
    const log = accounts[BUYER_TOKENS].earning_email_pref_log;
    assert.ok(Array.isArray(log));
    assert.equal(log.length, 20, 'bounded to the last 20 entries');
    for (const entry of log) {
      assert.equal(entry.source, 'dashboard');
      assert.equal(typeof entry.value, 'boolean');
      assert.match(entry.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      assert.equal(entry.account_id, BUYER_TOKENS);
    }
  });

  it('GET .../unsubscribe with a garbage token returns 400 and mutates no account', async () => {
    if (ctx.skipReason) return;
    const before = readJson(path.join(ctx.dataDir, 'accounts.json'));
    const res = await getJson(`${ctx.baseUrl}/account/email-prefs/unsubscribe?token=garbage`);
    assert.equal(res.status, 400);
    assert.deepEqual(readJson(path.join(ctx.dataDir, 'accounts.json')), before);
    // A5a: the 'expired' state wraps its content in <main>.
    assert.match(res.text, /<main class="unsub-wrap" id="main">/);
  });

  it('a valid earning-emails-off token flips the flag exactly once via the POST form, appends an email_link opt-out record, and is single-use (a second POST with the same token fails)', async () => {
    if (ctx.skipReason) return;
    const rawToken = crypto.randomBytes(32).toString('base64url');
    const magicLinksFile = path.join(ctx.dataDir, 'magic_links.json');
    const links = readJson(magicLinksFile);
    links[sha256(rawToken)] = { email: 'lwe-buyer-normal@test.local', purpose: 'earning-emails-off', expires_at: Date.now() + 900_000 };
    writeJson(magicLinksFile, links);

    const getPage = await getJson(`${ctx.baseUrl}/account/email-prefs/unsubscribe?token=${rawToken}`);
    assert.equal(getPage.status, 200);
    assert.match(getPage.text, /Stop Unlock Emails/);
    assert.match(getPage.text, /Turn Off Unlock Emails/);
    assert.match(getPage.text, new RegExp(`value="${rawToken}"`), 'token is placed in the hidden form field');
    // A5a: the 'form' state wraps its content in <main>.
    assert.match(getPage.text, /<main class="unsub-wrap" id="main">/);

    const post1 = await postForm(`${ctx.baseUrl}/account/email-prefs/unsubscribe`, { token: rawToken });
    assert.equal(post1.status, 200);
    assert.match(post1.text, /Unlock emails are off/);
    // A5a: the 'done' state wraps its content in <main>.
    assert.match(post1.text, /<main class="unsub-wrap" id="main">/);

    const accountsAfter = readJson(path.join(ctx.dataDir, 'accounts.json'));
    assert.equal(accountsAfter[BUYER_NORMAL].earning_notifications_enabled, false);
    const log = accountsAfter[BUYER_NORMAL].earning_email_pref_log;
    assert.ok(Array.isArray(log) && log.length >= 1);
    assert.equal(log[log.length - 1].source, 'email_link');
    assert.equal(log[log.length - 1].value, false);

    const post2 = await postForm(`${ctx.baseUrl}/account/email-prefs/unsubscribe`, { token: rawToken });
    assert.equal(post2.status, 401, 'the token was single-use — a second POST must fail');
    assert.match(post2.text, /expired/);
  });

  it('a token minted for account deletion cannot turn off notifications, and the reverse', async () => {
    if (ctx.skipReason) return;
    const deleteToken = crypto.randomBytes(32).toString('base64url');
    const unsubToken = crypto.randomBytes(32).toString('base64url');
    const magicLinksFile = path.join(ctx.dataDir, 'magic_links.json');
    const links = readJson(magicLinksFile);
    links[sha256(deleteToken)] = { email: 'lwe-buyer-tokens@test.local', purpose: 'delete-account', expires_at: Date.now() + 900_000 };
    links[sha256(unsubToken)] = { email: 'lwe-buyer-tokens@test.local', purpose: 'earning-emails-off', expires_at: Date.now() + 900_000 };
    writeJson(magicLinksFile, links);

    const crossA = await postForm(`${ctx.baseUrl}/account/email-prefs/unsubscribe`, { token: deleteToken });
    assert.equal(crossA.status, 401, 'a delete-account token must not be redeemable here');

    const crossB = await postJson(`${ctx.baseUrl}/account/delete-confirm`, { method: 'email', token: unsubToken });
    assert.equal(crossB.status, 401, 'an earning-emails-off token must not be redeemable for deletion');

    // Both tokens remain valid for their OWN purpose after the cross-attempts
    // above (consumePurposeMagicLink only deletes on a purpose MATCH).
    const ownPurpose = await postForm(`${ctx.baseUrl}/account/email-prefs/unsubscribe`, { token: unsubToken });
    assert.equal(ownPurpose.status, 200, 'the unsub token still works for its own purpose');
  });

  it('a first sign-in with WELCOME_EMAIL_ENABLED=true and no RESEND_API_KEY runs the dev-mode branch (no network call, exactly one log line), and never fires again for the same or a pre-existing account', async () => {
    if (ctx.skipReason) return;
    const newEmail = 'lwe-new-signup@test.local';
    const rawToken1 = crypto.randomBytes(32).toString('base64url');
    const magicLinksFile = path.join(ctx.dataDir, 'magic_links.json');
    let links = readJson(magicLinksFile);
    links[sha256(rawToken1)] = { email: newEmail, expires_at: Date.now() + 900_000 };
    writeJson(magicLinksFile, links);

    const before = ctx.getOutput().length;
    const first = await getJson(`${ctx.baseUrl}/auth/verify?token=${rawToken1}`);
    assert.equal(first.status, 200);
    const afterFirst = ctx.getOutput().slice(before);
    // PM review (post-ship defect #4): the dev-mode log line must use
    // redactEmail (domain only), exactly like the earning-digest dev-mode
    // line already does — never the full address.
    const welcomeLines = (afterFirst.match(/Welcome email skipped \(dev mode\) for <redacted>@test\.local/g) || []);
    assert.equal(welcomeLines.length, 1, 'exactly one welcome-email dev-mode log line on first-ever sign-in');
    // Scope the "never the full address" check to the welcome-email log line
    // itself — a separate, pre-existing log line ("Verified magic link for
    // ... -> account ...") legitimately logs the full email elsewhere in the
    // same output and is out of scope for this assertion.
    const welcomeLineFull = afterFirst.split('\n').find((line) => line.includes('Welcome email skipped'));
    assert.ok(welcomeLineFull, 'the welcome-email dev-mode line is present');
    assert.ok(!welcomeLineFull.includes(newEmail), 'the dev-mode log line must never print the full email address');

    // Second sign-in, same (now-existing) account: no second welcome-email line.
    const rawToken2 = crypto.randomBytes(32).toString('base64url');
    links = readJson(magicLinksFile);
    links[sha256(rawToken2)] = { email: newEmail, expires_at: Date.now() + 900_000 };
    writeJson(magicLinksFile, links);
    const beforeSecond = ctx.getOutput().length;
    const second = await getJson(`${ctx.baseUrl}/auth/verify?token=${rawToken2}`);
    assert.equal(second.status, 200);
    const afterSecond = ctx.getOutput().slice(beforeSecond);
    assert.ok(!/Welcome email/.test(afterSecond), 'no welcome email on a second sign-in of the same account');
  });

  it('a sign-in for an account seeded as pre-existing (before this code shipped) never gets a welcome email', async () => {
    if (ctx.skipReason) return;
    const preexistingEmail = 'lwe-buyer-normal@test.local'; // already in accounts.json at boot
    const rawToken = crypto.randomBytes(32).toString('base64url');
    const magicLinksFile = path.join(ctx.dataDir, 'magic_links.json');
    const links = readJson(magicLinksFile);
    links[sha256(rawToken)] = { email: preexistingEmail, expires_at: Date.now() + 900_000 };
    writeJson(magicLinksFile, links);

    const before = ctx.getOutput().length;
    const verify = await getJson(`${ctx.baseUrl}/auth/verify?token=${rawToken}`);
    assert.equal(verify.status, 200);
    const output = ctx.getOutput().slice(before);
    assert.ok(!/Welcome email/.test(output), 'created:false for a pre-existing account, so no welcome email');
  });

  // PM review (post-ship): the legal memo's retention requirement asked
  // whether a deleted account's row in the notification queue file is
  // removed too. server.js:executeAccountDeletion (the same block that
  // already calls removeMagicLinksForEmail/removeWaitlistEmail) is the
  // deletion path, and it is in this builder's file list — so the removal
  // is added there (earningNotifications.removeAccount(accountId)), the
  // smallest possible change alongside the existing per-account cleanup.
  it('deleting an account removes its row from the earning-notifications queue file (GOV-2 retention)', async () => {
    if (ctx.skipReason) return;
    const notifFile = path.join(ctx.dataDir, 'earning-notifications.json');
    const seeded = readJson(notifFile);
    seeded[BUYER_DELETE_TARGET] = {
      pending: [{ learningId: 'lrn_delete_target', title: 'Should not survive deletion', amountUsd: 1, ts: Date.now() }],
      lastSentAt: null,
      attempts: 0,
    };
    writeJson(notifFile, seeded);
    assert.ok(readJson(notifFile)[BUYER_DELETE_TARGET], 'sanity: the row exists before deletion');

    const deleteToken = crypto.randomBytes(32).toString('base64url');
    const magicLinksFile = path.join(ctx.dataDir, 'magic_links.json');
    const links = readJson(magicLinksFile);
    links[sha256(deleteToken)] = {
      email: 'lwe-buyer-delete-target@test.local',
      purpose: 'delete-account',
      expires_at: Date.now() + 900_000,
    };
    writeJson(magicLinksFile, links);

    const del = await postJson(`${ctx.baseUrl}/account/delete-confirm`, { method: 'email', token: deleteToken });
    assert.equal(del.status, 200, JSON.stringify(del.body));

    const after = readJson(notifFile);
    assert.equal(Object.prototype.hasOwnProperty.call(after, BUYER_DELETE_TARGET), false,
      "the deleted account's queued learning titles/amounts must not survive the account");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// L6: EARNING_NOTIFICATIONS_ENABLED on, but RESEND_API_KEY unset, in a
// production environment — a misconfiguration, not a dev environment. Its
// own boot (NODE_ENV: 'production') so it never shares state with the
// dev-mode-logging cases above.
// ─────────────────────────────────────────────────────────────────────────
describe('LAUNCH-WAVE-EMAILS-E2E: L6 misconfigured production (flag on, no RESEND_API_KEY)', { timeout: 180_000 }, () => {
  const CONTRIB_ID = 'acc_lwe_l6_contrib';
  const CONTRIB_WALLET = '0x' + '9a'.repeat(20);
  const BUYER_ID = 'acc_lwe_l6_buyer';
  const RAW_BUYER_KEY = `axl_${'9'.repeat(40)}`;
  const LEARNING_ID = 'lrn_lwe_l6_1';

  let ctx;

  before(async () => {
    ctx = await boot({
      envExtra: { EARNING_NOTIFICATIONS_ENABLED: 'true', NODE_ENV: 'production' },
      accounts: {
        [CONTRIB_ID]: {
          id: CONTRIB_ID, email: 'lwe-l6-contrib@test.local', wallet: CONTRIB_WALLET,
          created_at: FIXED_AT, tos_version: CURRENT_TOS_VERSION,
          accepted_at: Date.parse(FIXED_AT), accepted_affirmed: true, api_keys: [],
        },
        [BUYER_ID]: {
          id: BUYER_ID, email: 'lwe-l6-buyer@test.local', created_at: FIXED_AT,
          api_keys: [apiKeyEntry(RAW_BUYER_KEY, 'key_lwe_l6_buyer', 'buyer', 'read')],
        },
      },
      learnings: [fixtureLearning(LEARNING_ID, { contributorAccountId: CONTRIB_ID, contributorWallet: CONTRIB_WALLET })],
      credits: { [BUYER_ID]: creditRecord(1) },
    });
    if (!ctx.skipReason) {
      // A due item already sitting in the queue before the unlock below —
      // proves the branch never drains what it cannot send, on top of the
      // item the unlock itself queues.
      const notifFile = path.join(ctx.dataDir, 'earning-notifications.json');
      writeJson(notifFile, {
        [CONTRIB_ID]: { pending: [{ learningId: 'lrn_preseeded', title: 'Pre-seeded', amountUsd: 0.7, ts: Date.now() }], lastSentAt: null, attempts: 0 },
      });
    }
  });

  after(async () => { if (ctx && ctx.child) { await stopServer(ctx.child); fs.rmSync(ctx.tmpDir, { recursive: true, force: true }); } });

  it('L6: logs one line with no address/URL/token and leaves every queued item intact (does not drain)', async () => {
    if (ctx.skipReason) return;
    const before = ctx.getOutput().length;
    const unlock = await getJson(`${ctx.baseUrl}/knowledge/${LEARNING_ID}`, { 'X-API-Key': RAW_BUYER_KEY });
    assert.equal(unlock.status, 200, JSON.stringify(unlock.body));
    assert.equal(unlock.body._revenue.contributor_earned_usd, 0.7);

    const newOutput = ctx.getOutput().slice(before);
    assert.match(newOutput, /\[earning-digest\] email delivery not configured in production; leaving queue intact/);
    assert.ok(!/dev mode:/.test(newOutput), 'the dev-mode log line must never fire in production');
    assert.ok(!/email-prefs\/unsubscribe\?token=/.test(newOutput), 'no opt-out URL is ever logged');
    assert.ok(!/lwe-l6-contrib@test\.local/.test(newOutput), 'no address is ever logged');

    const queue = readJson(path.join(ctx.dataDir, 'earning-notifications.json'));
    assert.ok(queue[CONTRIB_ID], 'the queue row still exists — nothing was drained');
    assert.equal(queue[CONTRIB_ID].pending.length, 2, 'the pre-seeded item AND the new unlock item are both still queued');
    assert.equal(queue[CONTRIB_ID].lastSentAt, null, 'lastSentAt is never stamped when nothing was actually sent');
  });
});
