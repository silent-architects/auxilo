'use strict';

/**
 * SCREEN-MODEL-CONFIG — the one live inference call (the GOV-3 sensitivity
 * screen) reads its model id + ordered fallbacks from model_config.json, tries
 * the next fallback ONCE on a retryable provider error, and otherwise keeps the
 * pre-existing fail-closed contract byte-for-byte. Bundled: MODEL-PIN (b-2)
 * de-dated dormant pins, the OpenClaw daemon timer gated on the extraction
 * flag, and the four /openclaw/* admin routes 410-gated on the same flag.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  reservePort,
  stageServer,
  bootServer,
  stopServer,
} = require('./helpers/staged-server');

const REPO = path.join(__dirname, '..');
const SERVER_SRC = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');
const RECLASSIFY_SRC = fs.readFileSync(path.join(REPO, 'scripts', 'reclassify-pending.js'), 'utf8');
const MODEL_CONFIG = JSON.parse(fs.readFileSync(path.join(REPO, 'model_config.json'), 'utf8'));

const {
  classifySensitivityLLM,
  resolveModelConfig,
  isRetryableProviderError,
  clearModelConfigCache,
  DEFAULT_MODEL,
  DEFAULT_MODEL_CONFIG_PATH,
  SCREEN_CONFIG_BLOCK,
} = require('../lib/content-sensitivity-llm.js');

// A complete, parseable verdict (R13: learning_type + malicious + reason required).
const CLEAN_VERDICT = JSON.stringify({
  sensitive: false, reason: 'generic public tooling', confidence: 0.92,
  learning_type: 'system_fact', malicious: 'none', malicious_reason: 'No malicious instruction.',
});

function apiError(status, text = 'provider said no') {
  const err = new Error(`Anthropic API error ${status}: ${text}`);
  err.status = status;
  return err;
}

function abortError() {
  const err = new Error('This operation was aborted');
  err.name = 'AbortError';
  return err;
}

function writeConfig(dir, name, obj) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
  return p;
}

describe('SCREEN-MODEL-CONFIG: model_config.json resolver', () => {
  let tmpDir;
  before(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auxilo-smc-')); });
  after(() => { clearModelConfigCache(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('ships a sensitivity_screen block with the current model as primary and one named fallback', () => {
    assert.equal(SCREEN_CONFIG_BLOCK, 'sensitivity_screen');
    const block = MODEL_CONFIG.sensitivity_screen;
    assert.ok(block, 'model_config.json must carry a sensitivity_screen block');
    assert.equal(block.model, 'claude-haiku-4-5');
    assert.deepEqual(block.fallbacks, ['claude-sonnet-4-5']);
    assert.equal(block.max_attempts, 2);
  });

  it('leaves the existing extraction block intact (primary + fallbacks shape unchanged)', () => {
    assert.equal(MODEL_CONFIG.extraction.primary.provider, 'anthropic');
    assert.equal(MODEL_CONFIG.extraction.primary.model, 'claude-haiku-4-5');
    assert.deepEqual(MODEL_CONFIG.extraction.fallbacks, [{ provider: 'anthropic', model: 'claude-sonnet-4-5' }]);
    assert.equal(MODEL_CONFIG.extraction.max_attempts_per_provider, 3);
    assert.equal(MODEL_CONFIG.extraction.transcript_limits.max_body_bytes, 262144);
    assert.deepEqual(MODEL_CONFIG.extraction.source_allowlist, ['claude-code', 'openclaw']);
  });

  it('reads the sensitivity_screen block from the repo model_config.json by default', () => {
    assert.equal(DEFAULT_MODEL_CONFIG_PATH, path.join(REPO, 'model_config.json'));
    const r = resolveModelConfig();
    assert.deepEqual(r, {
      model: 'claude-haiku-4-5', fallbacks: ['claude-sonnet-4-5'], max_attempts: 2, source: 'config',
    });
  });

  it('reads the extraction block shape (primary.model + [{model}] fallbacks) for the dormant pins', () => {
    const r = resolveModelConfig('extraction');
    assert.equal(r.model, 'claude-haiku-4-5');
    assert.deepEqual(r.fallbacks, ['claude-sonnet-4-5']);
    assert.equal(r.source, 'config');
  });

  it('falls back to the hardcoded default when the file is missing', () => {
    const r = resolveModelConfig('sensitivity_screen', { configPath: path.join(tmpDir, 'does-not-exist.json') });
    assert.deepEqual(r, { model: DEFAULT_MODEL, fallbacks: [], max_attempts: 1, source: 'default' });
    assert.equal(DEFAULT_MODEL, 'claude-haiku-4-5');
  });

  it('falls back to the hardcoded default when the file is unparseable', () => {
    const p = path.join(tmpDir, 'garbage.json');
    fs.writeFileSync(p, '{ not json');
    const r = resolveModelConfig('sensitivity_screen', { configPath: p });
    assert.deepEqual(r, { model: DEFAULT_MODEL, fallbacks: [], max_attempts: 1, source: 'default' });
  });

  it('falls back to the hardcoded default when the block is missing or carries no model', () => {
    const noBlock = writeConfig(tmpDir, 'no-block.json', { extraction: { primary: { model: 'x' } } });
    assert.deepEqual(resolveModelConfig('sensitivity_screen', { configPath: noBlock }),
      { model: DEFAULT_MODEL, fallbacks: [], max_attempts: 1, source: 'default' });
    const emptyModel = writeConfig(tmpDir, 'empty-model.json', { sensitivity_screen: { model: '   ', fallbacks: ['y'] } });
    assert.deepEqual(resolveModelConfig('sensitivity_screen', { configPath: emptyModel }),
      { model: DEFAULT_MODEL, fallbacks: [], max_attempts: 1, source: 'default' });
  });

  it('caps max_attempts at the number of distinct models and dedups the fallback list', () => {
    const p = writeConfig(tmpDir, 'caps.json', {
      sensitivity_screen: { model: 'a', fallbacks: ['a', 'b', 'b', 'c', '', 7], max_attempts: 10 },
    });
    assert.deepEqual(resolveModelConfig('sensitivity_screen', { configPath: p }),
      { model: 'a', fallbacks: ['b', 'c'], max_attempts: 3, source: 'config' });
    const p2 = writeConfig(tmpDir, 'caps2.json', {
      sensitivity_screen: { model: 'a', fallbacks: ['b', 'c'], max_attempts: 2 },
    });
    assert.equal(resolveModelConfig('sensitivity_screen', { configPath: p2 }).max_attempts, 2);
  });
});

describe('SCREEN-MODEL-CONFIG: retryable provider error classification', () => {
  it('treats 404 / 429 / 5xx / timeout as retryable', () => {
    assert.equal(isRetryableProviderError(apiError(404)), true);
    assert.equal(isRetryableProviderError(apiError(429)), true);
    assert.equal(isRetryableProviderError(apiError(500)), true);
    assert.equal(isRetryableProviderError(apiError(502)), true);
    assert.equal(isRetryableProviderError(apiError(529)), true);
    assert.equal(isRetryableProviderError(abortError()), true);
    // message-only errors (no .status) are classified from the API-error text
    assert.equal(isRetryableProviderError(new Error('Anthropic API error 503: overloaded')), true);
  });

  it('treats everything else as non-retryable', () => {
    assert.equal(isRetryableProviderError(apiError(400)), false);
    assert.equal(isRetryableProviderError(apiError(401)), false);
    assert.equal(isRetryableProviderError(apiError(403)), false);
    assert.equal(isRetryableProviderError(apiError(413)), false);
    assert.equal(isRetryableProviderError(new Error('boom')), false);
    assert.equal(isRetryableProviderError(new TypeError('fetch failed')), false);
    assert.equal(isRetryableProviderError(null), false);
  });
});

describe('SCREEN-MODEL-CONFIG: classifySensitivityLLM fallback + fail-closed contract', () => {
  const OPTS = { apiKey: 'test-key' };

  it('uses the config primary model on a clean call (one attempt, no fallback)', async () => {
    const calls = [];
    const verdict = await classifySensitivityLLM('t', 'b', ['x'], {
      ...OPTS, llmCall: async (a) => { calls.push(a); return CLEAN_VERDICT; },
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].model, 'claude-haiku-4-5');
    assert.equal(calls[0].apiKey, 'test-key');
    assert.equal(verdict.sensitive, false);
  });

  it('one retryable error (404) -> the fallback model is attempted exactly once and its verdict is returned', async () => {
    const calls = [];
    const verdict = await classifySensitivityLLM('t', 'b', [], {
      ...OPTS,
      llmCall: async (a) => {
        calls.push(a.model);
        if (calls.length === 1) throw apiError(404, 'model: claude-haiku-4-5 not found');
        return CLEAN_VERDICT;
      },
    });
    assert.deepEqual(calls, ['claude-haiku-4-5', 'claude-sonnet-4-5']);
    assert.equal(verdict.sensitive, false);
    assert.equal(verdict.reason, 'generic public tooling');
  });

  for (const [label, make] of [['429', () => apiError(429)], ['503', () => apiError(503)], ['timeout', abortError]]) {
    it(`one retryable error (${label}) -> exactly one fallback attempt`, async () => {
      const calls = [];
      const verdict = await classifySensitivityLLM('t', 'b', [], {
        ...OPTS,
        llmCall: async (a) => { calls.push(a.model); if (calls.length === 1) throw make(); return CLEAN_VERDICT; },
      });
      assert.deepEqual(calls, ['claude-haiku-4-5', 'claude-sonnet-4-5']);
      assert.equal(verdict.sensitive, false);
    });
  }

  it('non-retryable error -> fails closed immediately with the EXISTING shape (no fallback attempt)', async () => {
    const calls = [];
    const verdict = await classifySensitivityLLM('t', 'b', [], {
      ...OPTS, llmCall: async (a) => { calls.push(a.model); throw apiError(401, 'invalid x-api-key'); },
    });
    assert.deepEqual(calls, ['claude-haiku-4-5'], 'a 401 must not consume the fallback');
    // Byte-for-byte the pre-existing fail-closed verdict: three keys, this order, this reason format.
    assert.deepEqual(verdict, {
      sensitive: true,
      reason: 'llm error: Anthropic API error 401: invalid x-api-key (fail-closed)',
      confidence: 1,
    });
    assert.deepEqual(Object.keys(verdict), ['sensitive', 'reason', 'confidence']);
  });

  it('non-retryable generic throw -> same fail-closed shape, one call (the pre-existing ci5 contract)', async () => {
    const calls = [];
    const verdict = await classifySensitivityLLM('t', 'b', [], {
      ...OPTS, llmCall: async (a) => { calls.push(a.model); throw new Error('boom'); },
    });
    assert.equal(calls.length, 1);
    assert.deepEqual(verdict, { sensitive: true, reason: 'llm error: boom (fail-closed)', confidence: 1 });
  });

  it('exhaustion (retryable on primary AND fallback) -> fails closed with the last error, same shape, no third attempt', async () => {
    const calls = [];
    const verdict = await classifySensitivityLLM('t', 'b', [], {
      ...OPTS, llmCall: async (a) => { calls.push(a.model); throw apiError(503, `overloaded ${a.model}`); },
    });
    assert.deepEqual(calls, ['claude-haiku-4-5', 'claude-sonnet-4-5']);
    assert.deepEqual(verdict, {
      sensitive: true,
      reason: 'llm error: Anthropic API error 503: overloaded claude-sonnet-4-5 (fail-closed)',
      confidence: 1,
    });
  });

  it('timeout on both models -> the pre-existing timeout reason string, same shape', async () => {
    const calls = [];
    const verdict = await classifySensitivityLLM('t', 'b', [], {
      ...OPTS, timeoutMs: 1234, llmCall: async (a) => { calls.push(a.model); throw abortError(); },
    });
    assert.equal(calls.length, 2);
    assert.deepEqual(verdict, { sensitive: true, reason: 'llm timeout after 1234ms (fail-closed)', confidence: 1 });
  });

  it('missing API key -> fails closed before any call, unchanged shape', async () => {
    const calls = [];
    const verdict = await classifySensitivityLLM('t', 'b', [], {
      apiKey: '', llmCall: async (a) => { calls.push(a.model); return CLEAN_VERDICT; },
    });
    assert.equal(calls.length, 0);
    assert.deepEqual(verdict, {
      sensitive: true,
      reason: 'llm unavailable: ANTHROPIC_API_KEY not configured (fail-closed)',
      confidence: 1,
    });
  });

  it('unparseable response on the primary is NOT a provider error -> fail closed, no fallback', async () => {
    const calls = [];
    const verdict = await classifySensitivityLLM('t', 'b', [], {
      ...OPTS, llmCall: async (a) => { calls.push(a.model); return 'not json'; },
    });
    assert.equal(calls.length, 1);
    assert.deepEqual(verdict, { sensitive: true, reason: 'llm response unparseable (fail-closed)', confidence: 1 });
  });

  it('with the config unreadable, the hardcoded default is the only attempt (retryable error -> fail closed, one call)', async () => {
    const calls = [];
    const verdict = await classifySensitivityLLM('t', 'b', [], {
      ...OPTS,
      modelConfigPath: path.join(os.tmpdir(), 'auxilo-smc-absent', 'model_config.json'),
      llmCall: async (a) => { calls.push(a.model); throw apiError(404); },
    });
    assert.deepEqual(calls, [DEFAULT_MODEL]);
    assert.deepEqual(verdict, {
      sensitive: true, reason: 'llm error: Anthropic API error 404: provider said no (fail-closed)', confidence: 1,
    });
  });

  it('an explicit opts.model overrides the primary but keeps the config fallback', async () => {
    const calls = [];
    await classifySensitivityLLM('t', 'b', [], {
      ...OPTS, model: 'claude-custom',
      llmCall: async (a) => { calls.push(a.model); if (calls.length === 1) throw apiError(500); return CLEAN_VERDICT; },
    });
    assert.deepEqual(calls, ['claude-custom', 'claude-sonnet-4-5']);
  });

  it('reclassify-pending.js goes through classifySensitivityLLM with no model override (same resolver)', () => {
    assert.match(RECLASSIFY_SRC, /await classifySensitivityLLM\(l\.title, l\.body, tags\)/);
    assert.doesNotMatch(RECLASSIFY_SRC, /claude-haiku-4-5|claude-sonnet-4|model:/);
  });
});

describe('SCREEN-MODEL-CONFIG: server.js structural pins + daemon gate', () => {
  it('no dated model id remains in server.js; the three dormant pins read the extraction block via the shared resolver', () => {
    assert.doesNotMatch(SERVER_SRC, /claude-sonnet-4-20250514/);
    assert.doesNotMatch(SERVER_SRC, /'claude-haiku-4-5'/);
    assert.match(SERVER_SRC, /resolveModelConfig,[^\n]*\n\} = require\('\.\/lib\/content-sensitivity-llm\.js'\)/);
    // Exactly three call sites: daemon llmCall, /pipeline/upload, /extract audit row.
    assert.equal((SERVER_SRC.match(/resolveModelConfig\('extraction'\)\.model/g) || []).length, 3);
    const daemon = SERVER_SRC.slice(SERVER_SRC.indexOf('async function runOpenClawDaemon()'), SERVER_SRC.indexOf('function generateId()'));
    assert.match(daemon, /model: resolveModelConfig\('extraction'\)\.model/);
    const upload = SERVER_SRC.slice(SERVER_SRC.indexOf("app.post('/pipeline/upload'"), SERVER_SRC.indexOf("app.post('/pipeline/:id/approve'"));
    assert.match(upload, /model: resolveModelConfig\('extraction'\)\.model/);
    assert.match(SERVER_SRC, /model: extractionConfig\.primary\?\.model \|\| resolveModelConfig\('extraction'\)\.model/);
  });

  it('daemon bootstrap is gated on SERVER_SIDE_EXTRACTION_ENABLED, not on the API-key secret alone (structural)', () => {
    // Runtime proof is impractical: the old code also produced no log line when
    // the flag was off (runOpenClawDaemon early-returns silently), so a booted
    // server looks identical either way. The structural assertion pins the gate.
    const idx = SERVER_SRC.indexOf('setInterval(() => runOpenClawDaemon()');
    assert.ok(idx > 0, 'daemon setInterval must exist');
    const before = SERVER_SRC.slice(idx - 400, idx);
    assert.match(before, /if \(SERVER_SIDE_EXTRACTION_ENABLED && process\.env\.ANTHROPIC_API_KEY\) \{/);
    assert.doesNotMatch(SERVER_SRC, /\nif \(process\.env\.ANTHROPIC_API_KEY\) \{\n  runOpenClawDaemon\(\)/);
  });

  it('all four /openclaw/* routes carry the 410 gate as the first statement after adminAuth (structural)', () => {
    for (const [route, method, scope] of [
      ['/openclaw/status', 'get', 'read'], ['/openclaw/trigger', 'post', 'admin'],
      ['/openclaw/config', 'post', 'admin'], ['/openclaw/state', 'get', 'read'],
    ]) {
      const re = new RegExp(
        `app\\.${method}\\('${route.replace(/\//g, '\\/')}', adminAuth\\('${scope}'\\), (?:async )?\\(c\\) => \\{\\n  if \\(!SERVER_SIDE_EXTRACTION_ENABLED\\) return c\\.json\\(EXTRACTION_DEPRECATED, 410\\);\\n`,
      );
      assert.match(SERVER_SRC, re, `${route} must 410-gate first`);
    }
  });
});

describe('SCREEN-MODEL-CONFIG: /openclaw/* answer 410 with the flag unset (staged server)', { timeout: 180_000 }, () => {
  let tmpDir;
  let child;
  let baseUrl;
  let skipReason;
  const ADMIN_TOKEN = `smc-admin-${'a'.repeat(32)}`;

  before(async () => {
    const reservation = await reservePort();
    if ('skipReason' in reservation) { skipReason = reservation.skipReason; return; }
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auxilo-smc-server-'));
    const honoEntry = require.resolve('hono', { paths: [REPO] });
    const nodeModulesDir = honoEntry.slice(0, honoEntry.lastIndexOf(`${path.sep}node_modules${path.sep}`) + '/node_modules'.length);
    const staged = stageServer({
      repoRoot: REPO,
      tmpDir,
      nodeModulesDir,
      port: reservation.port,
      rootFiles: ['server.js', 'seed-knowledge.json', 'skills.json', 'openapi.json', 'package.json', 'model_config.json'],
      linkDirs: ['lib', 'public', 'prompts', 'config'],
    });
    const env = {
      NODE_ENV: 'test', TEST_MODE: '1', WALLET_PRIVATE_KEY: `0x${'11'.repeat(32)}`,
      LLM_SENSITIVITY_ENABLED: 'false', AUXILO_DATA_DIR: staged.dataDir,
      AUXILO_ACCOUNTS_FILE: path.join(staged.dataDir, 'accounts.json'),
      AUXILO_MAGIC_LINKS_FILE: path.join(staged.dataDir, 'magic-links.json'),
      AUXILO_IDENTITY_FILE: path.join(staged.dataDir, 'identity.json'),
      AUXILO_ADMIN_TOKEN: ADMIN_TOKEN,
      // A deployed key with the flag UNSET is exactly prod's shape.
      ANTHROPIC_API_KEY: 'sk-ant-test-not-a-real-key',
      SERVER_SIDE_EXTRACTION_ENABLED: '',
    };
    const boot = await bootServer({ tmpDir, port: reservation.port, env, timeoutMs: 60_000 });
    if ('skipReason' in boot) { skipReason = boot.skipReason; return; }
    child = boot.child;
    baseUrl = boot.baseUrl;
  });

  after(async () => {
    if (child) await stopServer(child);
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const ROUTES = [
    ['GET', '/openclaw/status'],
    ['POST', '/openclaw/trigger'],
    ['POST', '/openclaw/config'],
    ['GET', '/openclaw/state'],
  ];

  for (const [method, route] of ROUTES) {
    it(`${method} ${route} -> 410 EXTRACTION_DEPRECATED for an authenticated admin`, async (t) => {
      if (skipReason) return t.skip(skipReason);
      const res = await fetch(`${baseUrl}${route}`, {
        method,
        headers: { Authorization: `Bearer ${ADMIN_TOKEN}`, 'Content-Type': 'application/json' },
        body: method === 'POST' ? JSON.stringify({ auto_publish: true }) : undefined,
      });
      assert.equal(res.status, 410, `${method} ${route} got ${res.status}`);
      const body = await res.json();
      assert.equal(body.code, 'extraction_client_side');
      assert.equal(body.error, 'Server-side extraction is disabled');
      assert.equal(Object.hasOwn(body, 'triggered'), false);
      assert.equal(Object.hasOwn(body, 'daemon_running'), false);
    });

    it(`${method} ${route} -> adminAuth still runs first (401 without a token)`, async (t) => {
      if (skipReason) return t.skip(skipReason);
      const res = await fetch(`${baseUrl}${route}`, { method });
      assert.equal(res.status, 401);
    });
  }
});
