'use strict';

/**
 * test/credits-config-usable.test.js — CREDITS-CONFIG-USABLE
 *
 * Problem (live on prod at the time of this build): GET /health reported
 * stripe_configured:true whenever STRIPE_SECRET_KEY was merely PRESENT (see
 * lib/stripe.js history + server.js /health). The pasted prod secrets were
 * malformed (secret key 236 chars, webhook secret 16 chars = a placeholder
 * "whsec_PASTE_HERE"), so every visitor saw the three "Buy credits" buttons
 * while POST /checkout/session actually failed with Stripe's own "Invalid
 * API Key" error. The dark-safe invariant must be "usable", not "present" —
 * fail closed.
 *
 * This suite covers lib/stripe.js's getStripeStatus()/getStripeConfigIssue()
 * /probeStripeNow()/notifyStripeCheckoutAttempt() usability gate (unit,
 * real logic, no network — every probe test injects a stubbed Stripe client
 * via probeStripeNow(clientOverride) or __setStripeClientForTest()), plus
 * its wiring into GET /health, POST /checkout/session, POST
 * /account/connect-stripe, and POST /withdraw/stripe (source-level, same
 * style as test/credits-control-part1.test.js — server.js is a monolith
 * with no module exports for its route handlers).
 *
 * NO TEST IN THIS FILE MAKES A REAL NETWORK CALL TO STRIPE.
 *
 * Runner: node --test test/credits-config-usable.test.js
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-do-not-use-in-prod';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const SERVER_SRC = fs.readFileSync(path.join(REPO_ROOT, 'server.js'), 'utf-8');

const stripeLib = require('../lib/stripe.js');
const {
  getStripeStatus,
  getStripeConfigIssue,
  notifyStripeCheckoutAttempt,
  probeStripeNow,
  __resetStripeStatusForTest,
  __setStripeClientForTest,
} = stripeLib;

function sliceAt(src, marker, span = 4000) {
  const i = src.indexOf(marker);
  assert.notEqual(i, -1, `marker not found: ${marker}`);
  return src.slice(i, i + span);
}

// ─── Test fixtures ───────────────────────────────────────────────────────────

const VALID_TEST_KEY = 'sk_test_' + 'a'.repeat(40);   // 48 chars — well inside 24-200
const VALID_WHSEC = 'whsec_' + 'b'.repeat(40);         // 46 chars — >= 30

function setValidFormatEnv() {
  process.env.STRIPE_SECRET_KEY = VALID_TEST_KEY;
  process.env.STRIPE_WEBHOOK_SECRET = VALID_WHSEC;
}

function fakeStripeClient(behavior) {
  return {
    balance: {
      retrieve: async () => {
        if (behavior === 'success') return { object: 'balance', available: [] };
        if (behavior === 'auth-fail') {
          const err = new Error('Invalid API Key provided');
          err.type = 'StripeAuthenticationError';
          err.statusCode = 401;
          throw err;
        }
        if (behavior === 'network-fail') {
          const err = new Error('getaddrinfo ENOTFOUND api.stripe.com');
          err.code = 'ENOTFOUND';
          throw err;
        }
        if (behavior === 'timeout') {
          // Deliberately never resolves/rejects — exercises the probe's own
          // 5s timeout race, not a real network hang.
          return new Promise(() => {});
        }
        throw new Error(`unknown fake behavior: ${behavior}`);
      },
    },
  };
}

let _origSecret, _origWhsec;

beforeEach(() => {
  _origSecret = process.env.STRIPE_SECRET_KEY;
  _origWhsec = process.env.STRIPE_WEBHOOK_SECRET;
  __resetStripeStatusForTest();
});

afterEach(() => {
  if (_origSecret === undefined) delete process.env.STRIPE_SECRET_KEY; else process.env.STRIPE_SECRET_KEY = _origSecret;
  if (_origWhsec === undefined) delete process.env.STRIPE_WEBHOOK_SECRET; else process.env.STRIPE_WEBHOOK_SECRET = _origWhsec;
  __resetStripeStatusForTest();
});

// ─── 1. Format rules: getStripeConfigIssue() ────────────────────────────────

describe('getStripeConfigIssue: format rules (spec §1a/1b, all synchronous, no network)', () => {
  it('missing entirely (neither var set) → not-configured', () => {
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_WEBHOOK_SECRET;
    assert.equal(getStripeConfigIssue(), 'not-configured');
  });

  it('secret key set, webhook secret missing → not-configured', () => {
    process.env.STRIPE_SECRET_KEY = VALID_TEST_KEY;
    delete process.env.STRIPE_WEBHOOK_SECRET;
    assert.equal(getStripeConfigIssue(), 'not-configured');
  });

  it('webhook secret set, secret key missing → not-configured', () => {
    delete process.env.STRIPE_SECRET_KEY;
    process.env.STRIPE_WEBHOOK_SECRET = VALID_WHSEC;
    assert.equal(getStripeConfigIssue(), 'not-configured');
  });

  it('secret key containing whitespace → secret-key-malformed', () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_abc def' + 'x'.repeat(20);
    process.env.STRIPE_WEBHOOK_SECRET = VALID_WHSEC;
    assert.equal(getStripeConfigIssue(), 'secret-key-malformed');
  });

  it('secret key with a non-Stripe prefix → secret-key-malformed', () => {
    process.env.STRIPE_SECRET_KEY = 'pk_test_' + 'a'.repeat(40); // publishable, not secret
    process.env.STRIPE_WEBHOOK_SECRET = VALID_WHSEC;
    assert.equal(getStripeConfigIssue(), 'secret-key-malformed');
  });

  it('the exact prod-incident value — a 236-char sk_test_ key — → secret-key-malformed (too long)', () => {
    const longKey = 'sk_test_' + 'x'.repeat(236 - 'sk_test_'.length);
    assert.equal(longKey.length, 236, 'fixture must reproduce the reported prod length exactly');
    process.env.STRIPE_SECRET_KEY = longKey;
    process.env.STRIPE_WEBHOOK_SECRET = VALID_WHSEC;
    assert.equal(getStripeConfigIssue(), 'secret-key-malformed');
  });

  it('secret key too short (< 24 chars) → secret-key-malformed', () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_abc'; // 11 chars
    process.env.STRIPE_WEBHOOK_SECRET = VALID_WHSEC;
    assert.equal(getStripeConfigIssue(), 'secret-key-malformed');
  });

  it('secret key length boundary: 24 chars passes, 23 fails', () => {
    process.env.STRIPE_WEBHOOK_SECRET = VALID_WHSEC;
    process.env.STRIPE_SECRET_KEY = 'sk_test_' + 'a'.repeat(16); // 24 total
    assert.equal(getStripeConfigIssue(), null);
    process.env.STRIPE_SECRET_KEY = 'sk_test_' + 'a'.repeat(15); // 23 total
    assert.equal(getStripeConfigIssue(), 'secret-key-malformed');
  });

  it('secret key length boundary: 200 chars passes, 201 fails', () => {
    process.env.STRIPE_WEBHOOK_SECRET = VALID_WHSEC;
    process.env.STRIPE_SECRET_KEY = 'sk_test_' + 'a'.repeat(192); // 200 total
    assert.equal(getStripeConfigIssue(), null);
    process.env.STRIPE_SECRET_KEY = 'sk_test_' + 'a'.repeat(193); // 201 total
    assert.equal(getStripeConfigIssue(), 'secret-key-malformed');
  });

  it('rk_ restricted keys (test and live) are accepted by the prefix rule', () => {
    process.env.STRIPE_WEBHOOK_SECRET = VALID_WHSEC;
    process.env.STRIPE_SECRET_KEY = 'rk_test_' + 'a'.repeat(40);
    assert.equal(getStripeConfigIssue(), null);
    process.env.STRIPE_SECRET_KEY = 'rk_live_' + 'a'.repeat(40);
    assert.equal(getStripeConfigIssue(), null);
  });

  it('sk_live_ passes the prefix rule same as sk_test_', () => {
    process.env.STRIPE_WEBHOOK_SECRET = VALID_WHSEC;
    process.env.STRIPE_SECRET_KEY = 'sk_live_' + 'a'.repeat(40);
    assert.equal(getStripeConfigIssue(), null);
  });

  it('webhook secret containing whitespace → webhook-secret-malformed', () => {
    setValidFormatEnv();
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_abc def' + 'x'.repeat(30);
    assert.equal(getStripeConfigIssue(), 'webhook-secret-malformed');
  });

  it('webhook secret with the wrong prefix → webhook-secret-malformed', () => {
    setValidFormatEnv();
    process.env.STRIPE_WEBHOOK_SECRET = 'wh_' + 'a'.repeat(40);
    assert.equal(getStripeConfigIssue(), 'webhook-secret-malformed');
  });

  it('the exact prod-incident placeholder "whsec_PASTE_HERE" (16 chars) → webhook-secret-malformed', () => {
    setValidFormatEnv();
    assert.equal('whsec_PASTE_HERE'.length, 16, 'fixture must reproduce the reported placeholder exactly');
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_PASTE_HERE';
    assert.equal(getStripeConfigIssue(), 'webhook-secret-malformed');
  });

  it('webhook secret length boundary: 30 chars passes, 29 fails', () => {
    setValidFormatEnv();
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_' + 'a'.repeat(24); // 30 total
    assert.equal(getStripeConfigIssue(), null);
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_' + 'a'.repeat(23); // 29 total
    assert.equal(getStripeConfigIssue(), 'webhook-secret-malformed');
  });

  it('when both fields are malformed, the secret-key rule (checked first) wins', () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_' + 'x'.repeat(236 - 'sk_test_'.length);
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_PASTE_HERE';
    assert.equal(getStripeConfigIssue(), 'secret-key-malformed');
  });

  it('both fields valid format → null (proceed to live probe)', () => {
    setValidFormatEnv();
    assert.equal(getStripeConfigIssue(), null);
  });
});

// ─── 2. mode: 'test'|'live'|null from the key prefix (safe, no secret material) ─

describe('getStripeStatus / mode derivation', () => {
  it('sk_test_ → mode "test"', () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_' + 'a'.repeat(40);
    delete process.env.STRIPE_WEBHOOK_SECRET;
    assert.equal(getStripeStatus().mode, 'test');
  });

  it('sk_live_ → mode "live"', () => {
    process.env.STRIPE_SECRET_KEY = 'sk_live_' + 'a'.repeat(40);
    delete process.env.STRIPE_WEBHOOK_SECRET;
    assert.equal(getStripeStatus().mode, 'live');
  });

  it('rk_test_ → mode "test", rk_live_ → mode "live"', () => {
    process.env.STRIPE_SECRET_KEY = 'rk_test_' + 'a'.repeat(40);
    assert.equal(getStripeStatus().mode, 'test');
    process.env.STRIPE_SECRET_KEY = 'rk_live_' + 'a'.repeat(40);
    assert.equal(getStripeStatus().mode, 'live');
  });

  it('missing key → mode null', () => {
    delete process.env.STRIPE_SECRET_KEY;
    assert.equal(getStripeStatus().mode, null);
  });

  it('mode is derived even when configured is false — a malformed key still reveals its prefix (no other secret material)', () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_' + 'x'.repeat(236 - 'sk_test_'.length);
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_PASTE_HERE';
    const status = getStripeStatus();
    assert.equal(status.configured, false);
    assert.equal(status.mode, 'test');
  });
});

// ─── 3. getStripeStatus(): synchronous snapshot before any probe has run ────

describe('getStripeStatus: lazy synchronous snapshot (initStripeStatusProbing() never called)', () => {
  it('a deterministic format issue is reported immediately — no probe needed', () => {
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_WEBHOOK_SECRET;
    const status = getStripeStatus();
    assert.equal(status.configured, false);
    assert.equal(status.reason, 'not-configured');
    assert.ok(status.checked_at);
  });

  it('format-valid-but-unprobed reports probe-pending, not a false positive', () => {
    setValidFormatEnv();
    const status = getStripeStatus();
    assert.equal(status.configured, false);
    assert.equal(status.reason, 'probe-pending');
  });
});

// ─── 4. probeStripeNow(): live-probe classification, stubbed client only ───

describe('probeStripeNow: live probe classification (stubbed client — NO network)', () => {
  it('success → configured true, reason null', async () => {
    setValidFormatEnv();
    const status = await probeStripeNow(fakeStripeClient('success'));
    assert.equal(status.configured, true);
    assert.equal(status.reason, null);
    assert.ok(status.checked_at);
  });

  it('Stripe auth error (StripeAuthenticationError, 401) → configured false, reason secret-key-rejected', async () => {
    setValidFormatEnv();
    const status = await probeStripeNow(fakeStripeClient('auth-fail'));
    assert.equal(status.configured, false);
    assert.equal(status.reason, 'secret-key-rejected');
  });

  it('network failure (ENOTFOUND) → configured false, reason stripe-unreachable', async () => {
    setValidFormatEnv();
    const status = await probeStripeNow(fakeStripeClient('network-fail'));
    assert.equal(status.configured, false);
    assert.equal(status.reason, 'stripe-unreachable');
  });

  it('a hung call is cut off around the 5s probe timeout → configured false, reason stripe-unreachable', { timeout: 8000 }, async () => {
    setValidFormatEnv();
    const start = Date.now();
    const status = await probeStripeNow(fakeStripeClient('timeout'));
    const elapsed = Date.now() - start;
    assert.equal(status.configured, false);
    assert.equal(status.reason, 'stripe-unreachable');
    assert.ok(elapsed >= 4900 && elapsed < 6500, `expected the probe to time out ~5000ms, took ${elapsed}ms`);
  });

  it('format-invalid config short-circuits before any network call — the stub is never invoked', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_abc'; // too short
    process.env.STRIPE_WEBHOOK_SECRET = VALID_WHSEC;
    let called = false;
    const client = { balance: { retrieve: async () => { called = true; return {}; } } };
    const status = await probeStripeNow(client);
    assert.equal(called, false, 'format-invalid config must never reach the live probe');
    assert.equal(status.configured, false);
    assert.equal(status.reason, 'secret-key-malformed');
  });

  it('a successful probe result is cached — getStripeStatus() reads it back without re-probing', async () => {
    setValidFormatEnv();
    await probeStripeNow(fakeStripeClient('success'));
    const status = getStripeStatus();
    assert.equal(status.configured, true);
    assert.equal(status.reason, null);
  });

  it('never logs or exposes key material in the returned status object', async () => {
    setValidFormatEnv();
    const status = await probeStripeNow(fakeStripeClient('auth-fail'));
    const serialized = JSON.stringify(status);
    assert.ok(!serialized.includes(VALID_TEST_KEY), 'status must never carry the raw secret key');
    assert.ok(!serialized.includes(VALID_WHSEC), 'status must never carry the raw webhook secret');
    assert.deepEqual(Object.keys(status).sort(), ['checked_at', 'configured', 'mode', 'reason'].sort());
  });
});

// ─── 5. Cache + re-probe behavior: notifyStripeCheckoutAttempt() ───────────

describe('notifyStripeCheckoutAttempt: immediate reprobe on the first attempt after a failure', () => {
  it('after a failed probe, the next checkout attempt triggers an immediate reprobe (arm is consumed once)', async () => {
    setValidFormatEnv();
    // Prime a failure so the cache + arm reflect a transient failure.
    await probeStripeNow(fakeStripeClient('auth-fail'));
    assert.equal(getStripeStatus().configured, false);

    // Inject a client that WOULD succeed, and force getStripe() (called with
    // no override by notifyStripeCheckoutAttempt's internal reprobe) to
    // return it instead of constructing a real Stripe client.
    __setStripeClientForTest(fakeStripeClient('success'));

    notifyStripeCheckoutAttempt();
    // The reprobe runs async — wait for it to settle by polling the cache
    // briefly (bounded, no fixed sleep race: the fake client resolves
    // immediately, so this should flip within a tick or two).
    for (let i = 0; i < 20 && getStripeStatus().reason !== null; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.equal(getStripeStatus().configured, true, 'the armed reprobe must have run and picked up the now-good client');
  });

  it('a second attempt before another failure does NOT trigger a second reprobe (arm consumed)', async () => {
    setValidFormatEnv();
    await probeStripeNow(fakeStripeClient('auth-fail'));

    let calls = 0;
    __setStripeClientForTest({
      balance: { retrieve: async () => { calls += 1; return { object: 'balance' }; } },
    });

    notifyStripeCheckoutAttempt(); // consumes the arm, triggers 1 reprobe
    for (let i = 0; i < 20 && calls === 0; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.equal(calls, 1, 'first attempt after a failure must trigger exactly one reprobe');

    notifyStripeCheckoutAttempt(); // arm already consumed by a SUCCESSFUL probe — must no-op
    notifyStripeCheckoutAttempt();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(calls, 1, 'subsequent attempts after a success must not trigger additional reprobes');
  });

  it('a format-only failure (secret-key-malformed) is NOT transient — no reprobe is armed (a network retry cannot fix a bad paste)', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_abc'; // malformed
    process.env.STRIPE_WEBHOOK_SECRET = VALID_WHSEC;
    await probeStripeNow(); // no network call happens — format check short-circuits
    assert.equal(getStripeStatus().reason, 'secret-key-malformed');

    let called = false;
    __setStripeClientForTest({ balance: { retrieve: async () => { called = true; return {}; } } });
    notifyStripeCheckoutAttempt();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(called, false, 'a static format error must not arm a live reprobe');
  });

  it('a still-unusable reprobe result (still failing) leaves the interval as the only further retry path — no busy-loop', async () => {
    setValidFormatEnv();
    await probeStripeNow(fakeStripeClient('auth-fail'));

    let calls = 0;
    __setStripeClientForTest({
      balance: { retrieve: async () => { calls += 1; const e = new Error('bad'); e.type = 'StripeAuthenticationError'; throw e; } },
    });
    notifyStripeCheckoutAttempt();
    for (let i = 0; i < 20 && calls === 0; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.equal(calls, 1, 'the reprobe itself must run exactly once');
    // A failed reprobe re-arms (still a transient reason) — the spec's
    // "retried on the next interval" — but a burst of attempts in the same
    // tick must not pile up concurrent probes.
    notifyStripeCheckoutAttempt();
    notifyStripeCheckoutAttempt();
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(calls <= 2, `expected at most one further reprobe from the burst, got ${calls - 1} extra`);
  });
});

// ─── 6. /health: source-level wiring (usability, not presence) ─────────────

describe('/health wiring: stripe_configured/stripe_reason/stripe_mode from getStripeStatus()', () => {
  it('reads the cached usability status, not process.env.STRIPE_SECRET_KEY presence', () => {
    const h = sliceAt(SERVER_SRC, "app.get('/health', (c) => {", 2200);
    assert.ok(h.includes('const stripeStatus = getStripeStatus();'));
    assert.ok(h.includes('stripe_configured: stripeStatus.configured,'));
    assert.ok(h.includes('stripe_reason: stripeStatus.reason,'));
    assert.ok(h.includes('stripe_mode: stripeStatus.mode,'));
    assert.ok(!/stripe_configured:\s*!!process\.env\.STRIPE_SECRET_KEY/.test(h),
      'the old presence-only literal must be gone');
  });
});

// ─── 7. POST /checkout/session: 503 + reason code when unusable ────────────

describe('/checkout/session wiring: fails closed on usability with a machine-readable reason', () => {
  it('gates on stripeStatus.configured and returns code + reason in the 503 body', () => {
    const h = sliceAt(SERVER_SRC, "app.post('/checkout/session', requireAuth", 2500);
    assert.ok(h.includes('notifyStripeCheckoutAttempt();'), 'must arm/trigger the reprobe on every attempt');
    assert.ok(h.includes('const stripeStatus = getStripeStatus();'));
    assert.ok(h.includes('if (!stripeStatus.configured)'));
    assert.ok(h.includes("code: 'stripe_unusable',"));
    assert.ok(h.includes('reason: stripeStatus.reason,'));
  });
});

// ─── 8. Every presence-only reader found by grep is now usability-gated ────
// (build-task requirement: "Find every reader with grep... do not leave a
// presence-only gate anywhere." Enumerated readers: server.js /checkout/session
// (§7 above), /health (§6 above), /account/connect-stripe, /withdraw/stripe.
// dashboard.html + pricing.html read the /health JSON field only — already
// covered by fixing /health's semantics, no HTML change needed (see
// test/credits-control-part1.test.js T4). skills.json:254's "STRIPE_SECRET_KEY"
// is an unrelated third-party marketplace-listing auth hint, not our gate —
// confirmed out of scope by direct read.)

describe('/account/connect-stripe + /withdraw/stripe: no bare getStripe() presence gate survives', () => {
  it('/account/connect-stripe gates on getStripeStatus().configured', () => {
    const h = sliceAt(SERVER_SRC, "app.post('/account/connect-stripe', requireAuth", 1400);
    assert.ok(h.includes('_getStripeStatusConnect()'));
    assert.ok(h.includes('if (!connectStripeStatus.configured)'));
    assert.ok(!/if \(!getStripe\(\)\)/.test(h), 'the old presence-only literal must be gone from this route');
  });

  it('/withdraw/stripe gates on getStripeStatus().configured', () => {
    const h = sliceAt(SERVER_SRC, "app.post('/withdraw/stripe', requireAuth", 2200);
    assert.ok(h.includes('_getStripeStatusWithdraw()'));
    assert.ok(h.includes('if (!withdrawStripeStatus.configured)'));
    assert.ok(!/if \(!getStripe\(\)\)/.test(h), 'the old presence-only literal must be gone from this route');
  });

  it('no route handler in server.js still contains the bare presence literal', () => {
    assert.ok(!SERVER_SRC.includes('if (!getStripe()) return'),
      'every former presence-only gate must have moved to the usability check');
  });
});

// ─── 9. Server boot wiring: initStripeStatusProbing() runs, non-blocking ───

describe('server.js boot wiring', () => {
  it('calls initStripeStatusProbing() once at startup, after the destructured import', () => {
    assert.ok(SERVER_SRC.includes('initStripeStatusProbing,'), 'must be destructured from lib/stripe.js at the top');
    assert.ok(SERVER_SRC.includes('initStripeStatusProbing();'), 'must be invoked at boot');
    const importIdx = SERVER_SRC.indexOf('initStripeStatusProbing,');
    const callIdx = SERVER_SRC.indexOf('initStripeStatusProbing();');
    assert.ok(importIdx < callIdx, 'import must precede the boot call');
  });
});
