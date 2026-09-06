'use strict';

/**
 * test/connect-page.test.js — /connect: SITE-PM packet 13 rev 2
 * (AD-STRINGS-PACKET-13-CONNECT-PAGE-2026-09-06.md, BUILD-READY).
 *
 * Tyler, verbatim (the packet's own authority for this page's existence):
 * "I DO NOT PREFER linking to anchor text - especially in the nav - i would
 * prefer we link to a page - so for instance, Connect Your Agent - should
 * have its own page with a very simple step by step process, not a link to
 * the CTA on the home page." /connect is that page.
 *
 * Coverage:
 *   1. GET /connect → 200 text/html.
 *   2. Head strings: <title>, meta description, og:title, og:description,
 *      twitter:title, twitter:description, og:site_name, canonical — all
 *      the packet's exact "Head" section strings.
 *   3. Exactly one <h1>, reading "Connect Your Agent" (Title Case, per the
 *      2026-09-06 night casing addendum — TITLE-CASE-HEADINGS-SWEEP-
 *      2026-09-06.md's explicit inventory for this new page).
 *   4. The five numbered steps' <h2> headings appear, in order, each in
 *      Title Case (none end in a terminal period, so all five are governed
 *      by the casing addendum).
 *   5. The install command (`npx auxilo setup`) block appears exactly once
 *      — checked as the rendered <pre> command element, not raw substring
 *      count, because the packet's own meta description text also contains
 *      the literal phrase "npx auxilo setup" (and og/twitter duplicate it
 *      again) — that's expected head-tag duplication, not a second gold
 *      event on the page.
 *   6. Fixed-strings "device code" and "restart your client" each appear
 *      exactly once within <body> (the packet's check #1) — checked against
 *      body content only, since the meta description also independently
 *      contains "restart your client" as SEO copy, which is not the same
 *      claim as "appears once in the visible page".
 *   7. Step 2's fallback link is pinned to exactly /legal/supported-clients
 *      (the packet's documented interim target until /works-with ships —
 *      pinning the href means that swap is a one-line diff later).
 *   8. No page served under public/ or server.js's legal-page template
 *      still links href="/#install", href="#connect", or
 *      href="/for-builders#connect" — every one of those was repointed to
 *      /connect in this same wave. index.html keeps id="install" as an
 *      anchor TARGET (not an href) for any page that still deep-links it;
 *      that id surviving is asserted separately, not confused with an href.
 *   9. public/sitemap.xml lists /connect.
 *
 * Staged-server pattern: test/ad-routes.test.js.
 *
 * Runner: node --test test/connect-page.test.js
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
const CONNECT_HTML = fs.readFileSync(path.join(REPO, 'public', 'connect.html'), 'utf8');
const INDEX_HTML = fs.readFileSync(path.join(REPO, 'public', 'index.html'), 'utf8');

// Every HTML file git tracks under public/, enumerated from the source of
// truth (git ls-files), not a hand-typed list — the same discipline the
// "sweeps enumerate from git ls-files" lesson names, so a file added or
// renamed after this test was written still gets swept.
const { execFileSync } = require('node:child_process');
const TRACKED_HTML_FILES = execFileSync('git', ['ls-files', 'public/'], { cwd: REPO, encoding: 'utf8' })
  .split('\n')
  .filter((f) => f.endsWith('.html'));

function bodyOf(html) {
  const start = html.indexOf('<body>');
  const end = html.lastIndexOf('</body>');
  assert.notEqual(start, -1, 'page has a <body>');
  assert.notEqual(end, -1, 'page has a closing </body>');
  return html.slice(start, end);
}

function countOccurrences(haystack, needle) {
  return haystack.split(needle).length - 1;
}

const CONNECT_BODY = bodyOf(CONNECT_HTML);

const EXPECTED_TITLE = 'Connect your agent | Auxilo';
const EXPECTED_DESCRIPTION = 'Run npx auxilo setup, choose whether to capture sessions, and your agent can search Auxilo once you restart your client. You approve anything that publishes.';

const EXPECTED_H2_ORDER = [
  'Run One Command',
  'Choose Whether to Capture Sessions',
  'Your Agent Stops Starting Over',
  'Approve What Publishes',
  'Earn When Another Agent Unlocks Your Learning',
];

describe('/connect: SITE-PM packet 13 rev 2', { timeout: 180_000 }, () => {
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
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auxilo-connect-page-'));
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
        SESSION_SECRET: 'connect-page-test-session-secret-0123456789',
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

  it('GET /connect → 200 text/html', async (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    const res = await fetch(`${baseUrl}/connect`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /^text\/html/);
    const body = await res.text();
    assert.ok(body.includes('Connect Your Agent'), 'served body carries the h1 text');
  });

  it('head: <title> is exactly the packet string', () => {
    assert.ok(CONNECT_HTML.includes(`<title>${EXPECTED_TITLE}</title>`), 'title tag');
  });

  it('head: meta description is exactly the packet string', () => {
    assert.ok(CONNECT_HTML.includes(`<meta name="description" content="${EXPECTED_DESCRIPTION}">`), 'description meta');
  });

  it('head: og:title and twitter:title equal the title (packet bind)', () => {
    assert.ok(CONNECT_HTML.includes(`<meta property="og:title" content="${EXPECTED_TITLE}" />`), 'og:title');
    assert.ok(CONNECT_HTML.includes(`<meta name="twitter:title" content="${EXPECTED_TITLE}" />`), 'twitter:title');
  });

  it('head: og:description and twitter:description equal the description', () => {
    assert.ok(CONNECT_HTML.includes(`<meta property="og:description" content="${EXPECTED_DESCRIPTION}" />`), 'og:description');
    assert.ok(CONNECT_HTML.includes(`<meta name="twitter:description" content="${EXPECTED_DESCRIPTION}" />`), 'twitter:description');
  });

  it('head: og:site_name is "Auxilo"', () => {
    assert.ok(CONNECT_HTML.includes('<meta property="og:site_name" content="Auxilo" />'), 'og:site_name');
  });

  it('head: canonical is https://auxilo.io/connect', () => {
    assert.ok(CONNECT_HTML.includes('<link rel="canonical" href="https://auxilo.io/connect" />'), 'canonical');
  });

  it('exactly one <h1>, reading "Connect Your Agent"', () => {
    const h1s = [...CONNECT_BODY.matchAll(/<h1[^>]*>([^<]*)<\/h1>/g)];
    assert.equal(h1s.length, 1, `expected exactly one h1, found ${h1s.length}`);
    assert.equal(h1s[0][1].trim(), 'Connect Your Agent');
  });

  it('the five step h2 headings appear, in order, exactly as the casing addendum names them', () => {
    const h2s = [...CONNECT_BODY.matchAll(/<h2[^>]*>([^<]*)<\/h2>/g)].map((m) => m[1].trim());
    assert.deepEqual(h2s, EXPECTED_H2_ORDER);
  });

  it('none of the five h2 headings end in a terminal period, question mark, or exclamation point (so Title Case governs all five per the casing addendum)', () => {
    for (const h of EXPECTED_H2_ORDER) {
      assert.ok(!/[.?!]$/.test(h), `${h} must not end in terminal punctuation`);
    }
  });

  it('the install command block (npx auxilo setup) appears exactly once as the rendered <pre> command', () => {
    const matches = [...CONNECT_HTML.matchAll(/<pre[^>]*>npx auxilo setup<\/pre>/g)];
    assert.equal(matches.length, 1, `expected exactly one install <pre> block, found ${matches.length}`);
  });

  it('"device code" appears exactly once in <body>', () => {
    assert.equal(countOccurrences(CONNECT_BODY, 'device code'), 1);
  });

  it('"restart your client" appears exactly once in <body>, case-insensitively (step 3 opens the sentence with "Restart your client"; the meta description also carries the phrase in <head>, which is expected SEO duplication, not a second body claim)', () => {
    const matches = CONNECT_BODY.match(/restart your client/gi) || [];
    assert.equal(matches.length, 1, `found ${matches.length} case-insensitive occurrences in body`);
  });

  it('step 5 carries the ratified accrual pair: "Withdrawals open soon" linked to /status, and "not guaranteed"', () => {
    assert.ok(CONNECT_HTML.includes('<a href="/status">Withdrawals open soon</a>'), 'status link');
    assert.ok(CONNECT_HTML.includes('not guaranteed'), 'not-guaranteed clause');
  });

  it('step 2\'s fallback link is pinned to exactly /legal/supported-clients (swap to /works-with is a one-line change here when it ships)', () => {
    assert.ok(
      CONNECT_HTML.includes('<a href="/legal/supported-clients">See what Auxilo captures on each client</a>'),
      'fallback href pinned to /legal/supported-clients with the exact packet link text'
    );
  });

  it('the foot link "How it works, in full" points at /how-it-works', () => {
    assert.ok(CONNECT_HTML.includes('<a href="/how-it-works">How it works, in full</a>'));
  });

  it('the nav CTA on /connect itself points at /connect (self-link, same treatment as every other page)', () => {
    assert.ok(CONNECT_HTML.includes('<a href="/connect" id="nav-cta-access" class="nav-cta">Connect your agent</a>'));
  });

  it('no served page or server.js legal-page template still links href="/#install", href="#connect", or href="/for-builders#connect"', () => {
    const offenders = [];
    for (const relFile of TRACKED_HTML_FILES) {
      const html = fs.readFileSync(path.join(REPO, relFile), 'utf8');
      if (html.includes('href="/#install"')) offenders.push(`${relFile}: href="/#install"`);
      if (html.includes('href="#connect"')) offenders.push(`${relFile}: href="#connect"`);
      if (html.includes('href="/for-builders#connect"')) offenders.push(`${relFile}: href="/for-builders#connect"`);
    }
    if (SERVER_SRC.includes('href="/#install"')) offenders.push('server.js: href="/#install"');
    if (SERVER_SRC.includes('href="#connect"')) offenders.push('server.js: href="#connect"');
    assert.deepEqual(offenders, [], `stale hrefs remain: ${offenders.join(', ')}`);
  });

  it('index.html keeps id="install" as an anchor TARGET (not removed) even though it is no longer a link target from elsewhere', () => {
    assert.ok(INDEX_HTML.includes('id="install"'), 'index.html must keep the #install anchor target');
  });

  it('every tracked page carries href="/connect" in its nav CTA (the repointed link)', () => {
    const missing = [];
    for (const relFile of TRACKED_HTML_FILES) {
      const html = fs.readFileSync(path.join(REPO, relFile), 'utf8');
      // dashboard.html and writing/index.html-adjacent pages without the
      // shared nav-cta pattern are out of scope for this specific check;
      // only pages that ship the shared "Connect your agent" CTA text count.
      if (html.includes('Connect your agent') && !html.includes('href="/connect"')) {
        missing.push(relFile);
      }
    }
    assert.deepEqual(missing, [], `pages with a stale nav CTA href: ${missing.join(', ')}`);
  });

  it('public/sitemap.xml lists /connect', () => {
    assert.ok(SITEMAP.includes('<loc>https://auxilo.io/connect</loc>'), 'sitemap has /connect');
  });

  it('server.js defines a GET /connect route serving connect.html', () => {
    assert.match(SERVER_SRC, /app\.get\('\/connect',\s*\(c\)\s*=>\s*\{[\s\S]{0,200}connect\.html/);
  });
});
