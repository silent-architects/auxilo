'use strict';

/**
 * test/dr8-self-unlock-free.test.js — DR-8 owner short-circuit: self-unlock is $0
 * (PUNCH-LIST §31 DR-8, option (a), Tyler 2026-07-20)
 *
 * The public claim ("your own learnings come back free" — README:7/100/122,
 * memory-first positioning, WP-1a) is now shipped behavior: GET /knowledge/:id
 * serves a PROVABLE owner free BEFORE any charge. Provable means (a) the
 * caller's valid API key resolves to the learning's contributor_account_id, or
 * (b) it resolves to an account whose LINKED wallet (account.wallet — set only
 * by the AUD19-3 EIP-712 account-bound link flow) equals contributor_wallet.
 * The X-Wallet-Address header is a bare claim and never unlocks the free path;
 * header claimants and anonymous x402 payers still pay, and the M-2 wash guard
 * still zeroes their self-dealing accrual post-payment.
 *
 * The free path is a PURE READ: no credit deduction, no counter bump (not even
 * ops-only unlocks_total), no demand/ranking movement, no earnings entry, no
 * WAL, no unlock event, no purchase-ledger write (LW-7: no rating rights), no
 * file write of any kind — an unlimited free path must not be able to spin any
 * persisted signal (else it becomes a free demand/ranking pump).
 *
 * Strategy: structural source analysis of the server.js handler wiring — the
 * same convention as test/cp6-accrual-gate.test.js / test/x402-router-server.test.js
 * (server.js binds a listener at require-time, so handler logic is pinned at
 * the source level; the ownership predicate's inputs are lib functions with
 * their own behavioral suites: validateApiKey, hasMinScope, linkWallet).
 *
 * Runner: node --test test/dr8-self-unlock-free.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SERVER_SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

// The unlock route handler: from its registration to the next route registration.
function unlockHandler() {
  const start = SERVER_SRC.indexOf("app.get('/knowledge/:id', async (c) => {");
  assert.ok(start !== -1, 'unlock route present');
  const end = SERVER_SRC.indexOf("app.post('/knowledge/:id/rate'", start);
  assert.ok(end !== -1, 'rate route follows the unlock route');
  return SERVER_SRC.slice(start, end);
}

// The owner short-circuit block: predicate + free return, ending where the
// router-mode block begins.
function ownerBlock(h) {
  const start = h.indexOf('let dr8OwnerAccountId = null;');
  assert.ok(start !== -1, 'DR-8 owner short-circuit present');
  const end = h.indexOf('// R-01 router mode', start);
  assert.ok(end !== -1, 'router-mode block follows the owner short-circuit');
  return h.slice(start, end);
}

let h, owner;
before(() => {
  h = unlockHandler();
  owner = ownerBlock(h);
});

// ─── 1. Ordering: the free path runs BEFORE any charge or refuse gate ───────────
describe('DR-8 placement (free before any charge)', () => {
  it('owner short-circuit sits BEFORE dualAuthDynamic (no credit burn, no 402, no charge)', () => {
    const ownerAt = h.indexOf('let dr8OwnerAccountId = null;');
    const chargeAt = h.indexOf('await dualAuthDynamic(');
    assert.ok(chargeAt !== -1, 'paid path intact');
    assert.ok(ownerAt < chargeAt, 'ownership must be decided before the charge');
  });

  it('owner short-circuit sits BEFORE the CONTRIBUTOR_NOT_ONBOARDED refuse gate (an owner recall moves no money)', () => {
    const ownerAt = h.indexOf('let dr8OwnerAccountId = null;');
    const refuseAt = h.indexOf("code: 'CONTRIBUTOR_NOT_ONBOARDED'");
    assert.ok(refuseAt !== -1, 'refuse gate intact for buyers');
    assert.ok(ownerAt < refuseAt, 'a not-yet-onboarded builder still gets their own content back');
  });

  it('owner short-circuit sits AFTER the S21-2 moderation gate (non-approved items stay 404 on this route)', () => {
    const modAt = h.indexOf('CONTENT_MODERATION_ENABLED && learning.status');
    const ownerAt = h.indexOf('let dr8OwnerAccountId = null;');
    assert.ok(modAt !== -1 && modAt < ownerAt,
      'owner recall applies to servable learnings; held items go through /account/pending');
  });

  it('free return short-circuits: the owner block returns c.json before the paid path', () => {
    assert.ok(owner.includes('if (dr8OwnerAccountId) {'), 'guarded free return');
    assert.ok(owner.includes('return c.json({'), 'free path returns directly');
  });
});

// ─── 2. Ownership must be PROVEN (never an unverified claim) ────────────────────
describe('DR-8 ownership predicate', () => {
  it('account arm: valid API key resolved to the contributor account', () => {
    assert.ok(owner.includes('validateApiKey(dr8Key)'), 'identity from key validation');
    assert.ok(owner.includes("hasMinScope(dr8KeyResult.effective_scope || dr8KeyResult.scope, 'read')"),
      'same minimum scope as the paid API-key path (D2 rank check)');
    assert.ok(owner.includes('dr8KeyResult.accountId === dr8ContribAccountId'), 'account match arm');
  });

  it('wallet arm: the ACCOUNT-LINKED wallet (AUD19-3), read authoritatively', () => {
    assert.ok(owner.includes('loadAccounts()[dr8KeyResult.accountId]'),
      'authoritative account read (not the cache)');
    assert.ok(owner.includes('dr8Account.wallet'),
      'account.wallet — set only by the EIP-712 account-bound linkWallet flow');
    assert.ok(owner.includes('dr8LinkedWallet === dr8ContribWallet'), 'linked-wallet match arm');
  });

  it('the X-Wallet-Address header is NEVER consulted by the free path (unverified claim)', () => {
    assert.ok(!owner.includes('X-Wallet-Address'),
      'a header claim must not unlock free content — it still routes through the paid path');
    // The header IS still read by the M-2 wash guard, which runs post-payment.
    const m2At = h.indexOf("c.req.header('X-Wallet-Address')");
    const chargeAt = h.indexOf('await dualAuthDynamic(');
    assert.ok(m2At !== -1 && m2At > chargeAt,
      'M-2 wash guard still reads the header claim AFTER the charge');
  });

  it('API-key precedence mirrors dualAuthDynamic (X-API-Key, then Bearer)', () => {
    assert.ok(owner.indexOf("c.req.header('X-API-Key')") < owner.indexOf("startsWith('Bearer ')"),
      'same header precedence as the paid path — one identity, two spellings');
  });
});

// ─── 3. The free path is a PURE READ (M-2 zeroing semantics, strengthened) ──────
describe('DR-8 free path moves no signals', () => {
  const FORBIDDEN = [
    ['deductCredit', 'no credit burn'],
    ['unlocks_total', 'not even the ops-only raw counter (unlimited free bumps would spin it + safeWrite per hit)'],
    ['quality.unlocks', 'no ranking counter (feeds computeScore / search ranking)'],
    ['demand', 'no demand-window bump (feeds the pricing engine spike)'],
    ['earnings', 'no earnings entry, no gross/contributor/platform movement'],
    ['pending_balance', 'no balance movement'],
    ['createWalEntry', 'no WAL'],
    ['appendUnlockEvent', 'no analytics unlock event (not a sale)'],
    ['recordPurchase', 'no purchase-ledger write — LW-7: self-unlocks never mint rating rights'],
    ['recordAccrual', 'no accrual-cap arm (must not affect a real buyer accrual window)'],
    ['searchSourceCache', 'no discovery-premium cache consumption'],
    ['safeWrite', 'no file write of ANY kind'],
    ['acquireLearningsLock', 'no catalog lock — nothing is mutated'],
  ];
  for (const [needle, why] of FORBIDDEN) {
    it(`owner block never touches ${needle} (${why})`, () => {
      assert.ok(!owner.includes(needle), `forbidden on the free path: ${needle} — ${why}`);
    });
  }

  it('free response declares itself: amount_paid_usd 0, zero earnings, self_unlock + owner_recall_free', () => {
    assert.ok(owner.includes('amount_paid_usd: 0'));
    assert.ok(owner.includes('contributor_earned_usd: 0'));
    assert.ok(owner.includes('platform_earned_usd: 0'));
    assert.ok(owner.includes('self_unlock: true'));
    assert.ok(owner.includes('owner_recall_free: true'));
  });

  it('free response strips ops counters and moderation-internal fields like every buyer-facing projection', () => {
    assert.ok(owner.includes('stripOpsCounters(ownerLearning.quality)'));
    for (const f of ['injection_flags', 'possible_duplicate_of', 'moderation',
      'sensitivity_signals', 'sensitivity_evidence', 'learning_type', 'sanitized_from']) {
      assert.ok(owner.includes(f), `strips ${f}`);
    }
  });

  it('stripOpsCounters is declared at module scope BEFORE the route (sloppy-mode block hoisting cannot reach a pre-payment return)', () => {
    const declAt = SERVER_SRC.indexOf('function stripOpsCounters(quality)');
    const routeAt = SERVER_SRC.indexOf("app.get('/knowledge/:id'");
    assert.ok(declAt !== -1 && declAt < routeAt,
      'declaration must execute before any unlock request can return');
    assert.equal((SERVER_SRC.match(/function stripOpsCounters\(/g) || []).length, 1,
      'exactly one declaration — the old in-route copy is gone');
  });
});

// ─── 4. Non-owners: the paid path is UNCHANGED ──────────────────────────────────
describe('DR-8 leaves the paid path intact', () => {
  it('non-owner fall-through: dualAuthDynamic still charges, with the unlock description', () => {
    assert.ok(h.includes("await dualAuthDynamic(c, UNLOCK_PRICE,"), 'charge call intact');
    assert.ok(h.includes("'unlock', 'read', routerCtx)"), 'same credit type, scope, and router context');
  });

  it('M-2 wash guard intact as the post-payment backstop (header claims + anonymous x402 still pay, still accrue nothing)', () => {
    assert.ok(h.includes('const isSelfUnlock ='), 'M-2 predicate present');
    assert.ok(h.includes('if (isSelfUnlock) {'), 'M-2 branch present');
    assert.ok(h.includes('const countersCredited = !accrualCapped && !isSelfUnlock;'),
      'CAT-1 §5 counter gating unchanged');
  });

  it('accrual cap (AUD19-2) untouched and still AFTER the M-2 guard', () => {
    const selfAt = h.indexOf('if (isSelfUnlock) {');
    const capAt = h.indexOf('if (accrualCapped) {');
    assert.ok(selfAt !== -1 && capAt !== -1 && selfAt < capAt, 'ordering preserved');
  });

  it('LW-7 purchase ledger still written on the real paid path only', () => {
    const paidTail = h.slice(h.indexOf('commitWal(walId);'));
    assert.ok(paidTail.includes('recordPurchase(buyerAccountId, id)'),
      'paid delivery still mints rating rights');
  });
});

// ─── 5. Contract surfaces carry the new truth ───────────────────────────────────
describe('DR-8 contract surfaces', () => {
  it('openapi.json documents the free owner path on GET /knowledge/{id}', () => {
    const spec = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'openapi.json'), 'utf8'));
    const get = spec.paths['/knowledge/{id}'].get;
    assert.match(get.description, /SELF-UNLOCK IS \$0/i);
    const rev = spec.components.schemas.LearningFull.properties._revenue.properties;
    assert.ok(rev.amount_paid_usd, '_revenue.amount_paid_usd documented');
    assert.ok(rev.owner_recall_free, '_revenue.owner_recall_free documented');
    assert.ok(rev.self_unlock, '_revenue.self_unlock documented');
  });

  it('MCP auxilo_unlock description states own learnings are $0', () => {
    const mcp = fs.readFileSync(path.join(__dirname, '..', 'mcp-server.js'), 'utf8');
    const at = mcp.indexOf("name: 'auxilo_unlock'");
    assert.ok(at !== -1);
    const desc = mcp.slice(at, mcp.indexOf('inputSchema', at));
    assert.match(desc, /OWN learnings are \$0/i);
  });

  it('/prices listing states the $0 self-unlock', () => {
    assert.match(SERVER_SRC, /'\/knowledge\/:id': \{ price: '\$0\.05'[^}]*Your own learnings are \$0/);
  });
});
