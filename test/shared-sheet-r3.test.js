'use strict';

/**
 * test/shared-sheet-r3.test.js: the shared rules that changed in round 3, and the homepage's wide section.
 *
 * What it pins (the source, then the render from the staged real server, every number compared inside one run):
 *   - the h1 scale: 48 to 64 at 1025 and up, 40 to 56 at 1024 and down, so a tablet's headline is larger than a phone's
 *   - the accessibility rules of the shared sheet: the fixed navigation's clearance on every anchor jump and focus,
 *     smooth scrolling off under reduced motion, a focused code scroller's ring drawn inside its box
 *   - reading pages share one frame: the hero copy and the body start on the same left edge, the legal pages' edge
 *   - a block label that acts as a section heading is the serif at 30px
 *   - the homepage's wide section: copy in a 60ch column, 48 under it one window the full content width, the kill
 *     switch chip inside its bottom right corner at every width, the rows stacked at 900 and down
 *   - the homepage band label, closing note and footer links: no lone word, 44px and 24px targets on a phone
 *
 * Runner: node --test test/shared-sheet-r3.test.js
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

describe('shared sheet, round 3: the source', () => {
  const css = read('public/styles.css');
  const html = read('public/index.html');
  const pageStyle = html.match(/<style>([\s\S]*?)<\/style>/)[1];

  it('the h1 scale is 48 to 64 at 1025 and up and 40 to 56 at 1024 and down', () => {
    assert.match(css, /:root\s*\{[^}]*--h1:\s*clamp\(48px,\s*5vw,\s*64px\);/);
    const tablet = mediaBlock(css, '@media (max-width: 1024px) {\n  :root { --h1');
    assert.ok(tablet, 'the 1024-and-down block that sets --h1 is found');
    assert.match(tablet, /--h1:\s*clamp\(40px,\s*6\.2vw,\s*56px\)/);
  });

  it('every anchor jump and focused control clears the fixed navigation at every width', () => {
    const rule = css.match(/^html\s*\{([^}]*)\}/m);
    assert.ok(rule, 'the html rule is found');
    assert.match(rule[1], /scroll-padding-top:\s*var\(--nav-clear\)/);
    // positive control: the 900-and-down block keeps its own larger header clearance
    assert.match(css, /html\s*\{\s*scroll-padding-top:\s*var\(--header-h\);\s*\}/);
  });

  it('smooth scrolling is off under reduced motion', () => {
    const block = mediaBlock(css, '@media (prefers-reduced-motion: reduce)');
    assert.ok(block, 'the reduced-motion block is found');
    assert.match(block, /html\s*\{\s*scroll-behavior:\s*auto;\s*\}/);
    assert.match(css, /^html\s*\{[^}]*scroll-behavior:\s*smooth/m, 'positive control: smooth stays the default');
  });

  it('a focused code scroller draws its ring inside its own box', () => {
    assert.match(css, /^pre:focus-visible\s*\{\s*outline-offset:\s*-4px;\s*\}/m);
    assert.match(css, /^\*:focus-visible\s*\{[^}]*outline-offset:\s*2px/m, 'positive control: every other control keeps the 2px offset');
  });

  it('a block label that acts as a section heading is the serif at 30px, weight 300, whatever its tag', () => {
    const rule = css.match(/main \.component-label,\s*main \.ww-key-lead\s*\{([^}]*)\}/);
    assert.ok(rule, 'the label rule is found');
    assert.match(rule[1], /font-family:\s*var\(--serif\)/);
    assert.match(rule[1], /font-size:\s*30px/);
    assert.match(rule[1], /font-weight:\s*300/);
    assert.match(rule[1], /color:\s*var\(--fg-1\)/);
  });

  it('a one-sentence callout has a lede line to be set as (19px, heading ink), not a card', () => {
    const rule = css.match(/^\.lede-line\s*\{([^}]*)\}/m);
    assert.ok(rule, '.lede-line is found');
    assert.match(rule[1], /font-size:\s*19px/);
    assert.match(rule[1], /color:\s*var\(--fg-1\)/);
    assert.ok(!/border|background|padding|box-shadow/.test(rule[1]), 'it carries no box');
  });

  it('the reading frame is named for every reading page and sets one column width', () => {
    const rule = css.match(/:is\(#about-hero, #connect-hero, #writing-hero, #essay-hero\) \.hero-one > \*,[\s\S]*?\{([^}]*)\}/);
    assert.ok(rule, 'the reading-frame rule is found');
    for (const sel of ['#about-body .read > *', '#connect-steps-section .container > *', '#writing-entries .container > *', '#essay-body .essay-body > *']) {
      assert.ok(css.includes(sel), `${sel} is in the frame`);
    }
    assert.match(rule[1], /--read-w:\s*calc\(720px - 2 \* var\(--gutter-base\)\)/);
  });

  it('the band, the closing note and the footer links are set so no word is left alone and no target is small', () => {
    const band = pageStyle.match(/\.ww-band-eyebrow\s*\{([^}]*)\}/)[1];
    assert.match(band, /text-wrap:\s*balance/);
    assert.match(pageStyle.match(/\.ww-band-wrap\s*\{([^}]*)\}/)[1], /grid-template-columns:\s*260px 1fr/);
    assert.ok(!/white-space:\s*nowrap/.test(pageStyle.match(/\.ww-band-name\s*\{([^}]*)\}/)[1]), 'a client name wraps rather than clips');
    assert.match(css.match(/^\.footer-cta-note\s*\{([^}]*)\}/m)[1], /text-wrap:\s*balance/);
    const phone = mediaBlock(css, '@media (max-width: 600px) {\n  .footer-cta-note a');
    assert.ok(phone && /padding:\s*11px 0;[\s\S]*margin:\s*-11px 0/.test(phone), 'the setup link is a 44px target that costs the note no height');
    assert.match(mediaBlock(css, '@media (max-width: 480px) {\n  .lede,') || '', /\.footer-meta a\s*\{[^}]*display:\s*inline-block/, 'a footer meta link is a box of its own on a phone');
    // positive control: the category chip no longer clips
    const cat = css.match(/^\.discovery-cat\s*\{([^}]*)\}/m)[1];
    assert.ok(!/nowrap|text-overflow|overflow:\s*hidden/.test(cat), 'the catalog category chip wraps instead of clipping');
    assert.match(cat, /overflow-wrap:\s*anywhere/);
  });

  it('the three step cards are a list: the container and each card carry the role', () => {
    const steps = html.match(/<div class="steps"([^>]*)>/);
    assert.ok(steps && /role="list"/.test(steps[1]), 'the container is a list');
    assert.equal((html.match(/<div class="step" role="listitem">/g) || []).length, 3, 'three list items');
    assert.equal((html.match(/<div class="step"[^>]*>/g) || []).length, 3, 'positive control: three cards in all');
  });
});

describe('shared sheet, round 3: the render', { timeout: 240_000 }, () => {
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
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auxilo-shared-sheet-r3-'));
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
        SESSION_SECRET: 'shared-sheet-r3-test-session-secret-01234',
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

  async function at(t, width, route, fn) {
    if (bootSkipReason) { t.skip(bootSkipReason); return undefined; }
    if (!playwrightOk) { t.skip('playwright not resolvable'); return undefined; }
    const ctx = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    try {
      await page.goto(`${baseUrl}${route}`, { waitUntil: 'networkidle' });
      await page.evaluate(() => document.fonts.ready);
      return await fn(page);
    } finally {
      await ctx.close();
    }
  }

  // ── the h1 scale ──
  it('the h1 is larger on a tablet than on a phone, and takes the scale at every width (compared with the token in the same run)', async (t) => {
    const sizes = {};
    for (const width of [375, 768, 1024, 1025, 1280, 1440]) {
      const m = await at(t, width, '/', (page) => page.evaluate(() => {
        const h1 = parseFloat(getComputedStyle(document.querySelector('#hero-heading')).fontSize);
        const probe = document.createElement('i');
        probe.style.fontSize = 'var(--h1)';
        document.body.appendChild(probe);
        const token = parseFloat(getComputedStyle(probe).fontSize);
        probe.remove();
        return { h1, token, vw: window.innerWidth };
      }));
      if (!m) return;
      assert.ok(Math.abs(m.h1 - m.token) <= 0.01, `${width}: the hero h1 (${m.h1}) is the --h1 token (${m.token})`);
      sizes[width] = m.h1;
    }
    assert.equal(sizes[375], 40, 'a phone is 40');
    assert.ok(sizes[768] > sizes[375] + 4, `a tablet (${sizes[768]}) has a larger headline than a phone (${sizes[375]})`);
    assert.equal(sizes[1024], 56, 'the tablet scale tops out at 56');
    assert.ok(sizes[1025] >= 48 && sizes[1025] < sizes[1024], 'at 1025 the desktop scale starts at 48 and up');
    assert.equal(sizes[1440], 64, 'the desktop scale tops out at 64');
  });

  for (const route of ['/', '/for-builders', '/for-agents', '/pricing', '/how-submissions-work']) {
    it(`the h1 on ${route} never leaves a single word alone on a line at 375, 768, 1024 and 1280`, async (t) => {
      for (const width of [375, 768, 1024, 1280]) {
        const m = await at(t, width, route, (page) => page.evaluate(() => {
          const el = document.querySelector('h1');
          const tops = [];
          const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
          let node;
          while ((node = walker.nextNode())) {
            const re = /\S+/g; let mm;
            while ((mm = re.exec(node.textContent))) {
              const range = document.createRange();
              range.setStart(node, mm.index); range.setEnd(node, mm.index + mm[0].length);
              const r = range.getClientRects()[0];
              if (r) tops.push(Math.round(r.top));
            }
          }
          const lines = [];
          for (const top of tops) {
            let line = lines.find((l) => Math.abs(l.top - top) <= 3);
            if (!line) { line = { top, count: 0 }; lines.push(line); }
            line.count += 1;
          }
          return { words: tops.length, lines: lines.length, lone: lines.length > 1 && lines.some((l) => l.count === 1) };
        }));
        if (!m) return;
        assert.ok(m.words > 3, `positive control: the h1 on ${route} was read (${m.words} words)`);
        assert.equal(m.lone, false, `${route} h1 at ${width}: a single word is alone on a line`);
      }
    });
  }

  // ── the anchors ──
  it('the fixed navigation clears every anchor jump and focus at 1280 as well as on a phone', async (t) => {
    for (const width of [1280, 375]) {
      const m = await at(t, width, '/', (page) => page.evaluate(() => {
        const nav = document.querySelector('#main-nav').getBoundingClientRect();
        return { pad: parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop), navBottom: nav.bottom };
      }));
      if (!m) return;
      assert.ok(m.pad >= m.navBottom - 0.5, `${width}: scroll-padding-top ${m.pad} clears the navigation, which ends at ${m.navBottom}`);
    }
  });

  // ── the reading frame ──
  const READING = [
    ['/about', '#about-hero h1', '#about-body p'],
    ['/connect', '#connect-hero h1', '#connect-steps-section .connect-steps'],
    ['/writing', '#writing-hero h1', '#writing-entries .entries'],
    ['/writing/agents-message-board', '#essay-hero h1', '#essay-body .essay-body > p'],
    ['/terms', '.legal-wrap > h1', '.legal-wrap > h2'],
  ];
  for (const width of [1280, 768, 375]) {
    it(`reading pages at ${width}: the hero copy and the body share one left edge, and it is the legal pages' edge`, async (t) => {
      const edges = {};
      for (const [route, hero, body] of READING) {
        const m = await at(t, width, route, (page) => page.evaluate(([h, b]) => {
          const left = (sel) => { const el = document.querySelector(sel); return el ? el.getBoundingClientRect().left : null; };
          return { hero: left(h), body: left(b) };
        }, [hero, body]));
        if (!m) return;
        assert.ok(m.hero !== null && m.body !== null, `${route}: both the hero copy and the body were found`);
        assert.ok(Math.abs(m.hero - m.body) <= 0.5, `${route} @ ${width}: hero copy at ${m.hero}, body at ${m.body}`);
        edges[route] = m.hero;
      }
      for (const route of Object.keys(edges)) {
        assert.ok(Math.abs(edges[route] - edges['/terms']) <= 0.5, `${route} @ ${width}: ${edges[route]} against the legal pages' ${edges['/terms']}`);
      }
      if (width === 1280) assert.equal(edges['/terms'], 304, 'positive control: the legal edge is 304 at 1280');
    });
  }

  // ── the section labels ──
  it('/status: the section labels are the serif at 30px, and /works-with: the key lead is the same', async (t) => {
    const s = await at(t, 1280, '/status', (page) => page.evaluate(() => [...document.querySelectorAll('.component-label')].map((el) => { const cs = getComputedStyle(el); return { family: cs.fontFamily, size: cs.fontSize, weight: cs.fontWeight }; })));
    if (!s) return;
    assert.equal(s.length, 4, 'four labels');
    for (const l of s) { assert.match(l.family, /Newsreader/); assert.equal(l.size, '30px'); assert.equal(l.weight, '300'); }
    const w = await at(t, 1280, '/works-with', (page) => page.evaluate(() => { const cs = getComputedStyle(document.querySelector('.ww-key-lead')); return { family: cs.fontFamily, size: cs.fontSize }; }));
    assert.match(w.family, /Newsreader/);
    assert.equal(w.size, '30px');
  });

  // ── the homepage's wide section ──
  for (const width of [1280, 768, 375]) {
    it(`homepage @ ${width}: copy in a 60ch column, 48 under it one window the full content width, the kill-switch chip inside its bottom right corner`, async (t) => {
      const m = await at(t, width, '/', (page) => page.evaluate(() => {
        const box = (el) => { const r = el.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width, h: r.height }; };
        const sec = document.querySelector('#setup-detail');
        const container = sec.querySelector(':scope > .container');
        const cc = getComputedStyle(container);
        const copy = box(sec.querySelector('.setup-copy'));
        const win = sec.querySelector('.dw-window');
        const chip = box(win.querySelector('.dw-kill'));
        const probe = document.createElement('i');
        probe.style.display = 'block'; probe.style.width = '60ch'; probe.style.fontSize = getComputedStyle(sec.querySelector('.setup-copy p')).fontSize; probe.style.fontFamily = getComputedStyle(sec.querySelector('.setup-copy p')).fontFamily;
        sec.appendChild(probe);
        const ch60 = probe.getBoundingClientRect().width; probe.remove();
        const cats = [...win.querySelectorAll('.dw-window-cats .dw-chip')].map((c) => Math.round(c.getBoundingClientRect().top));
        const rows = [...win.querySelectorAll('.dw-window-row')];
        const first = rows[0];
        const btns = first.querySelector('.dw-btns').getBoundingClientRect();
        const text = first.querySelector('.dw-window-text').getBoundingClientRect();
        return {
          container: box(container),
          padL: parseFloat(cc.paddingLeft), padR: parseFloat(cc.paddingRight),
          copy, ch60, win: box(win), chip,
          gap: win.getBoundingClientRect().top - copy.b,
          token: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--space-block')),
          catLines: new Set(cats).size,
          rows: rows.length,
          stacked: btns.top >= text.bottom - 0.5,
          sideBySide: btns.left >= text.right - 0.5 && Math.abs(btns.top - text.top) < 48,
          sw: document.documentElement.scrollWidth,
          maxTitle: Math.max(...[...win.querySelectorAll('.dw-title')].map((el) => el.getBoundingClientRect().right)),
        };
      }));
      if (!m) return;
      const contentL = m.container.l + m.padL, contentR = m.container.r - m.padR;
      assert.ok(Math.abs(m.win.l - contentL) <= 0.5 && Math.abs(m.win.r - contentR) <= 0.5, `the window runs the full content width (${m.win.l}-${m.win.r} against ${contentL}-${contentR})`);
      assert.ok(m.copy.w <= m.ch60 + 0.5, `the copy column (${m.copy.w}) is at most 60ch (${m.ch60})`);
      assert.ok(Math.abs(m.gap - m.token) <= 0.5, `the window sits one --space-block (${m.token}) under the copy, found ${m.gap}`);
      assert.ok(m.chip.r <= m.win.r - 16 + 0.5 && m.chip.b <= m.win.b - 16 + 0.5, 'the chip is inside the window\'s corner, 16 or more in from both edges');
      assert.ok(m.chip.r <= contentR + 0.5, 'and inside the content edge');
      assert.ok(m.chip.l >= m.win.l, 'positive control: the chip is wholly inside the window on the left too');
      assert.equal(m.rows, 3, 'three queue rows');
      assert.ok(m.sw <= width, 'no sideways scroll');
      assert.ok(m.maxTitle <= m.win.r, 'no title runs out of the window');
      if (width === 1280) assert.equal(m.win.w, 1100, 'positive control: the window is 1100 wide at 1280');
      if (width <= 900) assert.ok(m.stacked && !m.sideBySide, 'the rows stack, the buttons under the text');
      else assert.ok(m.sideBySide && !m.stacked, 'at 1280 the buttons sit beside the text');
      if (width === 375) assert.ok(m.catLines > 1, 'the category chips wrap onto more than one line');
      if (width === 1280) assert.equal(m.catLines, 1, 'positive control: the six chips fit one line at 1280');
    });
  }

  // ── the band, the closing note, the footer targets ──
  for (const width of [1280, 768, 375]) {
    it(`homepage @ ${width}: the band label and the closing note never leave one word alone on a line`, async (t) => {
      const m = await at(t, width, '/', (page) => page.evaluate(() => {
        const lines = (el) => {
          const tops = [];
          const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
          let node;
          while ((node = walker.nextNode())) {
            const re = /\S+/g; let mm;
            while ((mm = re.exec(node.textContent))) {
              const range = document.createRange();
              range.setStart(node, mm.index); range.setEnd(node, mm.index + mm[0].length);
              const r = range.getClientRects()[0];
              if (r) tops.push(Math.round(r.top));
            }
          }
          const out = [];
          for (const top of tops) {
            let line = out.find((l) => Math.abs(l.top - top) <= 3);
            if (!line) { line = { top, count: 0 }; out.push(line); }
            line.count += 1;
          }
          return { n: out.length, lone: out.length > 1 && out.some((l) => l.count === 1), words: tops.length };
        };
        const label = document.querySelector('#works-with-band-heading');
        return { label: lines(label), note: lines(document.querySelector('#footer-cta .footer-cta-note')), col: parseFloat(getComputedStyle(label.parentElement).gridTemplateColumns) };
      }));
      if (!m) return;
      assert.ok(m.label.words >= 5 && m.note.words >= 8, 'positive control: both strings were read');
      assert.equal(m.label.lone, false, 'the band label');
      assert.equal(m.note.lone, false, 'the closing note');
      if (width === 1280) assert.equal(m.col, 260, 'the label column is 260');
    });
  }

  it('homepage @ 375: the setup link is a 44px target and each footer meta link is at least 24px tall', async (t) => {
    const m = await at(t, 375, '/', (page) => page.evaluate(() => {
      const link = document.querySelector('#footer-cta-setup-link').getBoundingClientRect();
      const meta = [...document.querySelectorAll('footer .footer-meta a')].map((a) => a.getBoundingClientRect().height);
      const note = document.querySelector('#footer-cta .footer-cta-note');
      const lh = parseFloat(getComputedStyle(note).lineHeight) || 23;
      return { link: link.height, meta, noteHeight: note.getBoundingClientRect().height, lh };
    }));
    if (!m) return;
    assert.ok(m.link >= 44, `the setup link is ${m.link} tall`);
    assert.ok(m.meta.length >= 8, 'positive control: the footer links were found');
    for (const h of m.meta) assert.ok(h >= 24, `a footer meta link is ${h} tall`);
    assert.ok(m.noteHeight <= m.lh * 3 + 1, `the note keeps its height (${m.noteHeight}): the bigger target costs nothing`);
  });
});
