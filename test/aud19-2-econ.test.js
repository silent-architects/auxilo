'use strict';

/**
 * test/aud19-2-econ.test.js — AUD19-2 credit-path revenue-share economics
 *
 * RETIRED IN LARGE PART (credits-as-cash follow-up, SITE-PM 2026-09-27,
 * "let's make credits same as cash", final state, one model). The AUD19-2
 * design this file originally pinned — per-lot unit pricing, an accrual
 * basis of min(list price, the consumed credit's own price), a legacy-lot
 * migration for pre-lot balances, and a 1-per-(buyer, learning)/30-day
 * accrual cap — is the unit-credit model the owner retired in favor of one
 * balance, held in dollars. Every describe block that pinned that model is
 * removed, each with its reason, rather than weakened to pass:
 *
 *   - 'credit lots: unit price travels with the credit' (4 tests) — spent
 *     unit lots via addPurchasedCredits/deductCredit; both the function and
 *     the concept are gone.
 *   - 'lot consumption order: paid lots before $0 grant lots' (2 tests) —
 *     same; there is one balance, not a paid-then-grant unit-lot queue.
 *   - 'legacy migration: pre-lot balances get a derived-price lot on first
 *     touch' (4 tests) — ensureUnlockLots/deriveLegacyUnitPrice are deleted;
 *     no code path creates a unit lot, so nothing migrates into one.
 *   - 'per-(buyer, learning) accrual cap — 1 credited accrual / 30 days'
 *     (6 tests) — lib/unlock-attribution.js is deleted (F-5); a repeat
 *     unlock from a balance earns the share every time, the same as x402
 *     (proved in test/credits-as-cash-unlock.test.js, test 34b).
 *   - 'server.js: accrual basis = min(list, credit unit price), credit path
 *     only' (5 tests) — the min(list, unit) sub-formula and the
 *     creditLotKind branch it lived in are gone; the basis is simply the
 *     paid-drawn portion of the debit now (test/credits-one-balance.test.js).
 *   - 'server.js: per-(buyer, learning) accrual cap wiring' (5 tests) — same
 *     as the accrual-cap-store retirement above, at the server-wiring level.
 *   - 'server.js: $0 referral lots + pack pricing at the grant sites'
 *     (2 tests) — referral grants now mint a $5.00 promotional DOLLAR lot
 *     via addDollarLot, not a $0-unit-price unit lot via addPurchasedCredits
 *     (test/credits-one-balance.test.js, F-2); the webhook no longer lots
 *     unlocks at a pro-rata unit price — it always adds dollars.
 *
 * What stays, unaffected by this build because it pins behavior the product
 * still has (self-unlock identity timing, WAL payload shape and replay
 * determinism): 'server.js: M-2 wash guard uses the POST-auth buyer
 * identity' and 'server.js: WAL determinism (forward-only cutover)', below.
 *
 * Runner: node --test test/aud19-2-econ.test.js
 */

const fs = require('fs');
const path = require('path');

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');

// ─── Server wiring (structural — same approach as the CP-6 suite) ────────────
const SERVER_SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf-8');

function unlockHandlerSlice() {
  const start = SERVER_SRC.indexOf("app.get('/knowledge/:id'");
  const end = SERVER_SRC.indexOf("app.post('/knowledge/:id/rate'", start);
  assert.ok(start !== -1 && end !== -1);
  return SERVER_SRC.slice(start, end);
}

describe('server.js: M-2 wash guard uses the POST-auth buyer identity', () => {
  let h;
  before(() => { h = unlockHandlerSlice(); });

  it('buyerAccountId is re-read after dualAuthDynamic (the pre-auth read is null on the credit path)', () => {
    const auth = h.indexOf('await dualAuthDynamic(');
    const buyer = h.indexOf("const buyerAccountId = c.get('accountId')");
    assert.ok(auth !== -1 && buyer !== -1 && auth < buyer,
      'identity must be read after authentication sets accountId');
  });

  it('the self-unlock account arm compares buyerAccountId', () => {
    assert.ok(/\(buyerAccountId && contribAccountId && buyerAccountId === contribAccountId\)/.test(h));
    assert.ok(h.includes('if (isSelfUnlock) {'), 'M-2 guard intact');
  });
});

describe('server.js: WAL determinism (forward-only cutover)', () => {
  it('WAL payload stores the basis + funding source + purchaser identity', () => {
    const h = unlockHandlerSlice();
    for (const field of ['amount_paid_usd: accrualBasis', 'funding_source: fundingSource',
      'purchaser_account_id: buyerAccountId', 'purchaser_ip_redacted:', 'purchaser_ua:']) {
      assert.ok(h.includes(field), `WAL payload must carry ${field}`);
    }
  });

  it('replayUnlock books gross from the STORED amount_paid_usd, never recomputes', () => {
    const r = SERVER_SRC.slice(SERVER_SRC.indexOf('function replayUnlock(entry)'), SERVER_SRC.indexOf('function replayPipelineApprove'));
    assert.ok(r.includes("const grossAmount = (typeof amount_paid_usd === 'number') ? amount_paid_usd : unlock_price;"),
      'stored basis when present; pre-cutover entries fall back to unlock_price unchanged');
    assert.ok(r.includes('total_gross += grossAmount'));
    assert.ok(r.includes('by_learning[learning_id].gross += grossAmount'));
    assert.ok(r.includes('pending_balance += contributor_earned'),
      'contributor amounts still replayed verbatim from the stored payload');
    assert.ok(!/accrualBasis/.test(r) && !/Math\.min\(/.test(r) && !/getCurrentPrice/.test(r),
      'replay never recomputes a basis from price or credits');
  });

  it('CP-6 interplay: held-vs-pending routing credits the SAME capped/based contributorEarned in both branches', () => {
    const h = unlockHandlerSlice();
    assert.ok(h.includes('activeEntry.pending_balance += contributorEarned;'));
    assert.ok(h.includes('activeEntry.unassented_pending = (activeEntry.unassented_pending || 0) + contributorEarned;'));
    assert.ok(h.includes('agency_in_force: agencyInForce'), 'CP-6 WAL field untouched');
  });
});
