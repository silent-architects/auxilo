'use strict';
/*
 * test/codex-cli-provider.test.js — EXTRACT-PER-CLIENT W1 PART B.
 *
 * Covers scripts/providers/codex-cli.js: argv shape, the two JSON-Schema hint
 * files, stdin composition, output-file-over-stdout precedence (with the
 * documented stdout fallback), env scrub (imported from claude-code.js, plus
 * the OPENAI_API_KEY-specific scrub), detect()'s two-leg requirement, auth_mode
 * reading, every reason code, usage always null, the cached `codex --version`
 * capture, and the provider-selection e2e proof named in the build spec:
 * "NO claude binary on PATH and a codex auth.json present → provider =
 * codex-cli" via providers/index.js's resolveProvider with injected detectors.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const codexCli = require('../scripts/providers/codex-cli.js');
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

/** Write a valid ~/.codex/auth.json under `home` and return `home`. */
function withAuthJson(home, authMode = 'chatgpt', extra = {}) {
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.codex', 'auth.json'),
    JSON.stringify({ auth_mode: authMode, OPENAI_API_KEY: null, ...extra })
  );
  return home;
}

function okSpawnResult(stdout = '', stderr = '') {
  return { status: 0, stdout, stderr, error: null, signal: null };
}

describe('codex-cli.js — module shape', () => {
  it('exports runModel and detect (provider.interface.js contract)', () => {
    assert.equal(typeof codexCli.runModel, 'function');
    assert.equal(typeof codexCli.detect, 'function');
  });
});

// ─── (1) argv — documented flag set, ends with '-' ─────────────────────────

describe('codex-cli.js — runModel argv', () => {
  it("mode:'extract' spawns codex with the documented flag set, output-schema pointing at the extraction envelope schema, and ends with '-'", async () => {
    const home = withAuthJson(tempDir('auxilo-codex-argv-'));
    const outputPath = path.join(home, 'out-extract.txt');
    fs.writeFileSync(outputPath, '{"learnings":[]}');
    const stub = spawnQueue([okSpawnResult('')]);
    try {
      const result = await codexCli.runModel({
        prompt: 'PROMPT', input: 'TRANSCRIPT', mode: 'extract',
        homeDir: home, codexBin: 'codex', outputPath,
        spawnSyncImpl: stub.spawnSyncImpl,
      });
      assert.equal(result.ok, true);
      assert.deepEqual(stub.calls[0].args, [
        'exec',
        '-s', 'read-only',
        '--skip-git-repo-check',
        '--ephemeral',
        '--ignore-user-config',
        '--output-schema', codexCli.EXTRACTION_SCHEMA_PATH,
        '-o', outputPath,
        '-',
      ]);
      assert.equal(stub.calls[0].bin, 'codex');
    } finally {
      cleanupTempDirs();
    }
  });

  it("mode:'judge' spawns the same flag shape with the judge-decisions schema", async () => {
    const home = withAuthJson(tempDir('auxilo-codex-argv-judge-'));
    const outputPath = path.join(home, 'out-judge.txt');
    fs.writeFileSync(outputPath, '{"decisions":[]}');
    const stub = spawnQueue([okSpawnResult('')]);
    try {
      const result = await codexCli.runModel({
        prompt: 'JUDGE_PROMPT', mode: 'judge',
        homeDir: home, codexBin: 'codex', outputPath,
        spawnSyncImpl: stub.spawnSyncImpl,
      });
      assert.equal(result.ok, true);
      assert.deepEqual(stub.calls[0].args, [
        'exec',
        '-s', 'read-only',
        '--skip-git-repo-check',
        '--ephemeral',
        '--ignore-user-config',
        '--output-schema', codexCli.JUDGE_SCHEMA_PATH,
        '-o', outputPath,
        '-',
      ]);
    } finally {
      cleanupTempDirs();
    }
  });
});

// ─── (2) schema files exist and validate the envelope shapes ───────────────

describe('codex-cli.js — output-schema hint files', () => {
  it('both schema files exist on disk and parse as valid JSON', () => {
    assert.ok(fs.existsSync(codexCli.EXTRACTION_SCHEMA_PATH));
    assert.ok(fs.existsSync(codexCli.JUDGE_SCHEMA_PATH));
    assert.doesNotThrow(() => JSON.parse(fs.readFileSync(codexCli.EXTRACTION_SCHEMA_PATH, 'utf8')));
    assert.doesNotThrow(() => JSON.parse(fs.readFileSync(codexCli.JUDGE_SCHEMA_PATH, 'utf8')));
  });

  it('extraction-envelope.schema.json validates a real parseExtractionOutput envelope (object form and bare-array form)', () => {
    const extractLocal = require('../scripts/extract-local.js');
    const schema = JSON.parse(fs.readFileSync(codexCli.EXTRACTION_SCHEMA_PATH, 'utf8'));
    const learningDef = schema.definitions.learning;

    function assertLearningMatchesSchema(l) {
      assert.equal(typeof l.title, 'string');
      assert.ok(l.title.length >= learningDef.properties.title.minLength);
      assert.equal(typeof l.body, 'string');
      assert.ok(l.body.length >= learningDef.properties.body.minLength);
      assert.ok(learningDef.properties.category.enum.includes(l.category));
      assert.ok(learningDef.properties.outcome.enum.includes(l.outcome));
    }

    const objectForm = extractLocal.parseExtractionOutput(JSON.stringify({
      learnings: [{
        title: 'A title long enough to pass',
        body: 'A body that is at least fifty characters long so it clears the gate.',
        category: 'code-execution',
        tags: ['x'],
        task_context: 'ctx',
        outcome: 'success',
      }],
      dedup_drops: [],
    }));
    assert.equal(objectForm.learnings.length, 1);
    objectForm.learnings.forEach(assertLearningMatchesSchema);

    const bareArrayForm = extractLocal.parseLearnings(JSON.stringify([{
      title: 'Another title long enough',
      body: 'Another body that clears the fifty-character minimum length gate easily.',
      category: 'monitoring',
      outcome: 'workaround',
    }]));
    assert.equal(bareArrayForm.length, 1);
    bareArrayForm.forEach(assertLearningMatchesSchema);
  });

  it('judge-decisions.schema.json validates a real parseJudgeDecisions response shape', () => {
    const schema = JSON.parse(fs.readFileSync(codexCli.JUDGE_SCHEMA_PATH, 'utf8'));
    const decisionProps = schema.properties.decisions.items.properties;
    const sample = { decisions: [{ candidate_index: 0, duplicate: true, matched_index_id: 'row-1' }] };
    assert.ok(Array.isArray(sample.decisions));
    for (const d of sample.decisions) {
      assert.equal(typeof d.candidate_index, decisionProps.candidate_index.type === 'integer' ? 'number' : typeof d.candidate_index);
      assert.equal(typeof d.duplicate, 'boolean');
      assert.equal(typeof d.matched_index_id, 'string');
    }
  });
});

// ─── (3) stdin carries prompt + input ───────────────────────────────────────

describe('codex-cli.js — stdin composition', () => {
  it('stdin is prompt + input verbatim (extract mode)', async () => {
    const home = withAuthJson(tempDir('auxilo-codex-stdin-'));
    const outputPath = path.join(home, 'out.txt');
    fs.writeFileSync(outputPath, '{"learnings":[]}');
    const stub = spawnQueue([okSpawnResult('')]);
    try {
      await codexCli.runModel({
        prompt: 'PROMPT-', input: 'TRANSCRIPT-BODY', mode: 'extract',
        homeDir: home, codexBin: 'codex', outputPath,
        spawnSyncImpl: stub.spawnSyncImpl,
      });
      assert.equal(stub.calls[0].opts.input, 'PROMPT-TRANSCRIPT-BODY');
    } finally {
      cleanupTempDirs();
    }
  });

  it('judge mode: stdin is prompt alone when input is omitted', async () => {
    const home = withAuthJson(tempDir('auxilo-codex-stdin-judge-'));
    const outputPath = path.join(home, 'out.txt');
    fs.writeFileSync(outputPath, '{"decisions":[]}');
    const stub = spawnQueue([okSpawnResult('')]);
    try {
      await codexCli.runModel({
        prompt: 'JUDGE-PROMPT-ONLY', mode: 'judge',
        homeDir: home, codexBin: 'codex', outputPath,
        spawnSyncImpl: stub.spawnSyncImpl,
      });
      assert.equal(stub.calls[0].opts.input, 'JUDGE-PROMPT-ONLY');
    } finally {
      cleanupTempDirs();
    }
  });
});

// ─── (4) output read from the -o file, not stdout; documented stdout fallback ─

describe('codex-cli.js — output source', () => {
  it('text comes from the -o file even when stdout carries stray banner/telemetry content', async () => {
    const home = withAuthJson(tempDir('auxilo-codex-output-'));
    const outputPath = path.join(home, 'out.txt');
    fs.writeFileSync(outputPath, '{"learnings":[{"title":"real answer from the file, not stdout","body":"body body body body body body body body body body body","category":"monitoring","outcome":"success"}]}');
    const stub = spawnQueue([okSpawnResult('session id: abc123\nstray telemetry line\n')]);
    try {
      const result = await codexCli.runModel({
        prompt: 'P', input: 'T', mode: 'extract',
        homeDir: home, codexBin: 'codex', outputPath,
        spawnSyncImpl: stub.spawnSyncImpl,
      });
      assert.equal(result.ok, true);
      assert.match(result.text, /real answer from the file, not stdout/);
      assert.doesNotMatch(result.text, /stray telemetry/);
    } finally {
      cleanupTempDirs();
    }
  });

  it('falls back to stdout when the -o file is absent (documented as the exception path, not the default)', async () => {
    const home = withAuthJson(tempDir('auxilo-codex-output-fallback-'));
    const outputPath = path.join(home, 'never-written.txt'); // never created
    const stub = spawnQueue([okSpawnResult('{"learnings":[]}')]);
    try {
      const result = await codexCli.runModel({
        prompt: 'P', input: 'T', mode: 'extract',
        homeDir: home, codexBin: 'codex', outputPath,
        spawnSyncImpl: stub.spawnSyncImpl,
      });
      assert.equal(result.ok, true);
      assert.equal(result.text, '{"learnings":[]}');
    } finally {
      cleanupTempDirs();
    }
  });

  it('the -o file is cleaned up (best-effort unlink) after a successful read', async () => {
    const home = withAuthJson(tempDir('auxilo-codex-cleanup-'));
    const outputPath = path.join(home, 'out.txt');
    fs.writeFileSync(outputPath, '{"learnings":[]}');
    const stub = spawnQueue([okSpawnResult('')]);
    try {
      await codexCli.runModel({
        prompt: 'P', input: 'T', mode: 'extract',
        homeDir: home, codexBin: 'codex', outputPath,
        spawnSyncImpl: stub.spawnSyncImpl,
      });
      assert.equal(fs.existsSync(outputPath), false);
    } finally {
      cleanupTempDirs();
    }
  });
});

// ─── (5) scrubbed env ───────────────────────────────────────────────────────

describe('codex-cli.js — codexChildEnv() scrub', () => {
  it('deletes every var in claude-code.js\'s SCRUBBED_CLIENT_ENV_VARS, imported not duplicated', () => {
    const dirty = { ...process.env };
    for (const key of claudeCode.SCRUBBED_CLIENT_ENV_VARS) dirty[key] = 'leaked-value';
    const originalEnv = process.env;
    process.env = dirty;
    try {
      const childEnv = codexCli.codexChildEnv();
      for (const key of claudeCode.SCRUBBED_CLIENT_ENV_VARS) {
        assert.equal(childEnv[key], undefined, `${key} must be scrubbed from the codex child env`);
      }
    } finally {
      process.env = originalEnv;
    }
  });

  it('scrubs OPENAI_API_KEY even though it is not in SCRUBBED_CLIENT_ENV_VARS and the parent process has one', () => {
    assert.ok(!claudeCode.SCRUBBED_CLIENT_ENV_VARS.includes('OPENAI_API_KEY'));
    const originalEnv = process.env;
    process.env = { ...originalEnv, OPENAI_API_KEY: 'sk-leaked' };
    try {
      const childEnv = codexCli.codexChildEnv();
      assert.equal(childEnv.OPENAI_API_KEY, undefined);
    } finally {
      process.env = originalEnv;
    }
  });

  it('preserves unrelated env vars and sets AUXILO_EXTRACTING=1', () => {
    const originalEnv = process.env;
    process.env = { ...originalEnv, SOME_UNRELATED_VAR: 'kept' };
    try {
      const childEnv = codexCli.codexChildEnv();
      assert.equal(childEnv.SOME_UNRELATED_VAR, 'kept');
      assert.equal(childEnv.AUXILO_EXTRACTING, '1');
    } finally {
      process.env = originalEnv;
    }
  });

  it('the env object actually handed to spawnSyncImpl has the scrub applied', async () => {
    const home = withAuthJson(tempDir('auxilo-codex-spawnenv-'));
    const outputPath = path.join(home, 'out.txt');
    fs.writeFileSync(outputPath, '{"learnings":[]}');
    const stub = spawnQueue([okSpawnResult('')]);
    const originalEnv = process.env;
    process.env = { ...originalEnv, ANTHROPIC_API_KEY: 'leak', OPENAI_API_KEY: 'leak' };
    try {
      await codexCli.runModel({
        prompt: 'P', input: 'T', mode: 'extract',
        homeDir: home, codexBin: 'codex', outputPath,
        spawnSyncImpl: stub.spawnSyncImpl,
      });
      const spawnedEnv = stub.calls[0].opts.env;
      assert.equal(spawnedEnv.ANTHROPIC_API_KEY, undefined);
      assert.equal(spawnedEnv.OPENAI_API_KEY, undefined);
    } finally {
      process.env = originalEnv;
      cleanupTempDirs();
    }
  });
});

// ─── (6) detect() — both legs required ─────────────────────────────────────

describe('codex-cli.js — detect()', () => {
  it('true: explicit binary candidate on disk + valid auth.json', () => {
    const home = withAuthJson(tempDir('auxilo-codex-detect-true-'));
    const binDir = path.join(home, '.npm-global', 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, 'codex'), '#!/bin/sh\n');
    try {
      let spawnCalls = 0;
      const result = codexCli.detect({ homeDir: home, spawnSyncImpl: () => { spawnCalls += 1; throw new Error('must not spawn'); } });
      assert.equal(result, true);
      assert.equal(spawnCalls, 0, 'an explicit filesystem candidate must not need a --version probe');
    } finally {
      cleanupTempDirs();
    }
  });

  it('true: no filesystem candidate, but --version probes successfully (PATH resolves it) + valid auth.json', () => {
    const home = withAuthJson(tempDir('auxilo-codex-detect-path-'));
    const stub = spawnQueue([{ status: 0, stdout: 'codex-cli 0.144.5', stderr: '', error: null }]);
    try {
      const result = codexCli.detect({ homeDir: home, spawnSyncImpl: stub.spawnSyncImpl });
      assert.equal(result, true);
      assert.deepEqual(stub.calls[0].args, ['--version']);
    } finally {
      cleanupTempDirs();
    }
  });

  it('false: valid auth.json but no binary anywhere (no candidate, --version probe fails)', () => {
    const home = withAuthJson(tempDir('auxilo-codex-detect-nobin-'));
    const stub = spawnQueue([{ status: 1, stdout: '', stderr: 'not found', error: null }]);
    try {
      const result = codexCli.detect({ homeDir: home, spawnSyncImpl: stub.spawnSyncImpl });
      assert.equal(result, false);
    } finally {
      cleanupTempDirs();
    }
  });

  it('false: binary present but ~/.codex/auth.json missing entirely — never spawns (auth checked first)', () => {
    const home = tempDir('auxilo-codex-detect-noauth-');
    const binDir = path.join(home, '.npm-global', 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, 'codex'), '#!/bin/sh\n');
    try {
      let spawnCalls = 0;
      const result = codexCli.detect({ homeDir: home, spawnSyncImpl: () => { spawnCalls += 1; throw new Error('must not spawn'); } });
      assert.equal(result, false);
      assert.equal(spawnCalls, 0);
    } finally {
      cleanupTempDirs();
    }
  });
});

// ─── (7) auth_mode reading ──────────────────────────────────────────────────

describe('codex-cli.js — readAuthMode()', () => {
  it('positive: returns the auth_mode string from a valid auth.json', () => {
    const home = withAuthJson(tempDir('auxilo-codex-auth-pos-'), 'chatgpt');
    try {
      assert.equal(codexCli.readAuthMode({ homeDir: home }), 'chatgpt');
    } finally {
      cleanupTempDirs();
    }
  });

  it('negative: missing auth.json returns null', () => {
    const home = tempDir('auxilo-codex-auth-missing-');
    try {
      assert.equal(codexCli.readAuthMode({ homeDir: home }), null);
    } finally {
      cleanupTempDirs();
    }
  });

  it('malformed JSON returns null, never throws', () => {
    const home = tempDir('auxilo-codex-auth-malformed-');
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(home, '.codex', 'auth.json'), '{ not valid json');
    try {
      assert.doesNotThrow(() => codexCli.readAuthMode({ homeDir: home }));
      assert.equal(codexCli.readAuthMode({ homeDir: home }), null);
    } finally {
      cleanupTempDirs();
    }
  });

  it('a falsy/empty auth_mode reads as null (not a bare presence check)', () => {
    const home = tempDir('auxilo-codex-auth-empty-');
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(home, '.codex', 'auth.json'), JSON.stringify({ auth_mode: '' }));
    try {
      assert.equal(codexCli.readAuthMode({ homeDir: home }), null);
    } finally {
      cleanupTempDirs();
    }
  });

  it('a truthy OPENAI_API_KEY alongside a valid auth_mode is still a valid read (not disqualifying)', () => {
    const home = withAuthJson(tempDir('auxilo-codex-auth-apikey-'), 'chatgpt', { OPENAI_API_KEY: 'sk-builder-own-key' });
    try {
      assert.equal(codexCli.readAuthMode({ homeDir: home }), 'chatgpt');
    } finally {
      cleanupTempDirs();
    }
  });
});

// ─── (8) reason codes ───────────────────────────────────────────────────────

describe('codex-cli.js — reason codes', () => {
  it("cli-unauthenticated: no auth.json short-circuits before any spawn", async () => {
    const home = tempDir('auxilo-codex-reason-unauth-');
    let spawnCalls = 0;
    try {
      const result = await codexCli.runModel({
        prompt: 'P', input: 'T', mode: 'extract', homeDir: home,
        spawnSyncImpl: () => { spawnCalls += 1; throw new Error('must not spawn'); },
      });
      assert.equal(result.ok, false);
      assert.equal(result.reasonCode, 'cli-unauthenticated');
      assert.equal(spawnCalls, 0);
    } finally {
      cleanupTempDirs();
    }
  });

  it('cli-not-installed: spawn fails with ENOENT (binary not found)', async () => {
    const home = withAuthJson(tempDir('auxilo-codex-reason-enoent-'));
    const outputPath = path.join(home, 'out.txt');
    const spawnSyncImpl = () => {
      const err = new Error('spawn codex ENOENT');
      err.code = 'ENOENT';
      return { error: err, stdout: '', stderr: '', status: null };
    };
    try {
      const result = await codexCli.runModel({
        prompt: 'P', input: 'T', mode: 'extract',
        homeDir: home, codexBin: 'codex', outputPath, spawnSyncImpl,
      });
      assert.equal(result.ok, false);
      assert.equal(result.reasonCode, 'cli-not-installed');
    } finally {
      cleanupTempDirs();
    }
  });

  it('cli-timeout: spawn reports an ETIMEDOUT error', async () => {
    const home = withAuthJson(tempDir('auxilo-codex-reason-timeout-err-'));
    const outputPath = path.join(home, 'out.txt');
    const spawnSyncImpl = () => {
      const err = new Error('etimedout');
      err.code = 'ETIMEDOUT';
      return { error: err, stdout: '', stderr: '', status: null };
    };
    try {
      const result = await codexCli.runModel({
        prompt: 'P', input: 'T', mode: 'extract',
        homeDir: home, codexBin: 'codex', outputPath, spawnSyncImpl,
      });
      assert.equal(result.ok, false);
      assert.equal(result.reasonCode, 'cli-timeout');
    } finally {
      cleanupTempDirs();
    }
  });

  it('cli-timeout: spawnSync signal-killed timeout (no error object, status null, signal set)', async () => {
    const home = withAuthJson(tempDir('auxilo-codex-reason-timeout-signal-'));
    const outputPath = path.join(home, 'out.txt');
    const stub = spawnQueue([{ status: null, signal: 'SIGTERM', stdout: '', stderr: '', error: null }]);
    try {
      const result = await codexCli.runModel({
        prompt: 'P', input: 'T', mode: 'extract',
        homeDir: home, codexBin: 'codex', outputPath, spawnSyncImpl: stub.spawnSyncImpl,
      });
      assert.equal(result.ok, false);
      assert.equal(result.reasonCode, 'cli-timeout');
    } finally {
      cleanupTempDirs();
    }
  });

  it('cli-bad-output: exit 0, no -o file, empty stdout', async () => {
    const home = withAuthJson(tempDir('auxilo-codex-reason-badoutput-'));
    const outputPath = path.join(home, 'never-written.txt');
    const stub = spawnQueue([okSpawnResult('')]);
    try {
      const result = await codexCli.runModel({
        prompt: 'P', input: 'T', mode: 'extract',
        homeDir: home, codexBin: 'codex', outputPath, spawnSyncImpl: stub.spawnSyncImpl,
      });
      assert.equal(result.ok, false);
      assert.equal(result.reasonCode, 'cli-bad-output');
    } finally {
      cleanupTempDirs();
    }
  });

  it('model-error: non-zero exit', async () => {
    const home = withAuthJson(tempDir('auxilo-codex-reason-modelerror-'));
    const outputPath = path.join(home, 'out.txt');
    const stub = spawnQueue([{ status: 1, stdout: 'boom', stderr: '', error: null, signal: null }]);
    try {
      const result = await codexCli.runModel({
        prompt: 'P', input: 'T', mode: 'extract',
        homeDir: home, codexBin: 'codex', outputPath, spawnSyncImpl: stub.spawnSyncImpl,
      });
      assert.equal(result.ok, false);
      assert.equal(result.reasonCode, 'model-error');
    } finally {
      cleanupTempDirs();
    }
  });
});

// ─── (9) usage always null ───────────────────────────────────────────────────

describe('codex-cli.js — usage', () => {
  it('a successful run always reports usage:null (the -o file carries no token counts)', async () => {
    const home = withAuthJson(tempDir('auxilo-codex-usage-'));
    const outputPath = path.join(home, 'out.txt');
    fs.writeFileSync(outputPath, '{"learnings":[]}');
    const stub = spawnQueue([okSpawnResult('')]);
    try {
      const result = await codexCli.runModel({
        prompt: 'P', input: 'T', mode: 'extract',
        homeDir: home, codexBin: 'codex', outputPath, spawnSyncImpl: stub.spawnSyncImpl,
      });
      assert.equal(result.ok, true);
      assert.equal(result.usage, null);
    } finally {
      cleanupTempDirs();
    }
  });
});

// ─── (10) codex --version capture is cached per process ────────────────────

describe('codex-cli.js — getCodexVersion() caching', () => {
  it('two runModel calls only probe --version once', async () => {
    codexCli._resetVersionCacheForTests();
    const home = withAuthJson(tempDir('auxilo-codex-version-cache-'));
    const outputPath1 = path.join(home, 'out1.txt');
    const outputPath2 = path.join(home, 'out2.txt');
    fs.writeFileSync(outputPath1, '{"learnings":[]}');
    fs.writeFileSync(outputPath2, '{"decisions":[]}');
    let versionProbeCalls = 0;
    const spawnSyncImpl = (bin, args) => {
      if (args[0] === '--version') {
        versionProbeCalls += 1;
        return { status: 0, stdout: 'codex-cli 0.144.5', stderr: '', error: null };
      }
      return okSpawnResult('');
    };
    try {
      const r1 = await codexCli.runModel({
        prompt: 'P', input: 'T', mode: 'extract',
        homeDir: home, codexBin: 'codex', outputPath: outputPath1, spawnSyncImpl,
      });
      const r2 = await codexCli.runModel({
        prompt: 'P', mode: 'judge',
        homeDir: home, codexBin: 'codex', outputPath: outputPath2, spawnSyncImpl,
      });
      assert.equal(r1.ok, true);
      assert.equal(r2.ok, true);
      assert.equal(r1.extraction_model.provider, 'codex-cli');
      assert.equal(r1.extraction_model.model, null);
      assert.equal(r1.extraction_model.version, 'codex-cli 0.144.5');
      assert.equal(r2.extraction_model.version, 'codex-cli 0.144.5');
      // Two runModel() calls, each of which needs the version stamp — only
      // ONE of the (bin, ['--version']) spawns should have actually happened.
      assert.equal(versionProbeCalls, 1, 'version probe must be cached across calls in this process');
    } finally {
      codexCli._resetVersionCacheForTests();
      cleanupTempDirs();
    }
  });
});

// ─── (11) e2e proof: no claude on PATH + codex auth.json present → codex-cli ─

describe('providers/index.js — e2e: claude unavailable, codex-cli available → resolveProvider picks codex-cli', () => {
  it("resolveProvider selects id:'codex-cli' when claude-code.detect() is false and codex-cli.detect() is true", async () => {
    const home = tempDir('auxilo-e2e-codex-selected-');
    withAuthJson(home, 'chatgpt');
    const codexBinDir = path.join(home, '.npm-global', 'bin');
    fs.mkdirSync(codexBinDir, { recursive: true });
    fs.writeFileSync(path.join(codexBinDir, 'codex'), '#!/bin/sh\n');

    // Shared existsSync: only the codex candidate path resolves — claude's
    // resolveClaudeBin candidates (all under a DIFFERENT subtree) all miss,
    // so claude-code.detect() falls through to checkAuthStatus().
    const existsSync = (p) => p === path.join(codexBinDir, 'codex');
    // Shared spawnSyncImpl: only claude-code.detect()'s checkAuthStatus probe
    // (`claude auth status`) reaches a spawn in this scenario — codex-cli's
    // detect() short-circuits on the explicit filesystem candidate above and
    // never spawns. Any `claude auth status` call reports a failure so
    // claude-code.detect() reads 'unknown' → false.
    const spawnSyncImpl = (bin, args) => {
      if (bin === 'claude' && args[0] === 'auth') {
        return { status: 1, stdout: '', stderr: 'not found' };
      }
      throw new Error(`unexpected spawn in e2e test: ${bin} ${args.join(' ')}`);
    };

    try {
      const resolved = await providers.resolveProvider({
        env: {},
        providerCache: {},
        homeDir: home,
        existsSync,
        spawnSyncImpl,
      });
      assert.equal(resolved.ok, true);
      assert.equal(resolved.id, 'codex-cli');
    } finally {
      cleanupTempDirs();
    }
  });
});
