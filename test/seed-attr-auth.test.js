'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SignJWT } = require('jose');
const {
  bootServer,
  reservePort,
  stageServer,
  stopServer,
} = require('./helpers/staged-server');

const ROOT = path.join(__dirname, '..');
const SESSION_SECRET = 'seed-attr-auth-session-secret-32-bytes';
const PLATFORM_ACCOUNT_ID = 'acc_platform';
const PLATFORM_EMAIL = 'platform@auxilo.io';
const PLATFORM_ALIAS = 'platform-identity-alias@example.test';
const ORDINARY_ACCOUNT_ID = 'acc_seed_attr_auth_control';
const ORDINARY_EMAIL = 'ordinary-seed-attr@example.test';
const RAW_PLATFORM_KEY = `axl_c_${'p'.repeat(32)}`;
const NEUTRAL_MAGIC_RESPONSE = {
  message: 'If that email is valid, a login link has been sent.',
};
const INVALID_TOKEN_RESPONSE = { error: 'Invalid or expired token' };

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function platformAccount(email = PLATFORM_ALIAS) {
  return {
    id: PLATFORM_ACCOUNT_ID,
    email,
    created_at: '2026-09-02T12:00:00.000Z',
    api_keys: [{
      id: 'key_seed_attr_platform',
      hash: sha256(RAW_PLATFORM_KEY),
      label: 'existing-platform',
      name: 'existing-platform',
      scope: 'contribute',
      scope_version: 2,
      active: true,
      created_at: '2026-09-02T12:00:00.000Z',
      last_used_at: null,
    }],
    platform: true,
  };
}

function ordinaryAccount() {
  return {
    id: ORDINARY_ACCOUNT_ID,
    email: ORDINARY_EMAIL,
    created_at: '2026-09-02T12:00:00.000Z',
    api_keys: [],
  };
}

async function startAuthFixture(t, { accounts = {}, magicLinks = {} } = {}) {
  let nodeModulesDir;
  try {
    const honoEntry = require.resolve('hono', { paths: [ROOT] });
    nodeModulesDir = honoEntry.slice(
      0,
      honoEntry.lastIndexOf(`${path.sep}node_modules${path.sep}`) + '/node_modules'.length,
    );
  } catch {
    t.skip('hono not resolvable from repo root');
    return null;
  }

  const reservation = await reservePort();
  if (reservation.skipReason) {
    t.skip(reservation.skipReason);
    return null;
  }

  const app = fs.mkdtempSync(path.join(os.tmpdir(), 'auxilo-seed-attr-auth-'));
  let child = null;
  let closed = false;
  const cleanup = async () => {
    if (closed) return;
    closed = true;
    if (child) await stopServer(child);
    fs.rmSync(app, { recursive: true, force: true });
  };
  t.after(cleanup);

  try {
    const { dataDir } = stageServer({
      repoRoot: ROOT,
      tmpDir: app,
      nodeModulesDir,
      port: reservation.port,
      rootFiles: [
        'server.js',
        'seed-knowledge.json',
        'skills.json',
        'openapi.json',
        'package.json',
        'model_config.json',
      ],
      linkDirs: [],
      copyDirs: ['lib', 'public', 'prompts', 'config'],
    });

    const files = {
      accounts: path.join(dataDir, 'accounts.json'),
      magicLinks: path.join(dataDir, 'magic_links.json'),
    };
    writeJson(path.join(dataDir, 'learnings.json'), []);
    writeJson(files.accounts, accounts);
    writeJson(files.magicLinks, magicLinks);
    writeJson(path.join(dataDir, 'earnings.json'), {});
    writeJson(path.join(dataDir, 'credits.json'), {});
    writeJson(path.join(dataDir, 'unlock-attribution.json'), {});
    writeJson(path.join(dataDir, 'purchase-ledger.json'), {});
    writeJson(path.join(dataDir, 'verified-wallets.json'), {});

    const boot = await bootServer({
      tmpDir: app,
      port: reservation.port,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        PAYMENTS_ENABLED: 'true',
        WALLET_PRIVATE_KEY: `0x${'11'.repeat(32)}`,
        SESSION_SECRET,
        RESEND_API_KEY: '',
        CONTENT_MODERATION_ENABLED: 'true',
        LLM_SENSITIVITY_ENABLED: 'false',
        AUXILO_ACCOUNTS_FILE: files.accounts,
        AUXILO_CREDITS_FILE: path.join(dataDir, 'credits.json'),
        AUXILO_UNLOCK_ATTRIBUTION_FILE: path.join(dataDir, 'unlock-attribution.json'),
        AUXILO_PURCHASE_LEDGER_FILE: path.join(dataDir, 'purchase-ledger.json'),
      },
      timeoutMs: 60_000,
      maxAttempts: 3,
    });
    if (boot.skipReason) {
      t.skip(boot.skipReason);
      await cleanup();
      return null;
    }
    child = boot.child;
    return { ...boot, files, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  return {
    status: response.status,
    text,
    body: JSON.parse(text),
  };
}

async function postJson(url, body, headers = {}) {
  return fetchJson(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

async function sessionToken(accountId, email) {
  return new SignJWT({ accountId, email })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(Buffer.from(SESSION_SECRET));
}

test('platform magic-link requests stay neutral, create no token, and retain ordinary rate-limit behavior', { timeout: 120_000 }, async (t) => {
  const fixture = await startAuthFixture(t, {
    accounts: { [PLATFORM_ACCOUNT_ID]: platformAccount() },
  });
  if (!fixture) return;

  const magicBytesBefore = fs.readFileSync(fixture.files.magicLinks);
  const canonical = await postJson(`${fixture.baseUrl}/auth/magic-link`, {
    email: '  Platform@Auxilo.io  ',
  });
  assert.equal(canonical.status, 200);
  assert.deepEqual(canonical.body, NEUTRAL_MAGIC_RESPONSE);
  assert.deepEqual(fs.readFileSync(fixture.files.magicLinks), magicBytesBefore);

  const alias = await postJson(`${fixture.baseUrl}/auth/magic-link`, {
    email: `  ${PLATFORM_ALIAS.toUpperCase()}  `,
  });
  assert.equal(alias.status, 200);
  assert.equal(alias.text, canonical.text, 'registered aliases must keep the exact neutral wire response');
  assert.deepEqual(fs.readFileSync(fixture.files.magicLinks), magicBytesBefore);

  const ordinary = await postJson(`${fixture.baseUrl}/auth/magic-link`, {
    email: ORDINARY_EMAIL,
  });
  assert.equal(ordinary.status, 200);
  assert.equal(ordinary.text, canonical.text, 'ordinary and platform requests must be indistinguishable');

  const canonicalSuccesses = [canonical];
  const ordinarySuccesses = [ordinary];
  for (let request = 2; request <= 5; request += 1) {
    canonicalSuccesses.push(await postJson(`${fixture.baseUrl}/auth/magic-link`, { email: PLATFORM_EMAIL }));
    ordinarySuccesses.push(await postJson(`${fixture.baseUrl}/auth/magic-link`, { email: ORDINARY_EMAIL }));
  }
  for (const response of [...canonicalSuccesses, ...ordinarySuccesses]) {
    assert.equal(response.status, 200);
    assert.equal(response.text, canonical.text);
  }

  const platformLimited = await postJson(`${fixture.baseUrl}/auth/magic-link`, { email: PLATFORM_EMAIL });
  const ordinaryLimited = await postJson(`${fixture.baseUrl}/auth/magic-link`, { email: ORDINARY_EMAIL });
  assert.equal(platformLimited.status, 429);
  assert.equal(ordinaryLimited.status, 429);
  assert.equal(platformLimited.text, ordinaryLimited.text, 'rate limiting must not disclose platform identity');

  const links = readJson(fixture.files.magicLinks);
  assert.equal(Object.keys(links).length, 5, 'only the five permitted ordinary requests persist tokens');
  assert.ok(Object.values(links).every((entry) => entry.email === ORDINARY_EMAIL));
  const outputLines = fixture.getOutput().split('\n');
  const platformDeliveries = outputLines.filter((line) =>
    /Magic link for (platform@auxilo\.io|platform-identity-alias@example\.test)/i.test(line));
  assert.equal(platformDeliveries.length, 6, 'platform requests traverse the same delivery path');
  assert.ok(platformDeliveries.every((line) => !line.includes('?token=')),
    'platform delivery carries no redeemable token');
});

test('preexisting platform magic links are consumed with the generic invalid-token response and no account creation', { timeout: 180_000 }, async (t) => {
  const canonicalToken = crypto.randomBytes(32).toString('base64url');
  const preMigration = await startAuthFixture(t, {
    accounts: {},
    magicLinks: {
      [sha256(canonicalToken)]: {
        email: PLATFORM_EMAIL,
        expires_at: Date.UTC(2100, 0, 1),
      },
    },
  });
  if (!preMigration) return;

  const accountsBefore = fs.readFileSync(preMigration.files.accounts);
  const unknownToken = crypto.randomBytes(32).toString('base64url');
  const unknown = await fetchJson(`${preMigration.baseUrl}/auth/verify?token=${unknownToken}`);
  assert.equal(unknown.status, 401);
  assert.deepEqual(unknown.body, INVALID_TOKEN_RESPONSE);

  const canonical = await fetchJson(`${preMigration.baseUrl}/auth/verify?token=${canonicalToken}`);
  assert.equal(canonical.status, 401);
  assert.equal(canonical.text, unknown.text, 'a reserved mailbox must look exactly like an invalid token');
  assert.ok(!('token' in canonical.body));
  assert.deepEqual(readJson(preMigration.files.magicLinks), {}, 'refused token remains single-use');
  assert.deepEqual(fs.readFileSync(preMigration.files.accounts), accountsBefore, 'pre-apply refusal must not create an account');
  await preMigration.cleanup();

  const aliasToken = crypto.randomBytes(32).toString('base64url');
  const ordinaryToken = crypto.randomBytes(32).toString('base64url');
  const postMigration = await startAuthFixture(t, {
    accounts: {
      [PLATFORM_ACCOUNT_ID]: platformAccount(),
      [ORDINARY_ACCOUNT_ID]: ordinaryAccount(),
    },
    magicLinks: {
      [sha256(aliasToken)]: {
        email: PLATFORM_ALIAS,
        expires_at: Date.UTC(2100, 0, 1),
      },
      [sha256(ordinaryToken)]: {
        email: ORDINARY_EMAIL,
        expires_at: Date.UTC(2100, 0, 1),
      },
    },
  });
  if (!postMigration) return;

  const aliasedAccountsBefore = fs.readFileSync(postMigration.files.accounts);
  const alias = await fetchJson(`${postMigration.baseUrl}/auth/verify?token=${aliasToken}`);
  assert.equal(alias.status, 401);
  assert.equal(alias.text, unknown.text, 'an account-resolved platform alias must use the same generic response');
  assert.ok(!('token' in alias.body));
  assert.ok(!readJson(postMigration.files.magicLinks)[sha256(aliasToken)], 'aliased token remains single-use');
  assert.deepEqual(fs.readFileSync(postMigration.files.accounts), aliasedAccountsBefore);

  const ordinary = await fetchJson(`${postMigration.baseUrl}/auth/verify?token=${ordinaryToken}`);
  assert.equal(ordinary.status, 200, 'ordinary verification remains enabled');
  assert.equal(typeof ordinary.body.token, 'string');
  const { payload } = await require('jose').jwtVerify(
    ordinary.body.token,
    Buffer.from(SESSION_SECRET),
    { algorithms: ['HS256'] },
  );
  assert.equal(payload.accountId, ORDINARY_ACCOUNT_ID);
  assert.deepEqual(readJson(postMigration.files.magicLinks), {});
  assert.deepEqual(fs.readFileSync(postMigration.files.accounts), aliasedAccountsBefore);
});

test('every reachable API-key issuance path refuses platform accounts before mutation', { timeout: 120_000 }, async (t) => {
  const accountsSource = fs.readFileSync(path.join(ROOT, 'lib', 'accounts.js'), 'utf8');
  const serverSource = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const slice = (source, startMarker, endMarker) => {
    const start = source.indexOf(startMarker);
    const end = source.indexOf(endMarker, start + startMarker.length);
    assert.ok(start !== -1 && end > start, `${startMarker} route markers must remain present`);
    return source.slice(start, end);
  };

  const magicRequest = slice(accountsSource, "app.post('/auth/magic-link'", "app.get('/auth/verify'");
  const requestGuard = magicRequest.indexOf('platformAccountIdForEmail(normalizedEmail)');
  const emailLimit = magicRequest.indexOf("isRateLimited('email'");
  const ipLimit = magicRequest.indexOf("isRateLimited('ip'");
  assert.ok(emailLimit !== -1 && ipLimit > emailLimit && requestGuard > ipLimit);
  assert.ok(requestGuard < magicRequest.indexOf('crypto.randomBytes'));
  assert.ok(magicRequest.indexOf('email_.sendMagicLink') > requestGuard,
    'platform and ordinary requests must share the remote delivery wait');

  const magicVerify = slice(accountsSource, "app.get('/auth/verify'", "app.post('/account/api-keys'");
  const verifyGuard = magicVerify.indexOf('platformAccountIdForEmail(matchedEntry.email)');
  assert.ok(verifyGuard > magicVerify.indexOf('saveMagicLinks(links)'));
  assert.ok(verifyGuard < magicVerify.indexOf('findOrCreateAccount'));

  const directCreate = slice(accountsSource, "app.post('/account/api-keys'", "app.get('/account/dashboard'");
  const directGuard = directCreate.indexOf('PLATFORM_ACCOUNT_IDS.has(accountId)');
  assert.ok(directGuard !== -1 && directGuard < directCreate.indexOf('crypto.randomBytes'));

  const rotate = slice(serverSource, "app.post('/account/api-keys/rotate'", '// ─── Device Code Login Flow');
  const rotateGuard = rotate.indexOf('PLATFORM_ACCOUNT_IDS.has(accountId)');
  assert.ok(rotateGuard !== -1 && rotateGuard < rotate.indexOf('isRotateRateLimited(accountId)'));
  assert.ok(rotateGuard !== -1 && rotateGuard < rotate.indexOf('rotateKeyEntry(account, target)'));

  const authorize = slice(serverSource, "app.post('/auth/device/authorize'", "app.get('/account/credits'");
  const authorizeGuard = authorize.indexOf('PLATFORM_ACCOUNT_IDS.has(payload.accountId)');
  assert.ok(authorizeGuard !== -1 && authorizeGuard < authorize.indexOf('acquireAccountLock(payload.accountId)'));
  assert.ok(authorizeGuard !== -1 && authorizeGuard < authorize.indexOf('crypto.randomBytes'));

  const fixture = await startAuthFixture(t, {
    accounts: {
      [PLATFORM_ACCOUNT_ID]: platformAccount(),
      [ORDINARY_ACCOUNT_ID]: ordinaryAccount(),
    },
  });
  if (!fixture) return;

  const platformJwt = await sessionToken(PLATFORM_ACCOUNT_ID, PLATFORM_ALIAS);
  const ordinaryJwt = await sessionToken(ORDINARY_ACCOUNT_ID, ORDINARY_EMAIL);
  const platformKeysBefore = JSON.stringify(readJson(fixture.files.accounts)[PLATFORM_ACCOUNT_ID].api_keys);
  const platformSessionHeaders = { Authorization: `Bearer ${platformJwt}` };
  const directGeneric = { error: 'Invalid or expired session token' };

  const labeled = await postJson(
    `${fixture.baseUrl}/account/api-keys`,
    { label: 'denied-labeled', scope: 'read' },
    platformSessionHeaders,
  );
  assert.equal(labeled.status, 401);
  assert.deepEqual(labeled.body, directGeneric);
  assert.ok(!('api_key' in labeled.body));

  const legacy = await postJson(
    `${fixture.baseUrl}/account/api-keys`,
    { name: 'denied-legacy', scope: 'read' },
    platformSessionHeaders,
  );
  assert.equal(legacy.status, 401);
  assert.deepEqual(legacy.body, directGeneric);
  assert.ok(!('api_key' in legacy.body));

  const ordinary = await postJson(
    `${fixture.baseUrl}/account/api-keys`,
    { label: 'ordinary-control', scope: 'read' },
    { Authorization: `Bearer ${ordinaryJwt}` },
  );
  assert.equal(ordinary.status, 201);
  assert.match(ordinary.body.api_key, /^axl_/);

  const rotateGeneric = { error: 'Invalid or expired credentials' };
  const sessionRotate = await postJson(
    `${fixture.baseUrl}/account/api-keys/rotate`,
    { label: 'existing-platform' },
    platformSessionHeaders,
  );
  assert.equal(sessionRotate.status, 401);
  assert.deepEqual(sessionRotate.body, rotateGeneric);
  assert.ok(!('api_key' in sessionRotate.body));

  const ordinaryRotate = await postJson(
    `${fixture.baseUrl}/account/api-keys/rotate`,
    { label: 'ordinary-control' },
    { Authorization: `Bearer ${ordinaryJwt}` },
  );
  assert.equal(ordinaryRotate.status, 201, 'ordinary rotation remains enabled');
  assert.match(ordinaryRotate.body.api_key, /^axl_/);

  const keyRotate = await postJson(
    `${fixture.baseUrl}/account/api-keys/rotate`,
    {},
    { 'X-API-Key': RAW_PLATFORM_KEY },
  );
  assert.equal(keyRotate.status, 401);
  assert.deepEqual(keyRotate.body, rotateGeneric);
  assert.ok(!('api_key' in keyRotate.body));

  const device = await postJson(`${fixture.baseUrl}/auth/device`, {
    scope: 'read',
    label: 'denied-device',
  });
  assert.equal(device.status, 200);
  const deviceRefusal = await postJson(`${fixture.baseUrl}/auth/device/authorize`, {
    code: device.body.user_code,
    session_token: platformJwt,
  });
  assert.equal(deviceRefusal.status, 401);
  assert.deepEqual(deviceRefusal.body, directGeneric);

  const status = await fetchJson(
    `${fixture.baseUrl}/auth/device/status?device_code=${encodeURIComponent(device.body.device_code)}`,
  );
  assert.equal(status.status, 200);
  assert.deepEqual(status.body, { status: 'pending' });
  for (const secretField of ['api_key', 'account_id', 'email']) {
    assert.ok(!(secretField in status.body));
  }

  const ordinaryDevice = await postJson(`${fixture.baseUrl}/auth/device`, {
    scope: 'read',
    label: 'ordinary-device-control',
  });
  assert.equal(ordinaryDevice.status, 200);
  const ordinaryAuthorization = await postJson(`${fixture.baseUrl}/auth/device/authorize`, {
    code: ordinaryDevice.body.user_code,
    session_token: ordinaryJwt,
  });
  assert.equal(ordinaryAuthorization.status, 200, 'ordinary device authorization remains enabled');
  assert.deepEqual(ordinaryAuthorization.body, { status: 'authorized' });
  const ordinaryStatus = await fetchJson(
    `${fixture.baseUrl}/auth/device/status?device_code=${encodeURIComponent(ordinaryDevice.body.device_code)}`,
  );
  assert.equal(ordinaryStatus.status, 200);
  assert.equal(ordinaryStatus.body.status, 'authorized');
  assert.match(ordinaryStatus.body.api_key, /^axl_/);

  const platformKeysAfter = JSON.stringify(readJson(fixture.files.accounts)[PLATFORM_ACCOUNT_ID].api_keys);
  assert.equal(platformKeysAfter, platformKeysBefore, 'platform api_keys must remain byte-identical');
});
