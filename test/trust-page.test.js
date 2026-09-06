'use strict';

/**
 * test/trust-page.test.js — Trust page (/how-submissions-work): engineering
 * half of TRUST-PAGE-BUILD-SPEC-2026-09-02.md (rev 3g) / PUNCH-LIST
 * TRUST-PAGE + TRUST-REDIRECTS rows.
 *
 *   1. GET /how-submissions-work → 200 text/html containing the page <title>.
 *   2. Four redirects → 301 to /how-submissions-work: /trust, /governance,
 *      /for-platforms, /platforms.
 *   3. Head tags (title, description, canonical, og:*, twitter:*) present
 *      and byte-equal to the spec's SEO strings.
 *   4. h1 = the spec's h1 (`What stands between a submission and the public
 *      catalog`).
 *   5. The page never contains "Claude Code" as a requirement phrase —
 *      Tyler's ruling 2026-09-06 ("approved - build the trust page without
 *      the mention of a specific Claude Code requirement"). Asserted as: the
 *      literal string "Claude Code" does not appear anywhere in the served
 *      page at all (the strictest reading — the approved §2b/§3b copy names
 *      no client by name, so a clean page has zero occurrences).
 *   6. sitemap.xml lists the route; llms.txt carries the spec's Quick-start
 *      line.
 *   7. Structural: server.js registers the route and all four redirects.
 *
 * Staged-server pattern: test/ad-routes.test.js / test/clean-lane-phase-a2.test.js.
 *
 * Runner: node --test test/trust-page.test.js
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
const LLMS_TXT = fs.readFileSync(path.join(REPO, 'public', 'llms.txt'), 'utf8');
const TRUST_HTML = fs.readFileSync(path.join(REPO, 'public', 'how-submissions-work.html'), 'utf8');

const TITLE = 'What Stands Between a Submission and the Public Catalog | Auxilo';
const DESCRIPTION = "Auxilo is a marketplace for what coding agents learn. What every new submission passes before it reaches the public catalog, what Auxilo does not claim, and where the catalog stands today.";
const CANONICAL = 'https://auxilo.io/how-submissions-work';
const H1 = 'What stands between a submission and the public catalog';
const LLMS_LINE = '- How submissions reach the catalog: https://auxilo.io/how-submissions-work';
const REDIRECT_SOURCES = ['/trust', '/governance', '/for-platforms', '/platforms'];

describe('Trust page: route, redirects, head tags, h1, forbidden strings', { timeout: 180_000 }, () => {
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
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auxilo-trust-page-'));
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
        SESSION_SECRET: 'trust-page-test-session-secret-0123456789',
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

  it('GET /how-submissions-work → 200 text/html containing the page <title>', async (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    const res = await fetch(`${baseUrl}/how-submissions-work`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /^text\/html/);
    const body = await res.text();
    assert.ok(body.includes(`<title>${TITLE}</title>`), 'body carries the title tag');
  });

  for (const src of REDIRECT_SOURCES) {
    it(`GET ${src} → 301 to /how-submissions-work`, async (t) => {
      if (bootSkipReason) { t.skip(bootSkipReason); return; }
      const res = await fetch(`${baseUrl}${src}`, { redirect: 'manual' });
      assert.equal(res.status, 301);
      assert.equal(res.headers.get('location'), '/how-submissions-work');
    });
  }

  it('head tags present and byte-equal to the spec strings', () => {
    assert.ok(TRUST_HTML.includes(`<title>${TITLE}</title>`), 'title');
    assert.ok(TRUST_HTML.includes(`<meta name="description" content="${DESCRIPTION}">`), 'description');
    assert.ok(TRUST_HTML.includes(`<link rel="canonical" href="${CANONICAL}" />`), 'canonical');
    assert.ok(TRUST_HTML.includes(`<meta property="og:type" content="website" />`), 'og:type');
    assert.ok(TRUST_HTML.includes(`<meta property="og:site_name" content="Auxilo" />`), 'og:site_name');
    assert.ok(TRUST_HTML.includes(`<meta property="og:url" content="${CANONICAL}" />`), 'og:url');
    assert.ok(TRUST_HTML.includes(`<meta property="og:title" content="${TITLE}" />`), 'og:title');
    assert.ok(TRUST_HTML.includes(`<meta property="og:description" content="${DESCRIPTION}" />`), 'og:description');
    assert.ok(TRUST_HTML.includes(`<meta property="og:image" content="https://auxilo.io/og-image.png" />`), 'og:image');
    assert.ok(TRUST_HTML.includes(`<meta name="twitter:card" content="summary_large_image" />`), 'twitter:card');
    assert.ok(TRUST_HTML.includes(`<meta name="twitter:title" content="${TITLE}" />`), 'twitter:title');
    assert.ok(TRUST_HTML.includes(`<meta name="twitter:description" content="${DESCRIPTION}" />`), 'twitter:description');
    assert.ok(TRUST_HTML.includes(`<meta name="twitter:image" content="https://auxilo.io/og-image.png" />`), 'twitter:image');
  });

  it('h1 = the spec\'s h1, and exactly one h1 on the page', () => {
    const h1Matches = TRUST_HTML.match(/<h1[^>]*>([\s\S]*?)<\/h1>/g) || [];
    assert.equal(h1Matches.length, 1, 'exactly one <h1>');
    assert.ok(h1Matches[0].includes(H1), `h1 reads "${H1}"`);
  });

  it('no "Claude Code" requirement phrase anywhere in the served page (Tyler\'s ruling 2026-09-06)', () => {
    assert.ok(!TRUST_HTML.includes('Claude Code'), 'the string "Claude Code" does not appear on the page');
  });

  it('sitemap.xml lists /how-submissions-work; llms.txt carries the spec\'s Quick-start line', () => {
    assert.ok(SITEMAP.includes(`<loc>${CANONICAL}</loc>`), 'sitemap has /how-submissions-work');
    assert.ok(LLMS_TXT.includes(LLMS_LINE), 'llms.txt carries the spec line verbatim');
  });

  it('structural: server.js registers the route and all four redirects', () => {
    assert.ok(SERVER_SRC.includes(`app.get('/how-submissions-work', (c) => {`), 'route handler present');
    for (const src of REDIRECT_SOURCES) {
      assert.ok(
        SERVER_SRC.includes(`app.get('${src}', (c) => c.redirect('/how-submissions-work', 301));`),
        `redirect handler present for ${src}`
      );
    }
  });
});
