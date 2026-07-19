'use strict';

/**
 * test/aud19-payment-contract.test.js — 2026-07-19 payment-contract wave
 *
 * Covers PUNCH-LIST §26 rows:
 *   AUD19-5 — 402-first unlock challenge (SPEC-AUD19-5-402-first-2026-07-19):
 *             cold unauthenticated GET on a payable resource answers 402 with
 *             accepts[] MERGED with the options envelope; credits-exhausted
 *             402 now carries accepts[] too; MCP unlock handles both 402
 *             (new) and legacy 401-with-options.
 *   AUD19-7 — auxilo_withdraw DASH/ROUTE contract (SPEC-AUD19-7-withdraw-
 *             contract-2026-07-19 §4): honest status-and-routing tool — never
 *             attempts a custodial withdrawal; auxilo_verify_wallet's raw-args
 *             passthrough (which could mint action:'withdrawal' challenges)
 *             closed to a wallet+signature whitelist.
 *
 * Style matches the funnel/cp6 suites: pure-logic tests against exported
 * helpers (mcp-server.js) + source-level wiring assertions against server.js
 * and mcp-server.js (server.js hardcodes PORT/DATA_DIR so its endpoints are
 * otherwise only assertable statically).
 *
 * Runner: node --test test/aud19-payment-contract.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  unlockPaymentRequired,
  shapeWithdrawStatus,
  verifyWalletRequestBody,
} = require('../mcp-server.js');

const SERVER_SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf-8');
const MCP_SRC = fs.readFileSync(path.join(__dirname, '..', 'mcp-server.js'), 'utf-8');

// Slice helpers so assertions bind to the right function, not a lookalike
// (same convention as test/x402-router-server.test.js).
function slice(src, startMarker, endMarker) {
  const start = src.indexOf(startMarker);
  assert.notEqual(start, -1, `marker not found: ${startMarker}`);
  const end = src.indexOf(endMarker, start);
  assert.notEqual(end, -1, `end marker not found after ${startMarker}: ${endMarker}`);
  return src.slice(start, end);
}

// ════════════════════════════════════════════════════════════════════════════
// AUD19-5 — server.js structural
// ════════════════════════════════════════════════════════════════════════════

const vporSlice = slice(SERVER_SRC, 'async function verifyPaymentOrReject(', '// ── Dual Auth: x402 OR API Key');
const dadSlice = slice(SERVER_SRC, 'async function dualAuthDynamic(', 'const MIN_UNLOCK_PRICE');

describe('AUD19-5: verifyPaymentOrReject carries the merged options envelope', () => {
  it('accepts an authOptions parameter (default null)', () => {
    assert.ok(vporSlice.includes('routerCtx = null, authOptions = null)'),
      'verifyPaymentOrReject must take authOptions with a null default');
  });

  it('no-header branch builds the additive optionsBlock with the spec wording', () => {
    const noHeader = slice(vporSlice, 'if (!paymentHeader) {', '// CP-4');
    assert.ok(noHeader.includes("error: 'Payment required'"),
      'merged body must carry error: Payment required');
    assert.ok(noHeader.includes('This endpoint requires either an API key (with unlock credits) or an x402 payment.'),
      'merged body must carry the dual-path message');
    assert.ok(noHeader.includes('options: authOptions'),
      'merged body must pass the caller-supplied options through');
  });

  it('optionsBlock is spread into BOTH the router and custodial arms', () => {
    const noHeader = slice(vporSlice, 'if (!paymentHeader) {', '// CP-4');
    const spreads = noHeader.split('...optionsBlock,').length - 1;
    assert.equal(spreads, 2, 'both 402 arms of the no-header branch must merge the options block');
  });

  it('no-header branch still sets 402 + X-Payment-Required (regression)', () => {
    const noHeader = slice(vporSlice, 'if (!paymentHeader) {', '// CP-4');
    assert.ok(noHeader.includes('c.status(402)'));
    assert.ok(noHeader.includes("c.header('X-Payment-Required', 'true')"));
  });

  it('challenge consistency: the cold custodial accepts[] entry is byte-identical to the invalid-payment one', () => {
    const literals = [...vporSlice.matchAll(/accepts: \[\{([\s\S]*?)\}\]/g)].map(m => m[1].replace(/\s+/g, ' ').trim());
    assert.equal(literals.length, 2, 'expected exactly two inline custodial accepts literals (cold + invalid-payment)');
    assert.equal(literals[0], literals[1],
      'a client that fails a payment and retries must see the same challenge it would see cold');
  });

  it('invalid-payment branch is unchanged: error + accepts, no options merge (regression)', () => {
    const invalid = slice(vporSlice, 'if (!verified) {', '// R-01: surface the on-chain split');
    assert.ok(invalid.includes("error: 'Payment verification failed'"));
    assert.ok(invalid.includes('accepts:'));
    assert.ok(!invalid.includes('optionsBlock'),
      'the invalid-payment branch must not merge the options envelope (unchanged path)');
  });
});

describe('AUD19-5: dualAuthDynamic Path 3 answers 402-first', () => {
  it('Path 3 no longer returns a 401', () => {
    const path3 = dadSlice.slice(dadSlice.indexOf('// Path 3:'));
    assert.notEqual(path3.length, dadSlice.length + 1, 'Path 3 marker must exist');
    assert.ok(!path3.includes(', 401)'), 'Path 3 must not mint a 401 status');
    assert.ok(!dadSlice.includes("error: 'Authentication required'"),
      'the old 401 Authentication-required body must be gone from dualAuthDynamic');
  });

  it('Path 3 delegates into verifyPaymentOrReject with the full authOptions envelope', () => {
    const path3 = dadSlice.slice(dadSlice.indexOf('// Path 3:'));
    assert.ok(path3.includes('return verifyPaymentOrReject(c, price_usd, description, routerCtx, {'),
      'Path 3 must delegate to the single challenge-minting source of truth');
    for (const key of ["header: 'X-API-Key'", "format: 'axl_XXX'",
      "obtain: 'POST /auth/magic-link -> GET /auth/verify -> POST /account/api-keys'",
      "how_to_authenticate: 'npx auxilo setup'",
      "header: 'X-Payment'", 'price_usd: price_usd',
      "protocol: 'x402 (https://www.x402.org)'"]) {
      assert.ok(path3.includes(key), `authOptions must carry ${key}`);
    }
  });

  it('api-key path unaffected: valid key still proceeds (return null) and an invalid key still 401s (regression)', () => {
    assert.ok(dadSlice.includes('return null;  // Same contract as verifyPaymentOrReject'),
      'Path 1 success contract unchanged');
    assert.ok(dadSlice.includes("return c.json({ error: 'Invalid API key' }, 401)"),
      'invalid presented API key remains the one 401 on this path');
  });

  it('credits-exhausted 402 now carries the x402 accepts[] challenge (§3.3-2)', () => {
    const credits = slice(dadSlice, 'if (!creditResult.success) {', 'return null;');
    assert.ok(credits.includes('x402Version: 2'), 'credits-exhausted body must carry x402Version');
    assert.ok(credits.includes('accepts: ['), 'credits-exhausted body must carry accepts[]');
    assert.ok(credits.includes('_routerAccepts('), 'router arm must serve the router hint');
    assert.ok(credits.includes('payTo: WALLET') && credits.includes('asset: USDC_BASE')
      && credits.includes("assetTransferMethod: 'eip3009'"),
      'custodial arm must mirror the standard challenge entry');
    // The pre-existing body keys survive (additive change).
    for (const key of ["error: 'Credits exhausted'", 'message: creditResult.message',
      'credits: creditResult.status', 'reset_at: creditResult.status.period_end']) {
      assert.ok(credits.includes(key), `credits-exhausted body must retain ${key}`);
    }
  });
});

describe('AUD19-5: refuse-arm ordering regression', () => {
  it('the CONTRIBUTOR_NOT_ONBOARDED 409 still precedes the dualAuthDynamic challenge on the unlock route', () => {
    const refuse = SERVER_SRC.indexOf("code: 'CONTRIBUTOR_NOT_ONBOARDED'");
    const challenge = SERVER_SRC.indexOf('const rejection = await dualAuthDynamic(c, UNLOCK_PRICE,');
    assert.notEqual(refuse, -1);
    assert.notEqual(challenge, -1);
    assert.ok(refuse < challenge,
      'the refuse arm must keep firing BEFORE any payment is solicited');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// AUD19-5 — MCP unlock formatter (pure)
// ════════════════════════════════════════════════════════════════════════════

describe('AUD19-5: unlockPaymentRequired handles both challenge generations', () => {
  const endpoint = 'https://auxilo.io/knowledge/lrn_test';

  it('402 with accepts[]: price read from maxAmountRequired', () => {
    const out = unlockPaymentRequired(402, { x402Version: 2, accepts: [{ maxAmountRequired: '80000' }] }, endpoint);
    assert.equal(out.status, 'payment_required');
    assert.equal(out.cost, '$0.0800 USDC on Base (set by contributor)');
    assert.equal(out.http_endpoint, endpoint);
    assert.ok(out.how_to_pay.includes('x_payment'));
    assert.ok(out.how_to_pay.includes('npx auxilo setup'));
    assert.deepEqual(out.payment_details.accepts[0].maxAmountRequired, '80000');
  });

  it('legacy 401 with options (old live servers): price read from options.x402_payment.price_usd', () => {
    const out = unlockPaymentRequired(401, {
      error: 'Authentication required',
      options: { x402_payment: { price_usd: 0.08 } },
    }, endpoint);
    assert.equal(out.status, 'payment_required');
    assert.equal(out.cost, '$0.0800 USDC on Base (set by contributor)');
  });

  it('402 without a readable amount falls back to "dynamic"', () => {
    const out = unlockPaymentRequired(402, { error: 'Payment required' }, endpoint);
    assert.ok(out.cost.startsWith('dynamic'));
  });

  it('401 WITHOUT options is not a payment challenge (invalid API key) — returns null', () => {
    assert.equal(unlockPaymentRequired(401, { error: 'Invalid API key' }, endpoint), null);
  });

  it('200 body is not a challenge — returns null so the fenced unlock result flows', () => {
    assert.equal(unlockPaymentRequired(200, { id: 'lrn_x', body: 'content' }, endpoint), null);
  });

  it('the merged 402 (accepts + options) prefers the accepts[] amount', () => {
    const out = unlockPaymentRequired(402, {
      accepts: [{ maxAmountRequired: '150000' }],
      options: { x402_payment: { price_usd: 0.08 } },
    }, endpoint);
    assert.equal(out.cost, '$0.1500 USDC on Base (set by contributor)');
  });
});

describe('AUD19-5: MCP unlock handler wiring', () => {
  const unlockCase = slice(MCP_SRC, "case 'auxilo_unlock': {", "case 'auxilo_rate': {");
  it('routes both statuses through unlockPaymentRequired then falls through to the fence', () => {
    assert.ok(unlockCase.includes('unlockPaymentRequired(resp.status, data'),
      'handler must delegate challenge detection to the pure formatter');
    assert.ok(unlockCase.includes('fenceUnlockResult(data)'),
      'non-challenge responses must keep the LW-3(a) fence');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// AUD19-7 — auxilo_withdraw DASH/ROUTE contract
// ════════════════════════════════════════════════════════════════════════════

describe('AUD19-7: shapeWithdrawStatus (pure)', () => {
  const base = { pending_balance: 1.23, unassented_pending: 0.4, payouts_paused: true };

  it('reports the pay-at-sale model and maps the balances', () => {
    const out = shapeWithdrawStatus(base);
    assert.ok(out.payout_model.includes('paid to your linked wallet at sale time'));
    assert.equal(out.legacy_pending_balance_usd, 1.23);
    assert.equal(out.held_pending_terms_acceptance_usd, 0.4);
    assert.equal(out.payouts_paused, true);
  });

  it('paused: routes to the status page, not a retry', () => {
    const out = shapeWithdrawStatus(base);
    assert.ok(out.how_to_withdraw_legacy_balance.includes('paused during the settlement migration'));
    assert.ok(out.how_to_withdraw_legacy_balance.includes('https://auxilo.io/status'));
  });

  it('unpaused: routes the legacy balance to the dashboard Stripe rail', () => {
    const out = shapeWithdrawStatus({ ...base, payouts_paused: false });
    assert.ok(out.how_to_withdraw_legacy_balance.includes('https://auxilo.io/dashboard'));
    assert.ok(out.how_to_withdraw_legacy_balance.includes('$0.50 minimum'));
  });

  it('teaches the pay-at-sale onboarding chain', () => {
    assert.equal(shapeWithdrawStatus(base).get_paid_at_sale_time,
      'auxilo_accept_terms -> auxilo_verify_wallet -> auxilo_link_wallet');
  });
});

describe('AUD19-7: auxilo_withdraw never attempts a custodial withdrawal', () => {
  const withdrawCase = slice(MCP_SRC, "case 'auxilo_withdraw': {", "case 'auxilo_settlements': {");

  it('handler reads GET /account/earnings only', () => {
    assert.ok(withdrawCase.includes('/account/earnings`'),
      'the handler must be a status read against /account/earnings');
  });

  it('handler never calls POST /withdraw (or any POST at all)', () => {
    assert.ok(!withdrawCase.includes('${AUXILO_BASE}/withdraw'),
      'no request to the custodial /withdraw endpoint may remain');
    assert.ok(!withdrawCase.includes("method: 'POST'"),
      'the routing tool must not issue any POST — it moves no funds');
  });

  it('handler shapes the routing response and drafts the unauthenticated error', () => {
    assert.ok(withdrawCase.includes('shapeWithdrawStatus(e)'));
    assert.ok(withdrawCase.includes('Not authenticated. Run npx auxilo setup to create credentials, or pass session_token. Balances are account-scoped.'));
  });

  it('tool description: the fictional string-signature protocol is gone; the tool says it does not move funds', () => {
    const toolDef = slice(MCP_SRC, "name: 'auxilo_withdraw'", "name: 'auxilo_settlements'");
    assert.ok(!toolDef.includes('auxilo-withdraw-{wallet}-{amount}-{timestamp}'),
      'the fictional signature protocol must not survive in any published artifact');
    assert.ok(toolDef.includes('it does not move funds'));
    assert.ok(toolDef.includes('https://auxilo.io/dashboard'));
    assert.ok(toolDef.includes('required: []'), 'no required inputs — status tools take at most a session_token');
    assert.ok(!toolDef.includes('timestamp'), 'the dead timestamp parameter must be dropped');
  });
});

describe('AUD19-7: auxilo_verify_wallet action whitelist', () => {
  it('verifyWalletRequestBody refuses the withdrawal-action passthrough', () => {
    const body = verifyWalletRequestBody({ wallet: '0xabc', action: 'withdrawal', signature: '0xsig' });
    assert.deepEqual(body, { wallet: '0xabc', signature: '0xsig' },
      'only wallet + signature may travel — action must be stripped');
    assert.ok(!('action' in body));
  });

  it('omits signature entirely on the challenge-request step', () => {
    assert.deepEqual(verifyWalletRequestBody({ wallet: '0xabc' }), { wallet: '0xabc' });
  });

  it('arbitrary extra args never reach the server', () => {
    const body = verifyWalletRequestBody({ wallet: '0xabc', action: 'withdrawal', admin: true, foo: 'bar' });
    assert.deepEqual(Object.keys(body), ['wallet']);
  });

  it('handler wiring: the raw-args JSON.stringify passthrough is closed', () => {
    const verifyCase = slice(MCP_SRC, "case 'auxilo_verify_wallet': {", "case 'auxilo_withdraw': {");
    assert.ok(!verifyCase.includes('JSON.stringify(args)'),
      'the handler must not forward the raw args object');
    assert.ok(verifyCase.includes('verifyWalletRequestBody(args)'),
      'the handler must build its body through the whitelist');
  });
});
