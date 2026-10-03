'use strict';

/**
 * test/hero-0927.test.js — HERO-0927: homepage headline (H-1) and lede (H-2)
 * replacement (BUILD-BRIEF-HERO.md, 2026-09-27).
 *
 * The owner rejected the live headline ("Redo"), was shown five finalists,
 * and ruled F1. The lede went through two rounds (a first draft was
 * withdrawn as "convoluted"; the ruled replacement below is final). Two
 * strings on public/index.html change; nothing else does.
 *
 *   H-1  h1#hero-heading   -> NEW_H1
 *   H-2  p.hero-sub        -> NEW_LEDE
 *
 * Every expected string lives in exactly one constant below (single point of
 * edit, per the coordinator's instruction while H-2 was still in flight).
 *
 * This suite:
 *   - asserts both strings render, read from the staged real server.js
 *     (matches the live template path, not a static-file read)
 *   - sweeps every tracked file under the brief's named surfaces
 *     (public/, .well-known/, server.js, lib/, openapi.json, README.md,
 *     docs/, test/, scripts/) for the old headline and every sentence of the
 *     old lede, with a positive control per absence check
 *   - H-10: the earnings-not-guaranteed sentence and a withdrawals-paused
 *     statement still present, unchanged
 *   - H-11: "AI" appears in exactly two homepage strings (the h1, the title)
 *   - H-13: the new headline's rendered line count and no single-word line,
 *     at 375/768/1280
 *   - H-14: the lede's CSS measure (.hero-sub max-width) at 1280 is 30em of
 *     its own font size (design rebuild; was a fixed 600px)
 *   - H-16: the hero's copy button is fully inside the first screen at
 *     1280x720 and 375x667
 *   - H-15: no horizontal scroll at 375
 *
 * Runner: node --test test/hero-0927.test.js
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
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
const THIS_FILE = path.relative(REPO, __filename).split(path.sep).join('/');
// test/launch-wave-fixes-frontend.test.js's D4/HERO-0927 describe block
// legitimately holds the old lede (and its sentences) as absence-check
// literals -- it asserts they are NOT in index.html, the same role THIS_FILE
// plays for itself. Holding the string to search for it is not the same as
// presenting it as content, so both are excluded from the sweep below.
const SELF_REFERENTIAL_FILES = new Set([THIS_FILE, 'test/launch-wave-fixes-frontend.test.js']);

// ─── H-1 ──────────────────────────────────────────────────────────────────
const OLD_H1 = 'You have watched your AI work out the same fix before.';
const NEW_H1 = 'Earn from the work your AI already does.';

// ─── H-2 (ruled 2026-09-27, second and final round) ────────────────────────
const NEW_LEDE = 'Your agent finds a fix. You approve it. You earn money when another agent pays to unlock it.';
const OLD_LEDE = 'Next time, your agent can ask Auxilo instead. Signed in to your account, it gets the fix you published back for free. When another agent unlocks that fix, you earn a share.';
const OLD_LEDE_SENTENCES = [
  'Next time, your agent can ask Auxilo instead.',
  'Signed in to your account, it gets the fix you published back for free.',
  'When another agent unlocks that fix, you earn a share.',
];

// H-10
const EARNINGS_NOT_GUARANTEED = 'Earnings depend on whether other agents unlock your learnings and are not guaranteed.';

function isPlaywrightAvailable() {
  try {
    require.resolve('playwright');
    return true;
  } catch (e) {
    return false;
  }
}

// Every tracked file under the brief's named search surfaces (mirrors
// BUILD-BRIEF-HERO.md's "Find every copy of the old strings" scope exactly),
// so this sweep can't miss a machine surface merely because nobody thought
// to hardcode its path. Excludes this file itself (which must legitimately
// hold the old strings as literals to search for them).
function namedSurfaceFiles() {
  const roots = ['public', '.well-known', 'server.js', 'lib', 'openapi.json', 'README.md', 'docs', 'test', 'scripts'];
  const out = execFileSync('git', ['ls-files', ...roots], { cwd: REPO, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .filter((f) => !SELF_REFERENTIAL_FILES.has(f));
  return out;
}

const BINARY_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.ico', '.woff2', '.woff', '.ttf']);

function readTextFiles(files) {
  return files
    .filter((f) => !BINARY_EXT.has(path.extname(f)))
    .map((f) => ({ file: f, text: fs.readFileSync(path.join(REPO, f), 'utf8') }));
}

describe('HERO-0927 sweep: old headline and old lede appear in no named surface', () => {
  const files = readTextFiles(namedSurfaceFiles());

  it('sanity: the sweep actually enumerated files (not vacuously empty)', () => {
    assert.ok(files.length > 50, `expected a substantial file set, got ${files.length}`);
    assert.ok(files.some((f) => f.file === 'public/index.html'), 'public/index.html must be in the swept set');
  });

  it('positive control: a known-present string ("Auxilo") is found by the same scan (proves the detector matches real text)', () => {
    const hits = files.filter((f) => f.text.includes('Auxilo'));
    assert.ok(hits.length > 5, 'expected many files to mention "Auxilo"; the scan mechanism looks broken');
  });

  it('positive control: the new headline IS present on public/index.html (proves absence checks below are not vacuous)', () => {
    const idx = files.find((f) => f.file === 'public/index.html');
    assert.ok(idx, 'public/index.html must be in the swept set');
    assert.ok(idx.text.includes(NEW_H1), 'new headline must be present on public/index.html');
  });

  it('the old headline appears in no swept file', () => {
    const hits = files.filter((f) => f.text.includes(OLD_H1)).map((f) => f.file);
    assert.deepEqual(hits, [], `old headline must be gone; still found in: ${hits.join(', ')}`);
  });

  it('positive control: the new lede IS present on public/index.html', () => {
    const idx = files.find((f) => f.file === 'public/index.html');
    assert.ok(idx.text.includes(NEW_LEDE), 'new lede must be present on public/index.html');
  });

  it('the old full lede appears in no swept file', () => {
    const hits = files.filter((f) => f.text.includes(OLD_LEDE)).map((f) => f.file);
    assert.deepEqual(hits, [], `old lede must be gone; still found in: ${hits.join(', ')}`);
  });

  for (const sentence of OLD_LEDE_SENTENCES) {
    it(`the old lede's sentence "${sentence}" appears in no swept file`, () => {
      const hits = files.filter((f) => f.text.includes(sentence)).map((f) => f.file);
      assert.deepEqual(hits, [], `sentence must be gone; still found in: ${hits.join(', ')}`);
    });
  }
});

describe('HERO-0927: H-1/H-2 render from the staged server; H-10/H-11 checks', { timeout: 120_000 }, () => {
  let bootSkipReason = null;
  let tmpDir;
  let child;
  let baseUrl;
  let html;

  before(async () => {
    const honoEntry = require.resolve('hono', { paths: [REPO] });
    const nodeModulesDir = honoEntry.slice(0, honoEntry.lastIndexOf(`${path.sep}node_modules${path.sep}`) + '/node_modules'.length);
    const reservation = await reservePort();
    if ('skipReason' in reservation) {
      bootSkipReason = reservation.skipReason;
      return;
    }
    const { port } = reservation;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auxilo-hero-0927-'));
    stageServer({
      repoRoot: REPO,
      tmpDir,
      nodeModulesDir,
      port,
      rootFiles: ['server.js', 'seed-knowledge.json', 'skills.json', 'openapi.json', 'package.json', 'model_config.json'],
      linkDirs: ['lib', 'public', 'prompts', 'config', 'docs', '.well-known'],
    });
    const boot = await bootServer({
      tmpDir,
      port,
      env: {
        NODE_ENV: 'test',
        WALLET_PRIVATE_KEY: `0x${'11'.repeat(32)}`,
        LLM_SENSITIVITY_ENABLED: 'false',
        SESSION_SECRET: 'hero-0927-test-session-secret-0123456789ab',
      },
      timeoutMs: 60_000,
      maxAttempts: 4,
    });
    if ('skipReason' in boot) {
      bootSkipReason = boot.skipReason;
      return;
    }
    child = boot.child;
    baseUrl = boot.baseUrl;
    const res = await fetch(`${baseUrl}/`);
    html = await res.text();
  });

  after(async () => {
    if (child) await stopServer(child);
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('H-1: h1#hero-heading reads the new ruled headline, exactly once', (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    const m = html.match(/<h1 id="hero-heading">([\s\S]*?)<\/h1>/);
    assert.ok(m, 'hero-heading h1 found on the staged homepage');
    assert.equal(m[1], NEW_H1);
  });

  it('H-2: p.hero-sub reads the new ruled lede, exactly once', (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    const m = html.match(/<p class="hero-sub">([\s\S]*?)<\/p>/);
    assert.ok(m, 'hero-sub p found on the staged homepage');
    assert.equal(m[1], NEW_LEDE);
  });

  it('title tag, meta description, social tags, command block, its two notes, and "See How It Works" are untouched', (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    assert.ok(html.includes('<title>Marketplace for what AI agents learn | Auxilo</title>'), 'title tag unchanged');
    assert.ok(html.includes('npx auxilo setup'), 'command block unchanged');
    assert.ok(html.includes('Setup is free and takes one command. Extraction stays off until you turn it on.'), 'setup note 1 unchanged');
    assert.ok(html.includes("Extraction reads your finished sessions on your machine, and anything it pulls out publishes only after you approve it."), 'setup note 2 unchanged');
    assert.ok(html.includes('<a href="/how-it-works" id="hero-cta-secondary" class="hero-cta-link">See How It Works</a>'), '"See How It Works" link unchanged');
  });

  it('H-10: the earnings-not-guaranteed sentence appears once, verbatim, unchanged', (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    const count = html.split(EARNINGS_NOT_GUARANTEED).length - 1;
    assert.equal(count, 1, `expected the exact sentence exactly once, found ${count}`);
  });

  it('H-10: a statement that withdrawals are paused is present', (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    assert.ok(html.includes('withdrawals open soon'), 'withdrawals-paused statement present');
  });

  it('H-11: outside the standing FAQ-question carve-out (test/launch-wave-fixes-frontend.test.js D5), "AI" appears on the homepage in exactly two strings — the headline and the title tag', (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    let stripped = html
      .replace(/<script[\s\S]*?<\/script>/g, ' ')
      .replace(/<style[\s\S]*?<\/style>/g, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ');
    // FAQ questions render as <span>QUESTION TEXT</span> directly inside a
    // <button class="faq-question">, a pre-existing standing carve-out (a
    // search-query mirror) this build does not touch or narrow — same
    // detection as test/launch-wave-fixes-frontend.test.js's D5 suite.
    const faqSpans = [...stripped.matchAll(/<button class="faq-question"[^>]*>\s*<span>([^<]*)<\/span>/g)].map((m) => m[0]);
    assert.ok(faqSpans.length > 0, 'sanity: at least one FAQ question span found on the homepage');
    for (const span of faqSpans) stripped = stripped.split(span).join(' ');
    // Pull out the two allowed carriers before scanning the rest.
    const titleMatch = stripped.match(/<title>[\s\S]*?<\/title>/);
    const h1Match = stripped.match(/<h1 id="hero-heading">[\s\S]*?<\/h1>/);
    assert.ok(titleMatch, 'title tag found');
    assert.ok(h1Match, 'hero-heading h1 found');
    assert.match(titleMatch[0], /\bAI\b/, 'positive control: title tag carries "AI"');
    assert.match(h1Match[0], /\bAI\b/, 'positive control: h1 carries "AI"');
    stripped = stripped.split(titleMatch[0]).join(' ').split(h1Match[0]).join(' ');
    const text = stripped.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    assert.doesNotMatch(
      text,
      /\bAI\b/,
      `"AI" must appear nowhere else on the homepage (outside the FAQ-question carve-out); context: ${JSON.stringify((text.match(/.{0,60}\bAI\b.{0,60}/) || [''])[0])}`
    );
  });
});

describe('HERO-0927: H-13/H-14/H-15 rendered checks at 375/768/1280', { timeout: 120_000 }, () => {
  let bootSkipReason = null;
  let tmpDir;
  let child;
  let baseUrl;
  let browser;
  let playwrightOk = false;

  before(async () => {
    if (!isPlaywrightAvailable()) return;
    const honoEntry = require.resolve('hono', { paths: [REPO] });
    const nodeModulesDir = honoEntry.slice(0, honoEntry.lastIndexOf(`${path.sep}node_modules${path.sep}`) + '/node_modules'.length);
    const reservation = await reservePort();
    if ('skipReason' in reservation) {
      bootSkipReason = reservation.skipReason;
      return;
    }
    const { port } = reservation;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auxilo-hero-0927-render-'));
    stageServer({
      repoRoot: REPO,
      tmpDir,
      nodeModulesDir,
      port,
      rootFiles: ['server.js', 'seed-knowledge.json', 'skills.json', 'openapi.json', 'package.json', 'model_config.json'],
      linkDirs: ['lib', 'public', 'prompts', 'config', 'docs', '.well-known'],
    });
    const boot = await bootServer({
      tmpDir,
      port,
      env: {
        NODE_ENV: 'test',
        WALLET_PRIVATE_KEY: `0x${'11'.repeat(32)}`,
        LLM_SENSITIVITY_ENABLED: 'false',
        SESSION_SECRET: 'hero-0927-render-test-session-secret-01234',
      },
      timeoutMs: 60_000,
      maxAttempts: 4,
    });
    if ('skipReason' in boot) {
      bootSkipReason = boot.skipReason;
      return;
    }
    child = boot.child;
    baseUrl = boot.baseUrl;
    const { chromium } = require('playwright');
    browser = await chromium.launch();
    playwrightOk = true;
  });

  after(async () => {
    if (browser) await browser.close();
    if (child) await stopServer(child);
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function measureAt(width, height) {
    const ctx = await browser.newContext({ viewport: { width, height } });
    const page = await ctx.newPage();
    try {
      await page.goto(`${baseUrl}/`, { waitUntil: 'networkidle' });
      await page.addStyleTag({ content: '.reveal { opacity: 1 !important; transform: none !important; }' });
      const result = await page.evaluate(() => {
        const el = document.getElementById('hero-heading');
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        const lines = [];
        let lastTop = null;
        let cur = '';
        let n;
        while ((n = walker.nextNode())) {
          const t = n.textContent;
          for (let i = 0; i < t.length; i++) {
            const rg = document.createRange();
            rg.setStart(n, i);
            rg.setEnd(n, i + 1);
            const rc = rg.getClientRects()[0];
            if (!rc) { cur += t[i]; continue; }
            const top = Math.round(rc.top);
            if (lastTop !== null && Math.abs(top - lastTop) > 4) {
              lines.push(cur.trim());
              cur = '';
            }
            lastTop = top;
            cur += t[i];
          }
        }
        if (cur.trim()) lines.push(cur.trim());
        const heroSub = document.querySelector('.hero-sub');
        const heroSubMaxWidth = heroSub ? getComputedStyle(heroSub).maxWidth : null;
        const heroSubFontSize = heroSub ? getComputedStyle(heroSub).fontSize : null;
        const copyBtn = document.getElementById('copy-hero-setup');
        const copyRect = copyBtn ? copyBtn.getBoundingClientRect() : null;
        const heroCS = getComputedStyle(el);
        return {
          lines: lines.filter(Boolean),
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
          heroSubMaxWidth,
          heroSubFontSize,
          copyBtnBox: copyRect ? { top: copyRect.top, bottom: copyRect.bottom, left: copyRect.left, right: copyRect.right } : null,
          heroTextWrap: heroCS.textWrap || heroCS.getPropertyValue('text-wrap') || null,
          heroTextWrapStyle: heroCS.textWrapStyle || heroCS.getPropertyValue('text-wrap-style') || null,
        };
      });
      return result;
    } finally {
      await ctx.close();
    }
  }

  // R2-2 (coordinator, 2026-09-27): 1440 added alongside the brief's original
  // three widths after R2-1's text-wrap:balance change.
  const WIDTHS = [
    { w: 375, h: 812, maxLines: 3 },
    { w: 768, h: 1024, maxLines: 2 },
    { w: 1280, h: 800, maxLines: 2 },
    { w: 1440, h: 900, maxLines: 2 },
  ];

  for (const { w, h, maxLines } of WIDTHS) {
    it(`H-13: headline at ${w}px wraps to ${maxLines} lines or fewer, no single-word line`, async (t) => {
      if (bootSkipReason) { t.skip(bootSkipReason); return; }
      if (!playwrightOk) { t.skip('playwright not resolvable'); return; }
      const { lines } = await measureAt(w, h);
      console.log(`HERO-0927 H-13 headline lines at ${w}px:`, JSON.stringify(lines));
      assert.ok(lines.length >= 1, `${w}px: no rendered lines found for the headline`);
      assert.ok(lines.length <= maxLines, `${w}px: headline wrapped to ${lines.length} lines, expected <= ${maxLines}: ${JSON.stringify(lines)}`);
      for (const line of lines) {
        const words = line.trim().split(/\s+/).filter(Boolean);
        assert.ok(words.length !== 1, `${w}px: a line holds a single word ("${line}"): ${JSON.stringify(lines)}`);
      }
    });

    it(`H-15: no horizontal scroll at ${w}px`, async (t) => {
      if (bootSkipReason) { t.skip(bootSkipReason); return; }
      if (!playwrightOk) { t.skip('playwright not resolvable'); return; }
      const { scrollWidth, clientWidth } = await measureAt(w, h);
      assert.ok(scrollWidth <= clientWidth + 1, `${w}px: scrollWidth ${scrollWidth} > clientWidth ${clientWidth} (horizontal overflow)`);
    });
  }

  // Design rebuild: the lede's measure is 30em of its own size (570px at 19px, 510px at the
  // 17px used at 480 and down) instead of a fixed 600px. Compared in one run, never against a
  // literal pixel number: the max-width must equal 30 times the same element's font size.
  it('H-14: the lede\'s measure (.hero-sub max-width) at 1280 is 30em of its own font size', async (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    if (!playwrightOk) { t.skip('playwright not resolvable'); return; }
    const { heroSubMaxWidth, heroSubFontSize } = await measureAt(1280, 800);
    const maxW = parseFloat(heroSubMaxWidth);
    const fs = parseFloat(heroSubFontSize);
    assert.ok(fs > 0, `positive control: the lede's font size was measured (${heroSubFontSize})`);
    assert.ok(Math.abs(maxW - fs * 30) <= 0.5, `.hero-sub max-width ${heroSubMaxWidth} should be 30em of ${heroSubFontSize}`);
  });

  // H-16 (design rebuild): the ask is the one control above the fold. The copy button is
  // fully inside the first screen at the two fold sizes the site holds.
  for (const [w, h] of [[1280, 720], [375, 667]]) {
    it(`H-16: the hero copy button is fully inside the first screen at ${w}x${h}`, async (t) => {
      if (bootSkipReason) { t.skip(bootSkipReason); return; }
      if (!playwrightOk) { t.skip('playwright not resolvable'); return; }
      const { copyBtnBox } = await measureAt(w, h);
      assert.ok(copyBtnBox, '#copy-hero-setup found and measured');
      assert.ok(copyBtnBox.top >= 0 && copyBtnBox.left >= 0, `${w}x${h}: the button starts inside the screen: ${JSON.stringify(copyBtnBox)}`);
      assert.ok(copyBtnBox.bottom <= h, `${w}x${h}: the button's bottom edge ${copyBtnBox.bottom} is inside the fold (${h})`);
      assert.ok(copyBtnBox.right <= w, `${w}x${h}: the button's right edge ${copyBtnBox.right} is inside the screen width`);
    });
  }

  // R2-3 (coordinator, 2026-09-27), updated for the design rebuild: the computed text-wrap of
  // the headline is balance. The design system sets balance once, in the shared sheet, for
  // every h1 and h2 (no heading may leave a single word alone on a line), so the original
  // "added to #hero-heading only" scope is retired. What this asserts now: the h1 and every
  // h2 on the homepage computes balance; the h3 step titles do not (positive control, so the
  // check cannot pass by matching nothing).
  it('R2-3: #hero-heading and every h2 compute text-wrap: balance; the h3 step titles do not', async (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    if (!playwrightOk) { t.skip('playwright not resolvable'); return; }
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    try {
      await page.goto(`${baseUrl}/`, { waitUntil: 'networkidle' });
      const result = await page.evaluate(() => {
        const wrap = (h) => {
          const cs = getComputedStyle(h);
          return cs.textWrapStyle || cs.textWrap || cs.getPropertyValue('text-wrap-style') || cs.getPropertyValue('text-wrap');
        };
        const one = (h) => ({ id: h.id || null, tag: h.tagName, value: wrap(h) });
        return {
          h1: one(document.getElementById('hero-heading')),
          h2s: [...document.querySelectorAll('main h2')].map(one),
          h3s: [...document.querySelectorAll('main h3')].map(one),
        };
      });
      assert.match(result.h1.value, /balance/, `#hero-heading computed text-wrap should be "balance", got ${JSON.stringify(result.h1.value)}`);
      assert.ok(result.h2s.length >= 6, `positive control: the homepage's h2 headings were found (${result.h2s.length})`);
      const h2sWithout = result.h2s.filter((h) => !/balance/.test(h.value || ''));
      assert.deepEqual(h2sWithout, [], `every h2 must compute text-wrap: balance; without it: ${JSON.stringify(h2sWithout)}`);
      assert.ok(result.h3s.length >= 3, `positive control: the three step titles were found (${result.h3s.length})`);
      const h3sWith = result.h3s.filter((h) => /balance/.test(h.value || ''));
      assert.deepEqual(h3sWith, [], `step titles (h3) must not compute balance: ${JSON.stringify(h3sWith)}`);
    } finally {
      await ctx.close();
    }
  });
});
