// test/usdc-impl-monitor.test.js
//
// A1 circuit-breaker: lib/usdc-impl-monitor.js unit suite. Pure logic — a mock
// publicClient replaces the network, mirroring the DI convention in
// test/x402-router.test.js. Live behaviour is covered by
// scripts/usdc-impl-monitor.js (one-shot against real Base / Sepolia RPC) and
// the Sepolia Receive-only E2E.

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const monitor = require('../lib/usdc-impl-monitor.js');

// Live-verified pins (2026-07-04) the module ships with.
const BASE_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const BASE_IMPL = '0x2ce6311ddae708829bc0784c967b7d77d19fd779';
const SEPOLIA_IMPL = '0xd74cc5d436923b8ba2c179b4bca2841d8a52c5b5';

afterEach(() => {
  delete process.env.X402_USDC_EXPECTED_IMPL;
  delete process.env.X402_USDC_EXPECTED_CODEHASH;
});

// A 32-byte storage word that encodes `addr` in its low 20 bytes.
function implWord(addr) {
  return '0x' + '00'.repeat(12) + addr.replace(/^0x/, '');
}
function mockClient({ implAddr, code, throwOnStorage, throwOnCode }) {
  return {
    async getStorageAt() {
      if (throwOnStorage) throw new Error('rpc down');
      return implWord(implAddr);
    },
    async getCode() {
      if (throwOnCode) throw new Error('rpc down');
      return code || '0x60016002';
    },
  };
}

test('slotWordToAddress extracts the low 20 bytes', () => {
  assert.equal(monitor.slotWordToAddress(implWord(BASE_IMPL)), BASE_IMPL);
  assert.equal(monitor.slotWordToAddress('0x' + '00'.repeat(32)), '0x0000000000000000000000000000000000000000');
});

test('pinned expected impl resolves per chain; env overrides', () => {
  assert.equal(monitor.expectedImplFor(8453), BASE_IMPL);
  assert.equal(monitor.expectedImplFor(84532), SEPOLIA_IMPL);
  assert.equal(monitor.expectedImplFor(999999), null); // unpinned
  process.env.X402_USDC_EXPECTED_IMPL = '0x000000000000000000000000000000000000dEaD';
  assert.equal(monitor.expectedImplFor(999999), '0x000000000000000000000000000000000000dead');
});

test('checkUsdcImplementation: OK when on-chain impl matches the pin', async () => {
  const res = await monitor.checkUsdcImplementation({
    publicClient: mockClient({ implAddr: BASE_IMPL }), chainId: 8453, usdcAddress: BASE_USDC,
  });
  assert.equal(res.ok, true);
  assert.equal(res.reason, 'impl_matches');
  assert.equal(res.actual, BASE_IMPL);
});

test('checkUsdcImplementation: TRIPS when the impl address changed', async () => {
  const res = await monitor.checkUsdcImplementation({
    publicClient: mockClient({ implAddr: '0x1111111111111111111111111111111111111111' }),
    chainId: 8453, usdcAddress: BASE_USDC,
  });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'impl_changed');
  assert.equal(res.expected, BASE_IMPL);
  assert.equal(res.actual, '0x1111111111111111111111111111111111111111');
});

test('checkUsdcImplementation: no pin + no override fails closed (no_pinned_impl)', async () => {
  const res = await monitor.checkUsdcImplementation({
    publicClient: mockClient({ implAddr: BASE_IMPL }), chainId: 424242, usdcAddress: BASE_USDC,
  });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'no_pinned_impl');
});

test('checkUsdcImplementation: a read failure fails closed with readError', async () => {
  const res = await monitor.checkUsdcImplementation({
    publicClient: mockClient({ implAddr: BASE_IMPL, throwOnStorage: true }), chainId: 8453, usdcAddress: BASE_USDC,
  });
  assert.equal(res.ok, false);
  assert.equal(res.readError, true);
  assert.match(res.reason, /impl_read_failed/);
});

test('checkUsdcImplementation: optional codehash pin catches a same-address redeploy', async () => {
  const { keccak256 } = require('viem');
  const code = '0xdeadbeef';
  const goodHash = keccak256(code);
  // matching address + matching codehash → OK
  let res = await monitor.checkUsdcImplementation({
    publicClient: mockClient({ implAddr: BASE_IMPL, code }), chainId: 8453, usdcAddress: BASE_USDC,
    expectedCodeHash: goodHash,
  });
  assert.equal(res.ok, true);
  // matching address but WRONG codehash → tripped
  res = await monitor.checkUsdcImplementation({
    publicClient: mockClient({ implAddr: BASE_IMPL, code: '0xcafe' }), chainId: 8453, usdcAddress: BASE_USDC,
    expectedCodeHash: goodHash,
  });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'codehash_changed');
});
