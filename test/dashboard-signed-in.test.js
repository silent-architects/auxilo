'use strict';

/**
 * test/dashboard-signed-in.test.js
 *
 * The signed-in dashboard and its sign-in screen: the accessibility attributes
 * the page's script puts on the review queue and the sign-in form, and the look
 * of the cards, the earnings figures, the chips, the disabled buttons and the
 * bulk actions.
 *
 * Static checks read public/dashboard.html. Rendered checks load that page in a
 * browser from a small static server over public/, with the account API mocked
 * by route handlers (no data directory, no network, no real server). The rendered
 * checks compare two measurements taken in the same run; none pins a pixel
 * number that depends on how text is drawn.
 *
 * Runner: node --test test/dashboard-signed-in.test.js
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const PUBLIC = path.join(REPO, 'public');
const SRC = fs.readFileSync(path.join(PUBLIC, 'dashboard.html'), 'utf8');
const STYLE = SRC.slice(SRC.indexOf('<style>') + 7, SRC.indexOf('</style>'));
const SCRIPT = SRC.slice(SRC.indexOf('<script>\n(function') + 8, SRC.lastIndexOf('</script>'));

// ── Static helpers (each has a positive control below) ────────────────────

/** The body of the first CSS rule whose selector list contains `selector` exactly. */
function ruleBodies(css, selector) {
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');
  let m;
  while ((m = re.exec(bare))) {
    const sels = m[1].split(',').map((x) => x.trim());
    if (sels.includes(selector)) out.push(m[2]);
  }
  return out;
}

/** True when buildTriageRow names the checkbox from the row's own title element. */
function checkboxNamedFromTitle(script) {
  const labelled = /box\.setAttribute\('aria-labelledby',\s*'triage-title-'\s*\+\s*row\.id\)/.test(script);
  const titleId = /titleBtn\.id\s*=\s*'triage-title-'\s*\+\s*row\.id/.test(script);
  return labelled && titleId;
}

// ── Static: the attributes the script and markup carry ────────────────────

describe('dashboard accessibility attributes (static)', () => {
  it('each queue checkbox is named from its row title element, whose id derives from the row id', () => {
    assert.equal(checkboxNamedFromTitle(SCRIPT), true);
    // Control: the check fails when either half is missing.
    assert.equal(checkboxNamedFromTitle(SCRIPT.replace(/titleBtn\.id\s*=\s*'triage-title-'\s*\+\s*row\.id;/, '')), false);
    assert.equal(checkboxNamedFromTitle(SCRIPT.replace(/box\.setAttribute\('aria-labelledby'[^;]*;/, '')), false);
    // The id the label points at is built from the same id the checkbox already uses.
    assert.match(SCRIPT, /box\.id\s*=\s*'triage-check-'\s*\+\s*row\.id/);
  });

  it('the title toggle carries aria-expanded (starting closed) and aria-controls naming the detail row it opens', () => {
    assert.match(SCRIPT, /titleBtn\.setAttribute\('aria-expanded',\s*'false'\)/);
    assert.match(SCRIPT, /titleBtn\.setAttribute\('aria-controls',\s*'triage-detail-'\s*\+\s*row\.id\)/);
    // The detail row it controls is the one toggleTriageDetail builds with that id.
    assert.match(SCRIPT, /detailTr\.id\s*=\s*'triage-detail-'\s*\+\s*row\.id/);
    // Both ends of the toggle set the state.
    const fn = SCRIPT.slice(SCRIPT.indexOf('function toggleTriageDetail'), SCRIPT.indexOf('function markRowDecided'));
    assert.match(fn, /existing\.remove\(\);\s*if \(toggleBtn\) toggleBtn\.setAttribute\('aria-expanded',\s*'false'\)/);
    assert.match(fn, /insertBefore\(detailTr, tr\.nextSibling\);\s*if \(toggleBtn\) toggleBtn\.setAttribute\('aria-expanded',\s*'true'\)/);
    // Control: the extractor really sees a function body with both calls (not an empty slice).
    assert.equal((fn.match(/aria-expanded/g) || []).length, 2);
  });

  it('the sign-in confirmation sits in a role=status container that is never display:none', () => {
    const m = /<div role="status">\s*<div id="login-sent"[^>]*>\s*<div class="alert alert-success" id="login-sent-msg"><\/div>/.exec(SRC);
    assert.ok(m, 'the status container wraps #login-sent and so #login-sent-msg');
    assert.doesNotMatch(m[0].split('<div id="login-sent"')[0], /display\s*:\s*none/, 'the container itself is always rendered');
    // Control: #login-sent itself is the element that is hidden until the link is sent.
    assert.match(SRC, /<div id="login-sent" style="display:none">/);
  });

  it('#terms-scroll-region is a region and keeps its keyboard stop and its accessible name', () => {
    const tag = /<div id="terms-scroll-region"[^>]*>/.exec(SRC)[0];
    assert.match(tag, /role="region"/);
    assert.match(tag, /tabindex="0"/);
    assert.match(tag, /aria-label="Terms of Service, scrollable"/);
  });

  it('Enter in the email field calls the same function the button calls, and does nothing while the button is disabled', () => {
    assert.match(SRC, /<button class="btn btn-primary" id="login-btn" onclick="submitMagicLink\(\)"/);
    const block = SCRIPT.slice(SCRIPT.indexOf("var emailField = document.getElementById('login-email')"), SCRIPT.indexOf('// ── Sign out'));
    assert.match(block, /addEventListener\('keydown'/);
    assert.match(block, /e\.key !== 'Enter'/);
    assert.match(block, /sendBtn && sendBtn\.disabled\) return/);
    assert.match(block, /window\.submitMagicLink\(\)/);
    // Control: the slice is the handler (it does not run past it into the sign-out code).
    assert.doesNotMatch(block, /clearToken/);
  });
});

// ── Static: the look rules ────────────────────────────────────────────────

describe('dashboard look rules (static)', () => {
  it('no rule paints an earnings figure gold', () => {
    const bodies = ruleBodies(STYLE, '.earnings-value.aurum');
    assert.deepEqual(bodies.filter((b) => /color\s*:/.test(b)), []);
    // Control: the helper finds the figure rule and sees its colour.
    const base = ruleBodies(STYLE, '.earnings-value');
    assert.equal(base.length, 1);
    assert.match(base[0], /color:\s*var\(--fg-1\)/);
  });

  it('the four chip classes the script sets carry no style of their own', () => {
    for (const cls of ['.tag-category', '.tag-clean', '.tag-warn', '.tag-danger']) {
      assert.deepEqual(ruleBodies(STYLE, cls), [], `${cls} draws nothing`);
    }
    const tag = ruleBodies(STYLE, '.tag');
    assert.equal(tag.length, 1);
    assert.match(tag[0], /background:\s*var\(--tint\)/);
    assert.match(tag[0], /border:\s*0/);
    assert.match(tag[0], /white-space:\s*nowrap/);
  });

  it('a disabled button is a tint fill with note ink, no border, not-allowed, at full opacity', () => {
    const bodies = ruleBodies(STYLE, '.btn:disabled');
    assert.equal(bodies.length, 1);
    const b = bodies[0];
    assert.match(b, /background:\s*var\(--tint\)/);
    assert.match(b, /color:\s*var\(--fg-3\)/);
    assert.match(b, /border-color:\s*transparent/);
    assert.match(b, /opacity:\s*1\b/);
    assert.match(b, /cursor:\s*not-allowed/);
    assert.doesNotMatch(STYLE, /\.btn:disabled\s*\{\s*opacity:\s*0\.45/);
  });
});

// ── Rendered ──────────────────────────────────────────────────────────────

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
};

function b64u(o) {
  return Buffer.from(JSON.stringify(o)).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
// The page only decodes the token to read its expiry; the server is not involved.
const TOKEN = `${b64u({ alg: 'HS256', typ: 'JWT' })}.${b64u({ accountId: 'acc_x', email: 'builder@example.com', exp: Math.floor(Date.now() / 1000) + 86400 })}.sig`;

const QUEUE = [
  { id: 'l1', title: "MCP tool inputSchema must use 'object' type at the top level or tools won't appear", category: 'code-execution', quality: 19, lane: 'ready_to_publish', screens_passed: true, created_at: '2026-09-28T10:00:00Z' },
  { id: 'l2', title: 'JSONL is better than JSON arrays for append-heavy logs on minimal VMs', category: 'storage-state', quality: 17, lane: 'ready_to_publish', screens_passed: true, created_at: '2026-09-29T10:00:00Z' },
  { id: 'l3', title: 'Pinecone upsert requires vectors array not a single vector object', category: 'data-processing', quality: null, lane: 'needs_score', screens_passed: true, created_at: '2026-09-30T10:00:00Z' },
  { id: 'l4', title: 'A learning a screen flagged for a second look before anything publishes it anywhere', category: 'payment-financial', quality: 18, lane: 'needs_your_eyes', flags: ['injection', 'content_sensitivity'], why: 'An injection pattern was detected in the body text.', visibility: 'private', screens_passed: false, created_at: '2026-10-01T10:00:00Z' },
];

const GOLD = ['rgb(201, 168, 76)', 'rgb(122, 93, 16)'];

describe('dashboard signed in (rendered)', { timeout: 240_000 }, () => {
  let server;
  let base;
  let browser;
  let skip = null;

  before(async () => {
    let playwright;
    try {
      playwright = require(path.join(REPO, 'node_modules', 'playwright'));
    } catch (e) {
      skip = `playwright not resolvable: ${e.message}`;
      return;
    }
    server = http.createServer((req, res) => {
      const pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      const rel = pathname === '/dashboard' ? 'dashboard.html' : pathname.replace(/^\/+/, '');
      const file = path.normalize(path.join(PUBLIC, rel));
      if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        res.writeHead(404); res.end('not found'); return;
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(fs.readFileSync(file));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    try {
      browser = await playwright.chromium.launch();
    } catch (e) {
      skip = `chromium not launchable: ${e.message}`;
    }
  });

  after(async () => {
    if (browser) await browser.close();
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  /** A page on the dashboard with the account API mocked. cfg.token false = signed out. */
  async function open(width, cfg) {
    const c = Object.assign({ token: true, queue: QUEUE, earnings: {}, lane: 'off', published: 3, magic: null }, cfg || {});
    const ctx = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    const json = (route, body, status) => route.fulfill({ status: status || 200, contentType: 'application/json', body: JSON.stringify(body) });
    await page.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== base) return route.abort();
      const p = url.pathname;
      if (p === '/health') return json(route, { payments_enabled: false, stripe_configured: false });
      if (p === '/auth/magic-link') {
        if (c.magic) return c.magic(route, json);
        return json(route, { message: 'Check your email for the magic link.' });
      }
      if (p === '/account/terms-status') return json(route, { needs_acceptance: false, accepted: true, current_tos_version: 'v0' });
      if (p === '/account/earnings') {
        return json(route, Object.assign({ pending_balance: 14.25, total_gross_usd: 21.5, total_contributor: 15.05, total_withdrawn: 0, payouts_paused: true, can_withdraw: false, wallet: null }, c.earnings));
      }
      if (p === '/account/api-keys') return json(route, { keys: [] });
      if (p === '/account/purchases') return json(route, { purchases: [], total_spent_usd: 0 });
      if (p === '/account/credits') return json(route, { credit_balance: { total_usd: 8.5, frozen_usd: 2 } });
      if (p === '/account/settings') return json(route, { autonomous_extraction_mode: 'on', earning_notifications_available: true, earning_notifications_enabled: true });
      if (p === '/account/pending/summary') {
        const by = (lane) => c.queue.filter((i) => i.lane === lane).length;
        return json(route, { items: c.queue, pending_count: c.queue.length, counts: { by_lane: { ready_to_publish: by('ready_to_publish'), needs_score: by('needs_score'), needs_your_eyes: by('needs_your_eyes') } } });
      }
      if (p === '/account/pending') return json(route, { learnings: c.queue.map((i) => Object.assign({}, i, { body: 'Body of the learning.' })), pending_count: c.queue.length });
      if (p === '/account/clean-lane') {
        const common = { consent_version_current: 'cl-v1', consent_version_recorded: 'cl-v1', min_auto_publish_quality: 16, last_action_at: '2026-09-25T10:00:00Z' };
        if (c.lane === 'frozen') return json(route, Object.assign(common, { clean_lane_active: false, freeze_reason: 'retraction_rate' }));
        return json(route, Object.assign(common, { clean_lane_active: false }));
      }
      if (p === '/account/learnings') return json(route, { total: c.published, learnings: [] });
      if (p.startsWith('/account/') || p === '/terms') return route.fulfill({ status: 404, body: 'x' });
      return route.continue();
    });
    await page.addInitScript(([tok]) => {
      try { if (tok) localStorage.setItem('auxilo_session', tok); } catch (e) { /* storage blocked */ }
      // Records every sign-in request the page makes, synchronously at the call.
      window.__magicCalls = [];
      const realFetch = window.fetch.bind(window);
      window.fetch = function (u, init) {
        if (String(u).includes('/auth/magic-link')) {
          window.__magicCalls.push({ url: String(u), method: init && init.method, body: init && init.body, headers: JSON.stringify(init && init.headers) });
        }
        return realFetch(u, init);
      };
    }, [c.token ? TOKEN : null]);
    await page.goto(`${base}/dashboard`, { waitUntil: 'networkidle' });
    await page.evaluate(() => document.fonts.ready);
    if (c.token) {
      await page.waitForSelector('#earnings-grid .earnings-item', { state: 'attached' });
      if (c.queue.length) await page.waitForSelector('.triage-table', { state: 'attached' });
    }
    return { ctx, page };
  }

  // ── Sign-in ─────────────────────────────────────────────────────────────

  it('Enter in the email field sends the same request, with the same body, as a click on Send magic link', async (t) => {
    if (skip) { t.skip(skip); return; }
    const a = await open(1280, { token: false });
    let clicked;
    try {
      await a.page.fill('#login-email', 'you@example.com');
      await a.page.click('#login-btn');
      await a.page.waitForSelector('#login-sent', { state: 'visible' });
      clicked = await a.page.evaluate(() => window.__magicCalls);
      assert.equal(clicked.length, 1, 'positive control: the button sends one request');
      assert.equal(JSON.parse(clicked[0].body).email, 'you@example.com');
    } finally { await a.ctx.close(); }

    const b = await open(1280, { token: false });
    try {
      await b.page.fill('#login-email', 'you@example.com');
      await b.page.press('#login-email', 'Enter');
      await b.page.waitForSelector('#login-sent', { state: 'visible' });
      const entered = await b.page.evaluate(() => window.__magicCalls);
      assert.equal(entered.length, 1, 'Enter sends exactly one request');
      assert.deepEqual(entered[0], clicked[0], 'same url, method, body and headers as the click');
    } finally { await b.ctx.close(); }
  });

  it('Enter with an empty field shows the same line the button shows and sends nothing', async (t) => {
    if (skip) { t.skip(skip); return; }
    const a = await open(375, { token: false });
    try {
      await a.page.click('#login-btn');
      const viaButton = await a.page.textContent('#login-alert');
      assert.equal(viaButton, 'Please enter your email address.', 'positive control: the button path');
    } finally { await a.ctx.close(); }
    const b = await open(375, { token: false });
    try {
      await b.page.press('#login-email', 'Enter');
      assert.equal(await b.page.textContent('#login-alert'), 'Please enter your email address.');
      assert.equal((await b.page.evaluate(() => window.__magicCalls)).length, 0);
    } finally { await b.ctx.close(); }
  });

  it('Enter while a request is in flight sends no second request, as a click on the disabled button sends none', async (t) => {
    if (skip) { t.skip(skip); return; }
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const { ctx, page } = await open(1280, {
      token: false,
      magic: async (route, json) => { await gate; return json(route, { message: 'Check your email for the magic link.' }); },
    });
    try {
      await page.fill('#login-email', 'you@example.com');
      await page.press('#login-email', 'Enter');
      assert.equal(await page.isDisabled('#login-btn'), true, 'the first request disables the button');
      await page.press('#login-email', 'Enter');
      await page.press('#login-email', 'Enter');
      assert.equal((await page.evaluate(() => window.__magicCalls)).length, 1, 'repeats and a second Enter send nothing');
      release();
      await page.waitForSelector('#login-sent', { state: 'visible' });
      assert.equal((await page.evaluate(() => window.__magicCalls)).length, 1);
    } finally { release(); await ctx.close(); }
  });

  it('the confirmation container is always rendered and announces the message once it appears', async (t) => {
    if (skip) { t.skip(skip); return; }
    const { ctx, page } = await open(375, { token: false });
    try {
      const before = await page.evaluate(() => {
        const wrap = document.getElementById('login-sent-msg').closest('[role="status"]');
        if (!wrap) return null;
        let hidden = false;
        for (let el = wrap; el && el !== document.documentElement; el = el.parentElement) {
          if (getComputedStyle(el).display === 'none') hidden = true;
        }
        return { exists: true, hidden, sentHidden: getComputedStyle(document.getElementById('login-sent')).display === 'none' };
      });
      assert.ok(before && before.exists, 'the message has a role=status ancestor');
      assert.equal(before.hidden, false, 'the status container and everything above it is rendered before the send');
      assert.equal(before.sentHidden, true, 'positive control: the confirmation itself is hidden until the send');
      assert.equal(await page.getByRole('status').filter({ hasText: 'Check your email for the magic link.' }).count(), 0);
      await page.fill('#login-email', 'you@example.com');
      await page.click('#login-btn');
      await page.waitForSelector('#login-sent', { state: 'visible' });
      assert.equal(await page.getByRole('status').filter({ hasText: 'Check your email for the magic link.' }).count(), 1);
    } finally { await ctx.close(); }
  });

  // ── Review queue ────────────────────────────────────────────────────────

  it('every queue checkbox has an accessible name equal to its row title, and the Terms region is a named region', async (t) => {
    if (skip) { t.skip(skip); return; }
    const { ctx, page } = await open(1280);
    try {
      for (const row of QUEUE) {
        assert.equal(await page.getByRole('checkbox', { name: row.title, exact: true }).count(), 1, `checkbox named "${row.title}"`);
      }
      // Controls: the query discriminates, and the page's other checkbox is found by its own name.
      assert.equal(await page.getByRole('checkbox', { name: 'A title no row has', exact: true }).count(), 0);
      assert.equal(await page.getByRole('checkbox', { name: 'Unlock emails' }).count(), 1);
      const ids = await page.evaluate(() => [...document.querySelectorAll('input[id^="triage-check-"]')].map((box) => {
        const target = document.getElementById(box.getAttribute('aria-labelledby'));
        return { id: box.id, target: target && target.id, isTitle: !!target && target.classList.contains('triage-title-btn') };
      }));
      assert.equal(ids.length, QUEUE.length);
      for (const x of ids) {
        assert.equal(x.target, x.id.replace('triage-check-', 'triage-title-'));
        assert.equal(x.isTitle, true);
      }
      const region = await page.evaluate(() => {
        const el = document.getElementById('terms-scroll-region');
        return { role: el.getAttribute('role'), tabindex: el.getAttribute('tabindex'), label: el.getAttribute('aria-label') };
      });
      assert.deepEqual(region, { role: 'region', tabindex: '0', label: 'Terms of Service, scrollable' });
    } finally { await ctx.close(); }
  });

  it('the title toggle reports its state: aria-expanded follows open and closed, and aria-controls names the detail row', async (t) => {
    if (skip) { t.skip(skip); return; }
    const { ctx, page } = await open(1280);
    try {
      const btn = page.locator('#triage-title-l1');
      assert.equal(await btn.getAttribute('aria-expanded'), 'false');
      const controls = await btn.getAttribute('aria-controls');
      assert.equal(controls, 'triage-detail-l1');
      assert.equal(await page.locator(`#${controls}`).count(), 0, 'closed: the controlled row is not in the page');
      await btn.click();
      await page.waitForSelector(`#${controls}`, { state: 'attached' });
      assert.equal(await btn.getAttribute('aria-expanded'), 'true');
      assert.equal(await page.locator('#triage-title-l2').getAttribute('aria-expanded'), 'false', 'another row is unaffected');
      await btn.click();
      assert.equal(await btn.getAttribute('aria-expanded'), 'false');
      assert.equal(await page.locator(`#${controls}`).count(), 0, 'closed again: the row is gone');
      assert.equal(await page.getByRole('button', { name: QUEUE[0].title, exact: true }).count(), 1, 'the toggle keeps its name');
    } finally { await ctx.close(); }
  });

  // ── Earnings figures ────────────────────────────────────────────────────

  async function earningsRows(page) {
    const m = await page.evaluate(() => {
      const grid = document.getElementById('earnings-grid');
      const g = grid.getBoundingClientRect();
      return {
        left: g.left,
        right: g.right,
        items: [...grid.children].map((el) => {
          const r = el.getBoundingClientRect();
          return { left: r.left, right: r.right, top: r.top, valueTop: el.querySelector('.earnings-value').getBoundingClientRect().top };
        }),
      };
    });
    const rows = [];
    for (const it of m.items) {
      const row = rows.find((r) => Math.abs(r[0].top - it.top) < 1);
      if (row) row.push(it); else rows.push([it]);
    }
    return { grid: m, rows };
  }

  /** Every row spans the grid edge to edge with one gap between cells, and its figures share a top. */
  function rowsAreEven({ grid, rows }) {
    for (const row of rows) {
      const cells = row.slice().sort((a, b) => a.left - b.left);
      if (Math.abs(cells[0].left - grid.left) > 1) return false;
      if (Math.abs(cells[cells.length - 1].right - grid.right) > 1) return false;
      const gaps = cells.slice(1).map((c, i) => c.left - cells[i].right);
      if (gaps.some((x) => Math.abs(x - gaps[0]) > 1)) return false;
      if (row.some((c) => Math.abs(c.valueTop - row[0].valueTop) > 0.5)) return false;
    }
    return true;
  }

  it('the checker that judges the earnings grid rejects a ragged grid and a figure off its row\'s baseline', () => {
    const grid = { left: 0, right: 100 };
    const cell = (left, right, valueTop) => ({ left, right, top: 0, valueTop });
    assert.equal(rowsAreEven({ grid, rows: [[cell(0, 50, 10), cell(50, 100, 10)]] }), true);
    assert.equal(rowsAreEven({ grid, rows: [[cell(0, 50, 10)]] }), false, 'one cell short of the edge');
    assert.equal(rowsAreEven({ grid, rows: [[cell(0, 50, 10), cell(50, 100, 14)]] }), false, 'figures off one baseline');
  });

  const LAYOUTS = [
    { width: 1280, four: [4], five: [3, 2] },
    { width: 1024, four: [4], five: [3, 2] },
    { width: 768, four: [2, 2], five: [2, 2, 1] },
    { width: 375, four: [1, 1, 1, 1], five: [1, 1, 1, 1, 1] },
  ];

  it('the earnings figures lay out as an even grid at four and at five, with one baseline per row and no figure alone beside empty space', async (t) => {
    if (skip) { t.skip(skip); return; }
    for (const { width, four, five } of LAYOUTS) {
      for (const [count, expected, earnings] of [[4, four, {}], [5, five, { held_pending_assent: 3.2 }]]) {
        const { ctx, page } = await open(width, { earnings });
        try {
          const measured = await earningsRows(page);
          assert.equal(measured.grid.items.length, count, `${width}: ${count} figures rendered`);
          assert.deepEqual(measured.rows.map((r) => r.length), expected, `${width} at ${count}: figures per row`);
          assert.equal(rowsAreEven(measured), true, `${width} at ${count}: every row fills the grid and its figures share one baseline`);
        } finally { await ctx.close(); }
      }
    }
  });

  it('the label box is two lines tall wherever the figures sit side by side, so a one-line label and a two-line label share a baseline', async (t) => {
    if (skip) { t.skip(skip); return; }
    const { ctx, page } = await open(1280, { earnings: { held_pending_assent: 3.2 } });
    try {
      const m = await page.evaluate(() => [...document.querySelectorAll('#earnings-grid .earnings-item')].map((el) => {
        const l = el.querySelector('.earnings-label');
        const lh = parseFloat(getComputedStyle(l).lineHeight);
        return { text: l.textContent, h: l.getBoundingClientRect().height, lh, top: el.getBoundingClientRect().top };
      }));
      const firstRow = m.filter((x) => Math.abs(x.top - m[0].top) < 1);
      assert.ok(firstRow.length >= 3);
      assert.ok(firstRow.some((x) => x.h > x.lh * 1.5), 'positive control: one label in the row wraps to two lines');
      assert.ok(firstRow.some((x) => x.h < x.lh * 2.1 && /Your earnings/.test(x.text)), 'a short label sits in the same two-line box');
      const heights = new Set(firstRow.map((x) => Math.round(x.h)));
      assert.equal(heights.size, 1, 'every label in the row is the same height');
    } finally { await ctx.close(); }
  });

  it('no figure or text on the dashboard is gold, and the gold detector sees the setup button\'s command', async (t) => {
    if (skip) { t.skip(skip); return; }
    // A new account shows the setup command (the page's one gold thing); a paid, frozen account shows the rest.
    const scan = () => {
      const found = [];
      const walker = document.createTreeWalker(document.querySelector('main'), NodeFilter.SHOW_TEXT);
      let n;
      while ((n = walker.nextNode())) {
        const el = n.parentElement;
        if (!n.textContent.trim() || !el.getClientRects().length) continue;
        if (el.closest('#dash-setup-block')) continue;
        found.push({ text: n.textContent.trim().slice(0, 40), color: getComputedStyle(el).color });
      }
      return found;
    };
    const states = [
      { earnings: {}, queue: [], published: 0 },
      { earnings: { held_pending_assent: 3.2 }, lane: 'frozen' },
      { earnings: { payouts_paused: false, can_withdraw: true, wallet: '0x1111222233334444555566667777888899990000' } },
    ];
    for (const width of [1280, 375]) {
      for (const cfg of states) {
        const { ctx, page } = await open(width, cfg);
        try {
          if (cfg.published === 0) {
            await page.evaluate(() => { document.getElementById('welcome-card').style.display = ''; });
            const control = await page.evaluate(() => getComputedStyle(document.getElementById('dash-setup-code')).color);
            assert.ok(GOLD.includes(control), `positive control: the setup command is gold (${control})`);
          }
          const accrued = await page.evaluate(() => {
            const items = [...document.querySelectorAll('#earnings-grid .earnings-item')];
            const v = items[0].querySelector('.earnings-value');
            return { cls: v.className, color: getComputedStyle(v).color };
          });
          if (cfg.earnings.held_pending_assent !== undefined || cfg.lane === 'frozen') {
            assert.match(accrued.cls, /\baurum\b/, 'positive control: a real amount still carries the class that used to paint gold');
          }
          assert.equal(accrued.color, 'rgb(10, 10, 10)', 'the figure is ink');
          const text = await page.evaluate(scan);
          assert.ok(text.length > 20, 'the scan saw the page text');
          const gold = text.filter((x) => GOLD.includes(x.color));
          assert.deepEqual(gold, [], `${width}: gold text outside the setup command`);
        } finally { await ctx.close(); }
      }
    }
  });

  // ── Chips ───────────────────────────────────────────────────────────────

  it('every chip is one style, whatever class the script gave it, and no chip breaks across lines', async (t) => {
    if (skip) { t.skip(skip); return; }
    for (const width of [1280, 768, 375]) {
      const { ctx, page } = await open(width);
      try {
        const chips = await page.evaluate(() => [...document.querySelectorAll('.tag')].filter((el) => el.getClientRects().length).map((el) => {
          const cs = getComputedStyle(el);
          return {
            cls: el.className,
            text: el.textContent,
            bg: cs.backgroundColor,
            color: cs.color,
            border: [cs.borderTopWidth, cs.borderRightWidth, cs.borderBottomWidth, cs.borderLeftWidth].join(' '),
            h: el.getBoundingClientRect().height,
            lh: parseFloat(cs.lineHeight),
          };
        }));
        const classes = new Set(chips.map((c) => c.cls));
        for (const cls of ['tag tag-category', 'tag tag-clean', 'tag tag-warn', 'tag tag-danger']) {
          assert.ok(classes.has(cls), `positive control: ${width} shows a "${cls}" chip`);
        }
        assert.equal(new Set(chips.map((c) => c.bg)).size, 1, `${width}: one fill`);
        assert.equal(new Set(chips.map((c) => c.color)).size, 1, `${width}: one ink`);
        assert.equal(new Set(chips.map((c) => c.border)).size, 1, `${width}: one border`);
        assert.equal(chips[0].border, '0px 0px 0px 0px', 'no outline');
        assert.equal(chips[0].bg, 'rgb(241, 239, 233)', 'the tint');
        assert.equal(chips[0].color, 'rgb(10, 10, 10)', 'ink');
        for (const c of chips) assert.ok(c.h < c.lh * 1.5 + 8, `${width}: "${c.text}" is one line (${c.h}px high)`);
      } finally { await ctx.close(); }
    }
  });

  it('the category column never wraps a chip: the longest category sits on one line, as high as the shortest, with the table inside its box', async (t) => {
    if (skip) { t.skip(skip); return; }
    for (const width of [900, 1024, 1280]) {
      const { ctx, page } = await open(width);
      try {
        const m = await page.evaluate(() => {
          const tags = [...document.querySelectorAll('.triage-cell-category .tag')].map((el) => ({ text: el.textContent, h: el.getBoundingClientRect().height, rects: el.getClientRects().length }));
          const wrap = document.querySelector('.triage-table-wrap');
          return { tags, sw: wrap.scrollWidth, cw: wrap.clientWidth };
        });
        const long = m.tags.find((x) => x.text === 'payment-financial');
        const short = m.tags.find((x) => x.text === 'code-execution');
        assert.ok(long && short, 'both categories rendered');
        assert.equal(long.rects, 1, `${width}: payment-financial is a single box`);
        assert.ok(Math.abs(long.h - short.h) < 0.5, `${width}: payment-financial is as high as code-execution (${long.h} against ${short.h})`);
        assert.ok(m.sw <= m.cw, `${width}: the table does not scroll sideways (${m.sw} in ${m.cw})`);
      } finally { await ctx.close(); }
    }
  });

  // ── Buttons ─────────────────────────────────────────────────────────────

  const luminance = (rgb) => {
    const [r, g, b] = rgb.match(/\d+/g).slice(0, 3).map((v) => {
      const s = Number(v) / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (a, b) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };

  it('a disabled button looks disabled and keeps 4.5 to 1 on its label; an enabled secondary button does not look that way', async (t) => {
    if (skip) { t.skip(skip); return; }
    for (const width of [1280, 375]) {
      const { ctx, page } = await open(width);
      try {
        const read = (sel) => page.evaluate((s) => {
          const el = document.querySelector(s);
          const cs = getComputedStyle(el);
          return { disabled: el.disabled, bg: cs.backgroundColor, color: cs.color, bc: cs.borderTopColor, bw: cs.borderTopWidth, cursor: cs.cursor, opacity: cs.opacity };
        }, sel);
        const approve = await read('#bulk-approve-btn');
        const reject = await read('#bulk-reject-btn');
        const clear = await page.locator('.bulk-bar button', { hasText: 'Clear' }).evaluate((el) => {
          const cs = getComputedStyle(el);
          return { disabled: el.disabled, bg: cs.backgroundColor, bc: cs.borderTopColor, cursor: cs.cursor };
        });
        assert.equal(clear.disabled, false, 'positive control: Clear is enabled');
        assert.equal(clear.cursor, 'pointer');
        assert.equal(clear.bc, 'rgb(10, 10, 10)', 'an enabled secondary button has its ink outline');
        for (const d of [approve, reject]) {
          assert.equal(d.disabled, true);
          assert.equal(d.bg, 'rgb(241, 239, 233)', `${width}: tint fill`);
          assert.equal(d.color, 'rgb(94, 94, 87)', `${width}: note ink`);
          assert.equal(d.bc, 'rgba(0, 0, 0, 0)', `${width}: no visible border`);
          assert.equal(d.cursor, 'not-allowed');
          assert.equal(d.opacity, '1');
          assert.ok(contrast(d.color, d.bg) >= 4.5, `${width}: label contrast ${contrast(d.color, d.bg).toFixed(2)}`);
        }
      } finally { await ctx.close(); }
    }
  });

  it('the bulk actions are one row at 1280, an even three by two grid at 768 and an even two by three grid at 375', async (t) => {
    if (skip) { t.skip(skip); return; }
    const measure = async (width) => {
      const { ctx, page } = await open(width);
      try {
        return await page.evaluate(() => {
          const bar = document.querySelector('.bulk-bar').getBoundingClientRect();
          return {
            left: bar.left,
            right: bar.right,
            btns: [...document.querySelectorAll('.bulk-bar > button')].map((b) => {
              const r = b.getBoundingClientRect();
              return { left: r.left, right: r.right, top: r.top, w: r.width, h: r.height };
            }),
          };
        });
      } finally { await ctx.close(); }
    };
    const rowsOf = (btns) => {
      const rows = [];
      for (const b of btns) {
        const row = rows.find((r) => Math.abs(r[0].top - b.top) < 1);
        if (row) row.push(b); else rows.push([b]);
      }
      return rows;
    };
    const wide = await measure(1280);
    assert.equal(wide.btns.length, 6);
    assert.equal(rowsOf(wide.btns).length, 1, '1280: one row');
    for (const [width, perRow] of [[768, 3], [375, 2]]) {
      const m = await measure(width);
      const rows = rowsOf(m.btns);
      assert.deepEqual(rows.map((r) => r.length), Array(6 / perRow).fill(perRow), `${width}: ${perRow} across`);
      for (const r of rows) {
        assert.ok(Math.abs(r[0].left - m.left) < 1 && Math.abs(r[r.length - 1].right - m.right) < 1, `${width}: each row spans the bar`);
        assert.ok(r.every((b) => Math.abs(b.w - r[0].w) < 1), `${width}: the cells are equal width`);
        assert.ok(r.every((b) => Math.abs(b.h - r[0].h) < 1), `${width}: the cells in a row are equal height`);
      }
      assert.ok(m.btns.every((b) => b.h >= 44), `${width}: every button is at least 44 high`);
    }
  });

  // ── Measure ─────────────────────────────────────────────────────────────

  it('no line of card text runs past 70 characters', async (t) => {
    if (skip) { t.skip(skip); return; }
    const { ctx, page } = await open(1280, { lane: 'frozen' });
    try {
      const m = await page.evaluate(() => {
        const out = [];
        for (const el of document.querySelectorAll('.dash-card p, .dash-card .alert, .dash-card .wallet-note, .dash-card #clean-lane-terms')) {
          if (!el.getClientRects().length) continue;
          const probe = document.createElement('div');
          probe.style.cssText = 'position:absolute;visibility:hidden;height:0;width:70ch;';
          el.appendChild(probe);
          const limit = probe.getBoundingClientRect().width;
          probe.remove();
          out.push({ id: el.id || el.className || el.tagName, w: el.getBoundingClientRect().width, limit, len: el.textContent.length });
        }
        return { out, card: document.getElementById('pending-review-card').getBoundingClientRect().width };
      });
      const long = m.out.filter((x) => x.len > 150);
      assert.ok(long.length >= 4, 'positive control: the page has long card paragraphs');
      assert.ok(m.out.every((x) => x.w <= x.limit + 1), `every block is at most 70ch: ${JSON.stringify(m.out.filter((x) => x.w > x.limit + 1))}`);
      assert.deepEqual(long.filter((x) => x.w >= m.card - 100), [], 'a long block is narrower than its card, so the cap is what limits it');
    } finally { await ctx.close(); }
  });
});
