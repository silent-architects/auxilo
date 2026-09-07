'use strict';

/**
 * test/credits-e2e-findings.test.js — CREDITS-E2E-FINDINGS
 *
 * Covers the two dashboard.html fixes from the first live Stripe TEST
 * purchase (Starter, $10, 2026-09-06):
 *
 *   1. The ?checkout=success banner contradiction: the webhook can (and in
 *      the observed purchase did) credit the account and land on the page
 *      BEFORE the browser's first post-redirect /account/credits poll, so
 *      comparing the poll's own first reading against itself as "prior
 *      balance" never detects an increase and the page shows "Credits have
 *      not appeared yet" at the same time the balance and history row
 *      already reflect the purchase. Fixed by (a) stashing the real
 *      pre-purchase balance in sessionStorage before the Stripe redirect and
 *      (b) a small pure decision function (checkoutPollOutcome) that only
 *      declares the poll "exhausted" (not-appeared copy) when NO increase
 *      was seen across the whole poll window, and hides the banner (no
 *      success-confirmed string exists to show instead -- none composed
 *      here) the moment an increase is seen.
 *
 *   2. The purchase-history "Pack" column rendering the raw pack_id key
 *      (e.g. "starter") instead of the pack's display name ("Starter
 *      Pack"), fixed by a client-side lookup (packDisplayName) against
 *      window.__AUXILO_PACKS__ -- the same server-injected PACKS source
 *      (lib/stripe.js via server.js renderPackData) the pack-card rows
 *      already use, rather than adding a name field server-side.
 *
 * Style matches test/credits-control-part1.test.js and
 * test/spec3-e1-account-vocab-runtime.test.js: source-level string
 * assertions against the static dashboard.html (no jsdom dependency in this
 * repo -- see package.json), plus real-logic unit tests that extract the two
 * new pure, DOM-free functions from the page source with brace-balanced
 * slicing and execute them via `new Function(...)`, the same
 * source-extraction pattern used in spec3-e1's fail-open-guard test.
 *
 * Runner: node --test test/credits-e2e-findings.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const DASHBOARD_HTML = fs.readFileSync(path.join(REPO_ROOT, 'public', 'dashboard.html'), 'utf-8');

// ─── Helpers ─────────────────────────────────────────────────────────────

// Brace-balanced slice from a `function name(...) {` marker through its
// matching closing brace. Robust to reformatting inside the function body.
function extractFunctionSource(src, startMarker) {
  const start = src.indexOf(startMarker);
  assert.notEqual(start, -1, `marker not found: ${startMarker}`);
  const braceStart = src.indexOf('{', start);
  assert.notEqual(braceStart, -1, `no opening brace after marker: ${startMarker}`);
  let depth = 0;
  let i = braceStart;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) { i++; break; }
    }
  }
  assert.ok(depth === 0, `unbalanced braces extracting: ${startMarker}`);
  return src.slice(start, i);
}

function loadPureFunction(startMarker, fnName) {
  const src = extractFunctionSource(DASHBOARD_HTML, startMarker);
  // eslint-disable-next-line no-new-func
  return new Function(`${src}\nreturn ${fnName};`)();
}

// ─── 1. checkoutPollOutcome (state machine, DOM-free unit tests) ──────────

describe('CREDITS-E2E-FINDINGS 1: checkoutPollOutcome state machine', () => {
  const checkoutPollOutcome = loadPureFunction(
    'function checkoutPollOutcome(priorBalance, balance, attempt, maxAttempts) {',
    'checkoutPollOutcome'
  );

  it('is present in dashboard.html and callable in isolation', () => {
    assert.equal(typeof checkoutPollOutcome, 'function');
  });

  it('reports "increased" the moment balance exceeds the baseline, on the very first attempt', () => {
    // This is the exact race from the observed purchase: the webhook already
    // landed by the time of the FIRST poll, so with a real pre-purchase
    // baseline (not the first poll's own reading) the increase is caught
    // immediately instead of after the poll window burns out.
    assert.equal(checkoutPollOutcome(0, 80, 0, 4), 'increased');
  });

  it('does not report "increased" when balance merely equals the baseline', () => {
    assert.equal(checkoutPollOutcome(80, 80, 0, 4), 'continue');
  });

  it('reports "continue" while balance is unchanged and attempts remain', () => {
    assert.equal(checkoutPollOutcome(80, 80, 1, 4), 'continue');
    assert.equal(checkoutPollOutcome(80, 80, 3, 4), 'continue');
  });

  it('reports "exhausted" ONLY once the balance never increased across the whole poll window', () => {
    assert.equal(checkoutPollOutcome(80, 80, 4, 4), 'exhausted');
  });

  it('reports "increased", never "exhausted", the instant balance rises even on the last attempt', () => {
    // "increased" must win over "exhausted" so the contradictory banner
    // (both shown at once) the live purchase exposed cannot recur -- an
    // increase seen on the final poll must not fall through to the
    // not-appeared branch.
    assert.equal(checkoutPollOutcome(80, 160, 4, 4), 'increased');
  });

  it('treats a null balance reading (fetch failed / no unlocks field) as no increase, never a crash', () => {
    assert.equal(checkoutPollOutcome(80, null, 2, 4), 'continue');
    assert.equal(checkoutPollOutcome(80, null, 4, 4), 'exhausted');
  });

  it('falls back to treating a null baseline as "no increase possible yet" rather than a false positive', () => {
    assert.equal(checkoutPollOutcome(null, 80, 0, 4), 'continue');
  });
});

// ─── 2. Checkout banner wiring: no invented copy, existing strings kept ───

describe('CREDITS-E2E-FINDINGS 1b: checkout-banner wiring (source)', () => {
  it('the pre-existing "not appeared" string survives verbatim (not touched, only re-gated)', () => {
    const matches = DASHBOARD_HTML.match(
      /Credits have not appeared yet\. If they do not show in a few minutes, write to support@auxilo\.io\./g
    ) || [];
    assert.equal(matches.length, 2, 'both call sites (poll outcome + catch handler) keep the exact existing string');
  });

  it('the pre-existing "appear here" waiting string survives verbatim as the initial success-state copy', () => {
    assert.ok(DASHBOARD_HTML.includes('Your credits appear here as soon as the purchase lands.'));
  });

  it('no new banner copy was composed for the confirmed-increase case: the banner is hidden, not replaced with new text', () => {
    const h = extractFunctionSource(DASHBOARD_HTML, 'function pollForCreditIncrease(attempt, priorBalance) {');
    assert.ok(h.includes("outcome === 'increased'"));
    assert.ok(h.includes("hideAlert('checkout-banner')"),
      'no success-confirmed string exists in the file (verified above -- only two banner strings total), so the fix hides the banner rather than inventing copy');
  });

  it('the pre-purchase balance is stashed to sessionStorage before the Stripe redirect, not after', () => {
    const h = extractFunctionSource(DASHBOARD_HTML, 'window.auxiloBuyCredits = function (packId, btn) {');
    const stashIdx = h.indexOf('stashPrebuyBalance();');
    const redirectIdx = h.indexOf('window.location = res.data.url;');
    assert.ok(stashIdx !== -1, 'stash call present');
    assert.ok(redirectIdx !== -1, 'redirect present');
    assert.ok(stashIdx < redirectIdx, 'balance must be stashed BEFORE navigating away to Stripe');

    const stashFn = extractFunctionSource(DASHBOARD_HTML, 'function stashPrebuyBalance() {');
    assert.ok(stashFn.includes("sessionStorage.setItem(\n        'auxilo_prebuy_unlock_balance'"));
    assert.ok(stashFn.includes('_creditsBalanceCache'));
  });

  it('showCheckoutBanner reads and clears the stashed baseline before polling', () => {
    const h = extractFunctionSource(DASHBOARD_HTML, 'function showCheckoutBanner(state) {');
    assert.ok(h.includes("sessionStorage.getItem('auxilo_prebuy_unlock_balance')"));
    assert.ok(h.includes("sessionStorage.removeItem('auxilo_prebuy_unlock_balance')"));
    assert.ok(h.includes('pollForCreditIncrease(0, priorBalance)'));
  });

  it('REVIEW-NOTES-0906 (1): the cancel branch also clears the stashed pre-buy baseline', () => {
    // stashPrebuyBalance() writes 'auxilo_prebuy_unlock_balance' right before
    // the Stripe redirect. If checkout comes back cancelled, the success
    // branch's own removeItem never runs, so without a defensive clear here
    // the stash would sit in sessionStorage and get read as a stale baseline
    // by a later, unrelated successful purchase.
    const h = extractFunctionSource(DASHBOARD_HTML, 'function showCheckoutBanner(state) {');
    const cancelIdx = h.indexOf("state === 'cancel'");
    assert.ok(cancelIdx !== -1, 'cancel branch present');
    const cancelBranch = h.slice(cancelIdx);
    assert.ok(
      cancelBranch.includes("sessionStorage.removeItem('auxilo_prebuy_unlock_balance')"),
      'cancel branch must clear the same stash key the success branch clears'
    );
    // Defensive: try/catch around the clear, matching the style of the
    // existing sessionStorage reads/writes in this function.
    const clearIdx = cancelBranch.indexOf("sessionStorage.removeItem('auxilo_prebuy_unlock_balance')");
    const surrounding = cancelBranch.slice(Math.max(0, clearIdx - 40), clearIdx + 80);
    assert.ok(surrounding.includes('try'), 'clear is wrapped in try/catch like the existing reads');
  });
});

// ─── 3. packDisplayName (pack-name lookup, DOM-free unit tests) ───────────

describe('CREDITS-E2E-FINDINGS 2: packDisplayName lookup', () => {
  const packDisplayName = loadPureFunction(
    'function packDisplayName(packId) {',
    'packDisplayName'
  );

  it('is present in dashboard.html and callable in isolation', () => {
    assert.equal(typeof packDisplayName, 'function');
  });

  it('resolves a known pack id to its display name via window.__AUXILO_PACKS__', () => {
    global.window = {
      __AUXILO_PACKS__: [
        { id: 'starter', name: 'Starter Pack', price_usd: 10, unlocks: 80 },
        { id: 'growth', name: 'Growth Pack', price_usd: 25, unlocks: 250 },
        { id: 'pro', name: 'Pro Pack', price_usd: 100, unlocks: 1000 },
      ],
    };
    try {
      assert.equal(packDisplayName('starter'), 'Starter Pack');
      assert.equal(packDisplayName('growth'), 'Growth Pack');
      assert.equal(packDisplayName('pro'), 'Pro Pack');
    } finally {
      delete global.window;
    }
  });

  it('falls back to the raw key if the pack is not found (never throws, never blanks)', () => {
    global.window = { __AUXILO_PACKS__: [{ id: 'starter', name: 'Starter Pack' }] };
    try {
      assert.equal(packDisplayName('discontinued-pack'), 'discontinued-pack');
    } finally {
      delete global.window;
    }
  });

  it('falls back cleanly with no window.__AUXILO_PACKS__ at all', () => {
    global.window = {};
    try {
      assert.equal(packDisplayName('starter'), 'starter');
      assert.equal(packDisplayName(''), '');
    } finally {
      delete global.window;
    }
  });
});

describe('CREDITS-E2E-FINDINGS 2b: purchase-history Pack column wiring (source)', () => {
  it('renderPurchases renders the pack display name, not the raw pack_id key', () => {
    const h = extractFunctionSource(DASHBOARD_HTML, 'function renderPurchases(data, el) {');
    assert.ok(h.includes('packDisplayName(p.pack_id)'),
      'Pack column must go through the display-name lookup');
    assert.ok(!h.includes("packTd.textContent = p.pack_id"),
      'the raw-key render must be gone, not just supplemented');
  });

  it('the pack-card rows and the history table read the same window.__AUXILO_PACKS__ source (no second source of pack names)', () => {
    const cardRows = extractFunctionSource(DASHBOARD_HTML, 'function renderCreditPackRows() {');
    assert.ok(cardRows.includes('window.__AUXILO_PACKS__'));
    const lookup = extractFunctionSource(DASHBOARD_HTML, 'function packDisplayName(packId) {');
    assert.ok(lookup.includes('window.__AUXILO_PACKS__'));
  });

  it('the Pack column header is unchanged (no new/renamed column, no queries column reintroduced)', () => {
    assert.ok(DASHBOARD_HTML.includes("['Date', 'Pack', 'Amount', 'Unlocks'].forEach"));
  });
});
