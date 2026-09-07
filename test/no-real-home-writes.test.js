'use strict';
/*
 * test/no-real-home-writes.test.js — TEST-HOME-ISOLATION guard.
 *
 * PUNCH-LIST incident (2026-09-06): the operator's REAL ~/.auxilo/
 * providers.json was found holding a test fixture
 * ({"byo":{"provider":"anthropic","model":"x","api_key":"y"}}) — some
 * provider-state test reached the real HOME instead of an isolated one.
 * scripts/providers/{byo-key,index}.js's DEFAULT_PROVIDERS_STATE_PATH /
 * PROVIDERS_STATE_PATH now honor AUXILO_HOME (falling back to
 * os.homedir()), and scripts/test/run-isolated.js (wired as `npm test`) /
 * scripts/check-test-count.sh (the actual CI gate) both set AUXILO_HOME and
 * HOME to a fresh mkdtemp'd dir for the WHOLE suite run before node starts —
 * see those files. This test is the regression guard on that mechanism: it
 * snapshots the three paths most at risk (the provider-state file itself,
 * the installer's VERSION stamp, and ~/.claude/settings.json, which several
 * modules across this repo write via a bare os.homedir()) at the start of
 * this file's run and asserts nothing about them changed by the end.
 *
 * TEST-HOME-ISOLATION incident 2 (2026-09-06): a committed test
 * (test/extraction-model-stamp.test.js's runner.submitLearnings coverage)
 * called submitLearnings() with no `indexPath`, so lib/extraction-index.js's
 * appendSubmittedLearning() fell through to DEFAULT_INDEX_PATH and wrote 404
 * fixture rows into the operator's REAL ~/.auxilo/extracted-index.jsonl, and
 * touched ~/.auxilo/pending-learnings/ along the way. That test now passes
 * an explicit indexPath (see its Part 2 describe block), and
 * DEFAULT_INDEX_PATH itself now honors AUXILO_HOME the same way the
 * providers-state seam above does — but this guard did not watch either
 * path, so a future test making the same mistake would go undetected. Both
 * are added to WATCHED_PATHS below: the index file like the other watched
 * files (mtime + size), and pending-learnings as a directory (mtime + entry
 * count, since a dropped queue file may not change the directory's own size
 * in a way every filesystem reports usefully).
 *
 * Deliberately uses os.userInfo().homedir, NOT os.homedir() — the whole
 * point of the suite-wide mechanism this guards is to make os.homedir()
 * report a FAKE temp dir for the entire node --test process, so checking
 * os.homedir() here would just watch the fake dir and prove nothing.
 * os.userInfo().homedir reads the OS user database directly (getpwuid on
 * POSIX) and ignores the HOME env var entirely — confirmed empirically:
 * `HOME=/tmp/x node -e "console.log(os.homedir(), os.userInfo().homedir)"`
 * prints the overridden path for the first and the real account home for
 * the second. That makes it the one path-resolution function in Node's
 * stdlib that stays truthful under exactly the override this suite applies
 * to itself — which is precisely why this guard, and only this guard,
 * should ever call it; every other test in this repo should keep using
 * os.homedir() (or an explicit opts seam) like production code does.
 *
 * Scope: this file's own before/after, per the spec (a full-suite guard
 * would need cross-process coordination node --test's default per-file
 * child-process model doesn't give a single test file for free) — the
 * suite-wide AUXILO_HOME/HOME override above is the actual broad guard;
 * this is the cheap regression tripwire on THAT mechanism working at all.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// The REAL account home, immune to this run's AUXILO_HOME/HOME override.
const REAL_HOME = os.userInfo().homedir;

const WATCHED_PATHS = [
  path.join(REAL_HOME, '.auxilo', 'providers.json'),
  path.join(REAL_HOME, '.auxilo', 'bin', 'VERSION'),
  path.join(REAL_HOME, '.claude', 'settings.json'),
  // TEST-HOME-ISOLATION incident 2: the extraction index a test wrote 404
  // fixture rows into, and the pending-learnings dir it touched along the way.
  path.join(REAL_HOME, '.auxilo', 'extracted-index.jsonl'),
  path.join(REAL_HOME, '.auxilo', 'pending-learnings'),
];

function snapshot() {
  return WATCHED_PATHS.map((p) => {
    try {
      const stat = fs.statSync(p);
      const isDir = stat.isDirectory();
      // Directories: watch mtime + entry count (a dropped/removed queue file
      // always changes the entry count, even on filesystems where directory
      // "size" doesn't reflect content changes). Files: watch mtime + size,
      // as the other watched paths in this file already do.
      let entryCount = null;
      if (isDir) {
        try { entryCount = fs.readdirSync(p).length; } catch { entryCount = null; }
      }
      return {
        path: p,
        exists: true,
        isDir,
        mtimeMs: stat.mtimeMs,
        size: isDir ? null : stat.size,
        entryCount,
      };
    } catch (err) {
      return {
        path: p, exists: false, isDir: false, mtimeMs: null, size: null, entryCount: null,
        errCode: err && err.code,
      };
    }
  });
}

describe('TEST-HOME-ISOLATION guard: this test file must not touch the real HOME', () => {
  let baseline;

  before(() => {
    baseline = snapshot();
  });

  it('takes a baseline snapshot of the watched real-HOME paths', () => {
    assert.equal(baseline.length, WATCHED_PATHS.length);
    for (const entry of baseline) {
      assert.equal(typeof entry.exists, 'boolean', `${entry.path}: snapshot must record existence`);
    }
  });

  it('sanity: REAL_HOME resolved via os.userInfo().homedir is a real, non-empty absolute path (not the isolated AUXILO_HOME/HOME override)', () => {
    assert.equal(typeof REAL_HOME, 'string');
    assert.ok(REAL_HOME.length > 0, 'os.userInfo().homedir must not be empty');
    assert.ok(path.isAbsolute(REAL_HOME), 'os.userInfo().homedir must be absolute');
  });

  after(() => {
    const finalSnapshot = snapshot();
    for (let i = 0; i < WATCHED_PATHS.length; i += 1) {
      const before_ = baseline[i];
      const after_ = finalSnapshot[i];
      assert.equal(
        after_.exists,
        before_.exists,
        `${before_.path}: existence changed during this test file's run (before=${before_.exists}, after=${after_.exists}) — something wrote to the real HOME`
      );
      if (before_.exists) {
        assert.equal(
          after_.mtimeMs,
          before_.mtimeMs,
          `${before_.path}: mtime changed during this test file's run — something wrote to the real HOME`
        );
        if (before_.isDir) {
          assert.equal(
            after_.entryCount,
            before_.entryCount,
            `${before_.path}: directory entry count changed during this test file's run — something wrote to the real HOME`
          );
        } else {
          assert.equal(
            after_.size,
            before_.size,
            `${before_.path}: size changed during this test file's run — something wrote to the real HOME`
          );
        }
      }
    }
  });
});
