/**
 * test/runner-packaging-closure.test.js: Runner packaging closure invariant
 *
 * The installed runner lives in <home>/.auxilo/bin, copied file-by-file from
 * the npm tarball by lib/installer.js installRunner (RUNNER_STACK). Two sets
 * must therefore stay in sync with the code's actual require graph:
 *
 *   1. package.json "files", or the file never ships in the tarball, and
 *   2. RUNNER_STACK, or the file never reaches ~/.auxilo/bin,
 *
 * and RUNNER_STACK's dest paths must preserve the relative layout so every
 * require() still resolves after the copy. A gap here is invisible in the
 * repo (tests run against the checkout, where everything resolves) and fatal
 * for npm-installed users: the first extraction dies with MODULE_NOT_FOUND.
 * That is exactly how scripts/extract-local.js was lost: runner.js:postExtract
 * requires it lazily, it shipped in "files", but it was missing from
 * RUNNER_STACK, so every npm install had a runner that could never extract.
 *
 * This suite computes the real closure (static relative requires reachable
 * from the installed entry points) and asserts the invariant, so this class
 * of bug fails CI instead of failing users.
 *
 * Runner: node --test test/runner-packaging-closure.test.js
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const { RUNNER_STACK } = require('../lib/installer.js');
const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8'));

// Entry points the installer places in ~/.auxilo/bin that Node executes
// directly (hook → capture-core → runner). Everything they require must
// follow them into the bin tree.
const ENTRY_POINTS = ['scripts/runner.js', 'scripts/capture-core.js'];

/** Match static relative requires: require('./x'), require("../y/z.js"). */
const RELATIVE_REQUIRE_RE = /require\(\s*(['"])(\.{1,2}\/[^'"]+)\1\s*\)/g;

/** Normalize a repo-relative path to forward slashes. */
function norm(p) {
  return p.split(path.sep).join('/');
}

/**
 * Resolve a relative require the way Node does (file, then file.js, then
 * dir/index.js), returning a repo-relative path or null.
 */
function resolveRelative(fromRel, spec) {
  const baseRel = path.posix.join(path.posix.dirname(norm(fromRel)), spec);
  for (const candidate of [baseRel, `${baseRel}.js`, `${baseRel}/index.js`]) {
    const abs = path.join(REPO_ROOT, ...candidate.split('/'));
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return path.posix.normalize(candidate);
  }
  return null;
}

/** List [spec, resolvedRel] pairs for every static relative require in a file. */
function relativeRequiresOf(fileRel) {
  const src = fs.readFileSync(path.join(REPO_ROOT, ...fileRel.split('/')), 'utf-8');
  const out = [];
  for (const m of src.matchAll(RELATIVE_REQUIRE_RE)) {
    out.push([m[2], resolveRelative(fileRel, m[2])]);
  }
  return out;
}

/** BFS the relative-require closure from the entry points. */
function computeClosure() {
  const closure = new Set(ENTRY_POINTS);
  const queue = [...ENTRY_POINTS];
  while (queue.length > 0) {
    const fileRel = queue.shift();
    for (const [spec, resolved] of relativeRequiresOf(fileRel)) {
      assert.ok(resolved, `unresolvable relative require ${spec} in ${fileRel}`);
      if (!closure.has(resolved)) {
        closure.add(resolved);
        queue.push(resolved);
      }
    }
  }
  return closure;
}

/** npm "files" semantics used by this package: dir entries end with '/'. */
function shippedByFilesArray(fileRel) {
  return pkg.files.some((entry) =>
    entry.endsWith('/') ? fileRel.startsWith(entry) : fileRel === entry
  );
}

const closure = computeClosure();
const stackSrcs = new Set(RUNNER_STACK.map(([src]) => src));
const srcToDest = new Map(RUNNER_STACK.map(([src, dest]) => [src, dest]));

describe('Runner packaging closure', () => {
  it('closure walker found the known require graph (sanity)', () => {
    // If the walker regresses to finding nothing, every downstream assertion
    // would pass vacuously, so pin a few known members.
    for (const known of [
      'scripts/runner.js',
      'scripts/extract-local.js',
      'lib/sensitivity-filter.js',
      'scripts/sources/generic-jsonl.js',
    ]) {
      assert.ok(closure.has(known), `closure must include ${known}`);
    }
    assert.ok(closure.size >= 8, `closure unexpectedly small: ${closure.size}`);
  });

  it('every file in the runner require closure ships in package.json files[]', () => {
    for (const fileRel of closure) {
      assert.ok(
        shippedByFilesArray(fileRel),
        `${fileRel} is reachable from the installed runner but not shipped by package.json files[]`
      );
    }
  });

  it('every file in the runner require closure is copied by RUNNER_STACK', () => {
    for (const fileRel of closure) {
      assert.ok(
        stackSrcs.has(fileRel),
        `${fileRel} is reachable from the installed runner but missing from RUNNER_STACK, so ` +
          'npm installs will MODULE_NOT_FOUND at runtime'
      );
    }
  });

  it('RUNNER_STACK dest layout preserves require resolution in ~/.auxilo/bin', () => {
    for (const fileRel of closure) {
      const dest = srcToDest.get(fileRel);
      for (const [spec, resolvedSrc] of relativeRequiresOf(fileRel)) {
        const expectedDest = srcToDest.get(resolvedSrc);
        const resolvedFromDest = path.posix.normalize(
          path.posix.join(path.posix.dirname(dest), spec)
        );
        const matches =
          resolvedFromDest === expectedDest ||
          `${resolvedFromDest}.js` === expectedDest ||
          `${resolvedFromDest}/index.js` === expectedDest;
        assert.ok(
          matches,
          `require('${spec}') in installed ${dest} resolves to ${resolvedFromDest}, ` +
            `but ${resolvedSrc} is installed at ${expectedDest}`
        );
      }
    }
  });

  it('every RUNNER_STACK source file exists in the package', () => {
    for (const [src] of RUNNER_STACK) {
      assert.ok(
        fs.existsSync(path.join(REPO_ROOT, ...src.split('/'))),
        `RUNNER_STACK lists ${src} but it does not exist, so installRunner would throw`
      );
    }
  });

  it('every RUNNER_STACK source file ships in package.json files[]', () => {
    for (const [src] of RUNNER_STACK) {
      assert.ok(
        shippedByFilesArray(src),
        `RUNNER_STACK copies ${src} but package.json files[] does not ship it, so ` +
          'installRunner would throw on npm installs'
      );
    }
  });
});
