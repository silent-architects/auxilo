'use strict';

/**
 * BUILD-SPEC EXT-GATE — local extraction opened to every capture source.
 *
 * Closure test: the static EXTRACTABLE_SOURCES allowlist in
 * scripts/extract-local.js must equal the union of the two LIVE enumerations
 * of capture source ids:
 *   1. adapter ids from scripts/sources/*.js (runner.loadSources()), and
 *   2. runner-side ids of the installer's hook clients
 *      (clientRegistry entries with captureHook or hooks; sourceId || id).
 * extract-local.js cannot enumerate the registry at runtime (lib/installer.js
 * is not in RUNNER_STACK — the d8c7099 MODULE_NOT_FOUND class), so this test
 * is the authority: a future adapter or hook client that is not added to the
 * set turns CI red (manifest-closure pattern of test/wave3-client-funnel.test.js).
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const runner = require('../scripts/runner.js');
const { clientRegistry } = require('../lib/installer.js');
const { extractLocally, EXTRACTABLE_SOURCES } = require('../scripts/extract-local.js');

const sorted = (xs) => [...xs].sort();

function expectedSourceIds() {
  const adapterIds = runner.loadSources().map((S) => S.id);
  const hookIds = clientRegistry(os.homedir())
    .filter((c) => c.captureHook || c.hooks)
    .map((c) => c.sourceId || c.id);
  return sorted(new Set([...adapterIds, ...hookIds]));
}

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aux-ext-gate-'));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

describe('EXT-GATE — EXTRACTABLE_SOURCES closure', () => {
  it('equals the union of adapter ids and installer hook-client source ids', () => {
    assert.ok(EXTRACTABLE_SOURCES instanceof Set);
    const expected = expectedSourceIds();
    assert.ok(expected.length >= 12, `expected at least 12 live ids, got ${expected.length}`);
    assert.deepStrictEqual(sorted(EXTRACTABLE_SOURCES), expected);
  });

  it('every allowlisted id reaches invokeModel (no "not implemented" skip)', async () => {
    const dir = tmpdir();
    try {
      const indexPath = path.join(dir, 'extracted-index.jsonl');
      fs.writeFileSync(indexPath, '');
      const ids = sorted(EXTRACTABLE_SOURCES);
      const invoked = [];
      const skips = [];
      for (const id of ids) {
        const result = await extractLocally('synthetic transcript', id, {
          indexPath,
          log: () => {},
          invokeModel: async () => {
            invoked.push(id);
            return { ok: false, reason: 'fixture-model-stop' };
          },
        });
        skips.push(result.skipped);
        assert.deepEqual(result.learnings, []);
        assert.doesNotMatch(String(result.skipped), /local extraction not implemented/,
          `${id} must not short-circuit`);
      }
      assert.deepStrictEqual(invoked, ids);
      assert.equal(invoked.length, 12);
      assert.deepStrictEqual(skips, ids.map(() => 'fixture-model-stop'));
    } finally {
      cleanup(dir);
    }
  });

  it('unknown ids still short-circuit before model invocation (windsurf-x)', async () => {
    assert.ok(!EXTRACTABLE_SOURCES.has('windsurf-x'));
    const unknown = await extractLocally('synthetic transcript', 'windsurf-x', {
      invokeModel: async () => {
        throw new Error('unknown source must short-circuit before model invocation');
      },
    });
    assert.deepEqual(unknown.learnings, []);
    assert.equal(
      unknown.skipped,
      'local extraction not implemented for "windsurf-x" — agent contributes via auxilo_contribute'
    );
  });
});
