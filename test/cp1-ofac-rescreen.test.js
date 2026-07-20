'use strict';

/**
 * test/cp1-ofac-rescreen.test.js — CP-1 (PUNCH-LIST §22, AML-PROGRAM §G-1):
 * re-screen VERIFIED-BUT-UNLINKED wallets on every successful 24h OFAC SDN
 * refresh, closing the residual gap left by server.js's rescreenLinkedWallets()
 * (which only walks account.wallet — see test/r01-launch-blockers.test.js §9
 * for that half of CP-1, already shipped and untouched here).
 *
 * Two layers, matching the repo's conventions (see test/geo-embargo.test.js):
 *   A) Behavioral unit tests of the PURE decision engine (lib/ofac-rescreen.js)
 *      against fixture deps — clean wallet untouched, hit wallet frozen +
 *      logged + alerted, already-flagged wallet does not re-alert, platform
 *      wallet skipped entirely, account-linked wallet deduped out (left to the
 *      other sweep).
 *   B) Structural tests that the sweep is actually wired into server.js's
 *      refreshOFACList() success path, runs in a never-throws wrapper, and
 *      never fires on a failed refresh — analyzing server.js source rather
 *      than booting the whole app (requiring server.js starts a listener +
 *      live OFAC download).
 *
 * Runner: node --test test/cp1-ofac-rescreen.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { rescreenVerifiedWallets } = require('../lib/ofac-rescreen.js');

const CLEAN_WALLET = '0xcccccccccccccccccccccccccccccccccccccc';
const HIT_WALLET = '0xdddddddddddddddddddddddddddddddddddddd';
const ALREADY_FLAGGED_WALLET = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const LINKED_WALLET = '0xffffffffffffffffffffffffffffffffffffff';
const PLATFORM_WALLET = '0xA19Cf92cc1daCf742f0E50b4128cAD3A86A81EC4';

// Sanctioned set used by the fixture checkOFAC — deliberately includes the
// platform wallet and the linked wallet too, so a pathological hit against
// either would be visible if the exemption/dedupe logic were missing.
function fixtureCheckOFAC(sanctionedLower) {
  return (wallet) => sanctionedLower.has(String(wallet).toLowerCase());
}

function mkDeps(overrides = {}) {
  const logCalls = [];
  const alertCalls = [];
  const verifiedWallets = {
    [CLEAN_WALLET]: true,
    [HIT_WALLET]: true,
    [ALREADY_FLAGGED_WALLET]: { verified: true, ofac_hit_at: '2026-01-01T00:00:00.000Z' },
    [LINKED_WALLET]: true,
    [PLATFORM_WALLET.toLowerCase()]: true,
  };
  const sanctioned = new Set([HIT_WALLET, ALREADY_FLAGGED_WALLET, LINKED_WALLET, PLATFORM_WALLET.toLowerCase()]);
  const deps = {
    verifiedWallets,
    linkedWalletsLower: new Set([LINKED_WALLET]),
    platformWallets: [PLATFORM_WALLET],
    checkOFAC: fixtureCheckOFAC(sanctioned),
    logOFACBlock: (wallet, endpoint) => logCalls.push({ wallet, endpoint }),
    sendOpsAlert: (subject, body, opts) => {
      alertCalls.push({ subject, body, opts });
      return Promise.resolve();
    },
    ...overrides,
  };
  return { deps, verifiedWallets, logCalls, alertCalls };
}

// ─────────────────────────────────────────────────────────────────────────────
// A. Behavioral: the pure decision engine (lib/ofac-rescreen.js)
// ─────────────────────────────────────────────────────────────────────────────
describe('rescreenVerifiedWallets — decision engine', () => {
  it('a clean wallet is screened but left completely untouched', () => {
    const { deps, verifiedWallets, logCalls, alertCalls } = mkDeps();
    const result = rescreenVerifiedWallets(deps);
    assert.equal(verifiedWallets[CLEAN_WALLET], true, 'clean wallet record must not be rewritten');
    assert.ok(!logCalls.some((c) => c.wallet === CLEAN_WALLET), 'clean wallet must never be logged');
    assert.ok(result.screened >= 1, 'the clean wallet must be counted as screened');
    void alertCalls;
  });

  it('a NEW hit is frozen (stamped), logged with reason "rescreen", and alerts ops', () => {
    const { deps, verifiedWallets, logCalls, alertCalls } = mkDeps();
    const result = rescreenVerifiedWallets(deps);

    assert.equal(result.hits, 1, 'exactly one new hit expected (HIT_WALLET)');
    assert.deepEqual(result.newlyFrozen, [HIT_WALLET]);

    // Freeze: the wallet's own record is stamped, not a parallel store.
    const record = verifiedWallets[HIT_WALLET];
    assert.equal(typeof record, 'object', 'hit wallet record must become an object stamp');
    assert.equal(record.verified, true, 'freeze must not revoke prior verification status');
    assert.ok(record.ofac_hit_at, 'freeze must stamp an ofac_hit_at timestamp');
    assert.ok(!Number.isNaN(Date.parse(record.ofac_hit_at)), 'ofac_hit_at must be a valid ISO timestamp');

    // Logged with the exact reason the task/PUNCH-LIST specifies.
    const hitLog = logCalls.find((c) => c.wallet === HIT_WALLET);
    assert.ok(hitLog, 'logOFACBlock must be called for the hit wallet');
    assert.equal(hitLog.endpoint, 'rescreen', "logOFACBlock reason must be exactly 'rescreen'");

    // Ops alerted, category 'ofac', naming the wallet.
    assert.equal(alertCalls.length, 1, 'exactly one ops alert for one newly-hit wallet');
    assert.equal(alertCalls[0].opts.category, 'ofac');
    assert.ok(alertCalls[0].body.includes(HIT_WALLET) || alertCalls[0].subject.includes(HIT_WALLET) ||
      alertCalls[0].body.toLowerCase().includes(HIT_WALLET.toLowerCase()),
      'alert must name the affected wallet');
  });

  it('an already-flagged wallet is counted but does not re-log or re-alert (idempotent)', () => {
    const { deps, verifiedWallets, logCalls, alertCalls } = mkDeps();
    // Isolate: only the already-flagged wallet is sanctioned this run.
    deps.checkOFAC = fixtureCheckOFAC(new Set([ALREADY_FLAGGED_WALLET]));
    const before = JSON.stringify(verifiedWallets[ALREADY_FLAGGED_WALLET]);

    const result = rescreenVerifiedWallets(deps);

    assert.equal(result.hits, 0, 'an already-flagged hit must not count as a NEW hit');
    assert.equal(result.alreadyFrozen, 1);
    assert.equal(JSON.stringify(verifiedWallets[ALREADY_FLAGGED_WALLET]), before,
      'an already-flagged record must not be rewritten (preserves first-hit timestamp)');
    assert.ok(!logCalls.some((c) => c.wallet === ALREADY_FLAGGED_WALLET),
      'an already-flagged wallet must not be re-logged every cycle (alert-fatigue guard)');
    assert.equal(alertCalls.length, 0, 'no alert when there are zero NEW hits');
  });

  it('platform wallets are exempt even when sanctioned (self-brick guard)', () => {
    const { deps, logCalls } = mkDeps();
    // Sanity: the fixture's sanctioned set does include the platform wallet.
    assert.ok(deps.checkOFAC(PLATFORM_WALLET), 'fixture setup: platform wallet must be in the sanctioned set for this to be a real test');

    const result = rescreenVerifiedWallets(deps);

    assert.ok(!logCalls.some((c) => c.wallet.toLowerCase() === PLATFORM_WALLET.toLowerCase()),
      'the platform wallet must never be logged as a hit');
    // screened count reflects CLEAN_WALLET + HIT_WALLET + ALREADY_FLAGGED_WALLET
    // only — platform and linked wallets are excluded before the counter increments.
    assert.equal(result.screened, 3);
  });

  it('account-linked wallets are deduped out — left entirely to the other sweep', () => {
    const { deps, logCalls } = mkDeps();
    const result = rescreenVerifiedWallets(deps);
    assert.ok(!logCalls.some((c) => c.wallet === LINKED_WALLET),
      'a wallet already covered by rescreenLinkedWallets must not be double-processed here');
    void result;
  });

  it('a malformed per-wallet record cannot abort the sweep for the rest of the store', () => {
    const { deps, logCalls } = mkDeps();
    // Inject a pathological entry between two real wallets.
    deps.verifiedWallets['0x9999999999999999999999999999999999999a'] = true;
    const originalCheck = deps.checkOFAC;
    deps.checkOFAC = (wallet) => {
      if (wallet === '0x9999999999999999999999999999999999999a') throw new Error('boom');
      return originalCheck(wallet);
    };
    assert.doesNotThrow(() => rescreenVerifiedWallets(deps));
    assert.ok(logCalls.some((c) => c.wallet === HIT_WALLET), 'the real hit must still be processed despite the poisoned entry');
  });

  it('missing/invalid deps return a zeroed result instead of throwing', () => {
    assert.doesNotThrow(() => rescreenVerifiedWallets({}));
    assert.deepEqual(rescreenVerifiedWallets({}), { screened: 0, hits: 0, newlyFrozen: [], alreadyFrozen: 0 });
    assert.doesNotThrow(() => rescreenVerifiedWallets());
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B. Structural: wired into server.js's refresh success path, never-throws
// ─────────────────────────────────────────────────────────────────────────────
const SERVER_SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf-8');

function sliceHandler(marker, span = 4500) {
  const i = SERVER_SRC.indexOf(marker);
  assert.notEqual(i, -1, `handler not found: ${marker}`);
  return SERVER_SRC.slice(i, i + span);
}

describe('structural: verified-wallet re-screen is wired into refreshOFACList()', () => {
  it('server.js requires the pure decision engine from lib/ofac-rescreen.js', () => {
    assert.ok(SERVER_SRC.includes("require('./lib/ofac-rescreen.js')"),
      'server.js must import rescreenVerifiedWallets from lib/ofac-rescreen.js, not reimplement it inline');
  });

  it('the verified-wallet sweep runs inside refreshOFACList, AFTER a successful refresh, in its own never-throws wrapper', () => {
    const h = sliceHandler('async function refreshOFACList', 5200);
    const successLogAt = h.indexOf('SDN list refreshed');
    const linkedSweepAt = h.indexOf('rescreenLinkedWallets()');
    const verifiedSweepAt = h.indexOf('rescreenVerifiedWallets(');
    const catchAt = h.indexOf('} catch (err) {'); // the outer failure branch

    assert.notEqual(verifiedSweepAt, -1, 'refreshOFACList must call rescreenVerifiedWallets');
    assert.ok(successLogAt !== -1 && verifiedSweepAt > successLogAt,
      'the verified-wallet sweep must run only after a successful list refresh (never against a stale/failed load)');
    assert.ok(linkedSweepAt !== -1 && verifiedSweepAt > linkedSweepAt,
      'the verified-wallet sweep runs alongside/after the linked-wallet sweep, not instead of it');
    assert.ok(catchAt === -1 || verifiedSweepAt < catchAt,
      'the verified-wallet sweep call must live in the success branch (before the outer failure catch), not the failure branch');
    assert.ok(h.includes('Verified-wallet re-screen failed (refresh unaffected)'),
      'a sweep failure must be caught locally and logged, never allowed to propagate and break the refresh cycle');
  });

  it('the sweep call is inside its own try block distinct from the linked-wallet sweep\'s try block', () => {
    const h = sliceHandler('async function refreshOFACList', 5200);
    // There must be two independent try/catch pairs for the two CP-1 sweeps —
    // find the try immediately preceding each sweep call and confirm they differ.
    const linkedSweepAt = h.indexOf('rescreenLinkedWallets()');
    const verifiedSweepAt = h.indexOf('rescreenVerifiedWallets(');
    const tryBeforeLinked = h.lastIndexOf('try {', linkedSweepAt);
    const tryBeforeVerified = h.lastIndexOf('try {', verifiedSweepAt);
    assert.notEqual(tryBeforeLinked, -1);
    assert.notEqual(tryBeforeVerified, -1);
    assert.notEqual(tryBeforeLinked, tryBeforeVerified,
      'the two sweeps must be independently contained — one failing must not skip or break the other');
  });

  it('PLATFORM_WALLETS is passed through to the sweep (exemption wired end-to-end)', () => {
    const h = sliceHandler('rescreenVerifiedWallets(', 400);
    assert.ok(h.includes('platformWallets: PLATFORM_WALLETS'),
      'server.js must pass PLATFORM_WALLETS into the sweep so the platform wallet is never screened');
  });

  it('a NEW hit is persisted back to VERIFIED_WALLETS_FILE via safeWrite', () => {
    const h = sliceHandler('rescreenVerifiedWallets(', 900);
    assert.ok(h.includes('safeWrite(VERIFIED_WALLETS_FILE, verifiedWallets)'),
      'a freeze stamp written in memory must be persisted to disk, matching the existing verifiedWallets write convention');
  });
});
