'use strict';

// INCREMENTAL-SWEEP D1 + D5: offsets store, file lock, ledger merge-on-write.
// Everything runs on an injected in-memory fs and clock; nothing touches disk.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { makeMemFs } = require('./helpers/incremental-mem-fs');
const { createOffsetStore, withFileLock, atomicWriteJson, isValidState } = require('../lib/session-offsets');
const { mergeLedgers, saveLedgerMerged } = require('../lib/ledger-merge');

const OFFSETS = '/h/.auxilo/offsets.json';

function newStore(extra = {}) {
  const mem = makeMemFs();
  const store = createOffsetStore({
    fsImpl: mem.fsImpl,
    now: mem.clock.now,
    removeFile: mem.removeFile,
    sleep: (ms) => mem.clock.advance(ms),
    filePath: OFFSETS,
    pid: 4242,
    ...extra,
  });
  return { mem, store };
}

describe('session offsets store (D1)', () => {
  it('starts empty and returns null for an unknown session', () => {
    const { store } = newStore();
    assert.equal(store.get('claude-code', 's1'), null);
    assert.deepEqual(store.backlog('claude-code'), []);
  });

  it('persists an opaque state under sources.<source>.<sessionId> with version 1', () => {
    const { mem, store } = newStore();
    store.update('codex-cli', 'abc', { state: { kind: 'offset', offset: 10, headSha: 'x', headLen: 3, codec: 'plain' }, size: 99, more: true });
    const doc = JSON.parse(mem.fsImpl.readFileSync(OFFSETS, 'utf8'));
    assert.equal(doc.version, 1);
    assert.equal(doc.sources['codex-cli'].abc.state.offset, 10);
    assert.equal(doc.sources['codex-cli'].abc.more, true);
    assert.ok(doc.sources['codex-cli'].abc.updatedAt);
  });

  it('write is atomic: no tmp file survives and the lock is released', () => {
    const { mem, store } = newStore();
    store.update('claude-code', 's1', { size: 1 });
    const left = [...mem.files.keys()].filter((k) => k.endsWith('.tmp') || k.endsWith('.lock'));
    assert.deepEqual(left, []);
  });

  it('update merges into the existing entry and keeps other sessions', () => {
    const { store } = newStore();
    store.update('claude-code', 's1', { state: { kind: 'offset', offset: 5 }, size: 5 });
    store.update('claude-code', 's2', { state: { kind: 'rowid', highWater: 7 } });
    store.update('claude-code', 's1', { more: true });
    assert.equal(store.get('claude-code', 's1').state.offset, 5);
    assert.equal(store.get('claude-code', 's1').more, true);
    assert.equal(store.get('claude-code', 's2').state.highWater, 7);
  });

  it('merge-on-write: a write by another process between two of ours is kept', () => {
    const { mem, store } = newStore();
    store.update('claude-code', 's1', { size: 1 });
    const doc = JSON.parse(mem.fsImpl.readFileSync(OFFSETS, 'utf8'));
    doc.sources['claude-code'].other = { size: 77 };
    atomicWriteJson(mem.fsImpl, OFFSETS, doc);
    store.update('claude-code', 's1', { size: 2 });
    assert.equal(store.get('claude-code', 'other').size, 77);
    assert.equal(store.get('claude-code', 's1').size, 2);
  });

  it('backlog lists only sessions flagged more:true', () => {
    const { store } = newStore();
    store.update('claude-code', 'a', { more: true });
    store.update('claude-code', 'b', { more: false });
    assert.deepEqual(store.backlog('claude-code').map((x) => x.sessionId), ['a']);
  });

  it('a corrupt or wrong-version file is treated as empty', () => {
    const { mem, store } = newStore();
    mem.put(OFFSETS, '{not json');
    assert.equal(store.get('claude-code', 's1'), null);
    mem.put(OFFSETS, JSON.stringify({ version: 9, sources: { 'claude-code': { s1: { size: 1 } } } }));
    assert.equal(store.get('claude-code', 's1'), null);
  });

  it('counts offset_reset through noteReset', () => {
    const { store } = newStore();
    store.noteReset();
    store.noteReset();
    assert.equal(store.counters.offset_reset, 2);
  });

  it('isValidState accepts the three kinds only', () => {
    assert.ok(isValidState({ kind: 'offset' }));
    assert.ok(isValidState({ kind: 'hashes' }));
    assert.ok(isValidState({ kind: 'rowid' }));
    assert.equal(isValidState({ kind: 'other' }), false);
    assert.equal(isValidState(null), false);
  });

  it('defaults the file to <home>/.auxilo/offsets.json', () => {
    const mem = makeMemFs();
    const store = createOffsetStore({ fsImpl: mem.fsImpl, home: '/hh', env: {} });
    assert.equal(store.filePath, '/hh/.auxilo/offsets.json');
  });
});

describe('file lock (D1)', () => {
  it('a fresh lock blocks, then times out with LOCK_TIMEOUT; the foreign lock is left alone', () => {
    const mem = makeMemFs();
    mem.put('/l.lock', '{}');
    assert.throws(
      () => withFileLock('/l.lock', () => 1, {
        fsImpl: mem.fsImpl, now: mem.clock.now, removeFile: mem.removeFile,
        sleep: (ms) => mem.clock.advance(ms), staleMs: 10_000, waitMs: 500, pollMs: 100,
      }),
      (e) => e.code === 'LOCK_TIMEOUT'
    );
    assert.ok(mem.files.has('/l.lock'));
  });

  it('a lock older than the stale timeout is broken and the work runs', () => {
    const mem = makeMemFs();
    mem.put('/l.lock', '{}');
    mem.clock.advance(11_000);
    const out = withFileLock('/l.lock', () => 'ran', {
      fsImpl: mem.fsImpl, now: mem.clock.now, removeFile: mem.removeFile,
      sleep: (ms) => mem.clock.advance(ms), staleMs: 10_000, waitMs: 500,
    });
    assert.equal(out, 'ran');
    assert.equal(mem.files.has('/l.lock'), false);
  });

  it('releases the lock when the work throws', () => {
    const mem = makeMemFs();
    assert.throws(() => withFileLock('/l.lock', () => { throw new Error('boom'); }, {
      fsImpl: mem.fsImpl, now: mem.clock.now, removeFile: mem.removeFile, sleep: () => {},
    }), /boom/);
    assert.equal(mem.files.has('/l.lock'), false);
  });

  it('store.update still writes (merged) when the lock cannot be taken, and counts it', () => {
    const { mem, store } = newStore({ waitMs: 300, pollMs: 100 });
    mem.put(`${OFFSETS}.lock`, '{}');
    store.update('claude-code', 's1', { size: 3 });
    assert.equal(store.get('claude-code', 's1').size, 3);
    assert.equal(store.counters.lock_timeouts, 1);
  });
});

describe('ledger merge-on-write (D5)', () => {
  const LEDGER = '/h/.auxilo/ledger.json';

  it('unions marks, takes max highWater and max lastSweep', () => {
    const merged = mergeLedgers(
      { sources: { 'claude-code': { highWater: '2026-11-24T10:00:00.000Z', sessions: { 'claude-code:a:sha1': true } } }, lastSweep: '2026-11-24T10:00:00.000Z' },
      { sources: { 'claude-code': { highWater: '2026-11-23T10:00:00.000Z', sessions: { 'claude-code:b:sha2': true } } }, lastSweep: '2026-11-23T10:00:00.000Z' }
    );
    assert.deepEqual(Object.keys(merged.sources['claude-code'].sessions).sort(), ['claude-code:a:sha1', 'claude-code:b:sha2']);
    assert.equal(merged.sources['claude-code'].highWater, '2026-11-24T10:00:00.000Z');
    assert.equal(merged.lastSweep, '2026-11-24T10:00:00.000Z');
  });

  it('a hook mark written after the sweep loaded survives the sweep save', () => {
    const mem = makeMemFs();
    mem.put(LEDGER, JSON.stringify({ sources: {}, lastSweep: null }));
    const sweepCopy = JSON.parse(mem.fsImpl.readFileSync(LEDGER, 'utf8')); // sweep loads once
    // a hook-fired run marks and saves meanwhile
    mem.put(LEDGER, JSON.stringify({ sources: { 'claude-code': { highWater: '2026-11-24T12:00:00.000Z', sessions: { 'claude-code:hook:shaH': true } } } }));
    // the sweep now saves its stale object plus its own mark
    sweepCopy.sources['claude-code'] = { highWater: '2026-11-24T09:00:00.000Z', sessions: { 'claude-code:sweep:shaS': true } };
    const merged = saveLedgerMerged(LEDGER, sweepCopy, { fsImpl: mem.fsImpl, now: mem.clock.now, removeFile: mem.removeFile, sleep: () => {} });
    const onDisk = JSON.parse(mem.fsImpl.readFileSync(LEDGER, 'utf8'));
    assert.equal(onDisk.sources['claude-code'].sessions['claude-code:hook:shaH'], true);
    assert.equal(onDisk.sources['claude-code'].sessions['claude-code:sweep:shaS'], true);
    assert.equal(onDisk.sources['claude-code'].highWater, '2026-11-24T12:00:00.000Z');
    // caller's object is folded forward so later saves stay a superset
    assert.equal(sweepCopy.sources['claude-code'].sessions['claude-code:hook:shaH'], true);
    assert.equal(merged.sources['claude-code'].highWater, onDisk.sources['claude-code'].highWater);
  });

  it('uses a per-process tmp name and leaves no tmp or lock behind', () => {
    const mem = makeMemFs();
    saveLedgerMerged(LEDGER, { sources: {} }, { fsImpl: mem.fsImpl, now: mem.clock.now, removeFile: mem.removeFile, pid: 99 });
    assert.deepEqual([...mem.files.keys()].filter((k) => /\.(tmp|lock)$/.test(k)), []);
  });

  it('a stale ledger lock is broken; a held lock falls back to an unlocked merged save', () => {
    const mem = makeMemFs();
    mem.put(`${LEDGER}.lock`, '{}');
    mem.clock.advance(20_000);
    saveLedgerMerged(LEDGER, { sources: { x: { highWater: 'a', sessions: {} } } }, { fsImpl: mem.fsImpl, now: mem.clock.now, removeFile: mem.removeFile, sleep: (ms) => mem.clock.advance(ms) });
    assert.ok(JSON.parse(mem.fsImpl.readFileSync(LEDGER, 'utf8')).sources.x);

    const mem2 = makeMemFs();
    mem2.put(`${LEDGER}.lock`, '{}');
    const logs = [];
    saveLedgerMerged(LEDGER, { sources: { y: { highWater: 'a', sessions: {} } } }, {
      fsImpl: mem2.fsImpl, now: mem2.clock.now, removeFile: mem2.removeFile, sleep: (ms) => mem2.clock.advance(ms), waitMs: 200, pollMs: 100, log: (m) => logs.push(m),
    });
    assert.ok(JSON.parse(mem2.fsImpl.readFileSync(LEDGER, 'utf8')).sources.y);
    assert.equal(logs.length, 1);
  });
});
