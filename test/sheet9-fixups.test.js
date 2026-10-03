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
 *   B1  SUPERSEDED 2026-09-06 by wave D1 (the AD design-tells sweep): the
 *       original ruling restored .moat-grid/.moat-card/.moat-icon verbatim
 *       from 624044c after a Gate-A regression. Wave D1's tells 5/6
 *       deliberately remove .moat-icon and flatten .moat-card to a ruled
 *       list, so this block now protects THAT state instead — no .moat-icon
 *       anywhere, .moat-card full-width at both 1440px and 800px.
 *   S1  /status: hero h1 and the body's first block share one left edge at
 *       375/768/1440 (.status-body's own horizontal padding dropped so
 *       .container alone drives both insets).
 *   S3  /for-builders: the mobile (<=600px) hero h1 left edge equals the
 *       body section's left edge (40px — .builders-hero-content now picks
 *       up the same 24px .container normally supplies). Reference element
 *       updated 2026-09-06 (wave D1): the section's own h2 replaces the
 *       .section-label eyebrow the AD design-tells sweep removed — both
 *       shared the same left edge, so the measurement is unchanged.
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
const { PAGE_GUTTER } = require('./helpers/ad-rules-check');

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

describe('B1 (static, SUPERSEDED by the design rebuild): .moat-grid, .moat-card and .moat-icon are retired', () => {
  // The original B1 protected the 2-col bordered-card + 32x32 icon design against an accidental
  // dead-CSS deletion (Gate-A regression, sheet 9). Wave D1's AD design-tells sweep flattened it to a
  // hairline-ruled list, and the design rebuild then removed the last page that used it (the
  // paragraph on /for-builders is a claim beside a drawing now). With no user left the whole family
  // is gone from the shared sheet. This block protects THAT state instead.
  it('.moat-grid, .moat-card (and its h3, p, :hover) and .moat-icon have no rule in the shared sheet', () => {
    for (const selector of ['\\.moat-grid', '\\.moat-card', '\\.moat-card:first-child', '\\.moat-card:hover', '\\.moat-card h3', '\\.moat-card p', '\\.moat-icon']) {
      assert.equal(ruleBody(STYLES, `^${selector}\\s*\\{`), null, `${selector.replace(/\\\\/g, '')} rule is retired`);
    }
    assert.doesNotMatch(STYLES, /\.moat-/, 'styles.css carries no .moat-* selector at all');
    // Positive control: ruleBody still finds a rule that exists.
    assert.ok(ruleBody(STYLES, '^\\.dive-row\\s*\\{'), 'positive control: ruleBody finds the live .dive-row rule');
  });

  it('the <=900px media query no longer collapses .moat-grid to one column (nothing to collapse — it is already a single-column ruled list)', () => {
    const mediaBlock = ruleBody(STYLES, '^@media \\(max-width: 900px\\)\\s*\\{');
    assert.ok(mediaBlock, 'the <=900px media query exists');
    assert.doesNotMatch(mediaBlock, /\.moat-grid\s*\{/, 'no .moat-grid override remains in the <=900px block');
  });

  // Design rebuild: the "You Control What Publishes" block on /for-builders is a claim beside the
  // review-queue drawing (a .pair), so its paragraph no longer sits in a .moat-grid/.moat-card
  // wrapper. The shared rules went with it (the positive control is the paragraph itself, still
  // served inside the .pair).
  it('/for-builders no longer wraps its "You Control What Publishes" paragraph in .moat-grid/.moat-card, and never renders .moat-icon', () => {
    const html = readPublic('for-builders.html');
    assert.doesNotMatch(html, /class="moat-grid"/);
    assert.doesNotMatch(html, /class="moat-card"/);
    assert.doesNotMatch(html, /class="moat-icon"/, '.moat-icon markup is gone from /for-builders');
    assert.match(html, /<section id="why-builders"[^>]*>\s*<div class="container pair art-left">\s*<div>\s*<h2 id="why-builders-heading" >You Control What Publishes<\/h2>\s*<p>Raw transcripts never leave your machine\./, 'the paragraph is the claim beside the drawing');
    assert.equal(ruleBody(STYLES, '^\\.moat-card\\s*\\{'), null, 'the shared .moat-card rule went with its last user');
  });
});

describe('S1 (static): /status drops .status-body\'s own horizontal padding', () => {
  // SPACING-0927 (BUILD-BRIEF-SPACING.md): .status-body's vertical padding
  // is now the ruled section rhythm (var(--section-pad), responsive at the
  // shared 900/600px breakpoints) instead of a flat, ad hoc pair with its
  // own 640px-only override -- one rule now covers every width, so there is
  // only one declaration to check, not two. The horizontal inset is still
  // explicitly zeroed (via the longhand padding-left/right, not the
  // shorthand's 2nd value), so .container alone still drives the inset —
  // S1's actual point, unchanged.
  it('.status-body carries a zero horizontal inset (padding-left/right: 0) at every width', () => {
    const html = readPublic('status.html');
    const rule = ruleBody(html, '\\.status-body\\s*\\{');
    assert.ok(rule, '.status-body rule exists in status.html');
    assert.match(rule, /padding:\s*var\(--section-pad\)/, '.status-body uses the shared section-rhythm token');
    assert.match(rule, /padding-left:\s*0/, '.status-body zeroes its own left padding');
    assert.match(rule, /padding-right:\s*0/, '.status-body zeroes its own right padding');
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

describe('S3 (static): /for-builders hero content shares the body section\'s own left edge', () => {
  // SPACING-0927 (BUILD-BRIEF-SPACING.md B0-a): the 24px patch this test
  // used to require existed to compensate for a body section's OWN
  // .container carrying a second, stacked 24px padding below 1200px. That
  // stacking is gone everywhere now (`section > .container` is zeroed at
  // every width, styles.css) -- a body section's inset is its own
  // var(--section-pad) alone. #builders-hero (a <section>) and
  // .builders-hero-content both carry zero padding of their own (matching
  // every sibling hero's *-content wrapper), so the hero's inset is ALSO
  // just #builders-hero's own var(--section-pad) -- the two already match
  // with no page-local patch, at every width, not just <=600px.
  it('.builders-hero-content carries no padding of its own at any width', () => {
    const html = readPublic('for-builders.html');
    const styleBlock = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n');
    assert.doesNotMatch(styleBlock, /\.builders-hero-content\s*\{[^}]*padding/, '.builders-hero-content must not declare its own padding');
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
const INDEX_STYLESHEET_MATCH = readPublic('index.html').match(/href="\/styles\.css\?v=([0-9a-f]+)"/);
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

  // Design rebuild: /for-builders carries no .moat-grid/.moat-card any more (see the static test
  // above), so the full-width check is replaced by: no .moat-icon or .moat-card renders, and the
  // "You Control What Publishes" paragraph renders as the claim beside the drawing, at both widths.
  it('B1 (SUPERSEDED): .moat-icon and .moat-card render nowhere on /for-builders, and the You Control paragraph renders in the claim column at both 1440px and 800px', async (t) => {
    if (!tier2ok) { t.skip('playwright not resolvable'); return; }
    for (const width of [1440, 800]) {
      const ctx = await browser.newContext({ viewport: { width, height: 900 } });
      const p = await ctx.newPage();
      try {
        await p.goto(`${base}/for-builders.html`, { waitUntil: 'networkidle' });
        const found = await p.evaluate(() => {
          const para = document.querySelector('#why-builders .pair > div:first-child > p');
          const r = para ? para.getBoundingClientRect() : null;
          return {
            icons: document.querySelectorAll('.moat-icon').length,
            cards: document.querySelectorAll('.moat-card, .moat-grid').length,
            paraWidth: r ? r.width : 0,
            colWidth: para ? para.parentElement.getBoundingClientRect().width : 0,
          };
        });
        assert.equal(found.icons, 0, `.moat-icon should render nowhere at ${width}px`);
        assert.equal(found.cards, 0, `.moat-card/.moat-grid should render nowhere on /for-builders at ${width}px`);
        assert.ok(found.paraWidth > 0, `positive control: the You Control paragraph renders at ${width}px`);
        assert.ok(found.paraWidth <= found.colWidth + 1, `the paragraph fits its claim column at ${width}px: ${found.paraWidth} vs ${found.colWidth}`);
      } finally {
        await ctx.close();
      }
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

  it('S3: /for-builders mobile (375px) hero h1 left edge equals the body section\'s left edge (16px, SPACING-0927 ruled gutter -- was 40px)', async (t) => {
    if (!tier2ok) { t.skip('playwright not resolvable'); return; }
    const ctx = await browser.newContext({ viewport: { width: 375, height: 900 } });
    const p = await ctx.newPage();
    try {
      await p.goto(`${base}/for-builders.html`, { waitUntil: 'networkidle' });
      const lefts = await p.evaluate(() => ({
        heroH1: document.getElementById('builders-hero-heading').getBoundingClientRect().left,
        // The AD design-tells sweep (wave D1) removed .section-label
        // eyebrows sitewide; #how-earns-heading (the section's own h2,
        // previously right below the label) is the same left edge.
        bodyLabel: document.getElementById('how-earns-heading').getBoundingClientRect().left,
      }));
      assert.ok(
        Math.abs(lefts.heroH1 - lefts.bodyLabel) <= 0.5,
        `hero h1 left (${lefts.heroH1}) should equal body section left (${lefts.bodyLabel})`
      );
      // SPACING-0927 (BUILD-BRIEF-SPACING.md, SPACING-SHEET.md A1): the
      // ruled page gutter at 375px is 16px, sitewide (was 40px, the
      // now-removed .container double-pad compensation, B0-a). Compared
      // against the named token (M-5), not a bare number -- this is a
      // horizontal start position, not a rendered text metric, but the
      // token reference is the more honest source of truth either way.
      assert.ok(Math.abs(lefts.heroH1 - PAGE_GUTTER['375']) <= 1, `hero h1 left should be ~${PAGE_GUTTER['375']}px at 375px, got ${lefts.heroH1}`);
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

  // SPACING-0927 (BUILD-BRIEF-SPACING.md B0-a): the >=1200px zero-out this
  // block originally proved is still intact verbatim (N4 static, above) --
  // that was never the whole story, though. Below 1200px, a .container
  // nested directly in a <section> stacked ITS OWN 24px on top of the
  // section's own gutter (44px/40px at 768/375 instead of the ruled
  // 20px/16px). The fix removes that stacking at every width via a new,
  // more specific `section > .container` rule (styles.css) -- so
  // #own-learnings-free's .container (a direct child of a <section>) now
  // reads 0px at 1149/1150/1199 too, not just at 1200px. The two
  // mechanisms coexist (the original bare `.container` rule fires only at
  // >=1200px; the new `section > .container` rule fires at every width and
  // wins on specificity below 1200 where the bare rule doesn't apply
  // anyway) -- there is no longer a width where THIS element's padding is
  // 24px.
  it('N4: .container computed horizontal padding is 0px at every width once nested in a section (was 24px below 1200px)', async (t) => {
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
    assert.equal(results[1149], '0px', `.container padding-left at 1149px should be 0px, got ${results[1149]}`);
    assert.equal(results[1150], '0px', `.container padding-left at 1150px should be 0px, got ${results[1150]}`);
    assert.equal(results[1199], '0px', `.container padding-left at 1199px should be 0px, got ${results[1199]}`);
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
    // Design system pass: the page's own height changed with the section rhythm, so the two
    // tall viewports are taken relative to the page's natural height (measured in the same
    // run at a short viewport, where the footer bottom is the document height) instead of two
    // fixed numbers that the content could outgrow.
    const natural = await measureAt(700);
    const shortH = Math.ceil(natural) + 400;
    const tallH = Math.ceil(natural) + 1600;
    const short = await measureAt(shortH);
    const tall = await measureAt(tallH);
    assert.ok(Math.abs(short - shortH) <= 2, `footer bottom at a ${shortH}px viewport should be ~${shortH}, got ${short}`);
    assert.ok(Math.abs(tall - tallH) <= 2, `footer bottom at a ${tallH}px viewport should be ~${tallH}, got ${tall}`);
  });
});
