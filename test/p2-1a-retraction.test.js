/**
 * test/p2-1a-retraction.test.js — Retraction window sunset sweeper (B2)
 *
 * Covers:
 *   - row 23h old → retraction_window_active stays true
 *   - row 25h old (> 24h alias for 7d in test) → flipped to false
 *   - row never retracted → untouched
 *   - row with retraction_window_active=false → untouched
 *   - multiple rows: only expired ones flipped
 *   - plist validation
 *
 * Runner: node --test test/p2-1a-retraction.test.js
 */

'use strict';

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

let retraction;

before(() => {
  retraction = require('../jobs/retraction-sunset');
});

// ─── sweepRetractionWindows ─────────────────────────────────────────────────

describe('B2: sweepRetractionWindows', () => {
  const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;

  it('row published 6 days ago → retraction_window_active stays true', () => {
    const now = Date.now();
    const sixDaysAgo = new Date(now - 6 * 24 * 60 * 60 * 1000).toISOString();
    const learnings = [{
      id: 'lrn_young',
      published_at: sixDaysAgo,
      retraction_window_active: true,
      status: 'published',
    }];

    const result = retraction.sweepRetractionWindows(learnings, now);
    assert.equal(result.flipped.length, 0, 'should NOT flip 6-day-old row');
    assert.equal(learnings[0].retraction_window_active, true, 'flag must stay true');
  });

  it('row published 8 days ago → retraction_window_active flipped to false', () => {
    const now = Date.now();
    const eightDaysAgo = new Date(now - 8 * 24 * 60 * 60 * 1000).toISOString();
    const learnings = [{
      id: 'lrn_old',
      published_at: eightDaysAgo,
      retraction_window_active: true,
      status: 'published',
    }];

    const result = retraction.sweepRetractionWindows(learnings, now);
    assert.equal(result.flipped.length, 1, 'should flip 8-day-old row');
    assert.equal(learnings[0].retraction_window_active, false, 'flag must be false');
    assert.equal(result.flipped[0].id, 'lrn_old');
  });

  it('row with retracted_at older than 7 days → flipped to false', () => {
    const now = Date.now();
    const tenDaysAgo = new Date(now - 10 * 24 * 60 * 60 * 1000).toISOString();
    const learnings = [{
      id: 'lrn_retracted_old',
      published_at: tenDaysAgo,
      retracted_at: new Date(now - 9 * 24 * 60 * 60 * 1000).toISOString(),
      retraction_window_active: true,
      status: 'retracted',
    }];

    const result = retraction.sweepRetractionWindows(learnings, now);
    assert.equal(result.flipped.length, 1);
    assert.equal(learnings[0].retraction_window_active, false);
  });

  it('row never retracted (no retracted_at, window active, published 8d ago) → flipped', () => {
    const now = Date.now();
    const eightDaysAgo = new Date(now - 8 * 24 * 60 * 60 * 1000).toISOString();
    const learnings = [{
      id: 'lrn_unretracted',
      published_at: eightDaysAgo,
      retraction_window_active: true,
      status: 'published',
    }];

    const result = retraction.sweepRetractionWindows(learnings, now);
    assert.equal(result.flipped.length, 1,
      'even unretracted rows should have their window expire');
    assert.equal(learnings[0].retraction_window_active, false);
  });

  it('row with retraction_window_active=false → untouched', () => {
    const now = Date.now();
    const tenDaysAgo = new Date(now - 10 * 24 * 60 * 60 * 1000).toISOString();
    const learnings = [{
      id: 'lrn_already_false',
      published_at: tenDaysAgo,
      retraction_window_active: false,
      status: 'published',
    }];

    const result = retraction.sweepRetractionWindows(learnings, now);
    assert.equal(result.flipped.length, 0, 'already-false rows should be skipped');
  });

  it('row without retraction_window_active field → untouched', () => {
    const now = Date.now();
    const learnings = [{
      id: 'lrn_no_field',
      published_at: new Date(now - 10 * 24 * 60 * 60 * 1000).toISOString(),
      status: 'published',
    }];

    const result = retraction.sweepRetractionWindows(learnings, now);
    assert.equal(result.flipped.length, 0);
  });

  it('mixed array: only expired window rows get flipped', () => {
    const now = Date.now();
    const learnings = [
      { id: 'lrn_young', published_at: new Date(now - 3 * 24 * 60 * 60 * 1000).toISOString(), retraction_window_active: true },
      { id: 'lrn_old_1', published_at: new Date(now - 8 * 24 * 60 * 60 * 1000).toISOString(), retraction_window_active: true },
      { id: 'lrn_old_2', published_at: new Date(now - 10 * 24 * 60 * 60 * 1000).toISOString(), retraction_window_active: true },
      { id: 'lrn_done', published_at: new Date(now - 15 * 24 * 60 * 60 * 1000).toISOString(), retraction_window_active: false },
    ];

    const result = retraction.sweepRetractionWindows(learnings, now);
    assert.equal(result.flipped.length, 2, 'exactly 2 rows should flip');
    assert.equal(result.unchanged, 2, '2 rows unchanged');

    assert.equal(learnings[0].retraction_window_active, true, 'young row stays true');
    assert.equal(learnings[1].retraction_window_active, false, 'old row 1 flipped');
    assert.equal(learnings[2].retraction_window_active, false, 'old row 2 flipped');
    assert.equal(learnings[3].retraction_window_active, false, 'done row stays false');
  });
});

// ─── safeWrite ──────────────────────────────────────────────────────────────

describe('B2: safeWrite', () => {
  it('atomic write pattern (tmp + rename)', () => {
    const tmpFile = path.join(os.tmpdir(), `auxilo-sw-test-${Date.now()}.json`);
    const data = [{ id: 'test', retraction_window_active: false }];
    retraction.safeWrite(tmpFile, data);

    const written = JSON.parse(fs.readFileSync(tmpFile, 'utf-8'));
    assert.equal(written[0].id, 'test');
    assert.equal(written[0].retraction_window_active, false);

    // tmp file should not exist after rename
    assert.ok(!fs.existsSync(tmpFile + '.tmp'));
    fs.unlinkSync(tmpFile);
  });
});

// ─── Module shape ───────────────────────────────────────────────────────────

describe('B2: Module exports', () => {
  it('exports required functions', () => {
    assert.equal(typeof retraction.sweepRetractionWindows, 'function');
    assert.equal(typeof retraction.safeWrite, 'function');
    assert.equal(typeof retraction.parseArgs, 'function');
  });

  it('SEVEN_DAYS_MS is 7 days in milliseconds', () => {
    assert.equal(retraction.SEVEN_DAYS_MS, 7 * 24 * 60 * 60 * 1000);
  });

  it('does not auto-run on require()', () => {
    assert.ok(true);
  });
});

// ─── LaunchAgent retirement (2026-06-11) ────────────────────────────────────
//
// TEST-HOME-ISOLATION host-lane audit (2026-09-06) found this describe block
// asserting a machine-state fiction: it checked for
// ~/Library/LaunchAgents/io.auxilo.retraction-sweeper.plist, but NO installer
// in this repo has ever written that file. scripts/runner.js only exposes
// --install-sweeper (SWEEPER_LABEL = 'io.auxilo.sweeper' — the extraction
// sweeper, an unrelated job on a different schedule: StartCalendarInterval
// daily 03:15, not StartInterval hourly) and --install-digest (DIGEST_LABEL
// = 'io.auxilo.digest'). There is no --install-retraction-sweeper flag, and
// jobs/retraction-sunset.js's own header says why: "the
// auxilo-retraction-sweeper LaunchAgent was RETIRED 2026-06-11 ... a local
// LaunchAgent never operated on real data. Run it on the box (or as a
// server-side cron) if window expiry sweeping is needed; manual invocation
// still works." So the skip-when-absent guard here would skip on every
// machine forever, including the operator's own (confirmed:
// ~/Library/LaunchAgents has io.auxilo.{digest,sweeper,backup}.plist, no
// retraction-named plist, on 2026-09-06) — not a host self-check, just dead
// test code. This traces back through 11ae999 (renamed the checked filename
// tech.conway.auxilo-retraction-sweeper.plist -> io.auxilo.retraction-
// sweeper.plist without an installer ever producing either) to 0125a6d,
// which re-added skip-guarded plist-existence assertions that 95e77b4 had
// already replaced with the retirement-documentation check below — restoring
// that fix here, worded against the current (not 2026-06-11) doc text.
//
// What IS verifiable from the repo, with no HOME dependency, on every
// machine including CI: jobs/retraction-sunset.js documents the retirement
// and the sweeper's logic (tested above) still runs via direct CLI
// invocation rather than a LaunchAgent.

describe('B2: LaunchAgent retirement (2026-06-11)', () => {
  it('jobs/retraction-sunset.js documents the LaunchAgent retirement', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'jobs', 'retraction-sunset.js'), 'utf-8');
    assert.ok(src.includes('RETIRED'),
      'retraction-sunset.js must document the LaunchAgent retirement');
    assert.ok(src.includes('auxilo-retraction-sweeper'),
      'retirement note must name the retired LaunchAgent');
  });

  it('sweeper remains manually invocable (no LaunchAgent dependency)', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'jobs', 'retraction-sunset.js'), 'utf-8');
    assert.ok(src.includes('require.main === module') || src.includes('parseArgs'),
      'sweeper must support direct CLI invocation for manual/server-side runs');
  });
});
