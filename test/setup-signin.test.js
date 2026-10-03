'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { SignJWT } = require('jose');
const { chromium } = require('playwright');
const { reservePort, stageServer, bootServer, stopServer } = require('./helpers/staged-server');
const REPO = path.join(__dirname, '..');
const SECRET = 'setup-signin-test-session-secret-32byte';
const INVALID = 'That code did not match a waiting terminal. Check it, or run the command again for a new code.';

describe('SETUP-SIGNIN: typed device consent', { timeout: 120000 }, () => {
  let tmp, dataDir, boot, browser, base, serial = 0;
  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'auxilo-setup-signin-'));
    const reservation = await reservePort();
    assert.ok(reservation.port, 'loopback port available');
    const hono = require.resolve('hono', { paths: [REPO] });
    const staged = stageServer({ repoRoot: REPO, tmpDir: tmp,
      nodeModulesDir: hono.slice(0, hono.lastIndexOf(`${path.sep}node_modules${path.sep}`) + '/node_modules'.length),
      port: reservation.port,
      rootFiles: ['server.js', 'seed-knowledge.json', 'skills.json', 'openapi.json', 'package.json', 'model_config.json'],
      linkDirs: ['docs'], copyDirs: ['lib', 'public', 'prompts', 'config'],
      replacements: [{ name: 'expired device fixture', search: 'created_at: Date.now(),\n    device_code: deviceCode,', replace: "created_at: requestedLabel === 'expired-fixture' ? Date.now() - 600001 : Date.now(),\n    device_code: deviceCode," }],
    });
    dataDir = staged.dataDir;
    for (const file of ['accounts', 'earnings', 'magic_links', 'credits']) fs.writeFileSync(path.join(dataDir, file + '.json'), '{}');
    fs.writeFileSync(path.join(dataDir, 'learnings.json'), '[]');
    boot = await bootServer({ tmpDir: tmp, port: reservation.port, env: { NODE_ENV: 'test', BASE_URL: 'http://127.0.0.1:' + reservation.port, SESSION_SECRET: SECRET, RESEND_API_KEY: '', LLM_SENSITIVITY_ENABLED: 'false', WALLET_PRIVATE_KEY: '0x' + '11'.repeat(32) } });
    assert.ok(boot.child); base = boot.baseUrl;
    browser = await chromium.launch();
  });
  after(async () => { if (browser) await browser.close(); if (boot?.child) await stopServer(boot.child); if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });
  async function post(route, body) { const response = await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: response.status, data: await response.json() }; }
  async function session() {
    const id = 'acc_setup_' + (++serial), email = id + '@example.com';
    const file = path.join(dataDir, 'accounts.json');
    const accounts = JSON.parse(fs.readFileSync(file)); accounts[id] = { id, email, created_at: new Date().toISOString() }; fs.writeFileSync(file, JSON.stringify(accounts));
    return new SignJWT({ accountId: id, email }).setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime('10m').sign(Buffer.from(SECRET));
  }
  async function pageFor(token, query = '?connect=1') {
    const page = await browser.newPage();
    await page.addInitScript(t => localStorage.setItem('auxilo_session', t), token);
    await page.goto(base + '/dashboard' + query, { waitUntil: 'networkidle' });
    return page;
  }
  async function device(extra = {}) { return (await post('/auth/device', extra)).data; }

  it('t1: only boolean true adds connect=1 to the emailed URL', async () => {
    for (const [connect, expected] of [[true, '1'], [undefined, null], ['true', null], [false, null]]) {
      const email = `magic${++serial}@example.com`;
      assert.equal((await post('/auth/magic-link', { email, connect })).status, 200);
      const line = boot.getOutput().split('\n').find(l => l.includes('Magic link for ' + email + ':'));
      assert.ok(line); const url = new URL(line.slice(line.indexOf(': http') + 2));
      assert.equal(url.searchParams.get('connect'), expected);
      assert.ok(url.searchParams.get('token')); assert.equal(url.searchParams.has('code'), false); assert.equal(url.searchParams.has('device'), false);
    }
  });
  it('t2: connect card ignores code and device URL fields and strips the address', async () => {
    const page = await pageFor(await session(), '?connect=1&code=ABCD1234&device=1234ABCD');
    assert.equal(await page.locator('#terminal-connect-code').inputValue(), '');
    assert.equal(new URL(page.url()).search, ''); assert.equal(await page.locator('#terminal-connect').count(), 1); await page.close();
  });
  it('t3: typed lowercase code becomes one uppercase POST and the secret poll receives the key', async () => {
    const d = await device(); const page = await pageFor(await session()); let calls = [];
    page.on('request', r => { if (r.url().endsWith('/auth/device/authorize')) calls.push(r.postDataJSON()); });
    await page.fill('#terminal-connect-code', d.user_code.toLowerCase()); await page.click('#terminal-connect button');
    await page.getByText('Your terminal is connected. Return to it, and it finishes on its own.').waitFor();
    assert.equal(calls.length, 1); assert.equal(calls[0].code, d.user_code);
    const result = await (await fetch(base + '/auth/device/status?device_code=' + encodeURIComponent(d.device_code))).json();
    assert.equal(result.status, 'authorized'); assert.match(result.api_key, /^axl_c_/); await page.close();
  });
  it('t4: dismiss sends no authorization and shows the dismissal line', async () => {
    const page = await pageFor(await session()); let calls = 0;
    page.on('request', r => { if (r.url().endsWith('/auth/device/authorize')) calls++; });
    await page.getByText('This Was Not Me', { exact: true }).click();
    assert.equal(await page.getByText('Nothing was connected. You can close this page.').count(), 1);
    assert.equal(calls, 0); assert.equal(await page.locator('#terminal-connect-code').isVisible(), false); await page.close();
  });
  it('t5: invalid input makes no POST', async () => {
    const page = await pageFor(await session()); let calls = 0;
    page.on('request', r => { if (r.url().endsWith('/auth/device/authorize')) calls++; });
    for (const value of ['', '1234567', 'GGGGGGGG', '<script>']) {
      await page.fill('#terminal-connect-code', value); await page.click('#terminal-connect button');
      assert.equal(await page.getByText('Enter the eight characters your terminal shows.').count(), 1);
    }
    assert.equal(calls, 0); await page.close();
  });
  it('t6: unknown, expired and already-authorized codes show the same approved line', async () => {
    const token = await session(); const authorized = await device();
    assert.equal((await post('/auth/device/authorize', { code: authorized.user_code, session_token: token })).status, 200);
    const expired = await device({ label: 'expired-fixture' });
    const page = await pageFor(token);
    for (const code of ['00000000', expired.user_code, authorized.user_code]) {
      await page.fill('#terminal-connect-code', code); await page.click('#terminal-connect button');
      await page.waitForFunction(text => document.querySelector('#terminal-connect [role=status]').textContent === text && !document.querySelector('#terminal-connect button').disabled, INVALID);
    }
    await page.close();
  });
  it('t7: the dashboard preserves requested read scope', async () => {
    const d = await device({ scope: 'read' }); const page = await pageFor(await session());
    await page.fill('#terminal-connect-code', d.user_code); await page.click('#terminal-connect button');
    await page.getByText('Your terminal is connected. Return to it, and it finishes on its own.').waitFor();
    const result = await (await fetch(base + '/auth/device/status?device_code=' + encodeURIComponent(d.device_code))).json();
    assert.equal(result.scope, 'read'); assert.match(result.api_key, /^axl_r_/); await page.close();
  });
  it('t8: device email page removes token paste and uses the exact approved copy', async () => {
    const d = await device(); const page = await browser.newPage();
    await page.goto(base + '/auth/device/verify?code=' + d.user_code);
    assert.equal(await page.locator('#jwt').count(), 0); assert.doesNotMatch(await page.content(), /paste.*(?:JWT|token)/i);
    assert.equal(await page.getByText('Open Your Dashboard to Connect').getAttribute('href'), '/dashboard?connect=1');
    await page.fill('#email', 'device-email@example.com'); await page.getByText('Send Magic Link', { exact: true }).click();
    await page.getByText('Auxilo sent a sign-in link to device-email@example.com. Click it, then enter the code from your terminal on the dashboard that opens.').waitFor();
    await page.close();
  });
  it('t9: headless session-token authorization remains supported', async () => {
    const d = await device(); const res = await post('/auth/device/authorize', { code: d.user_code, session_token: await session() });
    assert.equal(res.status, 200); assert.equal(res.data.status, 'authorized');
  });
  it('t10: eleven attempts are blocked per session and the eleventh valid code stays pending', async () => {
    const token = await session(); const d = await device();
    for (let i = 0; i < 10; i++) assert.equal((await post('/auth/device/authorize', { code: '00000000', session_token: token })).status, 404);
    const blocked = await post('/auth/device/authorize', { code: d.user_code, session_token: token });
    assert.equal(blocked.status, 429); assert.equal(blocked.data.error, 'Rate limit exceeded'); assert.ok(blocked.data.retry_after <= 900);
    assert.equal((await (await fetch(base + '/auth/device/status?device_code=' + d.device_code)).json()).status, 'pending');
    assert.equal((await post('/auth/device/authorize', { code: d.user_code, session_token: await session() })).status, 200);
  });
  it('t11: the user code alone cannot retrieve a key', async () => {
    const d = await device(); await post('/auth/device/authorize', { code: d.user_code, session_token: await session() });
    for (const query of ['code=' + d.user_code, 'device_code=' + d.user_code]) {
      const r = await fetch(base + '/auth/device/status?' + query); assert.ok([400, 404].includes(r.status)); assert.equal((await r.json()).api_key, undefined);
    }
  });
  it('expired session returns to existing sign-in screen', async () => {
    const page = await pageFor(await session());
    await page.route('**/auth/device/authorize', r => r.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'Invalid or expired session token' }) }));
    await page.fill('#terminal-connect-code', '1234ABCD'); await page.click('#terminal-connect button');
    await page.getByText('Your session ended. Sign in again.', { exact: true }).waitFor(); await page.close();
  });
});
