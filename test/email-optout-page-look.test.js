'use strict';

/**
 * test/email-optout-page-look.test.js
 *
 * The unlock-email opt-out page (GET and POST /account/email-prefs/unsubscribe) is
 * a small standalone page. server.js gives it a style block that still reads the
 * colours of the dark site (ivory heading and wordmark, slate sub text) and it has
 * no navigation and no footer. The shared sheet makes `body` paper, so without a
 * dark ground for this page the ivory text sits on paper and cannot be read.
 *
 * This test boots a staged copy of THIS worktree's server (read-only staging, an
 * isolated data directory, the same pattern as test/spacing-frame.test.js) and
 * drives every state the route prints in a real browser:
 *   - GET with no token         (the "expired" state, 400)
 *   - GET with an invalid token (the "expired" state, 400)
 *   - GET with a live token     (the "form" state, 200)
 *   - the form submitted        (the "done" state, 200, reached the way a person
 *                                reaches it: by pressing the button)
 * at 1280 and 375, and asserts live measurements only:
 *   - the body ground is dark (the obsidian token, read from the page itself)
 *   - every visible text node has a contrast of at least 4.5 against its
 *     effective background
 *   - every focusable control shows a focus ring of at least 3 against its ground
 *   - nothing scrolls sideways
 * Nothing here pins a pixel number that depends on how text is drawn, and nothing
 * waits a fixed time. Each assertion has a positive control: the same helper is
 * run on a page with a deliberately bad element injected and must report it.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
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
const ROUTE = '/account/email-prefs/unsubscribe';
const WIDTHS = [1280, 375];
const HEIGHTS = { 1280: 800, 375: 812 };
const MIN_TEXT_CONTRAST = 4.5;
const MIN_RING_CONTRAST = 3;
const ACCOUNT_ID = 'acc_optout_look';
const ACCOUNT_EMAIL = 'optout-look@test.local';

// ── Node-side colour helpers (used for the dark-ground assertion and its control) ─
function parseColor(value) {
  const hex = String(value).trim().match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
  }
  const m = String(value).match(/rgba?\(([^)]+)\)/);
  if (!m) return null;
  const parts = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
  return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
}

function luminance({ r, g, b }) {
  const lin = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

// A ground counts as dark when its luminance is far below the middle of the scale.
function isDarkGround(color) {
  return color.a === 1 && luminance(color) < 0.05;
}

// ── In-page measurements. Each is serialised into the page, so each is self-contained ─

// Every visible text node, its colour and its effective background, as a ratio.
function measureTextContrast() {
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'TITLE']);

  function parse(value) {
    const m = String(value).match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const parts = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
  }
  function over(top, base) {
    const a = top.a;
    return {
      r: top.r * a + base.r * (1 - a),
      g: top.g * a + base.g * (1 - a),
      b: top.b * a + base.b * (1 - a),
      a: 1,
    };
  }
  function lum({ r, g, b }) {
    const lin = (v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  }
  function ratio(c1, c2) {
    const l1 = lum(c1);
    const l2 = lum(c2);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  }
  // The colour a viewer sees behind an element: its own ancestors' backgrounds,
  // layered from the first opaque one down. An image or gradient cannot be measured.
  function effectiveBackground(el) {
    const layers = [];
    for (let node = el; node; node = node.parentElement) {
      const cs = getComputedStyle(node);
      if (cs.backgroundImage !== 'none') return null;
      const c = parse(cs.backgroundColor);
      if (!c) return null;
      if (c.a > 0) layers.push(c);
      if (c.a === 1) break;
    }
    // with no opaque layer the browser's own white canvas is what shows through
    let base = { r: 255, g: 255, b: 255, a: 1 };
    for (let i = layers.length - 1; i >= 0; i--) base = over(layers[i], base);
    return base;
  }
  function isVisible(el, rect) {
    if (rect.width <= 0 || rect.height <= 0) return false;
    // wholly above or left of the page (an off-screen skip link) is not visible
    if (rect.bottom <= 0 || rect.right <= 0) return false;
    for (let node = el; node; node = node.parentElement) {
      const cs = getComputedStyle(node);
      if (cs.display === 'none' || cs.visibility !== 'visible') return false;
      if (Number(cs.opacity) === 0) return false;
      const r = node.getBoundingClientRect();
      if (cs.overflow !== 'visible' && r.width <= 1 && r.height <= 1) return false;
    }
    return true;
  }
  function opacityOf(el) {
    let o = 1;
    for (let node = el; node; node = node.parentElement) o *= Number(getComputedStyle(node).opacity);
    return o;
  }

  const results = [];
  const unmeasurable = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.nodeValue.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const el = node.parentElement;
    if (!el || SKIP_TAGS.has(el.tagName)) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    if (!isVisible(el, range.getBoundingClientRect())) continue;

    const bg = effectiveBackground(el);
    const fg = parse(getComputedStyle(el).color);
    if (!bg || !fg) { unmeasurable.push(text); continue; }
    const alpha = fg.a * opacityOf(el);
    const shown = over({ ...fg, a: alpha }, bg);
    results.push({
      text: text.slice(0, 60),
      color: `rgb(${Math.round(shown.r)}, ${Math.round(shown.g)}, ${Math.round(shown.b)})`,
      background: `rgb(${Math.round(bg.r)}, ${Math.round(bg.g)}, ${Math.round(bg.b)})`,
      ratio: ratio(shown, bg),
    });
  }
  return { results, unmeasurable };
}

// The focus ring of whatever holds focus, against the ground around that element.
function measureFocusedRing() {
  function parse(value) {
    const m = String(value).match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const parts = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
  }
  function over(top, base) {
    const a = top.a;
    return { r: top.r * a + base.r * (1 - a), g: top.g * a + base.g * (1 - a), b: top.b * a + base.b * (1 - a), a: 1 };
  }
  function lum({ r, g, b }) {
    const lin = (v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  }
  const el = document.activeElement;
  if (!el || el === document.body) return null;
  const cs = getComputedStyle(el);
  const layers = [];
  for (let node = el.parentElement; node; node = node.parentElement) {
    const c = parse(getComputedStyle(node).backgroundColor);
    if (c && c.a > 0) layers.push(c);
    if (c && c.a === 1) break;
  }
  let ground = { r: 255, g: 255, b: 255, a: 1 };
  for (let i = layers.length - 1; i >= 0; i--) ground = over(layers[i], ground);
  const ring = parse(cs.outlineColor);
  const shown = over(ring, ground);
  const l1 = lum(shown);
  const l2 = lum(ground);
  return {
    tag: el.tagName.toLowerCase(),
    label: (el.textContent || el.getAttribute('href') || '').replace(/\s+/g, ' ').trim().slice(0, 40),
    matchesFocusVisible: el.matches(':focus-visible'),
    outlineStyle: cs.outlineStyle,
    outlineWidth: parseFloat(cs.outlineWidth),
    ratio: (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05),
  };
}

// Whether anything reaches past the viewport sideways. html and body clip their own
// overflow on this site, so scrollWidth alone cannot see it: every box is measured.
function measureOverflow() {
  const vw = document.documentElement.clientWidth;
  let maxRight = 0;
  let minLeft = 0;
  let offender = null;
  for (const el of document.body.querySelectorAll('*')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    if (r.right > maxRight) { maxRight = r.right; offender = el.tagName.toLowerCase() + (el.className ? '.' + String(el.className).split(' ')[0] : ''); }
    if (r.left < minLeft) minLeft = r.left;
  }
  return {
    vw,
    scrollWidth: document.documentElement.scrollWidth,
    bodyScrollWidth: document.body.scrollWidth,
    maxRight,
    minLeft,
    offender,
  };
}

function fmtFailures(list) {
  return list.map((r) => `  "${r.text}" ${r.color} on ${r.background} = ${r.ratio.toFixed(2)}`).join('\n');
}

// The assertions live at module level, not in the describe callback: an assert at describe scope
// runs at collection time and reports fail 0 under the npm test flags (test/ch7-describe-body-guard).
// Walk the tab order, bounded by the number of focusable elements, and measure the ring on each.
async function measureEveryFocusRing(page) {
  const count = await page.evaluate(() => document.querySelectorAll('a[href], button, input:not([type="hidden"]), select, textarea, [tabindex]').length);
  const rings = [];
  for (let i = 0; i < count; i++) {
    await page.keyboard.press('Tab');
    const ring = await page.evaluate(measureFocusedRing);
    if (ring) rings.push(ring);
  }
  return { count, rings };
}

// The four measured promises, on whatever page is open.
async function assertLook(page, width) {
  // 1. A dark ground. The body paints it and it is the obsidian token, read from the page.
  const ground = await page.evaluate(() => ({
    body: getComputedStyle(document.body).backgroundColor,
    html: getComputedStyle(document.documentElement).backgroundColor,
    token: getComputedStyle(document.documentElement).getPropertyValue('--obsidian').trim(),
  }));
  const body = parseColor(ground.body);
  assert.ok(body, `body background should parse, got ${ground.body}`);
  assert.ok(isDarkGround(body), `body ground is not dark: ${ground.body}`);
  assert.deepEqual(body, parseColor(ground.token), `body ground should be the obsidian token ${ground.token}, got ${ground.body}`);
  const htmlGround = parseColor(ground.html);
  assert.ok(htmlGround.a === 0 || isDarkGround(htmlGround), `html must not paint a light ground over the canvas: ${ground.html}`);

  // 2. Every visible text node reads at 4.5 or better.
  const text = await page.evaluate(measureTextContrast);
  assert.ok(text.results.length > 0, 'the page should hold visible text to measure');
  assert.deepEqual(text.unmeasurable, [], 'every visible text node sits on a measurable ground');
  const weak = text.results.filter((r) => r.ratio < MIN_TEXT_CONTRAST);
  assert.equal(weak.length, 0, `text below ${MIN_TEXT_CONTRAST}:1 at ${width}:\n${fmtFailures(weak)}`);

  // 3. Every control shows a focus ring that reads against its ground.
  const { count, rings } = await measureEveryFocusRing(page);
  assert.ok(count > 0 && rings.length === count, `every focusable element takes focus (${rings.length} of ${count})`);
  for (const ring of rings) {
    assert.ok(ring.matchesFocusVisible, `${ring.tag} "${ring.label}" should match :focus-visible after a Tab`);
    assert.notEqual(ring.outlineStyle, 'none', `${ring.tag} "${ring.label}" has no focus outline`);
    assert.ok(ring.outlineWidth > 0, `${ring.tag} "${ring.label}" focus outline has no width`);
    assert.ok(ring.ratio >= MIN_RING_CONTRAST, `${ring.tag} "${ring.label}" focus ring is ${ring.ratio.toFixed(2)}:1 against its ground, needs ${MIN_RING_CONTRAST}`);
  }

  // 4. Nothing reaches past the viewport sideways.
  const overflow = await page.evaluate(measureOverflow);
  assert.ok(overflow.scrollWidth <= overflow.vw, `document scrolls sideways: scrollWidth ${overflow.scrollWidth} > ${overflow.vw}`);
  assert.ok(overflow.maxRight <= overflow.vw + 0.5, `a box reaches past the right edge (${overflow.offender}): ${overflow.maxRight} > ${overflow.vw}`);
  assert.ok(overflow.minLeft >= -0.5, `a box reaches past the left edge: ${overflow.minLeft}`);
}

describe('Opt-out page keeps its look (dark ground, legible text, visible focus, no sideways scroll)', { timeout: 300_000 }, () => {
  let bootSkipReason = null;
  let tmpDir;
  let dataDir;
  let child;
  let baseUrl;
  let browser;
  let playwrightOk = false;

  function seedMagicLink() {
    const raw = crypto.randomBytes(32).toString('base64url');
    const file = path.join(dataDir, 'magic_links.json');
    const links = JSON.parse(fs.readFileSync(file, 'utf8'));
    links[crypto.createHash('sha256').update(raw).digest('hex')] = {
      email: ACCOUNT_EMAIL,
      purpose: 'earning-emails-off',
      expires_at: Date.now() + 900_000,
    };
    fs.writeFileSync(file, JSON.stringify(links));
    return raw;
  }

  before(async () => {
    try {
      require.resolve('playwright', { paths: [REPO] });
    } catch (e) {
      return;
    }
    const honoEntry = require.resolve('hono', { paths: [REPO] });
    const nodeModulesDir = honoEntry.slice(0, honoEntry.lastIndexOf(`${path.sep}node_modules${path.sep}`) + '/node_modules'.length);
    const reservation = await reservePort();
    if ('skipReason' in reservation) {
      bootSkipReason = reservation.skipReason;
      return;
    }
    const { port } = reservation;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auxilo-optout-look-'));
    ({ dataDir } = stageServer({
      repoRoot: REPO,
      tmpDir,
      nodeModulesDir,
      port,
      rootFiles: ['server.js', 'seed-knowledge.json', 'skills.json', 'openapi.json', 'package.json', 'model_config.json'],
      linkDirs: [],
      copyDirs: ['lib', 'public', 'prompts', 'config', 'docs'],
    }));
    // One account so a live token can complete the form; its data stays in the temp directory.
    fs.writeFileSync(path.join(dataDir, 'accounts.json'), JSON.stringify({
      [ACCOUNT_ID]: { id: ACCOUNT_ID, email: ACCOUNT_EMAIL, created_at: '2026-08-01T00:00:00.000Z', api_keys: [] },
    }));
    fs.writeFileSync(path.join(dataDir, 'magic_links.json'), '{}');
    const boot = await bootServer({
      tmpDir,
      port,
      env: {
        NODE_ENV: 'test',
        SESSION_SECRET: 'optout-look-test-session-secret-0123456789',
        RESEND_API_KEY: '',
        LLM_SENSITIVITY_ENABLED: 'false',
        WALLET_PRIVATE_KEY: `0x${'11'.repeat(32)}`,
        HOME: tmpDir,
        AUXILO_HOME: path.join(tmpDir, 'auxilo-home'),
        AUXILO_ACCOUNTS_FILE: path.join(dataDir, 'accounts.json'),
        AUXILO_MAGIC_LINKS_FILE: path.join(dataDir, 'magic_links.json'),
      },
      timeoutMs: 60_000,
      maxAttempts: 3,
    });
    if ('skipReason' in boot) {
      bootSkipReason = boot.skipReason;
      return;
    }
    child = boot.child;
    baseUrl = boot.baseUrl;
    const { chromium } = require(path.join(nodeModulesDir, 'playwright'));
    browser = await chromium.launch();
    playwrightOk = true;
  });

  after(async () => {
    if (browser) await browser.close();
    if (child) await stopServer(child);
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function openPage(width) {
    const ctx = await browser.newContext({ viewport: { width, height: HEIGHTS[width] }, reducedMotion: 'reduce' });
    return { ctx, page: await ctx.newPage() };
  }

  async function settle(page) {
    await page.evaluate(() => document.fonts.ready);
  }

  const STATES = [
    {
      name: 'GET with no token (expired)',
      status: 400,
      load: async (page) => page.goto(`${baseUrl}${ROUTE}`, { waitUntil: 'networkidle' }),
      expectText: /This link has expired/,
    },
    {
      name: 'GET with an invalid token (expired)',
      status: 400,
      load: async (page) => page.goto(`${baseUrl}${ROUTE}?token=garbage`, { waitUntil: 'networkidle' }),
      expectText: /This link has expired/,
    },
    {
      name: 'GET with a live token (form)',
      status: 200,
      load: async (page) => page.goto(`${baseUrl}${ROUTE}?token=${seedMagicLink()}`, { waitUntil: 'networkidle' }),
      expectText: /Turn Off Unlock Emails/,
    },
    {
      name: 'the form submitted (done)',
      status: 200,
      load: async (page) => {
        await page.goto(`${baseUrl}${ROUTE}?token=${seedMagicLink()}`, { waitUntil: 'networkidle' });
        const [response] = await Promise.all([
          page.waitForResponse((r) => r.url().startsWith(`${baseUrl}${ROUTE}`) && r.request().method() === 'POST'),
          page.click('button[type="submit"]'),
        ]);
        await page.waitForSelector('.unsub-done');
        await page.waitForLoadState('networkidle');
        return response;
      },
      expectText: /Unlock emails are off/,
    },
  ];

  for (const state of STATES) {
    for (const width of WIDTHS) {
      it(`${state.name} @ ${width}: dark ground, text at ${MIN_TEXT_CONTRAST}:1 or better, visible focus, no sideways scroll`, async (t) => {
        if (bootSkipReason) { t.skip(bootSkipReason); return; }
        if (!playwrightOk) { t.skip('playwright not resolvable'); return; }
        const { ctx, page } = await openPage(width);
        try {
          const response = await state.load(page);
          assert.equal(response.status(), state.status, 'the route prints the state this case names');
          await settle(page);
          assert.match(await page.locator('main').innerText(), state.expectText, 'the page shows the state this case names');
          await assertLook(page, width);
        } finally {
          await ctx.close();
        }
      });
    }
  }

  // ── Positive controls: each helper reports a deliberately bad page ──
  it('control: the contrast helper reports low-contrast text (a dim line on the dark ground, ivory on paper) and passes plain good text', async (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    if (!playwrightOk) { t.skip('playwright not resolvable'); return; }
    const { ctx, page } = await openPage(1280);
    try {
      await page.goto(`${baseUrl}${ROUTE}`, { waitUntil: 'networkidle' });
      await settle(page);
      const clean = await page.evaluate(measureTextContrast);
      assert.equal(clean.results.filter((r) => r.ratio < MIN_TEXT_CONTRAST).length, 0, 'the untouched page has no weak text');

      await page.evaluate(() => {
        const wrap = document.querySelector('.unsub-wrap');
        const dim = document.createElement('p');
        dim.id = 'ctl-dim';
        dim.textContent = 'control dim line';
        dim.style.color = '#2a2a2a';
        const paper = document.createElement('div');
        paper.style.background = '#FAFAF8';
        const ivory = document.createElement('span');
        ivory.textContent = 'control ivory on paper';
        ivory.style.color = '#FAFAF8';
        paper.appendChild(ivory);
        const good = document.createElement('p');
        good.textContent = 'control good line';
        good.style.color = '#FAFAF8';
        wrap.append(dim, paper, good);
      });
      const injected = await page.evaluate(measureTextContrast);
      const weak = injected.results.filter((r) => r.ratio < MIN_TEXT_CONTRAST).map((r) => r.text);
      assert.ok(weak.includes('control dim line'), `the dim line must be reported, got ${JSON.stringify(weak)}`);
      assert.ok(weak.includes('control ivory on paper'), `ivory on paper must be reported, got ${JSON.stringify(weak)}`);
      assert.ok(!weak.includes('control good line'), 'plain ivory on the dark ground must pass');
    } finally {
      await ctx.close();
    }
  });

  it('control: the ground check refuses paper, and the focus helper reports a ring that is invisible on its ground', async (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    if (!playwrightOk) { t.skip('playwright not resolvable'); return; }
    assert.equal(isDarkGround(parseColor('rgb(250, 250, 248)')), false, 'paper is not a dark ground');
    assert.equal(isDarkGround(parseColor('#0A0A0A')), true, 'obsidian is a dark ground');
    const { ctx, page } = await openPage(1280);
    try {
      await page.goto(`${baseUrl}${ROUTE}?token=${seedMagicLink()}`, { waitUntil: 'networkidle' });
      await settle(page);
      // an ink ring on the dark ground is the old defect: the ring must measure as failing
      await page.addStyleTag({ content: 'button[type="submit"]:focus-visible { outline: 2px solid #0A0A0A !important; }' });
      await page.focus('button[type="submit"]');
      await page.keyboard.press('Shift+Tab');
      await page.keyboard.press('Tab');
      const ring = await page.evaluate(measureFocusedRing);
      assert.equal(ring.tag, 'button');
      assert.ok(ring.ratio < MIN_RING_CONTRAST, `an ink ring on the dark ground should measure under ${MIN_RING_CONTRAST}, got ${ring.ratio.toFixed(2)}`);
    } finally {
      await ctx.close();
    }
  });

  it('control: the overflow helper reports a box that reaches past the viewport at 375', async (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    if (!playwrightOk) { t.skip('playwright not resolvable'); return; }
    const { ctx, page } = await openPage(375);
    try {
      await page.goto(`${baseUrl}${ROUTE}`, { waitUntil: 'networkidle' });
      await settle(page);
      const clean = await page.evaluate(measureOverflow);
      assert.ok(clean.maxRight <= clean.vw + 0.5, 'the untouched page stays inside the viewport');
      await page.evaluate(() => {
        const wide = document.createElement('div');
        wide.style.width = `${document.documentElement.clientWidth * 2}px`;
        wide.style.height = '10px';
        document.querySelector('.unsub-wrap').appendChild(wide);
      });
      const injected = await page.evaluate(measureOverflow);
      assert.ok(injected.maxRight > injected.vw + 0.5, `an over-wide box must be reported, maxRight ${injected.maxRight} vs ${injected.vw}`);
    } finally {
      await ctx.close();
    }
  });
});
