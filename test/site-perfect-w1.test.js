'use strict';

/**
 * test/site-perfect-w1.test.js — SITE-PERFECT-W1 items 3 + 4 regression
 * (~/.auxilo/handoffs/SITE-PERFECT-DEFECT-SHEET-2026-09-06.md, rows V1/V2).
 *
 * Item 3 (V1): /works-with's `.ww-h1` broke the secondary-page scale --
 * `font-size: 64px; margin-bottom: 0` where /pricing's own h1
 * (`.pricing-page-header h1`, the AD's cited reference) computes
 * `font-size: 56px; margin-bottom: 20px` at 1440px via
 * `clamp(38px, 5vw, 56px)`. Fixed in public/works-with.html's page-scoped
 * `.ww-h1` rule to `font-size: 56px; margin-bottom: 20px`, matching
 * /pricing exactly (NOT the art director's 28px, which /pricing itself
 * disproves -- see the defect sheet's V1 row for the correction).
 *
 * Item 4 (V2): the homepage's UNHEADED section between
 * `#learning-explainer` ("What a Learning Is...") and `#own-learnings-free`
 * ("Never watch your agent...") -- `#works-with-band`, the works-with logo
 * band -- computed `padding: 96px 24px` against `var(--section-pad)`
 * (120px 24px) on the shared `section { padding: var(--section-pad); }`
 * rule (public/styles.css) that every other top-level homepage section
 * inherits unstyled. Fixed in public/index.html's page-scoped
 * `#works-with-band` rule to `padding: 120px 24px`, matching the shared
 * rule's vertical value. Only the desktop declaration was touched -- the
 * band's own `@media (max-width: 640px)` mobile override (56px 20px) is a
 * deliberate separate mobile treatment for this band and is out of this
 * item's scope (the defect and its 1440px positive control are both
 * desktop-only).
 *
 * Both fixes are scoped to page-local selectors (`.ww-h1` inside
 * works-with.html's own <style>, `#works-with-band` inside index.html's own
 * <style>) so nothing shared with another page's rules was touched.
 *
 * Runner: node --test test/site-perfect-w1.test.js
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(REPO, 'public');

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

// The eight top-level homepage sections (git-truth: grep '^<section' public/index.html,
// all eight live inside <main id="main">), each labeled by its first heading, or a
// descriptive label when it has none (works-with-band is the unheaded one this
// item's fix targets).
//
// #the-market was cut from the homepage (SITE-PERFECT-W2 A, commit 2997932,
// Tyler-approved: no unique claims, zero inbound links) -- see
// test/site-perfect-w2-a.test.js for the regression asserting its absence.
// This file's section list and count were updated to match (9 -> 8).
//
// #hero is deliberately excluded from the "everything computes 120px" invariant:
// public/styles.css's `#hero { padding: 0 24px; ... min-height: 100vh; }` is a
// full-viewport hero with its own layout system (flex-centered content, no
// var(--section-pad) rhythm) -- verified unchanged at 0px/0px before and after
// this fix, not part of the --section-pad rhythm the other 7 sections share.
const HOMEPAGE_SECTIONS = [
  { id: 'hero', label: 'hero (Hero heading)', expectPad: false },
  { id: 'learning-explainer', label: 'What a Learning Is, and Why Another Agent Would Use It', expectPad: true },
  { id: 'works-with-band', label: '(unheaded) works-with logo band', expectPad: true },
  { id: 'own-learnings-free', label: 'Never watch your agent solve the same problem twice.', expectPad: true },
  { id: 'how-it-works', label: 'Your Agents Learn. You Earn.', expectPad: true },
  { id: 'explore-section', label: 'explore-section (class-selected, no id)', expectPad: true },
  { id: 'faq', label: 'faq', expectPad: true },
  { id: 'footer-cta', label: 'footer-cta', expectPad: true },
];

describe('SITE-PERFECT-W1 item 3: /works-with h1 matches /pricing h1 at 1440px', { timeout: 60_000 }, () => {
  let ok = false;
  let server;
  let base;
  let browser;

  before(async () => {
    if (!isPlaywrightAvailable()) return;
    server = await startStaticServer(PUBLIC_DIR);
    base = `http://127.0.0.1:${server.address().port}`;
    const { chromium } = require('playwright');
    browser = await chromium.launch();
    ok = true;
  });

  after(async () => {
    if (browser) await browser.close();
    if (server) server.close();
  });

  async function measureH1(urlPath, selector) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const p = await ctx.newPage();
    try {
      await p.goto(`${base}/${urlPath}`, { waitUntil: 'networkidle' });
      return await p.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const cs = getComputedStyle(el);
        return { fontSize: cs.fontSize, marginBottom: cs.marginBottom };
      }, selector);
    } finally {
      await ctx.close();
    }
  }

  it('/works-with .ww-h1 computes font-size: 56px, margin-bottom: 20px', async (t) => {
    if (!ok) { t.skip('playwright not resolvable'); return; }
    const m = await measureH1('works-with.html', '.ww-h1');
    assert.ok(m, '.ww-h1 not found on /works-with');
    assert.equal(m.fontSize, '56px', `.ww-h1 font-size: got ${m.fontSize}`);
    assert.equal(m.marginBottom, '20px', `.ww-h1 margin-bottom: got ${m.marginBottom}`);
  });

  it('/pricing .pricing-page-header h1 computes font-size: 56px, margin-bottom: 20px', async (t) => {
    if (!ok) { t.skip('playwright not resolvable'); return; }
    const m = await measureH1('pricing.html', '.pricing-page-header h1');
    assert.ok(m, '.pricing-page-header h1 not found on /pricing');
    assert.equal(m.fontSize, '56px', `pricing h1 font-size: got ${m.fontSize}`);
    assert.equal(m.marginBottom, '20px', `pricing h1 margin-bottom: got ${m.marginBottom}`);
  });

  it('/works-with and /pricing h1 computed values are equal (the required proof)', async (t) => {
    if (!ok) { t.skip('playwright not resolvable'); return; }
    const ww = await measureH1('works-with.html', '.ww-h1');
    const pricing = await measureH1('pricing.html', '.pricing-page-header h1');
    assert.equal(ww.fontSize, pricing.fontSize, `font-size mismatch: works-with=${ww.fontSize} pricing=${pricing.fontSize}`);
    assert.equal(ww.marginBottom, pricing.marginBottom, `margin-bottom mismatch: works-with=${ww.marginBottom} pricing=${pricing.marginBottom}`);
  });
});

describe('SITE-PERFECT-W1 item 4: every top-level homepage section computes padding: 120px vertical at 1440px', { timeout: 60_000 }, () => {
  let ok = false;
  let server;
  let base;
  let browser;
  let page;
  let ctx;

  before(async () => {
    if (!isPlaywrightAvailable()) return;
    server = await startStaticServer(PUBLIC_DIR);
    base = `http://127.0.0.1:${server.address().port}`;
    const { chromium } = require('playwright');
    browser = await chromium.launch();
    ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    page = await ctx.newPage();
    await page.goto(`${base}/index.html`, { waitUntil: 'networkidle' });
    ok = true;
  });

  after(async () => {
    if (ctx) await ctx.close();
    if (browser) await browser.close();
    if (server) server.close();
  });

  it('index.html <main id="main"> declares exactly the 8 expected top-level sections (no drift)', async (t) => {
    if (!ok) { t.skip('playwright not resolvable'); return; }
    const found = await page.evaluate(() =>
      Array.from(document.querySelectorAll('#main > section')).map((s) => s.id || `.${s.className}`)
    );
    const expected = HOMEPAGE_SECTIONS.map((s) => (s.id === 'explore-section' ? '.explore-section' : s.id));
    assert.deepEqual(found, expected, `top-level section list drifted: found ${JSON.stringify(found)}, expected ${JSON.stringify(expected)}`);
  });

  for (const { id, label, expectPad } of HOMEPAGE_SECTIONS) {
    const selector = id === 'explore-section' ? '.explore-section' : `#${id}`;
    const want = expectPad ? '120px' : '0px';
    it(`section "${label}" (${selector}) computes padding-top: ${want}, padding-bottom: ${want}`, async (t) => {
      if (!ok) { t.skip('playwright not resolvable'); return; }
      const pad = await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const cs = getComputedStyle(el);
        return { top: cs.paddingTop, bottom: cs.paddingBottom };
      }, selector);
      assert.ok(pad, `${selector} not found on /`);
      assert.equal(pad.top, want, `${label} (${selector}) padding-top: got ${pad.top}, expected ${want}`);
      assert.equal(pad.bottom, want, `${label} (${selector}) padding-bottom: got ${pad.bottom}, expected ${want}`);
    });
  }

  it('the "Your Agents Learn. You Earn." section (#how-it-works) is unchanged at 120px (must NOT have been touched)', async (t) => {
    if (!ok) { t.skip('playwright not resolvable'); return; }
    const pad = await page.evaluate(() => {
      const el = document.getElementById('how-it-works');
      const cs = getComputedStyle(el);
      return { top: cs.paddingTop, bottom: cs.paddingBottom };
    });
    assert.equal(pad.top, '120px');
    assert.equal(pad.bottom, '120px');
  });
});
