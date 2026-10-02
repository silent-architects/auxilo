'use strict';

/**
 * test/sweep-render.test.js: the accessibility sweep, as rendered by the staged real server.
 *
 *   - Archivo's second file loads only when a page uses one of its characters (waited on the request event)
 *   - the footer meta line never starts a line with a middot, at every width tried
 *   - a two-word heading in the heading-left layout stays on one line where it fits, and no heading leaves one
 *     word alone on a line at 1280 and 1025; the heading column is 5 of 12
 *   - the current page's navigation link carries a 1.5px underline in its own colour, 6px off the text
 *   - the legal template: the skip link is first, the wrapper is the main landmark
 *   - /status on its healthy path and on its failing path (the /health call blocked) shows its amber dot
 *   - /dashboard's script colour --gold resolves; mono inside bold asks for weight 400
 *
 * Everything is compared inside one run. No fixed waits: the only waits are page loads, font readiness and
 * the browser's own request event.
 *
 * Runner: node --test test/sweep-render.test.js
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { reservePort, stageServer, bootServer, stopServer } = require('./helpers/staged-server');

const REPO = path.join(__dirname, '..');

function isPlaywrightAvailable() {
  try { require.resolve('playwright'); return true; } catch (e) { return false; }
}

describe('sweep: the render', { timeout: 300_000 }, () => {
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
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auxilo-sweep-render-'));
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
        SESSION_SECRET: 'sweep-render-test-session-secret-0123456',
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

  // Run `fn(page)` on `route` at `width`, in a fresh context; the fonts are ready before it runs.
  async function at(t, width, route, fn, { height = 900, setup } = {}) {
    if (bootSkipReason) { t.skip(bootSkipReason); return undefined; }
    if (!playwrightOk) { t.skip('playwright not resolvable'); return undefined; }
    const ctx = await browser.newContext({ viewport: { width, height }, reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    try {
      if (setup) await setup(page);
      await page.goto(`${baseUrl}${route}`, { waitUntil: 'networkidle' });
      await page.evaluate(() => document.fonts.ready);
      return await fn(page);
    } finally {
      await ctx.close();
    }
  }

  // ── Archivo's second file ──
  it('Archivo Ext: basic Latin fetches the core file only; a ș makes the browser fetch the Ext file', async (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    if (!playwrightOk) { t.skip('playwright not resolvable'); return; }
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    try {
      const fetched = [];
      page.on('request', (r) => { const m = r.url().match(/\/fonts\/([^/?]+\.woff2)/); if (m) fetched.push(m[1]); });
      await page.goto(`${baseUrl}/status`, { waitUntil: 'networkidle' });
      await page.evaluate(() => document.fonts.ready);
      assert.ok(fetched.some((f) => /^ArchivoVariable\.[0-9a-f]{8}\.woff2$/.test(f)), `the core file is fetched: ${fetched.join(', ')}`);
      assert.ok(!fetched.some((f) => /^ArchivoVariableExt\./.test(f)), 'the Ext file is not fetched by a page of basic Latin');
      // more basic Latin, in the same family, still does not fetch it
      await page.evaluate(() => {
        const p = document.createElement('p');
        p.id = 'probe-latin';
        p.textContent = 'Plain basic Latin text, with digits 0123456789 and punctuation.';
        document.querySelector('main').appendChild(p);
      });
      await page.evaluate(() => document.fonts.ready);
      assert.ok(!fetched.some((f) => /^ArchivoVariableExt\./.test(f)), 'basic Latin text added later does not fetch it either');
      // a Romanian s with comma below: the browser asks for the Ext file. Wait on the request event itself.
      const extRequest = page.waitForRequest((r) => /\/fonts\/ArchivoVariableExt\.[0-9a-f]{8}\.woff2/.test(r.url()), { timeout: 20_000 });
      await page.evaluate(() => {
        const p = document.createElement('p');
        p.id = 'probe-romanian';
        p.textContent = 'ș';
        document.querySelector('main').appendChild(p);
      });
      const req = await extRequest;
      assert.equal(new URL(req.url()).origin, new URL(baseUrl).origin, 'the Ext file comes from the same origin');
      const res = await req.response();
      assert.equal(res.status(), 200);
      assert.equal(res.headers()['cache-control'], 'public, max-age=31536000, immutable', 'and is cached like the other font files');
      const size = (await res.body()).length;
      assert.ok(size > 1000 && size <= 20 * 1024, `its size is sane (${size} bytes)`);
    } finally {
      await ctx.close();
    }
  });

  // ── the footer meta line ──
  // Runs in the page: does any middot start a line of the footer meta line (or of `el`)?
  const dotStartsALine = (sel) => {
    const el = document.querySelector(sel);
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const chars = [];
    while (walker.nextNode()) {
      const n = walker.currentNode;
      for (let i = 0; i < n.textContent.length; i++) {
        if (/\s/.test(n.textContent[i])) continue;
        const rg = document.createRange();
        rg.setStart(n, i);
        rg.setEnd(n, i + 1);
        const r = rg.getClientRects();
        if (r.length) chars.push({ c: n.textContent[i], top: Math.round(r[0].top) });
      }
    }
    const first = chars.length ? chars[0].c : null;
    const starts = [];
    for (let i = 1; i < chars.length; i++) if (chars[i].top > chars[i - 1].top + 3 && chars[i].c === '·') starts.push(i);
    return { count: chars.length, lines: new Set(chars.map((c) => c.top)).size, first, starts };
  };

  it('control: the line-start check flags a middot that wraps onto a new line', async (t) => {
    const r = await at(t, 1280, '/status', async (page) => {
      await page.evaluate(() => {
        const p = document.createElement('p');
        p.id = 'dot-probe';
        p.style.cssText = 'width:12ch;font:14px monospace;margin:0;position:absolute;top:0;left:0;background:#fff;z-index:9';
        p.textContent = 'aaaaaaaaaaaa ·';
        document.body.appendChild(p);
      });
      return page.evaluate(dotStartsALine, '#dot-probe');
    });
    if (!r) return;
    assert.equal(r.lines, 2, 'the probe wrapped');
    assert.equal(r.starts.length, 1, 'and its dot starts the second line');
  });

  for (const route of ['/', '/status', '/dashboard', '/terms']) {
    it(`the footer meta line on ${route}: no line starts with a middot, from 320 to 1280`, async (t) => {
      if (bootSkipReason) { t.skip(bootSkipReason); return; }
      if (!playwrightOk) { t.skip('playwright not resolvable'); return; }
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
      const page = await ctx.newPage();
      try {
        await page.goto(`${baseUrl}${route}`, { waitUntil: 'networkidle' });
        await page.evaluate(() => document.fonts.ready);
        // every width where a break can land differently, so the sweep is every 6px, plus the phone widths named
        const widths = [];
        for (let w = 320; w <= 1280; w += 6) widths.push(w);
        widths.push(340, 343, 346, 360, 375, 390, 414, 430, 480, 768, 900, 1024);
        const bad = [];
        let lines = 0;
        for (const w of widths) {
          await page.setViewportSize({ width: w, height: 900 });
          const r = await page.evaluate(dotStartsALine, 'footer .footer-meta');
          lines = Math.max(lines, r.lines);
          if (r.starts.length) bad.push(w);
        }
        assert.ok(lines >= 2, 'positive control: the line wraps at some width in the sweep');
        assert.deepEqual(bad, [], `a line starts with a middot at widths ${bad.join(', ')}`);
      } finally {
        await ctx.close();
      }
    });
  }

  // ── the heading-left layout ──
  const HEADING_ROUTES = ['/', '/for-builders', '/for-agents', '/pricing', '/how-it-works', '/how-submissions-work', '/api', '/works-with'];

  // Runs in the page: every visible h1 and h2 with two words or more, as the words on each of its lines.
  const headingLines = () => [...document.querySelectorAll('h1, h2')].filter((h) => h.offsetParent !== null).map((h) => {
    const words = [];
    const walker = document.createTreeWalker(h, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const n = walker.currentNode;
      const re = /\S+/g;
      let m;
      while ((m = re.exec(n.textContent))) {
        const rg = document.createRange();
        rg.setStart(n, m.index);
        rg.setEnd(n, m.index + m[0].length);
        const r = rg.getClientRects();
        if (r.length) words.push({ w: m[0], top: Math.round(r[0].top) });
      }
    }
    const byLine = {};
    for (const x of words) (byLine[x.top] = byLine[x.top] || []).push(x.w);
    return { text: h.textContent.trim().replace(/\s+/g, ' '), lines: Object.values(byLine).map((l) => l.join(' ')), inAside: !!h.closest('.aside-list') };
  }).filter((h) => h.text.split(' ').length > 1);

  it('control: the lone-word check flags a heading that sets a word alone on a line', async (t) => {
    const r = await at(t, 1280, '/', async (page) => {
      await page.evaluate(() => {
        const h = document.createElement('h2');
        h.style.cssText = 'width:120px;position:absolute;top:0;left:0;z-index:9;font-size:40px';
        h.textContent = 'Alpha Beta Gamma';
        document.body.appendChild(h);
      });
      return (await page.evaluate(headingLines)).find((x) => x.text === 'Alpha Beta Gamma');
    });
    if (!r) return;
    assert.ok(r.lines.length > 1 && r.lines.some((l) => !l.includes(' ')), `the probe sets a word alone: ${JSON.stringify(r.lines)}`);
  });

  for (const width of [1280, 1025]) {
    it(`no heading leaves one word alone on a line at ${width}, and a two-word heading in the heading-left layout sits on one line`, async (t) => {
      if (bootSkipReason) { t.skip(bootSkipReason); return; }
      if (!playwrightOk) { t.skip('playwright not resolvable'); return; }
      const ctx = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
      const page = await ctx.newPage();
      try {
        const alone = [];
        const named = {};
        for (const route of HEADING_ROUTES) {
          await page.goto(`${baseUrl}${route}`, { waitUntil: 'networkidle' });
          await page.evaluate(() => document.fonts.ready);
          for (const h of await page.evaluate(headingLines)) {
            if (h.lines.length > 1 && h.lines.some((l) => !l.includes(' '))) alone.push(`${route}: ${JSON.stringify(h.lines)}`);
            if (h.inAside && h.text.split(' ').length === 2) {
              named[h.text] = h.lines.length;
              assert.equal(h.lines.length, 1, `${route}: the two-word heading "${h.text}" sits on one line at ${width}`);
            }
          }
        }
        assert.deepEqual(alone, [], `a word stands alone on a line:\n${alone.join('\n')}`);
        // positive control: the two headings the ruling names were among those checked
        assert.ok('Common Questions' in named, 'Common Questions was checked');
        assert.ok('Dive Deeper' in named, 'Dive Deeper was checked');
      } finally {
        await ctx.close();
      }
    });
  }

  it('the heading column of the heading-left layout is 5 of 12 and the list is 7 of 12', async (t) => {
    const r = await at(t, 1280, '/', (page) => page.evaluate(() => [...document.querySelectorAll('.aside-list')].map((g) => {
      const kids = [...g.children].map((c) => c.getBoundingClientRect().width);
      const cs = getComputedStyle(g);
      return { cols: cs.gridTemplateColumns.split(' ').map(parseFloat), gap: parseFloat(cs.columnGap), kids };
    })));
    if (!r) return;
    assert.ok(r.length >= 2, `positive control: the homepage has heading-left sections (${r.length})`);
    for (const g of r) {
      assert.equal(g.cols.length, 2);
      // the two columns are in the ratio 5 to 7, measured in this run
      assert.ok(Math.abs(g.cols[0] / g.cols[1] - 5 / 7) < 0.01, `columns ${g.cols.join(' and ')} are 5 to 7`);
      assert.ok(Math.abs(g.cols[0] / (g.cols[0] + g.cols[1]) - 5 / 12) < 0.005, 'the heading column is 5 of 12 of the content');
    }
  });

  // ── the current page in the navigation ──
  it('the current page\'s link carries a 1.5px underline in its own colour, 6px off the text; the others carry none', async (t) => {
    const r = await at(t, 1280, '/pricing', (page) => page.evaluate(() => {
      const pick = (id) => { const cs = getComputedStyle(document.getElementById(id)); return { line: cs.textDecorationLine, thickness: cs.textDecorationThickness, offset: cs.textUnderlineOffset, decoColor: cs.textDecorationColor, color: cs.color, current: document.getElementById(id).getAttribute('aria-current') }; };
      return { here: pick('nav-pricing'), other: pick('nav-agents') };
    }));
    if (!r) return;
    assert.equal(r.here.current, 'page');
    assert.equal(r.here.line, 'underline');
    assert.equal(r.here.thickness, '1.5px');
    assert.equal(r.here.offset, '6px');
    assert.equal(r.here.decoColor, r.here.color, 'the underline is in the link\'s own colour');
    assert.equal(r.other.line, 'none', 'positive control: a link for another page has no underline');
    assert.equal(r.other.current, null);
  });

  // ── the legal template ──
  for (const route of ['/terms', '/privacy']) {
    it(`${route}: the skip link is the first element and the wrapper is the main landmark`, async (t) => {
      const r = await at(t, 1280, route, (page) => page.evaluate(() => {
        const first = document.body.firstElementChild;
        const wrap = document.querySelector('.legal-wrap');
        return {
          first: first.outerHTML,
          wrapId: wrap.id,
          wrapRole: wrap.getAttribute('role'),
          target: document.getElementById('main') === wrap,
          kids: [...wrap.children].map((c) => c.tagName.toLowerCase()).slice(0, 3),
          mains: document.querySelectorAll('main, [role="main"]').length,
        };
      }));
      if (!r) return;
      assert.equal(r.first, '<a href="#main" class="skip-to-content">Skip to content</a>');
      assert.equal(r.wrapId, 'main');
      assert.equal(r.wrapRole, 'main');
      assert.equal(r.target, true, 'the skip link target is the wrapper');
      assert.deepEqual(r.kids.slice(0, 2), ['a', 'h1'], 'the wrapper still starts with the back link and the h1');
      assert.equal(r.mains, 1, 'one main landmark on the page');
    });
  }

  it('/writing and the essay: a Tab from the top lands on the skip link, and Enter moves to #main', async (t) => {
    for (const route of ['/writing', '/writing/agents-message-board']) {
      const r = await at(t, 1280, route, async (page) => {
        await page.keyboard.press('Tab');
        const first = await page.evaluate(() => document.activeElement.className);
        await page.keyboard.press('Enter');
        return { first, hash: await page.evaluate(() => location.hash), main: await page.evaluate(() => !!document.querySelector('main#main')) };
      });
      if (!r) return;
      assert.equal(r.first, 'skip-to-content', `${route}: the first Tab stop is the skip link`);
      assert.equal(r.hash, '#main');
      assert.equal(r.main, true);
    }
  });

  // ── /status, both paths ──
  for (const [path_, label] of [['healthy', 'Operational: USDC withdrawals migrating'], ['failing', 'Partial Degradation Detected']]) {
    it(`/status on its ${path_} path: the amber dot is painted, and the script's two colour names resolve`, async (t) => {
      const r = await at(t, 1280, '/status', (page) => page.evaluate(() => {
        const root = getComputedStyle(document.documentElement);
        return {
          label: document.getElementById('status-label').textContent,
          dot: getComputedStyle(document.getElementById('status-dot')).backgroundColor,
          warn: root.getPropertyValue('--st-warn').trim(),
          yellow: root.getPropertyValue('--yellow').trim(),
          yellowBg: root.getPropertyValue('--yellow-bg').trim(),
          live: document.getElementById('live-health').className,
        };
      }), {
        setup: async (page) => { if (path_ === 'failing') await page.route('**/health', (route) => route.abort()); },
      });
      if (!r) return;
      assert.equal(r.label, label);
      assert.equal(r.live, path_ === 'failing' ? 'err' : 'ok', `the live line took the ${path_} class`);
      assert.equal(r.dot, 'rgb(183, 121, 31)', 'the dot is the amber state token');
      assert.ok(r.warn.length > 0 && r.yellow === r.warn, `--yellow resolves to the amber token (${r.yellow} vs ${r.warn})`);
      assert.ok(r.yellowBg.length > 0 && r.yellowBg === r.warn, `--yellow-bg resolves to it too (${r.yellowBg})`);
    });
  }

  // ── script colours on /dashboard, mono inside bold ──
  it('/dashboard: --gold resolves to the accent text token where the script paints with it', async (t) => {
    const r = await at(t, 1280, '/dashboard', (page) => page.evaluate(() => {
      const body = getComputedStyle(document.querySelector('.dash-body'));
      return { gold: body.getPropertyValue('--gold').trim(), accent: body.getPropertyValue('--accent-text').trim(), slate: body.getPropertyValue('--slate').trim() };
    }));
    if (!r) return;
    assert.ok(r.accent.length > 0, 'positive control: the accent token resolves in the body');
    assert.equal(r.gold, r.accent, `--gold is --accent-text (${r.gold})`);
    assert.ok(r.slate.length > 0, 'positive control: a neighbouring alias still resolves');
  });

  it('mono inside strong asks for weight 400, and the strong text around it for 600', async (t) => {
    const r = await at(t, 1280, '/about', (page) => page.evaluate(() => {
      const p = document.createElement('p');
      p.innerHTML = '<strong>bold <code>mono</code></strong> and <b>also <code>mono</code></b> and <code>plain</code>';
      document.querySelector('main').appendChild(p);
      const w = (el) => getComputedStyle(el).fontWeight;
      return { strong: w(p.querySelector('strong')), strongCode: w(p.querySelector('strong code')), bCode: w(p.querySelector('b code')), plain: w(p.querySelector(':scope > code')) };
    }));
    if (!r) return;
    assert.equal(r.strong, '600');
    assert.equal(r.strongCode, '400');
    assert.equal(r.bCode, '400');
    assert.equal(r.plain, '400');
  });
});
