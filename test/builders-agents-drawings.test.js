'use strict';

/**
 * test/builders-agents-drawings.test.js
 *
 * Round 4 of the design rebuild, /for-builders and /for-agents. Guards:
 *   - the drawing rule on every drawing of both pages: skeleton bars fill at most a third of a drawing,
 *     the rest is real (category chips, dashboard labels, tool names, paths, the ruled diagram labels,
 *     the three catalog titles), no drawing carries a digit, no drawing repeats a command, and each
 *     catalog title appears once among the page's drawings outside its review-queue window;
 *   - the kill-switch chip and its hang wrapper are gone from /for-builders;
 *   - the /for-builders hero is a hero grid with a drawn builder loop, over a dark figures band that
 *     keeps every live id and comment marker;
 *   - /for-agents stacks the two MCP code blocks in one column and top-aligns the catalog card;
 *   - a code panel that can scroll sideways is a keyboard stop named by its own label, and no panel
 *     cuts a line mid-word at 1280, 768 or 375;
 *   - at 1280 by 800 the figures on either page do not straddle the edge of the first screen.
 *
 * The static checks read the page source. The measured checks boot a tiny static server over public/
 * (no network, no real HOME) and drive it with Playwright; every one compares two live measurements
 * taken in the same run. They skip cleanly when Playwright is not installed.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const read = (f) => fs.readFileSync(path.join(PUBLIC_DIR, f), 'utf8');
const BUILDERS = read('for-builders.html');
const AGENTS = read('for-agents.html');
const main = (html) => (html.match(/<main id="main">([\s\S]*?)<\/main>/) || [, ''])[1];
const style = (html) => (html.match(/<style>([\s\S]*?)<\/style>/) || [, ''])[1];

const TITLES = [
  "MCP tool inputSchema must use 'object' type at the top level or tools won't appear",
  'JSONL is better than JSON arrays for append-heavy logs on minimal VMs',
  'Pinecone upsert requires vectors array not a single vector object',
];
const CATEGORIES = ['data-processing', 'web-interaction', 'code-execution', 'storage-state', 'payment-financial', 'monitoring'];
const DASHBOARD_LABELS = ['Pending Review Queue', 'Approve', 'Reject', 'Earnings', 'Balance', 'API Keys'];
const RULED_LABELS = ['Your agent solves a problem', 'You publish the learning', 'Another agent asks Auxilo and unlocks it', 'Your earnings accrue'];
// the three captions of /for-agents' exchange are on that page already, pinned by its own suites
const AGENTS_CAPTIONS = ['Another agent already solved it', 'Your agent asks Auxilo', 'Your agent sees a preview free and pays to unlock it'];

/** The markup of the element whose opening tag starts at `at`, by counting div opens and closes. */
function balanced(html, at) {
  const re = /<(\/?)div\b[^>]*>/g;
  re.lastIndex = at;
  let depth = 0;
  let m;
  while ((m = re.exec(html))) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return html.slice(at, re.lastIndex);
  }
  throw new Error('unbalanced div at ' + at);
}

function drawingsOf(html, openers) {
  const out = [];
  for (const opener of openers) {
    let from = 0;
    for (;;) {
      const at = html.indexOf(opener, from);
      if (at === -1) break;
      out.push(balanced(html, at));
      from = at + opener.length;
    }
  }
  return out;
}

/** Text nodes of a drawing, trimmed and non-empty. */
function marks(drawing) {
  return [...drawing.replace(/<svg[\s\S]*?<\/svg>/g, '').matchAll(/>([^<]+)</g)].map((m) => m[1].trim()).filter(Boolean);
}
const barsIn = (drawing) => (drawing.match(/class="dw-sk\b/g) || []).length;

const BUILDERS_DRAWINGS = {
  hero: drawingsOf(main(BUILDERS), ['<div class="bx" aria-hidden="true">']),
  steps: drawingsOf(main(BUILDERS), ['<div class="step-art" aria-hidden="true">']),
  stages: drawingsOf(main(BUILDERS), ['<div class="dw-stage pair-art" aria-hidden="true">']),
};
const AGENTS_DRAWINGS = {
  hero: drawingsOf(main(AGENTS), ['<div class="hx" role="img"']),
  steps: drawingsOf(main(AGENTS), ['<div class="step-art" aria-hidden="true">']),
};

describe('the drawing rule on /for-builders and /for-agents (static)', () => {
  it('positive control: every drawing of both pages was found', () => {
    assert.equal(BUILDERS_DRAWINGS.hero.length, 1, 'the builder loop');
    assert.equal(BUILDERS_DRAWINGS.steps.length, 3, 'three step drawings');
    assert.equal(BUILDERS_DRAWINGS.stages.length, 2, 'the earnings stage and the review window stage');
    assert.equal(AGENTS_DRAWINGS.hero.length, 1, 'the exchange');
    assert.equal(AGENTS_DRAWINGS.steps.length, 5, 'five step drawings');
  });

  const all = [
    ...BUILDERS_DRAWINGS.hero.map((d, i) => ['/for-builders hero', d]),
    ...BUILDERS_DRAWINGS.steps.map((d, i) => [`/for-builders step ${i + 1}`, d]),
    ...BUILDERS_DRAWINGS.stages.map((d, i) => [`/for-builders stage ${i + 1}`, d]),
    ...AGENTS_DRAWINGS.hero.map((d) => ['/for-agents hero', d]),
    ...AGENTS_DRAWINGS.steps.map((d, i) => [`/for-agents step ${i + 1}`, d]),
  ];

  it('skeleton bars fill at most a third of every drawing, and the counter sees both kinds of mark', () => {
    let drawingsWithBars = 0;
    for (const [name, drawing] of all) {
      const real = marks(drawing).length;
      const bars = barsIn(drawing);
      assert.ok(real > 0, `${name}: the counter finds real text`);
      assert.ok(bars * 2 <= real, `${name}: ${bars} skeleton bars against ${real} real marks is over a third`);
      if (bars > 0) drawingsWithBars++;
    }
    assert.ok(drawingsWithBars >= 4, 'positive control: the counter does find skeleton bars where there are some');
    // and it would fail a drawing made of bars
    assert.ok(barsIn('<div><span class="dw-sk"></span><span class="dw-sk"></span><span class="dw-sk"></span><i>x</i></div>') * 2 > marks('<div><span class="dw-sk"></span><i>x</i></div>').length, 'positive control: three bars against one mark is over the line');
  });

  it('every mark in every drawing is a ruled one: a title, a category, a dashboard label, a diagram label, a tool name, a path or verb already on the page', () => {
    const allowed = new Set([...TITLES, ...CATEGORIES, ...DASHBOARD_LABELS, ...RULED_LABELS]);
    for (const [name, drawing] of all) {
      const page = name.startsWith('/for-builders') ? main(BUILDERS) : main(AGENTS);
      const outside = page.replace(drawing, '');
      for (const text of marks(drawing)) {
        const ok = allowed.has(text)
          || /^auxilo_[a-z_]+$/.test(text)
          || (name.startsWith('/for-agents') && AGENTS_CAPTIONS.includes(text))
          || (name.startsWith('/for-agents') && (text === 'POST' || text === 'GET' || (/^\/[\w/:]+$/.test(text) && outside.includes(text))));
        assert.ok(ok, `${name}: "${text}" is not ruled content`);
      }
      assert.ok(!/\d/.test(marks(drawing).join(' ')), `${name}: no number, price, count or date`);
    }
  });

  it('no drawing repeats a command, and the kill-switch chip is gone from both pages', () => {
    for (const [name, drawing] of all) {
      assert.ok(!/npx auxilo/.test(drawing), `${name}: shows no command (the copy beside it already does)`);
    }
    for (const [file, html] of [['for-builders', BUILDERS], ['for-agents', AGENTS]]) {
      assert.doesNotMatch(html, /dw-kill|dw-hang/, `${file}: no kill-switch chip and no hang wrapper`);
    }
    // positive control: the page still names the command in its copy
    assert.match(main(BUILDERS), /<code>npx auxilo setup<\/code>/);
  });

  it('a catalog title appears once among the drawings outside the review-queue window (the hero counts), on each page', () => {
    const builders = [...BUILDERS_DRAWINGS.hero, ...BUILDERS_DRAWINGS.steps, BUILDERS_DRAWINGS.stages[0]].join('\n');
    const agents = [...AGENTS_DRAWINGS.hero, ...AGENTS_DRAWINGS.steps].join('\n');
    for (const [page, text] of [['/for-builders', builders], ['/for-agents', agents]]) {
      for (const title of TITLES) {
        const n = text.split(title).length - 1;
        assert.ok(n <= 1, `${page}: "${title}" appears ${n} times`);
      }
    }
    // positive control: the review-queue window on /for-builders does list all three, and the earnings stage holds the one it does
    const window = BUILDERS_DRAWINGS.stages[1];
    for (const title of TITLES) assert.ok(window.includes(title), `the review window lists "${title}"`);
    assert.ok(BUILDERS_DRAWINGS.stages[0].includes(TITLES[1]));
  });

  it('a dimmed card never stands for a greyed-out control: no drawing is faded by opacity, and /for-agents holds no outline-less ghost card', () => {
    for (const [name, drawing] of all) assert.doesNotMatch(drawing, /opacity/, `${name}: no inline fade`);
    assert.doesNotMatch(style(BUILDERS) + style(AGENTS), /\.(bx|hx|eu|fs|st)[\w-]*[^{}]*\{[^}]*opacity:\s*0?\.[0-9]/, 'no page rule dims a drawing card');
  });

  it('only the real dashboard labels are used as labels, and each appears in its own drawing as text', () => {
    const hero = BUILDERS_DRAWINGS.hero[0];
    for (const label of ['Pending Review Queue', 'Approve', 'Reject', 'Earnings']) {
      assert.ok(marks(hero).includes(label), `the hero carries ${label}`);
    }
    assert.ok(marks(hero).includes('Your earnings accrue'), 'the earnings panel carries its ruled caption');
    assert.ok(marks(hero).includes('code-execution') && marks(hero).includes(TITLES[0]), 'its one row is the chip and the MCP title');
    assert.match(hero, /<span class="dw-tick"><\/span><span class="bl-label">Earnings<\/span><span class="dw-amt"><\/span>/, 'a gold tick, the label and a gold bar');
  });
});

describe('the /for-builders hero and figures band', () => {
  const MAINB = main(BUILDERS);
  const hero = MAINB.match(/<section id="builders-hero"[\s\S]*?<\/section>/)[0];

  it('the hero is the shared hero grid: copy first, then the builder loop, which is a drawing only (aria-hidden)', () => {
    assert.match(hero, /<div class="container hero-grid">/);
    assert.ok(hero.indexOf('<h1 id="builders-hero-heading">') < hero.indexOf('<div class="bx" aria-hidden="true">'), 'the copy comes before the drawing in the source');
    assert.ok(hero.indexOf('<div class="hero-ctas">') < hero.indexOf('<div class="bx"'), 'and the buttons come before it, so on a phone the drawing follows them');
    assert.match(hero, /<a href="\/connect" class="btn-primary">Connect Your Agent<\/a>\s*<a href="\/how-it-works" class="btn-secondary">See How It Works<\/a>/);
    // the light review window comes first and the dark earnings panel after it, so the dark one overlaps it from below
    assert.ok(hero.indexOf('dw-panel dw-light bx-queue') < hero.indexOf('dw-panel dw-dark bx-earn'));
  });

  it('the figures band is the dark section after the hero, with the live cell between its own markers and the same layout as /for-agents', () => {
    const band = MAINB.match(/<section id="builders-stats" class="on-dark">[\s\S]*?<\/section>/)[0];
    assert.match(band, /<!--LC-LEARNINGS-HERO-CELL-->\s*<div class="cat-stat">\s*<span class="stats-strip-num pull-stat-num" id="lc-learnings-hero"><\/span>\s*<span class="stats-strip-label pull-stat-caption">learnings in the catalog<\/span>\s*<\/div>\s*<!--\/LC-LEARNINGS-HERO-CELL-->/);
    assert.equal((BUILDERS.match(/id="lc-learnings-hero"/g) || []).length, 1);
    assert.equal((BUILDERS.match(/<!--LC-LEARNINGS-HERO-CELL-->/g) || []).length, 1);
    assert.equal((BUILDERS.match(/<!--\/LC-LEARNINGS-HERO-CELL-->/g) || []).length, 1);
    // the same band rules as /for-agents' band, apart from the id
    const rule = (css, id) => (css.match(new RegExp(`#${id} \\.stats-strip-num\\s*\\{([^}]*)\\}`)) || [, ''])[1].replace(/\s+/g, ' ').trim();
    assert.ok(rule(style(BUILDERS), 'builders-stats').length > 40, 'positive control: the numeral rule is there');
    assert.equal(rule(style(BUILDERS), 'builders-stats'), rule(style(AGENTS), 'catalog-stats'), 'the figures are set exactly as /for-agents sets its own');
    assert.match(style(BUILDERS), /#builders-stats\s*\{\s*padding:\s*var\(--band-pad\);\s*border-top:\s*1px solid var\(--line\);\s*\}/);
    assert.match(style(AGENTS), /#catalog-stats\s*\{\s*padding:\s*var\(--band-pad\);\s*border-top:\s*1px solid var\(--line\);\s*\}/);
  });
});

describe('/for-agents layout notes and scrolling code panels', () => {
  it('the two MCP code blocks stack in one column and the catalog card starts level with its heading', () => {
    const css = style(AGENTS);
    assert.match(css, /\.mcp-code-pair\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\);/);
    assert.doesNotMatch(css, /\.mcp-code-pair\s*\{[^}]*align-items:\s*center/);
    assert.match(css, /#agent-catalog \.pair\s*\{\s*align-items:\s*start;\s*\}/);
    // no breakpoint puts the pair back side by side
    assert.doesNotMatch(css, /@media[^{]*\{[^@]*\.mcp-code-pair[^}]*grid-template-columns:\s*repeat/);
  });

  it('the page style blocks hold no kill-switch, no 520px parked-left hero drawing and no skeleton-only pair rows', () => {
    assert.doesNotMatch(style(AGENTS), /\.hx\s*\{[^}]*max-width:\s*520px/);
    assert.doesNotMatch(style(AGENTS), /fs-pair|fs-end/);
    assert.doesNotMatch(BUILDERS + AGENTS, /st-cmd/);
  });

  it('every code panel that can scroll sideways is a keyboard stop, named by its own panel label; the one-line commands are not', () => {
    for (const [file, html] of [['for-builders', main(BUILDERS)], ['for-agents', main(AGENTS)]]) {
      const pres = [...html.matchAll(/<pre id="([a-z0-9-]+)"([^>]*)>/g)];
      assert.ok(pres.length >= 4, `${file}: positive control: the code panels were found`);
      const scrollers = pres.filter((m) => /tabindex="0"/.test(m[2]));
      assert.ok(scrollers.length >= 3, `${file}: the long panels take the keyboard`);
      for (const [, id, attrs] of scrollers) {
        const named = (attrs.match(/aria-labelledby="([^"]+)"/) || [])[1];
        assert.ok(named, `${file} ${id}: named by an existing element`);
        assert.match(attrs, /role="region"/, `${file} ${id}: a region, so its name is announced`);
        assert.match(html, new RegExp(`<span class="code-block-lang" id="${named}">[^<]+</span>`), `${file} ${id}: the name is the panel's own label text`);
      }
      for (const [, id, attrs] of pres.filter((m) => !/tabindex="0"/.test(m[2]))) {
        assert.match(html, new RegExp(`<pre id="${id}">npx auxilo setup</pre>`), `${file} ${id}: only a one-line command is left out`);
      }
    }
  });
});

// ── measured checks ──────────────────────────────────────────────────────────

function isPlaywrightAvailable() {
  try { require.resolve('playwright'); return true; } catch (e) { return false; }
}

function startStaticServer(root) {
  const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.woff2': 'font/woff2' };
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
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

describe('measured: code panels, the MCP stack, the catalog card and the first screen', { timeout: 180_000 }, () => {
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

  async function onPage(file, width, height, fn) {
    const ctx = await browser.newContext({ viewport: { width, height }, reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    try {
      await page.goto(`${base}/${file}`, { waitUntil: 'networkidle' });
      await page.evaluate(() => document.fonts.ready);
      return await fn(page);
    } finally {
      await ctx.close();
    }
  }

  for (const [width, height] of [[1280, 800], [768, 1024], [375, 812]]) {
    it(`/for-builders at ${width}: no code panel cuts a line, and each scrolling panel keeps overflow-x auto`, async (t) => {
      if (!ok) { t.skip('playwright not resolvable'); return; }
      const m = await onPage('for-builders.html', width, height, (p) => p.evaluate(() => [...document.querySelectorAll('.code-block pre')].map((pre) => ({
        id: pre.id,
        overflowX: getComputedStyle(pre).overflowX,
        scrollW: pre.scrollWidth,
        clientW: pre.clientWidth,
        tabindex: pre.getAttribute('tabindex'),
      }))));
      assert.ok(m.length >= 4, 'positive control: the code panels were measured');
      for (const pre of m) {
        assert.ok(['auto', 'scroll'].includes(pre.overflowX), `${pre.id}: scrolls inside its box (${pre.overflowX})`);
        // No pixel pin on how text is drawn (Linux draws the mono a few px wider than macOS): a line wider
        // than its box is never cut because the box scrolls, and a box that can scroll is a keyboard stop.
        if (pre.scrollW > pre.clientW) assert.equal(pre.tabindex, '0', `${pre.id} at ${width}: a panel whose longest line (${pre.scrollW}) exceeds its box (${pre.clientW}) is keyboard reachable`);
      }
      assert.ok(m.some((p) => p.id === 'learn-code'), 'positive control: the POST /learn panel is one of them');
    });
  }

  it('/for-agents at 1280: the two MCP code blocks share one left edge and one width, and the catalog card starts level with its heading', async (t) => {
    if (!ok) { t.skip('playwright not resolvable'); return; }
    const m = await onPage('for-agents.html', 1280, 800, (p) => p.evaluate(() => {
      const box = (el) => { const r = el.getBoundingClientRect(); return { top: r.top, left: r.left, right: r.right, width: r.width, bottom: r.bottom }; };
      return {
        a: box(document.getElementById('npm-snippet')),
        b: box(document.getElementById('mcp-config-snippet')),
        heading: box(document.getElementById('catalog-heading')),
        right: box(document.querySelector('#agent-catalog .agents-right')),
        column: box(document.querySelector('#mcp-server .container')),
      };
    }));
    assert.ok(Math.abs(m.a.left - m.b.left) <= 0.5 && Math.abs(m.a.width - m.b.width) <= 0.5, 'one column: same left edge and width');
    assert.ok(m.b.top >= m.a.bottom, 'the second block sits under the first');
    assert.ok(Math.abs(m.a.width - m.column.width) <= 1, 'and each runs the full content width');
    assert.ok(Math.abs(m.right.top - m.heading.top) <= 1, `the catalog column starts (${m.right.top}) where the heading does (${m.heading.top})`);
  });

  for (const [file, figures] of [['for-agents.html', '#catalog-stats .cat-stats'], ['for-builders.html', '#builders-stats .cat-stats']]) {
    it(`${file} at 1280x800: the figures do not straddle the edge of the first screen`, async (t) => {
      if (!ok) { t.skip('playwright not resolvable'); return; }
      const m = await onPage(file, 1280, 800, (p) => p.evaluate((sel) => {
        const r = document.querySelector(sel).getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, vh: window.innerHeight };
      }, figures));
      assert.equal(m.vh, 800, 'positive control: the viewport is the one asked for');
      const straddles = m.top < m.vh && m.bottom > m.vh;
      assert.ok(!straddles, `the figures (${m.top} to ${m.bottom}) sit wholly on one side of the fold (${m.vh})`);
    });
  }

  it('/for-agents at 1280x800: the band starts below the first screen, as the hero is the first screen', async (t) => {
    if (!ok) { t.skip('playwright not resolvable'); return; }
    const m = await onPage('for-agents.html', 1280, 800, (p) => p.evaluate(() => ({
      band: document.getElementById('catalog-stats').getBoundingClientRect().top,
      hero: document.getElementById('page-hero').getBoundingClientRect().bottom,
      h1: document.getElementById('page-hero-heading').getBoundingClientRect().top,
      drawing: document.querySelector('#page-hero .hx').getBoundingClientRect().top,
      vh: window.innerHeight,
    })));
    assert.ok(Math.abs(m.band - m.hero) <= 0.5, 'the band starts where the hero ends');
    assert.ok(m.band >= m.vh, `the band (${m.band}) begins at or below the fold (${m.vh})`);
    assert.ok(Math.abs(m.h1 - m.drawing) <= 1, `the headline (${m.h1}) and the exchange (${m.drawing}) start on one line, so the first thing under the navigation is on the section rhythm`);
  });
});

// ── round 5: the unlock chips, the figures on the card columns, the command block, the exchange spacing ──

describe('round 5 (static): three unlocks by three different agents, and the figures in one three-column grid', () => {
  it('the three auxilo_unlock rows in the earnings stage each carry a different category chip, and the drawing rule still holds', () => {
    const stage = BUILDERS_DRAWINGS.stages[0];
    const rows = [...stage.matchAll(/<div class="dw-row"><span class="dw-tool">auxilo_unlock<\/span><span class="dw-sk"><\/span><span class="dw-chip">([^<]+)<\/span><\/div>/g)].map((m) => m[1]);
    assert.equal(rows.length, 3, 'positive control: three unlock rows, each with a chip');
    assert.equal(new Set(rows).size, 3, `three different chips (${rows.join(', ')})`);
    for (const c of rows) assert.ok(CATEGORIES.includes(c), `${c} is a real category`);
    assert.equal((stage.match(/<span class="dw-tool">auxilo_unlock<\/span>/g) || []).length, 3, 'and every unlock row is one of them');
    // and the negative control: the old row, one tool name and a bar, is not left anywhere
    assert.doesNotMatch(stage, /<span class="dw-tool">auxilo_unlock<\/span><span class="dw-sk"><\/span><\/div>/);
  });

  it('/for-builders sets its figures as a three-column grid with the steps\' own gap, not a spread flex row', () => {
    const css = style(BUILDERS);
    const rule = css.match(/\.cat-stats\s*\{([^}]*)\}/)[1];
    assert.match(rule, /display:\s*grid/);
    assert.match(rule, /grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/);
    assert.match(rule, /gap:\s*var\(--space-card\) var\(--space-copy\)/);
    assert.doesNotMatch(rule, /justify-content|flex/);
    // /for-agents' own figures row keeps its flex layout: the change is /for-builders only
    assert.match(style(AGENTS).match(/\.cat-stats\s*\{([^}]*)\}/)[1], /display:\s*flex/);
  });

  it('the command block under "Built for builders" is never stretched to the claim beside it', () => {
    const css = style(BUILDERS);
    assert.match(css, /#connect \.builders-grid\s*\{\s*align-items:\s*start;\s*\}/);
    assert.doesNotMatch(css, /#connect \.builders-grid\s*\{[^}]*stretch/);
    assert.doesNotMatch(css, /\.builders-right \.code-block\s*\{[^}]*flex:\s*1 1 auto/, 'the block no longer grows to fill its column');
  });
});

describe('round 5 (measured): the figures on the step columns, the command block, the exchange', { timeout: 180_000 }, () => {
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

  async function onPage(file, width, fn) {
    const ctx = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    try {
      await page.goto(`${base}/${file}`, { waitUntil: 'networkidle' });
      await page.evaluate(() => document.fonts.ready);
      return await fn(page);
    } finally {
      await ctx.close();
    }
  }

  for (const width of [1280, 1100]) {
    it(`/for-builders at ${width}: the three figures start on the three column lines of the step cards, with the same gap`, async (t) => {
      if (!ok) { t.skip('playwright not resolvable'); return; }
      const m = await onPage('for-builders.html', width, (p) => p.evaluate(() => {
        const L = (sel) => [...document.querySelectorAll(sel)].map((e) => { const r = e.getBoundingClientRect(); return { left: r.left, right: r.right }; });
        return { figures: L('#builders-stats .cat-stat'), cards: L('#how-it-earns .steps .step') };
      }));
      assert.equal(m.figures.length, 3, 'positive control: three figures');
      assert.equal(m.cards.length, 3, 'positive control: three step cards');
      m.figures.forEach((f, i) => assert.ok(Math.abs(f.left - m.cards[i].left) < 0.5, `figure ${i + 1} starts on the left line of card ${i + 1} (${f.left} and ${m.cards[i].left})`));
      assert.ok(Math.abs((m.figures[1].left - m.figures[0].right) - (m.cards[1].left - m.cards[0].right)) < 0.5, 'and the gap between figure columns is the gap between the cards');
    });
  }

  for (const width of [768, 375]) {
    it(`/for-builders at ${width}: the figures stay one grid with no horizontal scroll`, async (t) => {
      if (!ok) { t.skip('playwright not resolvable'); return; }
      const m = await onPage('for-builders.html', width, (p) => p.evaluate(() => ({
        cols: getComputedStyle(document.querySelector('#builders-stats .cat-stats')).gridTemplateColumns.split(' ').length,
        overflow: document.documentElement.scrollWidth - window.innerWidth,
      })));
      assert.equal(m.cols, width === 768 ? 3 : 1, 'three columns on a tablet, one on a phone');
      assert.ok(m.overflow <= 0, 'no horizontal scroll');
    });
  }

  it('/for-builders at 1280: the "Built for builders" command block ends under its last line, and the claim beside it is the taller column', async (t) => {
    if (!ok) { t.skip('playwright not resolvable'); return; }
    const m = await onPage('for-builders.html', 1280, (p) => p.evaluate(() => {
      const block = document.getElementById('openclaw-snippet');
      const pre = document.getElementById('openclaw-code');
      const range = document.createRange();
      range.selectNodeContents(pre);
      const lines = [...range.getClientRects()];
      const last = lines.reduce((a, r) => (r.bottom > a.bottom ? r : a), lines[0]);
      const cs = getComputedStyle(pre);
      // the glyph box of the last line, grown by the half-leading the line height adds under it: the foot of the line box
      const lastLine = last.bottom + (parseFloat(cs.lineHeight) - last.height) / 2;
      return {
        blockBottom: block.getBoundingClientRect().bottom,
        preBottom: pre.getBoundingClientRect().bottom,
        lastLine,
        padBottom: parseFloat(cs.paddingBottom),
        borderBottom: parseFloat(cs.borderBottomWidth),
        align: getComputedStyle(document.querySelector('#connect .builders-grid')).alignItems,
        leftHeight: document.querySelector('#connect .builders-left').getBoundingClientRect().height,
        blockHeight: block.getBoundingClientRect().height,
      };
    }));
    assert.equal(m.align, 'start');
    assert.ok(m.leftHeight > m.blockHeight, `positive control: the claim column (${m.leftHeight}) is taller than the block (${m.blockHeight}), so a stretch would have shown`);
    assert.ok(m.preBottom - m.lastLine <= m.padBottom + m.borderBottom + 1, `nothing empty under the last line: ${m.preBottom - m.lastLine} against a padding of ${m.padBottom}`);
    assert.ok(m.preBottom - m.lastLine >= m.padBottom - 1, 'positive control: the measure sees the padding, so it would see more');
    assert.ok(Math.abs(m.blockBottom - m.preBottom) <= 1, 'the block ends where its code ends');
  });

  for (const width of [1280, 768]) {
    it(`/for-agents at ${width}: each hero panel overlaps the one above by 16, with 16 clear between its edge and the last row above`, async (t) => {
      if (!ok) { t.skip('playwright not resolvable'); return; }
      const m = await onPage('for-agents.html', width, (p) => p.evaluate(() => {
        const panels = ['.hx-1', '.hx-2', '.hx-3'].map((s) => document.querySelector(s));
        const lastMark = (panel) => Math.max(...[...panel.querySelectorAll('.dw-chip, .dw-sk, .dw-tool, .dw-title')].map((e) => e.getBoundingClientRect().bottom));
        const r = panels.map((e) => e.getBoundingClientRect());
        return {
          overlaps: [r[0].bottom - r[1].top, r[1].bottom - r[2].top],
          margins: [parseFloat(getComputedStyle(panels[1]).marginTop), parseFloat(getComputedStyle(panels[2]).marginTop)],
          clears: [r[1].top - lastMark(panels[0]), r[2].top - lastMark(panels[1])],
        };
      }));
      m.overlaps.forEach((o, i) => {
        assert.ok(Math.abs(o - 16) < 0.5, `panel ${i + 2} overlaps panel ${i + 1} by ${o}, a ruled 16`);
        assert.ok(Math.abs(o + m.margins[i]) < 0.5, `and that is its margin, not an accident of line height (${m.margins[i]})`);
        assert.ok(m.clears[i] >= 16, `panel ${i + 2}'s edge is ${m.clears[i]} clear of the last row above it`);
      });
    });
  }

  it('/for-agents at 375: the three panels stack with a 16 gap and no overlap', async (t) => {
    if (!ok) { t.skip('playwright not resolvable'); return; }
    const m = await onPage('for-agents.html', 375, (p) => p.evaluate(() => {
      const r = ['.hx-1', '.hx-2', '.hx-3'].map((s) => document.querySelector(s).getBoundingClientRect());
      const pads = ['.hx-1', '.hx-2', '.hx-3'].map((s) => { const cs = getComputedStyle(document.querySelector(s)); return [parseFloat(cs.paddingTop), parseFloat(cs.paddingBottom)]; });
      return { gaps: [r[1].top - r[0].bottom, r[2].top - r[1].bottom], pads, overflow: document.documentElement.scrollWidth - window.innerWidth };
    }));
    assert.ok(m.gaps.every((g) => Math.abs(g - 16) < 0.5), `gaps ${m.gaps.join(', ')}`);
    assert.ok(m.pads.every(([top, bottom]) => top === bottom), 'top equals bottom on every panel when nothing overlaps it');
    assert.ok(m.overflow <= 0, 'no horizontal scroll');
  });
});
