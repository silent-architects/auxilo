'use strict';

/**
 * test/w3-b-hero-jumps.test.js — SITE-RESTRUCTURE-W3 item B (2026-09-07,
 * Tyler-approved: "how-it-works section jumps: tabs or anchor buttons in
 * the hero").
 *
 * ~/.auxilo/handoffs/SITE-RESTRUCTURE-W3-SPEC-2026-09-07.md, section B.
 *
 * Two anchor buttons ("For Builders" / "For Agents") sit in the
 * how-it-works.html hero, below the subtitle, above the live-ledger stat.
 * They smooth-scroll to the page's two existing step sequences
 * (#how-to-start-earning / #how-to-access-knowledge — new stable ids added
 * to those sections' own <section> elements; the h2s inside keep their
 * pre-existing upload-heading/download-heading ids for aria-labelledby).
 * Styled outlined ivory via the site's existing .btn-secondary class
 * (reused, not duplicated) — navigation aids, not asks, so no gold.
 *
 * Static checks run unconditionally. The rendering/scroll checks need a
 * real browser and skip gracefully (t.skip()) if playwright is not
 * resolvable, same convention as test/mobile-header-offset.test.js and
 * tests/test-mobile-nav-overlay.js.
 *
 * Runner: node --test test/w3-b-hero-jumps.test.js
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(REPO, 'public');
const PAGE_PATH = path.join(PUBLIC_DIR, 'how-it-works.html');
const HTML = fs.readFileSync(PAGE_PATH, 'utf8');

const BUILDER_LABEL = 'For Builders';
const AGENT_LABEL = 'For Agents';
const BUILDER_TARGET_ID = 'how-to-start-earning';
const AGENT_TARGET_ID = 'how-to-access-knowledge';

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

// ─── Static checks (no browser needed) ──────────────────────────────────

describe('W3-B static: hero jump buttons and target ids present in markup', () => {
  it('the hero contains a "For Builders" anchor button linking to #how-to-start-earning', () => {
    const re = new RegExp(
      `<a href="#${BUILDER_TARGET_ID}" class="btn-secondary">${BUILDER_LABEL}</a>`
    );
    assert.ok(re.test(HTML), 'expected the exact "For Builders" anchor button markup in how-it-works.html');
  });

  it('the hero contains a "For Agents" anchor button linking to #how-to-access-knowledge', () => {
    const re = new RegExp(
      `<a href="#${AGENT_TARGET_ID}" class="btn-secondary">${AGENT_LABEL}</a>`
    );
    assert.ok(re.test(HTML), 'expected the exact "For Agents" anchor button markup in how-it-works.html');
  });

  it('"For Builders" appears before "For Agents" (spec order)', () => {
    const bi = HTML.indexOf('>' + BUILDER_LABEL + '<');
    const ai = HTML.indexOf('>' + AGENT_LABEL + '<');
    assert.ok(bi !== -1 && ai !== -1, 'both labels must be present');
    assert.ok(bi < ai, 'For Builders must come before For Agents');
  });

  it('the jump buttons sit between the hero subtitle and the hero-ledger stat', () => {
    // Search only the body markup -- the page-scoped <style> block also
    // contains the literal string "hiw-hero-jumps" (its own CSS selector),
    // which appears earlier in the file than the hero markup itself.
    const bodyStart = HTML.indexOf('<body>');
    assert.ok(bodyStart !== -1, 'expected a <body> tag');
    const body = HTML.slice(bodyStart);
    const subIdx = body.indexOf('class="hiw-hero-sub"');
    const jumpsIdx = body.indexOf('class="hiw-hero-jumps"');
    const ledgerIdx = body.indexOf('id="hero-ledger"');
    assert.ok(subIdx !== -1 && jumpsIdx !== -1 && ledgerIdx !== -1, 'all three anchors must exist in body markup');
    assert.ok(subIdx < jumpsIdx && jumpsIdx < ledgerIdx, 'expected order: subtitle, then jump buttons, then ledger stat');
  });

  it('neither button uses a gold/aurum class (navigation aid, not an ask)', () => {
    assert.ok(!/class="btn-primary">(For Builders|For Agents)</.test(HTML), 'jump buttons must not use .btn-primary (gold)');
  });

  for (const id of [BUILDER_TARGET_ID, AGENT_TARGET_ID]) {
    it(`id="${id}" exists exactly once in the page`, () => {
      const matches = HTML.match(new RegExp(`id="${id}"`, 'g')) || [];
      assert.equal(matches.length, 1, `expected exactly one id="${id}", found ${matches.length}`);
    });
  }

  it('#how-to-start-earning is the upload/earning section (aria-labelledby="upload-heading")', () => {
    assert.ok(
      /<section class="hiw-upload-section section-raised" id="how-to-start-earning" aria-labelledby="upload-heading">/.test(HTML),
      'expected id="how-to-start-earning" on the existing How to Start Earning <section>'
    );
  });

  it('#how-to-access-knowledge is the download/access section (aria-labelledby="download-heading")', () => {
    assert.ok(
      /<section class="hiw-download-section section-ground" id="how-to-access-knowledge" aria-labelledby="download-heading">/.test(HTML),
      'expected id="how-to-access-knowledge" on the existing How to Access Knowledge <section>'
    );
  });

  it('page-scoped CSS gives the two jump targets scroll-margin-top: var(--header-h)', () => {
    const re = /#how-to-start-earning,\s*\n\s*#how-to-access-knowledge\s*\{\s*\n\s*scroll-margin-top:\s*var\(--header-h\);/;
    assert.ok(re.test(HTML), 'expected a page-scoped rule giving both jump targets scroll-margin-top: var(--header-h)');
  });

  it('styles.css is untouched by this build (page-scoped CSS only, per spec preference)', (t) => {
    // Environment-independent by design: this compares against origin/main
    // rather than a local branch name (e.g. agent/w3-a), which only exists
    // on a developer's machine and is absent on the CI runner (CI only has
    // origin/main and the checked-out sha). Skips gracefully, never throws,
    // if origin/main can't be resolved.
    const { execFileSync } = require('node:child_process');
    let baseStyles;
    try {
      execFileSync('git', ['rev-parse', '--verify', 'origin/main'], {
        cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'ignore', 'ignore'],
      });
    } catch (e) {
      t.skip('origin/main is not resolvable in this environment; cannot verify styles.css against a base ref');
      return;
    }
    try {
      baseStyles = execFileSync('git', ['show', 'origin/main:public/styles.css'], { cwd: REPO, encoding: 'utf8' });
    } catch (e) {
      t.skip(`could not read public/styles.css from origin/main: ${e.message}`);
      return;
    }
    const currentStyles = fs.readFileSync(path.join(PUBLIC_DIR, 'styles.css'), 'utf8');
    assert.equal(currentStyles, baseStyles, 'public/styles.css should be unchanged from origin/main for this item');
  });
});

// ─── Rendering / scroll checks (needs playwright) ───────────────────────

describe('W3-B rendering: buttons in hero, outlined ivory, click-scroll lands target below header', { timeout: 120_000 }, () => {
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

  for (const width of [375, 1440]) {
    it(`at ${width}px: both jump buttons render inside the hero, computed border/colour are outlined ivory (not gold)`, async (t) => {
      if (!ok) { t.skip('playwright not resolvable'); return; }
      const ctx = await browser.newContext({ viewport: { width, height: 900 } });
      const p = await ctx.newPage();
      try {
        await p.goto(`${base}/how-it-works.html`, { waitUntil: 'networkidle' });
        const result = await p.evaluate(() => {
          const hero = document.getElementById('hiw-content');
          const heroRect = hero.getBoundingClientRect();
          const links = Array.from(document.querySelectorAll('.hiw-hero-jumps a'));
          return {
            heroBottom: heroRect.bottom,
            heroTop: heroRect.top,
            links: links.map((a) => {
              const r = a.getBoundingClientRect();
              const cs = getComputedStyle(a);
              return {
                text: a.textContent.trim(),
                href: a.getAttribute('href'),
                top: r.top,
                bottom: r.bottom,
                color: cs.color,
                borderColor: cs.borderColor,
                background: cs.backgroundColor,
              };
            }),
          };
        });
        assert.equal(result.links.length, 2, 'expected exactly two hero jump links');
        const aurumRgb = 'rgb(201, 168, 76)';
        for (const link of result.links) {
          assert.ok(
            link.top >= result.heroTop && link.bottom <= result.heroBottom,
            `${link.text} at ${width}px should be within the hero section (link ${link.top}-${link.bottom}, hero ${result.heroTop}-${result.heroBottom})`
          );
          assert.notEqual(link.color, aurumRgb, `${link.text} text colour must not be gold/aurum`);
          assert.notEqual(link.borderColor, aurumRgb, `${link.text} border colour must not be gold/aurum`);
          assert.notEqual(link.background, aurumRgb, `${link.text} background must not be gold/aurum`);
        }
      } finally {
        await ctx.close();
      }
    });
  }

  const cases = [
    { label: BUILDER_LABEL, targetId: BUILDER_TARGET_ID },
    { label: AGENT_LABEL, targetId: AGENT_TARGET_ID },
  ];

  for (const width of [375, 1440]) {
    for (const { label, targetId } of cases) {
      it(`at ${width}px: clicking "${label}" scrolls #${targetId}'s heading below the fixed header`, async (t) => {
        if (!ok) { t.skip('playwright not resolvable'); return; }
        const ctx = await browser.newContext({ viewport: { width, height: 900 } });
        const p = await ctx.newPage();
        try {
          await p.goto(`${base}/how-it-works.html`, { waitUntil: 'networkidle' });
          const startY = await p.evaluate(() => window.scrollY);
          const link = p.locator(`.hiw-hero-jumps a:has-text("${label}")`);
          await link.click();
          // scroll-behavior: smooth -- give the animation time to settle.
          await p.waitForTimeout(600);
          const result = await p.evaluate((id) => {
            const nav = document.getElementById('main-nav');
            const target = document.getElementById(id);
            return {
              scrollY: window.scrollY,
              navBottom: nav.getBoundingClientRect().bottom,
              targetTop: target.getBoundingClientRect().top,
            };
          }, targetId);
          assert.ok(result.scrollY > startY, `clicking "${label}" should scroll the page down from ${startY}, got ${result.scrollY}`);
          assert.ok(
            result.targetTop >= result.navBottom,
            `#${targetId} top (${result.targetTop}) should land at or below the fixed header's bottom (${result.navBottom}) at ${width}px`
          );
        } finally {
          await ctx.close();
        }
      });
    }
  }

  it('both jump buttons are keyboard reachable via Tab (no tabindex="-1", not hidden)', async (t) => {
    if (!ok) { t.skip('playwright not resolvable'); return; }
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const p = await ctx.newPage();
    try {
      await p.goto(`${base}/how-it-works.html`, { waitUntil: 'networkidle' });
      const result = await p.evaluate(() => {
        const links = Array.from(document.querySelectorAll('.hiw-hero-jumps a'));
        return links.map((a) => ({
          text: a.textContent.trim(),
          tabIndex: a.tabIndex,
          visible: !!(a.offsetWidth || a.offsetHeight || a.getClientRects().length),
        }));
      });
      assert.equal(result.length, 2);
      for (const link of result) {
        assert.notEqual(link.tabIndex, -1, `${link.text} must be keyboard reachable (tabIndex !== -1)`);
        assert.ok(link.visible, `${link.text} must be visible/rendered`);
      }
    } finally {
      await ctx.close();
    }
  });

  it('no layout shift: the desktop hero (1440px) h1.top matches the pre-existing pinned value (140)', async (t) => {
    if (!ok) { t.skip('playwright not resolvable'); return; }
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const p = await ctx.newPage();
    try {
      await p.goto(`${base}/how-it-works.html`, { waitUntil: 'networkidle' });
      const h1Top = await p.evaluate(() => document.querySelector('h1').getBoundingClientRect().top);
      assert.ok(Math.abs(h1Top - 140) < 0.5, `h1.top should remain 140 at 1440px (mobile-header-offset.test.js's pinned value), got ${h1Top}`);
    } finally {
      await ctx.close();
    }
  });
});
