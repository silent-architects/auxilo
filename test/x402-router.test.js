// test/x402-router.test.js
//
// R-01 non-custodial settlement: lib/x402-router.js unit suite.
// Mirrors test/x402-facilitator.test.js conventions: node:test + strict
// assert, dependency injection instead of network (deps.sendRouterTx replaces
// the viem broadcast; deps.checkOFAC/ofacScreeningReady replace server state).
// The nonce-derivation known-answer vector was generated independently with
// Foundry (`cast abi-encode "f(address,uint256,bytes32)" ... | cast keccak`)
// so the JS derivation is pinned to the contract's own encoding, not to
// itself. On-chain behavior is covered by scripts/x402-router-sepolia-e2e.js
// against the live Base Sepolia router.

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const router = require('../lib/x402-router.js');

const ROUTER_ADDR = '0x8979B20E4789f4F903655B0ce8e0e901099E6142';
const CONTRIBUTOR = '0x6B3c89E1D705B96F2EdfDE818b7fDd3ecDA5Ee76';
const BUYER = '0x1111111111111111111111111111111111111111';
const SALT_VECTOR = '0x1111111111111111111111111111111111111111111111111111111111111111';
// cast keccak(cast abi-encode("f(address,uint256,bytes32)", CONTRIBUTOR, 7000, SALT_VECTOR))
const NONCE_VECTOR = '0xa54f71676679ab3ee577af207f17b1457ea627b44727eda0f6006eda9d426f43';

const RESOURCE = '/knowledge/test-learning';
const AMOUNT = '100000'; // 0.10 USDC in micro-units

beforeEach(() => {
  delete process.env.X402_ROUTER_ADDRESS;
  delete process.env.X402_ROUTER_CHAIN_ID;
  delete process.env.X402_ROUTER_USDC;
  delete process.env.X402_ROUTER_RECEIVE_ONLY;
  delete process.env.X402_ROUTER_CONFIRM_TAG;
  delete process.env.X402_ROUTER_MIN_CONFIRMATIONS;
  delete process.env.X402_ROUTER_CONFIRM_TIMEOUT_MS;
  router._resetForTests();
});

function enableRouter() {
  process.env.X402_ROUTER_ADDRESS = ROUTER_ADDR;
}

function makeAuth(overrides = {}) {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    from: BUYER,
    to: ROUTER_ADDR,
    value: AMOUNT,
    validAfter: String(nowSec - 60),
    validBefore: String(nowSec + 600),
    nonce: '0x' + 'ab'.repeat(32),
    ...overrides,
  };
}

function makePayload({ auth = makeAuth(), signature = '0x' + 'cd'.repeat(65), extra = undefined } = {}) {
  const p = { x402Version: 2, scheme: 'exact', network: 'eip155:8453', payload: { signature, authorization: auth } };
  if (extra) p.extra = extra;
  return p;
}

// Benign OFAC deps + a recording broadcast mock. `implOk` injects the A1
// USDC-impl guard result (default OK) so unit tests stay hermetic — the real
// _defaultAssertUsdcImplOk (a network read) runs only when NOT injected, i.e.
// in the live Sepolia E2E.
function makeDeps({ sanctioned = [], ready = true, broadcast, implOk = true } = {}) {
  const set = new Set(sanctioned.map((a) => a.toLowerCase()));
  const calls = [];
  const blocks = [];
  const deps = {
    ofacScreeningReady: () => ready,
    checkOFAC: (addr) => set.has(String(addr).toLowerCase()),
    logOFACBlock: (addr, endpoint) => blocks.push({ addr, endpoint }),
    assertUsdcImplOk: async () => (implOk ? { ok: true, reason: 'test' } : { ok: false, reason: 'circuit_open:impl_changed' }),
    sendRouterTx: async (call) => {
      calls.push(call);
      if (broadcast) return broadcast(call);
      return { txHash: '0x' + 'ee'.repeat(32), confirmed: true, reverted: false };
    },
  };
  return { deps, calls, blocks };
}

async function settle({ payload, contributor = CONTRIBUTOR, bps = 7000, deps }) {
  return router.settleWithRouter({
    paymentPayload: payload,
    expectedAmountMicro: AMOUNT,
    resource: RESOURCE,
    contributor,
    contributorBps: bps,
    deps,
  });
}

// ── Flag gating ─────────────────────────────────────────────────────────────

test('flag unset: routerEnabled false and settle refuses without broadcasting', async () => {
  assert.equal(router.routerEnabled(), false);
  const { deps, calls } = makeDeps();
  const r = await settle({ payload: makePayload(), deps });
  assert.equal(r.settled, false);
  assert.equal(r.settleFailed, false);
  assert.equal(r.reason, 'router_disabled');
  assert.equal(calls.length, 0);
});

test('flag set to a non-address value stays disabled', () => {
  process.env.X402_ROUTER_ADDRESS = 'not-an-address';
  assert.equal(router.routerEnabled(), false);
  assert.equal(router.getRouterAddress(), null);
});

// ── Nonce derivation (known-answer vector from Foundry cast) ────────────────

test('deriveReceiveNonce matches the contract encoding (cast vector)', () => {
  const derived = router.deriveReceiveNonce(CONTRIBUTOR, 7000, SALT_VECTOR);
  assert.equal(derived.toLowerCase(), NONCE_VECTOR);
});

// ── Challenge hint ──────────────────────────────────────────────────────────

test('createRouterHint + buildRouterExtra advertise the derived-nonce contract', () => {
  enableRouter();
  const hint = router.createRouterHint({ contributor: CONTRIBUTOR, contributorBps: 7000, resource: RESOURCE, amountMicro: AMOUNT });
  assert.match(hint.salt, /^0x[0-9a-f]{64}$/);
  const extra = router.buildRouterExtra(hint);
  assert.equal(extra.assetTransferMethod, 'eip3009');
  assert.equal(extra.name, 'USD Coin'); // USDC EIP-712 domain, unchanged for generic clients
  assert.equal(extra.router.address, ROUTER_ADDR);
  assert.equal(extra.router.contributor, CONTRIBUTOR);
  assert.equal(extra.router.contributorBps, '7000');
  assert.equal(extra.router.salt, hint.salt);
  assert.equal(extra.router.nonce, router.deriveReceiveNonce(CONTRIBUTOR, 7000, hint.salt));
});

test('createRouterHint rejects bad contributor and out-of-range bps', () => {
  assert.throws(() => router.createRouterHint({ contributor: 'nope', contributorBps: 7000, resource: RESOURCE, amountMicro: AMOUNT }), TypeError);
  assert.throws(() => router.createRouterHint({ contributor: CONTRIBUTOR, contributorBps: 0, resource: RESOURCE, amountMicro: AMOUNT }), RangeError);
  assert.throws(() => router.createRouterHint({ contributor: CONTRIBUTOR, contributorBps: 10001, resource: RESOURCE, amountMicro: AMOUNT }), RangeError);
});

// ── OFAC fail-closed (both parties, before any broadcast) ───────────────────

test('OFAC list not ready fails closed with ofacUnavailable (no broadcast)', async () => {
  enableRouter();
  const { deps, calls } = makeDeps({ ready: false });
  const r = await settle({ payload: makePayload(), deps });
  assert.equal(r.settled, false);
  assert.equal(r.ofacUnavailable, true);
  assert.equal(r.reason, 'ofac_unavailable');
  assert.equal(calls.length, 0);
});

test('missing OFAC deps fail closed (never default-open)', async () => {
  enableRouter();
  const r = await settle({ payload: makePayload(), deps: { sendRouterTx: async () => ({ txHash: '0x0', confirmed: true }) } });
  assert.equal(r.settled, false);
  assert.equal(r.ofacUnavailable, true);
  assert.equal(r.reason, 'ofac_deps_missing');
});

test('sanctioned buyer is blocked and logged before broadcast', async () => {
  enableRouter();
  const { deps, calls, blocks } = makeDeps({ sanctioned: [BUYER] });
  const r = await settle({ payload: makePayload(), deps });
  assert.equal(r.settled, false);
  assert.equal(r.reason, 'buyer_sanctioned');
  assert.equal(r.sanctioned, true);
  assert.equal(calls.length, 0);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].addr, BUYER);
});

test('sanctioned contributor is blocked and logged before broadcast', async () => {
  enableRouter();
  const { deps, calls, blocks } = makeDeps({ sanctioned: [CONTRIBUTOR] });
  const r = await settle({ payload: makePayload(), deps });
  assert.equal(r.settled, false);
  assert.equal(r.reason, 'contributor_sanctioned');
  assert.equal(calls.length, 0);
  assert.equal(blocks[0].addr, CONTRIBUTOR);
});

test('OFAC screens the TRANSFER path too (buyer blocked, no salt echoed)', async () => {
  enableRouter();
  const { deps, calls } = makeDeps({ sanctioned: [BUYER] });
  const r = await settle({ payload: makePayload(), deps }); // no extra.salt → transfer path
  assert.equal(r.reason, 'buyer_sanctioned');
  assert.equal(calls.length, 0);
});

// ── Receive path (nonce-bound) ──────────────────────────────────────────────

test('receive path: echoed salt + derived nonce settles via settleAndSplitReceive', async () => {
  enableRouter();
  const hint = router.createRouterHint({ contributor: CONTRIBUTOR, contributorBps: 7000, resource: RESOURCE, amountMicro: AMOUNT });
  const nonce = router.deriveReceiveNonce(CONTRIBUTOR, 7000, hint.salt);
  const payload = makePayload({ auth: makeAuth({ nonce }), extra: { salt: hint.salt } });
  const { deps, calls } = makeDeps();
  const r = await settle({ payload, deps });
  assert.equal(r.settled, true);
  assert.equal(r.path, 'receive');
  assert.match(r.txHash, /^0x/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].functionName, 'settleAndSplitReceive');
  assert.equal(calls[0].args[4], hint.salt);          // salt, not nonce, goes on-chain
  assert.equal(calls[0].args[6], CONTRIBUTOR);
  assert.equal(calls[0].args[7], 7000n);
  // RT-1: the hint SURVIVES success — EIP-3009 nonces are per-authorizer, so
  // a second buyer of the same learning shares the salt safely.
  assert.notEqual(router.peekRouterHint(hint.salt), null);
});

test('receive path: salt echoed inside payload.extra also works', async () => {
  enableRouter();
  const hint = router.createRouterHint({ contributor: CONTRIBUTOR, contributorBps: 6000, resource: RESOURCE, amountMicro: AMOUNT });
  const nonce = router.deriveReceiveNonce(CONTRIBUTOR, 6000, hint.salt);
  const payload = makePayload({ auth: makeAuth({ nonce }) });
  payload.payload.extra = { salt: hint.salt };
  const { deps, calls } = makeDeps();
  const r = await settle({ payload, bps: 6000, deps });
  assert.equal(r.settled, true);
  assert.equal(calls[0].args[7], 6000n);
});

test('receive path: unknown salt is rejected without broadcast', async () => {
  enableRouter();
  const salt = '0x' + '22'.repeat(32);
  const payload = makePayload({ auth: makeAuth({ nonce: router.deriveReceiveNonce(CONTRIBUTOR, 7000, salt) }), extra: { salt } });
  const { deps, calls } = makeDeps();
  const r = await settle({ payload, deps });
  assert.equal(r.settled, false);
  assert.equal(r.reason, 'unknown_or_expired_salt');
  assert.equal(calls.length, 0);
});

test('receive path: nonce not derived from the hint is rejected (P1-1 binding)', async () => {
  enableRouter();
  const hint = router.createRouterHint({ contributor: CONTRIBUTOR, contributorBps: 7000, resource: RESOURCE, amountMicro: AMOUNT });
  const payload = makePayload({ auth: makeAuth({ nonce: '0x' + 'ff'.repeat(32) }), extra: { salt: hint.salt } });
  const { deps, calls } = makeDeps();
  const r = await settle({ payload, deps });
  assert.equal(r.reason, 'nonce_not_derived');
  assert.equal(calls.length, 0);
});

test('receive path: split drift between challenge and settle is refused', async () => {
  enableRouter();
  const hint = router.createRouterHint({ contributor: CONTRIBUTOR, contributorBps: 6000, resource: RESOURCE, amountMicro: AMOUNT });
  const nonce = router.deriveReceiveNonce(CONTRIBUTOR, 6000, hint.salt);
  const payload = makePayload({ auth: makeAuth({ nonce }), extra: { salt: hint.salt } });
  const { deps, calls } = makeDeps();
  // caller now claims 7000 bps but the buyer signed over the 6000-bps hint
  const r = await settle({ payload, bps: 7000, deps });
  assert.equal(r.reason, 'hint_split_mismatch');
  assert.equal(calls.length, 0);
});

test('receive path: hint survives a failed settle so the buyer can retry', async () => {
  enableRouter();
  const hint = router.createRouterHint({ contributor: CONTRIBUTOR, contributorBps: 7000, resource: RESOURCE, amountMicro: AMOUNT });
  const nonce = router.deriveReceiveNonce(CONTRIBUTOR, 7000, hint.salt);
  const payload = makePayload({ auth: makeAuth({ nonce }), extra: { salt: hint.salt } });

  let attempt = 0;
  const { deps, calls } = makeDeps({
    broadcast: async () => {
      attempt++;
      if (attempt === 1) return { txHash: '0x' + '11'.repeat(32), confirmed: false, reverted: true };
      return { txHash: '0x' + '22'.repeat(32), confirmed: true, reverted: false };
    },
  });

  const first = await settle({ payload, deps });
  assert.equal(first.settleFailed, true);
  assert.equal(first.reason, 'onchain_revert');
  assert.notEqual(router.peekRouterHint(hint.salt), null); // still there

  const second = await settle({ payload, deps });
  assert.equal(second.settled, true);
  assert.equal(calls.length, 2);
});

// ── RT-1 flood hardening: per-split hint reuse ──────────────────────────────

test('challenges for the same split reuse one salt (hint-flood cannot churn the store)', () => {
  enableRouter();
  const params = { contributor: CONTRIBUTOR, contributorBps: 7000, resource: RESOURCE, amountMicro: AMOUNT };
  const first = router.createRouterHint(params);
  for (let i = 0; i < 50; i++) {
    assert.equal(router.createRouterHint(params).salt, first.salt);
  }
});

test('different resource, split, or amount mints a distinct salt', () => {
  enableRouter();
  const base = { contributor: CONTRIBUTOR, contributorBps: 7000, resource: RESOURCE, amountMicro: AMOUNT };
  const a = router.createRouterHint(base);
  const b = router.createRouterHint({ ...base, resource: '/knowledge/other' });
  const c = router.createRouterHint({ ...base, contributorBps: 6000 });
  const d = router.createRouterHint({ ...base, amountMicro: '200000' });
  const salts = new Set([a.salt, b.salt, c.salt, d.salt]);
  assert.equal(salts.size, 4);
});

test('two buyers can settle against the same shared hint', async () => {
  enableRouter();
  const hint = router.createRouterHint({ contributor: CONTRIBUTOR, contributorBps: 7000, resource: RESOURCE, amountMicro: AMOUNT });
  const nonce = router.deriveReceiveNonce(CONTRIBUTOR, 7000, hint.salt);
  const buyer2 = '0x2222222222222222222222222222222222222222';
  const { deps, calls } = makeDeps();

  const r1 = await settle({ payload: makePayload({ auth: makeAuth({ nonce }), extra: { salt: hint.salt } }), deps });
  const r2 = await settle({ payload: makePayload({ auth: makeAuth({ from: buyer2, nonce }), extra: { salt: hint.salt } }), deps });
  assert.equal(r1.settled, true);
  assert.equal(r2.settled, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].args[0], buyer2);
});

test('consumeRouterHint still removes a hint explicitly', () => {
  enableRouter();
  const hint = router.createRouterHint({ contributor: CONTRIBUTOR, contributorBps: 7000, resource: RESOURCE, amountMicro: AMOUNT });
  router.consumeRouterHint(hint.salt);
  assert.equal(router.peekRouterHint(hint.salt), null);
  // and the split index was cleared too — the next mint is a fresh salt
  const next = router.createRouterHint({ contributor: CONTRIBUTOR, contributorBps: 7000, resource: RESOURCE, amountMicro: AMOUNT });
  assert.notEqual(next.salt, hint.salt);
});

// ── Transfer path (generic x402 interop — ONLY in both-paths mode) ──────────

test('transfer path: with RECEIVE_ONLY off, no salt settles via settleAndSplitTransfer', async () => {
  enableRouter();
  process.env.X402_ROUTER_RECEIVE_ONLY = '0'; // both-paths AuxiloSplitRouter deployment
  const auth = makeAuth();
  const payload = makePayload({ auth });
  const { deps, calls } = makeDeps();
  const r = await settle({ payload, deps });
  assert.equal(r.settled, true);
  assert.equal(r.path, 'transfer');
  assert.equal(calls[0].functionName, 'settleAndSplitTransfer');
  assert.equal(calls[0].args[4], auth.nonce);
  assert.equal(calls[0].args[6], CONTRIBUTOR);
});

// ── Payload validation ──────────────────────────────────────────────────────

test('payment addressed to the platform wallet (not the router) is rejected', async () => {
  enableRouter();
  const payload = makePayload({ auth: makeAuth({ to: '0x1BE960313c93b3aA0AA62BF33B300CAB48c36Ca6' }) });
  const { deps, calls } = makeDeps();
  const r = await settle({ payload, deps });
  assert.equal(r.reason, 'wrong_payto');
  assert.equal(calls.length, 0);
});

test('amount mismatch, expired auth, and malformed payloads are rejected pre-broadcast', async () => {
  enableRouter();
  const { deps, calls } = makeDeps();
  const nowSec = Math.floor(Date.now() / 1000);

  let r = await settle({ payload: makePayload({ auth: makeAuth({ value: '999999' }) }), deps });
  assert.equal(r.reason, 'amount_mismatch');

  r = await settle({ payload: makePayload({ auth: makeAuth({ validBefore: String(nowSec - 10) }) }), deps });
  assert.equal(r.reason, 'authorization_expired');

  r = await settle({ payload: makePayload({ auth: makeAuth({ validAfter: String(nowSec + 600) }) }), deps });
  assert.equal(r.reason, 'authorization_not_yet_valid');

  r = await settle({ payload: { x402Version: 2 }, deps });
  assert.equal(r.reason, 'malformed_payload');

  r = await settle({ payload: makePayload({ signature: 'not-hex' }), deps });
  assert.equal(r.reason, 'malformed_payload');

  r = await settle({ payload: makePayload(), contributor: 'garbage', deps });
  assert.equal(r.reason, 'bad_contributor');

  r = await settle({ payload: makePayload(), bps: 0, deps });
  assert.equal(r.reason, 'bad_contributor_bps');

  assert.equal(calls.length, 0);
});

// Build a valid Receive-path payload (salt + derived nonce) that reaches the
// broadcast stage under receive-only default.
function receivePayload(bps = 7000) {
  const hint = router.createRouterHint({ contributor: CONTRIBUTOR, contributorBps: bps, resource: RESOURCE, amountMicro: AMOUNT });
  const nonce = router.deriveReceiveNonce(CONTRIBUTOR, bps, hint.salt);
  return makePayload({ auth: makeAuth({ nonce }), extra: { salt: hint.salt } });
}

test('broadcast exception maps to settleFailed (fail closed, no content)', async () => {
  enableRouter();
  const { deps } = makeDeps({ broadcast: async () => { throw new Error('rpc down'); } });
  const r = await settle({ payload: receivePayload(), deps });
  assert.equal(r.settleFailed, true);
  assert.match(r.reason, /broadcast_error/);
});

test('confirmation timeout maps to settleFailed confirm_timeout', async () => {
  enableRouter();
  const { deps } = makeDeps({ broadcast: async () => ({ txHash: '0x' + '33'.repeat(32), confirmed: false, reverted: false }) });
  const r = await settle({ payload: receivePayload(), deps });
  assert.equal(r.settleFailed, true);
  assert.equal(r.reason, 'confirm_timeout');
  assert.match(r.txHash, /^0x/);
});

// ── Receive-only MVP mode (default ON) ──────────────────────────────────────

test('receive-only is the default', () => {
  assert.equal(router.receiveOnly(), true);
  process.env.X402_ROUTER_RECEIVE_ONLY = '0';
  assert.equal(router.receiveOnly(), false);
  process.env.X402_ROUTER_RECEIVE_ONLY = 'false';
  assert.equal(router.receiveOnly(), false);
  process.env.X402_ROUTER_RECEIVE_ONLY = '1';
  assert.equal(router.receiveOnly(), true);
});

test('receive-only: a saltless (Transfer) payment is refused fail-closed, no broadcast (F8)', async () => {
  enableRouter(); // receive-only default ON
  const { deps, calls } = makeDeps();
  const r = await settle({ payload: makePayload(), deps }); // no extra.salt
  assert.equal(r.settled, false);
  assert.equal(r.settleFailed, false);
  assert.equal(r.reason, 'receive_only_requires_salt');
  assert.equal(calls.length, 0);
});

test('receive-only: the Receive path still settles normally', async () => {
  enableRouter();
  const hint = router.createRouterHint({ contributor: CONTRIBUTOR, contributorBps: 7000, resource: RESOURCE, amountMicro: AMOUNT });
  const nonce = router.deriveReceiveNonce(CONTRIBUTOR, 7000, hint.salt);
  const payload = makePayload({ auth: makeAuth({ nonce }), extra: { salt: hint.salt } });
  const { deps, calls } = makeDeps();
  const r = await settle({ payload, deps });
  assert.equal(r.settled, true);
  assert.equal(r.path, 'receive');
  assert.equal(calls[0].functionName, 'settleAndSplitReceive');
});

test('buildRouterExtra advertises receive-only mode and rejects blind-signing', () => {
  enableRouter();
  const hint = router.createRouterHint({ contributor: CONTRIBUTOR, contributorBps: 7000, resource: RESOURCE, amountMicro: AMOUNT });
  const extra = router.buildRouterExtra(hint);
  assert.equal(extra.router.mode, 'receive-only');
  assert.match(extra.router.instructions, /RECEIVE-ONLY/);
  assert.match(extra.router.instructions, /Derive the nonce yourself/);
  assert.match(extra.router.instructions, /not accepted|rejected/i);

  process.env.X402_ROUTER_RECEIVE_ONLY = '0';
  const dual = router.buildRouterExtra(hint);
  assert.equal(dual.router.mode, 'dual');
  assert.match(dual.router.instructions, /Generic x402 clients/);
});

// ── A1 circuit-breaker (USDC impl guard) ────────────────────────────────────

test('circuit-breaker: a tripped USDC-impl guard fails closed before broadcast', async () => {
  enableRouter();
  const hint = router.createRouterHint({ contributor: CONTRIBUTOR, contributorBps: 7000, resource: RESOURCE, amountMicro: AMOUNT });
  const nonce = router.deriveReceiveNonce(CONTRIBUTOR, 7000, hint.salt);
  const payload = makePayload({ auth: makeAuth({ nonce }), extra: { salt: hint.salt } });
  const { deps, calls } = makeDeps({ implOk: false });
  const r = await settle({ payload, deps });
  assert.equal(r.settled, false);
  assert.equal(r.settleFailed, true);
  assert.equal(r.circuitOpen, true);
  assert.match(r.reason, /circuit_open/);
  assert.equal(calls.length, 0); // never broadcast with a changed impl
});

// ── A4 reorg-safe finality ──────────────────────────────────────────────────

test('reorg before finality maps to settleFailed reorged_before_final (no booking)', async () => {
  enableRouter();
  const hint = router.createRouterHint({ contributor: CONTRIBUTOR, contributorBps: 7000, resource: RESOURCE, amountMicro: AMOUNT });
  const nonce = router.deriveReceiveNonce(CONTRIBUTOR, 7000, hint.salt);
  const payload = makePayload({ auth: makeAuth({ nonce }), extra: { salt: hint.salt } });
  const { deps } = makeDeps({ broadcast: async () => ({ txHash: '0x' + '44'.repeat(32), confirmed: false, reverted: false, reorged: true }) });
  const r = await settle({ payload, deps });
  assert.equal(r.settled, false);
  assert.equal(r.settleFailed, true);
  assert.equal(r.reason, 'reorged_before_final');
});

// _waitForFinality against a mock publicClient — the four terminal states.
// getBlock({blockTag}) → { number: safeNumber }; getBlock({blockNumber}) →
// { hash: canonicalHash } (the canonical block at the tx's height — Gate-A H1).
function mockPublicClient({ receipts, blockNumber, safeNumber, canonicalHash = '0xabc' }) {
  let i = 0;
  return {
    async getTransactionReceipt() {
      const r = receipts[Math.min(i++, receipts.length - 1)];
      if (r === 'throw') throw new Error('not found');
      return r;
    },
    async getBlockNumber() { return BigInt(blockNumber); },
    async getBlock(arg) {
      if (arg && arg.blockNumber !== undefined) return { hash: canonicalHash }; // canonical-at-height
      return { number: BigInt(safeNumber) }; // safe/finalized head
    },
  };
}

test('_waitForFinality: confirmed when depth met, block still canonical, safe head passed', async () => {
  process.env.X402_ROUTER_CONFIRM_TAG = 'safe';
  process.env.X402_ROUTER_MIN_CONFIRMATIONS = '2';
  const receipt = { status: 'success', blockNumber: 100n, blockHash: '0xabc' };
  const client = mockPublicClient({ receipts: [receipt], blockNumber: 102, safeNumber: 100, canonicalHash: '0xabc' });
  const out = await router._waitForFinality(client, '0xhash');
  assert.equal(out.status, 'confirmed');
  assert.equal(out.confirmations, 2);
});

test('_waitForFinality: reverted receipt short-circuits', async () => {
  const receipt = { status: 'reverted', blockNumber: 100n, blockHash: '0xabc' };
  const client = mockPublicClient({ receipts: [receipt], blockNumber: 100, safeNumber: 100 });
  const out = await router._waitForFinality(client, '0xhash');
  assert.equal(out.status, 'reverted');
});

test('_waitForFinality: a reorg (canonical block hash changed at height) fails closed', async () => {
  process.env.X402_ROUTER_CONFIRM_TAG = 'safe';
  process.env.X402_ROUTER_MIN_CONFIRMATIONS = '1';
  const receipt = { status: 'success', blockNumber: 100n, blockHash: '0xabc' };
  // canonical block at height 100 now has a DIFFERENT hash → the tx block was reorged out
  const client = mockPublicClient({ receipts: [receipt], blockNumber: 102, safeNumber: 102, canonicalHash: '0xDEAD' });
  const out = await router._waitForFinality(client, '0xhash');
  assert.equal(out.status, 'reorged');
});

test('_waitForFinality: safe tag not a real bigint head → keeps waiting, times out (fail closed)', async () => {
  process.env.X402_ROUTER_CONFIRM_TAG = 'safe';
  process.env.X402_ROUTER_MIN_CONFIRMATIONS = '1';
  process.env.X402_ROUTER_CONFIRM_TIMEOUT_MS = '150';
  const receipt = { status: 'success', blockNumber: 100n, blockHash: '0xabc' };
  const client = mockPublicClient({ receipts: [receipt], blockNumber: 102, canonicalHash: '0xabc' });
  // provider returns a non-bigint head number for the tag (e.g. aliases/omits it)
  client.getBlock = async (arg) => (arg && arg.blockNumber !== undefined) ? { hash: '0xabc' } : { number: null };
  const out = await router._waitForFinality(client, '0xhash');
  assert.equal(out.status, 'timeout'); // never books on an unverifiable tag
});

test('_waitForFinality: never-mined times out (fail closed)', async () => {
  process.env.X402_ROUTER_CONFIRM_TIMEOUT_MS = '150'; // tiny, so the test is fast
  const client = mockPublicClient({ receipts: ['throw'], blockNumber: 100, safeNumber: 100 });
  const out = await router._waitForFinality(client, '0xhash');
  assert.equal(out.status, 'timeout');
});

test('getConfirmConfig: mainnet floors min-confirmations to >=1 (no depth-0 booking)', () => {
  process.env.X402_ROUTER_CHAIN_ID = '8453';
  process.env.X402_ROUTER_CONFIRM_TAG = 'latest';
  process.env.X402_ROUTER_MIN_CONFIRMATIONS = '0';
  assert.equal(router.getConfirmConfig().minConfirmations, 1);
  process.env.X402_ROUTER_CHAIN_ID = '84532'; // testnet may opt into 0
  assert.equal(router.getConfirmConfig().minConfirmations, 0);
});
