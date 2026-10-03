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
const { evaluateRules, RULE_NAMES, READING_RHYTHM } = require('./helpers/ad-rules-check');

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
      // reading columns) -- covered by rule 1's centering check, not by
      // rule 2's page-gutter match. (The two boxes on /how-submissions-work
      // that used to be named here are gone: the page has no box left.)
      narrowColumnWrapperSelectors: new Set(['div.page-hero-content']),
      // Design rebuild: a band is a section with no heading that holds one row of figures. The homepage's
      // client band, /for-agents' catalog figures (#catalog-stats) and /for-builders' figures (#builders-stats)
      // all take the band rhythm.
      bandSelectors: ['works-with-band', 'catalog-stats', 'builders-stats'],
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

  // ── /how-submissions-work: a reading document in the shared 720 frame ──
  // The hero copy and every section (heading, prose, the table of rows, the live count) sit on one left
  // edge and in one column, the heading above its text at every width, and no box remains. After the dark
  // hero the sections are one paper ground and the gap between two of them is the reading rhythm (64, 48,
  // 32), half above and half below each section. Every pin is one measurement compared with another taken
  // in the same run, except the reading rhythm, which is the one design value the helper names.
  for (const width of WIDTHS) {
    it(`/how-submissions-work @ ${width}: the hero copy and every section share one left edge and one column, each heading sits above its text, and no box remains`, async (t) => {
      if (bootSkipReason) { t.skip(bootSkipReason); return; }
      if (!playwrightOk) { t.skip('playwright not resolvable'); return; }
      const ctx = await browser.newContext({ viewport: { width, height: HEIGHTS[width] } });
      const page = await ctx.newPage();
      try {
        await page.goto(`${baseUrl}/how-submissions-work`, { waitUntil: 'networkidle' });
        const m = await page.evaluate(() => {
          const box = (el) => { const r = el.getBoundingClientRect(); return { left: r.left, width: r.width, top: r.top, bottom: r.bottom }; };
          const section = (headingId) => {
            const h = document.getElementById(headingId);
            const sec = h && h.closest('section');
            const body = sec && sec.querySelector('.trust-prose, .ledger-card-body, .trust-table-wrap');
            return h && body ? { h: box(h), body: box(body) } : null;
          };
          const headingIds = [...document.querySelectorAll('main section h2')].map((h) => h.id);
          return {
            boxes: document.querySelectorAll('.callout-bordered, .ledger-card').length,
            hero: { h1: box(document.querySelector('#page-hero-heading')), lede: box(document.querySelector('.page-hero-sub')) },
            sections: headingIds.map((id) => [id, section(id)]),
            table: box(document.querySelector('.trust-table-wrap')),
            tableRows: document.querySelectorAll('.trust-table tbody tr').length,
            stat: box(document.querySelector('#s7-learnings-count')),
            counts: ['s7-learnings-count', 's7-unlocks-count'].map((id) => !!document.getElementById(id)),
            sheetAside: document.querySelectorAll('main .aside-list').length,
            ground: (() => {
              const secs = [...document.querySelectorAll('main > section')];
              const last = (sec) => sec.querySelector('.trust-prose, .ledger-card-body, .trust-table-wrap');
              const pad = (sec) => { const cs = getComputedStyle(sec); return { top: parseFloat(cs.paddingTop), bottom: parseFloat(cs.paddingBottom) }; };
              return {
                hero: getComputedStyle(secs[0]).backgroundColor,
                bodyGrounds: secs.slice(1).map((s) => getComputedStyle(s).backgroundColor),
                tinted: document.querySelectorAll('main > section.on-tint, main > section.on-dark:not(:first-child)').length,
                pads: secs.slice(1).map(pad),
                gaps: secs.slice(2).map((s, i) => s.querySelector('h2').getBoundingClientRect().top - last(secs[i + 1]).getBoundingClientRect().bottom),
              };
            })(),
          };
        });
        assert.equal(m.boxes, 0, 'no callout or ledger card box remains');
        assert.equal(m.sheetAside, 0, 'no heading-left section is left on the page');
        assert.equal(m.sections.length, 11, 'positive control: all eleven sections were measured');
        assert.equal(m.tableRows, 11, 'positive control: the table is still eleven rows');
        assert.deepEqual(m.counts, [true, true], 'positive control: both live-count figures are still on the page');
        const edge = m.sections[0][1].h.left;
        const col = m.sections[0][1].h.width;
        assert.ok(Math.abs(m.hero.h1.left - edge) <= 0.5, `the hero heading starts at the sections' left edge (${m.hero.h1.left} vs ${edge})`);
        assert.ok(Math.abs(m.hero.lede.left - edge) <= 0.5, `the hero lede starts at the sections' left edge (${m.hero.lede.left} vs ${edge})`);
        for (const [id, sec] of m.sections) {
          assert.ok(sec, `${id}: found, with its text under it`);
          assert.ok(Math.abs(sec.h.left - edge) <= 0.5, `${id}: the heading starts at the shared left edge (${sec.h.left} vs ${edge})`);
          assert.ok(Math.abs(sec.body.left - edge) <= 0.5, `${id}: the text starts at the shared left edge (${sec.body.left} vs ${edge})`);
          assert.ok(Math.abs(sec.h.width - col) <= 0.5 && Math.abs(sec.body.width - col) <= 0.5, `${id}: the heading and the text share one column (${sec.h.width}, ${sec.body.width} vs ${col})`);
          assert.ok(sec.body.top > sec.h.bottom - 0.5, `${id}: the text sits under the heading at ${width}, never beside it`);
        }
        // the table is at the reading width, not a wider card
        assert.ok(Math.abs(m.table.left - edge) <= 0.5 && Math.abs(m.table.width - col) <= 0.5, `the table of rows sits in the same column (${m.table.left}, ${m.table.width} vs ${edge}, ${col})`);
        // the live-count figures start on the same edge
        assert.ok(Math.abs(m.stat.left - edge) <= 0.5, `the first live figure starts at the shared left edge (${m.stat.left} vs ${edge})`);
        // one ground: every section after the hero draws the same (the page's paper), none is tint, and the
        // dark hero does not (positive control: a difference between grounds is visible to this measurement)
        assert.notEqual(m.ground.hero, m.ground.bodyGrounds[0], 'positive control: the hero ground differs from the body ground');
        assert.equal(m.ground.bodyGrounds.length, 11, 'positive control: all eleven body sections were measured');
        assert.equal(new Set(m.ground.bodyGrounds).size, 1, `the eleven sections after the hero share one ground (${[...new Set(m.ground.bodyGrounds)].join(' | ')})`);
        assert.equal(m.ground.tinted, 0, 'no section after the hero is on the tint or the dark ground');
        // the reading rhythm: each section carries half of the gap above and the same below, and the gap
        // between two sections, measured box to box, is the sum of the two paddings and the ruled value
        const gapRuled = READING_RHYTHM['/how-submissions-work'][width];
        assert.equal(m.ground.gaps.length, 10, 'positive control: ten gaps between eleven sections');
        m.ground.pads.forEach((p, i) => {
          assert.ok(Math.abs(p.top - p.bottom) <= 0.5, `section ${i + 1}: padding above equals padding below (${p.top} / ${p.bottom})`);
          assert.ok(Math.abs(p.top - gapRuled / 2) <= 0.5, `section ${i + 1}: padding is half of the reading gap ${gapRuled} (${p.top})`);
        });
        m.ground.gaps.forEach((g, i) => {
          const sum = m.ground.pads[i].bottom + m.ground.pads[i + 1].top;
          assert.ok(Math.abs(g - sum) <= 1, `gap ${i + 1} is the sum of the two paddings (${g} vs ${sum})`);
          assert.ok(Math.abs(g - gapRuled) <= 1, `gap ${i + 1} is the reading rhythm ${gapRuled} at ${width} (${g})`);
        });
      } finally {
        await ctx.close();
      }
    });
  }

  // ── /api: each documentation section's heading and intro sit in a 720 column above the material ──
  // The tables and code panels run the whole content width. The questions keep the heading-left layout.
  for (const width of WIDTHS) {
    it(`/api @ ${width}: the heading and intro of each documentation section are a 720 column above the material, and the tables and code panels are as wide as the section's content`, async (t) => {
      if (bootSkipReason) { t.skip(bootSkipReason); return; }
      if (!playwrightOk) { t.skip('playwright not resolvable'); return; }
      const ctx = await browser.newContext({ viewport: { width, height: HEIGHTS[width] } });
      const page = await ctx.newPage();
      try {
        await page.goto(`${baseUrl}/api`, { waitUntil: 'networkidle' });
        const m = await page.evaluate(() => {
          const box = (el) => { const r = el.getBoundingClientRect(); return { left: r.left, width: r.width, top: r.top, bottom: r.bottom }; };
          return {
            sections: [...document.querySelectorAll('main .doc-stack')].map((stack) => ({
              id: stack.closest('section').getAttribute('aria-labelledby'),
              stack: box(stack),
              head: box(stack.querySelector('.doc-head')),
              body: box(stack.querySelector('.doc-body')),
              wide: [...stack.querySelectorAll('.doc-body > .code-block, .doc-body > .doc-card')].map((el) => ({ cls: el.className.split(' ')[0], ...box(el) })),
            })),
            faq: (() => { const f = document.querySelector('#faq .aside-list'); return f ? { cols: getComputedStyle(f).gridTemplateColumns.split(' ').length } : null; })(),
          };
        });
        assert.equal(m.sections.length, 5, 'positive control: the five documentation sections were measured');
        assert.ok(m.sections.every((s) => s.wide.length >= 1), 'positive control: every section has a table or a code panel');
        for (const sec of m.sections) {
          assert.ok(sec.head.width <= 720 + 0.5, `${sec.id}: the heading and intro column is at most 720 (${sec.head.width})`);
          assert.ok(Math.abs(sec.head.left - sec.body.left) <= 0.5, `${sec.id}: the heading, the intro and the material share one left edge`);
          assert.ok(sec.body.top >= sec.head.bottom, `${sec.id}: the material sits under the heading, never beside it`);
          assert.ok(Math.abs(sec.body.width - sec.stack.width) <= 0.5, `${sec.id}: the material runs the section's whole content width`);
          for (const w of sec.wide) assert.ok(Math.abs(w.width - sec.stack.width) <= 0.5, `${sec.id}: a ${w.cls} runs the whole content width (${w.width} vs ${sec.stack.width})`);
          if (width > 800) assert.ok(sec.head.width < sec.body.width, `${sec.id}: at ${width} the head column is narrower than the material`);
        }
        // positive control: the questions are the one heading-left section, two columns from 1025 up
        assert.ok(m.faq, 'the questions section is still heading-left');
        assert.equal(m.faq.cols, width > 1024 ? 2 : 1);
      } finally {
        await ctx.close();
      }
    });
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
    // Rule 5's beside exemption, named: every heading the rule did not measure, and how many per width.
    console.log(`\n=== HEADINGS EXEMPT AS BESIDE (rule 5), per width ${JSON.stringify(evalResult.besideExemptCount)} ===`);
    for (const b of evalResult.besideExempt) console.log('  ' + b.replace(/\s+/g, ' '));
    assert.ok(true);
  });

  // Rule 5's beside exemption is pinned per width. A heading is exempt only where the unit after it sits beside
  // it (the heading-left layout, from 1025 up), so every exemption is at 1280 and none at 768 or 375. A new
  // heading-left section changes the number and fails here, on purpose: raise it knowingly, with the report.
  // Round 4: /how-submissions-work is a reading document, so its eleven heading-left sections are gone (17 to 6 at 1280).
  // /api's documentation sections stack their heading over the material and were never counted as beside (their intro
  // sat under the heading); its questions stay heading-left.
  const BESIDE_EXEMPT_PINNED = { 1280: 6, 768: 0, 375: 0 };
  it('rule 5: the beside exemption is reported and pinned per width, so a new silent exemption fails', (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    if (!playwrightOk) { t.skip('playwright not resolvable'); return; }
    assert.deepEqual(evalResult.besideExemptCount, BESIDE_EXEMPT_PINNED, `the exempt headings per width:\n${evalResult.besideExempt.map((b) => '  ' + b.replace(/\s+/g, ' ')).join('\n')}`);
    assert.equal(evalResult.besideExempt.length, Object.values(BESIDE_EXEMPT_PINNED).reduce((a, b) => a + b, 0), 'the list and the counts agree');
    // positive control: the exempt list is not empty, and each entry names its page, width and heading
    assert.ok(evalResult.besideExempt.length > 0 && evalResult.besideExempt.every((b) => /^\/[^ ]* @ \d+: h[123]/.test(b)));
  });

  it('rule 6: every card is logged (pass or fail), and the documented card exceptions are all still in use', (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    if (!playwrightOk) { t.skip('playwright not resolvable'); return; }
    assert.ok(evalResult.totalChecks[6] >= 20, `positive control: cards were found and logged (${evalResult.totalChecks[6]})`);
    assert.equal(evalResult.totalChecks[6], evalResult.passCounts[6] + evalResult.failures[6].length, 'every card is a pass or a failure, none silent');
    assert.deepEqual(evalResult.unusedCardExceptions, [], 'a card-padding exception no card matches any more must be removed');
  });
});

// ── The evaluator itself, on records made by hand (no server, no browser) ──
// Each rule is shown to fail on input that breaks it and to pass on input that keeps it, so a report of zero
// failures means the rule looked and found none, not that it could not see.
describe('the rule evaluator sees an overlap, an uneven card and an unlisted exemption', () => {
  const emptyRec = () => ({
    sections: [], seams: [], headingGaps: [], repeatedGroups: [], cards: [], joinedRows: [], siblingGaps: [],
    nav: null, footer: null,
  });
  const evalOne = (rec, page = '/probe') => evaluateRules({ [page]: { 1280: rec, 768: emptyRec(), 375: emptyRec() } }, {});
  const heading = (over) => Object.assign({
    heading: 'h2#probe', headingTag: 'h2', headingText: 'Probe', headingBottom: 200, headingLeft: 90, headingRight: 500,
    followingUnitLeft: 90, followingUnitRight: 1190, followingUnitTop: 224, firstThingKind: 'text', firstThingText: 'under', gap: 24,
  }, over);
  const card = (padding, over) => Object.assign({
    parentSelector: 'div.grid', className: 'probe-card', inGrid: true, gaps: [], bg: 'a', surface: 'a', borderColor: 'b', line: 'b',
    borderWidths: [1, 1, 1, 1], radii: [14, 14, 14, 14], padding, paddingUniform: true,
  }, over);

  it('rule 5: a thing under the heading at 24 passes; at 30 fails', () => {
    assert.equal(evalOne(Object.assign(emptyRec(), { headingGaps: [heading({})] })).failures[5].length, 0);
    assert.equal(evalOne(Object.assign(emptyRec(), { headingGaps: [heading({ gap: 30, followingUnitTop: 230 })] })).failures[5].length, 1);
  });

  it('rule 5: a unit that starts above the heading\'s bottom edge and overlaps it horizontally FAILS, it is not exempt', () => {
    const r = evalOne(Object.assign(emptyRec(), { headingGaps: [heading({ followingUnitTop: 150, gap: -50 })] }));
    assert.equal(r.failures[5].length, 1, 'a real overlap fails');
    assert.match(r.failures[5][0], /real overlap/);
    assert.equal(r.besideExempt.length, 0, 'and is not listed as exempt');
  });

  it('rule 5: a unit beside the heading is exempt, listed, and counted at its width', () => {
    const r = evalOne(Object.assign(emptyRec(), { headingGaps: [heading({ followingUnitLeft: 600, followingUnitRight: 1190, followingUnitTop: 120, gap: -80 })] }));
    assert.equal(r.failures[5].length, 0);
    assert.equal(r.besideExempt.length, 1);
    assert.deepEqual(r.besideExemptCount, { 1280: 1, 768: 0, 375: 0 });
  });

  // The reading rhythm: a reading document's sections after the hero carry half of the gap each side, and the
  // gap between two of them is the whole gap. Any other route keeps the full rhythm, so the same record fails there.
  describe('the reading rhythm', () => {
    const sec = (index, top, bottom) => ({ index, selector: `section#s${index}`, padding: { top, bottom }, boxGutterLeft: 90, boxGutterRight: 90 });
    const doc = (heroPad, pad, gap) => Object.assign(emptyRec(), {
      sections: [sec(0, heroPad, heroPad), sec(1, pad, pad), sec(2, pad, pad)],
      seams: [
        { from: 'section#s0', to: 'section#s1', contentGap: heroPad + pad },
        { from: 'section#s1', to: 'section#s2', contentGap: gap },
      ],
    });
    const run = (rec, page) => evaluateRules({ [page]: { 1280: rec, 768: emptyRec(), 375: emptyRec() } }, {});

    it('a hero at 120 and sections at 32 with a 64 gap pass rules 3 and 4 on the reading route', () => {
      const r = run(doc(120, 32, 64), '/how-submissions-work');
      assert.equal(r.failures[3].length, 0, r.failures[3].join('\n'));
      assert.equal(r.failures[4].length, 0, r.failures[4].join('\n'));
      assert.ok(r.totalChecks[4] >= 3, 'positive control: the extra reading-seam check ran as well as the two sums');
    });

    it('sections at the full 120, or a gap that is not 64, fail on the reading route', () => {
      assert.ok(run(doc(120, 120, 240), '/how-submissions-work').failures[3].length >= 2, 'the full rhythm is not the reading rhythm');
      const wide = run(doc(120, 32, 80), '/how-submissions-work');
      assert.ok(wide.failures[4].some((f) => /reading seam/.test(f)), 'a 80 gap fails the reading seam check');
    });

    it('the same record on any other route is measured exactly as before: 32 fails rule 3 there', () => {
      const r = run(doc(120, 32, 64), '/pricing');
      assert.equal(r.failures[3].length, 2, 'the two 32px sections fail the full rhythm of 120');
      assert.equal(r.failures[4].length, 0, 'the seams are sums of the paddings, as before');
      assert.equal(r.totalChecks[4], 2, 'no reading-seam check runs on another route');
    });
  });

  it('rule 6: a card with 32 on all four sides passes; 24, or uneven sides, or an uneven group fails', () => {
    const run = (cards) => evalOne(Object.assign(emptyRec(), { cards })).failures[6].length;
    assert.equal(run([card({ top: 32, right: 32, bottom: 32, left: 32 })]), 0);
    assert.equal(run([card({ top: 24, right: 24, bottom: 24, left: 24 })]), 1, 'equal but not 32');
    assert.equal(run([card({ top: 32, right: 32, bottom: 24, left: 32 })]), 1, 'not equal on four sides');
    assert.equal(run([card({ top: 32, right: 32, bottom: 32, left: 32 }, { paddingUniform: false })]), 1, 'not the same on every card of the group');
  });

  it('rule 6: every card is logged, and a card family on the documented list is counted as passing with its reason', () => {
    const r = evalOne(Object.assign(emptyRec(), { cards: [card({ top: 32, right: 32, bottom: 32, left: 32 }), card({ top: 0, right: 0, bottom: 0, left: 0 }, { parentSelector: 'div.steps', className: 'step' })] }));
    assert.equal(r.totalChecks[6], 2, 'both cards were logged');
    assert.equal(r.failures[6].length, 0);
    assert.ok(r.documentedExceptions.some((e) => /rule 6/.test(e) && /step card/.test(e)), 'the exception is named in the report');
    assert.ok(!r.unusedCardExceptions.includes('step') && r.unusedCardExceptions.includes('flow-step'), 'used and unused exceptions are told apart');
    // the same family at an uncovered size would fail: the client card exception is for 375 only
    const phone = (w) => evaluateRules({ '/probe': { 1280: emptyRec(), 768: emptyRec(), 375: emptyRec(), [w]: Object.assign(emptyRec(), { cards: [card({ top: 16, right: 16, bottom: 16, left: 16 }, { parentSelector: 'ul.ww-list', className: 'ww-cell ww-size-medium' })] }) } }, {});
    assert.equal(phone(375).failures[6].length, 0, 'at 375 the compact client card is a documented exception');
    assert.equal(phone(1280).failures[6].length, 1, 'at 1280 it is not');
  });
});
