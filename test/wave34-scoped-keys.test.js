'use strict';

/**
 * test/wave34-scoped-keys.test.js — Wave 3.4 (2026-07-19)
 *
 * Covers BUILD-SPEC-WAVE34-2026-07-19 (PUNCH-LIST rows NF-3, NF-4/D2):
 *   D2  — scope taxonomy read < earnings-read < contribute < admin (single-
 *         sourced), grandfather-aware effective_scope enforcement, admin
 *         never issuable via API/device flow, earnings gated at earnings-read,
 *         dualAuthDynamic rank fix (contribute keys can unlock again),
 *         key rotation (capability-preserving) + self-only key rotation/revoke,
 *         device-flow scope selection + 10-key cap + scope echo.
 *   NF-3 — `auxilo init`: zero-prompt scoped-key minting for CI / second
 *         machines; deviceLogin scope/label wire behavior; env-file writer.
 *
 * Style matches the aud19/wave1/wave2b suites: pure-logic tests against libs
 * (fixture-driven, backup/restore of data/accounts.json exactly like
 * test/api-key-validation.test.js) + source-level wiring assertions.
 *
 * Runner: node --test test/wave34-scoped-keys.test.js
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-do-not-use-in-prod';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');

// ─── Env-file isolation (must precede any require of lib/accounts.js) ────────
// The live data/accounts.json is ALSO fixtured (backup/restore) by
// test/api-key-validation.test.js, and node --test runs files as concurrent
// processes — two writers on one path race. This suite gets its own store
// via AUXILO_ACCOUNTS_FILE (same idiom as AUXILO_IDENTITY_FILE in wave2b).
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'auxilo-w34-accounts-'));
const ACCOUNTS_FILE = path.join(TMP_DIR, 'accounts.json');
process.env.AUXILO_ACCOUNTS_FILE = ACCOUNTS_FILE;

const SERVER_SRC = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf-8');
const ACCOUNTS_SRC = fs.readFileSync(path.join(ROOT, 'lib', 'accounts.js'), 'utf-8');
const CLI_SRC = fs.readFileSync(path.join(ROOT, 'bin', 'auxilo-cli.js'), 'utf-8');
const MCP_SRC = fs.readFileSync(path.join(ROOT, 'mcp-server.js'), 'utf-8');

function slice(startMarker, endMarker, src = SERVER_SRC) {
  const start = src.indexOf(startMarker);
  assert.ok(start !== -1, `marker not found: ${startMarker}`);
  const end = endMarker ? src.indexOf(endMarker, start) : start + 20000;
  assert.ok(end !== -1, `end marker not found: ${endMarker}`);
  return src.slice(start, end);
}

// ─── Fixture (backup/restore pattern from test/api-key-validation.test.js) ───

function rawKeyFor(seed) {
  return 'axl_w34_' + crypto.createHash('sha256').update(seed).digest('hex').slice(0, 32);
}
function hashOf(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

const RAW = {
  legacyRead: rawKeyFor('legacy-read'),
  legacyUnscoped: rawKeyFor('legacy-unscoped'),
  legacyContribute: rawKeyFor('legacy-contribute'),
  legacyAdmin: rawKeyFor('legacy-admin'),
  v2Read: rawKeyFor('v2-read'),
  v2Earnings: rawKeyFor('v2-earnings'),
  v2Contribute: rawKeyFor('v2-contribute'),
  suspended: rawKeyFor('suspended'),
};

function buildFixture() {
  const accounts = {
    acc_w34: {
      email: 'w34@example.com',
      created_at: Date.now(),
      api_keys: [
        { id: 'key_lr', hash: hashOf(RAW.legacyRead), label: 'legacy-read', scope: 'read', active: true, created_at: Date.now() },
        { id: 'key_lu', hash: hashOf(RAW.legacyUnscoped), label: 'legacy-unscoped', active: true, created_at: Date.now() },
        { id: 'key_lc', hash: hashOf(RAW.legacyContribute), label: 'legacy-contribute', scope: 'contribute', active: true, created_at: Date.now() },
        { id: 'key_la', hash: hashOf(RAW.legacyAdmin), label: 'legacy-admin', scope: 'admin', active: true, created_at: Date.now() },
        { id: 'key_2r', hash: hashOf(RAW.v2Read), label: 'v2-read', scope: 'read', scope_version: 2, active: true, created_at: Date.now() },
        { id: 'key_2e', hash: hashOf(RAW.v2Earnings), label: 'v2-earnings', scope: 'earnings-read', scope_version: 2, active: true, created_at: Date.now() },
        { id: 'key_2c', hash: hashOf(RAW.v2Contribute), label: 'v2-contribute', scope: 'contribute', scope_version: 2, active: true, created_at: Date.now() },
      ],
    },
    acc_w34_susp: {
      email: 'w34-suspended@example.com',
      created_at: Date.now(),
      disabled_at: Date.now(),
      api_keys: [
        { id: 'key_su', hash: hashOf(RAW.suspended), label: 'susp', scope: 'contribute', scope_version: 2, active: true, created_at: Date.now() },
      ],
    },
  };
  fs.mkdirSync(path.dirname(ACCOUNTS_FILE), { recursive: true });
  fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2));
  return accounts;
}

let accountsLib;

before(() => {
  buildFixture(); // writes to the isolated AUXILO_ACCOUNTS_FILE tmp store
  accountsLib = require('../lib/accounts.js');
  accountsLib.rebuildKeyIndex(); // deterministic even if the module was pre-loaded
});

after(() => {
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch { /* best effort */ }
});

/** Minimal Hono-ish context: only c.req.header is consumed by the resolvers. */
function ctx(headers = {}) {
  const h = {};
  for (const [k, v] of Object.entries(headers)) h[k.toLowerCase()] = v;
  return { req: { header: (name) => h[name.toLowerCase()] } };
}

// ─── T1. Scope taxonomy: single-sourced linear ranks ─────────────────────────

describe('T1 SCOPE_RANK taxonomy (D2)', () => {
  it('orders read < earnings-read < contribute < admin', () => {
    const { SCOPE_RANK } = require('../lib/accounts.js');
    assert.ok(SCOPE_RANK.read < SCOPE_RANK['earnings-read']);
    assert.ok(SCOPE_RANK['earnings-read'] < SCOPE_RANK.contribute);
    assert.ok(SCOPE_RANK.contribute < SCOPE_RANK.admin);
  });
  it('hasMinScope: rank semantics, fail-closed on unknown scopes', () => {
    const { hasMinScope } = require('../lib/accounts.js');
    assert.equal(hasMinScope('contribute', 'read'), true);          // higher passes lower
    assert.equal(hasMinScope('contribute', 'earnings-read'), true); // setup key sees earnings
    assert.equal(hasMinScope('earnings-read', 'contribute'), false);
    assert.equal(hasMinScope('read', 'earnings-read'), false);
    assert.equal(hasMinScope('admin', 'contribute'), true);
    assert.equal(hasMinScope('bogus', 'read'), false);
    assert.equal(hasMinScope(undefined, 'read'), false);
  });
  it('server.js does NOT re-declare SCOPE_RANK (single source in lib/accounts.js)', () => {
    assert.ok(!/const SCOPE_RANK\s*=/.test(SERVER_SRC), 'server.js must import, not re-declare, SCOPE_RANK');
    assert.ok(!/function hasMinScope\(/.test(SERVER_SRC), 'server.js must import, not re-declare, hasMinScope');
    assert.match(SERVER_SRC, /hasMinScope,/, 'server.js must import hasMinScope from lib/accounts.js');
  });
});

// ─── T2. effectiveScopeForKeyEntry (grandfather mapping) ─────────────────────

describe('T2 effectiveScopeForKeyEntry', () => {
  it('legacy read → earnings-read (their exact pre-D2 capability set)', () => {
    const { effectiveScopeForKeyEntry } = require('../lib/accounts.js');
    assert.equal(effectiveScopeForKeyEntry({ scope: 'read' }), 'earnings-read');
  });
  it('legacy unscoped → earnings-read (fail-closed read, then grandfathered)', () => {
    const { effectiveScopeForKeyEntry } = require('../lib/accounts.js');
    assert.equal(effectiveScopeForKeyEntry({}), 'earnings-read');
  });
  it('legacy contribute/admin → themselves (identical reachable set)', () => {
    const { effectiveScopeForKeyEntry } = require('../lib/accounts.js');
    assert.equal(effectiveScopeForKeyEntry({ scope: 'contribute' }), 'contribute');
    assert.equal(effectiveScopeForKeyEntry({ scope: 'admin' }), 'admin');
  });
  it('v2 keys are strict: no promotion for v2 read', () => {
    const { effectiveScopeForKeyEntry } = require('../lib/accounts.js');
    assert.equal(effectiveScopeForKeyEntry({ scope: 'read', scope_version: 2 }), 'read');
    assert.equal(effectiveScopeForKeyEntry({ scope: 'earnings-read', scope_version: 2 }), 'earnings-read');
  });
});

// ─── T3. validateApiKey carries effective scope + grandfather metadata ───────

describe('T3 validateApiKey effective_scope', () => {
  it('legacy read key: stored scope preserved, effective promoted, flagged grandfathered', () => {
    const r = accountsLib.validateApiKey(RAW.legacyRead);
    assert.equal(r.valid, true);
    assert.equal(r.scope, 'read');                    // display/compat unchanged
    assert.equal(r.effective_scope, 'earnings-read'); // enforcement
    assert.equal(r.grandfathered, true);
  });
  it('legacy unscoped key: read/earnings-read/grandfathered', () => {
    const r = accountsLib.validateApiKey(RAW.legacyUnscoped);
    assert.equal(r.valid, true);
    assert.equal(r.scope, 'read');
    assert.equal(r.effective_scope, 'earnings-read');
    assert.equal(r.grandfathered, true);
  });
  it('v2 read key: NOT promoted', () => {
    const r = accountsLib.validateApiKey(RAW.v2Read);
    assert.equal(r.valid, true);
    assert.equal(r.effective_scope, 'read');
    assert.equal(r.grandfathered, false);
  });
  it('legacy contribute + admin: effective == stored', () => {
    assert.equal(accountsLib.validateApiKey(RAW.legacyContribute).effective_scope, 'contribute');
    assert.equal(accountsLib.validateApiKey(RAW.legacyAdmin).effective_scope, 'admin');
  });
});

// ─── T4. resolveAccountAndKeyFromRequest enforcement ─────────────────────────

describe('T4 resolveAccountAndKeyFromRequest', () => {
  it('v2 read key is refused at earnings-read (403) — the D2 tightening', async () => {
    const r = await accountsLib.resolveAccountAndKeyFromRequest(ctx({ 'X-API-Key': RAW.v2Read }), 'earnings-read');
    assert.equal(r.status, 403);
    assert.match(r.error, /insufficient/);
  });
  it('v2 earnings-read key passes earnings-read and reports its hash', async () => {
    const r = await accountsLib.resolveAccountAndKeyFromRequest(ctx({ 'X-API-Key': RAW.v2Earnings }), 'earnings-read');
    assert.equal(r.accountId, 'acc_w34');
    assert.equal(r.viaSession, false);
    assert.equal(r.keyHash, hashOf(RAW.v2Earnings));
    assert.equal(r.keyScope, 'earnings-read');
  });
  it('contribute key passes earnings-read (contribute ⊃ earnings-read — setup key keeps working)', async () => {
    const r = await accountsLib.resolveAccountAndKeyFromRequest(ctx({ 'X-API-Key': RAW.v2Contribute }), 'earnings-read');
    assert.equal(r.accountId, 'acc_w34');
  });
  it('LEGACY read key still passes earnings-read (grandfathered — existing keys keep working)', async () => {
    const r = await accountsLib.resolveAccountAndKeyFromRequest(ctx({ 'X-API-Key': RAW.legacyRead }), 'earnings-read');
    assert.equal(r.accountId, 'acc_w34');
    assert.equal(r.keyScope, 'earnings-read');
  });
  it('earnings-read key cannot reach contribute routes', async () => {
    const r = await accountsLib.resolveAccountAndKeyFromRequest(ctx({ 'X-API-Key': RAW.v2Earnings }), 'contribute');
    assert.equal(r.status, 403);
  });
  it('v2 read key still passes plain read', async () => {
    const r = await accountsLib.resolveAccountAndKeyFromRequest(ctx({ 'X-API-Key': RAW.v2Read }), 'read');
    assert.equal(r.accountId, 'acc_w34');
  });
  it('suspended account is refused regardless of scope', async () => {
    const r = await accountsLib.resolveAccountAndKeyFromRequest(ctx({ 'X-API-Key': RAW.suspended }), 'read');
    assert.equal(r.status, 403);
    assert.match(r.error, /suspended/i);
  });
  it('session JWT: viaSession=true, no keyHash, passes any scope', async () => {
    const { SignJWT } = require('jose');
    const jwt = await new SignJWT({ accountId: 'acc_w34', email: 'w34@example.com' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(Buffer.from(process.env.SESSION_SECRET));
    const r = await accountsLib.resolveAccountAndKeyFromRequest(ctx({ Authorization: `Bearer ${jwt}` }), 'contribute');
    assert.equal(r.accountId, 'acc_w34');
    assert.equal(r.viaSession, true);
    assert.equal(r.keyHash, null);
  });
  it('resolveAccountFromRequest keeps its original shape (delegation)', async () => {
    const r = await accountsLib.resolveAccountFromRequest(ctx({ 'X-API-Key': RAW.v2Contribute }), 'contribute');
    assert.deepEqual(Object.keys(r), ['accountId']);
    assert.equal(r.accountId, 'acc_w34');
  });
  it('requireSessionOrApiKey middleware ranks on effective_scope (source)', () => {
    const mw = slice('function requireSessionOrApiKey', 'async function resolveAccountFromRequest', ACCOUNTS_SRC);
    assert.match(mw, /effective_scope/, 'middleware must rank the grandfather-aware effective scope');
  });
});

// ─── T5. Key rotation (capability-preserving, never escalating) ──────────────

describe('T5 rotateKeyEntry', () => {
  it('rotating a grandfathered read key mints an explicit v2 earnings-read key (same powers)', () => {
    const { rotateKeyEntry } = require('../lib/accounts.js');
    const account = { api_keys: [{ id: 'key_old', hash: 'h-old', label: 'ci', scope: 'read', active: true }] };
    const target = account.api_keys[0];
    const { rawKey, entry, oldHash } = rotateKeyEntry(account, target);
    assert.match(rawKey, /^axl_/);
    assert.equal(entry.scope, 'earnings-read');   // effective scope preserved — no silent capability loss
    assert.equal(entry.scope_version, 2);
    assert.equal(entry.label, 'ci');
    assert.equal(entry.rotated_from, 'key_old');
    assert.equal(oldHash, 'h-old');
    assert.equal(target.active, false);
    assert.ok(target.rotated_at, 'old key stamped rotated_at');
    assert.equal(account.api_keys.length, 2);
  });
  it('rotating a v2 contribute key stays contribute (never escalates)', () => {
    const { rotateKeyEntry } = require('../lib/accounts.js');
    const account = { api_keys: [{ id: 'k', hash: 'h', label: 'x', scope: 'contribute', scope_version: 2, active: true }] };
    const { entry } = rotateKeyEntry(account, account.api_keys[0]);
    assert.equal(entry.scope, 'contribute');
  });
  it('end-to-end: rotated key validates, old key stops validating', () => {
    const accounts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf-8'));
    const account = accounts.acc_w34;
    const target = account.api_keys.find((k) => k.id === 'key_lc');
    const { rawKey, entry, oldHash } = accountsLib.rotateKeyEntry(account, target);
    fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2));
    accountsLib.rebuildKeyIndex();
    const rNew = accountsLib.validateApiKey(rawKey);
    assert.equal(rNew.valid, true);
    assert.equal(rNew.effective_scope, 'contribute');
    assert.equal(rNew.grandfathered, false);
    const rOld = accountsLib.validateApiKey(RAW.legacyContribute);
    assert.equal(rOld.valid, false, 'rotated-out key must stop validating');
    assert.equal(entry.hash !== oldHash, true);
    // restore fixture for any later assertions
    buildFixture();
    accountsLib.rebuildKeyIndex();
  });
});

// ─── T6. Creation paths: admin never issuable, v2 stamped ────────────────────

describe('T6 POST /account/api-keys (source, lib/accounts.js)', () => {
  const creation = slice("app.post('/account/api-keys'", "app.get('/account/dashboard'", ACCOUNTS_SRC);
  it('labeled path: admin refused explicitly, earnings-read accepted, default contribute', () => {
    assert.match(creation, /ADMIN_SCOPE_NOT_ISSUABLE/);
    assert.match(creation, /LABELED_SCOPES = \['read', 'earnings-read', 'contribute'\]/);
    assert.match(creation, /: 'contribute';/, 'labeled default must remain contribute (setup-compatible least privilege)');
  });
  it('legacy path: admin refused, earnings-read accepted with axl_e_ prefix', () => {
    assert.match(creation, /VALID_SCOPES = \['read', 'earnings-read', 'contribute'\]/);
    assert.match(creation, /'earnings-read': 'axl_e_'/);
    const adminRefusals = creation.match(/ADMIN_SCOPE_NOT_ISSUABLE/g) || [];
    assert.ok(adminRefusals.length >= 2, 'BOTH creation paths must refuse admin');
  });
  it('both paths stamp scope_version 2 (strict, non-grandfathered semantics)', () => {
    const stamps = creation.match(/scope_version: 2/g) || [];
    assert.ok(stamps.length >= 2, 'labeled AND legacy entries must be v2-stamped');
  });
  it('dashboard display matches enforcement (no || \'admin\' fallback anywhere)', () => {
    assert.ok(!ACCOUNTS_SRC.includes("k.scope || 'admin'"), 'lib/accounts.js display fallback must be read, not admin');
    assert.ok(!SERVER_SRC.includes("k.scope || 'admin'"), 'server.js display fallback must be read, not admin');
  });
});

// ─── T7. NF-3 client plumbing: deviceLogin wire shape + env-file writer ──────

describe('T7 installer deviceLogin (scope/label) + writeEnvFile', () => {
  const installer = require('../lib/installer.js');

  function fakeServer({ echoScope } = {}) {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      if (String(url).endsWith('/auth/device')) {
        return { ok: true, json: async () => ({ user_code: 'ABCD1234', device_code: 'dev_secret', verification_url: 'https://x/verify', interval: 0 }) };
      }
      return {
        ok: true,
        json: async () => ({
          status: 'authorized', api_key: 'axl_c_test', account_id: 'acc_x', email: 'x@y.z',
          ...(echoScope ? { scope: echoScope, label: 'lbl' } : {}),
        }),
      };
    };
    return { calls, fetchImpl };
  }

  it('NO body when scope/label omitted (exact pre-3.4 wire shape)', async () => {
    const { calls, fetchImpl } = fakeServer({});
    await installer.deviceLogin({ baseUrl: 'https://x', fetchImpl, sleep: async () => {}, maxWaitMs: 1000 });
    assert.equal(calls[0].init.body, undefined);
  });
  it('body carries scope+label when requested; echoed scope surfaced to the caller', async () => {
    const { calls, fetchImpl } = fakeServer({ echoScope: 'read' });
    const r = await installer.deviceLogin({ baseUrl: 'https://x', scope: 'read', label: 'ci-1', fetchImpl, sleep: async () => {}, maxWaitMs: 1000 });
    const body = JSON.parse(calls[0].init.body);
    assert.deepEqual(body, { scope: 'read', label: 'ci-1' });
    assert.equal(r.scope, 'read');
    assert.equal(r.label, 'lbl');
  });
  it('pre-3.4 server: no echo → scope undefined (caller warns, never mislabels)', async () => {
    const { fetchImpl } = fakeServer({});
    const r = await installer.deviceLogin({ baseUrl: 'https://x', scope: 'read', fetchImpl, sleep: async () => {}, maxWaitMs: 1000 });
    assert.equal(r.scope, undefined);
  });

  it('writeEnvFile: creates 0600, updates in place (no duplicates), preserves other lines', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'auxilo-w34-'));
    const envPath = path.join(tmp, '.env');
    try {
      fs.writeFileSync(envPath, 'OTHER=1\nexport AUXILO_API_KEY=old\n');
      const w1 = installer.writeEnvFile(envPath, { api_key: 'axl_new', base_url: 'https://auxilo.io' });
      assert.equal(w1.created, false);
      const c1 = fs.readFileSync(envPath, 'utf-8');
      assert.match(c1, /^OTHER=1$/m, 'unrelated lines preserved');
      assert.match(c1, /^export AUXILO_API_KEY=axl_new$/m, 'export prefix preserved on replace');
      assert.equal((c1.match(/AUXILO_API_KEY=/g) || []).length, 1, 'no duplicate key lines');
      assert.match(c1, /^AUXILO_BASE_URL=https:\/\/auxilo\.io$/m);
      // idempotent second write
      installer.writeEnvFile(envPath, { api_key: 'axl_new2', base_url: 'https://auxilo.io' });
      const c2 = fs.readFileSync(envPath, 'utf-8');
      assert.equal((c2.match(/AUXILO_API_KEY=/g) || []).length, 1);
      assert.equal((c2.match(/AUXILO_BASE_URL=/g) || []).length, 1);
      assert.match(c2, /axl_new2/);
      const mode = fs.statSync(envPath).mode & 0o777;
      assert.equal(mode, 0o600, 'env file must be 0600');
      // fresh create
      const w2 = installer.writeEnvFile(path.join(tmp, 'fresh.env'), { api_key: 'axl_f' });
      assert.equal(w2.created, true);
      assert.equal(fs.statSync(w2.path).mode & 0o777, 0o600);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ─── T8–T12. Server wiring (source-level) ────────────────────────────────────

describe('T8 /account/earnings gated at earnings-read', () => {
  it('route uses requireSessionOrApiKey(\'earnings-read\')', () => {
    assert.match(SERVER_SRC, /app\.get\('\/account\/earnings', requireSessionOrApiKey\('earnings-read'\)/);
  });
});

describe('T9 dualAuthDynamic rank check (the unlock fix)', () => {
  const dual = slice('async function dualAuthDynamic', 'AU-8: Per-API-Key Rate Limiter');
  it('uses hasMinScope on effective_scope', () => {
    assert.match(dual, /hasMinScope\(result\.effective_scope \|\| result\.scope, requiredScope\)/);
  });
  it('the higher-privilege-refusing exact-match is gone', () => {
    assert.ok(!dual.includes("result.scope !== 'admin' && result.scope !== requiredScope"),
      'exact-match scope check must be replaced by the rank check');
  });
});

// ─── T9b. dualAuthDynamic BEHAVIORAL (Gate-A F1) ─────────────────────────────
//
// Gate-A on 2e0c39f found the headline fix had zero behavioral coverage:
// mutation M3 (dropping the `!` off `!hasMinScope(...)` at the scope gate)
// passed the whole suite because T9 above is regex-only. These tests EXECUTE
// the real dualAuthDynamic source extracted from server.js — the exact bytes
// that ship — with the REAL validateApiKey + hasMinScope (fixture-backed) and
// stubs only for the money/payment collaborators the scope gate hands off to.
// M3 inverts the gate's polarity, so the sufficient-key case below fails
// under the mutation (sufficient keys would 403) and kills it.

describe('T9b dualAuthDynamic behavioral (kills mutation M3)', () => {
  // Extract the function verbatim: from its declaration to the first
  // column-0 closing brace (the body is fully indented).
  const start = SERVER_SRC.indexOf('async function dualAuthDynamic');
  assert.ok(start !== -1, 'dualAuthDynamic not found in server.js');
  const end = SERVER_SRC.indexOf('\n}', start);
  assert.ok(end !== -1, 'dualAuthDynamic end brace not found');
  const fnSrc = SERVER_SRC.slice(start, end + 2);

  function buildHarness({ creditsExhausted = false } = {}) {
    const lib = require('../lib/accounts.js');
    const calls = { deductCredit: [], verify: 0 };
    const factory = new Function(
      'paymentsEnabled', 'paymentsDisabledBody', 'validateApiKey', 'hasMinScope',
      'loadAccounts', 'saveAccounts', 'deductCredit', 'x402Router',
      '_routerAccepts', '_custodialAccepts', 'verifyPaymentOrReject',
      fnSrc + '\nreturn dualAuthDynamic;'
    );
    const dualAuthDynamic = factory(
      /* paymentsEnabled */      () => true,
      /* paymentsDisabledBody */ () => ({ error: 'PAYMENTS_DISABLED' }),
      /* validateApiKey */       lib.validateApiKey,   // REAL, fixture-backed
      /* hasMinScope */          lib.hasMinScope,      // REAL
      /* loadAccounts */         () => ({}),           // last_used_at update no-ops
      /* saveAccounts */         () => {},
      /* deductCredit */         async (accountId, creditType) => {
        calls.deductCredit.push({ accountId, creditType });
        return creditsExhausted
          ? { success: false, message: 'no credits', status: { remaining: 0, period_end: 0 } }
          : { success: true, unit_price_usd: 0.08 };
      },
      /* x402Router */           { routerEnabled: () => false },
      /* _routerAccepts */       () => ({ stub: 'router' }),
      /* _custodialAccepts */    () => ({ stub: 'custodial' }),
      /* verifyPaymentOrReject */ async () => { calls.verify++; return { __resp: true, status: 402, body: { via: 'verifyPaymentOrReject' } }; }
    );
    return { dualAuthDynamic, calls };
  }

  function mkCtx(headers = {}) {
    const h = {};
    for (const [k, v] of Object.entries(headers)) h[k.toLowerCase()] = v;
    const store = {};
    return {
      req: { header: (n) => h[n.toLowerCase()], url: 'http://localhost/knowledge/l_test' },
      set: (k, v) => { store[k] = v; },
      header: () => {},
      json: (body, status) => ({ __resp: true, status: status || 200, body }),
      _store: store,
    };
  }

  it('KILLS M3: contribute key at the unlock gate (requiredScope read) is NOT scope-403d — it proceeds to the credit gate and returns null (payment OK)', async () => {
    const { dualAuthDynamic, calls } = buildHarness();
    const c = mkCtx({ 'X-API-Key': RAW.v2Contribute });
    const rejection = await dualAuthDynamic(c, 0.08, 'unlock test', 'unlock', 'read');
    assert.equal(rejection, null, `sufficient key must pass the scope gate (got ${JSON.stringify(rejection)})`);
    assert.equal(calls.deductCredit.length, 1, 'must reach the NEXT gate (credits)');
    assert.equal(calls.deductCredit[0].accountId, 'acc_w34');
    assert.equal(c._store.accountId, 'acc_w34');
    assert.equal(c._store.authMethod, 'api_key');
  });

  it('contribute key with exhausted credits gets 402 (the x402 fallback), never the scope 403', async () => {
    const { dualAuthDynamic } = buildHarness({ creditsExhausted: true });
    const c = mkCtx({ 'X-API-Key': RAW.v2Contribute });
    const rejection = await dualAuthDynamic(c, 0.08, 'unlock test', 'unlock', 'read');
    assert.equal(rejection.status, 402, 'exhausted credits must 402, proving the scope gate was passed');
    assert.notEqual(rejection.body.error, 'API key scope insufficient');
    assert.equal(rejection.body.error, 'Credits exhausted');
  });

  it('grandfathered legacy read key still unlocks (pre-D2 parity through the real gate)', async () => {
    const { dualAuthDynamic } = buildHarness();
    const c = mkCtx({ 'X-API-Key': RAW.legacyRead });
    const rejection = await dualAuthDynamic(c, 0.08, 'unlock test', 'unlock', 'read');
    assert.equal(rejection, null);
  });

  it('INVERSE: an insufficient-rank key (v2 read at a contribute-required gate) DOES 403 scope-insufficient', async () => {
    const { dualAuthDynamic, calls } = buildHarness();
    const c = mkCtx({ 'X-API-Key': RAW.v2Read });
    const rejection = await dualAuthDynamic(c, 0.08, 'contribute-gated test', 'unlock', 'contribute');
    assert.equal(rejection.status, 403);
    assert.equal(rejection.body.error, 'API key scope insufficient');
    assert.equal(rejection.body.required, 'contribute');
    assert.equal(rejection.body.actual, 'read');
    assert.equal(calls.deductCredit.length, 0, 'insufficient key must never reach the credit gate');
  });

  it('admin key passes any requiredScope; invalid key 401s (path-1 sanity)', async () => {
    const { dualAuthDynamic } = buildHarness();
    const ok = await dualAuthDynamic(mkCtx({ 'X-API-Key': RAW.legacyAdmin }), 0.08, 'x', 'unlock', 'contribute');
    assert.equal(ok, null);
    const bad = await dualAuthDynamic(mkCtx({ 'X-API-Key': 'axl_not_a_real_key_1234567890' }), 0.08, 'x', 'unlock', 'read');
    assert.equal(bad.status, 401);
  });
});

describe('T10 /learn scope check normalized', () => {
  it('uses hasMinScope(effective_scope, contribute)', () => {
    assert.match(SERVER_SRC, /hasMinScope\(keyResult\.effective_scope \|\| keyResult\.scope, 'contribute'\)/);
  });
});

describe('T11 key management routes', () => {
  it('GET /account/api-keys is session-or-key at read', () => {
    assert.match(SERVER_SRC, /app\.get\('\/account\/api-keys', requireSessionOrApiKey\('read'\)/);
  });
  it('DELETE enforces self-revoke for key callers', () => {
    const del = slice("app.delete('/account/api-keys/:label'", "app.post('/account/api-keys/rotate'");
    assert.match(del, /resolveAccountAndKeyFromRequest/);
    assert.match(del, /KEY_SELF_REVOKE_ONLY/);
    assert.match(del, /Cannot delete last active key/);
  });
  it('rotate route exists: account-locked, self-only for key callers, raw key once', () => {
    const rot = slice("app.post('/account/api-keys/rotate'", '// ─── Device Code Login Flow');
    assert.match(rot, /resolveAccountAndKeyFromRequest/);
    assert.match(rot, /acquireAccountLock/);
    assert.match(rot, /KEY_SELF_ROTATE_ONLY/);
    assert.match(rot, /rotateKeyEntry/);
    assert.match(rot, /removeFromKeyIndex/);
    assert.match(rot, /addToKeyIndex/);
    assert.match(rot, /not be shown again/);
  });
  it('rotate/revoke take ONLY the account lock (lock-order rule: no earnings/learnings locks)', () => {
    const both = slice("app.delete('/account/api-keys/:label'", '// ─── Device Code Login Flow');
    assert.ok(!both.includes('acquireEarningsLock') && !both.includes('acquireLearningsLock'),
      'key management must not touch earnings/learnings locks');
  });
});

describe('T12 device flow scope selection (D2/NF-3)', () => {
  const devicePost = slice("app.post('/auth/device'", "app.get('/auth/device/status'");
  const authorize = slice("app.post('/auth/device/authorize'", "app.get('/account/credits'");
  const status = slice("app.get('/auth/device/status'", "app.get('/auth/device/verify'");
  it('POST /auth/device validates scope, refuses admin, defaults contribute', () => {
    assert.match(devicePost, /ADMIN_SCOPE_NOT_ISSUABLE/);
    assert.match(devicePost, /\['read', 'earnings-read', 'contribute'\]/);
    assert.match(devicePost, /requestedScope = 'contribute'/);
    assert.match(devicePost, /requested_scope/);
  });
  it('authorize enforces the 10-key cap (was uncapped) and mints the requested scope, v2-stamped', () => {
    assert.match(authorize, /Maximum 10 API keys/);
    assert.match(authorize, /entry\.requested_scope \|\| 'contribute'/);
    assert.match(authorize, /scope_version: 2/);
  });
  it('authorize auto-suffixes label collisions; status echoes minted scope+label', () => {
    assert.match(authorize, /Device Login Key/);
    assert.match(authorize, /\$\{baseLabel\}-\$\{n\}/);
    assert.match(status, /scope: grantedScope/);
    assert.match(status, /label: grantedLabel/);
  });
});

// ─── T13. CLI: init command (zero-prompt) + delegation ───────────────────────

describe('T13 auxilo init CLI', () => {
  it('init is a registered command with scoped flags', () => {
    assert.match(CLI_SRC, /case 'init': return cmdInit\(flags\);/);
    assert.match(CLI_SRC, /INIT_SCOPES = \['read', 'earnings-read', 'contribute'\]/);
  });
  it('cmdInit never prompts (piped-stdin safe by construction — LW-17 class)', () => {
    const initSrc = slice('async function cmdInit', '// ─── auxilo status', CLI_SRC);
    assert.ok(!initSrc.includes('await ask('), 'init must not open the readline');
    assert.ok(!initSrc.includes('askYesNo('), 'init must not prompt');
  });
  it('cmdInit passes scope+label to deviceLogin and warns on server downgrade', () => {
    const initSrc = slice('async function cmdInit', '// ─── auxilo status', CLI_SRC);
    assert.match(initSrc, /deviceLogin\(\{\s*baseUrl,\s*scope,\s*label,/);
    assert.match(initSrc, /grantedScope !== scope/);
    assert.match(initSrc, /writeEnvFile/);
    assert.ok(!initSrc.includes('writeCredentials(HOME') || /flags\.save/.test(initSrc),
      'credentials.json only under --save');
  });
  it('mcp-server delegation includes init (npx auxilo-mcp init works)', () => {
    assert.match(MCP_SRC, /\['setup', 'init', 'status', 'review', 'disable'\]/);
  });
});

// ─── T14. Unchanged minScopes hold (regression pins for the audit table) ─────

describe('T14 route→scope pins (BUILD-SPEC-WAVE34 §3)', () => {
  it('link-wallet stays contribute (default), accept-terms contribute, consent contribute', () => {
    assert.match(SERVER_SRC, /app\.post\('\/account\/link-wallet', requireSessionOrApiKey\(\)/);
    assert.match(SERVER_SRC, /app\.post\('\/account\/accept-terms', requireSessionOrApiKey\('contribute'\)/);
    assert.match(SERVER_SRC, /app\.post\('\/extract\/consent', requireSessionOrApiKey\('contribute'\)/);
  });
  it('terms-status/settings/rate stay read', () => {
    assert.match(SERVER_SRC, /app\.get\('\/account\/terms-status', requireSessionOrApiKey\('read'\)/);
    assert.match(SERVER_SRC, /app\.get\('\/account\/settings', requireSessionOrApiKey\('read'\)/);
    assert.match(SERVER_SRC, /app\.post\('\/knowledge\/:id\/rate', requireSessionOrApiKey\('read'\)/);
  });
  it('self-review: listing read, decisions contribute', () => {
    assert.match(SERVER_SRC, /resolveSelfReviewAccount\(c, 'read'\)/);
    assert.match(SERVER_SRC, /resolveSelfReviewAccount\(c, 'contribute'\)/);
  });
  it('extract + retract keep the contribute floor on effective scope', () => {
    const matches = SERVER_SRC.match(/hasMinScope\(keyResult\.effective_scope \|\| keyResult\.scope, 'contribute'\)/g) || [];
    assert.ok(matches.length >= 3, '/learn, /extract and DELETE /learn/:id must all rank-check at contribute');
  });
  it('money paths remain session-only (untouched per constraints)', () => {
    assert.match(SERVER_SRC, /app\.post\('\/withdraw\/stripe', requireAuth/);
    assert.match(SERVER_SRC, /app\.post\('\/checkout\/session', requireAuth/);
    assert.match(SERVER_SRC, /app\.post\('\/account\/connect-stripe', requireAuth/);
    assert.match(SERVER_SRC, /app\.get\('\/account\/purchases', requireAuth/);
    assert.match(SERVER_SRC, /app\.get\('\/account\/credits', requireAuth/);
  });
});
