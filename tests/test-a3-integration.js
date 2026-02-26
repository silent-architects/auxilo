const assert = require('assert');
const { spawn } = require('child_process');
const { EIP712_DOMAIN, CHALLENGE_TYPES, WITHDRAWAL_TYPES } = require('../lib/eip712.js');
const { testAddress, signChallenge, signWithdrawal } = require('./helpers/test-wallet.js');

const PORT = 3000;
const API_URL = `http://localhost:${PORT}`;

async function fetchApi(path, options = {}) {
    const res = await fetch(`${API_URL}${path}`, {
        headers: { 'Content-Type': 'application/json' },
        ...options,
    });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
}

async function runTests() {
    console.log('--- Running A3 Integration Tests ---');
    let passed = 0;
    let failed = 0;

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

    // T-A3-INT-001: Happy path challenge→verify
    await runAsyncTest('T-A3-INT-001: Happy path challenge->verify', async () => {
        let res = await fetchApi('/wallet/challenge', {
            method: 'POST', body: JSON.stringify({ wallet: testAddress })
        });
        assert.strictEqual(res.status, 200, res.data.error);
        const { challenge, timestamp } = res.data;

        const sig = await signChallenge(EIP712_DOMAIN, CHALLENGE_TYPES, challenge, timestamp);

        res = await fetchApi('/wallet/verify', {
            method: 'POST', body: JSON.stringify({ wallet: testAddress, signature: sig })
        });
        assert.strictEqual(res.status, 200, res.data.error);
        assert.strictEqual(res.data.verified, true);
        assert.strictEqual(res.data.wallet, testAddress.toLowerCase());
    });

    // T-A3-INT-002: Verify without challenge
    await runAsyncTest('T-A3-INT-002: Verify without challenge fails', async () => {
        const res = await fetchApi('/wallet/verify', {
            method: 'POST', body: JSON.stringify({ wallet: testAddress, signature: '0x123456' })
        });
        assert.strictEqual(res.status, 400);
        assert.ok(res.data.error.includes('No active challenge'));
    });

    // T-A3-INT-003: Replay blocked (C7)
    await runAsyncTest('T-A3-INT-003: Replay blocked (C7)', async () => {
        const r1 = await fetchApi('/wallet/challenge', {
            method: 'POST', body: JSON.stringify({ wallet: testAddress })
        });
        const { challenge, timestamp } = r1.data;
        const sig = await signChallenge(EIP712_DOMAIN, CHALLENGE_TYPES, challenge, timestamp);

        const r2 = await fetchApi('/wallet/verify', {
            method: 'POST', body: JSON.stringify({ wallet: testAddress, signature: sig })
        });
        assert.strictEqual(r2.status, 200);

        const r3 = await fetchApi('/wallet/verify', {
            method: 'POST', body: JSON.stringify({ wallet: testAddress, signature: sig })
        });
        assert.strictEqual(r3.status, 400);
        assert.ok(r3.data.error.includes('No active challenge'));
    });

    // T-A3-INT-004: Invalid signature + nonce consumed
    await runAsyncTest('T-A3-INT-004: Invalid sig consumes nonce', async () => {
        const r1 = await fetchApi('/wallet/challenge', {
            method: 'POST', body: JSON.stringify({ wallet: testAddress })
        });
        const { challenge, timestamp } = r1.data;
        const invSig = await signChallenge(EIP712_DOMAIN, CHALLENGE_TYPES, 'wrong_nonce', timestamp);

        const r2 = await fetchApi('/wallet/verify', {
            method: 'POST', body: JSON.stringify({ wallet: testAddress, signature: invSig })
        });
        assert.strictEqual(r2.status, 401);

        const r3 = await fetchApi('/wallet/verify', {
            method: 'POST', body: JSON.stringify({ wallet: testAddress, signature: invSig })
        });
        assert.strictEqual(r3.status, 400, 'Nonce should be missing now');
    });

    // T-A3-INT-005/006: Missing field validation
    await runAsyncTest('T-A3-INT-005/006: Missing field validation', async () => {
        const r1 = await fetchApi('/wallet/verify', {
            method: 'POST', body: JSON.stringify({ wallet: testAddress })
        });
        assert.strictEqual(r1.status, 400);
        assert.ok(r1.data.error.includes('signature required'));

        const r2 = await fetchApi('/wallet/challenge', {
            method: 'POST', body: JSON.stringify({})
        });
        assert.strictEqual(r2.status, 400);
        assert.ok(r2.data.error.includes('Valid wallet'));
    });

    // T-A3-INT-008/009: Withdrawal action challenge
    await runAsyncTest('T-A3-INT-008/009: Withdrawal action & mismatch', async () => {
        // create challenge mismatching action
        const rChallenge = await fetchApi('/wallet/challenge', { method: 'POST', body: JSON.stringify({ wallet: testAddress, action: 'challenge' }) });
        const rWithdraw = await fetchApi('/withdraw', { method: 'POST', body: JSON.stringify({ wallet: testAddress, signature: '0x123' }) });
        // It should fail with action error
        assert.strictEqual(rWithdraw.status, 400);
        assert.ok(rWithdraw.data.error.includes('action: "withdrawal"'));
    });

    console.log(`\nTests completed: ${passed} passed, ${failed} failed`);
    return failed > 0 ? 1 : 0;
}

// Start server
console.log('Starting Auxilo test server...');
const serverProcess = spawn('node', ['server.js'], {
    cwd: __dirname + '/..',
    env: { ...process.env, WALLET_PRIVATE_KEY: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' }
});

serverProcess.stderr.on('data', (d) => console.error(d.toString()));

let timedOut = false;
const timer = setTimeout(() => {
    timedOut = true;
    console.error("Test timeout");
    serverProcess.kill();
    process.exit(1);
}, 10000);

setTimeout(async () => {
    if (timedOut) return;
    const exitCode = await runTests();
    serverProcess.kill();
    clearTimeout(timer);
    process.exit(exitCode);
}, 1500);
