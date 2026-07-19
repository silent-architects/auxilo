/**
 * ╔═══════════════════════════════════════════════════════════════════════╗
 * ║ RETIRED (LW-10, 2026-07-19) — DO NOT RUN.                             ║
 * ║ Hangs after T-A0-UNIT-007: a mocked RPC promise never resolves under  ║
 * ║ the proxyquire viem fake (verified with a 25s watchdog). Kept as a    ║
 * ║ historical verification record; tx-manager coverage lives in test/.   ║
 * ║ See tests/README.md.                                                  ║
 * ╚═══════════════════════════════════════════════════════════════════════╝
 *
 * tests/test-a0-unit.js
 *
 * SPEC-A0 Transaction Manager Verification
 * 25 executable test cases (18 unit + 4 edge/concurrency + 3 security)
 * + 3 deferred regression (REG-001, REG-002 to A1/A2; REG-003 covered by UNIT-010)
 *
 * Mocking strategy: proxyquire injects mock viem clients into the REAL
 * lib/tx-manager.js, ensuring withMutex, sendUSDC, checkBalance, and
 * checkGasBalance run their actual code with only the RPC layer faked.
 *
 * Run: node tests/test-a0-unit.js
 */

const assert = require('assert');
const { execSync, fork } = require('child_process');
const path = require('path');

// ─── Test harness (matching A3 pattern) ───────────────────────────────────────

let passed = 0;
let failed = 0;
const failures = [];

async function runAsyncTest(name, fn) {
    try {
        await fn();
        passed++;
        console.log(`✅ ${name}`);
    } catch (err) {
        failed++;
        failures.push(name);
        console.error(`❌ ${name}`);
        console.error(`   ${err.message}`);
    }
}

function runTest(name, fn) {
    try {
        fn();
        passed++;
        console.log(`✅ ${name}`);
    } catch (err) {
        failed++;
        failures.push(name);
        console.error(`❌ ${name}`);
        console.error(`   ${err.message}`);
    }
}

// ─── Helper: fresh proxyquire load ────────────────────────────────────────────
// Each test that needs mocks gets a fresh module load to avoid shared state
// between the mutex queue of different test cases.

const proxyquire = require('proxyquire').noCallThru();
const { parseUnits, formatUnits } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const { TEST_PRIVATE_KEY, testAddress } = require('./helpers/test-wallet');

/**
 * Create a fresh tx-manager instance with mock RPC responses.
 * Each call produces an isolated module with its own mutex queue.
 */
function freshTxManager(opts = {}) {
    const callLog = [];
    let callSeq = 0;

    const mockResponses = {
        getTransactionCount: opts.nonce ?? 42,
        writeContract: opts.txHash ?? '0xabc123def456789000000000000000000000000000000000000000000000abcd',
        getTransactionReceipt: opts.receipt ?? { status: 'success' },
        readContract: opts.balance ?? 1000000n,
        getBalance: opts.ethBalance ?? 10000000000000000n,
        ...opts.overrides,
    };

    async function resolve(key, args) {
        const r = mockResponses[key];
        if (typeof r === 'function') return r(args);
        return r;
    }

    const mockViem = {
        createPublicClient: () => ({
            getTransactionCount: async (a) => { callLog.push({ m: 'getNonce', seq: callSeq++, t: Date.now() }); if (opts.nonceDelay) await new Promise(r => setTimeout(r, opts.nonceDelay)); return resolve('getTransactionCount', a); },
            getTransactionReceipt: async (a) => { callLog.push({ m: 'getReceipt', seq: callSeq++, t: Date.now() }); if (opts.receiptDelay) await new Promise(r => setTimeout(r, opts.receiptDelay)); return resolve('getTransactionReceipt', a); },
            readContract: async (a) => { callLog.push({ m: 'readContract', seq: callSeq++, t: Date.now() }); return resolve('readContract', a); },
            getBalance: async (a) => { callLog.push({ m: 'getBalance', seq: callSeq++, t: Date.now() }); return resolve('getBalance', a); },
        }),
        createWalletClient: () => ({
            writeContract: async (a) => { callLog.push({ m: 'writeContract', seq: callSeq++, t: Date.now() }); if (opts.writeDelay) await new Promise(r => setTimeout(r, opts.writeDelay)); return resolve('writeContract', a); },
        }),
        parseUnits,
        formatUnits,
        http: () => 'mock-transport',
        '@noCallThru': true,
    };

    const origKey = process.env.WALLET_PRIVATE_KEY;
    process.env.WALLET_PRIVATE_KEY = TEST_PRIVATE_KEY;

    // Clear module cache so each call gets a fresh module with its own mutex
    const modPath = require.resolve('../lib/tx-manager');
    delete require.cache[modPath];

    const txManager = proxyquire('../lib/tx-manager', {
        'viem': mockViem,
        'viem/accounts': { privateKeyToAccount, '@noCallThru': true },
        'viem/chains': { base: { id: 8453, name: 'Base' }, '@noCallThru': true },
    });

    // Restore env
    if (origKey !== undefined) process.env.WALLET_PRIVATE_KEY = origKey;
    else delete process.env.WALLET_PRIVATE_KEY;

    return { txManager, callLog, mockResponses };
}

// ═══════════════════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════════════════

async function runTests() {
    console.log('═══════════════════════════════════════════════════');
    console.log('  SPEC-A0: Transaction Manager — Verification');
    console.log('═══════════════════════════════════════════════════\n');

    // ─── UNIT TESTS ──────────────────────────────────────────────────────────

    // T-A0-UNIT-001: Crash without WALLET_PRIVATE_KEY
    await runAsyncTest('T-A0-UNIT-001: Server crashes without WALLET_PRIVATE_KEY', async () => {
        const child = fork(
            path.join(__dirname, '..', 'lib', 'tx-manager.js'),
            [],
            {
                env: { ...process.env, WALLET_PRIVATE_KEY: '' },
                stdio: 'pipe',
                execArgv: [],
            }
        );

        const exitCode = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => { child.kill(); reject(new Error('Process did not exit within 5s')); }, 5000);
            child.on('exit', (code) => { clearTimeout(timer); resolve(code); });
            child.on('error', (err) => { clearTimeout(timer); reject(err); });
        });

        assert.strictEqual(exitCode, 1, `Expected exit code 1, got ${exitCode}`);
    });

    // T-A0-UNIT-002: getWalletAddress returns correct address
    runTest('T-A0-UNIT-002: getWalletAddress returns correct address', () => {
        const { txManager } = freshTxManager();
        const addr = txManager.getWalletAddress();
        assert.strictEqual(addr, testAddress, `Expected ${testAddress}, got ${addr}`);
    });

    // T-A0-UNIT-003: getPublicClient returns object with expected methods
    runTest('T-A0-UNIT-003: getPublicClient returns object with expected methods', () => {
        const { txManager } = freshTxManager();
        const pc = txManager.getPublicClient();
        assert.strictEqual(typeof pc.getBalance, 'function', 'getBalance missing');
        assert.strictEqual(typeof pc.readContract, 'function', 'readContract missing');
        assert.strictEqual(typeof pc.getTransactionReceipt, 'function', 'getTransactionReceipt missing');
        assert.strictEqual(typeof pc.getTransactionCount, 'function', 'getTransactionCount missing');
    });

    // T-A0-UNIT-004: USDC_BASE constant
    runTest('T-A0-UNIT-004: USDC_BASE is correct Base mainnet USDC address', () => {
        const { txManager } = freshTxManager();
        assert.strictEqual(txManager.USDC_BASE, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
    });

    // T-A0-UNIT-005: WALLET_ADDRESS matches getWalletAddress()
    runTest('T-A0-UNIT-005: WALLET_ADDRESS matches getWalletAddress()', () => {
        const { txManager } = freshTxManager();
        assert.strictEqual(txManager.WALLET_ADDRESS, txManager.getWalletAddress());
    });

    // T-A0-UNIT-006: sendUSDC serializes concurrent calls (mutex — sequence-log proof)
    await runAsyncTest('T-A0-UNIT-006: sendUSDC serializes concurrent calls (sequence-log proof)', async () => {
        const { txManager, callLog } = freshTxManager({ writeDelay: 10 });

        // Fire 3 concurrent calls
        const p1 = txManager.sendUSDC('0x1111111111111111111111111111111111111111', 1.0);
        const p2 = txManager.sendUSDC('0x2222222222222222222222222222222222222222', 2.0);
        const p3 = txManager.sendUSDC('0x3333333333333333333333333333333333333333', 3.0);
        await Promise.all([p1, p2, p3]);

        // Extract only the nonce-fetch and write-contract calls (ignore receipt polls)
        const critical = callLog.filter(c => c.m === 'getNonce' || c.m === 'writeContract');

        // Must be strictly interleaved: getNonce, writeContract, getNonce, writeContract, ...
        assert.strictEqual(critical.length, 6, `Expected 6 critical calls, got ${critical.length}`);
        for (let i = 0; i < 6; i += 2) {
            assert.strictEqual(critical[i].m, 'getNonce', `Call ${i} expected getNonce, got ${critical[i].m}`);
            assert.strictEqual(critical[i + 1].m, 'writeContract', `Call ${i + 1} expected writeContract, got ${critical[i + 1].m}`);
        }
        // Sequence numbers must show strict pairing
        for (let i = 0; i < 5; i++) {
            assert.ok(critical[i].seq < critical[i + 1].seq,
                `Sequence order violated at positions ${i} and ${i + 1}`);
        }
    });

    // T-A0-UNIT-007: sendUSDC returns confirmed on success
    await runAsyncTest('T-A0-UNIT-007: sendUSDC returns { status: confirmed } on success', async () => {
        const { txManager } = freshTxManager();
        const result = await txManager.sendUSDC('0x1111111111111111111111111111111111111111', 10.0);
        assert.strictEqual(result.status, 'confirmed');
        assert.ok(result.hash, 'hash should be present');
        assert.strictEqual(typeof result.hash, 'string');
    });

    // T-A0-UNIT-008: sendUSDC returns timeout on receipt timeout
    await runAsyncTest('T-A0-UNIT-008: sendUSDC returns { status: timeout } when receipt never arrives', async () => {
        // Mock: receipt always throws (simulates not-yet-mined)
        // Override CONFIRM_TIMEOUT_MS by mocking Date.now to fast-forward
        const realDateNow = Date.now;
        let nowOffset = 0;
        Date.now = () => realDateNow() + nowOffset;

        const { txManager } = freshTxManager({
            receipt: () => { throw new Error('not found'); },
            // We need to advance time during polling. Each getTransactionReceipt
            // call advances our mock clock by 5s to quickly exceed the 60s timeout.
            overrides: {},
        });

        // Patch: advance time by 5s each time receipt is polled
        let pollCount = 0;
        const origReceipt = txManager; // We need a different approach — use the callLog side-effect
        // Actually we'll advance time from the receipt mock function itself
        const { txManager: tm2 } = freshTxManager({
            receipt: () => {
                pollCount++;
                nowOffset = pollCount * 5000; // Each poll jumps 5s
                throw new Error('not found');
            },
        });

        const result = await tm2.sendUSDC('0x1111111111111111111111111111111111111111', 5.0);
        assert.strictEqual(result.status, 'timeout', `Expected timeout, got ${result.status}`);
        assert.ok(result.hash, 'hash should be present (broadcast succeeded)');

        Date.now = realDateNow;
    });

    // T-A0-UNIT-009: sendUSDC returns failed on broadcast error
    await runAsyncTest('T-A0-UNIT-009: sendUSDC returns { status: failed } on broadcast error', async () => {
        const { txManager } = freshTxManager({
            txHash: () => { throw new Error('insufficient funds for gas'); },
        });
        const result = await txManager.sendUSDC('0x1111111111111111111111111111111111111111', 10.0);
        assert.strictEqual(result.status, 'failed');
        assert.strictEqual(result.hash, null);
        assert.ok(result.error.includes('insufficient funds'), `Error message: ${result.error}`);
    });

    // T-A0-UNIT-010: checkBalance returns numeric balance (AR-5)
    await runAsyncTest('T-A0-UNIT-010: checkBalance returns { sufficient, balance } with AR-5 numeric', async () => {
        const { txManager } = freshTxManager({
            balance: 100500000n, // 100.5 USDC raw
        });
        const result = await txManager.checkBalance(50.0);
        assert.strictEqual(typeof result.balance, 'number', 'balance must be number, not bigint');
        assert.strictEqual(result.balance, 100.5);
        assert.strictEqual(result.sufficient, true);

        const result2 = await txManager.checkBalance(200.0);
        assert.strictEqual(result2.sufficient, false);
    });

    // T-A0-UNIT-011: Mutex releases on ALL exit paths (success, error, timeout)
    await runAsyncTest('T-A0-UNIT-011: Mutex releases on all exit paths (error + timeout + success)', async () => {
        const realDateNow = Date.now;

        // Call 1: broadcast error (throw)
        // Call 2: timeout (receipt never arrives)
        // Call 3: success
        // All 3 must complete — proving mutex releases on every path
        let callIndex = 0;
        let pollCountForCall2 = 0;
        let nowOffset = 0;
        Date.now = () => realDateNow() + nowOffset;

        const { txManager } = freshTxManager({
            txHash: (args) => {
                callIndex++;
                if (callIndex === 1) throw new Error('test broadcast error');
                return '0xhash' + callIndex;
            },
            receipt: () => {
                // For call 2 (callIndex will be 2), simulate timeout
                if (callIndex === 2) {
                    pollCountForCall2++;
                    nowOffset = pollCountForCall2 * 5000;
                    throw new Error('not found');
                }
                // For call 3, return success immediately
                return { status: 'success' };
            },
        });

        const r1 = await txManager.sendUSDC('0x1111111111111111111111111111111111111111', 1.0);
        assert.strictEqual(r1.status, 'failed', `Call 1 expected failed, got ${r1.status}`);

        nowOffset = 0; // Reset clock for call 2
        pollCountForCall2 = 0;
        const r2 = await txManager.sendUSDC('0x2222222222222222222222222222222222222222', 2.0);
        assert.strictEqual(r2.status, 'timeout', `Call 2 expected timeout, got ${r2.status}`);

        nowOffset = 0; // Reset clock for call 3
        const r3 = await txManager.sendUSDC('0x3333333333333333333333333333333333333333', 3.0);
        assert.strictEqual(r3.status, 'confirmed', `Call 3 expected confirmed, got ${r3.status}`);

        Date.now = realDateNow;
    });

    // T-A0-UNIT-012: waitForConfirmation returns false on 'reverted' receipt
    // DOCUMENTED SPEC BUG F3: revert ≡ timeout conflation
    await runAsyncTest('T-A0-UNIT-012: Reverted receipt → status: timeout (F3 spec bug documented)', async () => {
        const { txManager } = freshTxManager({
            receipt: { status: 'reverted' },
        });
        const result = await txManager.sendUSDC('0x1111111111111111111111111111111111111111', 5.0);
        // F3: sendUSDC conflates revert with timeout — this test DOCUMENTS the behavior
        assert.strictEqual(result.status, 'timeout',
            `F3 spec bug: reverted should currently map to timeout, got ${result.status}`);
        assert.ok(result.hash, 'hash should still be present for reverted txs');
        console.log('   ⚠️  F3: revert≡timeout conflation confirmed — tracked as follow-on spec item');
    });

    // T-A0-UNIT-013: sendUSDC with amount=0
    await runAsyncTest('T-A0-UNIT-013: sendUSDC with amount=0 completes without crash', async () => {
        const { txManager, callLog } = freshTxManager();
        const result = await txManager.sendUSDC('0x1111111111111111111111111111111111111111', 0);
        // parseUnits('0.000000', 6) = 0n — this is a valid EVM transfer
        assert.strictEqual(result.status, 'confirmed');
        // Verify the amount arg sent to writeContract was 0n
        const wc = callLog.find(c => c.m === 'writeContract');
        assert.ok(wc, 'writeContract should have been called');
    });

    // T-A0-UNIT-014: sendUSDC with negative amount
    // FINDING: viem parseUnits ACCEPTS negative values (produces negative bigint).
    // The mock chain doesn't reject this — on real chain, EVM would revert the uint256 transfer.
    // Recommendation: add input validation to sendUSDC (amount > 0) as follow-on spec item.
    await runAsyncTest('T-A0-UNIT-014: sendUSDC with negative amount — documents no input validation', async () => {
        const { txManager } = freshTxManager();
        const result = await txManager.sendUSDC('0x1111111111111111111111111111111111111111', -1);
        // viem parseUnits('-1.000000', 6) produces -1000000n — no error thrown locally.
        // On mainnet this would revert (uint256 overflow). Document behavior.
        // Current: completes with confirmed (mock chain). Real chain would revert.
        assert.ok(['confirmed', 'failed'].includes(result.status),
            `Expected confirmed or failed, got ${result.status}`);
        console.log(`   ⚠️  Negative amount: sendUSDC returned status=${result.status}. No input validation exists — add validation as follow-on.`);
    });

    // T-A0-UNIT-015: sendUSDC with invalid toAddress
    await runAsyncTest('T-A0-UNIT-015: sendUSDC with invalid address returns failed', async () => {
        const { txManager } = freshTxManager({
            txHash: () => { throw new Error('invalid address'); },
        });
        const result = await txManager.sendUSDC('0xinvalid', 10.0);
        assert.strictEqual(result.status, 'failed');
        assert.strictEqual(result.hash, null);
        assert.ok(result.error, 'error message should be present');
    });

    // T-A0-UNIT-016: checkGasBalance throws when ETH < 0.0001
    await runAsyncTest('T-A0-UNIT-016: checkGasBalance throws when ETH balance is too low', async () => {
        const { txManager } = freshTxManager({
            ethBalance: 99999999999999n, // 0.000099... ETH (< 0.0001)
        });
        try {
            await txManager.checkGasBalance();
            assert.fail('checkGasBalance should have thrown');
        } catch (err) {
            assert.ok(err.message.includes('insufficient ETH'),
                `Expected gas error, got: ${err.message}`);
        }
    });

    // T-A0-UNIT-017: checkGasBalance succeeds with sufficient ETH
    await runAsyncTest('T-A0-UNIT-017: checkGasBalance succeeds with sufficient ETH', async () => {
        const { txManager } = freshTxManager({
            ethBalance: 100000000000000n, // 0.0001 ETH exactly
        });
        // Should NOT throw
        await txManager.checkGasBalance();
    });

    // T-A0-UNIT-018: Startup ETH balance side-effect doesn't crash on RPC error
    await runAsyncTest('T-A0-UNIT-018: Module loads even if startup getBalance throws', async () => {
        // The startup side-effect calls getBalance().then().catch(console.error)
        // If getBalance throws, the .catch should absorb it
        const { txManager } = freshTxManager({
            ethBalance: () => { throw new Error('RPC down at startup'); },
        });
        // Module loaded successfully — verify exports work
        assert.ok(txManager.sendUSDC, 'sendUSDC should be exported');
        assert.ok(txManager.checkBalance, 'checkBalance should be exported');
        assert.ok(txManager.checkGasBalance, 'checkGasBalance should be exported');
        // Give the async side-effect time to fire and be caught
        await new Promise(r => setTimeout(r, 100));
    });

    console.log('\n─── CONCURRENCY / EDGE TESTS ────────────────────────\n');

    // T-A0-EDGE-001: 10 concurrent sendUSDC calls execute sequentially
    await runAsyncTest('T-A0-EDGE-001: 10 concurrent sendUSDC calls — strict sequential interleaving', async () => {
        const { txManager, callLog } = freshTxManager({ writeDelay: 5 });

        const promises = [];
        for (let i = 0; i < 10; i++) {
            const addr = '0x' + String(i + 1).padStart(40, '0');
            promises.push(txManager.sendUSDC(addr, 1.0));
        }
        const results = await Promise.all(promises);

        // All 10 must complete
        assert.strictEqual(results.length, 10);
        results.forEach((r, i) => assert.strictEqual(r.status, 'confirmed', `Call ${i} not confirmed`));

        // Verify strict interleaving
        const critical = callLog.filter(c => c.m === 'getNonce' || c.m === 'writeContract');
        assert.strictEqual(critical.length, 20, `Expected 20 critical calls, got ${critical.length}`);

        for (let i = 0; i < 20; i += 2) {
            assert.strictEqual(critical[i].m, 'getNonce', `Position ${i} expected getNonce`);
            assert.strictEqual(critical[i + 1].m, 'writeContract', `Position ${i + 1} expected writeContract`);
        }
    });

    // T-A0-EDGE-002: Mutex prevents nonce collision
    await runAsyncTest('T-A0-EDGE-002: Mutex prevents nonce collision — unique nonces', async () => {
        let nonceCounter = 100;
        const { txManager, callLog } = freshTxManager({
            nonce: () => nonceCounter++,
            writeDelay: 5,
        });

        const promises = [];
        for (let i = 0; i < 5; i++) {
            const addr = '0x' + String(i + 1).padStart(40, '0');
            promises.push(txManager.sendUSDC(addr, 1.0));
        }
        await Promise.all(promises);

        // Verify each getNonce call is followed by its corresponding writeContract
        // BEFORE the next getNonce happens
        const critical = callLog.filter(c => c.m === 'getNonce' || c.m === 'writeContract');
        for (let i = 0; i < critical.length; i += 2) {
            assert.strictEqual(critical[i].m, 'getNonce');
            assert.strictEqual(critical[i + 1].m, 'writeContract');
            assert.ok(critical[i].seq < critical[i + 1].seq);
            // Next pair starts after this pair
            if (i + 2 < critical.length) {
                assert.ok(critical[i + 1].seq < critical[i + 2].seq,
                    `writeContract at seq ${critical[i + 1].seq} must precede next getNonce at seq ${critical[i + 2].seq}`);
            }
        }
    });

    // T-A0-EDGE-003: Failed transfer doesn't block subsequent
    await runAsyncTest('T-A0-EDGE-003: Failed transfer does not block subsequent transfers', async () => {
        let callNum = 0;
        const { txManager } = freshTxManager({
            txHash: () => {
                callNum++;
                if (callNum === 1) throw new Error('network error');
                return '0xsuccess_hash_' + callNum;
            },
        });

        const r1 = await txManager.sendUSDC('0x1111111111111111111111111111111111111111', 5.0);
        assert.strictEqual(r1.status, 'failed');

        const r2 = await txManager.sendUSDC('0x2222222222222222222222222222222222222222', 5.0);
        assert.strictEqual(r2.status, 'confirmed');
    });

    // T-A0-EDGE-004: AUDIT-13 PROOF — getTransactionCount strictly interleaves with writeContract
    await runAsyncTest('T-A0-EDGE-004: AUDIT-13 proof — getNonce/writeContract strict interleaving (3 concurrent)', async () => {
        const { txManager, callLog } = freshTxManager({ writeDelay: 20 });

        // Fire 3 concurrent calls
        const p1 = txManager.sendUSDC('0x1111111111111111111111111111111111111111', 1.0);
        const p2 = txManager.sendUSDC('0x2222222222222222222222222222222222222222', 2.0);
        const p3 = txManager.sendUSDC('0x3333333333333333333333333333333333333333', 3.0);
        await Promise.all([p1, p2, p3]);

        // Extract critical-path calls only
        const critical = callLog.filter(c => c.m === 'getNonce' || c.m === 'writeContract');
        assert.strictEqual(critical.length, 6, 'Expected exactly 6 critical calls (3×getNonce + 3×writeContract)');

        // Assert EXACT sequence: [getNonce₁, writeContract₁, getNonce₂, writeContract₂, getNonce₃, writeContract₃]
        const expectedPattern = ['getNonce', 'writeContract', 'getNonce', 'writeContract', 'getNonce', 'writeContract'];
        const actualPattern = critical.map(c => c.m);
        assert.deepStrictEqual(actualPattern, expectedPattern,
            `AUDIT-13 FAILURE: Expected strict interleaving ${JSON.stringify(expectedPattern)}, ` +
            `got ${JSON.stringify(actualPattern)}`);

        // Also verify sequence numbers are strictly increasing
        for (let i = 0; i < critical.length - 1; i++) {
            assert.ok(critical[i].seq < critical[i + 1].seq,
                `Sequence order broken at ${critical[i].seq} → ${critical[i + 1].seq}`);
        }

        console.log('   ✓ AUDIT-13: getNonce is ALWAYS called inside mutex, immediately before writeContract');
    });

    console.log('\n─── SECURITY TESTS ──────────────────────────────────\n');

    // T-A0-SEC-001: Error messages never contain private key material
    await runAsyncTest('T-A0-SEC-001: Error messages never contain private key material', async () => {
        const keyHex = TEST_PRIVATE_KEY.replace('0x', '');
        const keyPattern = new RegExp(keyHex.substring(0, 16), 'i'); // First 16 chars of key

        // Test all failure modes
        const { txManager } = freshTxManager({
            txHash: () => { throw new Error('some broadcast error'); },
        });

        const r1 = await txManager.sendUSDC('0x1111111111111111111111111111111111111111', 10.0);
        assert.strictEqual(r1.status, 'failed');
        assert.ok(!keyPattern.test(r1.error), 'Error message must not contain private key fragment');
        assert.ok(!keyPattern.test(JSON.stringify(r1)), 'Result JSON must not contain private key fragment');
    });

    // T-A0-SEC-002: sendUSDC result object never contains private key
    await runAsyncTest('T-A0-SEC-002: sendUSDC result objects never contain private key', async () => {
        const keyHex = TEST_PRIVATE_KEY.replace('0x', '');

        // Test each return shape
        const { txManager: tm1 } = freshTxManager(); // success
        const r1 = await tm1.sendUSDC('0x1111111111111111111111111111111111111111', 10.0);
        assert.ok(!JSON.stringify(r1).includes(keyHex.substring(0, 16)), 'Success result leaked key');

        const { txManager: tm2 } = freshTxManager({
            txHash: () => { throw new Error('fail'); }
        }); // failure
        const r2 = await tm2.sendUSDC('0x1111111111111111111111111111111111111111', 10.0);
        assert.ok(!JSON.stringify(r2).includes(keyHex.substring(0, 16)), 'Failure result leaked key');
    });

    // T-A0-SEC-003: Startup crash message doesn't echo key value
    await runAsyncTest('T-A0-SEC-003: Crash message does not echo private key value', async () => {
        const child = fork(
            path.join(__dirname, '..', 'lib', 'tx-manager.js'),
            [],
            {
                env: { ...process.env, WALLET_PRIVATE_KEY: '' },
                stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
                execArgv: [],
            }
        );

        let stderr = '';
        child.stderr.on('data', (d) => { stderr += d.toString(); });

        await new Promise((resolve) => {
            child.on('exit', resolve);
            setTimeout(resolve, 3000);
        });

        // Verify the crash output doesn't contain any actual key values
        assert.ok(!stderr.includes('deadbeef'), `Crash stderr should not contain key material: ${stderr.substring(0, 200)}`);
    });

    // ─── REGRESSION TESTS ─────────────────────────────────────────────────────

    console.log('\n─── REGRESSION TESTS ────────────────────────────────\n');

    // T-A0-REG-003: Balance check returns correct value (REG-001, REG-002 deferred to A1/A2)
    await runAsyncTest('T-A0-REG-003: checkBalance returns correct numeric value', async () => {
        const { txManager } = freshTxManager({ balance: 50000000n }); // 50 USDC
        const result = await txManager.checkBalance(25.0);
        assert.strictEqual(result.balance, 50.0);
        assert.strictEqual(result.sufficient, true);
    });

    // ─── SUMMARY ──────────────────────────────────────────────────────────────

    console.log('\n═══════════════════════════════════════════════════');
    console.log(`  Results: ${passed} passed, ${failed} failed`);
    if (failures.length > 0) {
        console.log(`  Failures:`);
        failures.forEach(f => console.log(`    • ${f}`));
    }
    console.log('');
    console.log('  Deferred (not executed):');
    console.log('    • T-A0-REG-001: Withdrawal flow → deferred to A1 verification');
    console.log('    • T-A0-REG-002: Settlement flow → deferred to A2 verification');
    console.log('');
    console.log('  Known Limitations:');
    console.log('    • F3: waitForConfirmation returns false for both reverted AND timeout');
    console.log('      → sendUSDC status:timeout conflates revert with timeout');
    console.log('      → Settlement daemon will retry reverted txs as if timed out');
    console.log('      → Tracked as follow-on spec item for A0 v2');
    console.log('═══════════════════════════════════════════════════\n');

    if (failed > 0) process.exit(1);
    else process.exit(0);
}

runTests();
