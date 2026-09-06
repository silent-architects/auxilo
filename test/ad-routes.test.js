'use strict';

/**
 * test/ad-routes.test.js — AD routes: /about + /writing served, sitemap
 * carries both, API discovery says 'responsible disclosure contact'.
 *
 *   1. GET /about   → 200 text/html containing public/about.html's <title>.
 *   2. GET /writing → 200 text/html containing public/writing/index.html's <title>.
 *   3. GET /writing/ (trailing slash) → 301 redirect to /writing (Hono routes
 *      strictly; the redirect folds the slash form onto the canonical path).
 *   4. public/sitemap.xml lists https://auxilo.io/about and https://auxilo.io/writing.
 *   5. GET /api/info endpoint description for /.well-known/security.txt reads
 *      'responsible disclosure contact' (Tyler's word), never '... policy'.
 *   6. Structural: server.js carries the new phrase exactly once in the
 *      discovery map and the old phrase zero times.
 *
 * Staged-server pattern: test/clean-lane-phase-a2.test.js.
 *
 * Runner: node --test test/ad-routes.test.js
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  reservePort,
  stageServer,
  bootServer,
  stopServer,
  BOOT_SANDBOX_SKIP_REASON,
} = require('./helpers/staged-server');

const REPO = path.join(__dirname, '..');
const SERVER_SRC = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');
const SITEMAP = fs.readFileSync(path.join(REPO, 'public', 'sitemap.xml'), 'utf8');
const ABOUT_HTML = fs.readFileSync(path.join(REPO, 'public', 'about.html'), 'utf8');
const WRITING_HTML = fs.readFileSync(path.join(REPO, 'public', 'writing', 'index.html'), 'utf8');

function titleOf(html) {
  const m = html.match(/<title>([^<]+)<\/title>/);
  assert.ok(m, 'page has a <title>');
  return m[0];
}

const ABOUT_TITLE = titleOf(ABOUT_HTML);
const WRITING_TITLE = titleOf(WRITING_HTML);
const NEW_PHRASE = 'responsible disclosure contact';
const OLD_PHRASE = 'responsible disclosure policy';

describe('AD routes: /about + /writing + sitemap + discovery phrase', { timeout: 180_000 }, () => {
  let tmpDir;
  let child;
  let baseUrl;
  let bootSkipReason = null;

  before(async () => {
    const honoEntry = require.resolve('hono', { paths: [REPO] });
    const nodeModulesDir = honoEntry.slice(
      0,
      honoEntry.lastIndexOf(`${path.sep}node_modules${path.sep}`) + '/node_modules'.length
    );
    const reservation = await reservePort();
    if ('skipReason' in reservation) {
      assert.equal(reservation.skipReason, BOOT_SANDBOX_SKIP_REASON);
      bootSkipReason = BOOT_SANDBOX_SKIP_REASON;
      return;
    }
    const { port } = reservation;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auxilo-ad-routes-'));
    stageServer({
      repoRoot: REPO,
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
        SESSION_SECRET: 'ad-routes-test-session-secret-0123456789',
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

  it('GET /about → 200 text/html containing the about page <title>', async (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    const res = await fetch(`${baseUrl}/about`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /^text\/html/);
    const body = await res.text();
    assert.ok(body.includes(ABOUT_TITLE), `body carries ${ABOUT_TITLE}`);
  });

  it('GET /writing → 200 text/html containing the writing index <title>', async (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    const res = await fetch(`${baseUrl}/writing`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /^text\/html/);
    const body = await res.text();
    assert.ok(body.includes(WRITING_TITLE), `body carries ${WRITING_TITLE}`);
  });

  it('GET /writing/ (trailing slash) → 301 to /writing', async (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    const res = await fetch(`${baseUrl}/writing/`, { redirect: 'manual' });
    assert.equal(res.status, 301);
    assert.equal(res.headers.get('location'), '/writing');
  });

  it('public/sitemap.xml lists /about and /writing', () => {
    assert.ok(SITEMAP.includes('<loc>https://auxilo.io/about</loc>'), 'sitemap has /about');
    assert.ok(SITEMAP.includes('<loc>https://auxilo.io/writing</loc>'), 'sitemap has /writing');
  });

  it('GET /api/info security.txt description reads "responsible disclosure contact"', async (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    const res = await fetch(`${baseUrl}/api/info`);
    assert.equal(res.status, 200);
    const payload = await res.json();
    const entry = payload.endpoints && payload.endpoints['/.well-known/security.txt'];
    assert.ok(entry, 'discovery lists /.well-known/security.txt');
    assert.ok(entry.description.includes(NEW_PHRASE), `description: ${entry.description}`);
    assert.ok(!entry.description.includes(OLD_PHRASE), 'old phrase gone');
  });

  it('structural: server.js discovery map carries the new phrase exactly once and the old phrase never', () => {
    const discoveryLine = `'/.well-known/security.txt': { price: 'free', method: 'GET', description: 'RFC 9116 security contact and ${NEW_PHRASE}' }`;
    assert.equal(SERVER_SRC.split(discoveryLine).length - 1, 1, 'exactly one discovery entry with the new phrase');
    assert.equal(SERVER_SRC.split(OLD_PHRASE).length - 1, 0, 'old phrase absent from server.js');
  });
});
