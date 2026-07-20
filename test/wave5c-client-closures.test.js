'use strict';

/**
 * test/wave5c-client-closures.test.js — Wave 5C client/test board-closure
 * (BUILD-SPEC-WAVE5C-2026-07-19; PUNCH-LIST §18 N1/N3/N4)
 *
 * N3 — consent-gate INTEGRATION test (the priority). The wave-3 Gate-A
 *      reviewer proved that flipping `extractionArmed = false → true` in
 *      bin/auxilo-cli.js cmdSetup (and equally, deleting the else-cleanup
 *      branch) shipped silently: prior coverage was a string-position check
 *      plus unit tests of the removal helpers — nothing EXECUTED the branch.
 *      Here the real CLI runs as a subprocess against a fixture HOME, a
 *      scripted stdin prompt driver, and a local HTTP server playing the
 *      consent endpoint in three modes: (a) consent records, (b) consent
 *      record FAILS server-side, (c) user declines. Hooks/shims may exist
 *      ONLY in (a); (b)/(c) must run the UC-1a cleanup.
 *      Mutation contract (verified at build time, protocol in the spec):
 *      the extractionArmed flip and the dropped else-branch must EACH fail
 *      this suite.
 *
 * N1 — adapter read-size cap. discoverSessions() returns bytes but
 *      readSession() read unbounded (54MB proven in the wild; multi-GB OOMs
 *      a constrained sweeper). The cap lives on the BASE adapter
 *      (TranscriptSource.readSessionCapped — one shared path, all adapters,
 *      incl. future UC-3 self-registered ones), default 64MB, env-tunable
 *      via AUXILO_MAX_SESSION_BYTES. Oversize = counted skip on stderr,
 *      never a failure, never a read.
 *
 * Drive parity — client-side proof that Google Drive/Docs file IDs die in
 *      the client scrub path (runner.scrubAndVerify). The PATTERN itself is
 *      Wave-5B property (lib/sensitivity-filter.js — NOT edited here). Until
 *      the 5B merge lands the pattern, this test SKIPS LOUDLY; post-merge it
 *      enforces automatically.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');

const REPO_ROOT = path.join(__dirname, '..');
const CLI_PATH = path.join(REPO_ROOT, 'bin', 'auxilo-cli.js');
const RUNNER_PATH = path.join(REPO_ROOT, 'scripts', 'runner.js');

const installer = require('../lib/installer.js');
const runner = require('../scripts/runner.js');
const { scanText } = require('../lib/sensitivity-filter.js');
const {
  TranscriptSource,
  SessionTooLargeError,
  DEFAULT_MAX_SESSION_BYTES,
  resolveMaxSessionBytes,
} = require('../scripts/sources/source.interface.js');
const { ClaudeCodeSource } = require('../scripts/sources/claude-code.js');

function tmpdir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
function rmrf(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* best-effort */ }
}
function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

// ─────────────────────────────────────────────────────────────────────────────
// N3 — consent-gate integration (cmdSetup branches, executed for real)
// ─────────────────────────────────────────────────────────────────────────────

/** Assertions shared by the two must-clean scenarios (b) and (c). */
function assertNoCaptureArtifacts(home) {
  // The kill-switch sentinel must NOT exist — extraction is not armed.
  assert.ok(
    !fs.existsSync(path.join(home, '.auxilo', 'autonomous-enabled')),
    'sentinel must NOT be created when consent did not record'
  );
  // No auxilo-extract reference anywhere in Claude Code settings —
  // including the pre-seeded STALE entry (the else-branch cleanup).
  const settings = readJson(path.join(home, '.claude', 'settings.json'));
  assert.ok(
    !JSON.stringify(settings).includes('auxilo-extract'),
    `no auxilo-extract capture hook may remain in settings.json: ${JSON.stringify(settings)}`
  );
  // Cursor capture hook stripped + shim deleted.
  const cursorShim = installer.captureShimPath(home, 'cursor');
  assert.ok(!fs.existsSync(cursorShim), 'stale cursor capture shim must be deleted');
  const cursorHooksPath = path.join(home, '.cursor', 'hooks.json');
  if (fs.existsSync(cursorHooksPath)) {
    assert.ok(
      !fs.readFileSync(cursorHooksPath, 'utf-8').includes('auxilo-capture'),
      'stale cursor capture-hook config entry must be removed'
    );
  }
}

/** Consent-independent surfaces present in every scenario (boundary pin). */
function assertConsentIndependentSurfaces(home) {
  const settings = readJson(path.join(home, '.claude', 'settings.json'));
  assert.ok(settings.mcpServers && settings.mcpServers.auxilo,
    'MCP registration is NOT consent-gated');
  const flatStart = JSON.stringify(settings.hooks && settings.hooks.SessionStart || []);
  assert.ok(flatStart.includes('auxilo-review-notice'),
    'SessionStart review notice is NOT consent-gated (count-only surface)');
}

describe('N3 — consent-gate integration (cmdSetup subprocess)', () => {
  const API_KEY = 'wave5c-test-key';
  let server;       // local HTTP server playing POST /extract/consent
  let baseUrl;
  let consentMode;  // 'ok' | 'fail'
  let consentCalls; // [{ method, url, apiKey, body }]

  before(async () => {
    server = http.createServer((req, res) => {
      let data = '';
      req.on('data', (c) => { data += c; });
      req.on('end', () => {
        if (req.method === 'POST' && req.url === '/extract/consent') {
          let body = {};
          try { body = JSON.parse(data); } catch { /* keep {} */ }
          consentCalls.push({
            method: req.method,
            url: req.url,
            apiKey: req.headers['x-api-key'] || null,
            body,
          });
          if (consentMode === 'fail') {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'induced consent-record failure' }));
          } else {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, autonomous_extraction_mode: 'seamless' }));
          }
          return;
        }
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `unexpected route ${req.method} ${req.url}` }));
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => new Promise((resolve) => server.close(resolve)));

  /**
   * Build a fixture HOME: claude-code + cursor detected, already
   * authenticated (device login short-circuits), optional pre-seeded STALE
   * capture artifacts (the observable payload of the else-branch cleanup).
   */
  function makeHome({ staleArtifacts }) {
    const home = tmpdir('aux-w5c-n3-');
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(home, '.cursor'), { recursive: true });
    fs.mkdirSync(path.join(home, '.auxilo'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.auxilo', 'credentials.json'),
      JSON.stringify({ api_key: API_KEY, base_url: baseUrl, email: 'w5c@test.local' })
    );

    const settings = {};
    if (staleArtifacts) {
      // Stale Claude Code SessionEnd capture hook (pre-UC-1a install shape).
      settings.hooks = {
        SessionEnd: [
          { hooks: [{ type: 'command', command: path.join(home, '.auxilo', 'bin', 'auxilo-extract.sh') }] },
        ],
      };
      // Stale cursor capture hook + shim.
      const cursorShim = installer.captureShimPath(home, 'cursor');
      fs.writeFileSync(
        path.join(home, '.cursor', 'hooks.json'),
        JSON.stringify({ version: 1, hooks: { sessionEnd: [{ command: cursorShim }] } })
      );
      fs.mkdirSync(path.dirname(cursorShim), { recursive: true });
      fs.writeFileSync(cursorShim, '#!/bin/bash\n# stale wave5c fixture shim\n');
    }
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify(settings));
    return home;
  }

  /**
   * Run `auxilo setup` for real, driven by a scripted PROMPT DRIVER: each
   * answer is written only when its prompt appears on stdout (writing all
   * answers up-front loses lines — readline emits a buffered line while no
   * question is pending and the answer is dropped; this is also the honest
   * simulation of a human at the prompts).
   */
  function runSetup(home, promptScript, { timeoutMs = 30000 } = {}) {
    return new Promise((resolve, reject) => {
      const env = { ...process.env, HOME: home, AUXILO_NO_NOTIFY: '1' };
      delete env.AUXILO_BASE_URL; // the --base-url flag must be the only base
      delete env.AUXILO_EXTRACTING;
      const child = spawn(process.execPath, [CLI_PATH, 'setup', '--base-url', baseUrl], {
        env, stdio: ['pipe', 'pipe', 'pipe'],
      });
      const script = [...promptScript];
      let stdout = '';
      let stderr = '';
      const feed = () => {
        while (script.length > 0 && script[0].re.test(stdout)) {
          const step = script.shift();
          child.stdin.write(step.send);
          if (script.length === 0) child.stdin.end(); // no further prompts expected
        }
      };
      child.stdout.on('data', (c) => { stdout += c; feed(); });
      child.stderr.on('data', (c) => { stderr += c; });
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`setup subprocess hung >${timeoutMs}ms (unanswered prompts: ${script.length})\nstdout:\n${stdout}\nstderr:\n${stderr}`));
      }, timeoutMs);
      child.on('error', (err) => { clearTimeout(timer); reject(err); });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (script.length > 0) {
          reject(new Error(`setup exited with ${script.length} scripted prompt(s) never shown\nstdout:\n${stdout}\nstderr:\n${stderr}`));
          return;
        }
        resolve({ code, stdout, stderr });
      });
    });
  }

  const PROMPT_CLIENTS = { re: /Configure which clients\?/, send: 'all\n' };
  const consentPrompt = (answer) => ({ re: /Enable background extraction\?/, send: `${answer}\n` });


  it('(a) consent=Yes + server 200: sentinel + hooks/shims exist, exactly one grant call', async () => {
    const home = makeHome({ staleArtifacts: false });
    try {
      consentMode = 'ok';
      consentCalls = [];
      const res = await runSetup(home, [PROMPT_CLIENTS, consentPrompt('y')]);
      assert.equal(res.code, 0, `exit 0 expected\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

      // Server-side consent artifact attempt: exactly one grant, right key.
      assert.equal(consentCalls.length, 1, 'exactly one consent call');
      assert.equal(consentCalls[0].body.action, 'grant');
      assert.equal(consentCalls[0].apiKey, API_KEY);

      // Sentinel armed.
      assert.ok(fs.existsSync(path.join(home, '.auxilo', 'autonomous-enabled')),
        'sentinel must exist after recorded consent');

      // Claude Code SessionEnd hook: canonical structured entry.
      const settings = readJson(path.join(home, '.claude', 'settings.json'));
      const sessionEnd = (settings.hooks && settings.hooks.SessionEnd) || [];
      const canonical = path.join(home, '.auxilo', 'bin', 'auxilo-extract.sh');
      assert.ok(
        sessionEnd.some((e) => e && Array.isArray(e.hooks) &&
          e.hooks.some((h) => h && h.type === 'command' && h.command === canonical)),
        `canonical SessionEnd hook expected in ${JSON.stringify(sessionEnd)}`
      );

      // Cursor capture hook + shim.
      const cursorShim = installer.captureShimPath(home, 'cursor');
      assert.ok(fs.existsSync(cursorShim), 'cursor capture shim written');
      assert.ok(
        fs.readFileSync(path.join(home, '.cursor', 'hooks.json'), 'utf-8').includes(cursorShim),
        'cursor hooks.json references the capture shim'
      );

      assert.match(res.stdout, /background extraction ENABLED/);
      assertConsentIndependentSurfaces(home);
    } finally {
      rmrf(home);
    }
  });

  it('(b) consent=Yes + server 500: NOT armed, no hooks, stale artifacts cleaned', async () => {
    const home = makeHome({ staleArtifacts: true });
    try {
      consentMode = 'fail';
      consentCalls = [];
      const res = await runSetup(home, [PROMPT_CLIENTS, consentPrompt('y')]);
      assert.equal(res.code, 0, `exit 0 expected\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

      // The grant was ATTEMPTED (user said yes) and failed server-side.
      assert.equal(consentCalls.length, 1, 'consent grant attempted once');
      assert.match(res.stderr, /Could not record consent/,
        'failure must be surfaced loudly on stderr');
      assert.match(res.stdout + res.stderr, /NOT enabled/);

      assertNoCaptureArtifacts(home);
      assertConsentIndependentSurfaces(home);
    } finally {
      rmrf(home);
    }
  });

  it('(c) consent=No: zero consent calls, NOT armed, stale artifacts cleaned', async () => {
    const home = makeHome({ staleArtifacts: true });
    try {
      consentMode = 'ok';
      consentCalls = [];
      const res = await runSetup(home, [PROMPT_CLIENTS, consentPrompt('n')]);
      assert.equal(res.code, 0, `exit 0 expected\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

      // Declining must never touch the consent endpoint.
      assert.equal(consentCalls.length, 0, 'no consent call on decline');
      assert.match(res.stdout, /Background extraction left OFF/);
      assert.match(res.stdout, /No capture hooks are present/);

      assertNoCaptureArtifacts(home);
      assertConsentIndependentSurfaces(home);
    } finally {
      rmrf(home);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// N1 — adapter read-size cap (base path: TranscriptSource.readSessionCapped)
// ─────────────────────────────────────────────────────────────────────────────

describe('N1 — adapter read-size cap', () => {
  /** Probe adapter: counts delegated reads so "never read" is provable. */
  class ProbeSource extends TranscriptSource {
    static id = 'wave5c-probe';
    static displayName = 'Wave5C Probe';
    static version = '0.0.1';
    constructor() { super(); this.reads = 0; }
    async detect() { return true; }
    async discoverSessions() { return []; }
    async readSession(ref) {
      this.reads += 1;
      return { transcript: 'PROBE-TRANSCRIPT', metadata: { sessionId: ref.sessionId } };
    }
  }

  function withEnv(key, value, fn) {
    const prev = process.env[key];
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
    return Promise.resolve()
      .then(fn)
      .finally(() => {
        if (prev === undefined) delete process.env[key]; else process.env[key] = prev;
      });
  }

  it('N1-1: over-cap garbage file throws SESSION_TOO_LARGE before any read', async () => {
    const dir = tmpdir('aux-w5c-n1-');
    try {
      const big = path.join(dir, 'big.jsonl');
      fs.writeFileSync(big, 'G'.repeat(8192)); // garbage fixture, 8KB
      const probe = new ProbeSource();
      await withEnv('AUXILO_MAX_SESSION_BYTES', '4096', async () => {
        await assert.rejects(
          () => probe.readSessionCapped({ sessionId: 'big', path: big, bytes: 8192 }),
          (err) => err instanceof SessionTooLargeError &&
            err.code === 'SESSION_TOO_LARGE' &&
            err.bytes === 8192 && err.maxBytes === 4096
        );
      });
      assert.equal(probe.reads, 0, 'underlying readSession must never run for oversize');
    } finally {
      rmrf(dir);
    }
  });

  it('N1-1b: bytes-only sessionRef (no stat-able path) still enforces the cap', async () => {
    const probe = new ProbeSource();
    await withEnv('AUXILO_MAX_SESSION_BYTES', '4096', async () => {
      await assert.rejects(
        () => probe.readSessionCapped({ sessionId: 'phantom', path: '/nonexistent/w5c', bytes: 999999 }),
        (err) => err.code === 'SESSION_TOO_LARGE'
      );
    });
    assert.equal(probe.reads, 0);
  });

  it('N1-2: under-cap file delegates; capped output identical to direct readSession', async () => {
    const dir = tmpdir('aux-w5c-n1-');
    try {
      const small = path.join(dir, 'small.jsonl');
      const line = JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello capped world' } });
      fs.writeFileSync(small, line + '\n');
      const ref = { sessionId: 'small', path: small, bytes: fs.statSync(small).size, mtime: new Date().toISOString() };

      const probe = new ProbeSource();
      await withEnv('AUXILO_MAX_SESSION_BYTES', '4096', async () => {
        const out = await probe.readSessionCapped(ref);
        assert.equal(out.transcript, 'PROBE-TRANSCRIPT');
      });
      assert.equal(probe.reads, 1);

      // Real adapter: capped path === direct path for under-cap files.
      const src = new ClaudeCodeSource({ dataDir: dir, settingsPath: path.join(dir, 'settings.json') });
      const direct = await src.readSession(ref);
      const capped = await src.readSessionCapped(ref);
      assert.deepEqual(capped, direct);
      assert.match(capped.transcript, /hello capped world/);
    } finally {
      rmrf(dir);
    }
  });

  it('N1-3: env resolution — default 64MB, garbage rejected, valid override honored', () => {
    assert.equal(DEFAULT_MAX_SESSION_BYTES, 64 * 1024 * 1024);
    assert.equal(resolveMaxSessionBytes({}), DEFAULT_MAX_SESSION_BYTES);
    for (const bad of ['banana', '0', '-5', '12.5', '']) {
      assert.equal(resolveMaxSessionBytes({ AUXILO_MAX_SESSION_BYTES: bad }), DEFAULT_MAX_SESSION_BYTES,
        `garbage env value ${JSON.stringify(bad)} must fall back to the default`);
    }
    assert.equal(resolveMaxSessionBytes({ AUXILO_MAX_SESSION_BYTES: '4096' }), 4096);
  });

  it('N1-4: runner sweep skips the oversize session with a counted stderr line, processes the sibling', () => {
    const home = tmpdir('aux-w5c-n1sweep-');
    try {
      const projDir = path.join(home, '.claude', 'projects', 'proj');
      fs.mkdirSync(projDir, { recursive: true });
      fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{}'); // detect()
      fs.mkdirSync(path.join(home, '.auxilo'), { recursive: true });
      fs.writeFileSync(path.join(home, '.auxilo', 'autonomous-enabled'), 'enabled\n'); // sentinel

      // Oversize garbage (8KB > 4KB cap) + valid under-cap sibling (>MIN_CHARS text).
      fs.writeFileSync(path.join(projDir, 'zz-big.jsonl'), 'G'.repeat(8192));
      const text = 'The quick brown fox jumps over the lazy dog. '.repeat(50); // ~2250 chars
      fs.writeFileSync(path.join(projDir, 'aa-small.jsonl'),
        JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n');

      const env = { ...process.env, HOME: home, AUXILO_MAX_SESSION_BYTES: '4096', AUXILO_NO_NOTIFY: '1' };
      delete env.AUXILO_EXTRACTING;
      const res = spawnSync(process.execPath,
        [RUNNER_PATH, '--source', 'claude-code', '--dry-run', '--force'],
        { env, encoding: 'utf-8', timeout: 30000 });

      assert.equal(res.status, 0,
        `oversize is a SKIP, not a failure\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
      assert.match(res.stderr, /SKIPPED oversize session zz-big/,
        'oversize skip must land on stderr with the session id');
      assert.match(res.stderr, /oversize_skipped=1/);
      assert.match(res.stdout, /\[DRY RUN\]/, 'the under-cap sibling still processes');
      assert.match(res.stdout, /1 oversize/, 'sweep summary counts oversize skips');
    } finally {
      rmrf(home);
    }
  });

  it('N1-5: closure guard — every adapter inherits the shared cap, no shadowing, runner uses only the capped path', () => {
    const sourcesDir = path.join(REPO_ROOT, 'scripts', 'sources');
    const files = fs.readdirSync(sourcesDir).filter((f) => f.endsWith('.js') && f !== 'source.interface.js');
    let checked = 0;
    for (const f of files) {
      const mod = require(path.join(sourcesDir, f));
      for (const exported of Object.values(mod || {})) {
        if (typeof exported !== 'function') continue;
        if (!(exported.prototype instanceof TranscriptSource)) continue;
        checked += 1;
        assert.equal(typeof exported.prototype.readSessionCapped, 'function',
          `${f}: adapter must inherit readSessionCapped`);
        assert.ok(!Object.prototype.hasOwnProperty.call(exported.prototype, 'readSessionCapped'),
          `${f}: adapter must NOT shadow readSessionCapped (the cap is base-path-only)`);
      }
    }
    assert.ok(checked >= 7, `expected >=7 adapter classes, saw ${checked}`);

    // Runner must have no bare readSession call site left.
    const src = fs.readFileSync(RUNNER_PATH, 'utf-8');
    const bare = src.replace(/readSessionCapped/g, '').match(/\.readSession\(/g) || [];
    assert.equal(bare.length, 0,
      'scripts/runner.js must read sessions ONLY through readSessionCapped');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Drive-ID scrub parity (client side; pattern is Wave-5B property)
// ─────────────────────────────────────────────────────────────────────────────

describe('Drive-ID scrub parity — client scrub path (runner.scrubAndVerify)', () => {
  // Fixture IDs in the two real Drive shapes (44-char doc id, 33-char file id).
  const DOC_ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEf';
  const FILE_ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz012345';
  const DOC_URL = `https://docs.google.com/document/d/${DOC_ID}/edit`;
  const FILE_URL = `https://drive.google.com/file/d/${FILE_ID}/view`;

  it('Drive/Docs file IDs do not survive the client scrub (SKIPS LOUDLY until the 5B pattern merges)', (t) => {
    // Probe: does the shipped sensitivity filter know Drive URLs at all?
    // The probe fixture carries NOTHING but the Drive URLs, so "clean" can
    // only mean the 5B pattern is absent from lib/sensitivity-filter.js.
    const probe = scanText(`${DOC_URL}\n${FILE_URL}`);
    if (probe.clean) {
      console.error(
        '[wave5c] LOUD SKIP: lib/sensitivity-filter.js has no Google Drive/Docs ID pattern yet. ' +
        'This test depends on the Wave-5B sensitivity-filter change (5B owns that file). ' +
        'It will enforce automatically once the 5B merge lands. If 5B has already merged, ' +
        'this skip is a REGRESSION — the Drive leak class is open client-side.'
      );
      t.skip('5B Drive pattern not present yet (see stderr note)');
      return;
    }

    // Pattern present → enforce the leak-class kill through the runner's
    // ACTUAL client scrub path (both sweep and single-file modes call this).
    const transcript = [
      '[user]: Here is the doc we used for the migration runbook.',
      `[assistant]: I read ${DOC_URL} and the export at ${FILE_URL},`,
      'then applied the fix to the staging config as described.',
    ].join('\n');

    const { cleaned, report, refused } = runner.scrubAndVerify(transcript);
    assert.equal(refused, false, 'redact-and-rescan must converge, not refuse');
    assert.ok(cleaned, 'cleaned transcript expected');
    assert.ok(!cleaned.includes(DOC_ID), 'Google Docs file ID must not survive the client scrub');
    assert.ok(!cleaned.includes(FILE_ID), 'Google Drive file ID must not survive the client scrub');
    assert.equal(report.clean, false, 'scrub report must record that patterns matched');
    assert.ok(report.patterns_matched.length > 0);
  });
});

// Gate-A 5C F2: the single-file (--transcript) oversize short-circuit must fire
// BEFORE the raw readFileSync fallback — a refactor reordering the check would
// silently reopen the OOM hole (spec §2.2). Behavioral, not structural.
const { test: t5cF2 } = require('node:test');
const assert5cF2 = require('node:assert');
const { spawnSync: spawn5cF2 } = require('node:child_process');
const fs5cF2 = require('node:fs');
const path5cF2 = require('node:path');
const os5cF2 = require('node:os');
t5cF2('single-file --transcript oversize: exit 0, SKIPPED oversize, no processing (Gate-A 5C F2)', () => {
  const dir = fs5cF2.mkdtempSync(path5cF2.join(os5cF2.tmpdir(), 'aux5cf2-'));
  const big = path5cF2.join(dir, 'big.jsonl');
  fs5cF2.writeFileSync(big, 'x'.repeat(8192));
  // runner exits at the kill-switch sentinel before reading anything — arm it in the fixture HOME
  fs5cF2.mkdirSync(path5cF2.join(dir, '.auxilo'), { recursive: true });
  fs5cF2.writeFileSync(path5cF2.join(dir, '.auxilo', 'autonomous-enabled'), '1');
  const r = spawn5cF2(process.execPath, [path5cF2.join(__dirname, '..', 'scripts', 'runner.js'), '--transcript', big, '--dry-run'], {
    env: { ...process.env, AUXILO_MAX_SESSION_BYTES: '4096', AUXILO_EXTRACTING: '', HOME: dir },
    encoding: 'utf8', timeout: 30000,
  });
  assert5cF2.strictEqual(r.status, 0, `expected exit 0, got ${r.status}\nstderr: ${r.stderr}`);
  assert5cF2.match(r.stderr + r.stdout, /oversize|SESSION_TOO_LARGE/i, 'must announce the oversize skip');
  fs5cF2.rmSync(dir, { recursive: true, force: true });
});
