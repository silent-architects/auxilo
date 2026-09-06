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
  it('/account/credits description reads "View unlock credit balance" (both occurrences)', () => {
    const matches = SERVER_SRC.match(/View unlock credit balance for the authenticated account/g) || [];
    assert.equal(matches.length, 2, 'both /skills-manifest occurrences must carry the fixed string');
  });
  it('/checkout/session manifest body field is { pack }, not { pack_id } (both occurrences)', () => {
    assert.ok(!SERVER_SRC.includes('Body: { pack_id }'),
      'the manifest must not advertise a body field the route does not read');
    const matches = SERVER_SRC.match(/Create a Stripe checkout session to purchase credits\. Body: \{ pack \}/g) || [];
    assert.equal(matches.length, 2, 'both /skills-manifest occurrences must advertise { pack }');
  });
  it('the route itself destructures { pack } (manifest matches reality)', () => {
    const h = sliceAt(SERVER_SRC, "app.post('/checkout/session'", 1400);
    assert.ok(h.includes('const { pack } = body'));
  });
});

// ─── 2. lib/stripe.js: description fix + consent_collection (spec §3 req 2, 10) ─

describe('T2 lib/stripe.js: Checkout description + consent_collection (source)', () => {
  it('product_data.description no longer references queries', () => {
    assert.ok(!STRIPE_LIB_SRC.includes('${pack.queries} queries'),
      'the false "queries" claim must not reach Stripe\'s hosted page/receipt');
    assert.ok(STRIPE_LIB_SRC.includes('description: `${pack.unlocks} unlocks`'));
  });
  it('consent_collection.terms_of_service is required on the Session', () => {
    assert.ok(STRIPE_LIB_SRC.includes("consent_collection: { terms_of_service: 'required' }"));
  });
  it('unit_amount and metadata stay byte-unchanged (display-string fix only, not a data-model change)', () => {
    assert.ok(STRIPE_LIB_SRC.includes('unit_amount: pack.price_cents,'));
    assert.ok(STRIPE_LIB_SRC.includes("pack_queries: String(pack.queries),"));
    assert.ok(STRIPE_LIB_SRC.includes("pack_unlocks: String(pack.unlocks),"));
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

  it('the captured Stripe call carries consent_collection + a queries-free description (spec test 3, 7)', () => {
    assert.ok(capturedArgs, 'checkout.sessions.create must have been called');
    assert.deepEqual(capturedArgs.consent_collection, { terms_of_service: 'required' });
    const desc = capturedArgs.line_items[0].price_data.product_data.description;
    assert.ok(!/queries/i.test(desc), `description must not mention queries: "${desc}"`);
    assert.ok(/unlocks/i.test(desc), `description must state the unlock count: "${desc}"`);
    assert.equal(desc, '80 unlocks');
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

// ─── 5. /health stripe_configured (spec §7 test 5) ──────────────────────────

describe('T5 /health: stripe_configured field', () => {
  it('is present, derived from STRIPE_SECRET_KEY presence, boolean-coerced', () => {
    const h = sliceAt(SERVER_SRC, "app.get('/health', (c) => {", 1500);
    assert.ok(h.includes('stripe_configured: !!process.env.STRIPE_SECRET_KEY,'));
    assert.ok(h.includes('payments_enabled: paymentsEnabled(),'));
  });
});

// ─── 6. /account/connect-stripe gated behind CUSTODIAL_WITHDRAW_ENABLED ─────
// (spec §7 test 6; the money-paths requireAuth pin for this route already
// exists at test/wave34-scoped-keys.test.js — "money paths remain
// session-only" — not duplicated here.)

describe('T6 /account/connect-stripe: same paused-rail 503 shape as /withdraw/stripe', () => {
  it('gates on CUSTODIAL_WITHDRAW_ENABLED in addition to (not replacing) getStripe()', () => {
    const h = sliceAt(SERVER_SRC, "app.post('/account/connect-stripe', requireAuth", 1200);
    const custodialIdx = h.indexOf("process.env.CUSTODIAL_WITHDRAW_ENABLED !== 'true'");
    const stripeIdx = h.indexOf('if (!getStripe())');
    assert.notEqual(custodialIdx, -1, 'connect-stripe must check CUSTODIAL_WITHDRAW_ENABLED');
    assert.notEqual(stripeIdx, -1, 'connect-stripe must still check getStripe() (in addition to, not instead of)');
    assert.ok(h.includes("code: 'withdraw_paused_noncustodial_migration',"),
      'must return the SAME machine-readable code as /withdraw/stripe');
    assert.ok(h.includes("error: 'Withdrawals temporarily paused during non-custodial migration',"));
  });
  it('the 503 body text is identical to the /withdraw/stripe rail sentinel', () => {
    const withdrawShape = sliceAt(SERVER_SRC, "app.post('/withdraw/stripe', requireAuth", 1500);
    const connectShape = sliceAt(SERVER_SRC, "app.post('/account/connect-stripe', requireAuth", 1200);
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
  it('gates on hasAcceptedCurrentTos before pack validation / session creation, after paymentsEnabled', () => {
    const h = sliceAt(SERVER_SRC, "app.post('/checkout/session', requireAuth", 1800);
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
  it('queries_added stays in the API response contract and purchases.jsonl (data model untouched)', () => {
    assert.ok(SERVER_SRC.includes('queries_added: p.queries_added,'), '/account/purchases must still return it');
  });
  it('loadCredits() is wired into showDashboard()', () => {
    const h = sliceAt(DASHBOARD_HTML, 'function showDashboard(email) {', 600);
    assert.ok(h.includes('loadCredits();'));
  });
  it('the credit balance element sources GET /account/credits, never composes an adjacency to Earnings (GOV-2 A6)', () => {
    assert.ok(DASHBOARD_HTML.includes("apiFetch('/account/credits')"));
    const earningsIdx = DASHBOARD_HTML.indexOf('<div class="dash-card-title">Earnings</div>');
    const creditsIdx = DASHBOARD_HTML.indexOf('<div class="dash-card-title">Credits</div>');
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
  it('the three unlock counts are pinned', () => {
    assert.equal(PACKS.starter.unlocks, 80);
    assert.equal(PACKS.growth.unlocks, 250);
    assert.equal(PACKS.pro.unlocks, 1000);
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
        assert.ok(Object.prototype.hasOwnProperty.call(p, 'unlocks'));
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
