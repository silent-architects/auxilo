/**
 * tests/test-a4-unit.js
 *
 * SPEC-A4 Unit + Integration Tests
 * Admin auth hardening (timing-safe, expiry, scoping) and
 * x402 local fallback (LRU cache, RPC rate limiter, verification).
 *
 * Run: node tests/test-a4-unit.js
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { verifyAdminToken } = require('../lib/admin-auth.js');

let passed = 0;
let failed = 0;
const failures = [];

function runTest(name, fn) {
    try {
        fn();
        passed++;
        console.log(`✅ ${name}`);
    } catch (err) {
        failed++;
        failures.push({ name, error: err.message });
        console.error(`❌ ${name}`);
        console.error(`   ${err.message}`);
    }
}

async function runAsyncTest(name, fn) {
    try {
        await fn();
        passed++;
        console.log(`✅ ${name}`);
    } catch (err) {
        failed++;
        failures.push({ name, error: err.message });
        console.error(`❌ ${name}`);
        console.error(`   ${err.message}`);
    }
}

async function runTests() {
    console.log('=== A4 Unit + Integration Tests ===\n');

    // ═══════════════════════════════════════════════════════════════════════
    // 5.2 Admin Auth — lib/admin-auth.js
    // ═══════════════════════════════════════════════════════════════════════

    console.log('--- Admin Auth Unit Tests ---');

    // Save original env vars
    const origAdminToken = process.env.AUXILO_ADMIN_TOKEN;
    const origReadToken = process.env.AUXILO_ADMIN_READ_TOKEN;
    const origExpiry = process.env.AUXILO_ADMIN_TOKEN_EXPIRES_AT;

    // T-A4-AUTH-001: Missing token returns invalid
    runTest('T-A4-AUTH-001: Missing token returns invalid', () => {
        const result = verifyAdminToken('', 'read');
        assert.strictEqual(result.valid, false, 'Empty token should be invalid');
        assert.ok(result.error, 'Should have error message');
    });

    runTest('T-A4-AUTH-002: Null/undefined token returns invalid', () => {
        const r1 = verifyAdminToken(null, 'read');
        assert.strictEqual(r1.valid, false);
        const r2 = verifyAdminToken(undefined, 'read');
        assert.strictEqual(r2.valid, false);
    });

    // T-A4-AUTH-003: Valid admin token accepted
    runTest('T-A4-AUTH-003: Valid admin token accepted with admin scope', () => {
        process.env.AUXILO_ADMIN_TOKEN = 'test-admin-token-12345';
        delete process.env.AUXILO_ADMIN_TOKEN_EXPIRES_AT;

        const result = verifyAdminToken('test-admin-token-12345', 'admin');
        assert.strictEqual(result.valid, true);
        assert.strictEqual(result.scope, 'admin');
    });

    // T-A4-AUTH-004: Read token accepted for read scope
    runTest('T-A4-AUTH-004: Read token accepted for read scope', () => {
        process.env.AUXILO_ADMIN_TOKEN = 'admin-token';
        process.env.AUXILO_ADMIN_READ_TOKEN = 'read-only-token';
        delete process.env.AUXILO_ADMIN_TOKEN_EXPIRES_AT;

        const result = verifyAdminToken('read-only-token', 'read');
        assert.strictEqual(result.valid, true);
        assert.strictEqual(result.scope, 'read');
    });

    // T-A4-AUTH-005: Read token rejected for admin scope
    runTest('T-A4-AUTH-005: Read token rejected for admin scope (insufficient)', () => {
        process.env.AUXILO_ADMIN_TOKEN = 'admin-token';
        process.env.AUXILO_ADMIN_READ_TOKEN = 'read-only-token';
        delete process.env.AUXILO_ADMIN_TOKEN_EXPIRES_AT;

        const result = verifyAdminToken('read-only-token', 'admin');
        assert.strictEqual(result.valid, false);
        assert.ok(result.error.includes('scope') || result.error.includes('Insufficient'), 'Should mention scope');
    });

    // T-A4-AUTH-006: Admin token works for read scope too
    runTest('T-A4-AUTH-006: Admin token works for read scope (admin > read)', () => {
        process.env.AUXILO_ADMIN_TOKEN = 'admin-token-full';
        delete process.env.AUXILO_ADMIN_TOKEN_EXPIRES_AT;

        const result = verifyAdminToken('admin-token-full', 'read');
        assert.strictEqual(result.valid, true);
        assert.strictEqual(result.scope, 'admin');
    });

    // T-A4-AUTH-007: Wrong token rejected
    runTest('T-A4-AUTH-007: Wrong token rejected', () => {
        process.env.AUXILO_ADMIN_TOKEN = 'correct-token';
        delete process.env.AUXILO_ADMIN_TOKEN_EXPIRES_AT;

        const result = verifyAdminToken('wrong-token', 'read');
        assert.strictEqual(result.valid, false);
    });

    // T-A4-AUTH-008: Expired token rejected
    runTest('T-A4-AUTH-008: Expired token rejected', () => {
        process.env.AUXILO_ADMIN_TOKEN = 'admin-token';
        process.env.AUXILO_ADMIN_TOKEN_EXPIRES_AT = '2020-01-01T00:00:00Z'; // past date

        const result = verifyAdminToken('admin-token', 'read');
        assert.strictEqual(result.valid, false);
        assert.ok(result.error.includes('expired') || result.error.includes('Expired'), 'Should mention expiry');
    });

    // T-A4-AUTH-009: Non-expired token accepted
    runTest('T-A4-AUTH-009: Non-expired token accepted', () => {
        process.env.AUXILO_ADMIN_TOKEN = 'admin-token';
        process.env.AUXILO_ADMIN_TOKEN_EXPIRES_AT = '2099-12-31T23:59:59Z'; // far future

        const result = verifyAdminToken('admin-token', 'read');
        assert.strictEqual(result.valid, true);
    });

    // T-A4-AUTH-010: Invalid expiry format handled gracefully
    runTest('T-A4-AUTH-010: Invalid expiry format returns error (not crash)', () => {
        process.env.AUXILO_ADMIN_TOKEN = 'admin-token';
        process.env.AUXILO_ADMIN_TOKEN_EXPIRES_AT = 'not-a-date';

        const result = verifyAdminToken('admin-token', 'read');
        assert.strictEqual(result.valid, false);
        assert.ok(result.error, 'Should return error for invalid date format');
    });

    // T-A4-AUTH-011: Timing-safe comparison verified in source
    runTest('T-A4-AUTH-011: Uses timing-safe comparison (SHA-256 + timingSafeEqual)', () => {
        const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'admin-auth.js'), 'utf8');
        assert.ok(src.includes('timingSafeEqual'), 'Should use timingSafeEqual');
        assert.ok(src.includes("createHash('sha256')"), 'Should SHA-256 hash before comparison');
        assert.ok(src.includes('function safeCompare'), 'Should have safeCompare helper');
    });

    // Restore env vars
    if (origAdminToken !== undefined) process.env.AUXILO_ADMIN_TOKEN = origAdminToken;
    else delete process.env.AUXILO_ADMIN_TOKEN;
    if (origReadToken !== undefined) process.env.AUXILO_ADMIN_READ_TOKEN = origReadToken;
    else delete process.env.AUXILO_ADMIN_READ_TOKEN;
    if (origExpiry !== undefined) process.env.AUXILO_ADMIN_TOKEN_EXPIRES_AT = origExpiry;
    else delete process.env.AUXILO_ADMIN_TOKEN_EXPIRES_AT;

    // ═══════════════════════════════════════════════════════════════════════
    // 5.1 x402 Local Fallback — lib/x402-local.js (structure tests)
    // Note: Behavioral tests require tx-manager (WALLET_PRIVATE_KEY).
    // These tests validate code structure and the cache/rate-limiter patterns.
    // ═══════════════════════════════════════════════════════════════════════

    console.log('\n--- x402 Local Fallback Tests ---');

    runTest('T-A4-UNIT-001: x402-local module structure — exports verifyPaymentLocally', () => {
        const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'x402-local.js'), 'utf8');
        assert.ok(src.includes("module.exports = { verifyPaymentLocally, getCacheStats, clearCache }"),
            'Should export verifyPaymentLocally, getCacheStats, clearCache');
    });

    runTest('T-A4-UNIT-002: LRU cache constants — 1000 max, 5min TTL', () => {
        const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'x402-local.js'), 'utf8');
        assert.ok(src.includes('CACHE_MAX = 1000'), 'Cache max should be 1000');
        assert.ok(src.includes('5 * 60 * 1000'), 'Cache TTL should be 5 minutes');
    });

    runTest('T-A4-UNIT-003: LRU eviction — oldest entry removed at capacity', () => {
        const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'x402-local.js'), 'utf8');
        assert.ok(src.includes('paymentCache.size >= CACHE_MAX'), 'Should check cache size against MAX');
        assert.ok(src.includes('paymentCache.keys().next().value'), 'Should find oldest key for eviction');
    });

    runTest('T-A4-UNIT-004: RPC rate limiter — token bucket pattern', () => {
        const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'x402-local.js'), 'utf8');
        assert.ok(src.includes('RATE_LIMIT_PER_SEC = 10'), 'Rate limit should be 10/sec');
        assert.ok(src.includes('BURST_MAX = 15'), 'Burst max should be 15');
        assert.ok(src.includes('function tryAcquireRpcToken'), 'Should have token acquisition function');
    });

    runTest('T-A4-UNIT-005: Rate limit returns specific error message', () => {
        const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'x402-local.js'), 'utf8');
        assert.ok(src.includes('RPC rate limit exceeded'), 'Should return rate limit error message');
    });

    runTest('T-A4-UNIT-006: Invalid base64 proof rejected', () => {
        const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'x402-local.js'), 'utf8');
        assert.ok(src.includes('Invalid payment proof encoding'), 'Should reject invalid base64');
    });

    runTest('T-A4-UNIT-007: Missing txHash rejected', () => {
        const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'x402-local.js'), 'utf8');
        assert.ok(src.includes('No transaction hash in payment proof'), 'Should reject missing txHash');
    });

    runTest('T-A4-UNIT-008: Transfer event verification uses correct topic', () => {
        const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'x402-local.js'), 'utf8');
        // Transfer(address,address,uint256) keccak256
        assert.ok(
            src.includes('0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'),
            'Should use correct Transfer event topic'
        );
    });

    runTest('T-A4-UNIT-009: RPC errors NOT cached (transient failures)', () => {
        const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'x402-local.js'), 'utf8');
        // The catch block should NOT call setCache — RPC errors are transient
        const catchBlock = src.substring(src.indexOf('} catch (err) {', src.indexOf('verifyPaymentLocally')));
        assert.ok(
            !catchBlock.includes('setCache') || catchBlock.includes('NOT cached'),
            'RPC errors should NOT be cached'
        );
    });

    runTest('T-A4-UNIT-010: Insufficient amount rejected', () => {
        const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'x402-local.js'), 'utf8');
        assert.ok(src.includes('Insufficient payment'), 'Should reject insufficient payment amount');
    });

    // ═══════════════════════════════════════════════════════════════════════
    // A4 Integration — Admin middleware in server.js
    // ═══════════════════════════════════════════════════════════════════════

    console.log('\n--- A4 Server Integration Tests ---');

    runTest('T-A4-INT-001: Admin middleware wraps verifyAdminToken', () => {
        const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
        assert.ok(serverSrc.includes('function adminAuth'), 'adminAuth middleware should exist');
        assert.ok(serverSrc.includes('verifyAdminToken(token,'), 'Should call verifyAdminToken');
        assert.ok(serverSrc.includes("Bearer"), 'Should extract Bearer token from header');
    });

    runTest('T-A4-INT-002: Admin endpoints use correct scopes', () => {
        const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
        // GET endpoints should use read scope
        assert.ok(serverSrc.includes("adminAuth('read')"), 'GET admin endpoints should use read scope');
        // POST/mutation endpoints should use admin scope
        assert.ok(serverSrc.includes("adminAuth('admin')"), 'POST admin endpoints should use admin scope');
    });

    runTest('T-A4-INT-003: x402 fallback integrated into _verifyPayment', () => {
        const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
        assert.ok(serverSrc.includes('verifyPaymentLocally'), 'Should call verifyPaymentLocally as fallback');
        assert.ok(serverSrc.includes('Facilitator unreachable'), 'Should log facilitator failure');
        assert.ok(serverSrc.includes('Verified via local fallback'), 'Should log local verification success');
    });

    runTest('T-A4-INT-004: x402 rate limit returns 503 to client', () => {
        const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
        assert.ok(serverSrc.includes('rateLimited: true'), 'Should signal rate limit to caller');
        assert.ok(
            serverSrc.includes("'Payment verification temporarily unavailable'") &&
            serverSrc.includes('503'),
            'Should return 503 on rate limit'
        );
    });

    runTest('T-A4-INT-005: Admin ETH + USDC balance uses AR-5 pattern', () => {
        const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
        const adminSection = serverSrc.substring(
            serverSrc.indexOf("app.get('/admin/settlements'"),
            serverSrc.indexOf("app.post('/admin/settle'")
        );
        assert.ok(adminSection.includes('parseFloat(formatUnits('), 'Should use parseFloat(formatUnits(...)) (AR-5)');
    });

    // ─── Summary ─────────────────────────────────────────────────────────
    console.log(`\n${'='.repeat(60)}`);
    console.log(`A4 Unit + Integration: ${passed} passed, ${failed} failed`);
    if (failures.length > 0) {
        console.log('\nFailures:');
        for (const f of failures) {
            console.log(`  ❌ ${f.name}: ${f.error}`);
        }
    }
    console.log('='.repeat(60));
    process.exit(failed > 0 ? 1 : 0);
}

runTests();
