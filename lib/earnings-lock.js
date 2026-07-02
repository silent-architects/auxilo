// lib/earnings-lock.js
// Per-earnings-entry async mutex (M-1).
//
// The audit found the USDC withdrawal rail (keyed on the wallet via
// lib/wallet-lock.js) and the Stripe withdrawal rail (keyed on the account id
// via an inline account mutex) could run concurrently against the SAME earnings
// entry, because they locked on different keys. This module provides a single
// shared lock keyed on the RESOLVED earnings entry key, so both rails serialize
// against each other when they touch the same withdrawable balance.
//
// Same promise-chaining pattern as lib/wallet-lock.js.

'use strict';

const earningsMutexes = new Map(); // earningsKey => { chain: Promise, count: number }

/**
 * Acquire an exclusive lock for a resolved earnings-entry key.
 * Concurrent callers for the SAME key queue in FIFO order; different keys
 * proceed concurrently. Both the USDC and Stripe withdrawal rails acquire this
 * lock around the balance read+debit critical section so the same earned
 * balance can never be paid out on both rails at once (M-1).
 *
 * @param {string} earningsKey - the key returned by resolveEarningsEntry()
 * @returns {Promise<Function>} release function — call in a finally block
 */
function acquireEarningsLock(earningsKey) {
    const key = String(earningsKey);
    if (!earningsMutexes.has(key)) {
        earningsMutexes.set(key, { chain: Promise.resolve(), count: 0 });
    }

    const entry = earningsMutexes.get(key);
    let release;

    const newChain = new Promise((resolve) => {
        release = () => {
            entry.count--;
            if (entry.count === 0) {
                earningsMutexes.delete(key);
            }
            resolve();
        };
    });

    const acquire = entry.chain.then(() => release);
    entry.chain = newChain;
    entry.count++;

    return acquire;
}

/**
 * Count of earnings keys with active locks. For health/debugging.
 * @returns {number}
 */
function getActiveEarningsLockCount() {
    return earningsMutexes.size;
}

module.exports = { acquireEarningsLock, getActiveEarningsLockCount };
