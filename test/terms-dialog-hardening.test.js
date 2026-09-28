'use strict';

/**
 * test/terms-dialog-hardening.test.js — FIX-UNIT-TERMS-3.md, round 3.
 *
 * Two blockers the adversarial code review and the accessibility audit
 * found in the Terms dialog (BUILD-BRIEF-TERMS-SCROLL.md):
 *
 *   R3-1 (BLOCKER): Accept could turn on without reading -- scrolling a
 *   little then closing and reopening the dialog, or closing before /terms
 *   arrives, could both mark the end reached against a region that was not
 *   genuinely showing loaded content. Fixed by requiring ALL of: the dialog
 *   visible, the region's clientHeight above zero, a load-finished flag set
 *   only after the real append, and at least one h2 in the loaded content --
 *   plus closing now cancels any load in flight, removes the scroll
 *   handler, and disconnects the observer.
 *
 *   R3-10 (BLOCKER, accessibility): a reader who moves by Tab, by a screen
 *   reader's link list, by switch, or by voice could reach the dialog's
 *   three links and Close with no way to ever enable Accept, since the
 *   browser's own focus-into-view behavior stops as soon as a focused link
 *   is merely visible, not at the very bottom. Fixed by scrolling the
 *   region the rest of the way to its end when focus lands on its last
 *   focusable element and the end has not been reached yet.
 *
 * Also covered: R3-3 (cache: no-store + a version-mismatch check before
 * Accept can ever enable), R3-8 (the fetched Terms are sanitized -- an
 * allowlist of tags, no attributes but a validated href, every id
 * re-prefixed), and R3-11 (the page behind the dialog is inert to
 * assistive technology while it is open).
 *
 * Same shortcuts as test/terms-scroll-accept.test.js: a `jose`-minted
 * session token seeded into localStorage via page.addInitScript, and a
 * fresh account per test since dialog state persists for the page's life
 * by design (T-23).
 *
 * Runner: node --test test/terms-dialog-hardening.test.js
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
const { CURRENT_TOS_VERSION } = require('../lib/accounts.js');

const REPO = path.join(__dirname, '..');
const SESSION_SECRET = 'terms-dialog-hardening-session-secret-32b';

let acctCounter = 0;
function freshAccountId() {
  acctCounter += 1;
  return `acc_terms_hardening_${acctCounter}`;
}

async function jwtFor(accountId, email) {
  return new SignJWT({ accountId, email })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(Buffer.from(SESSION_SECRET));
}

describe('FIX-UNIT-TERMS-3: R3-1, R3-3, R3-8, R3-10, R3-11', { timeout: 240_000 }, () => {
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
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auxilo-terms-hardening-'));
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

  function seedAccount(email) {
    const accountId = freshAccountId();
    const accountsFile = path.join(dataDir, 'accounts.json');
    const accounts = JSON.parse(fs.readFileSync(accountsFile, 'utf8'));
    accounts[accountId] = { id: accountId, email, created_at: new Date().toISOString() };
    fs.writeFileSync(accountsFile, JSON.stringify(accounts, null, 2));
    return accountId;
  }

  async function openDashboard(browser, email, viewport) {
    const accountId = seedAccount(email);
    const token = await jwtFor(accountId, email);
    const page = await browser.newPage({ viewport: viewport || { width: 1280, height: 900 } });
    await page.addInitScript((t) => { localStorage.setItem('auxilo_session', t); }, token);
    await page.goto(`${baseUrl}/dashboard`, { waitUntil: 'networkidle' });
    await page.waitForSelector('#terms-gate', { state: 'visible' });
    return page;
  }

  it('R3-1a: closing before /terms arrives cancels that load -- reopening never inherits a wrongly-enabled Accept', async (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    const { chromium } = playwright;
    const browser = await chromium.launch();
    try {
      const page = await openDashboard(browser, 'r3-1a@example.com');
      let firstRequestSeen = false;
      let releaseFirst;
      const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
      await page.route('**/terms', async (route) => {
        if (!firstRequestSeen) {
          firstRequestSeen = true;
          await firstGate; // held until released, deliberately, below
        }
        await route.continue();
      });

      await page.click('#terms-read-btn'); // starts the held request
      await page.waitForFunction(() => document.getElementById('terms-dialog-overlay').style.display !== 'none');
      await page.keyboard.press('Escape'); // closes while the fetch is still in flight
      await page.waitForFunction(() => document.getElementById('terms-dialog-overlay').style.display === 'none');
      releaseFirst(); // the stale response resolves NOW, after close

      await page.click('#terms-read-btn'); // reopen -- a clean, second load
      await page.waitForFunction(() => {
        const r = document.getElementById('terms-scroll-region');
        return r && r.scrollHeight > r.clientHeight + 20;
      });
      const disabledAfterReopen = await page.evaluate(() => document.getElementById('terms-accept-btn').disabled);
      assert.equal(disabledAfterReopen, true, 'the cancelled, stale load must never have marked the end reached');

      // Normal scrolling still works in this clean session.
      await page.evaluate(() => { const r = document.getElementById('terms-scroll-region'); r.scrollTop = r.scrollHeight; });
      await page.waitForFunction(() => document.getElementById('terms-accept-btn').disabled === false);

      await page.close();
    } finally {
      await browser.close();
    }
  });

  it('R3-1b: scrolling part way, then closing and reopening, never leaves Accept enabled from a stale scroll handler', async (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    const { chromium } = playwright;
    const browser = await chromium.launch();
    try {
      const page = await openDashboard(browser, 'r3-1b@example.com');
      await page.click('#terms-read-btn');
      await page.waitForFunction(() => {
        const r = document.getElementById('terms-scroll-region');
        return r && r.scrollHeight > r.clientHeight + 100;
      });
      await page.evaluate(() => { document.getElementById('terms-scroll-region').scrollTop = 500; });
      await page.waitForFunction(() => document.getElementById('terms-scroll-region').scrollTop === 500);

      await page.keyboard.press('Escape'); // close mid-scroll, nowhere near the end
      await page.waitForFunction(() => document.getElementById('terms-dialog-overlay').style.display === 'none');
      await page.click('#terms-read-btn'); // reopen immediately

      await page.waitForFunction(() => {
        const r = document.getElementById('terms-scroll-region');
        return r && r.scrollHeight > r.clientHeight + 20;
      });
      const disabledAfterReopen = await page.evaluate(() => document.getElementById('terms-accept-btn').disabled);
      assert.equal(disabledAfterReopen, true, 'a stale scroll handler firing against the emptied region must never mark the end reached');

      await page.close();
    } finally {
      await browser.close();
    }
  });

  it('R3-1c: a legal section with no real content (no h2) never enables Accept', async (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    const { chromium } = playwright;
    const browser = await chromium.launch();
    try {
      const page = await openDashboard(browser, 'r3-1c@example.com');
      // R4-5: rather than a fixed settle window, count real firings of the
      // IntersectionObserver the dialog attaches to the end marker
      // (attachTermsScrollWatchers) -- that observer's callback is the one
      // async path (besides the synchronous "fits without scrolling" check)
      // that could mark the end reached, and by spec it always fires once
      // for a marker that is already intersecting when observe() starts.
      // Waiting for it to have fired at least once is a positive signal
      // that the window in which it could flip Accept has passed, since a
      // JS callback runs to completion (including any markTermsReachedEnd()
      // it calls) before this counter's increment is ever visible to a poll.
      await page.addInitScript(() => {
        window.__r31cObserverFireCount = 0;
        var OrigIO = window.IntersectionObserver;
        window.IntersectionObserver = function (cb, opts) {
          return new OrigIO(function (entries, obs) {
            window.__r31cObserverFireCount += 1;
            cb(entries, obs);
          }, opts);
        };
      });
      await page.reload({ waitUntil: 'networkidle' }); // re-run with the wrapped IntersectionObserver now armed
      await page.waitForSelector('#terms-gate', { state: 'visible' });
      // Version-matched (R3-3 must not be what blocks this), but the
      // content itself carries no h2 anywhere -- only the h1, which is
      // always skipped, and a plain paragraph.
      await page.route('**/terms', (route) => route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: `<html><body><div class="legal-wrap"><a class="legal-back" href="/">Back</a><h1>Terms of Service</h1><p>Current Amendment: <code>${CURRENT_TOS_VERSION}</code>, effective now.</p></div></body></html>`,
      }));
      await page.click('#terms-read-btn');
      await page.waitForFunction(() => document.getElementById('terms-scroll-region').textContent.length > 10);
      // No h2 exists to observe reaching -- the region also fits without
      // scrolling (short content), which would otherwise trip the "fits
      // without scrolling" signal; the missing-h2 guard must block it too.
      await page.waitForFunction(() => window.__r31cObserverFireCount >= 1, { timeout: 10_000 });
      const disabled = await page.evaluate(() => document.getElementById('terms-accept-btn').disabled);
      assert.equal(disabled, true, 'content with no h2 must never enable Accept, even though it fits without scrolling');

      await page.close();
    } finally {
      await browser.close();
    }
  });

  it('R3-3a: the dialog fetches /terms with cache: no-store', async (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    const { chromium } = playwright;
    const browser = await chromium.launch();
    try {
      const page = await openDashboard(browser, 'r3-3a@example.com');
      await page.addInitScript(() => {
        window.__termsFetchCalls = [];
        const orig = window.fetch;
        window.fetch = function (url, opts) {
          if (typeof url === 'string' && url.indexOf('/terms') === 0) window.__termsFetchCalls.push(opts || {});
          return orig.apply(this, arguments);
        };
      });
      await page.reload({ waitUntil: 'networkidle' }); // re-run with the init script now armed
      await page.waitForSelector('#terms-gate', { state: 'visible' });
      await page.click('#terms-read-btn');
      await page.waitForFunction(() => document.getElementById('terms-scroll-region').textContent.length > 500);
      const calls = await page.evaluate(() => window.__termsFetchCalls);
      assert.ok(calls.length >= 1, 'the dialog must fetch /terms');
      assert.equal(calls[0].cache, 'no-store', 'the fetch must be cache: no-store');

      await page.close();
    } finally {
      await browser.close();
    }
  });

  it('R3-3b: a version mismatch between the fetched Terms and terms-status shows the load failure state and leaves Accept disabled; fixing it and retrying recovers', async (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    const { chromium } = playwright;
    const browser = await chromium.launch();
    try {
      const page = await openDashboard(browser, 'r3-3b@example.com');
      let serveStale = true;
      await page.route('**/terms', (route) => {
        if (serveStale) {
          route.fulfill({
            status: 200,
            contentType: 'text/html',
            body: '<html><body><div class="legal-wrap"><a class="legal-back" href="/">Back</a><h1>Terms of Service</h1><h2 id="section-1">1. Section</h2><p>Current Amendment: <code>a-stale-version-not-current</code>, effective long ago.</p></div></body></html>',
          });
        } else {
          route.continue();
        }
      });

      await page.click('#terms-read-btn');
      await page.waitForSelector('#terms-load-error', { state: 'visible' });
      const disabled = await page.evaluate(() => document.getElementById('terms-accept-btn').disabled);
      assert.equal(disabled, true, 'a version mismatch must leave Accept disabled');
      const errorText = await page.evaluate(() => document.getElementById('terms-load-error').innerText.replace(/\s+/g, ' ').trim());
      assert.ok(errorText.includes('The Terms did not load. Try again.'), 'the mismatch shows the T-9 load failure state');

      serveStale = false; // the real /terms now serves, matching terms-status
      await page.click('#terms-retry-btn');
      await page.waitForSelector('#terms-load-error', { state: 'hidden' });
      await page.waitForFunction(() => {
        const r = document.getElementById('terms-scroll-region');
        return r && r.scrollHeight > r.clientHeight + 20;
      });
      const region = await page.evaluate(() => document.getElementById('terms-scroll-region').style.display);
      assert.notEqual(region, 'none', 'a matching version recovers the scrolling region on Try Again');

      await page.close();
    } finally {
      await browser.close();
    }
  });

  it('R4-3: a stale terms-status answer self-heals -- a second terms-status check (old version, then current) recovers the dialog with no Try Again and no page reload', async (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    const { chromium } = playwright;
    const browser = await chromium.launch();
    try {
      const accountId = seedAccount('r4-3@example.com');
      const token = await jwtFor(accountId, 'r4-3@example.com');
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      await page.addInitScript((t2) => { localStorage.setItem('auxilo_session', t2); }, token);

      // terms-status is mocked, NOT /terms: the real /terms endpoint always
      // serves the real, current amendment id. The first terms-status
      // answer (the dashboard's own initial loadTerms() call, before the
      // dialog ever opens) is an OLD version -- exactly the "terms-status
      // resolved before a just-landed amendment" case R4-3 describes, not a
      // truly stale /terms document (that is R3-3b, a distinct case that
      // stays a dead end until Try Again). Every call from the second
      // onward answers with the real, current status.
      let statusCalls = 0;
      await page.route('**/account/terms-status', async (route) => {
        statusCalls += 1;
        if (statusCalls === 1) {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              current_tos_version: 'an-old-version-terms-status-briefly-believed-current',
              accepted_version: null,
              accepted_at: null,
              accepted: false,
              needs_acceptance: true,
            }),
          });
          return;
        }
        await route.continue();
      });

      await page.goto(`${baseUrl}/dashboard`, { waitUntil: 'networkidle' });
      await page.waitForSelector('#terms-gate', { state: 'visible' });
      // A marker that only a fresh navigation would clear -- proves whatever
      // recovers the dialog below does it without a page reload.
      await page.evaluate(() => { window.__r43NoReloadMarker = 'still-here'; });

      await page.click('#terms-read-btn'); // the fetched /terms (current) now mismatches the stale terms-status already in hand
      await page.waitForFunction(() => {
        const r = document.getElementById('terms-scroll-region');
        return r && r.scrollHeight > r.clientHeight + 20;
      }, { timeout: 20_000 });

      const marker = await page.evaluate(() => window.__r43NoReloadMarker);
      assert.equal(marker, 'still-here', 'the dialog recovered without any navigation/reload of the page');
      const errorHidden = await page.evaluate(() => document.getElementById('terms-load-error').style.display === 'none' || getComputedStyle(document.getElementById('terms-load-error')).display === 'none');
      assert.equal(errorHidden, true, 'the recheck-and-match must never surface the load failure state');
      assert.ok(statusCalls >= 2, 'the automatic recheck must have hit terms-status a second time, with no Try Again click');

      // The recovered content is real: scrolling to the end enables Accept.
      await page.evaluate(() => { const r = document.getElementById('terms-scroll-region'); r.scrollTop = r.scrollHeight; });
      await page.waitForFunction(() => document.getElementById('terms-accept-btn').disabled === false, { timeout: 20_000 });

      await page.close();
    } finally {
      await browser.close();
    }
  });

  it('R3-8: onclick, a javascript: link, a style attribute, an iframe, and a colliding id are all neutralized', async (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    const { chromium } = playwright;
    const browser = await chromium.launch();
    try {
      const page = await openDashboard(browser, 'r3-8@example.com');
      await page.route('**/terms', (route) => route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: `<html><body><div class="legal-wrap">
          <a class="legal-back" href="/">Back</a>
          <h1>Terms of Service</h1>
          <h2 id="section-1">1. Section</h2>
          <p>Current Amendment: <code>${CURRENT_TOS_VERSION}</code>, effective now.</p>
          <button onclick="window.__pwnedA=true">click me</button>
          <a href="javascript:window.__pwnedB=true">bad link</a>
          <div style="position:fixed;top:0;left:0" onclick="window.__pwnedC=true">styled div</div>
          <iframe src="https://evil.example.test"></iframe>
          <div id="terms-accept-btn">fake accept</div>
        </div></body></html>`,
      }));
      await page.click('#terms-read-btn');
      await page.waitForFunction(() => document.getElementById('terms-scroll-region').querySelector('h2'));

      const check = await page.evaluate(() => {
        const region = document.getElementById('terms-scroll-region');
        return {
          onclickCount: region.querySelectorAll('[onclick]').length,
          jsLinkCount: Array.from(region.querySelectorAll('a')).filter((a) => (a.getAttribute('href') || '').indexOf('javascript:') === 0).length,
          // #terms-end-marker is the dashboard's OWN trusted sentinel (T-23),
          // not part of the fetched/sanitized content -- excluded here.
          styleAttrCount: region.querySelectorAll('[style]:not(#terms-end-marker)').length,
          iframeCount: region.querySelectorAll('iframe').length,
          fakeDiv: region.querySelector('#tos-terms-accept-btn') ? region.querySelector('#tos-terms-accept-btn').textContent : null,
          realAcceptTag: document.getElementById('terms-accept-btn').tagName,
          regionText: region.textContent,
        };
      });
      assert.equal(check.onclickCount, 0, 'no onclick attribute survives anywhere');
      assert.equal(check.jsLinkCount, 0, 'no javascript: href survives');
      assert.equal(check.styleAttrCount, 0, 'no style attribute survives');
      assert.equal(check.iframeCount, 0, 'no iframe survives');
      assert.equal(check.fakeDiv, 'fake accept', 'the colliding id is re-prefixed, and the div itself (an allowed tag) survives as plain content');
      assert.equal(check.realAcceptTag, 'BUTTON', 'the REAL Accept button is still what document.getElementById(\'terms-accept-btn\') finds');
      assert.ok(!check.regionText.includes('window.__pwned'), 'no attacker script text leaks in as visible content either');

      await page.close();
    } finally {
      await browser.close();
    }
  });

  it('R4-2: a protocol-relative //host/path and a backslash-prefixed path are NOT treated as site paths -- both degrade to plain text', async (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    const { chromium } = playwright;
    const browser = await chromium.launch();
    try {
      const page = await openDashboard(browser, 'r4-2@example.com');
      await page.route('**/terms', (route) => route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: `<html><body><div class="legal-wrap">
          <a class="legal-back" href="/">Back</a>
          <h1>Terms of Service</h1>
          <h2 id="section-1">1. Section</h2>
          <p>Current Amendment: <code>${CURRENT_TOS_VERSION}</code>, effective now.</p>
          <p><a href="//evil.example.test/path">protocol-relative link</a></p>
          <p><a href="/\\evil.example.test/path">backslash link</a></p>
        </div></body></html>`,
      }));
      await page.click('#terms-read-btn');
      await page.waitForFunction(() => document.getElementById('terms-scroll-region').querySelector('h2'));

      const check = await page.evaluate(() => {
        const region = document.getElementById('terms-scroll-region');
        const links = Array.from(region.querySelectorAll('a'));
        return {
          protoRelativeSurvives: links.some((a) => (a.getAttribute('href') || '').indexOf('evil.example.test') !== -1),
          protoRelativeText: region.textContent.indexOf('protocol-relative link') !== -1,
          backslashText: region.textContent.indexOf('backslash link') !== -1,
        };
      });
      assert.equal(check.protoRelativeSurvives, false, 'neither "//host/path" nor "/\\host/path" ever survives as a real href');
      assert.equal(check.protoRelativeText, true, 'the protocol-relative link is replaced by its text, not dropped entirely');
      assert.equal(check.backslashText, true, 'the backslash link is replaced by its text, not dropped entirely');

      await page.close();
    } finally {
      await browser.close();
    }
  });

  it('R3-10: Tab alone, from dialog open, reaches Accept and records a real acceptance', async (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    const { chromium } = playwright;
    const browser = await chromium.launch();
    try {
      const page = await openDashboard(browser, 'r3-10@example.com');
      await page.click('#terms-read-btn');
      await page.waitForFunction(() => {
        const r = document.getElementById('terms-scroll-region');
        return r && r.scrollHeight > r.clientHeight + 100; // sanity: real Terms need real scrolling
      });
      const focusedOnOpen = await page.evaluate(() => document.activeElement && document.activeElement.id);
      assert.equal(focusedOnOpen, 'terms-scroll-region', 'initial focus is on the scrollable region (T-40/41)');

      let acceptPosted = null;
      page.on('request', (r) => { if (r.url().endsWith('/account/accept-terms')) { try { acceptPosted = JSON.parse(r.postData() || '{}'); } catch (_) { acceptPosted = {}; } } });

      let enabled = false;
      for (let i = 0; i < 30 && !enabled; i++) {
        await page.keyboard.press('Tab');
        enabled = await page.evaluate(() => !document.getElementById('terms-accept-btn').disabled);
      }
      assert.equal(enabled, true, 'Tab alone (no mouse, no touch, no manual scrollTop) must be able to enable Accept');

      let onAccept = false;
      for (let i = 0; i < 6 && !onAccept; i++) {
        onAccept = (await page.evaluate(() => document.activeElement && document.activeElement.id)) === 'terms-accept-btn';
        if (!onAccept) await page.keyboard.press('Tab');
      }
      assert.equal(onAccept, true, 'Tab must be able to reach Accept once it is enabled, before Close');

      await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.getElementById('terms-dialog-overlay').style.display === 'none');
      assert.ok(acceptPosted, 'activating Accept by keyboard must record a real acceptance');
      assert.equal(acceptPosted.agree, true);

      await page.close();
    } finally {
      await browser.close();
    }
  });

  it('R3-11: the background is inert to assistive technology while the Terms dialog is open, and restored on close; the dialog itself is never inert', async (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    const { chromium } = playwright;
    const browser = await chromium.launch();
    try {
      const page = await openDashboard(browser, 'r3-11@example.com');
      await page.click('#terms-read-btn');
      await page.waitForSelector('#terms-dialog-overlay', { state: 'visible' });

      const whileOpen = await page.evaluate(() => ({
        navInert: document.getElementById('main-nav').hasAttribute('inert'),
        mainInert: document.getElementById('main').hasAttribute('inert'),
        dialogInert: document.getElementById('terms-dialog-overlay').hasAttribute('inert'),
      }));
      assert.equal(whileOpen.navInert, true, 'the nav is inert while the dialog is open');
      assert.equal(whileOpen.mainInert, true, 'the main content is inert while the dialog is open');
      assert.equal(whileOpen.dialogInert, false, 'the dialog itself must never be inert');

      await page.click('#terms-close-btn');
      await page.waitForSelector('#terms-dialog-overlay', { state: 'hidden' });
      const afterClose = await page.evaluate(() => ({
        navInert: document.getElementById('main-nav').hasAttribute('inert'),
        mainInert: document.getElementById('main').hasAttribute('inert'),
      }));
      assert.equal(afterClose.navInert, false, 'inert is removed from the nav after close');
      assert.equal(afterClose.mainInert, false, 'inert is removed from the main content after close');

      await page.close();
    } finally {
      await browser.close();
    }
  });

  it('R3-4: Accept and Close stay fully inside the viewport and the dialog, and the scrolling region stays >= 80 high, at every viewport from 320x568/280 upward', async (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    const { chromium } = playwright;
    const browser = await chromium.launch();
    try {
      const viewports = [
        { width: 568, height: 320 },
        { width: 667, height: 300 },
        { width: 740, height: 280 },
        { width: 320, height: 568 },
        { width: 375, height: 812 },
        { width: 1280, height: 900 },
      ];
      for (const vp of viewports) {
        const page = await openDashboard(browser, `r3-4-${vp.width}x${vp.height}@example.com`, vp);
        await page.click('#terms-read-btn');
        await page.waitForFunction(() => document.getElementById('terms-scroll-region').textContent.trim().length > 500);

        const m = await page.evaluate(() => {
          const dlg = document.getElementById('terms-dialog').getBoundingClientRect();
          const region = document.getElementById('terms-scroll-region').getBoundingClientRect();
          const accept = document.getElementById('terms-accept-btn').getBoundingClientRect();
          const close = document.getElementById('terms-close-btn').getBoundingClientRect();
          return {
            vw: innerWidth,
            vh: innerHeight,
            dlg: { top: dlg.top, bottom: dlg.bottom, left: dlg.left, right: dlg.right },
            region: { height: region.height },
            accept: { top: accept.top, bottom: accept.bottom, left: accept.left, right: accept.right },
            close: { top: close.top, bottom: close.bottom, left: close.left, right: close.right },
          };
        });

        const label = `${vp.width}x${vp.height}`;
        for (const [name, rect] of [['accept', m.accept], ['close', m.close]]) {
          assert.ok(rect.top >= 0 && rect.bottom <= m.vh, `${name} fully inside the viewport at ${label}`);
          assert.ok(rect.left >= 0 && rect.right <= m.vw, `${name} fully inside the viewport (width) at ${label}`);
          assert.ok(rect.top >= m.dlg.top - 1 && rect.bottom <= m.dlg.bottom + 1, `${name} fully inside the dialog at ${label}`);
        }
        assert.ok(m.region.height >= 80, `the scrolling region is at least 80 high at ${label} (got ${m.region.height})`);

        await page.close();
      }
    } finally {
      await browser.close();
    }
  });
});
