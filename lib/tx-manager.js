// lib/tx-manager.js
//
// Centralized Transaction Manager for Auxilo's platform wallet.
// ALL on-chain USDC broadcasts go through TxManager.sendUSDC().
// No other module may call walletClient.writeContract() or sendTransaction(),
// with ONE sanctioned exception: lib/x402-router.js (R-01 non-custodial
// settlement) broadcasts router-contract calls from the same account — it
// serializes through the exported withMutex below, so the nonce-race guarantee
// (AUDIT-13) still holds process-wide.
//
// Addresses: AUDIT-13 (nonce race), AUDIT-11 (nonce tracking), C6/AUDIT-14 (private key to env var)

const { createPublicClient, createWalletClient, http, parseUnits, formatUnits } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const { base } = require('viem/chains');

// --- Constants ---
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const ERC20_ABI = [
    {
        name: 'transfer',
        type: 'function',
        stateMutability: 'nonpayable',
        inputs: [
            { name: 'to', type: 'address' },
            { name: 'amount', type: 'uint256' },
        ],
        outputs: [{ type: 'bool' }],
    },
    {
        name: 'balanceOf',
        type: 'function',
        stateMutability: 'view',
        inputs: [{ name: 'account', type: 'address' }],
        outputs: [{ type: 'uint256' }],
    },
];

const CONFIRM_TIMEOUT_MS = 60_000; // 60 seconds to confirm
const CONFIRM_POLL_MS = 2_000;     // poll every 2 seconds

// --- Private Key Loading (C6/AUDIT-14 fix) ---
// Read from environment variable, NOT from disk file.
const privateKey = process.env.WALLET_PRIVATE_KEY;
if (!privateKey) {
    console.error('FATAL: WALLET_PRIVATE_KEY environment variable is not set.');
    console.error('Set it before starting the server: export WALLET_PRIVATE_KEY=0x...');
    process.exit(1);
}

const account = privateKeyToAccount(privateKey);
const WALLET_ADDRESS = account.address;

const publicClient = createPublicClient({
    chain: base,
    transport: http(),
});

const walletClient = createWalletClient({
    account,
    chain: base,
    transport: http(),
});

// --- Startup ETH Balance Warning (IMPL-A0-02: AR-5 compliant) ---
publicClient.getBalance({ address: WALLET_ADDRESS }).then(bal => {
    const ethBalance = parseFloat(formatUnits(bal, 18));
    if (ethBalance < 0.005) {
        console.warn(`WARNING: Platform wallet ETH balance low (${ethBalance.toFixed(6)} ETH). Payouts may fail.`);
    }
}).catch(console.error);

// --- Global Async Mutex ---
// Ensures only one transaction is in flight at a time.
// Queue-based: callers await their turn in FIFO order.
let mutexQueue = Promise.resolve();

function withMutex(fn) {
    let release;
    const next = new Promise((resolve) => { release = resolve; });
    const prev = mutexQueue;
    mutexQueue = next;
    return prev.then(async () => {
        try {
            return await fn();
        } finally {
            release();
        }
    });
}

// --- Core: sendUSDC ---
/**
 * Send USDC from the platform wallet to a recipient.
 * This is the SOLE broadcast interface. All on-chain sends go through here.
 *
 * @param {string} toAddress - recipient wallet address
 * @param {number} amountUSD - amount in USD (e.g. 10.50)
 * @returns {Promise<{ hash: string, status: 'confirmed' | 'timeout' | 'failed', error?: string }>}
 */
async function sendUSDC(toAddress, amountUSD) {
    return withMutex(async () => {
        try {
            // Convert to USDC smallest unit (6 decimals)
            const amount = parseUnits(amountUSD.toFixed(6), 6);

            // Fetch current nonce from the network (AUDIT-11 — managed internally)
            const nonce = await publicClient.getTransactionCount({
                address: WALLET_ADDRESS,
            });

            // Broadcast the USDC transfer
            const hash = await walletClient.writeContract({
                address: USDC_BASE,
                abi: ERC20_ABI,
                functionName: 'transfer',
                args: [toAddress, amount],
                nonce,
            });

            // Wait for confirmation with timeout
            const confirmed = await waitForConfirmation(hash);

            if (confirmed) {
                return { hash, status: 'confirmed' };
            } else {
                return { hash, status: 'timeout' };
            }
        } catch (error) {
            return {
                hash: null,
                status: 'failed',
                error: error.message || 'Unknown broadcast error',
            };
        }
    });
}

// --- Confirmation Waiting ---
async function waitForConfirmation(hash) {
    const start = Date.now();
    while (Date.now() - start < CONFIRM_TIMEOUT_MS) {
        try {
            const receipt = await publicClient.getTransactionReceipt({ hash });
            if (receipt && receipt.status === 'success') {
                return true;
            }
            if (receipt && receipt.status === 'reverted') {
                return false;
            }
        } catch {
            // Transaction not yet mined — continue polling
        }
        await new Promise((r) => setTimeout(r, CONFIRM_POLL_MS));
    }
    return false; // timeout
}

// --- Balance Check ---
/**
 * Check if the platform wallet has sufficient USDC balance.
 * Uses parseFloat(formatUnits(...)) per AR-5.
 *
 * @param {number} requiredAmountUSD - amount needed in USD
 * @returns {Promise<{ sufficient: boolean, balance: number }>}
 */
async function checkBalance(requiredAmountUSD) {
    const balanceRaw = await publicClient.readContract({
        address: USDC_BASE,
        abi: ERC20_ABI,
        functionName: 'balanceOf',
        args: [WALLET_ADDRESS],
    });
    // AR-5: parseFloat(formatUnits(...)) — mandatory pattern
    const balance = parseFloat(formatUnits(balanceRaw, 6));
    return {
        sufficient: balance >= requiredAmountUSD,
        balance,
    };
}

// --- Gas Balance Check (IMPL-A0-04: absorbed from server.js) ---
/**
 * Check if the platform wallet has enough ETH for gas fees.
 * Uses parseFloat(formatUnits(...)) per AR-5.
 *
 * @throws {Error} if ETH balance is too low for gas
 */
async function checkGasBalance() {
    const ethBalanceRaw = await publicClient.getBalance({ address: WALLET_ADDRESS });
    const ethBalance = parseFloat(formatUnits(ethBalanceRaw, 18));
    if (ethBalance < 0.0001) {
        throw new Error('Platform wallet has insufficient ETH for gas. Fund the wallet on Base.');
    }
}

// --- Public Client (for downstream use — settlement resolution, x402 verification) ---
// Exported read-only — no wallet operations.
function getPublicClient() {
    return publicClient;
}

function getWalletAddress() {
    return WALLET_ADDRESS;
}

module.exports = {
    sendUSDC,
    checkBalance,
    checkGasBalance,
    getPublicClient,
    getWalletAddress,
    withMutex,
    USDC_BASE,
    WALLET_ADDRESS,
    ERC20_ABI,
};
