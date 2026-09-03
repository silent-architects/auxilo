#!/usr/bin/env node
'use strict';
/*
 * scripts/backfill-pricing-blocks.js — give every visible learning that has no
 * `pricing` block one, so the daily pricing cron manages it.
 *
 * WHY THIS IS NOT A METADATA MIGRATION. lib/pricing.js getCurrentPrice picks its
 * base by branch: with a stored pricing.base_price it re-derives the base through
 * calculateLearningPrice; without one it falls back to learning.unlock_price, and
 * only then to the formula. So writing a base_price CHANGES WHICH BRANCH A ROW
 * TAKES, which changes the served price. Rows stored at 0.08 are served ~0.067
 * today (base 0.08, clamped to [0.04, 0.24]); their engine base is ~$1.19-$3.49.
 * A naive backfill would raise their price about 25x.
 *
 * SHAPE C (Tyler-ruled 2026-09-02): base_price = the engine's figure, but
 * current_price = the price the row is served TODAY. Nothing changes for buyers
 * at apply; the rows become cron-managed and converge to the engine's number at
 * the shipped +/-15%-per-run damping. The zero-change property is asserted here
 * and in test/price-noblock-backfill.test.js — it is not a comment.
 *
 * ORDER IS LOAD-BEARING. Every row's served price is computed from the
 * PRE-migration catalog snapshot before any block is written, because uniqueness
 * and density are catalog-derived and each write would move the catalog that
 * later rows are priced against.
 *
 *   node scripts/backfill-pricing-blocks.js --expect N
 *   node scripts/backfill-pricing-blocks.js --expect N --apply
 *
 * DRY-RUN by default. On --apply the store is backed up before it is changed and
 * replaced atomically with a sibling .tmp + rename. Restart the machine after a
 * successful apply so the server reloads learnings.json.
 */
const fs = require('fs');
const path = require('path');
const pricing = require('../lib/pricing.js');

const APP = process.env.APP_DIR || '/app';
const LEARNINGS = process.env.AUXILO_LEARNINGS_FILE || path.join(APP, 'data/learnings.json');
const BACKUP_DIR = process.env.AUXILO_BACKUP_DIR || path.join(APP, 'data/backups');

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  let apply = false;
  let expectRaw = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') {
      apply = true;
    } else if (arg === '--expect') {
      expectRaw = argv[++i];
      if (expectRaw === undefined || String(expectRaw).startsWith('--')) fail('--expect requires a value');
    } else {
      fail(`unknown argument: ${arg}`);
    }
  }
  if (expectRaw === null) fail('--expect <count> is required (guards against an unexpected store)');
  const expect = Number(expectRaw);
  if (!Number.isInteger(expect) || expect < 0) fail('--expect must be a non-negative integer');
  return { apply, expect };
}

// Same predicate as server.js visibleCatalog() with CONTENT_MODERATION_ENABLED
// on, which is how prod runs (fly.toml sets it "true").
function visibleCatalog(rows) {
  return rows.filter((l) => l && l.visibility !== 'private' && (!l.status || l.status === 'approved'));
}

function round6(n) {
  return Number(Number(n).toFixed(6));
}

function main() {
  const { apply, expect } = parseArgs(process.argv.slice(2));

  const raw = fs.readFileSync(LEARNINGS, 'utf8');
  const parsed = JSON.parse(raw);
  const rows = Array.isArray(parsed) ? parsed : (parsed.learnings || null);
  if (!Array.isArray(rows)) fail('learnings store is not an array and has no .learnings array');

  const visible = visibleCatalog(rows);
  const selected = visible.filter((l) => !l.pricing);
  const alreadyPriced = visible.length - selected.length;

  console.log(`mode: ${apply ? 'APPLY' : 'DRY-RUN'}`);
  console.log(`shape: C (base_price = engine figure, current_price = today's served price)`);
  console.log(`visible catalog: ${visible.length}`);
  console.log(`already have a pricing block: ${alreadyPriced}`);
  console.log(`selected (visible, no pricing block): ${selected.length}`);
  console.log(`expected: ${expect}`);
  if (selected.length !== expect) {
    fail(`selection is ${selected.length}, expected ${expect}. Nothing written. Re-derive before proceeding.`);
  }
  if (selected.length === 0) {
    console.log('\nNothing to do — every visible learning already has a pricing block.');
    return;
  }

  // ── PASS 1: compute against the PRE-migration snapshot. No writes here. ──
  const snapshot = visible.slice();
  const plan = selected.map((l) => ({
    row: l,
    id: l.id,
    storedUnlockPrice: l.unlock_price,
    servedBefore: round6(pricing.getCurrentPrice(l, snapshot)),
    basePrice: round6(pricing.calculateLearningPrice(l, snapshot)),
    complexity: pricing.classifyComplexity(l),
  }));

  const at008 = plan.filter((p) => Math.abs(Number(p.storedUnlockPrice || 0) - 0.08) < 1e-9);
  const others = plan.filter((p) => !at008.includes(p));
  const stat = (arr, key) => {
    if (!arr.length) return 'n/a';
    const v = arr.map((x) => x[key]);
    const mean = v.reduce((s, x) => s + x, 0) / v.length;
    return `min ${Math.min(...v).toFixed(4)} / mean ${mean.toFixed(4)} / max ${Math.max(...v).toFixed(4)}`;
  };
  console.log(`\nsplit by stored unlock_price:`);
  console.log(`  exactly 0.08: ${at008.length}`);
  console.log(`  other/absent: ${others.length}`);
  console.log(`served price today : ${stat(plan, 'servedBefore')}`);
  console.log(`engine base_price  : ${stat(plan, 'basePrice')}`);

  // ── PASS 2: attach blocks. ──
  const now = new Date().toISOString();
  for (const p of plan) {
    p.row.pricing = {
      base_price: p.basePrice,
      current_price: p.servedBefore,   // SHAPE C: today's served price, not the engine's
      builder_override_price: null,
      complexity: p.complexity,
      last_repriced_at: now,
    };
    p.row.unlock_price = p.servedBefore; // keep the two in step, as the cron does
  }

  // ── The shape's own assertion, against what a BUYER IS QUOTED. ──
  // server.js:8228-8232 resolves an unlock quote as
  //   pricing.current_price || getCurrentPrice(...) || unlock_price || DEFAULT
  // so BEFORE the backfill a blockless row is quoted the engine's live figure,
  // and AFTER it is quoted the stored current_price. Comparing getCurrentPrice
  // on both sides would compare the CRON's target, not the buyer's quote — the
  // target is meant to change, that is the point of the migration.
  const after = visibleCatalog(rows);
  const quote = (l, catalog) => round6(
    (l.pricing && l.pricing.current_price) || pricing.getCurrentPrice(l, catalog) || l.unlock_price || 0.08
  );
  const changed = plan.filter((p) => Math.abs(quote(p.row, after) - p.servedBefore) > 1e-6);
  console.log(`\nrows whose BUYER QUOTE changes at apply: ${changed.length} (shape C requires 0)`);
  if (changed.length > 0) {
    for (const c of changed.slice(0, 5)) {
      console.log(`  ${c.id}: ${c.servedBefore} -> ${quote(c.row, after)}`);
    }
    fail('shape C violated — a buyer quote would change. Nothing written.');
  }

  // Informational: where the cron will take each row, and how far it must travel.
  const targets = plan.map((p) => ({
    id: p.id,
    from: p.servedBefore,
    target: round6(pricing.getCurrentPrice(p.row, after)),
  }));
  const moving = targets.filter((t) => Math.abs(t.target - t.from) > 1e-6);
  console.log(`rows the cron will move from here: ${moving.length} (expected — this is the convergence)`);
  if (moving.length) {
    const ratios = moving.map((t) => t.target / t.from).filter((r) => Number.isFinite(r) && r > 0);
    const runs = (r) => Math.ceil(Math.log(r) / Math.log(1.15));
    const up = ratios.filter((r) => r > 1);
    console.log(`  upward moves: ${up.length}, largest ${Math.max(...(up.length ? up : [1])).toFixed(1)}x`
      + (up.length ? `, reached in ~${runs(Math.max(...up))} cron runs at the 15%/run cap` : ''));
  }

  if (!apply) {
    console.log('\nDRY-RUN — no files written. Re-run with --apply to persist, then restart the machine.');
    return;
  }

  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = now.replace(/[:.]/g, '-');
  const backup = path.join(BACKUP_DIR, `learnings-pre-price-noblock-${stamp}.json`);
  fs.writeFileSync(backup, raw);
  console.log(`\nbackup written: ${backup}`);

  const out = Array.isArray(parsed) ? rows : Object.assign(parsed, { learnings: rows });
  const tmp = `${LEARNINGS}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(out, null, 2));
  fs.renameSync(tmp, LEARNINGS);
  console.log(`learnings.json written: ${plan.length} pricing blocks backfilled.`);
  console.log('\nAPPLIED. NOW RESTART THE MACHINE so the server reloads learnings.json.');
}

main();
