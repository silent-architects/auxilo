'use strict';

/**
 * test/cp6-accrual-gate.test.js — CP-6 accrual-time acceptance gate
 * (payee-agency DISBURSEMENT gate; Gate-B Condition A / red-team P0-1)
 *
 * SCOPE (corrected per the Gate-B GOV-2 review, 2026-07-05): CP-6 gates DISBURSEMENT, not
 * receipt. On the custodial rail the buyer's USDC physically lands in Auxilo's platform
 * wallet at settle, BEFORE this gate runs — so `unassented_pending` vs `pending_balance` is
 * internal bookkeeping over money already received, NOT a cure of the physical receipt. What
 * CP-6 guarantees is that a Builder Share is never made WITHDRAWABLE (never disbursed) to a
 * Builder who has not entered the §5.10 agency. The receipt-side cure is the non-custodial
 * router receive-path becoming the default rail (or REFUSE while it is inert) — tracked as a
 * launch invariant, not here. Builder Share received before a Builder accepts §5.10 is HELD
 * in `unassented_pending` (non-withdrawable — getWithdrawableBalance reads pending_balance
 * only) and moved into `pending_balance` the moment they affirmatively accept. These tests
 * prove the held-bucket data model + the conversion helper (real logic) and that the accrual
 * gate, WAL replay, and accept-terms/link-wallet conversion are wired correctly.
 *
 * Runner: node --test test/cp6-accrual-gate.test.js
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-do-not-use-in-prod';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  initEarningsEntry,
  getWithdrawableBalance,
  convertUnassentedToPending,
  lazyMigrateOnWalletLink,
} = require('../lib/earnings.js');
const { isPayeeAgencyInForce, CURRENT_TOS_VERSION } = require('../lib/accounts.js');

// ─── 1. Data model: the held bucket exists and defaults to 0 ────────────────────
describe('initEarningsEntry', () => {
  it('includes a zero unassented_pending held bucket (CP-6)', () => {
    const e = initEarningsEntry('acc_x', null);
    assert.equal(e.unassented_pending, 0);
    assert.equal(e.pending_balance, 0);
  });
});

// ─── 2. isPayeeAgencyInForce — the gate predicate ───────────────────────────────
describe('isPayeeAgencyInForce', () => {
  it('false for null / no acceptance (an unassented Builder is never in force)', () => {
    assert.equal(isPayeeAgencyInForce(null), false);
    assert.equal(isPayeeAgencyInForce(undefined), false);
    assert.equal(isPayeeAgencyInForce({ email: 'a@example.com' }), false);
    assert.equal(isPayeeAgencyInForce({ tos_version: CURRENT_TOS_VERSION }), false); // no accepted_at
  });
  it('true once the Builder has an accepted §5.10 version', () => {
    assert.equal(isPayeeAgencyInForce({ tos_version: CURRENT_TOS_VERSION, accepted_at: Date.now() }), true);
  });
  it('false for a NON-§5.10-bearing version even with a timestamp (P2-A: fail-closed allow-list)', () => {
    // A future/unknown version that is not in PAYEE_AGENCY_VERSIONS must NOT pass the gate,
    // so a version that removes/reorders §5.10 can't silently open accrual to withdrawable.
    assert.equal(isPayeeAgencyInForce({ tos_version: '2099-01-01-some-future-version', accepted_at: Date.now() }), false);
  });
});

// ─── 3. Held balance is NOT withdrawable ────────────────────────────────────────
describe('getWithdrawableBalance', () => {
  it('counts pending_balance only — unassented_pending is never withdrawable', () => {
    const e = initEarningsEntry('acc_x', null);
    e.pending_balance = 1.25;
    e.unassented_pending = 9.5;
    assert.equal(getWithdrawableBalance(e), 1.25);
  });
});

// ─── 4. convertUnassentedToPending — the cure-on-assent ─────────────────────────
describe('convertUnassentedToPending', () => {
  it('moves held → pending, zeroes the bucket, and makes it withdrawable', () => {
    const earnings = { acc_x: initEarningsEntry('acc_x', null) };
    earnings.acc_x.pending_balance = 0.5;
    earnings.acc_x.unassented_pending = 2.0;
    const moved = convertUnassentedToPending(earnings, { account_id: 'acc_x' });
    assert.equal(moved, 2.0);
    assert.equal(earnings.acc_x.unassented_pending, 0);
    assert.equal(earnings.acc_x.pending_balance, 2.5);
    assert.equal(getWithdrawableBalance(earnings.acc_x), 2.5);
  });
  it('is a no-op when the held bucket is 0 (a repeat accept moves nothing)', () => {
    const earnings = { acc_x: initEarningsEntry('acc_x', null) };
    earnings.acc_x.pending_balance = 2.5;
    earnings.acc_x.unassented_pending = 0;
    const moved = convertUnassentedToPending(earnings, { account_id: 'acc_x' });
    assert.equal(moved, 0);
    assert.equal(earnings.acc_x.pending_balance, 2.5); // unchanged
  });
  it('is a no-op for an unknown / new identity (nothing to convert)', () => {
    assert.equal(convertUnassentedToPending({}, { account_id: 'acc_missing' }), 0);
  });
  it('AUD19-8: repeat conversion after fresh accrual moves ONLY the new amount (sweep idempotency)', () => {
    const earnings = { acc_x: initEarningsEntry('acc_x', null) };
    earnings.acc_x.unassented_pending = 1.0;
    assert.equal(convertUnassentedToPending(earnings, { account_id: 'acc_x' }), 1.0);
    // New held value lands after the first conversion (e.g. a WAL replay of a
    // pre-assent unlock) — the next sweep moves only that.
    earnings.acc_x.unassented_pending = 0.25;
    assert.equal(convertUnassentedToPending(earnings, { account_id: 'acc_x' }), 0.25);
    assert.equal(earnings.acc_x.pending_balance, 1.25);
    assert.equal(earnings.acc_x.unassented_pending, 0);
    // And a third call with nothing held moves nothing.
    assert.equal(convertUnassentedToPending(earnings, { account_id: 'acc_x' }), 0);
    assert.equal(earnings.acc_x.pending_balance, 1.25);
  });
  it('resolves and converts a wallet-keyed entry too', () => {
    const w = '0xabc0000000000000000000000000000000000001';
    const earnings = { [w]: initEarningsEntry(null, w) };
    earnings[w].unassented_pending = 1.5;
    const moved = convertUnassentedToPending(earnings, { wallet: w });
    assert.equal(moved, 1.5);
    assert.equal(earnings[w].pending_balance, 1.5);
    assert.equal(earnings[w].unassented_pending, 0);
  });
});

// ─── 5. Migration carries the held bucket (wallet → account) ────────────────────
describe('lazyMigrateOnWalletLink carries unassented_pending', () => {
  it('merges a wallet-keyed held balance into the account-keyed entry (no loss on link)', () => {
    const w = '0xabc0000000000000000000000000000000000002';
    const earnings = {
      acc_y: initEarningsEntry('acc_y', null),
      [w]: initEarningsEntry(null, w),
    };
    earnings.acc_y.unassented_pending = 0.25;
    earnings[w].unassented_pending = 0.75;
    earnings[w].pending_balance = 0.5;
    lazyMigrateOnWalletLink(earnings, w, 'acc_y');
    assert.equal(earnings.acc_y.unassented_pending, 1.0); // 0.25 + 0.75 carried across
    assert.equal(earnings.acc_y.pending_balance, 0.5);
  });
});

// ─── 5b. P1-B: accept-then-link must not strand held balance ────────────────────
describe('CP-6 P1-B: accept-then-link does not strand held balance', () => {
  it('migrate-then-convert moves a wallet-only held balance to withdrawable', () => {
    // Sequence: bare-wallet accrual (held) → account created + accepted → wallet linked.
    // accept-terms converted nothing (wallet not linked yet); link-wallet migrates the held
    // balance in, then (the P1-B fix) converts it. Terminal state must be WITHDRAWABLE.
    const w = '0xabc0000000000000000000000000000000000003';
    const earnings = {
      acc_z: initEarningsEntry('acc_z', null), // account exists + accepted, no wallet yet
      [w]: initEarningsEntry(null, w),         // bare-wallet accrual, held pre-account
    };
    earnings[w].unassented_pending = 0.5;
    lazyMigrateOnWalletLink(earnings, w, 'acc_z');                       // link-wallet step 1
    convertUnassentedToPending(earnings, { account_id: 'acc_z', wallet: w }); // link-wallet step 2 (P1-B fix)
    assert.equal(earnings.acc_z.unassented_pending, 0);
    assert.equal(earnings.acc_z.pending_balance, 0.5);
    assert.equal(getWithdrawableBalance(earnings.acc_z), 0.5); // no longer stranded
  });
});

// ─── 6. Server wiring (source-level — same approach as the assent suite) ────────
const SERVER_SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf-8');

describe('server.js: accrual gate + WAL replay + conversion wiring', () => {
  it('imports isPayeeAgencyInForce and convertUnassentedToPending', () => {
    assert.ok(SERVER_SRC.includes('isPayeeAgencyInForce'));
    assert.ok(SERVER_SRC.includes('convertUnassentedToPending'));
  });
  it('custodial accrual gates on the agency being in force, holding otherwise', () => {
    assert.ok(/agencyInForce = isPayeeAgencyInForce\(contribAccount\)/.test(SERVER_SRC));
    assert.ok(/activeEntry\.unassented_pending = \(activeEntry\.unassented_pending \|\| 0\) \+ contributorEarned/.test(SERVER_SRC));
    // authoritative read — NOT the null-on-miss cache, which would wrongly quarantine
    assert.ok(/loadAccounts\(\)\[contribAccountId\]/.test(SERVER_SRC));
  });
  it('persists the gate decision to the WAL payload for deterministic replay', () => {
    assert.ok(/agency_in_force: agencyInForce/.test(SERVER_SRC));
  });
  it('replayUnlock re-applies the gate, defaulting pre-CP-6 WAL entries to pending_balance', () => {
    assert.ok(/else if \(agency_in_force !== false\)/.test(SERVER_SRC));
    assert.ok(/earningsEntry\.unassented_pending = \(earningsEntry\.unassented_pending \|\| 0\) \+ contributor_earned/.test(SERVER_SRC));
  });
  it('AUD19-8: accept-terms sweeps held → pending on EVERY acceptance, including idempotent re-accepts (accept-then-crash cure)', () => {
    const i = SERVER_SRC.indexOf("app.post('/account/accept-terms'");
    assert.notEqual(i, -1);
    const h = SERVER_SRC.slice(i, i + 7000);
    // The sweep replaces the old inside-the-guard conversion. It must run on BOTH
    // branches: the durable-log append stays guarded by !result.alreadyAccepted,
    // but the sweep runs after/outside that guard so a re-accept after an
    // accept-then-crash still converts the stranded held balance.
    assert.ok(h.includes('sweepHeldEarnings(accountId)'), 'accept-terms must call the held-balance sweep');
    assert.ok(h.includes('!result.alreadyAccepted'), 'durable append keeps its non-idempotent guard');
    assert.ok(h.includes('OUTSIDE the !alreadyAccepted guard'),
      'the sweep is documented + placed outside the first-accept-only guard (the crash cure)');
    const guardAt = h.indexOf('!result.alreadyAccepted');
    const sweepAt = h.indexOf('sweepHeldEarnings(accountId)');
    assert.ok(sweepAt > guardAt, 'sweep call sits after the guarded durable-append block');
  });
  it('AUD19-8: link-wallet sweeps held balance AFTER the migration (P1-B strand fix, now unconditional)', () => {
    const i = SERVER_SRC.indexOf("app.post('/account/link-wallet'");
    assert.notEqual(i, -1);
    const h = SERVER_SRC.slice(i, i + 10000); // handler grew with the HIGH-1 challenge flow
    const migAt = h.indexOf('lazyMigrateOnWalletLink');
    const sweepAt = h.indexOf('sweepHeldEarnings');
    assert.ok(migAt !== -1 && sweepAt !== -1 && sweepAt > migAt,
      'link-wallet must sweep held balance after lazyMigrateOnWalletLink so accept-then-link does not strand funds');
  });
  it('AUD19-8: GET /account/earnings runs the self-healing sweep before reporting', () => {
    const i = SERVER_SRC.indexOf("app.get('/account/earnings'");
    assert.notEqual(i, -1);
    const h = SERVER_SRC.slice(i, i + 3000);
    assert.ok(h.includes('sweepHeldEarnings(accountId)'),
      'the earnings read must sweep first so releasable value is never reported as held');
  });
  it('AUD19-8: sweepHeldEarnings gates on the agency predicate and takes the shared earnings lock', () => {
    const i = SERVER_SRC.indexOf('async function sweepHeldEarnings');
    assert.notEqual(i, -1, 'sweep helper must exist');
    const h = SERVER_SRC.slice(i, i + 2500);
    assert.ok(h.includes('isPayeeAgencyInForce'), 'never moves money unless §5.10 is in force');
    assert.ok(h.includes('acquireEarningsLock'),
      'sweep runs post-assent (withdrawals possible) so it MUST hold the same earnings lock both rails use');
    assert.ok(h.includes('convertUnassentedToPending'), 'conversion goes through the one CP-6 helper');
    assert.ok(h.includes('safeWrite(EARNINGS_FILE'), 'persists the conversion');
  });
  it('AUD19-8(b): GET /account/earnings exposes held_pending_assent in both branches', () => {
    const i = SERVER_SRC.indexOf("app.get('/account/earnings'");
    const h = SERVER_SRC.slice(i, i + 6000);
    const matches = h.match(/held_pending_assent:/g) || [];
    assert.ok(matches.length >= 2, `held_pending_assent must appear in the zero-state AND normal branches (found ${matches.length})`);
  });
});
