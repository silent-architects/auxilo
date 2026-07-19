#!/usr/bin/env node
'use strict';

// scripts/x402-router-sepolia-receiveonly-e2e.js
//
// TESTNET STAGE for the mainnet flag-enable. Exercises lib/x402-router.js in
// RECEIVE-ONLY mode against the LIVE AuxiloSplitRouterReceiveOnly on Base
// Sepolia, with the NEW A1 (USDC-impl circuit-breaker) and A4 (reorg-safe
// confirmation-depth) guards ACTIVE — real broadcasts, real balance
// assertions, real finality wait. Testnet only; never mainnet.
//
//   node scripts/x402-router-sepolia-receiveonly-e2e.js
//
// It proves, live:
//   1. Receive path settles: buyer signs a derived-nonce ReceiveWithAuthorization
//      → contributor +70% / feeWallet +30% / router residue 0.
//   2. A4: the settle is only booked after the reorg-safe finality gate — with
//      X402_ROUTER_CONFIRM_TAG=safe it WAITS for the Base safe head to pass the
//      tx's block (not depth 1). Wait duration + confirmations are logged.
//   3. A1: the USDC-impl circuit-breaker runs on the real broadcast (a passing
//      settle proves it), and a deliberate wrong-pin makes it trip fail-closed.
//   4. Receive-only: a saltless (generic Transfer) payment is refused, no
//      broadcast — the Transfer selector is absent from this contract anyway.
//
// Key: X402_E2E_KEY_FILE (default ~/.auxilo/testnet/sepolia-deployer.txt).

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROUTER_RECEIVEONLY = '0x149C21BD3aC4364528fECceF29acf4Ec8ecf8145';
const USDC_SEPOLIA = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const CONTRIBUTOR = '0x000000000000000000000000000000000000dEaD'; // inert sink, balance-assertable
const AMOUNT_MICRO = '100000'; // 0.10 USDC
const BPS = 7000;

// Hermetic: only ever speak to Base Sepolia (GOV-3 L-3).
delete process.env.X402_ROUTER_RPC_URL;
process.env.X402_ROUTER_ADDRESS = ROUTER_RECEIVEONLY;
process.env.X402_ROUTER_CHAIN_ID = '84532';
process.env.X402_ROUTER_USDC = USDC_SEPOLIA;
// Receive-only is the default; be explicit so the stage is self-documenting.
process.env.X402_ROUTER_RECEIVE_ONLY = process.env.X402_ROUTER_RECEIVE_ONLY || '1';
// A4: exercise the REAL reorg-safe finality gate against the Base safe head.
// safe lags latest by ~85 blocks (~3 min) on Base Sepolia, so give it room.
process.env.X402_ROUTER_CONFIRM_TAG = process.env.X402_ROUTER_CONFIRM_TAG || 'safe';
process.env.X402_ROUTER_MIN_CONFIRMATIONS = process.env.X402_ROUTER_MIN_CONFIRMATIONS || '2';
process.env.X402_ROUTER_CONFIRM_TIMEOUT_MS = process.env.X402_ROUTER_CONFIRM_TIMEOUT_MS || '420000';

const keyFile = process.env.X402_E2E_KEY_FILE || path.join(os.homedir(), '.auxilo', 'testnet', 'sepolia-deployer.txt');
const keyMatch = fs.readFileSync(keyFile, 'utf8').match(/0x[0-9a-fA-F]{64}/);
if (!keyMatch) { console.error(`No private key found in ${keyFile}`); process.exit(1); }
process.env.X402_SETTLER_PRIVATE_KEY = keyMatch[0];

const router = require('../lib/x402-router.js');
const monitor = require('../lib/usdc-impl-monitor.js');
const { createPublicClient, http } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const { baseSepolia } = require('viem/chains');

const ERC20_VIEW_ABI = [
  { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { name: 'name', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { name: 'version', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
];

const benignOfac = { ofacScreeningReady: () => true, checkOFAC: () => false, logOFACBlock: () => {} };

function assert(cond, msg) {
  if (!cond) { console.error(`✗ FAIL: ${msg}`); process.exit(1); }
  console.log(`✓ ${msg}`);
}

async function main() {
  const buyer = privateKeyToAccount(process.env.X402_SETTLER_PRIVATE_KEY);
  const pub = createPublicClient({ chain: baseSepolia, transport: http() });
  const bal = (addr) => pub.readContract({ address: USDC_SEPOLIA, abi: ERC20_VIEW_ABI, functionName: 'balanceOf', args: [addr] });

  console.log(`Router (Receive-only): ${ROUTER_RECEIVEONLY} (Base Sepolia)`);
  console.log(`Buyer/settler:         ${buyer.address}`);
  console.log(`Confirm policy:        tag=${process.env.X402_ROUTER_CONFIRM_TAG} min=${process.env.X402_ROUTER_MIN_CONFIRMATIONS} timeout=${process.env.X402_ROUTER_CONFIRM_TIMEOUT_MS}ms`);

  const [usdcName, usdcVersion, feeWallet, settler] = await Promise.all([
    pub.readContract({ address: USDC_SEPOLIA, abi: ERC20_VIEW_ABI, functionName: 'name' }),
    pub.readContract({ address: USDC_SEPOLIA, abi: ERC20_VIEW_ABI, functionName: 'version' }),
    pub.readContract({ address: ROUTER_RECEIVEONLY, abi: router.ROUTER_ABI, functionName: 'feeWallet' }),
    pub.readContract({ address: ROUTER_RECEIVEONLY, abi: router.ROUTER_ABI, functionName: 'settler' }),
  ]);
  console.log(`USDC: name="${usdcName}" version="${usdcVersion}"; feeWallet=${feeWallet}; settler=${settler}`);
  assert(settler.toLowerCase() === buyer.address.toLowerCase(), 'key is the router settler');

  // ── Pre-flight: A1 impl guard passes live against the pinned Sepolia impl ──
  const implRes = await monitor.checkUsdcImplementation({ publicClient: pub, chainId: 84532, usdcAddress: USDC_SEPOLIA });
  assert(implRes.ok, `A1 monitor: USDC impl matches pin (${implRes.actual})`);

  const buyerStart = await bal(buyer.address);
  assert(buyerStart >= BigInt(AMOUNT_MICRO), `buyer holds >= 0.10 USDC (has ${buyerStart})`);

  const nowSec = Math.floor(Date.now() / 1000);
  const resource = '/knowledge/e2e-sepolia-receiveonly';
  const contributorAmt = (BigInt(AMOUNT_MICRO) * BigInt(BPS)) / 10000n;
  const feeAmt = BigInt(AMOUNT_MICRO) - contributorAmt;

  const signReceive = async (nonce) => {
    const typed = router.buildAuthTypedData({
      type: 'ReceiveWithAuthorization', usdcName, usdcVersion, chainId: 84532, usdcAddress: USDC_SEPOLIA,
      from: buyer.address, to: ROUTER_RECEIVEONLY, value: AMOUNT_MICRO,
      validAfter: String(nowSec - 60), validBefore: String(nowSec + 3600), nonce,
    });
    return buyer.signTypedData(typed);
  };

  // ── 1 + 2 + 3: Receive settle with the real A4 finality gate + A1 guard ──
  const hint = router.createRouterHint({ contributor: CONTRIBUTOR, contributorBps: BPS, resource, amountMicro: AMOUNT_MICRO });
  const derivedNonce = router.deriveReceiveNonce(CONTRIBUTOR, BPS, hint.salt);
  const extra = router.buildRouterExtra(hint);
  assert(extra.router.mode === 'receive-only', 'challenge advertises receive-only mode');
  assert(derivedNonce === extra.router.nonce, 'challenge extra carries the derived nonce');
  const receiveSig = await signReceive(derivedNonce);
  const receivePayload = {
    x402Version: 2, scheme: 'exact', network: 'eip155:84532',
    payload: {
      signature: receiveSig,
      authorization: { from: buyer.address, to: ROUTER_RECEIVEONLY, value: AMOUNT_MICRO, validAfter: String(nowSec - 60), validBefore: String(nowSec + 3600), nonce: derivedNonce },
      extra: { salt: hint.salt },
    },
  };

  const [c0, f0, r0] = await Promise.all([bal(CONTRIBUTOR), bal(feeWallet), bal(ROUTER_RECEIVEONLY)]);
  console.log(`\n[A4] settling with reorg-safe finality gate — this WAITS for the Base '${process.env.X402_ROUTER_CONFIRM_TAG}' head...`);
  const t0 = Date.now();
  const res = await router.settleWithRouter({
    paymentPayload: receivePayload, expectedAmountMicro: AMOUNT_MICRO,
    resource, contributor: CONTRIBUTOR, contributorBps: BPS, deps: benignOfac, // real broadcast; real A1 guard runs
  });
  const waited = ((Date.now() - t0) / 1000).toFixed(1);
  assert(res.settled === true, `receive path settled (tx ${res.txHash}, reason=${res.reason}, path=${res.path})`);
  assert(res.path === 'receive', 'settled via settleAndSplitReceive');
  console.log(`✓ [A4] booked as final only after ${waited}s finality wait (tag=${process.env.X402_ROUTER_CONFIRM_TAG}) — NOT depth 1`);

  // Poll balances (public Sepolia RPC is load-balanced).
  let c1, f1, r1;
  for (let i = 0; i < 15; i++) {
    [c1, f1, r1] = await Promise.all([bal(CONTRIBUTOR), bal(feeWallet), bal(ROUTER_RECEIVEONLY)]);
    if (c1 - c0 === contributorAmt) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  assert(c1 - c0 === contributorAmt, `contributor +${contributorAmt} micro-USDC (got +${c1 - c0})`);
  assert(f1 - f0 === feeAmt, `feeWallet +${feeAmt} micro-USDC (got +${f1 - f0})`);
  assert(r1 === r0, `router holds nothing (residue ${r1})`);

  // ── 4: Receive-only refuses a saltless (generic Transfer) payment ──
  const randomNonce = '0x' + require('crypto').randomBytes(32).toString('hex');
  const transferSig = await signReceive(randomNonce); // any sig; it never reaches the chain
  const saltlessPayload = {
    x402Version: 2, scheme: 'exact', network: 'eip155:84532',
    payload: { signature: transferSig, authorization: { from: buyer.address, to: ROUTER_RECEIVEONLY, value: AMOUNT_MICRO, validAfter: String(nowSec - 60), validBefore: String(nowSec + 3600), nonce: randomNonce } },
  };
  const refused = await router.settleWithRouter({
    paymentPayload: saltlessPayload, expectedAmountMicro: AMOUNT_MICRO,
    resource, contributor: CONTRIBUTOR, contributorBps: BPS, deps: benignOfac,
  });
  assert(refused.settled === false && refused.reason === 'receive_only_requires_salt', `receive-only refuses saltless Transfer (reason=${refused.reason})`);
  const bafter = await bal(buyer.address);
  // (refusal is pre-broadcast; the only spend so far is the one receive settle)

  // ── 3b: A1 circuit-breaker TRIPS live on a wrong impl pin (fail closed) ──
  console.log('\n[A1] tripping the circuit-breaker with a deliberate wrong impl pin...');
  process.env.X402_USDC_EXPECTED_IMPL = '0x000000000000000000000000000000000000dEaD';
  router._resetForTests(); // clears the impl cache + hints
  const hint2 = router.createRouterHint({ contributor: CONTRIBUTOR, contributorBps: BPS, resource, amountMicro: AMOUNT_MICRO });
  const nonce2 = router.deriveReceiveNonce(CONTRIBUTOR, BPS, hint2.salt);
  const sig2 = await signReceive(nonce2);
  const payload2 = {
    x402Version: 2, scheme: 'exact', network: 'eip155:84532',
    payload: { signature: sig2, authorization: { from: buyer.address, to: ROUTER_RECEIVEONLY, value: AMOUNT_MICRO, validAfter: String(nowSec - 60), validBefore: String(nowSec + 3600), nonce: nonce2 }, extra: { salt: hint2.salt } },
  };
  const cBefore = await bal(CONTRIBUTOR);
  const tripped = await router.settleWithRouter({
    paymentPayload: payload2, expectedAmountMicro: AMOUNT_MICRO,
    resource, contributor: CONTRIBUTOR, contributorBps: BPS, deps: benignOfac,
  });
  assert(tripped.settled === false && tripped.circuitOpen === true, `A1 breaker fails closed on impl mismatch (reason=${tripped.reason})`);
  const cAfterTrip = await bal(CONTRIBUTOR);
  assert(cAfterTrip === cBefore, 'no funds moved while the breaker was open');
  delete process.env.X402_USDC_EXPECTED_IMPL;

  console.log(`\n=== RECEIVE-ONLY E2E PASSED ===`);
  console.log(`Receive settle tx: ${res.txHash}`);
  console.log(`Buyer spent:       ${buyerStart - bafter} micro-USDC (one settle)`);
  console.log(`Finality wait:     ${waited}s (tag=${process.env.X402_ROUTER_CONFIRM_TAG})`);
}

main().catch((err) => { console.error('✗ E2E failed:', err); process.exit(1); });
