'use strict';

/**
 * test/nav-clearance.test.js — FIX-UNIT-LEGAL-CLEARANCE.md
 *
 * "The test that was missing": the fixed navigation's bottom edge is
 * always --nav-clear (99px). For every page in the sheet, at 1280, 768
 * and 375, with the page scrolled to the top:
 *
 *   1. No top-level content block sits under the navigation -- every
 *      block's own top edge is at or below the navigation's bottom edge.
 *   2. The first visible thing in the content sits exactly the section
 *      rhythm at that width (120 / 80 / 64) below the navigation's
 *      bottom edge, within half a pixel. The signed-out dashboard's
 *      sign-in card is the one named exception (a centred card whose own
 *      140px top padding is deliberately flat at every width, not the
 *      rhythm formula -- public/dashboard.html's own SPACING-0927 B-9
 *      comment).
 *
 * Compared against the tokens (RHYTHM / NAV_CLEAR below, the same values
 * test/helpers/spacing-metrics.js and test/helpers/ad-rules-check.js
 * already use), never a literal pixel position of something that holds
 * text.
 *
 * "First visible thing" is found the same way test/helpers/spacing-
 * metrics.js finds real content: a leaf-content scan (text node, image,
 * svg, or a self-contained control), not a container's own border-box
 * edge. A container's box can legitimately start at the same y as the
 * fixed nav while everything painted inside it starts lower, entirely
 * through its own padding, with no margin at all -- public/dashboard.html
 * (#login-view, 140px flat top padding, `main { margin-top: 0 }` opted
 * out on purpose, SPACING-0927 B-9) does exactly this, and a check that
 * used the box edge instead of the leaf content flagged it as a false
 * defect. Item 1 takes the minimum leaf-content top across every top-
 * level block (not just the first), so a defect anywhere on the page
 * still fails it; item 2 (the exact-rhythm match) uses only the first
 * top-level block, since that is the one thing the rhythm rule is about.
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
} = require('./helpers/staged-server');

const REPO = path.join(__dirname, '..');
const WIDTHS = [1280, 768, 375];
const HEIGHTS = { 1280: 900, 768: 1024, 375: 812 };
const RHYTHM = { 1280: 120, 768: 80, 375: 64 };
const TOL = 0.5;

const PAGES = [
  '/', '/for-builders', '/for-agents', '/how-it-works', '/pricing',
  '/works-with', '/about', '/connect', '/how-submissions-work',
  '/status', '/api', '/terms', '/privacy',
  '/legal/subprocessors', '/legal/supported-clients', '/dashboard',
];

// The signed-out dashboard's sign-in card: named exception to item 2
// only. Item 1 (nothing sits under the nav) still applies to it.
const RHYTHM_EXEMPT = new Set(['/dashboard']);

function near(a, b, tol) { return Math.abs(a - b) <= tol; }

// Self-contained page.evaluate() payload -- no closure over outer scope.
// isVisible/isLeafContent mirror test/helpers/spacing-metrics.js's own
// unionBox() helpers (the codebase's already-vetted way to find real
// painted content instead of a container's border-box edge).
function measureNavClearance() {
  function cs(el) { return getComputedStyle(el); }
  function rect(el) { return el.getBoundingClientRect(); }
  function isVisible(el) {
    if (!(el instanceof Element)) return false;
    const s = cs(el);
    if (s.display === 'none' || s.visibility === 'hidden') return false;
    if (parseFloat(s.opacity) === 0) return false;
    const r = rect(el);
    return r.width > 0 && r.height > 0;
  }
  function isLeafContent(el) {
    const tag = el.tagName.toUpperCase();
    if (['IMG', 'SVG', 'BUTTON', 'INPUT', 'TEXTAREA', 'SELECT', 'IFRAME', 'A'].includes(tag)) {
      const hasBlockKid = Array.from(el.children).some((k) => isVisible(k));
      if (tag === 'A' || tag === 'BUTTON') return !hasBlockKid;
      return true;
    }
    for (const node of el.childNodes) {
      if (node.nodeType === 3 && node.textContent.trim().length > 0) return true;
    }
    return el.children.length === 0 && el.textContent.trim().length > 0;
  }
  function shortSel(el) {
    let s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    const cls = (el.className && typeof el.className === 'string') ? el.className.trim() : '';
    if (cls) s += '.' + cls.split(/\s+/).slice(0, 2).join('.');
    return s;
  }
  function topOfLeafContent(root) {
    let top = Infinity;
    let sel = null;
    const all = [root, ...root.querySelectorAll('*')];
    for (const el of all) {
      if (!isVisible(el)) continue;
      if (cs(el).position === 'fixed') continue;
      if (!isLeafContent(el)) continue;
      const r = rect(el);
      if (r.width === 0 && r.height === 0) continue;
      if (r.top < top) { top = r.top; sel = shortSel(el); }
    }
    return { top: top === Infinity ? null : Math.round(top * 100) / 100, selector: sel };
  }

  const nav = document.getElementById('main-nav') || document.querySelector('nav');
  const navBottom = nav ? rect(nav).bottom : 0;

  const root = document.querySelector('main') || document.body;
  const skipTags = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT', 'NAV', 'FOOTER']);
  // The skip link is the first element in body on every page. On the legal template (no <main>; its wrapper
  // carries role="main") the blocks are body's children, and a skip link is not content under the navigation.
  const topBlocks = Array.from(root.children).filter((el) => isVisible(el) && !skipTags.has(el.tagName) && !el.classList.contains('skip-to-content'));

  const perBlock = topBlocks.map((el) => ({ selector: shortSel(el), ...topOfLeafContent(el) }));
  const minTop = perBlock.length
    ? perBlock.reduce((m, b) => (b.top !== null && (m === null || b.top < m) ? b.top : m), null)
    : null;
  const minSelector = perBlock.length
    ? (perBlock.find((b) => b.top === minTop) || {}).selector || null
    : null;
  const first = topBlocks.length ? topOfLeafContent(topBlocks[0]) : { top: null, selector: null };

  return {
    navBottom: Math.round(navBottom * 100) / 100,
    minTop,
    minSelector,
    firstTop: first.top,
    firstSelector: first.selector,
  };
}

describe('Nav clearance: nothing sits under the fixed nav, first thing sits exactly the rhythm below it', { timeout: 300_000 }, () => {
  let bootSkipReason = null;
  let tmpDir;
  let child;
  let baseUrl;
  let browser;
  let playwrightOk = false;
  const measurements = {};

  before(async () => {
    try {
      require.resolve('playwright', { paths: [REPO] });
    } catch (e) {
      return;
    }
    const honoEntry = require.resolve('hono', { paths: [REPO] });
    const nodeModulesDir = honoEntry.slice(0, honoEntry.lastIndexOf(`${path.sep}node_modules${path.sep}`) + '/node_modules'.length);
    const reservation = await reservePort();
    if ('skipReason' in reservation) {
      bootSkipReason = reservation.skipReason;
      return;
    }
    const { port } = reservation;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auxilo-nav-clearance-'));
    stageServer({
      repoRoot: REPO,
      tmpDir,
      nodeModulesDir,
      port,
      rootFiles: ['server.js', 'seed-knowledge.json', 'skills.json', 'openapi.json', 'package.json', 'model_config.json'],
      linkDirs: [],
      copyDirs: ['lib', 'public', 'prompts', 'config', 'docs'],
    });
    const boot = await bootServer({
      tmpDir,
      port,
      env: {
        NODE_ENV: 'test',
        SESSION_SECRET: 'nav-clearance-test-session-secret-0123456789ab',
        RESEND_API_KEY: '',
        LLM_SENSITIVITY_ENABLED: 'false',
        WALLET_PRIVATE_KEY: `0x${'11'.repeat(32)}`,
      },
      timeoutMs: 60_000,
      maxAttempts: 3,
    });
    if ('skipReason' in boot) {
      bootSkipReason = boot.skipReason;
      return;
    }
    child = boot.child;
    baseUrl = boot.baseUrl;
    const { chromium } = require(path.join(nodeModulesDir, 'playwright'));
    browser = await chromium.launch();
    playwrightOk = true;

    for (const route of PAGES) {
      measurements[route] = {};
      for (const width of WIDTHS) {
        const height = HEIGHTS[width];
        const ctx = await browser.newContext({ viewport: { width, height } });
        const page = await ctx.newPage();
        try {
          await page.goto(`${baseUrl}${route}`, { waitUntil: 'networkidle', timeout: 30_000 });
          await page.addStyleTag({ content: '.reveal { opacity: 1 !important; transform: none !important; }' });
          await page.waitForTimeout(120);
          measurements[route][width] = await page.evaluate(measureNavClearance);
        } catch (err) {
          measurements[route][width] = { error: err.message };
        } finally {
          await ctx.close();
        }
      }
    }
  });

  after(async () => {
    if (browser) await browser.close();
    if (child) await stopServer(child);
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  for (const route of PAGES) {
    for (const width of WIDTHS) {
      it(`${route} @ ${width}: nothing sits under the navigation`, (t) => {
        if (bootSkipReason) { t.skip(bootSkipReason); return; }
        if (!playwrightOk) { t.skip('playwright not resolvable'); return; }
        const m = measurements[route][width];
        assert.ok(m && !m.error, `measurement error: ${m && m.error}`);
        assert.ok(m.minTop !== null, `${route} @ ${width}: no visible content found`);
        assert.ok(
          m.minTop >= m.navBottom - TOL,
          `${route} @ ${width}: "${m.minSelector}" top=${m.minTop} is above the navigation's bottom edge (${m.navBottom})`,
        );
      });

      if (!RHYTHM_EXEMPT.has(route)) {
        it(`${route} @ ${width}: the first visible thing sits exactly the section rhythm (${RHYTHM[width]}) below the navigation`, (t) => {
          if (bootSkipReason) { t.skip(bootSkipReason); return; }
          if (!playwrightOk) { t.skip('playwright not resolvable'); return; }
          const m = measurements[route][width];
          assert.ok(m && !m.error, `measurement error: ${m && m.error}`);
          assert.ok(m.firstTop !== null, `${route} @ ${width}: no first visible thing found`);
          const gap = m.firstTop - m.navBottom;
          assert.ok(
            near(gap, RHYTHM[width], TOL),
            `${route} @ ${width}: "${m.firstSelector}" top=${m.firstTop}, navBottom=${m.navBottom}, gap=${gap}, ruled rhythm=${RHYTHM[width]}`,
          );
        });
      }
    }
  }
});
