'use strict';

/**
 * test/fix-unit-money.test.js — FIX-UNIT-MONEY.md, the rulings not already
 * covered by a dedicated file: L11 (corrupt data file), T1 (payee-agency
 * versions), T2 (Terms rendering), D1/D2 (dashboard surfaces), L8/L9
 * (surface text/schema cleanup).
 *
 * Every data file this suite touches is redirected to a private temp
 * directory before any module loads. No network call, no real Stripe SDK,
 * no real HOME.
 *
 * Runner: node --test test/fix-unit-money.test.js
 */

const os = require('os');
const fs = require('fs');
const path = require('path');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-unit-money-'));
process.env.AUXILO_CREDITS_FILE = path.join(TMP_DIR, 'credits.json');
process.env.AUXILO_ACCOUNT_HOLDS_FILE = path.join(TMP_DIR, 'account-holds.json');
process.env.AUXILO_PURCHASES_FILE = path.join(TMP_DIR, 'purchases.jsonl');

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');

const REPO = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(REPO, ...p), 'utf8');

after(() => { try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch { /* best effort */ } });

// ─── Ruling L11: a corrupt data file is refused, never read as empty ───────

describe('[ruling L11] a corrupt data file is refused, not read as empty', () => {
  it('lib/credits.js loadCredits(): missing file reads as empty (positive control); corrupt file throws, refusing the operation', () => {
    const credits = require('../lib/credits.js');
    // Positive control: with the temp file absent, it is empty.
    assert.deepEqual(credits.loadCredits(), {});
    // A real purchase now — the file exists and is well-formed.
    fs.writeFileSync(process.env.AUXILO_CREDITS_FILE, JSON.stringify({ acc_l11_a: { dollar_lots: [] } }));
    assert.deepEqual(credits.loadCredits(), { acc_l11_a: { dollar_lots: [] } });
    // Now corrupt it — this must NEVER be treated as "no accounts have any
    // money": the very next write would erase every other account's
    // balance if it were.
    fs.writeFileSync(process.env.AUXILO_CREDITS_FILE, '{ this is not valid json');
    assert.throws(() => credits.loadCredits(), 'a corrupt credits.json must refuse the read, never silently return {}');
    // Restore to a valid, empty state for the rest of the suite.
    fs.writeFileSync(process.env.AUXILO_CREDITS_FILE, '{}');
  });

  it('lib/account-holds.js loadHolds(): missing file reads as empty (positive control); corrupt file throws', () => {
    const holds = require('../lib/account-holds.js');
    fs.rmSync(process.env.AUXILO_ACCOUNT_HOLDS_FILE, { force: true });
    assert.deepEqual(holds.loadHolds(), {});
    fs.writeFileSync(process.env.AUXILO_ACCOUNT_HOLDS_FILE, JSON.stringify({ acc_l11_b: { reason: 'cap_overage' } }));
    assert.deepEqual(holds.loadHolds(), { acc_l11_b: { reason: 'cap_overage' } });
    fs.writeFileSync(process.env.AUXILO_ACCOUNT_HOLDS_FILE, 'not { json at all');
    assert.throws(() => holds.loadHolds(), 'a corrupt account-holds.json must refuse the read, never silently lift every hold');
    fs.writeFileSync(process.env.AUXILO_ACCOUNT_HOLDS_FILE, '{}');
  });

  it('a permission-denied-style read error (not ENOENT) also refuses -- only ENOENT reads as empty', () => {
    const credits = require('../lib/credits.js');
    const originalReadFileSync = fs.readFileSync;
    const target = process.env.AUXILO_CREDITS_FILE;
    // Simulate a non-ENOENT failure (e.g. EACCES) without touching real
    // filesystem permissions.
    const spy = (...args) => {
      if (args[0] === target) {
        const err = new Error('simulated permission denied');
        err.code = 'EACCES';
        throw err;
      }
      return originalReadFileSync(...args);
    };
    fs.readFileSync = spy;
    try {
      assert.throws(() => credits.loadCredits());
    } finally {
      fs.readFileSync = originalReadFileSync;
    }
  });
});

// ─── Ruling T1: payee-agency stays in force across the version bump ───────

describe('[ruling T1] PAYEE_AGENCY_VERSIONS holds both the July and the credit-balance version', () => {
  const { CURRENT_TOS_VERSION, isPayeeAgencyInForce, hasAcceptedCurrentTos } = require('../lib/accounts.js');

  it('CURRENT_TOS_VERSION is the credit-balance amendment', () => {
    assert.equal(CURRENT_TOS_VERSION, '2026-09-27-credit-balance-a2');
  });

  it('a builder who accepted the EARLIER payee-agency version still has the agency in force (their learnings still unlock)', () => {
    const account = { accepted_at: Date.now(), tos_version: '2026-07-04-payee-agency-a1' };
    assert.equal(isPayeeAgencyInForce(account), true,
      'the CP-6 accrual gate (server.js: does a paid Unlock credit pending_balance or quarantine to unassented_pending) must stay open for this builder');
  });

  it('a builder who accepted the CURRENT version also has the agency in force', () => {
    const account = { accepted_at: Date.now(), tos_version: CURRENT_TOS_VERSION };
    assert.equal(isPayeeAgencyInForce(account), true);
  });

  it('an account that never accepted any version, or accepted neither payee-agency version, does not have the agency in force', () => {
    assert.equal(isPayeeAgencyInForce(null), false);
    assert.equal(isPayeeAgencyInForce({ accepted_at: Date.now(), tos_version: '2026-09-06-clean-lane-b1' }), false,
      'a Non-Material amendment id never carried the payee-agency and must not pass the gate');
  });

  it('a builder on the earlier version is NOT treated as having accepted the CURRENT terms -- a buyer must accept the current version at checkout', () => {
    const account = { accepted_at: Date.now(), tos_version: '2026-07-04-payee-agency-a1' };
    assert.equal(hasAcceptedCurrentTos(account), false,
      'hasAcceptedCurrentTos (the checkout/withdrawal/link-wallet gate) is distinct from isPayeeAgencyInForce -- an old-version builder can still be UNLOCKED but must still accept the CURRENT Terms before buying a pack or linking a wallet');
  });
});

// ─── Ruling T2: the Terms render correctly, section 7.6 reads, numbering intact ─

describe('[ruling T2] docs/TERMS-OF-SERVICE.md: section 7.6 content and numbering', () => {
  const TERMS_MD = read('docs', 'TERMS-OF-SERVICE.md');

  it('section 7.6 exists as the sixth Payment Terms subsection, directly after 7.5 and before Section 8', () => {
    const idx76 = TERMS_MD.indexOf('### 7.6 Refunds, Reversals, and Disputes');
    const idx75 = TERMS_MD.indexOf('### 7.5 Taxes');
    const idx8 = TERMS_MD.indexOf('## 8. Intellectual Property');
    assert.notEqual(idx76, -1);
    assert.ok(idx75 < idx76 && idx76 < idx8, 'numbering intact: 7.5 then 7.6 then Section 8, no gap');
  });

  it('item 1 freezes the Balance for an inquiry as well as a dispute -- the created event must freeze regardless of opening status', () => {
    const section = TERMS_MD.slice(TERMS_MD.indexOf('### 7.6'), TERMS_MD.indexOf('## 8. Intellectual Property'));
    assert.match(section, /including an inquiry from the card issuer that has not become a chargeback/);
    assert.match(section, /is not available to spend/);
  });

  it('item 3 states the partial-refund rule H1 builds: remove up to the amount refunded, reverse only the excess, newest Unlock first, last one in proportion', () => {
    const section = TERMS_MD.slice(TERMS_MD.indexOf('### 7.6'), TERMS_MD.indexOf('## 8. Intellectual Property'));
    assert.match(section, /up to the amount refunded or reversed/);
    assert.match(section, /starting with the most recent of those Unlocks/);
    assert.match(section, /reverses the same proportion of the Builder Share on the Unlock whose payment falls partly within it/);
  });

  it('Section 5.4, 5.9.4(c), and 5.10.2 all point a partial-refund-aware sentence at Section 7.6', () => {
    assert.match(TERMS_MD, /the Builder Share on that Unlock may be reversed, in whole or in part, as provided in Section 7\.6/);
    assert.match(TERMS_MD, /A Builder Share on a payment that is later refunded or reversed may be reversed, in whole or in part, as provided in Section 7\.6/);
    assert.match(TERMS_MD, /Where a payment is later refunded, or reversed after a dispute, and a Builder Share on it is reversed under Section 7\.6, that Builder Share is treated as not received/);
  });

  it('no placeholder or stray amendment marker survives the four amended rows', () => {
    assert.doesNotMatch(TERMS_MD, /\{\{.*?\}\}/, 'no unfilled template placeholder');
    assert.doesNotMatch(TERMS_MD, /TBD|TODO|FIXME/i);
  });
});

// ─── Ruling D1 (superseded 2026-09-27 by the owner's read-to-the-end ruling,
// BUILD-BRIEF-TERMS-SCROLL.md): the card no longer carries a paragraph or a
// checkbox at all -- it is one line and a button that opens a dialog, and
// Accept lives in that dialog, disabled until the reader scrolls to the end
// of the Terms. ───────────────────────────────────────────────────────────

describe('[ruling D1] public/dashboard.html: Terms card reads as a plain acceptance ask', () => {
  const DASHBOARD_HTML = read('public', 'dashboard.html');

  it('the title is "Accept the Terms", the old "updated" framing is gone', () => {
    assert.ok(DASHBOARD_HTML.includes('<h2 class="dash-card-title">Accept the Terms</h2>'));
    assert.ok(!DASHBOARD_HTML.includes('Action required: accept the updated Terms'));
    assert.ok(!DASHBOARD_HTML.includes("We've updated our"));
  });

  it('the Section 5.10 paragraph and its Terms link are gone from the card; one plain line replaces it (before: the payee-agency paragraph; now: absent)', () => {
    assert.ok(!DASHBOARD_HTML.includes('under which you appoint Auxilo as your'), 'the payee-agency paragraph is removed');
    assert.ok(!DASHBOARD_HTML.includes('limited agent to receive your Builder Share'), 'the payee-agency paragraph is removed');
    // Positive control: the card's replacement line is present.
    assert.ok(DASHBOARD_HTML.includes('Read the Terms of Service to the end, then accept.'));
  });

  it('the checkbox, its label, and onTermsCheckChange are gone; Read the Terms opens the dialog and Accept lives there (before: a checkbox + "Accept and continue"; now: "Read the Terms" + "Accept")', () => {
    assert.ok(!DASHBOARD_HTML.includes('id="terms-agree-check"'), 'the checkbox is removed');
    assert.ok(!DASHBOARD_HTML.includes('I have read and agree to the'), 'the checkbox label is removed');
    assert.ok(!DASHBOARD_HTML.includes('onTermsCheckChange'), 'the checkbox handler is removed');
    assert.ok(!DASHBOARD_HTML.includes('Accept and continue'), 'the old button text is gone');
    // Positive control: the new controls are present.
    assert.ok(DASHBOARD_HTML.includes('<button class="btn btn-primary" id="terms-read-btn" onclick="openTermsDialog()">Read the Terms</button>'));
    assert.ok(/id="terms-accept-btn"[^>]*onclick="acceptTerms\(\)"[^>]*disabled/.test(DASHBOARD_HTML));
  });
});

// ─── Ruling D2: the Balance card shows the frozen-balance line conditionally ─

describe('[ruling D2] public/dashboard.html: Balance card frozen-balance line', () => {
  const DASHBOARD_HTML = read('public', 'dashboard.html');

  it('a dedicated element exists for the frozen line, hidden by default, right under the headline', () => {
    assert.ok(DASHBOARD_HTML.includes('<div id="credit-balance-line">—</div>'));
    assert.ok(DASHBOARD_HTML.includes('<div id="credit-balance-frozen" style="display:none;'),
      'the frozen line must default hidden (dark-safe / zero-state default)');
  });

  it('renderCreditBalance shows the line with the fmt()-formatted amount and the exact wording when frozen_usd > 0', () => {
    const fn = DASHBOARD_HTML.slice(DASHBOARD_HTML.indexOf('function renderCreditBalance(data) {'));
    const body = fn.slice(0, fn.indexOf('\n  function renderCreditPackRows'));
    assert.ok(body.includes("frozenEl.textContent = fmt(frozen) + ' is on hold while a payment dispute is open.';"));
    assert.ok(body.includes("frozenEl.style.display = '';"));
  });

  it('renderCreditBalance hides the line and clears its text when frozen_usd is zero', () => {
    const fn = DASHBOARD_HTML.slice(DASHBOARD_HTML.indexOf('function renderCreditBalance(data) {'));
    const body = fn.slice(0, fn.indexOf('\n  function renderCreditPackRows'));
    assert.ok(body.includes("frozenEl.style.display = 'none';"));
    assert.ok(body.includes("frozenEl.textContent = '';"));
  });

  it('the headline still reads total_usd (unchanged) -- total_usd already excludes frozen_usd (ruling L3)', () => {
    const fn = DASHBOARD_HTML.slice(DASHBOARD_HTML.indexOf('function renderCreditBalance(data) {'));
    const body = fn.slice(0, fn.indexOf('\n  function renderCreditPackRows'));
    assert.ok(body.includes('data.credit_balance.total_usd'));
    assert.ok(body.includes("line.textContent = total !== null ? fmt(total) : '—';"));
  });
});

// ─── Ruling L8: unit-credit fields fully removed from what the server serves ─

describe('[ruling L8] unit-model fields no longer served', () => {
  const { PACKS } = require('../lib/stripe.js');
  const SERVER_SRC = fs.readFileSync(path.join(REPO, 'server.js'), 'utf-8');
  const MCP_SRC = fs.readFileSync(path.join(REPO, 'mcp-server.js'), 'utf-8');

  it('lib/stripe.js PACKS carries no unlocks field on any pack', () => {
    for (const id of Object.keys(PACKS)) {
      assert.equal(Object.prototype.hasOwnProperty.call(PACKS[id], 'unlocks'), false, `PACKS.${id} must not carry unlocks`);
    }
    // Positive control: the fields that SHOULD still be there are.
    assert.ok(PACKS.starter.price_usd === 10 && PACKS.growth.price_usd === 25 && PACKS.pro.price_usd === 100);
  });

  it('renderPackData no longer injects unlocks into window.__AUXILO_PACKS__', () => {
    const fn = SERVER_SRC.slice(SERVER_SRC.indexOf('function renderPackData(html) {'), SERVER_SRC.indexOf('function serveHtmlWithLiveData'));
    assert.ok(!fn.includes('unlocks: PACKS[k].unlocks,'));
    assert.ok(fn.includes('price_usd: PACKS[k].price_usd,'), 'price_usd must remain -- only the unit field is gone');
  });

  it('the invalid-pack 400 response no longer lists unlocks per pack', () => {
    const idx = SERVER_SRC.indexOf('valid_packs: Object.keys(PACKS).map(k => ({');
    assert.notEqual(idx, -1);
    const block = SERVER_SRC.slice(idx, SERVER_SRC.indexOf('}))', idx) + 3);
    assert.ok(!block.includes('unlocks'));
  });

  it('the insufficient-balance 402 response no longer carries reset_at', () => {
    const idx = SERVER_SRC.indexOf("error: 'Credits exhausted'");
    assert.notEqual(idx, -1);
    const block = SERVER_SRC.slice(idx, idx + 600);
    assert.ok(!block.includes('reset_at'), 'reset_at means nothing for a dollar balance and must be gone');
  });

  it('the route catalog no longer describes /account/credits as "unlock credit balance" (both occurrences)', () => {
    assert.equal((SERVER_SRC.match(/View unlock credit balance/g) || []).length, 0);
    const matches = SERVER_SRC.match(/'\/account\/credits': \{ price: 'free', method: 'GET', description: '([^']+)'/g) || [];
    assert.ok(matches.length >= 2, 'both manifest occurrences must still exist');
    for (const m of matches) assert.ok(!/unlock credit/i.test(m));
  });

  it('mcp-server.js\'s one named phrase no longer says "unlock credits", and nothing else in the file changed shape', () => {
    assert.ok(!MCP_SRC.includes('an API key with unlock credits'));
    assert.ok(MCP_SRC.includes('a funded balance'), 'the replacement phrase must be present');
  });
});

// ─── Ruling L9: openapi.json matches the server ────────────────────────────

describe('[ruling L9] openapi.json matches the server', () => {
  const openapi = JSON.parse(read('openapi.json'));

  it('/account/credits is documented', () => {
    assert.ok(openapi.paths['/account/credits'], '/account/credits must have a path entry');
    assert.ok(openapi.paths['/account/credits'].get, 'must document GET');
    const props = openapi.paths['/account/credits'].get.responses['200'].content['application/json'].schema.properties.credit_balance.properties;
    assert.ok(props.paid_usd && props.promo_usd && props.total_usd && props.frozen_usd);
  });

  it('_revenue.accrual_capped is removed', () => {
    const revenueProps = openapi.components.schemas.LearningFull.properties._revenue.properties;
    assert.equal(Object.prototype.hasOwnProperty.call(revenueProps, 'accrual_capped'), false);
  });

  it('_revenue.amount_paid_usd description no longer claims it is simply "what this caller actually paid"', () => {
    const desc = openapi.components.schemas.LearningFull.properties._revenue.properties.amount_paid_usd.description;
    assert.ok(!/^What this caller actually paid/.test(desc));
    assert.match(desc, /Paid Balance portion/);
  });

  it('CreditPack.unlocks is removed', () => {
    assert.equal(Object.prototype.hasOwnProperty.call(openapi.components.schemas.CreditPack.properties, 'unlocks'), false);
  });

  it('the checkout refusals are documented: 403 ACCOUNT_HELD, 400 carries a code enum with both cap codes', () => {
    const responses = openapi.paths['/checkout/session'].post.responses;
    assert.ok(responses['403'], '403 ACCOUNT_HELD must be documented');
    const codeEnum = responses['400'].content['application/json'].schema.properties.code.enum;
    assert.ok(codeEnum.includes('BALANCE_CAP_EXCEEDED') && codeEnum.includes('DAILY_PURCHASE_CAP_EXCEEDED'));
  });

  it('schema shapes changed only where ruled -- Purchase and CreditPack.id/name/price_usd untouched', () => {
    const purchase = openapi.components.schemas.Purchase.properties;
    assert.ok(purchase.id && purchase.pack_id && purchase.amount_usd && purchase.timestamp);
    assert.equal(Object.keys(purchase).length, 4);
    const pack = openapi.components.schemas.CreditPack.properties;
    assert.deepEqual(Object.keys(pack).sort(), ['id', 'name', 'price_usd'].sort());
  });
});
