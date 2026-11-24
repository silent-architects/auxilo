'use strict';

// INCREMENTAL-SWEEP ERRATUM-1 D3b (builder 2): state kind 'hashes' for the
// rewritten-JSON adapters (cline, roo-code, continue, gemini-cli) and the
// one-time-probe offset path for antigravity / generic-jsonl. Delete-free:
// documents live in the in-memory fs helper and are injected through each
// adapter's `fsImpl`; nothing touches disk and no message content is real.

const { describe, it, mock, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { makeMemFs } = require('./helpers/incremental-mem-fs');
const { ClineSource } = require('../scripts/sources/cline');
const { RooCodeSource } = require('../scripts/sources/roo-code');
const { ContinueSource } = require('../scripts/sources/continue');
const { GeminiCliSource } = require('../scripts/sources/gemini-cli');
const { AntigravitySource } = require('../scripts/sources/antigravity');
const { GenericJsonlSource } = require('../scripts/sources/generic-jsonl');
const { HASH_SEEN_CAP, turnKeys } = require('../scripts/sources/segment-reader');
const incremental = require('../lib/incremental-sweep');

afterEach(() => mock.restoreAll());

const P = '/mem/tasks/t1/api_conversation_history.json';
const ref = (p = P) => ({ sessionId: 'cline-t1', path: p, mtime: '2026-11-24T00:00:00.000Z', bytes: 0 });
const OPTS = { charBudget: 30000, maxSegments: 3, maxBytes: 1024 * 1024 };

function msgs(n, prefix = 'm') {
  const out = [];
  for (let i = 0; i < n; i++) out.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: `${prefix}${i}` });
  return out;
}

function clineWith(doc, text) {
  const mem = makeMemFs();
  mem.put(P, text !== undefined ? text : JSON.stringify(doc));
  return { mem, adapter: new ClineSource({ fsImpl: mem.fsImpl, taskRoots: [] }) };
}

const texts = (res) => res.segments.map((s) => s.text).join('\n\n');

describe('hashes contract flags', () => {
  it('cline, roo-code, continue, gemini-cli are offset-capable and always incremental', () => {
    for (const A of [ClineSource, RooCodeSource, ContinueSource, GeminiCliSource]) {
      const a = new A();
      assert.equal(a.offsetCapable, true, A.id);
      assert.equal(a.requiresIncremental(ref()), true, A.id);
    }
  });

  it('decideMode routes a never-seen under-cap document through the incremental path, a handled one forward-only', () => {
    const a = new ClineSource();
    const base = { adapter: a, sessionRef: ref(), entry: null, size: 100, capBytes: 1000 };
    assert.equal(incremental.decideMode({ ...base, marks: [] }), 'incremental');
    assert.equal(incremental.decideMode({ ...base, marks: ['abc123'] }), 'forward-only-init');
  });
});

describe('cline hashes: unseen-only extraction', () => {
  it('first read returns every turn in document order, readSession-identical text', async () => {
    const doc = msgs(6);
    const { adapter, mem } = clineWith(doc);
    const res = await adapter.readNewSegments(ref(), null, OPTS);
    assert.equal(res.caughtUp, true);
    assert.equal(res.segments.length, 1);
    assert.equal(res.state.kind, 'hashes');
    assert.equal(res.state.seen.length, 6);
    assert.ok(res.state.seen.every((h) => /^[0-9a-f]{16}$/.test(h)));
    assert.match(res.state.docSha, /^[0-9a-f]{16}$/);

    // byte-identical to the whole-file readSession for the same document
    const realRead = fs.readFileSync;
    const realExists = fs.existsSync;
    mock.method(fs, 'existsSync', (p, ...a) => (p === P ? true : realExists.call(fs, p, ...a)));
    mock.method(fs, 'readFileSync', (p, ...a) => (p === P ? mem.files.get(P).data.toString('utf8') : realRead.call(fs, p, ...a)));
    const whole = await adapter.readSession(ref());
    assert.equal(texts(res), whole.transcript);
  });

  it('after an append only the new messages are extracted; nothing is re-read', async () => {
    const doc = msgs(4);
    const { adapter, mem } = clineWith(doc);
    const first = await adapter.readNewSegments(ref(), null, OPTS);
    mem.put(P, JSON.stringify([...doc, { role: 'user', content: 'brand new' }]));
    const second = await adapter.readNewSegments(ref(), first.state, OPTS);
    assert.equal(texts(second), '[user]: brand new');
    assert.equal(second.caughtUp, true);
    const third = await adapter.readNewSegments(ref(), second.state, OPTS);
    assert.equal(third.segments.length, 0);
    assert.equal(third.caughtUp, true);
    assert.equal(third.state.seen.length, 5);
  });

  it('an edited message hashes differently and counts as new', async () => {
    const doc = msgs(3);
    const { adapter, mem } = clineWith(doc);
    const first = await adapter.readNewSegments(ref(), null, OPTS);
    const edited = doc.map((m, i) => (i === 1 ? { ...m, content: 'm1 edited' } : m));
    mem.put(P, JSON.stringify(edited));
    const res = await adapter.readNewSegments(ref(), first.state, OPTS);
    assert.equal(texts(res), '[assistant]: m1 edited');
  });

  it('a NEW repeat of an old identical message is not swallowed (occurrence-aware keys)', async () => {
    const doc = [{ role: 'user', content: 'ok' }, { role: 'assistant', content: 'sure' }];
    const { adapter, mem } = clineWith(doc);
    const first = await adapter.readNewSegments(ref(), null, OPTS);
    mem.put(P, JSON.stringify([...doc, { role: 'user', content: 'ok' }]));
    const res = await adapter.readNewSegments(ref(), first.state, OPTS);
    assert.equal(texts(res), '[user]: ok');
    const keys = turnKeys(['a', 'a', 'a']);
    assert.equal(new Set(keys).size, 3);
  });

  it('rewrite and reorder stability: a pretty-printed or reordered rewrite yields nothing new', async () => {
    const doc = msgs(5);
    const { adapter, mem } = clineWith(doc);
    const first = await adapter.readNewSegments(ref(), null, OPTS);
    mem.put(P, JSON.stringify(doc, null, 4));
    const pretty = await adapter.readNewSegments(ref(), first.state, OPTS);
    assert.equal(pretty.segments.length, 0);
    assert.notEqual(pretty.state.docSha, first.state.docSha);
    mem.put(P, JSON.stringify([...doc].reverse()));
    const reordered = await adapter.readNewSegments(ref(), pretty.state, OPTS);
    assert.equal(reordered.segments.length, 0);
    assert.equal(reordered.caughtUp, true);
  });

  it('segments are grouped to the charBudget and backlog resumes from nextState', async () => {
    const doc = [];
    for (let i = 0; i < 6; i++) doc.push({ role: 'user', content: `${String(i).repeat(40)}` });
    const { adapter } = clineWith(doc);
    const small = { ...OPTS, charBudget: 100, maxSegments: 2 };
    const a = await adapter.readNewSegments(ref(), null, small);
    assert.equal(a.segments.length, 2);
    assert.equal(a.caughtUp, false);
    assert.ok(a.segments.every((s) => s.text.length <= 100));
    assert.equal(a.state.seen.length, a.segments.reduce((n, s) => n + s.endOffset - s.startOffset, 0));
    // the first segment's nextState holds only its own turns
    assert.equal(a.segments[0].nextState.seen.length, a.segments[0].endOffset - a.segments[0].startOffset);
    const b = await adapter.readNewSegments(ref(), a.state, { ...small, maxSegments: 5 });
    assert.equal(b.caughtUp, true);
    const joined = [...a.segments, ...b.segments].map((s) => s.text).join('\n\n');
    assert.equal(joined, doc.map((m) => `[user]: ${m.content}`).join('\n\n'));
  });

  it('a single turn longer than the budget is truncated to its head, never livelocks', async () => {
    const { adapter } = clineWith([{ role: 'user', content: 'x'.repeat(500) }]);
    const res = await adapter.readNewSegments(ref(), null, { ...OPTS, charBudget: 100 });
    assert.equal(res.segments.length, 1);
    assert.equal(res.segments[0].text.length, 100);
    assert.equal(res.caughtUp, true);
  });
});

describe('hashes: seen overflow is bounded and does not re-extract the front', () => {
  it('caps seen at 20,000 (most recent), flags truncated, and a follow-up read is quiet', async () => {
    const n = HASH_SEEN_CAP + 25;
    const { adapter, mem } = clineWith(msgs(n, 'q'));
    const big = { charBudget: 1e9, maxSegments: 1, maxBytes: 64 * 1024 * 1024 };
    const first = await adapter.readNewSegments(ref(), null, big);
    assert.equal(first.segments.length, 1);
    assert.equal(first.state.seen.length, HASH_SEEN_CAP);
    assert.equal(first.state.truncated, true);
    const again = await adapter.readNewSegments(ref(), first.state, big);
    assert.equal(again.segments.length, 0, 'the 25 dropped oldest keys must not re-extract the front');
    assert.equal(again.state.truncated, true);
    mem.put(P, JSON.stringify([...msgs(n, 'q'), { role: 'user', content: 'tail' }]));
    const grown = await adapter.readNewSegments(ref(), again.state, big);
    assert.equal(texts(grown), '[user]: tail');
  });
});

describe('hashes: oversize and unreadable documents are counted, never silent', () => {
  it('a document over maxBytes is unsupported oversize_document on read, probe and forward-only', async () => {
    const { adapter } = clineWith(msgs(50));
    const tiny = { ...OPTS, maxBytes: 64 };
    const res = await adapter.readNewSegments(ref(), null, tiny);
    assert.equal(res.unsupported, 'oversize_document');
    assert.equal(res.segments.length, 0);
    const prev = { kind: 'hashes', seen: ['aaaaaaaaaaaaaaaa'], docSha: 'b'.repeat(16) };
    const kept = await adapter.readNewSegments(ref(), prev, tiny);
    assert.equal(kept.state, prev, 'state is returned untouched');
    assert.equal((await adapter.forwardOnlyState(ref(), tiny)).unsupported, 'oversize_document');

    const saved = process.env.AUXILO_MAX_SESSION_BYTES;
    process.env.AUXILO_MAX_SESSION_BYTES = '64';
    try {
      const probe = await adapter.probeSession(ref());
      assert.deepEqual(probe, { ok: false, unsupported: true, reason: 'oversize_document' });
    } finally {
      if (saved === undefined) delete process.env.AUXILO_MAX_SESSION_BYTES; else process.env.AUXILO_MAX_SESSION_BYTES = saved;
    }
  });

  it('invalid JSON is unsupported (a half-written rewrite is retried, not marked); wrong shape is a permanent refusal', async () => {
    const half = clineWith(null, '[{"role":"user","content":"cut off');
    const r1 = await half.adapter.readNewSegments(ref(), null, OPTS);
    assert.equal(r1.unsupported, 'invalid_json_document');
    assert.equal((await half.adapter.probeSession(ref())).unsupported, true);

    const wrong = clineWith({ not: 'an array' });
    const probe = await wrong.adapter.probeSession(ref());
    assert.equal(probe.ok, false);
    assert.equal(probe.unsupported, undefined);
    assert.match(probe.reason, /format_probe_refused: not a messages array/);
    assert.equal((await wrong.adapter.readNewSegments(ref(), null, OPTS)).unsupported, 'format_probe_refused');
  });

  it('a missing file is unsupported document_unreadable', async () => {
    const mem = makeMemFs();
    const adapter = new ClineSource({ fsImpl: mem.fsImpl, taskRoots: [] });
    assert.equal((await adapter.readNewSegments(ref(), null, OPTS)).unsupported, 'document_unreadable');
  });
});

describe('hashes: forward-only first sight', () => {
  it('everything present counts as seen; only later additions are extracted', async () => {
    const doc = msgs(4);
    const { adapter, mem } = clineWith(doc);
    const st = await adapter.forwardOnlyState(ref(), OPTS);
    assert.equal(st.kind, 'hashes');
    assert.equal(st.seen.length, 4);
    const none = await adapter.readNewSegments(ref(), st, OPTS);
    assert.equal(none.segments.length, 0);
    mem.put(P, JSON.stringify([...doc, { role: 'assistant', content: 'later' }]));
    const later = await adapter.readNewSegments(ref(), st, OPTS);
    assert.equal(texts(later), '[assistant]: later');
  });
});

describe('roo-code, continue and gemini-cli share the engine with their own normalization', () => {
  it('roo-code reports its own type in the session id', () => {
    const a = new RooCodeSource({ taskRoots: [] });
    assert.equal(a.sessionIdForPath('/x/tasks/abc/api_conversation_history.json'), 'roo-code-abc');
    assert.equal(new ClineSource({ taskRoots: [] }).sessionIdForPath('/x/tasks/abc/api_conversation_history.json'), 'cline-abc');
  });

  it('continue: nested and bare history items, edit is new', async () => {
    const mem = makeMemFs();
    const p = '/mem/sessions/s1.json';
    const doc = { history: [{ message: { role: 'user', content: 'hello' } }, { role: 'assistant', content: 'hi there' }, { message: { role: 'tool', content: 'skip' } }] };
    mem.put(p, JSON.stringify(doc));
    const a = new ContinueSource({ fsImpl: mem.fsImpl, sessionsDir: '/mem/sessions' });
    const r = { sessionId: 's1', path: p };
    const first = await a.readNewSegments(r, null, OPTS);
    assert.equal(texts(first), '[user]: hello\n\n[assistant]: hi there');
    doc.history.push({ message: { role: 'user', content: 'more' } });
    mem.put(p, JSON.stringify(doc));
    assert.equal(texts(await a.readNewSegments(r, first.state, OPTS)), '[user]: more');
    assert.equal(a.sessionIdForPath(p), 's1');
  });

  it('gemini-cli: shape A (messages) and shape B (history/parts); session id is <hash>-<name>', async () => {
    const mem = makeMemFs();
    const pa = '/mem/tmp/h1/chats/session-1.json';
    const pb = '/mem/tmp/h1/chats/cp.json';
    mem.put(pa, JSON.stringify({ messages: [{ type: 'user', content: 'ask' }, { type: 'gemini', content: 'answer' }, { type: 'info', content: 'skip' }] }));
    mem.put(pb, JSON.stringify({ history: [{ role: 'user', parts: [{ text: 'q' }] }, { role: 'model', parts: [{ text: 'a' }, { thought: true, text: 'hidden' }] }] }));
    const a = new GeminiCliSource({ fsImpl: mem.fsImpl, dataDir: '/mem/tmp' });
    const ra = await a.readNewSegments({ sessionId: 'x', path: pa }, null, OPTS);
    assert.equal(texts(ra), '[user]: ask\n\n[assistant]: answer');
    const rb = await a.readNewSegments({ sessionId: 'y', path: pb }, null, OPTS);
    assert.equal(texts(rb), '[user]: q\n\n[assistant]: a');
    assert.equal(a.sessionIdForPath(pa), 'h1-session-1');
  });
});

describe('antigravity and generic-jsonl: one-time probe, then the offset reader', () => {
  const line = (o) => JSON.stringify(o);
  const jsonl = [
    line({ role: 'user', content: 'first question' }),
    line({ type: 'tool_use', name: 'x' }),
    line({ role: 'assistant', content: [{ type: 'text', text: 'first answer' }] }),
    '',
    line({ sender: 'human', text: 'second' }),
  ].join('\n') + '\n';

  it('parseLine reproduces readSession output exactly', async () => {
    const f = '/mem/brain/c1/.system_generated/logs/transcript.jsonl';
    const realRead = fs.readFileSync;
    const realExists = fs.existsSync;
    mock.method(fs, 'existsSync', (p, ...a) => (p === f ? true : realExists.call(fs, p, ...a)));
    mock.method(fs, 'readFileSync', (p, ...a) => (p === f ? jsonl : realRead.call(fs, p, ...a)));
    for (const a of [new AntigravitySource({ dataDir: '/mem/brain' }), new GenericJsonlSource({ id: 'cursor' })]) {
      const whole = await a.readSession({ sessionId: 's', path: f });
      const parts = jsonl.split('\n').filter((l) => l.trim()).map((l) => a.parseLine(l)).filter((t) => t !== null);
      assert.equal(parts.join('\n\n'), whole.transcript, a.type);
      assert.equal(a.offsetCapable, true);
    }
  });

  it('the probe passes a JSONL file once, refuses a mostly-non-JSON one as unsupported with its reason', async () => {
    const mem = makeMemFs();
    const good = '/mem/brain/c1/.system_generated/logs/t.jsonl';
    const bad = '/mem/brain/c2/.system_generated/logs/t.jsonl';
    mem.put(good, jsonl);
    mem.put(bad, ['not json', 'still not', line({ role: 'user', content: 'x' }), 'nope', 'nada'].join('\n'));
    const a = new AntigravitySource({ fsImpl: mem.fsImpl, dataDir: '/mem/brain' });
    assert.deepEqual(await a.probeSession({ path: good }), { ok: true });
    assert.deepEqual(await a.probeSession({ path: bad }), { ok: false, unsupported: true, reason: 'format_probe_refused' });
    const g = new GenericJsonlSource({ id: 'cursor', fsImpl: mem.fsImpl });
    assert.equal((await g.probeSession({ path: good })).ok, true);
    assert.equal((await g.probeSession({ path: '/mem/none' })).reason, 'probe_unreadable');
  });

  it('after the probe, readNewSegments streams only complete new lines (offset state)', async () => {
    const mem = makeMemFs();
    const f = '/mem/brain/c1/.system_generated/logs/t.jsonl';
    mem.put(f, jsonl);
    const a = new AntigravitySource({ fsImpl: mem.fsImpl, dataDir: '/mem/brain' });
    const r = { sessionId: 'c1-t', path: f };
    const opts = { ...OPTS, fsImpl: mem.fsImpl };
    const first = await a.readNewSegments(r, null, opts);
    assert.equal(first.state.kind, 'offset');
    assert.equal(texts(first), '[user]: first question\n\n[assistant]: first answer\n\n[user]: second');
    mem.put(f, jsonl + line({ role: 'assistant', content: 'third' }) + '\n' + '{"role":"user","content":"par');
    const second = await a.readNewSegments(r, first.state, opts);
    assert.equal(texts(second), '[assistant]: third');
    assert.equal(a.sessionIdForPath('/x/brain/c1/.system_generated/logs/t.jsonl'), 'c1-t');
  });
});
