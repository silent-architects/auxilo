'use strict';

// INCREMENTAL-SWEEP D3 + D6: adapter parseLine / offsetCapable flags and Codex
// discovery of .jsonl.zst rollouts. fs is mocked per call (node:test mock); no
// disk is read or written.

const { describe, it, mock, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { makeMemFs, identityZlib } = require('./helpers/incremental-mem-fs');
const { ClaudeCodeSource } = require('../scripts/sources/claude-code');
const { CodexCliSource, rolloutSessionId, ROLLOUT_NAME_RE, recordToTurn } = require('../scripts/sources/codex-cli');
const { CopilotSource } = require('../scripts/sources/copilot');
const { OpenClawSource } = require('../scripts/sources/openclaw');
const { AntigravitySource } = require('../scripts/sources/antigravity');
const { GenericJsonlSource } = require('../scripts/sources/generic-jsonl');
const { ClineSource } = require('../scripts/sources/cline');
const { ContinueSource } = require('../scripts/sources/continue');
const { GeminiCliSource } = require('../scripts/sources/gemini-cli');
const { DevinSource } = require('../scripts/sources/devin');

afterEach(() => mock.restoreAll());

// Make fs.existsSync/readFileSync serve `text` for exactly `file`, nothing else changes.
function serve(file, text) {
  const realRead = fs.readFileSync;
  const realExists = fs.existsSync;
  mock.method(fs, 'existsSync', (p, ...a) => (p === file ? true : realExists.call(fs, p, ...a)));
  mock.method(fs, 'readFileSync', (p, ...a) => (p === file ? text : realRead.call(fs, p, ...a)));
}

function joinTurns(adapter, lines) {
  const turns = [];
  let first = true;
  for (const l of lines) {
    if (!l.trim()) continue;
    const t = adapter.parseLine(l, { isFirstRecord: first });
    first = false;
    if (t !== null) turns.push(t);
  }
  return turns.join('\n\n');
}

describe('offsetCapable flags (D3)', () => {
  it('append-only line-by-line adapters are capable', () => {
    for (const A of [ClaudeCodeSource, CodexCliSource, CopilotSource, OpenClawSource]) {
      assert.equal(new A().offsetCapable, true, A.id);
    }
  });

  it('antigravity and generic-jsonl stay false (whole-file 80% JSON probe is not a per-line property)', () => {
    assert.equal(new AntigravitySource().offsetCapable, false);
    assert.equal(new GenericJsonlSource({ id: 'cursor' }).offsetCapable, false);
  });

  it('rewritten-JSON and SQLite adapters stay false in this builder (builder 2 owns hashes/rowid)', () => {
    for (const A of [ClineSource, ContinueSource, GeminiCliSource, DevinSource]) {
      assert.equal(new A().offsetCapable, false, A.id);
    }
  });
});

describe('claude-code parseLine is byte-identical to readSession (D3)', () => {
  const lines = [
    JSON.stringify({ type: 'queue-operation', content: 'meta' }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'plain string' } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', text: 'hidden?' }, { type: 'text', text: 'visible' }, { type: 'tool_use', name: 'x' }] } }),
    JSON.stringify({ type: 'system', content: 'sys text' }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: '   ' } }),
    'not json at all',
    JSON.stringify({ message: { role: 'user', content: { text: 'object text' } } }),
  ];

  it('concatenated parseLine output equals readSession().transcript', async () => {
    const a = new ClaudeCodeSource({ dataDir: '/x', settingsPath: '/x' });
    serve('/fake/c.jsonl', lines.join('\n') + '\n');
    const whole = await a.readSession({ path: '/fake/c.jsonl', sessionId: 'c', mtime: 'm', bytes: 1 });
    assert.equal(whole.transcript, joinTurns(a, lines));
    assert.equal(a.parseLine(lines[0]), null);
    assert.equal(a.parseLine(lines[5]), null);
  });
});

describe('codex parseLine / probeSession / discovery (D3, D6)', () => {
  const meta = JSON.stringify({ type: 'session_meta', payload: { thread_source: 'user', originator: 'o' } });
  const rows = [
    meta,
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'question' }] } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'custom_tool_call', name: 'shell', arguments: { cmd: 'ls' } } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'custom_tool_call_output', output: 'file-a' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'agent_reasoning' } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'ignored' }] } }),
  ];

  it('parseLine matches readSession normalization and ignores non-response items', async () => {
    const a = new CodexCliSource({ codexDir: '/x/.codex' });
    serve('/fake/rollout-2026-11-01T00-00-00-01a15133-47e5-73a2-b68a-252ec537a0af.jsonl', rows.join('\n') + '\n');
    const whole = await a.readSession({ path: '/fake/rollout-2026-11-01T00-00-00-01a15133-47e5-73a2-b68a-252ec537a0af.jsonl', sessionId: 'x', mtime: 'm', bytes: 1 });
    assert.equal(whole.transcript, joinTurns(a, rows));
    assert.equal(a.parseLine(meta), null);
    assert.equal(a.parseLine('{bad'), null);
    assert.equal(recordToTurn(null), null);
  });

  it('probeSession accepts a user thread and refuses non-user, non-session_meta and unreadable heads', async () => {
    const mem = makeMemFs();
    const a = new CodexCliSource({ codexDir: '/x/.codex' });
    a._readerDeps = { fsImpl: mem.fsImpl, zlibImpl: identityZlib };
    mem.put('/r/ok.jsonl', rows.join('\n') + '\n');
    assert.deepEqual(await a.probeSession({ path: '/r/ok.jsonl' }), { ok: true });
    mem.put('/r/agent.jsonl', JSON.stringify({ type: 'session_meta', payload: { thread_source: 'agent_created_thread' } }) + '\n{}\n');
    assert.equal((await a.probeSession({ path: '/r/agent.jsonl' })).ok, false);
    mem.put('/r/nometa.jsonl', rows[1] + '\n');
    assert.equal((await a.probeSession({ path: '/r/nometa.jsonl' })).reason, 'first record is not session_meta');
    mem.put('/r/empty.jsonl', '');
    assert.equal((await a.probeSession({ path: '/r/empty.jsonl' })).ok, false);
    mem.put('/r/z.jsonl.zst', rows.join('\n') + '\n');
    assert.deepEqual(await a.probeSession({ path: '/r/z.jsonl.zst' }), { ok: true });
    a._readerDeps = { fsImpl: mem.fsImpl, zlibImpl: {} };
    const unsupported = await a.probeSession({ path: '/r/z.jsonl.zst' });
    assert.equal(unsupported.unsupported, true);
  });

  it('a compressed rollout is refused by the whole-file reader and flagged requiresIncremental', async () => {
    const a = new CodexCliSource({ codexDir: '/x/.codex' });
    assert.equal(a.requiresIncremental({ path: '/a/rollout-1.jsonl.zst' }), true);
    assert.equal(a.requiresIncremental({ path: '/a/rollout-1.jsonl' }), false);
    assert.equal(await a.readSession({ path: '/a/rollout-1.jsonl.zst', sessionId: 'z' }), null);
  });

  it('session id parses from .jsonl and .jsonl.zst names, including continuation files', () => {
    const id = '01a1b1e1-14f5-7260-be8c-a099d216cd49';
    assert.equal(rolloutSessionId(`/s/rollout-2026-11-06T11-21-20-${id}.jsonl.zst`), id);
    assert.equal(rolloutSessionId(`/s/rollout-2026-11-06T11-21-20-${id}.jsonl`), id);
    assert.equal(new CodexCliSource().sessionIdForPath(`/s/rollout-2026-11-06T11-21-20-${id}.jsonl.zst`), id);
  });

  it('ROLLOUT_NAME_RE matches rollout-*.jsonl[.zst] and nothing else', () => {
    for (const ok of ['rollout-2026-11-06T11-21-20-abc.jsonl', 'rollout-2026-11-06T11-21-20-abc.jsonl.zst', 'ROLLOUT-1.JSONL.ZST']) {
      assert.equal(ROLLOUT_NAME_RE.test(ok), true, ok);
    }
    for (const no of [
      'session_index.jsonl', 'history.jsonl', 'logs_2.sqlite', 'state_5.sqlite', 'thread_history_1.sqlite',
      '01a1b1e1-14f5-7260-be8c-a099d216cd49-1731.sh', 'image.png', 'rollout-1.jsonl.gz', 'rollout-1.jsonl.zst.tmp',
      'xrollout-1.jsonl', 'rollout-1.sh', '01a1b1e1.lock',
    ]) {
      assert.equal(ROLLOUT_NAME_RE.test(no), false, no);
    }
  });

  it('discovery includes sessions/ (recursive) and archived_sessions/ (flat) .jsonl and .jsonl.zst, excludes everything else', async () => {
    const root = '/home/u/.codex';
    const oldMs = Date.now() - 3 * 60 * 60 * 1000;
    const dir = (name) => ({ name, isDirectory: () => true, isFile: () => false });
    const file = (name) => ({ name, isDirectory: () => false, isFile: () => true });
    const tree = {
      [`${root}/sessions`]: [dir('2026'), dir('shell_snapshots'), dir('generated_images'), file('session_index.jsonl')],
      [`${root}/sessions/2026`]: [file('rollout-2026-11-06T11-21-20-01a1b1e1-14f5-7260-be8c-a099d216cd49.jsonl.zst'), file('rollout-2026-11-17T10-00-00-01a1c000-14f5-7260-be8c-a099d216cd49.jsonl'), file('notes.txt'), file('x.sqlite')],
      [`${root}/sessions/shell_snapshots`]: [file('01a1b1e1-14f5-7260-be8c-a099d216cd49-1731.sh')],
      [`${root}/sessions/generated_images`]: [file('01a1b1e1-14f5-7260-be8c-a099d216cd49.png')],
      [`${root}/archived_sessions`]: [file('rollout-2026-10-01T00-00-00-01a0aaaa-14f5-7260-be8c-a099d216cd49.jsonl.zst'), dir('nested'), file('thread-writer.lock')],
      [`${root}/archived_sessions/nested`]: [file('rollout-2026-10-02T00-00-00-01a0bbbb-14f5-7260-be8c-a099d216cd49.jsonl.zst')],
    };
    mock.method(fs, 'readdirSync', (p) => {
      if (tree[p]) return tree[p];
      const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e;
    });
    mock.method(fs, 'statSync', () => ({ isFile: () => true, mtimeMs: oldMs, mtime: new Date(oldMs), size: 1234 }));
    const found = await new CodexCliSource({ codexDir: root, env: {} }).discoverSessions({});
    const names = found.map((s) => path.basename(s.path)).sort();
    assert.deepEqual(names, [
      'rollout-2026-10-01T00-00-00-01a0aaaa-14f5-7260-be8c-a099d216cd49.jsonl.zst',
      'rollout-2026-11-06T11-21-20-01a1b1e1-14f5-7260-be8c-a099d216cd49.jsonl.zst',
      'rollout-2026-11-17T10-00-00-01a1c000-14f5-7260-be8c-a099d216cd49.jsonl',
    ]);
    assert.ok(found.every((s) => !/shell_snapshots|generated_images|nested/.test(s.path)));
  });

  it('discovery keeps the 30-minute quiescence rule for .zst too', async () => {
    const root = '/home/u/.codex';
    const freshMs = Date.now() - 60 * 1000;
    mock.method(fs, 'readdirSync', (p) => (p === `${root}/sessions`
      ? [{ name: 'rollout-1-01a1b1e1-14f5-7260-be8c-a099d216cd49.jsonl.zst', isDirectory: () => false, isFile: () => true }]
      : (() => { throw new Error('ENOENT'); })()));
    mock.method(fs, 'statSync', () => ({ isFile: () => true, mtimeMs: freshMs, mtime: new Date(freshMs), size: 10 }));
    assert.deepEqual(await new CodexCliSource({ codexDir: root, env: {} }).discoverSessions({}), []);
  });
});

describe('copilot and openclaw parseLine (D3)', () => {
  it('copilot: parseLine and readSession agree; tool-call turns and unknown events yield null', async () => {
    const a = new CopilotSource({ stateDir: '/x' });
    const rows = [
      JSON.stringify({ type: 'session.start', data: { selectedModel: 'm', sessionId: 'sid' } }),
      JSON.stringify({ type: 'user.message', data: { content: 'hello' } }),
      JSON.stringify({ type: 'assistant.message', data: { content: '', toolRequests: [{}] , model: 'mm' } }),
      JSON.stringify({ type: 'assistant.message', data: { content: 'reply', model: 'mm' } }),
      JSON.stringify({ type: 'tool.execution', data: {} }),
      'garbage',
    ];
    serve('/fake/events.jsonl', rows.join('\n') + '\n');
    const whole = await a.readSession({ path: '/fake/events.jsonl', sessionId: 'd', mtime: 'm', bytes: 1 });
    assert.equal(whole.transcript, joinTurns(a, rows));
    assert.equal(whole.transcript, '[user]: hello\n\n[assistant]: reply');
    assert.equal(whole.metadata.model, 'm');
  });

  it('openclaw: the first non-blank record (header) is never a turn only when isFirstRecord is set', async () => {
    const a = new OpenClawSource({ dataDir: '/x' });
    const rows = [
      JSON.stringify({ type: 'session', id: 'hdr' }),
      JSON.stringify({ role: 'user', content: 'hi there' }),
      JSON.stringify({ role: 'assistant', content: [{ text: 'blocks' }] }),
      '{bad',
    ];
    serve('/fake/o.jsonl', rows.join('\n') + '\n');
    const whole = await a.readSession({ path: '/fake/o.jsonl', sessionId: 'o', mtime: 'm', bytes: 1 });
    assert.equal(whole.transcript, joinTurns(a, rows));
    assert.equal(a.parseLine(rows[0], { isFirstRecord: true }), null);
    assert.equal(a.parseLine(rows[1], { isFirstRecord: false }), '[user]: hi there');
  });
});
