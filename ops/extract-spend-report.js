/**
 * ops/extract-spend-report.js — Extraction Spend Report (P2.1a §9.3)
 *
 * Generates a per-account and global spend report for extraction API usage.
 * Intended to run via cron: 0 6 * * * node ops/extract-spend-report.js
 *
 * Per Tyler's email fallback answer: outputs to stdout/log (no SMTP transport).
 *
 * @module ops/extract-spend-report
 */

'use strict';

const fs = require('fs');
const path = require('path');

const AUDIT_FILE = path.join(__dirname, '..', 'data', 'audit-extractions.jsonl');

function generateSpendReport() {
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 86400000).toISOString();

  if (!fs.existsSync(AUDIT_FILE)) {
    console.log('[extract-spend-report] No audit file found.');
    return;
  }

  const content = fs.readFileSync(AUDIT_FILE, 'utf-8');
  const rows = content.split('\n').filter(l => l.trim()).map(l => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(r => r && r.ts && r.ts >= weekAgo);

  if (rows.length === 0) {
    console.log(`[extract-spend-report] No activity in the last 7 days.`);
    return;
  }

  // Per-account aggregation
  const accounts = {};
  let totalCost = 0;

  for (const row of rows) {
    const id = row.account_id || 'unknown';
    if (!accounts[id]) {
      accounts[id] = { extractions: 0, published: 0, cost_usd: 0 };
    }
    accounts[id].extractions++;
    accounts[id].published += (row.published_learning_ids?.length || 0);
    accounts[id].cost_usd += (row.cost_usd || 0);
    totalCost += (row.cost_usd || 0);
  }

  // Daily breakdown
  const dailySpend = {};
  for (const row of rows) {
    const day = row.ts.split('T')[0];
    dailySpend[day] = (dailySpend[day] || 0) + (row.cost_usd || 0);
  }

  console.log(`\n═══════════════════════════════════════════════`);
  console.log(`  Extraction Spend Report — 7-Day Rolling`);
  console.log(`  Generated: ${now.toISOString()}`);
  console.log(`═══════════════════════════════════════════════`);
  console.log(`  Total spend:       $${totalCost.toFixed(4)}`);
  console.log(`  Total extractions: ${rows.length}`);
  console.log(`  Active accounts:   ${Object.keys(accounts).length}`);
  console.log(`\n  Daily breakdown:`);
  for (const [day, spend] of Object.entries(dailySpend).sort()) {
    console.log(`    ${day}: $${spend.toFixed(4)}`);
  }
  console.log(`\n  Per-account:`);
  const sortedAccounts = Object.entries(accounts).sort((a, b) => b[1].cost_usd - a[1].cost_usd);
  for (const [id, stats] of sortedAccounts.slice(0, 20)) {
    console.log(`    ${id}: ${stats.extractions} extractions, ${stats.published} published, $${stats.cost_usd.toFixed(4)}`);
  }
  if (sortedAccounts.length > 20) {
    console.log(`    ... and ${sortedAccounts.length - 20} more accounts`);
  }
  console.log(`═══════════════════════════════════════════════\n`);
}

generateSpendReport();
