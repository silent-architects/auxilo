#!/usr/bin/env node
'use strict';
/*
 * scripts/retract-learnings.js — remove a list of learnings from the live data.
 *
 * The ids to remove are NOT embedded here: they are read from a JSON file
 * passed as the first argument (a plain JSON array of learning id strings).
 * That keeps this script generic and keeps any retraction batch out of the
 * public repo (data/ is gitignored; the operational id list ships via the
 * private deploy runbook).
 *
 * What it does on --apply:
 *   1. Backs up data/learnings.json to data/backups/learnings-pre-retraction-<ts>.json.
 *   2. Filters the listed ids out of data/learnings.json (full removal, not a
 *      status flip) and writes the file back atomically (.tmp + rename, the
 *      same pattern server.js uses).
 *   3. Leaves earnings.json and ratings.jsonl untouched: accrued earnings
 *      remain payable regardless of catalog membership (money-path data is
 *      never mutated here), and orphaned rating lines are inert (all reads
 *      are keyed lookups by id).
 *
 * No separate index or stats recompute is needed: every public stat
 * (/knowledge/stats, /stats, the /earnings and persona-page server renders)
 * is computed from the in-memory learnings array at request time. That array
 * loads from data/learnings.json at boot, so after --apply the caller MUST
 * restart the Fly machine for the running process to pick up the change
 * (the server holds `learnings` in memory and would otherwise overwrite the
 * edit on its next mutation) — same contract as reclassify-pending.js.
 *
 * DRY-RUN by default (writes nothing). Pass --apply to persist.
 * Idempotent: re-running with the same id list finds 0 matches and exits 0
 * without touching the file.
 *
 * Run on the box:  node /tmp/retract-learnings.js /tmp/retract-ids.json            (dry-run)
 *                  node /tmp/retract-learnings.js /tmp/retract-ids.json --apply    (then restart machine)
 */
const fs = require('fs');
const path = require('path');

const APP = process.env.APP_DIR || '/app';
const LEARNINGS = path.join(APP, 'data/learnings.json');
const BACKUP_DIR = path.join(APP, 'data/backups');

const args = process.argv.slice(2).filter(a => a !== '--apply');
const APPLY = process.argv.includes('--apply');
const IDS_FILE = args[0];

function fail(msg) {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

if (!IDS_FILE) {
  fail('usage: node retract-learnings.js <ids-file.json> [--apply]\n  ids-file.json: JSON array of learning id strings');
}
if (!fs.existsSync(IDS_FILE)) fail(`ids file not found: ${IDS_FILE}`);
if (!fs.existsSync(LEARNINGS)) fail(`learnings file not found: ${LEARNINGS} (set APP_DIR if not running on the box)`);

let ids;
try {
  ids = JSON.parse(fs.readFileSync(IDS_FILE, 'utf8'));
} catch (e) {
  fail(`ids file is not valid JSON: ${e.message}`);
}
if (!Array.isArray(ids) || ids.length === 0 || !ids.every(x => typeof x === 'string' && x.length > 0)) {
  fail('ids file must be a non-empty JSON array of id strings');
}
const idSet = new Set(ids);

const raw = JSON.parse(fs.readFileSync(LEARNINGS, 'utf8'));
if (!Array.isArray(raw)) fail('data/learnings.json is not a JSON array; refusing to touch it');

const found = raw.filter(l => idSet.has(l.id));
const foundIds = new Set(found.map(l => l.id));
const notFound = ids.filter(id => !foundIds.has(id));
const kept = raw.filter(l => !idSet.has(l.id));

console.log(`mode: ${APPLY ? 'APPLY' : 'DRY-RUN'}`);
console.log(`ids requested: ${ids.length}`);
console.log(`present in learnings.json: ${found.length}`);
found.forEach(l => console.log(`  - REMOVE ${l.id}  status=${l.status || 'approved(legacy)'}  "${String(l.title || '').slice(0, 60)}"`));
if (notFound.length) {
  console.log(`already absent (idempotent no-op): ${notFound.length}`);
  notFound.forEach(id => console.log(`  - absent ${id}`));
}
console.log(`catalog size: ${raw.length} -> ${kept.length}`);

if (found.length === 0) {
  console.log('\nNothing to do — all listed ids are already absent. Exiting 0.');
  process.exit(0);
}

if (!APPLY) {
  console.log('\nDRY-RUN — no files written. Re-run with --apply to persist, then restart the machine.');
  process.exit(0);
}

// ── APPLY ──
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
const ts = new Date().toISOString().replace(/[:.]/g, '-');
const backupPath = path.join(BACKUP_DIR, `learnings-pre-retraction-${ts}.json`);
fs.writeFileSync(backupPath, JSON.stringify(raw, null, 2));
console.log(`\nbackup written: ${backupPath}`);

const tmp = LEARNINGS + '.tmp';
fs.writeFileSync(tmp, JSON.stringify(kept, null, 2));
fs.renameSync(tmp, LEARNINGS);
console.log(`learnings.json written: ${kept.length} learnings remain.`);
console.log('\nNOW RESTART THE MACHINE so the server reloads the file (see runbook).');
process.exit(0);
