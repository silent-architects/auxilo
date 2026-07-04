#!/usr/bin/env node
'use strict';

// scripts/x402-router-sepolia-e2e.js
//
// R-01 integration test: exercises lib/x402-router.js against the LIVE
// AuxiloSplitRouter on Base Sepolia (contracts/DEPLOY-SEPOLIA.md) — both
// settlement paths, real broadcasts, real balance assertions. Testnet only.
//
// Not part of `npm test` (needs a funded key + network). Run manually:
//   node scripts/x402-router-sepolia-e2e.js
//
// Key: X402_E2E_KEY_FILE (default ~/.auxilo/testnet/sepolia-deployer.txt), a
// throwaway TESTNET-ONLY key holding Base Sepolia ETH + Circle faucet USDC.
// The same key plays buyer (signs EIP-3009) and settler (broadcasts) — the
// router doesn't care who the buyer is, only that the signature verifies.
//
// Spend per run: ~0.20 USDC (testnet) + dust gas.

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROUTER_SEPOLIA = '0x8979B20E4789f4F903655B0ce8e0e901099E6142';
const USDC_SEPOLIA = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const CONTRIBUTOR = '0x000000000000000000000000000000000000dEaD'; // inert sink, balance-assertable
const AMOUNT_MICRO = '100000'; // 0.10 USDC
const BPS = 7000;

// Env BEFORE requiring the lib (it reads env lazily, but be explicit).
// Hermetic: clear any inherited RPC override so this script can only ever
// speak to Base Sepolia (GOV-3 L-3).
delete process.env.X402_ROUTER_RPC_URL;
process.env.X402_ROUTER_ADDRESS = ROUTER_SEPOLIA;
process.env.X402_ROUTER_CHAIN_ID = '84532';
process.env.X402_ROUTER_USDC = USDC_SEPOLIA;

const keyFile = process.env.X402_E2E_KEY_FILE || path.join(os.homedir(), '.auxilo', 'testnet', 'sepolia-deployer.txt');
// The deployer file is annotated (cast wallet output: address line + key
// line) — extract the first 32-byte hex string.
const keyMatch = fs.readFileSync(keyFile, 'utf8').match(/0x[0-9a-fA-F]{64}/);
if (!keyMatch) {
  console.error(`No private key found in ${keyFile}`);
  process.exit(1);
}
process.env.X402_SETTLER_PRIVATE_KEY = keyMatch[0];

const router = require('../lib/x402-router.js');
const { createPublicClient, http } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const { baseSepolia } = require('viem/chains');

const ERC20_VIEW_ABI = [
  { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { name: 'name', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { name: 'version', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
];

// The integration test injects benign OFAC deps: sanctions screening is the
// server's live SDN state and is unit-tested fail-closed in
// test/x402-router.test.js; this script tests the CHAIN mechanics.
const benignOfac = {
  ofacScreeningReady: () => true,
  checkOFAC: () => false,
  logOFACBlock: () => {},
};

function assert(cond, msg) {
  if (!cond) {
    console.error(`✗ FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`✓ ${msg}`);
}

async function main() {
  const buyer = privateKeyToAccount(process.env.X402_SETTLER_PRIVATE_KEY);
  const pub = createPublicClient({ chain: baseSepolia, transport: http() });
  const bal = (addr) => pub.readContract({ address: USDC_SEPOLIA, abi: ERC20_VIEW_ABI, functionName: 'balanceOf', args: [addr] });

  console.log(`Router:      ${ROUTER_SEPOLIA} (Base Sepolia)`);
  console.log(`Buyer/settler: ${buyer.address}`);

  const [usdcName, usdcVersion, feeWallet, settler] = await Promise.all([
    pub.readContract({ address: USDC_SEPOLIA, abi: ERC20_VIEW_ABI, functionName: 'name' }),
    pub.readContract({ address: USDC_SEPOLIA, abi: ERC20_VIEW_ABI, functionName: 'version' }),
    pub.readContract({ address: ROUTER_SEPOLIA, abi: router.ROUTER_ABI, functionName: 'feeWallet' }),
    pub.readContract({ address: ROUTER_SEPOLIA, abi: router.ROUTER_ABI, functionName: 'settler' }),
  ]);
  console.log(`USDC domain: name="${usdcName}" version="${usdcVersion}"; feeWallet=${feeWallet}; settler=${settler}`);
  assert(settler.toLowerCase() === buyer.address.toLowerCase(), 'key is the router settler');

  const buyerStart = await bal(buyer.address);
  assert(buyerStart >= BigInt(AMOUNT_MICRO) * 2n, `buyer holds >= 0.20 USDC (has ${buyerStart})`);

  const nowSec = Math.floor(Date.now() / 1000);
  const resource = '/knowledge/e2e-sepolia';
  const contributorAmt = (BigInt(AMOUNT_MICRO) * BigInt(BPS)) / 10000n;
  const feeAmt = BigInt(AMOUNT_MICRO) - contributorAmt;

  const signAuth = async (type, nonce) => {
    const typed = router.buildAuthTypedData({
      type,
      usdcName,
      usdcVersion,
      chainId: 84532,
      usdcAddress: USDC_SEPOLIA,
      from: buyer.address,
      to: ROUTER_SEPOLIA,
      value: AMOUNT_MICRO,
      validAfter: String(nowSec - 60),
      validBefore: String(nowSec + 3600),
      nonce,
    });
    return buyer.signTypedData(typed);
  };

  const settleAndAssert = async (label, payload) => {
    const [c0, f0, r0] = await Promise.all([bal(CONTRIBUTOR), bal(feeWallet), bal(ROUTER_SEPOLIA)]);
    const res = await router.settleWithRouter({
      paymentPayload: payload,
      expectedAmountMicro: AMOUNT_MICRO,
      resource,
      contributor: CONTRIBUTOR,
      contributorBps: BPS,
      deps: benignOfac, // real broadcast: no sendRouterTx injection
    });
    assert(res.settled === true, `${label}: settled (tx ${res.txHash}, reason=${res.reason})`);
    // The public Sepolia RPC is load-balanced; a balanceOf right after the
    // receipt can hit a node still one block behind. Poll until the
    // contributor delta appears (or 30s), then assert everything.
    let c1, f1, r1;
    for (let i = 0; i < 15; i++) {
      [c1, f1, r1] = await Promise.all([bal(CONTRIBUTOR), bal(feeWallet), bal(ROUTER_SEPOLIA)]);
      if (c1 - c0 === contributorAmt) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    assert(c1 - c0 === contributorAmt, `${label}: contributor +${contributorAmt} micro-USDC (got +${c1 - c0})`);
    assert(f1 - f0 === feeAmt, `${label}: feeWallet +${feeAmt} micro-USDC (got +${f1 - f0})`);
    assert(r1 === r0, `${label}: router holds nothing (${r1})`);
    return res;
  };

  // ── Path 1: Receive (nonce-bound) — the Auxilo-aware client flow ──
  const hint = router.createRouterHint({ contributor: CONTRIBUTOR, contributorBps: BPS, resource, amountMicro: AMOUNT_MICRO });
  const derivedNonce = router.deriveReceiveNonce(CONTRIBUTOR, BPS, hint.salt);
  assert(derivedNonce === router.buildRouterExtra(hint).router.nonce, 'challenge extra carries the same derived nonce');
  const receiveSig = await signAuth('ReceiveWithAuthorization', derivedNonce);
  const receivePayload = {
    x402Version: 2,
    scheme: 'exact',
    network: 'eip155:84532',
    payload: {
      signature: receiveSig,
      authorization: {
        from: buyer.address, to: ROUTER_SEPOLIA, value: AMOUNT_MICRO,
        validAfter: String(nowSec - 60), validBefore: String(nowSec + 3600), nonce: derivedNonce,
      },
      extra: { salt: hint.salt },
    },
  };
  const r1 = await settleAndAssert('receive path', receivePayload);
  assert(r1.path === 'receive', 'settled via settleAndSplitReceive');

  // ── Path 2: Transfer (generic x402 client) — random nonce, no salt ──
  const randomNonce = '0x' + require('crypto').randomBytes(32).toString('hex');
  const transferSig = await signAuth('TransferWithAuthorization', randomNonce);
  const transferPayload = {
    x402Version: 2,
    scheme: 'exact',
    network: 'eip155:84532',
    payload: {
      signature: transferSig,
      authorization: {
        from: buyer.address, to: ROUTER_SEPOLIA, value: AMOUNT_MICRO,
        validAfter: String(nowSec - 60), validBefore: String(nowSec + 3600), nonce: randomNonce,
      },
    },
  };
  const r2 = await settleAndAssert('transfer path', transferPayload);
  assert(r2.path === 'transfer', 'settled via settleAndSplitTransfer');

  const buyerEnd = await bal(buyer.address);
  console.log(`\nAll assertions passed. Buyer spent ${buyerStart - buyerEnd} micro-USDC across both paths.`);
  console.log(`Receive tx:  ${r1.txHash}`);
  console.log(`Transfer tx: ${r2.txHash}`);
}

main().catch((err) => {
  console.error('✗ E2E failed:', err);
  process.exit(1);
});
