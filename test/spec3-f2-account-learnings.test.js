'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const REPO = path.join(__dirname, '..');
const SERVER_SOURCE = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');
const OPENAPI = require('../openapi.json');
const RAW_API_KEY = `axl_${'2'.repeat(40)}`;
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
    status: 'approved',
    contributor_account_id: ACCOUNT_ID,
    created_at: FIXED_AT,
    evidence: [{ signal: 'private_fixture', excerpt: 'must strip' }],
    quality_self_assessment: {
      specificity: 4,
      actionability: 4,
      novelty: 4,
      completeness: 4,
      total: 16,
    },
    ...overrides,
  };
}

function fixtureCatalog() {
  return [
    fixtureLearning('lrn_approved'),
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
      api_keys: [{
        id: 'key_spec3_f2_read',
        hash: crypto.createHash('sha256').update(RAW_API_KEY).digest('hex'),
        label: 'spec3-f2-read',
        scope: 'read',
        scope_version: 2,
        created_at: FIXED_AT,
        active: true,
      }],
    },
    [OTHER_ACCOUNT_ID]: {
      id: OTHER_ACCOUNT_ID,
      email: 'spec3-f2-other@test.local',
      created_at: FIXED_AT,
      api_keys: [],
    },
  };
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function stageServer(tmpDir, nodeModulesDir, port) {
  for (const file of [
    'server.js',
    'seed-knowledge.json',
    'skills.json',
    'openapi.json',
    'package.json',
    'model_config.json',
  ]) {
    const source = path.join(REPO, file);
    if (fs.existsSync(source)) fs.copyFileSync(source, path.join(tmpDir, file));
  }

  const staged = fs.readFileSync(path.join(tmpDir, 'server.js'), 'utf8');
  const walletPatched = staged.replace(
    /^const WALLET = '0x[0-9a-fA-F]{40}';$/m,
    "const WALLET = '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A';"
  );
  const portPatched = walletPatched.replace(
    'const PORT = 3000;',
    `const PORT = ${port};`
  );
  assert.notEqual(walletPatched, staged, 'expected staged wallet patch');
  assert.notEqual(portPatched, walletPatched, 'expected staged port patch');
  fs.writeFileSync(path.join(tmpDir, 'server.js'), portPatched);

  for (const directory of ['lib', 'public', 'prompts', 'config']) {
    fs.symlinkSync(path.join(REPO, directory), path.join(tmpDir, directory));
  }
  fs.symlinkSync(nodeModulesDir, path.join(tmpDir, 'node_modules'));
  fs.mkdirSync(path.join(tmpDir, 'data'));
  fs.writeFileSync(
    path.join(tmpDir, 'data', 'learnings.json'),
    JSON.stringify(fixtureCatalog(), null, 2)
  );
  fs.writeFileSync(
    path.join(tmpDir, 'data', 'accounts.json'),
    JSON.stringify(fixtureAccounts(), null, 2)
  );
}

function bootServer(tmpDir, port) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['server.js'], {
      cwd: tmpDir,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        WALLET_PRIVATE_KEY: `0x${'11'.repeat(32)}`,
        LLM_SENSITIVITY_ENABLED: 'false',
        AUXILO_DATA_DIR: path.join(tmpDir, 'data'),
        AUXILO_ACCOUNTS_FILE: path.join(tmpDir, 'data', 'accounts.json'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let settled = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => settle({ child, output, up: false }), 20_000);
    const onData = (buffer) => {
      output += buffer.toString();
      if (output.includes(`Auxilo running at http://0.0.0.0:${port}`)) {
        settle({ child, output, up: true });
      }
      if (output.includes('UNCAUGHT EXCEPTION')) settle({ child, output, up: false });
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', () => settle({ child, output, up: false }));
  });
}

describe('SPEC3-F2 GET /account/learnings', { timeout: 180_000 }, () => {
  let tmpDir;
  let child;
  let baseUrl;

  before(async () => {
    const honoEntry = require.resolve('hono', { paths: [REPO] });
    const nodeModulesDir = honoEntry.slice(
      0,
      honoEntry.lastIndexOf(`${path.sep}node_modules${path.sep}`) +
        '/node_modules'.length
    );
    const port = await reservePort();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auxilo-spec3-f2-endpoint-'));
    stageServer(tmpDir, nodeModulesDir, port);
    const boot = await bootServer(tmpDir, port);
    child = boot.child;
    assert.equal(boot.up, true, `server failed to boot: ${boot.output.slice(-1000)}`);
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(() => {
    if (child) child.kill('SIGKILL');
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('requires read-scope session-or-key authentication', async () => {
    const response = await fetch(`${baseUrl}/account/learnings`);
    assert.equal(response.status, 401);
  });

  it('defaults to all three statuses and scopes rows to the caller only', async () => {
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
  });

  it('returns the exact metadata-only projection and OpenAPI pins it closed', async () => {
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
    ]);
    for (const forbidden of ['body', 'evidence', 'quality', 'quality_self_assessment']) {
      assert.equal(Object.hasOwn(payload.learnings[0], forbidden), false);
    }

    const schema = OPENAPI.paths['/account/learnings'].get.responses['200']
      .content['application/json'].schema.properties.learnings.items;
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(Object.keys(schema.properties).sort(), [
      'category',
      'created_at',
      'id',
      'status',
      'tags',
      'title',
    ]);
    assert.equal(Object.hasOwn(schema.properties, 'body'), false);
  });

  it('accepts only the authorized comma-list status filter', async () => {
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
  });

  it('enforces default/max limit and nonnegative offset pagination bounds', async () => {
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

  it('is structurally read-only and contains no platform inference path', () => {
    const start = SERVER_SOURCE.indexOf("app.get('/account/learnings'");
    const end = SERVER_SOURCE.indexOf("app.get('/account/settings'", start);
    assert.ok(start > -1 && end > start);
    const handler = SERVER_SOURCE.slice(start, end);
    assert.match(handler, /requireSessionOrApiKey\('read'\)/);
    assert.match(handler, /learning\.contributor_account_id !== accountId/);
    assert.doesNotMatch(handler, /safeWrite|saveAccounts|append|POST|anthropic|claude|LLM|fetch\(/i);
  });
});
