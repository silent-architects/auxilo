'use strict';

/**
 * test/terms-scroll-accept.test.js — BUILD-BRIEF-TERMS-SCROLL.md Part T.
 *
 * The owner ruled the Terms card's paragraph and checkbox off: the builder
 * now clicks "Read the Terms", a dialog shows the full Terms as served at
 * /terms, and Accept stays disabled until the reader has scrolled to the
 * end. This file is the rendered (Playwright, real staged server, real
 * docs/TERMS-OF-SERVICE.md) proof of that behavior, at 375 and 1280.
 *
 * Session tokens are minted directly with `jose` (same SESSION_SECRET the
 * staged server boots with) and seeded into localStorage before the page's
 * own script runs, via page.addInitScript -- the same shortcut
 * test/credits-control-part1.test.js's T14 uses to skip the magic-link UI
 * round trip. Each test gets its own account and its own page, since
 * _termsReachedEnd is a page-level JS variable that (by design, T-23)
 * persists for the life of the page.
 *
 * Runner: node --test test/terms-scroll-accept.test.js
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-do-not-use-in-prod';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SignJWT } = require('jose');
const {
  reservePort,
  stageServer,
  bootServer,
  stopServer,
} = require('./helpers/staged-server');

const REPO = path.join(__dirname, '..');
const SESSION_SECRET = 'terms-scroll-accept-session-secret-32byte';

let acctCounter = 0;
function freshAccountId() {
  acctCounter += 1;
  return `acc_terms_scroll_${acctCounter}`;
}

async function jwtFor(accountId, email) {
  return new SignJWT({ accountId, email })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(Buffer.from(SESSION_SECRET));
}

describe('BUILD-BRIEF-TERMS-SCROLL Part T: read-to-the-end Terms acceptance', { timeout: 240_000 }, () => {
  let tmpDir;
  let child;
  let baseUrl;
  let bootSkipReason = null;
  let playwright;
  let dataDir;

  before(async () => {
    try {
      playwright = require(path.join(REPO, 'node_modules', 'playwright'));
    } catch (e) {
      bootSkipReason = 'playwright not resolvable: ' + e.message;
      return;
    }
    const honoEntry = require.resolve('hono', { paths: [REPO] });
    const nodeModulesDir = honoEntry.slice(0, honoEntry.lastIndexOf(`${path.sep}node_modules${path.sep}`) + '/node_modules'.length);
    const reservation = await reservePort();
    if (reservation.skipReason) { bootSkipReason = reservation.skipReason; return; }
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auxilo-terms-scroll-'));
    const staged = stageServer({
      repoRoot: REPO,
      tmpDir,
      nodeModulesDir,
      port: reservation.port,
      rootFiles: ['server.js', 'seed-knowledge.json', 'skills.json', 'openapi.json', 'package.json', 'model_config.json'],
      linkDirs: ['docs'],
      copyDirs: ['lib', 'public', 'prompts', 'config'],
    });
    dataDir = staged.dataDir;
    fs.writeFileSync(path.join(dataDir, 'learnings.json'), JSON.stringify([], null, 2));
    fs.writeFileSync(path.join(dataDir, 'accounts.json'), JSON.stringify({}, null, 2));
    fs.writeFileSync(path.join(dataDir, 'earnings.json'), JSON.stringify({}, null, 2));
    fs.writeFileSync(path.join(dataDir, 'magic_links.json'), JSON.stringify({}, null, 2));
    fs.writeFileSync(path.join(dataDir, 'credits.json'), JSON.stringify({}, null, 2));

    const bootResult = await bootServer({
      tmpDir,
      port: reservation.port,
      env: {
        NODE_ENV: 'test',
        SESSION_SECRET,
        RESEND_API_KEY: '',
        LLM_SENSITIVITY_ENABLED: 'false',
        WALLET_PRIVATE_KEY: '0x' + '11'.repeat(32),
      },
      timeoutMs: 60_000,
      maxAttempts: 4,
    });
    if (bootResult.skipReason) { bootSkipReason = bootResult.skipReason; return; }
    child = bootResult.child;
    baseUrl = bootResult.baseUrl;
  });

  after(async () => {
    if (child) await stopServer(child);
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function seedAccount(email, extra) {
    const accountId = freshAccountId();
    const accountsFile = path.join(dataDir, 'accounts.json');
    const accounts = JSON.parse(fs.readFileSync(accountsFile, 'utf8'));
    accounts[accountId] = Object.assign(
      { id: accountId, email, created_at: new Date().toISOString() },
      extra || {},
    );
    fs.writeFileSync(accountsFile, JSON.stringify(accounts, null, 2));
    return accountId;
  }

  // Extracts the same "legal content only" text a correct dashboard
  // implementation would show: .legal-wrap minus the "Back to Auxilo" link
  // and minus the page's own <h1> (R2-3: the dialog title already says
  // "Terms of Service"; everything AFTER that h1 is shown).
  function expectedTermsText(termsHtml) {
    const wrapStart = termsHtml.indexOf('<div class="legal-wrap">');
    const wrapEnd = termsHtml.indexOf('</div>\n\n<!-- Wave C.3b');
    const inner = termsHtml.slice(wrapStart, wrapEnd === -1 ? undefined : wrapEnd);
    return inner
      .replace(/<a[^>]*class="legal-back"[^>]*>[\s\S]*?<\/a>/, '')
      .replace(/<h1[^>]*>[\s\S]*?<\/h1>/, '')
      .replace(/<[^>]*>/g, ' ')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ')
      // R2-4/R3-13: a code span is an inline element -- innerText never
      // inserts a space around it, but the generic tag-strip above does.
      // Collapse a space this strip added right after "(" or right before
      // closing punctuation, so a code span sitting inside parentheses
      // (e.g. "(`auxilo provider set`)") compares equal in the FULL text.
      .replace(/\(\s+/g, '(')
      .replace(/\s+([.,;:!?)])/g, '$1')
      .trim();
  }

  async function openPage(browser, viewport) {
    const page = await browser.newPage({ viewport });
    return page;
  }

  it('1/8 + 8/8: the card shows T-1/T-2/T-3 and nothing else, at 375 and 1280, no horizontal scroll', async (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    const { chromium } = playwright;
    const browser = await chromium.launch();
    try {
      for (const viewport of [{ width: 375, height: 812 }, { width: 1280, height: 900 }]) {
        const accountId = seedAccount(`card-only-${viewport.width}@example.com`);
        const token = await jwtFor(accountId, `card-only-${viewport.width}@example.com`);
        const page = await openPage(browser, viewport);
        await page.addInitScript((t) => { localStorage.setItem('auxilo_session', t); }, token);
        await page.goto(`${baseUrl}/dashboard`, { waitUntil: 'networkidle' });
        await page.waitForSelector('#terms-gate', { state: 'visible' });

        // textContent, not innerText: .dash-card-title is all-caps by CSS
        // (text-transform), and this must compare the underlying content (T-1),
        // not the rendered presentation.
        const cardText = await page.evaluate(() => document.getElementById('terms-gate').textContent.replace(/\s+/g, ' ').trim());
        assert.equal(cardText, 'Accept the Terms Read the Terms of Service to the end, then accept. Read the Terms');
        assert.ok(!cardText.includes('Section 5.10'), 'the removed paragraph must not survive');

        const noCheckbox = await page.evaluate(() => !document.querySelector('#terms-gate input[type="checkbox"]'));
        assert.ok(noCheckbox, 'the card carries no checkbox');

        const noHScroll = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
        assert.ok(noHScroll, `no horizontal scroll at ${viewport.width}`);

        // R3-13: also checked with the dialog OPEN, not just closed.
        await page.click('#terms-read-btn');
        await page.waitForSelector('#terms-dialog-overlay', { state: 'visible' });
        await page.waitForFunction(() => {
          const r = document.getElementById('terms-scroll-region');
          return r && r.textContent.trim().length > 500;
        });
        const noHScrollOpen = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
        assert.ok(noHScrollOpen, `no horizontal scroll at ${viewport.width} with the dialog open`);

        await page.close();
      }
    } finally {
      await browser.close();
    }
  });

  it('2/8: the dialog opens, the Terms text equals what /terms serves, and Accept starts disabled', async (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    const { chromium } = playwright;
    const browser = await chromium.launch();
    try {
      const accountId = seedAccount('dialog-open@example.com');
      const token = await jwtFor(accountId, 'dialog-open@example.com');
      const page = await openPage(browser, { width: 1280, height: 900 });
      await page.addInitScript((t) => { localStorage.setItem('auxilo_session', t); }, token);
      await page.goto(`${baseUrl}/dashboard`, { waitUntil: 'networkidle' });
      await page.waitForSelector('#terms-gate', { state: 'visible' });

      await page.click('#terms-read-btn');
      await page.waitForSelector('#terms-dialog-overlay', { state: 'visible' });
      await page.waitForFunction(() => {
        const r = document.getElementById('terms-scroll-region');
        return r && r.textContent.trim().length > 500;
      });

      const termsRes = await page.evaluate((url) => fetch(url).then((r) => r.text()), `${baseUrl}/terms`);
      const expected = expectedTermsText(termsRes);
      const actual = await page.evaluate(() => document.getElementById('terms-scroll-region').innerText.replace(/\s+/g, ' ').trim());
      // R3-13: the WHOLE text, not a 200-character prefix -- a corruption
      // anywhere past the opening lines would otherwise go unnoticed.
      assert.ok(expected.length > 1000, 'sanity: /terms actually serves substantial content');
      assert.equal(actual, expected, 'the dialog must show the /terms content in full, not a copy or a truncation');

      // R2-3: the dialog title (h2 "Terms of Service") already says it -- the
      // fetched page's own h1 is left out, and everything after it is shown.
      // Heading order stays valid: the dialog carries no h1 anywhere, and the
      // first heading the content itself contributes continues at h2 (the
      // docs render "## N. ..." sections as h2), never skipping back to h1.
      const headingTags = await page.evaluate(() => Array.from(
        document.getElementById('terms-scroll-region').querySelectorAll('h1,h2,h3,h4,h5,h6'),
      ).map((h) => h.tagName));
      assert.ok(!headingTags.includes('H1'), 'no h1 renders inside the dialog content (R2-3)');
      assert.ok(headingTags.length > 0, 'sanity: the Terms content does carry section headings');
      assert.equal(headingTags[0], 'H2', 'the first heading the content contributes is an h2, continuing from the dialog title');

      const disabled = await page.evaluate(() => document.getElementById('terms-accept-btn').disabled);
      assert.equal(disabled, true, 'Accept starts disabled');

      await page.close();
    } finally {
      await browser.close();
    }
  });

  it('3/8: scrolling part of the way leaves Accept disabled (hint visible); reaching the end enables it at full strength (hint hidden), at 375 and 1280', async (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    const { chromium } = playwright;
    const browser = await chromium.launch();
    try {
      for (const viewport of [{ width: 375, height: 812 }, { width: 1280, height: 900 }]) {
        const email = `scroll-partial-${viewport.width}@example.com`;
        const accountId = seedAccount(email);
        const token = await jwtFor(accountId, email);
        const page = await openPage(browser, viewport);
        await page.addInitScript((t) => { localStorage.setItem('auxilo_session', t); }, token);
        await page.goto(`${baseUrl}/dashboard`, { waitUntil: 'networkidle' });
        await page.waitForSelector('#terms-gate', { state: 'visible' });
        await page.click('#terms-read-btn');
        await page.waitForFunction(() => {
          const r = document.getElementById('terms-scroll-region');
          return r && r.scrollHeight > r.clientHeight + 20; // sanity: this account's Terms need scrolling
        });

        // Reference: the page's primary button at rest (never disabled).
        const readBtnBg = await page.evaluate(() => getComputedStyle(document.getElementById('terms-read-btn')).backgroundColor);

        await page.evaluate(() => { document.getElementById('terms-scroll-region').scrollTop = 40; });
        // R3-13: wait for the state (the scroll position has actually
        // settled), never a fixed time.
        await page.waitForFunction(() => document.getElementById('terms-scroll-region').scrollTop === 40);
        const partial = await page.evaluate(() => {
          const b = document.getElementById('terms-accept-btn');
          const h = document.getElementById('terms-scroll-hint');
          return {
            disabled: b.disabled,
            bg: getComputedStyle(b).backgroundColor,
            describedby: b.getAttribute('aria-describedby'),
            hintVisible: getComputedStyle(h).visibility !== 'hidden',
          };
        });
        assert.equal(partial.disabled, true, `partial scroll leaves Accept disabled at ${viewport.width}`);
        assert.notEqual(partial.bg, readBtnBg, 'a disabled Accept does not wear the primary fill');
        assert.equal(partial.describedby, 'terms-scroll-hint', 'aria-describedby points at the hint while disabled (R2-1)');
        assert.equal(partial.hintVisible, true, 'the hint is visible while disabled (R2-1)');

        await page.evaluate(() => {
          const r = document.getElementById('terms-scroll-region');
          r.scrollTop = r.scrollHeight;
        });
        // R2-2: wait for the STATE (the button enabled and its fill settled on
        // the primary fill), never a fixed time -- .btn transitions its
        // background over 150ms, so the `disabled` DOM property flips before
        // the button visually reaches full strength; an assertion taken right
        // after the property flips still sees the mid-transition frame.
        await page.waitForFunction((refBg) => {
          const b = document.getElementById('terms-accept-btn');
          const cs = getComputedStyle(b);
          return !b.disabled && cs.backgroundColor === refBg && cs.opacity === '1';
        }, readBtnBg);
        const reached = await page.evaluate((refBg) => {
          const b = document.getElementById('terms-accept-btn');
          const h = document.getElementById('terms-scroll-hint');
          const cs = getComputedStyle(b);
          return {
            disabled: b.disabled,
            opacity: cs.opacity,
            bgMatchesReadBtn: cs.backgroundColor === refBg,
            describedby: b.getAttribute('aria-describedby'),
            hintVisible: getComputedStyle(h).visibility !== 'hidden',
          };
        }, readBtnBg);
        assert.equal(reached.disabled, false, `reaching the end enables Accept at ${viewport.width}`);
        assert.equal(reached.opacity, '1', 'the enabled Accept button is at full opacity');
        assert.equal(reached.bgMatchesReadBtn, true, 'the enabled Accept button matches the Read the Terms background exactly');
        assert.equal(reached.describedby, null, 'aria-describedby is removed once enabled (R2-1)');
        assert.equal(reached.hintVisible, false, 'the hint hides once the end is reached (R2-1), reserving its space');

        await page.close();
      }
    } finally {
      await browser.close();
    }
  });

  it('4/8: reaching the end by keyboard alone (focus the region, press End) enables Accept', async (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    const { chromium } = playwright;
    const browser = await chromium.launch();
    try {
      const accountId = seedAccount('scroll-keyboard@example.com');
      const token = await jwtFor(accountId, 'scroll-keyboard@example.com');
      const page = await openPage(browser, { width: 1280, height: 900 });
      await page.addInitScript((t) => { localStorage.setItem('auxilo_session', t); }, token);
      await page.goto(`${baseUrl}/dashboard`, { waitUntil: 'networkidle' });
      await page.waitForSelector('#terms-gate', { state: 'visible' });
      await page.click('#terms-read-btn');
      await page.waitForFunction(() => {
        const r = document.getElementById('terms-scroll-region');
        return r && r.scrollHeight > r.clientHeight + 20;
      });

      const focused = await page.evaluate(() => document.activeElement && document.activeElement.id);
      assert.equal(focused, 'terms-scroll-region', 'focus moves onto the scrollable region on open (T-40/T-41)');

      let disabled = await page.evaluate(() => document.getElementById('terms-accept-btn').disabled);
      assert.equal(disabled, true, 'still disabled before any keyboard scrolling');

      await page.keyboard.press('End');
      await page.waitForFunction(() => document.getElementById('terms-accept-btn').disabled === false, { timeout: 5000 });
      disabled = await page.evaluate(() => document.getElementById('terms-accept-btn').disabled);
      assert.equal(disabled, false, 'End key reaches the bottom and enables Accept');

      await page.close();
    } finally {
      await browser.close();
    }
  });

  it('5/8: Accept sends the version from terms-status with agree:true; the card hides; terms-status then reports no acceptance needed', async (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    const { chromium } = playwright;
    const browser = await chromium.launch();
    try {
      const accountId = seedAccount('accept-flow@example.com');
      const token = await jwtFor(accountId, 'accept-flow@example.com');
      const page = await openPage(browser, { width: 1280, height: 900 });
      await page.addInitScript((t) => { localStorage.setItem('auxilo_session', t); }, token);

      const acceptRequests = [];
      await page.route('**/account/accept-terms', (route) => {
        acceptRequests.push(JSON.parse(route.request().postData() || '{}'));
        route.continue();
      });

      await page.goto(`${baseUrl}/dashboard`, { waitUntil: 'networkidle' });
      await page.waitForSelector('#terms-gate', { state: 'visible' });
      await page.click('#terms-read-btn');
      await page.evaluate(() => {
        const r = document.getElementById('terms-scroll-region');
        return new Promise((resolve) => {
          const check = () => {
            if (r.scrollHeight > r.clientHeight + 20) { r.scrollTop = r.scrollHeight; resolve(); }
            else setTimeout(check, 20);
          };
          check();
        });
      });
      await page.waitForFunction(() => document.getElementById('terms-accept-btn').disabled === false);

      const statusBefore = await page.evaluate((url) => fetch(url, { headers: { Authorization: 'Bearer ' + localStorage.getItem('auxilo_session') } }).then((r) => r.json()), `${baseUrl}/account/terms-status`);
      assert.equal(statusBefore.needs_acceptance, true);

      await page.click('#terms-accept-btn');
      await page.waitForSelector('#terms-gate', { state: 'hidden' });
      await page.waitForSelector('#terms-dialog-overlay', { state: 'hidden' });

      assert.equal(acceptRequests.length, 1, 'exactly one accept-terms POST');
      assert.equal(acceptRequests[0].agree, true);
      assert.equal(acceptRequests[0].version, statusBefore.current_tos_version);

      const statusAfter = await page.evaluate((url) => fetch(url, { headers: { Authorization: 'Bearer ' + localStorage.getItem('auxilo_session') } }).then((r) => r.json()), `${baseUrl}/account/terms-status`);
      assert.equal(statusAfter.needs_acceptance, false, '/account/terms-status now reports no acceptance needed');

      await page.close();
    } finally {
      await browser.close();
    }
  });

  it('6/8: a failed load shows T-9, the button stays disabled, and Try Again recovers', async (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    const { chromium } = playwright;
    const browser = await chromium.launch();
    try {
      const accountId = seedAccount('load-error@example.com');
      const token = await jwtFor(accountId, 'load-error@example.com');
      const page = await openPage(browser, { width: 1280, height: 900 });
      await page.addInitScript((t) => { localStorage.setItem('auxilo_session', t); }, token);

      let failTerms = true;
      await page.route('**/terms', (route) => {
        if (failTerms) route.fulfill({ status: 500, body: 'boom' });
        else route.continue();
      });

      await page.goto(`${baseUrl}/dashboard`, { waitUntil: 'networkidle' });
      await page.waitForSelector('#terms-gate', { state: 'visible' });
      await page.click('#terms-read-btn');

      await page.waitForSelector('#terms-load-error', { state: 'visible' });
      const errorText = await page.evaluate(() => document.getElementById('terms-load-error').innerText.replace(/\s+/g, ' ').trim());
      assert.ok(errorText.includes('The Terms did not load. Try again.'));
      assert.ok(errorText.includes('Try Again'));
      let disabled = await page.evaluate(() => document.getElementById('terms-accept-btn').disabled);
      assert.equal(disabled, true, 'a failed load never enables Accept');

      failTerms = false;
      await page.click('#terms-retry-btn');
      await page.waitForSelector('#terms-load-error', { state: 'hidden' });
      await page.waitForFunction(() => {
        const r = document.getElementById('terms-scroll-region');
        return r && r.textContent.trim().length > 500;
      });
      const region = await page.evaluate(() => document.getElementById('terms-scroll-region').style.display);
      assert.notEqual(region, 'none', 'Try Again recovers the scrolling region');

      await page.close();
    } finally {
      await browser.close();
    }
  });

  it('7/8: Escape closes the dialog and focus returns to Read the Terms', async (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    const { chromium } = playwright;
    const browser = await chromium.launch();
    try {
      const accountId = seedAccount('escape-close@example.com');
      const token = await jwtFor(accountId, 'escape-close@example.com');
      const page = await openPage(browser, { width: 1280, height: 900 });
      await page.addInitScript((t) => { localStorage.setItem('auxilo_session', t); }, token);
      await page.goto(`${baseUrl}/dashboard`, { waitUntil: 'networkidle' });
      await page.waitForSelector('#terms-gate', { state: 'visible' });
      await page.click('#terms-read-btn');
      await page.waitForSelector('#terms-dialog-overlay', { state: 'visible' });

      await page.keyboard.press('Escape');
      await page.waitForSelector('#terms-dialog-overlay', { state: 'hidden' });
      const focused = await page.evaluate(() => document.activeElement && document.activeElement.id);
      assert.equal(focused, 'terms-read-btn', 'focus returns to Read the Terms on close');

      await page.close();
    } finally {
      await browser.close();
    }
  });
});
