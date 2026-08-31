'use strict';

/**
 * test/r01-launch-blockers.test.js — R-01 non-custodial launch blockers
 *
 * Covers the seven launch-blocking fixes on branch r01-noncustodial-launch:
 *   1. Stripe payout kill-switch (R01-MT-02)          — source-level gate
 *   2. Receipt-cure refuse-at-unlock (LAUNCH INVARIANT) — unit (predicate) + source (gate)
 *   3. Dead value_signal purchase-decision fields (UX-N1/CAT-1) — unit (pricing) + source
 *   4. Held balance leak in dashboard headline (MISS-03/BUX-3)  — source-level
 *   5. Withdraw ignores account suspension (SEC-2)     — source-level
 *   6. openapi.json incomplete + stale (MISS-01)       — parses openapi.json
 *   7. GET /version route (OPS-4)                       — source-level
 *
 * Mixed strategy, matching the repo's established convention (see
 * tos-clickwrap-assent.test.js / cp6-accrual-gate.test.js): pure logic in
 * lib/* is unit-tested with real inputs; route gates are verified against the
 * handler SOURCE so we don't have to boot Hono with every production env var
 * (and so a parallel agent's server can't cause a port clash).
 *
 * accounts.js imports 'jose' at load and warns without SESSION_SECRET; set a dummy.
 *
 * Runner: node --test test/r01-launch-blockers.test.js
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-do-not-use-in-prod';

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SERVER_SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf-8');

function sliceHandler(marker, span = 4500) {
  const i = SERVER_SRC.indexOf(marker);
  assert.notEqual(i, -1, `handler not found: ${marker}`);
  return SERVER_SRC.slice(i, i + span);
}

// The platform wallets (server.js WALLET/PLATFORM_WALLETS). The 2026-07-12 LLC
// rotation made the Auxilo, LLC wallet the receiving address; seed learnings still
// carry the retired pre-LLC wallet as contributor_wallet, so identity checks must
// recognize BOTH (or the refuse gate 409s the platform-seed catalog).
const PLATFORM_WALLET = '0xA19Cf92cc1daCf742f0E50b4128cAD3A86A81EC4';        // current — Auxilo, LLC
const LEGACY_PLATFORM_WALLET = '0x1BE960313c93b3aA0AA62BF33B300CAB48c36Ca6'; // retired pre-LLC; seeds carry it
const PLATFORM_WALLETS = [PLATFORM_WALLET, LEGACY_PLATFORM_WALLET];

// ─── 1. Stripe payout kill-switch (R01-MT-02) ───────────────────────────────────

describe('1. Stripe payout kill-switch', () => {
  it('POST /withdraw/stripe returns 503 with the pause code when the flag is unset', () => {
    const h = sliceHandler("app.post('/withdraw/stripe'", 1200);
    assert.ok(h.includes("process.env.CUSTODIAL_WITHDRAW_ENABLED !== 'true'"),
      'must gate on the same CUSTODIAL_WITHDRAW_ENABLED sentinel as the USDC rail');
    assert.ok(h.includes("code: 'withdraw_paused_noncustodial_migration'"),
      'must return the machine-readable pause code');
    assert.ok(/\}, 503\)/.test(h), 'must return HTTP 503');
    assert.ok(h.includes("error: 'Withdrawals temporarily paused during non-custodial migration'"),
      'must return the specified error message');
  });

  it('the kill-switch is BEFORE the auth/OFAC work (mirrors the USDC gate position)', () => {
    const h = sliceHandler("app.post('/withdraw/stripe'", 1600);
    const gateAt = h.indexOf('CUSTODIAL_WITHDRAW_ENABLED');
    const ofacAt = h.indexOf('ofacScreeningReady');
    const acctAt = h.indexOf("c.get('accountId')");
    assert.ok(gateAt !== -1 && ofacAt !== -1 && acctAt !== -1);
    assert.ok(gateAt < ofacAt && gateAt < acctAt,
      'the pause gate must run before any auth/screening work');
  });
});

// ─── 2. Receipt-cure: refuse-at-unlock for un-onboarded external builders ────────

describe('2. isPlatformContributor predicate (lib/accounts.js)', () => {
  const { isPlatformContributor } = require('../lib/accounts.js');

  it('platform-owned: seed learning whose contributor IS the platform wallet', () => {
    assert.equal(isPlatformContributor({ contributor_wallet: PLATFORM_WALLET }, PLATFORM_WALLET), true);
  });
  it('EXTERNAL (FB-3): wallet-only builder — non-platform wallet, no account — is NOT platform-owned', () => {
    // A bare external wallet with no account cannot have accepted §5.10, so its content
    // must be refused, not received into custody. (Previously wrongly returned true.)
    assert.equal(isPlatformContributor({ contributor_wallet: '0xdead000000000000000000000000000000000001' }, PLATFORM_WALLET), false);
  });
  it('platform-owned: case-insensitive match against a checksummed platform wallet', () => {
    assert.equal(isPlatformContributor({ contributor_wallet: PLATFORM_WALLET.toLowerCase() }, PLATFORM_WALLET), true);
  });
  it('platform-owned: null learning is treated as platform (never gates the catalog closed)', () => {
    assert.equal(isPlatformContributor(null, PLATFORM_WALLET), true);
  });
  it('platform-owned: no external payee at all (no wallet, no account) is platform-owned', () => {
    assert.equal(isPlatformContributor({ title: 'ownerless' }, PLATFORM_WALLET), true);
  });
  it('EXTERNAL: real account_id with a non-platform wallet is NOT platform-owned', () => {
    assert.equal(isPlatformContributor(
      { contributor_account_id: 'acc_ext', contributor_wallet: '0xdead000000000000000000000000000000000001' },
      PLATFORM_WALLET), false);
  });
  it('EXTERNAL: an external account with no wallet is NOT platform-owned (gates on assent)', () => {
    assert.equal(isPlatformContributor({ contributor_account_id: 'acc_ext' }, PLATFORM_WALLET), false);
  });

  // ── 2026-07-12 LLC wallet rotation: the predicate accepts a SET and must keep
  //    recognizing legacy-wallet seed learnings as platform, else the refuse gate
  //    409s the existing catalog the moment the receiving address rotates.
  it('ROTATION: legacy-wallet seed learning is still platform-owned under the PLATFORM_WALLETS set', () => {
    assert.equal(isPlatformContributor({ contributor_wallet: LEGACY_PLATFORM_WALLET }, PLATFORM_WALLETS), true);
  });
  it('ROTATION: new-wallet learning is platform-owned under the set', () => {
    assert.equal(isPlatformContributor({ contributor_wallet: PLATFORM_WALLET }, PLATFORM_WALLETS), true);
  });
  it('ROTATION: an external wallet is still refused under the set', () => {
    assert.equal(isPlatformContributor({ contributor_wallet: '0xdead000000000000000000000000000000000001' }, PLATFORM_WALLETS), false);
  });
  it('ROTATION: server.js passes the PLATFORM_WALLETS set (not the single WALLET) to the refuse gate', () => {
    assert.ok(SERVER_SRC.includes('isPlatformContributor(learning, PLATFORM_WALLETS)'),
      'the refuse gate must consult the set so legacy seeds stay unlockable');
    assert.ok(/const PLATFORM_WALLETS = \[WALLET, \.\.\.LEGACY_PLATFORM_WALLETS\]/.test(SERVER_SRC),
      'PLATFORM_WALLETS must be the current WALLET plus the legacy list');
  });
});

describe('2. refuse-at-unlock gate is wired BEFORE payment (server.js)', () => {
  let h;
  // CH-7: computed in before() — a failed slice exits 1, never fail-0/exit-0.
  // DR-8 (2026-07-20): window 4200 → 9500 — the owner short-circuit (free
  // self-unlock) now sits between the route head and the refuse gate; the gate
  // and dualAuthDynamic ordering assertions below are unchanged (sanctioned
  // window class, same as the 5A /learn slice bump).
  before(() => { h = sliceHandler("app.get('/knowledge/:id'", 9500); });

  it('the CONTRIBUTOR_NOT_ONBOARDED 409 exists in the unlock handler', () => {
    assert.ok(h.includes("code: 'CONTRIBUTOR_NOT_ONBOARDED'"), 'must return the machine-readable refusal code');
    assert.ok(/\}, 409\)/.test(h), 'must be an HTTP 409');
    assert.ok(h.includes('completed onboarding'), 'must carry the specified human-readable message');
  });

  it('the refusal consults isPlatformContributor + isPayeeAgencyInForce', () => {
    assert.ok(h.includes('isPlatformContributor(learning, PLATFORM_WALLETS)'),
      'platform-owned learnings must be exempt (never gated) — post-rotation the gate consults the wallet SET');
    assert.ok(h.includes('isPayeeAgencyInForce(contribAccount)'),
      'external contributors gate on the §5.10 payee-agency being in force');
  });

  it('the gate runs BEFORE the x402 payment challenge (dualAuthDynamic)', () => {
    const refuseAt = h.indexOf('CONTRIBUTOR_NOT_ONBOARDED');
    // DR-8: pin the CALL SITE, not the bare word — the owner short-circuit's
    // comments (which sit above the gate) legitimately name dualAuthDynamic.
    const payAt = h.indexOf('await dualAuthDynamic(');
    assert.ok(refuseAt !== -1 && payAt !== -1);
    assert.ok(refuseAt < payAt,
      'the refusal must precede any 402-challenge / payment request/settle');
  });

  it('router-mode settlements (non-custodial, no receipt) are exempt from the gate', () => {
    // The gate is `if (!routerCtx && !isPlatformContributor(...))` — router mode
    // pays the builder on-chain directly, so no custodial receipt occurs.
    assert.ok(/if \(!routerCtx && !isPlatformContributor\(learning, PLATFORM_WALLETS\)\)/.test(h),
      'the gate must be skipped when a router settlement will occur');
  });
});

// ─── 3. Dead value_signal purchase-decision fields (UX-N1/CAT-1) ─────────────────

describe('3. value_signal recompute (lib/pricing.js)', () => {
  const pricing = require('../lib/pricing.js');

  // A freshly-contributed, normally-priced $0.08 learning.
  function freshLearning(overrides = {}) {
    return {
      id: 'lrn_fresh',
      category: 'code-execution',
      body: 'A short but real learning body about an API quirk.',
      quality_self_assessment: { specificity: 3, actionability: 3, novelty: 2, completeness: 3, total: 11 },
      quality: { unlocks: 0, ratings: 0, avg_helpfulness: 0, score: 0 },
      pricing: { base_price: 0.08, current_price: 0.08 },
      unlock_price: 0.08,
      created_at: new Date().toISOString(),
      ...overrides,
    };
  }

  it('estimateDiyCost is a real POSITIVE number (not the old always-0)', () => {
    const diy = pricing.estimateDiyCost(freshLearning());
    assert.equal(typeof diy, 'number');
    assert.ok(diy > 0, `estimated_diy_cost must be > 0, got ${diy}`);
  });

  it('qualityScore01 is a real number in [0,1] (not the old always-null)', () => {
    const q = pricing.qualityScore01(freshLearning());
    assert.equal(typeof q, 'number');
    assert.ok(q >= 0 && q <= 1, `quality_score must be in [0,1], got ${q}`);
    assert.notEqual(q, null);
  });

  it("verdict is NOT 'expensive' for a normal $0.08 learning", () => {
    const v = pricing.calculateVerdict(freshLearning());
    assert.notEqual(v, 'expensive',
      `a normally-priced learning must not read as 'expensive', got ${v}`);
    assert.ok(['strong_buy', 'recommended', 'consider'].includes(v));
  });

  it('the search-result value_signal now reads from the real helpers', () => {
    const h = sliceHandler('value_signal: {', 400);
    assert.ok(h.includes('pricingEngine.estimateDiyCost(r)'),
      'estimated_diy_cost_usd must come from estimateDiyCost, not the never-written token_cost_estimate');
    assert.ok(h.includes('pricingEngine.qualityScore01(r)'),
      'quality_score must come from qualityScore01, not the never-written quality_multiplier');
    // The dead keys must no longer be READ (the bug was `r.pricing?.token_cost_estimate`
    // etc.). A mention in an explanatory comment is fine; a `.pricing?.<deadkey>` read is not.
    assert.ok(!/pricing\?\.token_cost_estimate/.test(SERVER_SRC), 'must not read pricing.token_cost_estimate');
    assert.ok(!/pricing\?\.time_value_estimate/.test(SERVER_SRC), 'must not read pricing.time_value_estimate');
    assert.ok(!/pricing\?\.quality_multiplier/.test(SERVER_SRC), 'must not read pricing.quality_multiplier');
  });
});

// ─── 4. Held balance leak into dashboard headline (MISS-03/BUX-3) ────────────────

describe('4. GET /account/earnings splits held from owned', () => {
  // AUD19-8: window widened 3200 → 6500 — the handler grew (self-healing held
  // sweep + held_pending_assent field) and the populated-branch assertions sit
  // beyond the old window.
  let h;
  before(() => { h = sliceHandler("app.get('/account/earnings'", 6500); });

  it('exposes unassented_pending as a distinct field in BOTH branches', () => {
    // two occurrences: the source==='new' zero state and the populated return
    const count = (h.match(/unassented_pending:/g) || []).length;
    assert.ok(count >= 2, `unassented_pending must appear in both branches, found ${count}`);
  });

  it('reports total_contributor as OWNED (gross − held), not raw lifetime gross', () => {
    assert.ok(h.includes('contributorOwned') && /contributorGross - heldPending/.test(h),
      'must subtract the held bucket from the gross so the headline excludes not-yet-owned funds');
    assert.ok(/total_contributor: contributorOwned/.test(h),
      'the total_contributor field the dashboard reads must be the owned figure');
  });

  it('preserves the raw lifetime figure as total_contributor_gross (no info loss)', () => {
    assert.ok(h.includes('total_contributor_gross: contributorGross'),
      'must still expose the gross lifetime contributor total under a distinct key');
  });

  it('does not double-count: owned + held == gross by construction', () => {
    // Sanity check the arithmetic the handler uses.
    const gross = 2.50, held = 1.00;
    const owned = Math.max(0, gross - held);
    assert.equal(Number((owned + held).toFixed(6)), gross);
  });
});

// ─── 5. Withdraw ignores account suspension (SEC-2) ──────────────────────────────

describe('5. wallet-signed POST /withdraw honors suspension', () => {
  let h;
  before(() => { h = sliceHandler("app.post('/withdraw'", 5000); });

  it('checks disabled_at on the resolved account and returns 403', () => {
    assert.ok(/withdrawAccount && withdrawAccount\.disabled_at/.test(h),
      'must check the resolved account for disabled_at (suspension)');
    assert.ok(h.includes("error: 'Account suspended'") && /\}, 403\)/.test(h),
      'must return the same 403 Account suspended the other routes return');
  });

  it('the suspension check is positioned around the terms check (after account resolution)', () => {
    const resolveAt = h.indexOf('const withdrawAccount =');
    const suspendAt = h.indexOf('withdrawAccount.disabled_at');
    assert.ok(resolveAt !== -1 && suspendAt !== -1 && suspendAt > resolveAt,
      'suspension must be checked after the account is resolved by wallet');
  });
});

// ─── 6. openapi.json completeness + version (MISS-01) ────────────────────────────

describe('6. openapi.json is complete and current', () => {
  const spec = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'openapi.json'), 'utf-8'));
  const pkgVersion = require('../package.json').version;

  it('info.version matches the package version', () => {
    // Consistency, not a hardcoded pin: the 0.9.6 bump (d9cb31b) broke the
    // old hardcode and CI stayed red undetected — drift is the failure class.
    assert.equal(spec.info.version, pkgVersion);
  });

  it('documents the previously-missing paths', () => {
    for (const p of ['/account/accept-terms', '/account/link-wallet', '/withdraw/stripe', '/account/earnings']) {
      assert.ok(spec.paths[p], `${p} must be documented`);
    }
    assert.ok(spec.paths['/account/accept-terms'].post, '/account/accept-terms must have POST');
    assert.ok(spec.paths['/account/link-wallet'].post, '/account/link-wallet must have POST');
    assert.ok(spec.paths['/withdraw/stripe'].post, '/withdraw/stripe must have POST');
    assert.ok(spec.paths['/account/earnings'].get, '/account/earnings must have GET');
  });

  it('documents the account-owner detail without exposing public per-learning earnings', () => {
    const props = spec.paths['/account/earnings'].get.responses['200']
      .content['application/json'].schema.properties;
    assert.ok(props.unassented_pending, 'must document unassented_pending');
    assert.ok(props.total_contributor_gross, 'must document total_contributor_gross');
    assert.ok(props.total_contributor, 'must document total_contributor');
    assert.ok(props.by_learning, 'authenticated owner surface must document per-learning detail');

    const publicContributorProps = spec.paths['/contributor/{wallet}'].get.responses['200']
      .content['application/json'].schema.properties;
    assert.equal(Object.hasOwn(publicContributorProps, 'by_learning'), false,
      'unauthenticated contributor response must not document per-learning earnings');
    assert.equal(Object.hasOwn(spec.components.schemas.LearningFull.properties, 'earnings'), false,
      'buyer unlock schema must not document owner-only earnings');
  });

  it('/withdraw carries a withdraw-pause note and a 503 response', () => {
    assert.ok(/paused/i.test(spec.paths['/withdraw'].post.description || ''),
      '/withdraw description must mention the pause');
    assert.ok(spec.paths['/withdraw'].post.responses['503'], '/withdraw must document the 503');
  });

  it('the new payout paths document the 503 pause response', () => {
    assert.ok(spec.paths['/withdraw/stripe'].post.responses['503'],
      '/withdraw/stripe must document the 503 pause');
  });
});

// ─── 7. GET /version route (OPS-4) ───────────────────────────────────────────────

describe('7. GET /version route', () => {
  it('the route exists and returns version + gitSha + builtAt', () => {
    const h = sliceHandler("app.get('/version'", 400);
    assert.ok(h.includes('version: VERSION'), 'must return the package version');
    assert.ok(h.includes("process.env.GIT_SHA || 'unknown'"), "gitSha must default to 'unknown'");
    assert.ok(h.includes('process.env.BUILT_AT || null'), 'builtAt must default to null');
  });
});

// ─── 8. Round-2 survivors (FB-1 /dmca route, FB-2 payouts_paused, FB-4 price) ─────

describe('8. FB-1: /dmca route is wired (Terms §5.9.4(b) links /dmca)', () => {
  it('server.js serves /dmca via serveLegalPage(DMCA-POLICY.md)', () => {
    assert.ok(
      /app\.get\('\/dmca',\s*\(c\)\s*=>\s*serveLegalPage\(c,\s*'DMCA-POLICY\.md'/.test(SERVER_SRC),
      'the /dmca route must exist so the clickwrapped Terms link does not 404');
  });
});

describe('8. FB-2: earnings API is server-authoritative about the payout pause', () => {
  // AUD19-8: window widened 4500 → 6500 (see the held-sweep note above).
  let h;
  before(() => { h = sliceHandler("app.get('/account/earnings'", 6500); });
  it('GET /account/earnings returns payouts_paused derived from the kill-switch', () => {
    assert.ok(h.includes('payouts_paused'), 'must surface a payouts_paused flag');
    assert.ok(h.includes("process.env.CUSTODIAL_WITHDRAW_ENABLED !== 'true'"),
      'payouts_paused must derive from the CUSTODIAL_WITHDRAW_ENABLED kill-switch');
  });
  it('can_withdraw is gated on the kill-switch (never true while paused)', () => {
    assert.ok(h.includes("canWithdraw && process.env.CUSTODIAL_WITHDRAW_ENABLED === 'true'"),
      'can_withdraw must be false whenever the custodial payout kill-switch is engaged');
  });
});

describe('8. FB-4: search quotes ONE price = the unlock charge', () => {
  let h;
  before(() => { h = sliceHandler('const resolvedPrice = r.pricing?.current_price', 2200); });
  it('unlock_price_usd and current_price both use the single resolvedPrice', () => {
    assert.ok(h.includes('const resolvedPrice'), 'must resolve one canonical price');
    assert.ok(h.includes('unlock_price_usd: resolvedPrice'), 'unlock_price_usd must be the resolved charge');
    assert.ok(h.includes('current_price: resolvedPrice'), 'current_price must equal unlock_price_usd');
  });
  it('resolvedPrice mirrors the unlock route chain (no 10x understatement)', () => {
    assert.ok(h.includes('pricingEngine.getCurrentPrice?.(r, visibleCatalog())'),
      'must resolve via the same engine call the unlock route charges with');
  });
  it('the verdict is computed against the resolved (charged) price', () => {
    assert.ok(h.includes('calculateVerdict(pricedForVerdict)'),
      'verdict must key off the resolved charge, not the stale $0.005 unlock_price');
  });
});

// ─── 9. CP-1: recurring linked-wallet re-screen on SDN refresh (AML G-1) ─────────

describe('9. CP-1 linked-wallet re-screen', () => {
  it('rescreenLinkedWallets suspends on a hit and persists via saveAccounts', () => {
    const h = sliceHandler('function rescreenLinkedWallets', 1300);
    assert.ok(h.includes('checkOFAC(account.wallet)'), 'must re-check every linked wallet');
    assert.ok(h.includes("account.disabled_reason = 'ofac_rescreen_hit'"),
      'a hit must suspend with a machine-readable reason');
    assert.ok(h.includes('saveAccounts(accounts)'), 'suspension must be persisted');
    assert.ok(h.includes("logOFACBlock(account.wallet, 'rescreen-sweep')"),
      'every NEW hit must be written to the OFAC block log');
    assert.ok(h.includes('if (account.disabled_at) { results.alreadySuspended++; continue; }'),
      'already-suspended accounts keep their first-hit disabled_at and do not re-alert/re-log each cycle');
  });

  it('the sweep runs inside the refresh success path, error-contained', () => {
    const h = sliceHandler('async function refreshOFACList', 3200);
    const sweepAt = h.indexOf('rescreenLinkedWallets()');
    const successLogAt = h.indexOf('SDN list refreshed');
    assert.ok(sweepAt !== -1, 'refresh must trigger the re-screen sweep');
    assert.ok(successLogAt !== -1 && sweepAt > successLogAt,
      'sweep runs only after a successful list refresh (never against a stale/failed load)');
    assert.ok(h.includes('Re-screen sweep failed (refresh unaffected)'),
      'a sweep failure must be contained and never break the refresh cycle');
  });

  it('a hit alerts ops with the manual-review requirement', () => {
    const h = sliceHandler('async function refreshOFACList', 3200);
    assert.ok(h.includes('Linked-wallet re-screen HIT'), 'ops alert on any hit');
    assert.ok(h.includes('manual compliance review'), 'release path is manual review, never automatic');
  });
});
