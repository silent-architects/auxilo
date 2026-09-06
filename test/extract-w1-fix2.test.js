'use strict';
/*
 * test/extract-w1-fix2.test.js — EXTRACT-PER-CLIENT W1 pre-publish fix pass
 * (0.9.13), agent/extract-w1-fix2 branched from pm/integ-h @ 0507ef5.
 *
 * Covers every item in the GOV-3 extraction review
 * (~/.auxilo/handoffs/GOV3-EXTRACTION-W1-REVIEW-2026-09-06.md) not already
 * exercised by an existing suite, plus GATE-A item (a) (codex identity),
 * the GIVENS (--no-session-persistence on the extraction spawn — covered in
 * test/claude-code-provider.test.js and test/ext-0806b-silent-skip.test.js,
 * not duplicated here), and the three gated CLI consent strings.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const byoKey = require('../scripts/providers/byo-key.js');
const providersIndex = require('../scripts/providers/index.js');
const codexCli = require('../scripts/providers/codex-cli.js');
const claudeCode = require('../scripts/providers/claude-code.js');
const extractLocal = require('../scripts/extract-local.js');

const REPO = path.join(__dirname, '..');
const CLI_SRC = fs.readFileSync(path.join(REPO, 'bin', 'auxilo-cli.js'), 'utf8');

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
function statePathIn(dir) {
  return path.join(dir, 'providers.json');
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

// ─── GOV-3 item 1: ONE writer, post-rename chmod, api_key never rewritten ──

describe('GOV-3 item 1: index.js persistSelected routes through byo-key.js\'s writeProvidersStateAtomic', () => {
  it('a stale providers.json.tmp at 0644 does NOT survive as the final file mode — persistSelected fixes it post-rename', async () => {
    const dir = tempDir('auxilo-w1fix2-persist-mode-');
    try {
      const statePath = statePathIn(dir);
      byoKey.writeByoConfig({ provider: 'openai', model: 'gpt-4o-mini', api_key: 'sk-untouched' }, { providersStatePath: statePath });
      // Plant a stale .tmp at a wide mode, as a crashed prior run would leave it.
      fs.writeFileSync(`${statePath}.tmp`, JSON.stringify({ stale: true }), { mode: 0o644 });

      const cache = {};
      const resolved = await providersIndex.resolveProvider({
        env: {}, providerCache: cache, providersStatePath: statePath,
        homeDir: dir, cwd: dir,
        existsSync: () => false,
        spawnSyncImpl: () => ({ status: 0, stdout: JSON.stringify({ loggedIn: false }), stderr: '' }),
        fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'x' } }] }) }),
      });
      assert.equal(resolved.ok, true);
      assert.equal(resolved.id, 'byo-key');

      const mode = fs.statSync(statePath).mode & 0o777;
      assert.equal(mode, 0o600, 'persisted-selection write must leave the FINAL file at 0600, even with a wide-mode stale .tmp in play');
      assert.ok(!fs.existsSync(`${statePath}.tmp`), 'no leftover .tmp file');
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      assert.equal(state.selected, 'byo-key');
      assert.equal(state.byo.api_key, 'sk-untouched', 'persistSelected must never rewrite/lose a credential field it did not itself set');
    } finally {
      cleanupTempDirs();
    }
  });

  it('byo-key.js exports ONE writeProvidersStateAtomic that both writeByoConfig and index.js persistSelected route through', () => {
    assert.equal(typeof byoKey.writeProvidersStateAtomic, 'function');
    const indexSrc = fs.readFileSync(path.join(REPO, 'scripts', 'providers', 'index.js'), 'utf8');
    assert.match(indexSrc, /byoKey\.writeProvidersStateAtomic\(/, 'index.js persistSelected must call the shared writer, not a second copy of the tmp+rename dance');
    assert.doesNotMatch(indexSrc.split('function persistSelected')[1] || '', /\.tmp`[\s\S]{0,120}writeFileSync/, 'persistSelected must not hand-roll its own tmp write anymore');
  });
});

// ─── GOV-3 should-fix item 9: symlink guard on tmp create ──────────────────

describe('GOV-3 should-fix item 9: tmp-file symlink guard', () => {
  it('a pre-existing SYMLINK at providers.json.tmp is not followed — write still lands cleanly and the symlink is gone', () => {
    const dir = tempDir('auxilo-w1fix2-symlink-');
    try {
      const statePath = statePathIn(dir);
      const decoyTarget = path.join(dir, 'decoy-outside.json');
      fs.writeFileSync(decoyTarget, '{"pwned":true}');
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      fs.symlinkSync(decoyTarget, `${statePath}.tmp`);

      byoKey.writeByoConfig({ provider: 'openai', model: 'x', api_key: 'k' }, { providersStatePath: statePath });

      const decoyContent = fs.readFileSync(decoyTarget, 'utf8');
      assert.equal(decoyContent, '{"pwned":true}', 'the symlink target must never be written through');
      const finalContent = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      assert.equal(finalContent.byo.provider, 'openai');
      // A successful write renames tmp -> target, so nothing (symlink or
      // otherwise) is left at the .tmp path at all — that IS the guard
      // working: the planted symlink was unlinked, not followed, before a
      // fresh 'wx' create landed a real file there.
      assert.ok(!fs.existsSync(`${statePath}.tmp`), 'no leftover .tmp (symlink or otherwise)');
    } finally {
      cleanupTempDirs();
    }
  });

  it('writeProvidersStateAtomic source uses flag wx on the tmp create', () => {
    const src = fs.readFileSync(path.join(REPO, 'scripts', 'providers', 'byo-key.js'), 'utf8');
    assert.match(src, /flag:\s*'wx'/);
  });
});

// ─── GOV-3 item 3: base_url must be https:// ───────────────────────────────

describe('GOV-3 item 3: base_url must be https://', () => {
  it('isBaseUrlInsecure: false for https, true for http/ftp/garbage, false for absent', () => {
    assert.equal(byoKey.isBaseUrlInsecure('https://api.example.com'), false);
    assert.equal(byoKey.isBaseUrlInsecure('http://api.example.com'), true);
    assert.equal(byoKey.isBaseUrlInsecure('ftp://api.example.com'), true);
    assert.equal(byoKey.isBaseUrlInsecure('not a url'), true);
    assert.equal(byoKey.isBaseUrlInsecure(''), false);
    assert.equal(byoKey.isBaseUrlInsecure(null), false);
  });

  it('detect() is false when the stored base_url is http://', () => {
    const dir = tempDir('auxilo-w1fix2-baseurl-detect-');
    try {
      const statePath = statePathIn(dir);
      byoKey.writeByoConfig({ provider: 'openai', base_url: 'http://127.0.0.1:9999', model: 'x', api_key: 'k' }, { providersStatePath: statePath });
      assert.equal(byoKey.detect({ providersStatePath: statePath }), false);
    } finally {
      cleanupTempDirs();
    }
  });

  it('runModel() refuses with reasonCode provider-base-url-insecure and never calls fetch, even reached directly (no detect() gate, e.g. via an override)', async () => {
    const dir = tempDir('auxilo-w1fix2-baseurl-runmodel-');
    try {
      const statePath = statePathIn(dir);
      byoKey.writeByoConfig({ provider: 'anthropic', base_url: 'http://127.0.0.1:9999', model: 'x', api_key: 'sekret' }, { providersStatePath: statePath });
      let fetchCalled = false;
      const fetchImpl = async () => { fetchCalled = true; return { ok: true, status: 200, json: async () => ({}) }; };
      const result = await byoKey.runModel({ providersStatePath: statePath, prompt: 'p', fetchImpl });
      assert.equal(result.ok, false);
      assert.equal(result.reasonCode, 'provider-base-url-insecure');
      assert.equal(fetchCalled, false, 'must refuse before ever sending the transcript or key');
      assert.ok(!JSON.stringify(result).includes('sekret'));
    } finally {
      cleanupTempDirs();
    }
  });

  it('CLI: `provider set` --base-url http://... is refused with reasonCode provider-base-url-insecure before any prompt', () => {
    assert.match(CLI_SRC, /provider-base-url-insecure/);
    assert.match(CLI_SRC, /isBaseUrlInsecure\(baseUrl\)/);
  });
});

// ─── GOV-3 item 4: redirect:'error' on every provider fetch call ───────────

describe('GOV-3 item 4: fetch redirect handling', () => {
  it('byo-key.js runModel passes redirect:"error" to fetchImpl', async () => {
    const dir = tempDir('auxilo-w1fix2-redirect-');
    try {
      const statePath = statePathIn(dir);
      byoKey.writeByoConfig({ provider: 'openai', model: 'x', api_key: 'k' }, { providersStatePath: statePath });
      let capturedInit;
      const fetchImpl = async (url, init) => {
        capturedInit = init;
        return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) };
      };
      await byoKey.runModel({ providersStatePath: statePath, prompt: 'p', fetchImpl });
      assert.equal(capturedInit.redirect, 'error');
    } finally {
      cleanupTempDirs();
    }
  });

  it('a redirect response (fetchImpl throwing the same TypeError undici raises for redirect:"error") surfaces as ok:false, reasonCode provider-error — never silently followed', async () => {
    const dir = tempDir('auxilo-w1fix2-redirect-throw-');
    try {
      const statePath = statePathIn(dir);
      byoKey.writeByoConfig({ provider: 'openai', model: 'x', api_key: 'k' }, { providersStatePath: statePath });
      const fetchImpl = async () => { throw new TypeError('fetch failed'); };
      const result = await byoKey.runModel({ providersStatePath: statePath, prompt: 'p', fetchImpl });
      assert.equal(result.ok, false);
      assert.equal(result.reasonCode, 'provider-error');
    } finally {
      cleanupTempDirs();
    }
  });
});

// ─── GOV-3 should-fix item 8: response size cap ────────────────────────────

describe('GOV-3 should-fix item 8: response body size cap (2MB)', () => {
  function streamOf(chunks) {
    let i = 0;
    return {
      getReader() {
        return {
          async read() {
            if (i >= chunks.length) return { done: true, value: undefined };
            const value = chunks[i];
            i += 1;
            return { done: false, value };
          },
          async cancel() { i = chunks.length; },
        };
      },
    };
  }

  it('a declared Content-Length over the cap is rejected WITHOUT reading the body', async () => {
    const dir = tempDir('auxilo-w1fix2-sizecap-header-');
    try {
      const statePath = statePathIn(dir);
      byoKey.writeByoConfig({ provider: 'openai', model: 'x', api_key: 'k' }, { providersStatePath: statePath });
      let bodyTouched = false;
      const fetchImpl = async () => ({
        ok: true,
        status: 200,
        headers: { get: (h) => (h.toLowerCase() === 'content-length' ? String(3 * 1024 * 1024) : null) },
        json: async () => { bodyTouched = true; return {}; },
        body: { getReader: () => ({ read: async () => { bodyTouched = true; return { done: true, value: undefined }; } }) },
      });
      const result = await byoKey.runModel({ providersStatePath: statePath, prompt: 'p', fetchImpl });
      assert.equal(result.ok, false);
      assert.equal(result.reasonCode, 'provider-response-too-large');
      assert.equal(bodyTouched, false, 'a declared over-cap length must refuse before touching the body at all');
    } finally {
      cleanupTempDirs();
    }
  });

  it('a body with NO Content-Length that exceeds the cap is caught by the byte-counted streaming read', async () => {
    const dir = tempDir('auxilo-w1fix2-sizecap-stream-');
    try {
      const statePath = statePathIn(dir);
      byoKey.writeByoConfig({ provider: 'openai', model: 'x', api_key: 'k' }, { providersStatePath: statePath });
      const bigChunk = new Uint8Array(1024 * 1024); // 1MB per chunk, 3 chunks = 3MB > 2MB cap
      const fetchImpl = async () => ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        body: streamOf([bigChunk, bigChunk, bigChunk]),
      });
      const result = await byoKey.runModel({ providersStatePath: statePath, prompt: 'p', fetchImpl });
      assert.equal(result.ok, false);
      assert.equal(result.reasonCode, 'provider-response-too-large');
    } finally {
      cleanupTempDirs();
    }
  });

  it('a normal-sized streamed body still parses correctly (no false-positive cap trip)', async () => {
    const dir = tempDir('auxilo-w1fix2-sizecap-ok-');
    try {
      const statePath = statePathIn(dir);
      byoKey.writeByoConfig({ provider: 'openai', model: 'x', api_key: 'k' }, { providersStatePath: statePath });
      const payload = Buffer.from(JSON.stringify({ choices: [{ message: { content: 'hello' } }] }), 'utf8');
      const fetchImpl = async () => ({
        ok: true,
        status: 200,
        headers: { get: (h) => (h.toLowerCase() === 'content-length' ? String(payload.byteLength) : null) },
        body: streamOf([new Uint8Array(payload)]),
      });
      const result = await byoKey.runModel({ providersStatePath: statePath, prompt: 'p', fetchImpl });
      assert.equal(result.ok, true);
      assert.equal(result.text, 'hello');
    } finally {
      cleanupTempDirs();
    }
  });

  it('a fixture response with no stream body at all (this repo\'s test-fixture shape) still falls back to res.json() correctly', async () => {
    const dir = tempDir('auxilo-w1fix2-sizecap-fixture-');
    try {
      const statePath = statePathIn(dir);
      byoKey.writeByoConfig({ provider: 'openai', model: 'x', api_key: 'k' }, { providersStatePath: statePath });
      const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'fixture-ok' } }] }) });
      const result = await byoKey.runModel({ providersStatePath: statePath, prompt: 'p', fetchImpl });
      assert.equal(result.ok, true);
      assert.equal(result.text, 'fixture-ok');
    } finally {
      cleanupTempDirs();
    }
  });

  it('the abort timer is kept alive through the body read, not cleared at headers (source check: clearTimeout is not inside the fetch try/finally alone)', () => {
    const src = fs.readFileSync(path.join(REPO, 'scripts', 'providers', 'byo-key.js'), 'utf8');
    const fnStart = src.indexOf('async function runModel(opts = {})');
    const fn = src.slice(fnStart, fnStart + 6000);
    assert.match(fn, /const clearTimer = \(\) => \{ if \(timer\) clearTimeout\(timer\); \};/);
    // clearTimer() must be called from an OUTER finally that wraps the body
    // read too, not from a finally around the fetch() await alone.
    const outerFinallyIdx = fn.search(/\} finally \{\s*\n\s*clearTimer\(\);/);
    assert.ok(outerFinallyIdx > -1, 'clearTimer must run from the outer finally wrapping the whole call');
    // And that finally must come AFTER the body-read call (readBoundedJson),
    // not before it — otherwise the timer would still be cleared at headers.
    const boundedReadIdx = fn.indexOf('readBoundedJson(res)');
    assert.ok(boundedReadIdx > -1 && boundedReadIdx < outerFinallyIdx,
      'the body read must happen before the outer finally that clears the timer — i.e. inside the timer\'s lifetime');
  });
});

// ─── GOV-3 item 5: gemini key in header, never the URL ─────────────────────
// (Positive-control behavioral test lives in test/byo-key-provider.test.js,
// updated in this same change. This is the static-source control.)

describe('GOV-3 item 5: gemini key never in the URL (static control)', () => {
  it('buildRequest for gemini has no `key=` query construction left in source', () => {
    const src = fs.readFileSync(path.join(REPO, 'scripts', 'providers', 'byo-key.js'), 'utf8');
    assert.doesNotMatch(src, /key=\$\{encodeURIComponent\(config\.api_key\)\}/, 'the old query-string key construction must be gone');
    assert.match(src, /'x-goog-api-key':\s*config\.api_key/);
  });
});

// ─── GOV-3 item 6: managed-settings billing-helper detection ───────────────

describe('GOV-3 item 6: managed-settings billing-helper detection', () => {
  it('managedSettingsPathForPlatform returns the documented path per OS', () => {
    assert.equal(claudeCode.managedSettingsPathForPlatform({ platform: 'darwin' }), '/Library/Application Support/ClaudeCode/managed-settings.json');
    assert.equal(claudeCode.managedSettingsPathForPlatform({ platform: 'linux' }), '/etc/claude-code/managed-settings.json');
    assert.equal(claudeCode.managedSettingsPathForPlatform({ platform: 'win32' }), 'C:\\Program Files\\ClaudeCode\\managed-settings.json');
    assert.equal(claudeCode.managedSettingsPathForPlatform({ platform: 'freebsd' }), '/etc/claude-code/managed-settings.json', 'unknown platform falls back to the Linux path');
  });

  it('a managed-settings.json with a truthy apiKeyHelper is detected regardless of user/project files', () => {
    const dir = tempDir('auxilo-w1fix2-managed-helper-');
    try {
      const managedPath = path.join(dir, 'managed-settings.json');
      fs.writeFileSync(managedPath, JSON.stringify({ apiKeyHelper: '/usr/local/bin/foreign-billing.sh' }));
      const homeDir = tempDir('auxilo-w1fix2-managed-home-');
      const detected = claudeCode.detectBillingHelperConfigured({
        homeDir, cwd: homeDir, managedSettingsPath: managedPath,
        existsSyncImpl: (p) => p === managedPath || fs.existsSync(p),
        readFileSyncImpl: (p, enc) => (p === managedPath ? fs.readFileSync(managedPath, enc) : fs.readFileSync(p, enc)),
      });
      assert.equal(detected, true);
    } finally {
      cleanupTempDirs();
    }
  });

  it('a managed-settings.json that EXISTS but cannot be read fails CLOSED (helper-configured = true), unlike a malformed user/project file', () => {
    const dir = tempDir('auxilo-w1fix2-managed-unreadable-');
    try {
      const managedPath = path.join(dir, 'managed-settings.json');
      const homeDir = tempDir('auxilo-w1fix2-managed-unreadable-home-');
      const detected = claudeCode.detectBillingHelperConfigured({
        homeDir, cwd: homeDir, managedSettingsPath: managedPath,
        existsSyncImpl: (p) => (p === managedPath ? true : fs.existsSync(p)),
        readFileSyncImpl: (p, enc) => {
          if (p === managedPath) { const e = new Error('EACCES: permission denied'); e.code = 'EACCES'; throw e; }
          return fs.readFileSync(p, enc);
        },
      });
      assert.equal(detected, true, 'present-but-unreadable managed settings must fail closed');
    } finally {
      cleanupTempDirs();
    }
  });

  it('a malformed (unparseable) user-scope settings.json still fails OPEN (matches CLI behavior, item 14 note) — only the managed path fails closed', () => {
    const dir = tempDir('auxilo-w1fix2-user-malformed-');
    try {
      fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), 'not { valid json');
      const detected = claudeCode.detectBillingHelperConfigured({
        homeDir: dir, cwd: dir, managedSettingsPath: path.join(dir, 'nonexistent-managed-settings.json'),
        existsSyncImpl: (p) => fs.existsSync(p),
        readFileSyncImpl: (p, enc) => fs.readFileSync(p, enc),
      });
      assert.equal(detected, false, 'malformed USER settings.json must still read as "no helper", per the CLI\'s own fail-open behavior there');
    } finally {
      cleanupTempDirs();
    }
  });

  it('no managed-settings.json present, no user/project helper — reads clean', () => {
    const dir = tempDir('auxilo-w1fix2-managed-absent-');
    try {
      const detected = claudeCode.detectBillingHelperConfigured({
        homeDir: dir, cwd: dir, managedSettingsPath: path.join(dir, 'nonexistent-managed-settings.json'),
      });
      assert.equal(detected, false);
    } finally {
      cleanupTempDirs();
    }
  });

  it('doc citation: a comment above the managed paths cites the official managed-settings doc URL', () => {
    const src = fs.readFileSync(path.join(REPO, 'scripts', 'providers', 'claude-code.js'), 'utf8');
    assert.match(src, /code\.claude\.com\/docs\/en\/managed-settings/);
  });
});

// ─── GATE-A item (a): codex identity, deprecated extraction_model alias ───

describe('GATE-A item (a): codex-cli identity field (resolveExtractionModelIdentity reads `identity`, not `extraction_model`)', () => {
  it('codex-cli.js runModel() result carries BOTH `identity` and the deprecated `extraction_model` alias, byte-identical', async () => {
    const home = tempDir('auxilo-w1fix2-codex-identity-');
    try {
      fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
      fs.writeFileSync(path.join(home, '.codex', 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', OPENAI_API_KEY: null }));
      const outputPath = path.join(home, 'out.txt');
      fs.writeFileSync(outputPath, '{"learnings":[]}');
      codexCli._resetVersionCacheForTests();
      const spawnSyncImpl = (bin, args) => {
        if (args[0] === '--version') return { status: 0, stdout: 'codex-cli 0.144.5', stderr: '', error: null };
        return { status: 0, stdout: '', stderr: '', error: null };
      };
      const result = await codexCli.runModel({
        prompt: 'P', input: 'T', mode: 'extract', homeDir: home, codexBin: 'codex', outputPath, spawnSyncImpl,
      });
      assert.equal(result.ok, true);
      assert.deepEqual(result.identity, { provider: 'codex-cli', model: null, version: 'codex-cli 0.144.5', vendor: null });
      assert.deepEqual(result.extraction_model, result.identity, 'deprecated alias must be byte-identical to identity for one release');
    } finally {
      codexCli._resetVersionCacheForTests();
      cleanupTempDirs();
    }
  });

  it('extract-local.js resolveExtractionModelIdentity reads codex-cli\'s REAL version through `identity` end to end (previously fell back to version:null via the field-name mismatch)', async () => {
    const dir = tempDir('auxilo-w1fix2-e2e-identity-');
    const indexPath = path.join(dir, 'extracted-index.jsonl');
    fs.writeFileSync(indexPath, '');
    const home = tempDir('auxilo-w1fix2-e2e-identity-home-');
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(home, '.codex', 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', OPENAI_API_KEY: null }));
    const outputPath = path.join(home, 'out.txt');
    fs.writeFileSync(outputPath, JSON.stringify({ learnings: [{
      title: 'Retry with jittered backoff on 503 from the widget queue API',
      body: 'The widget queue API returns 503 under load with no Retry-After header; a jittered exponential backoff starting at 250ms with a 5-attempt cap clears transient overload without hammering the queue further.',
      category: 'code-execution', tags: ['retry'], task_context: 'fixture', outcome: 'success',
    }] }));
    codexCli._resetVersionCacheForTests();
    const originalEnv = process.env.AUXILO_EXTRACTION_PROVIDER;
    process.env.AUXILO_EXTRACTION_PROVIDER = 'codex-cli';
    try {
      const spawnSyncImpl = (bin, args) => {
        if (args[0] === '--version') return { status: 0, stdout: 'codex-cli 0.144.5', stderr: '', error: null };
        return { status: 0, stdout: '', stderr: '', error: null };
      };
      const result = await extractLocal.extractLocally('a synthetic transcript', 'claude-code', {
        indexPath, log: () => {}, spawnSyncImpl, homeDir: home, cwd: home, codexBin: 'codex', outputPath,
      });
      assert.equal(result.learnings.length, 1);
      assert.deepEqual(result.learnings[0].extraction_model, {
        provider: 'codex-cli', model: null, version: 'codex-cli 0.144.5', vendor: null,
      }, 'the real codex version must now reach the stamp, not the generic null-version fallback');
    } finally {
      codexCli._resetVersionCacheForTests();
      if (originalEnv === undefined) delete process.env.AUXILO_EXTRACTION_PROVIDER;
      else process.env.AUXILO_EXTRACTION_PROVIDER = originalEnv;
      cleanupTempDirs();
    }
  });

  it('provider.interface.js documents `identity` on RunModelResult', () => {
    const src = fs.readFileSync(path.join(REPO, 'scripts', 'providers', 'provider.interface.js'), 'utf8');
    assert.match(src, /@property\s+\{object\}\s+\[identity\]/);
  });
});

// ─── GOV-3 should-fix item 11: private codex temp dir + 0600 + cleanup ────

describe('GOV-3 should-fix item 11: codex -o file lands in a private 0700 dir, 0600 file, cleaned up on every exit', () => {
  it('makeOutputLocation (no opts.outputPath): creates a private auxilo-<pid>-<rand> dir under os.tmpdir() at 0700', () => {
    const created = [];
    const mkdirSyncImpl = (dir, opts) => { created.push({ dir, opts }); fs.mkdirSync(dir, opts); };
    const { outputPath, cleanupDir } = codexCli.makeOutputLocation({ mkdirSyncImpl }, 'extract');
    try {
      assert.ok(cleanupDir, 'a private dir must be created when no outputPath override is given');
      assert.equal(created.length, 1);
      assert.equal(created[0].opts.mode, 0o700);
      assert.match(path.basename(created[0].dir), /^auxilo-\d+-[0-9a-f]{12}$/);
      assert.equal(path.dirname(outputPath), cleanupDir);
      assert.ok(fs.existsSync(cleanupDir));
    } finally {
      try { fs.rmSync(cleanupDir, { recursive: true, force: true }); } catch { /* cleanup */ }
    }
  });

  it('a caller-supplied opts.outputPath bypasses directory creation entirely (cleanupDir is null)', () => {
    const { outputPath, cleanupDir } = codexCli.makeOutputLocation({ outputPath: '/tmp/whatever.txt' }, 'extract');
    assert.equal(outputPath, '/tmp/whatever.txt');
    assert.equal(cleanupDir, null);
  });

  it('a real (auto-generated) run cleans up BOTH the file and the private directory on success', async () => {
    const home = tempDir('auxilo-w1fix2-privdir-success-home-');
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(home, '.codex', 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', OPENAI_API_KEY: null }));
    codexCli._resetVersionCacheForTests();
    let capturedOutputPath;
    const spawnSyncImpl = (bin, args) => {
      if (args[0] === '--version') return { status: 0, stdout: 'codex-cli 0.144.5', stderr: '', error: null };
      const oIdx = args.indexOf('-o');
      capturedOutputPath = args[oIdx + 1];
      fs.writeFileSync(capturedOutputPath, '{"learnings":[]}');
      return { status: 0, stdout: '', stderr: '', error: null };
    };
    try {
      const result = await codexCli.runModel({ prompt: 'P', input: 'T', mode: 'extract', homeDir: home, codexBin: 'codex', spawnSyncImpl });
      assert.equal(result.ok, true);
      assert.ok(capturedOutputPath, 'a -o path must have been generated');
      assert.ok(!fs.existsSync(capturedOutputPath), 'the output file must be gone after the call');
      assert.ok(!fs.existsSync(path.dirname(capturedOutputPath)), 'the private directory must be gone after the call');
    } finally {
      codexCli._resetVersionCacheForTests();
      cleanupTempDirs();
    }
  });

  it('cleans up the private directory even on a FAILURE exit path (non-zero exit, no output written)', async () => {
    const home = tempDir('auxilo-w1fix2-privdir-fail-home-');
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(home, '.codex', 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', OPENAI_API_KEY: null }));
    codexCli._resetVersionCacheForTests();
    let capturedOutputPath;
    const spawnSyncImpl = (bin, args) => {
      const oIdx = args.indexOf('-o');
      if (oIdx > -1) capturedOutputPath = args[oIdx + 1];
      return { status: 1, stdout: 'boom', stderr: '', error: null, signal: null };
    };
    try {
      const result = await codexCli.runModel({ prompt: 'P', input: 'T', mode: 'extract', homeDir: home, codexBin: 'codex', spawnSyncImpl });
      assert.equal(result.ok, false);
      assert.equal(result.reasonCode, 'model-error');
      assert.ok(capturedOutputPath);
      assert.ok(!fs.existsSync(path.dirname(capturedOutputPath)), 'the private directory must be gone even on a failure path');
    } finally {
      codexCli._resetVersionCacheForTests();
      cleanupTempDirs();
    }
  });

  it('chmods the output file to 0600 before reading it (in case codex wrote it under a wider umask)', async () => {
    const home = tempDir('auxilo-w1fix2-privdir-chmod-home-');
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(home, '.codex', 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', OPENAI_API_KEY: null }));
    codexCli._resetVersionCacheForTests();
    const chmodCalls = [];
    const chmodSyncImpl = (p, mode) => { chmodCalls.push({ p, mode }); fs.chmodSync(p, mode); };
    const spawnSyncImpl = (bin, args) => {
      if (args[0] === '--version') return { status: 0, stdout: 'codex-cli 0.144.5', stderr: '', error: null };
      const oIdx = args.indexOf('-o');
      const outputPath = args[oIdx + 1];
      fs.writeFileSync(outputPath, '{"learnings":[]}', { mode: 0o644 });
      return { status: 0, stdout: '', stderr: '', error: null };
    };
    try {
      const result = await codexCli.runModel({ prompt: 'P', input: 'T', mode: 'extract', homeDir: home, codexBin: 'codex', spawnSyncImpl, chmodSyncImpl });
      assert.equal(result.ok, true);
      assert.ok(chmodCalls.some((c) => c.mode === 0o600), 'must chmod the output file to 0600 before reading');
    } finally {
      codexCli._resetVersionCacheForTests();
      cleanupTempDirs();
    }
  });
});

// ─── GOV-3 should-fix item 10: no stack traces, clean refusals ─────────────

describe('GOV-3 should-fix item 10: clean refusals instead of raw stack traces', () => {
  it('clearProvidersFile never throws — a non-ENOENT read error returns "unreadable"', () => {
    const dir = tempDir('auxilo-w1fix2-clear-unreadable-');
    try {
      const statePath = statePathIn(dir);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(statePath, JSON.stringify({ byo: { provider: 'openai', model: 'x', api_key: 'y' } }));
      const readFileSyncImpl = () => { const e = new Error('EACCES'); e.code = 'EACCES'; throw e; };
      let threw = false;
      let result;
      try {
        result = byoKey.clearProvidersFile({ providersStatePath: statePath, readFileSyncImpl });
      } catch {
        threw = true;
      }
      assert.equal(threw, false, 'clearProvidersFile must never throw (its own docblock contract)');
      assert.equal(result, 'unreadable');
    } finally {
      cleanupTempDirs();
    }
  });

  it('bin/auxilo-cli.js providersFileModeUnsafe fails CLOSED (returns true, never throws) on a non-ENOENT stat error', () => {
    const cli = require('../bin/auxilo-cli.js');
    // providersFileModeUnsafe(target) stats the real filesystem; point it at a
    // path whose parent directory does not exist at all to provoke ENOTDIR/
    // ENOENT-adjacent — but the real contract test is the source itself:
    // no bare `throw err;` left for the non-ENOENT branch.
    const src = fs.readFileSync(path.join(REPO, 'bin', 'auxilo-cli.js'), 'utf8');
    const start = src.indexOf('function providersFileModeUnsafe(target)');
    const fn = src.slice(start, start + 600);
    assert.doesNotMatch(fn, /if \(err && err\.code === 'ENOENT'\) return false;\s*throw err;/, 'the non-ENOENT branch must not rethrow');
    assert.match(fn, /return true;.*fail closed/is);
    assert.equal(typeof cli.providersFileModeUnsafe, 'function');
  });

  it('cmdProvider clear handles "unreadable" and "unresolved" outcomes with a clean exit(1), not a fallthrough success message', () => {
    assert.match(CLI_SRC, /providers-file-unreadable/);
    assert.match(CLI_SRC, /result === 'unresolved'/);
  });
});

// ─── GOV-3 should-fix item 12: `provider clear` help text ─────────────────

describe('GOV-3 should-fix item 12: provider clear help text matches keep-selected semantics', () => {
  it('no longer claims `clear` deletes the file outright', () => {
    assert.doesNotMatch(CLI_SRC, /clear\s+Delete ~\/\.auxilo\/providers\.json\.`/);
  });

  it('describes the actual behavior: removes the BYO key, keeps `selected`', () => {
    const start = CLI_SRC.indexOf("provider: `Usage: auxilo provider");
    const block = CLI_SRC.slice(start, start + 800);
    assert.match(block, /clear\s+Remove your BYO key/);
    assert.match(block, /Keeps your auto-detected provider selection/);
  });
});

// ─── GOV-3 note item 13: home directory must be absolute ──────────────────

describe('GOV-3 note item 13: os.homedir() must resolve to an absolute path', () => {
  it('isHomeUnresolved: true for a relative providersStatePath (simulates os.homedir() returning \'\'), false for an absolute one', () => {
    assert.equal(byoKey.isHomeUnresolved('.auxilo/providers.json'), true);
    assert.equal(byoKey.isHomeUnresolved(''), true);
    assert.equal(byoKey.isHomeUnresolved(undefined), true);
    assert.equal(byoKey.isHomeUnresolved('/Users/x/.auxilo/providers.json'), false);
  });

  it('detect() is false, runModel() refuses with reasonCode provider-home-unresolved, when providersStatePath resolves relative', async () => {
    const relativePath = '.auxilo-w1fix2-relative-providers.json'; // never actually created/read
    try {
      assert.equal(byoKey.detect({ providersStatePath: relativePath }), false);
      const result = await byoKey.runModel({ providersStatePath: relativePath, prompt: 'p' });
      assert.equal(result.ok, false);
      assert.equal(result.reasonCode, 'provider-home-unresolved');
    } finally {
      try { fs.unlinkSync(relativePath); } catch { /* in case anything wrote it */ }
    }
  });

  it('writeByoConfig throws a tagged error (reasonCode provider-home-unresolved) rather than silently writing a relative path', () => {
    const relativePath = '.auxilo-w1fix2-relative-write.json';
    try {
      assert.throws(
        () => byoKey.writeByoConfig({ provider: 'openai', model: 'x', api_key: 'k' }, { providersStatePath: relativePath }),
        (err) => err && err.reasonCode === 'provider-home-unresolved'
      );
      assert.ok(!fs.existsSync(relativePath), 'nothing must be written when the home directory cannot be resolved');
    } finally {
      try { fs.unlinkSync(relativePath); } catch { /* in case anything wrote it */ }
    }
  });

  it('clearProvidersFile returns "unresolved" (never throws) for a relative providersStatePath', () => {
    const result = byoKey.clearProvidersFile({ providersStatePath: '.auxilo-w1fix2-relative-clear.json' });
    assert.equal(result, 'unresolved');
  });

  it('the CLI catches the writeByoConfig throw and refuses cleanly with reasonCode provider-home-unresolved', () => {
    assert.match(CLI_SRC, /provider-home-unresolved/);
  });
});

// ─── STRINGS: gated CLI consent text, byte-for-byte pins ───────────────────

describe('STRINGS: bin/auxilo-cli.js CONSENT_TEXT — three gated replacements (byte-for-byte)', () => {
  const NEW_EXTRACTS_BULLET =
    '    • EXTRACTS reusable learnings locally through the first model client you\n' +
    '      have installed (Claude Code, then Codex) or, when neither is\n' +
    '      available, a provider key you set yourself. For this step your\n' +
    '      scrubbed transcript goes only to that provider, under your own\n' +
    '      account with them, and any use is charged to that account, never to\n' +
    '      Auxilo. It is never sent to Auxilo, raw or scrubbed.';

  const NEW_EARNINGS_BLOCK =
    '      \\`auxilo review\\`. Auto-publish for learnings that pass every screen is\n' +
    '      off unless you turn it on in your dashboard. Your share of a paid\n' +
    '      unlock by another agent goes to your Auxilo account, 70% of what they\n' +
    '      paid on a direct unlock and 60% via discovery. A repeat unlock by the\n' +
    '      same buyer within 30 days earns nothing. Earnings depend on whether\n' +
    '      other agents unlock your learnings and are not guaranteed. Earnings\n' +
    '      accrue now. Withdrawals open soon, and auxilo.io/status shows where\n' +
    '      things stand.';

  const OLD_EXTRACTS_BULLET_FRAGMENT = 'EXTRACTS reusable learnings locally using your own claude CLI';
  const OLD_MANUAL_MODE_LINE = 'Manual mode (approve first, for everything) is';
  const OLD_EARN_70_LINE = 'You earn 70% of sales.';

  it('positive control: the OLD EXTRACTS-bullet fragment appears exactly 0 times now (was 1)', () => {
    const count = (CLI_SRC.match(new RegExp(OLD_EXTRACTS_BULLET_FRAGMENT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
    assert.equal(count, 0);
  });

  it('the new EXTRACTS bullet appears byte-for-byte, exactly once', () => {
    const count = CLI_SRC.split(NEW_EXTRACTS_BULLET).length - 1;
    assert.equal(count, 1);
  });

  it('positive control: the OLD "Manual mode..." and "You earn 70%..." lines appear exactly 0 times now (each was 1)', () => {
    assert.equal((CLI_SRC.match(new RegExp(OLD_MANUAL_MODE_LINE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length, 0);
    assert.equal((CLI_SRC.match(new RegExp(OLD_EARN_70_LINE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length, 0);
  });

  it('the new earnings/auto-publish block appears byte-for-byte, exactly once, right after `auxilo review`.', () => {
    const count = CLI_SRC.split(NEW_EARNINGS_BLOCK).length - 1;
    assert.equal(count, 1);
  });

  it('the em dash after "MCP server only" is gone — replaced with a period, two grammatical sentences', () => {
    assert.doesNotMatch(CLI_SRC, /MCP server only —/);
    assert.match(CLI_SRC, /Saying No installs the MCP server only\.\n {2}No session-end capture hook is written into any client config unless you say/);
  });

  it('COPY-18 sentences already applied are untouched: the ruled review-queue sentence and the operator-review sentence still appear, in order', () => {
    const ruledIdx = CLI_SRC.indexOf('time or in advance in your dashboard.');
    const operatorIdx = CLI_SRC.indexOf('Your first public learning\n      waits for operator review.');
    assert.ok(ruledIdx > -1 && operatorIdx > -1 && operatorIdx > ruledIdx);
  });

  it('the retired "publishes to the marketplace immediately" overclaim is still absent (COPY-18, unrelated to this pass)', () => {
    assert.ok(!CLI_SRC.includes('publishes to the marketplace immediately'));
  });
});
