'use strict';
const { supportedClaude } = require('./helpers/epc2-fixtures.js');
/*
 * test/claude-code-provider.test.js — EXTRACT-PER-CLIENT W1 PART A
 * (absorbs 0913 PART A / EXTRACT-TOOLS-LOCK).
 *
 * Covers: scripts/providers/claude-code.js (env scrub, tool lock, billing-helper
 * detector, mode dispatch) and scripts/providers/index.js (provider selection,
 * caching, clean-fallthrough e2e proof). The 9 relocated 0913 PART A cases live
 * here (env-scrub completeness/preservation, extraction argv gains --tools '',
 * judge argv unchanged, shared claudeChildEnv() across both spawns,
 * billing-helper positive/negative/malformed, extraction short-circuits without
 * spawning on a hit), plus items 10-13 (provider.interface smoke test lives in
 * its own file per the spec; selection order; caching; e2e no-throw proof).
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const claudeCode = require('../scripts/providers/claude-code.js');
const providers = require('../scripts/providers/index.js');

const tempDirs = [];
function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
function cleanupTempDirs() {
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
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

function epcAdapterFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'epc2-adapter-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  claudeCode._resetSettingSourcesCacheForTests();
  const codex = require('../scripts/providers/codex-cli.js'); codex._resetVersionCacheForTests();
  const byo = require('../scripts/providers/byo-key.js');
  fs.mkdirSync(path.join(root, '.codex')); fs.writeFileSync(path.join(root, '.codex/auth.json'), '{"auth_mode":"chatgpt"}');
  const opts = { ...supportedClaude, homeDir: root, cwd: root, claudeBin: '/fixture/PRIVATE_PATH/claude', codexBin: '/fixture/PRIVATE_PATH/codex',
    systemConfigPaths: [], providersStatePath: path.join(root, 'providers.json'), beforeModelInvocation: () => true,
    log: () => {}, existsSync: file => String(file).startsWith(root) && fs.existsSync(file),
    spawnSyncImpl: () => assert.fail('unstubbed model spawn'), fetchImpl: () => assert.fail('unstubbed vendor request') };
  byo.writeByoConfig({ provider: 'openai', model: 'requested-model', api_key: 'PRIVATE_KEY', base_url: 'https://fixture.invalid/PRIVATE_URL/v1' }, opts);
  return { root, opts, codex, byo };
}

const epcWrapper = (fields = {}) => JSON.stringify({ type: 'result', result: '{"learnings":[]}', is_error: false, ...fields });
function epcClaudeSpawn(stdout, status = 0, stderr = '') {
  return (_bin, args) => args[0] === 'auth' ? authJson(true) : { status, stdout, stderr };
}
function epcFailure(result, reason) {
  assert.equal(result.ok, false); assert.equal(result.text, ''); assert.equal(result.reason, reason);
  for (const marker of ['PRIVATE_OUTPUT', 'PRIVATE_ERROR', 'PRIVATE_PATH', 'PRIVATE_URL', 'PRIVATE_KEY', 'PRIVATE_TYPE']) {
    assert.equal(JSON.stringify(result).includes(marker), false, marker);
  }
}

describe('EPC2-2 Part B and mandatory adapter invocation boundary', () => {
  for (const id of ['claude-code', 'codex-cli', 'byo-key']) {
    it('hook fail-closed and exactly once before invocation: ' + id + ', both modes', async t => {
      const f = epcAdapterFixture(t); const adapter = id === 'claude-code' ? claudeCode : id === 'codex-cli' ? f.codex : f.byo;
      for (const mode of ['extract', 'judge']) {
        const events = [];
        const opts = { ...f.opts, mode,
          spawnSyncImpl: (_bin, args) => {
            if (args[0] === 'auth') return authJson(true);
            if (args[0] === '--version') return { status: 0, stdout: 'codex 1.0.0' };
            events.push('spawn');
            if (id === 'codex-cli') { fs.writeFileSync(args[args.indexOf('-o') + 1], mode === 'judge' ? '{"decisions":[]}' : '{"learnings":[]}'); return { status: 0, stdout: '{"type":"thread.started"}\n{"type":"turn.completed"}' }; }
            return { status: 0, stdout: epcWrapper() };
          },
          fetchImpl: async () => { events.push('spawn'); return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'answer' } }] }) }; },
        };
        const missing = await adapter.runModel({ ...opts, beforeModelInvocation: undefined });
        epcFailure(missing, 'model invocation requires an ownership hook'); assert.equal(missing.reasonCode, 'invocation-hook-missing'); assert.deepEqual(events, []);
        for (const value of [false, undefined, 1, 'true', Promise.resolve(true)]) {
          const refused = await adapter.runModel({ ...opts, beforeModelInvocation: () => { events.push('hook'); return value; } });
          epcFailure(refused, 'model invocation held by ownership hook'); assert.deepEqual(events.splice(0), ['hook']);
        }
        const result = await adapter.runModel({ ...opts, beforeModelInvocation: () => { events.push('hook'); return true; } });
        assert.equal(result.ok, true); assert.deepEqual(events, ['hook', 'spawn']);
      }
    });

    it('pre-invocation refusal does not consult the hook: ' + id, async t => {
      const f = epcAdapterFixture(t); const adapter = id === 'claude-code' ? claudeCode : id === 'codex-cli' ? f.codex : f.byo;
      const opts = { ...f.opts, beforeModelInvocation: () => assert.fail('refusal must precede hook') };
      if (id === 'claude-code') { fs.mkdirSync(path.join(f.root, '.claude')); fs.writeFileSync(path.join(f.root, '.claude/settings.json'), '{"apiKeyHelper":"PRIVATE_KEY"}'); }
      if (id === 'codex-cli') fs.unlinkSync(path.join(f.root, '.codex/auth.json'));
      if (id === 'byo-key') fs.unlinkSync(opts.providersStatePath);
      for (const mode of ['extract', 'judge']) { const result = await adapter.runModel({ ...opts, mode }); assert.equal(result.refusal, 'pre-invocation'); assert.equal(result.ok, false); }
    });
  }

  it('legacy extractWithClaudeCode also requires the hook, with no new production callers', t => {
    const { opts } = epcAdapterFixture(t); let modelCalls = 0;
    const result = claudeCode.extractWithClaudeCode('PRIVATE_OUTPUT', { ...opts, beforeModelInvocation: undefined,
      spawnSyncImpl: (_bin, args) => { if (args[0] === 'auth') return authJson(true); modelCalls++; return { status: 0, stdout: epcWrapper() }; },
    });
    assert.equal(result.reasonCode, 'invocation-hook-missing'); assert.equal(result.out, ''); assert.equal(modelCalls, 0);
    const { execFileSync } = require('node:child_process');
    const matches = execFileSync('git', ['grep', '-n', 'extractWithClaudeCode(', '--', 'scripts/', 'bin/', 'lib/'], { encoding: 'utf8' });
    assert.equal(matches.split('\n').filter(line => /:\d+:function extractWithClaudeCode\(/.test(line)).length, 1);
    assert.equal(matches.split('\n').filter(line => /:\d+:\s*(?:return |await |const .*?= )extractWithClaudeCode\(/.test(line)).length, 0);
  });

  for (const mode of ['extract', 'judge']) {
    for (const identity of [false, true]) for (const usage of [false, true]) {
      it(`B1/B2 ${mode}: identity=${identity}, usage=${usage} remain independent`, async t => {
        const { opts } = epcAdapterFixture(t);
        const result = await claudeCode.runModel({ ...opts, mode, spawnSyncImpl: epcClaudeSpawn(epcWrapper({
          ...(identity && { modelUsage: { 'requested-alias[1m]': { canonicalModel: 'actual-model' } } }),
          ...(usage && { usage: { input_tokens: 5, cache_read_input_tokens: 3, output_tokens: 2 } }),
        })) });
        assert.equal(result.ok, true); assert.equal(result.identity.requested_model, null);
        assert.equal(result.identity.observed_model, identity ? 'actual-model' : null);
        assert.equal(result.identity.model, identity ? 'actual-model' : null);
        assert.equal(result.identity.version, '2.1.41'); assert.deepEqual(result.usage, usage ? { input_tokens: 8, output_tokens: 2 } : null);
        assert.equal(result.identity.identity_unresolved, identity ? undefined : 'missing');
        assert.equal(JSON.stringify(result.identity).includes('[1m]'), false);
      });
    }

    for (const [label, modelUsage, observed, unresolved] of [
      ['same value twice', { a: { canonicalModel: 'actual' }, b: { canonicalModel: 'actual' } }, 'actual', undefined],
      ['distinct values', { a: { canonicalModel: 'one' }, b: { canonicalModel: 'two' } }, null, 'ambiguous'],
      ['keys only', { 'requested[1m]': { cost: 1 } }, null, 'missing'],
      ['blank values', { a: { canonicalModel: '' }, b: { canonicalModel: ' ' } }, null, 'missing'],
    ]) it(`B2 ${mode}: ${label}`, async t => {
      const { opts } = epcAdapterFixture(t); const result = await claudeCode.runModel({ ...opts, mode, spawnSyncImpl: epcClaudeSpawn(epcWrapper({ modelUsage })) });
      assert.equal(result.identity.observed_model, observed); assert.equal(result.identity.identity_unresolved, unresolved);
    });

    it(`B3 ${mode}: strict clean/noisy wrappers and all second JSON value types`, async t => {
      const { opts } = epcAdapterFixture(t); const wrapper = epcWrapper({ result: '  unchanged result bytes\n401 run /login  ' });
      for (const stdout of [wrapper, 'SDK noise\n' + wrapper + '\nSDK noise']) {
        const result = await claudeCode.runModel({ ...opts, mode, spawnSyncImpl: epcClaudeSpawn(stdout) });
        assert.equal(result.ok, true); assert.equal(result.text, '  unchanged result bytes\n401 run /login  ');
      }
      for (const extra of ['{}', '[]', 'null', 'true', 'false', '17', '"extra"', '{\n"multiline":true\n}', '[\n1\n]']) {
        const result = await claudeCode.runModel({ ...opts, mode, spawnSyncImpl: epcClaudeSpawn('noise\n' + wrapper + '\n' + extra) });
        epcFailure(result, mode === 'judge' ? 'local judge returned malformed JSON wrapper' : 'local model returned malformed JSON wrapper');
      }
      for (const obj of [{ result: 'PRIVATE_OUTPUT' }, { type: 'result', result: 3 }, { type: 'result', result: 'PRIVATE_OUTPUT', is_error: true }]) {
        const result = await claudeCode.runModel({ ...opts, mode, spawnSyncImpl: epcClaudeSpawn(JSON.stringify(obj)) });
        epcFailure(result, 'local model returned no successful result'); assert.equal(result.reasonCode, 'model-error');
      }
    });

    it(`B4 ${mode}: Claude failure exits have pinned reasons and no private output`, async t => {
      const { opts } = epcAdapterFixture(t);
      for (const [response, reason] of [
        [null, 'local model returned no process result'],
        [{ status: null, signal: 'SIGTERM', stdout: 'PRIVATE_OUTPUT', stderr: 'PRIVATE_ERROR' }, 'local model invocation failed'],
        [{ error: new Error('PRIVATE_ERROR'), stdout: 'PRIVATE_OUTPUT' }, 'local model invocation failed'],
        [{ status: 2, stdout: 'PRIVATE_OUTPUT', stderr: 'PRIVATE_ERROR' }, 'local model exited unsuccessfully'],
        [{ status: 0, stdout: 'PRIVATE_OUTPUT' }, mode === 'judge' ? 'local judge returned malformed JSON wrapper' : 'local model returned malformed JSON wrapper'],
        [{ status: 1, stdout: 'Please run /login PRIVATE_OUTPUT', stderr: 'PRIVATE_ERROR' }, 'local model not authenticated in this context (run `claude auth login` once); skipping deterministic extraction'],
        [{ status: 1, stderr: 'You cannot use --strict-mcp-config when an enterprise MCP config is present PRIVATE_ERROR' }, 'Claude Code refused MCP isolation with managed configuration'],
      ]) epcFailure(await claudeCode.runModel({ ...opts, mode, spawnSyncImpl: (_bin, args) => args[0] === 'auth' ? authJson(true) : response }), reason);
      epcFailure(await claudeCode.runModel({ ...opts, mode, spawnSyncImpl: (_bin, args) => { if (args[0] === 'auth') return authJson(true); throw new Error('PRIVATE_ERROR'); } }), 'local model spawn failed');
    });
  }

  for (const vendor of ['openai', 'anthropic', 'gemini']) it('B6/B7: ' + vendor + ' requested model is never promoted; only vendor response is observed', async t => {
    const { opts, byo } = epcAdapterFixture(t);
    byo.writeByoConfig({ provider: vendor, model: 'requested-model', api_key: 'PRIVATE_KEY' }, opts);
    for (const mode of ['extract', 'judge']) for (const observed of [false, true]) {
      const data = { choices: [{ message: { content: 'answer' } }], content: [{ type: 'text', text: 'answer' }], candidates: [{ content: { parts: [{ text: 'answer' }] } }],
        ...(observed && { [vendor === 'gemini' ? 'modelVersion' : 'model']: 'response-model' }) };
      const result = await byo.runModel({ ...opts, mode, fetchImpl: async () => ({ ok: true, status: 200, json: async () => data }) });
      assert.equal(result.identity.requested_model, 'requested-model'); assert.equal(result.identity.observed_model, observed ? 'response-model' : null);
      const stamp = require('../scripts/extract-local.js').resolveExtractionModelIdentity(result);
      assert.equal(stamp.model, observed ? 'response-model' : null);
    }
  });

  it('B4: BYO failure exit matrix hides errors, body, path and configured URL', async t => {
    const { opts, byo } = epcAdapterFixture(t);
    for (const mode of ['extract', 'judge']) {
      for (const [fetchImpl, reason] of [
        [async () => { throw new Error('PRIVATE_ERROR'); }, 'BYO provider request failed'],
        [async () => ({ ok: false, status: 429, text: async () => 'PRIVATE_OUTPUT' }), 'BYO provider rate-limited the request (HTTP 429)'],
        [async () => ({ ok: false, status: 503 }), 'BYO provider returned HTTP 503'],
        [async () => ({ ok: false, status: 'PRIVATE_ERROR' }), 'BYO provider request failed'],
        [async () => ({ ok: true, status: 200, json: async () => { throw new Error('PRIVATE_OUTPUT'); } }), 'BYO provider returned a non-JSON body'],
        [async () => ({ ok: true, status: 200, headers: { get: () => String(8 * 1024 * 1024) } }), 'BYO provider response exceeded the 2097152-byte cap'],
      ]) epcFailure(await byo.runModel({ ...opts, mode, fetchImpl }), reason);
    }
    byo.writeByoConfig({ provider: 'openai', model: 'requested-model', api_key: 'PRIVATE_KEY', base_url: 'http://fixture.invalid/PRIVATE_URL' }, opts);
    epcFailure(await byo.runModel(opts), 'configured base URL is not https; refusing the request');
  });

  it('B4/B5: Codex exit matrix, closed item-type list, and exported auth status', async t => {
    const { opts, codex, root } = epcAdapterFixture(t);
    assert.equal(typeof codex.checkAuthStatus, 'function'); assert.equal(codex.checkAuthStatus(opts), 'logged-in');
    for (const mode of ['extract', 'judge']) {
      for (const [response, reason] of [
        [null, 'codex spawn returned no process result'],
        [{ error: Object.assign(new Error('PRIVATE_ERROR'), { code: 'ENOENT' }) }, 'codex binary not found'],
        [{ error: Object.assign(new Error('PRIVATE_ERROR'), { code: 'ETIMEDOUT' }) }, 'codex exec timed out'],
        [{ error: new Error('PRIVATE_ERROR') }, 'codex spawn failed'],
        [{ signal: 'SIGTERM', status: null }, 'codex exec timed out'],
        [{ status: 1, stdout: 'PRIVATE_OUTPUT', stderr: 'PRIVATE_ERROR' }, 'codex exec failed'],
        [{ status: 0, stdout: 'PRIVATE_OUTPUT' }, 'codex exec emitted no parseable lifecycle event'],
        [{ status: 0, stdout: '{"type":"item.completed","item":{"type":"PRIVATE_TYPE"}}' }, 'codex exec emitted disallowed item type: unrecognized'],
        [{ status: 1, stderr: 'not authenticated PRIVATE_ERROR' }, 'codex CLI reported it is not authenticated'],
        [{ status: 1, stdout: '{"type":"error","message":"invalid_json_schema PRIVATE_OUTPUT"}' }, 'codex rejected the output schema (invalid_json_schema)'],
      ]) epcFailure(await codex.runModel({ ...opts, mode, spawnSyncImpl: () => response }), reason);
      const blockedPath = path.join(root, 'PRIVATE_PATH'); fs.writeFileSync(blockedPath, 'PRIVATE_OUTPUT');
      epcFailure(await codex.runModel({ ...opts, mode, systemConfigPaths: [blockedPath] }), 'codex system configuration is present');
    }
    fs.unlinkSync(path.join(root, '.codex/auth.json')); assert.equal(codex.checkAuthStatus(opts), 'logged-out');
  });
});

// ─── (1) Env scrub — completeness ───────────────────────────────────────────

describe('claude-code.js — claudeChildEnv() scrub completeness + preservation', () => {
  it('deletes every var in SCRUBBED_CLIENT_ENV_VARS from the child env', () => {
    const dirty = { ...process.env };
    for (const key of claudeCode.SCRUBBED_CLIENT_ENV_VARS) dirty[key] = 'leaked-value';
    const originalEnv = process.env;
    process.env = dirty;
    try {
      const childEnv = claudeCode.claudeChildEnv();
      for (const key of claudeCode.SCRUBBED_CLIENT_ENV_VARS) {
        assert.equal(childEnv[key], undefined, `${key} must be scrubbed from the child env`);
      }
    } finally {
      process.env = originalEnv;
    }
  });

  it('SCRUBBED_CLIENT_ENV_VARS carries the full confirmed list (28 names) and is frozen', () => {
    assert.ok(Object.isFrozen(claudeCode.SCRUBBED_CLIENT_ENV_VARS));
    assert.ok(claudeCode.SCRUBBED_CLIENT_ENV_VARS.includes('ANTHROPIC_API_KEY'));
    assert.ok(claudeCode.SCRUBBED_CLIENT_ENV_VARS.includes('ANTHROPIC_AUTH_TOKEN'));
    assert.ok(claudeCode.SCRUBBED_CLIENT_ENV_VARS.includes('AWS_BEARER_TOKEN_BEDROCK'));
    assert.ok(claudeCode.SCRUBBED_CLIENT_ENV_VARS.includes('GOOGLE_APPLICATION_CREDENTIALS'));
    assert.ok(claudeCode.SCRUBBED_CLIENT_ENV_VARS.includes('CLOUD_ML_REGION'));
    // Verbatim from the PUNCH-LIST EXTRACT-TOOLS-LOCK row's SME-confirmed list —
    // the row itself enumerates 28 names (the task brief said "26"; the actual
    // row text, expanded, is 28 — copied verbatim per the "do not retype from
    // memory" instruction, so this count pins the source-of-truth row, not the
    // brief's paraphrase).
    assert.equal(claudeCode.SCRUBBED_CLIENT_ENV_VARS.length, 28);
  });

  it('preserves non-scrubbed env vars and sets AUXILO_EXTRACTING=1', () => {
    const originalEnv = process.env;
    process.env = { ...originalEnv, SOME_UNRELATED_VAR: 'kept', AUXILO_EXTRACTING: undefined };
    try {
      const childEnv = claudeCode.claudeChildEnv();
      assert.equal(childEnv.SOME_UNRELATED_VAR, 'kept');
      assert.equal(childEnv.AUXILO_EXTRACTING, '1');
    } finally {
      process.env = originalEnv;
    }
  });
});

// ─── (2)+(3) Exact extraction and judge argv, including MCP isolation ─────

describe('claude-code.js — runModel argv per mode', () => {
  it("mode:'extract' spawns the literal tool-free, settings-free, strict-MCP argv", async () => {
    const stub = spawnQueue([authJson(true), { status: 0, stdout: JSON.stringify({ type: "result", result: '{"learnings":[]}', is_error: false }), stderr: '' }]);
    const result = await claudeCode.runModel({ ...supportedClaude, beforeModelInvocation: () => true,
      prompt: 'PROMPT', input: 'TRANSCRIPT', mode: 'extract',
      spawnSyncImpl: stub.spawnSyncImpl, claudeBin: 'claude',
    });
    assert.equal(result.ok, true);
    assert.deepEqual(stub.calls[1].args, ['-p', '--output-format', 'json', '--no-session-persistence', '--tools', '', '--setting-sources', '', '--strict-mcp-config']);
    assert.deepEqual(result.argv, ['-p', '--output-format', 'json', '--no-session-persistence', '--tools', '', '--setting-sources', '', '--strict-mcp-config']);
  });

  it("mode:'judge' spawns the literal JSON-output, tool-free, settings-free, strict-MCP argv", async () => {
    const stub = spawnQueue([{
      status: 0,
      stdout: JSON.stringify({ type: 'result', result: '{"decisions":[]}', is_error: false, usage: { input_tokens: 5, output_tokens: 2 } }),
      stderr: '',
    }]);
    const result = await claudeCode.runModel({ ...supportedClaude, beforeModelInvocation: () => true,
      prompt: 'JUDGE_PROMPT', mode: 'judge',
      spawnSyncImpl: stub.spawnSyncImpl, claudeBin: 'claude',
    });
    assert.equal(result.ok, true);
    assert.deepEqual(stub.calls[0].args, ['-p', '--output-format', 'json', '--no-session-persistence', '--tools', '', '--setting-sources', '', '--strict-mcp-config']);
    assert.deepEqual(result.usage, { input_tokens: 5, output_tokens: 2 });
  });
});

describe('CLAUDE-CHILD-MCP-CONTEXT — T1–T6', () => {
  it('T1: both frozen argv constants pin strict MCP isolation without an explicit config', () => {
    assert.deepEqual(claudeCode.EXTRACT_MODE_ARGV,
      ['-p', '--output-format', 'json', '--no-session-persistence', '--tools', '', '--setting-sources', '', '--strict-mcp-config']);
    assert.deepEqual(claudeCode.JUDGE_MODE_ARGV,
      ['-p', '--output-format', 'json', '--no-session-persistence', '--tools', '', '--setting-sources', '', '--strict-mcp-config']);
    assert.ok(Object.isFrozen(claudeCode.EXTRACT_MODE_ARGV));
    assert.ok(Object.isFrozen(claudeCode.JUDGE_MODE_ARGV));
  });

  it('T2: both actual model spawns end in --strict-mcp-config and pass no --mcp-config', async () => {
    for (const mode of ['extract', 'judge']) {
      const replies = mode === 'extract' ? [authJson(true)] : [];
      replies.push({ status: 0, stdout: JSON.stringify({ type: 'result', result: 'OK' }), stderr: '' });
      const stub = spawnQueue(replies);
      const result = await claudeCode.runModel({ ...supportedClaude, beforeModelInvocation: () => true, mode, prompt: 'fixture', claudeBin: 'claude', spawnSyncImpl: stub.spawnSyncImpl });
      assert.equal(result.ok, true);
      const modelCall = stub.calls.find(call => call.args[0] === '-p');
      assert.equal(modelCall.args.at(-1), '--strict-mcp-config');
      assert.ok(!modelCall.args.includes('--mcp-config'));
    }
  });

  it('T3: child env disables inherited account connectors and retains the literal billing scrub', () => {
    const scrubbed = [
      'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL',
      'ANTHROPIC_CUSTOM_HEADERS', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_PROFILE',
      'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
      'CLAUDE_CODE_USE_MANTLE', 'CLAUDE_CODE_SKIP_BEDROCK_AUTH', 'CLAUDE_CODE_SKIP_MANTLE_AUTH',
      'ANTHROPIC_BEDROCK_BASE_URL', 'ANTHROPIC_BEDROCK_MANTLE_BASE_URL',
      'ANTHROPIC_VERTEX_BASE_URL', 'ANTHROPIC_VERTEX_PROJECT_ID',
      'ANTHROPIC_FOUNDRY_RESOURCE', 'ANTHROPIC_FOUNDRY_API_KEY',
      'ANTHROPIC_FOUNDRY_AUTH_TOKEN', 'ANTHROPIC_FOUNDRY_BASE_URL',
      'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_PROFILE',
      'AWS_REGION', 'AWS_BEARER_TOKEN_BEDROCK', 'GOOGLE_APPLICATION_CREDENTIALS', 'CLOUD_ML_REGION',
    ];
    const originalEnv = process.env;
    process.env = { ...originalEnv, ENABLE_CLAUDEAI_MCP_SERVERS: 'true',
      ...Object.fromEntries(scrubbed.map(key => [key, 'fixture-secret'])) };
    try {
      const env = claudeCode.claudeChildEnv();
      assert.equal(env.ENABLE_CLAUDEAI_MCP_SERVERS, 'false');
      assert.equal(env.AUXILO_EXTRACTING, '1');
      for (const key of scrubbed) assert.equal(env[key], undefined, key);
      assert.equal(process.env.ENABLE_CLAUDEAI_MCP_SERVERS, 'true');
    } finally { process.env = originalEnv; }
  });

  it('T4: judge accepts one result plus SDK noise without returning the noise', async () => {
    const noise = 'Client.listTools() called but server does not advertise tools capability - returning empty list';
    const wrapper = { type: 'result', result: '{"decisions":[]}', is_error: false,
      usage: { input_tokens: 5, cache_creation_input_tokens: 7, cache_read_input_tokens: 3, output_tokens: 2 } };
    for (const stdout of [JSON.stringify(wrapper) + '\n' + noise + '\n', noise + '\n' + JSON.stringify(wrapper)]) {
      const stub = spawnQueue([{ status: 0, stdout, stderr: '' }]);
      const result = await claudeCode.runModel({ ...supportedClaude, beforeModelInvocation: () => true, mode: 'judge', claudeBin: 'claude', spawnSyncImpl: stub.spawnSyncImpl });
      assert.equal(result.ok, true);
      assert.equal(result.text, wrapper.result);
      assert.deepEqual(result.usage, { input_tokens: 15, output_tokens: 2 });
      assert.ok(!JSON.stringify(result).includes(noise));
    }
  });

  it('T5: judge noise recovery rejects extra JSON of any type and non-result wrappers', async () => {
    const resultLine = JSON.stringify({ type: 'result', result: 'OK' });
    const other = '{"type":"system","subtype":"init"}';
    const invalid = [resultLine + '\n' + resultLine, resultLine + '\n' + other, other + '\n' + resultLine,
      ...['42', 'null', 'true', '[]', '"text"'].map(line => resultLine + '\n' + line),
      'SDK noise\nmore noise', other + '\nSDK noise', 'null\nSDK noise'];
    for (const stdout of invalid) {
      const stub = spawnQueue([{ status: 0, stdout, stderr: '' }]);
      const result = await claudeCode.runModel({ ...supportedClaude, beforeModelInvocation: () => true, mode: 'judge', claudeBin: 'claude', spawnSyncImpl: stub.spawnSyncImpl });
      assert.equal(result.ok, false, stdout);
      assert.equal(result.reasonCode, 'model-error', stdout);
      assert.equal(result.reason, 'local judge returned malformed JSON wrapper', stdout);
    }
  });

  it('T6: enterprise MCP refusal is bounded, post-spawn, uncached, and requires a non-zero exit', async () => {
    const phrase = 'You cannot use --strict-mcp-config when an enterprise MCP config is present';
    for (const mode of ['extract', 'judge']) {
      for (const stream of ['stdout', 'stderr']) {
        const replies = [];
        for (let i = 0; i < 2; i += 1) {
          if (mode === 'extract') replies.push(authJson(true));
          replies.push({ status: 1, stdout: '', stderr: '', [stream]: phrase + ' PRIVATE-MARKER' });
        }
        const stub = spawnQueue(replies);
        for (let i = 0; i < 2; i += 1) {
          const result = await claudeCode.runModel({ ...supportedClaude, beforeModelInvocation: () => true, mode, claudeBin: 'claude', spawnSyncImpl: stub.spawnSyncImpl });
          assert.equal(result.ok, false);
          assert.equal(result.text, '');
          assert.equal(result.reasonCode, 'isolation-unverified');
          assert.ok(!JSON.stringify(result).includes(phrase));
          assert.ok(!JSON.stringify(result).includes('PRIVATE-MARKER'));
          const lines = [];
          require('../scripts/extract-local.js').logProviderRunSummary(
            { log: line => lines.push(line) }, 'mcp-refused',
            { ...result, extractionModel: { provider: 'claude-code' } }, null);
          assert.match(lines[0], /finder=ran/);
        }
        assert.equal(stub.calls.filter(call => call.args[0] === '-p').length, 2);
      }
      const replies = mode === 'extract' ? [authJson(true)] : [];
      replies.push({ status: 0, stdout: JSON.stringify({ type: 'result', result: phrase, is_error: false }), stderr: phrase });
      const stub = spawnQueue(replies);
      assert.equal((await claudeCode.runModel({ ...supportedClaude, beforeModelInvocation: () => true, mode, claudeBin: 'claude', spawnSyncImpl: stub.spawnSyncImpl })).ok, true);
    }
  });
});

// ─── (4) Both spawns share ONE claudeChildEnv() — no drift ────────────────

describe('claude-code.js — extraction and judge spawns share one env shape (no drift)', () => {
  it('the env object handed to both spawns has an identical scrub set (2 spawns verified)', async () => {
    const originalEnv = process.env;
    process.env = { ...originalEnv, ANTHROPIC_API_KEY: 'leak', AWS_PROFILE: 'leak' };
    try {
      const extractStub = spawnQueue([authJson(true), { status: 0, stdout: JSON.stringify({ type: "result", result: '{"learnings":[]}', is_error: false }), stderr: '' }]);
      await claudeCode.runModel({ ...supportedClaude, beforeModelInvocation: () => true,
        prompt: 'P', input: 'T', mode: 'extract',
        spawnSyncImpl: extractStub.spawnSyncImpl, claudeBin: 'claude',
      });
      const extractEnv = extractStub.calls[1].opts.env; // the '-p' spawn, not the auth-status probe

      const judgeStub = spawnQueue([{
        status: 0, stdout: JSON.stringify({ type: 'result', result: '{}', is_error: false }), stderr: '',
      }]);
      await claudeCode.runModel({ ...supportedClaude, beforeModelInvocation: () => true,
        prompt: 'P', mode: 'judge',
        spawnSyncImpl: judgeStub.spawnSyncImpl, claudeBin: 'claude',
      });
      const judgeEnv = judgeStub.calls[0].opts.env;

      assert.equal(extractEnv.ANTHROPIC_API_KEY, undefined);
      assert.equal(judgeEnv.ANTHROPIC_API_KEY, undefined);
      assert.equal(extractEnv.AWS_PROFILE, undefined);
      assert.equal(judgeEnv.AWS_PROFILE, undefined);
      assert.equal(extractEnv.AUXILO_EXTRACTING, '1');
      assert.equal(judgeEnv.AUXILO_EXTRACTING, '1');
    } finally {
      process.env = originalEnv;
    }
  });
});

// ─── EXTRACTION-CHILD-HOOKS (0.9.15): --setting-sources isolation ─────────
//
// SETTING_SOURCES_VALUE ships as '' (empty list) — verified LIVE this build
// (scratchpad hooks-0915) against the installed CLI: '--setting-sources ""'
// is accepted (exit 0, hook_response count 0, well-formed result), so no
// fresh-temp-cwd fallback is needed (an empty source list is cwd-independent
// — unlike 'project,local', which would still honor a target repo's own
// .claude/settings.json). Detection of a CLI that doesn't understand the
// flag at all happens from the SAME spawn that already carries it (a
// commander.js-style "unknown option" exit), never a separate probe call —
// so the happy-path spawn count is unchanged from before this row.
describe('claude-code.js — EXTRACTION-CHILD-HOOKS: --setting-sources isolation', () => {
  // cachedSettingSourcesUnsupported is module-level state (deliberately, so a
  // real process detects the CLI's flag support once and reuses it — see the
  // module's own doc). Reset it around every test in this block so one test
  // deliberately tripping it into 'unsupported' can never leak into the next.
  beforeEach(() => claudeCode._resetSettingSourcesCacheForTests());
  afterEach(() => claudeCode._resetSettingSourcesCacheForTests());

  it("every real spawn (extract AND judge) carries --setting-sources '' — the shipped narrowest value, verified accepted live", async () => {
    const extractStub = spawnQueue([authJson(true), { status: 0, stdout: JSON.stringify({ type: "result", result: '{"learnings":[]}', is_error: false }), stderr: '' }]);
    const extractResult = await claudeCode.runModel({ ...supportedClaude, beforeModelInvocation: () => true,
      prompt: 'P', input: 'T', mode: 'extract', spawnSyncImpl: extractStub.spawnSyncImpl, claudeBin: 'claude',
    });
    assert.ok(extractResult.argv.includes('--setting-sources'));
    assert.equal(extractResult.argv[extractResult.argv.indexOf('--setting-sources') + 1], '');

    const judgeStub = spawnQueue([{
      status: 0,
      stdout: JSON.stringify({ type: 'result', result: '{"decisions":[]}', is_error: false, usage: {} }),
      stderr: '',
    }]);
    const judgeResult = await claudeCode.runModel({ ...supportedClaude, beforeModelInvocation: () => true,
      prompt: 'P', mode: 'judge', spawnSyncImpl: judgeStub.spawnSyncImpl, claudeBin: 'claude',
    });
    assert.ok(judgeResult.argv.includes('--setting-sources'));
    assert.equal(judgeResult.argv[judgeResult.argv.indexOf('--setting-sources') + 1], '');
  });

  it("looksLikeUnsupportedSettingSourcesFlag: true only for a non-zero exit naming both --setting-sources AND an 'unknown option'-shaped message", () => {
    assert.equal(claudeCode.looksLikeUnsupportedSettingSourcesFlag(
      { status: 1, stdout: '', stderr: "error: unknown option '--setting-sources'" }
    ), true);
    assert.equal(claudeCode.looksLikeUnsupportedSettingSourcesFlag(
      { status: 0, stdout: '', stderr: '' }
    ), false, 'exit 0 is never unsupported, regardless of stdout content');
    assert.equal(claudeCode.looksLikeUnsupportedSettingSourcesFlag(
      { status: 1, stdout: '', stderr: 'API Error: 400 bad transcript' }
    ), false, 'a real model error must not be misread as flag-unsupported');
    assert.equal(claudeCode.looksLikeUnsupportedSettingSourcesFlag(null), false);
  });

  it('extraction: an unrecognized-flag response sets reasonCode cli-settings-isolation-unsupported and caches it — a SECOND call in the same process short-circuits before spawning again', async () => {
    let spawnCalls = 0;
    const responses = [authJson(true), { status: 1, stdout: '', stderr: "error: unknown option '--setting-sources'" }];
    const spawnSyncImpl = () => { spawnCalls += 1; return responses.shift(); };
    const first = await claudeCode.runModel({ ...supportedClaude, beforeModelInvocation: () => true, prompt: 'P', input: 'T', mode: 'extract', spawnSyncImpl, claudeBin: 'claude' });
    assert.equal(first.ok, false);
    assert.equal(first.reasonCode, 'cli-settings-isolation-unsupported');
    assert.equal(spawnCalls, 2, 'the auth check + the one real spawn that revealed unsupported — no separate probe call');

    const second = await claudeCode.runModel({ ...supportedClaude, beforeModelInvocation: () => true, prompt: 'P', input: 'T', mode: 'extract', spawnSyncImpl, claudeBin: 'claude' });
    assert.equal(second.ok, false);
    assert.equal(second.reasonCode, 'cli-settings-isolation-unsupported');
    assert.equal(spawnCalls, 2, 'cached: a second call must not spawn again (it must never run without the flag, and re-attempting a doomed spawn is silent waste)');
  });

  it('judge mode: same unsupported-flag detection and cache short-circuit', async () => {
    let spawnCalls = 0;
    const responses = [{ status: 1, stdout: '', stderr: "error: unknown option '--setting-sources'" }];
    const spawnSyncImpl = () => { spawnCalls += 1; return responses.shift(); };
    const first = await claudeCode.runModel({ ...supportedClaude, beforeModelInvocation: () => true, prompt: 'P', mode: 'judge', spawnSyncImpl, claudeBin: 'claude' });
    assert.equal(first.ok, false);
    assert.equal(first.reasonCode, 'cli-settings-isolation-unsupported');
    assert.equal(spawnCalls, 1);

    const second = await claudeCode.runModel({ ...supportedClaude, beforeModelInvocation: () => true, prompt: 'P', mode: 'judge', spawnSyncImpl, claudeBin: 'claude' });
    assert.equal(second.reasonCode, 'cli-settings-isolation-unsupported');
    assert.equal(spawnCalls, 1, 'cached across modes — extract detecting it also gates judge, and vice versa');
  });

  it('providers/index.js runModel(): cli-settings-isolation-unsupported is in NON_RETRYABLE_FOR_THIS_PROVIDER and falls through to the next provider rather than hard-failing', async () => {
    assert.ok(providers.NON_RETRYABLE_FOR_THIS_PROVIDER.has('cli-settings-isolation-unsupported'));
    const responses = [authJson(true), { status: 1, stdout: '', stderr: "error: unknown option '--setting-sources'" }];
    // Beyond claude-code's 2 calls, give byo-key's own probe a
    // clean, deterministic "not found" rather than letting the shared stub
    // run dry (which would surface a DIFFERENT provider's spawn-plumbing
    // failure as the walk's final reasonCode and make this assertion about
    // byo-key's own behavior instead of claude-code's fall-through).
    const spawnSyncImpl = () => responses.shift() || { status: 1, stdout: '', stderr: '', error: Object.assign(new Error('not found'), { code: 'ENOENT' }) };
    const home = tempDir('auxilo-isolation-fallthrough-home-');
    const logLines = [];
    try {
      const result = await providers.runModel({ ...supportedClaude,
        prompt: 'P', input: 'T', mode: 'extract', spawnSyncImpl, claudeBin: 'claude',
        homeDir: home, cwd: home, existsSync: () => false,
        providersStatePath: path.join(home, '.auxilo', 'providers.json'),
        routeBindingsDir: path.join(home, 'bindings'),
        log: (line) => logLines.push(line),
        // Pre-resolve to claude-code — bypasses resolveProvider()'s own
        // detect() scan (which would otherwise consume this test's crafted
        // auth-status/spawn response queue before runModel() gets to it) so
        // only runModel()'s own two claude-code calls (auth check, then the
        // real spawn that reveals the unsupported flag) draw from `responses`.
        providerCache: { resolved: { ok: true, id: 'claude-code', module: claudeCode } },
      });
      assert.equal(result.ok, false);
      assert.equal(result.reasonCode, 'cli-settings-isolation-unsupported');
      assert.equal(result.hold, 'pinned-route-unusable');
      assert.equal(logLines.some((line) => line.includes('trying next provider')), false);
    } finally {
      cleanupTempDirs();
    }
  });

  it('getClaudeCliVersion: reads the installed package.json version via realpath, filesystem-only (no spawn)', () => {
    const home = tempDir('auxilo-cliversion-fixture-');
    try {
      const installDir = path.join(home, 'node_modules', '@anthropic-ai', 'claude-code');
      fs.mkdirSync(installDir, { recursive: true });
      fs.writeFileSync(path.join(installDir, 'package.json'), JSON.stringify({ version: '9.9.9-fixture' }));
      fs.writeFileSync(path.join(installDir, 'cli.js'), '// fixture');
      const binLink = path.join(home, 'claude');
      fs.symlinkSync(path.join(installDir, 'cli.js'), binLink);
      let spawnCalls = 0;
      const version = claudeCode.getClaudeCliVersion(binLink, { spawnSyncImpl: () => { spawnCalls += 1; return { status: 0, stdout: '', stderr: '' }; } });
      assert.equal(version, '9.9.9-fixture');
      assert.equal(spawnCalls, 0, 'version resolution must never spawn — filesystem read only');
    } finally {
      cleanupTempDirs();
    }
  });

  it('getClaudeCliVersion: an unresolvable bin or a missing/malformed package.json yields null, never throws', () => {
    assert.doesNotThrow(() => {
      assert.equal(claudeCode.getClaudeCliVersion('claude', {}), null);
    });
    const home = tempDir('auxilo-cliversion-missing-pkg-');
    try {
      const bogusBin = path.join(home, 'claude');
      fs.writeFileSync(bogusBin, '// no sibling package.json');
      assert.equal(claudeCode.getClaudeCliVersion(bogusBin, {}), null);
    } finally {
      cleanupTempDirs();
    }
  });
});

// ─── (5)-(7) Billing-helper detector ───────────────────────────────────────

describe('claude-code.js — detectBillingHelperConfigured', () => {
  it('positive: apiKeyHelper (and the other three keys) in ~/.claude/settings.json trips true', () => {
    const home = tempDir('auxilo-billing-home-');
    try {
      fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
      fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ apiKeyHelper: '/bin/get-key' }));
      assert.equal(claudeCode.detectBillingHelperConfigured({ homeDir: home, cwd: home }), true);

      for (const key of ['awsAuthRefresh', 'awsCredentialExport', 'gcpAuthRefresh']) {
        fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ [key]: true }));
        assert.equal(claudeCode.detectBillingHelperConfigured({ homeDir: home, cwd: home }), true, key);
      }
    } finally {
      cleanupTempDirs();
    }
  });

  it('negative: no billing-helper keys present anywhere → false', () => {
    const home = tempDir('auxilo-billing-home-');
    try {
      fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
      fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ someOtherKey: true }));
      assert.equal(claudeCode.detectBillingHelperConfigured({ homeDir: home, cwd: home }), false);
    } finally {
      cleanupTempDirs();
    }
  });

  it('malformed JSON, and a fully missing settings.json, never throw and read as false', () => {
    const home = tempDir('auxilo-billing-home-');
    try {
      fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
      fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{ not valid json');
      assert.doesNotThrow(() => claudeCode.detectBillingHelperConfigured({ homeDir: home, cwd: home }));
      assert.equal(claudeCode.detectBillingHelperConfigured({ homeDir: home, cwd: home }), false);

      const emptyHome = tempDir('auxilo-billing-home-empty-');
      assert.equal(claudeCode.detectBillingHelperConfigured({ homeDir: emptyHome, cwd: emptyHome }), false);
    } finally {
      cleanupTempDirs();
    }
  });

  it('checks the nearest project .claude/settings.json AND settings.local.json upward from cwd', () => {
    const home = tempDir('auxilo-billing-home-clean-');
    const project = tempDir('auxilo-billing-project-');
    const nested = path.join(project, 'a', 'b');
    fs.mkdirSync(nested, { recursive: true });
    try {
      fs.mkdirSync(path.join(project, '.claude'), { recursive: true });
      fs.writeFileSync(path.join(project, '.claude', 'settings.local.json'), JSON.stringify({ gcpAuthRefresh: '/bin/gcp' }));
      assert.equal(claudeCode.detectBillingHelperConfigured({ homeDir: home, cwd: nested }), true);
    } finally {
      cleanupTempDirs();
    }
  });
});

describe('claude-code.js — runModel short-circuits on a billing-helper hit', () => {
  it('extraction never spawns when the detector trips (no spawn calls at all)', async () => {
    const home = tempDir('auxilo-billing-home-hit-');
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ apiKeyHelper: '/bin/x' }));
    try {
      let spawnCalls = 0;
      const spawnSyncImpl = () => { spawnCalls += 1; throw new Error('must not spawn'); };
      const result = await claudeCode.runModel({ ...supportedClaude, beforeModelInvocation: () => true,
        prompt: 'P', input: 'T', mode: 'extract', homeDir: home, cwd: home, spawnSyncImpl,
      });
      assert.equal(result.ok, false);
      assert.equal(result.reasonCode, 'cli-billing-helper-configured');
      assert.equal(spawnCalls, 0);
    } finally {
      cleanupTempDirs();
    }
  });

  it('judge mode also never spawns on a hit', async () => {
    const home = tempDir('auxilo-billing-home-hit-judge-');
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ awsCredentialExport: true }));
    try {
      let spawnCalls = 0;
      const spawnSyncImpl = () => { spawnCalls += 1; throw new Error('must not spawn'); };
      const result = await claudeCode.runModel({ ...supportedClaude, beforeModelInvocation: () => true, prompt: 'P', mode: 'judge', homeDir: home, cwd: home, spawnSyncImpl });
      assert.equal(result.ok, false);
      assert.equal(result.reasonCode, 'cli-billing-helper-configured');
      assert.equal(spawnCalls, 0);
    } finally {
      cleanupTempDirs();
    }
  });
});

// ─── detect() ────────────────────────────────────────────────────────────

describe('claude-code.js — detect()', () => {
  // EXTRACT-PER-CLIENT W1 P1 fix (PUNCH-LIST): detect() used to short-circuit
  // to `true` the instant a filesystem candidate resolved, with NO auth
  // check at all — a stale, logged-out install still "detected". The auth
  // check now ALWAYS runs, regardless of how the binary was found.
  it('a resolvable filesystem candidate alone is NOT enough — the auth check always runs now', () => {
    let spawnCalls = 0;
    const result = claudeCode.detect({ ...supportedClaude,
      homeDir: '/fixture/home',
      cwd: '/fixture/home',
      existsSync: (candidate) => candidate === '/opt/homebrew/bin/claude',
      spawnSyncImpl: () => { spawnCalls += 1; return authJson(true); },
    });
    assert.equal(result, true);
    assert.equal(spawnCalls, 1, 'the auth check must run even when a filesystem candidate resolves');
  });

  // EXTRACT-PER-CLIENT W1 P1 fix: the OLD formula (`status !== 'unknown'`)
  // was backwards — it read 'logged-out' as usable and only 'unknown' as
  // not. The correct "usable now" formula is 'logged-in' OR 'unknown' (an
  // undetermined status cannot PROVE the builder is logged out — the real
  // run is the classifier of record); only a DEFINITE 'logged-out' means not
  // usable.
  it('logged-in -> true; unknown -> true (cannot prove logged-out); logged-out -> false', () => {
    const loggedIn = spawnQueue([authJson(true)]);
    assert.equal(claudeCode.detect({ ...supportedClaude,
      homeDir: '/fixture/home', cwd: '/fixture/home', existsSync: () => false, spawnSyncImpl: loggedIn.spawnSyncImpl,
    }), true);

    const unknown = spawnQueue([{ status: 1, stdout: '', stderr: 'boom' }]);
    assert.equal(claudeCode.detect({ ...supportedClaude,
      homeDir: '/fixture/home', cwd: '/fixture/home', existsSync: () => false, spawnSyncImpl: unknown.spawnSyncImpl,
    }), true, "'unknown' auth status must read as usable — the flip half of the W1 P1 fix");

    const loggedOut = spawnQueue([authJson(false)]);
    assert.equal(claudeCode.detect({ ...supportedClaude,
      homeDir: '/fixture/home', cwd: '/fixture/home', existsSync: () => false, spawnSyncImpl: loggedOut.spawnSyncImpl,
    }), false, "a definite 'logged-out' status is the one detect() can act on with confidence");
  });

  // EXTRACT-PER-CLIENT W1 P1 fix: a billing-helper hit is a skip, not a
  // usable provider — detect() must say so BEFORE the equally-usable-looking
  // binary+auth checks below it ever get a chance to say otherwise.
  it('a foreign-billing CLI helper configured makes detect() false even with a resolvable, logged-in binary', () => {
    const home = tempDir('auxilo-detect-billing-home-');
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ apiKeyHelper: '/bin/get-key' }));
    try {
      let spawnCalls = 0;
      const result = claudeCode.detect({ ...supportedClaude,
        homeDir: home,
        cwd: home,
        existsSync: (c) => c === '/opt/homebrew/bin/claude',
        spawnSyncImpl: () => { spawnCalls += 1; return authJson(true); },
      });
      assert.equal(result, false);
      assert.equal(spawnCalls, 0, 'the billing-helper check must short-circuit before any auth spawn');
    } finally {
      cleanupTempDirs();
    }
  });
});

// ─── (10) provider.interface.js smoke test lives in its own file per the spec
// (test/provider-interface.test.js) — not duplicated here.

// ─── (11) index.js selection order ─────────────────────────────────────────

describe('providers/index.js — resolveProvider selection', () => {
  it('AUXILO_EXTRACTION_PROVIDER override wins unconditionally, without calling detect()', async () => {
    let detectCalls = 0;
    const cache = {};
    const resolved = await providers.resolveProvider({ ...supportedClaude,
      env: { AUXILO_EXTRACTION_PROVIDER: 'claude-code' },
      providerCache: cache,
      // detect() would throw if called — proves the override short-circuits it.
      existsSync: () => { detectCalls += 1; throw new Error('detect must not run'); },
    });
    assert.equal(resolved.ok, true);
    assert.equal(resolved.id, 'claude-code');
    assert.equal(detectCalls, 0);
  });

  it('an unknown override name fails cleanly (not a throw), naming the bad value', async () => {
    const resolved = await providers.resolveProvider({ ...supportedClaude,
      env: { AUXILO_EXTRACTION_PROVIDER: 'not-a-real-provider' },
      providerCache: {},
    });
    assert.equal(resolved.ok, false);
    assert.match(resolved.reason, /not-a-real-provider/);
  });

  it('absent override picks the first detect()-true provider in automatic order (claude-code first)', async () => {
    const resolved = await providers.resolveProvider({ ...supportedClaude,
      env: {},
      providerCache: {},
      homeDir: '/fixture/home',
      cwd: '/fixture/home', // billing-helper check walk starts here — nonexistent, safely reads as "no helper"
      providersStatePath: '/fixture/home/.auxilo/providers-fixed-order-test.json', // never touch the real ~/.auxilo/providers.json
      existsSync: (c) => c === '/opt/homebrew/bin/claude', // claude-code detects true
      // detect() now ALWAYS runs the auth check (W1 P1 fix) — inject it rather
      // than letting the default fall through to a REAL `claude auth status`.
      spawnSyncImpl: () => authJson(true),
    });
    assert.equal(resolved.ok, true);
    assert.equal(resolved.id, 'claude-code');
  });

  it('all automatic providers false → ok:false naming every automatic provider tried, in order', async () => {
    const resolved = await providers.resolveProvider({ ...supportedClaude,
      env: {},
      providerCache: {},
      homeDir: '/fixture/home',
      cwd: '/fixture/home',
      providersStatePath: '/fixture/home/.auxilo/providers-all-false-test.json',
      existsSync: () => false,
      // A DEFINITE 'logged-out' response — under the W1 P1 fix, an ambiguous
      // 'unknown' response (the old `{status:1}` fixture here) would now read
      // as USABLE, breaking this test's "all false" premise.
      spawnSyncImpl: () => authJson(false),
    });
    assert.equal(resolved.ok, false);
    assert.match(resolved.reason, /claude-code, byo-key/);
    assert.doesNotMatch(resolved.reason, /codex-cli/);
  });

  // byo-key's stub window closed in PART C (scripts/providers/byo-key.js now
  // exists — see test/byo-key-provider.test.js for its real behavior
  // coverage). This case now proves the opposite of the old stub assertion:
  // selection resolves to the REAL module, and with no providers.json config
  // on disk it degrades cleanly to provider-not-configured (not a throw, and
  // not the pre-PART-C stub's provider-not-installed).
  it('byo-key resolves to its real module (no longer a stub) and degrades cleanly to provider-not-configured when unconfigured', async () => {
    const statePath = await providers.PROVIDERS_STATE_PATH; // sanity: module loaded without throwing
    assert.equal(typeof statePath, 'string');
    const resolved = await providers.resolveProvider({ ...supportedClaude,
      env: { AUXILO_EXTRACTION_PROVIDER: 'byo-key' },
      providerCache: {},
    });
    assert.equal(resolved.ok, true); // selection succeeds (override wins)
    const runResult = await resolved.module.runModel({
      providersStatePath: '/fixture/home-with-no-providers-json/.auxilo/providers.json',
    });
    assert.equal(runResult.ok, false);
    assert.equal(runResult.reasonCode, 'provider-not-configured');
    assert.match(runResult.reason, /BYO provider key configured/);
  });

  // codex-cli's stub window closed in PART B (scripts/providers/codex-cli.js
  // now exists — see test/codex-cli-provider.test.js for its real behavior
  // coverage). This case now proves the opposite of the above: selection
  // resolves to the REAL module (not a stub), and that module never throws
  // and never silently spawns anything real under injected opts that give it
  // no way to authenticate.
  it('codex-cli resolves to its real module (no longer a stub) and degrades cleanly, without spawning, when unauthenticated', async () => {
    const resolved = await providers.resolveProvider({ ...supportedClaude,
      env: { AUXILO_EXTRACTION_PROVIDER: 'codex-cli' },
      providerCache: {},
    });
    assert.equal(resolved.ok, true);
    let spawnCalls = 0;
    const runResult = await resolved.module.runModel({
      homeDir: '/fixture/home-with-no-codex-auth-json',
      spawnSyncImpl: () => { spawnCalls += 1; throw new Error('must not spawn — no auth.json in this fixture home'); },
    });
    assert.equal(runResult.ok, false);
    assert.equal(runResult.reasonCode, 'cli-unauthenticated');
    assert.equal(spawnCalls, 0);
  });
});

// ─── (12) caching ───────────────────────────────────────────────────────────

describe('providers/index.js — resolveProvider caches the resolved auto-detect choice', () => {
  it('detect() runs once across two resolveProvider calls sharing a providerCache', async () => {
    let detectCalls = 0;
    const cache = {};
    const opts = {
      env: {},
      providerCache: cache,
      homeDir: '/fixture/home',
      cwd: '/fixture/home',
      providersStatePath: '/fixture/home/.auxilo/providers-cache-test-1.json',
      existsSync: (c) => {
        detectCalls += 1;
        return c === '/opt/homebrew/bin/claude';
      },
      // detect() now always runs the auth check (W1 P1 fix) — inject it.
      spawnSyncImpl: () => authJson(true),
    };
    const first = await providers.resolveProvider(opts);
    const second = await providers.resolveProvider(opts);
    assert.equal(first.id, 'claude-code');
    assert.equal(second.id, 'claude-code');
    // resolveClaudeBin probes every candidate per detect() call; a cached second
    // call must add ZERO further existsSync probes.
    const callsAfterFirst = detectCalls;
    assert.ok(callsAfterFirst > 0);
    await providers.resolveProvider(opts);
    assert.equal(detectCalls, callsAfterFirst, 'second+third resolveProvider call must not re-probe detect()');
  });

  it('a fresh providerCache (or none — the module default) re-detects independently', async () => {
    let detectCallsA = 0;
    const resolvedA = await providers.resolveProvider({ ...supportedClaude,
      env: {},
      providerCache: {},
      homeDir: '/fixture/home',
      cwd: '/fixture/home',
      providersStatePath: '/fixture/home/.auxilo/providers-cache-test-a.json',
      existsSync: () => { detectCallsA += 1; return true; },
      spawnSyncImpl: () => authJson(true),
    });
    let detectCallsB = 0;
    const resolvedB = await providers.resolveProvider({ ...supportedClaude,
      env: {},
      providerCache: {},
      homeDir: '/fixture/home',
      cwd: '/fixture/home',
      providersStatePath: '/fixture/home/.auxilo/providers-cache-test-b.json',
      existsSync: () => { detectCallsB += 1; return true; },
      spawnSyncImpl: () => authJson(true),
    });
    assert.equal(resolvedA.id, 'claude-code');
    assert.equal(resolvedB.id, 'claude-code');
    assert.ok(detectCallsA > 0);
    assert.ok(detectCallsB > 0, 'a fresh cache object must re-run detect() independently of a prior unrelated cache');
  });
});

// ─── (13) e2e proof — never throws, never silently yields zero learnings ──

describe('extract-local.js — e2e: unavailable forced provider degrades to a named skip, never throws', () => {
  it('claude binary unresolvable + AUXILO_EXTRACTION_PROVIDER=claude-code forced → extractLocally skips with a reason', async () => {
    const extractLocal = require('../scripts/extract-local.js');
    const originalEnv = process.env.AUXILO_EXTRACTION_PROVIDER;
    process.env.AUXILO_EXTRACTION_PROVIDER = 'claude-code';
    try {
      const dir = tempDir('auxilo-e2e-noclaude-');
      const indexPath = path.join(dir, 'extracted-index.jsonl');
      fs.writeFileSync(indexPath, '');
      // Mocked spawn simulating "claude binary renamed away": every spawn attempt
      // fails with ENOENT, exactly what a missing binary produces on a real
      // machine — no real process, no real completion (AGENTS.md no-real-
      // completion rule).
      const spawnSyncImpl = () => {
        const err = new Error('spawn claude ENOENT');
        err.code = 'ENOENT';
        return { error: err, stdout: '', stderr: '', status: null };
      };
      let thrown = null;
      let result;
      try {
        result = await extractLocal.extractLocally('synthetic transcript', 'claude-code', { ...supportedClaude,
          indexPath, log: () => {}, spawnSyncImpl, claudeBin: 'claude',
          routeBindingsDir: path.join(dir, 'bindings'),
        });
      } catch (err) {
        thrown = err;
      }
      assert.equal(thrown, null, 'extractLocally must never throw on an unavailable forced provider');
      assert.deepEqual(result.learnings, []);
      assert.equal(typeof result.skipped, 'string');
      assert.ok(result.skipped.length > 0, 'the skip reason must be present, not silent');
    } finally {
      cleanupTempDirs();
      if (originalEnv === undefined) delete process.env.AUXILO_EXTRACTION_PROVIDER;
      else process.env.AUXILO_EXTRACTION_PROVIDER = originalEnv;
    }
  });
});

// ─── bin/auxilo-cli.js cmdStatus — provider line (item 10, "resolved to X and
// why" half; the reasonCode-gated half is NOT implemented — see PART A report:
// it needs a last_reason_code field on runner.js's extraction skip-state
// schema, and scripts/runner.js is outside this part's touched-file scope) ──

describe('bin/auxilo-cli.js — extractionProviderLine', () => {
  it('renders the resolved provider id and "last recorded selection" when no env override is set (EXTRACTION-MODEL-PROVENANCE, PUNCH-LIST P1: no live detect() behind this line any more)', () => {
    const cli = require('../bin/auxilo-cli.js');
    const originalEnv = process.env.AUXILO_EXTRACTION_PROVIDER;
    delete process.env.AUXILO_EXTRACTION_PROVIDER;
    try {
      const line = cli.extractionProviderLine({ ok: true, id: 'claude-code' });
      assert.match(line, /claude-code/);
      assert.match(line, /last recorded selection/);
    } finally {
      if (originalEnv !== undefined) process.env.AUXILO_EXTRACTION_PROVIDER = originalEnv;
    }
  });

  it('renders "env override" when AUXILO_EXTRACTION_PROVIDER is set', () => {
    const cli = require('../bin/auxilo-cli.js');
    const originalEnv = process.env.AUXILO_EXTRACTION_PROVIDER;
    process.env.AUXILO_EXTRACTION_PROVIDER = 'claude-code';
    try {
      const line = cli.extractionProviderLine({ ok: true, id: 'claude-code' });
      assert.match(line, /env override/);
    } finally {
      if (originalEnv === undefined) delete process.env.AUXILO_EXTRACTION_PROVIDER;
      else process.env.AUXILO_EXTRACTION_PROVIDER = originalEnv;
    }
  });

  it('renders "none" with the reason when resolution failed', () => {
    const cli = require('../bin/auxilo-cli.js');
    const line = cli.extractionProviderLine({ ok: false, reason: 'no extraction model provider available — tried: claude-code, byo-key' });
    assert.match(line, /none/);
    assert.match(line, /tried: claude-code, byo-key/);
  });
});

// ─── EXTRACTION-MODEL-PROVENANCE (PUNCH-LIST P1): `auxilo status` no longer
// calls providers.resolveProvider({ ...supportedClaude,}) live — a fresh detect() answering
// "what would run now", not "what ran". lastRecordedProviderResolution()
// replaces that with two read-only sources: the current env override
// (a certain fact, not a probe) or providers.json's persisted `selected`
// field (a plain file read, no detect() invoked, no write possible). ───────

describe('bin/auxilo-cli.js — lastRecordedProviderResolution (no live detect() behind `auxilo status`)', () => {
  // PROVIDERS_STATE_PATH is a plain property on providers/index.js's
  // exports object (computed once at require time from AUXILO_HOME/
  // os.homedir()) — monkeypatching it for the duration of one test (and
  // restoring it in `finally`) redirects lastRecordedProviderResolution()'s
  // file read without touching the real home directory or any other test's
  // state, since Node caches the module by resolved path and every
  // consumer (including this function, via `providers.PROVIDERS_STATE_PATH`)
  // reads the same live object property.
  function withStatePath(statePath, fn) {
    const providers = require('../scripts/providers/index.js');
    const original = providers.PROVIDERS_STATE_PATH;
    providers.PROVIDERS_STATE_PATH = statePath;
    try {
      return fn();
    } finally {
      providers.PROVIDERS_STATE_PATH = original;
    }
  }

  it('AUXILO_EXTRACTION_PROVIDER, when set to a known provider, wins unconditionally over any persisted selection', () => {
    const cli = require('../bin/auxilo-cli.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auxilo-lastrecorded-override-'));
    const statePath = path.join(dir, 'providers.json');
    fs.writeFileSync(statePath, JSON.stringify({ selected: 'byo-key' }));
    const originalEnv = process.env.AUXILO_EXTRACTION_PROVIDER;
    try {
      process.env.AUXILO_EXTRACTION_PROVIDER = 'claude-code';
      const resolution = withStatePath(statePath, () => cli.lastRecordedProviderResolution());
      assert.equal(resolution.ok, true);
      assert.equal(resolution.id, 'claude-code', 'the override must win even though providers.json records a different persisted selection');
    } finally {
      if (originalEnv === undefined) delete process.env.AUXILO_EXTRACTION_PROVIDER;
      else process.env.AUXILO_EXTRACTION_PROVIDER = originalEnv;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an unknown AUXILO_EXTRACTION_PROVIDER value fails closed with a named reason, validated against KNOWN_PROVIDER_IDS without calling resolveProvider() (no detect(), no spawn)', () => {
    const cli = require('../bin/auxilo-cli.js');
    const originalEnv = process.env.AUXILO_EXTRACTION_PROVIDER;
    try {
      process.env.AUXILO_EXTRACTION_PROVIDER = 'not-a-real-provider';
      const resolution = cli.lastRecordedProviderResolution();
      assert.equal(resolution.ok, false);
      assert.match(resolution.reason, /not-a-real-provider.*is not a known provider/);
    } finally {
      if (originalEnv === undefined) delete process.env.AUXILO_EXTRACTION_PROVIDER;
      else process.env.AUXILO_EXTRACTION_PROVIDER = originalEnv;
    }
  });

  it('no override + a persisted `selected` field: reads it straight from disk, no detect() call, no write', () => {
    const cli = require('../bin/auxilo-cli.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auxilo-lastrecorded-persisted-'));
    const statePath = path.join(dir, 'providers.json');
    fs.writeFileSync(statePath, JSON.stringify({ selected: 'codex-cli' }));
    const before = fs.readFileSync(statePath, 'utf8');
    const originalEnv = process.env.AUXILO_EXTRACTION_PROVIDER;
    try {
      delete process.env.AUXILO_EXTRACTION_PROVIDER;
      const resolution = withStatePath(statePath, () => cli.lastRecordedProviderResolution());
      assert.equal(resolution.ok, true);
      assert.equal(resolution.id, 'codex-cli');
      assert.equal(fs.readFileSync(statePath, 'utf8'), before, 'a plain read must never rewrite the file');
    } finally {
      if (originalEnv === undefined) delete process.env.AUXILO_EXTRACTION_PROVIDER;
      else process.env.AUXILO_EXTRACTION_PROVIDER = originalEnv;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('no override + no providers.json at all: ok:false with "no recorded provider selection yet" — never a guess, never a crash', () => {
    const cli = require('../bin/auxilo-cli.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auxilo-lastrecorded-empty-'));
    const statePath = path.join(dir, 'providers.json'); // deliberately never written
    const originalEnv = process.env.AUXILO_EXTRACTION_PROVIDER;
    try {
      delete process.env.AUXILO_EXTRACTION_PROVIDER;
      const resolution = withStatePath(statePath, () => cli.lastRecordedProviderResolution());
      assert.deepEqual(resolution, { ok: false, reason: 'no recorded provider selection yet' });
    } finally {
      if (originalEnv === undefined) delete process.env.AUXILO_EXTRACTION_PROVIDER;
      else process.env.AUXILO_EXTRACTION_PROVIDER = originalEnv;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── EXTRACTION-RUN-LOG (0.9.15): one-line-per-run provider summary ───────

describe('extract-local.js — logProviderRunSummary / formatArgvForLog', () => {
  it("formatArgvForLog: empty strings render as '', missing/empty argv renders 'n/a'", () => {
    const extractLocal = require('../scripts/extract-local.js');
    assert.equal(extractLocal.formatArgvForLog(['-p', '--tools', '', '--setting-sources', '']), "-p --tools '' --setting-sources ''");
    assert.equal(extractLocal.formatArgvForLog([]), 'n/a');
    assert.equal(extractLocal.formatArgvForLog(undefined), 'n/a');
    assert.equal(extractLocal.formatArgvForLog(null), 'n/a');
  });

  it('claude-code, finder ran + judge ran: hooks=isolated, both argvs surfaced, cli version present', () => {
    const extractLocal = require('../scripts/extract-local.js');
    const lines = [];
    extractLocal.logProviderRunSummary(
      { log: (l) => lines.push(l) },
      'sess-1',
      {
        ok: true,
        extractionModel: { provider: 'claude-code', model: null, version: null, vendor: null },
        argv: ['-p', '--output-format', 'json', '--no-session-persistence', '--tools', '', '--setting-sources', ''],
        cliVersion: '2.1.12',
      },
      { judgeAttempted: true, judgeSucceeded: true, judgeReasonCode: null, judgeArgv: ['-p', '--output-format', 'json'], judgeCliVersion: '2.1.12' }
    );
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^\[providers\] run=sess-1 provider=claude-code cli=2\.1\.12 finder=ran judge=ran flags=.*setting-sources.* hooks=isolated$/);
  });

  it('finder skipped (cli-unauthenticated) with no extractionModel identity: provider/hooks both render as unknown/n-a rather than guessing', () => {
    const extractLocal = require('../scripts/extract-local.js');
    const lines = [];
    extractLocal.logProviderRunSummary(
      { log: (l) => lines.push(l) },
      'sess-2',
      { ok: false, reasonCode: 'cli-unauthenticated', extractionModel: null },
      null
    );
    assert.equal(lines.length, 1);
    assert.match(lines[0], /run=sess-2 provider=unknown cli=- finder=skipped judge=skipped\(no-candidates\) flags=n\/a hooks=n\/a$/);
  });

  it('claude-code, isolation unsupported: hooks=unsupported and finder=skipped', () => {
    const extractLocal = require('../scripts/extract-local.js');
    const lines = [];
    extractLocal.logProviderRunSummary(
      { log: (l) => lines.push(l) },
      'sess-3',
      {
        ok: false,
        reasonCode: 'cli-settings-isolation-unsupported',
        extractionModel: { provider: 'claude-code', model: null, version: null, vendor: null },
      },
      null
    );
    assert.equal(lines.length, 1);
    assert.match(lines[0], /provider=claude-code .*finder=skipped judge=skipped\(no-candidates\) .*hooks=unsupported$/);
  });

  it('judge failed after a real attempt (malformed/erroring, not "no candidates"): judge=failed', () => {
    const extractLocal = require('../scripts/extract-local.js');
    const lines = [];
    extractLocal.logProviderRunSummary(
      { log: (l) => lines.push(l) },
      'sess-4',
      { ok: true, extractionModel: { provider: 'claude-code' }, argv: ['-p'], cliVersion: '2.1.12' },
      { judgeAttempted: true, judgeSucceeded: false, judgeReasonCode: 'model-error' }
    );
    assert.match(lines[0], /judge=failed/);
  });

  it('a non-claude-code provider reports hooks=n/a', () => {
    const extractLocal = require('../scripts/extract-local.js');
    const lines = [];
    extractLocal.logProviderRunSummary(
      { log: (l) => lines.push(l) },
      'sess-5',
      { ok: true, extractionModel: { provider: 'codex-cli' } },
      { judgeAttempted: false, judgeSucceeded: false }
    );
    assert.match(lines[0], /provider=codex-cli .*hooks=n\/a$/);
  });

  it('EXTRACT-LOG-HOOKS-EVIDENCE: claude-code, finder ran with argv captured but NOT carrying --setting-sources: hooks=unknown, never isolated', () => {
    const extractLocal = require('../scripts/extract-local.js');
    const lines = [];
    extractLocal.logProviderRunSummary(
      { log: (l) => lines.push(l) },
      'sess-7',
      {
        ok: true,
        extractionModel: { provider: 'claude-code' },
        argv: ['-p', '--output-format', 'json', '--no-session-persistence', '--tools', ''],
        cliVersion: '2.1.12',
      },
      null
    );
    assert.equal(lines.length, 1);
    assert.match(lines[0], /finder=ran .*hooks=unknown$/);
    assert.doesNotMatch(lines[0], /hooks=isolated/);
  });

  it('EXTRACT-LOG-HOOKS-EVIDENCE: claude-code, finder=ran but NO argv captured this run (the fallthrough-to-another-provider case observed in production): hooks=unknown + flags=n/a, never isolated', () => {
    const extractLocal = require('../scripts/extract-local.js');
    const lines = [];
    // Reproduces the real defect class: providers.runModel() fell through
    // from claude-code to a different provider (byo-key, whose own
    // result carries no `argv` field and, on failure, no `identity`), so
    // resolveExtractionModelIdentity()'s fallback re-resolved the label
    // back to 'claude-code' independent of which provider's result this
    // actually is. reasonCode 'model-error' is NOT in
    // PRE_SPAWN_SKIP_REASON_CODES, so finder correctly reports 'ran' — but
    // there is no claude-code argv evidence to back an 'isolated' claim.
    extractLocal.logProviderRunSummary(
      { log: (l) => lines.push(l) },
      'sess-8',
      {
        ok: false,
        reasonCode: 'model-error',
        extractionModel: { provider: 'claude-code', model: null, version: null, vendor: null },
      },
      null
    );
    assert.equal(lines.length, 1);
    assert.match(lines[0], /provider=claude-code cli=- finder=ran judge=skipped\(no-candidates\) flags=n\/a hooks=unknown$/);
    assert.doesNotMatch(lines[0], /hooks=isolated/);
  });

  it('EXTRACT-LOG-HOOKS-EVIDENCE: the reason-code path still wins when the CLI is genuinely unsupported', () => {
    const extractLocal = require('../scripts/extract-local.js');
    const lines = [];
    extractLocal.logProviderRunSummary(
      { log: (l) => lines.push(l) },
      'sess-9',
      {
        ok: false,
        reasonCode: 'cli-settings-isolation-unsupported',
        extractionModel: { provider: 'claude-code', model: null, version: null, vendor: null },
        argv: ['-p', '--output-format', 'json', '--no-session-persistence', '--tools', '', '--setting-sources', ''],
        cliVersion: '2.1.12',
      },
      null
    );
    assert.equal(lines.length, 1);
    assert.match(lines[0], /hooks=unsupported$/);
  });

  it('logging must never throw or block extraction, even with a throwing log function', () => {
    const extractLocal = require('../scripts/extract-local.js');
    assert.doesNotThrow(() => {
      extractLocal.logProviderRunSummary(
        { log: () => { throw new Error('log sink down'); } },
        'sess-6',
        { ok: true, extractionModel: { provider: 'claude-code' } },
        null
      );
    });
  });

  it('extractLocally() end to end: emits exactly one run-summary line per run, at the skip exit AND at the success exit', async () => {
    const extractLocal = require('../scripts/extract-local.js');
    const lines = [];
    const skipResult = await extractLocal.extractLocally('t', 'claude-code', { ...supportedClaude,
      log: (l) => { if (l.startsWith('[providers]')) lines.push(l); },
      invokeModel: async () => ({ ok: false, reason: 'fixture-stop', reasonCode: 'cli-unauthenticated' }),
      runId: 'run-skip',
    });
    assert.equal(skipResult.learnings.length, 0);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /run=run-skip/);
    assert.match(lines[0], /finder=skipped/);

    lines.length = 0;
    const okResult = await extractLocal.extractLocally('t', 'claude-code', { ...supportedClaude,
      log: (l) => { if (l.startsWith('[providers]')) lines.push(l); },
      invokeModel: async () => ({ ok: true, out: JSON.stringify({ learnings: [] }) }),
      runId: 'run-ok',
    });
    assert.equal(okResult.learnings.length, 0);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /run=run-ok/);
    assert.match(lines[0], /finder=ran/);
    assert.match(lines[0], /judge=skipped\(no-candidates\)/, 'no learnings means no judge candidates this run');
  });
});

// ─── EXT-0806c — expired-OAuth exit is classified cli-unauthenticated ──────────
const OAUTH_EXPIRED = 'Failed to authenticate: OAuth session expired and could not be refreshed';
function claudeRun(mode, responses) {
  claudeCode._resetSettingSourcesCacheForTests();
  const stub = spawnQueue(responses);
  return claudeCode.runModel({ ...supportedClaude, beforeModelInvocation: () => true, mode, prompt: 'P', input: 'T',
    claudeBin: 'claude', spawnSyncImpl: stub.spawnSyncImpl, log: () => {} });
}

describe('claude-code.js — expired-OAuth classification (EXT-0806c)', () => {

  it('(a) extract: the exact string on STDERR with exit 1 is cli-unauthenticated, keeps the loggedIn:true discrepancy, and carries no refusal', async () => {
    assert.equal(claudeCode.OAUTH_EXPIRED_PATTERN.test('Failed to authenticate: OAuth session expired and could not be refreshed'), true);
    const result = await claudeRun('extract', [authJson(true), { status: 1, stdout: '', stderr: OAUTH_EXPIRED }]);
    assert.equal(result.ok, false);
    assert.equal(result.reasonCode, 'cli-unauthenticated');
    assert.equal(result.authStatus, 'logged-in');
    assert.equal(result.authDiscrepancy, true);
    assert.equal('refusal' in result, false, 'a post-spawn outcome must never permit fallback');
  });

  it('(b) extract: the exact string on STDOUT with exit 1 is cli-unauthenticated with no refusal', async () => {
    const result = await claudeRun('extract', [authJson(true), { status: 1, stdout: OAUTH_EXPIRED + '\n', stderr: '' }]);
    assert.equal(result.ok, false);
    assert.equal(result.reasonCode, 'cli-unauthenticated');
    assert.equal('refusal' in result, false);
  });

  it('(c) judge: the exact string on either stream with exit 1 is cli-unauthenticated with no refusal', async () => {
    for (const response of [{ status: 1, stdout: '', stderr: OAUTH_EXPIRED }, { status: 1, stdout: OAUTH_EXPIRED, stderr: '' }]) {
      const result = await claudeRun('judge', [response]);
      assert.equal(result.ok, false);
      assert.equal(result.reasonCode, 'cli-unauthenticated');
      assert.equal('refusal' in result, false);
    }
  });

  it('(d) Overloaded, rate-limit and generic exit 1 stay model-error in both modes', async () => {
    const failures = [
      { status: 1, stdout: '', stderr: 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}' },
      { status: 1, stdout: '', stderr: 'Error: rate limit exceeded, please retry later' },
      { status: 1, stdout: 'unexpected internal error', stderr: '' },
    ];
    for (const failure of failures) {
      const extract = await claudeRun('extract', [authJson(true), failure]);
      assert.equal(extract.reasonCode, 'model-error', JSON.stringify(failure));
      const judge = await claudeRun('judge', [failure]);
      assert.equal(judge.reasonCode, 'model-error', JSON.stringify(failure));
    }
  });

  it('(g) exit 0 whose result wrapper contains the OAuth phrase is a success in both modes, never cli-unauthenticated', async () => {
    const wrapper = JSON.stringify({ type: 'result', is_error: false,
      result: 'A learning ABOUT an auth bug: the CLI prints "' + OAUTH_EXPIRED + '" when the refresh token is dead.' });
    const extract = await claudeRun('extract', [authJson(true), { status: 0, stdout: wrapper, stderr: '' }]);
    assert.equal(extract.ok, true, JSON.stringify(extract));
    assert.equal(extract.text.includes(OAUTH_EXPIRED), true);
    const judge = await claudeRun('judge', [{ status: 0, stdout: wrapper, stderr: '' }]);
    assert.equal(judge.ok, true, JSON.stringify(judge));
    assert.notEqual(judge.reasonCode, 'cli-unauthenticated');
  });
});
