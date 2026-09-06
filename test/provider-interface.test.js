'use strict';
/*
 * test/provider-interface.test.js — EXTRACT-PER-CLIENT W1 PART A.
 *
 * scripts/providers/provider.interface.js is a doc-only contract (JSDoc
 * typedefs, no runtime logic) — mirrors source.interface.js's role for
 * transcript sources. This is a smoke test only: importing it must not throw
 * and it must carry no surprise runtime surface.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

describe('provider.interface.js — no-op import smoke test', () => {
  it('requires cleanly and exports nothing (doc-only contract, no runtime logic)', () => {
    const iface = require('../scripts/providers/provider.interface.js');
    assert.deepEqual(iface, {});
  });

  it('requiring it twice returns the same cached module (no side effects on repeat require)', () => {
    const first = require('../scripts/providers/provider.interface.js');
    const second = require('../scripts/providers/provider.interface.js');
    assert.strictEqual(first, second);
  });
});
