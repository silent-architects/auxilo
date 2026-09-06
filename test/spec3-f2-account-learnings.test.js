'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  reservePort,
  stageServer,
  bootServer,
  stopServer,
  BOOT_SANDBOX_SKIP_REASON,
} = require('./helpers/staged-server');

const REPO = path.join(__dirname, '..');
const SERVER_SOURCE = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');
const OPENAPI = require('../openapi.json');
const RAW_API_KEY = `axl_${'2'.repeat(40)}`;
const RAW_OTHER_API_KEY = `axl_${'3'.repeat(40)}`;
const ACCOUNT_ID = 'acc_spec3_f2_owner';
const OTHER_ACCOUNT_ID = 'acc_spec3_f2_other';
const FIXED_AT = '2026-07-26T12:00:00.000Z';

function fixtureLearning(id, overrides = {}) {
  return {
    id,
    title: `Fixture learning ${id}`,
    body: `Private body for ${id} must never leave the metadata projection.`,
    category: 'code-execution',
    tags: ['fixture', id],
    task_context: 'Testing private learning endpoint boundaries.',
    outcome: 'success',
    status: 'approved',
    contributor_account_id: ACCOUNT_ID,
    created_at: FIXED_AT,
    evidence: [{ signal: 'private_fixture', excerpt: 'must strip' }],
    quality: {
      unlocks: 0,
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
    },
    earnings: {
      total_gross_usd: 7.05,
      contributor_earned_usd: 4.935,
      platform_earned_usd: 2.115,
    },
    ...overrides,
  };
}

function fixtureCatalog() {
  return [
    fixtureLearning('lrn_approved', { visibility: 'private' }),
    fixtureLearning('lrn_rejected', { status: 'rejected' }),
    fixtureLearning('lrn_pending', { status: 'pending_review' }),
    fixtureLearning('lrn_legacy_approved', { status: undefined }),
    fixtureLearning('lrn_retracted', { status: 'retracted' }),
    fixtureLearning('lrn_other', {
      contributor_account_id: OTHER_ACCOUNT_ID,
      status: 'approved',
    }),
  ];
}

function fixtureAccounts() {
  return {
    [ACCOUNT_ID]: {
      id: ACCOUNT_ID,
      email: 'spec3-f2-owner@test.local',
      created_at: FIXED_AT,
      publication_trust: {
        source: 'operator_grant',
        granted_at: FIXED_AT,
        ref: 'operator:spec3-f2-fixture',
      },
      api_keys: [{
        id: 'key_spec3_f2_read',
        hash: crypto.createHash('sha256').update(RAW_API_KEY).digest('hex'),
        label: 'spec3-f2-read',
        scope: 'contribute',
        scope_version: 2,
        created_at: FIXED_AT,
        active: true,
      }],
    },
    [OTHER_ACCOUNT_ID]: {
      id: OTHER_ACCOUNT_ID,
      email: 'spec3-f2-other@test.local',
      created_at: FIXED_AT,
      api_keys: [{
        id: 'key_spec3_g1_other_read',
        hash: crypto.createHash('sha256').update(RAW_OTHER_API_KEY).digest('hex'),
        label: 'spec3-g1-other-read',
        scope: 'read',
        scope_version: 2,
        created_at: FIXED_AT,
        active: true,
      }],
    },
  };
}

describe('SPEC3-F2 GET /account/learnings', { timeout: 180_000 }, () => {
  let tmpDir;
  let child;
  let baseUrl;
  let getServerOutput;
  let bootSkipReason;

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
      bootSkipReason = BOOT_SANDBOX_SKIP_REASON;
      return;
    }

    const { port } = reservation;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auxilo-spec3-f2-endpoint-'));
    stageServer({
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
      linkDirs: ['lib', 'public', 'prompts', 'config'],
      replacements: [],
    });
    fs.writeFileSync(
      path.join(tmpDir, 'data', 'learnings.json'),
      JSON.stringify(fixtureCatalog(), null, 2)
    );
    fs.writeFileSync(
      path.join(tmpDir, 'data', 'accounts.json'),
      JSON.stringify(fixtureAccounts(), null, 2)
    );

    const boot = await bootServer({
      tmpDir,
      port,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        WALLET_PRIVATE_KEY: `0x${'11'.repeat(32)}`,
        LLM_SENSITIVITY_ENABLED: 'false',
        AUXILO_DATA_DIR: path.join(tmpDir, 'data'),
        AUXILO_ACCOUNTS_FILE: path.join(tmpDir, 'data', 'accounts.json'),
      },
      timeoutMs: 60_000,
      maxAttempts: 3,
    });
    if ('skipReason' in boot) {
      assert.equal(boot.skipReason, BOOT_SANDBOX_SKIP_REASON);
      bootSkipReason = BOOT_SANDBOX_SKIP_REASON;
      return;
    }

    child = boot.child;
    getServerOutput = boot.getOutput;
    baseUrl = boot.baseUrl;
  });

  after(async () => {
    if (child) await stopServer(child);
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('requires read-scope session-or-key authentication', async (t) => {
    if (bootSkipReason) {
      t.skip(bootSkipReason);
      return;
    }
    const response = await fetch(`${baseUrl}/account/learnings`);
    assert.equal(response.status, 401);
  });

  it('defaults to all three statuses and scopes rows to the caller only', async (t) => {
    if (bootSkipReason) {
      t.skip(bootSkipReason);
      return;
    }
    const response = await fetch(`${baseUrl}/account/learnings`, {
      headers: { 'X-API-Key': RAW_API_KEY },
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.account_id, ACCOUNT_ID);
    assert.equal(payload.total, 4);
    assert.deepEqual(payload.learnings.map((row) => row.id), [
      'lrn_approved',
      'lrn_rejected',
      'lrn_pending',
      'lrn_legacy_approved',
    ]);
    assert.ok(!payload.learnings.some((row) => row.id === 'lrn_other'));
    assert.ok(!payload.learnings.some((row) => row.id === 'lrn_retracted'));
    assert.equal(payload.learnings.find((row) => row.id === 'lrn_legacy_approved').status, 'approved');
    assert.equal(payload.learnings.find((row) => row.id === 'lrn_legacy_approved').visibility, 'public');

    const ownerSearch = await fetch(`${baseUrl}/knowledge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': RAW_API_KEY },
      body: JSON.stringify({ query: 'Fixture learning', limit: 15 }),
    });
    const ownerSearchText = await ownerSearch.text();
    assert.equal(ownerSearch.status, 200, `${ownerSearchText}\n${getServerOutput().slice(-2000)}`);
    const ownerResults = JSON.parse(ownerSearchText).results;
    const privateResult = ownerResults.find((row) => row.id === 'lrn_approved');
    assert.ok(privateResult, 'owner search includes approved-private learning');
    assert.equal(privateResult.visibility, 'private');
    for (const field of ['unlock_price_usd', 'current_price', 'value_signal']) {
      assert.equal(Object.hasOwn(privateResult, field), false);
    }
    assert.equal(Object.hasOwn(privateResult._revenue, 'unlock_price_usd'), false);
    assert.equal(privateResult._revenue.owner_recall_free, true);
    assert.equal(privateResult._revenue.amount_paid_usd, 0);

    for (const key of [null, RAW_OTHER_API_KEY]) {
      const headers = { 'Content-Type': 'application/json' };
      if (key) headers['X-API-Key'] = key;
      const response = await fetch(`${baseUrl}/knowledge`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ query: 'Fixture learning', limit: 15 }),
      });
      assert.equal(response.status, 200);
      assert.ok(!(await response.json()).results.some((row) => row.id === 'lrn_approved'));
    }

    const ownerRecall = await fetch(`${baseUrl}/knowledge/lrn_approved`, {
      headers: { 'X-API-Key': RAW_API_KEY },
    });
    assert.equal(ownerRecall.status, 200);
    const recallBody = await ownerRecall.json();
    assert.equal(recallBody.visibility, 'private');
    assert.equal(recallBody.body.includes('Private body'), true);
    for (const field of ['unlock_price', 'pricing', 'demand']) {
      assert.equal(Object.hasOwn(recallBody, field), false);
    }
    assert.deepEqual(recallBody.earnings, {
      total_gross_usd: 7.05,
      contributor_earned_usd: 4.935,
      platform_earned_usd: 2.115,
    });
    assert.equal(Object.hasOwn(recallBody._revenue, 'unlock_price_usd'), false);
    assert.equal(recallBody._revenue.owner_recall_free, true);

    const hiddenGet = await fetch(`${baseUrl}/knowledge/lrn_approved`, {
      headers: { 'X-API-Key': RAW_OTHER_API_KEY },
    });
    assert.equal(hiddenGet.status, 404);
    assert.deepEqual(await hiddenGet.json(), {
      error: 'Learning not found',
      id: 'lrn_approved',
    });

    const hiddenRate = await fetch(`${baseUrl}/knowledge/lrn_approved/rate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': RAW_OTHER_API_KEY },
      body: JSON.stringify({ helpfulness: 5 }),
    });
    assert.equal(hiddenRate.status, 404);
    assert.deepEqual(await hiddenRate.json(), {
      error: 'Learning not found',
      id: 'lrn_approved',
    });

    const hiddenReport = await fetch(`${baseUrl}/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ learning_id: 'lrn_approved', reason: 'private must hide' }),
    });
    assert.equal(hiddenReport.status, 404);
    assert.deepEqual(await hiddenReport.json(), {
      error: 'Learning not found',
      learning_id: 'lrn_approved',
    });

    const persisted = JSON.parse(
      fs.readFileSync(path.join(tmpDir, 'data', 'learnings.json'), 'utf8')
    ).find((row) => row.id === 'lrn_approved');
    assert.equal(Object.hasOwn(persisted, 'demand'), false,
      'private owner search is a pure read with no demand mutation');
  });

  it('returns the exact metadata-only projection and OpenAPI pins it closed', async (t) => {
    if (bootSkipReason) {
      t.skip(bootSkipReason);
      return;
    }
    const response = await fetch(`${baseUrl}/account/learnings?limit=1`, {
      headers: { 'X-API-Key': RAW_API_KEY },
    });
    const payload = await response.json();
    assert.deepEqual(Object.keys(payload.learnings[0]).sort(), [
      'category',
      'created_at',
      'id',
      'status',
      'tags',
      'title',
      'visibility',
    ]);
    for (const forbidden of ['body', 'evidence', 'quality', 'quality_self_assessment']) {
      assert.equal(Object.hasOwn(payload.learnings[0], forbidden), false);
    }

    const schema = OPENAPI.paths['/account/learnings'].get.responses['200']
      .content['application/json'].schema.properties.learnings.items;
    assert.equal(schema.additionalProperties, false);
    // Seven required keys + three OPTIONAL clean-lane stamps (Gate-A
    // 2026-09-05): published_via / standing_consent_version / retractable_until
    // appear only on learnings published under standing consent.
    assert.deepEqual(Object.keys(schema.properties).sort(), [
      'category',
      'created_at',
      'id',
      'published_via',
      'retractable_until',
      'standing_consent_version',
      'status',
      'tags',
      'title',
      'visibility',
    ]);
    assert.deepEqual([...schema.required].sort(), [
      'category',
      'created_at',
      'id',
      'status',
      'tags',
      'title',
      'visibility',
    ], 'the three clean-lane stamps are optional, never required');
    for (const optional of ['published_via', 'standing_consent_version', 'retractable_until']) {
      assert.equal(schema.properties[optional].type, 'string');
      assert.match(schema.properties[optional].description, /clean-lane standing consent/);
    }
    assert.equal(schema.properties.retractable_until.format, 'date-time');
    assert.equal(Object.hasOwn(schema.properties, 'body'), false);
  });

  it('accepts only the authorized comma-list status filter', async (t) => {
    if (bootSkipReason) {
      t.skip(bootSkipReason);
      return;
    }
    const headers = { 'X-API-Key': RAW_API_KEY };
    const filtered = await fetch(
      `${baseUrl}/account/learnings?status=rejected,pending_review`,
      { headers }
    );
    assert.equal(filtered.status, 200);
    const payload = await filtered.json();
    assert.equal(payload.total, 2);
    assert.deepEqual(payload.learnings.map((row) => row.status), [
      'rejected',
      'pending_review',
    ]);

    const invalid = await fetch(
      `${baseUrl}/account/learnings?status=approved,retracted`,
      { headers }
    );
    assert.equal(invalid.status, 400);

    const privateOnly = await fetch(
      `${baseUrl}/account/learnings?visibility=private`,
      { headers }
    );
    assert.equal(privateOnly.status, 200);
    const privatePayload = await privateOnly.json();
    assert.deepEqual(privatePayload.learnings.map((row) => row.id), ['lrn_approved']);
    assert.ok(privatePayload.learnings.every((row) => row.visibility === 'private'));

    const invalidVisibility = await fetch(
      `${baseUrl}/account/learnings?visibility=secret`,
      { headers }
    );
    assert.equal(invalidVisibility.status, 400);
  });

  it('enforces default/max limit and nonnegative offset pagination bounds', async (t) => {
    if (bootSkipReason) {
      t.skip(bootSkipReason);
      return;
    }
    const headers = { 'X-API-Key': RAW_API_KEY };
    const page = await fetch(
      `${baseUrl}/account/learnings?limit=1&offset=1`,
      { headers }
    );
    const pageBody = await page.json();
    assert.equal(pageBody.total, 4);
    assert.equal(pageBody.limit, 1);
    assert.equal(pageBody.offset, 1);
    assert.equal(pageBody.learnings.length, 1);
    assert.equal(pageBody.learnings[0].id, 'lrn_rejected');

    const bounded = await fetch(
      `${baseUrl}/account/learnings?limit=999&offset=-7`,
      { headers }
    );
    const boundedBody = await bounded.json();
    assert.equal(boundedBody.limit, 500);
    assert.equal(boundedBody.offset, 0);
  });

  it('is structurally read-only and exercises private keep/promote end-to-end', async (t) => {
    if (bootSkipReason) {
      t.skip(bootSkipReason);
      return;
    }
    const start = SERVER_SOURCE.indexOf("app.get('/account/learnings'");
    const end = SERVER_SOURCE.indexOf("app.get('/account/settings'", start);
    assert.ok(start > -1 && end > start);
    const handler = SERVER_SOURCE.slice(start, end);
    assert.match(handler, /requireSessionOrApiKey\('read'\)/);
    assert.match(handler, /learning\.contributor_account_id !== accountId/);
    assert.doesNotMatch(handler, /safeWrite|saveAccounts|append|POST|anthropic|claude|LLM|fetch\(/i);

    const submission = {
      title: 'Private operational lesson',
      body: 'This account-specific operational lesson is deliberately non-technical and remains private until rewritten.',
      category: 'non-technical',
      tags: ['private', 'operations'],
      task_context: 'Capturing an owner-only lesson.',
      outcome: 'success',
      visibility: 'private',
    };
    const publicNonTechnical = await fetch(`${baseUrl}/learn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': RAW_API_KEY },
      body: JSON.stringify({ ...submission, visibility: 'public' }),
    });
    assert.equal(publicNonTechnical.status, 400);
    const publicNonTechnicalBody = await publicNonTechnical.json();
    assert.equal(publicNonTechnicalBody.code, 'CATEGORY_OUT_OF_SCOPE');
    assert.match(publicNonTechnicalBody.error, /CI-5/);

    const unsafePrivate = await fetch(`${baseUrl}/learn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': RAW_API_KEY },
      body: JSON.stringify({
        ...submission,
        title: 'Unsafe private operational lesson',
        body: `This private content still runs GOV-3 and therefore rejects the credential ${'sk-test-' + 'x'.repeat(32)} before storage.`,
      }),
    });
    assert.equal(unsafePrivate.status, 422);

    const submitted = await fetch(`${baseUrl}/learn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': RAW_API_KEY },
      body: JSON.stringify(submission),
    });
    const submittedBody = await submitted.json();
    assert.equal(submitted.status, 201, JSON.stringify(submittedBody));
    assert.equal(submittedBody.status, 'pending_review');
    assert.equal(submittedBody.visibility, 'private');
    assert.ok(submittedBody.review_reason.includes('private_destination'));

    const directApprove = await fetch(
      `${baseUrl}/account/pending/${submittedBody.id}/approve`,
      { method: 'POST', headers: { 'X-API-Key': RAW_API_KEY } }
    );
    assert.equal(directApprove.status, 409,
      'private-destined pending may not bypass sanitize into public approval');

    const kept = await fetch(
      `${baseUrl}/account/pending/${submittedBody.id}/keep-private`,
      { method: 'POST', headers: { 'X-API-Key': RAW_API_KEY } }
    );
    const keptBody = await kept.json();
    assert.equal(kept.status, 200, JSON.stringify(keptBody));
    assert.equal(keptBody.status, 'approved');
    assert.equal(keptBody.visibility, 'private');

    const promoted = await fetch(
      `${baseUrl}/account/pending/${submittedBody.id}/sanitize`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': RAW_API_KEY },
        body: JSON.stringify({
          title: 'Technical private promotion rewrite',
          body: 'Node services should scope exact and near duplicate comparisons by authenticated contributor before persisting any predecessor evidence.',
          tags: ['node', 'privacy', 'deduplication'],
          category: 'code-execution',
        }),
      }
    );
    const promotedBody = await promoted.json();
    assert.equal(promoted.status, 200, JSON.stringify(promotedBody));
    assert.equal(promotedBody.status, 'pending_review');
    assert.equal(promotedBody.original_disposition, 'kept_private');

    const records = JSON.parse(
      fs.readFileSync(path.join(tmpDir, 'data', 'learnings.json'), 'utf8')
    );
    const original = records.find((row) => row.id === submittedBody.id);
    const replacement = records.find((row) => row.id === promotedBody.id);
    assert.equal(original.status, 'approved');
    assert.equal(original.visibility, 'private');
    assert.equal(original.sanitized_to, replacement.id);
    assert.equal(replacement.status, 'pending_review');
    assert.equal(replacement.visibility, 'public');
    assert.equal(replacement.category, 'code-execution');

    const approved = await fetch(
      `${baseUrl}/account/pending/${replacement.id}/approve`,
      { method: 'POST', headers: { 'X-API-Key': RAW_API_KEY } }
    );
    assert.equal(approved.status, 200, JSON.stringify(await approved.json()));
  });
});
