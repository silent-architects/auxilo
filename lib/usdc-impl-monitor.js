'use strict';

// lib/usdc-impl-monitor.js — A1 circuit-breaker: detect Circle USDC proxy upgrades.
//
// WHY THIS EXISTS (audit A1 / VERIFICATION.md §7-8):
//   The AuxiloSplitRouterReceiveOnly trust model — EIP-712/nonce semantics,
//   NO transfer hooks (so the reentrancy reasoning holds), and 1:1 value
//   conservation — is all verified "against FiatTokenV2_2 as deployed today".
//   USDC is a Circle-upgradeable proxy: Circle can swap the implementation
//   *code* underneath the router's assumptions WITHOUT changing the USDC
//   proxy *address* (which is what the contract immutably pins). A future
//   upgrade could add a transfer hook (invalidating the reentrancy proof),
//   fee-on-transfer / rebasing (breaking conservation), or changed nonce
//   semantics — with NO on-chain signal to the router.
//
//   This module reads the proxy's implementation slot and compares it against a
//   pinned known-good value. If it has changed, the rail FAILS CLOSED: the
//   settle path in lib/x402-router.js refuses to broadcast (circuit open),
//   and the standalone monitor (scripts/usdc-impl-monitor.js) alerts.
//
// PROXY TYPE: Circle's FiatTokenProxy is a ZeppelinOS AdminUpgradeabilityProxy;
//   the implementation address lives at
//   keccak256("org.zeppelinos.proxy.implementation") — NOT the EIP-1967 slot.
//   Verified live 2026-07-04 via `cast storage`.

const IMPL_SLOT = '0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3';

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

// Pinned known-good USDC implementations, live-verified 2026-07-04 (`cast
// storage <proxy> <IMPL_SLOT>`). `codeHash` is optional belt-and-suspenders —
// if present the monitor also checks the implementation bytecode hash, so a
// same-address redeploy (rare) is still caught. Address match alone is the
// primary signal (a Circle upgrade changes the impl address).
const PINNED = {
  8453: {
    // Base mainnet
    usdc: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    impl: '0x2ce6311ddae708829bc0784c967b7d77d19fd779', // FiatTokenV2_2
    codeHash: null,
  },
  84532: {
    // Base Sepolia
    usdc: '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
    impl: '0xd74cc5d436923b8ba2c179b4bca2841d8a52c5b5',
    codeHash: null,
  },
};

function pinnedFor(chainId) {
  return PINNED[Number(chainId)] || null;
}

// Resolve the expected implementation address for a chain. An explicit env
// override (X402_USDC_EXPECTED_IMPL) wins — required for any chain not pinned
// above; without a resolvable expectation the check fails closed.
function expectedImplFor(chainId) {
  const env = (process.env.X402_USDC_EXPECTED_IMPL || '').trim();
  if (ADDRESS_RE.test(env)) return env.toLowerCase();
  const p = pinnedFor(chainId);
  return p ? p.impl.toLowerCase() : null;
}

function expectedCodeHashFor(chainId) {
  const env = (process.env.X402_USDC_EXPECTED_CODEHASH || '').trim();
  if (/^0x[0-9a-fA-F]{64}$/.test(env)) return env.toLowerCase();
  const p = pinnedFor(chainId);
  return p && p.codeHash ? p.codeHash.toLowerCase() : null;
}

// The impl slot holds a left-zero-padded 32-byte word; the address is the low
// 20 bytes.
function slotWordToAddress(word) {
  const hex = String(word || '').replace(/^0x/, '').padStart(64, '0');
  return ('0x' + hex.slice(24)).toLowerCase();
}

async function readImplementation({ publicClient, usdcAddress }) {
  const word = await publicClient.getStorageAt({ address: usdcAddress, slot: IMPL_SLOT });
  return slotWordToAddress(word);
}

async function readImplCodeHash({ publicClient, implAddress }) {
  const { keccak256 } = require('viem');
  const code = await publicClient.getCode({ address: implAddress });
  return keccak256(code || '0x').toLowerCase();
}

// Core check. Returns a plain result object — never throws.
//   { ok, reason, expected, actual, expectedCodeHash?, actualCodeHash?, readError? }
// reason ∈ { impl_matches, impl_changed, codehash_changed, no_pinned_impl,
//            impl_read_failed:<msg> }
async function checkUsdcImplementation({ publicClient, chainId, usdcAddress, expectedImpl, expectedCodeHash }) {
  const expected = (expectedImpl || expectedImplFor(chainId));
  if (!expected) {
    return { ok: false, reason: 'no_pinned_impl', expected: null, actual: null };
  }
  let actual;
  try {
    actual = await readImplementation({ publicClient, usdcAddress: usdcAddress });
  } catch (err) {
    return {
      ok: false,
      reason: 'impl_read_failed:' + (err && (err.shortMessage || err.message) || 'unknown'),
      expected: expected.toLowerCase(),
      actual: null,
      readError: true,
    };
  }
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    return { ok: false, reason: 'impl_changed', expected: expected.toLowerCase(), actual: actual.toLowerCase() };
  }

  // Optional secondary bytecode-hash check.
  const wantHash = (expectedCodeHash || expectedCodeHashFor(chainId));
  if (wantHash) {
    let actualHash;
    try {
      actualHash = await readImplCodeHash({ publicClient, implAddress: actual });
    } catch (err) {
      return {
        ok: false,
        reason: 'codehash_read_failed:' + (err && (err.shortMessage || err.message) || 'unknown'),
        expected: expected.toLowerCase(), actual: actual.toLowerCase(),
        expectedCodeHash: wantHash, actualCodeHash: null, readError: true,
      };
    }
    if (actualHash !== wantHash.toLowerCase()) {
      return {
        ok: false, reason: 'codehash_changed',
        expected: expected.toLowerCase(), actual: actual.toLowerCase(),
        expectedCodeHash: wantHash.toLowerCase(), actualCodeHash: actualHash,
      };
    }
  }

  return { ok: true, reason: 'impl_matches', expected: expected.toLowerCase(), actual: actual.toLowerCase() };
}

module.exports = {
  IMPL_SLOT,
  PINNED,
  pinnedFor,
  expectedImplFor,
  expectedCodeHashFor,
  slotWordToAddress,
  readImplementation,
  readImplCodeHash,
  checkUsdcImplementation,
};
