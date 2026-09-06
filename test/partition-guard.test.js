'use strict';

/**
 * test/partition-guard.test.js — TRUST-P0: lib/partition-guard.js unit
 * coverage. The trust page's §4 internal/external split fabricated a false
 * State B on the live catalog (v95): /how-submissions-work said "An outside
 * builder has published here" while GET /knowledge/stats reported
 * total_contributors: 2, both Auxilo identities. Root cause: rows carrying
 * the operator's real account id with NO wallet on that particular row read
 * as external, because the operator register (config/internal-identities.json)
 * held only the operator WALLET, and computePartition never linked that
 * wallet to the account id it co-occurs with elsewhere in the catalog.
 *
 * Fixtures (per the binding fix):
 *   (a) platform rows only → state 'a'
 *   (b) operator account id + no wallet on that row, linked via another row
 *       that carries both the account id and the registered wallet → internal
 *       → state 'a' (this is the exact live-bug shape)
 *   (c) operator account id rows with NO wallet ANYWHERE in the catalog and
 *       no link → internal ONLY if named via INTERNAL_IDENTITIES_EXTRA_ACCOUNT_IDS;
 *       else external (documented residual — the register cannot discover an
 *       account id it was never shown next to a registered wallet)
 *   (d) one true external row → state 'b', external_n = 1
 *   (e) partitionAgreesWithStatsTruth contract holds over a 200-row synthetic
 *       catalog mixing every shape above
 *   (f) the state-'a' guard: computePartition never reports state 'b' when
 *       countDistinctContributors() agrees every distinct contributor
 *       present is internal
 *
 * Runner: node --test test/partition-guard.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  loadInternalIdentitiesRegister,
  isOperatorIdentity,
  buildInternalIdentitySet,
  isInternalRow,
  computePartition,
  partitionAgreesWithStatsTruth,
} = require('../lib/partition-guard.js');
const { isPlatformContributor } = require('../lib/accounts.js');
const { contributorIdentity, countDistinctContributors } = require('../lib/stats-truth.js');

const PLATFORM_WALLET = '0xPLATFORM00000000000000000000000000000001';
const OPERATOR_WALLET = '0xA19Cf92cc1daCf742f0E50b4128cAD3A86A81EC4';
const OPERATOR_WALLET_LOWER = OPERATOR_WALLET.toLowerCase();
const OPERATOR_ACCOUNT_ID = 'acc_operator_real_id';
const EXTERNAL_WALLET = '0xEXTERNAL000000000000000000000000000000EE';
const EXTERNAL_ACCOUNT_ID = 'acc_external_builder';

function makeRow(overrides) {
  return Object.assign({
    id: 'row_' + Math.random().toString(36).slice(2),
    contributor_account_id: null,
    contributor_wallet: null,
  }, overrides);
}

// A register whose file+env layer holds ONLY the operator wallet — mirrors
// config/internal-identities.json's shipped state (account_ids stays empty;
// the operator's account id is meant to be discovered by linking, not
// hand-entered).
function walletOnlyRegister(extra) {
  return loadInternalIdentitiesRegister('/nonexistent/does-not-exist.json', {
    INTERNAL_IDENTITIES_EXTRA_WALLETS: OPERATOR_WALLET,
    ...extra,
  });
}

const basePartitionOpts = (register) => ({
  platformWallets: [PLATFORM_WALLET],
  register,
  isPlatformContributorFn: isPlatformContributor,
});

describe('lib/partition-guard.js — TRUST-P0 fixtures', () => {
  it('(a) platform rows only → state a, external_n 0', () => {
    const register = walletOnlyRegister();
    const rows = [
      makeRow({ id: 'p1' }), // null/null → platform default
      makeRow({ id: 'p2', contributor_wallet: PLATFORM_WALLET }),
      makeRow({ id: 'p3', contributor_account_id: 'acc_platform' }),
    ];
    const partition = computePartition(rows, basePartitionOpts(register));
    assert.equal(partition.state, 'a');
    assert.equal(partition.external_n, 0);
    assert.equal(partition.total_n, 3);
  });

  it('(b) operator account id + no wallet on that row, linked via a sibling row → internal, state a (the live-bug shape)', () => {
    const register = walletOnlyRegister(); // register.wallets has ONLY the operator wallet
    assert.equal(register.accountIds.size, 0, 'precondition: account_ids starts empty, exactly like the shipped register');

    const rows = [
      // Most of the operator's submissions: real account id, no wallet on
      // the row at all — this is the shape that read as external pre-fix.
      makeRow({ id: 'op_no_wallet_1', contributor_account_id: OPERATOR_ACCOUNT_ID }),
      makeRow({ id: 'op_no_wallet_2', contributor_account_id: OPERATOR_ACCOUNT_ID }),
      // One sibling row somewhere in the catalog carries BOTH the account id
      // and the registered wallet — the one-hop link source.
      makeRow({ id: 'op_linking_row', contributor_account_id: OPERATOR_ACCOUNT_ID, contributor_wallet: OPERATOR_WALLET }),
    ];

    const identities = buildInternalIdentitySet(rows, { platformWallets: [PLATFORM_WALLET], register });
    assert.ok(identities.has(OPERATOR_ACCOUNT_ID), 'the operator account id is discovered by linking and added to INTERNAL_IDENTITIES');

    const partition = computePartition(rows, basePartitionOpts(register));
    assert.equal(partition.state, 'a', 'linked operator account id resolves internal — no false State B');
    assert.equal(partition.external_n, 0);
    assert.equal(partition.total_n, 3);
  });

  it('(b, order independence) the link still applies even when the no-wallet rows are seen before the linking row', () => {
    const register = walletOnlyRegister();
    const rows = [
      makeRow({ id: 'op_linking_row', contributor_account_id: OPERATOR_ACCOUNT_ID, contributor_wallet: OPERATOR_WALLET }),
      makeRow({ id: 'op_no_wallet_1', contributor_account_id: OPERATOR_ACCOUNT_ID }),
    ];
    const partitionA = computePartition(rows, basePartitionOpts(register));
    const partitionB = computePartition([...rows].reverse(), basePartitionOpts(register));
    assert.equal(partitionA.state, 'a');
    assert.equal(partitionB.state, 'a', 'buildInternalIdentitySet pre-scans the WHOLE catalog before classifying any row, so order cannot matter');
  });

  it('(c) operator account id with NO wallet anywhere and no link → external unless named via env extra (documented residual)', () => {
    const registerNoExtra = loadInternalIdentitiesRegister('/nonexistent/does-not-exist.json', {});
    const rowsUnlinked = [
      makeRow({ id: 'orphan_1', contributor_account_id: OPERATOR_ACCOUNT_ID }),
      makeRow({ id: 'orphan_2', contributor_account_id: OPERATOR_ACCOUNT_ID }),
    ];
    const unlinkedPartition = computePartition(rowsUnlinked, basePartitionOpts(registerNoExtra));
    assert.equal(unlinkedPartition.state, 'b', 'an account id never seen next to a registered wallet cannot be discovered by linking — external, documented');
    assert.equal(unlinkedPartition.external_n, 2);

    // Same catalog, but INTERNAL_IDENTITIES_EXTRA_ACCOUNT_IDS names the id —
    // the documented mitigation path (already supported, PUNCH-LIST TRUST-PAGE P0).
    const registerWithExtra = loadInternalIdentitiesRegister('/nonexistent/does-not-exist.json', {
      INTERNAL_IDENTITIES_EXTRA_ACCOUNT_IDS: OPERATOR_ACCOUNT_ID,
    });
    const mitigatedPartition = computePartition(rowsUnlinked, basePartitionOpts(registerWithExtra));
    assert.equal(mitigatedPartition.state, 'a', 'env extra names the account id directly — internal, state a');
    assert.equal(mitigatedPartition.external_n, 0);
  });

  it('(d) one true external row → state b, external_n 1', () => {
    const register = walletOnlyRegister();
    const rows = [
      makeRow({ id: 'p1' }),
      makeRow({ id: 'p2', contributor_wallet: PLATFORM_WALLET }),
      makeRow({ id: 'ext_1', contributor_account_id: EXTERNAL_ACCOUNT_ID, contributor_wallet: EXTERNAL_WALLET }),
    ];
    const partition = computePartition(rows, basePartitionOpts(register));
    assert.equal(partition.state, 'b');
    assert.equal(partition.external_n, 1);
    assert.equal(partition.total_n, 3);
  });

  it('(d) a wallet-only external row (no account id) is external too, and counted in null_account_n', () => {
    const register = walletOnlyRegister();
    const rows = [
      makeRow({ id: 'p1' }),
      makeRow({ id: 'ext_wallet_only', contributor_wallet: EXTERNAL_WALLET }),
    ];
    const partition = computePartition(rows, basePartitionOpts(register));
    assert.equal(partition.state, 'b');
    assert.equal(partition.external_n, 1);
    assert.equal(partition.null_account_n, 1, 'a null-account external row is reported inside external_n, never a separate fail condition');
  });

  it('never reads a null account id as external on its own — no account AND no wallet is the platform default, always internal', () => {
    const register = walletOnlyRegister();
    const rows = [makeRow({ id: 'null_null' })];
    const partition = computePartition(rows, basePartitionOpts(register));
    assert.equal(partition.state, 'a');
    assert.equal(partition.external_n, 0, 'no standalone null-account-equals-external rule exists');
  });

  it('(e) partitionAgreesWithStatsTruth contract holds over a 200-row synthetic catalog mixing every shape', () => {
    const register = walletOnlyRegister();
    const rows = [];

    // 40 platform null/null rows
    for (let i = 0; i < 40; i++) rows.push(makeRow({ id: `mix_platform_null_${i}` }));
    // 20 explicit platform-wallet rows
    for (let i = 0; i < 20; i++) rows.push(makeRow({ id: `mix_platform_wallet_${i}`, contributor_wallet: PLATFORM_WALLET }));
    // 15 explicit platform-account-id rows
    for (let i = 0; i < 15; i++) rows.push(makeRow({ id: `mix_platform_acct_${i}`, contributor_account_id: 'acc_platform' }));
    // 1 linking row (operator account id + operator wallet)
    rows.push(makeRow({ id: 'mix_operator_link', contributor_account_id: OPERATOR_ACCOUNT_ID, contributor_wallet: OPERATOR_WALLET }));
    // 60 operator rows with the account id but NO wallet (the live-bug shape) — must resolve internal via the link above
    for (let i = 0; i < 60; i++) rows.push(makeRow({ id: `mix_operator_no_wallet_${i}`, contributor_account_id: OPERATOR_ACCOUNT_ID }));
    // 10 rows on the bare operator wallet, no account id
    for (let i = 0; i < 10; i++) rows.push(makeRow({ id: `mix_operator_wallet_only_${i}`, contributor_wallet: OPERATOR_WALLET }));
    // 30 genuinely external rows, one shared external builder identity (account + wallet)
    for (let i = 0; i < 30; i++) {
      rows.push(makeRow({ id: `mix_external_${i}`, contributor_account_id: EXTERNAL_ACCOUNT_ID, contributor_wallet: EXTERNAL_WALLET }));
    }
    // 24 more external rows, a second external builder, wallet-only (no account)
    const EXTERNAL_WALLET_2 = '0xEXTERNAL222222222222222222222222222222EE';
    for (let i = 0; i < 24; i++) rows.push(makeRow({ id: `mix_external2_${i}`, contributor_wallet: EXTERNAL_WALLET_2 }));

    assert.equal(rows.length, 200, 'sanity: the synthetic catalog is exactly 200 rows');

    const opts = basePartitionOpts(register);
    const result = partitionAgreesWithStatsTruth(rows, opts);
    assert.equal(result.conflictIdentities.size, 0, 'no identity is split-brained across its own rows');
    assert.equal(result.agrees, true, 'external-classified identities == full identity set minus INTERNAL_IDENTITIES, exactly');

    // Cross-check against computePartition's own external_n and against
    // countDistinctContributors-style truth: exactly 2 external identities
    // (EXTERNAL_ACCOUNT_ID and the lowercased EXTERNAL_WALLET_2) among 54
    // external rows (30 + 24); everything else is one of the internal
    // identities (acc_platform, the platform wallet's own identity is
    // subsumed by acc_platform since isPlatformContributor treats a
    // platform-wallet row as platform, and OPERATOR_ACCOUNT_ID).
    const partition = computePartition(rows, opts);
    assert.equal(partition.total_n, 200);
    assert.equal(partition.external_n, 54, '30 + 24 genuinely external rows');
    assert.equal(partition.state, 'b');
    assert.equal(result.externalIdentities.size, 2, 'two distinct external contributor identities, matching the two external builders');
    assert.ok(result.externalIdentities.has(EXTERNAL_ACCOUNT_ID));
    assert.ok(result.externalIdentities.has(EXTERNAL_WALLET_2.toLowerCase()));
    assert.ok(!result.externalIdentities.has(OPERATOR_ACCOUNT_ID), 'the operator account id must never be classed external once linked');
  });

  it('(e) the contract also holds on a fully-internal 200-row catalog (state a, agrees true, empty external set)', () => {
    const register = walletOnlyRegister();
    const rows = [];
    for (let i = 0; i < 100; i++) rows.push(makeRow({ id: `all_int_null_${i}` }));
    rows.push(makeRow({ id: 'all_int_link', contributor_account_id: OPERATOR_ACCOUNT_ID, contributor_wallet: OPERATOR_WALLET }));
    for (let i = 0; i < 99; i++) rows.push(makeRow({ id: `all_int_op_${i}`, contributor_account_id: OPERATOR_ACCOUNT_ID }));
    assert.equal(rows.length, 200);

    const opts = basePartitionOpts(register);
    const result = partitionAgreesWithStatsTruth(rows, opts);
    assert.equal(result.agrees, true);
    assert.equal(result.externalIdentities.size, 0);
    assert.equal(result.conflictIdentities.size, 0);

    const partition = computePartition(rows, opts);
    assert.equal(partition.state, 'a');
    assert.equal(partition.external_n, 0);
  });

  it('(f) computePartition never reports state b when countDistinctContributors agrees every distinct contributor present is internal', () => {
    const register = walletOnlyRegister();
    // The exact P0 shape: operator rows split across account-only and
    // account+wallet forms, linked; stats-truth's own contributor count
    // must agree there are 0 external contributors, and the guard's
    // precondition (countDistinctContributors === internal identities
    // present) must hold — proving computePartition's state 'a' output is
    // not a coincidence of the row-level pass alone.
    const rows = [
      makeRow({ id: 'f_link', contributor_account_id: OPERATOR_ACCOUNT_ID, contributor_wallet: OPERATOR_WALLET }),
      makeRow({ id: 'f_no_wallet_1', contributor_account_id: OPERATOR_ACCOUNT_ID }),
      makeRow({ id: 'f_no_wallet_2', contributor_account_id: OPERATOR_ACCOUNT_ID }),
      makeRow({ id: 'f_platform_null' }),
    ];
    const partition = computePartition(rows, basePartitionOpts(register));
    assert.equal(partition.state, 'a', 'the page must never render State B here');
    assert.equal(partition.external_n, 0);

    const distinctContributors = countDistinctContributors(rows);
    const identities = new Set(rows.map((r) => contributorIdentity(r)));
    assert.equal(distinctContributors, identities.size, 'sanity: countDistinctContributors matches the raw identity set size');
    assert.equal(distinctContributors, 2, 'two distinct contributors present: OPERATOR_ACCOUNT_ID and acc_platform (the null/null default)');
  });

  it('computePartition returns null for a non-array catalog (derivation failure, not n=0)', () => {
    const register = walletOnlyRegister();
    assert.equal(computePartition(null, basePartitionOpts(register)), null);
    assert.equal(computePartition(undefined, basePartitionOpts(register)), null);
    assert.equal(computePartition('not-an-array', basePartitionOpts(register)), null);
  });

  it('computePartition types an empty array as state a (a legitimate zero-learning catalog)', () => {
    const register = walletOnlyRegister();
    const partition = computePartition([], basePartitionOpts(register));
    assert.deepEqual(partition, { total_n: 0, external_n: 0, null_account_n: 0, state: 'a' });
  });

  it('isOperatorIdentity remains the unlinked, single-row register check (backward compatible)', () => {
    const register = walletOnlyRegister();
    assert.equal(isOperatorIdentity({ contributor_account_id: null, contributor_wallet: OPERATOR_WALLET }, register), true);
    assert.equal(isOperatorIdentity({ contributor_account_id: null, contributor_wallet: OPERATOR_WALLET.toUpperCase() }, register), true, 'case-insensitive');
    assert.equal(isOperatorIdentity({ contributor_account_id: OPERATOR_ACCOUNT_ID, contributor_wallet: null }, register), false, 'unlinked: the register alone (no rows to scan) cannot discover this account id');
  });

  it('isInternalRow: isPlatformContributorFn dominates and is checked before internalIdentities', () => {
    const register = walletOnlyRegister();
    const identities = buildInternalIdentitySet([], { platformWallets: [PLATFORM_WALLET], register });
    const alwaysPlatform = () => true;
    const row = { contributor_account_id: EXTERNAL_ACCOUNT_ID, contributor_wallet: EXTERNAL_WALLET };
    assert.equal(isInternalRow(row, { platformWallets: [PLATFORM_WALLET], isPlatformContributorFn: alwaysPlatform, internalIdentities: identities }), true);
  });
});

// ─── TRUST-P0 PASS 2 (2026-09-06, adversarial re-check) ────────────────────
// Two more findings on top of the fixtures above:
//   B1 — isInternalRow's row-level wallet fallback let a genuinely external
//        account get flipped internal by ONE row carrying a registered
//        wallet (address reuse / an out-of-band artifact), split-braining
//        the identity. Fixed: classification is per identity only, and the
//        one-hop link now requires every wallet-bearing row of an account
//        to agree before the account is linked internal.
//   B2 — loadInternalIdentitiesRegister silently degraded ANY read failure
//        (not just ENOENT) to an empty register, indistinguishable from a
//        legitimately empty one. Fixed: a non-ENOENT failure now returns a
//        `{ error }` sentinel and computePartition refuses to serve either
//        branch instead of under-registering silently.
describe('lib/partition-guard.js — TRUST-P0 PASS 2 fixtures (B1, B2)', () => {
  it('(B1) a genuinely external account whose ONLY row happens to carry the platform wallet is still external — state b, external_n 1, never a', () => {
    const register = walletOnlyRegister();
    const rows = [
      makeRow({ id: 'p1' }), // platform default, internal
      // The exact adversarial shape: an external account (never registered,
      // never linked) whose single visible row's wallet field happens to
      // equal the PLATFORM wallet — address reuse, a corrupted field, or an
      // out-of-band artifact, not evidence the account is Auxilo's own.
      makeRow({ id: 'ext_platform_wallet_row', contributor_account_id: EXTERNAL_ACCOUNT_ID, contributor_wallet: PLATFORM_WALLET }),
    ];
    const partition = computePartition(rows, basePartitionOpts(register));
    assert.equal(partition.state, 'b', 'a row carrying the platform wallet must never flip an unrelated external account id internal');
    assert.equal(partition.external_n, 1);
    assert.equal(partition.total_n, 2);

    const contract = partitionAgreesWithStatsTruth(rows, basePartitionOpts(register));
    assert.equal(contract.agrees, true, 'no split-brain: the identity classifies consistently');
    assert.equal(contract.conflictIdentities.size, 0);
  });

  it('(B1) the same external account with a SECOND row on its own real external wallet — both rows external, consistently, identity-level not row-level (the minimal.js repro shape)', () => {
    const register = walletOnlyRegister();
    const rows = [
      makeRow({ id: 'ext_own_wallet', contributor_account_id: EXTERNAL_ACCOUNT_ID, contributor_wallet: EXTERNAL_WALLET }),
      makeRow({ id: 'ext_platform_wallet_row', contributor_account_id: EXTERNAL_ACCOUNT_ID, contributor_wallet: PLATFORM_WALLET }),
    ];
    const partition = computePartition(rows, basePartitionOpts(register));
    assert.equal(partition.state, 'b');
    assert.equal(partition.external_n, 2, 'both rows of the one external identity classify the same way — never split');
    assert.equal(partition.null_account_n, 0);

    const contract = partitionAgreesWithStatsTruth(rows, basePartitionOpts(register));
    assert.equal(contract.agrees, true);
    assert.equal(contract.conflictIdentities.size, 0);
    assert.ok(contract.externalIdentities.has(EXTERNAL_ACCOUNT_ID));
  });

  it('(B1) one-hop linking requires unanimity: an operator-account row with a CONFLICTING external wallet stops the whole account from linking, even though another row of the same account carries the registered wallet', () => {
    const register = walletOnlyRegister();
    const rows = [
      makeRow({ id: 'op_registered_wallet', contributor_account_id: OPERATOR_ACCOUNT_ID, contributor_wallet: OPERATOR_WALLET }),
      makeRow({ id: 'op_conflicting_wallet', contributor_account_id: OPERATOR_ACCOUNT_ID, contributor_wallet: EXTERNAL_WALLET }),
    ];
    const identities = buildInternalIdentitySet(rows, { platformWallets: [PLATFORM_WALLET], register });
    assert.equal(identities.has(OPERATOR_ACCOUNT_ID), false, 'a conflicting wallet on even one row disqualifies the account from being linked');

    const partition = computePartition(rows, basePartitionOpts(register));
    assert.equal(partition.state, 'b', 'fails closed — never fabricates internal on conflicting evidence');
    assert.equal(partition.external_n, 2);
  });

  it('(runtime contract) computePartition refuses (state null, identity-conflict) when the injected isPlatformContributorFn itself disagrees across rows of one identity', () => {
    // Defense-in-depth: the fixes above make a real per-row disagreement
    // unreachable through this module's own logic (contributorIdentity(row)
    // is the same value for every row of an identity, so internalIdentities
    // membership cannot itself vary). This exercises the runtime contract
    // check directly by injecting a pathological isPlatformContributorFn
    // that disagrees with itself for two rows sharing one identity —
    // simulating a future regression upstream of this module.
    const register = walletOnlyRegister();
    const rows = [
      makeRow({ id: 'row_1', contributor_account_id: EXTERNAL_ACCOUNT_ID, contributor_wallet: EXTERNAL_WALLET }),
      makeRow({ id: 'row_2', contributor_account_id: EXTERNAL_ACCOUNT_ID, contributor_wallet: EXTERNAL_WALLET }),
    ];
    const flakyIsPlatformContributor = (row) => row.id === 'row_1'; // true for one row, false for its sibling
    const partition = computePartition(rows, {
      platformWallets: [PLATFORM_WALLET],
      register,
      isPlatformContributorFn: flakyIsPlatformContributor,
    });
    assert.equal(partition.state, null, 'a split-brained identity must never render either branch');
    assert.equal(partition.reason, 'identity-conflict');
    assert.deepEqual(partition.conflicts, [EXTERNAL_ACCOUNT_ID]);
    assert.equal(partition.external_n, null, 'no external count is fabricated when the state itself is unresolved');
    assert.equal(partition.total_n, 2, 'total_n stays reportable even when state cannot be picked');
  });

  it('(B2) a register file that exists but fails to parse returns an { error } sentinel, never a silently-empty register', () => {
    const badPath = path.join(os.tmpdir(), `partition-guard-corrupt-${process.pid}-${Date.now()}.json`);
    fs.writeFileSync(badPath, '{ this is not valid json ][');
    try {
      const corrupt = loadInternalIdentitiesRegister(badPath, {});
      assert.ok(corrupt.error, 'a parse failure returns a truthy .error, not empty wallet/accountId sets');
      assert.equal(corrupt.wallets, undefined, 'the sentinel carries no wallets set');
      assert.equal(corrupt.accountIds, undefined, 'the sentinel carries no accountIds set');
    } finally {
      fs.rmSync(badPath, { force: true });
    }
  });

  it('(B2) computePartition refuses (state null, register-error) on a corrupted register, even over a purely-internal catalog — never fabricates State B', () => {
    const badPath = path.join(os.tmpdir(), `partition-guard-corrupt-${process.pid}-${Date.now()}-2.json`);
    fs.writeFileSync(badPath, '{ this is not valid json ][');
    try {
      const corruptRegister = loadInternalIdentitiesRegister(badPath, {});
      const rows = [
        makeRow({ id: 'p1' }),
        makeRow({ id: 'p2', contributor_account_id: OPERATOR_ACCOUNT_ID, contributor_wallet: OPERATOR_WALLET }),
        makeRow({ id: 'p3', contributor_account_id: OPERATOR_ACCOUNT_ID }),
      ];
      const partition = computePartition(rows, {
        platformWallets: [PLATFORM_WALLET],
        register: corruptRegister,
        isPlatformContributorFn: isPlatformContributor,
      });
      assert.equal(partition.state, null, 'register corruption must never silently degrade to a fabricated state — this catalog is pure-internal pre-corruption');
      assert.equal(partition.reason, 'register-error');
      assert.equal(partition.external_n, null);
      assert.equal(partition.null_account_n, null);
      assert.equal(partition.total_n, 3, 'total_n is still reportable — only the branch pick is refused');
    } finally {
      fs.rmSync(badPath, { force: true });
    }
  });

  it('(B2) ENOENT is unaffected — a nonexistent path still degrades to an empty file layer, env additions still apply (unlike a corrupted-but-present file)', () => {
    const register = loadInternalIdentitiesRegister('/definitely/does/not/exist.json', {
      INTERNAL_IDENTITIES_EXTRA_WALLETS: OPERATOR_WALLET,
    });
    assert.equal(register.error, undefined, 'ENOENT is not treated as corruption');
    assert.ok(register.wallets.has(OPERATOR_WALLET.toLowerCase()), 'env additions still apply on top of the empty file layer');
  });
});
