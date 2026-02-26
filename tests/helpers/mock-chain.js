/**
 * tests/helpers/mock-chain.js
 *
 * Proxyquire-based mock harness for lib/tx-manager.js.
 * Injects mock viem clients into the REAL module so withMutex,
 * sendUSDC, checkBalance, and checkGasBalance run their actual code
 * with only the RPC layer faked.
 *
 * Usage:
 *   const { createMockTxManager } = require('./mock-chain');
 *   const { txManager, callLog, mockResponses } = createMockTxManager({ ... });
 */

const proxyquire = require('proxyquire').noCallThru();
const { parseUnits, formatUnits } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const { TEST_PRIVATE_KEY } = require('./test-wallet');

/**
 * Create a proxyquire-loaded tx-manager with configurable mock RPC responses.
 *
 * @param {Object} opts
 * @param {number|Function} [opts.nonce=42]           getTransactionCount response
 * @param {string|Function} [opts.txHash='0xabc123']  writeContract response (tx hash)
 * @param {Object|Function} [opts.receipt]             getTransactionReceipt response
 * @param {bigint|Function} [opts.balance]             readContract response (USDC raw)
 * @param {bigint|Function} [opts.ethBalance]           getBalance response (ETH raw)
 * @param {number}          [opts.writeDelay=0]        ms delay on writeContract
 * @param {number}          [opts.receiptDelay=0]      ms delay on getTransactionReceipt
 * @param {Object}          [opts.overrides]            override any mock response by method name
 * @returns {{ txManager: Object, callLog: Array, mockResponses: Object }}
 */
function createMockTxManager(opts = {}) {
    const callLog = [];
    let callSequence = 0;

    const mockResponses = {
        getTransactionCount: opts.nonce ?? 42,
        writeContract: opts.txHash ?? '0xabc123def456789000000000000000000000000000000000000000000000abcd',
        getTransactionReceipt: opts.receipt ?? { status: 'success' },
        readContract: opts.balance ?? 1000000n,       // 1 USDC in raw units
        getBalance: opts.ethBalance ?? 10000000000000000n, // 0.01 ETH
        ...opts.overrides,
    };

    async function resolveResponse(key, args) {
        const resp = mockResponses[key];
        if (typeof resp === 'function') return resp(args);
        return resp;
    }

    const mockPublicClient = {
        getTransactionCount: async (args) => {
            callLog.push({ method: 'getTransactionCount', args, seq: callSequence++, time: Date.now() });
            return resolveResponse('getTransactionCount', args);
        },
        getTransactionReceipt: async (args) => {
            callLog.push({ method: 'getTransactionReceipt', args, seq: callSequence++, time: Date.now() });
            if (opts.receiptDelay) await new Promise(r => setTimeout(r, opts.receiptDelay));
            return resolveResponse('getTransactionReceipt', args);
        },
        readContract: async (args) => {
            callLog.push({ method: 'readContract', args, seq: callSequence++, time: Date.now() });
            return resolveResponse('readContract', args);
        },
        getBalance: async (args) => {
            callLog.push({ method: 'getBalance', args, seq: callSequence++, time: Date.now() });
            return resolveResponse('getBalance', args);
        },
    };

    const mockWalletClient = {
        writeContract: async (args) => {
            callLog.push({ method: 'writeContract', args, seq: callSequence++, time: Date.now() });
            if (opts.writeDelay) await new Promise(r => setTimeout(r, opts.writeDelay));
            return resolveResponse('writeContract', args);
        },
    };

    // Build mock viem module — real parseUnits/formatUnits, mocked client factories
    const mockViem = {
        createPublicClient: () => mockPublicClient,
        createWalletClient: () => mockWalletClient,
        parseUnits,
        formatUnits,
        http: () => 'mock-transport',
        '@noCallThru': true,
    };

    const mockViemAccounts = {
        privateKeyToAccount,
        '@noCallThru': true,
    };

    const mockViemChains = {
        base: { id: 8453, name: 'Base', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 } },
        '@noCallThru': true,
    };

    // Set the test private key before loading the module
    const originalKey = process.env.WALLET_PRIVATE_KEY;
    process.env.WALLET_PRIVATE_KEY = TEST_PRIVATE_KEY;

    const txManager = proxyquire('../../lib/tx-manager', {
        'viem': mockViem,
        'viem/accounts': mockViemAccounts,
        'viem/chains': mockViemChains,
    });

    return {
        txManager,
        callLog,
        mockResponses,
        /** Restore original env var (call in test teardown) */
        cleanup: () => {
            if (originalKey !== undefined) {
                process.env.WALLET_PRIVATE_KEY = originalKey;
            } else {
                delete process.env.WALLET_PRIVATE_KEY;
            }
        },
    };
}

module.exports = { createMockTxManager };
