'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
process.env.SESSION_SECRET ||= 'seed-attr-test-session-secret-32-bytes';
const {
  BOOT_SANDBOX_SKIP_REASON,
  bootServer,
  reservePort,
  stageServer,
  stopServer,
} = require('./helpers/staged-server');
const { migratePipelineOwners } = require('../lib/pipeline-owner-migration.js');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'attribute-seed-learnings.js');
const PLATFORM_ACCOUNT_ID = 'acc_platform';
const LEGACY_WALLET = '0x1BE960313c93b3aA0AA62BF33B300CAB48c36Ca6';
const PLATFORM_NOTE = 'First-class platform identity for the platform-wallet-origin learnings published with no account attached (SEED-ATTR, Tyler-ruled 2026-09-02)';
const BUYER_ACCOUNT_ID = 'acc_seed_attr_buyer';
const RAW_BUYER_KEY = `axl_${'7'.repeat(40)}`;
const UNLOCK_FIXTURE_ID = 'lrn_seed_attr_booking_diff';
const FIXED_AT = '2026-09-02T12:00:00.000Z';

function fixtureRows() {
  return [
    {
      id: 'seed-visible-approved',
      title: 'Approved seed',
      status: 'approved',
      contributor_wallet: LEGACY_WALLET,
      contributor_agent: 'platform-seed',
      earnings: { total: 17, unlocks: 6 },
    },
    {
      id: 'seed-visible-legacy',
      title: 'Legacy status seed',
      contributor_wallet: LEGACY_WALLET.toUpperCase(),
      contributor_agent: 'unknown',
    },
    {
      id: 'seed-private',
      visibility: 'private',
      status: 'approved',
      contributor_wallet: LEGACY_WALLET,
    },
    {
      id: 'seed-pending',
      status: 'pending_review',
      contributor_wallet: LEGACY_WALLET,
    },
    {
      id: 'already-attributed',
      status: 'approved',
      contributor_wallet: LEGACY_WALLET,
      contributor_account_id: 'acc_existing',
    },
    {
      id: 'different-wallet',
      status: 'approved',
      contributor_wallet: '0x0000000000000000000000000000000000000001',
    },
  ];
}

function makeFixture(accounts = { acc_existing: { email: 'owner@example.test', created_at: 1, api_keys: [] } }) {
  const app = fs.mkdtempSync(path.join(os.tmpdir(), 'auxilo-seed-attr-'));
  const data = path.join(app, 'data');
  fs.mkdirSync(data, { recursive: true });
  const learnings = fixtureRows();
  fs.writeFileSync(path.join(data, 'learnings.json'), JSON.stringify(learnings, null, 2));
  fs.writeFileSync(path.join(data, 'accounts.json'), JSON.stringify(accounts, null, 2));
  return { app, data, learnings, accounts };
}

function run(app, args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, APP_DIR: app, CONTENT_MODERATION_ENABLED: 'true' },
  });
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function digest(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function backupFiles(data) {
  const dir = path.join(data, 'backups');
  return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
}

test('dry-run reports visible and whole-store matches without mutating either store', () => {
  const { app, data } = makeFixture();
  try {
    const learningsFile = path.join(data, 'learnings.json');
    const accountsFile = path.join(data, 'accounts.json');
    const before = [digest(learningsFile), digest(accountsFile)];

    const result = run(app, ['--account', PLATFORM_ACCOUNT_ID, '--expect', '4']);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /mode: DRY-RUN/);
    assert.match(result.stdout, /visible matches: 2/);
    assert.match(result.stdout, /whole-store matches: 4/);
    for (const id of ['seed-visible-approved', 'seed-visible-legacy', 'seed-private', 'seed-pending']) {
      assert.match(result.stdout, new RegExp(`  - ${id}`));
    }
    assert.doesNotMatch(result.stdout, /  - already-attributed/);
    assert.deepEqual([digest(learningsFile), digest(accountsFile)], before);
    assert.deepEqual(backupFiles(data), []);
  } finally {
    fs.rmSync(app, { recursive: true, force: true });
  }
});

test('--apply --expect N changes exactly one field on matched rows and creates the platform account once', () => {
  const { app, data, learnings: beforeLearnings, accounts: beforeAccounts } = makeFixture();
  try {
    const learningsFile = path.join(data, 'learnings.json');
    const accountsFile = path.join(data, 'accounts.json');
    const learningBytesBefore = fs.readFileSync(learningsFile);
    const accountBytesBefore = fs.readFileSync(accountsFile);

    const result = run(app, ['--account', PLATFORM_ACCOUNT_ID, '--expect', '4', '--apply']);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /mode: APPLY/);
    assert.match(result.stdout, /visible matches: 2/);
    assert.match(result.stdout, /whole-store matches: 4/);
    assert.match(result.stdout, /  - seed-visible-approved/);
    const afterLearnings = readJson(learningsFile);
    const afterAccounts = readJson(accountsFile);
    const matchedIds = new Set(['seed-visible-approved', 'seed-visible-legacy', 'seed-private', 'seed-pending']);

    for (const before of beforeLearnings) {
      const after = afterLearnings.find(row => row.id === before.id);
      if (matchedIds.has(before.id)) {
        assert.deepEqual(after, { ...before, contributor_account_id: PLATFORM_ACCOUNT_ID });
        assert.equal(after.contributor_wallet, before.contributor_wallet, `${before.id} wallet provenance changed`);
      } else {
        assert.deepEqual(after, before, `${before.id} must remain untouched`);
      }
    }

    assert.deepEqual(afterAccounts.acc_existing, beforeAccounts.acc_existing);
    assert.deepEqual(Object.keys(afterAccounts[PLATFORM_ACCOUNT_ID]), [
      'email', 'created_at', 'api_keys', 'platform', 'note',
    ]);
    assert.equal(afterAccounts[PLATFORM_ACCOUNT_ID].email, 'platform@auxilo.io');
    assert.match(afterAccounts[PLATFORM_ACCOUNT_ID].created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.deepEqual(afterAccounts[PLATFORM_ACCOUNT_ID].api_keys, []);
    assert.equal(afterAccounts[PLATFORM_ACCOUNT_ID].platform, true);
    assert.equal(afterAccounts[PLATFORM_ACCOUNT_ID].note, PLATFORM_NOTE);

    const backups = backupFiles(data);
    assert.equal(backups.length, 2);
    const learningBackup = backups.find(name => name.startsWith('learnings-pre-seed-attr-'));
    const accountBackup = backups.find(name => name.startsWith('accounts-pre-seed-attr-'));
    assert.ok(learningBackup);
    assert.ok(accountBackup);
    assert.deepEqual(fs.readFileSync(path.join(data, 'backups', learningBackup)), learningBytesBefore);
    assert.deepEqual(fs.readFileSync(path.join(data, 'backups', accountBackup)), accountBytesBefore);
    assert.equal(fs.existsSync(`${learningsFile}.tmp`), false);
    assert.equal(fs.existsSync(`${accountsFile}.tmp`), false);
  } finally {
    fs.rmSync(app, { recursive: true, force: true });
  }
});

test('wrong --expect aborts before backups, account creation, or learning writes', () => {
  const { app, data } = makeFixture();
  try {
    const learningsFile = path.join(data, 'learnings.json');
    const accountsFile = path.join(data, 'accounts.json');
    const before = [digest(learningsFile), digest(accountsFile)];

    const result = run(app, ['--account', PLATFORM_ACCOUNT_ID, '--expect', '3', '--apply']);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /expected 3 whole-store matches, found 4; no files written/);
    assert.deepEqual([digest(learningsFile), digest(accountsFile)], before);
    assert.deepEqual(backupFiles(data), []);
  } finally {
    fs.rmSync(app, { recursive: true, force: true });
  }
});

test('a second apply with --expect 0 is a clean byte-for-byte no-op', () => {
  const { app, data } = makeFixture();
  try {
    const learningsFile = path.join(data, 'learnings.json');
    const accountsFile = path.join(data, 'accounts.json');
    const first = run(app, ['--account', PLATFORM_ACCOUNT_ID, '--expect', '4', '--apply']);
    assert.equal(first.status, 0, first.stderr);

    const before = [digest(learningsFile), digest(accountsFile)];
    const backupsBefore = backupFiles(data);
    const createdAt = readJson(accountsFile)[PLATFORM_ACCOUNT_ID].created_at;
    const second = run(app, ['--account', PLATFORM_ACCOUNT_ID, '--expect', '0', '--apply']);

    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /whole-store matches: 0/);
    assert.match(second.stdout, /Nothing to do/);
    assert.deepEqual([digest(learningsFile), digest(accountsFile)], before);
    assert.deepEqual(backupFiles(data), backupsBefore);
    assert.equal(readJson(accountsFile)[PLATFORM_ACCOUNT_ID].created_at, createdAt);
  } finally {
    fs.rmSync(app, { recursive: true, force: true });
  }
});

test('the ruling-bearing account and an integer expectation are both mandatory', () => {
  const { app, data } = makeFixture();
  try {
    const learningsFile = path.join(data, 'learnings.json');
    const accountsFile = path.join(data, 'accounts.json');
    const before = [digest(learningsFile), digest(accountsFile)];
    const invocations = [
      { args: ['--expect', '4', '--apply'], error: /usage:/ },
      { args: ['--account', 'acc_someone_else', '--expect', '4', '--apply'], error: /--account must be acc_platform/ },
      { args: ['--account', PLATFORM_ACCOUNT_ID, '--apply'], error: /--expect must be a non-negative integer/ },
      { args: ['--account', PLATFORM_ACCOUNT_ID, '--expect', '-1', '--apply'], error: /--expect must be a non-negative integer/ },
    ];

    for (const invocation of invocations) {
      const result = run(app, invocation.args);
      assert.equal(result.status, 1);
      assert.match(result.stderr, invocation.error);
    }
    assert.deepEqual([digest(learningsFile), digest(accountsFile)], before);
    assert.deepEqual(backupFiles(data), []);
  } finally {
    fs.rmSync(app, { recursive: true, force: true });
  }
});

function apiKeyEntry() {
  return {
    id: 'key_seed_attr_buyer',
    hash: crypto.createHash('sha256').update(RAW_BUYER_KEY).digest('hex'),
    label: 'seed-attr-buyer',
    scope: 'read',
    scope_version: 2,
    created_at: FIXED_AT,
    active: true,
  };
}

function unlockLearning(contributorAccountId) {
  return {
    id: UNLOCK_FIXTURE_ID,
    title: 'Seed attribution booking equivalence fixture',
    body: 'A platform-account attribution must preserve the legacy wallet earnings mutation exactly.',
    snippet: 'Seed attribution booking equivalence fixture.',
    category: 'code-execution',
    tags: ['seed-attr', 'earnings'],
    task_context: 'Verify account attribution does not change money booking.',
    outcome: 'success',
    status: 'approved',
    visibility: 'public',
    contributor_account_id: contributorAccountId,
    contributor_wallet: LEGACY_WALLET,
    contributor_agent: 'platform-seed',
    unlock_price: 0.1,
    pricing: { current_price: 0.1, floor_price: 0.05, ceiling_price: 20 },
    demand: {
      search_impressions_7d: 0,
      search_impressions_30d: 0,
      unlocks_7d: 0,
      unlocks_30d: 0,
    },
    earnings: { gross_usd: 0, contributor_share_usd: 0, platform_share_usd: 0 },
    quality: {
      unlocks: 0,
      unlocks_total: 0,
      ratings: 0,
      avg_helpfulness: 0,
      helpfulness_scores: [],
      score: 0,
    },
    created_at: FIXED_AT,
    updated_at: FIXED_AT,
  };
}

function unlockAccounts() {
  return {
    [PLATFORM_ACCOUNT_ID]: {
      email: 'platform@auxilo.io',
      created_at: FIXED_AT,
      api_keys: [],
      platform: true,
      note: PLATFORM_NOTE,
    },
    [BUYER_ACCOUNT_ID]: {
      id: BUYER_ACCOUNT_ID,
      email: 'seed-attr-buyer@example.test',
      created_at: FIXED_AT,
      api_keys: [apiKeyEntry()],
    },
  };
}

function unlockCredits() {
  return {
    [BUYER_ACCOUNT_ID]: {
      queries_used: 0,
      unlocks_used: 0,
      purchased_queries: 0,
      purchased_unlocks: 1,
      unlock_lots: [{
        unit_price_usd: 0.1,
        remaining: 1,
        added_at: Date.parse(FIXED_AT),
      }],
      period_start: '2026-09-01T00:00:00.000Z',
      period_end: '2099-09-01T00:00:00.000Z',
      created_at: Date.parse(FIXED_AT),
      last_deducted_at: null,
    },
  };
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

async function runUnlockFixture(contributorAccountId) {
  const reservation = await reservePort();
  if ('skipReason' in reservation) return reservation;

  const honoEntry = require.resolve('hono', { paths: [ROOT] });
  const nodeModulesDir = honoEntry.slice(
    0,
    honoEntry.lastIndexOf(`${path.sep}node_modules${path.sep}`) + '/node_modules'.length,
  );
  const app = fs.mkdtempSync(path.join(os.tmpdir(), 'auxilo-seed-attr-unlock-'));
  let child;
  try {
    const { dataDir } = stageServer({
      repoRoot: ROOT,
      tmpDir: app,
      nodeModulesDir,
      port: reservation.port,
      rootFiles: [
        'server.js',
        'seed-knowledge.json',
        'skills.json',
        'openapi.json',
        'package.json',
        'model_config.json',
      ],
      linkDirs: [],
      copyDirs: ['lib', 'public', 'prompts', 'config'],
      replacements: [{
        name: 'freeze SEED-ATTR fixture clock',
        search: "const { Hono } = require('hono');",
        replace: [
          'const SeedAttrRealDate = Date;',
          'global.Date = class SeedAttrFrozenDate extends SeedAttrRealDate {',
          `  constructor(...args) { super(...(args.length ? args : [${JSON.stringify(FIXED_AT)}])); }`,
          `  static now() { return SeedAttrRealDate.parse(${JSON.stringify(FIXED_AT)}); }`,
          '};',
          "const { Hono } = require('hono');",
        ].join('\n'),
      }],
    });

    writeJson(path.join(dataDir, 'learnings.json'), [unlockLearning(contributorAccountId)]);
    writeJson(path.join(dataDir, 'accounts.json'), unlockAccounts());
    writeJson(path.join(dataDir, 'earnings.json'), {});
    writeJson(path.join(dataDir, 'credits.json'), unlockCredits());
    writeJson(path.join(dataDir, 'unlock-attribution.json'), {});
    writeJson(path.join(dataDir, 'purchase-ledger.json'), {});
    writeJson(path.join(dataDir, 'verified-wallets.json'), {});

    const boot = await bootServer({
      tmpDir: app,
      port: reservation.port,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        PAYMENTS_ENABLED: 'true',
        WALLET_PRIVATE_KEY: `0x${'11'.repeat(32)}`,
        SESSION_SECRET: 'seed-attr-fixture-session-secret',
        CONTENT_MODERATION_ENABLED: 'true',
        LLM_SENSITIVITY_ENABLED: 'false',
        AUXILO_ACCOUNTS_FILE: path.join(dataDir, 'accounts.json'),
        AUXILO_CREDITS_FILE: path.join(dataDir, 'credits.json'),
        AUXILO_UNLOCK_ATTRIBUTION_FILE: path.join(dataDir, 'unlock-attribution.json'),
        AUXILO_PURCHASE_LEDGER_FILE: path.join(dataDir, 'purchase-ledger.json'),
      },
      timeoutMs: 60_000,
      maxAttempts: 3,
    });
    if ('skipReason' in boot) return boot;
    child = boot.child;

    const response = await fetch(`${boot.baseUrl}/knowledge/${UNLOCK_FIXTURE_ID}`, {
      headers: { 'X-API-Key': RAW_BUYER_KEY },
    });
    const responseText = await response.text();
    assert.equal(
      response.status,
      200,
      `unlock returned ${response.status}: ${responseText}\n${boot.getOutput().slice(-2000)}`,
    );

    const earningsFile = path.join(dataDir, 'earnings.json');
    return {
      bytes: fs.readFileSync(earningsFile),
      store: readJson(earningsFile),
    };
  } finally {
    if (child) await stopServer(child);
    fs.rmSync(app, { recursive: true, force: true });
  }
}

test('server uses one shared platform-account guard before every unlock crediting branch', () => {
  const source = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const start = source.indexOf("app.get('/knowledge/:id'");
  const end = source.indexOf("app.post('/knowledge/:id/rate'", start);
  assert.ok(start !== -1 && end > start);
  const handler = source.slice(start, end);
  const guard = 'normalizeCreditingContributorAccountId(learning.contributor_account_id)';
  assert.equal((source.match(/normalizeCreditingContributorAccountId\(/g) || []).length, 2);
  assert.ok(handler.includes(guard));
  const guardAt = handler.indexOf(guard);
  for (const downstream of [
    'account_id: contribAccountId',
    'const contribAccount = contribAccountId',
    'contributor_account_id: contribAccountId',
  ]) {
    assert.ok(handler.indexOf(downstream) > guardAt, `${downstream} must consume the guarded id`);
  }
  assert.doesNotMatch(handler.slice(guardAt + guard.length), /learning\.contributor_account_id/);

  const replayStart = source.indexOf('function replayUnlock(entry)');
  const replayEnd = source.indexOf('// All steps done', replayStart);
  assert.ok(replayStart !== -1 && replayEnd > replayStart);
  const replay = source.slice(replayStart, replayEnd);
  assert.ok(replay.includes(
    'const replayContributorAccountId = normalizeCreditingContributorAccountId(contributor_account_id);',
  ));
  assert.ok(replay.includes('? (replayContributorAccountId || builder_wallet)'));
  assert.ok(replay.includes('contributor_account_id: replayContributorAccountId'));
  assert.doesNotMatch(replay, /account_id:\s*contributor_account_id/);
  assert.doesNotMatch(replay, /initEarningsEntry\(contributor_account_id/);
});

test('AC-1 earnings repair treats acc_platform byte-identically to a null-account row', () => {
  const realDate = Date;
  global.Date = class SeedAttrMigrationDate extends realDate {
    constructor(...args) { super(...(args.length ? args : [FIXED_AT])); }
    static now() { return realDate.parse(FIXED_AT); }
  };

  const runRepair = (contributorAccountId) => {
    const learnings = [{
      id: UNLOCK_FIXTURE_ID,
      contributor_account_id: contributorAccountId,
      contributor_wallet: LEGACY_WALLET,
    }];
    const earnings = {
      null: {
        account_id: null,
        wallet: null,
        total_gross: 0.1,
        total_contributor: 0.07,
        total_platform: 0.03,
        pending_balance: 0.07,
        by_learning: {
          [UNLOCK_FIXTURE_ID]: {
            gross: 0.1,
            contributor: 0.07,
            platform: 0.03,
            unlocks: 1,
          },
        },
      },
    };
    migratePipelineOwners(learnings, earnings, {
      [PLATFORM_ACCOUNT_ID]: { email: 'platform@auxilo.io', api_keys: [], platform: true },
    });
    return Buffer.from(JSON.stringify(earnings, null, 2));
  };

  try {
    const nullAccount = runRepair(null);
    const platformAccount = runRepair(PLATFORM_ACCOUNT_ID);
    assert.deepEqual(platformAccount, nullAccount);
    const repaired = JSON.parse(platformAccount.toString('utf8'));
    assert.equal(Object.hasOwn(repaired, PLATFORM_ACCOUNT_ID), false);
    assert.deepEqual(Object.keys(repaired), [LEGACY_WALLET]);
  } finally {
    global.Date = realDate;
  }
});

test('fixture diff: acc_platform and null-account unlocks mutate earnings.json byte-identically', {
  timeout: 180_000,
}, async (t) => {
  const nullAccount = await runUnlockFixture(null);
  if ('skipReason' in nullAccount) {
    assert.equal(nullAccount.skipReason, BOOT_SANDBOX_SKIP_REASON);
    t.skip(nullAccount.skipReason);
    return;
  }
  const platformAccount = await runUnlockFixture(PLATFORM_ACCOUNT_ID);
  if ('skipReason' in platformAccount) {
    assert.equal(platformAccount.skipReason, BOOT_SANDBOX_SKIP_REASON);
    t.skip(platformAccount.skipReason);
    return;
  }

  assert.deepEqual(platformAccount.bytes, nullAccount.bytes);
  assert.equal(Object.hasOwn(platformAccount.store, PLATFORM_ACCOUNT_ID), false);
  // Pin the existing caller behavior byte-for-byte: a newly created entry is
  // keyed with the stored checksummed wallet, not the lowercase lookup form.
  const walletKey = LEGACY_WALLET;
  assert.deepEqual(Object.keys(platformAccount.store), [walletKey]);
  const entry = platformAccount.store[walletKey];
  assert.equal(entry.account_id, null);
  assert.equal(entry.wallet, walletKey);
  assert.equal(entry.total_gross, 0.1);
  assert.equal(entry.total_contributor, 0.1 * 0.7);
  assert.equal(entry.total_platform, 0.1 * (1 - 0.7));
  assert.equal(entry.pending_balance, 0);
  assert.equal(entry.unassented_pending, 0.1 * 0.7);
  assert.deepEqual(entry.by_learning[UNLOCK_FIXTURE_ID], {
    gross: 0.1,
    contributor: 0.1 * 0.7,
    platform: 0.1 * (1 - 0.7),
    unlocks: 1,
  });
});
