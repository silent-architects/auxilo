'use strict';

/**
 * test/for-builders-hero-fold.test.js
 *
 * The /for-builders hero's main button (`Connect Your Agent`) must sit fully inside the first
 * screen at 1280 by 720 and at 375 by 667: its top below the navigation, its bottom above the
 * viewport's bottom edge, both sides inside the viewport.
 *
 * Every assertion compares two live measurements taken in the same run (the button's box against
 * the window's own size, the navigation's box, the headline's box, the stat panel's box). No fixed
 * pixel number is pinned, so nothing here depends on how text is drawn on a given machine.
 *
 * Boots a tiny static server over public/ (no network, no real HOME) and drives it with
 * Playwright. Skips cleanly when Playwright is not installed.
 *
 * Runner: node --test test/for-builders-hero-fold.test.js
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const SCREENS = [
  { name: '1280x720', width: 1280, height: 720 },
  { name: '375x667', width: 375, height: 667 },
];

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

describe('/for-builders hero: the main button sits inside the first screen', { timeout: 120_000 }, () => {
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

  async function measure(screen) {
    const ctx = await browser.newContext({ viewport: { width: screen.width, height: screen.height } });
    const page = await ctx.newPage();
    try {
      await page.goto(`${base}/for-builders.html`, { waitUntil: 'networkidle' });
      await page.evaluate(() => document.fonts.ready);
      return await page.evaluate(() => {
        const box = (el) => {
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height };
        };
        const buttons = [...document.querySelectorAll('#builders-hero .hero-ctas a')];
        return {
          vw: window.innerWidth,
          vh: window.innerHeight,
          nav: box(document.getElementById('main-nav')),
          h1: box(document.getElementById('builders-hero-heading')),
          mainLabel: buttons[0] ? buttons[0].textContent.trim() : null,
          mainIsPrimary: buttons[0] ? buttons[0].classList.contains('btn-primary') : false,
          main: box(buttons[0]),
          second: box(buttons[1]),
          panel: box(document.querySelector('#builders-hero .builders-hero-stats')),
          copy: box(document.querySelector('#builders-hero .builders-hero-content')),
        };
      });
    } finally {
      await ctx.close();
    }
  }

  for (const screen of SCREENS) {
    it(`at ${screen.name}: Connect Your Agent is fully inside the first screen, below the navigation and below the headline`, async (t) => {
      if (!ok) { t.skip('playwright not resolvable'); return; }
      const m = await measure(screen);

      // Positive control: the measured element really is the hero's main button.
      assert.equal(m.mainLabel, 'Connect Your Agent', 'the first button in the hero is Connect Your Agent');
      assert.ok(m.mainIsPrimary, 'it is the page\'s primary button');
      assert.ok(m.main && m.main.height > 0 && m.main.width > 0, 'the button has a real box');

      // The viewport the page actually has is the one we asked for (the comparison target is live).
      assert.equal(m.vw, screen.width);
      assert.equal(m.vh, screen.height);

      assert.ok(m.main.bottom <= m.vh, `bottom edge ${m.main.bottom} must be at or above the viewport bottom ${m.vh}`);
      assert.ok(m.main.top >= m.nav.bottom, `top edge ${m.main.top} must be below the navigation bottom ${m.nav.bottom}`);
      assert.ok(m.main.left >= 0 && m.main.right <= m.vw, `sides ${m.main.left}..${m.main.right} must be inside the viewport width ${m.vw}`);
      assert.ok(m.main.top >= m.h1.bottom, `the button (${m.main.top}) sits below the headline (${m.h1.bottom})`);
    });
  }

  it('at 1280x720 the stat panel sits beside the copy, and at 375x667 it follows the buttons', async (t) => {
    if (!ok) { t.skip('playwright not resolvable'); return; }
    const wide = await measure(SCREENS[0]);
    assert.ok(wide.panel && wide.copy, 'the stat panel and the copy column exist');
    assert.ok(wide.panel.left >= wide.copy.right, `wide: the panel (${wide.panel.left}) starts at or after the copy column's right edge (${wide.copy.right})`);

    const phone = await measure(SCREENS[1]);
    const lowest = Math.max(phone.main.bottom, phone.second.bottom);
    assert.ok(phone.panel.top >= lowest, `phone: the panel top (${phone.panel.top}) is at or below the buttons' bottom (${lowest})`);
  });
});
