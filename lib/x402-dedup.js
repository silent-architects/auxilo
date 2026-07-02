// lib/x402-dedup.js
// M-4: Stable, always-present deduplication key for an x402 payment proof.
//
// The legacy server-side dedup keyed only on `proof.payload.txHash`, which does
// NOT exist on the advertised `exact`/`eip3009` scheme — the client signs a
// transferWithAuthorization and the facilitator submits the tx, so there is no
// client txHash. That made replay-dedup a no-op for real protocol payments, and
// "no txHash" was treated as "allow". This helper always returns a key, binding
// the EIP-3009 authorization nonce (with from + validBefore) when present and
// otherwise hashing the full payment header.

'use strict';

const { createHash } = require('node:crypto');

/**
 * Derive a stable, always-present deduplication key for an x402 payment proof.
 * Never returns null — falls back to hashing the full payment header so a proof
 * can always be deduped (and a re-sent identical proof yields the same key).
 *
 * Priority:
 *   1. explicit txHash (legacy / settled-tx paths),
 *   2. EIP-3009 authorization nonce bound to from + validBefore,
 *   3. SHA-256 of the full base64 X-Payment header (always available).
 *
 * @param {string} paymentHeader - Raw base64 X-Payment header value.
 * @returns {string} A lowercase dedup key.
 */
function computePaymentDedupKey(paymentHeader) {
    const headerHash = 'x402hdr:' + createHash('sha256').update(paymentHeader || '').digest('hex');

    let proof;
    try {
        proof = JSON.parse(Buffer.from(paymentHeader, 'base64').toString('utf8'));
    } catch {
        return headerHash;
    }

    const payload = (proof && proof.payload) || {};

    // 1. Explicit tx hash (legacy / settled-tx paths).
    const txHash = payload.txHash || payload.transaction;
    if (txHash && typeof txHash === 'string') {
        return txHash.toLowerCase().trim();
    }

    // 2. EIP-3009 authorization: nonce bound to from + validBefore.
    const auth = payload.authorization || payload.authValues || {};
    const nonce = auth.nonce;
    if (nonce && typeof nonce === 'string') {
        const from = (auth.from || '').toString().toLowerCase();
        const validBefore = (auth.validBefore != null ? auth.validBefore : '').toString();
        return `eip3009:${nonce.toLowerCase()}:${from}:${validBefore}`;
    }

    // 3. Fallback: full-header hash (always present).
    return headerHash;
}

module.exports = { computePaymentDedupKey };
