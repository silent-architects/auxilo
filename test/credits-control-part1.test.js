'use strict';

/**
 * test/credits-control-part1.test.js — CREDITS-CONTROL PART 1 (dark-safe code)
 *
 * Covers BUILD-SPEC-CREDITS-CONTROL-REV2-2026-09-06.md §3/§7 + the binding
 * amendments in the build task: manifest pack_id→pack + "queries" retired
 * from the capability manifest, lib/stripe.js checkout description +
 * consent_collection, /health stripe_configured, /account/connect-stripe
 * gated behind CUSTODIAL_WITHDRAW_ENABLED, /checkout/success + /checkout/cancel
 * 302 redirects carrying no session_id, POST /checkout/session gated behind
 * current-Terms acceptance, the dashboard "Queries" column removal, the
 * pack-data-from-PACKS-at-render rule, the /terms §7 heading anchor, and the
 * payment_method_types pin.
 *
 * Style matches the aud19/wave1/wave2b/spec3-b1/pricing-visibility suites:
 * source-level wiring assertions (server.js is a monolith with no module
 * exports — see test/spec3-b1-server.test.js header) + real-logic unit tests
 * against lib/stripe.js and lib/credits.js + one real-server boot (shared
 * staged-server harness, same pattern as test/pricing-visibility.test.js).
 *
 * Runner: node --test test/credits-control-part1.test.js
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-do-not-use-in-prod';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { SignJWT } = require('jose');
const { reservePort, stageServer, bootServer, stopServer } = require('./helpers/staged-server');

const REPO_ROOT = path.join(__dirname, '..');
const SERVER_SRC = fs.readFileSync(path.join(REPO_ROOT, 'server.js'), 'utf-8');
const STRIPE_LIB_SRC = fs.readFileSync(path.join(REPO_ROOT, 'lib', 'stripe.js'), 'utf-8');
const PRICING_HTML = fs.readFileSync(path.join(REPO_ROOT, 'public', 'pricing.html'), 'utf-8');
const DASHBOARD_HTML = fs.readFileSync(path.join(REPO_ROOT, 'public', 'dashboard.html'), 'utf-8');
const TERMS_MD = fs.readFileSync(path.join(REPO_ROOT, 'docs', 'TERMS-OF-SERVICE.md'), 'utf-8');

const { CURRENT_TOS_VERSION } = require('../lib/accounts.js');

function sliceAt(src, marker, span = 4000) {
  const i = src.indexOf(marker);
  assert.notEqual(i, -1, `marker not found: ${marker}`);
  return src.slice(i, i + span);
}

// ─── 1. Capability manifest strings (both /skills surfaces, spec §3 req 1) ──

describe('T1 capability manifest: pack field + queries retired', () => {
  it('no "query and unlock" language survives anywhere in the manifest', () => {
    assert.ok(!SERVER_SRC.includes('View query and unlock credit balance'),
      'the pre-fix manifest string must be gone everywhere, not just one occurrence');
  });
  // FIX-UNIT-MONEY L8: "unlock credit balance" retired -- there is no unit
  // credit, only a dollar Balance.
  it('/account/credits description reads "View balance" (both occurrences), never "unlock credit"', () => {
    const matches = SERVER_SRC.match(/View balance for the authenticated account/g) || [];
    assert.equal(matches.length, 2, 'both /skills-manifest occurrences must carry the fixed string');
    assert.equal((SERVER_SRC.match(/View unlock credit balance/g) || []).length, 0);
  });
  it('/checkout/session manifest body field is { pack }, not { pack_id } (both occurrences)', () => {
    assert.ok(!SERVER_SRC.includes('Body: { pack_id }'),
      'the manifest must not advertise a body field the route does not read');
    const matches = SERVER_SRC.match(/Create a Stripe checkout session to purchase credits\. Body: \{ pack \}/g) || [];
    assert.equal(matches.length, 2, 'both /skills-manifest occurrences must advertise { pack }');
  });
  // AUD-CAC (credits-as-cash, 2026-09-27): the span widened from 1400 to
  // 2200 — the route gained the account-hold check ahead of pack
  // validation (spec §2 test 16/§8 test 26); the marker and the assertion
  // are unchanged.
  it('the route itself destructures { pack } (manifest matches reality)', () => {
    const h = sliceAt(SERVER_SRC, "app.post('/checkout/session'", 2200);
    assert.ok(h.includes('const { pack } = body'));
  });
});

// ─── 2. lib/stripe.js: description fix + consent_collection (spec §3 req 2, 10) ─

describe('T2 lib/stripe.js: Checkout description + consent_collection (source)', () => {
  // RETIRED (credits-as-cash follow-up, SITE-PM 2026-09-27): 'product_data.
  // description no longer references queries' pinned the unit-lot
  // description branch (`${pack.unlocks} unlocks`) — that branch, and the
  // lotKind switch that selected it, are both gone. A pack purchase always
  // states the dollar amount added to the balance now (proved below and in
  // test/credits-one-balance.test.js).
  it('consent_collection.terms_of_service is required on the Session', () => {
    assert.ok(STRIPE_LIB_SRC.includes("consent_collection: { terms_of_service: 'required' }"));
  });
  it('unit_amount stays byte-unchanged; pack_queries metadata is retired (CREDITS-QUERIES-RESIDUAL)', () => {
    assert.ok(STRIPE_LIB_SRC.includes('unit_amount: pack.price_cents,'));
    const metadataBlock = sliceAt(STRIPE_LIB_SRC, 'metadata: {', 200);
    assert.ok(!metadataBlock.includes('pack_queries'),
      'the metadata object must no longer carry a pack_queries key — a purchase adds dollars only now');
  });
  it('success_url stays byte-identical (still carries session_id — the ROUTE strips it before the browser sees it)', () => {
    assert.ok(STRIPE_LIB_SRC.includes(
      'success_url: `${baseUrl}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,'));
  });
});

// ─── 3. Behavioral: createCheckoutSession call args via a fake Stripe client ─
// (spec §7 test 3 + test 7 — "inject a fake Stripe client for the session
// creation test; assert consent_collection, description has no queries,
// success_url has no session_id [in the value we forward to the browser]".)

describe('T3 createCheckoutSession: fake-Stripe call-args assertions', () => {
  const stripeModulePath = require.resolve('stripe');
  const stripeLibPath = require.resolve('../lib/stripe.js');
  let capturedArgs = null;
  let originalStripeCacheEntry;

  before(() => {
    originalStripeCacheEntry = require.cache[stripeModulePath];
    delete require.cache[stripeModulePath];
    delete require.cache[stripeLibPath];

    class FakeStripe {
      constructor() {
        this.checkout = {
          sessions: {
            create: async (args) => {
              capturedArgs = args;
              return { id: 'cs_test_fake123', url: 'https://checkout.stripe.test/fake123' };
            },
          },
        };
      }
    }
    require.cache[stripeModulePath] = {
      id: stripeModulePath,
      filename: stripeModulePath,
      loaded: true,
      exports: FakeStripe,
    };
  });

  after(() => {
    delete require.cache[stripeLibPath];
    if (originalStripeCacheEntry) {
      require.cache[stripeModulePath] = originalStripeCacheEntry;
    } else {
      delete require.cache[stripeModulePath];
    }
  });

  it('createCheckoutSession({pack: "starter"}) resolves {url, session_id} unchanged shape (spec test 2)', async () => {
    const priorKey = process.env.STRIPE_SECRET_KEY;
    process.env.STRIPE_SECRET_KEY = 'sk_test_fake_for_this_suite_only';
    try {
      const stripeLib = require('../lib/stripe.js');
      const result = await stripeLib.createCheckoutSession('acc_test_ccp1', 'starter', 'https://auxilo.test');
      assert.deepEqual(Object.keys(result).sort(), ['session_id', 'url'].sort());
      assert.equal(result.url, 'https://checkout.stripe.test/fake123');
      assert.equal(result.session_id, 'cs_test_fake123');
    } finally {
      if (priorKey === undefined) delete process.env.STRIPE_SECRET_KEY;
      else process.env.STRIPE_SECRET_KEY = priorKey;
    }
  });

  it('the captured Stripe call carries consent_collection + a dollar-balance description (spec test 3, 7)', () => {
    assert.ok(capturedArgs, 'checkout.sessions.create must have been called');
    assert.deepEqual(capturedArgs.consent_collection, { terms_of_service: 'required' });
    const desc = capturedArgs.line_items[0].price_data.product_data.description;
    assert.ok(!/queries/i.test(desc), `description must not mention queries: "${desc}"`);
    assert.equal(desc, '$10.00 added to your Auxilo balance');
    // success_url keeps Stripe's own ?session_id={CHECKOUT_SESSION_ID} template
    // (spec: "success_url stays byte-identical") — Stripe substitutes the real
    // id here server-side; it is OUR /checkout/success route (T8 below) that
    // strips it before the browser ever sees it in a redirect target.
    assert.ok(capturedArgs.success_url.includes('{CHECKOUT_SESSION_ID}'));
  });
});

// ─── 4. No-button-when-unconfigured (spec §7 test 4, STOP gate e) ───────────

describe('T4 dark-safe rendering: no purchase button/disclosures without stripe_configured', () => {
  it('pricing.html: every .pack-buy-btn defaults to display:none and is revealed only by /health', () => {
    const btnMatches = PRICING_HTML.match(/class="btn-primary pack-buy-btn"[^>]*>/g) || [];
    assert.equal(btnMatches.length, 3, 'one Buy button per pack card');
    for (const tag of btnMatches) {
      assert.ok(tag.includes('style="display:none"'), `button must default hidden: ${tag}`);
    }
    assert.ok(PRICING_HTML.includes("data.payments_enabled === true && data.stripe_configured === true"));
    assert.ok(PRICING_HTML.includes("document.querySelectorAll('.pack-buy-btn').forEach"));
  });
  it('pricing.html: the disclosure block also defaults hidden', () => {
    assert.ok(PRICING_HTML.includes('id="purchase-disclosures" class="purchase-disclosures" style="display:none"'));
  });
  it('dashboard.html: pack rows are built with buttons hidden until checkStripeConfigured() confirms both flags', () => {
    assert.ok(DASHBOARD_HTML.includes("btn.style.display = 'none'; // dark-safe default"));
    assert.ok(DASHBOARD_HTML.includes('_stripeReady = !!(data && data.payments_enabled === true && data.stripe_configured === true)'));
  });
  it('neither page fires a checkout POST from a hidden/unrevealed button (buttons are the only trigger, gated by the same visibility check)', () => {
    // The purchase functions themselves do not re-check stripe_configured (a
    // hidden, undisplayed button cannot be clicked) — the dark-safe invariant
    // is enforced by never revealing the control, asserted above.
    assert.ok(PRICING_HTML.includes('window.auxiloBuyCredits = function'));
    assert.ok(DASHBOARD_HTML.includes('window.auxiloBuyCredits = function'));
  });
});

// ─── 5. /health stripe_configured (spec §7 test 5; superseded by
// CREDITS-CONFIG-USABLE — stripe_configured now means probe-validated
// usable, not merely present. See test/credits-config-usable.test.js for
// the full usability-gate suite; this test just pins the /health wiring.) ──

describe('T5 /health: stripe_configured field', () => {
  it('is derived from getStripeStatus() (usability, not bare presence), plus reason + mode', () => {
    const h = sliceAt(SERVER_SRC, "app.get('/health', (c) => {", 2200);
    assert.ok(h.includes('stripe_configured: stripeStatus.configured,'));
    assert.ok(h.includes('stripe_reason: stripeStatus.reason,'));
    assert.ok(h.includes('stripe_mode: stripeStatus.mode,'));
    assert.ok(h.includes('payments_enabled: paymentsEnabled(),'));
  });
});

// ─── 6. /account/connect-stripe gated behind CUSTODIAL_WITHDRAW_ENABLED ─────
// (spec §7 test 6; the money-paths requireAuth pin for this route already
// exists at test/wave34-scoped-keys.test.js — "money paths remain
// session-only" — not duplicated here. Stripe-gate literal updated for
// CREDITS-CONFIG-USABLE: usability, not getStripe() presence.)

describe('T6 /account/connect-stripe: same paused-rail 503 shape as /withdraw/stripe', () => {
  it('gates on CUSTODIAL_WITHDRAW_ENABLED in addition to (not replacing) the Stripe usability check', () => {
    const h = sliceAt(SERVER_SRC, "app.post('/account/connect-stripe', requireAuth", 1400);
    const custodialIdx = h.indexOf("process.env.CUSTODIAL_WITHDRAW_ENABLED !== 'true'");
    const stripeIdx = h.indexOf('if (!connectStripeStatus.configured)');
    assert.notEqual(custodialIdx, -1, 'connect-stripe must check CUSTODIAL_WITHDRAW_ENABLED');
    assert.notEqual(stripeIdx, -1, 'connect-stripe must still check Stripe usability (in addition to, not instead of)');
    assert.ok(h.includes("code: 'withdraw_paused_noncustodial_migration',"),
      'must return the SAME machine-readable code as /withdraw/stripe');
    assert.ok(h.includes("error: 'Withdrawals temporarily paused during non-custodial migration',"));
  });
  it('the 503 body text is identical to the /withdraw/stripe rail sentinel', () => {
    const withdrawShape = sliceAt(SERVER_SRC, "app.post('/withdraw/stripe', requireAuth", 2200);
    const connectShape = sliceAt(SERVER_SRC, "app.post('/account/connect-stripe', requireAuth", 1400);
    const extractBody = (h) => {
      const m = h.match(/error: 'Withdrawals temporarily paused during non-custodial migration',\s*\n\s*code: 'withdraw_paused_noncustodial_migration',/);
      assert.ok(m, 'expected shape not found');
      return m[0];
    };
    assert.equal(extractBody(withdrawShape), extractBody(connectShape));
  });
});

// ─── 7. POST /checkout/session: Terms gate (GOV-2 A3, blocking) ────────────

describe('T7 /checkout/session: current-Terms-acceptance gate', () => {
  // AUD-CAC (credits-as-cash, 2026-09-27): both spans widened from 2500 to
  // 5200 — the route gained the account-hold check (spec §2 test 16/§8 test
  // 26) and the two purchase caps (spec §2, ruling L6) between pack
  // validation and Stripe-usability/session-creation. The markers, the
  // ordering asserted, and the terms-gate/stripe-usability assertions are
  // all unchanged.
  it('gates on hasAcceptedCurrentTos before pack validation / session creation, after paymentsEnabled', () => {
    const h = sliceAt(SERVER_SRC, "app.post('/checkout/session', requireAuth", 5200);
    const paymentsIdx = h.indexOf('if (!paymentsEnabled())');
    const termsIdx = h.indexOf('if (!hasAcceptedCurrentTos(checkoutAccount))');
    const packIdx = h.indexOf('const { pack } = body');
    const createIdx = h.indexOf('createCheckoutSession(');
    assert.notEqual(paymentsIdx, -1);
    assert.notEqual(termsIdx, -1, 'no existing hasAcceptedCurrentTos gate reached this route before this change');
    assert.ok(paymentsIdx < termsIdx, 'PAYMENTS_ENABLED must be checked first (global kill switch)');
    assert.ok(termsIdx < packIdx, 'Terms gate must precede pack validation');
    assert.ok(packIdx < createIdx);
    assert.ok(h.includes('return termsNotAcceptedResponse(c);'));
  });
  it('gates on Stripe usability (CREDITS-CONFIG-USABLE) after pack validation, before session creation', () => {
    const h = sliceAt(SERVER_SRC, "app.post('/checkout/session', requireAuth", 5200);
    const packIdx = h.indexOf('const { pack } = body');
    const stripeIdx = h.indexOf('if (!stripeStatus.configured)');
    const createIdx = h.indexOf('createCheckoutSession(');
    assert.notEqual(stripeIdx, -1, 'checkout/session must gate on Stripe usability, not presence');
    assert.ok(packIdx < stripeIdx && stripeIdx < createIdx,
      'usability check must run after pack validation and before session creation');
    assert.ok(h.includes("code: 'stripe_unusable',"));
    assert.ok(h.includes('reason: stripeStatus.reason,'));
  });
  // AUD-CAC: the two purchase caps (spec §2, ruling L6) sit between pack
  // validation and the Stripe-usability check, always checked regardless of
  // CREDITS_AS_CASH_ENABLED.
  //
  // FIX-UNIT-MONEY L10: this test (and the ACCOUNT_HELD test below) only
  // ever asserted the REFUSAL BODY'S SOURCE STRING exists somewhere in the
  // route -- an inverted condition (crediting when the cap IS exceeded,
  // refusing when it is NOT) would still pass, which is exactly why M1 was
  // not caught by any pre-existing test. The REAL refusal behavior --
  // BALANCE_CAP_EXCEEDED actually returned by the live route when unpaid
  // pending Checkout sessions push an account over the cap, and
  // ACCOUNT_HELD actually returned when a webhook-race hold is in place,
  // driven through a real staged server with no mocking -- is proved in
  // test/fix-unit-money-webhook.test.js ("[ruling M3] unpaid, unexpired
  // Checkout sessions count toward the pre-check..." and "[ruling M4] the
  // admin route clears an account hold..."). These ordering/wiring checks
  // stay as a fast source-level regression guard for where the checks sit
  // relative to each other, not as the only proof they work.
  it('checks the balance cap and the daily purchase cap after pack validation, before Stripe usability [AUD-CAC]', () => {
    const h = sliceAt(SERVER_SRC, "app.post('/checkout/session', requireAuth", 5200);
    const packIdx = h.indexOf('const { pack } = body');
    const balanceIdx = h.indexOf('checkBalanceCap(accountId, packPrice)');
    const dailyIdx = h.indexOf('checkDailyCap(accountId, packPrice)');
    const stripeIdx = h.indexOf('if (!stripeStatus.configured)');
    assert.notEqual(balanceIdx, -1, 'the balance cap must be checked');
    assert.notEqual(dailyIdx, -1, 'the daily purchase cap must be checked');
    assert.ok(packIdx < balanceIdx && balanceIdx < dailyIdx && dailyIdx < stripeIdx,
      'both caps must be checked after pack validation and before the Stripe usability probe');
    assert.ok(h.includes("code: 'BALANCE_CAP_EXCEEDED',"));
    assert.ok(h.includes("code: 'DAILY_PURCHASE_CAP_EXCEEDED',"));
  });
  it('refuses a held account before pack validation, with a 403 and code ACCOUNT_HELD [AUD-CAC]', () => {
    const h = sliceAt(SERVER_SRC, "app.post('/checkout/session', requireAuth", 5200);
    const termsIdx = h.indexOf('if (!hasAcceptedCurrentTos(checkoutAccount))');
    const heldIdx = h.indexOf('if (isAccountHeld(accountId))');
    const packIdx = h.indexOf('const { pack } = body');
    assert.notEqual(heldIdx, -1, 'the route must check isAccountHeld');
    assert.ok(termsIdx < heldIdx && heldIdx < packIdx, 'the hold check must sit after the Terms gate and before pack validation');
    assert.ok(h.includes("code: 'ACCOUNT_HELD',"));
  });
  // RETIRED (credits-as-cash follow-up, SITE-PM 2026-09-27): 'the flag is
  // read exactly here...' pinned CREDITS_AS_CASH_ENABLED — lib/credits-flag.js
  // is deleted, there is no flag to read. Every checkout session creates a
  // dollar_paid lot unconditionally (test/credits-one-balance.test.js).
});

// ─── 8. /checkout/success + /checkout/cancel: 302, no session_id (STOP gate c) ─

describe('T8 checkout redirects: 302 to /dashboard?checkout=, no session_id, no account data', () => {
  it('/checkout/success redirects with no query-string forwarding', () => {
    const h = sliceAt(SERVER_SRC, "app.get('/checkout/success', (c) => {", 300);
    assert.ok(h.includes("c.redirect('/dashboard?checkout=success', 302);"));
    assert.ok(!h.includes('session_id'), 'the route body itself must not read/forward session_id anymore');
    assert.ok(!h.includes('c.json('), 'must not be the old raw-JSON response');
  });
  it('/checkout/cancel redirects with no query-string forwarding', () => {
    const h = sliceAt(SERVER_SRC, "app.get('/checkout/cancel', (c) => {", 300);
    assert.ok(h.includes("c.redirect('/dashboard?checkout=cancel', 302);"));
    assert.ok(!h.includes('c.json('));
  });
});

// ─── 9. Webhook idempotency re-assert (spec §7 test 9) ──────────────────────

describe('T9 webhook idempotency: isSessionProcessed (unchanged behavior, re-asserted)', () => {
  const { appendPurchase, isSessionProcessed, PURCHASES_FILE } = require('../lib/stripe.js');
  const BACKUP = PURCHASES_FILE + '.credits-control-part1-test-backup';
  let hadOriginal = false;

  before(() => {
    hadOriginal = fs.existsSync(PURCHASES_FILE);
    if (hadOriginal) fs.copyFileSync(PURCHASES_FILE, BACKUP);
  });
  after(() => {
    if (hadOriginal) {
      fs.copyFileSync(BACKUP, PURCHASES_FILE);
      fs.unlinkSync(BACKUP);
    } else if (fs.existsSync(PURCHASES_FILE)) {
      fs.unlinkSync(PURCHASES_FILE);
    }
  });

  it('a session recorded once is reported processed; an unrelated session is not', () => {
    const sid = 'cs_test_ccp1_' + crypto.randomBytes(8).toString('hex');
    assert.equal(isSessionProcessed(sid), false, 'must be false before any record exists');
    appendPurchase({
      id: 'pur_test_ccp1',
      account_id: 'acc_test_ccp1',
      pack_id: 'starter',
      amount_usd: 10,
      queries_added: 400,
      unlocks_added: 80,
      stripe_session_id: sid,
      stripe_payment_intent: null,
      timestamp: new Date().toISOString(),
    });
    assert.equal(isSessionProcessed(sid), true, 'replaying the same session must be recognized as already processed');
    assert.equal(isSessionProcessed('cs_test_unrelated_' + crypto.randomBytes(8).toString('hex')), false);
  });
});

// ─── 10. Dashboard render: no "Queries" column, credits card wired ──────────

describe('T10 dashboard.html: Queries column retired, Credits card wired', () => {
  it('the purchase-history header array no longer includes Queries', () => {
    assert.ok(DASHBOARD_HTML.includes("['Date', 'Pack', 'Amount', 'Unlocks'].forEach"));
    assert.ok(!DASHBOARD_HTML.includes("['Date', 'Pack', 'Amount', 'Queries', 'Unlocks']"));
  });
  it('no qTd / queries_added cell is built in the purchases table', () => {
    const h = sliceAt(DASHBOARD_HTML, 'function renderPurchases(data, el) {', 2200);
    assert.ok(!h.includes('qTd'));
    assert.ok(!h.includes('p.queries_added'), 'no cell must read p.queries_added anymore (a nearby comment may still name the field — that is fine)');
  });
  // RETIRED-AND-REPLACED (credits-as-cash follow-up, SITE-PM 2026-09-27):
  // the old test asserted unlocks_added was STILL returned; F-7 removes it
  // — /account/purchases reports dollars only now.
  it('/account/purchases no longer returns queries_added or unlocks_added — dollars only', () => {
    const h = sliceAt(SERVER_SRC, "app.get('/account/purchases'", 900);
    assert.ok(!h.includes('queries_added'), '/account/purchases must not return queries_added anymore');
    assert.ok(!h.includes('unlocks_added'), '/account/purchases must not return unlocks_added anymore');
    assert.ok(h.includes('amount_usd: p.amount_usd,'), 'the dollar amount is still returned');
  });
  it('loadCredits() is wired into showDashboard()', () => {
    const h = sliceAt(DASHBOARD_HTML, 'function showDashboard(email) {', 600);
    assert.ok(h.includes('loadCredits();'));
  });
  it('the credit balance element sources GET /account/credits, never composes an adjacency to Earnings (GOV-2 A6)', () => {
    assert.ok(DASHBOARD_HTML.includes("apiFetch('/account/credits')"));
    // FIX-UNIT A5b (2026-09-26): .dash-card-title is now an <h2> (was a
    // <div>); the class is unchanged so it still locates each card.
    const earningsIdx = DASHBOARD_HTML.indexOf('<h2 class="dash-card-title">Earnings</h2>');
    const creditsIdx = DASHBOARD_HTML.indexOf('<h2 class="dash-card-title">Balance</h2>');
    assert.notEqual(earningsIdx, -1);
    assert.notEqual(creditsIdx, -1);
    // Separate dash-card blocks, not nested/merged (a distinct </div> closes
    // Earnings before the Credits card opens).
    assert.ok(creditsIdx > earningsIdx);
  });
});

// ─── 11. PACKS pin + conditional doc↔literal cross-check ───────────────────

describe('T11 PACKS pin (80/250/1000) + Terms §7.1 doc↔literal cross-check', () => {
  const { PACKS } = require('../lib/stripe.js');
  // FIX-UNIT-MONEY L8: unlock counts retired -- there is one balance, and a
  // pack adds exactly its price_usd in dollars, nothing else. The three
  // NUMBERS this test pinned (80/250/1000) no longer exist anywhere to pin;
  // what stays pinned is the dollar price and the absence of the field.
  it('no pack carries an unlocks field; prices are pinned', () => {
    for (const id of ['starter', 'growth', 'pro']) {
      assert.equal(Object.prototype.hasOwnProperty.call(PACKS[id], 'unlocks'), false, `PACKS.${id} must not carry unlocks`);
    }
    assert.equal(PACKS.starter.price_usd, 10);
    assert.equal(PACKS.growth.price_usd, 25);
    assert.equal(PACKS.pro.price_usd, 100);
  });
  it('pack cards + dashboard control never hand-type PACKS numbers (rendered from window.__AUXILO_PACKS__ / renderPackData)', () => {
    assert.ok(SERVER_SRC.includes('function renderPackData(html)'));
    assert.ok(SERVER_SRC.includes('html = renderPackData(html);'), 'wired into at least one render path');
    assert.ok(DASHBOARD_HTML.includes('window.__AUXILO_PACKS__'));
  });
  const hasParagraph = /grants 80/.test(TERMS_MD);
  it('IF the §7.1 "what a credit buys" paragraph has shipped, its unlock counts match PACKS (Tyler-gated per spec R2 — dormant until that paragraph lands)',
    { skip: !hasParagraph ? 'Terms §7.1 "what a credit buys" paragraph not yet shipped (R2, Tyler-gated, out of PART 1 scope)' : false },
    () => {
      assert.ok(TERMS_MD.includes('grants 80'));
      assert.ok(TERMS_MD.includes('grants 250'));
      assert.ok(TERMS_MD.includes('grants 1,000') || TERMS_MD.includes('grants 1000'));
    });
});

// ─── 12. payment_method_types pin (spec §7 test 12) ─────────────────────────

describe('T12 payment_method_types pin', () => {
  it("stays ['card'] — the webhook does not check session.payment_status, safe only under card (no delayed-payment methods)", () => {
    assert.ok(STRIPE_LIB_SRC.includes("payment_method_types: ['card'],"));
  });
});

// ─── 13. /terms §7 heading anchor (GOV-2 D8) ────────────────────────────────

describe('T13 legal-page renderer: numbered ## headings get id="section-N"', () => {
  it('the heading-id rule is present ahead of the old bare <h2> replace', () => {
    const h = sliceAt(SERVER_SRC, "function serveLegalPage(", 12600);
    assert.ok(h.includes('`section-${numMatch[1]}`'));
    assert.ok(h.includes('const numMatch = text.match(/^(\\d+)\\./)'));
    assert.ok(h.includes('return `<h2 id="${id}">${text}</h2>`;'));
  });
  it('docs/TERMS-OF-SERVICE.md carries a "## 7." heading for the rule to anchor (D8 precondition)', () => {
    assert.match(TERMS_MD, /^## 7\. /m);
  });
});

// ─── 14. Behavioral: real server boot (shared staged-server harness) ───────
// Covers, against the REAL running app (no mocked Stripe — the assertions
// below only exercise paths that never reach a live Stripe network call):
//   - GET /health: stripe_configured=false by default, payments_enabled=true
//   - GET /terms: id="section-7" actually renders from the real docs/ file
//   - GET /checkout/success + /checkout/cancel: real 302 + Location header
//   - POST /checkout/session: Terms-accepted account still 503s dark-safe
//     (Stripe unconfigured) BEFORE any side effect; Terms-unaccepted account
//     gets 403 before ever reaching the Stripe check (gate ordering, live)
//   - POST /account/connect-stripe: real 503 paused-rail body

describe('T14 behavioral: real server boot', () => {
  it('health/terms/redirects/checkout-session/connect-stripe all behave dark-safe on a live boot', { timeout: 90_000 }, async (t) => {
    let nodeModulesDir;
    try {
      const honoEntry = require.resolve('hono', { paths: [REPO_ROOT] });
      nodeModulesDir = honoEntry.slice(
        0,
        honoEntry.lastIndexOf(`${path.sep}node_modules${path.sep}`) + '/node_modules'.length
      );
    } catch {
      t.skip('hono not resolvable from repo root — skipping real boot (structural guards above remain enforcing)');
      return;
    }
    const reservation = await reservePort();
    if (reservation.skipReason) {
      t.skip(reservation.skipReason);
      return;
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auxilo-ccp1-'));
    let child = null;
    let baseUrl;
    try {
      stageServer({
        repoRoot: REPO_ROOT,
        tmpDir,
        nodeModulesDir,
        port: reservation.port,
        rootFiles: ['server.js', 'seed-knowledge.json', 'skills.json', 'openapi.json', 'package.json', 'model_config.json'],
        linkDirs: ['lib', 'public', 'prompts', 'config', 'docs'],
        replacements: [],
      });

      const now = new Date().toISOString();
      const ACCT_ACCEPTED = 'acc_ccp1_accepted';
      const ACCT_NO_TERMS = 'acc_ccp1_noterms';
      const accounts = {
        [ACCT_ACCEPTED]: {
          id: ACCT_ACCEPTED,
          email: 'ccp1-accepted@test.local',
          created_at: now,
          tos_version: CURRENT_TOS_VERSION,
          accepted_at: now,
        },
        [ACCT_NO_TERMS]: {
          id: ACCT_NO_TERMS,
          email: 'ccp1-noterms@test.local',
          created_at: now,
        },
      };
      fs.writeFileSync(path.join(tmpDir, 'data', 'learnings.json'), JSON.stringify([], null, 2));
      fs.writeFileSync(path.join(tmpDir, 'data', 'accounts.json'), JSON.stringify(accounts, null, 2));

      const secret = process.env.SESSION_SECRET;
      const jwtFor = (accountId, email) => new SignJWT({ accountId, email })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .setExpirationTime('24h')
        .sign(Buffer.from(secret));

      const tokenAccepted = await jwtFor(ACCT_ACCEPTED, accounts[ACCT_ACCEPTED].email);
      const tokenNoTerms = await jwtFor(ACCT_NO_TERMS, accounts[ACCT_NO_TERMS].email);

      const boot = await bootServer({
        tmpDir,
        port: reservation.port,
        env: {
          NODE_ENV: 'test',
          WALLET_PRIVATE_KEY: '0x' + '11'.repeat(32),
          SESSION_SECRET: secret,
          AUXILO_DATA_DIR: path.join(tmpDir, 'data'),
          AUXILO_ACCOUNTS_FILE: path.join(tmpDir, 'data', 'accounts.json'),
          // Deliberately absent: STRIPE_SECRET_KEY, CUSTODIAL_WITHDRAW_ENABLED
          // — this boot proves the dark-safe defaults.
        },
        timeoutMs: 60_000,
        maxAttempts: 3,
      });
      if (boot.skipReason) {
        t.skip(boot.skipReason);
        return;
      }
      child = boot.child;
      baseUrl = boot.baseUrl;

      // ── /health ──────────────────────────────────────────────────────
      const health = await (await fetch(`${baseUrl}/health`)).json();
      assert.equal(health.stripe_configured, false, 'no STRIPE_SECRET_KEY in this boot');
      assert.equal(health.payments_enabled, true, 'PAYMENTS_ENABLED default-on');

      // ── /terms: real heading-id render (D8) ─────────────────────────
      const termsHtml = await (await fetch(`${baseUrl}/terms`)).text();
      assert.ok(termsHtml.includes('id="section-7"'), '§7 heading must carry the anchor the D8 link targets');

      // ── /checkout/success + /checkout/cancel: real 302, no session_id ──
      const successRes = await fetch(`${baseUrl}/checkout/success?session_id=cs_test_should_not_survive`, { redirect: 'manual' });
      assert.equal(successRes.status, 302);
      const successLoc = successRes.headers.get('location');
      assert.equal(successLoc, '/dashboard?checkout=success');
      assert.ok(!successLoc.includes('session_id'), 'no session_id must survive into the redirect target');

      const cancelRes = await fetch(`${baseUrl}/checkout/cancel`, { redirect: 'manual' });
      assert.equal(cancelRes.status, 302);
      assert.equal(cancelRes.headers.get('location'), '/dashboard?checkout=cancel');

      // ── POST /checkout/session: Terms-unaccepted account → 403 before any Stripe check ──
      const noTermsRes = await fetch(`${baseUrl}/checkout/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenNoTerms}` },
        body: JSON.stringify({ pack: 'starter' }),
      });
      assert.equal(noTermsRes.status, 403);
      const noTermsBody = await noTermsRes.json();
      assert.equal(noTermsBody.code, 'TERMS_NOT_ACCEPTED');

      // ── POST /checkout/session: invalid pack, Terms-accepted account → 400, valid_packs[] carries no "queries" (micro-fix should-fix 1) ──
      const badPackRes = await fetch(`${baseUrl}/checkout/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenAccepted}` },
        body: JSON.stringify({ pack: 'not-a-real-pack' }),
      });
      assert.equal(badPackRes.status, 400);
      const badPackBody = await badPackRes.json();
      assert.equal(badPackBody.error, 'Invalid pack');
      assert.ok(Array.isArray(badPackBody.valid_packs) && badPackBody.valid_packs.length > 0);
      for (const p of badPackBody.valid_packs) {
        assert.ok(!Object.prototype.hasOwnProperty.call(p, 'queries'), `valid_packs[] entry must not carry "queries": ${JSON.stringify(p)}`);
        assert.ok(Object.prototype.hasOwnProperty.call(p, 'id'));
        // FIX-UNIT-MONEY L8: unlocks retired -- a pack adds dollars only.
        assert.ok(!Object.prototype.hasOwnProperty.call(p, 'unlocks'), `valid_packs[] entry must not carry "unlocks": ${JSON.stringify(p)}`);
        assert.ok(Object.prototype.hasOwnProperty.call(p, 'price_usd'));
      }

      // ── POST /checkout/session: Terms-accepted account, Stripe unconfigured → 503 dark-safe ──
      const acceptedRes = await fetch(`${baseUrl}/checkout/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenAccepted}` },
        body: JSON.stringify({ pack: 'starter' }),
      });
      assert.equal(acceptedRes.status, 503, 'a Terms-accepted account must still be refused while Stripe is unconfigured — STOP gate e');
      const acceptedBody = await acceptedRes.json();
      assert.equal(acceptedBody.error, 'Payment system unavailable');

      // ── POST /account/connect-stripe: real paused-rail 503 ──────────
      const connectRes = await fetch(`${baseUrl}/account/connect-stripe`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokenAccepted}` },
      });
      assert.equal(connectRes.status, 503);
      const connectBody = await connectRes.json();
      assert.equal(connectBody.code, 'withdraw_paused_noncustodial_migration');

      // ── No purchase button in the served /pricing HTML markup baseline ──
      // (the button exists but is display:none by default — proven at the
      // markup level in T4; here we confirm the SERVED page, not just the
      // repo file, carries the same hidden default.)
      const pricingHtml = await (await fetch(`${baseUrl}/pricing`)).text();
      assert.ok(pricingHtml.includes('pack-buy-btn') && pricingHtml.includes('style="display:none"'));
    } finally {
      if (child) await stopServer(child);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ─── 15. auxiloBuyCredits: TERMS_NOT_ACCEPTED routes to the terms gate, not
// a dead-end alert (micro-fix should-fix 2, source-level — inline <script>
// functions with no module export, same constraint noted in the file header) ─

describe('T15 auxiloBuyCredits: TERMS_NOT_ACCEPTED 403 routes to the terms-gate clickwrap', () => {
  it('dashboard.html: reveals #terms-gate and focuses its checkbox before falling through to the generic alert', () => {
    const h = sliceAt(DASHBOARD_HTML, 'window.auxiloBuyCredits = function (packId, btn) {', 1600);
    const codeCheckIdx = h.indexOf("res.data.code === 'TERMS_NOT_ACCEPTED'");
    const showGateIdx = h.indexOf("show('terms-gate')");
    const focusIdx = h.indexOf("getElementById('terms-agree-check')");
    const returnIdx = h.indexOf('return;', focusIdx);
    const genericAlertIdx = h.indexOf("showAlert('dash-alert', (res.data && res.data.error)");
    assert.notEqual(codeCheckIdx, -1, 'handler must branch on the TERMS_NOT_ACCEPTED code');
    assert.notEqual(showGateIdx, -1, 'handler must reveal #terms-gate');
    assert.notEqual(focusIdx, -1, 'handler must focus the terms-gate checkbox');
    assert.ok(codeCheckIdx < showGateIdx && showGateIdx < focusIdx, 'code check must precede reveal must precede focus');
    assert.notEqual(returnIdx, -1, 'the TERMS_NOT_ACCEPTED branch must return before falling through');
    assert.ok(genericAlertIdx === -1 || returnIdx < genericAlertIdx, 'a TERMS_NOT_ACCEPTED response must never reach the generic dash-alert');
  });

  it('pricing.html: redirects to /dashboard#terms-gate instead of calling window.alert on TERMS_NOT_ACCEPTED', () => {
    const h = sliceAt(PRICING_HTML, 'window.auxiloBuyCredits = function (packId) {', 1600);
    const codeCheckIdx = h.indexOf("res.data.code === 'TERMS_NOT_ACCEPTED'");
    const redirectIdx = h.indexOf("window.location = '/dashboard#terms-gate'");
    const returnIdx = h.indexOf('return;', redirectIdx);
    const genericAlertIdx = h.indexOf('window.alert((res.data && res.data.error)');
    assert.notEqual(codeCheckIdx, -1, 'handler must branch on the TERMS_NOT_ACCEPTED code');
    assert.notEqual(redirectIdx, -1, 'handler must redirect to the dashboard terms gate (no new strings)');
    assert.ok(codeCheckIdx < redirectIdx);
    assert.notEqual(returnIdx, -1, 'the TERMS_NOT_ACCEPTED branch must return before falling through');
    assert.ok(genericAlertIdx === -1 || returnIdx < genericAlertIdx, 'a TERMS_NOT_ACCEPTED response must never reach window.alert');
  });

  it('the dashboard #terms-gate card (~:673) still exists with the checkbox this handler focuses', () => {
    assert.ok(DASHBOARD_HTML.includes('id="terms-gate"'));
    assert.ok(DASHBOARD_HTML.includes('id="terms-agree-check"'));
  });
});

// ─── 16. CREDITS-QUERIES-RESIDUAL: query credits fully retired ──────────────
// Nothing ever spent query credits — deductCredit()'s only caller
// (dualAuthDynamic) has always passed 'unlock' exclusively. This closes the
// grant side: packs no longer mint queries, the webhook no longer forwards
// them, and the API/receipt surfaces stop mentioning them. Ledger fields
// (purchased_queries/queries_used) stay in the record shape — see
// test/credits.test.js for the reader-tolerance coverage of legacy records.

describe('T16 CREDITS-QUERIES-RESIDUAL: packs grant dollars only', () => {
  // FIX-UNIT-MONEY L8: packs no longer grant unlocks either -- there is one
  // balance, and a pack adds exactly its price_usd in dollars.
  it('lib/stripe.js PACKS: no pack defines a queries field, or an unlocks field, anymore', () => {
    const packsBlock = sliceAt(STRIPE_LIB_SRC, 'const PACKS = {', 700);
    assert.ok(!/queries:\s*\d+/.test(packsBlock), 'no PACKS entry may carry a queries count');
    assert.ok(!/unlocks:\s*\d+/.test(packsBlock), 'no PACKS entry may carry an unlocks count');
    assert.ok(/price_usd:\s*10/.test(packsBlock) && /price_usd:\s*25/.test(packsBlock) && /price_usd:\s*100/.test(packsBlock),
      'dollar prices must be untouched');
  });

  // RETIRED (credits-as-cash follow-up, SITE-PM 2026-09-27): 'the webhook no
  // longer destructures/parses pack_queries and always passes 0 to
  // addPurchasedCredits (unit-lot branch)' pinned the retired unit-lot
  // webhook branch — addPurchasedCredits is deleted; the webhook always
  // calls addDollarLot (test/credits-one-balance.test.js).
  it('the webhook no longer destructures/parses pack_queries', () => {
    const h = sliceAt(SERVER_SRC, "event.type === 'checkout.session.completed'", 2800);
    assert.ok(!h.includes('pack_queries'), 'pack_queries must not be read from the webhook metadata anymore');
  });

  // RETIRED (credits-as-cash follow-up): 'the purchase record written to
  // purchases.jsonl no longer carries queries_added' asserted unlocks_added
  // was STILL present; F-7 removes it too — a purchase record carries the
  // dollar amount only.
  it('the purchase record written to purchases.jsonl carries no unit field, dollars only', () => {
    const h = sliceAt(SERVER_SRC, 'const purchase = {', 400);
    assert.ok(!h.includes('queries_added'), 'new purchase records must not carry queries_added');
    assert.ok(!h.includes('unlocks_added'), 'new purchase records must not carry unlocks_added');
    assert.ok(h.includes('amount_usd: PACKS[pack_id]?.price_usd || 0,'));
  });

  // RETIRED (credits-as-cash follow-up): 'the credited-account server log
  // line no longer mentions queries' pinned the old "+N unlocks" log
  // wording — a purchase credits a dollar amount now, not an unlock count.
  it('the credited-account server log line reports the dollar amount, never queries or unlocks', () => {
    const h = sliceAt(SERVER_SRC, '[stripe] Credited account', 200);
    assert.ok(!/queries/i.test(h), 'the log line must not claim a queries grant anymore');
    assert.ok(!/unlocks/i.test(h), 'the log line must not claim an unlocks grant anymore');
    assert.ok(h.includes('+$${(PACKS[pack_id]?.price_usd || 0).toFixed(2)} (${pack_id})'),
      'the log line must report the dollar amount and pack id');
  });

  // RETIRED (credits-as-cash follow-up): the old test asserted
  // Purchase.unlocks_added STILL existed in openapi.json; F-7/F-8 remove it
  // — the purchase schema now matches the dollars-only response.
  //
  // FIX-UNIT-MONEY L9: CreditPack.unlocks is ALSO removed now (it used to
  // "remain" because packs still granted a unit count) -- a pack adds
  // dollars only.
  it('openapi.json: CreditPack has no "queries" or "unlocks" property, and Purchase has no queries_added or unlocks_added property', () => {
    const openapi = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'openapi.json'), 'utf-8'));
    const creditPack = openapi.components.schemas.CreditPack.properties;
    const purchase = openapi.components.schemas.Purchase.properties;
    assert.ok(!Object.prototype.hasOwnProperty.call(creditPack, 'queries'), 'CreditPack.queries must be removed');
    assert.ok(!Object.prototype.hasOwnProperty.call(creditPack, 'unlocks'), 'CreditPack.unlocks must be removed');
    assert.ok(!Object.prototype.hasOwnProperty.call(purchase, 'queries_added'), 'Purchase.queries_added must be removed');
    assert.ok(!Object.prototype.hasOwnProperty.call(purchase, 'unlocks_added'), 'Purchase.unlocks_added must be removed');
  });

  it('lib/credits.js: deductCredit() rejects creditType "query" (real behavior, not just source)', async () => {
    const { deductCredit: realDeductCredit } = require('../lib/credits.js');
    const r = await realDeductCredit('acc_test_ccp1_residual_' + crypto.randomBytes(6).toString('hex'), 'query');
    assert.equal(r.success, false, 'query credits are retired — deductCredit must reject the type outright');
  });
});
