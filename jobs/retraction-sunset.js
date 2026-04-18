#!/usr/bin/env node

/**
 * jobs/retraction-sunset.js — Retraction Window Sweeper (P2.1a §5.2 / B2)
 *
 * Walks data/learnings.json and flips retraction_window_active from true → false
 * on any learning where the retraction window has expired (published_at > 7 days ago
 * AND retracted_at is set, meaning the learning was retracted, AND the retraction
 * window is still marked active).
 *
 * Actually, per the spec: retraction_window_active should be flipped false after 7 days
 * from published_at, regardless of whether the user retracted. The window simply expires.
 *
 * Uses the same safeWrite pattern (write tmp, rename) as server.js.
 *
 * Usage:
 *   node jobs/retraction-sunset.js              # production sweep
 *   node jobs/retraction-sunset.js --dry-run    # report only, no writes
 *
 * Scheduled via: ~/Library/LaunchAgents/tech.conway.auxilo-retraction-sweeper.plist
 *
 * @module jobs/retraction-sunset
 */

'use strict';

const fs = require('fs');
const path = require('path');

const LEARNINGS_FILE = path.join(__dirname, '..', 'data', 'learnings.json');
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

// ─── CLI Args ───────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { dryRun: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--dry-run') args.dryRun = true;
  }
  return args;
}

// ─── Safe Write (mirrors server.js:488 pattern) ─────────────────────────────

function safeWrite(filepath, data) {
  const tmp = filepath + '.tmp';
  const content = JSON.stringify(data, null, 2);
  fs.writeFileSync(tmp, content, 'utf-8');
  fs.renameSync(tmp, filepath);
}

// ─── Sweeper Logic ──────────────────────────────────────────────────────────

/**
 * Sweep learnings and flip expired retraction windows.
 *
 * @param {Array<object>} learnings - Array of learning objects
 * @param {number} [now] - Current timestamp (ms), defaults to Date.now()
 * @returns {{ flipped: Array<object>, unchanged: number }}
 */
function sweepRetractionWindows(learnings, now) {
  const currentTime = now || Date.now();
  const flipped = [];

  for (const learning of learnings) {
    if (learning.retraction_window_active !== true) continue;

    const publishedAt = learning.published_at
      ? new Date(learning.published_at).getTime()
      : null;

    if (!publishedAt) continue;

    const age = currentTime - publishedAt;
    if (age > SEVEN_DAYS_MS) {
      learning.retraction_window_active = false;
      flipped.push({
        id: learning.id,
        published_at: learning.published_at,
        age_days: (age / (24 * 60 * 60 * 1000)).toFixed(1),
      });
    }
  }

  return {
    flipped,
    unchanged: learnings.length - flipped.length,
  };
}

// ─── Main ───────────────────────────────────────────────────────────────────

function main() {
  const args = parseArgs(process.argv);

  if (!fs.existsSync(LEARNINGS_FILE)) {
    console.log('[retraction-sunset] No learnings file found. Nothing to sweep.');
    process.exit(0);
  }

  let learnings;
  try {
    learnings = JSON.parse(fs.readFileSync(LEARNINGS_FILE, 'utf-8'));
  } catch (err) {
    console.error(`[retraction-sunset] Failed to parse ${LEARNINGS_FILE}: ${err.message}`);
    process.exit(1);
  }

  if (!Array.isArray(learnings)) {
    console.error('[retraction-sunset] learnings.json is not an array');
    process.exit(1);
  }

  const result = sweepRetractionWindows(learnings);

  // Report
  console.log(`[retraction-sunset] Scanned ${learnings.length} learning(s)`);
  console.log(`[retraction-sunset] Flipped: ${result.flipped.length}, Unchanged: ${result.unchanged}`);
  for (const f of result.flipped) {
    console.log(`  → ${f.id}: published ${f.published_at}, age ${f.age_days}d`);
  }

  // Write
  if (result.flipped.length > 0 && !args.dryRun) {
    safeWrite(LEARNINGS_FILE, learnings);
    console.log('[retraction-sunset] learnings.json updated.');
  } else if (args.dryRun && result.flipped.length > 0) {
    console.log('[retraction-sunset] Dry run — no changes written.');
  }

  process.exit(0);
}

// ─── Exports (for testing) ─────────────────────────────────────────────────

module.exports = {
  parseArgs,
  sweepRetractionWindows,
  safeWrite,
  LEARNINGS_FILE,
  SEVEN_DAYS_MS,
};

if (require.main === module) {
  main();
}
