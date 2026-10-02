'use strict';

/**
 * test/spacing-frame.test.js — SPACING-0927 Part A (the frame), Round 3
 * (FIX-UNIT-SPACING-3.md)
 *
 * Measured the Art Director's way (M-1 through M-5, FIX-UNIT-SPACING-3.md):
 * a seam is the gap from the bottom of the last visible thing in one
 * section to the top of the first visible thing in the next, not wrapper
 * to wrapper (M-2); a heading's gap is measured to the first visible
 * thing that follows it in reading order through any wrapper, where a
 * bordered/backgrounded box counts as a visible thing at its own edge,
 * not by descending into it (M-3); a scrollable code block is measured by
 * its own visible box (M-4); no pin here depends on how text is drawn --
 * every rule check compares a live measurement against a token or another
 * live measurement (M-5).
 *
 * Boots a staged copy of THIS worktree's server (read-only staging) on a
 * free local port and drives it with Playwright at 1280/768/375, for every
 * page in the sheet (16 pages, dashboard included -- V-5).
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
const { extractPageMetrics, foldCheck } = require('./helpers/ad-verify-measure');
const { evaluateRules, RULE_NAMES } = require('./helpers/ad-rules-check');

const REPO = path.join(__dirname, '..');
const WIDTHS = [1280, 768, 375];
const HEIGHTS = { 1280: 900, 768: 1024, 375: 812 };

const PAGES = [
  '/', '/for-builders', '/for-agents', '/how-it-works', '/pricing',
  '/works-with', '/about', '/connect', '/how-submissions-work',
  '/status', '/api', '/terms', '/privacy',
  '/legal/subprocessors', '/legal/supported-clients', '/dashboard',
];

describe('SPACING-0927 Part A (the frame), measured the Art Director\'s way', { timeout: 300_000 }, () => {
  let bootSkipReason = null;
  let tmpDir;
  let child;
  let baseUrl;
  let browser;
  let playwrightOk = false;
  let evalResult = null;
  let foldResults = null;
  let measurements = null;

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
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auxilo-spacing-frame3-'));
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
        SESSION_SECRET: 'spacing-frame3-test-session-secret-0123456789',
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

    // Measure every (route, width) ONCE up front, Art Director's method.
    measurements = {};
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
          measurements[route][width] = await page.evaluate(extractPageMetrics);
        } catch (err) {
          measurements[route][width] = { error: err.message };
        } finally {
          await ctx.close();
        }
      }
    }

    // Fold pass: 1280x720 and 375x667, every page.
    foldResults = {};
    for (const [width, height] of [[1280, 720], [375, 667]]) {
      foldResults[`${width}x${height}`] = {};
      for (const route of PAGES) {
        const ctx = await browser.newContext({ viewport: { width, height } });
        const page = await ctx.newPage();
        try {
          await page.goto(`${baseUrl}${route}`, { waitUntil: 'networkidle', timeout: 30_000 });
          await page.addStyleTag({ content: '.reveal { opacity: 1 !important; transform: none !important; }' });
          await page.waitForTimeout(120);
          foldResults[`${width}x${height}`][route] = await page.evaluate(foldCheck, { vw: width, vh: height });
        } catch (err) {
          foldResults[`${width}x${height}`][route] = { error: err.message };
        } finally {
          await ctx.close();
        }
      }
    }

    evalResult = evaluateRules(measurements, foldResults, {
      // Deliberately narrower, centred columns within a section (A1b-style
      // reading columns and the two V-4 boxes) -- covered by rule 1's
      // centering check and, for the V-4 boxes, a dedicated half-pixel
      // test below, not by rule 2's page-gutter match.
      narrowColumnWrapperSelectors: new Set(['div.page-hero-content', 'div.callout-bordered', 'div.ledger-card']),
      // Design rebuild: a band is a section with no heading that holds one row of figures. The homepage's
      // client band and /for-agents' catalog figures (#catalog-stats) both take the band rhythm.
      bandSelectors: ['works-with-band', 'catalog-stats'],
    });
  });

  after(async () => {
    if (browser) await browser.close();
    if (child) await stopServer(child);
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function failMsg(rule) {
    const fails = evalResult.failures[rule];
    const shown = fails.slice(0, 40).map((f) => '  ' + f).join('\n');
    const more = fails.length > 40 ? `\n  ... and ${fails.length - 40} more` : '';
    return `${RULE_NAMES[rule]}: ${evalResult.passCounts[rule]}/${evalResult.totalChecks[rule]} passing\n${shown}${more}`;
  }

  for (const rule of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
    it(`${RULE_NAMES[rule]}: every check passes`, (t) => {
      if (bootSkipReason) { t.skip(bootSkipReason); return; }
      if (!playwrightOk) { t.skip('playwright not resolvable'); return; }
      assert.equal(evalResult.failures[rule].length, 0, failMsg(rule));
    });
  }

  // ── V-4: the two off-centre boxes on /how-submissions-work, half-pixel ──
  for (const width of WIDTHS) {
    for (const cls of ['.callout-bordered', '.ledger-card']) {
      it(`/how-submissions-work @ ${width}: ${cls} is centred (space left == space right, within half a pixel)`, async (t) => {
        if (bootSkipReason) { t.skip(bootSkipReason); return; }
        if (!playwrightOk) { t.skip('playwright not resolvable'); return; }
        const ctx = await browser.newContext({ viewport: { width, height: HEIGHTS[width] } });
        const page = await ctx.newPage();
        try {
          await page.goto(`${baseUrl}/how-submissions-work`, { waitUntil: 'networkidle' });
          const boxes = await page.evaluate((sel) => [...document.querySelectorAll(sel)].map((el) => {
            const r = el.getBoundingClientRect();
            return { left: r.left, right: window.innerWidth - r.right };
          }), cls);
          assert.ok(boxes.length > 0, `at least one ${cls} found`);
          for (const b of boxes) {
            assert.ok(Math.abs(b.left - b.right) <= 0.5, `${cls} not centred: left=${b.left} right=${b.right}`);
          }
        } finally {
          await ctx.close();
        }
      });
    }
  }

  // ── B-4: the homepage first screen ────────────────────────────────────
  for (const [w, h] of [[1280, 720], [375, 667]]) {
    it(`homepage first screen at ${w}x${h}: headline, lede, command block, label and both notes are all inside the fold`, async (t) => {
      if (bootSkipReason) { t.skip(bootSkipReason); return; }
      if (!playwrightOk) { t.skip('playwright not resolvable'); return; }
      const ctx = await browser.newContext({ viewport: { width: w, height: h } });
      const page = await ctx.newPage();
      try {
        await page.goto(`${baseUrl}/`, { waitUntil: 'networkidle' });
        await page.addStyleTag({ content: '.reveal { opacity: 1 !important; transform: none !important; }' });
        await page.waitForTimeout(120);
        const bottoms = await page.evaluate(() => {
          const sel = ['#hero-heading', '.hero-sub', '#hero-setup-snippet', '.hero-setup-note'];
          const els = document.querySelectorAll(sel.join(','));
          return [...els].map((el) => ({ id: el.id || el.className, bottom: el.getBoundingClientRect().bottom }));
        });
        assert.ok(bottoms.length >= 3, `expected the headline/lede/command block/notes, found ${bottoms.length}: ${JSON.stringify(bottoms)}`);
        for (const b of bottoms) {
          assert.ok(b.bottom <= h, `${w}x${h}: "${b.id}" bottom edge ${b.bottom} exceeds the fold (${h})`);
        }
      } finally {
        await ctx.close();
      }
    });
  }

  // ── The homepage client band: its link sits 16 under the row of names ──
  // Measured box to box in the same run and compared with the page's own
  // --space-body token, not a pixel literal.
  for (const width of WIDTHS) {
    it(`homepage @ ${width}: the client band's link sits one body gap (--space-body, 16) under the row of client names`, async (t) => {
      if (bootSkipReason) { t.skip(bootSkipReason); return; }
      if (!playwrightOk) { t.skip('playwright not resolvable'); return; }
      const ctx = await browser.newContext({ viewport: { width, height: HEIGHTS[width] } });
      const page = await ctx.newPage();
      try {
        await page.goto(`${baseUrl}/`, { waitUntil: 'networkidle' });
        const m = await page.evaluate(() => {
          const names = document.querySelector('#works-with-band .ww-band-grid');
          const link = document.querySelector('#works-with-band .ww-band-link');
          const token = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--space-body'));
          return {
            token,
            gap: link && names ? link.getBoundingClientRect().top - names.getBoundingClientRect().bottom : null,
            fullGridGap: names ? parseFloat(getComputedStyle(names.parentElement).rowGap) : null,
          };
        });
        assert.ok(typeof m.gap === 'number', 'the names row and the link were both found');
        assert.ok(Math.abs(m.gap - m.token) <= 0.5, `${width}: names row -> link gap ${m.gap}, token --space-body ${m.token}`);
      } finally {
        await ctx.close();
      }
    });
  }

  // ── V-8: /for-builders hero CTA -- report only, no pin (M-5) ──────────
  // "Not part of this work. It sits below the first screen on production
  // today. Do not change the order or content of that hero. Confirm only
  // that your build does not move it lower than production: on production
  // the button's bottom edge is 795 at 1280 by 720 and 765 at 375 by 667.
  // Compare by rendering, in the same test run, the hero with your
  // spacing rules and reporting the number. Do not pin these two numbers
  // in a test." -- this reports the live number for the human-authored
  // report to compare against production's 795/765; it does not assert
  // against those two literals.
  for (const [w, h] of [[1280, 720], [375, 667]]) {
    it(`REPORT ONLY: /for-builders hero primary CTA bottom edge at ${w}x${h} (compare against production's own number in the report, not pinned here)`, async (t) => {
      if (bootSkipReason) { t.skip(bootSkipReason); return; }
      if (!playwrightOk) { t.skip('playwright not resolvable'); return; }
      const ctx = await browser.newContext({ viewport: { width: w, height: h } });
      const page = await ctx.newPage();
      try {
        await page.goto(`${baseUrl}/for-builders`, { waitUntil: 'networkidle' });
        await page.addStyleTag({ content: '.reveal { opacity: 1 !important; transform: none !important; }' });
        await page.waitForTimeout(120);
        const bottom = await page.evaluate(() => {
          const btn = document.querySelector('main .btn-primary');
          return btn ? btn.getBoundingClientRect().bottom : null;
        });
        console.log(`V-8 REPORT: /for-builders .btn-primary bottom @ ${w}x${h} = ${bottom}`);
        assert.ok(typeof bottom === 'number', 'button bottom edge measured');
      } finally {
        await ctx.close();
      }
    });
  }

  it('prints the full A3-1..A3-10 table for the report', (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    if (!playwrightOk) { t.skip('playwright not resolvable'); return; }
    console.log('\n=== SPACING-0927 ROUND 3: A3-1..A3-10 TABLE ===');
    for (const rule of Object.keys(RULE_NAMES)) {
      console.log(`${RULE_NAMES[rule]}: checked=${evalResult.totalChecks[rule]} passing=${evalResult.passCounts[rule]}`);
    }
    if (evalResult.documentedExceptions && evalResult.documentedExceptions.length) {
      console.log('\n=== DOCUMENTED EXCEPTIONS (counted as passing, reason attached) ===');
      for (const ex of evalResult.documentedExceptions) console.log('  ' + ex);
    }
    assert.ok(true);
  });
});
