// lib/wallet-lock.js
// Per-wallet async mutex for withdrawal serialization.
// Different from A0's global TxManager mutex — this prevents
// the same wallet from having two withdrawal requests in flight,
// while TxManager serializes actual on-chain broadcasts.

'use strict';

const walletMutexes = new Map(); // walletAddress => { chain: Promise, count: number }

/**
 * Acquire an exclusive lock for a wallet address.
 * Concurrent callers for the SAME wallet queue in FIFO order.
 * Different wallets proceed concurrently.
 * @param {string} walletAddress - lowercase hex address
 * @returns {Promise<Function>} release function — call in finally block
 */
function acquireWalletLock(walletAddress) {
    const addr = walletAddress.toLowerCase();
    if (!walletMutexes.has(addr)) {
        walletMutexes.set(addr, { chain: Promise.resolve(), count: 0 });
    }

    const entry = walletMutexes.get(addr);
    let release;

    const newChain = new Promise((resolve) => {
        release = () => {
            entry.count--;
            if (entry.count === 0) {
                walletMutexes.delete(addr);
            }
            resolve();
        };
    });

    // Caller awaits until previous chain link resolves
    const acquire = entry.chain.then(() => release);
    entry.chain = newChain;
    entry.count++;

    return acquire;
}

/**
 * Get count of wallets with active locks. For health endpoint / debugging.
 * @returns {number}
 */
function getActiveLockCount() {
    return walletMutexes.size;
}

module.exports = { acquireWalletLock, getActiveLockCount };
