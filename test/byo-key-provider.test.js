'use strict';
/*
 * test/byo-key-provider.test.js — EXTRACT-PER-CLIENT W1 PART C
 *
 * Covers scripts/providers/byo-key.js (config read/write/clear, vendor
 * routing/payload shape/text-extraction for openai-compatible/anthropic/
 * gemini, 429/5xx/network-error handling, never-logs-the-key) and
 * bin/auxilo-cli.js's `auxilo provider status|set|clear` (TTY-only + typed
 * consent-sentence discipline mirroring cmdCleanLane, and the empty
 * PROVIDER_KEY_CONSENT_SENTENCE slot refusing to run at all).
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const byoKey = require('../scripts/providers/byo-key.js');
const providersIndex = require('../scripts/providers/index.js');
const cli = require('../bin/auxilo-cli.js');

const REPO = path.join(__dirname, '..');
const CLI_PATH = path.join(REPO, 'bin', 'auxilo-cli.js');
const BYO_KEY_SRC = fs.readFileSync(path.join(REPO, 'scripts', 'providers', 'byo-key.js'), 'utf8');
const CLI_SRC = fs.readFileSync(CLI_PATH, 'utf8');

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

// ─── config read/write/clear ────────────────────────────────────────────────

describe('byo-key.js: providers.json path parity with scripts/providers/index.js', () => {
  it('DEFAULT_PROVIDERS_STATE_PATH is byte-equal to index.js\'s PROVIDERS_STATE_PATH', () => {
    assert.equal(byoKey.DEFAULT_PROVIDERS_STATE_PATH, providersIndex.PROVIDERS_STATE_PATH);
  });
});

describe('byo-key.js: writeByoConfig / readByoConfig / clearProvidersFile', () => {
  it('writes 0600 via tmp+rename, and readByoConfig round-trips it', () => {
    const dir = tempDir('auxilo-byo-write-');
    try {
      const statePath = statePathIn(dir);
      const written = byoKey.writeByoConfig(
        { provider: 'openai', model: 'gpt-4o-mini', api_key: 'sk-test-123' },
        { providersStatePath: statePath }
      );
      assert.equal(written, statePath);
      assert.ok(!fs.existsSync(`${statePath}.tmp`), 'no leftover .tmp file');
      const mode = fs.statSync(statePath).mode & 0o777;
      assert.equal(mode, 0o600);
      const config = byoKey.readByoConfig({ providersStatePath: statePath });
      assert.deepEqual(config, { provider: 'openai', base_url: null, model: 'gpt-4o-mini', api_key: 'sk-test-123' });
    } finally {
      cleanupTempDirs();
    }
  });

  it('preserves every other top-level key already in providers.json (notably `selected`, written by index.js)', () => {
    const dir = tempDir('auxilo-byo-preserve-');
    try {
      const statePath = statePathIn(dir);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(statePath, JSON.stringify({ selected: 'claude-code' }), { mode: 0o600 });
      byoKey.writeByoConfig(
        { provider: 'anthropic', model: 'claude-sonnet-4-5', api_key: 'sk-ant-test' },
        { providersStatePath: statePath }
      );
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      assert.equal(state.selected, 'claude-code', 'set must not clobber the auto-detected selection');
      assert.equal(state.byo.provider, 'anthropic');
    } finally {
      cleanupTempDirs();
    }
  });

  it('readByoConfig returns null on missing, malformed, or incomplete config', () => {
    const dir = tempDir('auxilo-byo-missing-');
    try {
      const statePath = statePathIn(dir);
      assert.equal(byoKey.readByoConfig({ providersStatePath: statePath }), null, 'missing file');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(statePath, 'not json');
      assert.equal(byoKey.readByoConfig({ providersStatePath: statePath }), null, 'malformed JSON');
      fs.writeFileSync(statePath, JSON.stringify({ byo: { provider: 'openai' } }));
      assert.equal(byoKey.readByoConfig({ providersStatePath: statePath }), null, 'missing model/api_key');
      fs.writeFileSync(statePath, JSON.stringify({ byo: [] }));
      assert.equal(byoKey.readByoConfig({ providersStatePath: statePath }), null, 'byo is an array, not an object');
    } finally {
      cleanupTempDirs();
    }
  });

  it('clearProvidersFile keeps `selected` and clears only `byo` (spec) — file kept, 0600, byo gone', () => {
    const dir = tempDir('auxilo-byo-clear-keeps-selected-');
    try {
      const statePath = statePathIn(dir);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(statePath, JSON.stringify({ selected: 'byo-key', byo: { provider: 'openai', model: 'x', api_key: 'y' } }));
      const result = byoKey.clearProvidersFile({ providersStatePath: statePath });
      assert.equal(result, 'removed-byo');
      assert.ok(fs.existsSync(statePath), 'the file must be kept, not deleted');
      assert.ok(!fs.existsSync(`${statePath}.tmp`), 'no leftover .tmp file');
      const mode = fs.statSync(statePath).mode & 0o777;
      assert.equal(mode, 0o600);
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      assert.deepEqual(state, { selected: 'byo-key' }, 'selected preserved, byo gone, nothing else added');
    } finally {
      cleanupTempDirs();
    }
  });

  it('clearProvidersFile removes the file outright when byo was the only content (nothing left to keep)', () => {
    const dir = tempDir('auxilo-byo-clear-byo-only-');
    try {
      const statePath = statePathIn(dir);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(statePath, JSON.stringify({ byo: { provider: 'openai', model: 'x', api_key: 'y' } }));
      const result = byoKey.clearProvidersFile({ providersStatePath: statePath });
      assert.equal(result, 'removed-file');
      assert.ok(!fs.existsSync(statePath), 'an empty {} must not be left on disk');
    } finally {
      cleanupTempDirs();
    }
  });

  it('clearProvidersFile is a no-op (never throws) on an absent file, and on a file with no `byo` key', () => {
    const dir = tempDir('auxilo-byo-clear-noop-');
    try {
      const statePath = statePathIn(dir);
      assert.equal(byoKey.clearProvidersFile({ providersStatePath: statePath }), 'noop', 'absent file is a no-op');

      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(statePath, JSON.stringify({ selected: 'claude-code' }));
      const result = byoKey.clearProvidersFile({ providersStatePath: statePath });
      assert.equal(result, 'noop', 'no byo key present is also a no-op');
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      assert.deepEqual(state, { selected: 'claude-code' }, 'untouched');
    } finally {
      cleanupTempDirs();
    }
  });
});

// ─── detect() ────────────────────────────────────────────────────────────────

describe('byo-key.js: detect()', () => {
  it('false with no config; true once a complete config is written', () => {
    const dir = tempDir('auxilo-byo-detect-');
    try {
      const statePath = statePathIn(dir);
      assert.equal(byoKey.detect({ providersStatePath: statePath }), false);
      byoKey.writeByoConfig({ provider: 'gemini', model: 'gemini-2.5-flash', api_key: 'k' }, { providersStatePath: statePath });
      assert.equal(byoKey.detect({ providersStatePath: statePath }), true);
    } finally {
      cleanupTempDirs();
    }
  });
});

// ─── runModel: vendor routing + payload shape + text extraction ────────────

function fetchCapturing(response) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return response(url, init);
  };
  return { fetchImpl, calls };
}

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

describe('byo-key.js: runModel — openai-compatible (default) variant', () => {
  it('POSTs {baseUrl}/chat/completions with Bearer auth, extracts choices[0].message.content', async () => {
    const dir = tempDir('auxilo-byo-openai-');
    try {
      const statePath = statePathIn(dir);
      byoKey.writeByoConfig({ provider: 'openai', model: 'gpt-4o-mini', api_key: 'sk-openai-test' }, { providersStatePath: statePath });
      const { fetchImpl, calls } = fetchCapturing(() => jsonResponse(200, {
        choices: [{ message: { content: '{"learnings":[]}' } }],
      }));
      const result = await byoKey.runModel({
        providersStatePath: statePath, prompt: 'extract: ', input: 'transcript text', fetchImpl,
      });
      assert.equal(result.ok, true);
      assert.equal(result.text, '{"learnings":[]}');
      assert.deepEqual(result.identity, { provider: 'byo-key', model: 'gpt-4o-mini', version: null, vendor: 'openai-compatible' });
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, 'https://api.openai.com/v1/chat/completions');
      assert.equal(calls[0].init.headers.Authorization, 'Bearer sk-openai-test');
      const body = JSON.parse(calls[0].init.body);
      assert.equal(body.model, 'gpt-4o-mini');
      assert.equal(body.messages[0].content, 'extract: transcript text');
    } finally {
      cleanupTempDirs();
    }
  });

  it('honors a custom base_url for an OpenAI-compatible endpoint', async () => {
    const dir = tempDir('auxilo-byo-custom-');
    try {
      const statePath = statePathIn(dir);
      byoKey.writeByoConfig({ provider: 'my-local-vllm', base_url: 'https://llm.internal.example/v1', model: 'llama-70b', api_key: 'local-key' }, { providersStatePath: statePath });
      const { fetchImpl, calls } = fetchCapturing(() => jsonResponse(200, { choices: [{ message: { content: 'ok' } }] }));
      const result = await byoKey.runModel({ providersStatePath: statePath, prompt: 'p', fetchImpl });
      assert.equal(result.ok, true);
      assert.equal(calls[0].url, 'https://llm.internal.example/v1/chat/completions');
      assert.equal(result.identity.vendor, 'openai-compatible');
    } finally {
      cleanupTempDirs();
    }
  });
});

describe('byo-key.js: runModel — anthropic variant', () => {
  it('POSTs {baseUrl}/messages with x-api-key + anthropic-version, extracts content[0].text', async () => {
    const dir = tempDir('auxilo-byo-anthropic-');
    try {
      const statePath = statePathIn(dir);
      byoKey.writeByoConfig({ provider: 'anthropic', model: 'claude-sonnet-4-5', api_key: 'sk-ant-test' }, { providersStatePath: statePath });
      const { fetchImpl, calls } = fetchCapturing(() => jsonResponse(200, {
        content: [{ type: 'text', text: '{"learnings":[]}' }],
        usage: { input_tokens: 100, output_tokens: 20 },
      }));
      const result = await byoKey.runModel({ providersStatePath: statePath, prompt: 'extract: ', input: 't', fetchImpl });
      assert.equal(result.ok, true);
      assert.equal(result.text, '{"learnings":[]}');
      assert.deepEqual(result.usage, { input_tokens: 100, output_tokens: 20 });
      assert.deepEqual(result.identity, { provider: 'byo-key', model: 'claude-sonnet-4-5', version: null, vendor: 'anthropic' });
      assert.equal(calls[0].url, 'https://api.anthropic.com/v1/messages');
      assert.equal(calls[0].init.headers['x-api-key'], 'sk-ant-test');
      assert.equal(calls[0].init.headers['anthropic-version'], '2023-06-01');
      assert.equal(calls[0].init.headers.Authorization, undefined, 'anthropic uses x-api-key, never a Bearer header');
    } finally {
      cleanupTempDirs();
    }
  });
});

describe('byo-key.js: runModel — gemini variant', () => {
  it('POSTs {baseUrl}/models/{model}:generateContent?key=..., extracts candidates[0].content.parts[].text', async () => {
    const dir = tempDir('auxilo-byo-gemini-');
    try {
      const statePath = statePathIn(dir);
      byoKey.writeByoConfig({ provider: 'gemini', model: 'gemini-2.5-flash', api_key: 'gk-test' }, { providersStatePath: statePath });
      const { fetchImpl, calls } = fetchCapturing(() => jsonResponse(200, {
        candidates: [{ content: { parts: [{ text: '{"learnings":' }, { text: '[]}' }] } }],
      }));
      const result = await byoKey.runModel({ providersStatePath: statePath, prompt: 'extract: ', input: 't', fetchImpl });
      assert.equal(result.ok, true);
      assert.equal(result.text, '{"learnings":[]}');
      assert.equal(result.identity.vendor, 'gemini');
      assert.ok(calls[0].url.startsWith('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key='));
      assert.ok(calls[0].url.includes('gk-test'), 'gemini has no header alternative to the key query param');
      assert.equal(calls[0].init.headers.Authorization, undefined);
      assert.equal(calls[0].init.headers['x-api-key'], undefined);
    } finally {
      cleanupTempDirs();
    }
  });
});

// ─── error handling: 429 / 5xx / network throw / not configured ────────────

describe('byo-key.js: runModel — error handling', () => {
  it('429 -> ok:false, reasonCode provider-rate-limited, exactly one fetch call (no retry)', async () => {
    const dir = tempDir('auxilo-byo-429-');
    try {
      const statePath = statePathIn(dir);
      byoKey.writeByoConfig({ provider: 'openai', model: 'x', api_key: 'k' }, { providersStatePath: statePath });
      const { fetchImpl, calls } = fetchCapturing(() => jsonResponse(429, { error: 'rate limited' }));
      const result = await byoKey.runModel({ providersStatePath: statePath, prompt: 'p', fetchImpl });
      assert.equal(result.ok, false);
      assert.equal(result.reasonCode, 'provider-rate-limited');
      assert.equal(calls.length, 1, 'never retries a 429');
    } finally {
      cleanupTempDirs();
    }
  });

  it('500 -> ok:false, reasonCode provider-error', async () => {
    const dir = tempDir('auxilo-byo-500-');
    try {
      const statePath = statePathIn(dir);
      byoKey.writeByoConfig({ provider: 'openai', model: 'x', api_key: 'k' }, { providersStatePath: statePath });
      const { fetchImpl, calls } = fetchCapturing(() => jsonResponse(500, { error: 'boom' }));
      const result = await byoKey.runModel({ providersStatePath: statePath, prompt: 'p', fetchImpl });
      assert.equal(result.ok, false);
      assert.equal(result.reasonCode, 'provider-error');
      assert.equal(calls.length, 1);
    } finally {
      cleanupTempDirs();
    }
  });

  it('a network throw -> ok:false, reasonCode provider-error, never propagates', async () => {
    const dir = tempDir('auxilo-byo-throw-');
    try {
      const statePath = statePathIn(dir);
      byoKey.writeByoConfig({ provider: 'openai', model: 'x', api_key: 'k' }, { providersStatePath: statePath });
      const fetchImpl = async () => { throw new Error('ECONNREFUSED'); };
      const result = await byoKey.runModel({ providersStatePath: statePath, prompt: 'p', fetchImpl });
      assert.equal(result.ok, false);
      assert.equal(result.reasonCode, 'provider-error');
      assert.match(result.reason, /ECONNREFUSED/);
    } finally {
      cleanupTempDirs();
    }
  });

  it('no config on disk -> ok:false, reasonCode provider-not-configured, no fetch attempted', async () => {
    const dir = tempDir('auxilo-byo-noconfig-');
    try {
      const statePath = statePathIn(dir);
      const { fetchImpl, calls } = fetchCapturing(() => jsonResponse(200, {}));
      const result = await byoKey.runModel({ providersStatePath: statePath, prompt: 'p', fetchImpl });
      assert.equal(result.ok, false);
      assert.equal(result.reasonCode, 'provider-not-configured');
      assert.equal(calls.length, 0);
    } finally {
      cleanupTempDirs();
    }
  });
});

// ─── never logs the key ─────────────────────────────────────────────────────

describe('byo-key.js: the key is never logged', () => {
  it('static source grep: no console.* or bare log( call anywhere in the module', () => {
    assert.doesNotMatch(BYO_KEY_SRC, /console\.\w+\(/, 'no console.* call exists in this module at all');
    assert.doesNotMatch(BYO_KEY_SRC, /(?<![.\w])log\(/, 'no bare log(...) call exists in this module at all');
  });

  it('behavioral: a failing/successful runModel call never surfaces the raw key in any returned field', async () => {
    const dir = tempDir('auxilo-byo-nolog-');
    try {
      const statePath = statePathIn(dir);
      const SECRET = 'sk-super-secret-do-not-leak-9f8e7d6c';
      byoKey.writeByoConfig({ provider: 'openai', model: 'x', api_key: SECRET }, { providersStatePath: statePath });
      const { fetchImpl } = fetchCapturing(() => jsonResponse(500, { error: 'boom' }));
      const result = await byoKey.runModel({ providersStatePath: statePath, prompt: 'p', fetchImpl });
      const serialized = JSON.stringify(result);
      assert.ok(!serialized.includes(SECRET), 'the key must not appear anywhere in the runModel result');
    } finally {
      cleanupTempDirs();
    }
  });
});

// ─── bin/auxilo-cli.js: auxilo provider ─────────────────────────────────────

const PROVIDER_KEY_CONSENT_SENTENCE_EXPECTED = 'This key is yours. It stays on this machine in ~/.auxilo/providers.json, readable only by your user account, and Auxilo never receives it. It is used for one thing, drafting learnings from your own scrubbed sessions. Drafting sends those sessions to that provider under your own account, and any use is charged to that account, never to Auxilo. Run auxilo provider clear to remove it.';

describe('bin/auxilo-cli.js: PROVIDER_KEY_CONSENT_SENTENCE (SITE-PM string slot)', () => {
  it('is non-empty and byte-equal to the ruled sentence', () => {
    assert.ok(cli.PROVIDER_KEY_CONSENT_SENTENCE.length > 0, 'sentence must not be empty');
    assert.equal(cli.PROVIDER_KEY_CONSENT_SENTENCE, PROVIDER_KEY_CONSENT_SENTENCE_EXPECTED);
  });

  it('structural: cmdProvider still refuses `set` were the sentence ever empty again, with reasonCode consent-sentence-missing, before the TTY gate', () => {
    const start = CLI_SRC.indexOf('async function cmdProvider');
    assert.ok(start > 0, 'cmdProvider not found');
    const fn = CLI_SRC.slice(start, start + 5000);
    const consentCheckIdx = fn.indexOf("PROVIDER_KEY_CONSENT_SENTENCE === ''");
    const modeCheckIdx = fn.indexOf('providersFileModeUnsafe(');
    const ttyCheckIdx = fn.indexOf('!process.stdin.isTTY');
    assert.ok(consentCheckIdx > -1, 'empty-sentence refusal not found');
    assert.ok(modeCheckIdx > -1, 'providers-file-mode-unsafe check not found');
    assert.ok(ttyCheckIdx > -1, 'TTY gate not found');
    assert.ok(consentCheckIdx < modeCheckIdx, 'the consent-sentence-missing check must run before the mode check');
    assert.ok(modeCheckIdx < ttyCheckIdx, 'the providers-file-mode-unsafe check must run before the TTY gate');
    assert.match(fn, /reasonCode:\s*consent-sentence-missing/);
    assert.match(fn, /reasonCode:\s*providers-file-mode-unsafe/);
  });

  it('structural: the mode check and the sentence print both precede the API key prompt, and the mode check precedes storing', () => {
    const start = CLI_SRC.indexOf('async function cmdProvider');
    const fn = CLI_SRC.slice(start, start + 5000);
    const modeCheckIdx = fn.indexOf('providersFileModeUnsafe(');
    const sentencePrintIdx = fn.indexOf('wrapForTerminal(PROVIDER_KEY_CONSENT_SENTENCE)');
    const keyPromptIdx = fn.indexOf("askHidden('API key");
    const writeIdx = fn.indexOf('byoKeyProvider.writeByoConfig(');
    assert.ok(modeCheckIdx > -1 && sentencePrintIdx > -1 && keyPromptIdx > -1 && writeIdx > -1,
      'one of the expected calls was not found in cmdProvider');
    assert.ok(modeCheckIdx < sentencePrintIdx, 'the mode check must run before the sentence is ever printed');
    assert.ok(sentencePrintIdx < keyPromptIdx, 'the sentence must print before the API key prompt');
    assert.ok(modeCheckIdx < writeIdx, 'the mode check must run before providers.json is written');
  });

  it('structural: the sentence prints word-wrapped to the terminal width (never a raw unwrapped console.log of the constant)', () => {
    const start = CLI_SRC.indexOf('async function cmdProvider');
    const fn = CLI_SRC.slice(start, start + 5000);
    assert.ok(!/console\.log\(`\\n\$\{PROVIDER_KEY_CONSENT_SENTENCE\}\\n`\)/.test(fn),
      'the sentence must not be printed raw/unwrapped');
    const wrapCount = (fn.match(/wrapForTerminal\(PROVIDER_KEY_CONSENT_SENTENCE\)/g) || []).length;
    assert.ok(wrapCount >= 1, 'the sentence must be printed via wrapForTerminal');
  });

  it('structural: `provider set` and `provider clear` both exist (the sentence prints only when both do)', () => {
    assert.match(CLI_SRC, /sub === 'set'/);
    assert.match(CLI_SRC, /sub === 'clear'/);
  });

  it('structural: no --yes/--force/env/argv path can supply the key — only askHidden', () => {
    const start = CLI_SRC.indexOf('async function cmdProvider');
    const fn = CLI_SRC.slice(start, start + 5000);
    assert.ok(!/flags\.key|flags\['api-key'\]|flags\.apiKey|process\.env\.\w*KEY/.test(fn),
      'the key must never be readable from a flag or env var');
    assert.match(fn, /askHidden\(/, 'the key prompt must use the hidden-input helper');
  });

  it('structural: askHidden is a distinct function from ask (echo-suppressing hook present)', () => {
    assert.match(CLI_SRC, /function askHidden\(question\)/);
    assert.match(CLI_SRC, /_writeToOutput/);
  });
});

describe('bin/auxilo-cli.js: providersFileModeUnsafe (owner-read-only predicate)', () => {
  it('no file on disk is NOT unsafe (writeByoConfig always writes 0600 itself)', () => {
    const dir = tempDir('auxilo-mode-check-absent-');
    try {
      assert.equal(cli.providersFileModeUnsafe(statePathIn(dir)), false);
    } finally {
      cleanupTempDirs();
    }
  });

  it('a 0600 file is NOT unsafe', () => {
    const dir = tempDir('auxilo-mode-check-0600-');
    try {
      fs.mkdirSync(dir, { recursive: true });
      const statePath = statePathIn(dir);
      fs.writeFileSync(statePath, '{}', { mode: 0o600 });
      assert.equal(cli.providersFileModeUnsafe(statePath), false);
    } finally {
      cleanupTempDirs();
    }
  });

  it('a group/world-readable file (0644) IS unsafe', () => {
    const dir = tempDir('auxilo-mode-check-0644-');
    try {
      fs.mkdirSync(dir, { recursive: true });
      const statePath = statePathIn(dir);
      fs.writeFileSync(statePath, '{}', { mode: 0o644 });
      assert.equal(cli.providersFileModeUnsafe(statePath), true);
    } finally {
      cleanupTempDirs();
    }
  });

  it('a group-writable file (0660) IS unsafe', () => {
    const dir = tempDir('auxilo-mode-check-0660-');
    try {
      fs.mkdirSync(dir, { recursive: true });
      const statePath = statePathIn(dir);
      fs.writeFileSync(statePath, '{}', { mode: 0o660 });
      assert.equal(cli.providersFileModeUnsafe(statePath), true);
    } finally {
      cleanupTempDirs();
    }
  });
});

function runCli(args, env, input = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`CLI timed out: ${args.join(' ')}`)); }, 10000);
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', reject);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.stdin.end(input);
  });
}

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'auxilo-provider-cli-'));
  tempDirs.push(home);
  return home;
}

describe('CLI: auxilo provider (real spawn, non-TTY piped stdio)', () => {
  it('`provider set` refuses (exit 1) even with a full scripted answer stream — the sentence is filled now, so it refuses at the TTY gate instead', async () => {
    const home = makeHome();
    try {
      const res = await runCli(['provider', 'set'], { HOME: home },
        'openai\n\nsome-model\nI agree\nsk-would-be-a-real-key\n');
      assert.equal(res.code, 1);
      assert.match(res.stderr, /interactive terminal/);
      assert.ok(!fs.existsSync(path.join(home, '.auxilo', 'providers.json')), 'nothing written');
    } finally {
      cleanupTempDirs();
    }
  });

  it('`provider set` fails closed with reasonCode providers-file-mode-unsafe when an existing providers.json is group/world-readable, before the TTY gate and without touching the file', async () => {
    const home = makeHome();
    try {
      const dir = path.join(home, '.auxilo');
      fs.mkdirSync(dir, { recursive: true });
      const statePath = path.join(dir, 'providers.json');
      fs.writeFileSync(statePath, JSON.stringify({ selected: 'claude-code' }), { mode: 0o644 });
      const res = await runCli(['provider', 'set'], { HOME: home },
        'openai\n\nsome-model\nI agree\nsk-would-be-a-real-key\n');
      assert.equal(res.code, 1);
      assert.match(res.stderr, /providers-file-mode-unsafe/);
      // fail-closed means untouched, not just unreadable-but-modified
      const mode = fs.statSync(statePath).mode & 0o777;
      assert.equal(mode, 0o644, 'the unsafe file must be left exactly as found, not silently rewritten');
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      assert.deepEqual(state, { selected: 'claude-code' }, 'content must be untouched');
    } finally {
      cleanupTempDirs();
    }
  });

  it('`provider set` passes the mode check (reaches the TTY gate instead) when an existing providers.json is 0600', async () => {
    const home = makeHome();
    try {
      const dir = path.join(home, '.auxilo');
      fs.mkdirSync(dir, { recursive: true });
      const statePath = path.join(dir, 'providers.json');
      fs.writeFileSync(statePath, JSON.stringify({ selected: 'claude-code' }), { mode: 0o600 });
      const res = await runCli(['provider', 'set'], { HOME: home },
        'openai\n\nsome-model\nI agree\nsk-would-be-a-real-key\n');
      assert.equal(res.code, 1);
      assert.doesNotMatch(res.stderr, /providers-file-mode-unsafe/);
      assert.match(res.stderr, /interactive terminal/);
    } finally {
      cleanupTempDirs();
    }
  });

  it('`provider status` with nothing configured prints "none configured", exit 0', async () => {
    const home = makeHome();
    try {
      const res = await runCli(['provider', 'status'], { HOME: home });
      assert.equal(res.code, 0);
      assert.match(res.stdout, /none configured/);
    } finally {
      cleanupTempDirs();
    }
  });

  it('`provider status` reports vendor/model/key-present, never the key itself, once configured', async () => {
    const home = makeHome();
    try {
      const dir = path.join(home, '.auxilo');
      fs.mkdirSync(dir, { recursive: true });
      const SECRET = 'sk-should-never-print-in-status-abc123';
      fs.writeFileSync(path.join(dir, 'providers.json'), JSON.stringify({
        byo: { provider: 'openai', model: 'gpt-4o-mini', api_key: SECRET },
      }), { mode: 0o600 });
      const res = await runCli(['provider', 'status'], { HOME: home });
      assert.equal(res.code, 0);
      assert.match(res.stdout, /vendor: openai/);
      assert.match(res.stdout, /model: gpt-4o-mini/);
      assert.match(res.stdout, /key: present/);
      assert.ok(!res.stdout.includes(SECRET), 'the key itself must never print, not even a prefix');
    } finally {
      cleanupTempDirs();
    }
  });

  it('`provider clear` with nothing to remove prints so and exits 0; removes an existing file', async () => {
    const home = makeHome();
    try {
      const nothing = await runCli(['provider', 'clear'], { HOME: home });
      assert.equal(nothing.code, 0);
      assert.match(nothing.stdout, /Nothing to remove/);

      const dir = path.join(home, '.auxilo');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'providers.json'), JSON.stringify({ byo: { provider: 'openai', model: 'x', api_key: 'y' } }));
      const removed = await runCli(['provider', 'clear'], { HOME: home });
      assert.equal(removed.code, 0);
      assert.match(removed.stdout, /removed/);
      assert.ok(!fs.existsSync(path.join(dir, 'providers.json')));
    } finally {
      cleanupTempDirs();
    }
  });

  it('`provider clear` keeps `selected` and the file itself when other content remains', async () => {
    const home = makeHome();
    try {
      const dir = path.join(home, '.auxilo');
      fs.mkdirSync(dir, { recursive: true });
      const statePath = path.join(dir, 'providers.json');
      fs.writeFileSync(statePath, JSON.stringify({ selected: 'byo-key', byo: { provider: 'openai', model: 'x', api_key: 'y' } }));
      const res = await runCli(['provider', 'clear'], { HOME: home });
      assert.equal(res.code, 0);
      assert.match(res.stdout, /cleared/);
      assert.ok(fs.existsSync(statePath), 'providers.json must be kept');
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      assert.deepEqual(state, { selected: 'byo-key' });
    } finally {
      cleanupTempDirs();
    }
  });

  it('unknown subcommand exits 1; `provider help` exits 0 with usage text, no network', async () => {
    const home = makeHome();
    try {
      const unknown = await runCli(['provider', 'bogus'], { HOME: home });
      assert.equal(unknown.code, 1);
      const help = await runCli(['provider', 'help'], { HOME: home });
      assert.equal(help.code, 0);
      assert.match(help.stdout, /auxilo provider/);
    } finally {
      cleanupTempDirs();
    }
  });
});
