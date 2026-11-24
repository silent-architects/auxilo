'use strict';

// INCREMENTAL-SWEEP D4: the decision / persistence logic behind the runner's
// segmented extraction, driven with fakes (in-memory store, fake adapter, fake
// scrub/ledger/extract). No disk, no network, no LLM.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { makeMemFs } = require('./helpers/incremental-mem-fs');
const { createOffsetStore } = require('../lib/session-offsets');
const inc = require('../lib/incremental-sweep');

const CAP = 1000;
const MIN = 50;

function harness({ entry, marks = [], size = 5000, segments = [], caughtUp = true, adapterExtra = {}, postExtractImpl, scrubRefuse = false } = {}) {
  const mem = makeMemFs();
  const store = createOffsetStore({ fsImpl: mem.fsImpl, now: mem.clock.now, removeFile: mem.removeFile, filePath: '/o/offsets.json', sleep: () => {} });
  if (entry) store.update('fake', 's1', entry);
  const ledger = { sources: { fake: { highWater: null, sessions: {} } } };
  for (const m of marks) ledger.sources.fake.sessions[`fake:s1:${m}`] = true;
  const calls = [];
  const source = {
    type: 'fake',
    offsetCapable: true,
    requiresIncremental: () => false,
    async probeSession() { calls.push('probe'); return { ok: true }; },
    async forwardOnlyState() { calls.push('forward'); return { kind: 'offset', offset: size, headLen: 0, headSha: null, codec: 'plain' }; },
    async readNewSegments(ref, state, o) { calls.push(['read', state, o.maxSegments, o.charBudget]); return { segments, state: segments.length ? segments[segments.length - 1].nextState : state, caughtUp }; },
    ...adapterExtra,
  };
  const stats = inc.newStats();
  const order = [];
  const outcomes = [];
  const deps = {
    statSize: () => size,
    scrubAndVerify: (t) => (scrubRefuse ? { refused: true } : { cleaned: t, report: { clean: true, patterns_matched: [] }, refused: false }),
    sha256: (t) => `sha:${t}`,
    ledgerHas: (l, s, id, sha) => l.sources[s]?.sessions?.[`${s}:${id}:${sha}`] === true,
    ledgerMark: (l, s, id, sha, mtime) => { order.push(`mark:${sha}`); (l.sources[s] ||= { sessions: {} }).sessions[`${s}:${id}:${sha}`] = true; },
    saveLedger: () => order.push('save'),
    writeQueueFile: () => { order.push('queue'); return 'q1'; },
    deleteQueueFile: () => order.push('dequeue'),
    postExtract: postExtractImpl || (async () => { order.push('extract'); return { skipped: false, result: { learnings_held: 0 } }; }),
    isSkippedExtraction: (d) => Boolean(d && d.skipped),
    recordRealExtractionCompletion: () => order.push('record'),
    onOutcome: (d) => outcomes.push(d),
    log: () => {},
    accountTag: 'account=t',
  };
  const opts = { dryRun: false, maxSegments: 3, charBudget: 30000, minChars: MIN, capBytes: CAP };
  const ref = { sessionId: 's1', path: '/p/s1.jsonl', mtime: '2026-11-24T00:00:00.000Z', bytes: size };
  return { store, ledger, source, stats, deps, opts, ref, calls, order, outcomes, mem };
}

const seg = (text, end, extra = {}) => ({ text, startOffset: end - text.length, endOffset: end, nextState: { kind: 'offset', offset: end, headLen: 0, headSha: null, codec: 'plain' }, ...extra });
const run = (h) => inc.processSession({ source: h.source, sessionRef: h.ref, ledger: h.ledger, store: h.store, stats: h.stats, opts: h.opts, deps: h.deps });
const long = (c) => c.repeat(80);

describe('resolveMaxSegments (AUXILO_MAX_SEGMENTS_PER_SESSION)', () => {
  it('defaults to 3; accepts a positive integer; rejects zero, negatives, fractions, garbage', () => {
    assert.equal(inc.resolveMaxSegments({}), 3);
    assert.equal(inc.resolveMaxSegments({ AUXILO_MAX_SEGMENTS_PER_SESSION: '5' }), 5);
    for (const bad of ['0', '-2', '1.5', 'abc', '']) assert.equal(inc.resolveMaxSegments({ AUXILO_MAX_SEGMENTS_PER_SESSION: bad }), 3, bad);
    assert.equal(inc.resolveMaxSegments({ AUXILO_MAX_SEGMENTS_PER_SESSION: '5' }, 2), 2);
  });
});

describe('decideMode: first-sight rules (D4)', () => {
  const adapter = { offsetCapable: true, requiresIncremental: () => false };
  const base = { adapter, sessionRef: {}, entry: null, capBytes: CAP };

  it('non-capable adapter or a session under the cap stays on the legacy path', () => {
    assert.equal(inc.decideMode({ ...base, adapter: { offsetCapable: false }, size: 99999, marks: [] }), 'legacy');
    assert.equal(inc.decideMode({ ...base, size: 10, marks: [] }), 'legacy');
  });

  it('over the cap, never seen -> incremental backfill from the start', () => {
    assert.equal(inc.decideMode({ ...base, size: 5000, marks: [] }), 'incremental');
  });

  it('over the cap with an oversize mark -> backfill (oversize wins over any other mark)', () => {
    assert.equal(inc.decideMode({ ...base, size: 5000, marks: ['oversize'] }), 'incremental');
    assert.equal(inc.decideMode({ ...base, size: 5000, marks: ['oversize', 'abc123'] }), 'incremental');
  });

  it('over the cap with an existing non-oversize done mark -> forward-only', () => {
    assert.equal(inc.decideMode({ ...base, size: 5000, marks: ['abc123'] }), 'forward-only-init');
    assert.equal(inc.decideMode({ ...base, size: 5000, marks: ['skipped'] }), 'forward-only-init');
    assert.equal(inc.decideMode({ ...base, size: 5000, marks: ['probe-refused'] }), 'forward-only-init');
  });

  it('a stored state always means incremental, even under the cap', () => {
    assert.equal(inc.decideMode({ ...base, entry: { state: { kind: 'offset' } }, size: 10, marks: ['abc'] }), 'incremental');
  });

  it('an adapter that requires incremental (zstd rollout) goes incremental under the cap', () => {
    const a = { offsetCapable: true, requiresIncremental: () => true };
    assert.equal(inc.decideMode({ ...base, adapter: a, size: 10, marks: [] }), 'incremental');
    assert.equal(inc.decideMode({ ...base, adapter: a, size: 10, marks: ['abc'] }), 'forward-only-init');
  });

  it('unknown size is not treated as oversize (the legacy cap fails closed on its own)', () => {
    assert.equal(inc.decideMode({ ...base, size: null, marks: [] }), 'legacy');
  });

  it('ledgerMarksFor reads only this session suffixes', () => {
    const ledger = { sources: { fake: { sessions: { 'fake:s1:oversize': true, 'fake:s1:abc': true, 'fake:s2:def': true, 'other:s1:zzz': true } } } };
    assert.deepEqual(inc.ledgerMarksFor(ledger, 'fake', 's1').sort(), ['abc', 'oversize']);
  });
});

describe('processSession: backfill, segments, advance (D4)', () => {
  it('under the cap with no state is not handled (legacy path untouched)', async () => {
    const h = harness({ size: 10 });
    assert.deepEqual(await run(h), { handled: false, mode: 'legacy' });
    assert.deepEqual(h.calls, []);
  });

  it('oversize session: probes once, reads with the segment cap, extracts each segment and advances the stored state per segment', async () => {
    const segments = [seg(long('a'), 100), seg(long('b'), 200), seg(long('c'), 300)];
    const h = harness({ segments, caughtUp: false });
    const r = await run(h);
    assert.equal(r.mode, 'incremental');
    assert.deepEqual(h.calls[0], 'probe');
    assert.deepEqual(h.calls[1].slice(2), [3, 30000]);
    const e = h.store.get('fake', 's1');
    assert.equal(e.state.offset, 300);
    assert.equal(e.more, true, 'cap reached before EOF leaves backlog');
    assert.equal(h.stats.incrementalSegments, 3);
    assert.equal(h.stats.processed, 3);
  });

  it('caught up: more=false and the final offset is stored', async () => {
    const h = harness({ segments: [seg(long('a'), 100), seg(long('b'), 250)], caughtUp: true });
    await run(h);
    const e = h.store.get('fake', 's1');
    assert.equal(e.state.offset, 250);
    assert.equal(e.more, false);
    assert.equal(e.size, 5000);
  });

  it('every segment gets the same content-sha ledger mark a whole session uses', async () => {
    const h = harness({ segments: [seg(long('a'), 100)] });
    await run(h);
    assert.equal(h.ledger.sources.fake.sessions[`fake:s1:sha:${long('a')}`], true);
  });

  it('ledger sha check happens BEFORE queue write and extraction; a known segment never reaches extraction', async () => {
    const h = harness({ entry: { state: { kind: 'offset', offset: 0 }, size: 1, more: true }, segments: [seg(long('a'), 100), seg(long('b'), 200)] });
    h.ledger.sources.fake.sessions[`fake:s1:sha:${long('a')}`] = true;
    await run(h);
    assert.deepEqual(h.order.filter((x) => ['queue', 'extract'].includes(x)), ['queue', 'extract'], 'only the unseen segment is extracted');
    assert.equal(h.stats.skipped, 1);
    assert.equal(h.store.get('fake', 's1').state.offset, 200, 'a duplicate is terminal and advances');
    assert.ok(h.order.indexOf('queue') < h.order.indexOf('extract'));
  });

  it('a scrub fail-closed segment is terminal: not uploaded, offset advances', async () => {
    const h = harness({ segments: [seg(long('a'), 100)], scrubRefuse: true });
    await run(h);
    assert.ok(!h.order.includes('extract'));
    assert.equal(h.store.get('fake', 's1').state.offset, 100);
  });

  it('a short non-final segment is skipped terminally without extraction', async () => {
    const h = harness({ segments: [seg('tiny', 40), seg(long('b'), 140)], caughtUp: true });
    await run(h);
    assert.equal(h.order.filter((x) => x === 'extract').length, 1);
    assert.equal(h.store.get('fake', 's1').state.offset, 140);
  });

  it('a short FINAL tail is left unconsumed (waits for more) and is not re-announced while the size is unchanged', async () => {
    const h = harness({ entry: { state: { kind: 'offset', offset: 100 }, size: 90, more: false }, segments: [seg('tiny', 140)], caughtUp: true });
    const r = await run(h);
    assert.equal(r.mode, 'tail-pending');
    const e = h.store.get('fake', 's1');
    assert.equal(e.state.offset, 100, 'state not advanced');
    assert.equal(e.tailPendingSize, 5000);
    assert.equal(e.more, false);
    assert.ok(!h.order.includes('extract'));
    const again = await run(harness({ entry: e, segments: [] }));
    assert.equal(again.mode, 'unchanged');
  });

  it('dry run never persists state or touches the ledger', async () => {
    const h = harness({ segments: [seg(long('a'), 100)] });
    h.opts.dryRun = true;
    await run(h);
    assert.equal(h.store.get('fake', 's1'), null);
    assert.ok(!h.order.includes('queue'));
    assert.deepEqual(h.ledger.sources.fake.sessions, {});
  });

  it('a state reset by the adapter is counted and logged as offset_reset', async () => {
    const h = harness({ entry: { state: { kind: 'offset', offset: 9999 }, size: 1, more: false }, segments: [seg(long('a'), 100)] });
    h.source.readNewSegments = async () => ({ segments: [seg(long('a'), 100)], state: seg(long('a'), 100).nextState, caughtUp: true, resetReason: 'head_changed' });
    await run(h);
    assert.equal(h.stats.offsetResets, 1);
    assert.equal(h.store.counters.offset_reset, 1);
  });
});

describe('processSession: transient failure never advances (D4)', () => {
  it('classifier-skipped extraction (cli-unauthenticated etc.) keeps the offset, flags backlog, marks nothing', async () => {
    const h = harness({
      entry: { state: { kind: 'offset', offset: 100 }, size: 100, more: false },
      segments: [seg(long('a'), 200), seg(long('b'), 300)],
      postExtractImpl: async () => ({ skipped: true, reasonCode: 'cli-unauthenticated', result: { extraction_id: 'client-skip' } }),
    });
    const r = await run(h);
    assert.equal(r.mode, 'transient');
    const e = h.store.get('fake', 's1');
    assert.equal(e.state.offset, 100);
    assert.equal(e.more, true);
    assert.deepEqual(h.ledger.sources.fake.sessions, {});
    assert.equal(h.stats.retained, 1);
    assert.equal(h.stats.incrementalSegments, 1, 'stops at the first transient failure');
    assert.ok(h.order.includes('dequeue'), 'the queue file this run wrote is removed (F6), so --flush-pending cannot resubmit it');
  });

  it('a thrown upload error is transient too', async () => {
    const h = harness({
      entry: { state: { kind: 'offset', offset: 100 }, size: 100, more: false },
      segments: [seg(long('a'), 200)],
      postExtractImpl: async () => { throw new Error('provider unreachable'); },
    });
    await run(h);
    assert.equal(h.store.get('fake', 's1').state.offset, 100);
    assert.equal(h.store.get('fake', 's1').more, true);
    assert.equal(h.stats.failed, 1);
    assert.deepEqual(h.ledger.sources.fake.sessions, {});
  });

  it('a success then a failure advances only past the success', async () => {
    let n = 0;
    const h = harness({
      segments: [seg(long('a'), 100), seg(long('b'), 200)],
      postExtractImpl: async () => (++n === 1 ? { skipped: false, result: {} } : { skipped: true, reasonCode: 'x', result: {} }),
    });
    await run(h);
    const e = h.store.get('fake', 's1');
    assert.equal(e.state.offset, 100);
    assert.equal(e.more, true);
  });

  it('a read error on a session with state flags backlog without moving the state', async () => {
    const h = harness({ entry: { state: { kind: 'offset', offset: 7 }, size: 7, more: false } });
    h.source.readNewSegments = async () => { throw new Error('EIO'); };
    await run(h);
    assert.equal(h.store.get('fake', 's1').state.offset, 7);
    assert.equal(h.store.get('fake', 's1').more, true);
    assert.equal(h.stats.failed, 1);
  });
});

describe('processSession: gates, forward-only, unsupported (D4)', () => {
  it('forward-only first sight stores the current end and extracts nothing', async () => {
    const h = harness({ marks: ['abc123'], size: 5000 });
    const r = await run(h);
    assert.equal(r.mode, 'forward-only-init');
    assert.equal(h.store.get('fake', 's1').state.offset, 5000);
    assert.ok(!h.calls.some((c) => Array.isArray(c) && c[0] === 'read'));
    assert.equal(h.stats.forwardInit, 1);
  });

  it('adapter probe refusal (non-user thread) marks probe-refused and creates no state', async () => {
    const h = harness({ adapterExtra: { probeSession: async () => ({ ok: false, reason: 'non-user thread' }) } });
    await run(h);
    assert.equal(h.ledger.sources.fake.sessions['fake:s1:probe-refused'], true);
    assert.equal(h.store.get('fake', 's1'), null);
    assert.equal(h.stats.refused, 1);
  });

  it('unsupported (e.g. zst without zstd) is counted by reason, leaves the session unmarked and unfailed', async () => {
    const h = harness({ adapterExtra: { readNewSegments: async () => ({ segments: [], state: null, caughtUp: false, unsupported: 'zst_requires_node_22_15' }) } });
    const r = await run(h);
    assert.equal(r.mode, 'unsupported');
    assert.equal(h.stats.unsupported.zst_requires_node_22_15, 1);
    assert.equal(h.stats.failed, 0);
    assert.deepEqual(h.ledger.sources.fake.sessions, {});
    assert.equal(h.store.get('fake', 's1'), null);
  });

  it('a session whose stored state is caught up and whose size is unchanged is skipped cheaply', async () => {
    const h = harness({ entry: { state: { kind: 'offset', offset: 5000 }, size: 5000, more: false } });
    const r = await run(h);
    assert.equal(r.mode, 'unchanged');
    assert.deepEqual(h.calls, []);
  });
});

describe('collectBacklog (D4)', () => {
  it('adds sessions with more:true that discovery did not return, skips discovered ones, reports vanished files', () => {
    const mem = makeMemFs();
    const store = createOffsetStore({ fsImpl: mem.fsImpl, now: mem.clock.now, removeFile: mem.removeFile, filePath: '/o/offsets.json', sleep: () => {} });
    store.update('fake', 'old-big', { path: '/p/old-big.jsonl', mtime: '2026-10-01T00:00:00.000Z', more: true, state: { kind: 'offset', offset: 1 } });
    store.update('fake', 'in-discovery', { path: '/p/d.jsonl', more: true });
    store.update('fake', 'gone', { path: '/p/gone.jsonl', more: true });
    store.update('fake', 'done', { path: '/p/done.jsonl', more: false });
    const sizes = { '/p/old-big.jsonl': 777, '/p/d.jsonl': 5 };
    const { refs, gone } = inc.collectBacklog(store, 'fake', new Set(['in-discovery']), (p) => (p in sizes ? sizes[p] : null));
    assert.deepEqual(refs.map((r) => [r.sessionId, r.bytes, r.fromBacklog]), [['old-big', 777, true]]);
    assert.deepEqual(gone, ['gone']);
  });

  it('backlog sessions are counted in stats.backlogSessions when processed', async () => {
    const h = harness({ entry: { state: { kind: 'offset', offset: 1 }, size: 1, more: true }, segments: [seg(long('a'), 100)] });
    h.ref.fromBacklog = true;
    await run(h);
    assert.equal(h.stats.backlogSessions, 1);
  });
});

describe('runner wiring (D4)', () => {
  const runner = require('../scripts/runner.js');

  it('parses --incremental and --max-segments (positive integers only)', () => {
    const a = runner.parseArgs(['node', 'runner.js', '--transcript', '/t.jsonl', '--incremental', '--max-segments', '3']);
    assert.equal(a.incremental, true);
    assert.equal(a.maxSegments, 3);
    assert.equal(a.transcript, '/t.jsonl');
    assert.equal(runner.parseArgs(['node', 'r', '--max-segments', '0']).maxSegments, null);
    assert.equal(runner.parseArgs(['node', 'r', '--max-segments', 'x']).maxSegments, null);
    assert.equal(runner.parseArgs(['node', 'r']).incremental, false);
  });

  it('sweeper manifest ships the new lib files and the segment reader', () => {
    const srcs = runner.sweeperManifest().map((row) => row[0]);
    for (const f of ['lib/session-offsets.js', 'lib/ledger-merge.js', 'lib/incremental-sweep.js', 'scripts/sources/segment-reader.js']) {
      assert.ok(srcs.includes(f), f);
    }
  });

  it('the segment reader is not registered as a transcript source', () => {
    assert.ok(!runner.SOURCES.some((S) => /segment/.test(S.id)));
    const ids = runner.SOURCES.map((S) => S.id);
    for (const id of ['claude-code', 'codex-cli', 'copilot', 'openclaw']) assert.ok(ids.includes(id), id);
  });
});
