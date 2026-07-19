#!/usr/bin/env node

/**
 * jobs/daily-digest.js — Per-Builder Daily Extraction Digest (P2.1a §9.2 / B3;
 * SPEC3 slice A2 — the digest that tells the truth)
 *
 * Two sections:
 *   1. REVIEW QUEUE (queue truth): with ~/.auxilo/credentials.json present,
 *      fetches GET /account/pending/summary and renders the three builder
 *      lanes (SPEC3 §2.2): "Ready to publish" / "Needs a score" /
 *      "Needs your eyes", plus oldest-item age and a dashboard deep link.
 *      Fail-silent: no credentials or unreachable server → log-only digest.
 *      The word "clean" is never rendered (SPEC3 naming rule).
 *   2. ACTIVITY: the extract.log (plain-text, timestamp-prefixed lines written
 *      by scripts/runner.js log()) from the prior 24h window, aggregated
 *      per-Builder. P1-13b: the parser reads the runner's structured tokens
 *      `published=` / `held=` / `rejected=` / `account=` (held joined the
 *      vocabulary when the runner started classifying /learn responses
 *      truthfully instead of counting every 2xx as published).
 *
 * Sends via MailerSend (or falls back to stdout when MAILERSEND_API_KEY is
 * absent).
 *
 * Usage:
 *   node jobs/daily-digest.js                  # production — sends email
 *   node jobs/daily-digest.js --dry-run        # stdout only, no email
 *   node jobs/daily-digest.js --window 48      # override window (hours)
 *
 * Environment:
 *   MAILERSEND_API_KEY  — MailerSend API key (optional, falls back to stdout)
 *   DIGEST_FROM         — sender email address
 *   DIGEST_TO           — recipient email address
 *
 * Exit codes:
 *   0 — success (including empty digest)
 *   1 — hard error
 *
 * Scheduled via: ~/Library/LaunchAgents/io.auxilo.digest.plist
 * SELF-CONTAINED (fs/path/os + global fetch only) — --install-digest copies
 * this file alone to ~/.auxilo/bin/jobs/.
 *
 * @module jobs/daily-digest
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// ─── Configuration ──────────────────────────────────────────────────────────

const EXTRACT_LOG = path.join(os.homedir(), '.auxilo', 'extract.log');
const CREDENTIALS_PATH = path.join(os.homedir(), '.auxilo', 'credentials.json');
const DEFAULT_WINDOW_HOURS = 24;
const SUMMARY_TIMEOUT_MS = 5000;

/** Builder-lane quality floor (mirrors lib/review.js DEFAULT_QUALITY_THRESHOLD
 *  — not required: this file must stay dependency-free for the bin copy). */
const QUALITY_THRESHOLD = 14;

// ─── CLI Args ───────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { dryRun: false, windowHours: DEFAULT_WINDOW_HOURS };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--dry-run') args.dryRun = true;
    else if (argv[i] === '--window' && argv[i + 1]) {
      args.windowHours = parseInt(argv[++i], 10) || DEFAULT_WINDOW_HOURS;
    }
  }
  return args;
}

// ─── Log Parsing ────────────────────────────────────────────────────────────

/**
 * Parse the extract log and return rows within the time window.
 *
 * @param {string} logPath - Path to the extract.log file
 * @param {number} windowHours - Hours to look back
 * @returns {Array<object>} Parsed log rows within the window
 */
function readLogRows(logPath, windowHours) {
  if (!fs.existsSync(logPath)) {
    return []; // Missing log file is NOT an error — empty digest
  }

  const content = fs.readFileSync(logPath, 'utf-8');
  const cutoff = Date.now() - (windowHours * 60 * 60 * 1000);
  const rows = [];
  const seenLines = new Set();

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Extract timestamp from log line format: [2026-04-15T12:00:00.000Z] ...
    const tsMatch = trimmed.match(/^\[(\d{4}-\d{2}-\d{2}T[^\]]+)\]/);
    if (!tsMatch) continue;

    const ts = new Date(tsMatch[1]);
    if (ts.getTime() < cutoff) continue;

    // An exact-duplicate line (same ms timestamp, same text) is a double-write
    // — e.g. stdout redirected into the log on top of log()'s own append —
    // not a repeated event. Count it once or publish totals double.
    if (seenLines.has(trimmed)) continue;
    seenLines.add(trimmed);

    // Parse structured data if present
    const row = {
      timestamp: tsMatch[1],
      line: trimmed,
      builder: null,
      action: null,
      published: 0,
      held: 0,
      rejected: 0,
      category: null,
    };

    // Extract builder/account from log patterns
    const builderMatch = trimmed.match(/account[_=](\S+)/i) ||
                         trimmed.match(/builder[_=](\S+)/i);
    if (builderMatch) row.builder = builderMatch[1];

    // Extract action — structured tokens first, then the legacy human-readable
    // runner vocabulary (lines written before runner.js emitted tokens)
    const legacyPublish = trimmed.match(/(\d+) learning\(s\) published, (\d+) rejected/);
    const legacyFlush = trimmed.match(/Flushed \S+: (\d+) published/);
    if (trimmed.includes('published=')) {
      const pubMatch = trimmed.match(/published=(\d+)/);
      const heldMatch = trimmed.match(/held=(\d+)/);
      const rejMatch = trimmed.match(/rejected=(\d+)/);
      row.action = 'extract';
      row.published = pubMatch ? parseInt(pubMatch[1], 10) : 0;
      row.held = heldMatch ? parseInt(heldMatch[1], 10) : 0;
      row.rejected = rejMatch ? parseInt(rejMatch[1], 10) : 0;
    } else if (legacyPublish) {
      row.action = 'extract';
      row.published = parseInt(legacyPublish[1], 10);
      row.rejected = parseInt(legacyPublish[2], 10);
    } else if (legacyFlush) {
      row.action = 'extract';
      row.published = parseInt(legacyFlush[1], 10);
    } else if (trimmed.includes('retract')) {
      row.action = 'retract';
    } else if (trimmed.includes('Scrub')) {
      row.action = 'scrub';
    } else if (trimmed.includes('Skipped')) {
      row.action = 'skip';
    }

    // Extract category if present
    const catMatch = trimmed.match(/category[=:](\S+)/i);
    if (catMatch) row.category = catMatch[1];

    // Lines with no recognized action (sweep summaries, installer output)
    // carry no digest signal — keeping them fabricates an all-zero "unknown"
    // builder section in the rendered digest.
    if (!row.action) continue;

    rows.push(row);
  }

  return rows;
}

// ─── Aggregation ────────────────────────────────────────────────────────────

/**
 * Aggregate log rows per-builder.
 *
 * @param {Array<object>} rows - Parsed log rows
 * @returns {Map<string, object>} Builder ID → aggregation object
 */
function aggregatePerBuilder(rows) {
  const builders = new Map();

  for (const row of rows) {
    const id = row.builder || 'unknown';
    if (!builders.has(id)) {
      builders.set(id, {
        builderId: id,
        extractionsAttempted: 0,
        publishedCount: 0,
        heldCount: 0,
        rejectedCount: 0,
        retractedCount: 0,
        categories: {},
        totalRows: 0,
      });
    }
    const b = builders.get(id);
    b.totalRows++;

    if (row.action === 'extract') {
      b.extractionsAttempted++;
      b.publishedCount += row.published;
      b.heldCount += row.held || 0;
      b.rejectedCount += row.rejected;
    } else if (row.action === 'retract') {
      b.retractedCount++;
    }

    if (row.category) {
      b.categories[row.category] = (b.categories[row.category] || 0) + 1;
    }
  }

  return builders;
}

/**
 * Get top N categories from a categories map.
 */
function topCategories(categories, n = 3) {
  return Object.entries(categories)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([cat, count]) => `${cat} (${count})`);
}

// ─── Review-queue lanes (SPEC3 §2.2) ────────────────────────────────────────

/**
 * Compute the builder-facing lane for one pending-summary row. Prefers a
 * server-computed `lane` field when present (B1 forward-compat); otherwise
 * derives it from the fields every summary row already carries.
 *
 * @param {object} row  { lane?, screens_passed, quality, flags }
 * @returns {'ready'|'needs_score'|'needs_eyes'}
 */
function laneOf(row) {
  if (row && (row.lane === 'ready' || row.lane === 'needs_score' || row.lane === 'needs_eyes')) {
    return row.lane;
  }
  if (!row || !row.screens_passed) return 'needs_eyes';
  if (row.quality != null && row.quality >= QUALITY_THRESHOLD) return 'ready';
  return 'needs_score';
}

/** Aggregate summary rows into lane counts + oldest-item age (days). */
function laneCounts(summary, now = Date.now()) {
  const counts = { ready: 0, needs_score: 0, needs_eyes: 0, total: 0 };
  let oldestMs = null;
  for (const row of (summary && summary.items) || []) {
    counts[laneOf(row)] += 1;
    counts.total += 1;
    const t = row && row.created_at ? Date.parse(row.created_at) : NaN;
    if (Number.isFinite(t) && (oldestMs === null || t < oldestMs)) oldestMs = t;
  }
  counts.oldest_days = oldestMs === null ? null : Math.floor((now - oldestMs) / 86400000);
  return counts;
}

/** Read ~/.auxilo/credentials.json; null when absent/malformed/keyless. */
function readCredentials(credPath = CREDENTIALS_PATH) {
  try {
    const creds = JSON.parse(fs.readFileSync(credPath, 'utf-8'));
    return creds && typeof creds === 'object' && creds.api_key ? creds : null;
  } catch {
    return null;
  }
}

/**
 * Fetch GET /account/pending/summary — FAIL-SILENT (null on any error or
 * timeout): the digest degrades to log-only, it never crashes on the network.
 */
async function fetchPendingSummary(creds, fetchImpl = fetch) {
  if (!creds) return null;
  const baseUrl = String(creds.base_url || 'https://auxilo.io').replace(/\/+$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SUMMARY_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${baseUrl}/account/pending/summary`, {
      headers: { 'X-API-Key': creds.api_key },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const body = await res.json();
    return body && typeof body === 'object' ? body : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Render the review-queue section (three lanes, SPEC3 naming — the word
 * "clean" is never rendered). Returns [] when the summary is unavailable.
 */
function formatQueueSection(summary) {
  if (!summary || !Array.isArray(summary.items)) return [];
  const lanes = laneCounts(summary);
  const lines = [];
  lines.push('');
  lines.push(`  Review queue: ${lanes.total} learning(s) waiting`);
  lines.push('  ─────────────────────────────────────────');
  lines.push(`    Ready to publish:  ${lanes.ready}`);
  lines.push(`    Needs a score:     ${lanes.needs_score}`);
  lines.push(`    Needs your eyes:   ${lanes.needs_eyes}`);
  if (lanes.oldest_days != null) {
    lines.push(`    Oldest waiting:    ${lanes.oldest_days} day(s)`);
  }
  lines.push('    Review: https://auxilo.io/dashboard  ·  npx auxilo review');
  return lines;
}

// ─── Formatting ─────────────────────────────────────────────────────────────

/**
 * Format a digest as plain text.
 *
 * @param {Map<string, object>} builders - Per-builder aggregation
 * @param {number} windowHours - Window size
 * @param {object|null} [summary] - Pending-review summary (queue truth; optional)
 * @returns {string} Formatted digest text
 */
function formatDigest(builders, windowHours, summary = null) {
  const now = new Date().toISOString().split('T')[0];
  const lines = [];

  lines.push('');
  lines.push('═══════════════════════════════════════════════');
  lines.push(`  Auxilo Extraction Daily Digest — ${now}`);
  lines.push(`  Window: last ${windowHours} hours`);
  lines.push('═══════════════════════════════════════════════');

  // SPEC3 A2: queue truth FIRST — the queue is the thing that silently grew
  // to 441 items; activity counts alone hid it.
  lines.push(...formatQueueSection(summary));

  if (builders.size === 0) {
    lines.push('');
    lines.push('  No extraction activity in this window.');
    lines.push('═══════════════════════════════════════════════');
    lines.push('');
    return lines.join('\n');
  }

  for (const [id, b] of builders) {
    lines.push('');
    lines.push(`  Builder: ${id}`);
    lines.push(`  ─────────────────────────────────────────`);
    lines.push(`    Extractions attempted: ${b.extractionsAttempted}`);
    lines.push(`    Published:             ${b.publishedCount}`);
    lines.push(`    Held for review:       ${b.heldCount}`);
    lines.push(`    Rejected:              ${b.rejectedCount}`);
    lines.push(`    Retracted:             ${b.retractedCount}`);

    const top = topCategories(b.categories);
    if (top.length > 0) {
      lines.push(`    Top categories:        ${top.join(', ')}`);
    }
  }

  lines.push('');
  lines.push('═══════════════════════════════════════════════');
  lines.push('');

  return lines.join('\n');
}

// ─── Email (MailerSend) ─────────────────────────────────────────────────────

/**
 * Send digest via MailerSend API.
 *
 * @param {string} text - Formatted digest text
 * @returns {Promise<boolean>} true on success
 */
async function sendViaMailerSend(text) {
  const apiKey = process.env.MAILERSEND_API_KEY;
  const from = process.env.DIGEST_FROM || 'digest@auxilo.io';
  const to = process.env.DIGEST_TO;

  if (!apiKey || !to) {
    return false;
  }

  try {
    const res = await fetch('https://api.mailersend.com/v1/email', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: { email: from, name: 'Auxilo Digest' },
        to: [{ email: to }],
        subject: `Auxilo Extraction Digest — ${new Date().toISOString().split('T')[0]}`,
        text,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      console.error(`[daily-digest] MailerSend error (${res.status}): ${body}`);
      // Fallback to log file per B3 spec
      const logFallback = path.join(os.homedir(), '.auxilo', 'extract.log');
      fs.appendFileSync(logFallback, `[${new Date().toISOString()}] [digest-email-fail] ${body}\n`);
      return false;
    }

    return true;
  } catch (err) {
    console.error(`[daily-digest] MailerSend network error: ${err.message}`);
    return false;
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv);

  // Read and aggregate
  const rows = readLogRows(EXTRACT_LOG, args.windowHours);
  const builders = aggregatePerBuilder(rows);

  // SPEC3 A2: queue truth (fail-silent — null degrades to log-only digest)
  const summary = await fetchPendingSummary(readCredentials());
  const text = formatDigest(builders, args.windowHours, summary);

  // Try email first (unless dry-run or no API key)
  if (!args.dryRun && process.env.MAILERSEND_API_KEY) {
    const sent = await sendViaMailerSend(text);
    if (sent) {
      console.log('[daily-digest] Digest sent via MailerSend.');
      process.exit(0);
    }
    console.log('[daily-digest] MailerSend failed — falling back to stdout.');
  }

  // Stdout fallback (always works, dev mode)
  console.log(text);
  process.exit(0);
}

// ─── Exports (for testing) ─────────────────────────────────────────────────

module.exports = {
  parseArgs,
  readLogRows,
  aggregatePerBuilder,
  topCategories,
  formatDigest,
  laneOf,
  laneCounts,
  formatQueueSection,
  fetchPendingSummary,
  readCredentials,
  EXTRACT_LOG,
  QUALITY_THRESHOLD,
};

if (require.main === module) {
  main().catch(err => {
    console.error('[daily-digest] Fatal error:', err.message);
    process.exit(1);
  });
}
