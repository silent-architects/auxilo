'use strict';

/**
 * test/vision-dashboard-payout-panel.test.js — VISION PASS rows V-27, V-28,
 * V-33 (SITE-PM, 2026-09-27), REGISTER-V-VISION.md.
 *
 * V-27/V-28/V-33 sit in the branch of renderPayoutPanel() (public/
 * dashboard.html) that renders only when the server's `payouts_paused`
 * field is NOT strictly `true`. On this staged server (no
 * CUSTODIAL_WITHDRAW_ENABLED set), the real GET /account/earnings response
 * always carries payouts_paused: true, so a normal sign-in only exercises
 * the OTHER branch (already covered by test/launch-wave-dashboard.test.js).
 *
 * Per the brief: "Test them by driving that branch in a test, not by
 * changing the flag." renderPayoutPanel is a module-private function
 * inside dashboard.html's own IIFE, so it cannot be called directly from
 * page.evaluate(). Instead this file intercepts the client's own
 * GET /account/earnings fetch (Playwright page.route) and fulfills it with
 * a synthetic response whose payouts_paused is false — driving the real
 * code path the browser runs, through the real network boundary the app
 * uses, without touching the server's env-var flag at all.
 *
 * Runner: node --test test/vision-dashboard-payout-panel.test.js
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

function extractMagicToken(output, email) {
  const re = new RegExp('\\[accounts\\] Magic link for ' + email.replace(/[.]/g, '\\.') + ': (\\S+)', 'g');
  let m;
  let last = null;
  while ((m = re.exec(output))) last = m;
  if (!last) return null;
  const url = new URL(last[1]);
  return url.searchParams.get('token');
}

describe('VISION PASS (V-27/V-28/V-33): dashboard payout panel, non-paused branch, driven via network mock', { timeout: 240_000 }, () => {
  let tmpDir;
  let child;
  let baseUrl;
  let boot;
  let bootSkipReason = null;
  let playwright;

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
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auxilo-vision-dash-payout-'));
    const { dataDir } = stageServer({
      repoRoot: REPO,
      tmpDir,
      nodeModulesDir,
      port: reservation.port,
      rootFiles: ['server.js', 'seed-knowledge.json', 'skills.json', 'openapi.json', 'package.json', 'model_config.json'],
      linkDirs: [],
      copyDirs: ['lib', 'public', 'prompts', 'config'],
    });
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
        SESSION_SECRET: 'vision-dash-payout-session-secret-32byte',
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

  async function tokenForEmail(email) {
    await fetch(`${baseUrl}/auth/magic-link`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }),
    });
    let token = null;
    for (let i = 0; i < 30 && !token; i++) {
      token = extractMagicToken(boot.getOutput(), email);
      if (!token) await new Promise((r) => setTimeout(r, 150));
    }
    return token;
  }

  it('V-27: linked-wallet note reads the new text, no reason clause; V-33: the wallet heading carries no colon and no "coming soon"', async (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    const { chromium } = playwright;
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      await page.route('**/account/earnings', (route) => {
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            pending_balance: 1.23,
            total_contributor: 4.56,
            lifetime_gross: 5,
            total_withdrawn: 0,
            payouts_paused: false,
            wallet: '0x1111111111111111111111111111111111111111',
            recent: [],
          }),
        });
      });

      const token = await tokenForEmail('vision-payout-a@example.com');
      assert.ok(token, 'magic link token found in server output');
      // Dashboard.html's own bootstrap exchanges a RAW magic-link token for
      // a JWT via its own GET /auth/verify call (public/dashboard.html
      // ~line 3142) — pass the raw token, do not pre-redeem it (magic-link
      // tokens are single-use; redeeming it here would leave the page's own
      // verify call with nothing to exchange, and the dashboard would never
      // reach showDashboard()/loadEarnings()).
      await page.goto(`${baseUrl}/dashboard?token=${encodeURIComponent(token)}`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(400);

      const payoutText = await page.evaluate(() => document.getElementById('payout-content').textContent.replace(/\s+/g, ' ').trim());
      assert.ok(payoutText.includes('Your wallet is linked and ready for USDC withdrawals on Base when they open. Bank withdrawals via Stripe open soon. The withdrawals section below shows where things stand.'), `V-27 text not found, got: ${payoutText}`);
      assert.ok(!payoutText.includes('non-custodial rail rolls out'), 'the retired reason clause must not survive');
      assert.ok(!payoutText.includes('coming soon'), '"coming soon" must not survive anywhere in the payout panel');

      const headingText = await page.evaluate(() => {
        const wrap = document.getElementById('payout-content');
        const strongs = Array.from(wrap.querySelectorAll('strong'));
        const head = strongs.find((s) => s.textContent.includes('Wallet (USDC on Base)'));
        return head ? head.textContent : null;
      });
      assert.equal(headingText, 'Wallet (USDC on Base)', 'V-33: heading carries no colon, no "coming soon"');
    } finally {
      await browser.close();
    }
  });

  it('V-28: no-wallet note is now framed as a step, no "coming soon"', async (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    const { chromium } = playwright;
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      await page.route('**/account/earnings', (route) => {
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            pending_balance: 0,
            total_contributor: 0,
            lifetime_gross: 0,
            total_withdrawn: 0,
            payouts_paused: false,
            wallet: null,
            recent: [],
          }),
        });
      });

      const token = await tokenForEmail('vision-payout-b@example.com');
      assert.ok(token, 'magic link token found in server output');
      await page.goto(`${baseUrl}/dashboard?token=${encodeURIComponent(token)}`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(400);

      const payoutText = await page.evaluate(() => document.getElementById('payout-content').textContent.replace(/\s+/g, ' ').trim());
      assert.ok(payoutText.includes('No wallet linked. Link one now through your agent so it is ready when USDC withdrawals on Base open. Verify it with auxilo_verify_wallet, then link it with auxilo_link_wallet. Linking asks the wallet to sign a one-time challenge proving you control it. Bank withdrawals via Stripe open soon. The withdrawals section below shows where things stand.'), `V-28 text not found, got: ${payoutText}`);
      assert.ok(!payoutText.includes('coming soon'), '"coming soon" must not survive anywhere in the payout panel');
    } finally {
      await browser.close();
    }
  });
});
