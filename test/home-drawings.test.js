'use strict';

/**
 * test/home-drawings.test.js: the homepage hero thread, the hero notes, the recall drawing,
 * the shared device, the scroll cue on code blocks and the footer's meta line.
 *
 * What it pins (all read from the staged real server, compared inside one run, no pixel
 * literals that depend on how text is drawn):
 *   - the hero thread: one svg, three legs in reading order, each leg meets the next panel's
 *     edge level with that panel's marker, the first two legs faint ivory, the last gold, no
 *     arrowheads; stacked (480 and down) it is a vertical hairline through the node column
 *   - its motion: only inside no-preference and 481 and up, finished inside 2.4 seconds, a
 *     leg draws as its panel starts to rise and never before the panel it leaves exists
 *   - the device is one shared background image on the first dark section of every hero with no drawing, 12%
 *     ivory, no gold, at 1025 and up only; its apex hangs 48px outside the hero container's right edge, level
 *     with the container's top, so its crossbar runs in the margin, clear of every panel and button by 48 or
 *     more, and it never sits behind hero text; below 1025 there is none; a hero that holds a drawing (home,
 *     for-builders, for-agents, pricing, how-it-works) carries none, and neither does the dashboard
 *   - the two hero notes take the body colour and 15px from 481 up, 14px below
 *   - the hero drawing: panel 1 is a mono session ending in a category chip and a lit bar, panel 4 is an ordinary
 *     dark panel (gold only in its marker, its ledger row and the thread's last leg) with an Earnings row label
 *   - the recall drawing: the long way is at most four bars with category chips between them and ends in a 1px
 *     outline card, the short way returns the full Pinecone card; the explainer's session is at most three bars
 *     with two category chips and the auxilo_contribute row; step card 3 shows one Earnings row and one Balance row
 *   - no catalog title stands twice outside the review queue, and no drawing is more than a third skeleton bars,
 *     measured as the sum of the bar boxes over the drawing's box
 *   - a code block at 480 and down keeps its header label and its code both 16 from the frame's outer edge
 *   - code blocks that scroll sideways keep a thin scrollbar on the dark ground
 *   - the footer meta line is 14px, left under the logo, and its links never break inside
 *
 * Runner: node --test test/home-drawings.test.js
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

const REPO = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

function isPlaywrightAvailable() {
  try {
    require.resolve('playwright');
    return true;
  } catch (e) {
    return false;
  }
}

const IVORY_THREAD = 'rgba(250, 250, 248, 0.28)';
const AURUM_RGB = 'rgb(201, 168, 76)';
const TITLE = 'JSONL is better than JSON arrays for append-heavy logs on minimal VMs';

// The text between a rule's opening brace and its matching close, for the first rule whose
// selector list contains `needle`. Reads the source, so it holds on any runner.
function ruleBody(css, needle) {
  let from = 0;
  for (;;) {
    const at = css.indexOf(needle, from);
    if (at < 0) return null;
    const open = css.indexOf('{', at);
    const before = css.slice(css.lastIndexOf('}', at) + 1, open);
    if (before.includes(needle)) return css.slice(open + 1, css.indexOf('}', open));
    from = at + needle.length;
  }
}

// The text inside a media block (brace matched), found by its exact prelude.
function mediaBlock(source, prelude) {
  const at = source.indexOf(prelude);
  if (at < 0) return null;
  const open = source.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}') { depth--; if (depth === 0) return source.slice(open + 1, i); }
  }
  return null;
}

describe('home drawings: the source', () => {
  const html = read('public/index.html');
  const css = read('public/styles.css');
  const pageStyle = html.match(/<style>([\s\S]*?)<\/style>/)[1];

  it('the hero thread is one svg with three legs in reading order, aria-hidden, drawn before the panels', () => {
    const hero = html.match(/<section id="hero"[\s\S]*?<\/section>/)[0];
    const svg = hero.match(/<svg class="hx-thread"[\s\S]*?<\/svg>/);
    assert.ok(svg, 'the thread svg is in the hero');
    assert.match(svg[0], /aria-hidden="true"/);
    const legs = [...svg[0].matchAll(/<path class="hx-leg-(\d)"/g)].map((m) => m[1]);
    assert.deepEqual(legs, ['1', '2', '3'], 'three legs, in reading order');
    assert.ok(!/marker-(start|mid|end)/.test(svg[0]) && !/<marker/.test(svg[0]), 'no arrowheads');
    assert.ok(hero.indexOf('<svg class="hx-thread"') < hero.indexOf('hx-1"'), 'the thread comes before the first panel, so the panels paint over it');
  });

  it('only the last leg is gold in the page block; the legs share one faint ivory rule', () => {
    const base = ruleBody(pageStyle, '.hx-thread path');
    assert.ok(base, 'the shared leg rule is found');
    assert.match(base, /stroke:\s*rgba\(250, 250, 248, 0\.28\)/);
    assert.match(base, /stroke-width:\s*1\.25/);
    assert.match(base, /stroke-linecap:\s*round/);
    assert.ok(!/aurum/.test(base), 'no gold in the shared leg rule');
    const gold = ruleBody(pageStyle, '.hx-thread .hx-leg-3');
    assert.ok(gold && /stroke:\s*var\(--aurum\)/.test(gold), 'the last leg is gold');
    assert.ok(!/\.hx-leg-[12][^{]*\{[^}]*aurum/.test(pageStyle), 'neither of the first two legs is gold');
  });

  it('every animation in the page block sits inside the no-preference, 481-and-up media block', () => {
    const block = mediaBlock(pageStyle, '@media (prefers-reduced-motion: no-preference) and (min-width: 481px)');
    assert.ok(block, 'the motion block is found, with its exact prelude');
    assert.ok(/animation/.test(block), 'positive control: the block carries the animation');
    const outside = pageStyle.replace(block, '');
    assert.ok(!/animation\s*:|animation-delay|stroke-dasharray|stroke-dashoffset/.test(outside), 'no animation, dash or delay outside it');
  });

  // The device is no longer markup. One shared rule paints the mark's own geometry (the two sides of the triangle
  // and its crossbar) as a background image on the first dark section, at 1025 and up, and one opt-out clears it on
  // the five heroes that hold a drawing. One inline svg data URI carries it, drawn 1:1 so the line is 1.5px. Below
  // 1025 no rule paints anything.
  const deviceSvg = (name) => {
    const m = css.match(new RegExp(`${name}:\\s*url\\("data:image/svg\\+xml,([^"]*)"\\)`));
    if (!m) throw new Error(`${name} is not defined as an svg data URI`);
    return decodeURIComponent(m[1]);
  };

  it('the device is one faint ivory line for both strokes, 1.5px at the size it is drawn, with no gold, and only one image of it exists', () => {
    const svg = deviceSvg('--device');
    assert.ok(/<path /.test(svg) && /<line /.test(svg), '--device draws the triangle\'s sides and its crossbar');
    assert.match(svg, /stroke='#FAFAF8'/, '--device is ivory');
    assert.match(svg, /stroke-opacity='\.12'/, '--device is 12% ivory');
    assert.ok(!/201,\s*168,\s*76|aurum|c9a84c/i.test(svg), '--device carries no gold');
    const w = Number(svg.match(/\swidth='(\d+)'/)[1]);
    const h = Number(svg.match(/\sheight='(\d+)'/)[1]);
    assert.deepEqual([w, h], [1250, 1150], '--device is drawn 1250 by 1150');
    // drawn 1:1 (the viewBox is the drawn size), so the rendered line is the stroke width
    assert.equal(svg.match(/viewBox='([^']*)'/)[1], `0 0 ${w} ${h}`, '--device is drawn 1:1');
    assert.equal(Number(svg.match(/stroke-width='([\d.]+)'/)[1]), 1.5, '--device renders a 1.5px line');
    // the corner glyphs of the earlier rounds are gone, and so is the old --device-a anchor
    assert.ok(!/--device-band|--device-a\b/.test(css), 'the 70px corner glyph and the old anchor variable are gone from the sheet');
    // the rule that paints it is in a 1025-and-up media block, on the first dark section and on the legal band
    const block = mediaBlock(css, '@media (min-width: 1025px) {\n  main > .on-dark:first-child,');
    assert.ok(block, 'the device rule sits in a min-width 1025 media block');
    assert.match(block, /main > \.on-dark:first-child,\s*body \.legal-wrap > h1::before\s*\{[^}]*background-image:\s*var\(--device\)/, 'it paints --device on main > .on-dark:first-child and on the legal template band');
    assert.match(block, /background-size:\s*1250px 1150px/);
    // anchored to the hero container's right edge: 48px outside it, level with the container's top (120)
    assert.match(block, /background-position:\s*min\(calc\(50% \+ 703px\), calc\(100% \+ 754px\)\) 120px/, 'apex at the container\'s right edge plus 48, at the container\'s top');
    // outside that block nothing paints --device (so there is none at 1024 and down)
    assert.ok(!css.replace(block, '').includes('background-image: var(--device)'), 'no rule outside the 1025 block paints the device');
    // the dashboard is an application surface: the header band takes no device and the sign-in screen is cleared
    assert.ok(!/\.dash-wrap > \.dash-band:first-child/.test(css), 'the dashboard header band takes no device');
    assert.match(css, /main > #login-view\s*\{[^}]*background-image:\s*none/, 'the dashboard sign-in screen carries no device');
    // the old inline clipping wrapper has no rule left, since no page carries it
    assert.ok(!/\.dw-device-clip/.test(css), 'the shared sheet carries no rule for the old inline device wrapper');
    // a hero that holds a drawing carries no device: the opt-out names exactly those five heroes and clears the image
    const optOut = css.match(/main > :is\(([^)]*)\)\s*\{\s*background-image:\s*none;?\s*\}/);
    assert.ok(optOut, 'one rule clears the device on the heroes that hold a drawing');
    assert.deepEqual(optOut[1].split(',').map((x) => x.trim()).sort(), ['#builders-hero', '#hero', '#page-hero', '#pricing-hero', '.hiw-hero'], 'the home, for-builders, for-agents, pricing and how-it-works heroes, and no other');
    assert.ok(css.indexOf(optOut[0]) > css.indexOf(block), 'positive control: the opt-out follows the shared rule it overrides');
  });

  it('the device keeps the dimmest text on the dark ground above 4.5 to 1, even directly under the line', () => {
    // 12% ivory over #0A0A0A, then the contrast of the dimmest on-dark text (#8B929A) against that
    const lum = (rgb) => { const c = rgb.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
    const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
    const under = [10, 10, 10].map((d, i) => d * 0.88 + [250, 250, 248][i] * 0.12);
    assert.ok(ratio([0x8B, 0x92, 0x9A], under) >= 4.5, `the dimmest note colour keeps ${ratio([0x8B, 0x92, 0x9A], under).toFixed(2)} to 1 under the line`);
    assert.ok(ratio([0xA7, 0xAC, 0xB2], under) > ratio([0x8B, 0x92, 0x9A], under), 'positive control: the body colour keeps more than the note colour');
  });

  const MCP_TITLE = "MCP tool inputSchema must use 'object' type at the top level or tools won't appear";
  const PINECONE_TITLE = 'Pinecone upsert requires vectors array not a single vector object';

  it('the recall drawing: the long way is at most four bars with category chips between them and ends in a 1px outline card, the short way returns the full Pinecone card', () => {
    const sec = html.match(/<section id="own-learnings-free"[\s\S]*?<\/section>/)[0];
    assert.match(sec, /<div class="dw-stage pair-art" aria-hidden="true">/, 'the drawing stays hidden from assistive tech');
    const panels = sec.split('<div class="dw-panel dw-dark').slice(1);
    assert.equal(panels.length, 2, 'two dark panels');
    assert.ok(panels[0].startsWith(' dw-long dw-term"'), 'the first is the tall panel');
    // the long way: bars and category chips in document order, never two bars side by side, at most four bars in all
    const run = [...panels[0].matchAll(/<span class="(dw-sk|dw-chip)[ "]/g)].map((m) => m[1]);
    assert.ok(run.includes('dw-chip'), 'positive control: the run carries chips');
    assert.ok(run.filter((x) => x === 'dw-sk').length >= 3, 'positive control: the run carries bars');
    assert.ok(run.filter((x) => x === 'dw-sk').length <= 4, `the long way keeps at most four bars (${run.filter((x) => x === 'dw-sk').length})`);
    assert.ok(!run.some((x, i) => x === 'dw-sk' && run[i + 1] === 'dw-sk'), 'no two bars stand side by side: a chip sits between them');
    for (const cat of ['data-processing', 'web-interaction', 'code-execution']) assert.ok(panels[0].includes(`<span class="dw-chip">${cat}</span>`), `the long way carries a real ${cat} chip`);
    // the long way's found card is an outline card (no light fill, no dimming), with its chip and one skeleton line, at its foot
    assert.ok(/<div class="dw-row"><span class="dw-chip">code-execution<\/span><\/div>\s*<div class="dw-panel dw-outline dw-found"><span class="dw-chip">storage-state<\/span><div class="dw-found-lines"><span class="dw-sk w85"><\/span><\/div><\/div>\s*<\/div>/.test(panels[0]), 'its outline card sits at its foot, after the last chip, with the chip and one line');
    assert.ok(!/dw-light/.test(panels[0]), 'the long way carries no light card');
    // the short way is one tool row with the full returned card directly under it, the Pinecone title
    assert.ok(/<span class="dw-tool">auxilo_knowledge<\/span><\/div>\s*<div class="dw-panel dw-light dw-found"><span class="dw-chip">storage-state<\/span><span class="dw-title">/.test(panels[1]), 'the short panel is one tool row with the full card directly under it');
    assert.ok(panels[1].includes(`<span class="dw-title">${PINECONE_TITLE}</span>`), 'the returned card is the Pinecone title');
    assert.equal((panels[1].match(/auxilo_knowledge/g) || []).length, 1, 'one tool row');
    assert.ok(!sec.includes(TITLE), 'the explainer\'s JSONL title does not stand in the recall drawing');
  });

  it('no catalog title stands twice outside the review queue window, and the queue window lists all three', () => {
    const win = html.slice(html.indexOf('<div class="dw-panel dw-light dw-window"'), html.indexOf('<!-- What a learning is'));
    assert.ok(win.length > 500, 'positive control: the queue window was cut out');
    const outside = html.replace(win, '');
    const body = outside.slice(outside.indexOf('<main'), outside.indexOf('</main>'));
    for (const title of [MCP_TITLE, PINECONE_TITLE, TITLE]) {
      assert.equal(win.split(title).length - 1, 1, `the queue window lists "${title.slice(0, 24)}" once`);
      assert.ok(body.split(title).length - 1 <= 1, `"${title.slice(0, 24)}" stands at most once outside the window (${body.split(title).length - 1})`);
    }
    // positive control: each of the three still stands somewhere outside it, in the drawing that shows it
    assert.ok(body.includes(MCP_TITLE) && body.includes(TITLE) && body.includes(PINECONE_TITLE), 'each title stands once in its own drawing');
  });

  it('hero panel 1 is a mono session ending in a category chip and a lit bar; panel 4 is an ordinary dark panel with an Earnings row label', () => {
    const hero = html.match(/<section id="hero"[\s\S]*?<\/section>/)[0];
    const p1 = hero.slice(hero.indexOf('<div class="dw-panel dw-dark hx-1">'), hero.indexOf('<div class="dw-panel dw-light hx-2">'));
    assert.ok(p1.length > 100, 'positive control: panel 1 was cut out');
    assert.ok(/<div class="dw-term"[^>]*><span class="dw-sk w85"><\/span><span class="dw-sk w55"><\/span><div class="dw-row hx-1-row"><span class="dw-chip">code-execution<\/span><span class="dw-sk lit"><\/span><\/div><\/div>/.test(p1), 'two short skeleton bars, then a row with the code-execution chip and a lit bar');
    assert.equal((p1.match(/<span class="dw-sk /g) || []).length, 3, 'three bars in all (two, and the lit one in the row)');
    assert.ok(/<div class="dw-ledger"><div class="dw-row"><span class="dw-tick"><\/span><span class="dw-rowlabel">Earnings<\/span><span class="dw-sk"><\/span><span class="dw-amt"><\/span><\/div><\/div>/.test(hero.slice(hero.indexOf('hx-4"'))), 'Earnings is the row label of panel 4\'s gold-tick ledger row');
    // the page style gives panel 4 no border or text colour of its own: it is an ordinary dark panel
    const rule = ruleBody(pageStyle, '.hx-4');
    assert.ok(rule, 'the panel 4 rule is found');
    assert.ok(!/border|color|aurum/.test(rule), 'panel 4 takes no border and no colour of its own');
    assert.ok(!/\.hx-4 \.dw-cap/.test(pageStyle), 'its caption takes no colour of its own');
    assert.match(ruleBody(pageStyle, '.hx-4 .dw-node') || '', /color:\s*var\(--aurum\)/, 'its node marker stays gold');
  });

  it('the explainer drawing is at most three bars with two category chips and a real tool row, then the JSONL card; the step cards show a review card, and an Earnings row and a Balance row', () => {
    const sec = html.match(/<section id="learning-explainer"[\s\S]*?<\/section>/)[0];
    assert.ok(sec.includes(`<span class="dw-title" style="font-size:16px">${TITLE}</span>`), 'the explainer keeps the JSONL card');
    assert.ok(/<span class="dw-tool">auxilo_contribute<\/span><span class="dw-sk lit"/.test(sec), 'its session ends on the real auxilo_contribute tool row');
    // bars and chips in document order: a bar, a chip, a bar, a chip, then the tool row (its lit bar is the third); the card's chip is the third chip
    const stage = sec.slice(sec.indexOf('<div class="dw-stage dw-stage-dark'));
    const session = stage.slice(0, stage.indexOf('<div class="dw-panel dw-light"'));
    assert.ok(session.length > 200 && stage.length > session.length, 'positive control: the session was cut out ahead of the card');
    const run = [...session.matchAll(/<span class="(dw-sk|dw-chip|dw-tool)[ "]/g)].map((m) => m[1]);
    assert.deepEqual(run, ['dw-sk', 'dw-chip', 'dw-sk', 'dw-chip', 'dw-tool', 'dw-sk'], 'bar, chip, bar, chip, tool row with its lit bar: three bars interleaved with two chips and the tool row');
    assert.ok(session.includes('<span class="dw-chip">code-execution</span>') && session.includes('<span class="dw-chip">web-interaction</span>'), 'the two chips are real categories');
    assert.equal((stage.match(/<span class="dw-sk/g) || []).length, 3, 'three bars in the whole drawing, the card carries none');
    const steps = [...html.matchAll(/<div class="step-art" aria-hidden="true">([\s\S]*?)<\/div><\/div>\s*<div class="step-body">/g)].map((m) => m[1]);
    assert.equal(steps.length, 3, 'three step drawings');
    // card 2: a light review card, a category chip, Approve and Reject, and the title as skeleton bars (the MCP title already stands in the hero and the queue)
    assert.ok(/dw-panel dw-light step-review/.test(steps[1]), 'card 2 is a light review card');
    assert.ok(steps[1].includes('<span class="dw-chip">code-execution</span>') && steps[1].includes('<span class="dw-btn primary">Approve</span><span class="dw-btn ghost">Reject</span>'), 'with its chip, Approve and Reject');
    assert.ok(!/dw-title/.test(steps[1]), 'and no catalog title, so none stands twice outside the queue');
    // card 3: one Earnings row and one Balance row, never one label three times
    assert.deepEqual([...steps[2].matchAll(/<span class="dw-rowlabel">([^<]*)<\/span>/g)].map((m) => m[1]), ['Earnings', 'Balance'], 'card 3 has one Earnings row and one Balance row, in that order');
    assert.equal((steps[2].match(/<span class="dw-tick">/g) || []).length, 2, 'positive control: two ledger rows');
  });

  it('code blocks keep a thin scrollbar on the dark ground (standard and webkit)', () => {
    const std = css.match(/\.code-block pre,[^{]*\{([^}]*scrollbar-width[^}]*)\}/);
    assert.ok(std, 'the scrollbar rule is found on .code-block pre');
    assert.match(std[1], /scrollbar-width:\s*thin/);
    assert.match(std[1], /scrollbar-color:\s*rgba\(250, 250, 248, 0\.35\) transparent/);
    const bar = ruleBody(css, '.code-block pre::-webkit-scrollbar');
    assert.ok(bar && /height:\s*6px/.test(bar), 'the webkit bar is 6px high');
    const thumb = ruleBody(css, '.code-block pre::-webkit-scrollbar-thumb');
    assert.ok(thumb && /rgba\(250, 250, 248, 0\.35\)/.test(thumb), 'the webkit thumb takes the same colour');
    assert.ok(/\.dw-dark pre,/.test(std[0]), 'every pre in a dark panel takes it');
  });
});

describe('home drawings: the render', { timeout: 180_000 }, () => {
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
    if ('skipReason' in reservation) { bootSkipReason = reservation.skipReason; return; }
    const { port } = reservation;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auxilo-home-drawings-'));
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
        SESSION_SECRET: 'home-drawings-test-session-secret-0123456',
      },
      timeoutMs: 60_000,
      maxAttempts: 4,
    });
    if ('skipReason' in boot) { bootSkipReason = boot.skipReason; return; }
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

  // Run `fn` inside a page at `width`. Reduced motion by default, so the finished drawing is what
  // gets measured; pass motion:true for the animation timings.
  async function at(t, width, route, fn, { motion = false, height = 800 } = {}) {
    if (bootSkipReason) { t.skip(bootSkipReason); return undefined; }
    if (!playwrightOk) { t.skip('playwright not resolvable'); return undefined; }
    const ctx = await browser.newContext({ viewport: { width, height }, reducedMotion: motion ? 'no-preference' : 'reduce' });
    const page = await ctx.newPage();
    try {
      await page.goto(`${baseUrl}${route}`, { waitUntil: motion ? 'domcontentloaded' : 'networkidle' });
      return await fn(page);
    } finally {
      await ctx.close();
    }
  }

  // ── the thread, from 481 up ──
  for (const width of [481, 768, 1024, 1280]) {
    it(`the thread at ${width}: each leg starts behind the panel it leaves and ends at the next panel's edge, level with its marker`, async (t) => {
      const m = await at(t, width, '/', (page) => page.evaluate(() => {
        const svg = document.querySelector('.hx-thread');
        const sr = svg.getBoundingClientRect();
        const toScreen = (p) => ({ x: sr.left + (p.x / 100) * sr.width, y: sr.top + (p.y / 508) * sr.height });
        const box = (el) => { const r = el.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom }; };
        const node = (n) => { const r = document.querySelector(`.hx-${n} .dw-node`).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };
        const ends = [...svg.querySelectorAll('path')].map((p) => {
          const len = p.getTotalLength();
          return { start: toScreen(p.getPointAtLength(0)), end: toScreen(p.getPointAtLength(len)) };
        });
        return {
          display: getComputedStyle(svg).display,
          rect: { w: sr.width, h: sr.height },
          ends,
          cards: [1, 2, 3, 4].map((n) => box(document.querySelector(`.hx-${n}`))),
          nodes: [1, 2, 3, 4].map(node),
        };
      }));
      if (!m) return;
      assert.notEqual(m.display, 'none', 'the thread shows');
      assert.ok(m.rect.w > 0 && m.rect.h > 0, 'positive control: the svg has a box');
      const inside = (p, c, slack = 0) => p.x >= c.l - slack && p.x <= c.r + slack && p.y >= c.t - slack && p.y <= c.b + slack;
      // legs 1, 2, 3 leave panels 1, 2, 3 (hidden behind them) and arrive at panels 2, 3, 4
      for (let i = 0; i < 3; i++) {
        assert.ok(inside(m.ends[i].start, m.cards[i]), `leg ${i + 1} starts behind panel ${i + 1}`);
      }
      const levelWithMarker = (end, node) => Math.abs(end.y - node.y) <= 2.5;
      assert.ok(Math.abs(m.ends[0].end.x - m.cards[1].l) <= 3 && levelWithMarker(m.ends[0].end, m.nodes[1]), `leg 1 meets panel 2's left edge level with its marker: ${JSON.stringify([m.ends[0].end, m.cards[1].l, m.nodes[1]])}`);
      assert.ok(Math.abs(m.ends[1].end.x - m.cards[2].r) <= 3 && levelWithMarker(m.ends[1].end, m.nodes[2]), `leg 2 meets panel 3's right edge level with its marker: ${JSON.stringify([m.ends[1].end, m.cards[2].r, m.nodes[2]])}`);
      assert.ok(Math.abs(m.ends[2].end.x - m.cards[3].l) <= 3 && levelWithMarker(m.ends[2].end, m.nodes[3]), `leg 3 meets panel 4's left edge level with its marker: ${JSON.stringify([m.ends[2].end, m.cards[3].l, m.nodes[3]])}`);
      // the legs run down the page in reading order
      assert.ok(m.ends[0].end.y < m.ends[1].end.y && m.ends[1].end.y < m.ends[2].end.y, 'the legs arrive top to bottom');
    });
  }

  it('the thread colours at 1280: legs 1 and 2 faint ivory, leg 3 gold, 1.25px, round caps, no markers', async (t) => {
    const s = await at(t, 1280, '/', (page) => page.evaluate(() => [1, 2, 3].map((n) => {
      const cs = getComputedStyle(document.querySelector(`.hx-leg-${n}`));
      return { stroke: cs.stroke, width: cs.strokeWidth, cap: cs.strokeLinecap, markerEnd: cs.markerEnd, markerStart: cs.markerStart, dash: cs.strokeDasharray };
    })));
    if (!s) return;
    assert.equal(s[0].stroke, IVORY_THREAD);
    assert.equal(s[1].stroke, IVORY_THREAD);
    assert.equal(s[2].stroke, AURUM_RGB);
    for (const leg of s) {
      assert.equal(leg.width, '1.25px');
      assert.equal(leg.cap, 'round');
      assert.equal(leg.markerEnd, 'none');
      assert.equal(leg.markerStart, 'none');
      assert.equal(leg.dash, 'none', 'at rest the leg is a plain line, not a dash pattern');
    }
  });

  // ── the thread, stacked ──
  for (const width of [480, 375]) {
    it(`the stack at ${width}: a plain vertical hairline in each gap, on the marker column, ivory then ivory then gold, nothing after the last panel`, async (t) => {
      const m = await at(t, width, '/', (page) => page.evaluate(() => {
        const out = { svg: getComputedStyle(document.querySelector('.hx-thread')).display, segs: [] };
        for (const n of [1, 2, 3, 4]) {
          const card = document.querySelector(`.hx-${n}`);
          const cs = getComputedStyle(card);
          const r = card.getBoundingClientRect();
          const node = card.querySelector('.dw-node').getBoundingClientRect();
          const next = document.querySelector(`.hx-${n + 1}`);
          const ps = getComputedStyle(card, '::after');
          out.segs.push({
            content: ps.content,
            background: ps.backgroundColor,
            width: parseFloat(ps.width),
            height: parseFloat(ps.height),
            // the segment's box, from the card's border-box and the pseudo's own offsets
            top: r.top + parseFloat(cs.borderTopWidth) + parseFloat(ps.top),
            centreX: r.left + parseFloat(cs.borderLeftWidth) + parseFloat(ps.left) + parseFloat(ps.width) / 2,
            cardBottom: r.bottom,
            nextTop: next ? next.getBoundingClientRect().top : null,
            nodeX: node.left + node.width / 2,
          });
        }
        return out;
      }));
      if (!m) return;
      assert.equal(m.svg, 'none', 'the drawn thread is off when the panels stack');
      assert.equal(m.segs[3].content, 'none', 'nothing hangs below the last panel');
      assert.notEqual(m.segs[0].content, 'none', 'positive control: the first gap carries a segment');
      assert.equal(m.segs[0].background, IVORY_THREAD);
      assert.equal(m.segs[1].background, IVORY_THREAD);
      assert.equal(m.segs[2].background, AURUM_RGB);
      for (let i = 0; i < 3; i++) {
        const s = m.segs[i];
        assert.ok(Math.abs(s.centreX - s.nodeX) <= 0.5, `segment ${i + 1} sits on the marker column: ${s.centreX} vs ${s.nodeX}`);
        assert.ok(Math.abs(s.top - s.cardBottom) <= 0.75, `segment ${i + 1} starts at the panel above's edge`);
        assert.ok(s.top + s.height >= s.nextTop - 0.01 && s.top + s.height <= s.nextTop + 1.5, `segment ${i + 1} reaches the panel below`);
        assert.ok(Math.abs(s.width - 1.25) <= 0.01, 'a 1.25px hairline');
      }
    });
  }

  // ── motion ──
  it('motion at 1280: the sequence ends inside 2.4s, a leg draws as its panel starts to rise, and a leg never starts before the panel it leaves exists', async (t) => {
    const a = await at(t, 1280, '/', (page) => page.evaluate(() => document.getAnimations().map((x) => {
      const timing = x.effect.getComputedTiming();
      const cls = String(x.effect.target.getAttribute('class'));
      return { cls, start: timing.delay, end: timing.endTime, dur: timing.duration };
    })), { motion: true });
    if (!a) return;
    const leg = (n) => a.find((x) => x.cls.includes(`hx-leg-${n}`));
    const card = (n) => a.find((x) => /(^|\s)hx-\d(\s|$)/.test(x.cls) && x.cls.split(/\s+/).includes(`hx-${n}`));
    for (const n of [1, 2, 3]) assert.ok(leg(n), `positive control: leg ${n} animates`);
    for (const n of [1, 2, 3, 4]) assert.ok(card(n), `positive control: panel ${n} animates`);
    const last = Math.max(...a.map((x) => x.end));
    assert.ok(last <= 2400, `the whole sequence ends at ${last}ms, inside 2400ms`);
    for (const n of [1, 2, 3]) {
      assert.ok(leg(n).start >= card(n).start + card(n).dur * 0.5, `leg ${n} starts once panel ${n} is mostly there`);
      assert.ok(leg(n).end >= card(n + 1).start, `leg ${n} is still drawing when panel ${n + 1} starts to rise`);
      assert.ok(leg(n).end - card(n + 1).start <= 150, `leg ${n} finishes within 150ms of panel ${n + 1} starting to rise, never long before`);
    }
  });

  it('motion is off at 480 and down: no animation runs on the stacked drawing', async (t) => {
    const a = await at(t, 480, '/', (page) => page.evaluate(() => document.getAnimations().filter((x) => x.effect && x.effect.target && x.effect.target.closest && x.effect.target.closest('.hx')).length), { motion: true });
    if (a === undefined) return;
    assert.equal(a, 0);
  });

  // ── the device ──
  // The first dark section of every hero with no drawing carries the shared background image at 1025 and up, and
  // nothing below. A hero that holds a drawing carries none at any width: the device's left leg ran under its panels.
  // Its painted pixels are found by diffing two screenshots of the same hero in one run (the hero's children
  // hidden, with and without the image), then compared with the boxes of the hero's panels and buttons and
  // with its text. No pixel literals: the numbers compared are the container's edge, the ruled 48, and boxes
  // measured in the same page.
  const FIRST_DARK = 'main > .on-dark:first-child';
  const GAP = 48;
  const DEVICE_ROUTES = ['/api', '/status', '/works-with', '/connect', '/about', '/how-submissions-work', '/writing', '/writing/agents-message-board'];
  const DRAWING_ROUTES = ['/', '/for-builders', '/for-agents', '/how-it-works', '/pricing'];

  // Run in the page: the hero section's box, its content right edge (the container), its panels and buttons,
  // and the line boxes of its text that are not inside a panel.
  const heroProbe = () => {
    const sec = document.querySelector('main > .on-dark:first-child');
    const r = sec.getBoundingClientRect();
    const cs = getComputedStyle(sec);
    const maxW = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--max-w'));
    const contentL = r.left + parseFloat(cs.paddingLeft);
    const contentR = r.right - parseFloat(cs.paddingRight);
    const containerR = Math.min(contentR, (contentL + contentR) / 2 + maxW / 2);
    const rect = (el) => { const b = el.getBoundingClientRect(); return { l: b.left, t: b.top + scrollY, r: b.right, b: b.bottom + scrollY, tag: el.tagName.toLowerCase() }; };
    const obstacles = [...sec.querySelectorAll('.dw-panel, .code-block, .copy-btn, .btn-primary, .btn-secondary, .hero-cta-link, .dw-btn')].filter((e) => e.getBoundingClientRect().width > 0).map(rect);
    const texts = [];
    const walker = document.createTreeWalker(sec, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const n = walker.currentNode;
      if (!n.textContent.trim() || !n.parentElement || getComputedStyle(n.parentElement).display === 'none') continue;
      const rg = document.createRange(); rg.selectNodeContents(n);
      for (const b of rg.getClientRects()) if (b.width > 0 && b.height > 0) texts.push({ l: b.left, t: b.top + scrollY, r: b.right, b: b.bottom + scrollY, tag: n.parentElement.tagName.toLowerCase() });
    }
    const inside = (t, o) => t.l >= o.l - 1 && t.r <= o.r + 1 && t.t >= o.t - 1 && t.b <= o.b + 1;
    return {
      sec: { l: r.left, t: r.top + scrollY, r: r.right, b: r.bottom + scrollY, padTop: parseFloat(cs.paddingTop) },
      containerR, vw: window.innerWidth, scrollW: document.documentElement.scrollWidth,
      obstacles,
      texts: texts.filter((t) => !obstacles.some((o) => inside(t, o))),
      image: cs.backgroundImage,
    };
  };

  // The painted device pixels of the hero, in page coordinates.
  async function deviceMask(page, info) {
    const clip = { x: 0, y: Math.round(info.sec.t), width: info.vw, height: Math.round(info.sec.b - info.sec.t) };
    await page.addStyleTag({ content: 'main > .on-dark:first-child > * { visibility: hidden !important; }' });
    const on = await page.screenshot({ clip, fullPage: true });
    await page.addStyleTag({ content: 'main > .on-dark:first-child { background-image: none !important; }' });
    const off = await page.screenshot({ clip, fullPage: true });
    const diffPage = await page.context().newPage();
    try {
      const flat = await diffPage.evaluate(async ([A, B]) => {
        const load = (b64) => new Promise((res) => { const im = new Image(); im.onload = () => res(im); im.src = `data:image/png;base64,${b64}`; });
        const [ia, ib] = await Promise.all([load(A), load(B)]);
        const c = document.createElement('canvas'); c.width = ia.width; c.height = ia.height;
        const g = c.getContext('2d');
        g.drawImage(ia, 0, 0); const da = g.getImageData(0, 0, c.width, c.height).data;
        g.clearRect(0, 0, c.width, c.height); g.drawImage(ib, 0, 0); const db = g.getImageData(0, 0, c.width, c.height).data;
        const out = [];
        for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) { const i = (y * c.width + x) * 4; if (Math.abs(da[i] - db[i]) > 3) out.push(x, y); }
        return out;
      }, [on.toString('base64'), off.toString('base64')]);
      const mask = [];
      for (let i = 0; i < flat.length; i += 2) mask.push([flat[i], flat[i + 1] + clip.y]);
      return mask;
    } finally {
      await diffPage.close();
    }
  }

  // The longest horizontal run of device pixels (the crossbar), and the topmost pixel (the apex).
  function crossbarAndApex(mask) {
    const rows = new Map();
    for (const [x, y] of mask) { if (!rows.has(y)) rows.set(y, []); rows.get(y).push(x); }
    let bar = null;
    for (const [y, xs] of rows) {
      xs.sort((a, b) => a - b);
      let start = xs[0]; let prev = xs[0];
      for (let i = 1; i <= xs.length; i++) {
        if (i === xs.length || xs[i] !== prev + 1) { if (!bar || prev - start > bar.x1 - bar.x0) bar = { y, x0: start, x1: prev }; start = xs[i]; }
        prev = xs[i];
      }
    }
    const top = Math.min(...mask.map((p) => p[1]));
    const topXs = mask.filter((p) => p[1] === top).map((p) => p[0]);
    return { bar, apex: { x: topXs.reduce((a, b) => a + b, 0) / topXs.length, y: top } };
  }

  it('control: the crossbar and apex finder reads a drawn crossbar and apex', () => {
    const mask = [];
    for (let x = 100; x < 160; x++) mask.push([x, 50]);
    mask.push([100, 10], [101, 10], [99, 11], [102, 11]);
    const { bar, apex } = crossbarAndApex(mask);
    assert.deepEqual(bar, { y: 50, x0: 100, x1: 159 });
    assert.deepEqual([apex.x, apex.y], [100.5, 10]);
  });

  for (const width of [1280, 1440]) {
    for (const route of DEVICE_ROUTES) {
      it(`the device on ${route} at ${width}: apex ${GAP}px outside the container's right edge and level with its top, the crossbar clear of every panel and button by ${GAP} or more, and nothing behind hero text`, async (t) => {
        const d = await at(t, width, route, async (page) => {
          const info = await page.evaluate(heroProbe);
          const mask = await deviceMask(page, info);
          return { info, mask };
        }, { height: 900 });
        if (!d) return;
        const { info, mask } = d;
        assert.match(info.image, /^url\("data:image\/svg\+xml,/, 'the first dark section paints the device svg');
        assert.ok(!/201,\s*168,\s*76|c9a84c|aurum/i.test(decodeURIComponent(info.image)), 'no gold in it');
        assert.ok(info.scrollW <= width, 'the device adds no sideways scroll');
        assert.ok(mask.length > 200, `positive control: the device was painted (${mask.length} pixels)`);
        const { bar, apex } = crossbarAndApex(mask);
        assert.ok(Math.abs(apex.x - (info.containerR + GAP)) <= 3, `the apex (${apex.x}) hangs ${GAP}px outside the container's right edge (${info.containerR})`);
        assert.ok(Math.abs(apex.y - (info.sec.t + info.sec.padTop)) <= 4, `the apex (${apex.y}) is level with the container's top (${info.sec.t + info.sec.padTop})`);
        // The crossbar hangs 200px under the apex (the drawing's own geometry, read from the image). A hero shorter than
        // the apex's offset plus that drop clips it, and the measurement then has to find no crossbar at all.
        const drop = Number(decodeURIComponent(info.image).match(/<line [^>]*y1='(\d+)'/)[1]) - Number(decodeURIComponent(info.image).match(/<path d='M-?\d+ \d+L\d+ (\d+)L/)[1]);
        assert.ok(drop > 100, `positive control: the image's crossbar hangs ${drop}px under its apex`);
        const clipped = info.sec.b - info.sec.t < info.sec.padTop + drop;
        if (clipped) {
          assert.ok(!bar || bar.x1 - bar.x0 < 30, `the hero is shorter than the crossbar's drop, so the crossbar is clipped away (${JSON.stringify(bar)})`);
        } else {
          assert.ok(bar && bar.x1 - bar.x0 >= 30, 'the crossbar leaves the frame to the right');
          assert.ok(bar.x0 >= apex.x - 3, `the crossbar starts at the apex's centre line (${bar.x0} against ${apex.x})`);
          for (const o of info.obstacles) {
            const dx = Math.max(o.l - bar.x1, 0, bar.x0 - o.r);
            const dy = Math.max(o.t - bar.y, 0, bar.y - o.b);
            assert.ok(Math.hypot(dx, dy) >= GAP - 0.5, `the crossbar (y ${bar.y}, x ${bar.x0}-${bar.x1}) is ${Math.hypot(dx, dy).toFixed(1)}px from a ${o.tag} at ${JSON.stringify(o)}`);
          }
        }
        assert.ok(info.texts.length > 0, 'positive control: the hero has text outside its panels');
        for (const tx of info.texts) {
          assert.ok(!mask.some(([x, y]) => x >= tx.l && x <= tx.r && y >= tx.t && y <= tx.b), `a device line crosses a ${tx.tag} line at ${JSON.stringify(tx)}`);
        }
      });
    }
  }

  // A hero that holds a drawing carries no device at any width, while the same page paints the shared rule on a
  // first dark section of its own (a probe added in the same page), so the control proves the opt-out and nothing else.
  for (const width of [1280, 1440]) {
    for (const route of DRAWING_ROUTES) {
      it(`the hero on ${route} at ${width} holds a drawing and paints no device, while a first dark section probe in the same page does`, async (t) => {
        const d = await at(t, width, route, (page) => page.evaluate(() => {
          const hero = document.querySelector('main > .on-dark:first-child');
          const own = getComputedStyle(hero).backgroundImage;
          const probe = document.createElement('section');
          probe.className = 'on-dark';
          document.querySelector('main').prepend(probe);
          const control = getComputedStyle(probe).backgroundImage;
          probe.remove();
          return { own, control, scrollW: document.documentElement.scrollWidth };
        }), { height: 900 });
        if (!d) return;
        assert.match(d.control, /^url\("data:image\/svg\+xml,/, 'positive control: the shared rule paints a first dark section at this width');
        assert.equal(d.own, 'none', `${route} paints no device behind its drawing`);
        assert.ok(d.scrollW <= width, 'no sideways scroll');
      });
    }
  }

  // Below 1025 there is no device: the first dark section paints no image, on every route, at the widths a
  // tablet and a phone have, and the legal template's band paints none either.
  for (const width of [1024, 768, 375]) {
    it(`the device at ${width}: none on the first dark section of any page, and none on the legal band`, async (t) => {
      const routes = [...DRAWING_ROUTES, ...DEVICE_ROUTES];
      const seen = [];
      for (const route of routes) {
        const d = await at(t, width, route, (page) => page.evaluate((sel) => {
          const el = document.querySelector(sel);
          return { has: !!el, image: el ? getComputedStyle(el).backgroundImage : null, scrollW: document.documentElement.scrollWidth };
        }, FIRST_DARK), { height: width === 375 ? 812 : 1024 });
        if (!d) return;
        assert.ok(d.has, `positive control: ${route} has a first dark section`);
        assert.equal(d.image, 'none', `${route} at ${width} paints no device`);
        assert.ok(d.scrollW <= width, `${route} has no sideways scroll`);
        seen.push(route);
      }
      assert.equal(seen.length, routes.length);
      const legal = await at(t, width, '/terms', (page) => page.evaluate(() => getComputedStyle(document.querySelector('.legal-wrap > h1'), '::before').backgroundImage));
      if (legal === undefined) return;
      assert.equal(legal, 'none', `the legal band paints no device at ${width}`);
      // positive control: the same band paints it at 1280
      const wide = await at(t, 1280, '/terms', (page) => page.evaluate(() => getComputedStyle(document.querySelector('.legal-wrap > h1'), '::before').backgroundImage));
      assert.match(wide, /^url\("data:image\/svg\+xml,/, 'positive control: the legal band paints the device at 1280');
    });
  }

  // The dashboard is an application surface: no device, neither on the sign-in screen nor on the signed-in band.
  for (const width of [1280, 768, 375]) {
    it(`the dashboard at ${width}: no device on the sign-in screen or the signed-in header band`, async (t) => {
      const d = await at(t, width, '/dashboard', (page) => page.evaluate(() => {
        const login = document.querySelector('#login-view');
        const band = document.querySelector('.dash-wrap > .dash-band');
        // a positive control, from the same page: the shared rule would paint the first dark section of main at 1025 and up
        const probe = document.createElement('section');
        probe.className = 'on-dark';
        document.querySelector('main').prepend(probe);
        const control = getComputedStyle(probe).backgroundImage;
        probe.remove();
        return { login: getComputedStyle(login).backgroundImage, band: getComputedStyle(band).backgroundImage, control };
      }), { height: 900 });
      if (!d) return;
      assert.equal(d.login, 'none', 'the sign-in screen paints no device');
      assert.equal(d.band, 'none', 'the signed-in header band paints no device');
      if (width > 1024) assert.match(d.control, /^url\("data:image\/svg\+xml,/, 'positive control: the shared rule does paint a first dark section in main');
      else assert.equal(d.control, 'none', 'below 1025 the shared rule paints nothing');
    });
  }

  // ── the hero notes ──
  for (const [width, size] of [[1280, '15px'], [481, '15px'], [480, '14px'], [375, '14px']]) {
    it(`the hero notes at ${width}: the body colour and ${size}`, async (t) => {
      const n = await at(t, width, '/', (page) => page.evaluate(() => {
        const probe = document.createElement('i');
        probe.style.color = 'var(--fg-2)';
        document.querySelector('#hero').appendChild(probe);
        const fg2 = getComputedStyle(probe).color;
        probe.remove();
        const notes = [...document.querySelectorAll('.hero-setup-note')].map((p) => { const cs = getComputedStyle(p); return { color: cs.color, size: cs.fontSize }; });
        const fg3probe = document.createElement('i');
        fg3probe.style.color = 'var(--fg-3)';
        document.querySelector('#hero').appendChild(fg3probe);
        const fg3 = getComputedStyle(fg3probe).color;
        fg3probe.remove();
        return { fg2, fg3, notes };
      }));
      if (!n) return;
      assert.equal(n.notes.length, 2, 'both notes found');
      assert.notEqual(n.fg2, n.fg3, 'positive control: the two tokens differ, so the colour check can tell them apart');
      for (const note of n.notes) {
        assert.equal(note.color, n.fg2, 'the note takes the body colour');
        assert.equal(note.size, size);
      }
    });
  }

  // ── the recall drawing ──
  it('the recall drawing at 1280: bottoms aligned, the long way taller, the short way\'s card the full one and the long way\'s a 1px outline card, never dimmed', async (t) => {
    const m = await at(t, 1280, '/', (page) => page.evaluate(() => {
      const panels = [...document.querySelectorAll('#own-learnings-free .dw-twoup > .dw-dark')].map((p) => p.getBoundingClientRect());
      const found = [...document.querySelectorAll('#own-learnings-free .dw-found')];
      const cards = found.map((c) => c.getBoundingClientRect());
      return {
        panels: panels.map((r) => ({ t: r.top, b: r.bottom, w: r.width })),
        cards: cards.map((r) => ({ t: r.top, b: r.bottom, h: r.height, w: r.width })),
        opacity: found.map((c) => parseFloat(getComputedStyle(c).opacity)),
        bg: found.map((c) => getComputedStyle(c).backgroundColor),
        border: found.map((c) => ({ w: getComputedStyle(c).borderTopWidth, style: getComputedStyle(c).borderTopStyle, color: getComputedStyle(c).borderTopColor })),
        shadow: found.map((c) => getComputedStyle(c).boxShadow),
        titles: found.map((c) => c.querySelector('.dw-title') ? parseFloat(getComputedStyle(c.querySelector('.dw-title')).fontSize) : null),
      };
    }));
    if (!m) return;
    assert.equal(m.panels.length, 2);
    assert.equal(m.cards.length, 2);
    assert.ok(Math.abs(m.panels[0].b - m.panels[1].b) <= 0.5, 'bottoms aligned');
    assert.ok(m.panels[0].b - m.panels[0].t > m.panels[1].b - m.panels[1].t + 20, 'the long way is taller than the short way');
    assert.ok(m.cards[1].h > m.cards[0].h + 8, 'the short way\'s returned card is the larger card, so the two never read as a duplicate');
    assert.ok(Math.abs(m.cards[0].b - m.cards[1].b) <= 0.5, 'the cards sit level');
    assert.ok(Math.abs((m.panels[0].b - m.cards[0].b) - (m.panels[1].b - m.cards[1].b)) <= 0.5, 'the same space under each card');
    // a dimmed card never stands for a greyed-out control: the long way's card is a 1px outline, full opacity
    assert.deepEqual(m.opacity, [1, 1], 'neither card is dimmed');
    assert.equal(m.border[0].w, '1px', 'the long way\'s card is a 1px outline card');
    assert.equal(m.border[0].style, 'solid');
    assert.equal(m.bg[0], 'rgba(0, 0, 0, 0)', 'with no fill of its own');
    assert.equal(m.shadow[0], 'none', 'and no shadow');
    assert.notEqual(m.bg[1], 'rgba(0, 0, 0, 0)', 'positive control: the short way\'s card has a fill');
    assert.equal(m.titles[1], 16, 'the returned card\'s title is 16px');
    assert.equal(m.titles[0], null, 'the outline card carries no title, so each catalog title stands once outside the queue');
  });

  for (const width of [480, 375]) {
    it(`the recall drawing at ${width}: one column, the long way above the short way`, async (t) => {
      const m = await at(t, width, '/', (page) => page.evaluate(() => [...document.querySelectorAll('#own-learnings-free .dw-twoup > .dw-dark')].map((p) => { const r = p.getBoundingClientRect(); return { t: r.top, b: r.bottom, l: r.left, r: r.right }; })));
      if (!m) return;
      assert.equal(m.length, 2);
      assert.ok(m[1].t >= m[0].b, 'the second panel starts under the first');
      assert.ok(Math.abs(m[0].l - m[1].l) <= 0.5 && Math.abs(m[0].r - m[1].r) <= 0.5, 'the same column');
    });
  }

  // ── the hero's grid, the earnings panel, the code block headers, the skeleton share ──
  for (const [width, cols] of [[1100, 2], [1024, 2], [901, 2], [900, 1], [768, 1], [375, 1]]) {
    it(`the hero grid at ${width}: ${cols} column${cols > 1 ? 's' : ''}${width === 768 ? ', and the exchange takes the full content width' : ''}`, async (t) => {
      const m = await at(t, width, '/', (page) => page.evaluate(() => {
        const grid = document.querySelector('#hero .hero-grid');
        const gcs = getComputedStyle(grid);
        const hx = document.querySelector('.hx').getBoundingClientRect();
        const pad = parseFloat(gcs.paddingLeft) + parseFloat(gcs.paddingRight);
        const g = grid.getBoundingClientRect();
        return { cols: gcs.gridTemplateColumns.split(' ').length, hx: hx.width, content: g.width - pad, gridLeft: g.left + parseFloat(gcs.paddingLeft), hxLeft: hx.left, sw: document.documentElement.scrollWidth };
      }), { height: 1000 });
      if (!m) return;
      assert.equal(m.cols, cols);
      assert.ok(m.sw <= width, 'no sideways scroll');
      if (cols === 1) {
        assert.ok(Math.abs(m.hx - m.content) <= 0.5 && Math.abs(m.hxLeft - m.gridLeft) <= 0.5, `stacked, the exchange takes the whole content width (${m.hx} of ${m.content})`);
      } else {
        assert.ok(m.hx < m.content * 0.6, `positive control: side by side, the exchange is the narrower column (${m.hx} of ${m.content})`);
      }
    });
  }

  it('the earnings panel at 1280 is an ordinary dark panel: its border, caption and text match panel 1\'s; only its marker, ledger row and the last leg are gold', async (t) => {
    const m = await at(t, 1280, '/', (page) => page.evaluate(() => {
      const card = (n) => document.querySelector(`.hx-${n}`);
      const cs = (el) => getComputedStyle(el);
      return {
        border: [1, 4].map((n) => cs(card(n)).borderTopColor),
        bg: [1, 4].map((n) => cs(card(n)).backgroundColor),
        caption: [1, 4].map((n) => cs(card(n).querySelector('.dw-cap')).color),
        label: cs(card(4).querySelector('.dw-rowlabel')).color,
        node: cs(card(4).querySelector('.dw-node')).color,
        nodePath: cs(card(4).querySelector('.dw-node path')).stroke,
        tick: cs(card(4).querySelector('.dw-tick')).backgroundColor,
        amt: cs(card(4).querySelector('.dw-amt')).backgroundColor,
        node1: cs(card(1).querySelector('.dw-node path')).stroke,
      };
    }));
    if (!m) return;
    assert.equal(m.border[1], m.border[0], 'the same border as panel 1');
    assert.equal(m.bg[1], m.bg[0], 'the same fill as panel 1');
    assert.equal(m.caption[1], m.caption[0], 'the same caption colour as panel 1');
    assert.notEqual(m.caption[1], AURUM_RGB, 'the caption is not gold');
    assert.equal(m.label, m.caption[0], 'the Earnings label is ivory too');
    assert.equal(m.node, AURUM_RGB, 'the node marker is gold');
    assert.equal(m.nodePath, AURUM_RGB);
    assert.equal(m.tick, AURUM_RGB, 'the ledger tick is gold');
    assert.notEqual(m.node1, AURUM_RGB, 'positive control: panel 1\'s marker is not gold');
  });

  for (const width of [480, 375]) {
    for (const route of ['/', '/connect', '/for-agents', '/for-builders', '/how-it-works', '/api']) {
      it(`every code block header at ${width} on ${route}: stacked, 16 above and below and 15 beside inside the 1px frame, 8 between the label and a full-width button, never overlapping`, async (t) => {
        const hs = await at(t, width, route, (page) => page.evaluate(() => [...document.querySelectorAll('.code-block-header')].filter((h) => h.getBoundingClientRect().width > 0).map((h) => {
          const cs = getComputedStyle(h);
          const l = h.querySelector('.code-block-lang').getBoundingClientRect();
          const b = h.querySelector('.copy-btn').getBoundingClientRect();
          const r = h.getBoundingClientRect();
          return { dir: cs.flexDirection, pad: [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft], gap: b.top - l.bottom, labelTop: l.top - r.top, btnW: b.width, inner: r.width - 30, overlap: l.left < b.right && l.right > b.left && l.top < b.bottom && l.bottom > b.top };
        })), { height: 812 });
        if (!hs) return;
        assert.ok(hs.length > 0, `positive control: ${route} has a code block header`);
        for (const h of hs) {
          assert.equal(h.dir, 'column', 'stacked, label above the button');
          assert.deepEqual(h.pad, ['16px', '15px', '16px', '15px'], '16 above and below, 15 beside (the 1px frame makes it 16 from the outer edge)');
          assert.ok(Math.abs(h.gap - 8) <= 0.5, `8 between the label and the button (${h.gap})`);
          assert.ok(Math.abs(h.btnW - h.inner) <= 0.5, `the button is full width (${h.btnW} of ${h.inner})`);
          assert.ok(Math.abs(h.labelTop - 16) <= 0.5, `the label sits 16 below the header's top (${h.labelTop})`);
          assert.equal(h.overlap, false, 'the label and the button never overlap');
        }
      });
    }
  }

  for (const width of [600, 481]) {
    it(`code block headers at ${width}: a row, and the label and the button never overlap`, async (t) => {
      for (const route of ['/', '/for-agents', '/how-it-works', '/api']) {
        const hs = await at(t, width, route, (page) => page.evaluate(() => [...document.querySelectorAll('.code-block-header')].filter((h) => h.getBoundingClientRect().width > 0).map((h) => {
          const l = h.querySelector('.code-block-lang').getBoundingClientRect();
          const b = h.querySelector('.copy-btn').getBoundingClientRect();
          return { dir: getComputedStyle(h).flexDirection, overlap: l.left < b.right && l.right > b.left && l.top < b.bottom && l.bottom > b.top };
        })), { height: 900 });
        if (!hs) return;
        assert.ok(hs.length > 0, `positive control: ${route} has a header`);
        for (const h of hs) { assert.equal(h.dir, 'row'); assert.equal(h.overlap, false, `${route}: the label and the button never overlap`); }
      }
    });
  }

  // At phone width a code block has one inset: the header's label and the code both start 16 from the frame's
  // outer edge (its 1px border plus 15 of padding), on every block of every page, the asks included. Both are
  // measured in the same page from the frame's own left edge: the label by its text, the code by the left of its
  // content box (the ask draws a dim "$ " in front of the command, so its first glyph is the prompt, not the text).
  for (const width of [480, 375]) {
    for (const route of ['/', '/connect', '/for-agents', '/for-builders', '/how-it-works', '/api']) {
      it(`every code block at ${width} on ${route}: the header label and the code both start 16 from the frame's outer edge, and both end 16 from its other edge`, async (t) => {
        const bs = await at(t, width, route, (page) => page.evaluate(() => [...document.querySelectorAll('.code-block')].filter((b) => b.querySelector('.code-block-lang') && b.querySelector('pre') && b.getBoundingClientRect().width > 0).map((b) => {
          const f = b.getBoundingClientRect();
          const textBox = (el) => { const rg = document.createRange(); rg.selectNodeContents(el); const rs = [...rg.getClientRects()].filter((x) => x.width > 0); return { l: Math.min(...rs.map((x) => x.left)), r: Math.max(...rs.map((x) => x.right)) }; };
          const lang = textBox(b.querySelector('.code-block-lang'));
          const btn = b.querySelector('.copy-btn').getBoundingClientRect();
          const pre = b.querySelector('pre');
          const pcs = getComputedStyle(pre);
          const bcs = getComputedStyle(b);
          return {
            id: b.id || b.className,
            label: lang.l - f.left,
            code: pre.getBoundingClientRect().left + parseFloat(pcs.borderLeftWidth) + parseFloat(pcs.paddingLeft) - f.left,
            button: [btn.left - f.left, f.right - btn.right],
            padPre: [parseFloat(pcs.paddingLeft) + parseFloat(bcs.borderLeftWidth), parseFloat(pcs.paddingRight) + parseFloat(bcs.borderRightWidth)],
          };
        })), { height: 812 });
        if (!bs) return;
        assert.ok(bs.length > 0, `positive control: ${route} has a code block with a header`);
        for (const b of bs) {
          assert.ok(Math.abs(b.label - 16) <= 0.5, `${b.id}: the header label starts ${b.label}px from the frame`);
          assert.ok(Math.abs(b.code - 16) <= 0.5, `${b.id}: the code starts ${b.code}px from the frame`);
          assert.ok(Math.abs(b.code - b.label) <= 0.5, `${b.id}: the code and the header label share one left edge`);
          assert.ok(Math.abs(b.button[0] - 16) <= 0.5 && Math.abs(b.button[1] - 16) <= 0.5, `${b.id}: the full-width button is 16 from each side of the frame (${b.button})`);
          assert.ok(Math.abs(b.padPre[0] - 16) <= 0.5 && Math.abs(b.padPre[1] - 16) <= 0.5, `${b.id}: the code's padding plus frame is 16 each side (${b.padPre})`);
        }
      });
    }
  }

  // No drawing is more than a third skeleton bars: the boxes of each run of bars (the union of the bars that share
  // a parent) over the drawing's own box, in the same page.
  for (const width of [1280, 768, 375]) {
    it(`the homepage drawings at ${width}: skeleton bars fill at most a third of each`, async (t) => {
      const r = await at(t, width, '/', (page) => page.evaluate(() => {
        const drawings = [['exchange', '.hx'], ['window', '.dw-window'], ['explainer', '#learning-explainer .dw-stage'], ['recall', '#own-learnings-free .dw-stage'], ['step 1', '.step:nth-child(1) .step-art'], ['step 2', '.step:nth-child(2) .step-art'], ['step 3', '.step:nth-child(3) .step-art']];
        return drawings.map(([name, sel]) => {
          const d = document.querySelector(sel);
          const db = d.getBoundingClientRect();
          const groups = new Map();
          for (const sk of d.querySelectorAll('.dw-sk')) {
            const b = sk.getBoundingClientRect();
            const g = groups.get(sk.parentElement) || { l: 1e9, t: 1e9, r: -1e9, b: -1e9 };
            g.l = Math.min(g.l, b.left); g.t = Math.min(g.t, b.top); g.r = Math.max(g.r, b.right); g.b = Math.max(g.b, b.bottom);
            groups.set(sk.parentElement, g);
          }
          let area = 0;
          for (const g of groups.values()) area += (g.r - g.l) * (g.b - g.t);
          return { name, share: area / (db.width * db.height), bars: d.querySelectorAll('.dw-sk').length };
        });
      }));
      if (!r) return;
      assert.equal(r.length, 7, 'all seven drawings were measured');
      assert.ok(r.every((d) => d.bars > 0), 'positive control: every drawing has skeleton bars to measure');
      for (const d of r) assert.ok(d.share <= 1 / 3, `${d.name} is ${(d.share * 100).toFixed(0)}% skeleton bars`);
    });
  }

  // The skeleton share the area way: the sum of every bar's own box over the drawing's box, taken in one page, for
  // each drawing, each of the dark panels in them, and the recall drawing's long panel. A probe drawing built in the
  // same page from the same bar class, with one bar over half its box, proves the measure can tell a slab from a
  // sparse drawing: it reads above a third, so the check can fail.
  for (const width of [1280, 768, 375]) {
    it(`the homepage drawings at ${width}: the skeleton bars' own boxes sum to at most a third of each drawing's box`, async (t) => {
      const r = await at(t, width, '/', (page) => page.evaluate(() => {
        const share = (d) => {
          const db = d.getBoundingClientRect();
          let area = 0;
          for (const sk of d.querySelectorAll('.dw-sk')) { const b = sk.getBoundingClientRect(); area += b.width * b.height; }
          return { share: area / (db.width * db.height), bars: d.querySelectorAll('.dw-sk').length };
        };
        const named = [['exchange', '.hx'], ['window', '.dw-window'], ['explainer', '#learning-explainer .dw-stage'], ['recall', '#own-learnings-free .dw-stage'], ['recall long panel', '#own-learnings-free .dw-long'], ['step 1', '.step:nth-child(1) .step-art'], ['step 2', '.step:nth-child(2) .step-art'], ['step 3', '.step:nth-child(3) .step-art']]
          .map(([name, sel]) => [name, document.querySelector(sel)]);
        const drawn = named.length;
        for (const [i, p] of [...document.querySelectorAll('.hx .dw-dark, #own-learnings-free .dw-dark')].entries()) named.push([`dark panel ${i + 1}`, p]);
        const probe = document.createElement('div');
        probe.style.cssText = 'width:200px;height:60px;position:absolute;left:0;top:0;color:#888';
        probe.innerHTML = '<span class="dw-sk" style="width:100%;height:32px"></span>';
        document.body.appendChild(probe);
        const control = share(probe).share;
        probe.remove();
        return { control, drawn, drawings: named.map(([name, d]) => ({ name, ...share(d) })) };
      }));
      if (!r) return;
      assert.ok(r.control > 1 / 3, `positive control: a probe drawing with a bar over half its box reads ${(r.control * 100).toFixed(0)}%, above a third`);
      assert.ok(r.drawings.length >= 12, `every drawing and every dark panel was measured (${r.drawings.length})`);
      assert.ok(r.drawings.slice(0, r.drawn).every((d) => d.bars > 0), 'positive control: every drawing has bars to measure');
      for (const d of r.drawings) assert.ok(d.share <= 1 / 3, `${d.name} is ${(d.share * 100).toFixed(1)}% skeleton bars by area`);
    });

    it(`the explainer holds at most three bars and the recall drawing's long panel at most four, a category chip between any two bars, at ${width}`, async (t) => {
      const m = await at(t, width, '/', (page) => page.evaluate(() => {
        const run = (root) => [...root.querySelectorAll('.dw-sk, .dw-chip')].map((e) => (e.classList.contains('dw-sk') ? 'bar' : 'chip'));
        const explainer = document.querySelector('#learning-explainer .dw-stage');
        const long = document.querySelector('#own-learnings-free .dw-long');
        return { explainer: run(explainer), long: run(long) };
      }));
      if (!m) return;
      const adjacent = (a) => a.some((x, i) => x === 'bar' && a[i + 1] === 'bar');
      assert.ok(m.explainer.includes('chip') && m.long.includes('chip'), 'positive control: both carry category chips');
      assert.ok(m.explainer.filter((x) => x === 'bar').length <= 3, `the explainer keeps at most three bars (${m.explainer.filter((x) => x === 'bar').length})`);
      assert.ok(m.long.filter((x) => x === 'bar').length <= 4, `the long panel keeps at most four bars (${m.long.filter((x) => x === 'bar').length})`);
      assert.ok(!adjacent(m.long), `no two bars stand side by side in the long panel: ${m.long.join(' ')}`);
      assert.ok(adjacent(['bar', 'bar', 'chip']) && !adjacent(['bar', 'chip', 'bar']), 'control: the adjacency check tells side by side from interleaved');
    });
  }

  // Stacked, the long panel is full width: its bars stay at 40% of its content width or less, so it never reads as a slab.
  for (const width of [480, 375]) {
    it(`the recall drawing's long panel at ${width}: every bar is at most 40% of its content width, with chips between`, async (t) => {
      const m = await at(t, width, '/', (page) => page.evaluate(() => {
        const long = document.querySelector('#own-learnings-free .dw-long');
        const cs = getComputedStyle(long);
        const content = long.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
        const short = document.querySelector('#own-learnings-free .dw-twoup > .dw-dark:not(.dw-long)').getBoundingClientRect();
        const lr = long.getBoundingClientRect();
        return { content, bars: [...long.querySelectorAll('.dw-sk')].map((b) => b.getBoundingClientRect().width), chips: long.querySelectorAll('.dw-chip').length, stacked: short.top >= lr.bottom };
      }));
      if (!m) return;
      assert.ok(m.stacked, 'positive control: the two panels are stacked at this width');
      assert.ok(m.bars.length >= 3 && m.chips >= 3, `positive control: the long panel has bars (${m.bars.length}) and chips (${m.chips})`);
      for (const w of m.bars) assert.ok(w <= m.content * 0.4 + 0.5, `a bar is ${w}px of ${m.content}px, more than 40%`);
    });
  }

  for (const width of [1280, 375]) {
    it(`the review card in step 2 at ${width}: the chip holds one line and clears the buttons`, async (t) => {
      const m = await at(t, width, '/', (page) => page.evaluate(() => {
        const head = document.querySelector('.step-review-head');
        const chip = head.querySelector('.dw-chip').getBoundingClientRect();
        const btns = head.querySelector('.dw-btns').getBoundingClientRect();
        const card = document.querySelector('.step-review').getBoundingClientRect();
        return { chipH: chip.height, chipR: chip.right, btnsL: btns.left, btnsR: btns.right, cardR: card.right, cardL: card.left, chipL: chip.left };
      }));
      if (!m) return;
      assert.ok(m.chipH < 26, `the chip is one line (${m.chipH}px)`);
      assert.ok(m.chipR <= m.btnsL, 'the chip clears the buttons');
      assert.ok(m.chipL >= m.cardL && m.btnsR <= m.cardR, 'both sit inside the card');
    });
  }

  // ── the scroll cue ──
  it('a code block that scrolls sideways keeps a thin scrollbar: /api at 375', async (t) => {
    const r = await at(t, 375, '/api', (page) => page.evaluate(() => {
      const pres = [...document.querySelectorAll('.code-block pre')];
      const wide = pres.filter((p) => p.scrollWidth > p.clientWidth + 1);
      const first = wide[0];
      const cs = first ? getComputedStyle(first) : null;
      return { count: pres.length, wide: wide.length, width: cs && cs.scrollbarWidth, color: cs && cs.scrollbarColor };
    }));
    if (!r) return;
    assert.ok(r.count > 0, 'positive control: the page has code blocks');
    assert.ok(r.wide > 0, 'positive control: at least one block scrolls sideways at 375');
    assert.equal(r.width, 'thin');
    assert.equal(r.color, 'rgba(250, 250, 248, 0.35) rgba(0, 0, 0, 0)');
  });

  // ── the footer meta line ──
  for (const width of [1280, 768, 480, 375]) {
    it(`the footer meta line at ${width}: 14px, starting at the logo's left edge, and no link breaks across two lines`, async (t) => {
      const f = await at(t, width, '/', (page) => page.evaluate(() => {
        const meta = document.querySelector('footer .footer-meta');
        const logo = document.querySelector('footer .footer-logo');
        const cs = getComputedStyle(meta);
        const links = [...meta.querySelectorAll('a')].map((a) => ({ rects: a.getClientRects().length, nowrap: getComputedStyle(a).whiteSpace }));
        return {
          size: cs.fontSize,
          align: cs.textAlign,
          line: parseFloat(cs.lineHeight) / parseFloat(cs.fontSize),
          metaLeft: meta.getBoundingClientRect().left,
          logoLeft: logo.getBoundingClientRect().left,
          links,
        };
      }));
      if (!f) return;
      assert.equal(f.size, '14px');
      assert.ok(f.links.length >= 5, 'positive control: the links were found');
      assert.ok(['left', 'start'].includes(f.align), `left aligned, not centred (${f.align})`);
      if (width <= 900) assert.ok(Math.abs(f.metaLeft - f.logoLeft) <= 0.5, `stacked, the text starts under the logo: ${f.metaLeft} vs ${f.logoLeft}`);
      if (width <= 480) {
        assert.ok(f.links.every((l) => l.nowrap === 'nowrap'), 'each link is no-wrap');
        assert.ok(f.line >= 1.7, `a comfortable line height (${f.line})`);
      }
      assert.ok(f.links.every((l) => l.rects === 1), 'no link is split across two lines');
    });
  }
});
