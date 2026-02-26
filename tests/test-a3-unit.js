const assert = require('assert');
const {
    EIP712_DOMAIN,
    CHALLENGE_TYPES,
    WITHDRAWAL_TYPES,
    createNonce,
    consumeNonce,
    verifyChallengeSignature,
    verifyWithdrawalSignature,
} = require('../lib/eip712.js');

const { testAddress, signChallenge, signWithdrawal } = require('./helpers/test-wallet.js');

async function runTests() {
    console.log('--- Running A3 Unit Tests ---');
    let passed = 0;
    let failed = 0;

    function runTest(name, fn) {
        try {
            fn();
            passed++;
            console.log(`✅ ${name}`);
        } catch (err) {
            failed++;
            console.error(`❌ ${name}`);
            console.error(err);
        }
    }

    async function runAsyncTest(name, fn) {
        try {
            await fn();
            passed++;
            console.log(`✅ ${name}`);
        } catch (err) {
            failed++;
            console.error(`❌ ${name}`);
            console.error(err);
        }
    }

    // T-A3-UNIT-001: createNonce returns struct {nonce, timestamp, expires_at}
    runTest('T-A3-UNIT-001: createNonce structure', () => {
        const res = createNonce(testAddress);
        assert.ok(res.nonce, 'missing nonce');
        assert.ok(res.timestamp, 'missing timestamp');
        assert.ok(res.expires_at, 'missing expires_at');
        // Action is stored but not returned in createNonce
    });

    // T-A3-UNIT-002: createNonce overwrites existing nonce for same wallet
    // T-A3-UNIT-003: createNonce is case-insensitive (0xA == 0xa)
    runTest('T-A3-UNIT-002/003: createNonce overwrite & case-insensitivity', () => {
        const res1 = createNonce(testAddress.toUpperCase());
        const res2 = createNonce(testAddress.toLowerCase());
        assert.notStrictEqual(res1.nonce, res2.nonce, 'Nonces should differ');

        const consumed1 = consumeNonce(testAddress.toUpperCase());
        assert.strictEqual(consumed1.nonce, res2.nonce, 'Should return the latter nonce regardless of case');
    });

    // T-A3-UNIT-004: consumeNonce returns valid data and deletes it (single-use)
    runTest('T-A3-UNIT-004: consumeNonce single-use', () => {
        const res = createNonce(testAddress);
        const consumed = consumeNonce(testAddress);
        assert.strictEqual(consumed.nonce, res.nonce);
        const consumedAgain = consumeNonce(testAddress);
        assert.strictEqual(consumedAgain, null, 'Should be deleted after first use');
    });

    // T-A3-UNIT-005: consumeNonce returns null for non-existent wallet
    runTest('T-A3-UNIT-005: consumeNonce for non-existent wallet', () => {
        const consumed = consumeNonce('0xNotExistent');
        assert.strictEqual(consumed, null);
    });

    // T-A3-UNIT-006: consumeNonce returns null if TTL expired
    // Modifying global Date.now for testing
    runTest('T-A3-UNIT-006: consumeNonce expiry', () => {
        const realDateNow = Date.now;
        try {
            const start = realDateNow();
            Date.now = () => start; // mock now
            createNonce(testAddress);

            Date.now = () => start + 301_000; // Fast forward > 5 minutes
            const consumed = consumeNonce(testAddress);
            assert.strictEqual(consumed, null, 'Expected expired nonce to be null');
        } finally {
            Date.now = realDateNow; // restore
        }
    });

    // T-A3-UNIT-008: Default action is 'challenge'
    // T-A3-UNIT-009: Can set action to 'withdrawal'
    runTest('T-A3-UNIT-008/009: Action type storage', () => {
        createNonce(testAddress);
        const c1 = consumeNonce(testAddress);
        assert.strictEqual(c1.action, 'challenge');

        createNonce(testAddress, 'withdrawal');
        const c2 = consumeNonce(testAddress);
        assert.strictEqual(c2.action, 'withdrawal');
    });

    // Signature tests
    await runAsyncTest('T-A3-UNIT-013: Valid challenge signature passes', async () => {
        const { nonce, timestamp } = createNonce(testAddress);
        const sig = await signChallenge(EIP712_DOMAIN, CHALLENGE_TYPES, nonce, timestamp);
        const isValid = await verifyChallengeSignature(testAddress, nonce, timestamp, sig);
        assert.strictEqual(isValid, true);
    });

    await runAsyncTest('T-A3-UNIT-010: Wrong wallet rejected', async () => {
        const { nonce, timestamp } = createNonce(testAddress);
        const sig = await signChallenge(EIP712_DOMAIN, CHALLENGE_TYPES, nonce, timestamp);
        // Pretend to verify for a diff wallet
        const OTHER_WALLET = '0x1111111111111111111111111111111111111111';
        const isValid = await verifyChallengeSignature(OTHER_WALLET, nonce, timestamp, sig);
        assert.strictEqual(isValid, false);
    });

    await runAsyncTest('T-A3-UNIT-011: Tampered nonce rejected', async () => {
        const { nonce, timestamp } = createNonce(testAddress);
        const sig = await signChallenge(EIP712_DOMAIN, CHALLENGE_TYPES, nonce, timestamp);
        const isValid = await verifyChallengeSignature(testAddress, 'tampered_nonce', timestamp, sig);
        assert.strictEqual(isValid, false);
    });

    await runAsyncTest('T-A3-UNIT-012: Tampered timestamp rejected', async () => {
        const { nonce, timestamp } = createNonce(testAddress);
        const sig = await signChallenge(EIP712_DOMAIN, CHALLENGE_TYPES, nonce, timestamp);
        const isValid = await verifyChallengeSignature(testAddress, nonce, timestamp + 1, sig);
        assert.strictEqual(isValid, false);
    });

    await runAsyncTest('T-A3-UNIT-014: Valid withdrawal signature passes', async () => {
        const amount = "15.50";
        const { nonce, timestamp } = createNonce(testAddress, 'withdrawal');
        const sig = await signWithdrawal(EIP712_DOMAIN, WITHDRAWAL_TYPES, amount, nonce, timestamp);
        const isValid = await verifyWithdrawalSignature(testAddress, amount, nonce, timestamp, sig);
        assert.strictEqual(isValid, true);
    });

    console.log(`\nTests completed: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
    else process.exit(0);
}

runTests();
