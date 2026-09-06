'use strict';

/**
 * test/seo-baseline.test.js — SEO baseline (markup half), per
 * ~/.auxilo/handoffs/SEO-BASELINE-2026-09-06.md:
 *
 *   1. GET /terms  → 200, carries exactly one <link rel="canonical"> and an
 *      og:url matching the request path (https://auxilo.io/terms).
 *   2. GET /privacy → 200, carries exactly one <link rel="canonical"> and an
 *      og:url matching the request path (https://auxilo.io/privacy).
 *   3. public/sitemap.xml lists /status and /legal/supported-clients.
 *   4. public/sitemap.xml carries no <lastmod> anywhere (dropped per the
 *      baseline's "automated or dropped" ruling — this build drops).
 *
 * /earnings is explicitly HELD by the same baseline (no 301, no sitemap/nav
 * removal) — this suite makes no assertion about it.
 *
 * Staged-server pattern: test/ad-routes.test.js.
 *
 * Runner: node --test test/seo-baseline.test.js
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

function canonicalLinks(html) {
  return html.match(/<link rel="canonical"[^>]*>/g) || [];
}

function metaContent(html, property) {
  const re = new RegExp(
    `<meta (?:property|name)="${property}" content="([^"]*)"`
  );
  const m = html.match(re);
  return m ? m[1] : null;
}

describe('SEO baseline (markup): /terms + /privacy canonical/og, sitemap /status + /legal/supported-clients, lastmod dropped', { timeout: 180_000 }, () => {
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
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auxilo-seo-baseline-'));
    stageServer({
      repoRoot: REPO,
      tmpDir,
      nodeModulesDir,
      port,
      rootFiles: ['server.js', 'seed-knowledge.json', 'skills.json', 'openapi.json', 'package.json', 'model_config.json'],
      linkDirs: ['lib', 'public', 'prompts', 'config', 'docs'],
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
        SESSION_SECRET: 'seo-baseline-test-session-secret-0123456789',
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

  it('GET /terms → 200, exactly one canonical, og:url matches request path', async (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    const res = await fetch(`${baseUrl}/terms`);
    assert.equal(res.status, 200);
    const body = await res.text();
    const canonicals = canonicalLinks(body);
    assert.equal(canonicals.length, 1, `exactly one canonical, found ${canonicals.length}`);
    assert.ok(canonicals[0].includes('href="https://auxilo.io/terms"'), canonicals[0]);
    assert.equal(metaContent(body, 'og:url'), 'https://auxilo.io/terms');
    assert.equal(metaContent(body, 'og:type'), 'website');
    assert.equal(metaContent(body, 'twitter:card'), 'summary');
  });

  it('GET /privacy → 200, exactly one canonical, og:url matches request path', async (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    const res = await fetch(`${baseUrl}/privacy`);
    assert.equal(res.status, 200);
    const body = await res.text();
    const canonicals = canonicalLinks(body);
    assert.equal(canonicals.length, 1, `exactly one canonical, found ${canonicals.length}`);
    assert.ok(canonicals[0].includes('href="https://auxilo.io/privacy"'), canonicals[0]);
    assert.equal(metaContent(body, 'og:url'), 'https://auxilo.io/privacy');
    assert.equal(metaContent(body, 'og:type'), 'website');
    assert.equal(metaContent(body, 'twitter:card'), 'summary');
  });

  it('public/sitemap.xml lists /status and /legal/supported-clients', () => {
    assert.ok(SITEMAP.includes('<loc>https://auxilo.io/status</loc>'), 'sitemap has /status');
    assert.ok(
      SITEMAP.includes('<loc>https://auxilo.io/legal/supported-clients</loc>'),
      'sitemap has /legal/supported-clients'
    );
  });

  it('public/sitemap.xml carries no <lastmod> anywhere (dropped, not automated, per this build)', () => {
    assert.ok(!/<lastmod>/.test(SITEMAP), 'no <lastmod> tag present in sitemap.xml');
  });
});
