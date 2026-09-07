'use strict';

/**
 * test/prepublish-guard.test.js — STALE-PRIMARY-CHECKOUT guard coverage.
 *
 * scripts/prepublish-guard.js's `check({ run, env })` takes an injectable
 * command runner, so every branch here is exercised with a fake `run` that
 * returns canned output or throws — no real git or network calls, and no
 * dependency on this machine's actual checkout state or network reachability.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { check, PACKAGE_NAME } = require('../scripts/prepublish-guard.js');

const HEAD_SHA = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);

/**
 * Builds a fake `run(cmd)` from a map of exact-command -> value|Error.
 * Any command not in the map throws, so a test only needs to stub the
 * commands relevant to the branch it is exercising.
 */
function fakeRun(responses) {
  return (cmd) => {
    if (!(cmd in responses)) {
      throw new Error(`fakeRun: unexpected command "${cmd}"`);
    }
    const value = responses[cmd];
    if (value instanceof Error) throw value;
    return value;
  };
}

function passingResponses(overrides = {}) {
  return {
    'git fetch origin main --quiet': '',
    'git rev-parse HEAD': HEAD_SHA,
    'git rev-parse origin/main': HEAD_SHA,
    'git status --porcelain': '',
    [`npm view ${PACKAGE_NAME}@0.9.17 version`]: new Error('npm ERR! 404'),
    ...overrides,
  };
}

test('prepublish-guard: passes when HEAD == origin/main, tree clean, version unpublished', () => {
  const result = check({ run: fakeRun(passingResponses()), env: {} });
  assert.equal(result.ok, true);
  assert.equal(result.forced, false);
  assert.equal(result.headSha, HEAD_SHA);
  assert.equal(result.version, '0.9.17');
});

test('prepublish-guard: refuses when HEAD != origin/main', () => {
  const responses = passingResponses({ 'git rev-parse origin/main': OTHER_SHA });
  const result = check({ run: fakeRun(responses), env: {} });
  assert.equal(result.ok, false);
  assert.match(result.reason, /HEAD .* is not origin\/main/);
  assert.match(result.reason, /git checkout --detach origin\/main/);
});

test('prepublish-guard: refuses on a dirty tracked working tree', () => {
  const responses = passingResponses({
    'git status --porcelain': ' M lib/foo.js\n?? scratch.txt',
  });
  const result = check({ run: fakeRun(responses), env: {} });
  assert.equal(result.ok, false);
  assert.match(result.reason, /uncommitted changes to tracked files/);
});

test('prepublish-guard: untracked-only changes do not block (npm files[] is authoritative)', () => {
  const responses = passingResponses({
    'git status --porcelain': '?? scratch.txt\n?? notes.md',
  });
  const result = check({ run: fakeRun(responses), env: {} });
  assert.equal(result.ok, true);
});

test('prepublish-guard: refuses when the current version is already published', () => {
  const responses = passingResponses({
    [`npm view ${PACKAGE_NAME}@0.9.17 version`]: '0.9.17',
  });
  const result = check({ run: fakeRun(responses), env: {} });
  assert.equal(result.ok, false);
  assert.match(result.reason, /already published to the registry/);
});

test('prepublish-guard: refuses with a clear message when git fetch fails (offline)', () => {
  const responses = {
    'git fetch origin main --quiet': new Error('fatal: unable to access origin: Could not resolve host'),
  };
  const result = check({ run: fakeRun(responses), env: {} });
  assert.equal(result.ok, false);
  assert.match(result.reason, /git fetch origin main failed/);
  assert.match(result.reason, /origin unreachable/);
});

test('prepublish-guard: AUXILO_PUBLISH_FORCE=1 bypasses all checks', () => {
  // No responses stubbed at all — if the force path touched `run`, this
  // would throw "unexpected command" and fail the test.
  const result = check({ run: fakeRun({}), env: { AUXILO_PUBLISH_FORCE: '1' } });
  assert.equal(result.ok, true);
  assert.equal(result.forced, true);
});

test('prepublish-guard: AUXILO_PUBLISH_FORCE set to a non-"1" value does NOT bypass', () => {
  const result = check({ run: fakeRun(passingResponses()), env: { AUXILO_PUBLISH_FORCE: 'true' } });
  assert.equal(result.ok, true);
  assert.equal(result.forced, false);
});
