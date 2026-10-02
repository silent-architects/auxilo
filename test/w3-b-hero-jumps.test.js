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
      /<section class="hiw-upload-section" id="how-to-start-earning" aria-labelledby="upload-heading">/.test(HTML),
      'expected id="how-to-start-earning" on the existing How to Start Earning <section>'
    );
  });

  it('#how-to-access-knowledge is the download/access section (aria-labelledby="download-heading")', () => {
    assert.ok(
      /<section class="hiw-download-section on-tint" id="how-to-access-knowledge" aria-labelledby="download-heading">/.test(HTML),
      'expected id="how-to-access-knowledge" on the existing How to Access Knowledge <section>'
    );
  });

  it('page-scoped CSS gives the two jump targets scroll-margin-top: var(--header-h)', () => {
    const re = /#how-to-start-earning,\s*\n\s*#how-to-access-knowledge\s*\{\s*\n\s*scroll-margin-top:\s*var\(--header-h\);/;
    assert.ok(re.test(HTML), 'expected a page-scoped rule giving both jump targets scroll-margin-top: var(--header-h)');
  });

  // The former "styles.css differs from origin/main by nothing beyond the
  // two LAYOUT-SHEET 2026-09-26 edits" test case was deleted here
  // (FIX-UNIT H2, 2026-09-26). It compared the working tree's styles.css,
  // with a fixed list of named edits reverted, against origin/main's copy
  // byte-for-byte. That comparison goes red on main the moment
  // site/launch-wave-0926 merges, because origin/main then already
  // contains the edits it expects to revert -- it would fail on every
  // run on main forever after, CI included. It was a scope check for the
  // W3-B build ("this build touches no shared CSS"); W3-B shipped long
  // ago and the real invariant it was written to protect -- the
  // page-scoped scroll-margin-top rule above -- is asserted directly by
  // the test just above this comment.
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

  it('no layout shift: the desktop hero (1440px) h1.top sits exactly at its containing block\'s own content edge (no stray margin)', async (t) => {
    if (!ok) { t.skip('playwright not resolvable'); return; }
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const p = await ctx.newPage();
    try {
      await p.goto(`${base}/how-it-works.html`, { waitUntil: 'networkidle' });
      // SPACING-0927 Round 3 (FIX-UNIT-SPACING-3.md M-5): was a literal
      // pixel pin (219) duplicating mobile-header-offset.test.js's own
      // EXPECTED_1440_H1_TOP table -- that table is gone too (same reason:
      // a rendered position, not a token). h1 has no preceding visible
      // sibling here, so it sits exactly at its own parent's content edge
      // (the parent's live rect.top + its own padding-top/border-top);
      // comparing the two live, in the same run, proves "no layout shift"
      // without hard-coding what the position happens to equal.
      const m = await p.evaluate(() => {
        const h1 = document.querySelector('h1');
        const h1Top = h1.getBoundingClientRect().top;
        const h1MarginTop = parseFloat(getComputedStyle(h1).marginTop) || 0;
        const el = h1.parentElement;
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        const expected = r.top + (parseFloat(s.paddingTop) || 0) + (parseFloat(s.borderTopWidth) || 0);
        return { h1Top, h1MarginTop, expected };
      });
      assert.ok(Math.abs(m.h1MarginTop) < 0.5, `h1 margin-top should be 0, got ${m.h1MarginTop}`);
      assert.ok(Math.abs(m.h1Top - m.expected) < 0.5, `h1.top=${m.h1Top}, expected ${m.expected} (its own containing block's content edge, measured live in the same run)`);
    } finally {
      await ctx.close();
    }
  });
});

// ─── Round 4 (how-it-works layout and drawings, needs playwright) ───────
// The qualifies pair sits two across under the step text; the unlock cards share one height with
// their text at the top; no drawing is more than a third skeleton bars. Every measure compares two
// numbers taken in the same run.

describe('how-it-works round 4: the pair, the unlock cards and the drawings', { timeout: 120_000 }, () => {
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

  async function measure(width, fn) {
    const ctx = await browser.newContext({ viewport: { width, height: 900 } });
    const p = await ctx.newPage();
    try {
      await p.goto(`${base}/how-it-works.html`, { waitUntil: 'networkidle' });
      await p.evaluate(() => document.fonts.ready);
      return await p.evaluate(fn);
    } finally {
      await ctx.close();
    }
  }

  for (const width of [1280, 1100, 768]) {
    it(`at ${width}: the qualifies and does-not-qualify cards sit two across, equal, under the step text`, async (t) => {
      if (!ok) { t.skip('playwright not resolvable'); return; }
      const m = await measure(width, () => {
        const grid = document.querySelector('.qualify-grid');
        const boxes = [...grid.querySelectorAll('.qualify-box')].map((b) => b.getBoundingClientRect());
        const text = grid.closest('.hiw-row').querySelector('.hiw-text').getBoundingClientRect();
        const g = grid.getBoundingClientRect();
        return { boxes: boxes.map((r) => ({ l: r.left, r: r.right, t: r.top, h: r.height })), textBottom: text.bottom, textRight: text.right, gridLeft: g.left, gridRight: g.right, gridTop: g.top };
      });
      assert.equal(m.boxes.length, 2, 'positive control: both cards are there');
      assert.ok(Math.abs(m.boxes[0].t - m.boxes[1].t) < 1, 'one row');
      assert.ok(m.boxes[1].l > m.boxes[0].r, 'side by side');
      assert.ok(Math.abs(m.boxes[0].h - m.boxes[1].h) < 1, 'equal height');
      assert.ok(Math.abs((m.boxes[1].l - m.boxes[0].r) - 24) < 1, 'one 24 gap between them');
      assert.ok(m.gridTop >= m.textBottom - 1, 'under the step text, not beside it');
      assert.ok(Math.abs(m.boxes[0].l - m.gridLeft) < 1 && Math.abs(m.boxes[1].r - m.gridRight) < 1, 'the pair fills its row');
    });
  }

  for (const width of [1280, 768]) {
    it(`at ${width}: the three unlock cards share one height and their text starts at the top`, async (t) => {
      if (!ok) { t.skip('playwright not resolvable'); return; }
      const m = await measure(width, () => [...document.querySelectorAll('.hiw-cards3 > *')].map((c) => {
        const r = c.getBoundingClientRect();
        const first = c.firstElementChild.getBoundingClientRect();
        const cs = getComputedStyle(c);
        return { h: r.height, topGap: first.top - r.top, edge: parseFloat(cs.paddingTop) + parseFloat(cs.borderTopWidth) };
      }));
      assert.equal(m.length, 3, 'positive control: three cards');
      assert.ok(m.every((c) => Math.abs(c.h - m[0].h) < 1), `one height (${m.map((c) => c.h).join(', ')})`);
      assert.ok(m.every((c) => Math.abs(c.topGap - c.edge) < 1), 'the text starts at the card border and padding, never centred');
    });
  }

  for (const width of [1280, 375]) {
    it(`at ${width}: skeleton bars fill at most a third of any drawing, and the drawings carry real words`, async (t) => {
      if (!ok) { t.skip('playwright not resolvable'); return; }
      const m = await measure(width, () => [...document.querySelectorAll('.hiw-fig, .hero-ledger')].map((st) => {
        const sr = st.getBoundingClientRect();
        const groups = new Set([...st.querySelectorAll('.dw-sk')].map((e) => e.parentElement));
        const region = [...groups].reduce((a, g) => { const r = g.getBoundingClientRect(); return a + r.width * r.height; }, 0);
        return { share: region / (sr.width * sr.height), words: st.textContent.replace(/\s+/g, ' ').trim().length, bars: st.querySelectorAll('.dw-sk').length };
      }));
      assert.ok(m.length >= 6, 'positive control: every drawing was measured');
      assert.ok(m.some((d) => d.bars > 0), 'positive control: the detector sees a drawing that still has bars');
      for (const d of m) assert.ok(d.share <= 1 / 3, `a drawing is ${(d.share * 100).toFixed(0)}% bars`);
    });
  }

  it('the earn drawing names the six categories and one real catalog title, and the page uses each catalog title at most once', () => {
    const body = HTML.slice(HTML.indexOf('<body>')).replace(/<script[\s\S]*?<\/script>/g, '');
    const earn = body.slice(body.indexOf('hiw-chips'), body.indexOf('hiw-chips') + 900);
    for (const c of ['data-processing', 'web-interaction', 'code-execution', 'storage-state', 'payment-financial', 'monitoring']) {
      assert.ok(earn.includes(`>${c}<`), `the catalog panel carries the ${c} chip`);
    }
    for (const title of [
      "MCP tool inputSchema must use 'object' type at the top level or tools won't appear",
      'JSONL is better than JSON arrays for append-heavy logs on minimal VMs',
      'Pinecone upsert requires vectors array not a single vector object',
    ]) {
      assert.ok(body.split(title).length - 1 <= 1, `"${title.slice(0, 24)}..." appears at most once`);
    }
    assert.ok(body.includes('JSONL is better than JSON arrays'), 'positive control: a title is used');
  });
});

// ─── Round 5 (how-it-works hero drawing, the live figure as a stat line, step 3) ──
// The hero is the earning flow drawn: the five step titles as five nodes on one thread, the last leg
// gold, in a dark panel the headings below already describe (so it is aria-hidden). The live catalog
// figure is a stat line under the buttons, ink on dark, shown only once a number arrives. Step 3 holds
// its worked example beside its text, and the qualifies pair under both.

describe('how-it-works round 5: the hero drawing and the stat line (static)', () => {
  const BODY = HTML.slice(HTML.indexOf('<body>'));
  const STYLE = (HTML.match(/<style>([\s\S]*?)<\/style>/) || [, ''])[1];
  const hero = BODY.slice(BODY.indexOf('<section class="hiw-hero'), BODY.indexOf('</section>', BODY.indexOf('<section class="hiw-hero')));
  const upload = BODY.slice(BODY.indexOf('<section class="hiw-upload-section"'), BODY.indexOf('<section class="hiw-download-section'));
  const stepTitles = [...upload.matchAll(/<h3>(Step \d: [^<]+)<\/h3>/g)].map((m) => m[1]);
  const drawing = hero.slice(hero.indexOf('<div class="dw-panel dw-dark hiw-path"'));
  const nodeTexts = [...drawing.matchAll(/<div class="hiw-hn"><div class="dw-cap"><svg[\s\S]*?<\/svg>([^<]+)<\/div>/g)].map((m) => m[1]);

  it('the five nodes carry the exact strings of the five step headings, in order, and the drawing is aria-hidden', () => {
    assert.equal(stepTitles.length, 5, 'positive control: the earning flow has five step headings');
    assert.deepEqual(nodeTexts, stepTitles);
    assert.match(drawing, /^<div class="dw-panel dw-dark hiw-path" aria-hidden="true">/);
    assert.equal((drawing.match(/<svg class="dw-node" viewBox="0 0 12 12"><path d="M6 0\.5 L11\.5 6 L6 11\.5 L0\.5 6 Z"\/><\/svg>/g) || []).length, 5, 'one diamond marker a node');
    assert.doesNotMatch(drawing, /<h[1-6]\b/, 'the drawing adds no heading');
    // the headings are still the page's words: each step title is a heading once
    for (const t of stepTitles) assert.equal(upload.split(`<h3>${t}</h3>`).length - 1, 1, `${t} is a heading once`);
  });

  it('only the last leg of the thread and the last marker are gold; the first three legs are faint ivory', () => {
    assert.match(STYLE, /\.hiw-hn:nth-last-child\(2\)::after\s*\{\s*background:\s*var\(--aurum\);\s*\}/);
    assert.match(STYLE, /\.hiw-hn:last-child \.dw-node\s*\{\s*color:\s*var\(--aurum\);\s*\}/);
    assert.match(STYLE, /\.hiw-hn:not\(:last-child\)::after\s*\{[^}]*background:\s*rgba\(250, 250, 248, 0\.28\)/);
    const hiw = STYLE.slice(STYLE.indexOf('.hiw-path {'), STYLE.indexOf('/* The two jump targets'));
    assert.equal((hiw.match(/--aurum/g) || []).length, 2, 'positive control: the drawing names gold exactly twice (the last leg and the last marker)');
    // and its motion sits inside the no-preference guard
    const motion = STYLE.match(/@media \(prefers-reduced-motion: no-preference\) and \(min-width: 481px\) \{([\s\S]*?)\n    \}\n/)[1];
    for (const [rule] of [...STYLE.matchAll(/animation(?:-delay)?:[^;]+;/g)]) assert.ok(motion.includes(rule), `animation sits inside the guard: ${rule}`);
    assert.ok(/animation:/.test(motion), 'positive control: the thread does animate');
  });

  it('the live figure moves to a stat line under the buttons: same ids, same label, a plain line (no panel, no skeleton bars), no gold', () => {
    assert.equal((HTML.match(/id="hero-ledger"/g) || []).length, 1);
    assert.equal((HTML.match(/id="hero-ledger-num"/g) || []).length, 1);
    assert.match(hero, /<div class="hero-ledger" id="hero-ledger">\s*<span class="hero-ledger-num" id="hero-ledger-num"><\/span>\s*<span class="hero-ledger-label"><svg class="dw-node" viewBox="0 0 12 12" aria-hidden="true"><path d="M6 0\.5 L11\.5 6 L6 11\.5 L0\.5 6 Z"\/><\/svg>learnings in the catalog<\/span>\s*<\/div>/);
    const copy = hero.slice(hero.indexOf('<div class="hiw-hero-copy">'), hero.indexOf('<div class="dw-panel dw-dark hiw-path"'));
    assert.ok(copy.indexOf('class="hiw-hero-jumps"') < copy.indexOf('id="hero-ledger"'), 'the stat line follows the buttons inside the copy column');
    assert.ok(!/dw-panel|dw-term|dw-sk/.test(copy), 'the copy column holds no panel and no skeleton bars');
    assert.ok(!/btn-primary|aurum|accent-text/.test(copy), 'no gold in the copy column of the hero');
    const num = STYLE.match(/\.hiw-hero \.hero-ledger \.hero-ledger-num\s*\{([^}]*)\}/)[1];
    assert.match(num, /font-family:\s*var\(--serif\)/);
    assert.match(num, /font-weight:\s*300/);
    assert.match(num, /color:\s*var\(--fg-1\)/, 'the figure is ink');
    assert.doesNotMatch(num, /accent-text|aurum/);
    // the script that fills it is unchanged
    assert.match(HTML, /hn\.textContent = s\.learnings_count\.toLocaleString\(\);\s*hl\.classList\.add\('is-live'\);/);
  });

  it('step 3: its row holds the text, the worked example and the qualifies pair, the pair last and full width', () => {
    const row = upload.slice(upload.indexOf('<div class="hiw-row hiw-row-under">'));
    const order = ['<h3>Step 3: Your Agent Drafts Learnings</h3>', 'class="hiw-example-label"', 'class="qualify-grid"'].map((s) => row.indexOf(s));
    assert.ok(order.every((n) => n > -1) && order[0] < order[1] && order[1] < order[2], 'text, then the example, then the pair');
    assert.match(row, /<div class="hiw-pics hiw-pics-under">\s*<div class="qualify-grid">/);
    for (const s of ['<strong>Example: from raw interaction to extracted learning</strong>', 'Credentials and secrets are <strong>scrubbed on your machine</strong>, before anything is uploaded. They never leave your system.']) {
      assert.equal(HTML.split(s).length - 1, 1, `${s.slice(0, 40)} is on the page once`);
    }
  });
});

describe('how-it-works round 5: the hero and step 3, measured', { timeout: 120_000 }, () => {
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

  async function onPage(width, fn, { stats } = {}) {
    const ctx = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    try {
      if (stats) await page.route('**/knowledge/stats', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ learnings_count: 1234 }) }));
      await page.goto(`${base}/how-it-works.html`, { waitUntil: 'networkidle' });
      await page.evaluate(() => document.fonts.ready);
      return await fn(page);
    } finally {
      await ctx.close();
    }
  }

  for (const width of [1280, 768, 375]) {
    it(`at ${width}: the five nodes share one marker column and run down it in order, and the thread's last leg is gold where the first is not`, async (t) => {
      if (!ok) { t.skip('playwright not resolvable'); return; }
      const m = await onPage(width, (p) => p.evaluate(() => {
        const nodes = [...document.querySelectorAll('.hiw-path .hiw-hn')];
        const marks = nodes.map((n) => n.querySelector('.dw-node').getBoundingClientRect());
        const leg = (n) => getComputedStyle(n, '::after').backgroundColor;
        return {
          count: nodes.length,
          lefts: marks.map((r) => r.left),
          tops: marks.map((r) => r.top),
          firstLeg: leg(nodes[0]),
          lastLeg: leg(nodes[3]),
          lastMarker: getComputedStyle(nodes[4].querySelector('.dw-node')).color,
          panel: document.querySelector('.hiw-path').getBoundingClientRect().width,
          heroInner: document.querySelector('.hiw-hero .container').getBoundingClientRect().width,
          overflow: document.documentElement.scrollWidth - window.innerWidth,
        };
      }));
      assert.equal(m.count, 5, 'positive control: five nodes');
      assert.ok(m.lefts.every((l) => Math.abs(l - m.lefts[0]) < 0.5), 'one marker column');
      assert.ok(m.tops.every((y, i) => i === 0 || y > m.tops[i - 1]), 'in reading order, top to bottom');
      assert.equal(m.lastLeg, m.lastMarker, 'the last leg is the same gold as the last marker');
      assert.notEqual(m.firstLeg, m.lastLeg, 'and the first leg is not gold');
      assert.ok(m.panel <= m.heroInner + 0.5, 'the drawing stays inside the hero');
      assert.ok(m.overflow <= 0, 'no horizontal scroll');
    });
  }

  for (const width of [1280, 768, 375]) {
    it(`at ${width}: the stat line is under the buttons, takes its box before the number arrives, and shows ink on dark once it does`, async (t) => {
      if (!ok) { t.skip('playwright not resolvable'); return; }
      const before = await onPage(width, (p) => p.evaluate(() => {
        const l = document.getElementById('hero-ledger');
        const r = l.getBoundingClientRect();
        return { top: r.top, height: r.height, visibility: getComputedStyle(l).visibility, jumpsBottom: document.querySelector('.hiw-hero-jumps').getBoundingClientRect().bottom };
      }));
      const after = await onPage(width, async (p) => {
        await p.waitForSelector('#hero-ledger.is-live');
        return p.evaluate(() => {
          const l = document.getElementById('hero-ledger');
          const num = document.getElementById('hero-ledger-num');
          const label = l.querySelector('.hero-ledger-label');
          const r = l.getBoundingClientRect();
          const h1 = getComputedStyle(document.querySelector('.hiw-hero h1')).color;
          return {
            top: r.top, height: r.height, visibility: getComputedStyle(l).visibility, text: num.textContent,
            numColor: getComputedStyle(num).color, h1, labelColor: getComputedStyle(label).color,
            numFont: getComputedStyle(num).fontFamily, accent: getComputedStyle(document.querySelector('.hiw-hero')).getPropertyValue('--accent-text').trim(),
            numRight: num.getBoundingClientRect().right, labelLeft: label.getBoundingClientRect().left,
            numTop: num.getBoundingClientRect().top, labelTop: label.getBoundingClientRect().top, labelBottom: label.getBoundingClientRect().bottom, numBottom: num.getBoundingClientRect().bottom,
          };
        });
      }, { stats: true });
      assert.equal(before.visibility, 'hidden', 'positive control: hidden until the number arrives');
      assert.ok(before.top >= before.jumpsBottom, 'under the buttons');
      assert.equal(after.visibility, 'visible');
      assert.ok(Math.abs(after.top - before.top) < 0.5 && Math.abs(after.height - before.height) < 0.5, 'the number arriving moves nothing');
      assert.equal(after.text, '1,234');
      assert.equal(after.numColor, after.h1, 'the figure is the headline ink');
      assert.notEqual(after.numColor, after.accent, 'and not the gold');
      assert.ok(after.labelLeft >= after.numRight, 'the label sits beside the figure');
      assert.ok(after.labelTop < after.numBottom && after.labelBottom > after.numTop, 'on the same line');
      assert.match(after.numFont, /Newsreader|serif/i);
    });
  }

  it('at 1280: step 3 holds the example beside the step text, level with it at the top, and the qualifies pair under both', async (t) => {
    if (!ok) { t.skip('playwright not resolvable'); return; }
    const m = await onPage(1280, (p) => p.evaluate(() => {
      const row = document.querySelector('.hiw-row-under');
      const box = (el) => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right }; };
      return {
        text: box(row.querySelector('.hiw-text')), h3: box(row.querySelector('h3')), label: box(row.querySelector('.hiw-example-label')),
        cards: [...row.querySelectorAll('.ba-card')].map(box), grid: box(row.querySelector('.qualify-grid')), row: box(row),
      };
    }));
    assert.ok(m.label.left >= m.text.right, 'the example is in the right column, beside the text');
    assert.ok(Math.abs(m.label.top - m.h3.top) <= 1, `the example starts level with the step heading (${m.label.top} and ${m.h3.top})`);
    assert.equal(m.cards.length, 2, 'positive control: both cards');
    assert.ok(m.cards.every((c) => c.left >= m.text.right), 'both cards sit in the right column');
    assert.ok(m.cards[1].top >= m.cards[0].bottom, 'the two cards stack in their half');
    assert.ok(m.grid.top >= Math.max(m.text.bottom, m.cards[1].bottom) - 1, 'the qualifies pair is under the text and under the example');
    assert.ok(Math.abs(m.grid.left - m.row.left) < 1 && Math.abs(m.grid.right - m.row.right) < 1, 'and runs the full width of the row');
  });

  it('at 768: the example follows the step text, full width, as before', async (t) => {
    if (!ok) { t.skip('playwright not resolvable'); return; }
    const m = await onPage(768, (p) => p.evaluate(() => {
      const row = document.querySelector('.hiw-row-under');
      const text = row.querySelector('.hiw-text').getBoundingClientRect();
      const label = row.querySelector('.hiw-example-label').getBoundingClientRect();
      const cards = [...row.querySelectorAll('.ba-card')].map((c) => c.getBoundingClientRect());
      return { textBottom: text.bottom, textLeft: text.left, labelTop: label.top, labelLeft: label.left, cards: cards.map((c) => ({ top: c.top, left: c.left })) };
    }));
    assert.ok(m.labelTop >= m.textBottom, 'under the text');
    assert.ok(Math.abs(m.labelLeft - m.textLeft) < 1, 'on its left edge');
    assert.ok(Math.abs(m.cards[0].top - m.cards[1].top) < 1 && m.cards[1].left > m.cards[0].left, 'the pair of cards is two across');
  });
});
