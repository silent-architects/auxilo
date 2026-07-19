#!/usr/bin/env node
'use strict';

// scripts/deploy-attest.js — A3 deploy-time constructor attestation.
//
// WHY (audit A3 / VERIFICATION.md §7-8): AuxiloSplitRouterReceiveOnly is
// IMMUTABLE. Its constructor args (usdc, feeWallet, settler) are the ENTIRE
// trust root and are unrecoverable if wrong — a single wrong-but-nonzero
// feeWallet sends 30-40% of every settlement to a typo/attacker address
// FOREVER, and every unit/fork/symbolic test re-passes against it because they
// all construct correctly in setup. `_validate` only checks non-zero. So the
// trust root can only be secured by a deploy-time procedure, run BEFORE
// X402_ROUTER_ADDRESS is ever set.
//
// This script is that procedure, in two phases:
//
//   PREFLIGHT (before you deploy) — validate the intended constructor args:
//     node scripts/deploy-attest.js preflight \
//       --chain 8453 --usdc <addr> --fee <addr> --settler <addr>
//       [--allow-noncanonical]   (bypass the canonical-USDC assertion; discouraged)
//
//   READBACK (after you deploy, before you flip the flag) — prove the deployed
//   contract stored exactly those args AND is the audited bytecode:
//     node scripts/deploy-attest.js readback \
//       --chain 8453 --router <deployed> \
//       [--usdc <addr> --fee <addr> --settler <addr>]  (expected; asserts equality)
//       [--artifact contracts/out/AuxiloSplitRouterReceiveOnly.sol/AuxiloSplitRouterReceiveOnly.json]
//
// Exit code 0 = all hard checks passed; 1 = at least one hard check FAILED.
// Warnings (⚠) never fail the run but MUST be read.

const fs = require('fs');
const path = require('path');
const { createPublicClient, http, keccak256 } = require('viem');
const { base, baseSepolia } = require('viem/chains');

// ── Canonical / known-good pins (live-verified 2026-07-04) ───────────────────
const CANONICAL_USDC = {
  8453: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  84532: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
};
const EXPECTED_USDC_IMPL = {
  8453: '0x2ce6311ddae708829bc0784c967b7d77d19fd779', // FiatTokenV2_2
  84532: '0xd74cc5d436923b8ba2c179b4bca2841d8a52c5b5',
};
// Never let feeWallet/settler collide with a platform custodial payout wallet —
// current (Auxilo, LLC, rotated 2026-07-12) OR the retired pre-LLC wallet (which
// carries prior history/approvals, exactly what a fresh feeWallet must not have).
const PLATFORM_CUSTODIAL_WALLETS = [
  '0xA19Cf92cc1daCf742f0E50b4128cAD3A86A81EC4', // current — Auxilo, LLC
  '0x1BE960313c93b3aA0AA62BF33B300CAB48c36Ca6', // retired pre-LLC wallet
];
const IMPL_SLOT = '0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3';

const ROUTER_READ_ABI = [
  { name: 'usdc', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { name: 'feeWallet', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { name: 'settler', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
];
const USDC_BLACKLIST_ABI = [
  { name: 'isBlacklisted', type: 'function', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'bool' }] },
];

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

// ── tiny arg parser ──────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) { out[key] = true; }
      else { out[key] = next; i++; }
    } else { out._.push(a); }
  }
  return out;
}

let hardFail = false;
const eqAddr = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();
function pass(msg) { console.log(`  ✓ ${msg}`); }
function fail(msg) { console.error(`  ✗ FAIL: ${msg}`); hardFail = true; }
function warn(msg) { console.warn(`  ⚠ WARN: ${msg}`); }
function requireAddr(name, v) {
  if (!ADDRESS_RE.test(String(v || ''))) { fail(`${name} is missing or not an address: ${v}`); return false; }
  return true;
}

function clientFor(chainId) {
  const chain = chainId === 84532 ? baseSepolia : base;
  const transport = process.env.X402_ROUTER_RPC_URL ? http(process.env.X402_ROUTER_RPC_URL) : http();
  return createPublicClient({ chain, transport });
}

// Zero-fill the immutable byte ranges in a runtime-bytecode hex string (no 0x)
// so two builds that differ ONLY in embedded immutables compare equal. This is
// what lets us prove the deployed LOGIC is the audited source while the
// immutables (verified separately via the getters) are legitimately different.
function blankImmutables(hexNoPrefix, immutableReferences) {
  const chars = hexNoPrefix.split('');
  for (const astId of Object.keys(immutableReferences || {})) {
    for (const ref of immutableReferences[astId]) {
      const start = ref.start * 2; // byte offset → hex offset
      const len = ref.length * 2;
      for (let i = start; i < start + len && i < chars.length; i++) chars[i] = '0';
    }
  }
  return chars.join('');
}

async function preflight(a) {
  const chainId = Number(a.chain || 8453);
  console.log(`\n=== A3 PREFLIGHT (chain ${chainId}) ===`);
  const usdc = a.usdc, fee = a.fee || a.feeWallet, settler = a.settler;
  const okAddrs = [requireAddr('--usdc', usdc), requireAddr('--fee', fee), requireAddr('--settler', settler)].every(Boolean);
  if (!okAddrs) return;

  // 1. Canonical USDC assertion (code-pinnable — the only immutable that is).
  const canonical = CANONICAL_USDC[chainId];
  if (canonical && eqAddr(usdc, canonical)) {
    pass(`USDC is the canonical address for chain ${chainId} (${canonical})`);
  } else if (a['allow-noncanonical']) {
    warn(`USDC ${usdc} is NOT canonical (${canonical}) — proceeding only because --allow-noncanonical was set`);
  } else {
    fail(`USDC ${usdc} != canonical ${canonical} for chain ${chainId}. Re-check, or pass --allow-noncanonical if this is deliberate.`);
  }

  // 2. Distinctness: feeWallet must not be settler, USDC, router-to-be, or the
  //    shared custodial payout wallet, and must be non-zero.
  if (eqAddr(fee, settler)) fail('feeWallet == settler (must be distinct)');
  else pass('feeWallet != settler');
  if (eqAddr(fee, usdc)) fail('feeWallet == USDC address'); else pass('feeWallet != USDC');
  const feeCollision = PLATFORM_CUSTODIAL_WALLETS.find((w) => eqAddr(fee, w));
  if (feeCollision) fail(`feeWallet == platform custodial wallet ${feeCollision} (current or retired) — use a FRESH single-purpose wallet`);
  else pass('feeWallet != platform custodial payout wallets (current + retired)');
  const settlerCollision = PLATFORM_CUSTODIAL_WALLETS.find((w) => eqAddr(settler, w));
  if (settlerCollision) fail(`settler == platform custodial wallet ${settlerCollision} (current or retired) — settler must be a dedicated isolated key (F5)`);
  else pass('settler != platform custodial payout wallets (current + retired)');

  const client = clientFor(chainId);

  // 3. USDC implementation == pinned expected (ties A1 to deploy time).
  try {
    const word = await client.getStorageAt({ address: usdc, slot: IMPL_SLOT });
    const impl = ('0x' + String(word).replace(/^0x/, '').padStart(64, '0').slice(24)).toLowerCase();
    const exp = (process.env.X402_USDC_EXPECTED_IMPL || EXPECTED_USDC_IMPL[chainId] || '').toLowerCase();
    if (exp && impl === exp) pass(`USDC implementation matches pinned expected (${impl})`);
    else if (!exp) warn(`no pinned USDC impl for chain ${chainId}; observed ${impl} — set X402_USDC_EXPECTED_IMPL and re-run`);
    else fail(`USDC implementation ${impl} != pinned expected ${exp} — the A1 monitor pin is stale or USDC was upgraded`);
  } catch (err) { warn(`could not read USDC impl slot: ${err.shortMessage || err.message}`); }

  // 4. feeWallet not USDC-blacklisted, and is a fresh single-purpose wallet.
  try {
    const bl = await client.readContract({ address: usdc, abi: USDC_BLACKLIST_ABI, functionName: 'isBlacklisted', args: [fee] });
    if (bl) fail('feeWallet IS USDC-blacklisted — every fee leg would revert; pick another'); else pass('feeWallet is NOT USDC-blacklisted');
  } catch (err) { warn(`could not check feeWallet blacklist status: ${err.shortMessage || err.message}`); }
  try {
    const n = await client.getTransactionCount({ address: fee });
    if (n === 0) pass('feeWallet nonce == 0 (fresh, single-purpose)');
    else warn(`feeWallet nonce == ${n} (not brand-new; confirm it is intended single-purpose and you control it)`);
  } catch (err) { warn(`could not read feeWallet nonce: ${err.shortMessage || err.message}`); }

  // Attestation record the operator should save + sign off on.
  console.log('\n--- ATTESTATION RECORD (save this; sign off before deploy) ---');
  console.log(JSON.stringify({
    phase: 'preflight', chainId,
    usdc, feeWallet: fee, settler,
    canonicalUsdcAsserted: canonical ? eqAddr(usdc, canonical) : false,
    result: hardFail ? 'FAIL' : 'PASS',
  }, null, 2));
}

async function readback(a) {
  const chainId = Number(a.chain || 8453);
  const router = a.router;
  console.log(`\n=== A3 READBACK (chain ${chainId}) ===`);
  if (!requireAddr('--router', router)) return;
  const client = clientFor(chainId);

  // 1. Read the three immutables back from the deployed contract.
  let onchain;
  try {
    const [usdc, feeWallet, settler] = await Promise.all([
      client.readContract({ address: router, abi: ROUTER_READ_ABI, functionName: 'usdc' }),
      client.readContract({ address: router, abi: ROUTER_READ_ABI, functionName: 'feeWallet' }),
      client.readContract({ address: router, abi: ROUTER_READ_ABI, functionName: 'settler' }),
    ]);
    onchain = { usdc, feeWallet, settler };
    pass(`read immutables: usdc=${usdc} feeWallet=${feeWallet} settler=${settler}`);
  } catch (err) { fail(`could not read router immutables: ${err.shortMessage || err.message}`); return; }

  // 2. Assert each equals the intended value (if provided).
  const want = { usdc: a.usdc, feeWallet: a.fee || a.feeWallet, settler: a.settler };
  for (const k of ['usdc', 'feeWallet', 'settler']) {
    if (want[k]) {
      if (eqAddr(onchain[k], want[k])) pass(`${k} on-chain matches intended (${want[k]})`);
      else fail(`${k} on-chain ${onchain[k]} != intended ${want[k]} — DO NOT flip the flag; redeploy`);
    } else warn(`no expected --${k === 'feeWallet' ? 'fee' : k} supplied; on-chain value is ${onchain[k]} (not asserted)`);
  }

  // 3. Canonical USDC on the deployed contract.
  const canonical = CANONICAL_USDC[chainId];
  if (canonical) {
    if (eqAddr(onchain.usdc, canonical)) pass(`deployed usdc is canonical for chain ${chainId}`);
    else fail(`deployed usdc ${onchain.usdc} != canonical ${canonical}`);
  }

  // 4. Bytecode match vs the audited artifact (immutable-aware).
  const artifactPath = a.artifact || path.join(__dirname, '..', 'contracts', 'out', 'AuxiloSplitRouterReceiveOnly.sol', 'AuxiloSplitRouterReceiveOnly.json');
  try {
    const art = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
    const artObj = String(art.deployedBytecode.object).replace(/^0x/, '').toLowerCase();
    const immRefs = art.deployedBytecode.immutableReferences || {};
    const code = await client.getCode({ address: router });
    const onObj = String(code || '').replace(/^0x/, '').toLowerCase();
    if (onObj.length === 0) { fail('no code at router address (not a contract?)'); }
    else if (onObj.length !== artObj.length) {
      fail(`deployed bytecode length ${onObj.length} != artifact ${artObj.length} — NOT the audited contract`);
    } else {
      const a1 = blankImmutables(artObj, immRefs);
      const b1 = blankImmutables(onObj, immRefs);
      if (a1 === b1) pass('deployed runtime bytecode matches audited artifact (immutables blanked)');
      else fail('deployed runtime bytecode DIFFERS from audited artifact — NOT the audited contract');
    }
  } catch (err) {
    // Gate-A L4: readback is the gate that precedes flipping the flag. A MISSING
    // bytecode comparison (artifact absent/unparseable, getCode error) must be a
    // HARD FAIL, not a warning — otherwise "forgot to `forge build`" yields a
    // green readback with the strongest check silently skipped.
    fail(`bytecode match could not run: ${err.message} — run \`forge build\` in contracts/ and retry (this check is mandatory before the flag)`);
  }

  console.log('\n--- READBACK RESULT ---');
  console.log(JSON.stringify({ phase: 'readback', chainId, router, onchain, result: hardFail ? 'FAIL' : 'PASS' }, null, 2));
  console.log('\nNEXT: run Etherscan/Basescan source verification (see contracts/DEPLOY-ATTESTATION.md §5),');
  console.log('then — only if every check above is ✓ — set X402_ROUTER_ADDRESS to this router.');
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const a = parseArgs(argv.slice(1));
  if (cmd === 'preflight') await preflight(a);
  else if (cmd === 'readback') await readback(a);
  else {
    console.error('Usage: deploy-attest.js <preflight|readback> [flags] — see header comment.');
    process.exit(2);
  }
  console.log(hardFail ? '\n✗ ATTESTATION FAILED — do not proceed.\n' : '\n✓ ATTESTATION PASSED for this phase.\n');
  process.exit(hardFail ? 1 : 0);
}

main().catch((err) => { console.error('deploy-attest fatal:', err); process.exit(1); });
