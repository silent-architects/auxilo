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
  it("mode:'extract' spawns [bin, '-p', '--no-session-persistence', '--tools', '', '--setting-sources', ''] (EXTRACT-TOOLS-LOCK + the W1 FIX GIVENS: matches the judge spawn's --no-session-persistence; EXTRACTION-CHILD-HOOKS 0.9.15 adds --setting-sources '' so the child loads none of the operator's own settings/hooks)", async () => {
    const stub = spawnQueue([authJson(true), { status: 0, stdout: '{"learnings":[]}', stderr: '' }]);
    const result = await claudeCode.runModel({
      prompt: 'PROMPT', input: 'TRANSCRIPT', mode: 'extract',
      spawnSyncImpl: stub.spawnSyncImpl, claudeBin: 'claude',
    });
    assert.equal(result.ok, true);
    assert.deepEqual(stub.calls[1].args, ['-p', '--no-session-persistence', '--tools', '', '--setting-sources', '']);
    assert.deepEqual(result.argv, ['-p', '--no-session-persistence', '--tools', '', '--setting-sources', '']);
  });

  it("mode:'judge' spawns byte-identical argv to pre-move plus --setting-sources '' (0.9.15): ['-p','--output-format','json','--no-session-persistence','--tools','','--setting-sources','']", async () => {
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
    assert.deepEqual(stub.calls[0].args, ['-p', '--output-format', 'json', '--no-session-persistence', '--tools', '', '--setting-sources', '']);
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
    const extractStub = spawnQueue([authJson(true), { status: 0, stdout: '{"learnings":[]}', stderr: '' }]);
    const extractResult = await claudeCode.runModel({
      prompt: 'P', input: 'T', mode: 'extract', spawnSyncImpl: extractStub.spawnSyncImpl, claudeBin: 'claude',
    });
    assert.ok(extractResult.argv.includes('--setting-sources'));
    assert.equal(extractResult.argv[extractResult.argv.indexOf('--setting-sources') + 1], '');

    const judgeStub = spawnQueue([{
      status: 0,
      stdout: JSON.stringify({ result: '{"decisions":[]}', is_error: false, usage: {} }),
      stderr: '',
    }]);
    const judgeResult = await claudeCode.runModel({
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
    const first = await claudeCode.runModel({ prompt: 'P', input: 'T', mode: 'extract', spawnSyncImpl, claudeBin: 'claude' });
    assert.equal(first.ok, false);
    assert.equal(first.reasonCode, 'cli-settings-isolation-unsupported');
    assert.equal(spawnCalls, 2, 'the auth check + the one real spawn that revealed unsupported — no separate probe call');

    const second = await claudeCode.runModel({ prompt: 'P', input: 'T', mode: 'extract', spawnSyncImpl, claudeBin: 'claude' });
    assert.equal(second.ok, false);
    assert.equal(second.reasonCode, 'cli-settings-isolation-unsupported');
    assert.equal(spawnCalls, 2, 'cached: a second call must not spawn again (it must never run without the flag, and re-attempting a doomed spawn is silent waste)');
  });

  it('judge mode: same unsupported-flag detection and cache short-circuit', async () => {
    let spawnCalls = 0;
    const responses = [{ status: 1, stdout: '', stderr: "error: unknown option '--setting-sources'" }];
    const spawnSyncImpl = () => { spawnCalls += 1; return responses.shift(); };
    const first = await claudeCode.runModel({ prompt: 'P', mode: 'judge', spawnSyncImpl, claudeBin: 'claude' });
    assert.equal(first.ok, false);
    assert.equal(first.reasonCode, 'cli-settings-isolation-unsupported');
    assert.equal(spawnCalls, 1);

    const second = await claudeCode.runModel({ prompt: 'P', mode: 'judge', spawnSyncImpl, claudeBin: 'claude' });
    assert.equal(second.reasonCode, 'cli-settings-isolation-unsupported');
    assert.equal(spawnCalls, 1, 'cached across modes — extract detecting it also gates judge, and vice versa');
  });

  it('providers/index.js runModel(): cli-settings-isolation-unsupported is in NON_RETRYABLE_FOR_THIS_PROVIDER and falls through to the next provider rather than hard-failing', async () => {
    assert.ok(providers.NON_RETRYABLE_FOR_THIS_PROVIDER.has('cli-settings-isolation-unsupported'));
    const responses = [authJson(true), { status: 1, stdout: '', stderr: "error: unknown option '--setting-sources'" }];
    // Beyond claude-code's 2 calls, give codex-cli/byo-key's own probes a
    // clean, deterministic "not found" rather than letting the shared stub
    // run dry (which would surface a DIFFERENT provider's spawn-plumbing
    // failure as the walk's final reasonCode and make this assertion about
    // codex-cli/byo-key's own behavior instead of claude-code's fall-through).
    const spawnSyncImpl = () => responses.shift() || { status: 1, stdout: '', stderr: '', error: Object.assign(new Error('not found'), { code: 'ENOENT' }) };
    const home = tempDir('auxilo-isolation-fallthrough-home-');
    const logLines = [];
    try {
      const result = await providers.runModel({
        prompt: 'P', input: 'T', mode: 'extract', spawnSyncImpl, claudeBin: 'claude',
        homeDir: home, cwd: home, existsSync: () => false,
        providersStatePath: path.join(home, '.auxilo', 'providers.json'),
        log: (line) => logLines.push(line),
        // Pre-resolve to claude-code — bypasses resolveProvider()'s own
        // detect() scan (which would otherwise consume this test's crafted
        // auth-status/spawn response queue before runModel() gets to it) so
        // only runModel()'s own two claude-code calls (auth check, then the
        // real spawn that reveals the unsupported flag) draw from `responses`.
        providerCache: { resolved: { ok: true, id: 'claude-code', module: claudeCode } },
      });
      assert.equal(result.ok, false);
      assert.notEqual(result.reasonCode, 'cli-settings-isolation-unsupported', 'must not stop at claude-code — the whole point of the retryable set is falling through');
      assert.ok(
        logLines.some((line) => line.includes('claude-code unusable (cli-settings-isolation-unsupported); trying next provider')),
        `expected a claude-code fall-through log line; got: ${JSON.stringify(logLines)}`
      );
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
  // EXTRACT-PER-CLIENT W1 P1 fix (PUNCH-LIST): detect() used to short-circuit
  // to `true` the instant a filesystem candidate resolved, with NO auth
  // check at all — a stale, logged-out install still "detected". The auth
  // check now ALWAYS runs, regardless of how the binary was found.
  it('a resolvable filesystem candidate alone is NOT enough — the auth check always runs now', () => {
    let spawnCalls = 0;
    const result = claudeCode.detect({
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
    assert.equal(claudeCode.detect({
      homeDir: '/fixture/home', cwd: '/fixture/home', existsSync: () => false, spawnSyncImpl: loggedIn.spawnSyncImpl,
    }), true);

    const unknown = spawnQueue([{ status: 1, stdout: '', stderr: 'boom' }]);
    assert.equal(claudeCode.detect({
      homeDir: '/fixture/home', cwd: '/fixture/home', existsSync: () => false, spawnSyncImpl: unknown.spawnSyncImpl,
    }), true, "'unknown' auth status must read as usable — the flip half of the W1 P1 fix");

    const loggedOut = spawnQueue([authJson(false)]);
    assert.equal(claudeCode.detect({
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
      const result = claudeCode.detect({
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

  it('all providers false → ok:false naming every provider tried, in order', async () => {
    const resolved = await providers.resolveProvider({
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
    assert.match(resolved.reason, /claude-code, codex-cli, byo-key/);
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
    const resolved = await providers.resolveProvider({
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
    const resolved = await providers.resolveProvider({
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
      env: {},
      providerCache: {},
      homeDir: '/fixture/home',
      cwd: '/fixture/home',
      providersStatePath: '/fixture/home/.auxilo/providers-cache-test-a.json',
      existsSync: () => { detectCallsA += 1; return true; },
      spawnSyncImpl: () => authJson(true),
    });
    let detectCallsB = 0;
    const resolvedB = await providers.resolveProvider({
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
        argv: ['-p', '--no-session-persistence', '--tools', '', '--setting-sources', ''],
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
    const skipResult = await extractLocal.extractLocally('t', 'claude-code', {
      log: (l) => { if (l.startsWith('[providers]')) lines.push(l); },
      invokeModel: async () => ({ ok: false, reason: 'fixture-stop', reasonCode: 'cli-unauthenticated' }),
      runId: 'run-skip',
    });
    assert.equal(skipResult.learnings.length, 0);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /run=run-skip/);
    assert.match(lines[0], /finder=skipped/);

    lines.length = 0;
    const okResult = await extractLocal.extractLocally('t', 'claude-code', {
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
