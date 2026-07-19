#!/usr/bin/env node
'use strict';
/*
 * scripts/pending-triage-report.js - READ-ONLY pending-review backlog analysis.
 *
 * The operator's first stop before any bulk review decision: what is actually
 * sitting in pending_review, how good is it, what did the platform screens say,
 * and what would approve-clean select at each quality threshold. Prints a
 * report; NEVER writes, mutates, or calls any mutating endpoint.
 *
 * Usage:
 *   node scripts/pending-triage-report.js <learnings.json>          local file
 *   node scripts/pending-triage-report.js --file /path/learnings.json
 *   node scripts/pending-triage-report.js --file data.json --account acc_xxx
 *   node scripts/pending-triage-report.js --url https://api.auxilo.io --key axl_xxx
 *   Flags: --top N   preview size (default 10)
 *
 * File mode reads a learnings.json (e.g. copied down from prod) and analyzes
 * every pending_review item in it (optionally one account via --account).
 * URL mode calls GET /account/pending/summary with your API key (read scope)
 * and analyzes YOUR OWN pending queue only.
 *
 * Run this against the backlog first, pick your approve-clean threshold from
 * the threshold table, then run `npx auxilo review --approve-clean`.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const selfReview = require(path.join(__dirname, '..', 'lib', 'self-review.js'));
const reviewLib = require(path.join(__dirname, '..', 'lib', 'review.js'));

function parseArgs(argv) {
  const args = { top: 10 };
  const positional = [];
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--file' || a === '--url' || a === '--key' || a === '--account' || a === '--top') {
      args[a.slice(2)] = argv[++i];
    } else if (a.startsWith('--')) {
      console.error(`Unknown flag: ${a}`);
      process.exit(1);
    } else {
      positional.push(a);
    }
  }
  if (!args.file && positional[0]) args.file = positional[0];
  args.top = parseInt(args.top, 10) || 10;
  return args;
}

function resolveApiKey(args) {
  if (args.key) return args.key;
  if (process.env.AUXILO_API_KEY) return process.env.AUXILO_API_KEY;
  try {
    const creds = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.auxilo', 'credentials.json'), 'utf8'));
    if (creds.api_key) return creds.api_key;
  } catch { /* no credentials file */ }
  return null;
}

function loadRowsFromFile(file, accountFilter) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const all = Array.isArray(raw) ? raw : (raw.learnings || []);

  const byStatus = {};
  for (const l of all) byStatus[l.status || '(none)'] = (byStatus[l.status || '(none)'] || 0) + 1;

  let pending = all.filter((l) => l && l.status === selfReview.PENDING_STATUS);

  const byAccount = {};
  for (const l of pending) {
    const acc = l.contributor_account_id || '(no account)';
    byAccount[acc] = (byAccount[acc] || 0) + 1;
  }
  if (accountFilter) pending = pending.filter((l) => l.contributor_account_id === accountFilter);

  const rows = pending.map(selfReview.projectTriageRow);
  rows.sort((a, b) => {
    const qa = a.quality == null ? -1 : a.quality;
    const qb = b.quality == null ? -1 : b.quality;
    if (qb !== qa) return qb - qa;
    return String(a.created_at || '').localeCompare(String(b.created_at || ''));
  });

  // Near-dup clusters among this pending set (same union rule as the server).
  const pendingIds = new Set(rows.map((r) => r.id));
  const clusterByRoot = new Map();
  for (const r of rows) {
    if (r.possible_duplicate_of && pendingIds.has(r.possible_duplicate_of)) {
      const root = r.possible_duplicate_of;
      if (!clusterByRoot.has(root)) clusterByRoot.set(root, new Set([root]));
      clusterByRoot.get(root).add(r.id);
    }
  }
  const clusters = [...clusterByRoot.values()].filter((s) => s.size >= 2).map((s) => [...s]);

  return { rows, clusters, byStatus, byAccount, total: all.length };
}

async function loadRowsFromUrl(baseUrl, apiKey) {
  const url = `${baseUrl.replace(/\/+$/, '')}/account/pending/summary`;
  const res = await fetch(url, { headers: { 'X-API-Key': apiKey } });
  let body = {};
  try { body = await res.json(); } catch { /* non-JSON */ }
  if (!res.ok) {
    console.error(`Summary fetch failed (HTTP ${res.status}): ${body.error || 'unknown error'}`);
    process.exit(1);
  }
  return {
    rows: body.items || [],
    clusters: body.near_dup_clusters || [],
    byStatus: null,
    byAccount: null,
    total: null,
    accountId: body.account_id,
  };
}

function pct(n, total) {
  return total > 0 ? ` (${Math.round((n / total) * 100)}%)` : '';
}

function printReport(data, args) {
  const { rows, clusters } = data;
  const n = rows.length;

  console.log('\nPENDING-REVIEW TRIAGE REPORT (read-only)');
  console.log('========================================');

  if (data.byStatus) {
    console.log(`\nCatalog file: ${data.total} learnings by status:`);
    for (const [s, c] of Object.entries(data.byStatus).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${s}: ${c}`);
    }
    const accounts = Object.entries(data.byAccount).sort((a, b) => b[1] - a[1]);
    if (accounts.length > 1) {
      console.log(`\nPending by contributor account (pass --account <id> to focus):`);
      for (const [acc, c] of accounts) console.log(`  ${acc}: ${c}`);
    }
  }
  if (data.accountId) console.log(`\nAccount: ${data.accountId}`);

  console.log(`\nPending items analyzed: ${n}`);
  if (n === 0) { console.log('Queue is clear. Nothing to triage.\n'); return; }

  // By screen verdict
  const clean = rows.filter((r) => r.screens_passed);
  const flagCombo = {};
  for (const r of rows) {
    const key = r.screens_passed ? 'clean (passed every screen)' : (r.flags || []).join('+');
    flagCombo[key] = (flagCombo[key] || 0) + 1;
  }
  console.log(`\nBy screen verdict:`);
  for (const [k, c] of Object.entries(flagCombo).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k}: ${c}${pct(c, n)}`);
  }

  // By category
  const byCat = {};
  for (const r of rows) byCat[r.category || '(none)'] = (byCat[r.category || '(none)'] || 0) + 1;
  console.log(`\nBy category:`);
  for (const [k, c] of Object.entries(byCat).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k}: ${c}${pct(c, n)}`);
  }

  // By quality band
  const bands = { '18-20': 0, '14-17': 0, '10-13': 0, below_10: 0, unscored: 0 };
  for (const r of rows) bands[selfReview.qualityBand(r.quality)] += 1;
  console.log(`\nBy quality band (0-20 scale):`);
  for (const [k, c] of Object.entries(bands)) console.log(`  ${k}: ${c}${pct(c, n)}`);

  // Near-dup clusters
  console.log(`\nNear-duplicate clusters among pending: ${clusters.length}`);
  clusters.slice(0, 10).forEach((cl, i) => console.log(`  cluster ${i + 1}: ${cl.join(', ')}`));
  if (clusters.length > 10) console.log(`  ... and ${clusters.length - 10} more`);

  // Approve-clean threshold table (the decision aid)
  console.log(`\nWhat --approve-clean would select at each threshold (clean items only):`);
  console.log(`  threshold  selected   left pending (flagged stays pending regardless: ${n - clean.length})`);
  for (const t of [18, 16, 14, 12, 10, 0]) {
    const sel = reviewLib.selectForBulkApprove(rows, { mode: 'clean', minQuality: t });
    const label = t === 0 ? ' 0 (incl. unscored)' : String(t).padStart(2);
    console.log(`  ${label.padEnd(19)} ${String(sel.selected.length).padStart(4)}       ${String(n - sel.selected.length).padStart(4)}`);
  }
  console.log(`  (default threshold is ${reviewLib.DEFAULT_QUALITY_THRESHOLD}; approve-clean NEVER includes screen-flagged items)`);

  // Top-N preview
  const top = clean.slice(0, args.top);
  console.log(`\nTop ${top.length} clean items by quality (preview):`);
  for (const r of top) {
    const q = r.quality == null ? '--' : String(r.quality).padStart(2);
    console.log(`  q=${q}  ${r.id}  [${r.category || '?'}]  ${String(r.title || '').slice(0, 64)}`);
  }
  console.log(`\nNext step: npx auxilo review --approve-clean [--min-quality N]  (shows the exact list, then requires typing the count)\n`);
}

(async () => {
  const args = parseArgs(process.argv);

  if (!args.file && !args.url) {
    console.error('Usage: node scripts/pending-triage-report.js <learnings.json> | --file <path> [--account acc_x] | --url <base> [--key axl_x]  [--top N]');
    process.exit(1);
  }

  let data;
  if (args.file) {
    if (!fs.existsSync(args.file)) {
      console.error(`File not found: ${args.file}`);
      process.exit(1);
    }
    data = loadRowsFromFile(args.file, args.account);
  } else {
    const apiKey = resolveApiKey(args);
    if (!apiKey) {
      console.error('No API key: pass --key, set AUXILO_API_KEY, or log in via `npx auxilo setup`.');
      process.exit(1);
    }
    data = await loadRowsFromUrl(args.url, apiKey);
  }

  printReport(data, args);
})();
