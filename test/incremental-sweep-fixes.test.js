'use strict';

// INCREMENTAL-SWEEP review fixes F1-F8. Injected in-memory fs only; no disk,
// no network, no delete site (the lock helpers take an injected removeFile).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const nodeFs = require('node:fs');
const nodePath = require('node:path');
const { makeMemFs, identityZlib } = require('./helpers/incremental-mem-fs');
const { createOffsetStore, tryFileLock } = require('../lib/session-offsets');
const { refreshLedgerFromDisk } = require('../lib/ledger-merge');
const { readNewSegmentsOffset, readSegments } = require('../scripts/sources/segment-reader');
const { ClaudeCodeSource } = require('../scripts/sources/claude-code');
const inc = require('../lib/incremental-sweep');

const ROOT = nodePath.join(__dirname, '..');
const CAP = 1000;
const MIN = 50;
const long = (c) => c.repeat(80);
const seg = (text, end) => ({ text, startOffset: end - text.length, endOffset: end, nextState: { kind: 'offset', offset: end, headLen: 0, headSha: null, codec: 'plain' } });

function harness({ entry, marks = [], size = 500, segments = [], caughtUp = true, adapterExtra = {}, depsExtra = {}, optsExtra = {}, storeExtra = {} } = {}) {
  const mem = makeMemFs();
  const store = createOffsetStore({ fsImpl: mem.fsImpl, now: mem.clock.now, removeFile: mem.removeFile, filePath: '/o/offsets.json', sleep: () => {}, ...storeExtra });
  if (entry) store.update('fake', 's1', entry);
  const ledger = { sources: { fake: { highWater: null, sessions: {} } } };
  for (const m of marks) ledger.sources.fake.sessions[`fake:s1:${m}`] = true;
  const calls = [];
  const source = {
    type: 'fake',
    offsetCapable: true,
    requiresIncremental: () => false,
    async probeSession() { return { ok: true }; },
    async forwardOnlyState() { calls.push('forward'); return { kind: 'offset', offset: size, headLen: 0, headSha: null, codec: 'plain' }; },
    async readNewSegments(ref, state, o) { calls.push(['read', o.maxSegments, o.resetPolicy]); return { segments, state, caughtUp }; },
    ...adapterExtra,
  };
  const stats = inc.newStats();
  const order = [];
  const deps = {
    statSize: () => size,
    scrubAndVerify: (t) => ({ cleaned: t, report: { clean: true, patterns_matched: [] }, refused: false }),
    sha256: (t) => `sha:${t}`,
    ledgerHas: (l, s, id, sha) => l.sources[s]?.sessions?.[`${s}:${id}:${sha}`] === true,
    ledgerMark: (l, s, id, sha) => { order.push('mark'); l.sources[s].sessions[`${s}:${id}:${sha}`] = true; },
    saveLedger: () => {},
    writeQueueFile: () => { order.push('queue'); return 'q1'; },
    deleteQueueFile: (p) => order.push(`dequeue:${p}`),
    postExtract: async () => { order.push('extract'); return { skipped: false, result: {} }; },
    isSkippedExtraction: (d) => Boolean(d && d.skipped),
    recordRealExtractionCompletion: () => {},
    onOutcome: () => {},
    log: (m) => order.push(`log:${m}`),
    ...depsExtra,
  };
  const opts = { dryRun: false, maxSegments: 3, charBudget: 30000, minChars: MIN, capBytes: CAP, ...optsExtra };
  const ref = { sessionId: 's1', path: '/p/s1.jsonl', mtime: '2026-11-24T00:00:00.000Z', bytes: size };
  return { store, ledger, source, stats, deps, opts, ref, calls, order, mem };
}
const run = (h) => inc.processSession({ source: h.source, sessionRef: h.ref, ledger: h.ledger, store: h.store, stats: h.stats, opts: h.opts, deps: h.deps });

describe('F1 forced incremental (--incremental never reads whole)', () => {
  const adapter = { offsetCapable: true, requiresIncremental: () => false };
  it('decideMode: a small session with no state is legacy unless incrementalForced', () => {
    const base = { adapter, sessionRef: {}, entry: null, size: 500, capBytes: CAP };
    assert.equal(inc.decideMode({ ...base, marks: [] }), 'legacy');
    assert.equal(inc.decideMode({ ...base, marks: [], incrementalForced: true }), 'incremental');
    assert.equal(inc.decideMode({ ...base, marks: ['sha'], incrementalForced: true }), 'forward-only-init');
    assert.equal(inc.decideMode({ ...base, marks: ['oversize'], incrementalForced: true }), 'incremental');
  });
  it('decideMode: non-capable adapters stay legacy even when forced', () => {
    assert.equal(inc.decideMode({ adapter: { offsetCapable: false }, sessionRef: {}, entry: null, size: 5e7, capBytes: CAP, marks: [], incrementalForced: true }), 'legacy');
  });
  it('processSession with incrementalForced handles a 25-128MB-style session (size under the runner cap) and never returns handled:false', async () => {
    const h = harness({ size: 500, segments: [seg(long('a'), 600)], optsExtra: { incrementalForced: true } });
    const r = await run(h);
    assert.equal(r.handled, true);
    assert.equal(r.mode, 'incremental');
    assert.equal(h.stats.processed, 1);
  });
  it('forced + already handled before: forward-only start, nothing extracted', async () => {
    const h = harness({ marks: ['abc'], optsExtra: { incrementalForced: true } });
    const r = await run(h);
    assert.equal(r.mode, 'forward-only-init');
    assert.ok(!h.order.includes('extract'));
    assert.equal(h.store.get('fake', 's1').forwardOnly, true);
  });
  it('runner single-file mode forces incremental and exits without a whole-file read when unhandled', () => {
    const src = nodeFs.readFileSync(nodePath.join(ROOT, 'scripts/runner.js'), 'utf8');
    assert.match(src, /ctx\.opts\.incrementalForced = true;/);
    assert.match(src, /not reading the file whole/);
  });
});

describe('F2 per-sweep segment budget', () => {
  it('resolveSweepSegmentBudget: default 30, positive integers only', () => {
    assert.equal(inc.resolveSweepSegmentBudget({}), 30);
    assert.equal(inc.resolveSweepSegmentBudget({ AUXILO_MAX_SEGMENTS_PER_SWEEP: '7' }), 7);
    for (const bad of ['0', '-2', '1.5', 'abc']) assert.equal(inc.resolveSweepSegmentBudget({ AUXILO_MAX_SEGMENTS_PER_SWEEP: bad }), 30);
  });
  it('an exhausted budget starts nothing, flags the session backlog and counts it', async () => {
    const h = harness({ segments: [seg(long('a'), 600)], optsExtra: { incrementalForced: true, budget: { remaining: 0 } } });
    const r = await run(h);
    assert.equal(r.mode, 'budget-deferred');
    assert.equal(h.calls.length, 0);
    assert.equal(h.store.get('fake', 's1').more, true);
    assert.equal(h.stats.budgetDeferred, 1);
  });
  it('the read is capped at the remaining budget and each segment spends one', async () => {
    const budget = { remaining: 2 };
    const h = harness({ entry: { state: { kind: 'offset', offset: 1 }, size: 1, more: true }, segments: [seg(long('a'), 600), seg(long('b'), 700)], caughtUp: false, optsExtra: { budget } });
    await run(h);
    assert.deepEqual(h.calls[0].slice(0, 2), ['read', 2]);
    assert.equal(budget.remaining, 0);
    assert.equal(h.stats.budgetDeferred, 1, 'session left with more content while the budget is spent');
    assert.equal(h.store.get('fake', 's1').more, true);
  });
  it('orderForSweep: backlog and stored-state sessions first, newest mtime first', () => {
    const mem = makeMemFs();
    const store = createOffsetStore({ fsImpl: mem.fsImpl, now: mem.clock.now, removeFile: mem.removeFile, filePath: '/o/offsets.json' });
    store.update('fake', 'withState', { state: { kind: 'offset', offset: 1 } });
    const sessions = [
      { sessionId: 'newNever', mtime: '2026-11-24T10:00:00Z' },
      { sessionId: 'oldNever', mtime: '2026-11-01T10:00:00Z' },
      { sessionId: 'withState', mtime: '2026-11-02T10:00:00Z' },
      { sessionId: 'backlog', mtime: '2026-10-01T10:00:00Z', fromBacklog: true },
    ];
    assert.deepEqual(inc.orderForSweep(store, 'fake', sessions).map((s) => s.sessionId), ['withState', 'backlog', 'newNever', 'oldNever']);
  });
  it('runner wires the budget, the log line and the ordering', () => {
    const src = nodeFs.readFileSync(nodePath.join(ROOT, 'scripts/runner.js'), 'utf8');
    assert.match(src, /inc\.opts\.budget = \{ remaining: incremental\.resolveSweepSegmentBudget/);
    assert.match(src, /sweep_segment_budget_exhausted backlog_sessions=/);
    assert.match(src, /incremental\.orderForSweep\(/);
  });
});

describe('F3 per-session lock and ledger refresh', () => {
  it('a held session lock skips the session (session_locked) without reading', async () => {
    const h = harness({ optsExtra: { incrementalForced: true }, segments: [seg(long('a'), 600)] });
    const release = h.store.tryLockSession('fake', 's1');
    assert.equal(typeof release, 'function');
    const r = await run(h);
    assert.equal(r.mode, 'session_locked');
    assert.equal(h.stats.sessionLocked, 1);
    assert.equal(h.calls.length, 0);
    release();
    const r2 = await run(h);
    assert.equal(r2.mode, 'incremental');
  });
  it('the lock is released after a run, even when the run throws', async () => {
    const h = harness({ optsExtra: { incrementalForced: true } });
    h.source.readNewSegments = async () => { throw new Error('boom'); };
    await run(h);
    const again = h.store.tryLockSession('fake', 's1');
    assert.equal(typeof again, 'function');
  });
  it('a lock older than 10 minutes is stale and is taken over; a fresh one is not', () => {
    const mem = makeMemFs();
    const deps = { fsImpl: mem.fsImpl, now: mem.clock.now, removeFile: mem.removeFile };
    const first = tryFileLock('/l/a.lock', deps);
    assert.equal(typeof first, 'function');
    mem.clock.advance(9 * 60 * 1000);
    assert.equal(tryFileLock('/l/a.lock', deps), null);
    mem.clock.advance(2 * 60 * 1000);
    assert.equal(typeof tryFileLock('/l/a.lock', deps), 'function');
  });
  it('the lock file is mode 0600 and keyed by source+session', () => {
    const mem = makeMemFs();
    const store = createOffsetStore({ fsImpl: mem.fsImpl, now: mem.clock.now, removeFile: mem.removeFile, filePath: '/o/offsets.json' });
    assert.notEqual(store.sessionLockPath('a', 'x'), store.sessionLockPath('b', 'x'));
    assert.notEqual(store.sessionLockPath('a', 'x'), store.sessionLockPath('a', 'y'));
    assert.match(store.sessionLockPath('a', 'x'), /\/o\/session-locks\/[0-9a-f]{32}\.lock$/);
  });
  it('handleSegment re-reads the ledger so a mark another process wrote is seen (no second extraction)', async () => {
    const h = harness({
      entry: { state: { kind: 'offset', offset: 1 }, size: 1, more: true },
      segments: [seg(long('a'), 600)],
      depsExtra: { refreshLedger: (l) => { l.sources.fake.sessions[`fake:s1:sha:${long('a')}`] = true; } },
    });
    await run(h);
    assert.ok(!h.order.includes('extract'));
    assert.equal(h.stats.skipped, 1);
  });
  it('refreshLedgerFromDisk folds disk marks into the in-memory ledger without writing', () => {
    const mem = makeMemFs();
    mem.put('/l/ledger.json', JSON.stringify({ sources: { fake: { highWater: '2026-11-24T00:00:00Z', sessions: { 'fake:s:abc': true } } } }));
    const ledger = { sources: { fake: { highWater: null, sessions: { 'fake:s:mine': true } } } };
    refreshLedgerFromDisk('/l/ledger.json', ledger, { fsImpl: mem.fsImpl });
    assert.equal(ledger.sources.fake.sessions['fake:s:abc'], true);
    assert.equal(ledger.sources.fake.sessions['fake:s:mine'], true);
  });
});

describe('F4 reset does not re-extract an already handled session', () => {
  const adapter = new ClaudeCodeSource({ dataDir: '/nope', settingsPath: '/nope' });
  const P = '/s/session.jsonl';
  const line = (role, text) => JSON.stringify({ type: role, message: { role, content: text } }) + '\n';
  const o = (mem, extra = {}) => ({ fsImpl: mem.fsImpl, zlibImpl: identityZlib, charBudget: 30000, maxSegments: 3, ...extra });
  it('head_changed with resetPolicy forward-only returns the current end and no segments', async () => {
    const mem = makeMemFs();
    mem.put(P, line('user', 'original-head') + line('assistant', 'more'));
    const first = await readNewSegmentsOffset(adapter, { path: P }, null, o(mem));
    const rewritten = line('user', 'REPLACED-head') + line('assistant', 'more') + line('user', 'extra');
    mem.put(P, rewritten);
    const res = await readNewSegmentsOffset(adapter, { path: P }, first.state, o(mem, { resetPolicy: 'forward-only' }));
    assert.equal(res.resetReason, 'head_changed');
    assert.equal(res.resetForwardOnly, true);
    assert.equal(res.segments.length, 0);
    assert.equal(res.state.offset, Buffer.byteLength(rewritten));
  });
  it('offset_beyond_eof with forward-only also restarts at the end; the backfill policy still re-reads from 0', async () => {
    const mem = makeMemFs();
    const body = line('user', 'one') + line('assistant', 'two');
    mem.put(P, body);
    const stored = { kind: 'offset', offset: 5000, headLen: 0, headSha: null, codec: 'plain' };
    const fwd = await readNewSegmentsOffset(adapter, { path: P }, stored, o(mem, { resetPolicy: 'forward-only' }));
    assert.equal(fwd.resetForwardOnly, true);
    assert.equal(fwd.state.offset, Buffer.byteLength(body));
    const back = await readNewSegmentsOffset(adapter, { path: P }, stored, o(mem, { resetPolicy: 'backfill' }));
    assert.equal(back.segments.length, 1);
    assert.ok(!back.resetForwardOnly);
  });
  it('processSession passes forward-only when the session has a done mark or began forward-only, backfill otherwise', async () => {
    const withMark = harness({ entry: { state: { kind: 'offset', offset: 1 }, size: 1, more: true }, marks: ['sha'] });
    await run(withMark);
    assert.equal(withMark.calls[0][2], 'forward-only');
    const flagged = harness({ entry: { state: { kind: 'offset', offset: 1 }, size: 1, more: true, forwardOnly: true } });
    await run(flagged);
    assert.equal(flagged.calls[0][2], 'forward-only');
    const oversize = harness({ entry: { state: { kind: 'offset', offset: 1 }, size: 1, more: true }, marks: ['oversize'] });
    await run(oversize);
    assert.equal(oversize.calls[0][2], 'backfill');
  });
  it('processSession persists the forward-only state from a reset and extracts nothing', async () => {
    const st = { kind: 'offset', offset: 777, headLen: 0, headSha: null, codec: 'plain' };
    const h = harness({
      entry: { state: { kind: 'offset', offset: 1 }, size: 1, more: true }, marks: ['sha'],
      adapterExtra: { async readNewSegments() { return { segments: [], state: st, caughtUp: true, resetReason: 'head_changed', resetForwardOnly: true }; } },
    });
    const r = await run(h);
    assert.equal(r.mode, 'reset-forward-only');
    const e = h.store.get('fake', 's1');
    assert.equal(e.state.offset, 777);
    assert.equal(e.more, false);
    assert.equal(e.forwardOnly, true);
    assert.equal(h.stats.offsetResets, 1);
    assert.ok(!h.order.includes('extract'));
  });
});

describe('F5 transient read and the cheap unchanged probe', () => {
  it('a transient read result is counted transient_retained, never advances and stays backlog', async () => {
    const h = harness({
      entry: { state: { kind: 'rowid', highWater: 5 }, size: 500, more: false },
      adapterExtra: { async readNewSegments() { return { segments: [], state: { kind: 'rowid', highWater: 5 }, caughtUp: false, transient: true, transientReason: 'sqlite_busy' }; }, async isUnchanged() { return false; } },
    });
    const r = await run(h);
    assert.equal(r.mode, 'transient-read');
    assert.equal(h.stats.transientRetained, 1);
    assert.equal(h.stats.failed, 0);
    const e = h.store.get('fake', 's1');
    assert.equal(e.state.highWater, 5);
    assert.equal(e.more, true);
  });
  it('isUnchanged overrides size equality: same size but rows pending is read', async () => {
    const h = harness({
      entry: { state: { kind: 'rowid', highWater: 5 }, size: 500, more: false },
      adapterExtra: { async isUnchanged() { return false; } },
    });
    await run(h);
    assert.equal(h.calls.length, 1, 'read happened despite equal size');
  });
  it('isUnchanged true skips the read; a throwing probe falls back to reading', async () => {
    const quiet = harness({ entry: { state: { kind: 'rowid', highWater: 5 }, size: 99, more: false }, adapterExtra: { async isUnchanged() { return true; } } });
    assert.equal((await run(quiet)).mode, 'unchanged');
    const broken = harness({ entry: { state: { kind: 'rowid', highWater: 5 }, size: 500, more: false }, adapterExtra: { async isUnchanged() { throw new Error('x'); } } });
    await run(broken);
    assert.equal(broken.calls.length, 1);
  });
  it('runner Summary and stderr carry transient_retained', () => {
    const src = nodeFs.readFileSync(nodePath.join(ROOT, 'scripts/runner.js'), 'utf8');
    assert.match(src, /transient_retained=\$\{inc\.stats\.transientRetained\}/);
  });
});

describe('F6 no queue file left behind on a transient or failed segment', () => {
  it('classifier-skipped and thrown uploads delete exactly the queue file this run wrote', async () => {
    for (const postExtract of [async () => ({ skipped: true, result: {} }), async () => { throw new Error('down'); }]) {
      const h = harness({
        entry: { state: { kind: 'offset', offset: 1 }, size: 1, more: true },
        segments: [seg(long('a'), 600)],
        depsExtra: { postExtract },
      });
      await run(h);
      assert.deepEqual(h.order.filter((x) => x.startsWith('dequeue')), ['dequeue:q1']);
    }
  });
  it('--flush-pending drops a queue file whose segment sha the ledger already has', () => {
    const src = nodeFs.readFileSync(nodePath.join(ROOT, 'scripts/runner.js'), 'utf8');
    const flush = src.slice(src.indexOf('if (args.flushPending)'));
    assert.match(flush, /payload\.sha[\s\S]{0,200}ledgerHas\(loadLedger\(\), payload\.source, payload\.sessionId, payload\.sha\)/);
    assert.match(flush, /already in ledger; dropped without resubmitting/);
  });
});

describe('F7 lock identity, single parse, regular files only', () => {
  it('a stale lock whose inode changed between the two stats is not broken', () => {
    const mem = makeMemFs();
    mem.put('/l/x.lock', '{}');
    mem.clock.advance(20 * 60 * 1000);
    const real = mem.fsImpl.statSync.bind(mem.fsImpl);
    let n = 0;
    const fsImpl = { ...mem.fsImpl, statSync: (p) => { const s = real(p); n += 1; return { ...s, ino: n }; } };
    const got = tryFileLock('/l/x.lock', { fsImpl, now: mem.clock.now, removeFile: mem.removeFile });
    assert.equal(got, null);
    assert.ok(mem.files.has('/l/x.lock'), 'the lock was not removed');
  });
  it('store.get parses the offsets document once', () => {
    const mem = makeMemFs();
    const store = createOffsetStore({ fsImpl: mem.fsImpl, now: mem.clock.now, removeFile: mem.removeFile, filePath: '/o/offsets.json' });
    store.update('fake', 's1', { more: false });
    let reads = 0;
    const real = mem.fsImpl.readFileSync;
    mem.fsImpl.readFileSync = (...a) => { reads += 1; return real.apply(mem.fsImpl, a); };
    assert.equal(store.get('fake', 's1').more, false);
    assert.equal(reads, 1);
  });
  it('the segment reader refuses a path that is not a regular file', async () => {
    const mem = makeMemFs();
    mem.put('/s/fifo', 'x\n');
    const fsImpl = { ...mem.fsImpl, statSync: () => ({ size: 0, mtimeMs: 0, isFile: () => false }) };
    const outcome = {};
    const segs = [];
    for await (const s of readSegments({ path: '/s/fifo' }, new ClaudeCodeSource({ dataDir: '/nope', settingsPath: '/nope' }), { fsImpl, outcome })) segs.push(s);
    assert.equal(segs.length, 0);
    assert.equal(outcome.unsupported, 'not_regular_file');
  });
});

describe('F8 docs truth', () => {
  const read = (f) => nodeFs.readFileSync(nodePath.join(ROOT, f), 'utf8');
  it('README names the per-sweep env var and the head-only rule', () => {
    const r = read('README.md');
    assert.match(r, /AUXILO_MAX_SEGMENTS_PER_SWEEP/);
    assert.match(r, /head-only extraction, meaning only its first 30,000 characters/);
  });
  it('PUNCH-LIST INCR-1 documents the sweep budget; INCR-9 does not claim the README was untouched', () => {
    const p = read('PUNCH-LIST.md');
    const row = (id) => p.split('\n').find((l) => l.startsWith(`| ${id} |`));
    assert.match(row('INCR-1'), /AUXILO_MAX_SEGMENTS_PER_SWEEP/);
    assert.doesNotMatch(row('INCR-9'), /README claims[^.]*was edited/);
    assert.match(row('INCR-9'), /README\.md/);
  });
  it('the false "stored offset to EOF" comment is gone and capture-core states the true behavior', () => {
    assert.doesNotMatch(read('lib/installer.js'), /extract from the stored offset to EOF/);
    assert.match(read('scripts/capture-core.js'), /forces incremental handling at ANY size/);
  });
  it('Summary keeps its existing prefix and adds discovered_from_backlog', () => {
    const src = read('scripts/runner.js');
    assert.match(src, /\$\{totalDiscovered\} discovered, \$\{totalProcessed\} processed/);
    assert.match(src, /discovered_from_backlog=\$\{inc\.stats\.backlogDiscovered\}/);
  });
});
