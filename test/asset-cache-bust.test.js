'use strict';

/**
 * test/asset-cache-bust.test.js — ASSET-CACHE-BUST
 *
 * Bug (verified live): 14 tracked pages under public/ linked
 * /styles.css?v=13, a query value that had not changed since 2026-07-01
 * while styles.css itself changed three times since (7bdb984, 111e42d,
 * 8626c9e). server.js serves /styles.css with
 * `Cache-Control: public, max-age=31536000, immutable` (server.js:5570) —
 * the route match is on the path only, so the query string is decorative to
 * the server but load-bearing to the browser's cache: a returning visitor
 * who ever fetched /styles.css?v=13 would never re-request it for up to a
 * year, even after the file changed, because the URL never changed. Two
 * `/*.js?v=N` links (dashboard-review.js?v=1, dashboard-clean-lane.js?v=3)
 * shared the same stale-query pattern.
 *
 * Fix: scripts/asset-versions.js computes an 8-hex sha256 prefix of each
 * versioned asset's current bytes and keeps every `?v=` reference to it in
 * sync, so a content change always produces a new URL. This suite covers:
 *
 *   1. `--check` against the real repo tree passes (no stale references) —
 *      this is the same invocation scripts/predeploy-check.sh now runs, so
 *      this test fails the same way a broken predeploy gate would.
 *   2. Unit: a temp fixture repo with a styles.css referenced at its correct
 *      hash passes `--check`; after the css is modified WITHOUT bumping the
 *      reference, `--check` detects it as stale and exits 1; `--write` fixes
 *      it and `--check` passes again.
 *   3. Behavioral: boot the real server.js and confirm
 *      GET /styles.css?v=<hash> returns 200 text/css (server.js:5570 ignores
 *      the query when resolving which file to serve, per its own comment
 *      there — this proves the immutable-cached URL still resolves after the
 *      hash changes, i.e. the cache-bust actually busts the cache instead of
 *      404ing).
 *
 * Runner: node --test test/asset-cache-bust.test.js
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const {
  BOOT_SANDBOX_SKIP_REASON,
  bootServer,
  reservePort,
  stageServer,
  stopServer,
} = require('./helpers/staged-server');

const REPO_ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'asset-versions.js');

function runScript(args, opts = {}) {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...args], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: { ...process.env, ...(opts.env || {}) },
    });
    return { code: 0, stdout };
  } catch (e) {
    // execFileSync throws on non-zero exit; the useful bits are still there.
    return { code: e.status, stdout: (e.stdout || '').toString() + (e.stderr || '').toString() };
  }
}

// ─── 1. Real tree is clean ─────────────────────────────────────────────────

describe('asset-versions.js --check against the real tree', () => {
  it('passes — every ?v= reference matches its asset\'s current content hash', () => {
    const { code, stdout } = runScript(['--check']);
    assert.equal(code, 0, `--check must pass on the committed tree. Output:\n${stdout}`);
    assert.match(stdout, /All \?v= references match/);
  });

  it('discovers styles.css plus the two dashboard.html js assets (report mode)', () => {
    const { code, stdout } = runScript([]);
    assert.equal(code, 0);
    assert.match(stdout, /\/styles\.css\t\?v=[0-9a-f]{8}/);
    assert.match(stdout, /\/dashboard-review\.js\t\?v=[0-9a-f]{8}/);
    assert.match(stdout, /\/dashboard-clean-lane\.js\t\?v=[0-9a-f]{8}/);
  });
});

// ─── 2. Unit: temp fixture repo, modify an asset without bumping the ref ──

describe('asset-versions.js unit: detects a modified asset with a stale reference', () => {
  it('flags styles.css as stale after its bytes change but the ?v= reference does not, then fixes it with --write', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auxilo-asset-versions-'));
    try {
      // Minimal fixture: a git repo (git ls-files is the enumeration source)
      // with one HTML file referencing one CSS asset.
      execFileSync('git', ['init', '-q'], { cwd: tmpDir });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tmpDir });
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir });
      fs.mkdirSync(path.join(tmpDir, 'public'));

      const cssPath = path.join(tmpDir, 'public', 'styles.css');
      fs.writeFileSync(cssPath, 'body { color: red; }\n');
      const initialHash = crypto.createHash('sha256').update(fs.readFileSync(cssPath)).digest('hex').slice(0, 8);

      const htmlPath = path.join(tmpDir, 'public', 'page.html');
      fs.writeFileSync(
        htmlPath,
        `<!doctype html><html><head><link rel="stylesheet" href="/styles.css?v=${initialHash}" /></head><body></body></html>\n`
      );
      execFileSync('git', ['add', '-A'], { cwd: tmpDir });

      const env = { ASSET_VERSIONS_ROOT: tmpDir };

      // Correct hash from the start → clean.
      let res = runScript(['--check'], { env });
      assert.equal(res.code, 0, `expected clean check before modification. Output:\n${res.stdout}`);

      // Ship a CSS change without bumping the reference (the exact real bug).
      fs.writeFileSync(cssPath, 'body { color: blue; }\n');
      const newHash = crypto.createHash('sha256').update(fs.readFileSync(cssPath)).digest('hex').slice(0, 8);
      assert.notEqual(newHash, initialHash, 'fixture sanity: content change must change the hash');

      res = runScript(['--check'], { env });
      assert.equal(res.code, 1, `expected --check to detect the stale reference. Output:\n${res.stdout}`);
      assert.match(res.stdout, /STALE/);
      assert.match(res.stdout, new RegExp(`\\?v=${newHash}`));

      // --write repairs it.
      res = runScript(['--write'], { env });
      assert.equal(res.code, 0, `--write should succeed. Output:\n${res.stdout}`);
      const fixedHtml = fs.readFileSync(htmlPath, 'utf8');
      assert.match(fixedHtml, new RegExp(`/styles\\.css\\?v=${newHash}"`));

      res = runScript(['--check'], { env });
      assert.equal(res.code, 0, `expected clean check after --write. Output:\n${res.stdout}`);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('does not touch the file path or any unrelated attribute — only the ?v= value changes', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auxilo-asset-versions-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: tmpDir });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tmpDir });
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir });
      fs.mkdirSync(path.join(tmpDir, 'public'));
      fs.writeFileSync(path.join(tmpDir, 'public', 'styles.css'), 'body { color: green; }\n');
      const htmlPath = path.join(tmpDir, 'public', 'page.html');
      const original = `<!doctype html><html><head><link rel="stylesheet" href="/styles.css?v=deadbeef" /><script src="/app.js" id="x"></script></head><body></body></html>\n`;
      fs.writeFileSync(htmlPath, original);
      execFileSync('git', ['add', '-A'], { cwd: tmpDir });

      runScript(['--write'], { env: { ASSET_VERSIONS_ROOT: tmpDir } });
      const after = fs.readFileSync(htmlPath, 'utf8');

      assert.match(after, /href="\/styles\.css\?v=[0-9a-f]{8}"/, 'path stays /styles.css, only the query changes');
      assert.match(after, /<script src="\/app\.js" id="x"><\/script>/, 'unrelated script tag with no ?v= is untouched');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ─── 3. Behavioral: the live static handler ignores the query ─────────────

describe('server.js static handler serves /styles.css identically regardless of the ?v= query', { timeout: 180_000 }, () => {
  let tmpDir;
  let child;
  let baseUrl;
  let bootSkipReason = null;

  before(async () => {
    let honoEntry;
    try {
      honoEntry = require.resolve('hono', { paths: [REPO_ROOT] });
    } catch {
      bootSkipReason = 'hono not resolvable from repo root';
      return;
    }
    const nodeModulesDir = honoEntry.slice(0, honoEntry.lastIndexOf(`${path.sep}node_modules${path.sep}`) + '/node_modules'.length);

    const reservation = await reservePort();
    if ('skipReason' in reservation) {
      assert.equal(reservation.skipReason, BOOT_SANDBOX_SKIP_REASON);
      bootSkipReason = BOOT_SANDBOX_SKIP_REASON;
      return;
    }
    const { port } = reservation;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auxilo-asset-cache-bust-boot-'));
    stageServer({
      repoRoot: REPO_ROOT,
      tmpDir,
      nodeModulesDir,
      port,
      rootFiles: ['server.js', 'seed-knowledge.json', 'skills.json', 'openapi.json', 'package.json', 'model_config.json'],
      linkDirs: ['lib', 'public', 'prompts', 'config'],
      replacements: [],
    });

    const boot = await bootServer({
      tmpDir,
      port,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        WALLET_PRIVATE_KEY: `0x${'11'.repeat(32)}`,
        LLM_SENSITIVITY_ENABLED: 'false',
        SESSION_SECRET: 'asset-cache-bust-test-session-secret-0123456789',
        AUXILO_DATA_DIR: path.join(tmpDir, 'data'),
      },
      timeoutMs: 60_000,
      maxAttempts: 3,
    });
    if ('skipReason' in boot) {
      assert.equal(boot.skipReason, BOOT_SANDBOX_SKIP_REASON);
      bootSkipReason = BOOT_SANDBOX_SKIP_REASON;
      return;
    }
    child = boot.child;
    baseUrl = boot.baseUrl;
  });

  after(async () => {
    if (child) await stopServer(child);
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('GET /styles.css?v=<current hash> returns 200 text/css with the immutable cache header (server.js:5570)', async (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    const hash = crypto
      .createHash('sha256')
      .update(fs.readFileSync(path.join(REPO_ROOT, 'public', 'styles.css')))
      .digest('hex')
      .slice(0, 8);
    const res = await fetch(`${baseUrl}/styles.css?v=${hash}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /text\/css/);
    assert.equal(res.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    const body = await res.text();
    assert.ok(body.length > 0);

    // A DIFFERENT query value resolves to the exact same file — server.js's
    // route match at line 5570 is path-only, so the ?v= is a pure
    // cache-buster, never a routing key. That's what makes bumping it safe
    // (it can never 404) and necessary (an unbumped value never re-fetches).
    const res2 = await fetch(`${baseUrl}/styles.css?v=some-other-value`);
    assert.equal(res2.status, 200);
    const body2 = await res2.text();
    assert.equal(body2, body);
  });
});
