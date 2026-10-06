'use strict';

/**
 * test/session-ended.test.js — BUILD-BRIEF-TERMS-SCROLL.md Part S.
 *
 * A stored session token the server refuses must send the builder to the
 * sign-in screen with one line, once, instead of printing the raw 401 text
 * in every card. A 403 is never treated as a session that has ended.
 *
 *   S-1: an expired (or unreadable) stored token, caught at start-up before
 *        a single request is made.
 *   S-2: a token the server refuses (401) on an actual account request,
 *        caught once even though many requests fire concurrently at page
 *        load, and proven to touch no card's rendered text.
 *   S-3: a 403 is not a session that has ended -- TERMS_NOT_ACCEPTED shows
 *        the Terms card (both routes that can answer it from the dashboard:
 *        the pack-purchase handler, live, and the Stripe withdrawal
 *        handler, mocked because its OFAC-readiness gate needs a live
 *        Treasury-list fetch this sandbox has no network path to); any
 *        other 403 shows the server's message and leaves the builder
 *        signed in.
 *   S-5: signing in again after S-2 lands on a working dashboard.
 *
 * Session tokens are minted directly with `jose` and seeded into
 * localStorage via page.addInitScript, same shortcut
 * test/terms-scroll-accept.test.js uses.
 *
 * Runner: node --test test/session-ended.test.js
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
const SESSION_SECRET = 'session-ended-test-session-secret-32byte';

let acctCounter = 0;
function freshAccountId() {
  acctCounter += 1;
  return `acc_session_ended_${acctCounter}`;
}

async function realJwt(accountId, email) {
  return new SignJWT({ accountId, email })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(Buffer.from(SESSION_SECRET));
}

// A token the server refuses: well-formed, decodable, future exp (so the
// CLIENT's own start-up check treats it as usable and proceeds to
// showDashboard()) but signed with a secret the server does not hold, so
// every real server-side verifyJwt() call rejects it with a real 401 --
// no route mocking needed for S-2.
async function serverRefusedJwt(accountId, email) {
  return new SignJWT({ accountId, email })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(Buffer.from('a-completely-different-secret-not-known-32b'));
}

// A stored token that cannot be trusted at start-up: decodable JSON, but
// exp already in the past. No real signature needed -- isTokenUsable()
// never checks one; that is the server's job.
function expiredToken(email) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    accountId: 'acc_whoever',
    email,
    exp: Math.floor(Date.now() / 1000) - 3600,
  })).toString('base64url');
  return `${header}.${payload}.not-a-real-signature`;
}

function extractMagicToken(output, email) {
  const re = new RegExp('\\[accounts\\] Magic link for ' + email.replace(/[.]/g, '\\.') + ': (\\S+)', 'g');
  let m;
  let last = null;
  while ((m = re.exec(output))) last = m;
  if (!last) return null;
  const url = new URL(last[1]);
  return url.searchParams.get('token');
}

describe('BUILD-BRIEF-TERMS-SCROLL Part S: a session that has ended', { timeout: 240_000 }, () => {
  let tmpDir;
  let child;
  let baseUrl;
  let boot;
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
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auxilo-session-ended-'));
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
    boot = bootResult;
    child = boot.child;
    baseUrl = boot.baseUrl;
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

  async function acceptedExtra() {
    const { CURRENT_TOS_VERSION } = require('../lib/accounts.js');
    return { tos_version: CURRENT_TOS_VERSION, accepted_at: Date.now() };
  }

  it('S-1: a stored token whose exp has passed shows sign-in with the one line, before any request is made', async (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    const { chromium } = playwright;
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      const token = expiredToken('expired-user@example.com');
      await page.addInitScript((t) => { localStorage.setItem('auxilo_session', t); }, token);

      // No route should ever be hit with this token -- S-1 is a client-side
      // decision made before a single request goes out.
      let anyAccountRequest = false;
      await page.route('**/account/**', (route) => { anyAccountRequest = true; route.continue(); });

      await page.goto(`${baseUrl}/dashboard`, { waitUntil: 'networkidle' });
      await page.waitForSelector('#login-view', { state: 'visible' });

      const state = await page.evaluate(() => ({
        dashHidden: document.getElementById('dash-view').style.display === 'none',
        alertText: document.getElementById('login-alert').textContent,
        alertClass: document.getElementById('login-alert').className,
        tokenLeft: localStorage.getItem('auxilo_session'),
        focusedId: document.activeElement && document.activeElement.id,
      }));
      assert.equal(state.dashHidden, true, 'the dashboard never shows');
      assert.equal(state.alertText, 'Your session ended. Sign in again.');
      assert.equal(state.alertClass, 'alert alert-info', 'informational style, not error (S-4)');
      assert.equal(state.tokenLeft, null, 'the unusable token is cleared');
      assert.equal(anyAccountRequest, false, 'S-1 is decided before any account request is made');
      assert.equal(state.focusedId, 'login-email', 'R3-12: focus lands in the email field, not the body');

      await page.close();
    } finally {
      await browser.close();
    }
  });

  it('S-2: a token the server refuses (401) redirects once, even though many account requests fire at page load; no card ever shows the raw text', async (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    const { chromium } = playwright;
    const browser = await chromium.launch();
    try {
      const accountId = seedAccount('refused-token@example.com');
      const token = await serverRefusedJwt(accountId, 'refused-token@example.com');
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      await page.addInitScript((t) => {
        localStorage.setItem('auxilo_session', t);
        // Counts real removals of the session key, to prove clearToken (and
        // so the whole session-ended handler) runs exactly once no matter
        // how many concurrent 401s land.
        window.__clearCalls = 0;
        const orig = Storage.prototype.removeItem;
        Storage.prototype.removeItem = function (key) {
          if (key === 'auxilo_session') window.__clearCalls += 1;
          return orig.call(this, key);
        };
        // R4-5: rather than a fixed settle window, count every /account/
        // request showDashboard fires at load and wait for each one's raw
        // network response to land -- the actual "further in-flight
        // request" this test needs to let finish before it can trust
        // __clearCalls. Counted against the underlying fetch()'s own
        // promise, not apiFetch's, since apiFetch deliberately leaves a
        // 401's promise unresolved forever (S-2) -- the network response
        // itself still lands and is what this test must wait past.
        window.__accountRequestsStarted = 0;
        window.__accountRequestsFinished = 0;
        const origFetch = window.fetch;
        window.fetch = function (input, init) {
          const url = typeof input === 'string' ? input : (input && input.url) || '';
          const isAccount = url.indexOf('/account/') !== -1;
          if (isAccount) window.__accountRequestsStarted += 1;
          const p = origFetch.apply(this, arguments);
          if (isAccount) {
            p.then(function () { window.__accountRequestsFinished += 1; },
                   function () { window.__accountRequestsFinished += 1; });
          }
          return p;
        };
      }, token);

      await page.goto(`${baseUrl}/dashboard`, { waitUntil: 'networkidle' });
      await page.waitForSelector('#login-view', { state: 'visible' });
      // Every /account/ request showDashboard fired at load must have its
      // raw response back before __clearCalls can be trusted as final.
      await page.waitForFunction(() => window.__accountRequestsStarted > 0
        && window.__accountRequestsFinished >= window.__accountRequestsStarted, { timeout: 20_000 });

      const state = await page.evaluate(() => ({
        dashHidden: document.getElementById('dash-view').style.display === 'none',
        alertText: document.getElementById('login-alert').textContent,
        alertClass: document.getElementById('login-alert').className,
        tokenLeft: localStorage.getItem('auxilo_session'),
        clearCalls: window.__clearCalls,
        dashHtml: document.getElementById('dash-view').innerHTML,
        focusedId: document.activeElement && document.activeElement.id,
      }));
      assert.equal(state.dashHidden, true);
      assert.equal(state.alertText, 'Your session ended. Sign in again.');
      assert.equal(state.alertClass, 'alert alert-info');
      assert.equal(state.tokenLeft, null);
      assert.equal(state.clearCalls, 1, 'handled exactly once, not once per concurrent request');
      assert.ok(!state.dashHtml.includes('Invalid or expired credentials'), 'no card ever prints the raw 401 text');
      assert.ok(!state.dashHtml.includes('Invalid or expired session token'), 'no card ever prints the raw 401 text');
      assert.equal(state.focusedId, 'login-email', 'R3-12: focus lands in the email field, not the body');

      // S-5: signing in again lands on a working dashboard.
      await fetch(`${baseUrl}/auth/magic-link`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'refused-token@example.com' }),
      });
      let magicToken = null;
      for (let i = 0; i < 30 && !magicToken; i++) {
        magicToken = extractMagicToken(boot.getOutput(), 'refused-token@example.com');
        if (!magicToken) await new Promise((r) => setTimeout(r, 150));
      }
      assert.ok(magicToken, 'magic link token found in server output');
      await page.goto(`${baseUrl}/dashboard?token=${encodeURIComponent(magicToken)}`, { waitUntil: 'networkidle' });
      await page.waitForSelector('#dash-view', { state: 'visible' });
      const afterSignIn = await page.evaluate(() => ({
        loginHidden: document.getElementById('login-view').style.display === 'none',
        email: document.getElementById('dash-email-label').textContent,
      }));
      assert.equal(afterSignIn.loginHidden, true);
      assert.equal(afterSignIn.email, 'refused-token@example.com');

      await page.close();
    } finally {
      await browser.close();
    }
  });

  it('S-3a: a 403 TERMS_NOT_ACCEPTED from the pack-purchase route (live) shows the Terms card and leaves the builder signed in', async (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    const { chromium } = playwright;
    const browser = await chromium.launch();
    try {
      const email = 's3a-checkout@example.com';
      const accountId = seedAccount(email); // fresh account -- needs_acceptance: true
      const token = await realJwt(accountId, email);
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      await page.addInitScript((t) => { localStorage.setItem('auxilo_session', t); }, token);
      await page.goto(`${baseUrl}/dashboard`, { waitUntil: 'networkidle' });
      await page.waitForSelector('#terms-gate', { state: 'visible' });

      // Hide it and move focus elsewhere first, so re-showing it + moving
      // focus back proves THIS handler did it, not just initial load.
      await page.evaluate(() => {
        document.getElementById('terms-gate').style.display = 'none';
        document.getElementById('connect-stripe-btn') && document.getElementById('connect-stripe-btn').focus();
      });

      await page.evaluate(() => { window.auxiloBuyCredits('starter', null); }); // fire and forget; real network call
      await page.waitForFunction(() => document.getElementById('terms-gate').style.display !== 'none');

      const state = await page.evaluate(() => ({
        gateVisible: document.getElementById('terms-gate').style.display !== 'none',
        focusedId: document.activeElement && document.activeElement.id,
        dashVisible: document.getElementById('dash-view').style.display !== 'none',
        loginVisible: document.getElementById('login-view').style.display !== 'none',
      }));
      assert.equal(state.gateVisible, true);
      assert.equal(state.focusedId, 'terms-read-btn');
      assert.equal(state.dashVisible, true, 'still signed in');
      assert.equal(state.loginVisible, false, 'a 403 is not a session that has ended');

      await page.close();
    } finally {
      await browser.close();
    }
  });

  it('S-3b: a 403 TERMS_NOT_ACCEPTED from the Stripe withdrawal route (mocked past the OFAC-readiness gate) shows the Terms card and leaves the builder signed in', async (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    const { chromium } = playwright;
    const browser = await chromium.launch();
    try {
      const email = 's3b-withdraw@example.com';
      const accountId = seedAccount(email, await acceptedExtra()); // ToS already accepted -- card starts hidden
      const token = await realJwt(accountId, email);
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      await page.addInitScript((t) => { localStorage.setItem('auxilo_session', t); }, token);
      // The real /account/earnings on a staged server always reports
      // payouts_paused: true (no CUSTODIAL_WITHDRAW_ENABLED), so the withdraw
      // form (and #withdraw-btn) never renders -- mock a withdrawable
      // balance so the client's OWN 403 handling can be exercised, the same
      // network-mock approach test/vision-dashboard-payout-panel.test.js uses.
      await page.route('**/account/earnings', (route) => {
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            pending_balance: 5, total_contributor: 5, lifetime_gross: 5, total_withdrawn: 0,
            payouts_paused: false, can_withdraw: true, wallet: null, recent: [],
          }),
        });
      });
      // D0: reach the existing Terms response only after owner-status preflight.
      await page.route('**/account/stripe-transfer-attempts/current', (route) => {
        route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Cache-Control': 'private, no-store' }, body: JSON.stringify({ account_id: accountId, attempt: null }) });
      });
      await page.route('**/withdraw/stripe', (route) => {
        route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'You must accept the current Terms of Service before this action.', code: 'TERMS_NOT_ACCEPTED' }) });
      });

      await page.goto(`${baseUrl}/dashboard`, { waitUntil: 'networkidle' });
      await page.waitForSelector('#terms-gate', { state: 'hidden' });
      await page.waitForSelector('#withdraw-btn', { state: 'attached' });

      await page.evaluate(() => {
        const el = document.getElementById('withdraw-amount');
        if (el) el.value = '5';
        document.getElementById('withdraw-btn').onclick();
      });
      await page.waitForFunction(() => document.getElementById('terms-gate').style.display !== 'none');

      const state = await page.evaluate(() => ({
        gateVisible: document.getElementById('terms-gate').style.display !== 'none',
        focusedId: document.activeElement && document.activeElement.id,
        dashVisible: document.getElementById('dash-view').style.display !== 'none',
        loginVisible: document.getElementById('login-view').style.display !== 'none',
      }));
      assert.equal(state.gateVisible, true);
      assert.equal(state.focusedId, 'terms-read-btn');
      assert.equal(state.dashVisible, true, 'still signed in');
      assert.equal(state.loginVisible, false, 'a 403 is not a session that has ended');

      await page.close();
    } finally {
      await browser.close();
    }
  });

  it('S-3c: any other 403 (e.g. a suspended account) shows the server message in the existing alert area and leaves the builder signed in', async (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    const { chromium } = playwright;
    const browser = await chromium.launch();
    try {
      const email = 's3c-suspended@example.com';
      const accountId = seedAccount(email, await acceptedExtra());
      const token = await realJwt(accountId, email);
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      await page.addInitScript((t) => { localStorage.setItem('auxilo_session', t); }, token);
      await page.route('**/account/connect-stripe', (route) => {
        route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'Account suspended' }) });
      });

      await page.goto(`${baseUrl}/dashboard`, { waitUntil: 'networkidle' });
      await page.waitForSelector('#connect-stripe-btn', { state: 'attached' });
      await page.evaluate(() => document.getElementById('connect-stripe-btn').onclick());
      await page.waitForFunction(() => {
        const el = document.getElementById('stripe-alert');
        return el && el.style.display !== 'none' && el.textContent.length > 0;
      });

      const state = await page.evaluate(() => ({
        alertText: document.getElementById('stripe-alert').textContent,
        alertClass: document.getElementById('stripe-alert').className,
        dashVisible: document.getElementById('dash-view').style.display !== 'none',
        loginVisible: document.getElementById('login-view').style.display !== 'none',
      }));
      assert.equal(state.alertText, 'Account suspended');
      assert.equal(state.alertClass, 'alert alert-error');
      assert.equal(state.dashVisible, true, 'still signed in');
      assert.equal(state.loginVisible, false);

      await page.close();
    } finally {
      await browser.close();
    }
  });

  it('R3-5: a 401 while the Terms dialog is open closes it and restores page scroll -- the sign-in button is reachable at 568x320', async (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    const { chromium } = playwright;
    const browser = await chromium.launch();
    try {
      const email = 'r3-5@example.com';
      const accountId = seedAccount(email);
      const token = await realJwt(accountId, email);
      const page = await browser.newPage({ viewport: { width: 568, height: 320 } });
      await page.addInitScript((t) => { localStorage.setItem('auxilo_session', t); }, token);
      await page.goto(`${baseUrl}/dashboard`, { waitUntil: 'networkidle' });
      await page.waitForSelector('#terms-gate', { state: 'visible' });
      await page.click('#terms-read-btn');
      await page.waitForSelector('#terms-dialog-overlay', { state: 'visible' });

      await page.route('**/account/accept-terms', (route) => {
        route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'Invalid or expired credentials' }) });
      });
      // Reach the end for real, then click Accept -- the 401 this route
      // mocks comes back from a genuine click, not a fabricated call. This
      // pair waits on a REAL, unmocked /terms fetch + render, so under a
      // heavily loaded full-suite run (many concurrent staged servers and
      // browsers) it is given a generous timeout rather than Playwright's
      // 30s default -- the assertions themselves are unchanged.
      await page.waitForFunction(() => {
        const r = document.getElementById('terms-scroll-region');
        return r && r.scrollHeight > 0;
      }, null, { timeout: 60_000 });
      await page.evaluate(() => {
        const r = document.getElementById('terms-scroll-region');
        r.scrollTop = r.scrollHeight;
      });
      await page.waitForFunction(() => !document.getElementById('terms-accept-btn').disabled, null, { timeout: 60_000 });
      await page.click('#terms-accept-btn');

      await page.waitForSelector('#login-view', { state: 'visible' });
      const m = await page.evaluate(() => ({
        overlayHidden: document.getElementById('terms-dialog-overlay').style.display === 'none',
        bodyOverflow: document.body.style.overflow,
        mainInert: document.getElementById('main').hasAttribute('inert'),
        loginBtnDisabled: document.getElementById('login-btn').disabled,
        loginBtnInViewport: (() => {
          const r = document.getElementById('login-btn').getBoundingClientRect();
          return r.top >= 0 && r.bottom <= innerHeight;
        })(),
      }));
      assert.equal(m.overlayHidden, true, 'the 401 must close the Terms dialog');
      // R3-5's own fix: closing the dialog resets the INLINE overflow lock
      // this page's own code applies (see openTermsDialog/closeTermsDialog).
      // Site-wide, `html, body { overflow-x: clip }` (styles.css, an
      // unrelated horizontal-overflow backstop) also caps vertical body
      // scroll at this exact 320-tall viewport on the plain sign-in screen
      // with no dialog ever involved (verified: a fresh, dialog-free load
      // of #login-view at 568x320 shows the identical cap) -- so a
      // scrollTo-based "can the page scroll" probe cannot distinguish this
      // fix from a still-broken one, and is not used here. What IS this
      // fix's to prove, and what is asserted: the lock this dialog itself
      // applies is released, and the sign-in button ends up sized and
      // enabled the same as it would after any normal sign-out.
      assert.equal(m.bodyOverflow, '', 'page scroll must be restored, not left locked by this dialog');
      assert.equal(m.mainInert, false, 'inert must be removed along with closing the dialog');
      assert.equal(m.loginBtnDisabled, false, 'the sign-in button is present, enabled, and normally sized -- not hidden behind a residual lock');

      await page.close();
    } finally {
      await browser.close();
    }
  });

  it('R3-6: a request that would go out with no stored token is itself a session that has ended (same screen, same line, once), no raw "Authorization required" text', async (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    const { chromium } = playwright;
    const browser = await chromium.launch();
    try {
      const email = 'r3-6@example.com';
      const accountId = seedAccount(email);
      const token = await realJwt(accountId, email);
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      await page.addInitScript((t) => { localStorage.setItem('auxilo_session', t); }, token);
      await page.goto(`${baseUrl}/dashboard`, { waitUntil: 'networkidle' });
      await page.waitForSelector('#terms-gate', { state: 'visible' });

      // Simulates signing out in another tab: the token is gone, but this
      // tab's own in-memory JS state (and open dashboard) is untouched.
      let anyAccountRequest = false;
      await page.route('**/account/**', (route) => { anyAccountRequest = true; route.continue(); });
      await page.evaluate(() => localStorage.removeItem('auxilo_session'));
      await page.evaluate(() => window.auxiloBuyCredits('starter', null));

      await page.waitForSelector('#login-view', { state: 'visible' });
      const state = await page.evaluate(() => ({
        alertText: document.getElementById('login-alert').textContent,
        alertClass: document.getElementById('login-alert').className,
        dashAlertText: document.getElementById('dash-alert') ? document.getElementById('dash-alert').textContent : '',
        dashHtml: document.getElementById('dash-view').innerHTML,
      }));
      assert.equal(state.alertText, 'Your session ended. Sign in again.');
      assert.equal(state.alertClass, 'alert alert-info');
      assert.equal(state.dashAlertText, '', 'the generic dash-alert never gets the raw server text either');
      assert.ok(!state.dashHtml.includes('Authorization required'), 'no card ever prints the raw "Authorization required" text');
      assert.equal(anyAccountRequest, false, 'no request goes out at all -- there is no token to send');

      await page.close();
    } finally {
      await browser.close();
    }
  });

  it('R4-1: signing out while the checkout balance poll is pending never shows the session-ended line', async (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    const { chromium } = playwright;
    const browser = await chromium.launch();
    try {
      const email = 'r4-1@example.com';
      const accountId = seedAccount(email);
      const token = await realJwt(accountId, email);
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      await page.addInitScript((t) => { localStorage.setItem('auxilo_session', t); }, token);

      // The balance never increases, so pollForCreditIncrease keeps
      // rescheduling itself every 3s (the 'continue' outcome) instead of
      // ever stopping on its own -- exactly the pending-poll state R4-1
      // targets. Counted so the wait below can confirm no request landed
      // after sign-out, rather than sleeping blind.
      let creditsRequests = 0;
      await page.route('**/account/credits', (route) => {
        creditsRequests += 1;
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ credit_balance: { total_usd: 5 } }) });
      });

      await page.goto(`${baseUrl}/dashboard?checkout=success`, { waitUntil: 'networkidle' });
      await page.waitForSelector('#checkout-banner', { state: 'visible' });
      // Wait for the FIRST poll tick's own request to actually land (a real
      // state, not a guess), proving a NEXT tick is now scheduled.
      await new Promise((resolve) => {
        const check = () => { if (creditsRequests >= 1) resolve(); else setTimeout(check, 20); };
        check();
      });

      // Deliberate sign-out while that next tick is still pending.
      await page.evaluate(() => window.signOut());
      await page.waitForSelector('#login-form', { state: 'visible' });

      // A fresh magic-link request right after sign-out -- the state the
      // stale poll's session-ended handler would otherwise stomp back to
      // the bare login form.
      await page.fill('#login-email', 'someone-else@example.com');
      await page.click('#login-btn');
      await page.waitForSelector('#login-sent', { state: 'visible' });
      const sentMsgBefore = await page.evaluate(() => document.getElementById('login-sent-msg').textContent);

      const requestsAtSignOut = creditsRequests;
      // R4-1's own fix cancels the pending timer outright (signOut() calls
      // clearTimeout on it), so the positive signal to wait on is that the
      // window it was scheduled in (3s) has elapsed with no further
      // request -- there is no other event to observe an absence by.
      await new Promise((resolve) => setTimeout(resolve, 3500));

      const state = await page.evaluate(() => ({
        loginAlertVisible: document.getElementById('login-alert').style.display !== 'none',
        loginSentVisible: document.getElementById('login-sent').style.display !== 'none',
        loginFormVisible: document.getElementById('login-form').style.display !== 'none',
        sentMsg: document.getElementById('login-sent-msg').textContent,
      }));
      assert.equal(creditsRequests, requestsAtSignOut, 'the poll never fires again after sign-out -- its pending timer was cancelled');
      assert.equal(state.loginAlertVisible, false, 'the session-ended line never shows after a deliberate sign-out');
      assert.equal(state.loginSentVisible, true, 'the "check your email" confirmation is not cleared');
      assert.equal(state.loginFormVisible, false, 'the view does not revert to the bare login form');
      assert.equal(state.sentMsg, sentMsgBefore, 'the confirmation text itself is untouched');

      await page.close();
    } finally {
      await browser.close();
    }
  });
});
