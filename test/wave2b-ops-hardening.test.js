'use strict';

/**
 * test/wave2b-ops-hardening.test.js — Wave 2b (2026-07-19)
 *
 * Covers BUILD-SPEC-WAVE2B-2026-07-19 (PUNCH-LIST rows):
 *   1. H-3 — OFAC list-refresh failures page via sendOpsAlert (category 'ofac').
 *   2. RUNBOOK §9 — learnings.json store-level write mutex + lock-order rule
 *      (account → earnings → learnings, learnings innermost).
 *   3. RUNBOOK §5 — PAYMENTS_ENABLED global money-movement kill switch.
 *   4. CP-2 — identity/W-9 capture at wallet-link, CODE-DARK (flag off = zero
 *      behavior change), AES-256-GCM encrypted-at-rest separate store.
 *   5. CAT-1 task-#13 — /pricing/categories + pricing-insights visibility
 *      filter; unlock-counter gating (countersCredited) + ops-only
 *      unlocks_total.
 *   6. Wave-1 review carry-ins — F1 discovery-cache restore on refund,
 *      F2 un-arm-before-refund ordering, F4 purchase-ledger write mutex.
 *   7. SPEC3 B4 — retraction null-consent 500 fix + approval-time window basis.
 *
 * Style matches the aud19/wave1 suites: pure-logic tests against libs
 * (env-file isolation) + source-level wiring assertions against server.js.
 *
 * Runner: node --test test/wave2b-ops-hardening.test.js
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ─── Env-file isolation (must precede the lib requires) ──────────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'auxilo-wave2b-'));
process.env.AUXILO_IDENTITY_FILE = path.join(TMP, 'identity.json');
process.env.AUXILO_PURCHASE_LEDGER_FILE = path.join(TMP, 'purchase-ledger.json');

const { acquireLearningsLock, getLearningsLockDepth } = require('../lib/learnings-lock.js');
const { paymentsEnabled, paymentsDisabledBody } = require('../lib/payments-switch.js');
const vault = require('../lib/identity-vault.js');
const ledger = require('../lib/purchase-ledger.js');
const consentReader = require('../lib/extraction-consent-reader.js');

const SERVER_SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf-8');

after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ } });

const TEST_KEY = 'a'.repeat(64); // 32 bytes hex — test-only, no real data

function slice(startMarker, endMarker, src = SERVER_SRC) {
  const start = src.indexOf(startMarker);
  assert.ok(start !== -1, `marker not found: ${startMarker}`);
  const end = endMarker ? src.indexOf(endMarker, start) : start + 20000;
  assert.ok(end !== -1, `end marker not found: ${endMarker}`);
  return src.slice(start, end);
}

function unlockHandlerSlice() {
  return slice("app.get('/knowledge/:id'", "app.post('/knowledge/:id/rate'");
}

function linkWalletSlice() {
  const start = SERVER_SRC.indexOf("app.post('/account/link-wallet'");
  assert.ok(start !== -1);
  return SERVER_SRC.slice(start, start + 20000);
}

function retractionSlice() {
  return slice("app.delete('/learn/:id'", "// ── GET /account/settings");
}

// ════════════════════════════════════════════════════════════════════════════
// 1. H-3 — OFAC refresh-failure alerting
// ════════════════════════════════════════════════════════════════════════════

describe('H-3: OFAC list-refresh failures page via ops-alert', () => {
  let refresh, catchBlock;
  // CH-7: computed in before() — a failed slice exits 1, never fail-0/exit-0.
  before(() => {
    refresh = slice('async function refreshOFACList()', 'function checkOFAC(');
    catchBlock = refresh.slice(refresh.indexOf('} catch (err) {'));
  });

  it('the failure catch fires sendOpsAlert in the ofac category, never-throws', () => {
    assert.ok(catchBlock.includes('sendOpsAlert('), 'refresh failures must page');
    assert.ok(catchBlock.includes("{ category: 'ofac' }"), 'ofac category (independent rate-limit window)');
    assert.ok(catchBlock.includes('.catch(() => {})'), 'fire-and-forget — the refresh loop must never throw');
  });

  it('severity escalates with consecutive failures (>24h WARNING, >48h CRITICAL)', () => {
    assert.ok(catchBlock.includes('ofacState.consecutiveFailures >= 2'), 'two-failure escalation arm');
    assert.ok(/stale >24h/.test(catchBlock) && /stale >48h/.test(catchBlock),
      'both staleness tiers named in the alert subject');
  });

  it('the alert distinguishes fail-closed boot state from stale-list operation', () => {
    assert.ok(catchBlock.includes('ofacScreeningReady()'),
      'alert body must branch on screening readiness');
    assert.ok(catchBlock.includes('failing CLOSED'),
      'boot-time failure names the 503 fail-closed state');
    assert.ok(catchBlock.includes("'NEVER (boot-time failure)'"),
      'lastRefresh null is reported as a boot-time failure');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. learnings.json write mutex
// ════════════════════════════════════════════════════════════════════════════

describe('learnings-lock: store-level mutex behavior', () => {
  it('mutual exclusion + FIFO: contenders run strictly in acquisition order', async () => {
    const log = [];
    async function contender(name, delayMs) {
      const release = await acquireLearningsLock();
      try {
        log.push(`${name}:in`);
        await new Promise((r) => setTimeout(r, delayMs));
        log.push(`${name}:out`);
      } finally {
        release();
      }
    }
    await Promise.all([contender('a', 15), contender('b', 5), contender('c', 1)]);
    assert.deepEqual(log, ['a:in', 'a:out', 'b:in', 'b:out', 'c:in', 'c:out'],
      'critical sections never interleave and run FIFO');
  });

  it('depth bookkeeping returns to zero after release (no leak)', async () => {
    const release = await acquireLearningsLock();
    assert.ok(getLearningsLockDepth() >= 1);
    release();
    // Let the chain settle.
    await new Promise((r) => setImmediate(r));
    assert.equal(getLearningsLockDepth(), 0);
  });

  it('module documents the lock-order rule (account → earnings → learnings)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'learnings-lock.js'), 'utf-8');
    assert.ok(src.includes('account-lock  →  earnings-lock  →  learnings-lock'));
    assert.ok(src.includes('INNERMOST'), 'learnings lock declared the leaf lock');
  });
});

describe('learnings-lock: server wiring — every runtime catalog writer holds the lock', () => {
  // Every runtime safeWrite(LEARNINGS_FILE, ...) call site must sit inside an
  // acquire/finally-release. Boot-time writers (startup migration/seed + WAL
  // replay, before the server accepts traffic) are the documented exemption.
  it('unlock handler acquires AFTER settlement and releases in a finally', () => {
    const h = unlockHandlerSlice();
    const auth = h.indexOf('await dualAuthDynamic(');
    const lock = h.indexOf('await acquireLearningsLock()');
    assert.ok(auth !== -1 && lock !== -1 && lock > auth,
      'lock acquired after payment settlement — never across the 180s finality wait');
    assert.ok(h.includes('releaseLearningsLock();'), 'released in finally');
    // All three persist sites in the handler are after the acquisition.
    let idx = h.indexOf('safeWrite(LEARNINGS_FILE');
    while (idx !== -1) {
      assert.ok(idx > lock, 'every catalog persist in the unlock handler sits under the lock');
      idx = h.indexOf('safeWrite(LEARNINGS_FILE', idx + 1);
    }
  });

  it('retraction, /learn, /extract, rate, cron, admin, self-review, adoption, pipeline writers hold the lock', () => {
    for (const [name, s] of [
      ['retraction', retractionSlice()],
      ['rate', slice("app.post('/knowledge/:id/rate'", "app.get('/pricing/categories'")],
      ['pricing-cron', slice('async function runDailyPricingCron', 'const _pricingCronStartup')],
      ['admin-approve', slice("app.post('/admin/moderation/:id/approve'", "app.post('/admin/moderation/:id/reject'")],
      ['admin-reject', slice("app.post('/admin/moderation/:id/reject'", '// ─── LW-15')],
      ['self-approve', slice("app.post('/account/pending/:id/approve'", "app.post('/account/pending/:id/reject'")],
      ['self-reject', slice("app.post('/account/pending/:id/reject'", '// ─── Review-seamless')],
      ['self-bulk', slice("app.post('/account/pending/bulk'", '// ─── S21-3')],
      ['adopt-lazy', slice('async function adoptOrphansForAccount', "app.get('/account/pending'")],
    ]) {
      assert.ok(s.includes('await acquireLearningsLock()'), `${name} must acquire the catalog lock`);
      assert.ok(s.includes('releaseLearningsLock();'), `${name} must release in finally`);
    }
    // /learn + /extract + pipeline: match their wrapped commit blocks.
    assert.equal(SERVER_SRC.split('await acquireLearningsLock()').length - 1 >= 13, true,
      'all mapped writer sites acquire the lock');
  });

  it('lock order: the learnings lock never wraps an earnings/account acquisition', () => {
    // Slice every region between an acquireLearningsLock and its release and
    // assert no earnings/account lock is taken inside.
    let from = 0;
    let regions = 0;
    while (true) {
      const a = SERVER_SRC.indexOf('await acquireLearningsLock()', from);
      if (a === -1) break;
      const r = SERVER_SRC.indexOf('releaseLearningsLock();', a);
      assert.ok(r !== -1, 'every acquisition has a release');
      const held = SERVER_SRC.slice(a, r);
      assert.ok(!held.includes('acquireEarningsLock('),
        'earnings lock must never be acquired while holding the learnings lock');
      assert.ok(!held.includes('acquireAccountLock('),
        'account lock must never be acquired while holding the learnings lock');
      assert.ok(!held.includes('sweepHeldEarnings('),
        'sweepHeldEarnings (takes the earnings lock) must never run under the learnings lock');
      regions++;
      from = a + 1;
    }
    assert.ok(regions >= 13, `expected >=13 locked writer regions, found ${regions}`);
  });

  it('link-wallet adoption acquires in rule order: account lock first, learnings inside', () => {
    const h = linkWalletSlice();
    const acct = h.indexOf('await acquireAccountLock(accountId)');
    const lrn = h.indexOf('await acquireLearningsLock()');
    assert.ok(acct !== -1 && lrn !== -1 && acct < lrn,
      'account → learnings, the documented dual-acquisition order');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3. PAYMENTS_ENABLED kill switch
// ════════════════════════════════════════════════════════════════════════════

describe('payments-switch: flag semantics + body shape', () => {
  const saved = process.env.PAYMENTS_ENABLED;
  after(() => {
    if (saved === undefined) delete process.env.PAYMENTS_ENABLED;
    else process.env.PAYMENTS_ENABLED = saved;
  });

  it('default ON: absent/empty/garbage/true all keep payments enabled', () => {
    delete process.env.PAYMENTS_ENABLED;
    assert.equal(paymentsEnabled(), true, 'absent = enabled (default ON)');
    for (const v of ['true', '1', 'yes', 'on', 'banana', '']) {
      process.env.PAYMENTS_ENABLED = v;
      assert.equal(paymentsEnabled(), true, `'${v}' must not disable payments`);
    }
  });

  it('only explicit off-values disable, case-insensitively', () => {
    for (const v of ['false', 'FALSE', ' False ', '0', 'off', 'OFF', 'no']) {
      process.env.PAYMENTS_ENABLED = v;
      assert.equal(paymentsEnabled(), false, `'${v}' must disable payments`);
    }
  });

  it('503 body is machine-readable and self-healing', () => {
    const body = paymentsDisabledBody();
    assert.equal(body.code, 'PAYMENTS_DISABLED');
    assert.equal(typeof body.retry_after, 'number');
    assert.ok(/search/.test(body.error) && /Retry later/.test(body.error),
      'message names the free surfaces and tells the caller to retry');
    assert.ok(/nothing was charged/i.test(body.error) || /No money moved/i.test(body.error),
      'message states no money moved');
  });
});

describe('payments-switch: server gates (all five money-movement surfaces)', () => {
  it('dualAuthDynamic is gated at the top (credit deduct + x402 settle + 402 minting)', () => {
    const h = slice('async function dualAuthDynamic(', 'const MIN_UNLOCK_PRICE');
    const gate = h.indexOf('if (!paymentsEnabled())');
    const deduct = h.indexOf('await deductCredit(');
    assert.ok(gate !== -1 && deduct !== -1 && gate < deduct,
      'gate must precede the credit deduction');
    assert.ok(gate < h.indexOf('verifyPaymentOrReject(c'),
      'gate must precede any settle/challenge delegation');
  });

  it('checkout session + stripe webhook are gated before side effects', () => {
    const co = slice("app.post('/checkout/session'", "app.post('/webhook/stripe'");
    assert.ok(co.indexOf('if (!paymentsEnabled())') !== -1);
    assert.ok(co.indexOf('if (!paymentsEnabled())') < co.indexOf('createCheckoutSession('));
    const wh = slice("app.post('/webhook/stripe'", "app.get('/account/purchases'");
    const gate = wh.indexOf('if (!paymentsEnabled())');
    assert.ok(gate !== -1 && gate < wh.indexOf('verifyWebhookSignature('),
      'webhook gate sits before signature work — 503 makes Stripe retry (self-healing)');
    assert.ok(gate < wh.indexOf('addPurchasedCredits('), 'no credits granted while disabled');
  });

  it('both withdraw rails are gated ABOVE the custodial sentinel', () => {
    for (const marker of ["app.post('/withdraw/stripe'", "app.post('/withdraw',"]) {
      const start = SERVER_SRC.indexOf(marker);
      assert.ok(start !== -1);
      const h = SERVER_SRC.slice(start, start + 3000);
      const gate = h.indexOf('if (!paymentsEnabled())');
      const custodial = h.indexOf("CUSTODIAL_WITHDRAW_ENABLED");
      assert.ok(gate !== -1 && custodial !== -1 && gate < custodial,
        `${marker} global gate must be layered above the rail sentinel`);
    }
  });

  it('reads/search stay free: no gate in search, stats, or discovery handlers', () => {
    for (const [start, end] of [
      ["app.post('/knowledge', optionalAuth()", "app.get('/knowledge/stats'"],
      ["app.get('/knowledge/stats'", "app.get('/knowledge/:id'"],
    ]) {
      const h = slice(start, end);
      assert.ok(!h.includes('paymentsEnabled()'), `read surface must not be gated: ${start}`);
    }
  });

  it('/health exposes the effective switch state', () => {
    const h = slice("app.get('/health'", "app.get('/ready'");
    assert.ok(h.includes('payments_enabled: paymentsEnabled()'));
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 4. CP-2 identity vault (CODE-DARK)
// ════════════════════════════════════════════════════════════════════════════

describe('CP-2: flag + key semantics', () => {
  const savedFlag = process.env.CP2_IDENTITY_CAPTURE_ENABLED;
  const savedKey = process.env.CP2_DATA_KEY;
  after(() => {
    if (savedFlag === undefined) delete process.env.CP2_IDENTITY_CAPTURE_ENABLED;
    else process.env.CP2_IDENTITY_CAPTURE_ENABLED = savedFlag;
    if (savedKey === undefined) delete process.env.CP2_DATA_KEY;
    else process.env.CP2_DATA_KEY = savedKey;
  });

  it('capture is OFF by default and only exactly "true" enables it', () => {
    delete process.env.CP2_IDENTITY_CAPTURE_ENABLED;
    assert.equal(vault.captureEnabled(), false, 'absent = off (CODE-DARK)');
    for (const v of ['false', '1', 'yes', 'TRUE', 'on']) {
      process.env.CP2_IDENTITY_CAPTURE_ENABLED = v;
      assert.equal(vault.captureEnabled(), false, `'${v}' must not enable capture`);
    }
    process.env.CP2_IDENTITY_CAPTURE_ENABLED = 'true';
    assert.equal(vault.captureEnabled(), true);
  });

  it('key must be exactly 64 hex chars — no derivation from weak inputs', () => {
    delete process.env.CP2_DATA_KEY;
    assert.equal(vault.keyStatus().ok, false, 'absent key is invalid');
    for (const bad of ['a'.repeat(63), 'a'.repeat(65), 'z'.repeat(64), 'passphrase', '']) {
      process.env.CP2_DATA_KEY = bad;
      assert.equal(vault.keyStatus().ok, false, `'${bad.slice(0, 10)}...' must be rejected`);
    }
    process.env.CP2_DATA_KEY = TEST_KEY;
    assert.equal(vault.keyStatus().ok, true);
  });
});

describe('CP-2: field validation', () => {
  it('accepts a valid W-9 and W-8BEN attestation, trims whitespace', () => {
    for (const form of vault.TAX_FORM_TYPES) {
      const r = vault.validateIdentityFields({ legal_name: '  Jane Doe ', country: ' US ', tax_form_type: form });
      assert.equal(r.ok, true);
      assert.equal(r.fields.legal_name, 'Jane Doe');
      assert.equal(r.fields.country, 'US');
    }
  });

  it('rejects missing/oversized/invalid fields with named errors', () => {
    for (const bad of [
      undefined,
      {},
      { legal_name: '', country: 'US', tax_form_type: 'W-9' },
      { legal_name: 'x'.repeat(201), country: 'US', tax_form_type: 'W-9' },
      { legal_name: 'Jane', country: '', tax_form_type: 'W-9' },
      { legal_name: 'Jane', country: 'US', tax_form_type: 'W-2' },
      { legal_name: 'Jane', country: 'US' },
    ]) {
      const r = vault.validateIdentityFields(bad);
      assert.equal(r.ok, false);
      assert.ok(Array.isArray(r.errors) && r.errors.length > 0);
    }
  });
});

describe('CP-2: encrypted-at-rest store', () => {
  process.env.CP2_DATA_KEY = TEST_KEY;
  const FIELDS = { legal_name: 'Jane Q Doe', country: 'United States', tax_form_type: 'W-9' };
  const WALLET = '0x' + '1'.repeat(40);

  it('encrypt → store → read round-trip; ciphertext leaks nothing', () => {
    process.env.CP2_DATA_KEY = TEST_KEY;
    const enc = vault.encryptIdentity('acc_cp2_a', FIELDS, WALLET);
    assert.equal(enc.alg, 'aes-256-gcm');
    const onDiskShape = JSON.stringify(enc);
    for (const secret of ['Jane', 'Doe', 'United States', 'W-9']) {
      assert.ok(!onDiskShape.includes(secret), `ciphertext must not contain '${secret}'`);
    }
    vault.storeIdentity('acc_cp2_a', enc);
    assert.equal(vault.hasIdentity('acc_cp2_a'), true);
    const dec = vault.readIdentity('acc_cp2_a');
    assert.equal(dec.legal_name, 'Jane Q Doe');
    assert.equal(dec.tax_form_type, 'W-9');
    assert.equal(dec.wallet, WALLET);
    assert.ok(dec.captured_at);
    // Raw file also never contains plaintext.
    const raw = fs.readFileSync(process.env.AUXILO_IDENTITY_FILE, 'utf8');
    assert.ok(!raw.includes('Jane') && !raw.includes('United States'));
  });

  it('fresh IV per write; AAD binds the record to its account', () => {
    process.env.CP2_DATA_KEY = TEST_KEY;
    const e1 = vault.encryptIdentity('acc_cp2_b', FIELDS, WALLET);
    const e2 = vault.encryptIdentity('acc_cp2_b', FIELDS, WALLET);
    assert.notEqual(e1.iv, e2.iv, 'IV must be random per write');
    // Transplant e1 onto another account: GCM auth must fail.
    vault.storeIdentity('acc_cp2_victim', e1);
    assert.throws(() => vault.readIdentity('acc_cp2_victim'),
      'a ciphertext moved between accounts must fail authentication');
  });

  it('tamper detection: modified ciphertext or tag fails closed', () => {
    process.env.CP2_DATA_KEY = TEST_KEY;
    const enc = vault.encryptIdentity('acc_cp2_c', FIELDS, WALLET);
    vault.storeIdentity('acc_cp2_c', { ...enc, data: Buffer.from('tampered').toString('base64') });
    assert.throws(() => vault.readIdentity('acc_cp2_c'));
  });

  it('snapshot/restore compensation: new row deleted, prior row reinstated', () => {
    process.env.CP2_DATA_KEY = TEST_KEY;
    // Case 1: no prior record — restore(null) deletes.
    assert.equal(vault.snapshotIdentity('acc_cp2_d'), null);
    vault.storeIdentity('acc_cp2_d', vault.encryptIdentity('acc_cp2_d', FIELDS, WALLET));
    vault.restoreIdentity('acc_cp2_d', null);
    assert.equal(vault.hasIdentity('acc_cp2_d'), false);
    // Case 2: prior record survives a failed overwrite attempt.
    const first = vault.encryptIdentity('acc_cp2_e', FIELDS, WALLET);
    vault.storeIdentity('acc_cp2_e', first);
    const prior = vault.snapshotIdentity('acc_cp2_e');
    vault.storeIdentity('acc_cp2_e', vault.encryptIdentity('acc_cp2_e', { ...FIELDS, legal_name: 'Someone Else' }, WALLET));
    vault.restoreIdentity('acc_cp2_e', prior);
    assert.equal(vault.readIdentity('acc_cp2_e').legal_name, 'Jane Q Doe');
  });

  it('store file is 0600', () => {
    const mode = fs.statSync(process.env.AUXILO_IDENTITY_FILE).mode & 0o777;
    assert.equal(mode, 0o600);
  });

  it('encryption refuses when the key is unusable (fail closed)', () => {
    delete process.env.CP2_DATA_KEY;
    assert.throws(() => vault.encryptIdentity('acc_cp2_f', FIELDS, WALLET));
    process.env.CP2_DATA_KEY = TEST_KEY;
  });
});

describe('CP-2: link-wallet wiring (source) — dark by default, fail closed when on', () => {
  let h;
  before(() => { h = linkWalletSlice(); });

  it('flag-off purity: every capture reference is gated on captureEnabled()', () => {
    assert.ok(h.includes('identityVault.captureEnabled()'), 'single flag gate');
    // body.identity is only ever read inside the enabled branch.
    const gateAt = h.indexOf('if (identityVault.captureEnabled()) {');
    const identRead = h.indexOf('body.identity');
    assert.ok(gateAt !== -1 && identRead > gateAt, 'body.identity read only when the flag is on');
  });

  it('refusal arms sit BEFORE nonce consumption (a refused attempt keeps the challenge)', () => {
    const cp2At = h.indexOf("code: 'IDENTITY_CAPTURE_UNAVAILABLE'");
    const reqAt = h.indexOf("code: 'IDENTITY_REQUIRED'");
    const nonceAt = h.indexOf('consumeNonce(wallet)');
    assert.ok(cp2At !== -1 && reqAt !== -1 && nonceAt !== -1);
    assert.ok(cp2At < nonceAt && reqAt < nonceAt);
  });

  it('store sits inside the account lock BEFORE linkWallet; failed link restores prior state', () => {
    const lockAt = h.indexOf('await acquireAccountLock(accountId)');
    const storeAt = h.indexOf('identityVault.storeIdentity(');
    const linkAt = h.indexOf('linkWallet(accountId');
    const restoreAt = h.indexOf('identityVault.restoreIdentity(');
    assert.ok(lockAt < storeAt && storeAt < linkAt, 'snapshot+store under the lock, before the link');
    assert.ok(restoreAt > linkAt, 'compensation on link failure');
    assert.ok(h.includes('cp2Prior = identityVault.snapshotIdentity(accountId);'));
  });

  it('responses carry a boolean receipt only — no identity fields anywhere in server responses', () => {
    assert.ok(h.includes('identity_captured: true'));
    // No response shape in the whole server ever includes a legal_name value.
    assert.ok(!/c\.json\([^)]*legal_name:/.test(SERVER_SRC),
      'legal_name must never appear in a response literal');
    assert.ok(!SERVER_SRC.includes('readIdentity('),
      'no route decrypts identity — read path is ops-shell/tests only');
  });

  it('challenge response advertises the field contract when the flag is on', () => {
    assert.ok(h.includes('identity_required: true'));
    assert.ok(h.includes('identityVault.identityFieldContract()'));
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 5. CAT-1 task-#13 fixes
// ════════════════════════════════════════════════════════════════════════════

describe('CAT-1 (a): public analytics count only servable learnings', () => {
  it('visibleCatalog() helper exists and all four surfaces use it', () => {
    assert.ok(SERVER_SRC.includes('function visibleCatalog()'));
    const stats = slice("app.get('/knowledge/stats'", "app.get('/knowledge/:id'");
    assert.ok(stats.includes('visibleCatalog()'));
    const cats = slice("app.get('/pricing/categories'", "app.get('/contributor/:wallet/pricing-insights'");
    assert.ok(cats.includes('for (const learning of visibleCatalog())'),
      '/pricing/categories iterates servable items only (940-vs-58 leak)');
    assert.ok(!cats.includes('of learnings)'), 'raw-array iteration removed');
    const insights = slice("app.get('/contributor/:wallet/pricing-insights'", "app.get('/contributor/:wallet'");
    assert.ok(insights.includes('visibleCatalog().filter('),
      'pricing-insights no longer leaks pending/rejected titles');
    const match = slice('function matchLearnings(', 'let results = visibleLearnings');
    assert.ok(match.includes('filters.accountId') &&
      match.includes('comparisonCatalog(learnings, filters.accountId)'),
      'search visibility includes the authenticated owner private comparison set');
    assert.ok(match.includes(".filter((l) => !l.status || l.status === 'approved')"),
      'search still excludes held and rejected rows');
  });

  it('no inline visibility predicate remains outside the helper (SSR helper delegates too)', () => {
    assert.equal(SERVER_SRC.split("publicCatalog.filter(l => !l.status || l.status === 'approved')").length - 1, 1,
      'the predicate exists exactly once — inside visibleCatalog()');
    assert.equal(SERVER_SRC.split("learnings.filter((l) => l && l.visibility !== 'private')").length - 1, 1,
      'private exclusion exists exactly once — inside visibleCatalog()');
    const ssr = slice('function visibleLearningsList()', 'function displayPrice(');
    assert.ok(ssr.includes('return visibleCatalog();'), 'the pre-existing SSR helper delegates');
  });
});

describe('CAT-1 (b): unlock counters credited only for real unlocks', () => {
  const h = unlockHandlerSlice();

  it('countersCredited = !accrualCapped && !isSelfUnlock, computed before the bumps', () => {
    const predAt = h.indexOf('const countersCredited = !accrualCapped && !isSelfUnlock;');
    const selfAt = h.indexOf('const isSelfUnlock =');
    const bumpAt = h.indexOf('learning.quality.unlocks_total =');
    assert.ok(predAt !== -1 && selfAt !== -1 && bumpAt !== -1);
    assert.ok(selfAt < predAt && predAt < bumpAt,
      'wash-guard decision hoisted above the counter bumps');
  });

  it('credited counter + demand bump only under the predicate; raw total always bumps', () => {
    assert.ok(/learning\.quality\.unlocks_total = \(learning\.quality\.unlocks_total \|\| 0\) \+ 1;/.test(h),
      'ops-only raw counter unconditional');
    assert.ok(/if \(countersCredited\) \{\s*\n\s*learning\.quality\.unlocks = \(learning\.quality\.unlocks \|\| 0\) \+ 1;\s*\n\s*learning\.demand\.unlocks_7d\+\+;\s*\n\s*learning\.demand\.unlocks_30d\+\+;\s*\n\s*\}/.test(h),
      'ranking counter and demand windows share the credited predicate');
  });

  it('ranking/stats surfaces read the CREDITED counter, never unlocks_total', () => {
    const score = slice('function computeScore(', 'const KNOWLEDGE_QUERY_MAX_CHARS');
    assert.ok(score.includes('q.unlocks ||') && !score.includes('unlocks_total'),
      'computeScore uses the credited counter');
    // STATS-TRUTH: the public stats surface no longer reads ANY stored unlock
    // counter — credited or raw — it derives total_unlocks + top_learnings[]
    // .unlocks from the per-unlock event ledger (lib/stats-truth.js).
    const stats = slice("app.get('/knowledge/stats'", "app.get('/knowledge/:id'");
    assert.ok(stats.includes('computeStatsTruth(') &&
      !stats.includes('l.quality.unlocks') && !stats.includes('unlocks_total'),
      'total_unlocks + top_learnings derive from the unlock ledger, never a stored counter');
    // Search projection constructs its quality object explicitly — credited only.
    assert.ok(SERVER_SRC.includes('quality: { score: computeScore(r), unlocks: r.quality.unlocks,'),
      'search projection field list excludes unlocks_total');
  });

  it('rollback restores both counters (unlocks_total snapshot in _rb)', () => {
    assert.ok(h.includes('unlocksTotal: learning.quality.unlocks_total || 0,'));
    const catchBlock = h.slice(h.indexOf('} catch (deliveryErr) {'));
    assert.ok(catchBlock.includes('learning.quality.unlocks_total = _rb.unlocksTotal;'));
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 6. Wave-1 carry-ins (F1 / F2 / F4)
// ════════════════════════════════════════════════════════════════════════════

describe('Wave-1 carry-ins in the unlock compensation path', () => {
  let h, catchBlock;
  before(() => {
    h = unlockHandlerSlice();
    catchBlock = h.slice(h.indexOf('} catch (deliveryErr) {'));
  });

  it('F1: refunded delivery failure restores the discovery-cache entry at its ORIGINAL timestamp', () => {
    assert.ok(catchBlock.includes('if (isFromSearch) searchSourceCache.set(discoveryCacheKey, cachedAt);'),
      'the retry of a refunded unlock keeps its 60% discovery attribution');
    assert.ok(!catchBlock.includes('searchSourceCache.set(discoveryCacheKey, Date.now()'),
      'original timestamp — the retry rides the original discovery window');
  });

  it('F2: the accrual cap is un-armed BEFORE the refund await (capped-race closed)', () => {
    const unarmAt = catchBlock.indexOf('if (accrualArmed) unrecordAccrual(buyerAccountId, id);');
    const refundAt = catchBlock.indexOf('await refundCredit(');
    assert.ok(unarmAt !== -1 && refundAt !== -1 && unarmAt < refundAt,
      'un-arm precedes the await so a concurrent same-buyer unlock cannot read a stale armed cap');
  });
});

describe('F4: purchase-ledger writes serialize under the store-level mutex', () => {
  it('concurrent recordings for the same and different accounts all land (no lost update)', async () => {
    await Promise.all([
      ledger.recordPurchase('acc_f4_a', 'lrn_1', 100),
      ledger.recordPurchase('acc_f4_a', 'lrn_1', 200),
      ledger.recordPurchase('acc_f4_b', 'lrn_1', 300),
      ledger.recordPurchase('acc_f4_a', 'lrn_2', 400),
    ]);
    const map = ledger.loadLedger();
    assert.equal(map['acc_f4_a:lrn_1'].count, 2, 'same-key concurrent writes both counted');
    assert.equal(map['acc_f4_b:lrn_1'].count, 1, 'cross-account write not lost');
    assert.equal(map['acc_f4_a:lrn_2'].count, 1, 'cross-learning write not lost');
  });

  it('module documents the file-level (not account-keyed) decision + compaction future', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'purchase-ledger.js'), 'utf-8');
    assert.ok(src.includes('file-level is the sound version'), 'deviation from the account-keyed sketch is argued');
    assert.ok(src.includes('FUTURE:'), 'compaction/sharding noted as future work');
  });

  it('unlock-handler call sites are fire-and-forget with rejection handling', () => {
    const h = unlockHandlerSlice();
    assert.equal(h.split('recordPurchase(buyerAccountId, id).catch(').length - 1, 2,
      'both delivery-success sites handle the async rejection without awaiting');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 7. SPEC3 B4 — retraction fixes
// ════════════════════════════════════════════════════════════════════════════

describe('B4-1: retraction no longer 500s for never-consented accounts', () => {
  it('root cause pinned: getConsentState returns null when no consent record exists', () => {
    assert.equal(consentReader.getConsentState('acc_never_consented_wave2b'), null);
  });

  it('the handler null-guards the consent read and records the truthful "none"', () => {
    const h = retractionSlice();
    assert.ok(h.includes('const retractConsent = getConsentState(accountId);'));
    assert.ok(h.includes("consent_version: retractConsent ? retractConsent.consent_version : 'none',"),
      "'none' satisfies the audit writer's truthiness assertion for action 'retract'");
    assert.ok(!/consent_version: getConsentState\(accountId\)\.consent_version/.test(h),
      'the unguarded deref is gone');
  });
});

describe('B4-2: retraction window runs from approval time for queue-approved items', () => {
  const h = retractionSlice();

  it('basis prefers self_review_action / moderation_action approval stamps, falls back to created_at', () => {
    assert.ok(h.includes("learning.self_review_action.action === 'self_approve'"));
    assert.ok(h.includes("learning.moderation_action.action === 'approved'"));
    assert.ok(h.includes('const publishedAtIso = approvedAtIso || learning.created_at;'));
  });

  it('the 409 response reports the SAME basis it enforced', () => {
    assert.ok(h.includes('published_at: publishedAtIso,'));
    assert.ok(!h.includes('published_at: learning.created_at,'),
      'response no longer contradicts the enforced window');
  });

  it('approval stamps exist where the basis expects them (self-review + admin routes)', () => {
    assert.ok(SERVER_SRC.includes("action: 'approved',"), 'admin approve stamps moderation_action.at');
    const selfReviewSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'self-review.js'), 'utf-8');
    assert.ok(selfReviewSrc.includes("learning.self_review_action = { action: 'self_approve', by: accountId, at: now }"),
      'self-approve stamps self_review_action.at');
  });
});
