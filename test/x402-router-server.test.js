/**
 * test/x402-router-server.test.js — R-01 router-mode server.js structural tests
 *
 * Covers the Gate A conditions on the server integration (PUNCH-LIST §23):
 *   RT-3: a router-settled self-unlock books an onchain_settlements record
 *   custody invariant: router settles NEVER credit crypto pending_balance
 *         (live handler, WAL replay, and self-unlock paths)
 *   RT-2: exact on-chain micro-USDC fields recorded alongside float USD
 *
 * Strategy: structural source-code analysis, same convention as
 * test/p2-1a-extract-handler.test.js — verify the implementation shape in
 * server.js source. On-chain behavior lives in test/x402-router.test.js and
 * scripts/x402-router-sepolia-e2e.js.
 */

'use strict';

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SERVER_SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf-8');

// Slice helpers so assertions bind to the right function, not a lookalike.
function slice(startMarker, endMarker) {
  const start = SERVER_SRC.indexOf(startMarker);
  assert.notEqual(start, -1, `marker not found: ${startMarker}`);
  const end = SERVER_SRC.indexOf(endMarker, start);
  assert.notEqual(end, -1, `end marker not found after ${startMarker}: ${endMarker}`);
  return SERVER_SRC.slice(start, end);
}

describe('RT-3: router-settled self-unlock is booked', () => {
  let selfUnlockBlock;
  // CH-7: computed in before() — a failed slice exits 1, never fail-0/exit-0.
  before(() => { selfUnlockBlock = slice('if (isSelfUnlock) {', 'learning.earnings.gross_usd'); });

  it('self-unlock branch books onchain_settlements when routerSettlement is present', () => {
    assert.ok(selfUnlockBlock.includes('if (routerSettlement) {'),
      'self-unlock branch must check routerSettlement');
    assert.ok(selfUnlockBlock.includes('onchain_settlements.push'),
      'self-unlock branch must push an onchain_settlements record');
    assert.ok(selfUnlockBlock.includes('self_unlock: true'),
      'the booked record must be marked self_unlock');
    assert.ok(selfUnlockBlock.includes('safeWrite(EARNINGS_FILE, earnings)'),
      'the booked record must be persisted before the early return');
  });

  it('booking happens BEFORE the early return', () => {
    const push = selfUnlockBlock.indexOf('onchain_settlements.push');
    const ret = selfUnlockBlock.indexOf('return c.json');
    assert.ok(push !== -1 && ret !== -1 && push < ret,
      'settlement booking must precede the self-unlock response');
  });

  it('self-unlock still credits NOTHING to pending_balance', () => {
    assert.ok(!selfUnlockBlock.includes('pending_balance +='),
      'self-unlock must never credit pending_balance');
  });
});

describe('custody invariant: router settles never credit pending_balance', () => {
  it('unlock handler credits pending_balance only in the non-router branch', () => {
    const unlockBlock = slice("app.get('/knowledge/:id'", "app.post('/knowledge/:id/rate'");
    const credits = unlockBlock.split('pending_balance +=').length - 1;
    assert.equal(credits, 1, 'exactly one pending_balance credit site in the unlock handler');
    // that one credit site must be the else-branch of the routerSettlement check
    const guard = unlockBlock.indexOf('if (routerSettlement) {', unlockBlock.indexOf('by_learning[id].unlocks += 1'));
    const credit = unlockBlock.indexOf('pending_balance +=');
    assert.ok(guard !== -1 && guard < credit,
      'the pending_balance credit must sit behind the routerSettlement guard');
  });

  it('WAL replay carries the settled_onchain guard', () => {
    const replayBlock = slice('function replayUnlock(entry)', 'function recoverWalEntries');
    assert.ok(replayBlock.includes('settled_onchain'), 'replayUnlock must read settled_onchain');
    const guard = replayBlock.indexOf('if (settled_onchain)');
    const credit = replayBlock.indexOf('pending_balance += contributor_earned');
    assert.ok(guard !== -1 && credit !== -1 && guard < credit,
      'replay pending_balance credit must sit behind the settled_onchain guard');
    assert.ok(replayBlock.includes('onchain_settlements.push'),
      'replay of a settled unlock must book the settlement record instead');
  });

  it('WAL payload records the settlement facts for crash replay', () => {
    for (const field of ['settled_onchain:', 'settlement_tx:', 'settlement_bps:']) {
      assert.ok(SERVER_SRC.includes(field), `WAL payload must carry ${field}`);
    }
  });
});

describe('router mode control flow', () => {
  it('router branch never falls through to the local fallback', () => {
    const vp = slice('async function _verifyPayment(', '// ─── Dynamic Payment Verification');
    const guard = vp.indexOf('if (routerMode) {\n    return { verified: false, rateLimited: false };');
    const local = vp.indexOf('verifyPaymentLocally(');
    assert.ok(guard !== -1, 'router-mode fail-closed guard must exist before the local fallback');
    assert.ok(guard < local, 'the guard must precede verifyPaymentLocally');
  });

  it('routerCtx is built only for flag-on + verified contributor wallets', () => {
    const unlockBlock = slice("app.get('/knowledge/:id'", "app.post('/knowledge/:id/rate'");
    const gate = unlockBlock.indexOf('if (x402Router.routerEnabled())');
    const verified = unlockBlock.indexOf('verifiedWallets[rwLower]');
    const ctx = unlockBlock.indexOf('routerCtx = {');
    assert.ok(gate !== -1 && verified !== -1 && ctx !== -1 && gate < verified && verified < ctx,
      'routerCtx must require routerEnabled() AND a verifiedWallets hit');
  });
});

describe('RT-2: exact micro-USDC reconciliation fields', () => {
  it('every onchain_settlements record site computes floor(gross*bps/1e4)', () => {
    const sites = SERVER_SRC.split('onchain_settlements.push').length - 1;
    assert.equal(sites, 3, 'expected exactly 3 booking sites (unlock, self-unlock, WAL replay)');
    const floors = SERVER_SRC.split('/ 10000)').length - 1;
    assert.ok(floors >= 3, 'each booking site must floor the contributor micro-share like the contract');
    for (const field of ['gross_micro:', 'contributor_micro:', 'platform_micro:']) {
      const count = SERVER_SRC.split(field).length - 1;
      assert.ok(count >= 3, `${field} must appear at all 3 booking sites (found ${count})`);
    }
  });
});
