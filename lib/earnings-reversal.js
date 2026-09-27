'use strict';

/**
 * lib/earnings-reversal.js — AUD-CAC builder-share reversal (spec §0, §4).
 *
 * lib/earnings.js is NOT modified for this build (ruling L11). This module
 * answers spec section 0's question — "can a share be reversed using only
 * what lib/earnings.js already exports?" — with the same mechanism the spec
 * itself describes:
 *
 *   - resolveEarningsEntry(earnings, { account_id, wallet }) finds the
 *     builder's earnings entry, the SAME way server.js already finds it
 *     before crediting a share.
 *   - getWithdrawableBalance(entry) reads the entry's current pending
 *     balance, read-only.
 *
 * The actual debit is inline subtraction here, mirroring exactly how a
 * share is credited today: server.js writes
 * `activeEntry.pending_balance += contributorEarned` directly, inline —
 * lib/earnings.js has no exported "add to balance" function at all, so
 * reversal writes the mirror image, `entry.pending_balance -= amount`,
 * directly, inline, here.
 *
 * `debitWithdrawableBalance` is deliberately NOT used for this. It exists
 * for a real withdrawal payout: it refuses to let the balance go below
 * zero, and it bumps total_withdrawn/withdrawal_count, both of which would
 * misstate a reversal as a payout the builder actually received. A
 * reversal is allowed to take pending_balance below zero — getWithdrawableBalance
 * already treats a negative pending_balance as zero, so both payout rails
 * already refuse to pay anything while a builder's balance sits negative
 * from a reversal, using code that exists today, unmodified.
 */

const { resolveEarningsEntry, getWithdrawableBalance } = require('./earnings.js');
const { acquireEarningsLock } = require('./earnings-lock.js');

function round6(v) {
    return Math.round((v + Number.EPSILON) * 1e6) / 1e6;
}

/**
 * Reverse one funded-unlock record (as returned by
 * lib/credits.js removeDollarLotRemainder's `funded_unlocks` array) against
 * the live earnings map. Mutates `earnings` in place; the caller persists.
 *
 * Ruling M8: takes the SAME acquireEarningsLock the withdrawal rails take
 * around their own balance read+debit, keyed on the resolved entry, for the
 * duration of the mutation — a reversal subtracts from pending_balance, and
 * subtracting with no lock is exactly the unsafe half of the read-modify-
 * write the lock exists to serialize (crediting only ever adds, which is
 * why the credit path could get away without one).
 *
 * Ruling L2: a reversal reduces gross by the contributor share PLUS the
 * platform share (not the contributor share alone), reduces platform by its
 * own share, and updates the per-learning figures the same way — mirroring
 * exactly how a credit adds to all three when the unlock happened.
 *
 * @param {object} earnings — the full earnings map (mutated in place).
 * @param {object} funding — one entry from a dollar lot's funded_unlocks:
 *        { contributor_account_id, contributor_wallet, contributor_amount, platform_amount, learning_id }.
 * @returns {Promise<{ reversed: number, key: string|null, found: boolean }>}
 */
async function reverseOneFundedUnlock(earnings, funding) {
    const amount = round6(funding && funding.contributor_amount || 0);
    if (amount <= 0) {
        return { reversed: 0, key: null, found: false };
    }
    const platformAmount = round6(funding && funding.platform_amount || 0);

    // Peek the key first (read-only) so the lock is keyed on the SAME
    // resolved identity the mutation below uses.
    const peek = resolveEarningsEntry(earnings, {
        account_id: funding.contributor_account_id || null,
        wallet: funding.contributor_wallet || null,
    });
    if (peek.source === 'new') {
        // The entry MUST already exist — it was credited when this unlock
        // happened. If it genuinely doesn't (data loss elsewhere), there is
        // nothing on-ledger to debit; report it rather than silently
        // fabricating a negative entry for an identity with no history.
        return { reversed: 0, key: null, found: false };
    }

    const release = await acquireEarningsLock(peek.key);
    try {
        // Re-resolve under the lock — nothing else in this codebase deletes
        // an earnings entry mid-request, but re-reading is free and removes
        // any doubt that the entry we mutate is the one the lock protects.
        const { key, entry, source } = resolveEarningsEntry(earnings, {
            account_id: funding.contributor_account_id || null,
            wallet: funding.contributor_wallet || null,
        });
        if (source === 'new') {
            return { reversed: 0, key: null, found: false };
        }

        // N3: `funding.id` is this specific funded-unlock entry's own id
        // (lib/credits.js). Once it has been written into this builder's
        // reversals list, it must never be subtracted a second time — a
        // Stripe retry after THIS SAME process's earnings save threw (the
        // in-memory mutation below survives; only the persist failed) finds
        // the identical pending entry again, and an on-the-spot reversal can
        // race a second refund/dispute delivery for the same payment onto
        // the same entry. An entry with no id (nothing to dedupe against)
        // always proceeds, unchanged from before this ruling.
        if (funding.id && Array.isArray(entry.reversals) && entry.reversals.some(r => r.id === funding.id)) {
            return { reversed: 0, key, found: true, alreadyApplied: true };
        }

        // Read-only, per spec §0 — used here only to report the balance a
        // caller may want to log, not to gate the write itself (a reversal
        // is allowed to go negative).
        void getWithdrawableBalance(entry);

        entry.pending_balance   = round6((entry.pending_balance   || 0) - amount);
        entry.total_contributor = round6((entry.total_contributor || 0) - amount);
        entry.total_platform    = round6((entry.total_platform    || 0) - platformAmount);
        entry.total_gross       = round6((entry.total_gross       || 0) - amount - platformAmount);
        if (funding.learning_id && entry.by_learning && entry.by_learning[funding.learning_id]) {
            const bl = entry.by_learning[funding.learning_id];
            bl.contributor = round6((bl.contributor || 0) - amount);
            bl.platform    = round6((bl.platform    || 0) - platformAmount);
            bl.gross       = round6((bl.gross       || 0) - amount - platformAmount);
        }
        entry.last_updated = new Date().toISOString();

        // N3: the id (when this entry carries one) is written into the SAME
        // save that changes the amounts, so a later attempt at this exact
        // entry sees it immediately, in the same in-memory mutation.
        if (!Array.isArray(entry.reversals)) entry.reversals = [];
        entry.reversals.push({
            id: funding.id || null,
            amount,
            platform_amount: platformAmount,
            learning_id: funding.learning_id || null,
            reason: 'dollar_lot_reversal',
            ts: new Date().toISOString(),
        });

        return { reversed: amount, key, found: true };
    } finally {
        release();
    }
}

/**
 * Reverse an entire dollar lot's funded-unlock history (spec test 22/23/27).
 * Idempotent by construction: the caller (lib/credits.js
 * removeDollarLotRemainder) hands back only entries currently marked
 * pending_reversal, so replaying this against the same set twice is
 * harmless (an empty array reverses nothing). Each entry is reversed under
 * its OWN earnings lock (ruling M8) — different builders' entries proceed
 * concurrently; only the SAME entry serializes.
 *
 * @param {object} earnings — the full earnings map (mutated in place).
 * @param {Array}  fundedUnlocks — entries from removeDollarLotRemainder.
 * @returns {Promise<{ totalReversed: number, perEntry: Array }>}
 */
async function reverseLotFunding(earnings, fundedUnlocks) {
    let totalReversed = 0;
    const perEntry = [];
    for (const funding of (fundedUnlocks || [])) {
        const result = await reverseOneFundedUnlock(earnings, funding);
        totalReversed = round6(totalReversed + result.reversed);
        perEntry.push(result);
    }
    return { totalReversed, perEntry };
}

module.exports = {
    reverseOneFundedUnlock,
    reverseLotFunding,
};
