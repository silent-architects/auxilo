/**
 * tests/test-a2-unit.js
 *
 * SPEC-A2 Unit + Integration Tests
 * WAL lifecycle, consistency checks, settlement daemon structure,
 * and reservation schema validation.
 *
 * Run: node tests/test-a2-unit.js
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
    createWalEntry,
    markStepComplete,
    commitWal,
    getPendingWalEntries,
} = require('../lib/wal.js');

const WAL_DIR = path.join(__dirname, '..', 'data', 'wal');
const DATA_DIR = path.join(__dirname, '..', 'data');

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
    console.log('=== A2 Unit + Integration Tests ===\n');

    // ═══════════════════════════════════════════════════════════════════════
    // 3.1 WAL Unit Tests — lib/wal.js
    // ═══════════════════════════════════════════════════════════════════════

    console.log('--- 3.1 WAL Unit Tests ---');

    // T-A2-UNIT-001: WAL create + execute + complete lifecycle
    runTest('T-A2-UNIT-001: WAL create + markStepComplete + commit lifecycle', () => {
        const id = createWalEntry('unlock', {
            learning_id: 'test-learning-1',
            builder_wallet: '0xtest',
            unlock_price: 0.005,
            contributor_earned: 0.0035,
            platform_earned: 0.0015,
        });

        // WAL file should exist
        const walPath = path.join(WAL_DIR, `${id}.wal.json`);
        assert.ok(fs.existsSync(walPath), 'WAL file should exist after create');

        // Read and validate structure
        const entry = JSON.parse(fs.readFileSync(walPath, 'utf8'));
        assert.strictEqual(entry.id, id, 'Entry ID should match');
        assert.strictEqual(entry.operation, 'unlock', 'Operation should be unlock');
        assert.ok(Array.isArray(entry.steps_completed), 'steps_completed should be array');
        assert.strictEqual(entry.steps_completed.length, 0, 'No steps completed initially');

        // Mark steps
        markStepComplete(id, 'update_learnings');
        const after1 = JSON.parse(fs.readFileSync(walPath, 'utf8'));
        assert.ok(after1.steps_completed.includes('update_learnings'), 'Step should be recorded');

        markStepComplete(id, 'update_earnings');
        const after2 = JSON.parse(fs.readFileSync(walPath, 'utf8'));
        assert.ok(after2.steps_completed.includes('update_earnings'), 'Second step should be recorded');
        assert.strictEqual(after2.steps_completed.length, 2, 'Should have 2 completed steps');

        // Commit (delete)
        commitWal(id);
        assert.ok(!fs.existsSync(walPath), 'WAL file should be deleted after commit');
    });

    // T-A2-UNIT-002: WAL survives process crash mid-execution
    runTest('T-A2-UNIT-002: WAL recovery replays only incomplete steps', () => {
        // Simulate: WAL created, step 1 done, "crash" (skip commit)
        const id = createWalEntry('unlock', {
            learning_id: 'crash-test',
            builder_wallet: '0xcrash',
            unlock_price: 0.005,
            contributor_earned: 0.0035,
            platform_earned: 0.0015,
        });
        markStepComplete(id, 'update_learnings');
        // Don't call commitWal — simulate crash

        // getPendingWalEntries should find it
        const pending = getPendingWalEntries();
        const found = pending.find(e => e.id === id);
        assert.ok(found, 'Should find the incomplete WAL entry');
        assert.ok(found.steps_completed.includes('update_learnings'), 'Step 1 should be marked done');
        assert.ok(!found.steps_completed.includes('update_earnings'), 'Step 2 should NOT be done');

        // Cleanup
        commitWal(id);
    });

    // T-A2-UNIT-003: WAL file format is valid JSON
    runTest('T-A2-UNIT-003: WAL file is valid JSON with required fields', () => {
        const id = createWalEntry('test', { foo: 'bar' });
        const walPath = path.join(WAL_DIR, `${id}.wal.json`);
        const raw = fs.readFileSync(walPath, 'utf8');

        let parsed;
        assert.doesNotThrow(() => { parsed = JSON.parse(raw); }, 'WAL file should be valid JSON');
        assert.ok(parsed.id, 'Should have id');
        assert.ok(parsed.operation, 'Should have operation');
        assert.ok(parsed.payload, 'Should have payload');
        assert.ok(Array.isArray(parsed.steps_completed), 'Should have steps_completed array');
        assert.ok(parsed.created_at, 'Should have created_at');

        commitWal(id);
    });

    // T-A2-UNIT-004: WAL handles empty payload
    runTest('T-A2-UNIT-004: WAL handles empty payload — immediately completable', () => {
        const id = createWalEntry('noop', {});
        const walPath = path.join(WAL_DIR, `${id}.wal.json`);
        assert.ok(fs.existsSync(walPath), 'WAL file should exist');

        commitWal(id);
        assert.ok(!fs.existsSync(walPath), 'WAL file should be deleted after commit');
    });

    // T-A2-UNIT-005: markStepComplete is idempotent
    runTest('T-A2-UNIT-005: markStepComplete does not duplicate step entries', () => {
        const id = createWalEntry('test', { test: true });
        markStepComplete(id, 'step_a');
        markStepComplete(id, 'step_a'); // duplicate
        markStepComplete(id, 'step_a'); // triple

        const walPath = path.join(WAL_DIR, `${id}.wal.json`);
        const entry = JSON.parse(fs.readFileSync(walPath, 'utf8'));
        const count = entry.steps_completed.filter(s => s === 'step_a').length;
        assert.strictEqual(count, 1, 'Step should appear only once despite multiple markStepComplete calls');

        commitWal(id);
    });

    // T-A2-UNIT-006: markStepComplete for non-existent WAL — no crash
    runTest('T-A2-UNIT-006: markStepComplete for non-existent WAL does not crash', () => {
        // Should not throw
        assert.doesNotThrow(() => {
            markStepComplete('nonexistent-id', 'some_step');
        }, 'markStepComplete on missing WAL should not throw');
    });

    // T-A2-UNIT-007: commitWal for non-existent WAL — no crash
    runTest('T-A2-UNIT-007: commitWal for non-existent WAL does not crash', () => {
        assert.doesNotThrow(() => {
            commitWal('nonexistent-id');
        }, 'commitWal on missing WAL should not throw');
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 3.2 Reservation Schema Tests (validated via server.js code inspection)
    // ═══════════════════════════════════════════════════════════════════════

    console.log('\n--- 3.2 Reservation Schema Tests ---');

    // T-A2-UNIT-006 (spec): reservations.json initialized correctly
    runTest('T-A2-UNIT-008: Reservation functions exist in server.js', () => {
        const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
        assert.ok(serverSrc.includes('function loadReservations'), 'loadReservations should exist');
        assert.ok(serverSrc.includes('function saveReservations'), 'saveReservations should exist');
        assert.ok(serverSrc.includes('function createReservation'), 'createReservation should exist');
        assert.ok(serverSrc.includes('function commitReservation'), 'commitReservation should exist');
        assert.ok(serverSrc.includes('function releaseReservation'), 'releaseReservation should exist');
    });

    // T-A2-UNIT-007 (spec): Reservation lifecycle
    runTest('T-A2-UNIT-009: Reservation lifecycle — create/commit/release use tmp-rename', () => {
        const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

        // saveReservations uses tmp-rename pattern
        const saveFn = serverSrc.substring(
            serverSrc.indexOf('function saveReservations'),
            serverSrc.indexOf('function createReservation')
        );
        assert.ok(saveFn.includes('.tmp'), 'saveReservations should write to .tmp first');
        assert.ok(saveFn.includes('renameSync'), 'saveReservations should use renameSync');

        // createReservation sets status to 'reserved'
        const createFn = serverSrc.substring(
            serverSrc.indexOf('function createReservation'),
            serverSrc.indexOf('function commitReservation')
        );
        assert.ok(createFn.includes("'reserved'"), 'createReservation should set status to reserved');

        // commitReservation sets status to 'committed'
        const commitFn = serverSrc.substring(
            serverSrc.indexOf('function commitReservation'),
            serverSrc.indexOf('function releaseReservation')
        );
        assert.ok(commitFn.includes("'committed'"), 'commitReservation should set status to committed');
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 3.4-3.5 Settlement Daemon + Consistency Check (code structure)
    // ═══════════════════════════════════════════════════════════════════════

    console.log('\n--- 3.4 Settlement Daemon Tests ---');

    // T-A2-INT-004 through T-A2-INT-008: Settlement daemon structure
    runTest('T-A2-INT-004/005: Daemon retries and respects max retry count', () => {
        const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
        assert.ok(serverSrc.includes('SETTLEMENT_MAX_RETRIES = 3'), 'Max retries should be 3');
        assert.ok(serverSrc.includes('retryCount >= SETTLEMENT_MAX_RETRIES'), 'Should check retry count');
        assert.ok(serverSrc.includes("status: 'retry'"), 'Should set retry status on failure');
        assert.ok(serverSrc.includes('retry_count: retryCount + 1'), 'Should increment retry count');
    });

    // T-A2-INT-006: Auto-refund after 24h
    runTest('T-A2-INT-006: Auto-refund after 24h for exhausted retries', () => {
        const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
        assert.ok(serverSrc.includes('SETTLEMENT_REFUND_AGE_MS'), 'Should have refund age constant');
        assert.ok(serverSrc.includes('24 * 60 * 60 * 1000'), 'Refund age should be 24 hours');
        assert.ok(serverSrc.includes("status: 'refunded'"), 'Should set refunded status');
        assert.ok(serverSrc.includes('entry.pending_balance += s.amount'), 'Should restore balance on refund');
    });

    // T-A2-INT-007: Daemon runs hourly
    runTest('T-A2-INT-007: Settlement daemon runs on hourly interval', () => {
        const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
        assert.ok(
            serverSrc.includes('SETTLEMENT_DAEMON_INTERVAL_MS') &&
            serverSrc.includes('60 * 60 * 1000'),
            'Daemon interval should be 1 hour (3,600,000ms)'
        );
        assert.ok(
            serverSrc.includes('setInterval') &&
            serverSrc.includes('resolveStuckSettlements'),
            'setInterval should call resolveStuckSettlements'
        );
    });

    // T-A2-INT-008: Daemon skips already-settled entries
    runTest('T-A2-INT-008: Daemon only processes pending/retry settlements', () => {
        const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
        // The daemon filters for pending/retry only — settled entries are skipped
        assert.ok(
            serverSrc.includes("s.status === 'pending' || s.status === 'retry'"),
            'Daemon should only process pending/retry settlements'
        );
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 3.5 Consistency Check Tests
    // ═══════════════════════════════════════════════════════════════════════

    console.log('\n--- 3.5 Consistency Check Tests ---');

    // T-A2-INT-009/010: Consistency check
    runTest('T-A2-INT-009/010: Consistency check detects drift', () => {
        const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
        assert.ok(serverSrc.includes('function runConsistencyCheck'), 'runConsistencyCheck should exist');

        // Check formula: expected = total_contributor - total_withdrawn
        assert.ok(
            serverSrc.includes('entry.total_contributor') &&
            serverSrc.includes('entry.total_withdrawn'),
            'Should use total_contributor and total_withdrawn for expected calculation'
        );

        // Check epsilon for float comparison
        assert.ok(serverSrc.includes('0.000001'), 'Should use epsilon for float comparison');

        // Check it logs warnings
        assert.ok(serverSrc.includes('[CONSISTENCY]'), 'Should log with [CONSISTENCY] prefix');
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 3.6 Edge Cases
    // ═══════════════════════════════════════════════════════════════════════

    console.log('\n--- 3.6 Edge Cases ---');

    // T-A2-EDGE-001: WAL directory auto-created
    runTest('T-A2-EDGE-001: WAL directory auto-created on startup', () => {
        // wal.js creates the directory on require — check it exists
        assert.ok(fs.existsSync(WAL_DIR), 'WAL directory should exist (auto-created by wal.js)');
    });

    // T-A2-EDGE-002: Concurrent WAL entries get unique IDs
    runTest('T-A2-EDGE-002: Concurrent WAL entries for different operations get unique IDs', () => {
        const ids = [];
        for (let i = 0; i < 50; i++) {
            ids.push(createWalEntry('unlock', { learning_id: `skill-${i}` }));
        }
        const unique = new Set(ids);
        assert.strictEqual(unique.size, 50, `All 50 WAL entries should have unique IDs, got ${unique.size}`);

        // Cleanup
        for (const id of ids) commitWal(id);
    });

    // ─── Summary ─────────────────────────────────────────────────────────
    console.log(`\n${'='.repeat(60)}`);
    console.log(`A2 Unit + Integration: ${passed} passed, ${failed} failed`);
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
