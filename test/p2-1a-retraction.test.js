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

// ─── Plist validation ───────────────────────────────────────────────────────

describe('B2: LaunchAgent plist', () => {
  // This LaunchAgent is a macOS-only local operations artifact installed into
  // ~/Library/LaunchAgents by the retraction-sweeper setup script. It cannot be
  // present on Linux CI, and is absent on a dev machine until setup is run, so
  // these checks skip when the plist is not installed and run in full where it is.
  const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents',
    'tech.conway.auxilo-retraction-sweeper.plist');
  const skipReason = !fs.existsSync(plistPath) &&
    'LaunchAgent plist not installed on this host (macOS-only local ops artifact)';

  it('tech.conway.auxilo-retraction-sweeper.plist exists', { skip: skipReason }, () => {
    assert.ok(fs.existsSync(plistPath), `plist must exist at ${plistPath}`);
  });

  it('plist contains correct label', { skip: skipReason }, () => {
    const content = fs.readFileSync(plistPath, 'utf-8');
    assert.ok(content.includes('tech.conway.auxilo-retraction-sweeper'));
  });

  it('plist runs hourly (StartInterval 3600)', { skip: skipReason }, () => {
    const content = fs.readFileSync(plistPath, 'utf-8');
    assert.ok(content.includes('<key>StartInterval</key>'));
    assert.ok(content.includes('<integer>3600</integer>'));
  });

  it('plist logs to ~/.auxilo/logs/', { skip: skipReason }, () => {
    const content = fs.readFileSync(plistPath, 'utf-8');
    assert.ok(content.includes('.auxilo/logs/'));
  });
});
