'use strict';
/*
 * test/provider-selection.test.js — EXTRACT-PER-CLIENT W1 P1 fix (PUNCH-LIST).
 *
 * Covers scripts/providers/index.js's resolveProvider()/runModel() selection
 * fall-through and persisted-choice re-detection, and claude-code.js's
 * detect() "usable now" semantics, as an end-to-end complement to the
 * per-module unit coverage in test/claude-code-provider.test.js,
 * test/codex-cli-provider.test.js and test/byo-key-provider.test.js.
 *
 * Defect this fixes: claude-code.js's detect() used to return true on binary
 * presence alone, and (on the PATH fallback) for any auth status that was not
 * literally 'unknown' — including 'logged-out'. Combined with
 * resolveProvider() never falling through when the selected provider's
 * runModel() later failed, a builder with Codex signed in and a stale,
 * logged-out Claude Code install got NO extraction at all.
 *
 * Fixtures (a)-(f) below are the binding scenarios named in the fix spec.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const providers = require('../scripts/providers/index.js');
const claudeCode = require('../scripts/providers/claude-code.js');
const codexCli = require('../scripts/providers/codex-cli.js');
const byoKey = require('../scripts/providers/byo-key.js');
const runner = require('../scripts/runner.js');

const CLI_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'bin', 'auxilo-cli.js'), 'utf8');

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

async function withProviderMethodStubs(stubs, fn) {
  const originals = [];
  for (const [provider, methods] of stubs) {
    for (const [name, implementation] of Object.entries(methods)) {
      originals.push([provider, name, provider[name]]);
      provider[name] = implementation;
    }
  }
  try {
    return await fn();
  } finally {
    for (const [provider, name, implementation] of originals.reverse()) {
      provider[name] = implementation;
    }
  }
}

function writeProvidersState(statePath, state) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.chmodSync(statePath, 0o600);
}

function successfulByoResponse(text = 'ok') {
  return {
    ok: true,
    status: 200,
    async json() {
      return { choices: [{ message: { content: text } }] };
    },
  };
}

/** Write a valid ~/.codex/auth.json under `home`. */
function withCodexAuth(home, authMode = 'chatgpt') {
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(home, '.codex', 'auth.json'), JSON.stringify({ auth_mode: authMode, OPENAI_API_KEY: null }));
  return home;
}

/** A codex binary candidate under home/.npm-global/bin/codex (a resolveCodexBin candidate). */
function withCodexBin(home) {
  const binPath = path.join(home, '.npm-global', 'bin', 'codex');
  fs.mkdirSync(path.dirname(binPath), { recursive: true });
  fs.writeFileSync(binPath, '#!/bin/sh\n');
  return binPath;
}

function lifecycleJsonl() {
  return [
    { type: 'thread.started', thread_id: 'fixture-thread' },
    { type: 'turn.started' },
    { type: 'turn.completed' },
  ].map((event) => JSON.stringify(event)).join('\n');
}

// ─── fixture (a) ─────────────────────────────────────────────────────────
// claude installed + logged-out, codex auth present → codex-cli remains dark
// under automatic resolution.

describe('EXTRACT-PER-CLIENT W1 P1 fixture (a): claude installed+logged-out, codex authenticated', () => {
  it('automatic resolution never invokes codex-cli and exhausts the configured automatic providers', async () => {
    const home = tempDir('auxilo-fixture-a-');
    withCodexAuth(home, 'chatgpt');
    const codexBinPath = withCodexBin(home);
    const outputPath = path.join(home, 'codex-out.txt');
    fs.writeFileSync(outputPath, JSON.stringify({ learnings: [] }));

    const spawnCalls = [];
    const spawnSyncImpl = (bin, args) => {
      spawnCalls.push({ bin, args });
      const base = path.basename(bin);
      if (base === 'claude' && args[0] === 'auth') {
        return { status: 0, stdout: JSON.stringify({ loggedIn: false }), stderr: '' }; // definite logged-out
      }
      if (base === 'codex' && args[0] === '--version') {
        return { status: 0, stdout: 'codex-cli 0.144.5', stderr: '', error: null };
      }
      if (base === 'codex' && args[0] === 'exec') {
        return { status: 0, stdout: lifecycleJsonl(), stderr: '', error: null };
      }
      throw new Error(`unexpected spawn: ${bin} ${JSON.stringify(args)}`);
    };

    try {
      const result = await providers.runModel({
        env: {},
        providerCache: {},
        mode: 'extract',
        prompt: 'P',
        input: 'T',
        homeDir: home,
        cwd: home,
        providersStatePath: path.join(home, '.auxilo', 'providers.json'),
        existsSync: (p) => p === codexBinPath,
        spawnSyncImpl,
        outputPath,
      });
      assert.equal(result.ok, false);
      assert.equal(result.reasonCode, 'no-usable-provider');
      assert.doesNotMatch(result.reason, /codex-cli=/);
      assert.ok(
        spawnCalls.some((c) => path.basename(c.bin) === 'claude' && c.args[0] === 'auth'),
        'claude-code must actually have been tried (and found logged-out) before falling through'
      );
      assert.ok(
        !spawnCalls.some((c) => path.basename(c.bin) === 'claude' && c.args[0] !== 'auth'),
        'the real extraction spawn must never reach claude while it is logged-out'
      );
      assert.ok(
        !spawnCalls.some((c) => path.basename(c.bin) === 'codex'),
        'codex-cli must remain dark under automatic resolution'
      );
    } finally {
      codexCli._resetVersionCacheForTests();
      cleanupTempDirs();
    }
  });
});

// ─── fixture (b) ─────────────────────────────────────────────────────────
// claude logged-out, no key → no-usable-provider with the two automatic
// reasons; transcript NOT marked in the content-sha ledger.

describe('EXTRACT-PER-CLIENT W1 P1 fixture (b): claude logged-out + no codex + no key', () => {
  it('providers.runModel exhausts both automatic providers, each with its own distinct reason', async () => {
    const home = tempDir('auxilo-fixture-b-');
    const spawnSyncImpl = (bin, args) => {
      if (path.basename(bin) === 'claude' && args[0] === 'auth') {
        return { status: 0, stdout: JSON.stringify({ loggedIn: false }), stderr: '' };
      }
      throw new Error(`unexpected spawn: ${bin} ${JSON.stringify(args)}`);
    };
    try {
      const result = await providers.runModel({
        env: {},
        providerCache: {},
        mode: 'extract',
        prompt: 'P',
        input: 'T',
        homeDir: home,
        cwd: home,
        providersStatePath: path.join(home, '.auxilo', 'providers.json'),
        existsSync: () => false,
        spawnSyncImpl,
      });
      assert.equal(result.ok, false);
      assert.equal(result.reasonCode, 'no-usable-provider');
      assert.match(result.reason, /claude-code=cli-unauthenticated/);
      assert.match(result.reason, /byo-key=provider-not-configured/);
      assert.doesNotMatch(result.reason, /codex-cli=/);
    } finally {
      cleanupTempDirs();
    }
  });

  it('the runner classifies this as a skip (extraction_id client-skip) — the ledgerMark gate at runner.js ~:1299 (guarded by the ~:1264 dedup check above it) never runs for it', async () => {
    const home = tempDir('auxilo-fixture-b-runner-');
    const idxDir = tempDir('auxilo-fixture-b-index-');
    const indexPath = path.join(idxDir, 'extracted-index.jsonl');
    fs.writeFileSync(indexPath, '');
    const spawnSyncImpl = (bin, args) => {
      if (path.basename(bin) === 'claude' && args[0] === 'auth') {
        return { status: 0, stdout: JSON.stringify({ loggedIn: false }), stderr: '' };
      }
      throw new Error(`unexpected spawn: ${bin} ${JSON.stringify(args)}`);
    };
    try {
      const detailed = await runner.postExtractDetailed(
        'a synthetic transcript, long enough to pass the length floor if any is applied by this path',
        'sess-fixture-b',
        'claude-code',
        { clean: true },
        {
          indexPath,
          log: () => {},
          homeDir: home,
          cwd: home,
          providersStatePath: path.join(home, '.auxilo', 'providers.json'),
          existsSync: () => false,
          spawnSyncImpl,
        }
      );
      assert.equal(detailed.skipped, true);
      assert.equal(detailed.reasonCode, 'no-usable-provider');
      assert.equal(detailed.result.extraction_id, 'client-skip');
      assert.equal(
        runner.isSkippedExtraction(detailed),
        true,
        'runner.js gates ledgerMark on this predicate — a skip must never be marked into the content-sha ledger, so the source transcript remains the retry source'
      );
    } finally {
      cleanupTempDirs();
    }
  });
});

// ─── fixture (c) ─────────────────────────────────────────────────────────
// claude 'unknown' auth → claude selected, and if its run returns
// cli-unauthenticated → codex stays dark in the same call.

describe("EXTRACT-PER-CLIENT W1 P1 fixture (c): claude auth status 'unknown' at detect(), but the real run is unauthenticated", () => {
  it('claude-code is selected (unknown reads as usable), then automatic resolution skips codex-cli after the real run is unauthenticated', async () => {
    const home = tempDir('auxilo-fixture-c-');
    withCodexAuth(home, 'chatgpt');
    const codexBinPath = withCodexBin(home);
    const outputPath = path.join(home, 'codex-out.txt');
    fs.writeFileSync(outputPath, JSON.stringify({ learnings: [] }));

    const spawnSyncImpl = (bin, args) => {
      const base = path.basename(bin);
      if (base === 'claude' && args[0] === 'auth') {
        // Ambiguous both times (detect() AND runExtractMode's own pre-spawn
        // check) — checkAuthStatus classifies a non-zero-exit/garbled
        // response as 'unknown', never 'logged-out'.
        return { status: 1, stdout: '', stderr: 'boom' };
      }
      if (base === 'claude' && args[0] === '-p') {
        // The REAL extraction spawn — this is what actually determines
        // unauthenticated, per runExtractMode's own comment: "the run itself
        // is the classifier of record."
        return { status: 0, stdout: 'API Error: 401 Unauthorized. Please run /login', stderr: '' };
      }
      if (base === 'codex' && args[0] === '--version') {
        return { status: 0, stdout: 'codex-cli 0.144.5', stderr: '', error: null };
      }
      if (base === 'codex' && args[0] === 'exec') {
        return { status: 0, stdout: lifecycleJsonl(), stderr: '', error: null };
      }
      throw new Error(`unexpected spawn: ${bin} ${JSON.stringify(args)}`);
    };

    try {
      const resolved = await providers.resolveProvider({
        env: {},
        providerCache: {},
        homeDir: home,
        cwd: home,
        providersStatePath: path.join(home, '.auxilo', 'providers.json'),
        existsSync: () => false,
        spawnSyncImpl,
      });
      assert.equal(resolved.ok, true);
      assert.equal(resolved.id, 'claude-code', "detect() must read 'unknown' as usable — the W1 P1 fix");

      const result = await providers.runModel({
        env: {},
        providerCache: {},
        mode: 'extract',
        prompt: 'P',
        input: 'T',
        homeDir: home,
        cwd: home,
        providersStatePath: path.join(home, '.auxilo', 'providers.json'),
        existsSync: (p) => p === codexBinPath,
        spawnSyncImpl,
        outputPath,
      });
      assert.equal(result.ok, false);
      assert.equal(result.reasonCode, 'no-usable-provider');
      assert.doesNotMatch(result.reason, /codex-cli=/);
    } finally {
      codexCli._resetVersionCacheForTests();
      cleanupTempDirs();
    }
  });
});

// ─── fixture (d) ─────────────────────────────────────────────────────────
// env override to a logged-out provider → no fall-through, reason reported.

describe('EXTRACT-PER-CLIENT W1 P1 fixture (d): AUXILO_EXTRACTION_PROVIDER override to a logged-out provider', () => {
  it('reports the provider\'s own cli-unauthenticated reason as-is; codex-cli is never tried', async () => {
    const home = tempDir('auxilo-fixture-d-');
    let codexSpawned = false;
    const spawnSyncImpl = (bin, args) => {
      const base = path.basename(bin);
      if (base === 'claude' && args[0] === 'auth') {
        return { status: 0, stdout: JSON.stringify({ loggedIn: false }), stderr: '' };
      }
      if (base === 'codex') {
        codexSpawned = true;
        throw new Error('codex must never be tried under an explicit AUXILO_EXTRACTION_PROVIDER override');
      }
      throw new Error(`unexpected spawn: ${bin} ${JSON.stringify(args)}`);
    };
    try {
      const result = await providers.runModel({
        env: { AUXILO_EXTRACTION_PROVIDER: 'claude-code' },
        providerCache: {},
        mode: 'extract',
        prompt: 'P',
        input: 'T',
        homeDir: home,
        cwd: home,
        existsSync: () => false,
        spawnSyncImpl,
      });
      assert.equal(result.ok, false);
      assert.equal(result.reasonCode, 'cli-unauthenticated');
      assert.notEqual(result.reasonCode, 'no-usable-provider', 'an explicit override never falls through to the exhaustion summary');
      assert.equal(codexSpawned, false);
    } finally {
      cleanupTempDirs();
    }
  });
});

// ─── fixture (e) ─────────────────────────────────────────────────────────
// billing helper configured → claude skipped, codex remains dark.

describe('EXTRACT-PER-CLIENT W1 P1 fixture (e): a foreign-billing CLI helper is configured', () => {
  it('claude-code is skipped entirely at the detect() stage and codex-cli is never invoked automatically', async () => {
    const home = tempDir('auxilo-fixture-e-');
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ apiKeyHelper: '/bin/get-key' }));
    withCodexAuth(home, 'chatgpt');
    const codexBinPath = withCodexBin(home);
    const outputPath = path.join(home, 'codex-out.txt');
    fs.writeFileSync(outputPath, JSON.stringify({ learnings: [] }));

    let claudeSpawned = false;
    const spawnSyncImpl = (bin, args) => {
      const base = path.basename(bin);
      if (base === 'claude') {
        claudeSpawned = true;
        throw new Error('claude must never be spawned once the billing-helper detector trips');
      }
      if (base === 'codex' && args[0] === '--version') {
        return { status: 0, stdout: 'codex-cli 0.144.5', stderr: '', error: null };
      }
      if (base === 'codex' && args[0] === 'exec') {
        return { status: 0, stdout: lifecycleJsonl(), stderr: '', error: null };
      }
      throw new Error(`unexpected spawn: ${bin} ${JSON.stringify(args)}`);
    };

    try {
      const result = await providers.runModel({
        env: {},
        providerCache: {},
        mode: 'extract',
        prompt: 'P',
        input: 'T',
        homeDir: home,
        cwd: home,
        providersStatePath: path.join(home, '.auxilo', 'providers.json'),
        existsSync: (p) => p === codexBinPath,
        spawnSyncImpl,
        outputPath,
      });
      assert.equal(result.ok, false);
      assert.equal(result.reasonCode, 'no-usable-provider');
      assert.doesNotMatch(result.reason, /codex-cli=/);
      assert.equal(claudeSpawned, false, 'claude-code must be skipped entirely, not merely attempted and failed');
    } finally {
      codexCli._resetVersionCacheForTests();
      cleanupTempDirs();
    }
  });
});

// ─── fixture (f) ─────────────────────────────────────────────────────────
// persisted selected=claude-code gone stale → automatic re-detect skips codex.

describe('EXTRACT-PER-CLIENT W1 P1 fixture (f): a persisted selection has gone stale', () => {
  it('re-detects, logs one line, and reports no automatic provider without selecting codex', async () => {
    const home = tempDir('auxilo-fixture-f-');
    const statePath = path.join(home, '.auxilo', 'providers.json');
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify({ selected: 'claude-code' }));

    withCodexAuth(home, 'chatgpt');
    const codexBinPath = withCodexBin(home);

    const spawnSyncImpl = (bin, args) => {
      const base = path.basename(bin);
      if (base === 'claude' && args[0] === 'auth') {
        return { status: 0, stdout: JSON.stringify({ loggedIn: false }), stderr: '' }; // stale — no longer usable
      }
      throw new Error(`unexpected spawn: ${bin} ${JSON.stringify(args)}`);
    };

    const loggedLines = [];
    try {
      const resolved = await providers.resolveProvider({
        env: {},
        providerCache: {},
        homeDir: home,
        cwd: home,
        providersStatePath: statePath,
        existsSync: (p) => p === codexBinPath,
        spawnSyncImpl,
        log: (line) => loggedLines.push(line),
      });
      assert.equal(resolved.ok, false);
      assert.doesNotMatch(resolved.reason, /codex-cli/);
      assert.ok(
        loggedLines.some((l) => /persisted selection "claude-code" is no longer usable/.test(l)),
        'must log one line noting the stale persisted choice, not fail silently'
      );
      const written = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      assert.equal(written.selected, 'claude-code', 'no replacement is persisted when no automatic provider is usable');
    } finally {
      cleanupTempDirs();
    }
  });

  it('a persisted codex-cli selection is retired instead of taking the automatic fast path', async () => {
    const home = tempDir('auxilo-fixture-f-fastpath-');
    const statePath = path.join(home, '.auxilo', 'providers.json');
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify({ selected: 'codex-cli' }));
    withCodexAuth(home, 'chatgpt');
    const codexBinPath = withCodexBin(home);

    const resolved = await providers.resolveProvider({
      env: {},
      providerCache: {},
      homeDir: home,
      cwd: home,
      providersStatePath: statePath,
      existsSync: (p) => p === codexBinPath,
      spawnSyncImpl: () => ({ status: 0, stdout: JSON.stringify({ loggedIn: false }), stderr: '' }),
    });
    try {
      assert.equal(resolved.ok, false);
      assert.doesNotMatch(resolved.reason, /codex-cli/);
      assert.equal(Object.prototype.hasOwnProperty.call(JSON.parse(fs.readFileSync(statePath, 'utf8')), 'selected'), false);
    } finally {
      cleanupTempDirs();
    }
  });
});

// ─── fall-through boundary: timeouts/model errors do NOT fall through ─────

describe('EXTRACT-PER-CLIENT W1 P1: a working provider that merely failed once does not trigger fall-through', () => {
  it('claude-code selected + logged-in, real run returns reasonCode model-error -> returned as-is, codex-cli never tried', async () => {
    const home = tempDir('auxilo-fallthrough-boundary-');
    let codexSpawned = false;
    const spawnSyncImpl = (bin, args) => {
      const base = path.basename(bin);
      if (base === 'claude' && args[0] === 'auth') {
        return { status: 0, stdout: JSON.stringify({ loggedIn: true }), stderr: '' };
      }
      if (base === 'claude' && args[0] === '-p') {
        return { status: 1, stdout: 'a real model error, unrelated to auth', stderr: '' };
      }
      if (base === 'codex') {
        codexSpawned = true;
        throw new Error('codex must never be tried after a non-retryable-for-this-provider-set failure');
      }
      throw new Error(`unexpected spawn: ${bin} ${JSON.stringify(args)}`);
    };
    try {
      const result = await providers.runModel({
        env: {},
        providerCache: {},
        mode: 'extract',
        prompt: 'P',
        input: 'T',
        homeDir: home,
        cwd: home,
        providersStatePath: path.join(home, '.auxilo', 'providers.json'),
        existsSync: () => false,
        spawnSyncImpl,
      });
      assert.equal(result.ok, false);
      assert.equal(result.reasonCode, 'model-error');
      assert.notEqual(result.reasonCode, 'no-usable-provider');
      assert.equal(codexSpawned, false);
    } finally {
      cleanupTempDirs();
    }
  });
});

describe('CLAUDE-CHILD-MCP-CONTEXT — provider selection', () => {
  it('T6: enterprise MCP refusal never falls through to an available Codex route', async () => {
    const home = tempDir('auxilo-mcp-refusal-selection-');
    withCodexAuth(home);
    const codexBin = withCodexBin(home);
    try {
      assert.equal(codexCli.detect({ homeDir: home }), true);
      for (const mode of ['extract', 'judge']) {
        let codexCalls = 0;
        let claudeModelCalls = 0;
        const result = await providers.runModel({
          env: {}, providerCache: {}, mode, prompt: 'fixture', homeDir: home, cwd: home,
          claudeBin: 'claude', providersStatePath: path.join(home, 'providers.json'),
          existsSync: p => p === codexBin,
          spawnSyncImpl: (bin, args) => {
            if (path.basename(bin) === 'codex') {
              codexCalls += 1;
              return { status: 1, stdout: '', stderr: 'unexpected fallback' };
            }
            if (args[0] === 'auth') return { status: 0, stdout: '{"loggedIn":true}', stderr: '' };
            claudeModelCalls += 1;
            return { status: 1, stdout: '', stderr: 'You cannot use --strict-mcp-config when an enterprise MCP config is present' };
          },
        });
        assert.equal(result.reasonCode, 'isolation-unverified');
        assert.equal(claudeModelCalls, 1);
        assert.equal(codexCalls, 0);
      }
    } finally { cleanupTempDirs(); }
  });
});

describe('EXTRACT-PER-CLIENT W1 P1: NON_RETRYABLE_FOR_THIS_PROVIDER — the exact fall-through set', () => {
  it('is exactly the six named reasonCodes, no more, no less (EXTRACTION-CHILD-HOOKS 0.9.15 adds cli-settings-isolation-unsupported)', () => {
    assert.deepEqual(
      Array.from(providers.NON_RETRYABLE_FOR_THIS_PROVIDER).sort(),
      [
        'cli-billing-helper-configured',
        'cli-not-installed',
        'cli-settings-isolation-unsupported',
        'cli-unauthenticated',
        'provider-not-configured',
        'providers-file-mode-unsafe',
      ].sort()
    );
  });
});

// ─── EPC2-2 E0: automatic Codex invocation disabled ──────────────────────

describe('EPC2-2 E0: provider registry and automatic walk', () => {
  it('T1: known provider ids and automatic provider order are distinct frozen exports, and PROVIDER_ORDER is retired', () => {
    assert.deepEqual(providers.KNOWN_PROVIDER_IDS, ['claude-code', 'codex-cli', 'byo-key']);
    assert.deepEqual(providers.AUTOMATIC_PROVIDER_ORDER, ['claude-code', 'byo-key']);
    assert.equal(Object.isFrozen(providers.KNOWN_PROVIDER_IDS), true);
    assert.equal(Object.isFrozen(providers.AUTOMATIC_PROVIDER_ORDER), true);
    assert.equal(Object.prototype.hasOwnProperty.call(providers, 'PROVIDER_ORDER'), false);
  });

  it('T2: every automatic non-retryable Claude failure skips Codex when no BYO key exists, in extract and judge modes', async () => {
    const home = tempDir('auxilo-e0-t2-');
    let codexRuns = 0;
    try {
      await withProviderMethodStubs([
        [claudeCode, {
          detect: async () => true,
          runModel: async (opts) => ({ ok: false, text: '', usage: null, reasonCode: opts.testReasonCode, reason: 'claude unavailable', authStatus: 'logged-out' }),
        }],
        [codexCli, {
          detect: () => true,
          runModel: async () => {
            codexRuns += 1;
            return { ok: false, text: '', usage: null, reasonCode: 'model-error', reason: 'must stay dark', authStatus: 'logged-in' };
          },
        }],
        [byoKey, {
          detect: () => false,
          runModel: async () => ({ ok: false, text: '', usage: null, reasonCode: 'provider-not-configured', reason: 'no key', authStatus: 'unknown' }),
        }],
      ], async () => {
        for (const reasonCode of [
          'cli-unauthenticated',
          'cli-not-installed',
          'cli-billing-helper-configured',
          'provider-not-configured',
          'providers-file-mode-unsafe',
          'cli-settings-isolation-unsupported',
        ]) {
          for (const mode of ['extract', 'judge']) {
            const result = await providers.runModel({
              env: {}, providerCache: {}, mode, testReasonCode: reasonCode,
              providersStatePath: path.join(home, `${reasonCode}-${mode}.json`),
              log: () => {},
            });
            assert.equal(result.ok, false, `${mode}/${reasonCode} must fail without a BYO key`);
          }
        }
      });
      assert.equal(codexRuns, 0);
    } finally {
      cleanupTempDirs();
    }
  });

  it('T3: every automatic non-retryable Claude failure falls through to configured BYO, never Codex, in extract and judge modes', async () => {
    const home = tempDir('auxilo-e0-t3-');
    const statePath = path.join(home, '.auxilo', 'providers.json');
    writeProvidersState(statePath, {
      byo: { provider: 'openai', model: 'fixture-model', api_key: 'fixture-key' },
    });
    let codexRuns = 0;
    try {
      await withProviderMethodStubs([
        [claudeCode, {
          detect: async () => true,
          runModel: async (opts) => ({ ok: false, text: '', usage: null, reasonCode: opts.testReasonCode, reason: 'claude unavailable', authStatus: 'logged-out' }),
        }],
        [codexCli, {
          detect: () => true,
          runModel: async () => {
            codexRuns += 1;
            return { ok: false, text: '', usage: null, reasonCode: 'model-error', reason: 'must stay dark', authStatus: 'logged-in' };
          },
        }],
      ], async () => {
        for (const reasonCode of [
          'cli-unauthenticated',
          'cli-not-installed',
          'cli-billing-helper-configured',
          'provider-not-configured',
          'providers-file-mode-unsafe',
          'cli-settings-isolation-unsupported',
        ]) {
          for (const mode of ['extract', 'judge']) {
            const result = await providers.runModel({
              env: {}, providerCache: {}, mode, testReasonCode: reasonCode,
              providersStatePath: statePath,
              fetchImpl: async () => successfulByoResponse(`${mode}-${reasonCode}`),
              log: () => {},
            });
            assert.equal(result.ok, true, `${mode}/${reasonCode} must reach configured BYO`);
            assert.equal(result.identity.provider, 'byo-key');
          }
        }
      });
      assert.equal(codexRuns, 0);
    } finally {
      cleanupTempDirs();
    }
  });

  it('T4: persisted codex-cli is cleared in memory and on disk while BYO and unrelated state survive byte-for-byte', async () => {
    const home = tempDir('auxilo-e0-t4-');
    const statePath = path.join(home, '.auxilo', 'providers.json');
    const byo = { provider: 'openai', model: 'fixture-model', api_key: 'fixture-key' };
    writeProvidersState(statePath, { selected: 'codex-cli', byo, unrelated: { keep: ['exactly', 1] } });
    let codexCalls = 0;
    try {
      const resolved = await withProviderMethodStubs([
        [claudeCode, { detect: async () => false }],
        [codexCli, {
          detect: () => { codexCalls += 1; return true; },
          runModel: async () => { codexCalls += 1; return { ok: true, text: 'wrong' }; },
        }],
      ], () => providers.resolveProvider({ env: {}, providerCache: {}, providersStatePath: statePath, log: () => {} }));
      assert.equal(resolved.ok, true);
      assert.equal(resolved.id, 'byo-key');
      assert.equal(codexCalls, 0);
      const written = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      assert.notEqual(written.selected, 'codex-cli');
      assert.deepEqual(written.byo, byo);
      assert.deepEqual(written.unrelated, { keep: ['exactly', 1] });
    } finally {
      cleanupTempDirs();
    }
  });

  it('T5: a failed persisted-codex migration stays ineligible across fresh caches and logs only the fixed bounded message', async () => {
    const home = tempDir('auxilo-e0-t5-');
    const statePath = path.join(home, '.auxilo', 'providers.json');
    writeProvidersState(statePath, { selected: 'codex-cli', unrelated: true });
    const lines = [];
    let codexRuns = 0;
    try {
      await withProviderMethodStubs([
        [claudeCode, {
          detect: async () => false,
          runModel: async () => ({ ok: false, text: '', usage: null, reasonCode: 'cli-unauthenticated', reason: 'no claude', authStatus: 'logged-out' }),
        }],
        [codexCli, {
          detect: () => true,
          runModel: async () => { codexRuns += 1; return { ok: true, text: 'wrong' }; },
        }],
        [byoKey, {
          detect: () => false,
          runModel: async () => ({ ok: false, text: '', usage: null, reasonCode: 'provider-not-configured', reason: 'no key', authStatus: 'unknown' }),
        }],
      ], async () => {
        for (let i = 0; i < 2; i += 1) {
          const result = await providers.runModel({
            env: {}, providerCache: {}, providersStatePath: statePath,
            lstatSyncImpl: () => ({ isFile: () => false, uid: typeof process.getuid === 'function' ? process.getuid() : 0 }),
            log: (line) => lines.push(line),
          });
          assert.equal(result.ok, false);
        }
      });
      assert.equal(codexRuns, 0);
      assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).selected, 'codex-cli');
      const migrationLines = lines.filter((line) => line === '[providers] could not clear retired automatic codex-cli selection; continuing without it');
      assert.equal(migrationLines.length, 2);
      assert.equal(migrationLines.some((line) => line.includes(statePath)), false);
    } finally {
      cleanupTempDirs();
    }
  });

  it('T6: a usable persisted BYO selection still starts at BYO and is not discarded while Claude is usable', async () => {
    const home = tempDir('auxilo-e0-t6-');
    const statePath = path.join(home, '.auxilo', 'providers.json');
    writeProvidersState(statePath, {
      selected: 'byo-key',
      byo: { provider: 'openai', model: 'fixture-model', api_key: 'fixture-key' },
    });
    let claudeCalls = 0;
    let codexCalls = 0;
    try {
      const result = await withProviderMethodStubs([
        [claudeCode, {
          detect: async () => { claudeCalls += 1; return true; },
          runModel: async () => { claudeCalls += 1; return { ok: true, text: 'wrong' }; },
        }],
        [codexCli, {
          detect: () => { codexCalls += 1; return true; },
          runModel: async () => { codexCalls += 1; return { ok: true, text: 'wrong' }; },
        }],
      ], () => providers.runModel({
        env: {}, providerCache: {}, providersStatePath: statePath,
        fetchImpl: async () => successfulByoResponse('byo-first'),
      }));
      assert.equal(result.ok, true);
      assert.equal(result.identity.provider, 'byo-key');
      assert.equal(claudeCalls, 0);
      assert.equal(codexCalls, 0);
      assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).selected, 'byo-key');
    } finally {
      cleanupTempDirs();
    }
  });

  it('T7: explicit codex-cli override invokes Codex once per mode and never falls through on failure', async () => {
    let codexRuns = 0;
    let otherRuns = 0;
    await withProviderMethodStubs([
      [claudeCode, { runModel: async () => { otherRuns += 1; return { ok: true, text: 'wrong' }; } }],
      [codexCli, {
        runModel: async () => {
          codexRuns += 1;
          return { ok: false, text: '', usage: null, reasonCode: 'model-error', reason: 'fixture failure', authStatus: 'logged-in' };
        },
      }],
      [byoKey, { runModel: async () => { otherRuns += 1; return { ok: true, text: 'wrong' }; } }],
    ], async () => {
      for (const mode of ['extract', 'judge']) {
        const before = codexRuns;
        const result = await providers.runModel({ env: { AUXILO_EXTRACTION_PROVIDER: 'codex-cli' }, mode });
        assert.equal(result.ok, false);
        assert.equal(result.reasonCode, 'model-error');
        assert.equal(codexRuns, before + 1);
      }
    });
    assert.equal(otherRuns, 0);
  });

  it('T8: unknown override errors list every known id and the CLI validator accepts codex-cli', async () => {
    const expectedIds = 'claude-code, codex-cli, byo-key';
    const registryResult = await providers.resolveProvider({ env: { AUXILO_EXTRACTION_PROVIDER: 'unknown-provider' } });
    assert.equal(registryResult.ok, false);
    assert.match(registryResult.reason, new RegExp(expectedIds));

    const cli = require('../bin/auxilo-cli.js');
    const original = process.env.AUXILO_EXTRACTION_PROVIDER;
    try {
      process.env.AUXILO_EXTRACTION_PROVIDER = 'unknown-provider';
      const cliError = cli.lastRecordedProviderResolution();
      assert.equal(cliError.ok, false);
      assert.match(cliError.reason, new RegExp(expectedIds));

      process.env.AUXILO_EXTRACTION_PROVIDER = 'codex-cli';
      assert.deepEqual(cli.lastRecordedProviderResolution(), { ok: true, id: 'codex-cli' });
    } finally {
      if (original === undefined) delete process.env.AUXILO_EXTRACTION_PROVIDER;
      else process.env.AUXILO_EXTRACTION_PROVIDER = original;
    }
  });

  it('T9: a transient Claude failure reaches neither BYO nor Codex in extract and judge modes', async () => {
    let codexRuns = 0;
    let byoRuns = 0;
    try {
      await withProviderMethodStubs([
        [claudeCode, {
          detect: async () => true,
          runModel: async () => ({ ok: false, text: '', usage: null, reasonCode: 'model-error', reason: 'transient', authStatus: 'logged-in' }),
        }],
        [codexCli, { runModel: async () => { codexRuns += 1; return { ok: true, text: 'wrong' }; } }],
        [byoKey, { runModel: async () => { byoRuns += 1; return { ok: true, text: 'wrong' }; } }],
      ], async () => {
        for (const mode of ['extract', 'judge']) {
          const result = await providers.runModel({ env: {}, providerCache: {}, mode, providersStatePath: path.join(tempDir('auxilo-e0-t9-'), 'providers.json') });
          assert.equal(result.reasonCode, 'model-error');
        }
      });
      assert.equal(codexRuns, 0);
      assert.equal(byoRuns, 0);
    } finally {
      cleanupTempDirs();
    }
  });

  it('T10: a codex-cli override does not leak into the next automatic resolution in the same process', async () => {
    const providerCache = {};
    let codexRuns = 0;
    try {
      await withProviderMethodStubs([
        [claudeCode, {
          detect: async () => true,
          runModel: async () => ({ ok: false, text: '', usage: null, reasonCode: 'cli-unauthenticated', reason: 'no claude', authStatus: 'logged-out' }),
        }],
        [codexCli, {
          runModel: async () => {
            codexRuns += 1;
            return { ok: false, text: '', usage: null, reasonCode: 'model-error', reason: 'override fixture', authStatus: 'logged-in' };
          },
        }],
        [byoKey, {
          detect: () => false,
          runModel: async () => ({ ok: false, text: '', usage: null, reasonCode: 'provider-not-configured', reason: 'no key', authStatus: 'unknown' }),
        }],
      ], async () => {
        const overrideResult = await providers.runModel({ env: { AUXILO_EXTRACTION_PROVIDER: 'codex-cli' }, providerCache });
        assert.equal(overrideResult.ok, false);
        assert.equal(codexRuns, 1);

        const automaticResult = await providers.runModel({
          env: {}, providerCache,
          providersStatePath: path.join(tempDir('auxilo-e0-t10-'), 'providers.json'),
          log: () => {},
        });
        assert.equal(automaticResult.ok, false);
        assert.equal(codexRuns, 1);
      });
    } finally {
      cleanupTempDirs();
    }
  });
});

describe('EPC2-2 E0: approved CLI strings', () => {
  it('T11: CONSENT_TEXT contains the approved EXTRACTS bullet and every other source line remains pinned', () => {
    const match = /const CONSENT_TEXT = `\n([\s\S]*?)\n`;/u.exec(CLI_SOURCE);
    assert.ok(match, 'CONSENT_TEXT source block must exist');
    const expectedLines = [
      '  Background extraction (optional)',
      '  --------------------------------',
      '  If you opt in, a session-end hook runs after each session in your wired',
      '  clients (Claude Code, Cursor, Gemini CLI, …) and a local runner:',
      '    • READS the session transcript on your machine,',
      '    • SCRUBS it locally (sensitivity filter: API keys, tokens, emails, PII',
      '      are redacted first),',
      '    • EXTRACTS reusable learnings locally through Claude Code, when you',
      '      are signed in to it, or a provider key you set yourself. For this',
      '      step your scrubbed transcript goes only to that provider, under',
      '      your own account with them, and any use is charged to that',
      '      account, never to Auxilo. It is never sent to Auxilo, raw or',
      '      scrubbed.',
      '    • UPLOADS only the finished learning drafts (title, body, category,',
      "      tags, task context, outcome) to Auxilo (${'POST /learn'}). Everything",
      '      waits in your review queue until you approve it, one learning at a',
      '      time or in advance in your dashboard. Your first public learning',
      '      waits for operator review. A draft that any screen flags (sensitive,',
      '      duplicate, uncertain quality) waits in your private queue for',
      '      \\`auxilo review\\`. Auto-publish for learnings that pass every screen is',
      '      off unless you turn it on in your dashboard. Your share of a paid',
      '      unlock by another agent goes to your Auxilo account, 70% of what they',
      '      paid on a direct unlock and 60% via discovery. A repeat unlock by the',
      '      same buyer within 30 days earns nothing. Earnings depend on whether',
      '      other agents unlock your learnings and are not guaranteed. Earnings',
      '      accrue now. Withdrawals open soon, and auxilo.io/status shows where',
      '      things stand.',
      '    • UPDATES itself once a day from npm. A newer version installs only after',
      '      its signature and checksum both pass, and if either fails you keep the',
      '      copy you have. Run auxilo setup --no-autoupdate to decline. auxilo',
      '      status shows the setting and the last check.',
      '  You can stop any time with \\`auxilo disable\\` (local kill-switch) and review',
      '  every run in ~/.auxilo/extract.log. Saying No installs the MCP server only.',
      '  No session-end capture hook is written into any client config unless you say',
      '  Yes, and any capture hooks left by an earlier install are removed.',
    ];
    assert.deepEqual(match[1].split('\n'), expectedLines);
    assert.doesNotMatch(match[1], /Codex/);
    assert.doesNotMatch(match[1], /when neither is available/);
  });

  it('T12: provider help contains the approved BYO paragraph and retires the Codex fixed-order claim', () => {
    const cli = require('../bin/auxilo-cli.js');
    let output = '';
    const originalLog = console.log;
    try {
      console.log = (value) => { output += String(value); };
      cli.usage('provider');
    } finally {
      console.log = originalLog;
    }
    const approved = 'Configure a bring-your-own (BYO) model provider key for local extraction.\nClaude Code drafts first when you are signed in to it; your key only\ntakes over when Claude Code is not usable, and once it does, it keeps\ndrafting even after Claude Code becomes usable again. Auxilo never sees\nor bills this key.';
    assert.equal(output.includes(approved), true);
    assert.match(output, /Auxilo never sees\nor bills this key\./);
    assert.doesNotMatch(output, /codex-cli/);
    assert.doesNotMatch(output, /fixed order/);
  });

  it('T13: provider-set confirmation equals the approved fixed-value literal, including its leading newline', () => {
    const match = /console\.log\(`(\\n✓ Saved to \$\{written\}[^`]+)`\);/u.exec(CLI_SOURCE);
    assert.ok(match, 'provider set confirmation template must exist');
    const rendered = match[1]
      .replace(/^\\n/u, '\n')
      .replace('${written}', '/tmp/providers.json')
      .replace('${vendor}', 'anthropic');
    assert.equal(
      rendered,
      '\n✓ Saved to /tmp/providers.json (mode 0600). This machine drafts through Claude Code first when you are signed in to it; your anthropic key only takes over when Claude Code is not usable, and once it does, it keeps drafting even after Claude Code becomes usable again.'
    );
  });
});
