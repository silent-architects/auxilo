'use strict';

/**
 * test/launch-wave-fixes-visual.test.js — FIX-UNIT-2: final visual findings
 * (REVIEW-VISUAL-FINAL.md V1/V2/V3/V4/V6/V7/V8/V9, plus M1, the project
 * manager's own for-builders heading-wrap finding).
 *
 * Each describe block below pins one finding: the OLD (broken) shape is
 * asserted absent, the NEW (fixed) shape is asserted present, and where a
 * finding is a rendering question (line count, contrast ratio, clearance,
 * element height) a real Playwright measurement backs it, not just markup.
 *
 * Static-file assertions use `fs.readFileSync` directly, matching this
 * repo's own convention (e.g. test/connect-page.test.js, test/fb-accrual-
 * sentence.test.js). Playwright sections skip gracefully when playwright
 * or a loopback bind is unavailable, same convention as
 * test/mobile-header-offset.test.js.
 *
 * Runner: node --test test/launch-wave-fixes-visual.test.js
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
  BOOT_SANDBOX_SKIP_REASON,
} = require('./helpers/staged-server');

const REPO = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(REPO, 'public');

function read(rel) {
  return fs.readFileSync(path.join(REPO, rel), 'utf8');
}

function isPlaywrightAvailable() {
  try { require.resolve('playwright'); return true; } catch { return false; }
}

// ─────────────────────────────────────────────────────────────────────────
// V2 + V4 + V8 (dashboard, session-required): shared staged server + a real
// HS256 session JWT signed with the same SESSION_SECRET the staged server
// boots with (matches this wave's own test/../verify-fixes-frontend.js
// pattern) — pre-seeded accounts.json/earnings.json sidestep entirely
// whatever timing quirk makes a *freshly created* account not show up in a
// same-process re-read (unrelated to this fix, out of scope to chase here).
// ─────────────────────────────────────────────────────────────────────────
describe('FIX-UNIT-2: dashboard + email-prefs (staged server)', { timeout: 180_000 }, () => {
  let tier2ok = false;
  let bootSkipReason = null;
  let tmpDir;
  let child;
  let baseUrl;
  let browser;
  const SESSION_SECRET = 'launch-wave-fixes-visual-session-secret-32b';
  const ACCT_ZERO = 'acc_v2zero';
  const ACCT_PAID = 'acc_v2paid';
  let tokenZero;
  let tokenPaid;

  before(async () => {
    if (!isPlaywrightAvailable()) return;
    const honoEntry = require.resolve('hono', { paths: [REPO] });
    const nodeModulesDir = honoEntry.slice(
      0,
      honoEntry.lastIndexOf(`${path.sep}node_modules${path.sep}`) + '/node_modules'.length
    );
    const reservation = await reservePort();
    if ('skipReason' in reservation) {
      assert.equal(reservation.skipReason, BOOT_SANDBOX_SKIP_REASON);
      bootSkipReason = BOOT_SANDBOX_SKIP_REASON;
      return;
    }
    const { port } = reservation;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auxilo-launch-wave-fixes-visual-'));
    const { dataDir } = stageServer({
      repoRoot: REPO,
      tmpDir,
      nodeModulesDir,
      port,
      rootFiles: ['server.js', 'seed-knowledge.json', 'skills.json', 'openapi.json', 'package.json', 'model_config.json'],
      linkDirs: [],
      copyDirs: ['lib', 'public', 'prompts', 'config'],
    });

    fs.writeFileSync(path.join(dataDir, 'accounts.json'), JSON.stringify({
      [ACCT_ZERO]: { id: ACCT_ZERO, email: 'v2zero@example.com', created_at: new Date().toISOString(), api_keys: [] },
      [ACCT_PAID]: { id: ACCT_PAID, email: 'v2paid@example.com', created_at: new Date().toISOString(), api_keys: [] },
    }, null, 2));
    fs.writeFileSync(path.join(dataDir, 'learnings.json'), '[]');
    // V2: ACCT_ZERO has NO earnings.json entry at all (resolveEarningsEntry's
    // source==='new' branch, GET /account/earnings' explicit zero-state
    // response) -- a genuinely fresh account, not a doctored zero.
    // ACCT_PAID has a real nonzero pending_balance.
    fs.writeFileSync(path.join(dataDir, 'earnings.json'), JSON.stringify({
      [ACCT_PAID]: {
        account_id: ACCT_PAID, wallet: null, total_gross: 20, total_contributor: 14,
        total_platform: 6, by_learning: {}, last_updated: new Date().toISOString(),
        pending_balance: 12.34, unassented_pending: 0, total_withdrawn: 0,
        withdrawal_count: 0, processed_settlements: [],
      },
    }, null, 2));
    fs.writeFileSync(path.join(dataDir, 'magic_links.json'), '{}');

    const boot = await bootServer({
      tmpDir,
      port,
      env: {
        NODE_ENV: 'test',
        SESSION_SECRET,
        RESEND_API_KEY: '',
        LLM_SENSITIVITY_ENABLED: 'false',
        WALLET_PRIVATE_KEY: `0x${'11'.repeat(32)}`,
      },
      timeoutMs: 60_000,
      maxAttempts: 3,
    });
    if ('skipReason' in boot) {
      assert.equal(boot.skipReason, BOOT_SANDBOX_SKIP_REASON);
      bootSkipReason = BOOT_SANDBOX_SKIP_REASON;
      return;
    }
    child = boot.child;
    baseUrl = boot.baseUrl;

    const { SignJWT } = require(path.join(REPO, 'node_modules', 'jose'));
    async function sign(accountId, email) {
      return new SignJWT({ accountId, email })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .setExpirationTime('10m')
        .sign(Buffer.from(SESSION_SECRET));
    }
    tokenZero = await sign(ACCT_ZERO, 'v2zero@example.com');
    tokenPaid = await sign(ACCT_PAID, 'v2paid@example.com');

    const { chromium } = require(path.join(REPO, 'node_modules', 'playwright'));
    browser = await chromium.launch();
    tier2ok = true;
  });

  after(async () => {
    if (browser) await browser.close();
    if (child) await stopServer(child);
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function loadDashboardAs(token) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(`${baseUrl}/dashboard`, { waitUntil: 'networkidle' });
    await page.evaluate((t) => localStorage.setItem('auxilo_session', t), token);
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(600);
    return { ctx, page };
  }

  it('V2: $0.00 pending balance renders WITHOUT the .aurum gold class (plain ivory, like the other figures)', async (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    if (!tier2ok) { t.skip('playwright not resolvable'); return; }
    const { ctx, page } = await loadDashboardAs(tokenZero);
    try {
      const info = await page.evaluate(() => {
        const items = Array.from(document.querySelectorAll('#earnings-grid .earnings-item'));
        const row = items.find((el) => el.querySelector('.earnings-label').textContent.trim() === 'Your share (accrued)');
        const val = row ? row.querySelector('.earnings-value') : null;
        return val ? { text: val.textContent.trim(), hasAurum: val.classList.contains('aurum'), color: getComputedStyle(val).color } : null;
      });
      assert.ok(info, 'earnings row "Your share (accrued)" found');
      assert.equal(info.text, '$0.00');
      assert.equal(info.hasAurum, false, 'zero balance must NOT carry .aurum');
      assert.notEqual(info.color, 'rgb(201, 168, 76)', 'computed color must not be the gold token');
    } finally {
      await ctx.close();
    }
  });

  it('V2: a real nonzero pending balance still renders WITH the .aurum gold class (positive control — the highlight is not simply removed)', async (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    if (!tier2ok) { t.skip('playwright not resolvable'); return; }
    const { ctx, page } = await loadDashboardAs(tokenPaid);
    try {
      const info = await page.evaluate(() => {
        const items = Array.from(document.querySelectorAll('#earnings-grid .earnings-item'));
        const row = items.find((el) => el.querySelector('.earnings-label').textContent.trim() === 'Your share (accrued)');
        const val = row ? row.querySelector('.earnings-value') : null;
        return val ? { text: val.textContent.trim(), hasAurum: val.classList.contains('aurum'), color: getComputedStyle(val).color } : null;
      });
      assert.ok(info, 'earnings row "Your share (accrued)" found');
      assert.equal(info.text, '$12.34');
      assert.equal(info.hasAurum, true, 'nonzero balance must still carry .aurum');
      assert.equal(info.color, 'rgb(201, 168, 76)', 'computed color must be the gold token');
    } finally {
      await ctx.close();
    }
  });

  it('V4: the three dashboard .btn.btn-primary buttons are >= 44px tall at 375px and 1280px, label stays centered', async (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    if (!tier2ok) { t.skip('playwright not resolvable'); return; }
    for (const width of [375, 1280]) {
      const ctx = await browser.newContext({ viewport: { width, height: 900 } });
      const page = await ctx.newPage();
      try {
        // login-btn is on the signed-out view; visit with no session.
        await page.goto(`${baseUrl}/dashboard`, { waitUntil: 'networkidle' });
        const loginBtn = await page.evaluate(() => {
          const el = document.getElementById('login-btn');
          const r = el.getBoundingClientRect();
          return { height: r.height, display: getComputedStyle(el).display };
        });
        assert.ok(loginBtn.height >= 44, `#login-btn height ${loginBtn.height} at ${width}px must be >= 44`);
        assert.equal(loginBtn.display, 'inline-flex');

        // terms-accept-btn / clean-lane-grant-btn are in the dash-view (need a session).
        const { ctx: ctx2, page: page2 } = await loadDashboardAs(tokenPaid);
        try {
          const rects = await page2.evaluate(() => {
            // #clean-lane-grant-form ships display:none until GET
            // /account/clean-lane reports the feature live for this account
            // (dark by default in this staged env, per the review's own
            // "checked and sound" #8) -- force it visible purely to measure
            // the button's CSS-driven height, same pattern this wave's own
            // verify-fixes-frontend.js already used for the sibling
            // #unlock-email-setting row.
            const form = document.getElementById('clean-lane-grant-form');
            if (form) form.style.display = '';
            // BUILD-BRIEF-TERMS-SCROLL.md: #terms-accept-btn now lives inside
            // the Terms dialog, shown only once "Read the Terms" opens it --
            // force the overlay visible for the same reason as the clean-lane
            // form above, purely to measure the button's CSS-driven height.
            const termsOverlay = document.getElementById('terms-dialog-overlay');
            if (termsOverlay) termsOverlay.style.display = '';
            return ['terms-accept-btn', 'clean-lane-grant-btn'].map((id) => {
              const el = document.getElementById(id);
              const r = el.getBoundingClientRect();
              return { id, height: r.height };
            });
          });
          for (const r of rects) {
            assert.ok(r.height >= 44, `#${r.id} height ${r.height} at ${width}px must be >= 44`);
          }
        } finally {
          await ctx2.close();
        }
      } finally {
        await ctx.close();
      }
    }
  });

  it('V8: dashboard skip link is the first element in <body>, hidden until focus, targets #main which now exists', async (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    if (!tier2ok) { t.skip('playwright not resolvable'); return; }
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    try {
      await page.goto(`${baseUrl}/dashboard`, { waitUntil: 'networkidle' });
      // CI-2: the skip link's `top` moves from -100% to 0 on focus via a CSS
      // transition -- reading the computed value the instant after focus()
      // can land mid-transition on a slower machine (observed in CI as
      // top=-900px where 0px was expected). Turning transitions and
      // animations off page-wide makes the post-focus read land on the
      // settled end value deterministically, on any machine.
      await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation: none !important; }' });
      const info = await page.evaluate(() => {
        const body = document.body;
        let firstEl = body.firstElementChild;
        const main = document.getElementById('main');
        const beforeFocus = firstEl ? getComputedStyle(firstEl).top : null;
        return {
          firstElClass: firstEl ? firstEl.className : null,
          firstElHref: firstEl ? firstEl.getAttribute('href') : null,
          firstElText: firstEl ? firstEl.textContent.trim() : null,
          mainExists: !!main,
          mainIsMainTag: main ? main.tagName.toLowerCase() === 'main' : false,
          beforeFocusTop: beforeFocus,
        };
      });
      assert.equal(info.firstElClass, 'skip-to-content');
      assert.equal(info.firstElHref, '#main');
      assert.equal(info.firstElText, 'Skip to content');
      assert.ok(info.mainExists, 'a #main element now exists on the dashboard (it had none before)');
      assert.ok(info.mainIsMainTag, '#main is a real <main> landmark');
      // The CSS is `top: -100%`; a browser's computed style resolves that
      // percentage against the containing block's height once one exists
      // (here, the 900px viewport), so the computed value is a large
      // negative pixel figure, not the literal string "-100%".
      assert.ok(parseFloat(info.beforeFocusTop) <= -100, `hidden off-screen before focus, got top=${info.beforeFocusTop}`);

      await page.focus('.skip-to-content');
      const afterFocusTop = await page.evaluate(() => getComputedStyle(document.querySelector('.skip-to-content')).top);
      assert.equal(afterFocusTop, '0px', 'visible (top:0) once focused');
    } finally {
      await ctx.close();
    }
  });

  it('V8: email-prefs page (all three states) carries the same skip link + a #main it points to', async (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    if (!tier2ok) { t.skip('playwright not resolvable'); return; }
    const res = await fetch(`${baseUrl}/account/email-prefs/unsubscribe?token=garbage`);
    const html = await res.text();
    assert.equal(res.status, 400, '"expired" state (invalid token shape)');
    assert.match(html, /<body><a href="#main" class="skip-to-content">Skip to content<\/a>/, 'skip link is the first thing in body');
    assert.match(html, /<main class="unsub-wrap" id="main">/, '#main exists on the unsub page');
    assert.match(html, /\.skip-to-content\s*\{[^}]*top:\s*-100%/, 'inlined hidden-by-default rule present');
    assert.match(html, /\.skip-to-content:focus\s*\{[^}]*top:\s*0/, 'inlined focus-visible rule present');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// V1 + V7: about/connect/works-with clear the fixed header at every width,
// not only <=900px. (The general per-page regression pins already live in
// test/mobile-header-offset.test.js and were updated there for this fix;
// this block adds the brief's own explicit 24px-clearance assertion.)
// ─────────────────────────────────────────────────────────────────────────
describe('FIX-UNIT-2 V1/V7: header clearance at every width (static server)', { timeout: 120_000 }, () => {
  let server;
  let base;
  let browser;
  let ok = false;

  before(async () => {
    if (!isPlaywrightAvailable()) return;
    const http = require('node:http');
    const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
    server = http.createServer((req, res) => {
      let urlPath = decodeURIComponent(req.url.split('?')[0]);
      if (urlPath === '/') urlPath = '/index.html';
      const filePath = path.join(PUBLIC_DIR, urlPath);
      fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404); res.end('not found'); return; }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
        res.end(data);
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    const { chromium } = require('playwright');
    browser = await chromium.launch();
    ok = true;
  });

  after(async () => {
    if (browser) await browser.close();
    if (server) server.close();
  });

  const PAGES = ['/about.html', '/connect.html', '/works-with.html'];
  const WIDTHS = [1280, 768, 375];
  const MIN_CLEARANCE = 24;

  for (const page of PAGES) {
    for (const width of WIDTHS) {
      it(`${page} at ${width}px: h1.top >= header.bottom + ${MIN_CLEARANCE}`, async (t) => {
        if (!ok) { t.skip('playwright not resolvable'); return; }
        const height = width === 375 ? 812 : (width === 768 ? 1024 : 800);
        const ctx = await browser.newContext({ viewport: { width, height } });
        const p = await ctx.newPage();
        try {
          await p.goto(base + page, { waitUntil: 'networkidle' });
          const m = await p.evaluate(() => {
            const nav = document.getElementById('main-nav');
            const h1 = document.querySelector('h1');
            return { navBottom: nav.getBoundingClientRect().bottom, h1Top: h1.getBoundingClientRect().top };
          });
          const required = m.navBottom + MIN_CLEARANCE;
          assert.ok(m.h1Top >= required, `${page} at ${width}px: h1.top=${m.h1Top} should be >= header.bottom(${m.navBottom}) + ${MIN_CLEARANCE} = ${required}`);
        } finally {
          await ctx.close();
        }
      });
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────
// V3: /how-submissions-work #s7-unlocks-count is secondary/ivory, its
// sibling #s7-learnings-count stays gold (positive control).
// ─────────────────────────────────────────────────────────────────────────
describe('FIX-UNIT-2 V3: trust page live-count secondary style', () => {
  const HTML = read('public/how-submissions-work.html');

  it('#s7-unlocks-count carries pull-stat-secondary in addition to ledger-card-value', () => {
    assert.match(HTML, /<span id="s7-unlocks-count" class="ledger-card-value pull-stat-secondary">/);
  });

  it('positive control: #s7-learnings-count is UNCHANGED (still just ledger-card-value, stays gold)', () => {
    assert.match(HTML, /<span id="s7-learnings-count" class="ledger-card-value">/);
    assert.doesNotMatch(HTML, /<span id="s7-learnings-count" class="ledger-card-value pull-stat-secondary">/);
  });

  it('neither id moved or was renamed', () => {
    assert.equal((HTML.match(/id="s7-unlocks-count"/g) || []).length, 1);
    assert.equal((HTML.match(/id="s7-learnings-count"/g) || []).length, 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// V6: /for-agents .auth-badge.apikey contrast, computed with the full
// alpha-blended background stack (background: rgba(ash, 0.07) over the
// obsidian page background, same method the review used).
// ─────────────────────────────────────────────────────────────────────────
describe('FIX-UNIT-2 V6: .auth-badge.apikey contrast >= 4.5:1', { timeout: 60_000 }, () => {
  const HTML = read('public/for-agents.html');

  it('the rule now sets color: var(--ash), not var(--slate)', () => {
    const m = HTML.match(/\.auth-badge\.apikey\s*\{([^}]*)\}/);
    assert.ok(m, '.auth-badge.apikey rule found');
    assert.match(m[1], /color:\s*var\(--ash\)/);
    assert.doesNotMatch(m[1], /color:\s*var\(--slate\)/);
  });

  // Real DOM measurement, not a hand-assumed background: `.auth-badge.apikey`
  // sits inside `.auth-compare-card.featured` (background: var(--aurum-dim),
  // rgba(201,168,76,0.15)), NOT a plain obsidian card as a first guess would
  // assume -- the full alpha-blended ancestor chain (body -> section-ground
  // -> .featured card -> the badge's own 7%-alpha ash fill) is what the
  // review's own contrast pass used, and what this measures.
  it('computed contrast ratio, full ancestor background stack: --ash >= 4.5:1, and would have been ~4.24:1 (under 4.5) with the old --slate', async (t) => {
    if (!isPlaywrightAvailable()) { t.skip('playwright not resolvable'); return; }
    const http = require('node:http');
    const MIME = { '.html': 'text/html', '.css': 'text/css' };
    const server = http.createServer((req, res) => {
      const urlPath = decodeURIComponent(req.url.split('?')[0]);
      const filePath = path.join(PUBLIC_DIR, urlPath);
      fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404); res.end('not found'); return; }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
        res.end(data);
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const { chromium } = require('playwright');
    const browser = await chromium.launch();
    try {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      const page = await ctx.newPage();
      await page.goto(`${base}/for-agents.html`, { waitUntil: 'networkidle' });
      const result = await page.evaluate(() => {
        function parseRGB(str) {
          const m = str.match(/rgba?\(([^)]+)\)/);
          if (!m) return null;
          const parts = m[1].split(',').map((s) => parseFloat(s.trim()));
          return [parts[0], parts[1], parts[2], parts[3] !== undefined ? parts[3] : 1];
        }
        function compositeBgFor(el) {
          const layers = [];
          let cur = el;
          while (cur) {
            const rgba = parseRGB(getComputedStyle(cur).backgroundColor);
            if (rgba && rgba[3] > 0) layers.push(rgba);
            cur = cur.parentElement;
          }
          layers.reverse();
          let composite = [255, 255, 255];
          for (const [r, g, b, a] of layers) composite = [r * a + composite[0] * (1 - a), g * a + composite[1] * (1 - a), b * a + composite[2] * (1 - a)];
          return composite;
        }
        function contrastRatio(rgb1, rgb2) {
          function lum([r, g, b]) {
            const chan = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
            return 0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b);
          }
          const L1 = lum(rgb1) + 0.05, L2 = lum(rgb2) + 0.05;
          return L1 > L2 ? L1 / L2 : L2 / L1;
        }
        const el = document.querySelector('.auth-badge.apikey');
        const bg = compositeBgFor(el);
        const afterColor = parseRGB(getComputedStyle(el).color).slice(0, 3);
        const after = contrastRatio(afterColor, bg);
        // Old value, measured the same way, without editing the file.
        el.style.color = 'rgb(139, 146, 154)'; // --slate
        const before = contrastRatio([139, 146, 154], bg);
        return { bg, afterColor, after, before };
      });
      assert.ok(result.before < 4.5, `sanity check: the OLD --slate ratio (${result.before.toFixed(2)}) should be under 4.5 (matches the review's measured 4.24:1)`);
      assert.ok(result.after >= 4.5, `the NEW --ash ratio (${result.after.toFixed(2)}) must be >= 4.5:1 (background stack: ${JSON.stringify(result.bg)})`);
    } finally {
      await browser.close();
      server.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// V8 (static pages): skip link first-in-body + #main present, for the four
// pages that had neither before this fix.
// ─────────────────────────────────────────────────────────────────────────
describe('FIX-UNIT-2 V8: skip link + #main on about/connect/works-with', () => {
  const CASES = [
    ['public/about.html', '<main id="main">'],
    ['public/connect.html', '<main id="main">'],
    ['public/works-with.html', '<main class="ww-main" id="main">'],
  ];

  for (const [file, mainTag] of CASES) {
    it(`${file}: skip link is first in <body>, and ${mainTag} exists`, () => {
      const html = read(file);
      const bodyMatch = html.match(/<body>\s*<a href="#main" class="skip-to-content">Skip to content<\/a>/);
      assert.ok(bodyMatch, `${file}: skip link not first in <body>`);
      assert.equal((html.match(/id="main"/g) || []).length, 1, `${file}: exactly one #main`);
      assert.ok(html.includes(mainTag), `${file}: expected ${mainTag}`);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// V9: pricing.html's "Revenue Split" is now an h3, and no public/ page
// skips a heading level (sweep asked for by the brief).
// ─────────────────────────────────────────────────────────────────────────
describe('FIX-UNIT-2 V9: heading hierarchy', () => {
  it('pricing.html "Revenue Split" is an h3 under the For Builders h2, not an h4', () => {
    const html = read('public/pricing.html');
    assert.doesNotMatch(html, /<h4[^>]*>Revenue Split<\/h4>/);
    assert.match(html, /<h3[^>]*>Revenue Split<\/h3>/);
    assert.match(html, /\.revenue-split-visual h3\s*\{/);
  });

  function gitTrackedPublicHtmlFiles() {
    const { execFileSync } = require('node:child_process');
    return execFileSync('git', ['ls-files', 'public/'], { cwd: REPO, encoding: 'utf8' })
      .split('\n').filter((f) => f.endsWith('.html'));
  }

  function headingSkips(html) {
    const cleaned = html
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '');
    const levels = [...cleaned.matchAll(/<h([1-6])\b[^>]*>/gi)].map((m) => parseInt(m[1], 10));
    let prev = 0;
    const skips = [];
    for (const level of levels) {
      if (level > prev + 1) skips.push(`h${prev}->h${level}`);
      prev = level;
    }
    return skips;
  }

  it('no public/ page skips a heading level (only pricing.html failed this before the fix)', () => {
    const files = gitTrackedPublicHtmlFiles();
    assert.ok(files.length >= 14, `expected >= 14 tracked html files, found ${files.length}`);
    const failures = [];
    for (const f of files) {
      const skips = headingSkips(read(f));
      if (skips.length) failures.push(`${f}: ${skips.join(', ')}`);
    }
    assert.deepEqual(failures, [], `heading-level skips found:\n${failures.join('\n')}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// M1: for-builders #connect-heading (the primary finding) plus the sweep of
// the nine other <br>-carrying h1/h2s across for-agents/for-builders/
// pricing/index.
// ─────────────────────────────────────────────────────────────────────────
describe('FIX-UNIT-2 M1: heading <br> sweep (static markup)', () => {
  it('for-builders #connect-heading: <br> removed, text-wrap: balance added, words unchanged', () => {
    const html = read('public/for-builders.html');
    assert.match(html, /<h2 id="connect-heading" >Built for builders who'd rather ship than bill\.<\/h2>/);
    assert.doesNotMatch(html, /id="connect-heading"[^>]*>[^<]*<br>/);
    assert.match(html, /#connect-heading\s*\{\s*text-wrap:\s*balance;\s*\}/);
  });

  const FIXED = [
    ['public/for-agents.html', 'id="page-hero-heading"', 'Never rediscover what another agent already learned.', '#page-hero-heading'],
    ['public/for-agents.html', 'id="mcp-heading"', 'Native tools for Claude Code, Cursor, and any MCP-compatible client.', '#mcp-heading'],
    ['public/pricing.html', null, 'Search free. Pay only when you unlock, from $0.05.', '.pricing-page-header h1'],
  ];

  for (const [file, idAttr, text, balanceSelector] of FIXED) {
    it(`${file} ${idAttr || '(h1)'}: <br> removed, text unchanged, text-wrap: balance added`, () => {
      const html = read(file);
      assert.ok(html.includes(text), `${file}: expected text "${text}" not found verbatim`);
      const escaped = balanceSelector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      assert.match(html, new RegExp(`${escaped}\\s*\\{\\s*text-wrap:\\s*balance;\\s*\\}`));
    });
  }

  // FIX-UNIT-2B H1 correction: these three are each TWO SENTENCES
  // ("Your agents are already learning." / "Your earnings start now.").
  // Fix unit 2 removed their <br>, which let the 375px line break land
  // inside the second sentence instead of on the sentence boundary. The
  // <br> (with its original leading space) is restored; text-wrap:
  // balance stays, so each sentence still wraps evenly on its own when it
  // doesn't fit one line.
  const TWO_SENTENCE_BR_RESTORED = [
    ['public/for-builders.html', 'id="footer-cta-heading"', '#footer-cta-heading'],
    ['public/pricing.html', 'id="pricing-cta-heading"', '#pricing-cta-heading'],
    ['public/index.html', 'id="footer-cta-heading"', '#footer-cta-heading'],
  ];
  for (const [file, idAttr, balanceSelector] of TWO_SENTENCE_BR_RESTORED) {
    it(`${file} ${idAttr}: <br> restored between the two sentences, text-wrap: balance kept`, () => {
      const html = read(file);
      assert.match(html, new RegExp(`<h2 ${idAttr.replace(/"/g, '\\"')} >Your agents are already learning\\. <br>Your earnings start now\\.<\\/h2>`));
      const escaped = balanceSelector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      assert.match(html, new RegExp(`${escaped}\\s*\\{\\s*text-wrap:\\s*balance;\\s*\\}`));
    });
  }

  const UNCHANGED_WITH_BR = [
    ['public/for-agents.html', 'Two ways to pay, <br>both production-ready.'],
    ['public/for-agents.html', 'Stop rediscovering <br>what another agent already solved.'],
    ['public/for-builders.html', 'Build Once. <br>Keep Earning.'],
  ];
  for (const [file, snippet] of UNCHANGED_WITH_BR) {
    it(`${file}: "${snippet}" is untouched (measured — no single-word line at 375/768/1280, left as-is)`, () => {
      const html = read(file);
      assert.ok(html.includes(snippet), `${file}: expected the untouched heading "${snippet}"`);
    });
  }
});

describe('FIX-UNIT-2 M1: heading line-wrap measurements (rendered, static server)', { timeout: 120_000 }, () => {
  let server;
  let base;
  let browser;
  let ok = false;

  before(async () => {
    if (!isPlaywrightAvailable()) return;
    const http = require('node:http');
    const MIME = { '.html': 'text/html', '.css': 'text/css', '.woff2': 'font/woff2' };
    server = http.createServer((req, res) => {
      let urlPath = decodeURIComponent(req.url.split('?')[0]);
      if (urlPath === '/') urlPath = '/index.html';
      const filePath = path.join(PUBLIC_DIR, urlPath);
      fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404); res.end('not found'); return; }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
        res.end(data);
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    const { chromium } = require('playwright');
    browser = await chromium.launch();
    ok = true;
  });

  after(async () => {
    if (browser) await browser.close();
    if (server) server.close();
  });

  async function measure(page, selector) {
    return page.evaluate((sel) => {
      const el = document.querySelector(sel);
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
      const words = [];
      let node;
      while ((node = walker.nextNode())) {
        const re = /\S+/g; let m;
        while ((m = re.exec(node.textContent))) {
          const range = document.createRange();
          range.setStart(node, m.index); range.setEnd(node, m.index + m[0].length);
          const r = range.getClientRects()[0];
          if (r) words.push({ text: m[0], top: Math.round(r.top) });
        }
      }
      const lines = [];
      for (const w of words) {
        let line = lines.find((l) => Math.abs(l.top - w.top) <= 3);
        if (!line) { line = { top: w.top, words: [] }; lines.push(line); }
        line.words.push(w.text);
      }
      lines.sort((a, b) => a.top - b.top);
      return { lineCount: lines.length, anySingleWordLine: lines.some((l) => l.words.length === 1) };
    }, selector);
  }

  it('for-builders #connect-heading: 2 lines at 375, 1 line at 768, 2 lines at 1280, never a single-word line', async (t) => {
    if (!ok) { t.skip('playwright not resolvable'); return; }
    const expected = { 375: 2, 768: 1, 1280: 2 };
    for (const width of [375, 768, 1280]) {
      const height = width === 375 ? 812 : (width === 768 ? 1024 : 800);
      const ctx = await browser.newContext({ viewport: { width, height } });
      const page = await ctx.newPage();
      try {
        await page.goto(`${base}/for-builders.html`, { waitUntil: 'networkidle' });
        const m = await measure(page, '#connect-heading');
        assert.equal(m.lineCount, expected[width], `#connect-heading at ${width}px should render ${expected[width]} line(s), got ${m.lineCount}`);
        assert.equal(m.anySingleWordLine, false, `#connect-heading at ${width}px must not have a single-word line`);
      } finally {
        await ctx.close();
      }
    }
  });

  // FIX-UNIT-2B H1 correction: with the <br> restored between the two
  // sentences, 768/1280 must render exactly 2 lines (one sentence each).
  it('FIX-UNIT-2B H1: the three two-sentence CTA headings render exactly 2 lines at 768 and 1280 (one sentence per line)', async (t) => {
    if (!ok) { t.skip('playwright not resolvable'); return; }
    const TARGETS = [
      ['/for-builders.html', '#footer-cta-heading'],
      ['/pricing.html', '#pricing-cta-heading'],
      ['/index.html', '#footer-cta-heading'],
    ];
    for (const width of [768, 1280]) {
      const height = width === 768 ? 1024 : 800;
      const ctx = await browser.newContext({ viewport: { width, height } });
      const page = await ctx.newPage();
      try {
        for (const [route, selector] of TARGETS) {
          await page.goto(base + route, { waitUntil: 'networkidle' });
          const m = await measure(page, selector);
          assert.equal(m.lineCount, 2, `${route} ${selector} at ${width}px should render 2 lines (one sentence each), got ${m.lineCount}`);
          assert.equal(m.anySingleWordLine, false, `${route} ${selector} at ${width}px must not have a single-word line`);
        }
      } finally {
        await ctx.close();
      }
    }
  });

  const SWEEP = [
    ['/for-agents.html', '#mcp-heading', { 375: false, 768: false, 1280: false }],
    ['/for-builders.html', '#footer-cta-heading', { 375: false, 768: false, 1280: false }],
    ['/pricing.html', '.pricing-page-header h1', { 375: false, 768: false, 1280: false }],
    ['/pricing.html', '#pricing-cta-heading', { 375: false, 768: false, 1280: false }],
    ['/index.html', '#footer-cta-heading', { 375: false, 768: false, 1280: false }],
    // FIX-UNIT-2B H5: the 375px orphan reported above (fix unit 2) is now
    // corrected. Below 400px only, styles.css's shared DR-3 mobile type
    // ramp forces this heading to 40px !important; a narrower, equally-
    // !important id-selector media query (max-width: 399px) steps it down
    // to 39px, the smallest reduction that removes the single-word line
    // (text-wrap:balance alone could not, since 7 words needed a smaller
    // font to fit in 3 lines rather than 4). 768/1280 are untouched by
    // that query and stay as fix unit 2 left them.
    ['/for-agents.html', '#page-hero-heading', { 375: false, 768: false, 1280: false }],
  ];

  for (const [route, selector, expectSingle] of SWEEP) {
    it(`${route} ${selector}: single-word-line check across 375/768/1280`, async (t) => {
      if (!ok) { t.skip('playwright not resolvable'); return; }
      for (const width of [375, 768, 1280]) {
        const height = width === 375 ? 812 : (width === 768 ? 1024 : 800);
        const ctx = await browser.newContext({ viewport: { width, height } });
        const page = await ctx.newPage();
        try {
          await page.goto(base + route, { waitUntil: 'networkidle' });
          const m = await measure(page, selector);
          assert.equal(
            m.anySingleWordLine, expectSingle[width],
            `${route} ${selector} at ${width}px: anySingleWordLine=${m.anySingleWordLine}, expected ${expectSingle[width]} (lines=${m.lineCount})`
          );
        } finally {
          await ctx.close();
        }
      }
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// FIX-UNIT-2B H2 + H3: homepage hero — h1 at 1280 (was 3 lines, "before."
// orphaned), and the "See How It Works" link's position/fit inside the
// first screen at 1280x800 and 375x812.
// ─────────────────────────────────────────────────────────────────────────
describe('FIX-UNIT-2B H2/H3: homepage hero h1 width + CTA link placement', { timeout: 120_000 }, () => {
  let server;
  let base;
  let browser;
  let ok = false;

  before(async () => {
    if (!isPlaywrightAvailable()) return;
    const http = require('node:http');
    const MIME = { '.html': 'text/html', '.css': 'text/css', '.woff2': 'font/woff2' };
    server = http.createServer((req, res) => {
      let urlPath = decodeURIComponent(req.url.split('?')[0]);
      if (urlPath === '/') urlPath = '/index.html';
      const filePath = path.join(PUBLIC_DIR, urlPath);
      fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404); res.end('not found'); return; }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
        res.end(data);
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    const { chromium } = require('playwright');
    browser = await chromium.launch();
    ok = true;
  });

  after(async () => {
    if (browser) await browser.close();
    if (server) server.close();
  });

  it('H2: #hero h1 max-width raised (820px -> 950px) so 1280px renders 2 lines with no orphan word; 375/768 unchanged (still no single-word line)', () => {
    const css = read('public/styles.css');
    const m = css.match(/#hero h1\s*\{([^}]*)\}/);
    assert.ok(m, '#hero h1 rule found');
    assert.match(m[1], /max-width:\s*950px/);
    assert.doesNotMatch(m[1], /font-size:\s*clamp\(4[1-9]px/, 'font-size clamp minimum must not have changed from 40px');
  });

  it('H2 rendered: homepage h1 has no single-word line at 375, 768 or 1280 (2 lines at 1280, was 3)', async (t) => {
    if (!ok) { t.skip('playwright not resolvable'); return; }
    const expected = { 375: 4, 768: 2, 1280: 2 };
    for (const width of [375, 768, 1280]) {
      const height = width === 375 ? 812 : (width === 768 ? 1024 : 800);
      const ctx = await browser.newContext({ viewport: { width, height } });
      const page = await ctx.newPage();
      try {
        await page.goto(`${base}/index.html`, { waitUntil: 'networkidle' });
        const m = await page.evaluate(() => {
          const el = document.getElementById('hero-heading');
          const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
          const words = [];
          let node;
          while ((node = walker.nextNode())) {
            const re = /\S+/g; let mm;
            while ((mm = re.exec(node.textContent))) {
              const range = document.createRange();
              range.setStart(node, mm.index); range.setEnd(node, mm.index + mm[0].length);
              const r = range.getClientRects()[0];
              if (r) words.push(Math.round(r.top));
            }
          }
          const lines = [];
          for (const top of words) {
            let line = lines.find((l) => Math.abs(l.top - top) <= 3);
            if (!line) { line = { top, count: 0 }; lines.push(line); }
            line.count += 1;
          }
          return { lineCount: lines.length, anySingleWordLine: lines.some((l) => l.count === 1) };
        });
        assert.equal(m.lineCount, expected[width], `homepage h1 at ${width}px should render ${expected[width]} lines, got ${m.lineCount}`);
        assert.equal(m.anySingleWordLine, false, `homepage h1 at ${width}px must not have a single-word line`);
      } finally {
        await ctx.close();
      }
    }
  });

  it('H3: .hero-install-row stays a column at every width (id override beats the shared 981px row switch)', () => {
    const html = read('public/index.html');
    assert.match(html, /#hero \.hero-install-row\s*\{\s*flex-direction:\s*column;\s*align-items:\s*flex-start;\s*\}/);
  });

  it('H3 rendered: "See How It Works" sits under the two setup notes, left-aligned with them, and its bottom edge is inside the first screen at 1280x800 and 375x812', async (t) => {
    if (!ok) { t.skip('playwright not resolvable'); return; }
    for (const [width, height] of [[1280, 800], [375, 812]]) {
      const ctx = await browser.newContext({ viewport: { width, height } });
      const page = await ctx.newPage();
      try {
        await page.goto(`${base}/index.html`, { waitUntil: 'networkidle' });
        const info = await page.evaluate(() => {
          const link = document.getElementById('hero-cta-secondary');
          const notes = Array.from(document.querySelectorAll('.hero-setup-note'));
          const linkRect = link.getBoundingClientRect();
          const lastNoteRect = notes[notes.length - 1].getBoundingClientRect();
          return {
            linkLeft: linkRect.left, linkTop: linkRect.top, linkBottom: linkRect.bottom, linkHeight: linkRect.height,
            noteLeft: notes[0].getBoundingClientRect().left,
            lastNoteBottom: lastNoteRect.bottom,
          };
        });
        assert.equal(info.linkLeft, info.noteLeft, `at ${width}x${height}: link left (${info.linkLeft}) should match the setup notes' left (${info.noteLeft})`);
        assert.ok(info.linkTop >= info.lastNoteBottom, `at ${width}x${height}: link top (${info.linkTop}) should be at/below the last note's bottom (${info.lastNoteBottom})`);
        assert.ok(info.linkHeight >= 44, `at ${width}x${height}: link height ${info.linkHeight} must stay >= 44 (touch target)`);
        assert.ok(info.linkBottom <= height, `at ${width}x${height}: link bottom (${info.linkBottom}) must be inside the first screen (${height})`);
        console.log(`H3 [${width}x${height}] "See How It Works" bottom edge: ${info.linkBottom}px`);
      } finally {
        await ctx.close();
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// FIX-UNIT-2B H4: /works-with h1 no longer orphans "Run".
// ─────────────────────────────────────────────────────────────────────────
describe('FIX-UNIT-2B H4: /works-with h1 text-wrap: balance', () => {
  it('.ww-h1 carries text-wrap: balance', () => {
    const html = read('public/works-with.html');
    const m = html.match(/\.ww-h1\s*\{([^}]*)\}/);
    assert.ok(m, '.ww-h1 rule found');
    assert.match(m[1], /text-wrap:\s*balance/);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// FIX-UNIT-2B H5: /for-agents #page-hero-heading, below 400px only, steps
// down from the shared DR-3 mobile ramp's 40px !important to 39px.
// ─────────────────────────────────────────────────────────────────────────
describe('FIX-UNIT-2B H5: /for-agents #page-hero-heading font-size step below 400px', { timeout: 60_000 }, () => {
  it('a max-width:399px, !important, id-scoped rule sets 39px (one step below the shared 40px !important ramp)', () => {
    const html = read('public/for-agents.html');
    const m = html.match(/@media \(max-width: 399px\) \{\s*#page-hero-heading \{ font-size:\s*([0-9.]+)px !important; \}\s*\}/);
    assert.ok(m, 'the max-width:399px #page-hero-heading font-size override was not found');
    assert.equal(m[1], '39');
  });

  it('rendered: 39px at 375 (orphan gone), untouched (40px, from the shared ramp) at 400-600, untouched clamp at 768/1280', async (t) => {
    if (!isPlaywrightAvailable()) { t.skip('playwright not resolvable'); return; }
    const http = require('node:http');
    const MIME = { '.html': 'text/html', '.css': 'text/css' };
    const server = http.createServer((req, res) => {
      const filePath = path.join(PUBLIC_DIR, decodeURIComponent(req.url.split('?')[0]));
      fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404); res.end('not found'); return; }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
        res.end(data);
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const { chromium } = require('playwright');
    const browser = await chromium.launch();
    try {
      for (const [width, expectedSize] of [[375, '39px'], [500, '40px'], [768, '38.4px'], [1280, '56px']]) {
        const ctx = await browser.newContext({ viewport: { width, height: 900 } });
        const page = await ctx.newPage();
        try {
          await page.goto(`${base}/for-agents.html`, { waitUntil: 'networkidle' });
          const fontSize = await page.evaluate(() => getComputedStyle(document.getElementById('page-hero-heading')).fontSize);
          assert.equal(fontSize, expectedSize, `at ${width}px, #page-hero-heading font-size should be ${expectedSize}, got ${fontSize}`);
        } finally {
          await ctx.close();
        }
      }
    } finally {
      await browser.close();
      server.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// FIX-UNIT-2B Part A: /for-builders new FAQ item Q-01 REV 2
// (REGISTER-Q-FINAL.md, "Q-01 REV 2").
// ─────────────────────────────────────────────────────────────────────────
describe('FIX-UNIT-2B Part A: /for-builders FAQ item Q-01 REV 2', () => {
  const HTML = read('public/for-builders.html');
  const QUESTION = 'Does Auxilo work if I do not use Claude Code?';
  const BOUNDARY_SENTENCE = 'Drafting runs through Claude Code, when you are signed in to it, or a provider key you set yourself. Without either, captured sessions are held and nothing is submitted.';

  function stripTags(html) {
    return html
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&#x27;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function jsonLdEntries(html) {
    const scriptMatch = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
    const data = JSON.parse(scriptMatch[1]);
    const faqNode = data['@graph'].find((n) => n['@type'] === 'FAQPage');
    return faqNode.mainEntity;
  }

  function visibleAnswerInner(html, question) {
    const marker = `<span>${question}</span>`;
    const idx = html.indexOf(marker);
    if (idx === -1) return null;
    const rest = html.slice(idx + marker.length);
    const m = rest.match(/<div class="faq-answer-inner">([\s\S]*?)<\/div>/);
    return m ? m[1] : null;
  }

  it('the question appears exactly once in visible text and exactly once in the JSON-LD', () => {
    const visibleSpans = [...HTML.matchAll(/<button class="faq-question"[^>]*>\s*<span>([^<]+)<\/span>/g)].map((m) => m[1]);
    assert.equal(visibleSpans.filter((q) => q === QUESTION).length, 1, 'question appears exactly once in the rendered FAQ');
    const entries = jsonLdEntries(HTML);
    assert.equal(entries.filter((e) => e.name === QUESTION).length, 1, 'question appears exactly once in the FAQPage JSON-LD');
  });

  it('the visible answer, tags stripped, equals the JSON-LD answer exactly', () => {
    const visible = visibleAnswerInner(HTML, QUESTION);
    assert.ok(visible, 'visible answer found');
    const entries = jsonLdEntries(HTML);
    const entry = entries.find((e) => e.name === QUESTION);
    assert.ok(entry, 'JSON-LD entry found');
    assert.equal(stripTags(visible), entry.acceptedAnswer.text, 'visible answer (tags stripped) must equal the JSON-LD answer text');
  });

  it('the answer contains the canonical boundary sentence verbatim (visible and JSON-LD)', () => {
    const visible = visibleAnswerInner(HTML, QUESTION);
    assert.ok(visible.includes(BOUNDARY_SENTENCE), 'visible answer contains the boundary sentence verbatim');
    const entries = jsonLdEntries(HTML);
    const entry = entries.find((e) => e.name === QUESTION);
    assert.ok(entry.acceptedAnswer.text.includes(BOUNDARY_SENTENCE), 'JSON-LD answer contains the boundary sentence verbatim');
  });

  it('the answer contains no colon, no em dash, no en dash', () => {
    const visible = stripTags(visibleAnswerInner(HTML, QUESTION));
    assert.doesNotMatch(visible, /:/, 'no colon');
    assert.doesNotMatch(visible, /—/, 'no em dash');
    assert.doesNotMatch(visible, /–/, 'no en dash');
    const entries = jsonLdEntries(HTML);
    const text = entries.find((e) => e.name === QUESTION).acceptedAnswer.text;
    assert.doesNotMatch(text, /:/, 'no colon (JSON-LD)');
    assert.doesNotMatch(text, /—/, 'no em dash (JSON-LD)');
    assert.doesNotMatch(text, /–/, 'no en dash (JSON-LD)');
  });

  it('the /for-builders FAQ now has eight items (was seven), the new one placed fourth, directly after "Who sets the price for my learnings?"', () => {
    const visibleSpans = [...HTML.matchAll(/<button class="faq-question"[^>]*>\s*<span>([^<]+)<\/span>/g)].map((m) => m[1]);
    assert.equal(visibleSpans.length, 8, 'rendered FAQ has 8 items');
    assert.equal(visibleSpans[2], 'Who sets the price for my learnings?');
    assert.equal(visibleSpans[3], QUESTION, 'new question is the 4th item');
    const entries = jsonLdEntries(HTML);
    assert.equal(entries.length, 8, 'JSON-LD mainEntity has 8 items');
    assert.equal(entries[3].name, QUESTION, 'new question is the 4th JSON-LD entry');
  });

  it('the link target is /legal/supported-clients (matching /for-agents and /how-it-works)', () => {
    const visible = visibleAnswerInner(HTML, QUESTION);
    assert.match(visible, /<a href="\/legal\/supported-clients">supported clients page<\/a>/);
  });

  it('inline markup: npx auxilo setup and npx auxilo provider set are each in <code>; the JSON-LD mirror is plain text with identical words', () => {
    const visible = visibleAnswerInner(HTML, QUESTION);
    assert.match(visible, /<code[^>]*>npx auxilo setup<\/code>/);
    assert.match(visible, /<code[^>]*>npx auxilo provider set<\/code>/);
    const entries = jsonLdEntries(HTML);
    const text = entries.find((e) => e.name === QUESTION).acceptedAnswer.text;
    assert.doesNotMatch(text, /<[^>]+>/, 'JSON-LD answer has no markup');
    assert.ok(text.includes('npx auxilo setup') && text.includes('npx auxilo provider set'));
  });
});
