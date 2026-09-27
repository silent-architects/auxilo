'use strict';

/**
 * test/no-local-paths-guard.test.js — CI-3 guard.
 *
 * An absolute path into one developer's local filesystem (a scratch temp
 * folder, a home directory) does not belong in a public repository -- it
 * proves nothing to anyone else's checkout and, worse, can leak the
 * operator's username or machine layout. This scans every tracked file
 * under test/ and scripts/ for such a path and fails the build if it finds
 * one, other than inside the two files this guard names as its ONLY
 * exceptions (pre-existing references this release did not touch).
 *
 * Enumerated via `git ls-files` (ruling: a directory listing is not "every
 * tracked file" -- see the sweep-enumerates-from-git-ls-files lesson), same
 * convention as test/title-case-sweep.test.js.
 *
 * Runner: node --test test/no-local-paths-guard.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO = path.join(__dirname, '..');

// The ONLY files this guard permits a matching path in -- pre-existing
// references in files this release did not touch, named explicitly rather
// than silently skipped so a future addition to this list has to be a
// deliberate, reviewable edit. Each carries the reason it is here: either
// the two files CI-3 named outright, or a file this sweep found carrying
// the SAME class of reference -- a deliberately generic placeholder or a
// test fixture whose whole job is proving a path-leak SCREENER catches an
// example leak, not an actual leaked path.
const EXCEPTIONS = new Map([
  ['scripts/providers/claude-code.js', 'CI-3 named exception (untouched by this release)'],
  ['test/claude-code-provider.test.js', 'CI-3 named exception (untouched by this release)'],
  ['scripts/prompts/extraction.v1.js', 'documents the generic placeholder "/Users/USER/..." learnings must rewrite real paths into, not a real path'],
  ['test/extract-w1-fix2.test.js', 'fixture uses the generic placeholder "/Users/x/..." for a byo-key path-resolution test'],
  ['test/mcp-server-staleness.test.js', 'fixtures use generic placeholders ("/Users/me/...", "cwd: \'/home/user\'") for MCP config staleness tests'],
  ['test/wave5b-review-closures.test.js', 'fixture data for the sensitivity/PII screener\'s OWN tests -- it must recognize an example leaked path to prove the screener catches one'],
  ['test/fixtures/epc2-1-prompts/extraction-backcompat.txt', 'mirrors extraction.v1.js\'s own "/Users/USER/..." placeholder line'],
  ['test/fixtures/epc2-1-prompts/extraction-private-score-off-memory-absent.txt', 'mirrors extraction.v1.js\'s own "/Users/USER/..." placeholder line'],
  ['test/fixtures/epc2-1-prompts/extraction-private-score-off-memory-present.txt', 'mirrors extraction.v1.js\'s own "/Users/USER/..." placeholder line'],
  ['test/fixtures/epc2-1-prompts/extraction-private-score-on-memory-absent.txt', 'mirrors extraction.v1.js\'s own "/Users/USER/..." placeholder line'],
  ['test/fixtures/epc2-1-prompts/extraction-private-score-on-memory-present.txt', 'mirrors extraction.v1.js\'s own "/Users/USER/..." placeholder line'],
  ['test/fixtures/epc2-1-prompts/extraction-public-score-off-memory-absent.txt', 'mirrors extraction.v1.js\'s own "/Users/USER/..." placeholder line'],
  ['test/fixtures/epc2-1-prompts/extraction-public-score-off-memory-present.txt', 'mirrors extraction.v1.js\'s own "/Users/USER/..." placeholder line'],
  ['test/fixtures/epc2-1-prompts/extraction-public-score-on-memory-absent.txt', 'mirrors extraction.v1.js\'s own "/Users/USER/..." placeholder line'],
  ['test/fixtures/epc2-1-prompts/extraction-public-score-on-memory-present.txt', 'mirrors extraction.v1.js\'s own "/Users/USER/..." placeholder line'],
]);

// Matches an absolute path rooted at one of the four local-filesystem
// prefixes this guard refuses, wherever it appears in a line (a comment, a
// string literal, anywhere) -- not anchored to line-start, since a scratch
// path is just as much a leak mid-sentence in a comment as it is in code.
// The lookbehind refuses a match embedded inside a longer path segment
// (e.g. a test's own "/fixture/home/..." sandbox root, which contains
// "/home/" as a substring but names no real home directory) -- a real
// absolute path is preceded by a quote, paren, space, or line start, never
// by another path-segment character.
const LOCAL_PATH_PATTERN = /(?<![\w/])(\/private\/tmp|\/var\/folders|\/Users\/|\/home\/)[^\s'"`)]*/;

function trackedFiles(subdir) {
  const out = execFileSync('git', ['ls-files', subdir], { cwd: REPO, encoding: 'utf8' });
  return out.split('\n').filter(Boolean);
}

describe('no-local-paths-guard: positive control (the detector itself catches a real violation)', () => {
  it('LOCAL_PATH_PATTERN matches each of the four forbidden prefixes', () => {
    const samples = [
      '/private/tmp/claude-501/some-session/scratchpad/file.txt',
      '/var/folders/pn/hvf4qgbs733b9kgf5y54mcr40000gn/T/tmp-xyz',
      '/Users/iamtylerkelley/dev/auxilo/some/path.js',
      '/home/someone/project/file.js',
    ];
    for (const s of samples) {
      assert.match(s, LOCAL_PATH_PATTERN, `positive control: the detector must match ${s}`);
    }
  });

  it('a normal repo-relative path does NOT match (the detector is not vacuous the other way)', () => {
    assert.doesNotMatch('test/fix-unit-money-3.test.js', LOCAL_PATH_PATTERN);
    assert.doesNotMatch('/private/tmp/claude-501/../PUNCH-LIST.md'.replace('/private/tmp/claude-501/../', ''), LOCAL_PATH_PATTERN);
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
