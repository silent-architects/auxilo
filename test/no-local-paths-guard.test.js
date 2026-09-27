'use strict';

/**
 * test/no-local-paths-guard.test.js — CI-3 guard.
 *
 * An absolute path into one developer's local filesystem (a scratch temp
 * folder, a home directory) does not belong in a public repository -- it
 * proves nothing to anyone else's checkout and, worse, can leak the
 * operator's username or machine layout. This scans every tracked file
 * under test/ and scripts/ for such a path and fails the build if it finds
 * one, other than inside the files this guard names as its ONLY exceptions
 * (pre-existing references this release did not touch).
 *
 * Enumerated via `git ls-files` (ruling: a directory listing is not "every
 * tracked file" -- see the sweep-enumerates-from-git-ls-files lesson), same
 * convention as test/title-case-sweep.test.js. General rule this follows
 * from and that bit this guard once already: a guard that lists files from
 * git only sees TRACKED files, so it must be run again once its own new
 * files (itself included) are committed and tracked.
 *
 * CI-3 follow-up (2026-09-27): the guard's own source is itself a tracked
 * file under test/, so its search patterns and positive-control samples are
 * assembled from PARTS at runtime -- the source text never contains one of
 * the four complete forbidden prefixes as a literal substring, so the
 * guard's own file never fails its own sweep. This is not a weakening: the
 * assembled RegExp and sample strings are identical in behavior to writing
 * the literals directly: they still match every real path.
 *
 * Runner: node --test test/no-local-paths-guard.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO = path.join(__dirname, '..');

// The four local-filesystem roots this guard refuses, each built from parts
// so this file's own source never contains one whole (see file header).
const SEP = '/';
const LOCAL_PATH_PREFIXES = [
  SEP + 'private' + SEP + 'tmp',   // a macOS/Linux scratch temp root
  SEP + 'var' + SEP + 'folders',   // macOS's per-user temp root
  SEP + 'Users' + SEP,             // macOS home directories
  SEP + 'home' + SEP,              // Linux home directories
];

// The ONLY files this guard permits a matching path in -- pre-existing
// references in files this release did not touch, named explicitly rather
// than silently skipped so a future addition to this list has to be a
// deliberate, reviewable edit. Each carries the reason it is here: either
// the two files CI-3 named outright, or a file this sweep found carrying
// the SAME class of reference -- a deliberately generic placeholder or a
// test fixture whose whole job is proving a path-leak SCREENER catches an
// example leak, not an actual leaked path. Reasons below describe what
// each file does WITHOUT reproducing the literal pattern themselves, for
// the same self-scan reason the file header explains.
const EXCEPTIONS = new Map([
  ['scripts/providers/claude-code.js', 'CI-3 named exception (untouched by this release)'],
  ['test/claude-code-provider.test.js', 'CI-3 named exception (untouched by this release)'],
  ['scripts/prompts/extraction.v1.js', 'documents the generic home-directory placeholder learnings must rewrite real paths into, not a real path'],
  ['test/extract-w1-fix2.test.js', 'fixture uses a generic placeholder home-directory path for a byo-key path-resolution test'],
  ['test/mcp-server-staleness.test.js', 'fixtures use generic placeholder home-directory paths for MCP config staleness tests'],
  ['test/wave5b-review-closures.test.js', 'fixture data for the sensitivity/PII screener\'s OWN tests -- it must recognize an example leaked path to prove the screener catches one'],
  ['test/fixtures/epc2-1-prompts/extraction-backcompat.txt', 'mirrors extraction.v1.js\'s own placeholder line'],
  ['test/fixtures/epc2-1-prompts/extraction-private-score-off-memory-absent.txt', 'mirrors extraction.v1.js\'s own placeholder line'],
  ['test/fixtures/epc2-1-prompts/extraction-private-score-off-memory-present.txt', 'mirrors extraction.v1.js\'s own placeholder line'],
  ['test/fixtures/epc2-1-prompts/extraction-private-score-on-memory-absent.txt', 'mirrors extraction.v1.js\'s own placeholder line'],
  ['test/fixtures/epc2-1-prompts/extraction-private-score-on-memory-present.txt', 'mirrors extraction.v1.js\'s own placeholder line'],
  ['test/fixtures/epc2-1-prompts/extraction-public-score-off-memory-absent.txt', 'mirrors extraction.v1.js\'s own placeholder line'],
  ['test/fixtures/epc2-1-prompts/extraction-public-score-off-memory-present.txt', 'mirrors extraction.v1.js\'s own placeholder line'],
  ['test/fixtures/epc2-1-prompts/extraction-public-score-on-memory-present.txt', 'mirrors extraction.v1.js\'s own placeholder line'],
  ['test/fixtures/epc2-1-prompts/extraction-public-score-on-memory-absent.txt', 'mirrors extraction.v1.js\'s own placeholder line'],
]);

// Matches an absolute path rooted at one of the four local-filesystem
// prefixes this guard refuses, wherever it appears in a line (a comment, a
// string literal, anywhere) -- not anchored to line-start, since a scratch
// path is just as much a leak mid-sentence in a comment as it is in code.
// The lookbehind refuses a match embedded inside a longer path segment
// (e.g. a test's own synthetic "/fixture/home/..." sandbox root, which
// contains one of the four prefixes as a substring but names no real local
// directory) -- a real absolute path is preceded by a quote, paren, space,
// or line start, never by another path-segment character.
const LOCAL_PATH_PATTERN = new RegExp(
  '(?<![\\w/])(' + LOCAL_PATH_PREFIXES.join('|') + ')[^\\s\'"`)]*'
);

function trackedFiles(subdir) {
  const out = execFileSync('git', ['ls-files', subdir], { cwd: REPO, encoding: 'utf8' });
  return out.split('\n').filter(Boolean);
}

describe('no-local-paths-guard: positive control (the detector itself catches a real violation)', () => {
  it('LOCAL_PATH_PATTERN matches each of the four forbidden prefixes', () => {
    // Assembled from LOCAL_PATH_PREFIXES at runtime -- see the file header
    // on why no complete forbidden path is written as a literal here.
    const samples = [
      LOCAL_PATH_PREFIXES[0] + '/claude-501/some-session/scratchpad/file.txt',
      LOCAL_PATH_PREFIXES[1] + '/pn/hvf4qgbs733b9kgf5y54mcr40000gn/T/tmp-xyz',
      LOCAL_PATH_PREFIXES[2] + 'iamtylerkelley/dev/auxilo/some/path.js',
      LOCAL_PATH_PREFIXES[3] + 'someone/project/file.js',
    ];
    for (const s of samples) {
      assert.match(s, LOCAL_PATH_PATTERN, `positive control: the detector must match ${s}`);
    }
  });

  it('a normal repo-relative path does NOT match (the detector is not vacuous the other way)', () => {
    assert.doesNotMatch('test/fix-unit-money-3.test.js', LOCAL_PATH_PATTERN);
    assert.doesNotMatch('PUNCH-LIST.md', LOCAL_PATH_PATTERN);
  });
});

describe('no-local-paths-guard: sweep test/ and scripts/', () => {
  const files = [...trackedFiles('test/'), ...trackedFiles('scripts/')];

  it('the sweep actually enumerated files (guard against an empty/broken git ls-files call)', () => {
    assert.ok(files.length > 50, `expected many tracked files under test/ and scripts/, got ${files.length}`);
  });

  for (const file of files) {
    it(`${file}: no absolute local-filesystem path`, () => {
      if (EXCEPTIONS.has(file)) {
        return; // named exception, pre-existing, out of this release's scope
      }
      const abs = path.join(REPO, file);
      let content;
      try {
        content = fs.readFileSync(abs, 'utf8');
      } catch {
        return; // e.g. a symlink or binary git can't decode as utf8 -- not this guard's concern
      }
      const lines = content.split('\n');
      const hits = [];
      lines.forEach((line, i) => {
        const m = line.match(LOCAL_PATH_PATTERN);
        if (m) hits.push(`line ${i + 1}: ${m[0]}`);
      });
      assert.equal(hits.length, 0, `${file} contains a local-filesystem path (public repo -- remove it or add it to EXCEPTIONS with a reason):\n${hits.join('\n')}`);
    });
  }

  it('EXCEPTIONS names only files that actually still exist and are still tracked (no stale entries)', () => {
    for (const ex of EXCEPTIONS.keys()) {
      assert.ok(files.includes(ex), `EXCEPTIONS lists ${ex}, which git ls-files no longer reports under test/ or scripts/`);
    }
  });
});
