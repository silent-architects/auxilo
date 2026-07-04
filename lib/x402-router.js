'use strict';

// lib/x402-router.js — non-custodial x402 settlement through AuxiloSplitRouter (R-01).
//
// FLAG-GATED: everything here is inert unless X402_ROUTER_ADDRESS is set to a
// deployed AuxiloSplitRouter address. With the flag unset (the prod default
// until the hard gates in contracts/README.md clear), server.js behavior is
// byte-for-byte the current facilitator rail.
//
// What this replaces when enabled: facilitator /settle capturing 100% of the
// buyer's USDC into the platform wallet + an off-chain pending_balance credit
// (custody). Instead Auxilo SELF-SETTLES against the router, which atomically
// splits the buyer's USDC into contributor share + platform fee in a single
// transaction — the contributor's money never rests with Auxilo.
//
// Two settlement paths (contracts/AuxiloSplitRouter.sol):
//   1. settleAndSplitReceive — Auxilo-aware clients. The 402 challenge `extra`
//      carries (contributor, contributorBps, salt); the client signs a USDC
//      EIP-3009 ReceiveWithAuthorization whose nonce is DERIVED:
//        nonce = keccak256(abi.encode(contributor, contributorBps, salt))
//      The contract re-derives the nonce from the settler-supplied split
//      params, so settler tampering with the split fails USDC's own signature
//      check (red-team P1-1 nonce binding). The client echoes {salt} in the
//      payment payload `extra` so the server can find the hint again.
//   2. settleAndSplitTransfer — generic x402 clients that sign the standard
//      exact-scheme TransferWithAuthorization (to = router) with their own
//      random nonce. Split params are settler-asserted on this path — the
//      disclosed interop cost (contracts/README.md client-compat table).
//
// OFAC: buyer (the EIP-3009 signer) AND contributor (the split recipient) are
// screened fail-closed BEFORE any broadcast, on BOTH paths. The screening
// functions live in server.js state, so they arrive via `deps` injection —
// the same injection convention as fetchImpl in lib/x402-facilitator.js.
//
// Broadcast follows the lib/tx-manager.js pattern: single-flight mutex, fresh
// on-chain nonce, poll-for-receipt confirmation. When WALLET_PRIVATE_KEY is
// set (i.e. tx-manager is loadable without exiting) we share tx-manager's
// mutex so router settles and legacy sendUSDC payouts can never race the same
// account nonce; otherwise a module-local queue is used.

const crypto = require('crypto');

// ── Router ABI (only what the settler calls; source: contracts/AuxiloSplitRouter.sol) ──
const ROUTER_ABI = [
  {
    name: 'settleAndSplitReceive',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'from', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'salt', type: 'bytes32' },
      { name: 'signature', type: 'bytes' },
      { name: 'contributor', type: 'address' },
      { name: 'contributorBps', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    name: 'settleAndSplitTransfer',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'from', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' },
      { name: 'signature', type: 'bytes' },
      { name: 'contributor', type: 'address' },
      { name: 'contributorBps', type: 'uint256' },
    ],
    outputs: [],
  },
  { name: 'settler', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { name: 'feeWallet', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { name: 'usdc', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
];

// Per-chain USDC defaults (Circle-verified; see contracts/DEPLOY-SEPOLIA.md).
const USDC_BY_CHAIN = {
  8453: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // Base mainnet
  84532: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', // Base Sepolia
};

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;

const CONFIRM_TIMEOUT_MS = 60_000; // mirror tx-manager
const CONFIRM_POLL_MS = 2_000;

// ── Flag / config ───────────────────────────────────────────────────────────

function routerEnabled() {
  return ADDRESS_RE.test(process.env.X402_ROUTER_ADDRESS || '');
}

function getRouterAddress() {
  const a = process.env.X402_ROUTER_ADDRESS || '';
  return ADDRESS_RE.test(a) ? a : null;
}

function getChainId() {
  return Number(process.env.X402_ROUTER_CHAIN_ID || 8453);
}

function getNetworkString() {
  return `eip155:${getChainId()}`;
}

function getUsdcAddress() {
  return process.env.X402_ROUTER_USDC || USDC_BY_CHAIN[getChainId()] || USDC_BY_CHAIN[8453];
}

// ── Nonce derivation (must match AuxiloSplitRouter.sol line-for-line):
//    bytes32 nonce = keccak256(abi.encode(contributor, contributorBps, salt))
function deriveReceiveNonce(contributor, contributorBps, salt) {
  const { keccak256, encodeAbiParameters } = require('viem');
  return keccak256(encodeAbiParameters(
    [{ type: 'address' }, { type: 'uint256' }, { type: 'bytes32' }],
    [contributor, BigInt(contributorBps), salt],
  ));
}

// ── Challenge hint store ────────────────────────────────────────────────────
// Each router-mode 402 challenge advertises a salt and remembers the split it
// advertised. At settle time the echoed salt looks the hint back up, so the
// split the buyer signed over is exactly the split we broadcast — immune to
// drift in source-based share computation between the challenge request and
// the paid request.
//
// FLOOD HARDENING (Gate A sec L-1 / PUNCH-LIST RT-1): challenges REUSE a
// fresh hint for the same (resource, contributor, bps, amount) instead of
// minting a new salt per request. The 402 challenge is unauthenticated, so a
// per-request mint let an attacker churn the store and evict live hints;
// with reuse, the live-hint population is bounded by catalog size, not
// request rate. Sharing one salt across buyers is safe: EIP-3009 nonces are
// per-authorizer (FiatToken keeps mapping(authorizer => nonce => used)), so
// two buyers signing the same derived nonce cannot collide on-chain — which
// is also why hints are NOT consumed on settle success (a consume would
// break the second concurrent buyer of the same learning). Known edge: the
// SAME buyer re-buying the SAME learning inside one reuse window re-derives
// an on-chain-used nonce and fails closed until a fresh salt is minted after
// the window — rare, self-healing, documented.
const HINT_TTL_MS = 15 * 60 * 1000;
const HINT_REUSE_MS = 5 * 60 * 1000; // mint at most one salt per split per window
const HINT_MAX = 5000;
const _hints = new Map();      // salt -> hint
const _hintsBySplit = new Map(); // resource|contributor|bps|amount -> salt

function _splitKey({ contributor, contributorBps, resource, amountMicro }) {
  return `${resource}|${String(contributor).toLowerCase()}|${contributorBps}|${amountMicro}`;
}

function _pruneHints() {
  const now = Date.now();
  for (const [salt, h] of _hints) {
    if (now - h.createdAt > HINT_TTL_MS) {
      _hints.delete(salt);
      if (_hintsBySplit.get(h.splitKey) === salt) _hintsBySplit.delete(h.splitKey);
    }
  }
  // Bound memory even under pathological catalogs: evict oldest (Map
  // preserves insertion order) until under the cap.
  while (_hints.size > HINT_MAX) {
    const oldestSalt = _hints.keys().next().value;
    const oldest = _hints.get(oldestSalt);
    _hints.delete(oldestSalt);
    if (oldest && _hintsBySplit.get(oldest.splitKey) === oldestSalt) _hintsBySplit.delete(oldest.splitKey);
  }
}

function createRouterHint({ contributor, contributorBps, resource, amountMicro }) {
  if (!ADDRESS_RE.test(contributor || '')) throw new TypeError('createRouterHint: bad contributor address');
  const bps = Number(contributorBps);
  if (!Number.isInteger(bps) || bps < 1 || bps > 10000) throw new RangeError('createRouterHint: contributorBps out of range');
  _pruneHints();
  const splitKey = _splitKey({ contributor, contributorBps: bps, resource, amountMicro: String(amountMicro) });
  const existingSalt = _hintsBySplit.get(splitKey);
  if (existingSalt) {
    const existing = _hints.get(existingSalt);
    if (existing && Date.now() - existing.createdAt < HINT_REUSE_MS) return existing;
  }
  const salt = '0x' + crypto.randomBytes(32).toString('hex');
  const hint = {
    salt,
    contributor,
    contributorBps: bps,
    resource,
    amountMicro: String(amountMicro),
    createdAt: Date.now(),
    splitKey,
  };
  _hints.set(salt, hint);
  _hintsBySplit.set(splitKey, salt);
  return hint;
}

function peekRouterHint(salt) {
  const h = _hints.get(salt);
  if (!h) return null;
  if (Date.now() - h.createdAt > HINT_TTL_MS) {
    _hints.delete(salt);
    return null;
  }
  return h;
}

// Explicit removal (admin/testing). Settles do NOT consume hints — see the
// flood-hardening note above; replay safety comes from EIP-3009's
// per-authorizer nonce plus the server-side payment dedup, not from hint
// lifetime.
function consumeRouterHint(salt) {
  const h = _hints.get(salt);
  _hints.delete(salt);
  if (h && _hintsBySplit.get(h.splitKey) === salt) _hintsBySplit.delete(h.splitKey);
}

// The `extra` object for a router-mode 402 challenge. `name`/`version` remain
// the USDC EIP-712 domain fields generic x402 clients already use to sign
// TransferWithAuthorization (payTo = router works unchanged for them). The
// `router` block is the Auxilo-aware upgrade path to the front-run-proof
// Receive settlement.
function buildRouterExtra(hint, { usdcName = 'USD Coin', usdcVersion = '2' } = {}) {
  return {
    assetTransferMethod: 'eip3009',
    name: usdcName,
    version: usdcVersion,
    router: {
      address: getRouterAddress(),
      scheme: 'auxilo-split-v1',
      authorizationType: 'ReceiveWithAuthorization',
      contributor: hint.contributor,
      contributorBps: String(hint.contributorBps),
      salt: hint.salt,
      // Convenience precompute — identical to deriving client-side. The
      // binding comes from the CONTRACT re-deriving it from settler-supplied
      // params, not from who computed it first.
      nonce: deriveReceiveNonce(hint.contributor, hint.contributorBps, hint.salt),
      instructions: 'Sign USDC ReceiveWithAuthorization with to=router.address and nonce as given (or derive it: keccak256(abi.encode(contributor,contributorBps,salt))). Send the salt back as {"extra":{"salt":...}} inside the X-Payment payload. Generic x402 clients: ignore this block and sign the standard TransferWithAuthorization to payTo with a random nonce.',
    },
  };
}

// EIP-712 typed data for the integration script / Auxilo-aware clients.
function buildAuthTypedData({ type, usdcName, usdcVersion, chainId, usdcAddress, from, to, value, validAfter, validBefore, nonce }) {
  if (type !== 'ReceiveWithAuthorization' && type !== 'TransferWithAuthorization') {
    throw new TypeError('buildAuthTypedData: type must be ReceiveWithAuthorization or TransferWithAuthorization');
  }
  return {
    domain: { name: usdcName, version: usdcVersion, chainId, verifyingContract: usdcAddress },
    types: {
      [type]: [
        { name: 'from', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' },
        { name: 'validBefore', type: 'uint256' },
        { name: 'nonce', type: 'bytes32' },
      ],
    },
    primaryType: type,
    message: { from, to, value: BigInt(value), validAfter: BigInt(validAfter), validBefore: BigInt(validBefore), nonce },
  };
}

// ── Broadcast (production path) ─────────────────────────────────────────────

// Module-local FIFO mutex, same shape as tx-manager's. Used only when
// tx-manager is not loadable (it process.exit()s without WALLET_PRIVATE_KEY);
// in that case there is no other broadcaster to race anyway.
let _localQueue = Promise.resolve();
function _localWithMutex(fn) {
  let release;
  const next = new Promise((resolve) => { release = resolve; });
  const prev = _localQueue;
  _localQueue = next;
  return prev.then(async () => {
    try {
      return await fn();
    } finally {
      release();
    }
  });
}

function _getWithMutex() {
  if (process.env.WALLET_PRIVATE_KEY) {
    try {
      const txm = require('./tx-manager.js');
      if (typeof txm.withMutex === 'function') return txm.withMutex;
    } catch { /* fall through to local queue */ }
  }
  return _localWithMutex;
}

let _clients = null;
function _getClients() {
  if (_clients) return _clients;
  const { createPublicClient, createWalletClient, http } = require('viem');
  const { privateKeyToAccount } = require('viem/accounts');
  const { base, baseSepolia } = require('viem/chains');
  const chainId = getChainId();
  const chain = chainId === 84532 ? baseSepolia : base;
  // AUDIT F5 (2026-07-04): the settler key MUST be a dedicated, isolated key —
  // NOT the shared custodial payout key (WALLET_PRIVATE_KEY, which signs every
  // sendUSDC and whose key class MEMORY 2026-07-01 records as leaked). Reusing
  // it would turn one compromised key into full settler-role compromise on the
  // unbound Transfer/Stranded paths (settler can name contributor=attacker,
  // bps=10000). Fail closed: require a dedicated key, never fall back.
  const key = process.env.X402_SETTLER_PRIVATE_KEY;
  if (!key) {
    throw new Error('x402-router: X402_SETTLER_PRIVATE_KEY is required (dedicated, isolated settler key). Refusing to fall back to the shared WALLET_PRIVATE_KEY — see audit F5 and contracts/README.md.');
  }
  const account = privateKeyToAccount(key);
  const transport = process.env.X402_ROUTER_RPC_URL ? http(process.env.X402_ROUTER_RPC_URL) : http();
  _clients = {
    account,
    publicClient: createPublicClient({ chain, transport }),
    walletClient: createWalletClient({ account, chain, transport }),
  };
  return _clients;
}

async function _waitForConfirmation(publicClient, hash) {
  const start = Date.now();
  while (Date.now() - start < CONFIRM_TIMEOUT_MS) {
    try {
      const receipt = await publicClient.getTransactionReceipt({ hash });
      if (receipt && receipt.status === 'success') return 'confirmed';
      if (receipt && receipt.status === 'reverted') return 'reverted';
    } catch { /* not mined yet — keep polling */ }
    await new Promise((r) => setTimeout(r, CONFIRM_POLL_MS));
  }
  return 'timeout';
}

async function _defaultSendRouterTx({ functionName, args }) {
  const withMutex = _getWithMutex();
  return withMutex(async () => {
    const { account, publicClient, walletClient } = _getClients();
    const nonce = await publicClient.getTransactionCount({ address: account.address });
    const txHash = await walletClient.writeContract({
      address: getRouterAddress(),
      abi: ROUTER_ABI,
      functionName,
      args,
      nonce,
    });
    const outcome = await _waitForConfirmation(publicClient, txHash);
    return { txHash, confirmed: outcome === 'confirmed', reverted: outcome === 'reverted' };
  });
}

// ── Settlement ──────────────────────────────────────────────────────────────
//
// Return shape mirrors lib/x402-facilitator.js verifyAndSettle so server.js
// maps outcomes identically:
//   { verifyValid, settled, settleFailed, txHash, reason }
// plus: path ('receive'|'transfer'), ofacUnavailable (→ caller returns 503),
// sanctioned (blocked pre-broadcast).
// Pre-broadcast rejections are verifyValid:false/settleFailed:false; there is
// deliberately NO fallback rail behind this function — in router mode a
// payment that cannot settle through the router is a failed payment.
async function settleWithRouter({ paymentPayload, expectedAmountMicro, resource, contributor, contributorBps, deps = {} }) {
  const fail = (reason, extra = {}) => ({ verifyValid: false, settled: false, settleFailed: false, txHash: null, reason, ...extra });

  if (!routerEnabled()) return fail('router_disabled');
  if (!ADDRESS_RE.test(contributor || '')) return fail('bad_contributor');
  const bps = Number(contributorBps);
  if (!Number.isInteger(bps) || bps < 1 || bps > 10000) return fail('bad_contributor_bps');

  const auth = paymentPayload && paymentPayload.payload && paymentPayload.payload.authorization;
  const signature = paymentPayload && paymentPayload.payload && paymentPayload.payload.signature;
  if (!auth || !signature || typeof signature !== 'string' || !signature.startsWith('0x')) return fail('malformed_payload');
  const { from, to, value, validAfter, validBefore, nonce } = auth;
  if (!ADDRESS_RE.test(from || '') || !ADDRESS_RE.test(to || '')) return fail('malformed_payload');
  if (to.toLowerCase() !== getRouterAddress().toLowerCase()) return fail('wrong_payto');
  // Scheme 'exact': the signed value must equal the advertised amount.
  if (String(value) !== String(expectedAmountMicro)) return fail('amount_mismatch');
  const nowSec = Math.floor(Date.now() / 1000);
  if (!/^\d+$/.test(String(validBefore)) || Number(validBefore) <= nowSec + 5) return fail('authorization_expired');
  if (!/^\d+$/.test(String(validAfter)) || Number(validAfter) > nowSec) return fail('authorization_not_yet_valid');

  // ── OFAC: fail closed BEFORE any broadcast, both parties, both paths. ──
  const { checkOFAC, ofacScreeningReady, logOFACBlock } = deps;
  if (typeof checkOFAC !== 'function' || typeof ofacScreeningReady !== 'function') {
    return fail('ofac_deps_missing', { ofacUnavailable: true });
  }
  if (!ofacScreeningReady()) return fail('ofac_unavailable', { ofacUnavailable: true });
  if (checkOFAC(from)) {
    if (typeof logOFACBlock === 'function') logOFACBlock(from, `${resource} (x402 router buyer)`);
    return fail('buyer_sanctioned', { sanctioned: true });
  }
  if (checkOFAC(contributor)) {
    if (typeof logOFACBlock === 'function') logOFACBlock(contributor, `${resource} (x402 router contributor)`);
    return fail('contributor_sanctioned', { sanctioned: true });
  }

  // ── Path selection: an echoed salt selects the nonce-bound Receive path. ──
  const echoedSalt =
    (paymentPayload.extra && paymentPayload.extra.salt) ||
    (paymentPayload.payload.extra && paymentPayload.payload.extra.salt) ||
    null;

  let call;
  if (echoedSalt) {
    if (!BYTES32_RE.test(String(echoedSalt))) return fail('malformed_salt');
    const hint = peekRouterHint(echoedSalt);
    if (!hint) return fail('unknown_or_expired_salt');
    if (hint.resource !== resource || hint.amountMicro !== String(expectedAmountMicro)) return fail('hint_mismatch');
    if (hint.contributor.toLowerCase() !== contributor.toLowerCase() || hint.contributorBps !== bps) {
      // The split we advertised at challenge time is server truth; a caller
      // computing a different split now indicates state drift — refuse rather
      // than burn gas on a guaranteed USDC signature failure.
      return fail('hint_split_mismatch');
    }
    const derived = deriveReceiveNonce(hint.contributor, hint.contributorBps, echoedSalt);
    if (String(nonce).toLowerCase() !== derived.toLowerCase()) return fail('nonce_not_derived');
    call = {
      functionName: 'settleAndSplitReceive',
      args: [from, BigInt(value), BigInt(validAfter), BigInt(validBefore), echoedSalt, signature, hint.contributor, BigInt(hint.contributorBps)],
      path: 'receive',
      salt: echoedSalt,
    };
  } else {
    if (!BYTES32_RE.test(String(nonce))) return fail('malformed_nonce');
    call = {
      functionName: 'settleAndSplitTransfer',
      args: [from, BigInt(value), BigInt(validAfter), BigInt(validBefore), nonce, signature, contributor, BigInt(bps)],
      path: 'transfer',
    };
  }

  const sendRouterTx = deps.sendRouterTx || _defaultSendRouterTx;
  try {
    const { txHash, confirmed, reverted } = await sendRouterTx(call);
    if (reverted) return { verifyValid: true, settled: false, settleFailed: true, txHash: txHash || null, reason: 'onchain_revert', path: call.path };
    if (!confirmed) {
      // Timeout: the tx MAY still land later. Fail closed (no content), same
      // posture as the current rail; the consumed EIP-3009 nonce prevents any
      // double-settle on retry.
      return { verifyValid: true, settled: false, settleFailed: true, txHash: txHash || null, reason: 'confirm_timeout', path: call.path };
    }
    return { verifyValid: true, settled: true, settleFailed: false, txHash, reason: 'settled', path: call.path };
  } catch (err) {
    return { verifyValid: true, settled: false, settleFailed: true, txHash: null, reason: 'broadcast_error:' + (err.shortMessage || err.message || 'unknown'), path: call.path };
  }
}

// Test hook: clear module state between test cases.
function _resetForTests() {
  _hints.clear();
  _hintsBySplit.clear();
  _clients = null;
}

module.exports = {
  routerEnabled,
  getRouterAddress,
  getChainId,
  getNetworkString,
  getUsdcAddress,
  deriveReceiveNonce,
  createRouterHint,
  peekRouterHint,
  consumeRouterHint,
  buildRouterExtra,
  buildAuthTypedData,
  settleWithRouter,
  ROUTER_ABI,
  _resetForTests,
};
