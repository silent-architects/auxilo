'use strict';

/**
 * test/legal-shell-footer.test.js — Wave C.3b, item 1 + 2.
 *
 * (1) `serveLegalPage` in server.js (the renderer behind /terms, /privacy,
 *     /legal/subprocessors, /legal/supported-clients, /dmca) used to close
 *     its `.legal-wrap` and stop — none of the five legal routes carried the
 *     site footer, so a visitor landing on any of them (the only two of
 *     which, /terms and /privacy, previously had no route home at all) had
 *     no path back to /about, /writing, /status, the security.txt/agent.json
 *     links, or GitHub. This test boots the real server and asserts every
 *     serveLegalPage route's footer is byte-identical (after whitespace
 *     normalization) to /pricing's shipped footer — the copy-source named in
 *     the wave's build spec (packet 3 rev 2 footer set).
 *
 * (2) A structural, file-level pin (no server boot) that `--svg-label` in
 *     public/styles.css is 15px, and that the demand exchange <g> in
 *     public/for-agents.html carries an explicit `font-size="14"` override
 *     with a comment naming the measurement behind it — so a future CSS
 *     edit that touches either value has to touch this test too, per
 *     AGENTS.md's "any commit that adds or removes tests must bump the
 *     [check-test-count.sh] pin" discipline for the token/override pair
 *     they travel together under.
 *
 * Staged-server pattern: test/seo-baseline.test.js / test/ad-routes.test.js.
 *
 * Runner: node --test test/legal-shell-footer.test.js
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

// Every route served through serveLegalPage (server.js's own app.get list,
// read directly rather than re-typed, so this suite can't silently drift
// from the real route table).
const SERVER_SRC = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');
const STYLES_CSS = fs.readFileSync(path.join(REPO, 'public', 'styles.css'), 'utf8');
const FOR_AGENTS_HTML = fs.readFileSync(path.join(REPO, 'public', 'for-agents.html'), 'utf8');

function legalRoutes() {
  const re = /app\.get\('([^']+)',\s*\(c\)\s*=>\s*serveLegalPage\(/g;
  const routes = [];
  let m;
  while ((m = re.exec(SERVER_SRC))) routes.push(m[1]);
  return routes;
}

function extractFooter(html) {
  const start = html.indexOf('<footer>');
  const end = html.indexOf('</footer>', start);
  assert.notEqual(start, -1, 'no <footer> found in page');
  assert.notEqual(end, -1, 'no closing </footer> found in page');
  return html.slice(start, end + '</footer>'.length);
}

// Normalizes whitespace between tags so a reflowed-but-unchanged footer
// still compares equal, then strips the (legal-shell-only) inline id
// attribute noise isn't a concern here since none exists on this markup.
function normalizeFooter(footerHtml) {
  return footerHtml.replace(/>\s+</g, '><').trim();
}

function footerLinks(footerHtml) {
  return [...footerHtml.matchAll(/<a href="([^"]+)"/g)].map((m) => m[1]);
}

const ROUTES = legalRoutes();

describe('LEGAL-SHELL-FOOTER: serveLegalPage routes carry /pricing\'s footer byte-for-byte', { timeout: 180_000 }, () => {
  let tmpDir;
  let child;
  let baseUrl;
  let bootSkipReason = null;

  before(async () => {
    assert.ok(ROUTES.length >= 5, `expected at least 5 serveLegalPage routes in server.js, found ${ROUTES.length}: ${ROUTES.join(', ')}`);

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
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auxilo-legal-footer-'));
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
        SESSION_SECRET: 'legal-shell-footer-test-session-secret-0123456789',
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

  it('GET /pricing serves a <footer> with the packet-3-rev-2 link set', async (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    const res = await fetch(`${baseUrl}/pricing`);
    assert.equal(res.status, 200);
    const body = await res.text();
    const links = footerLinks(extractFooter(body));
    assert.deepEqual(links, [
      '/',
      '/about',
      '/writing',
      '/status',
      '/.well-known/security.txt',
      '/.well-known/agent.json',
      '/terms',
      '/privacy',
      'https://github.com/silent-architects/auxilo',
    ]);
  });

  for (const route of legalRoutes()) {
    it(`GET ${route} carries /pricing's footer, byte-for-byte after whitespace normalization`, async (t) => {
      if (bootSkipReason) { t.skip(bootSkipReason); return; }
      const [pricingRes, routeRes] = await Promise.all([
        fetch(`${baseUrl}/pricing`),
        fetch(`${baseUrl}${route}`),
      ]);
      assert.equal(pricingRes.status, 200);
      assert.equal(routeRes.status, 200, `${route} did not return 200`);
      const pricingFooter = normalizeFooter(extractFooter(await pricingRes.text()));
      const routeFooter = normalizeFooter(extractFooter(await routeRes.text()));
      assert.equal(routeFooter, pricingFooter,
        `${route}'s footer diverges from /pricing's after whitespace normalization`);
    });

    it(`GET ${route} keeps its "← Back to Auxilo" link above the footer`, async (t) => {
      if (bootSkipReason) { t.skip(bootSkipReason); return; }
      const res = await fetch(`${baseUrl}${route}`);
      assert.equal(res.status, 200);
      const body = await res.text();
      assert.ok(body.includes('class="legal-back">← Back to Auxilo</a>'),
        `${route} must keep the existing "← Back to Auxilo" link`);
      const backIndex = body.indexOf('legal-back');
      const footerIndex = body.indexOf('<footer>');
      assert.ok(backIndex !== -1 && footerIndex !== -1 && backIndex < footerIndex,
        `${route}'s "← Back to Auxilo" link must appear before the footer`);
    });
  }
});

describe('LEGAL-SHELL-FOOTER: --svg-label / demand-exchange override structural pin', () => {
  it('public/styles.css sets --svg-label to 15px', () => {
    const m = STYLES_CSS.match(/--svg-label:\s*([0-9.]+px);/);
    assert.ok(m, '--svg-label must be declared in public/styles.css :root');
    assert.equal(m[1], '15px',
      `--svg-label is ${m[1]}, expected 15px (Wave C.3b: 15 is the smallest whole value clearing the 12px floor on all three drawings at 375px, tightest being the fork at 15 * 0.8156 = 12.23)`);
  });

  it('for-agents.html\'s demand exchange <g> overrides font-size to 14, with a comment naming the measurement', () => {
    const gIndex = FOR_AGENTS_HTML.indexOf('font-size="14"');
    assert.notEqual(gIndex, -1,
      'for-agents.html must carry an explicit font-size="14" override on the demand exchange <g> (its widest label overflows its rect at the sitewide 15px token)');
    // The override must sit on the demand exchange's own <g>, not some
    // unrelated element that happens to share the literal.
    const gTagStart = FOR_AGENTS_HTML.lastIndexOf('<g ', gIndex);
    const gTag = FOR_AGENTS_HTML.slice(gTagStart, gIndex + 'font-size="14"'.length);
    assert.match(gTag, /text-anchor="middle"/, 'the font-size="14" override must be on the demand exchange label <g>');

    // A comment naming the measurement must precede the override (not a
    // bare magic-number override with no rationale on record).
    const precedingSlice = FOR_AGENTS_HTML.slice(Math.max(0, gTagStart - 600), gTagStart);
    assert.match(precedingSlice, /<!--[\s\S]*measured[\s\S]*?-->/i,
      'the font-size="14" override must be preceded by a comment naming the measurement behind it');
    assert.match(precedingSlice, /364/, 'the preceding comment should name the rect width the measurement was taken against');
  });
});
