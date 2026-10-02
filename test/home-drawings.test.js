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
 *   - the device is one shared background image on the first dark section of every page, 12% ivory, no gold
 *   - the two hero notes take the body colour and 15px from 481 up, 14px below
 *   - the recall drawing shows the same learning in both panels, the short way's card dominant and the long way's dimmed
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
const IVORY_DEVICE = 'rgba(250, 250, 248, 0.07)';
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

  // Round 3: the device is no longer markup. One shared rule paints the mark's own geometry (the two
  // sides of the triangle and its crossbar) as a background image on the first dark section of every page.
  // Two inline svg data URIs carry it, one at desktop size and one at the size a tablet and a phone get.
  const deviceSvg = (name) => {
    const m = css.match(new RegExp(`${name}:\\s*url\\("data:image/svg\\+xml,([^"]*)"\\)`));
    assert.ok(m, `${name} is defined as an svg data URI`);
    return decodeURIComponent(m[1]);
  };

  it('the device is one faint ivory line for both strokes, 1.5px at the size it is drawn, with no gold', () => {
    for (const [name, drawn] of [['--device', 1300], ['--device-small', 806]]) {
      const svg = deviceSvg(name);
      assert.ok(/<path /.test(svg) && /<line /.test(svg), `${name} draws the triangle's sides and its crossbar`);
      assert.match(svg, /stroke='#FAFAF8'/, `${name} is ivory`);
      assert.match(svg, /stroke-opacity='\.12'/, `${name} is 12% ivory`);
      assert.ok(!/201,\s*168,\s*76|aurum|c9a84c/i.test(svg), `${name} carries no gold`);
      const width = Number(svg.match(/\swidth='(\d+)'/)[1]);
      const strokeWidth = Number(svg.match(/stroke-width='([\d.]+)'/)[1]);
      assert.equal(width, drawn, `${name} is drawn at ${drawn}px`);
      // the viewBox is 1300 wide, so the rendered line is the stroke width scaled by drawn / 1300
      assert.ok(Math.abs(strokeWidth * (width / 1300) - 1.5) <= 0.02, `${name} renders a 1.5px line (${strokeWidth * (width / 1300)})`);
    }
    // positive control: the rule that paints it is on the first dark section, and it is not on a dark ground rule
    assert.match(css, /main > \.on-dark:first-child,[\s\S]*?background-image:\s*var\(--device\)/, 'the shared rule paints --device on main > .on-dark:first-child');
    assert.ok(/body \.legal-wrap > h1::before/.test(css), 'the legal template\'s hero band takes it too');
    assert.ok(/\.dash-wrap > \.dash-band:first-child/.test(css), 'the dashboard header band takes it too');
  });

  it('the device keeps the dimmest text on the dark ground above 4.5 to 1, even directly under the line', () => {
    // 12% ivory over #0A0A0A, then the contrast of the dimmest on-dark text (#8B929A) against that
    const lum = (rgb) => { const c = rgb.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
    const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
    const under = [10, 10, 10].map((d, i) => d * 0.88 + [250, 250, 248][i] * 0.12);
    assert.ok(ratio([0x8B, 0x92, 0x9A], under) >= 4.5, `the dimmest note colour keeps ${ratio([0x8B, 0x92, 0x9A], under).toFixed(2)} to 1 under the line`);
    assert.ok(ratio([0xA7, 0xAC, 0xB2], under) > ratio([0x8B, 0x92, 0x9A], under), 'positive control: the body colour keeps more than the note colour');
  });

  it('the recall drawing holds the same card twice: the same chip and the same title, in both panels', () => {
    const sec = html.match(/<section id="own-learnings-free"[\s\S]*?<\/section>/)[0];
    assert.match(sec, /<div class="dw-stage pair-art" aria-hidden="true">/, 'the drawing stays hidden from assistive tech');
    const cards = [...sec.matchAll(/<div class="dw-panel dw-light dw-found">([\s\S]*?)<\/div>/g)].map((m) => m[1]);
    assert.equal(cards.length, 2, 'two cards');
    assert.equal(cards[0], cards[1], 'the same markup in both');
    assert.ok(cards[0].includes('<span class="dw-chip">storage-state</span>'), 'the chip');
    assert.ok(cards[0].includes(`<span class="dw-title">${TITLE}</span>`), 'the title');
    const panels = sec.split('<div class="dw-panel dw-dark').slice(1);
    assert.equal(panels.length, 2, 'two dark panels');
    assert.ok(panels[0].startsWith(' dw-long dw-term"'), 'the first is the tall panel');
    assert.ok(/<span class="dw-sk w40 lit"><\/span>\s*<div class="dw-panel dw-light dw-found">/.test(panels[0]), 'its card sits at its foot, after the dim lines');
    assert.ok(/<span class="dw-tool">auxilo_knowledge<\/span><\/div>\s*<div class="dw-panel dw-light dw-found">/.test(panels[1]), 'the short panel is one tool row with the card directly under it');
    assert.equal((panels[1].match(/auxilo_knowledge/g) || []).length, 1, 'one tool row');
    // positive control for the counts above: the same title still stands in the queue and the explainer
    assert.equal(html.split(TITLE).length - 1, 4, 'the title stands in the queue, the explainer and the two recall cards');
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
  // The first dark section of every page carries the shared background image, at the size and anchor the
  // viewport gets, and never gold. A page that still draws its own inline device does not show it.
  const FIRST_DARK = 'main > .on-dark:first-child';
  for (const route of ['/', '/for-builders', '/pricing', '/about', '/status']) {
    it(`the device on ${route} at 1280: the shared image on the first dark section, anchored right, 1300px, no gold`, async (t) => {
      const d = await at(t, 1280, route, (page) => page.evaluate((sel) => {
        const el = document.querySelector(sel);
        const cs = el ? getComputedStyle(el) : null;
        const clip = document.querySelector('.dw-device-clip');
        return cs && { image: cs.backgroundImage, size: cs.backgroundSize, pos: cs.backgroundPosition, repeat: cs.backgroundRepeat, clipShown: clip ? getComputedStyle(clip).display !== 'none' : false };
      }, FIRST_DARK));
      if (!d) return;
      assert.match(d.image, /^url\("data:image\/svg\+xml,/, 'the first dark section paints the device svg');
      assert.ok(!/201,\s*168,\s*76|c9a84c|aurum/i.test(decodeURIComponent(d.image)), 'no gold in it');
      assert.equal(d.size, '1300px 1300px');
      assert.equal(d.repeat, 'no-repeat');
      assert.match(d.pos, /^calc\(100% [+-] \d+px\) /, 'anchored to the right edge (a calc on 100%)');
      assert.equal(d.clipShown, false, 'no inline clipping wrapper is drawn on the page');
    });
  }

  it('the device on the legal template band: the same image, on the h1\'s ::before', async (t) => {
    const d = await at(t, 1280, '/terms', (page) => page.evaluate(() => {
      const h1 = document.querySelector('.legal-wrap > h1');
      const cs = getComputedStyle(h1, '::before');
      return { image: cs.backgroundImage, size: cs.backgroundSize, width: parseFloat(cs.width), vw: window.innerWidth };
    }));
    if (!d) return;
    assert.match(d.image, /^url\("data:image\/svg\+xml,/);
    assert.equal(d.size, '1300px 1300px');
    assert.equal(d.width, d.vw, 'positive control: the band is the full width of the window');
  });

  for (const [width, size] of [[768, '806px 806px'], [375, '806px 806px']]) {
    it(`the device at ${width}: a cropped corner of the same drawing, drawn smaller, still behind the first dark section`, async (t) => {
      const d = await at(t, width, '/', (page) => page.evaluate((sel) => {
        const cs = getComputedStyle(document.querySelector(sel));
        return { image: cs.backgroundImage, size: cs.backgroundSize, scrollW: document.documentElement.scrollWidth };
      }, FIRST_DARK));
      if (!d) return;
      assert.match(d.image, /^url\("data:image\/svg\+xml,/);
      assert.equal(d.size, size);
      assert.ok(/stroke-width='2\.42'/.test(decodeURIComponent(d.image)), 'the small drawing still renders a 1.5px line');
      assert.ok(d.scrollW <= width, 'the device adds no sideways scroll');
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
  it('the recall drawing at 1280: bottoms aligned, the long way taller, the short way\'s card the dominant one and the long way\'s dimmed', async (t) => {
    const m = await at(t, 1280, '/', (page) => page.evaluate(() => {
      const panels = [...document.querySelectorAll('#own-learnings-free .dw-twoup > .dw-dark')].map((p) => p.getBoundingClientRect());
      const found = [...document.querySelectorAll('#own-learnings-free .dw-found')];
      const cards = found.map((c) => c.getBoundingClientRect());
      return {
        panels: panels.map((r) => ({ t: r.top, b: r.bottom, w: r.width })),
        cards: cards.map((r) => ({ t: r.top, b: r.bottom, h: r.height, w: r.width })),
        opacity: found.map((c) => parseFloat(getComputedStyle(c).opacity)),
        title: found.map((c) => parseFloat(getComputedStyle(c.querySelector('.dw-title')).fontSize)),
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
    assert.equal(m.opacity[0], 0.6, 'the long way keeps its small card at the foot, dimmed to 60%');
    assert.equal(m.opacity[1], 1, 'the short way\'s card is at full contrast');
    assert.equal(m.title[1], 16, 'its title is 16px');
    assert.ok(m.title[0] < m.title[1], 'positive control: the dimmed card\'s title is smaller');
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
