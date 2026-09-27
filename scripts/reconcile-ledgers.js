#!/usr/bin/env node
'use strict';

/**
 * scripts/reconcile-ledgers.js — ruling R1 ("the two ledgers are never
 * reconciled").
 *
 * Auxilo keeps money in two separate files that must agree but are never
 * cross-checked against each other:
 *
 *   - credits.json  — every buyer's dollar lots. Each paid ("pack") lot
 *     carries its own history of which builder shares it funded
 *     (funded_unlocks), which of those were later reversed, how much of
 *     the pack's price has been refunded (refunded_usd) and how much has
 *     been lost to disputes (dispute_lost_by_id).
 *   - earnings.json — every builder's running balance (pending_balance),
 *     built up over every pack that ever funded a share for them.
 *
 * This is a READ-ONLY check. It changes nothing on disk — it opens both
 * files, computes figures, and prints a report. Run it by hand or from a
 * cron/ops job; it is never imported by server.js and never runs at module
 * load or request time.
 *
 * Usage:
 *   node scripts/reconcile-ledgers.js <data-folder>
 *
 * <data-folder> must contain credits.json and/or earnings.json (produced by
 * lib/credits.js / lib/earnings.js's own save functions). A missing file
 * reads as empty (the same "first use" rule lib/credits.js and
 * lib/account-holds.js already use) — this script is safe to run against a
 * data folder that has never taken a purchase or a payout.
 *
 * Per PACK payment (a dollar_paid lot), reports:
 *   - the paid dollars spent (the total basis of every share ever recorded
 *     against this lot, kept or reversed)
 *   - the shares recorded as funded by it (same figure -- kept it a
 *     separate line for readability, since "recorded" is the historical
 *     fact and "spent" is the money-flow framing of the same number)
 *   - the shares reversed (the basis of every entry marked reversed)
 *   - the shares kept (recorded minus reversed) against 70% of the money
 *     still collected for the pack (original price minus everything
 *     refunded and lost to disputes) -- the invariant every fix in this
 *     unit protects
 *
 * Then cross-checks the two ledgers: for every contributor who appears in
 * ANY pack's funded_unlocks, sums the shares they currently keep across
 * every credit-pack-funded lot and compares that sum against their current
 * earnings.json pending_balance. A contributor's credits-ledger sum should
 * never EXCEED their earnings-ledger balance (they may legitimately hold
 * MORE than the credits-ledger sum, from x402 or router income this script
 * does not touch) -- a contributor where it does is flagged as drift.
 *
 * PUBLIC REPO: the report prints only counts and dollar totals. No
 * account id, email, wallet address, or API key ever appears in the
 * output -- packs and contributors are reported by a sequential index, not
 * by their real identifier.
 */

const fs = require('fs');
const path = require('path');

function round6(v) {
  return Math.round((v + Number.EPSILON) * 1e6) / 1e6;
}

// A missing file (never purchased/paid on this box) reads as empty. Any
// other read/parse failure is refused loudly -- a reconciliation report
// built on a silently-emptied ledger would be worse than no report at all.
function loadJsonOrEmpty(filePath, emptyValue) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return emptyValue;
    throw new Error(`refusing to treat a read failure on ${path.basename(filePath)} as empty: ${err && err.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`refusing to treat a corrupt ${path.basename(filePath)} as empty: ${err && err.message}`);
  }
}

function shareBasis(entry) {
  return round6((entry.contributor_amount || 0) + (entry.platform_amount || 0));
}

function moneyStillCollected(lot) {
  const disputeLost = Object.values(lot.dispute_lost_by_id || {}).reduce((s, v) => s + (v || 0), 0);
  const refunded = (typeof lot.refunded_usd === 'number') ? lot.refunded_usd
    // Backward compatible with a lot written before ruling N14 (the single
    // shared running total) -- read the old field when the new ones are
    // both absent, rather than reporting every pre-fix lot as fully held.
    : (typeof lot.refunded_usd_so_far === 'number' && disputeLost === 0 ? lot.refunded_usd_so_far : 0);
  return round6(Math.max(0, (lot.original_usd || 0) - refunded - disputeLost));
}

function reconcile(dataDir) {
  const credits = loadJsonOrEmpty(path.join(dataDir, 'credits.json'), {});
  const earnings = loadJsonOrEmpty(path.join(dataDir, 'earnings.json'), {});

  const packs = [];
  for (const accountId of Object.keys(credits)) {
    const record = credits[accountId];
    const lots = Array.isArray(record && record.dollar_lots) ? record.dollar_lots : [];
    for (const lot of lots) {
      if (!lot || lot.kind !== 'dollar_paid') continue;
      const funded = Array.isArray(lot.funded_unlocks) ? lot.funded_unlocks : [];
      let recorded = 0, reversed = 0;
      for (const entry of funded) {
        const basis = shareBasis(entry);
        recorded = round6(recorded + basis);
        if (entry.reversed) reversed = round6(reversed + basis);
      }
      const kept = round6(recorded - reversed);
      const held = moneyStillCollected(lot);
      packs.push({
        paidDollarsSpent: recorded, // every dollar a share was ever recorded against, spent from this pack
        sharesRecorded: recorded,
        sharesReversed: reversed,
        sharesKept: kept,
        moneyStillCollected: held,
        over70pct: kept > round6(0.7 * held) + 1e-6,
      });
    }
  }

  // Cross-ledger: sum each contributor's CURRENTLY-KEPT credit-pack shares
  // (across every pack) and compare to their live earnings.json balance.
  const keptByContributor = new Map();
  for (const accountId of Object.keys(credits)) {
    const record = credits[accountId];
    const lots = Array.isArray(record && record.dollar_lots) ? record.dollar_lots : [];
    for (const lot of lots) {
      if (!lot || lot.kind !== 'dollar_paid') continue;
      const funded = Array.isArray(lot.funded_unlocks) ? lot.funded_unlocks : [];
      for (const entry of funded) {
        if (entry.reversed || entry.pending_reversal) continue;
        const contributorId = entry.contributor_account_id;
        if (!contributorId) continue; // wallet-only contributors are out of this cross-check's scope
        const basis = round6(entry.contributor_amount || 0);
        keptByContributor.set(contributorId, round6((keptByContributor.get(contributorId) || 0) + basis));
      }
    }
  }
  const contributorRows = [];
  for (const [contributorId, keptSum] of keptByContributor) {
    const balance = round6((earnings[contributorId] && earnings[contributorId].pending_balance) || 0);
    contributorRows.push({
      creditsLedgerKept: keptSum,
      earningsLedgerBalance: balance,
      drift: keptSum > balance + 1e-6,
      diff: round6(keptSum - balance),
    });
  }

  return { packs, contributorRows };
}

function formatReport(dataDir, { packs, contributorRows }) {
  const lines = [];
  lines.push(`Reconcile ledgers (read-only, changes nothing)`);
  lines.push(`Data folder: ${dataDir}`);
  lines.push('');
  lines.push(`Packs found: ${packs.length}`);

  const totals = packs.reduce((acc, p) => ({
    spent: round6(acc.spent + p.paidDollarsSpent),
    recorded: round6(acc.recorded + p.sharesRecorded),
    reversed: round6(acc.reversed + p.sharesReversed),
    kept: round6(acc.kept + p.sharesKept),
    held: round6(acc.held + p.moneyStillCollected),
  }), { spent: 0, recorded: 0, reversed: 0, kept: 0, held: 0 });
  lines.push(`Total paid dollars spent across all packs: $${totals.spent.toFixed(6)}`);
  lines.push(`Total shares recorded: $${totals.recorded.toFixed(6)}`);
  lines.push(`Total shares reversed: $${totals.reversed.toFixed(6)}`);
  lines.push(`Total shares kept: $${totals.kept.toFixed(6)}`);
  lines.push(`Total money still collected (all packs): $${totals.held.toFixed(6)}`);
  lines.push('');

  packs.forEach((p, i) => {
    lines.push(`Pack #${i + 1}: paid dollars spent $${p.paidDollarsSpent.toFixed(6)} | shares recorded $${p.sharesRecorded.toFixed(6)} | shares reversed $${p.sharesReversed.toFixed(6)} | shares kept $${p.sharesKept.toFixed(6)} | money still collected $${p.moneyStillCollected.toFixed(6)}`);
  });
  lines.push('');

  const overCap = packs.filter((p) => p.over70pct);
  lines.push(`Packs where shares kept exceed 70% of money still collected: ${overCap.length}`);
  overCap.forEach((p) => {
    const idx = packs.indexOf(p) + 1;
    lines.push(`  Pack #${idx}: kept $${p.sharesKept.toFixed(6)} > 70% of held $${p.moneyStillCollected.toFixed(6)} (70% = $${round6(0.7 * p.moneyStillCollected).toFixed(6)})`);
  });
  lines.push('');

  lines.push(`Contributors cross-checked against the earnings ledger: ${contributorRows.length}`);
  const drifted = contributorRows.filter((r) => r.drift);
  lines.push(`Contributors with a mismatch (credits-ledger shares kept exceeds the earnings-ledger balance): ${drifted.length}`);
  drifted.forEach((r, i) => {
    lines.push(`  contributor #${i + 1}: credits-ledger kept $${r.creditsLedgerKept.toFixed(6)}, earnings-ledger shows $${r.earningsLedgerBalance.toFixed(6)} (diff $${r.diff.toFixed(6)})`);
  });

  return lines.join('\n') + '\n';
}

function main() {
  const dataDir = process.argv[2];
  if (!dataDir) {
    process.stderr.write('Usage: node scripts/reconcile-ledgers.js <data-folder>\n');
    process.exit(1);
  }
  const report = reconcile(dataDir);
  process.stdout.write(formatReport(dataDir, report));
}

if (require.main === module) {
  main();
}

module.exports = { reconcile, formatReport, moneyStillCollected, shareBasis };
