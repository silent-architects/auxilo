/**
 * lib/earnings.js — Phase 0.5 Earnings Helpers (SPEC-P0.5)
 *
 * Provides:
 *   - resolveEarningsEntry(earnings, { account_id?, wallet? })
 *       Central lookup — finds or creates the correct earnings entry.
 *   - initEarningsEntry(account_id, wallet)
 *       Zero-value entry factory.
 *   - getWalletIndex(earnings)
 *       Safe getter for the __wallet_index object.
 *   - setWalletIndex(earnings, wallet, accountId)
 *       Add a wallet → account_id mapping to the index.
 *   - migrateEarningsToAccountKeyed(earnings, accounts, dataDir)
 *       Startup migration: re-keys wallet-keyed entries to account_id where
 *       a matching account (with a .wallet field) exists.
 *   - lazyMigrateOnWalletLink(earnings, wallet, accountId)
 *       Wallet-link migration: re-keys a single wallet-keyed entry when an
 *       account claims that wallet address.
 *   - getWithdrawableBalance(entry)
 *       The ONE authoritative withdrawable balance both rails read/debit.
 *   - debitWithdrawableBalance(entry, amount)
 *       Atomically debit the authoritative balance and bump withdrawal stats.
 *       Used by BOTH the USDC and Stripe withdrawal rails so the same earned
 *       balance can never be withdrawn twice (M-1).
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ─── initEarningsEntry ────────────────────────────────────────────────────────

/**
 * Create a new zero-value earnings entry.
 *
 * @param {string|null} account_id
 * @param {string|null} wallet  Lowercase EVM address or null.
 * @returns {object}
 */
function initEarningsEntry(account_id, wallet) {
    return {
        account_id:           account_id || null,
        wallet:               wallet || null,
        total_gross:          0,
        total_contributor:    0,
        total_platform:       0,
        by_learning:          {},
        last_updated:         null,
        pending_balance:      0,
        // CP-6: Builder Share received before the payee-agency (§5.10) is in force for this
        // Builder is HELD here — non-withdrawable (getWithdrawableBalance reads pending_balance
        // only) — and moved into pending_balance by convertUnassentedToPending() the moment the
        // Builder affirmatively accepts the Terms.
        unassented_pending:   0,
        total_withdrawn:      0,
        withdrawal_count:     0,
        processed_settlements: [],
    };
}

// ─── Wallet Index Helpers ─────────────────────────────────────────────────────

/**
 * Return the __wallet_index object (never null — returns {} when missing).
 *
 * @param {object} earnings  The full earnings map.
 * @returns {object}
 */
function getWalletIndex(earnings) {
    return (earnings.__wallet_index && typeof earnings.__wallet_index === 'object')
        ? earnings.__wallet_index
        : {};
}

/**
 * Add a wallet → accountId mapping to the __wallet_index.
 * Mutates the earnings object in place.
 *
 * @param {object} earnings
 * @param {string} wallet      Lowercase EVM address.
 * @param {string} accountId   acc_… identifier.
 */
function setWalletIndex(earnings, wallet, accountId) {
    if (!earnings.__wallet_index || typeof earnings.__wallet_index !== 'object') {
        earnings.__wallet_index = {};
    }
    earnings.__wallet_index[wallet] = accountId;
}

// ─── resolveEarningsEntry ─────────────────────────────────────────────────────

/**
 * Find or describe the correct earnings entry for a given identity.
 *
 * Resolution order:
 *   1. account_id provided → direct lookup by earnings[account_id].
 *   2. wallet provided → check __wallet_index for a mapped account_id, then
 *      fall back to a direct wallet-keyed entry.
 *   3. Neither found → return a new in-memory entry (caller must persist it).
 *
 * @param {object} earnings  The full earnings map.
 * @param {object} identifiers
 * @param {string|null} [identifiers.account_id]
 * @param {string|null} [identifiers.wallet]
 * @returns {{ key: string, entry: object, source: 'account'|'wallet'|'new' }}
 */
function resolveEarningsEntry(earnings, { account_id = null, wallet = null } = {}) {
    // 1. Direct account_id lookup
    if (account_id && earnings[account_id]) {
        return { key: account_id, entry: earnings[account_id], source: 'account' };
    }

    // 2. Wallet-based resolution
    if (wallet) {
        const walletLower = wallet.toLowerCase();
        const index = getWalletIndex(earnings);

        // 2a. wallet → account via index
        const mappedAccountId = index[walletLower];
        if (mappedAccountId && earnings[mappedAccountId]) {
            return { key: mappedAccountId, entry: earnings[mappedAccountId], source: 'account' };
        }

        // 2b. Legacy direct wallet-keyed entry
        if (earnings[walletLower]) {
            return { key: walletLower, entry: earnings[walletLower], source: 'wallet' };
        }
    }

    // 3. No existing entry — return a new one (caller decides which key to use)
    const newEntry = initEarningsEntry(account_id, wallet ? wallet.toLowerCase() : null);
    return { key: account_id || (wallet ? wallet.toLowerCase() : null), entry: newEntry, source: 'new' };
}

// ─── migrateEarningsToAccountKeyed ───────────────────────────────────────────

/**
 * Startup migration: convert wallet-keyed earnings entries to account-keyed
 * entries for every account that has a .wallet field in accounts.json.
 *
 * Idempotent: already-migrated entries (keys starting with 'acc_') are
 * skipped unchanged.  Unmatched wallet entries are preserved as-is.
 *
 * @param {object} earnings   The live earnings map (mutated in place).
 * @param {object} accounts   The accounts map from accounts.json.
 * @param {string} [dataDir]  Path to the data directory (for backup + write).
 *                            Pass null/undefined to skip file I/O (for unit tests
 *                            that inspect the return value directly).
 * @returns {object}  The mutated earnings map (same reference).
 */
function migrateEarningsToAccountKeyed(earnings, accounts, dataDir) {
    // Build wallet → account_id lookup from accounts.json
    const walletToAccount = {};
    for (const [accountId, account] of Object.entries(accounts || {})) {
        if (account && account.wallet) {
            walletToAccount[account.wallet.toLowerCase()] = accountId;
        }
    }

    // Collect wallet-keyed entries that need migration (keys starting with '0x')
    const walletKeys = Object.keys(earnings).filter(k => k.startsWith('0x'));

    let migrated = 0;
    let unmatched = 0;

    for (const walletKey of walletKeys) {
        const accountId = walletToAccount[walletKey.toLowerCase()];
        if (!accountId) {
            unmatched++;
            continue; // Preserve unmigrated entries
        }

        // IR-H-004 FIX: Account-keyed entry already exists — merge wallet-keyed data into it
        // (Previously this branch silently dropped wallet-keyed data)
        if (earnings[accountId]) {
            const dest = earnings[accountId];
            const walletEntry = earnings[walletKey];

            // Merge numeric totals (additive — both entries may have accumulated earnings)
            dest.total_gross       = (dest.total_gross       || 0) + (walletEntry.total_gross       || 0);
            dest.total_contributor = (dest.total_contributor || 0) + (walletEntry.total_contributor || 0);
            dest.total_platform    = (dest.total_platform    || 0) + (walletEntry.total_platform    || 0);
            dest.pending_balance   = (dest.pending_balance   || 0) + (walletEntry.pending_balance   || 0);
            dest.unassented_pending = (dest.unassented_pending || 0) + (walletEntry.unassented_pending || 0); // CP-6: carry held balance
            dest.total_withdrawn   = (dest.total_withdrawn   || 0) + (walletEntry.total_withdrawn   || 0);
            dest.withdrawal_count  = (dest.withdrawal_count  || 0) + (walletEntry.withdrawal_count  || 0);
            dest.wallet = walletKey.toLowerCase();
            dest.account_id = accountId;

            // Merge by_learning (per-learning-id additive sums)
            if (!dest.by_learning) dest.by_learning = {};
            for (const [lid, data] of Object.entries(walletEntry.by_learning || {})) {
                if (!dest.by_learning[lid]) {
                    dest.by_learning[lid] = { gross: 0, contributor: 0, platform: 0, unlocks: 0 };
                }
                dest.by_learning[lid].gross       += (data.gross       || 0);
                dest.by_learning[lid].contributor  += (data.contributor || 0);
                dest.by_learning[lid].platform     += (data.platform    || 0);
                dest.by_learning[lid].unlocks      += (data.unlocks     || 0);
            }

            // Merge processed_settlements (deduplicated)
            const srcSettlements = Array.isArray(walletEntry.processed_settlements)
                ? walletEntry.processed_settlements
                : Object.keys(walletEntry.processed_settlements || {});
            if (!Array.isArray(dest.processed_settlements)) {
                dest.processed_settlements = dest.processed_settlements && typeof dest.processed_settlements === 'object'
                    ? Object.keys(dest.processed_settlements)
                    : [];
            }
            for (const sid of srcSettlements) {
                if (!dest.processed_settlements.includes(sid)) {
                    dest.processed_settlements.push(sid);
                }
            }

            setWalletIndex(earnings, walletKey.toLowerCase(), accountId);
            delete earnings[walletKey];
            migrated++;
            continue;
        }

        const oldEntry = earnings[walletKey];

        // Build the new account-keyed entry
        const newEntry = {
            ...oldEntry,
            account_id: accountId,
            wallet:     walletKey.toLowerCase(),
        };

        // Ensure processed_settlements is an array (old entries may use object form)
        if (!Array.isArray(newEntry.processed_settlements)) {
            if (newEntry.processed_settlements && typeof newEntry.processed_settlements === 'object') {
                // Convert object-keyed format to array of keys
                newEntry.processed_settlements = Object.keys(newEntry.processed_settlements);
            } else {
                newEntry.processed_settlements = [];
            }
        }

        earnings[accountId] = newEntry;
        setWalletIndex(earnings, walletKey.toLowerCase(), accountId);
        delete earnings[walletKey];
        migrated++;
    }

    console.log(
        `[migration] Migrated ${migrated} earnings entries to account-keyed format. ` +
        `${unmatched} entries remain wallet-keyed (unclaimed).`
    );

    // File I/O: only when dataDir is provided (allows pure unit testing)
    if (dataDir) {
        const earningsFile = path.join(dataDir, 'earnings.json');

        // Pre-migration backup
        try {
            const ts = Date.now();
            const backupPath = earningsFile + `.pre-migration-${ts}`;
            const current = fs.existsSync(earningsFile)
                ? fs.readFileSync(earningsFile, 'utf8')
                : '{}';
            fs.writeFileSync(backupPath, current);
        } catch (e) {
            console.warn('[migration] Pre-migration backup failed:', e.message);
        }

        // Atomic write
        const tmp = earningsFile + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(earnings, null, 2));
        fs.renameSync(tmp, earningsFile);
    }

    return earnings;
}

// ─── lazyMigrateOnWalletLink ──────────────────────────────────────────────────

/**
 * When an account links a wallet, check for a pre-existing wallet-keyed
 * earnings entry and re-key it to the account_id.
 *
 * Mutates the earnings object in place.  Does NOT write to disk — caller is
 * responsible for persisting via safeWrite().
 *
 * @param {object} earnings    The live earnings map (mutated in place).
 * @param {string} wallet      Lowercase EVM address being linked.
 * @param {string} accountId   The account claiming the wallet.
 * @returns {boolean}  true if a wallet-keyed entry was migrated, false otherwise.
 */
function lazyMigrateOnWalletLink(earnings, wallet, accountId) {
    const walletLower = wallet.toLowerCase();
    const walletEntry = earnings[walletLower];

    if (!walletEntry) {
        // No pre-existing wallet entry — just update the index
        setWalletIndex(earnings, walletLower, accountId);
        return false;
    }

    // A wallet-keyed entry exists — check if account-keyed entry already exists
    if (earnings[accountId]) {
        // Account-keyed entry already present (shouldn't happen in practice, but be safe)
        // Merge the wallet-keyed entry into the account-keyed one
        const dest = earnings[accountId];
        dest.total_gross       = (dest.total_gross       || 0) + (walletEntry.total_gross       || 0);
        dest.total_contributor = (dest.total_contributor || 0) + (walletEntry.total_contributor || 0);
        dest.total_platform    = (dest.total_platform    || 0) + (walletEntry.total_platform    || 0);
        dest.pending_balance   = (dest.pending_balance   || 0) + (walletEntry.pending_balance   || 0);
        dest.unassented_pending = (dest.unassented_pending || 0) + (walletEntry.unassented_pending || 0); // CP-6: carry held balance
        dest.total_withdrawn   = (dest.total_withdrawn   || 0) + (walletEntry.total_withdrawn   || 0);
        dest.withdrawal_count  = (dest.withdrawal_count  || 0) + (walletEntry.withdrawal_count  || 0);
        dest.wallet = walletLower;
        dest.account_id = accountId;

        // Merge by_learning
        for (const [lid, data] of Object.entries(walletEntry.by_learning || {})) {
            if (!dest.by_learning[lid]) {
                dest.by_learning[lid] = { gross: 0, contributor: 0, platform: 0, unlocks: 0 };
            }
            dest.by_learning[lid].gross       += (data.gross       || 0);
            dest.by_learning[lid].contributor  += (data.contributor || 0);
            dest.by_learning[lid].platform     += (data.platform    || 0);
            dest.by_learning[lid].unlocks      += (data.unlocks     || 0);
        }

        // Merge processed_settlements
        const srcSettlements = Array.isArray(walletEntry.processed_settlements)
            ? walletEntry.processed_settlements
            : Object.keys(walletEntry.processed_settlements || {});
        if (!Array.isArray(dest.processed_settlements)) {
            dest.processed_settlements = [];
        }
        for (const sid of srcSettlements) {
            if (!dest.processed_settlements.includes(sid)) {
                dest.processed_settlements.push(sid);
            }
        }

        delete earnings[walletLower];
    } else {
        // Re-key wallet entry to account_id
        const newEntry = {
            ...walletEntry,
            account_id: accountId,
            wallet:     walletLower,
        };

        // Normalise processed_settlements to array form
        if (!Array.isArray(newEntry.processed_settlements)) {
            if (newEntry.processed_settlements && typeof newEntry.processed_settlements === 'object') {
                newEntry.processed_settlements = Object.keys(newEntry.processed_settlements);
            } else {
                newEntry.processed_settlements = [];
            }
        }

        earnings[accountId] = newEntry;
        delete earnings[walletLower];
    }

    // Update index regardless of which branch ran
    setWalletIndex(earnings, walletLower, accountId);
    return true;
}

// ─── Unified Withdrawable Balance (M-1) ───────────────────────────────────────
//
// The audit (M-1) found that the USDC rail debited `pending_balance` while the
// Stripe rail computed `total_contributor − sum(WITHDRAWALS_FILE)` — two
// independent ledgers over the SAME earnings entry. A contributor with both a
// wallet and a Stripe Connect account could therefore withdraw the same earned
// balance twice (once as USDC, once as USD), draining real platform funds.
//
// The fix unifies on ONE authoritative withdrawable-balance field —
// `pending_balance` — credited once on unlock and debited by BOTH rails through
// the helpers below. `total_contributor` becomes a lifetime-gross metric only;
// it is never a balance and is never debited.

/**
 * The single authoritative withdrawable balance, used identically by both the
 * USDC and Stripe withdrawal rails. Returns a non-negative number.
 *
 * @param {object} entry  An earnings entry (from resolveEarningsEntry).
 * @returns {number}      The current withdrawable balance in USD.
 */
function getWithdrawableBalance(entry) {
    if (!entry || typeof entry.pending_balance !== 'number' || !isFinite(entry.pending_balance)) {
        return 0;
    }
    return entry.pending_balance < 0 ? 0 : entry.pending_balance;
}

/**
 * Atomically debit the authoritative withdrawable balance and bump the shared
 * withdrawal counters. Both rails call this under the same lock so the same
 * earned balance can never be paid out twice (M-1).
 *
 * Mutates `entry` in place. Throws RangeError if `amount` exceeds the available
 * balance (the caller must have already gated on getWithdrawableBalance) — this
 * is a defensive last line so an accounting bug can never overpay.
 *
 * `total_contributor` is deliberately NOT touched here: it is lifetime-gross.
 *
 * @param {object} entry   The earnings entry to debit (mutated in place).
 * @param {number} amount  The gross withdrawal amount in USD to debit.
 * @returns {number}       The remaining pending_balance after the debit.
 */
function debitWithdrawableBalance(entry, amount) {
    if (!entry) throw new TypeError('debitWithdrawableBalance: entry is required');
    if (typeof amount !== 'number' || !isFinite(amount) || amount <= 0) {
        throw new RangeError('debitWithdrawableBalance: amount must be a positive finite number');
    }
    const available = getWithdrawableBalance(entry);
    // Tolerate sub-micro floating-point dust so a legitimate full-balance
    // withdrawal isn't rejected, but never allow a real overdraw.
    if (amount > available + 1e-6) {
        throw new RangeError(
            `debitWithdrawableBalance: amount ${amount} exceeds available ${available}`
        );
    }
    entry.pending_balance   = parseFloat((available - amount).toFixed(6));
    if (entry.pending_balance < 0) entry.pending_balance = 0;
    entry.total_withdrawn   = parseFloat(((entry.total_withdrawn || 0) + amount).toFixed(6));
    entry.withdrawal_count  = (entry.withdrawal_count || 0) + 1;
    return entry.pending_balance;
}

/**
 * CP-6: Move a Builder's HELD (unassented) balance into the withdrawable pending_balance.
 * Called when a Builder affirmatively accepts the Terms and the payee-agency (§5.10) becomes
 * in force: Builder Share received on their behalf BEFORE assent was quarantined in
 * `unassented_pending` (non-withdrawable — getWithdrawableBalance reads pending_balance only);
 * acceptance is the moment it becomes agency-covered and withdrawable. Idempotent (no-op when
 * the held bucket is 0 or the entry is new/absent). Mutates `earnings` in place; the caller
 * persists.
 *
 * @param {object} earnings  The full earnings map.
 * @param {object} identifiers { account_id?, wallet? }
 * @returns {number}  The amount moved (0 if none).
 */
function convertUnassentedToPending(earnings, { account_id = null, wallet = null } = {}) {
    const { entry, source } = resolveEarningsEntry(earnings, { account_id, wallet });
    if (!entry || source === 'new') return 0;
    const held = (typeof entry.unassented_pending === 'number' && isFinite(entry.unassented_pending) && entry.unassented_pending > 0)
        ? entry.unassented_pending
        : 0;
    if (held <= 0) return 0;
    entry.pending_balance = parseFloat(((entry.pending_balance || 0) + held).toFixed(6));
    entry.unassented_pending = 0;
    entry.last_updated = new Date().toISOString();
    return held;
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
    resolveEarningsEntry,
    initEarningsEntry,
    getWalletIndex,
    setWalletIndex,
    migrateEarningsToAccountKeyed,
    lazyMigrateOnWalletLink,
    getWithdrawableBalance,
    debitWithdrawableBalance,
    convertUnassentedToPending,
};
