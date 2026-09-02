'use strict';

/**
 * BUILD-SPEC ENVELOPE-0831 rev 2 / R1
 *
 * Runner: node --test test/envelope-0831.test.js
 *
 * The live cases run a staged copy of server.js with a copied lib/ tree and
 * private data files. Nothing in the repository's real data/ directory is
 * read or written by the staged server.
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
const SERVER_SOURCE = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');
const OPENAPI = require('../openapi.json');

const OWNER_ACCOUNT_ID = 'acc_envelope_0831_owner';
const BUYER_ACCOUNT_ID = 'acc_envelope_0831_buyer';
const ZERO_ACCOUNT_ID = 'acc_envelope_0831_zero';
const FLOAT_ACCOUNT_ID = 'acc_envelope_0831_float';
const RAW_OWNER_KEY = `axl_${'a'.repeat(40)}`;
const RAW_BUYER_KEY = `axl_${'b'.repeat(40)}`;
const RAW_ZERO_KEY = `axl_${'c'.repeat(40)}`;
const RAW_FLOAT_KEY = `axl_${'d'.repeat(40)}`;
const OWNER_WALLET = '0x2222222222222222222222222222222222222222';
const FLOAT_WALLET = '0x4444444444444444444444444444444444444444';
const UNKNOWN_WALLET = '0x5555555555555555555555555555555555555555';
const PUBLIC_ID = 'lrn_envelope_0831_public';
const PRIVATE_ID = 'lrn_envelope_0831_private';
const FLOAT_ID_A = 'lrn_envelope_0831_float_a';
const FLOAT_ID_B = 'lrn_envelope_0831_float_b';
const FIXED_AT = '2026-08-31T12:00:00.000Z';
const CURRENT_TOS_VERSION = '2026-07-04-payee-agency-a1';

const OWNER_ONLY_FIELDS = [
  'earnings',
  'quality_self_assessment',
  'contributor_account_id',
];

const MODERATION_FIELDS = [
  'injection_flags',
  'possible_duplicate_of',
  'possible_duplicate_similarity',
  'moderation',
  'near_duplicate_evidence',
  'near_duplicate_why',
  'malicious_verdict',
  'malicious_reason',
  'platform_hold_reasons',
  'report_auto_hidden_at',
  'report_auto_hide_distinct_count',
  'sensitivity_signals',
  'sensitivity_source',
  'sensitivity_evidence',
  'learning_type',
  'sanitized_from',
  'sanitized_to',
];

function extractNamedFunction(name) {
  const start = SERVER_SOURCE.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} declaration must exist in actual server.js`);
  const open = SERVER_SOURCE.indexOf('{', start);
  assert.notEqual(open, -1, `${name} declaration must have a body`);
  let depth = 0;
  for (let i = open; i < SERVER_SOURCE.length; i++) {
    if (SERVER_SOURCE[i] === '{') depth++;
    if (SERVER_SOURCE[i] === '}') {
      depth--;
      if (depth === 0) return SERVER_SOURCE.slice(start, i + 1);
    }
  }
  assert.fail(`${name} declaration is not balanced`);
}

function actualSourceFunction(name, dependencies = []) {
  const dependencyDeclarations = dependencies
    .map((dependency) => extractNamedFunction(dependency))
    .join('\n\n');
  const declaration = extractNamedFunction(name);
  return Function(
    `"use strict"; ${dependencyDeclarations}\nreturn (${declaration});`
  )();
}

function sourceSlice(source, startMarker, endMarker, from = 0) {
  const start = source.indexOf(startMarker, from);
  assert.notEqual(start, -1, `missing source marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(end, -1, `missing source marker: ${endMarker}`);
  return source.slice(start, end);
}

function assertFieldsAbsent(payload, fields, label) {
  for (const field of fields) {
    assert.equal(Object.hasOwn(payload, field), false, `${label} omits ${field}`);
  }
}

function assertFieldsPresent(payload, fields, label) {
  for (const field of fields) {
    assert.equal(Object.hasOwn(payload, field), true, `${label} retains ${field}`);
  }
}

function assertSerializedMoney(actual, raw, label) {
  assert.equal(typeof actual, 'number', `${label} is a number`);
  assert.equal(actual, parseFloat(raw.toFixed(6)), `${label} uses exact 6dp semantics`);
  const rendered = String(actual);
  assert.doesNotMatch(rendered, /e/i, `${label} does not use exponent notation`);
  const fraction = rendered.includes('.') ? rendered.split('.')[1] : '';
  assert.ok(fraction.length <= 6, `${label} has at most six fractional digits`);
}

function logProbeExcerpt(label, payload) {
  if (process.env.ENVELOPE_0831_PROBE !== '1') return;
  console.log(`[ENVELOPE-0831 live probe] ${label}: ${JSON.stringify(payload)}`);
}

describe('ENVELOPE-0831 pure projections and route wiring', () => {
  it('stripOwnerOnlyFields strips exactly three fields, keeps every other field, and does not mutate its input', () => {
    const stripOwnerOnlyFields = actualSourceFunction('stripOwnerOnlyFields');
    const input = {
      id: PUBLIC_ID,
      title: 'Retained title',
      earnings: { gross_usd: 9.5 },
      quality_self_assessment: { total: 17 },
      contributor_account_id: OWNER_ACCOUNT_ID,
      demand: { unlocks_30d: 4 },
      pricing: { current_price: 1.41 },
      contributor_agent: 'fixture-agent',
      contributor_key_label: 'fixture-key',
      contributor_wallet: OWNER_WALLET,
      body: 'Retained body',
    };
    const snapshot = JSON.parse(JSON.stringify(input));

    const projected = stripOwnerOnlyFields(input);

    assert.notStrictEqual(projected, input, 'projection returns a new object');
    assert.deepEqual(projected, {
      id: PUBLIC_ID,
      title: 'Retained title',
      demand: { unlocks_30d: 4 },
      pricing: { current_price: 1.41 },
      contributor_agent: 'fixture-agent',
      contributor_key_label: 'fixture-key',
      contributor_wallet: OWNER_WALLET,
      body: 'Retained body',
    });
    assert.deepEqual(input, snapshot, 'source learning is unchanged');
  });

  it('serializeMoney rounds finite float tails to six places and passes non-money values through', () => {
    const serializeMoney = actualSourceFunction('serializeMoney');
    const marker = { preserve: true };

    assert.equal(serializeMoney(0.1 + 0.2), 0.3);
    assert.equal(serializeMoney(1.41), 1.41);
    assert.equal(serializeMoney(0), 0);
    assert.strictEqual(serializeMoney(null), null);
    assert.strictEqual(serializeMoney(undefined), undefined);
    assert.equal(serializeMoney(Infinity), Infinity);
    assert.ok(Number.isNaN(serializeMoney(NaN)));
    assert.strictEqual(serializeMoney('0.30000000000000004'), '0.30000000000000004');
    assert.strictEqual(serializeMoney(marker), marker);
  });

  it('serializeRevenue rounds all present money fields to six places, preserves clean values, flags and settlement, and is immutable', () => {
    const serializeRevenue = actualSourceFunction('serializeRevenue', ['serializeMoney']);
    const input = {
      unlock_price_usd: 1.41,
      amount_paid_usd: 0.125,
      contributor_earned_usd: 1.41 * 0.7,
      platform_earned_usd: 1.41 * 0.3,
      self_unlock: true,
      owner_recall_free: true,
      accrual_capped: true,
      settlement: {
        tx_hash: '0xfixture',
        path: 'router',
        router: '0x3333333333333333333333333333333333333333',
      },
    };
    const snapshot = JSON.parse(JSON.stringify(input));

    const serialized = serializeRevenue(input);

    assert.notStrictEqual(serialized, input, 'serialization returns a new object');
    assert.deepEqual(serialized, {
      unlock_price_usd: 1.41,
      amount_paid_usd: 0.125,
      contributor_earned_usd: 0.987,
      platform_earned_usd: 0.423,
      self_unlock: true,
      owner_recall_free: true,
      accrual_capped: true,
      settlement: {
        tx_hash: '0xfixture',
        path: 'router',
        router: '0x3333333333333333333333333333333333333333',
      },
    });
    assert.deepEqual(input, snapshot, 'source revenue object is unchanged');
  });

  it('wires one strip boundary to all three buyer branches and one serializer to every success revenue envelope', () => {
    const unlock = sourceSlice(
      SERVER_SOURCE,
      "app.get('/knowledge/:id', async (c) => {",
      "app.post('/knowledge/:id/rate'"
    );
    const privateOwner = sourceSlice(
      unlock,
      "if (learning.visibility === 'private') {",
      '// E1: Dynamic pricing'
    );
    const publicOwner = sourceSlice(
      unlock,
      'if (dr8OwnerAccountId) {',
      '// R-01 router mode'
    );
    const paidSelf = sourceSlice(
      unlock,
      'if (isSelfUnlock) {',
      '// AUD19-2: capped repeat unlock'
    );
    const cappedRepeat = sourceSlice(
      unlock,
      'if (accrualCapped) {',
      '// AUD19-2: gross books'
    );
    const paidPublic = sourceSlice(
      unlock,
      '// LW-13 / LW-16: strip moderation-internal fields',
      '} catch (deliveryErr) {'
    );
    const privateSearch = sourceSlice(
      SERVER_SOURCE,
      "if (r.visibility === 'private') {",
      '// FB-4: quote the ONE price'
    );

    for (const [label, block] of [
      ['paid self', paidSelf],
      ['capped repeat', cappedRepeat],
      ['paid public', paidPublic],
    ]) {
      assert.match(block, /stripOwnerOnlyFields\(/, `${label} uses the shared buyer projection`);
    }
    for (const [label, block] of [
      ['private owner', privateOwner],
      ['DR-8 public owner', publicOwner],
    ]) {
      assert.doesNotMatch(block, /stripOwnerOnlyFields\(/, `${label} keeps owner-only fields`);
    }
    for (const [label, block] of [
      ['private owner', privateOwner],
      ['DR-8 public owner', publicOwner],
      ['paid self', paidSelf],
      ['capped repeat', cappedRepeat],
      ['paid public', paidPublic],
      ['private owner search', privateSearch],
    ]) {
      assert.match(
        block,
        /_revenue:\s*serializeRevenue\(\{/,
        `${label} serializes its _revenue object`
      );
    }
    assert.equal(
      (unlock.match(/_revenue:\s*serializeRevenue\(\{/g) || []).length,
      5,
      'the unlock route has exactly five serialized success envelopes'
    );
  });
});

function fixtureLearning(id, visibility) {
  return {
    id,
    title: `Envelope fixture ${id}`,
    body: `Full fixture body for ${id}.`,
    snippet: `Fixture snippet for ${id}.`,
    category: 'code-execution',
    tags: ['envelope-0831', visibility],
    task_context: 'Pin buyer and owner response projections.',
    outcome: 'success',
    status: 'approved',
    visibility,
    contributor_account_id: OWNER_ACCOUNT_ID,
    contributor_wallet: OWNER_WALLET,
    contributor_agent: 'fixture-agent',
    contributor_key_label: 'fixture-contributor-key',
    related_skills: ['testing'],
    unlock_price: 1.41,
    pricing: {
      current_price: 1.41,
      floor_price: 0.05,
      ceiling_price: 20,
    },
    demand: {
      search_impressions_7d: 2,
      search_impressions_30d: 6,
      unlocks_7d: 0,
      unlocks_30d: 0,
    },
    earnings: {
      gross_usd: 2,
      contributor_share_usd: 1.4,
      platform_share_usd: 0.6,
    },
    quality: {
      unlocks: 0,
      unlocks_total: 0,
      ratings: 0,
      avg_helpfulness: 0,
      helpfulness_scores: [],
      score: 0,
    },
    quality_self_assessment: {
      specificity: 4,
      actionability: 4,
      novelty: 4,
      completeness: 4,
      total: 16,
      reasoning: 'Owner-only review reasoning.',
    },
    created_at: FIXED_AT,
    updated_at: FIXED_AT,
    injection_flags: ['fixture-injection-flag'],
    possible_duplicate_of: 'lrn_fixture_duplicate',
    possible_duplicate_similarity: 0.97,
    moderation: { disposition: 'fixture-only' },
    near_duplicate_evidence: ['fixture evidence'],
    near_duplicate_why: 'fixture reason',
    malicious_verdict: 'safe',
    malicious_reason: 'fixture reason',
    platform_hold_reasons: [],
    report_auto_hidden_at: FIXED_AT,
    report_auto_hide_distinct_count: 3,
    sensitivity_signals: ['fixture signal'],
    sensitivity_source: 'fixture',
    sensitivity_evidence: ['fixture sensitivity evidence'],
    learning_type: 'fixture-internal-type',
    sanitized_from: 'lrn_fixture_source',
    sanitized_to: 'lrn_fixture_target',
  };
}

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

function fixtureAccounts() {
  return {
    [OWNER_ACCOUNT_ID]: {
      id: OWNER_ACCOUNT_ID,
      email: 'envelope-owner@test.local',
      wallet: OWNER_WALLET,
      created_at: FIXED_AT,
      tos_version: CURRENT_TOS_VERSION,
      accepted_at: Date.parse(FIXED_AT),
      accepted_affirmed: true,
      api_keys: [apiKeyEntry(
        RAW_OWNER_KEY,
        'key_envelope_owner',
        'owner',
        'contribute'
      )],
    },
    [BUYER_ACCOUNT_ID]: {
      id: BUYER_ACCOUNT_ID,
      email: 'envelope-buyer@test.local',
      created_at: FIXED_AT,
      api_keys: [apiKeyEntry(
        RAW_BUYER_KEY,
        'key_envelope_buyer',
        'buyer',
        'read'
      )],
    },
    [ZERO_ACCOUNT_ID]: {
      id: ZERO_ACCOUNT_ID,
      email: 'envelope-zero@test.local',
      created_at: FIXED_AT,
      api_keys: [apiKeyEntry(
        RAW_ZERO_KEY,
        'key_envelope_zero',
        'zero',
        'earnings-read'
      )],
    },
    [FLOAT_ACCOUNT_ID]: {
      id: FLOAT_ACCOUNT_ID,
      email: 'envelope-float@test.local',
      wallet: FLOAT_WALLET,
      created_at: FIXED_AT,
      api_keys: [apiKeyEntry(
        RAW_FLOAT_KEY,
        'key_envelope_float',
        'float',
        'earnings-read'
      )],
    },
  };
}

function fixtureFloatEarningsEntry() {
  return {
    account_id: FLOAT_ACCOUNT_ID,
    wallet: FLOAT_WALLET,
    total_gross: 0.30000000000000004,
    total_contributor: 0.23333333333333334,
    total_platform: 0.06666666666666668,
    by_learning: {
      [FLOAT_ID_A]: {
        gross: 0.10000000000000002,
        contributor: 0.07777777777777779,
        platform: 0.022222222222222227,
        unlocks: 3,
        unknown_nested: { fixture: 'alpha', preserved_count: 11 },
      },
      [FLOAT_ID_B]: {
        gross: 0.20000000000000004,
        contributor: 0.15555555555555556,
        platform: 0.04444444444444445,
        unlocks: 4,
        unknown_nested: { fixture: 'beta', preserved_count: 13 },
      },
    },
    last_updated: FIXED_AT,
    pending_balance: 0.16666666666666669,
    unassented_pending: 0.04444444444444445,
    total_withdrawn: 0.03333333333333334,
    withdrawal_count: 7,
    processed_settlements: ['settlement_float_fixture'],
  };
}

function fixtureEarnings() {
  return {
    [FLOAT_ACCOUNT_ID]: fixtureFloatEarningsEntry(),
    __wallet_index: {
      [FLOAT_WALLET]: FLOAT_ACCOUNT_ID,
    },
  };
}

function fixtureCredits() {
  return {
    [BUYER_ACCOUNT_ID]: {
      queries_used: 0,
      unlocks_used: 0,
      purchased_queries: 0,
      purchased_unlocks: 3,
      unlock_lots: [{
        unit_price_usd: 1.41,
        remaining: 3,
        added_at: Date.parse(FIXED_AT),
      }],
      period_start: '2026-08-01T00:00:00.000Z',
      period_end: '2099-09-01T00:00:00.000Z',
      created_at: Date.parse(FIXED_AT),
      last_deducted_at: null,
    },
  };
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function writeStagedFixtures(dataDir) {
  const floatLearningA = {
    ...fixtureLearning(FLOAT_ID_A, 'public'),
    contributor_account_id: FLOAT_ACCOUNT_ID,
    contributor_wallet: FLOAT_WALLET,
  };
  const floatLearningB = {
    ...fixtureLearning(FLOAT_ID_B, 'public'),
    contributor_account_id: FLOAT_ACCOUNT_ID,
    contributor_wallet: FLOAT_WALLET,
  };
  writeJson(path.join(dataDir, 'learnings.json'), [
    fixtureLearning(PUBLIC_ID, 'public'),
    fixtureLearning(PRIVATE_ID, 'private'),
    floatLearningA,
    floatLearningB,
  ]);
  writeJson(path.join(dataDir, 'accounts.json'), fixtureAccounts());
  writeJson(path.join(dataDir, 'earnings.json'), fixtureEarnings());
  writeJson(path.join(dataDir, 'credits.json'), fixtureCredits());
  writeJson(path.join(dataDir, 'unlock-attribution.json'), {});
  writeJson(path.join(dataDir, 'purchase-ledger.json'), {});
  writeJson(path.join(dataDir, 'verified-wallets.json'), {});
}

async function getJson(url, headers, getServerOutput) {
  const response = await fetch(url, { headers });
  const text = await response.text();
  assert.equal(
    response.status,
    200,
    `${url} returned ${response.status}: ${text}\n${getServerOutput().slice(-2000)}`
  );
  return JSON.parse(text);
}

describe('ENVELOPE-0831 staged live response envelopes', { timeout: 180_000 }, () => {
  let tmpDir;
  let child;
  let baseUrl;
  let getServerOutput;
  let liveSkipReason;

  before(async () => {
    const honoEntry = require.resolve('hono', { paths: [REPO] });
    const nodeModulesDir = honoEntry.slice(
      0,
      honoEntry.lastIndexOf(`${path.sep}node_modules${path.sep}`) +
        '/node_modules'.length
    );
    const reservation = await reservePort();
    if ('skipReason' in reservation) {
      assert.equal(reservation.skipReason, BOOT_SANDBOX_SKIP_REASON);
      liveSkipReason = reservation.skipReason;
      return;
    }

    const { port } = reservation;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auxilo-envelope-0831-'));
    const { dataDir } = stageServer({
      repoRoot: REPO,
      tmpDir,
      nodeModulesDir,
      port,
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
      replacements: [],
    });
    writeStagedFixtures(dataDir);
    const boot = await bootServer({
      tmpDir,
      port,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        WALLET_PRIVATE_KEY: `0x${'11'.repeat(32)}`,
        SESSION_SECRET: 'envelope-0831-test-session-secret',
        CONTENT_MODERATION_ENABLED: 'true',
        LLM_SENSITIVITY_ENABLED: 'false',
        AUXILO_DATA_DIR: dataDir,
        AUXILO_ACCOUNTS_FILE: path.join(dataDir, 'accounts.json'),
        AUXILO_CREDITS_FILE: path.join(dataDir, 'credits.json'),
        AUXILO_UNLOCK_ATTRIBUTION_FILE: path.join(dataDir, 'unlock-attribution.json'),
        AUXILO_PURCHASE_LEDGER_FILE: path.join(dataDir, 'purchase-ledger.json'),
      },
      timeoutMs: 60_000,
      maxAttempts: 3,
    });
    if ('skipReason' in boot) {
      assert.equal(boot.skipReason, BOOT_SANDBOX_SKIP_REASON);
      liveSkipReason = boot.skipReason;
      return;
    }
    child = boot.child;
    getServerOutput = boot.getOutput;
    baseUrl = boot.baseUrl;
  });

  after(async () => {
    await stopServer(child);
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('serializes every earnings and contributor money field to 6dp without mutating staged stores', async (t) => {
    if (liveSkipReason) {
      t.skip(liveSkipReason);
      return;
    }
    const dataDir = path.join(tmpDir, 'data');
    const storeFiles = ['earnings.json', 'accounts.json', 'learnings.json'];
    const before = Object.fromEntries(
      storeFiles.map((file) => [file, fs.readFileSync(path.join(dataDir, file))])
    );
    const raw = fixtureFloatEarningsEntry();

    const accountDashboard = await getJson(
      `${baseUrl}/account/earnings`,
      { 'X-API-Key': RAW_FLOAT_KEY },
      getServerOutput
    );
    const contributorDashboard = await getJson(
      `${baseUrl}/contributor/${FLOAT_WALLET}`,
      {},
      getServerOutput
    );

    const accountMoney = {
      total_gross_usd: raw.total_gross,
      total_gross: raw.total_gross,
      total_contributor: parseFloat((
        parseFloat(raw.total_contributor.toFixed(6)) -
        parseFloat(raw.unassented_pending.toFixed(6))
      ).toFixed(6)),
      total_contributor_gross: raw.total_contributor,
      held_pending_assent: raw.unassented_pending,
      unassented_pending: raw.unassented_pending,
      pending_balance: raw.pending_balance,
      total_withdrawn: raw.total_withdrawn,
    };
    assertFieldsPresent(
      accountDashboard,
      Object.keys(accountMoney),
      'account float earnings'
    );
    for (const [field, value] of Object.entries(accountMoney)) {
      assertSerializedMoney(accountDashboard[field], value, `account.${field}`);
    }

    assert.deepEqual(Object.keys(accountDashboard.by_learning).sort(), [
      FLOAT_ID_A,
      FLOAT_ID_B,
    ]);
    for (const learningId of [FLOAT_ID_A, FLOAT_ID_B]) {
      const detail = accountDashboard.by_learning[learningId];
      assertFieldsPresent(
        detail,
        ['gross', 'contributor', 'platform'],
        `account.by_learning.${learningId}`
      );
      for (const field of ['gross', 'contributor', 'platform']) {
        assertSerializedMoney(
          detail[field],
          raw.by_learning[learningId][field],
          `account.by_learning.${learningId}.${field}`
        );
      }
      assert.equal(detail.unlocks, raw.by_learning[learningId].unlocks);
      assert.deepEqual(
        detail.unknown_nested,
        raw.by_learning[learningId].unknown_nested,
        `${learningId} unknown nested fields survive serialization`
      );
    }
    assert.equal(accountDashboard.withdrawal_count, raw.withdrawal_count);

    const contributorMoney = {
      total_gross_usd: raw.total_gross,
      total_contributor_usd: raw.total_contributor,
      total_platform_usd: raw.total_platform,
      pending_balance: raw.pending_balance,
      total_withdrawn: raw.total_withdrawn,
    };
    assertFieldsPresent(
      contributorDashboard,
      Object.keys(contributorMoney),
      'public float contributor'
    );
    for (const [field, value] of Object.entries(contributorMoney)) {
      assertSerializedMoney(contributorDashboard[field], value, `contributor.${field}`);
    }
    assert.equal(contributorDashboard.withdrawal_count, raw.withdrawal_count);
    assert.equal(contributorDashboard.learnings_submitted, 2);
    assert.equal(contributorDashboard.last_updated, raw.last_updated);
    assert.equal(Object.hasOwn(contributorDashboard, 'by_learning'), false);

    for (const file of storeFiles) {
      assert.deepEqual(
        fs.readFileSync(path.join(dataDir, file)),
        before[file],
        `GET responses leave data/${file} byte-identical`
      );
    }
  });

  it('serves paid public buyers the stripped learning, retained buyer fields, frozen four-key revenue shape, and clean 1.41 split', async (t) => {
    if (liveSkipReason) {
      t.skip(liveSkipReason);
      return;
    }
    const payload = await getJson(
      `${baseUrl}/knowledge/${PUBLIC_ID}`,
      { 'X-API-Key': RAW_BUYER_KEY },
      getServerOutput
    );

    assertFieldsAbsent(payload, OWNER_ONLY_FIELDS, 'paid public envelope');
    assertFieldsAbsent(payload, MODERATION_FIELDS, 'paid public envelope');
    assertFieldsPresent(payload, [
      'demand',
      'pricing',
      'contributor_agent',
      'contributor_key_label',
      'contributor_wallet',
      'content_advisory',
    ], 'paid public envelope');
    assert.deepEqual(payload._revenue, {
      unlock_price_usd: 1.41,
      amount_paid_usd: 1.41,
      contributor_earned_usd: 0.987,
      platform_earned_usd: 0.423,
    });
    logProbeExcerpt('buyer', {
      id: payload.id,
      owner_only_fields_present: OWNER_ONLY_FIELDS.filter((field) => Object.hasOwn(payload, field)),
      demand: payload.demand,
      pricing: payload.pricing,
      contributor_agent: payload.contributor_agent,
      contributor_key_label: payload.contributor_key_label,
      content_advisory: payload.content_advisory,
      _revenue: payload._revenue,
    });
  });

  it('serves a capped repeat through the same strip and marks its zero-accrual revenue envelope', async (t) => {
    if (liveSkipReason) {
      t.skip(liveSkipReason);
      return;
    }
    const payload = await getJson(
      `${baseUrl}/knowledge/${PUBLIC_ID}`,
      { 'X-API-Key': RAW_BUYER_KEY },
      getServerOutput
    );

    assertFieldsAbsent(payload, OWNER_ONLY_FIELDS, 'capped repeat envelope');
    assertFieldsAbsent(payload, MODERATION_FIELDS, 'capped repeat envelope');
    assert.deepEqual(payload._revenue, {
      unlock_price_usd: 1.41,
      amount_paid_usd: 1.41,
      contributor_earned_usd: 0,
      platform_earned_usd: 0,
      accrual_capped: true,
    });
  });

  it('treats a matching bare X-Wallet-Address as a paid buyer view and strips owner-only fields', async (t) => {
    if (liveSkipReason) {
      t.skip(liveSkipReason);
      return;
    }
    const payload = await getJson(
      `${baseUrl}/knowledge/${PUBLIC_ID}`,
      {
        'X-API-Key': RAW_BUYER_KEY,
        'X-Wallet-Address': OWNER_WALLET,
      },
      getServerOutput
    );

    assertFieldsAbsent(payload, OWNER_ONLY_FIELDS, 'paid self envelope');
    assertFieldsAbsent(payload, MODERATION_FIELDS, 'paid self envelope');
    assert.equal(payload._revenue.self_unlock, true);
    assert.equal(Object.hasOwn(payload._revenue, 'owner_recall_free'), false);
    const credits = JSON.parse(
      fs.readFileSync(path.join(tmpDir, 'data', 'credits.json'), 'utf8')
    );
    assert.equal(credits[BUYER_ACCOUNT_ID].purchased_unlocks, 0, 'claimed-wallet self path paid one credit');
  });

  it('keeps all three owner-only fields on a provable DR-8 public owner recall', async (t) => {
    if (liveSkipReason) {
      t.skip(liveSkipReason);
      return;
    }
    const payload = await getJson(
      `${baseUrl}/knowledge/${PUBLIC_ID}`,
      { 'X-API-Key': RAW_OWNER_KEY },
      getServerOutput
    );

    assertFieldsPresent(payload, OWNER_ONLY_FIELDS, 'DR-8 public owner envelope');
    assertFieldsAbsent(payload, MODERATION_FIELDS, 'DR-8 public owner envelope');
    assert.equal(payload.contributor_account_id, OWNER_ACCOUNT_ID);
    assert.equal(payload._revenue.owner_recall_free, true);
    logProbeExcerpt('owner', {
      id: payload.id,
      earnings: payload.earnings,
      quality_self_assessment: payload.quality_self_assessment,
      contributor_account_id: payload.contributor_account_id,
      _revenue: payload._revenue,
    });
  });

  it('keeps all three owner-only fields on a provable private owner recall', async (t) => {
    if (liveSkipReason) {
      t.skip(liveSkipReason);
      return;
    }
    const payload = await getJson(
      `${baseUrl}/knowledge/${PRIVATE_ID}`,
      { 'X-API-Key': RAW_OWNER_KEY },
      getServerOutput
    );

    assertFieldsPresent(payload, OWNER_ONLY_FIELDS, 'private owner envelope');
    assertFieldsAbsent(payload, MODERATION_FIELDS, 'private owner envelope');
    assert.equal(payload.visibility, 'private');
    assert.equal(payload.contributor_account_id, OWNER_ACCOUNT_ID);
    assert.equal(payload._revenue.owner_recall_free, true);
  });

  it('keeps wallet aggregates public, moves per-learning detail to account earnings, and gives zero earners an empty detail object', async (t) => {
    if (liveSkipReason) {
      t.skip(liveSkipReason);
      return;
    }
    const publicDashboard = await getJson(
      `${baseUrl}/contributor/${OWNER_WALLET}`,
      {},
      getServerOutput
    );
    assert.equal(Object.hasOwn(publicDashboard, 'by_learning'), false);
    assertFieldsPresent(publicDashboard, [
      'total_gross_usd',
      'total_contributor_usd',
      'total_platform_usd',
      'pending_balance',
      'total_withdrawn',
      'withdrawal_count',
    ], 'public contributor dashboard');
    assert.equal(publicDashboard.total_gross_usd, 1.41);

    const ownerDashboard = await getJson(
      `${baseUrl}/account/earnings`,
      { 'X-API-Key': RAW_OWNER_KEY },
      getServerOutput
    );
    assert.ok(ownerDashboard.by_learning && ownerDashboard.by_learning[PUBLIC_ID]);
    assert.equal(ownerDashboard.by_learning[PUBLIC_ID].gross, 1.41);
    assert.equal(ownerDashboard.by_learning[PUBLIC_ID].unlocks, 1);

    const zeroDashboard = await getJson(
      `${baseUrl}/account/earnings`,
      { 'X-API-Key': RAW_ZERO_KEY },
      getServerOutput
    );
    assert.deepEqual(zeroDashboard.by_learning, {});

    const unknownWalletDashboard = await getJson(
      `${baseUrl}/contributor/${UNKNOWN_WALLET}`,
      {},
      getServerOutput
    );
    assert.equal(unknownWalletDashboard.total_contributor_usd, 0);
  });
});

describe('ENVELOPE-0831 OpenAPI truth', () => {
  it('omits buyer and public per-item earnings fields, documents owner by-learning detail, and holds version 0.9.10', () => {
    const fullProperties = OPENAPI.components.schemas.LearningFull.properties;
    assertFieldsAbsent(fullProperties, OWNER_ONLY_FIELDS, 'LearningFull schema');

    const publicContributorProperties = OPENAPI.paths['/contributor/{wallet}'].get
      .responses['200'].content['application/json'].schema.properties;
    assert.equal(Object.hasOwn(publicContributorProperties, 'by_learning'), false);
    assertFieldsPresent(publicContributorProperties, [
      'total_gross_usd',
      'total_contributor_usd',
      'total_platform_usd',
    ], 'public contributor schema');

    const accountEarningsProperties = OPENAPI.paths['/account/earnings'].get
      .responses['200'].content['application/json'].schema.properties;
    assert.equal(accountEarningsProperties.by_learning.type, 'object');
    assert.deepEqual(OPENAPI.paths['/account/earnings'].get.security, [
      { bearerAuth: [] },
      { apiKeyAuth: [] },
    ]);
    assert.equal(OPENAPI.info.version, '0.9.10');
  });
});
