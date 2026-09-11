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
    'npm whoami': 'someuser',
    'git fetch origin main --quiet': '',
    'git rev-parse HEAD': HEAD_SHA,
    'git rev-parse origin/main': HEAD_SHA,
    'git status --porcelain': '',
    [`npm view ${PACKAGE_NAME}@0.9.20 version`]: new Error('npm ERR! 404'),
    ...overrides,
  };
}

test('prepublish-guard: passes when HEAD == origin/main, tree clean, version unpublished', () => {
  const result = check({ run: fakeRun(passingResponses()), env: {} });
  assert.equal(result.ok, true);
  assert.equal(result.forced, false);
  assert.equal(result.headSha, HEAD_SHA);
  assert.equal(result.version, '0.9.20');
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
    [`npm view ${PACKAGE_NAME}@0.9.20 version`]: '0.9.20',
  });
  const result = check({ run: fakeRun(responses), env: {} });
  assert.equal(result.ok, false);
  assert.match(result.reason, /already published to the registry/);
});

test('prepublish-guard: refuses with a clear message when git fetch fails (offline)', () => {
  const responses = {
    'npm whoami': 'someuser',
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

// ─── PUBLISH-GUARD-AUTH coverage ────────────────────────────────────────
//
// The auth precondition (npm whoami) is checked FIRST, before the fetch/
// HEAD/clean-tree/version conditions. `fakeRun` throws "unexpected command"
// for anything not stubbed, so a test that stubs ONLY 'npm whoami' and gets
// a refusal (rather than an "unexpected command" crash) proves the guard
// never reached the fetch/HEAD/version checks.

test('prepublish-guard: npm whoami succeeds -> proceeds past auth to the other checks', () => {
  const result = check({ run: fakeRun(passingResponses()), env: {} });
  assert.equal(result.ok, true);
  assert.equal(result.forced, false);
  assert.equal(result.headSha, HEAD_SHA);
  assert.equal(result.version, '0.9.20');
});

test('prepublish-guard: npm whoami fails with E401 -> refuses with the auth message, never runs fetch/HEAD/version checks', () => {
  // Only 'npm whoami' is stubbed — if the guard proceeded to the fetch or
  // version checks, fakeRun would throw "unexpected command" and this test
  // would fail with that error instead of the expected refusal.
  const whoamiError = new Error(
    'Command failed: npm whoami\n' +
      'npm ERR! code E401\n' +
      'npm ERR! Unable to authenticate, need: Basic realm="//registry.npmjs.org/"'
  );
  const result = check({ run: fakeRun({ 'npm whoami': whoamiError }), env: {} });

  assert.equal(result.ok, false);
  assert.match(result.reason, /not authenticated to the npm registry/);
  assert.match(result.reason, /npm whoami failed/);
  assert.match(result.reason, /404 Not Found/);
  assert.match(result.reason, /npm login/);

  // The reason must never carry the raw captured stderr/error body — only
  // our own composed message. In particular it must not repeat the fake
  // error's own text (which could, in a real npm config, contain a
  // credential-bearing registry URL).
  assert.doesNotMatch(result.reason, /E401/);
  assert.doesNotMatch(result.reason, /Unable to authenticate/);
  assert.doesNotMatch(result.reason, /registry\.npmjs\.org/);
});

test('prepublish-guard: npm whoami fails with ENEEDAUTH -> refuses with the auth message', () => {
  const whoamiError = new Error('npm ERR! code ENEEDAUTH\nnpm ERR! need auth This command requires you to be logged in.');
  const result = check({ run: fakeRun({ 'npm whoami': whoamiError }), env: {} });

  assert.equal(result.ok, false);
  assert.match(result.reason, /not authenticated to the npm registry/);
  assert.match(result.reason, /npm login/);
  assert.doesNotMatch(result.reason, /ENEEDAUTH/);
});

test('prepublish-guard: AUXILO_PUBLISH_FORCE=1 bypasses the auth check too (npm whoami never runs)', () => {
  // No responses stubbed at all, including 'npm whoami' — if the force
  // path touched `run` for any reason, this would throw "unexpected
  // command" and fail the test.
  const result = check({ run: fakeRun({}), env: { AUXILO_PUBLISH_FORCE: '1' } });
  assert.equal(result.ok, true);
  assert.equal(result.forced, true);
});
