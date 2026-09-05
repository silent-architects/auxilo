// lib/eip712.js — EIP-712 Domain, Types, Nonce Store, Verification Helpers
// SPEC-A3: Auth Hardening (C7, H1, H2, H3, AUDIT-08)

const { verifyTypedData } = require('viem');
const crypto = require('crypto');

// --- EIP-712 Domain (AUDIT-08) ---
// verifyingContract = platform wallet address (no on-chain contract exists,
// wallet address serves as unique identifier for domain binding).
// 2026-07-12 LLC wallet rotation: rotated to the Auxilo, LLC wallet in the same
// deploy as the payTo change. Safe because the domain is SERVER-AUTHORITATIVE —
// clients fetch it from the wallet-verify challenge response and sign what is
// served; nothing client-side hardcodes it. The challenge nonce store is
// in-memory, so in-flight pre-rotation challenges die at the deploy restart
// regardless; already-verified wallets are never re-checked against the domain.
const EIP712_DOMAIN = {
  name: 'Auxilo',
  version: '1',
  chainId: 8453, // Base mainnet (EIP-155)
  verifyingContract: '0xA19Cf92cc1daCf742f0E50b4128cAD3A86A81EC4',
};

// --- EIP-712 Types ---
const CHALLENGE_TYPES = {
  Challenge: [
    { name: 'wallet', type: 'address' },
    { name: 'nonce', type: 'string' },
    { name: 'timestamp', type: 'uint256' },
    { name: 'action', type: 'string' },
  ],
};

const WITHDRAWAL_TYPES = {
  Withdrawal: [
    { name: 'wallet', type: 'address' },
    { name: 'amount', type: 'string' },
    { name: 'nonce', type: 'string' },
    { name: 'timestamp', type: 'uint256' },
  ],
};

// --- Nonce Store ---
// In-memory Map: wallet (lowercase) -> { nonce, timestamp, action, created_at }
// TTL: 5 minutes (300_000 ms)
const NONCE_TTL = 300_000;
const nonceStore = new Map();

// Cleanup expired nonces every 60 seconds.
// Reviewer debt (Wave 1, 2026-07-19): .unref() so this module-level timer never
// holds the event loop open — any process that merely requires this lib (tests,
// one-shot scripts) would otherwise hang at exit (`node --test` needed
// --test-force-exit purely because of this interval).
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of nonceStore) {
    if (now - entry.created_at > NONCE_TTL) {
      nonceStore.delete(key);
    }
  }
}, 60_000).unref();

/**
 * Generate and store a nonce for a wallet address.
 * Overwrites any existing nonce for the same wallet (only one active challenge per wallet).
 * @param {string} wallet - checksummed or lowercase wallet address
 * @param {string} action - 'challenge' or 'withdrawal'
 * @returns {{ nonce: string, timestamp: number, expires_at: number }}
 */
function createNonce(wallet, action = 'challenge') {
  const key = wallet.toLowerCase();
  const nonce = crypto.randomBytes(32).toString('hex');
  const timestamp = Math.floor(Date.now() / 1000); // unix seconds
  const entry = { nonce, timestamp, action, created_at: Date.now() };
  nonceStore.set(key, entry);
  return {
    nonce,
    timestamp,
    expires_at: Math.floor((entry.created_at + NONCE_TTL) / 1000),
  };
}

/**
 * Consume (delete) a nonce for a wallet address.
 * Returns the nonce data if valid, or null if expired/missing.
 * CRITICAL: Deletes BEFORE returning — nonce is single-use (C7 fix).
 * @param {string} wallet
 * @returns {{ nonce: string, timestamp: number, action: string } | null}
 */
function consumeNonce(wallet) {
  const key = wallet.toLowerCase();
  const entry = nonceStore.get(key);
  nonceStore.delete(key); // Delete FIRST — single-use enforcement
  if (!entry) return null;
  if (Date.now() - entry.created_at > NONCE_TTL) return null;
  return { nonce: entry.nonce, timestamp: entry.timestamp, action: entry.action };
}

/**
 * Verify an EIP-712 challenge signature.
 * @param {string} wallet - claimed signer address
 * @param {string} nonce - from the consumed nonce
 * @param {number} timestamp - from the consumed nonce
 * @param {string} signature - hex signature from the agent
 * @returns {Promise<boolean>}
 */
async function verifyChallengeSignature(wallet, nonce, timestamp, signature) {
  const valid = await verifyTypedData({
    address: wallet,
    domain: EIP712_DOMAIN,
    types: CHALLENGE_TYPES,
    primaryType: 'Challenge',
    message: {
      wallet: wallet,
      nonce,
      timestamp: BigInt(timestamp),
      action: 'authenticate',
    },
    signature,
  });
  return valid;
}

/**
 * Verify the fresh, single-use proof used only for account-data deletion.
 * A signature made for ordinary wallet authentication is not interchangeable
 * with this action because the action string is part of the signed data.
 */
async function verifyDeleteAccountSignature(wallet, nonce, timestamp, signature) {
  return verifyTypedData({
    address: wallet,
    domain: EIP712_DOMAIN,
    types: CHALLENGE_TYPES,
    primaryType: 'Challenge',
    message: {
      wallet,
      nonce,
      timestamp: BigInt(timestamp),
      action: 'delete-account',
    },
    signature,
  });
}

/**
 * AUD19 Gate-A HIGH-1: the EIP-712 action string for a wallet-LINK challenge,
 * bound to the linking account. Global `verifiedWallets` membership only proves
 * the wallet's key was controlled by SOMEONE at SOME time (every wallet-only
 * contributor's wallet is in the set by construction) — it proves nothing about
 * the account now trying to link it. Binding the accountId into the SIGNED
 * action string makes the signature itself attest "the holder of this wallet's
 * key authorizes linking to THIS account": a signature minted for one account
 * can never be replayed to link the wallet to another.
 *
 * @param {string} accountId
 * @returns {string}
 */
function linkAction(accountId) {
  return `link:${accountId}`;
}

/**
 * Verify an EIP-712 wallet-LINK challenge signature (HIGH-1).
 * Same Challenge struct as verifyChallengeSignature, but the action is
 * account-bound via linkAction(accountId), so control of the wallet key is
 * proven FRESH, for THIS account, at link time.
 *
 * @param {string} wallet - claimed signer address (the wallet being linked)
 * @param {string} accountId - the account requesting the link
 * @param {string} nonce - from the consumed nonce
 * @param {number} timestamp - from the consumed nonce
 * @param {string} signature - hex signature from the wallet's key
 * @returns {Promise<boolean>}
 */
async function verifyLinkSignature(wallet, accountId, nonce, timestamp, signature) {
  const valid = await verifyTypedData({
    address: wallet,
    domain: EIP712_DOMAIN,
    types: CHALLENGE_TYPES,
    primaryType: 'Challenge',
    message: {
      wallet: wallet,
      nonce,
      timestamp: BigInt(timestamp),
      action: linkAction(accountId),
    },
    signature,
  });
  return valid;
}

/**
 * Verify an EIP-712 withdrawal signature.
 * Used by the withdrawal handler.
 *
 * IMPL-05 CONSTRAINT: The `amount` parameter in the signed EIP-712 message
 * MUST match the server-side computed pending_balance. The withdrawal handler
 * (A1 scope) is responsible for rejecting requests where the signed amount
 * does not equal entry.pending_balance. Do NOT trust client-provided amounts
 * without server-side validation.
 *
 * @param {string} wallet - claimed signer address
 * @param {string} amount - withdrawal amount as string (e.g. "10.50")
 * @param {string} nonce - from the consumed nonce
 * @param {number} timestamp - from the consumed nonce
 * @param {string} signature - hex signature from the agent
 * @returns {Promise<boolean>}
 */
async function verifyWithdrawalSignature(wallet, amount, nonce, timestamp, signature) {
  const valid = await verifyTypedData({
    address: wallet,
    domain: EIP712_DOMAIN,
    types: WITHDRAWAL_TYPES,
    primaryType: 'Withdrawal',
    message: {
      wallet: wallet,
      amount,
      nonce,
      timestamp: BigInt(timestamp),
    },
    signature,
  });
  return valid;
}

module.exports = {
  EIP712_DOMAIN,
  CHALLENGE_TYPES,
  WITHDRAWAL_TYPES,
  createNonce,
  consumeNonce,
  verifyChallengeSignature,
  verifyDeleteAccountSignature,
  linkAction,
  verifyLinkSignature,
  verifyWithdrawalSignature,
};
