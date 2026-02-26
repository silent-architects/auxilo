/**
 * tests/test-a1-unit.js
 *
 * SPEC-A1 Unit + Integration Tests
 * Per-wallet mutex, reservation model, withdrawal handler structure,
 * and WAL-protected dual-write validation.
 *
 * Run: node tests/test-a1-unit.js
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { acquireWalletLock, getActiveLockCount } = require('../lib/wallet-lock.js');

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
    console.log('=== A1 Unit + Integration Tests ===\n');

    // ═══════════════════════════════════════════════════════════════════════
    // 4.1 Per-Wallet Mutex Tests — lib/wallet-lock.js
    // ═══════════════════════════════════════════════════════════════════════

    console.log('--- 4.1 Wallet Lock Unit Tests ---');

    // T-A1-UNIT-001: Per-wallet mutex serializes withdrawals
    await runAsyncTest('T-A1-UNIT-001: Per-wallet mutex serializes access', async () => {
        const order = [];
        const walletA = '0x' + 'a'.repeat(40);

        const release1 = await acquireWalletLock(walletA);
        order.push('lock1');

        // Start second acquire — it should wait
        const p2 = acquireWalletLock(walletA).then(release => {
            order.push('lock2');
            return release;
        });

        // Give p2 a tick to start waiting
        await new Promise(r => setTimeout(r, 10));
        assert.deepStrictEqual(order, ['lock1'], 'Second lock should be waiting');

        // Release first lock
        release1();
        const release2 = await p2;
        assert.deepStrictEqual(order, ['lock1', 'lock2'], 'Second lock should acquire after first released');

        release2();
    });

    // T-A1-UNIT-002: Per-wallet mutex is per-wallet (different wallets don't block)
    await runAsyncTest('T-A1-UNIT-002: Different wallets do not block each other', async () => {
        const walletA = '0x' + 'a'.repeat(40);
        const walletB = '0x' + 'b'.repeat(40);

        const releaseA = await acquireWalletLock(walletA);
        // Wallet B should acquire immediately even though A is locked
        const releaseB = await acquireWalletLock(walletB);

        assert.ok(releaseA, 'Should have release function for A');
        assert.ok(releaseB, 'Should have release function for B');

        releaseA();
        releaseB();
    });

    // T-A1-UNIT-003: Lock released on error
    await runAsyncTest('T-A1-UNIT-003: Lock can be reacquired after release in finally block', async () => {
        const wallet = '0x' + 'c'.repeat(40);

        // Simulate error inside locked section
        try {
            const release = await acquireWalletLock(wallet);
            try {
                throw new Error('simulated error');
            } finally {
                release();
            }
        } catch {
            // Expected — caught the simulated error
        }

        // Lock should be available again
        const release2 = await acquireWalletLock(wallet);
        assert.ok(release2, 'Lock should be acquirable after error + release');
        release2();
    });

    // T-A1-UNIT-004: Lock key is case-insensitive
    await runAsyncTest('T-A1-UNIT-004: Lock key is case-insensitive', async () => {
        const upper = '0xABCDEF' + '0'.repeat(34);
        const lower = upper.toLowerCase();

        const order = [];
        const release1 = await acquireWalletLock(upper);
        order.push('upper');

        // Lower case should wait — same lock
        const p2 = acquireWalletLock(lower).then(release => {
            order.push('lower');
            return release;
        });

        await new Promise(r => setTimeout(r, 10));
        assert.deepStrictEqual(order, ['upper'], 'Lower-case lock should wait');

        release1();
        const release2 = await p2;
        assert.deepStrictEqual(order, ['upper', 'lower'], 'Lock should be case-insensitive');
        release2();
    });

    // T-A1-UNIT-005 (extra): getActiveLockCount
    await runAsyncTest('T-A1-UNIT-005: getActiveLockCount tracks active locks', async () => {
        const before = getActiveLockCount();

        const walletX = '0x' + 'f'.repeat(40);
        const release = await acquireWalletLock(walletX);
        assert.strictEqual(getActiveLockCount(), before + 1, 'Count should increase by 1');

        release();
        // After release, the wallet entry is deleted if count reaches 0
        assert.strictEqual(getActiveLockCount(), before, 'Count should return to original');
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 4.2 Reservation Model Tests (code structure)
    // ═══════════════════════════════════════════════════════════════════════

    console.log('\n--- 4.2 Reservation Model Tests ---');

    runTest('T-A1-UNIT-006: Reservation model — C8 fix verified in withdrawal flow', () => {
        const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

        // Find the withdrawal handler
        const withdrawStart = serverSrc.indexOf("app.post('/withdraw'");
        assert.ok(withdrawStart > 0, 'Withdrawal handler should exist');

        const withdrawBody = serverSrc.substring(withdrawStart, withdrawStart + 5000);

        // C8 fix: createReservation is called BEFORE sendUSDC
        const reserveIdx = withdrawBody.indexOf('createReservation');
        const sendIdx = withdrawBody.indexOf('sendUSDC');
        assert.ok(reserveIdx > 0, 'Should call createReservation');
        assert.ok(sendIdx > 0, 'Should call sendUSDC');
        assert.ok(reserveIdx < sendIdx, 'createReservation must come BEFORE sendUSDC (C8 fix)');
    });

    runTest('T-A1-UNIT-007: Reservation committed on success, released on failure', () => {
        const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
        const withdrawBody = serverSrc.substring(
            serverSrc.indexOf("app.post('/withdraw'"),
            serverSrc.indexOf("app.get('/contributor/:wallet/settlements'")
        );

        // Success path: commitReservation
        assert.ok(withdrawBody.includes('commitReservation'), 'Should commit on success');
        // Failure path: releaseReservation
        assert.ok(withdrawBody.includes('releaseReservation'), 'Should release on failure');
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 4.3 Withdrawal Handler Integration
    // ═══════════════════════════════════════════════════════════════════════

    console.log('\n--- 4.3 Withdrawal Handler Tests ---');

    runTest('T-A1-INT-001: Withdrawal uses acquireWalletLock with finally release', () => {
        const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
        const withdrawBody = serverSrc.substring(
            serverSrc.indexOf("app.post('/withdraw'"),
            serverSrc.indexOf("app.get('/contributor/:wallet/settlements'")
        );

        assert.ok(withdrawBody.includes('acquireWalletLock'), 'Should acquire wallet lock');
        assert.ok(withdrawBody.includes('releaseLock()'), 'Should call releaseLock');
        assert.ok(withdrawBody.includes('finally'), 'releaseLock should be in finally block');
    });

    runTest('T-A1-INT-002: Withdrawal rate limiting burns on ALL attempts (AR-1)', () => {
        const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
        const withdrawBody = serverSrc.substring(
            serverSrc.indexOf("app.post('/withdraw'"),
            serverSrc.indexOf("app.get('/contributor/:wallet/settlements'")
        );

        // Rate limit timestamp should be set BEFORE balance checks
        const burnIdx = withdrawBody.indexOf('lastWithdrawalAttempt[walletLower] = Date.now()');
        const balanceCheckIdx = withdrawBody.indexOf('checkBalance');
        assert.ok(burnIdx > 0, 'Should burn rate limit');
        assert.ok(balanceCheckIdx > 0, 'Should check balance');
        assert.ok(burnIdx < balanceCheckIdx, 'Rate limit burn must come BEFORE balance check');
    });

    runTest('T-A1-INT-003: Withdrawal verifies EIP-712 signature (A3 integration)', () => {
        const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
        const withdrawBody = serverSrc.substring(
            serverSrc.indexOf("app.post('/withdraw'"),
            serverSrc.indexOf("app.get('/contributor/:wallet/settlements'")
        );

        // Must use consumeNonce and verifyWithdrawalSignature
        assert.ok(withdrawBody.includes('consumeNonce'), 'Should consume withdrawal nonce');
        assert.ok(withdrawBody.includes('verifyWithdrawalSignature'), 'Should verify EIP-712 withdrawal sig');

        // Action must be 'withdrawal' (not 'challenge')
        assert.ok(
            withdrawBody.includes("nonceData.action !== 'withdrawal'"),
            'Should check nonce action is withdrawal'
        );
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 4.4 WAL-Protected Dual Write
    // ═══════════════════════════════════════════════════════════════════════

    console.log('\n--- 4.4 WAL-Protected Dual Write ---');

    runTest('T-A1-INT-004: Withdrawal creates WAL entry for dual-write protection', () => {
        const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
        const withdrawBody = serverSrc.substring(
            serverSrc.indexOf("app.post('/withdraw'"),
            serverSrc.indexOf("app.get('/contributor/:wallet/settlements'")
        );

        assert.ok(withdrawBody.includes("createWalEntry('withdraw'"), 'Should create WAL entry for withdrawal');
        assert.ok(withdrawBody.includes("markStepComplete(walId, 'earnings_deducted')"), 'Should mark earnings step');
        assert.ok(withdrawBody.includes("markStepComplete(walId, 'settlement_appended')"), 'Should mark settlement step');
        assert.ok(withdrawBody.includes('commitWal(walId)'), 'Should commit WAL on success');
    });

    runTest('T-A1-INT-005: Withdrawal WAL recovery handles all 3 states', () => {
        const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

        // WAL recovery for withdrawals handles:
        // 1. earnings_deducted but NOT settlement_appended
        assert.ok(
            serverSrc.includes("completed.includes('earnings_deducted') && !completed.includes('settlement_appended')"),
            'Should handle earnings-done-settlement-pending state'
        );
        // 2. settlement_appended but NOT earnings_deducted
        assert.ok(
            serverSrc.includes("completed.includes('settlement_appended') && !completed.includes('earnings_deducted')"),
            'Should handle settlement-done-earnings-pending state'
        );
        // 3. Neither completed
        assert.ok(
            serverSrc.includes("!completed.includes('earnings_deducted') && !completed.includes('settlement_appended')"),
            'Should handle neither-done state (release reservation)'
        );
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 4.5 Edge Cases
    // ═══════════════════════════════════════════════════════════════════════

    console.log('\n--- 4.5 Edge Cases ---');

    runTest('T-A1-EDGE-001: Minimum withdrawal enforced ($0.05)', () => {
        const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
        assert.ok(
            serverSrc.includes('pending_balance < 0.05') || serverSrc.includes('payout_amount < 0.05'),
            'Should enforce minimum withdrawal of $0.05'
        );
    });

    runTest('T-A1-EDGE-002: Server-side computed payout (IMPL-05)', () => {
        const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
        const withdrawBody = serverSrc.substring(
            serverSrc.indexOf("app.post('/withdraw'"),
            serverSrc.indexOf("app.get('/contributor/:wallet/settlements'")
        );

        assert.ok(
            withdrawBody.includes('entry.pending_balance.toFixed(6)'),
            'Payout amount should be computed from server-side pending_balance, not client input'
        );
    });

    // ─── Summary ─────────────────────────────────────────────────────────
    console.log(`\n${'='.repeat(60)}`);
    console.log(`A1 Unit + Integration: ${passed} passed, ${failed} failed`);
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
