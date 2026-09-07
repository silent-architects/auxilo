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
const codexCli = require('../scripts/providers/codex-cli.js');
const runner = require('../scripts/runner.js');

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

// ─── fixture (a) ─────────────────────────────────────────────────────────
// claude installed + logged-out, codex auth present → codex-cli selected,
// extraction proceeds.

describe('EXTRACT-PER-CLIENT W1 P1 fixture (a): claude installed+logged-out, codex authenticated', () => {
  it('resolveProvider picks codex-cli and runModel succeeds through it, never reaching byo-key', async () => {
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
        return { status: 0, stdout: '', stderr: '', error: null };
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
      assert.equal(result.ok, true);
      assert.equal(result.extraction_model && result.extraction_model.provider, 'codex-cli');
      assert.ok(
        spawnCalls.some((c) => path.basename(c.bin) === 'claude' && c.args[0] === 'auth'),
        'claude-code must actually have been tried (and found logged-out) before falling through'
      );
      assert.ok(
        !spawnCalls.some((c) => path.basename(c.bin) === 'claude' && c.args[0] !== 'auth'),
        'the real extraction spawn must never reach claude while it is logged-out'
      );
    } finally {
      codexCli._resetVersionCacheForTests();
      cleanupTempDirs();
    }
  });
});

// ─── fixture (b) ─────────────────────────────────────────────────────────
// claude logged-out, no codex, no key → no-usable-provider with the three
// reasons; transcript NOT marked in the content-sha ledger.

describe('EXTRACT-PER-CLIENT W1 P1 fixture (b): claude logged-out + no codex + no key', () => {
  it('providers.runModel exhausts all three providers, each with its own distinct reason', async () => {
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
      assert.match(result.reason, /codex-cli=cli-unauthenticated/);
      assert.match(result.reason, /byo-key=provider-not-configured/);
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
// cli-unauthenticated → falls through to codex in the same call.

describe("EXTRACT-PER-CLIENT W1 P1 fixture (c): claude auth status 'unknown' at detect(), but the real run is unauthenticated", () => {
  it('claude-code is selected (unknown reads as usable), fails cli-unauthenticated on the real run, and codex-cli picks it up in the SAME runModel() call', async () => {
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
        return { status: 0, stdout: '', stderr: '', error: null };
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
      assert.equal(result.ok, true);
      assert.equal(result.extraction_model && result.extraction_model.provider, 'codex-cli');
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
// billing helper configured → claude skipped, codex selected.

describe('EXTRACT-PER-CLIENT W1 P1 fixture (e): a foreign-billing CLI helper is configured', () => {
  it('claude-code is skipped entirely at the detect() stage; codex-cli is selected and never sees a claude spawn', async () => {
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
        return { status: 0, stdout: '', stderr: '', error: null };
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
      assert.equal(result.ok, true);
      assert.equal(result.extraction_model && result.extraction_model.provider, 'codex-cli');
      assert.equal(claudeSpawned, false, 'claude-code must be skipped entirely, not merely attempted and failed');
    } finally {
      codexCli._resetVersionCacheForTests();
      cleanupTempDirs();
    }
  });
});

// ─── fixture (f) ─────────────────────────────────────────────────────────
// persisted selected=claude-code gone stale → re-detect picks codex, file
// updated.

describe('EXTRACT-PER-CLIENT W1 P1 fixture (f): a persisted selection has gone stale', () => {
  it('re-detects instead of failing, logs one line, and overwrites the persisted file with the new pick', async () => {
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
      assert.equal(resolved.ok, true);
      assert.equal(resolved.id, 'codex-cli');
      assert.ok(
        loggedLines.some((l) => /persisted selection "claude-code" is no longer usable/.test(l)),
        'must log one line noting the stale persisted choice, not fail silently'
      );
      const written = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      assert.equal(written.selected, 'codex-cli', 'the persisted file must be overwritten with the newly re-detected choice');
    } finally {
      cleanupTempDirs();
    }
  });

  it('a persisted selection that is STILL usable skips re-probing earlier providers in PROVIDER_ORDER', async () => {
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
      // claude-code would need this to detect — proves it was never probed.
      spawnSyncImpl: () => { throw new Error('claude-code must not be probed when the persisted choice is still usable'); },
    });
    try {
      assert.equal(resolved.ok, true);
      assert.equal(resolved.id, 'codex-cli');
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
