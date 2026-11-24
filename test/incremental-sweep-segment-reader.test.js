'use strict';

// INCREMENTAL-SWEEP D2: segment reader + the kind-'offset' side of the uniform
// readNewSegments contract. In-memory fs and a fake zstd (identity); no disk.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { makeMemFs, identityZlib } = require('./helpers/incremental-mem-fs');
const { readSegments, readNewSegmentsOffset, forwardOnlyStateOffset, codecFor, ZST_UNSUPPORTED } = require('../scripts/sources/segment-reader');
const { ClaudeCodeSource } = require('../scripts/sources/claude-code');
const { TranscriptSource } = require('../scripts/sources/source.interface');

const P = '/s/session.jsonl';
const adapter = new ClaudeCodeSource({ dataDir: '/nope', settingsPath: '/nope' });

const line = (role, text) => JSON.stringify({ type: role, message: { role, content: text } }) + '\n';
const textOfSegments = (segs) => segs.map((s) => s.text);

async function collect(mem, opts = {}, ad = adapter, ref = { path: P }) {
  const outcome = {};
  const segs = [];
  for await (const s of readSegments(ref, ad, { fsImpl: mem.fsImpl, zlibImpl: identityZlib, outcome, ...opts })) segs.push(s);
  return { segs, outcome };
}

describe('segment reader (D2)', () => {
  it('consumes only complete lines: a trailing partial line is left unconsumed', async () => {
    const mem = makeMemFs({ chunkSize: 7 });
    const full = line('user', 'hello') + line('assistant', 'world');
    mem.put(P, full + '{"type":"user","message":{"role":"user","content":"par');
    const { segs, outcome } = await collect(mem);
    assert.equal(segs.length, 1);
    assert.equal(segs[0].text, '[user]: hello\n\n[assistant]: world');
    assert.equal(segs[0].endOffset, Buffer.byteLength(full));
    assert.equal(outcome.consumedOffset, Buffer.byteLength(full));
    assert.ok(outcome.partialTailBytes > 0);
    assert.equal(outcome.caughtUp, true);
  });

  it('char budget boundary: a line that does not fit starts the next segment; offsets are line starts', async () => {
    const mem = makeMemFs({ chunkSize: 10 });
    const a = line('user', 'a'.repeat(40));
    const b = line('user', 'b'.repeat(40));
    const c = line('user', 'c'.repeat(40));
    mem.put(P, a + b + c);
    // each turn is "[user]: " + 40 = 48 chars; budget 100 fits two (48+2+48=98), not three
    const { segs, outcome } = await collect(mem, { charBudget: 100 });
    assert.equal(segs.length, 2);
    assert.equal(segs[0].startOffset, 0);
    assert.equal(segs[0].endOffset, Buffer.byteLength(a + b));
    assert.equal(segs[1].startOffset, Buffer.byteLength(a + b));
    assert.equal(segs[1].endOffset, Buffer.byteLength(a + b + c));
    assert.ok(segs.every((s) => s.text.length <= 100));
    assert.equal(outcome.caughtUp, true);
  });

  it('a single turn longer than the budget is truncated to its head (never livelocks)', async () => {
    const mem = makeMemFs();
    const big = line('user', 'x'.repeat(500));
    mem.put(P, big + line('assistant', 'tail'));
    const { segs, outcome } = await collect(mem, { charBudget: 100 });
    assert.equal(segs[0].text.length, 100);
    assert.ok(outcome.linesTruncated >= 1);
    assert.equal(outcome.consumedOffset, Buffer.byteLength(big + line('assistant', 'tail')));
  });

  it('maxSegments stops early with caughtUp=false and the offset at the next line start', async () => {
    const mem = makeMemFs();
    const lines = [1, 2, 3, 4].map((n) => line('user', String(n).repeat(40)));
    mem.put(P, lines.join(''));
    const { segs, outcome } = await collect(mem, { charBudget: 60, maxSegments: 2 });
    assert.equal(segs.length, 2);
    assert.equal(outcome.caughtUp, false);
    assert.equal(outcome.consumedOffset, Buffer.byteLength(lines[0] + lines[1]));
    assert.equal(segs[1].endOffset, outcome.consumedOffset);
  });

  it('oversize line is drained without buffering, counted, skipped; offset advances past it', async () => {
    const mem = makeMemFs({ chunkSize: 16 });
    const small = line('user', 'ok');
    const huge = line('user', 'z'.repeat(400));
    mem.put(P, small + huge + line('assistant', 'after'));
    const { segs, outcome } = await collect(mem, { maxLineBytes: 100 });
    assert.equal(outcome.linesSkippedOversize, 1);
    assert.equal(segs.length, 1);
    assert.equal(segs[0].text, '[user]: ok\n\n[assistant]: after');
    assert.equal(segs[0].linesSkippedOversize, 1);
    assert.equal(outcome.consumedOffset, Buffer.byteLength(small + huge + line('assistant', 'after')));
  });

  it('resuming from an offset yields the same segments as one single pass', async () => {
    const mem = makeMemFs({ chunkSize: 13 });
    const lines = Array.from({ length: 9 }, (_, i) => line(i % 2 ? 'assistant' : 'user', `turn-${i}-` + 'q'.repeat(30)));
    mem.put(P, lines.join(''));
    const single = await collect(mem, { charBudget: 120 });
    const resumed = [];
    let offset = 0;
    for (let guard = 0; guard < 20; guard++) {
      const { segs, outcome } = await collect(mem, { charBudget: 120, maxSegments: 1, fromOffset: offset });
      resumed.push(...segs);
      offset = outcome.consumedOffset;
      if (outcome.caughtUp) break;
    }
    assert.deepEqual(textOfSegments(resumed), textOfSegments(single.segs));
    assert.equal(offset, Buffer.byteLength(lines.join('')));
  });

  it('appended content after a stored offset is read exactly once', async () => {
    const mem = makeMemFs();
    const first = line('user', 'one') + line('assistant', 'two');
    mem.put(P, first);
    const a = await collect(mem);
    mem.put(P, first + line('user', 'three'));
    const b = await collect(mem, { fromOffset: a.outcome.consumedOffset });
    assert.deepEqual(textOfSegments(b.segs), ['[user]: three']);
  });

  it('non-text lines (meta types, malformed) are consumed without producing text', async () => {
    const mem = makeMemFs();
    const body = JSON.stringify({ type: 'attachment', x: 1 }) + '\nnot json\n' + '\n';
    mem.put(P, body);
    const { segs, outcome } = await collect(mem);
    assert.deepEqual(segs, []);
    assert.equal(outcome.consumedOffset, Buffer.byteLength(body));
    assert.equal(outcome.caughtUp, true);
  });

  it('flags the first non-blank record only when reading from offset 0', async () => {
    const seen = [];
    const spy = { parseLine: (l, ctx) => { seen.push(ctx.isFirstRecord); return 't'; } };
    const mem = makeMemFs();
    mem.put(P, '\nhead\nsecond\nthird\n');
    await collect(mem, {}, spy);
    assert.deepEqual(seen, [true, false, false]);
    seen.length = 0;
    await collect(mem, { fromOffset: 6 }, spy);
    assert.deepEqual(seen, [false, false]);
  });
});

describe('zstd path (D2)', () => {
  it('codecFor recognises .zst', () => {
    assert.equal(codecFor('/a/rollout-1.jsonl.zst'), 'zst');
    assert.equal(codecFor('/a/rollout-1.jsonl'), 'plain');
  });

  it('streams through the decompressor and discards fromOffset decompressed bytes', async () => {
    const mem = makeMemFs({ chunkSize: 11 });
    const lines = [line('user', 'first-' + 'a'.repeat(20)), line('user', 'second-' + 'b'.repeat(20)), line('user', 'third-' + 'c'.repeat(20))];
    mem.put('/s/r.jsonl.zst', lines.join(''));
    const { segs } = await collect(mem, { fromOffset: Buffer.byteLength(lines[0]) }, adapter, { path: '/s/r.jsonl.zst' });
    assert.equal(segs.length, 1);
    assert.ok(segs[0].text.startsWith('[user]: second-'));
    assert.ok(segs[0].text.includes('third-'));
    assert.ok(!segs[0].text.includes('first-'));
  });

  it('missing createZstdDecompress returns unsupported (counted by the runner), never a silent skip', async () => {
    const mem = makeMemFs();
    mem.put('/s/r.jsonl.zst', line('user', 'x'));
    const res = await readNewSegmentsOffset(adapter, { path: '/s/r.jsonl.zst' }, null, { fsImpl: mem.fsImpl, zlibImpl: {} });
    assert.equal(res.unsupported, ZST_UNSUPPORTED);
    assert.deepEqual(res.segments, []);
    const direct = {};
    for await (const _ of readSegments({ path: '/s/r.jsonl.zst' }, adapter, { fsImpl: mem.fsImpl, zlibImpl: {}, outcome: direct })) { /* none */ }
    assert.equal(direct.unsupported, ZST_UNSUPPORTED);
    const fwd = await forwardOnlyStateOffset({ path: '/s/r.jsonl.zst' }, { fsImpl: mem.fsImpl, zlibImpl: {} });
    assert.equal(fwd.unsupported, ZST_UNSUPPORTED);
  });

  it('an offset beyond the decompressed length resets to 0 and re-reads', async () => {
    const mem = makeMemFs();
    mem.put('/s/r.jsonl.zst', line('user', 'only'));
    const res = await readNewSegmentsOffset(adapter, { path: '/s/r.jsonl.zst' },
      { kind: 'offset', offset: 99999, headLen: 0, headSha: null, codec: 'zst' },
      { fsImpl: mem.fsImpl, zlibImpl: identityZlib });
    assert.equal(res.resetReason, 'offset_beyond_eof');
    assert.equal(res.segments.length, 1);
  });

  it('a plain rollout renamed to .zst keeps its offset when the head matches', async () => {
    const mem = makeMemFs();
    const content = line('user', 'one') + line('assistant', 'two') + line('user', 'three');
    mem.put('/s/r.jsonl', content);
    const first = await readNewSegmentsOffset(adapter, { path: '/s/r.jsonl' }, null, { fsImpl: mem.fsImpl, zlibImpl: identityZlib, maxSegments: 1, charBudget: 20 });
    assert.equal(first.caughtUp, false);
    mem.put('/s/r.jsonl.zst', content); // same bytes, now "compressed"
    const second = await readNewSegmentsOffset(adapter, { path: '/s/r.jsonl.zst' }, first.state, { fsImpl: mem.fsImpl, zlibImpl: identityZlib });
    assert.equal(second.resetReason, null);
    assert.ok(second.segments.length >= 1);
    assert.ok(!second.segments[0].text.includes('one'));
  });
});

describe('readNewSegments, kind offset (uniform contract)', () => {
  const opts = (mem, extra = {}) => ({ fsImpl: mem.fsImpl, zlibImpl: identityZlib, ...extra });

  it('first read returns segments with nextState and a final state', async () => {
    const mem = makeMemFs();
    const body = line('user', 'hi') + line('assistant', 'yo');
    mem.put(P, body);
    const res = await readNewSegmentsOffset(adapter, { path: P }, null, opts(mem));
    assert.equal(res.segments.length, 1);
    assert.equal(res.segments[0].nextState.kind, 'offset');
    assert.equal(res.segments[0].nextState.offset, Buffer.byteLength(body));
    assert.equal(res.state.offset, Buffer.byteLength(body));
    assert.equal(res.caughtUp, true);
    assert.equal(res.resetReason, null);
  });

  it('resets to 0 and reports size_shrank when the file is smaller than the stored offset', async () => {
    const mem = makeMemFs();
    mem.put(P, line('user', 'short'));
    const res = await readNewSegmentsOffset(adapter, { path: P }, { kind: 'offset', offset: 5000, headLen: 0, headSha: null, codec: 'plain' }, opts(mem));
    assert.equal(res.resetReason, 'size_shrank');
    assert.equal(res.segments.length, 1);
  });

  it('resets to 0 and reports head_changed when the head hash no longer matches', async () => {
    const mem = makeMemFs();
    const original = line('user', 'original-head') + line('assistant', 'more');
    mem.put(P, original);
    const first = await readNewSegmentsOffset(adapter, { path: P }, null, opts(mem));
    mem.put(P, line('user', 'REPLACED-head') + line('assistant', 'more') + line('user', 'extra'));
    const res = await readNewSegmentsOffset(adapter, { path: P }, first.state, opts(mem));
    assert.equal(res.resetReason, 'head_changed');
    assert.ok(res.segments[0].text.includes('REPLACED-head'));
  });

  it('a stored state with an intact head resumes without reset', async () => {
    const mem = makeMemFs();
    const original = line('user', 'stable') + line('assistant', 'reply');
    mem.put(P, original);
    const first = await readNewSegmentsOffset(adapter, { path: P }, null, opts(mem));
    mem.put(P, original + line('user', 'newer'));
    const res = await readNewSegmentsOffset(adapter, { path: P }, first.state, opts(mem));
    assert.equal(res.resetReason, null);
    assert.deepEqual(res.segments.map((s) => s.text), ['[user]: newer']);
  });

  it('forwardOnlyState points at the current end so only later additions are read', async () => {
    const mem = makeMemFs();
    const body = line('user', 'old') + line('assistant', 'older');
    mem.put(P, body);
    const st = await forwardOnlyStateOffset({ path: P }, { fsImpl: mem.fsImpl, zlibImpl: identityZlib });
    assert.equal(st.offset, Buffer.byteLength(body));
    mem.put(P, body + line('user', 'brand-new'));
    const res = await readNewSegmentsOffset(adapter, { path: P }, st, opts(mem));
    assert.deepEqual(res.segments.map((s) => s.text), ['[user]: brand-new']);
  });

  it('base class: non-capable adapters return unsupported, capable ones inherit the offset reader', async () => {
    class Plain extends TranscriptSource { static id = 'plain-test'; }
    const p = new Plain();
    assert.equal(p.offsetCapable, false);
    const res = await p.readNewSegments({ path: P }, null, {});
    assert.equal(res.unsupported, 'not_incremental_capable');
    assert.equal((await p.forwardOnlyState({ path: P })).unsupported, 'not_incremental_capable');
    assert.equal(adapter.offsetCapable, true);
  });
});
