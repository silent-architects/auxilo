'use strict';
/*
 * test/extraction-model-stamp.test.js — EXTRACT-PER-CLIENT W1 PART C
 *
 * Covers the extraction_model stamp threaded end to end:
 *   scripts/extract-local.js (extractLocally attaches it per-learning)
 *   -> scripts/runner.js (submitLearnings forwards it in the /learn POST body)
 *   -> server.js (POST /learn intake: tolerant/bounded validation, storage,
 *      never on a buyer envelope)
 *   -> openapi.json (documented as an optional request field)
 *   -> GET /account/learnings (owner surface returns it)
 *
 * Parts 1-2 are fast in-process unit tests (mocked spawn/fetch). Part 3 is
 * structural (server.js hardcodes PORT/DATA_DIR at module scope, so this repo
 * tests routes statically — see test/spec3-b1-server.test.js's own header for
 * the same convention). Part 4 validates the openapi.json schema directly.
 * Part 5 is ONE real staged-server boot proving the full round trip and the
 * clean-lane calibration gate together, amortizing the boot cost across
 * several assertions in a single test.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const extractLocal = require('../scripts/extract-local.js');
const runner = require('../scripts/runner.js');
const byoKey = require('../scripts/providers/byo-key.js');

const REPO_ROOT = path.join(__dirname, '..');
const SERVER_SRC = fs.readFileSync(path.join(REPO_ROOT, 'server.js'), 'utf8');

const tempDirs = [];
function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
function cleanupTempDirs() {
  for (const dir of tempDirs.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

function spawnQueue(responses) {
  const calls = [];
  const spawnSyncImpl = (bin, args, opts) => {
    calls.push({ bin, args, opts });
    assert.ok(responses.length, `unexpected spawn: ${bin} ${args.join(' ')}`);
    return responses.shift();
  };
  return { calls, spawnSyncImpl };
}
function authJson(loggedIn) {
  return { status: 0, stdout: JSON.stringify({ loggedIn }), stderr: '' };
}
function extractionStdout(learnings) {
  return { status: 0, stdout: JSON.stringify({ learnings }), stderr: '' };
}

const LEARNING_A = {
  title: 'Retry with jittered backoff on 503 from the widget queue API',
  body: 'The widget queue API returns 503 under load with no Retry-After header; a jittered exponential backoff starting at 250ms with a 5-attempt cap clears transient overload without hammering the queue further.',
  category: 'code-execution',
  tags: ['retry', 'backoff'],
  task_context: 'debugging a flaky queue integration',
  outcome: 'success',
};

// ─── Part 1: extract-local.js attaches extraction_model per learning ───────

describe('extract-local.js: extractLocally attaches extraction_model per learning', () => {
  it('default path (claude-code forced) stamps {provider:"claude-code", model:null, version:null, vendor:null} — claude-code.js has no identity field yet, so extractLocally falls back to the resolved provider id alone', async () => {
    const dir = tempDir('auxilo-stamp-claude-');
    const indexPath = path.join(dir, 'extracted-index.jsonl');
    fs.writeFileSync(indexPath, '');
    const { spawnSyncImpl } = spawnQueue([authJson(true), extractionStdout([LEARNING_A])]);
    const originalEnv = process.env.AUXILO_EXTRACTION_PROVIDER;
    process.env.AUXILO_EXTRACTION_PROVIDER = 'claude-code';
    try {
      const result = await extractLocal.extractLocally('a synthetic transcript', 'claude-code', {
        indexPath, log: () => {}, spawnSyncImpl, claudeBin: 'claude', homeDir: '/fixture/home', cwd: '/fixture/home',
      });
      assert.equal(result.learnings.length, 1);
      assert.deepEqual(result.learnings[0].extraction_model, {
        provider: 'claude-code', model: null, version: null, vendor: null,
      });
    } finally {
      cleanupTempDirs();
      if (originalEnv === undefined) delete process.env.AUXILO_EXTRACTION_PROVIDER;
      else process.env.AUXILO_EXTRACTION_PROVIDER = originalEnv;
    }
  });

  it('default path (byo-key forced) stamps the full {provider:"byo-key", model, version:null, vendor} identity byo-key.js reports', async () => {
    const dir = tempDir('auxilo-stamp-byo-');
    const indexPath = path.join(dir, 'extracted-index.jsonl');
    fs.writeFileSync(indexPath, '');
    const providersStatePath = path.join(dir, 'providers.json');
    byoKey.writeByoConfig({ provider: 'anthropic', model: 'claude-sonnet-4-5', api_key: 'sk-ant-fixture' }, { providersStatePath });
    const fetchImpl = async () => ({
      ok: true, status: 200,
      json: async () => ({ content: [{ type: 'text', text: JSON.stringify({ learnings: [LEARNING_A] }) }] }),
    });
    const originalEnv = process.env.AUXILO_EXTRACTION_PROVIDER;
    process.env.AUXILO_EXTRACTION_PROVIDER = 'byo-key';
    try {
      const result = await extractLocal.extractLocally('a synthetic transcript', 'claude-code', {
        indexPath, log: () => {}, fetchImpl, providersStatePath,
      });
      assert.equal(result.learnings.length, 1);
      assert.deepEqual(result.learnings[0].extraction_model, {
        provider: 'byo-key', model: 'claude-sonnet-4-5', version: null, vendor: 'anthropic',
      });
    } finally {
      cleanupTempDirs();
      if (originalEnv === undefined) delete process.env.AUXILO_EXTRACTION_PROVIDER;
      else process.env.AUXILO_EXTRACTION_PROVIDER = originalEnv;
    }
  });

  it('a custom opts.invokeModel that reports NO extractionModel yields learnings with no extraction_model key at all (every pre-PART-C test in this repo uses this path — byte-identical, back-compat)', async () => {
    const dir = tempDir('auxilo-stamp-nomodel-');
    const indexPath = path.join(dir, 'extracted-index.jsonl');
    fs.writeFileSync(indexPath, '');
    try {
      const result = await extractLocal.extractLocally('a synthetic transcript', 'claude-code', {
        indexPath, log: () => {},
        invokeModel: async () => ({ ok: true, out: JSON.stringify({ learnings: [LEARNING_A] }) }),
      });
      assert.equal(result.learnings.length, 1);
      assert.equal('extraction_model' in result.learnings[0], false);
    } finally {
      cleanupTempDirs();
    }
  });

  it('a custom opts.invokeModel that DOES report an extractionModel gets it stamped verbatim onto every candidate', async () => {
    const dir = tempDir('auxilo-stamp-custom-');
    const indexPath = path.join(dir, 'extracted-index.jsonl');
    fs.writeFileSync(indexPath, '');
    const identity = { provider: 'codex-cli', model: null, version: '0.144.5', vendor: null };
    try {
      const result = await extractLocal.extractLocally('a synthetic transcript', 'claude-code', {
        indexPath, log: () => {},
        invokeModel: async () => ({
          ok: true, out: JSON.stringify({ learnings: [LEARNING_A] }), extractionModel: identity,
        }),
      });
      assert.equal(result.learnings.length, 1);
      assert.deepEqual(result.learnings[0].extraction_model, identity);
    } finally {
      cleanupTempDirs();
    }
  });

  it('a skipped extraction (ok:false) never attaches extraction_model (empty learnings array either way)', async () => {
    const result = await extractLocal.extractLocally('t', 'claude-code', {
      log: () => {},
      invokeModel: async () => ({ ok: false, reason: 'fixture-stop' }),
    });
    assert.deepEqual(result.learnings, []);
  });
});

// ─── Part 2: runner.js submitLearnings forwards extraction_model ───────────

describe('runner.js: submitLearnings forwards extraction_model in the /learn POST body', () => {
  it('includes it when present on the learning object; omits the key entirely when absent', async () => {
    const bodies = [];
    const fetchImpl = async (url, init) => {
      bodies.push(JSON.parse(init.body));
      return { ok: true, json: async () => ({ status: 'approved' }) };
    };
    const withModel = { ...LEARNING_A, extraction_model: { provider: 'byo-key', model: 'gpt-4o-mini', version: null, vendor: 'openai-compatible' } };
    const withoutModel = { ...LEARNING_A, title: 'A distinct second title padded to length ok' };
    await runner.submitLearnings([withModel, withoutModel], 'claude-code', {
      fetchImpl, baseUrl: 'https://auxilo.test', apiKey: 'axl_test',
    });
    assert.equal(bodies.length, 2);
    assert.deepEqual(bodies[0].extraction_model, withModel.extraction_model);
    assert.equal('extraction_model' in bodies[1], false);
  });
});

// ─── Part 3: server.js intake — structural (repo convention for this file) ─

describe('server.js /learn wiring: extraction_model intake (structural)', () => {
  it('destructures extraction_model additively from the body', () => {
    assert.match(SERVER_SRC, /quality_self_assessment, extraction_context, submission_channel, visibility,\s*extraction_model \} = body/);
  });

  it('normalizeExtractionModel: malformed input -> null (tolerant, never a 400), bounded string lengths', () => {
    assert.match(SERVER_SRC, /function normalizeExtractionModel\(value\)/);
    const start = SERVER_SRC.indexOf('function normalizeExtractionModel(value)');
    const fn = SERVER_SRC.slice(start, start + 900);
    assert.match(fn, /if \(!value \|\| typeof value !== 'object' \|\| Array\.isArray\(value\)\) return null;/);
    assert.match(fn, /if \(typeof value\.provider !== 'string' \|\| !value\.provider\) return null;/);
    assert.match(fn, /boundedString\(value\.provider, 64\)/);
    assert.match(fn, /boundedString\(value\.model, 256\)/);
    assert.match(fn, /boundedString\(value\.version, 128\)/);
    assert.match(fn, /boundedString\(value\.vendor, 64\)/);
  });

  it('passes extractionModel into the evaluateExtractionPublish call', () => {
    const start = SERVER_SRC.indexOf('const laneVerdict = evaluateExtractionPublish({');
    assert.ok(start > 0);
    const block = SERVER_SRC.slice(start, start + 300);
    assert.match(block, /extractionModel,/);
  });

  it('stores extraction_model on the learning object, spread-if-present (matches quality_self_assessment\'s pattern)', () => {
    assert.match(SERVER_SRC, /\.\.\.\(extractionModel && \{ extraction_model: extractionModel \}\),/);
  });

  it('stripOwnerOnlyFields strips extraction_model — never on a buyer-facing envelope', () => {
    const start = SERVER_SRC.indexOf('function stripOwnerOnlyFields(learning)');
    assert.ok(start > 0);
    const fn = SERVER_SRC.slice(start, start + 500);
    assert.match(fn, /extraction_model: _extractionModel,/);
  });

  it('GET /account/learnings (owner surface) includes extraction_model in its explicit allow-list projection', () => {
    const start = SERVER_SRC.indexOf("app.get('/account/learnings'");
    assert.ok(start > 0);
    const block = SERVER_SRC.slice(start, start + 6000);
    assert.match(block, /learning\.extraction_model != null && \{ extraction_model: learning\.extraction_model \}/);
  });
});

// ─── Part 4: openapi.json documents the field ───────────────────────────────

describe('openapi.json: /learn request schema gains extraction_model as optional', () => {
  const openapi = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'openapi.json'), 'utf8'));

  it('the schema property exists with the right shape', () => {
    const props = openapi.paths['/learn'].post.requestBody.content['application/json'].schema.properties;
    assert.ok(props.extraction_model, 'extraction_model property missing from /learn request schema');
    assert.equal(props.extraction_model.type, 'object');
    assert.equal(props.extraction_model.properties.provider.type, 'string');
    assert.equal(props.extraction_model.properties.model.type, 'string');
    assert.equal(props.extraction_model.properties.version.type, 'string');
    assert.equal(props.extraction_model.properties.vendor.type, 'string');
  });

  it('is optional (not in the request schema\'s required list, if one exists)', () => {
    const schema = openapi.paths['/learn'].post.requestBody.content['application/json'].schema;
    if (Array.isArray(schema.required)) {
      assert.ok(!schema.required.includes('extraction_model'));
    }
  });

  it('a fixture body carrying extraction_model validates against the documented shape (provider/model/version/vendor are all strings)', () => {
    const fixture = { provider: 'byo-key', model: 'gpt-4o-mini', version: null, vendor: 'openai-compatible' };
    const props = openapi.paths['/learn'].post.requestBody.content['application/json'].schema.properties.extraction_model.properties;
    assert.equal(typeof fixture.provider, props.provider.type);
    assert.equal(typeof fixture.model, props.model.type);
  });
});

// ─── Part 5: real staged-server round trip + clean-lane calibration gate ──

const { reservePort, stageServer, bootServer, stopServer } = require('./helpers/staged-server');
const cleanLane = require('../lib/clean-lane.js');

const TRUSTED_KEY = 'axl_' + 'e'.repeat(40);
const TRUSTED = 'acc_extmodel_trusted';

function apiKeyRow(id, raw, label) {
  return {
    id,
    hash: crypto.createHash('sha256').update(raw).digest('hex'),
    label,
    scope: 'contribute',
    scope_version: 2,
    created_at: new Date().toISOString(),
    active: true,
  };
}

function fixtureCatalog() {
  const seed = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'seed-knowledge.json'), 'utf-8'));
  const base = Array.isArray(seed) ? seed[0] : seed.learnings[0];
  const l = JSON.parse(JSON.stringify(base));
  l.id = 'extmodel_seed_1';
  l.status = 'approved';
  return [l];
}

function fixtureAccounts() {
  const now = new Date().toISOString();
  return {
    [TRUSTED]: {
      id: TRUSTED,
      email: 'extmodel-trusted@test.local',
      created_at: now,
      tos_version: '2026-07-04-payee-agency-a1',
      accepted_at: now,
      publication_trust: { source: 'operator_grant', granted_at: now, ref: 'operator:extmodel-fixture' },
      api_keys: [apiKeyRow('key_extmodel_trusted', TRUSTED_KEY, 'extmodel-trusted')],
    },
  };
}

function extractionPayload(topic, extraction_model) {
  return {
    ...topic,
    category: 'code-execution',
    task_context: 'extraction_model stamp round-trip e2e',
    outcome: 'success',
    contributor_agent: 'auxilo-hook/claude-code',
    submission_channel: 'extraction',
    quality_self_assessment: { specificity: 5, actionability: 5, novelty: 5, completeness: 5, total: 20 },
    ...(extraction_model !== undefined && { extraction_model }),
  };
}

describe('EXTRACT-PER-CLIENT W1 PART C: real staged-server round trip', () => {
  it('calibrated provider auto-publishes and round-trips to GET /account/learnings; uncalibrated provider always holds even at quality 20 with an active grant; malformed extraction_model is tolerated, not a 400', { timeout: 240_000 }, async (t) => {
    let nodeModulesDir;
    try {
      const honoEntry = require.resolve('hono', { paths: [REPO_ROOT] });
      nodeModulesDir = honoEntry.slice(0, honoEntry.lastIndexOf(`${path.sep}node_modules${path.sep}`) + '/node_modules'.length);
    } catch {
      t.skip('hono not resolvable from repo root — skipping real boot (unit + structural legs still enforce)');
      return;
    }
    const reservation = await reservePort();
    if (reservation.skipReason) { t.skip(reservation.skipReason); return; }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auxilo-extmodel-'));
    let child = null;
    let baseUrl;
    const headers = { 'X-API-Key': TRUSTED_KEY, 'Content-Type': 'application/json' };
    const post = async (p, body) => {
      const res = await fetch(`${baseUrl}${p}`, { method: 'POST', headers, body: JSON.stringify(body) });
      return { status: res.status, body: await res.json() };
    };
    const get = async (p) => {
      const res = await fetch(`${baseUrl}${p}`, { headers });
      assert.equal(res.status, 200, `GET ${p}`);
      return res.json();
    };

    try {
      stageServer({
        repoRoot: REPO_ROOT,
        tmpDir,
        nodeModulesDir,
        port: reservation.port,
        rootFiles: ['server.js', 'seed-knowledge.json', 'skills.json', 'openapi.json', 'package.json', 'model_config.json'],
        linkDirs: ['lib', 'public', 'prompts', 'config'],
        replacements: [],
      });
      fs.writeFileSync(path.join(tmpDir, 'data', 'learnings.json'), JSON.stringify(fixtureCatalog(), null, 2));
      fs.writeFileSync(path.join(tmpDir, 'data', 'accounts.json'), JSON.stringify(fixtureAccounts(), null, 2));

      const boot = await bootServer({
        tmpDir,
        port: reservation.port,
        env: {
          NODE_ENV: 'test',
          WALLET_PRIVATE_KEY: '0x' + '11'.repeat(32),
          LLM_SENSITIVITY_ENABLED: 'false',
          AUXILO_DATA_DIR: path.join(tmpDir, 'data'),
          AUXILO_ACCOUNTS_FILE: path.join(tmpDir, 'data', 'accounts.json'),
          EXTRACTION_AUTOPUBLISH_CONSENT_ENABLED: 'true',
        },
        timeoutMs: 60_000,
        maxAttempts: 4,
      });
      if (boot.skipReason) { t.skip(boot.skipReason); return; }
      child = boot.child;
      baseUrl = boot.baseUrl;

      // Grant standing consent for TRUSTED so a clean, floor-passing item CAN
      // auto-publish — the calibration gate must still override this for an
      // uncalibrated provider (checked below).
      const granted = await post('/account/clean-lane/grant', {
        consent_version: cleanLane.CLEAN_LANE_CONSENT_VERSION,
        agree: true,
        affirmation: cleanLane.CLEAN_LANE_AFFIRMATION,
      });
      assert.equal(granted.status, 200, JSON.stringify(granted.body));

      // (1) Calibrated provider (claude-code) — auto-publishes.
      const calibrated = await post('/learn', extractionPayload(
        {
          title: 'Cap the retry queue depth to avoid unbounded memory growth',
          body: 'A retry queue with no depth cap grows unbounded under sustained upstream failure; cap it and shed the oldest entries with a logged counter so the failure is visible instead of silently consuming all available memory.',
          tags: ['retry', 'memory'],
        },
        { provider: 'claude-code', model: 'sonnet-fixture', version: null, vendor: null }
      ));
      assert.equal(calibrated.status, 201, JSON.stringify(calibrated.body));
      assert.equal(calibrated.body.status, 'approved', 'calibrated provider + active grant + quality 20 must auto-publish');

      const approvedRows = await get('/account/learnings?status=approved');
      const calibratedRow = approvedRows.learnings.find((l) => l.id === calibrated.body.id);
      assert.ok(calibratedRow, 'the published learning must appear in the owner listing');
      assert.deepEqual(calibratedRow.extraction_model, { provider: 'claude-code', model: 'sonnet-fixture', version: null, vendor: null });

      // (2) Uncalibrated provider (codex-cli) — ALWAYS holds, same quality/consent.
      const uncalibrated = await post('/learn', extractionPayload(
        {
          title: 'Pin the connection pool size below the database max_connections',
          body: 'A connection pool sized without headroom against the database max_connections setting exhausts the server under concurrent deploys; pin the pool below that ceiling with margin for admin and replication connections.',
          tags: ['database', 'pooling'],
        },
        { provider: 'codex-cli', model: null, version: '0.144.5', vendor: null }
      ));
      assert.equal(uncalibrated.status, 201, JSON.stringify(uncalibrated.body));
      assert.equal(uncalibrated.body.status, 'pending_review', 'an uncalibrated provider must never auto-publish, even at quality 20 with an active grant');
      assert.ok(uncalibrated.body.review_reason.includes('uncalibrated_extraction_provider'));

      const pendingRows = await get('/account/learnings?status=pending_review');
      const uncalibratedRow = pendingRows.learnings.find((l) => l.id === uncalibrated.body.id);
      assert.ok(uncalibratedRow, 'the held learning must still appear in the owner listing');
      assert.deepEqual(uncalibratedRow.extraction_model, { provider: 'codex-cli', model: null, version: '0.144.5', vendor: null });

      // (3) Malformed extraction_model (a string, not an object) — never a 400;
      // treated as absent (no extraction_model stored at all).
      const malformedBody = extractionPayload({
        title: 'Flush the write buffer before closing a piped child process',
        body: 'Closing a child process stdin immediately after a large write can truncate the piped output on the far end; wait for the write callback or drain event before calling end() so the consumer receives every byte.',
        tags: ['node', 'child-process'],
      });
      malformedBody.extraction_model = 'not-an-object';
      const malformed = await post('/learn', malformedBody);
      assert.notEqual(malformed.status, 400, 'a malformed extraction_model must never 400 the whole submission');
      assert.equal(malformed.status, 201);
      const allRows = await get('/account/learnings?status=approved,pending_review,rejected');
      const malformedRow = allRows.learnings.find((l) => l.id === malformed.body.id);
      assert.ok(malformedRow);
      assert.equal('extraction_model' in malformedRow, false, 'malformed input normalizes to absent, not a garbage value');
    } finally {
      if (child) await stopServer(child);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
