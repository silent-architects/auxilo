'use strict';

/**
 * test/gsc-verification.test.js — Google Search Console site verification
 * file for https://auxilo.io/ (SITE-PM row SEARCH-CONSOLE-VERIFY).
 *
 * public/google319f7b1ffb42b07d.html must be served verbatim at
 * /google319f7b1ffb42b07d.html: 200, text/html, body == Google's exact
 * verification string (trailing newline aside), no redirect. It must never
 * appear in sitemap.xml (it is not a page).
 *
 * Staged-server pattern: test/ad-routes.test.js / test/clean-lane-phase-a2.test.js.
 *
 * Runner: node --test test/gsc-verification.test.js
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
const SITEMAP = fs.readFileSync(path.join(REPO, 'public', 'sitemap.xml'), 'utf8');
const VERIFY_FILE = 'google319f7b1ffb42b07d.html';
const VERIFY_STRING = 'google-site-verification: google319f7b1ffb42b07d.html';

describe('GSC site verification file', { timeout: 180_000 }, () => {
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
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auxilo-gsc-verify-'));
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
        SESSION_SECRET: 'gsc-verify-test-session-secret-0123456789',
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

  it(`GET /${VERIFY_FILE} → 200 text/html, body exactly Google's verification string, no redirect`, async (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    const res = await fetch(`${baseUrl}/${VERIFY_FILE}`, { redirect: 'manual' });
    assert.equal(res.status, 200, 'served 200, not redirected/404');
    assert.match(res.headers.get('content-type') || '', /^text\/html/, 'content-type starts with text/html');
    const body = await res.text();
    assert.equal(body.trim(), VERIFY_STRING, 'body trimmed equals the exact Google-issued string');
  });

  it('public/sitemap.xml does not list the verification file', () => {
    assert.ok(!SITEMAP.includes(VERIFY_FILE), 'verification file absent from sitemap.xml');
  });
});
