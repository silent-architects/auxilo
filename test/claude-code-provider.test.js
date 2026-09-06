'use strict';
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

const { describe, it } = require('node:test');
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

// ─── (2)+(3) Extraction argv gains --tools '', judge argv unchanged ────────

describe('claude-code.js — runModel argv per mode', () => {
  it("mode:'extract' spawns [bin, '-p', '--tools', ''] (the new hardening)", async () => {
    const stub = spawnQueue([authJson(true), { status: 0, stdout: '{"learnings":[]}', stderr: '' }]);
    const result = await claudeCode.runModel({
      prompt: 'PROMPT', input: 'TRANSCRIPT', mode: 'extract',
      spawnSyncImpl: stub.spawnSyncImpl, claudeBin: 'claude',
    });
    assert.equal(result.ok, true);
    assert.deepEqual(stub.calls[1].args, ['-p', '--tools', '']);
  });

  it("mode:'judge' spawns byte-identical argv to pre-move: ['-p','--output-format','json','--no-session-persistence','--tools','']", async () => {
    const stub = spawnQueue([{
      status: 0,
      stdout: JSON.stringify({ result: '{"decisions":[]}', is_error: false, usage: { input_tokens: 5, output_tokens: 2 } }),
      stderr: '',
    }]);
    const result = await claudeCode.runModel({
      prompt: 'JUDGE_PROMPT', mode: 'judge',
      spawnSyncImpl: stub.spawnSyncImpl, claudeBin: 'claude',
    });
    assert.equal(result.ok, true);
    assert.deepEqual(stub.calls[0].args, ['-p', '--output-format', 'json', '--no-session-persistence', '--tools', '']);
    assert.deepEqual(result.usage, { input_tokens: 5, output_tokens: 2 });
  });
});

// ─── (4) Both spawns share ONE claudeChildEnv() — no drift ────────────────

describe('claude-code.js — extraction and judge spawns share one env shape (no drift)', () => {
  it('the env object handed to both spawns has an identical scrub set (2 spawns verified)', async () => {
    const originalEnv = process.env;
    process.env = { ...originalEnv, ANTHROPIC_API_KEY: 'leak', AWS_PROFILE: 'leak' };
    try {
      const extractStub = spawnQueue([authJson(true), { status: 0, stdout: '{"learnings":[]}', stderr: '' }]);
      await claudeCode.runModel({
        prompt: 'P', input: 'T', mode: 'extract',
        spawnSyncImpl: extractStub.spawnSyncImpl, claudeBin: 'claude',
      });
      const extractEnv = extractStub.calls[1].opts.env; // the '-p' spawn, not the auth-status probe

      const judgeStub = spawnQueue([{
        status: 0, stdout: JSON.stringify({ result: '{}', is_error: false }), stderr: '',
      }]);
      await claudeCode.runModel({
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
      const result = await claudeCode.runModel({
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
      const result = await claudeCode.runModel({ prompt: 'P', mode: 'judge', homeDir: home, cwd: home, spawnSyncImpl });
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
  it('true when a filesystem candidate resolves, without needing an auth spawn', () => {
    let spawnCalls = 0;
    const result = claudeCode.detect({
      homeDir: '/fixture/home',
      existsSync: (candidate) => candidate === '/opt/homebrew/bin/claude',
      spawnSyncImpl: () => { spawnCalls += 1; return authJson(true); },
    });
    assert.equal(result, true);
    assert.equal(spawnCalls, 0);
  });

  it('falls through to checkAuthStatus() when no candidate resolves; true unless unknown', () => {
    const stub = spawnQueue([authJson(true)]);
    const trueResult = claudeCode.detect({
      homeDir: '/fixture/home', existsSync: () => false, spawnSyncImpl: stub.spawnSyncImpl,
    });
    assert.equal(trueResult, true);

    const unknownStub = spawnQueue([{ status: 1, stdout: '', stderr: 'boom' }]);
    const falseResult = claudeCode.detect({
      homeDir: '/fixture/home', existsSync: () => false, spawnSyncImpl: unknownStub.spawnSyncImpl,
    });
    assert.equal(falseResult, false);
  });
});

// ─── (10) provider.interface.js smoke test lives in its own file per the spec
// (test/provider-interface.test.js) — not duplicated here.

// ─── (11) index.js selection order ─────────────────────────────────────────

describe('providers/index.js — resolveProvider selection', () => {
  it('AUXILO_EXTRACTION_PROVIDER override wins unconditionally, without calling detect()', async () => {
    let detectCalls = 0;
    const cache = {};
    const resolved = await providers.resolveProvider({
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
    const resolved = await providers.resolveProvider({
      env: { AUXILO_EXTRACTION_PROVIDER: 'not-a-real-provider' },
      providerCache: {},
    });
    assert.equal(resolved.ok, false);
    assert.match(resolved.reason, /not-a-real-provider/);
  });

  it('absent override picks the first detect()-true provider in fixed order (claude-code first)', async () => {
    const resolved = await providers.resolveProvider({
      env: {},
      providerCache: {},
      homeDir: '/fixture/home',
      existsSync: (c) => c === '/opt/homebrew/bin/claude', // claude-code detects true
    });
    assert.equal(resolved.ok, true);
    assert.equal(resolved.id, 'claude-code');
  });

  it('all providers false → ok:false naming every provider tried, in order', async () => {
    const resolved = await providers.resolveProvider({
      env: {},
      providerCache: {},
      homeDir: '/fixture/home',
      existsSync: () => false,
      spawnSyncImpl: () => ({ status: 1, stdout: '', stderr: '' }), // checkAuthStatus -> unknown
    });
    assert.equal(resolved.ok, false);
    assert.match(resolved.reason, /claude-code, codex-cli, byo-key/);
  });

  it('codex-cli and byo-key degrade to clean "not installed yet" stubs (no throw) until PART B/C add files', async () => {
    const codexResult = await providers.PROVIDERS_STATE_PATH; // sanity: module loaded without throwing
    assert.equal(typeof codexResult, 'string');
    const resolved = await providers.resolveProvider({
      env: { AUXILO_EXTRACTION_PROVIDER: 'codex-cli' },
      providerCache: {},
    });
    assert.equal(resolved.ok, true); // selection succeeds (override wins)
    const runResult = await resolved.module.runModel({});
    assert.equal(runResult.ok, false);
    assert.equal(runResult.reasonCode, 'provider-not-installed');
    assert.match(runResult.reason, /codex-cli/);
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
      existsSync: (c) => {
        detectCalls += 1;
        return c === '/opt/homebrew/bin/claude';
      },
    };
    const first = await providers.resolveProvider(opts);
    const second = await providers.resolveProvider(opts);
    assert.equal(first.id, 'claude-code');
    assert.equal(second.id, 'claude-code');
    // resolveClaudeBin probes 4 candidates per detect() call; a cached second
    // call must add ZERO further existsSync probes.
    const callsAfterFirst = detectCalls;
    assert.ok(callsAfterFirst > 0);
    await providers.resolveProvider(opts);
    assert.equal(detectCalls, callsAfterFirst, 'second+third resolveProvider call must not re-probe detect()');
  });

  it('a fresh providerCache (or none — the module default) re-detects independently', async () => {
    let detectCallsA = 0;
    const resolvedA = await providers.resolveProvider({
      env: {}, providerCache: {}, homeDir: '/fixture/home',
      existsSync: () => { detectCallsA += 1; return true; },
    });
    let detectCallsB = 0;
    const resolvedB = await providers.resolveProvider({
      env: {}, providerCache: {}, homeDir: '/fixture/home',
      existsSync: () => { detectCallsB += 1; return true; },
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
        result = await extractLocal.extractLocally('synthetic transcript', 'claude-code', {
          indexPath, log: () => {}, spawnSyncImpl, claudeBin: 'claude',
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
  it('renders the resolved provider id and "auto-detected" when no env override is set', () => {
    const cli = require('../bin/auxilo-cli.js');
    const originalEnv = process.env.AUXILO_EXTRACTION_PROVIDER;
    delete process.env.AUXILO_EXTRACTION_PROVIDER;
    try {
      const line = cli.extractionProviderLine({ ok: true, id: 'claude-code' });
      assert.match(line, /claude-code/);
      assert.match(line, /auto-detected/);
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
    const line = cli.extractionProviderLine({ ok: false, reason: 'no extraction model provider available — tried: claude-code, codex-cli, byo-key' });
    assert.match(line, /none/);
    assert.match(line, /tried: claude-code, codex-cli, byo-key/);
  });
});
