'use strict';

/**
 * test/sheet9-fixups.test.js — Sheet 9 fix-ups (Gate-A 2026-09-06), builder
 * verification for TECH-PM rulings B1 / S1 / S3 / N1 / N3 / N4.
 *
 * Tier 1 (static, always runs, zero extra dependencies): parses
 * public/styles.css and the touched HTML files and asserts the exact CSS
 * facts each ruling requires.
 *
 * Tier 2 (dynamic, needs playwright — already a devDependency, used the
 * same way by tests/test-mobile-nav-overlay.js's own Tier 2): serves
 * public/ over a throwaway static server and asserts the rendering/
 * interaction facts no static regex can prove — horizontal overflow,
 * rendered inset equality between two elements, computed padding at a
 * live breakpoint, and focus reachability. Lives in test/*.test.js (not
 * tests/) so it runs under `npm test` / check-test-count.sh without a
 * package.json change — package.json is off-limits for this build. Skips
 * gracefully (t.skip()) if playwright is not resolvable, same as DR-1.
 *
 * Items covered:
 *   B1  .moat-grid/.moat-card/.moat-icon restored to styles.css verbatim
 *       from 624044c, still used by /for-builders (:959-985): .moat-icon
 *       32x32, two columns above 900px, one column at/below it.
 *   S1  /status: hero h1 and the body's first block share one left edge at
 *       375/768/1440 (.status-body's own horizontal padding dropped so
 *       .container alone drives both insets).
 *   S3  /for-builders: the mobile (<=600px) hero h1 left edge equals the
 *       body section's left edge (40px — .builders-hero-content now picks
 *       up the same 24px .container normally supplies).
 *   N1  the FAQ accordion's closed state (visibility:hidden) pulls a link
 *       inside the still-in-DOM answer text out of tab order; it's
 *       reachable again once the item opens (visibility:visible).
 *   N3  /about and /writing link the shared stylesheet at the same ?v= as
 *       every other page and no longer duplicate footer CSS; their
 *       footer's computed link colour matches /pricing's.
 *   N4  .container's padding-removal breakpoint is 1200, not 1150 — the
 *       24px gutter holds through 1199px and only drops at 1200px.
 *
 * Runner: node --test test/sheet9-fixups.test.js
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const REPO_ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(REPO_ROOT, 'public');
const STYLES_PATH = path.join(PUBLIC_DIR, 'styles.css');
const STYLES = fs.readFileSync(STYLES_PATH, 'utf8');

function readPublic(relPath) {
  return fs.readFileSync(path.join(PUBLIC_DIR, relPath), 'utf8');
}

/**
 * Depth-counting rule-body extractor (same technique as
 * tests/test-mobile-nav-overlay.js's parseCssRules): finds the first `{`
 * at/after the selector match and returns everything up to its matching
 * `}`, so it works uniformly for a single flat rule and for an @media
 * block containing many nested rules.
 */
function ruleBody(css, selectorPattern) {
  const re = new RegExp(selectorPattern, 'm');
  const m = re.exec(css);
  if (!m) return null;
  const braceIdx = css.indexOf('{', m.index);
  if (braceIdx === -1) return null;
  let depth = 1;
  let i = braceIdx + 1;
  while (i < css.length && depth > 0) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}') depth--;
    i++;
  }
  return css.slice(braceIdx + 1, i - 1);
}

// ═══════════════════════════════════════════════════════════════════════
// Tier 1: static CSS + HTML assertions
// ═══════════════════════════════════════════════════════════════════════

describe('B1 (static): .moat-grid/.moat-card/.moat-icon restored to styles.css', () => {
  it('all six rules exist with the values carried over verbatim from 624044c', () => {
    const moatGrid = ruleBody(STYLES, '^\\.moat-grid\\s*\\{');
    assert.ok(moatGrid, '.moat-grid rule exists');
    assert.match(moatGrid, /display:\s*grid/);
    assert.match(moatGrid, /grid-template-columns:\s*1fr 1fr/);
    assert.match(moatGrid, /gap:\s*24px/);
    assert.match(moatGrid, /max-width:\s*800px/);

    const moatCard = ruleBody(STYLES, '^\\.moat-card\\s*\\{');
    assert.ok(moatCard, '.moat-card rule exists');
    assert.match(moatCard, /padding:\s*32px 28px/);
    assert.match(moatCard, /border-radius:\s*6px/);

    const moatCardHover = ruleBody(STYLES, '^\\.moat-card:hover\\s*\\{');
    assert.ok(moatCardHover, '.moat-card:hover rule exists');
    assert.match(moatCardHover, /border-color:\s*var\(--aurum-border\)/);

    const moatIcon = ruleBody(STYLES, '^\\.moat-icon\\s*\\{');
    assert.ok(moatIcon, '.moat-icon rule exists');
    assert.match(moatIcon, /width:\s*32px/);
    assert.match(moatIcon, /height:\s*32px/);

    const moatCardH3 = ruleBody(STYLES, '^\\.moat-card h3\\s*\\{');
    assert.ok(moatCardH3, '.moat-card h3 rule exists');
    assert.match(moatCardH3, /font-size:\s*18px/);

    const moatCardP = ruleBody(STYLES, '^\\.moat-card p\\s*\\{');
    assert.ok(moatCardP, '.moat-card p rule exists');
    assert.match(moatCardP, /font-size:\s*15px/);
  });

  it('the <=900px media query still collapses .moat-grid to one column', () => {
    const mediaBlock = ruleBody(STYLES, '^@media \\(max-width: 900px\\)\\s*\\{');
    assert.ok(mediaBlock, 'the <=900px media query exists');
    assert.match(mediaBlock, /\.moat-grid\s*\{\s*grid-template-columns:\s*1fr;\s*\}/);
  });

  it('/for-builders still renders .moat-grid/.moat-card/.moat-icon (the only remaining consumer)', () => {
    const html = readPublic('for-builders.html');
    assert.match(html, /<div class="moat-grid">/);
    assert.match(html, /<div class="moat-card reveal">/);
    assert.match(html, /class="moat-icon"/);
  });
});

describe('S1 (static): /status drops .status-body\'s own horizontal padding', () => {
  it('both .status-body padding declarations (desktop + <=640px) carry zero horizontal inset', () => {
    const html = readPublic('status.html');
    const decls = [...html.matchAll(/\.status-body\s*\{\s*padding:\s*([^;]+);/g)].map((m) => m[1].trim());
    assert.ok(decls.length >= 2, `expected at least 2 .status-body padding declarations, found ${decls.length}`);
    for (const decl of decls) {
      // "<top> <right> <bottom>" (3-value shorthand) or "<top> 0 <bottom>" —
      // either way the horizontal (2nd) value must be 0.
      const parts = decl.split(/\s+/);
      assert.equal(parts.length, 3, `.status-body padding "${decl}" should be a 3-value shorthand`);
      assert.equal(parts[1], '0', `.status-body padding "${decl}" must carry 0 horizontal inset`);
    }
  });
});

describe('N5 (static): /status body pins the footer to the bottom on short content', () => {
  it('body is a min-height:100vh flex column and #main takes flex:1', () => {
    const html = readPublic('status.html');
    const styleBlock = (html.match(/<style>([\s\S]*?)<\/style>/) || [, ''])[1];
    const bodyRule = ruleBody(styleBlock, '^\\s*body\\s*\\{');
    assert.ok(bodyRule, 'status.html defines its own body {} rule');
    assert.match(bodyRule, /min-height:\s*100vh/);
    assert.match(bodyRule, /display:\s*flex/);
    assert.match(bodyRule, /flex-direction:\s*column/);

    const mainRule = ruleBody(styleBlock, 'main#main\\s*\\{');
    assert.ok(mainRule, 'status.html gives #main flex:1');
    assert.match(mainRule, /flex:\s*1/);
  });
});

describe('S3 (static): /for-builders mobile hero content picks up .container\'s 24px', () => {
  it('.builders-hero-content gets 24px horizontal padding inside the <=600px media query', () => {
    const html = readPublic('for-builders.html');
    const styleBlock = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n');
    const mediaBlock = ruleBody(styleBlock, '@media \\(max-width: 600px\\)\\s*\\{');
    assert.ok(mediaBlock, 'the <=600px media query exists in for-builders.html');
    assert.match(mediaBlock, /\.builders-hero-content\s*\{\s*padding-left:\s*24px;\s*padding-right:\s*24px;\s*\}/);
  });
});

describe('N1 (static): FAQ accordion closed state is visibility:hidden', () => {
  it('.faq-answer is visibility:hidden closed and .faq-item.open .faq-answer is visibility:visible', () => {
    const faqAnswer = ruleBody(STYLES, '^\\.faq-answer\\s*\\{');
    assert.ok(faqAnswer, '.faq-answer rule exists');
    assert.match(faqAnswer, /visibility:\s*hidden/);
    assert.match(faqAnswer, /transition:[^;]*visibility/);

    const faqAnswerOpen = ruleBody(STYLES, '^\\.faq-item\\.open \\.faq-answer\\s*\\{');
    assert.ok(faqAnswerOpen, '.faq-item.open .faq-answer rule exists');
    assert.match(faqAnswerOpen, /visibility:\s*visible/);
  });

  it('the answer text stays in the DOM (no display:none / content removal), only visibility changes', () => {
    const faqAnswer = ruleBody(STYLES, '^\\.faq-answer\\s*\\{');
    assert.doesNotMatch(faqAnswer, /display:\s*none/);
  });
});

// Read at module scope (no assert — a describe-body assert is the CH-7
// silent-failure class this repo's ch7-describe-body-guard.test.js sweeps
// for; a plain throw here is fine, since it fails loudly rather than
// silently, but the value is simple enough not to need one).
const INDEX_STYLESHEET_MATCH = readPublic('index.html').match(/href="\/styles\.css\?v=(\d+)"/);
const CANONICAL_VERSION = INDEX_STYLESHEET_MATCH ? INDEX_STYLESHEET_MATCH[1] : null;

describe('N3 (static): /about + /writing link the shared stylesheet, no duplicated footer CSS', () => {
  it('index.html carries a /styles.css?v=N link to read the canonical version from', () => {
    assert.ok(CANONICAL_VERSION, 'index.html carries a /styles.css?v=N link');
  });

  for (const page of ['about.html', path.join('writing', 'index.html')]) {
    it(`${page} links /styles.css?v=${CANONICAL_VERSION}, same as index.html`, () => {
      const html = readPublic(page);
      assert.match(html, new RegExp(`href="/styles\\.css\\?v=${CANONICAL_VERSION}"`));
    });

    it(`${page} no longer defines footer/.footer-inner/.footer-logo/.footer-meta locally`, () => {
      const html = readPublic(page);
      const styleBlocks = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n');
      assert.doesNotMatch(styleBlocks, /^\s*footer\s*\{/m, `${page} must not locally define footer {}`);
      assert.doesNotMatch(styleBlocks, /\.footer-inner\s*\{/, `${page} must not locally define .footer-inner {}`);
      assert.doesNotMatch(styleBlocks, /\.footer-logo\s*\{/, `${page} must not locally define .footer-logo {}`);
      assert.doesNotMatch(styleBlocks, /\.footer-meta\s*\{/, `${page} must not locally define .footer-meta {}`);
    });
  }
});

describe('N4 (static): .container padding-removal breakpoint is 1200, not 1150', () => {
  it('the min-width: 1200px media query drops .container padding; no 1150px version remains', () => {
    assert.doesNotMatch(STYLES, /@media \(min-width: 1150px\)/);
    const block = ruleBody(STYLES, '^@media \\(min-width: 1200px\\)\\s*\\{');
    assert.ok(block, 'the min-width: 1200px media query exists');
    assert.match(block, /\.container\s*\{\s*padding-left:\s*0;\s*padding-right:\s*0;\s*\}/);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Tier 2: dynamic Playwright assertions (skips if playwright unavailable)
// ═══════════════════════════════════════════════════════════════════════

function isPlaywrightAvailable() {
  try {
    require.resolve('playwright');
    return true;
  } catch (e) {
    return false;
  }
}

function startStaticServer(root) {
  const MIME = {
    '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
    '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json',
  };
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(req.url.split('?')[0]);
    const filePath = path.join(root, urlPath);
    if (!filePath.startsWith(root)) { res.writeHead(403); res.end(); return; }
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
      res.end(data);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

describe('Tier 2 (dynamic, playwright)', () => {
  let tier2ok = false;
  let server;
  let base;
  let browser;

  before(async () => {
    if (!isPlaywrightAvailable()) return;
    server = await startStaticServer(PUBLIC_DIR);
    base = `http://127.0.0.1:${server.address().port}`;
    const { chromium } = require('playwright');
    browser = await chromium.launch();
    tier2ok = true;
  });

  after(async () => {
    if (browser) await browser.close();
    if (server) server.close();
  });

  const OVERFLOW_PAGES = ['status.html', 'for-builders.html', 'about.html', path.join('writing', 'index.html')];
  const WIDTHS = [375, 768, 1440];

  for (const page of OVERFLOW_PAGES) {
    for (const width of WIDTHS) {
      it(`no horizontal overflow on /${page.replace(/\\/g, '/')} at ${width}px`, async (t) => {
        if (!tier2ok) { t.skip('playwright not resolvable'); return; }
        const ctx = await browser.newContext({ viewport: { width, height: 900 } });
        const p = await ctx.newPage();
        try {
          await p.goto(`${base}/${page.replace(/\\/g, '/')}`, { waitUntil: 'networkidle' });
          const overflow = await p.evaluate(() => ({
            scrollWidth: document.documentElement.scrollWidth,
            clientWidth: document.documentElement.clientWidth,
          }));
          assert.ok(
            overflow.scrollWidth <= overflow.clientWidth + 1,
            `${page} at ${width}px: scrollWidth ${overflow.scrollWidth} > clientWidth ${overflow.clientWidth} (horizontal overflow)`
          );
        } finally {
          await ctx.close();
        }
      });
    }
  }

  it('B1: .moat-icon renders 32x32 and .moat-grid is two columns above 900px, one column at/below it', async (t) => {
    if (!tier2ok) { t.skip('playwright not resolvable'); return; }
    const wide = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const wp = await wide.newPage();
    try {
      await wp.goto(`${base}/for-builders.html`, { waitUntil: 'networkidle' });
      const iconBox = await wp.evaluate(() => {
        const el = document.querySelector('.moat-icon');
        const r = el.getBoundingClientRect();
        return { width: r.width, height: r.height };
      });
      assert.ok(Math.abs(iconBox.width - 32) <= 0.5, `.moat-icon width should be 32px, got ${iconBox.width}`);
      assert.ok(Math.abs(iconBox.height - 32) <= 0.5, `.moat-icon height should be 32px, got ${iconBox.height}`);

      const wideCols = await wp.evaluate(() => {
        const grid = document.querySelector('.moat-grid');
        return getComputedStyle(grid).gridTemplateColumns.trim().split(/\s+/).length;
      });
      assert.equal(wideCols, 2, `.moat-grid should be 2 columns at 1440px, got ${wideCols}`);
    } finally {
      await wide.close();
    }

    const narrow = await browser.newContext({ viewport: { width: 800, height: 900 } });
    const np = await narrow.newPage();
    try {
      await np.goto(`${base}/for-builders.html`, { waitUntil: 'networkidle' });
      const narrowCols = await np.evaluate(() => {
        const grid = document.querySelector('.moat-grid');
        return getComputedStyle(grid).gridTemplateColumns.trim().split(/\s+/).length;
      });
      assert.equal(narrowCols, 1, `.moat-grid should collapse to 1 column at 800px (<=900), got ${narrowCols}`);
    } finally {
      await narrow.close();
    }
  });

  for (const width of WIDTHS) {
    it(`S1: /status hero h1 and the body's first block share one left edge at ${width}px`, async (t) => {
      if (!tier2ok) { t.skip('playwright not resolvable'); return; }
      const ctx = await browser.newContext({ viewport: { width, height: 900 } });
      const p = await ctx.newPage();
      try {
        await p.goto(`${base}/status.html`, { waitUntil: 'networkidle' });
        const lefts = await p.evaluate(() => ({
          heroH1: document.querySelector('.page-title').getBoundingClientRect().left,
          bodyFirst: document.getElementById('overall-status').getBoundingClientRect().left,
        }));
        assert.ok(
          Math.abs(lefts.heroH1 - lefts.bodyFirst) <= 0.5,
          `at ${width}px hero h1 left (${lefts.heroH1}) should equal body's first block left (${lefts.bodyFirst})`
        );
      } finally {
        await ctx.close();
      }
    });
  }

  it('S3: /for-builders mobile (375px) hero h1 left edge equals the body section\'s left edge (40px)', async (t) => {
    if (!tier2ok) { t.skip('playwright not resolvable'); return; }
    const ctx = await browser.newContext({ viewport: { width: 375, height: 900 } });
    const p = await ctx.newPage();
    try {
      await p.goto(`${base}/for-builders.html`, { waitUntil: 'networkidle' });
      const lefts = await p.evaluate(() => ({
        heroH1: document.getElementById('builders-hero-heading').getBoundingClientRect().left,
        bodyLabel: document.querySelector('#how-it-earns .section-label').getBoundingClientRect().left,
      }));
      assert.ok(
        Math.abs(lefts.heroH1 - lefts.bodyLabel) <= 0.5,
        `hero h1 left (${lefts.heroH1}) should equal body section left (${lefts.bodyLabel})`
      );
      assert.ok(Math.abs(lefts.heroH1 - 40) <= 1, `hero h1 left should be ~40px at 375px, got ${lefts.heroH1}`);
    } finally {
      await ctx.close();
    }
  });

  it('N1: a link inside a closed FAQ answer is not focusable; opening the item makes it focusable', async (t) => {
    if (!tier2ok) { t.skip('playwright not resolvable'); return; }
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const p = await ctx.newPage();
    try {
      await p.goto(`${base}/for-builders.html`, { waitUntil: 'networkidle' });
      // The "No wallet? No problem" FAQ answer carries a /status link
      // (public/for-builders.html:1063) and starts closed.
      const before = await p.evaluate(() => {
        const item = [...document.querySelectorAll('.faq-item')].find(
          (el) => el.querySelector('.faq-answer-inner a[href="/status"]')
        );
        if (!item) return { found: false };
        const link = item.querySelector('.faq-answer-inner a[href="/status"]');
        const visibility = getComputedStyle(item.querySelector('.faq-answer')).visibility;
        link.focus();
        return { found: true, visibility, focused: document.activeElement === link };
      });
      assert.ok(before.found, 'a FAQ item with a /status link inside its answer exists on /for-builders');
      assert.equal(before.visibility, 'hidden', 'closed answer should be visibility:hidden');
      assert.equal(before.focused, false, 'a link inside a closed answer must not be focusable');

      const after = await p.evaluate(() => {
        const item = [...document.querySelectorAll('.faq-item')].find(
          (el) => el.querySelector('.faq-answer-inner a[href="/status"]')
        );
        item.querySelector('.faq-question').click();
        const link = item.querySelector('.faq-answer-inner a[href="/status"]');
        const visibility = getComputedStyle(item.querySelector('.faq-answer')).visibility;
        link.focus();
        return { visibility, focused: document.activeElement === link };
      });
      assert.equal(after.visibility, 'visible', 'open answer should be visibility:visible');
      assert.equal(after.focused, true, 'a link inside an open answer must be focusable');
    } finally {
      await ctx.close();
    }
  });

  it('N3: /about\'s footer link colour + border match /pricing\'s (both driven by the shared stylesheet)', async (t) => {
    if (!tier2ok) { t.skip('playwright not resolvable'); return; }
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const p = await ctx.newPage();
    try {
      const readFooter = async (page) => {
        await p.goto(`${base}/${page}`, { waitUntil: 'networkidle' });
        return p.evaluate(() => {
          const link = document.querySelector('footer .footer-meta a');
          const footer = document.querySelector('footer');
          return {
            color: getComputedStyle(link).color,
            borderTopColor: getComputedStyle(footer).borderTopColor,
          };
        });
      };
      const aboutFooter = await readFooter('about.html');
      const pricingFooter = await readFooter('pricing.html');
      assert.equal(aboutFooter.color, pricingFooter.color,
        `/about footer link colour (${aboutFooter.color}) should match /pricing's (${pricingFooter.color})`);
      assert.equal(aboutFooter.borderTopColor, pricingFooter.borderTopColor,
        `/about footer border colour (${aboutFooter.borderTopColor}) should match /pricing's (${pricingFooter.borderTopColor})`);
    } finally {
      await ctx.close();
    }
  });

  it('N4: .container computed horizontal padding holds 24px through 1199px and drops only at 1200px', async (t) => {
    if (!tier2ok) { t.skip('playwright not resolvable'); return; }
    const results = {};
    for (const width of [1149, 1150, 1199, 1200]) {
      const ctx = await browser.newContext({ viewport: { width, height: 900 } });
      const p = await ctx.newPage();
      try {
        await p.goto(`${base}/index.html`, { waitUntil: 'networkidle' });
        results[width] = await p.evaluate(() => {
          const el = document.querySelector('#own-learnings-free .container');
          return getComputedStyle(el).paddingLeft;
        });
      } finally {
        await ctx.close();
      }
    }
    assert.equal(results[1149], '24px', `.container padding-left at 1149px should be 24px, got ${results[1149]}`);
    assert.equal(results[1150], '24px', `.container padding-left at 1150px should be 24px, got ${results[1150]}`);
    assert.equal(results[1199], '24px', `.container padding-left at 1199px should be 24px, got ${results[1199]}`);
    assert.equal(results[1200], '0px', `.container padding-left at 1200px should be 0px, got ${results[1200]}`);
  });

  it('N5: /status footer tracks the viewport bottom on short content (proves the flex pin, not a coincidence)', async (t) => {
    if (!tier2ok) { t.skip('playwright not resolvable'); return; }
    // If #main were NOT absorbing the extra space via flex:1, the footer
    // would sit at a fixed absolute position (wherever the natural content
    // ends) no matter how tall the viewport is. Measuring at two very
    // different tall heights and requiring the footer to track EACH one
    // proves the pin is real, without needing to know the natural content
    // height up front (which min-height:100vh itself would confound if
    // measured directly).
    const measureAt = async (height) => {
      const ctx = await browser.newContext({ viewport: { width: 1280, height } });
      const p = await ctx.newPage();
      try {
        await p.goto(`${base}/status.html`, { waitUntil: 'networkidle' });
        return await p.evaluate(() => document.querySelector('footer').getBoundingClientRect().bottom);
      } finally {
        await ctx.close();
      }
    };
    const short = await measureAt(2000);
    const tall = await measureAt(3200);
    assert.ok(Math.abs(short - 2000) <= 2, `footer bottom at a 2000px viewport should be ~2000, got ${short}`);
    assert.ok(Math.abs(tall - 3200) <= 2, `footer bottom at a 3200px viewport should be ~3200, got ${tall}`);
  });
});
