// lib/pipeline-owner-migration.js
// One-time migration for AC-1 (pipeline-published learnings have no resolvable owner).
//
// The pipeline-approve handler historically wrote the owner as `contributor_id`
// (a field read nowhere else) and the wallet as `account.walletAddress` (always
// undefined — the real field is `account.wallet`). As a result, every pipeline
// learning ended up with `contributor_account_id === undefined` and
// `contributor_wallet === null`, which meant:
//   - the contributor could never retract it (DELETE /learn/:id gates on
//     contributor_account_id),
//   - it never entered the self-review queue,
//   - on unlock, its earnings aggregated into an orphaned, unwithdrawable
//     earnings["null"] bucket.
//
// This migration is idempotent: it only touches learnings that still carry the
// legacy `contributor_id` field or are missing `contributor_account_id`, and it
// only re-attributes the earnings["null"] bucket entries whose learning now has
// a resolvable owner.

'use strict';

const {
    resolveEarningsEntry,
    initEarningsEntry,
    setWalletIndex,
} = require('./earnings.js');

/**
 * Repair pipeline learnings' owner fields and re-attribute the orphaned
 * earnings["null"] bucket. Mutates `learnings` and `earnings` in place.
 *
 * @param {Array<object>} learnings  The live learnings array.
 * @param {object} earnings          The live earnings map.
 * @param {object} accounts          The accounts map (account_id -> account).
 * @returns {{ learningsFixed: number, bucketsReattributed: number, residualNullByLearning: number }}
 */
function migratePipelineOwners(learnings, earnings, accounts) {
    let learningsFixed = 0;

    // 1. Repair owner fields on each affected learning.
    for (const l of learnings) {
        if (!l || typeof l !== 'object') continue;

        const hasLegacyField = Object.prototype.hasOwnProperty.call(l, 'contributor_id');
        const missingAccountId = l.contributor_account_id === undefined || l.contributor_account_id === null;

        // Only act when there is something to fix: a legacy contributor_id present,
        // or an account-id we can still recover from the legacy field.
        if (!hasLegacyField && !missingAccountId) continue;

        let fixed = false;

        // Recover account id from the legacy field if the real one is missing.
        if (missingAccountId && hasLegacyField && l.contributor_id) {
            l.contributor_account_id = l.contributor_id;
            fixed = true;
        }

        // Backfill the wallet from the account record if absent.
        const acctId = l.contributor_account_id;
        if (acctId && accounts && accounts[acctId]) {
            const acct = accounts[acctId];
            if ((l.contributor_wallet === undefined || l.contributor_wallet === null) && acct.wallet) {
                l.contributor_wallet = acct.wallet;
                fixed = true;
            }
        }

        // Drop the stale field so the migration is idempotent on re-run.
        if (hasLegacyField) {
            delete l.contributor_id;
            fixed = true;
        }

        if (fixed) learningsFixed++;
    }

    // 2. Re-attribute the orphaned earnings["null"] bucket.
    let bucketsReattributed = 0;
    let residualNullByLearning = 0;

    const nullBucket = earnings['null'];
    if (nullBucket && nullBucket.by_learning && typeof nullBucket.by_learning === 'object') {
        // Build a learning_id -> owner lookup from the (now-repaired) catalog.
        const ownerByLearning = {};
        for (const l of learnings) {
            if (l && l.id) {
                ownerByLearning[l.id] = {
                    account_id: l.contributor_account_id || null,
                    wallet: l.contributor_wallet || null,
                };
            }
        }

        for (const [lid, data] of Object.entries(nullBucket.by_learning)) {
            const owner = ownerByLearning[lid];
            if (!owner || (!owner.account_id && !owner.wallet)) {
                // Still unresolvable — leave it in the null bucket.
                residualNullByLearning++;
                continue;
            }

            // Resolve (or create) the destination entry for this owner.
            const { key: destKey, entry: destEntry, source } = resolveEarningsEntry(earnings, {
                account_id: owner.account_id,
                wallet: owner.wallet,
            });
            const resolvedKey = (source === 'new') ? (owner.account_id || owner.wallet) : destKey;
            if (source === 'new') {
                earnings[resolvedKey] = initEarningsEntry(owner.account_id, owner.wallet);
                if (owner.account_id && owner.wallet) {
                    setWalletIndex(earnings, String(owner.wallet).toLowerCase(), owner.account_id);
                }
            }
            const dest = earnings[resolvedKey];

            // Move the per-learning sums.
            const g = data.gross || 0, ctr = data.contributor || 0, plt = data.platform || 0, unl = data.unlocks || 0;
            dest.total_gross       = (dest.total_gross       || 0) + g;
            dest.total_contributor = (dest.total_contributor || 0) + ctr;
            dest.total_platform    = (dest.total_platform    || 0) + plt;
            // The contributor share moves into withdrawable balance.
            dest.pending_balance   = (dest.pending_balance   || 0) + ctr;

            if (!dest.by_learning) dest.by_learning = {};
            if (!dest.by_learning[lid]) {
                dest.by_learning[lid] = { gross: 0, contributor: 0, platform: 0, unlocks: 0 };
            }
            dest.by_learning[lid].gross       += g;
            dest.by_learning[lid].contributor += ctr;
            dest.by_learning[lid].platform    += plt;
            dest.by_learning[lid].unlocks     += unl;
            dest.last_updated = new Date().toISOString();

            // Decrement the null bucket totals and remove the moved entry.
            nullBucket.total_gross       = (nullBucket.total_gross       || 0) - g;
            nullBucket.total_contributor = (nullBucket.total_contributor || 0) - ctr;
            nullBucket.total_platform    = (nullBucket.total_platform    || 0) - plt;
            nullBucket.pending_balance   = (nullBucket.pending_balance   || 0) - ctr;
            delete nullBucket.by_learning[lid];

            bucketsReattributed++;
        }

        // Clamp residual null-bucket totals to non-negative and drop it if empty.
        for (const f of ['total_gross', 'total_contributor', 'total_platform', 'pending_balance']) {
            if (typeof nullBucket[f] === 'number' && nullBucket[f] < 0) nullBucket[f] = 0;
        }
        if (Object.keys(nullBucket.by_learning).length === 0 && (nullBucket.pending_balance || 0) <= 1e-6) {
            delete earnings['null'];
        }
    }

    return { learningsFixed, bucketsReattributed, residualNullByLearning };
}

module.exports = { migratePipelineOwners };
