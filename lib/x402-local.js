// lib/x402-local.js
// Local fallback for x402 payment verification when facilitator is unreachable.
// AUDIT-12: LRU cache (5min TTL, 1000 entries) + RPC rate limiter (10/sec, burst 15) prevent
// secondary outage from Base node overload.
//
// Findings addressed: C5 (no local x402 fallback), AUDIT-12 (LRU cache + RPC rate limiting)

'use strict';

const { createHash } = require('node:crypto');
const { getPublicClient } = require('./tx-manager.js');

// --- LRU Cache ---
// Key: SHA-256 hash of payment proof. Value: { valid, timestamp }.
const CACHE_MAX = 1000;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const paymentCache = new Map();

function getCacheKey(paymentHeader) {
    return createHash('sha256').update(paymentHeader).digest('hex');
}

function getCached(key) {
    const entry = paymentCache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
        paymentCache.delete(key);
        return null;
    }
    // Move to end (LRU refresh)
    paymentCache.delete(key);
    paymentCache.set(key, entry);
    return entry;
}

function setCache(key, valid) {
    // Evict oldest entry if at capacity
    if (paymentCache.size >= CACHE_MAX) {
        const oldest = paymentCache.keys().next().value;
        paymentCache.delete(oldest);
    }
    paymentCache.set(key, { valid, timestamp: Date.now() });
}

// --- RPC Rate Limiter (Token Bucket) ---
// Caps RPC calls to Base node at 10/sec with burst capacity of 15.
const RATE_LIMIT_PER_SEC = 10;
const BURST_MAX = 15;
let tokens = BURST_MAX;
let lastRefill = Date.now();

function tryAcquireRpcToken() {
    const now = Date.now();
    const elapsed = (now - lastRefill) / 1000;
    tokens = Math.min(BURST_MAX, tokens + elapsed * RATE_LIMIT_PER_SEC);
    lastRefill = now;

    if (tokens < 1) return false;
    tokens -= 1;
    return true;
}

// --- USDC Transfer Verification ---
// Transfer event topic0: keccak256("Transfer(address,address,uint256)")
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

/**
 * Verify an x402 payment proof locally by checking on-chain state.
 * Called only when the primary facilitator (facilitator.openx402.ai) is unreachable.
 *
 * @param {string} paymentHeader - Raw X-Payment header value (base64-encoded JSON)
 * @param {number} expectedAmountUSD - Expected payment amount in USD
 * @param {string} recipientAddress - Platform wallet address (WALLET_ADDRESS from A0)
 * @param {string} usdcAddress - USDC contract address on Base (USDC_BASE from A0)
 * @returns {Promise<{ valid: boolean, error?: string, cached?: boolean }>}
 */
async function verifyPaymentLocally(paymentHeader, expectedAmountUSD, recipientAddress, usdcAddress) {
    // 1. Check cache first — avoids RPC call for already-confirmed proofs
    const cacheKey = getCacheKey(paymentHeader);
    const cached = getCached(cacheKey);
    if (cached) {
        return { valid: cached.valid, cached: true };
    }

    // 2. Rate limit check — reject if RPC budget exhausted
    if (!tryAcquireRpcToken()) {
        return { valid: false, error: 'RPC rate limit exceeded. Retry in 5s.' };
    }

    try {
        // 3. Parse x402 payment proof
        // The X-Payment header is base64-encoded JSON per the x402 protocol.
        // Structure: { x402Version, scheme, network, payload: { ... } }
        let proof;
        try {
            proof = JSON.parse(Buffer.from(paymentHeader, 'base64').toString('utf8'));
        } catch {
            setCache(cacheKey, false);
            return { valid: false, error: 'Invalid payment proof encoding' };
        }

        // 4. Extract transaction hash from proof payload
        // Common locations per x402-hono: payload.txHash, payload.transaction
        // Builder note: verify against actual x402-hono package source if needed.
        const txHash = proof?.payload?.txHash || proof?.payload?.transaction;
        if (!txHash || typeof txHash !== 'string' || !txHash.startsWith('0x')) {
            setCache(cacheKey, false);
            return { valid: false, error: 'No transaction hash in payment proof' };
        }

        // 5. Verify on-chain via publicClient (A0) — second rate-limit check for two-stage ops
        if (!tryAcquireRpcToken()) {
            return { valid: false, error: 'RPC rate limit exceeded. Retry in 5s.' };
        }

        const publicClient = getPublicClient();
        const receipt = await publicClient.getTransactionReceipt({ hash: txHash });

        if (!receipt || receipt.status !== 'success') {
            setCache(cacheKey, false);
            return { valid: false, error: 'Transaction not confirmed or failed' };
        }

        // 6. Verify USDC transfer in logs
        // Look for Transfer(from, to, value) where to = recipientAddress
        const transferLog = receipt.logs.find(log => {
            if (log.address.toLowerCase() !== usdcAddress.toLowerCase()) return false;
            if (log.topics[0] !== TRANSFER_TOPIC) return false;
            // topics[2] = to address (padded to 32 bytes) — slice leading zeros
            const toAddr = '0x' + log.topics[2].slice(26).toLowerCase();
            return toAddr === recipientAddress.toLowerCase();
        });

        if (!transferLog) {
            setCache(cacheKey, false);
            return { valid: false, error: 'No USDC transfer to platform wallet in transaction' };
        }

        // 7. Verify amount (USDC has 6 decimals)
        const transferredAmount = Number(BigInt(transferLog.data)) / 1e6;
        if (transferredAmount < expectedAmountUSD) {
            setCache(cacheKey, false);
            return { valid: false, error: `Insufficient payment: ${transferredAmount} < ${expectedAmountUSD}` };
        }

        // 8. Valid — cache and return
        setCache(cacheKey, true);
        return { valid: true };

    } catch (err) {
        // RPC error or unexpected failure — intentionally NOT cached (may be transient)
        return { valid: false, error: `Local verification failed: ${err.message}` };
    }
}

/**
 * Get cache stats for health/debug endpoints.
 */
function getCacheStats() {
    return {
        size: paymentCache.size,
        maxSize: CACHE_MAX,
        ttlMs: CACHE_TTL_MS,
        rpcTokensAvailable: Math.floor(tokens),
    };
}

/**
 * Clear the payment proof cache. For testing/admin use.
 */
function clearCache() {
    paymentCache.clear();
}

module.exports = { verifyPaymentLocally, getCacheStats, clearCache };
