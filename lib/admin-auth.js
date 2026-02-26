// lib/admin-auth.js
// Admin endpoint authentication hardening.
// H4: Token expiry. H5: Token scoping. Plus timing-safe comparison.
//
// Environment variables:
//   AUXILO_ADMIN_TOKEN          = full admin scope (required, existing)
//   AUXILO_ADMIN_READ_TOKEN     = read-only scope (optional, new)
//   AUXILO_ADMIN_TOKEN_EXPIRES_AT = ISO 8601 expiry timestamp (optional, new)

'use strict';

const { timingSafeEqual, createHash } = require('node:crypto');

/**
 * Verify an admin token with timing-safe comparison, expiry, and scope checks.
 *
 * @param {string} providedToken - Token from Authorization: Bearer header
 * @param {'read'|'admin'} requiredScope - Minimum scope needed for this endpoint
 * @returns {{ valid: boolean, scope?: string, error?: string }}
 */
function verifyAdminToken(providedToken, requiredScope = 'read') {
    if (!providedToken || typeof providedToken !== 'string') {
        return { valid: false, error: 'Missing token' };
    }

    // 1. Check expiry — applies to ALL admin tokens
    const expiresAt = process.env.AUXILO_ADMIN_TOKEN_EXPIRES_AT;
    if (expiresAt) {
        const expiryDate = new Date(expiresAt);
        if (isNaN(expiryDate.getTime())) {
            console.error('[admin-auth] Invalid AUXILO_ADMIN_TOKEN_EXPIRES_AT format — expected ISO 8601');
            return { valid: false, error: 'Server configuration error' };
        }
        if (Date.now() > expiryDate.getTime()) {
            return { valid: false, error: 'Admin token expired. Rotate and redeploy.' };
        }
    }

    // 2. Timing-safe comparison against admin token (full scope)
    const adminToken = process.env.AUXILO_ADMIN_TOKEN;
    if (adminToken && safeCompare(providedToken, adminToken)) {
        return { valid: true, scope: 'admin' };
    }

    // 3. Timing-safe comparison against read token (read-only scope)
    const readToken = process.env.AUXILO_ADMIN_READ_TOKEN;
    if (readToken && safeCompare(providedToken, readToken)) {
        if (requiredScope === 'admin') {
            return { valid: false, error: 'Insufficient scope' };
        }
        return { valid: true, scope: 'read' };
    }

    // 4. No match
    return { valid: false, error: 'Invalid token' };
}

/**
 * Timing-safe string comparison.
 * crypto.timingSafeEqual requires equal-length buffers.
 * Both inputs are SHA-256 hashed first to normalize length and prevent
 * information leakage on mismatched-length tokens.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function safeCompare(a, b) {
    const hashA = createHash('sha256').update(a).digest();
    const hashB = createHash('sha256').update(b).digest();
    return timingSafeEqual(hashA, hashB);
}

module.exports = { verifyAdminToken };
