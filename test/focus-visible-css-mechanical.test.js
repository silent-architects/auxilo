'use strict';

/**
 * test/focus-visible-css-mechanical.test.js — TECH-PM build, rows
 * FOCUS-VISIBLE + CSS-MECHANICAL (SITE-PERFECT-DEFECT-SHEET-2026-09-06.md).
 *
 * Two independent items from that sheet:
 *
 *   FOCUS-VISIBLE (sheet item V3, "Visual defect sheet" table): the
 *   site-wide keyboard-focus ring. public/styles.css previously carried two
 *   textually-identical `*:focus-visible` / `button,a,input:focus-visible`
 *   blocks (both `outline: 2px solid var(--aurum)`), consolidated into one
 *   universal `*:focus-visible { outline: 1.5px solid var(--ivory);
 *   outline-offset: 2px; }` rule so every focusable element -- nav links,
 *   buttons, footer links, form controls, the hamburger toggle -- gets a
 *   ring in the ivory token (var(--ivory) = #FAFAF8 = rgb(250,250,248)),
 *   which survives gold grounds the way the pre-existing .nav-cta-only
 *   ivory override already did. `:focus-visible` (not bare `:focus`)
 *   already excludes mouse-click focus, so no separate
 *   `:focus:not(:focus-visible)` suppression rule was needed or added.
 *
 *   CSS-MECHANICAL (sheet §"Mechanical dispositions (no design judgment
 *   required)" table): four no-judgment-required fixes --
 *     - how-it-works.html .hiw-section-heading font-size: was a literal
 *       clamp(28px,3.5vw,42px), now var(--h2-section) (same value).
 *     - for-agents.html .page-hero-content and how-it-works.html
 *       .hiw-hero h1 max-width: was a literal 1100px, now var(--max-w)
 *       (same value). how-submissions-work.html's own .page-hero-content
 *       (max-width: 820px, a genuinely different value) is untouched --
 *       the sheet's table names only for-agents + how-it-works.
 *     - for-builders.html .earnings-scenario h3/p font-size: were swapped
 *       (13px/14px) vs the shared styles.css rule (14px/13px); un-swapped,
 *       every other property (weight, letter-spacing, uppercase, color)
 *       left as this page's own intentional override.
 *     - for-builders.html's page-scoped .tier-* fork (.tier-cards-grid,
 *       .tier-card and its variants, .tier-card-header, .tier-icon,
 *       .tier-name, .tier-card .tier-desc, .tier-numbers, .tier-row and
 *       its variants, .tier-year, .tier-amount, .tier-annual and its
 *       parts) is deleted, including its dead @media (max-width: 900px)
 *       .tier-cards-grid override, so the page falls through to the
 *       shared styles.css .tier-* rules. Verified dead before deletion:
 *       no element in for-builders.html's markup carries any of these
 *       classes (Tier 2 below re-verifies against the live DOM), so the
 *       deletion changes zero rendered computed styles.
 *
 * Tier 1 (static, always runs): parses public/styles.css and the touched
 * HTML files' page-scoped <style> blocks and asserts the exact CSS facts.
 * Tier 2 (dynamic, playwright -- already a devDependency, same
 * skip-gracefully convention as test/sheet9-fixups.test.js and
 * tests/test-mobile-nav-overlay.js): serves public/ over a throwaway
 * static server and asserts what static parsing can't -- keyboard-Tab
 * focus reachability and the resulting computed outline on a real
 * focused-visible element, resolved-pixel equality between the two
 * "now uses the token" selectors and the token itself, and that the
 * deleted .tier-* fork's classes render on zero elements.
 *
 * Runner: node --test test/focus-visible-css-mechanical.test.js
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const REPO_ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(REPO_ROOT, 'public');
const STYLES = fs.readFileSync(path.join(PUBLIC_DIR, 'styles.css'), 'utf8');

function readPublic(relPath) {
  return fs.readFileSync(path.join(PUBLIC_DIR, relPath), 'utf8');
}

/**
 * Depth-counting rule-body extractor (same technique as
 * test/sheet9-fixups.test.js's ruleBody / tests/test-mobile-nav-overlay.js's
 * parseCssRules): finds the first `{` at/after the selector match and
 * returns everything up to its matching `}`.
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

describe('FOCUS-VISIBLE (static): one universal ivory 1.5px focus-visible rule, no aurum/duplicate leftovers', () => {
  it('--ivory resolves to rgb(250,250,248) (#FAFAF8), the exact colour the sheet\'s V3 row specifies', () => {
    const root = ruleBody(STYLES, ':root\\s*\\{');
    assert.ok(root, ':root rule exists');
    assert.match(root, /--ivory:\s*#FAFAF8/i);
  });

  it('the universal *:focus-visible rule is outline: 1.5px solid var(--ivory); outline-offset: 2px', () => {
    const rule = ruleBody(STYLES, '\\*:focus-visible\\s*\\{');
    assert.ok(rule, '*:focus-visible rule exists');
    assert.match(rule, /outline:\s*1\.5px solid var\(--ivory\)/);
    assert.match(rule, /outline-offset:\s*2px/);
  });

  it('the old duplicate button:focus-visible,a:focus-visible,input:focus-visible aurum block is gone (consolidated into *:focus-visible)', () => {
    assert.doesNotMatch(STYLES, /button:focus-visible,\s*\n\s*a:focus-visible,\s*\n\s*input:focus-visible\s*\{/,
      'the redundant per-element focus-visible block should no longer exist');
  });

  it('no rule anywhere in styles.css still sets a focus-visible outline in aurum (2px solid var(--aurum) as a *:focus-visible/button,a,input pattern is gone)', () => {
    // .nav-cta:focus-visible is intentionally left alone (already ivory,
    // pre-dates this fix, not part of the V3 defect) -- this assertion only
    // guards against the aurum *:focus-visible / button,a,input:focus-visible
    // pattern this fix removed reappearing.
    assert.doesNotMatch(STYLES, /\*:focus-visible\s*\{\s*outline:\s*2px solid var\(--aurum\)/);
  });

  it('dashboard.html\'s .form-input no longer carries a blanket outline: none (it used to sit at the same specificity as, and later in cascade order than, the shared *:focus-visible rule, permanently killing its ring)', () => {
    const html = readPublic('dashboard.html');
    const rule = ruleBody(html, '\\.form-input\\s*\\{');
    assert.ok(rule, '.form-input rule exists in dashboard.html');
    assert.doesNotMatch(rule, /outline:\s*none/, '.form-input\'s base rule should not set outline: none unconditionally');
  });
});

describe('CSS-MECHANICAL (static): the four no-judgment-required token dispositions', () => {
  it('.hiw-section-heading font-size is var(--h2-section), matching the token\'s own value', () => {
    const hiwHtml = readPublic('how-it-works.html');
    const rule = ruleBody(hiwHtml, '\\.hiw-section-heading\\s*\\{');
    assert.ok(rule, '.hiw-section-heading rule exists in how-it-works.html');
    assert.match(rule, /font-size:\s*var\(--h2-section\)/);
    assert.doesNotMatch(rule, /font-size:\s*clamp\(/, 'the literal clamp() value should be gone, replaced by the token');

    const token = ruleBody(STYLES, ':root\\s*\\{');
    assert.match(token, /--h2-section:\s*clamp\(28px,\s*3\.5vw,\s*42px\)/,
      '--h2-section is still clamp(28px,3.5vw,42px), the exact value .hiw-section-heading used to hardcode');
  });

  it('.page-hero-content (for-agents) and .hiw-hero h1 (how-it-works) max-width is var(--max-w), matching the token\'s own 1100px value', () => {
    const forAgentsHtml = readPublic('for-agents.html');
    const pageHeroContent = ruleBody(forAgentsHtml, '\\.page-hero-content\\s*\\{');
    assert.ok(pageHeroContent, '.page-hero-content rule exists in for-agents.html');
    assert.match(pageHeroContent, /max-width:\s*var\(--max-w\)/);

    const hiwHtml = readPublic('how-it-works.html');
    const hiwHeroH1 = ruleBody(hiwHtml, '\\.hiw-hero h1\\s*\\{');
    assert.ok(hiwHeroH1, '.hiw-hero h1 rule exists in how-it-works.html');
    assert.match(hiwHeroH1, /max-width:\s*var\(--max-w\)/);

    const token = ruleBody(STYLES, ':root\\s*\\{');
    assert.match(token, /--max-w:\s*1100px/, '--max-w is still 1100px, the exact value both selectors used to hardcode');
  });

  it('how-submissions-work.html\'s .page-hero-content (max-width: 820px, a genuinely different value, out of the sheet\'s scope for this row) is untouched', () => {
    const html = readPublic('how-submissions-work.html');
    const rule = ruleBody(html, '\\.page-hero-content\\s*\\{');
    assert.ok(rule, '.page-hero-content rule exists in how-submissions-work.html');
    assert.match(rule, /max-width:\s*820px/, 'not var(--max-w) -- 820px is a real, different value, correctly out of scope');
  });

  it('for-builders.html .earnings-scenario h3/p font-size are un-swapped: h3 14px, p 13px, matching the shared styles.css rule', () => {
    const html = readPublic('for-builders.html');
    const h3 = ruleBody(html, '\\.earnings-scenario h3\\s*\\{');
    const p = ruleBody(html, '\\.earnings-scenario p\\s*\\{');
    assert.ok(h3 && p, 'for-builders.html .earnings-scenario h3/p rules exist');
    assert.match(h3, /font-size:\s*14px/);
    assert.match(p, /font-size:\s*13px/);

    const sharedH3 = ruleBody(STYLES, '\\.earnings-scenario h3\\s*\\{');
    const sharedP = ruleBody(STYLES, '\\.earnings-scenario p\\s*\\{');
    assert.match(sharedH3, /font-size:\s*14px/, 'shared styles.css .earnings-scenario h3 is 14px');
    assert.match(sharedP, /font-size:\s*13px/, 'shared styles.css .earnings-scenario p is 13px');
  });

  it('for-builders.html no longer carries its own .tier-card / .tier-cards-grid fork (falls through to shared styles.css)', () => {
    const html = readPublic('for-builders.html');
    assert.equal(ruleBody(html, '\\.tier-cards-grid\\s*\\{'), null, '.tier-cards-grid page-scoped rule is gone');
    assert.equal(ruleBody(html, '\\.tier-card\\s*\\{'), null, '.tier-card page-scoped rule is gone');
    assert.equal(ruleBody(html, '\\.tier-annual\\s*\\{'), null, '.tier-annual page-scoped rule is gone');
    assert.doesNotMatch(html, /\.tier-card--power\s*\{/);
    assert.doesNotMatch(html, /@media \(max-width: 900px\)\s*\{\s*\.tier-cards-grid/, 'the dead 900px .tier-cards-grid override is also gone');

    // The shared rule this page now falls through to is untouched.
    const sharedTierCard = ruleBody(STYLES, '\\.tier-card\\s*\\{');
    assert.ok(sharedTierCard, 'shared styles.css .tier-card rule still exists, unchanged');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Tier 2: dynamic (playwright) assertions
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
    '.woff2': 'font/woff2',
  };
  const server = http.createServer((req, res) => {
    let urlPath = decodeURIComponent(req.url.split('?')[0]);
    if (urlPath === '/') urlPath = '/index.html';
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

  it('FOCUS-VISIBLE: keyboard-Tab to the first nav link renders a solid ivory outline, not outline-style: none', async (t) => {
    if (!tier2ok) { t.skip('playwright not resolvable'); return; }
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const p = await ctx.newPage();
    try {
      await p.goto(`${base}/index.html`, { waitUntil: 'networkidle' });
      // Tab past the skip-link and the nav logo to a plain .nav-links a.
      await p.keyboard.press('Tab');
      await p.keyboard.press('Tab');
      await p.keyboard.press('Tab');
      const info = await p.evaluate(() => {
        const el = document.activeElement;
        const cs = getComputedStyle(el);
        return {
          tag: el.tagName,
          isNavLink: el.closest('.nav-links') !== null,
          outlineStyle: cs.outlineStyle,
          outlineWidth: cs.outlineWidth,
          outlineColor: cs.outlineColor,
        };
      });
      assert.equal(info.tag, 'A', `expected the third Tab stop to land on an <a>, got ${info.tag}`);
      assert.notEqual(info.outlineStyle, 'none', 'outline-style should not be none on a keyboard-focused link');
      assert.equal(info.outlineStyle, 'solid');
      // Chromium's used-value for outline-width rounds a declared 1.5px down
      // to the nearest whole device pixel (1px at devicePixelRatio 1) --
      // verified directly (a probe with the same declared width renders
      // identically) and confirmed against the pre-existing 2px .nav-cta
      // ivory ring, which is unaffected because 2 is already a whole
      // pixel. The authored declaration (1.5px, in source) is asserted
      // separately in the static Tier 1 block above; this only asserts the
      // real rendered/used value.
      assert.equal(info.outlineWidth, '1px');
      assert.equal(info.outlineColor, 'rgb(250, 250, 248)', 'outline colour should be the ivory token, not aurum');
    } finally {
      await ctx.close();
    }
  });

  it('FOCUS-VISIBLE: the ring reaches every focusable class named in the sheet -- footer link, form control (desktop viewport)', async (t) => {
    if (!tier2ok) { t.skip('playwright not resolvable'); return; }
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const p = await ctx.newPage();
    try {
      await p.goto(`${base}/index.html`, { waitUntil: 'networkidle' });
      const footerInfo = await p.evaluate(() => {
        const el = document.querySelector('.footer-links a, .footer-meta a');
        if (!el) return null;
        el.focus();
        const cs = getComputedStyle(el);
        return { outlineStyle: cs.outlineStyle, outlineColor: cs.outlineColor, matchesFocusVisible: el.matches(':focus-visible') };
      });
      assert.ok(footerInfo, 'a footer link exists on the homepage');
      assert.ok(footerInfo.matchesFocusVisible, 'programmatic .focus() on a footer link matches :focus-visible');
      assert.notEqual(footerInfo.outlineStyle, 'none');
      assert.equal(footerInfo.outlineColor, 'rgb(250, 250, 248)');

      await p.goto(`${base}/dashboard.html`, { waitUntil: 'networkidle' });
      const formInfo = await p.evaluate(() => {
        const el = document.querySelector('.form-input');
        if (!el) return null;
        el.focus();
        const cs = getComputedStyle(el);
        return { outlineStyle: cs.outlineStyle, outlineColor: cs.outlineColor };
      });
      assert.ok(formInfo, '.form-input exists on /dashboard');
      // dashboard.html's .form-input used to carry an unconditional
      // `outline: none;` -- same specificity as styles.css's shared
      // *:focus-visible rule (0,1,0 each) and later in cascade order (this
      // page's own <style> block loads after the linked stylesheet), so it
      // won outright and killed the ring on every keyboard/mouse focus of
      // this field. Removed (see dashboard.html's FOCUS-VISIBLE comment) --
      // this asserts it stays gone.
      assert.notEqual(formInfo.outlineStyle, 'none',
        '.form-input should render a visible focus outline (its old unconditional `outline: none` must not have returned)');
      assert.equal(formInfo.outlineColor, 'rgb(250, 250, 248)');
    } finally {
      await ctx.close();
    }
  });

  it('FOCUS-VISIBLE: the hamburger toggle (only reachable/visible at <=900px, per styles.css\'s nav breakpoint) gets the ring too', async (t) => {
    if (!tier2ok) { t.skip('playwright not resolvable'); return; }
    const ctx = await browser.newContext({ viewport: { width: 375, height: 800 } });
    const p = await ctx.newPage();
    try {
      await p.goto(`${base}/index.html`, { waitUntil: 'networkidle' });
      // Real keyboard Tab, not programmatic .focus() -- the hamburger is
      // display:none above 900px so it can't be focused there at all, and
      // separately a <button>'s programmatic .focus() does not reliably
      // satisfy :focus-visible in Chromium the way a real Tab keypress does.
      let info = null;
      for (let i = 0; i < 20; i++) {
        await p.keyboard.press('Tab');
        info = await p.evaluate(() => {
          const el = document.activeElement;
          const cs = getComputedStyle(el);
          return { tag: el.tagName, cls: el.className, outlineStyle: cs.outlineStyle, outlineColor: cs.outlineColor };
        });
        if (info.cls && info.cls.split(' ').includes('hamburger')) break;
      }
      assert.ok(info && info.cls && info.cls.split(' ').includes('hamburger'),
        `expected to Tab onto .hamburger within 20 presses at 375px, last stop was ${info && info.tag}.${info && info.cls}`);
      assert.equal(info.tag, 'BUTTON');
      assert.notEqual(info.outlineStyle, 'none');
      assert.equal(info.outlineColor, 'rgb(250, 250, 248)');
    } finally {
      await ctx.close();
    }
  });

  it('CSS-MECHANICAL: .hiw-section-heading\'s resolved font-size matches var(--h2-section) resolved on a neutral probe element, at 1440px and 700px', async (t) => {
    if (!tier2ok) { t.skip('playwright not resolvable'); return; }
    // Widths above the pre-existing, already-approved DR-3 mobile-type-ramp
    // breakpoint (styles.css @media (max-width: 600px) { section h2 {
    // font-size: 25px !important; } }) only -- below 600px that separate,
    // deliberate rule correctly wins over any section h2's own font-size
    // (including var(--h2-section)) regardless of specificity, because it
    // is `!important`. That is real, shipped, unrelated behavior this row
    // doesn't touch, not something this equality check should fail on.
    for (const width of [1440, 700]) {
      const ctx = await browser.newContext({ viewport: { width, height: 900 } });
      const p = await ctx.newPage();
      try {
        await p.goto(`${base}/how-it-works.html`, { waitUntil: 'networkidle' });
        const result = await p.evaluate(() => {
          const heading = document.getElementById('upload-heading');
          const probe = document.createElement('div');
          probe.style.fontSize = 'var(--h2-section)';
          document.body.appendChild(probe);
          const out = {
            headingFontSize: getComputedStyle(heading).fontSize,
            tokenFontSize: getComputedStyle(probe).fontSize,
          };
          probe.remove();
          return out;
        });
        assert.equal(result.headingFontSize, result.tokenFontSize,
          `at ${width}px: .hiw-section-heading (${result.headingFontSize}) should equal var(--h2-section) (${result.tokenFontSize})`);
      } finally {
        await ctx.close();
      }
    }
  });

  it('CSS-MECHANICAL: .page-hero-content (for-agents) and .hiw-hero h1 (how-it-works) resolved max-width matches var(--max-w) resolved on a neutral probe', async (t) => {
    if (!tier2ok) { t.skip('playwright not resolvable'); return; }
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const p = await ctx.newPage();
    try {
      await p.goto(`${base}/for-agents.html`, { waitUntil: 'networkidle' });
      const forAgents = await p.evaluate(() => {
        const el = document.querySelector('.page-hero-content');
        const probe = document.createElement('div');
        probe.style.maxWidth = 'var(--max-w)';
        document.body.appendChild(probe);
        const out = { elMaxWidth: getComputedStyle(el).maxWidth, tokenMaxWidth: getComputedStyle(probe).maxWidth };
        probe.remove();
        return out;
      });
      assert.equal(forAgents.elMaxWidth, forAgents.tokenMaxWidth);
      assert.equal(forAgents.elMaxWidth, '1100px');

      await p.goto(`${base}/how-it-works.html`, { waitUntil: 'networkidle' });
      const hiw = await p.evaluate(() => {
        const el = document.querySelector('.hiw-hero h1');
        const probe = document.createElement('div');
        probe.style.maxWidth = 'var(--max-w)';
        document.body.appendChild(probe);
        const out = { elMaxWidth: getComputedStyle(el).maxWidth, tokenMaxWidth: getComputedStyle(probe).maxWidth };
        probe.remove();
        return out;
      });
      assert.equal(hiw.elMaxWidth, hiw.tokenMaxWidth);
      assert.equal(hiw.elMaxWidth, '1100px');
    } finally {
      await ctx.close();
    }
  });

  it('CSS-MECHANICAL: /for-builders renders zero elements carrying any deleted .tier-* class (the fork was dead code, deletion changed nothing)', async (t) => {
    if (!tier2ok) { t.skip('playwright not resolvable'); return; }
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const p = await ctx.newPage();
    try {
      await p.goto(`${base}/for-builders.html`, { waitUntil: 'networkidle' });
      const count = await p.evaluate(() =>
        document.querySelectorAll(
          '.tier-cards-grid, .tier-card, .tier-card--active, .tier-card--power, .tier-card-header, ' +
          '.tier-icon, .tier-name, .tier-desc, .tier-numbers, .tier-row, .tier-row-highlight, ' +
          '.tier-year, .tier-amount, .tier-annual, .tier-annual-label, .tier-annual-amount'
        ).length
      );
      assert.equal(count, 0, 'no element on /for-builders should carry any of the deleted .tier-* classes');
    } finally {
      await ctx.close();
    }
  });

  it('CSS-MECHANICAL: /for-builders .earnings-scenario h3/p resolve to 14px/13px live', async (t) => {
    if (!tier2ok) { t.skip('playwright not resolvable'); return; }
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const p = await ctx.newPage();
    try {
      await p.goto(`${base}/for-builders.html`, { waitUntil: 'networkidle' });
      const sizes = await p.evaluate(() => {
        const h3 = document.querySelector('.earnings-scenario h3');
        const para = document.querySelector('.earnings-scenario p');
        return {
          h3: h3 ? getComputedStyle(h3).fontSize : null,
          p: para ? getComputedStyle(para).fontSize : null,
        };
      });
      assert.equal(sizes.h3, '14px');
      assert.equal(sizes.p, '13px');
    } finally {
      await ctx.close();
    }
  });
});
