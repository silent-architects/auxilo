'use strict';

// INCREMENTAL-SWEEP ERRATUM-1 D3b (builder 2): Devin SQLite, state kind 'rowid'.
// A fake `node:sqlite` module is injected (config.sqliteModule): it records how
// the database was opened, parses the adapter's fixed SELECTs, and can simulate
// a busy/locked database. No SQLite file is created, opened or deleted.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { DevinSource, classifySqliteError } = require('../scripts/sources/devin');

const REF = { sessionId: 'sess-1', path: '/mem/acp/sess-1.db', mtime: '2026-11-24T00:00:00.000Z', bytes: 1 };
const OPTS = { charBudget: 30000, maxSegments: 3 };

function payload(text, kind = 'user_message') {
  const chunkType = kind === 'user_message' ? 'user_message_chunk' : 'agent_message_chunk';
  return JSON.stringify({ kind, content: [{ sessionUpdate: chunkType, content: { type: 'text', text } }] });
}

function row(position, kind, text) {
  return { position, kind, payload: kind === 'user_message' || kind === 'agent_message' ? payload(text, kind) : '{"kind":"tool_call"}' };
}

/** Fake node:sqlite. `rows` is the live table; mutate it between reads. */
function makeFakeSqlite(rows, { busyOn = null, busyErr = null } = {}) {
  const log = { opens: [], execs: [], prepares: [], closes: 0 };
  class DatabaseSync {
    constructor(p, opts) {
      log.opens.push({ path: p, opts });
      if (busyOn === 'open') throw busyErr || Object.assign(new Error('database is locked'), { errcode: 5, errstr: 'database is locked' });
    }
    exec(sql) { log.execs.push(sql); }
    prepare(sql) {
      log.prepares.push(sql);
      if (busyOn === 'query') throw busyErr || Object.assign(new Error('database is locked'), { errcode: 5 });
      return {
        all() {
          if (/^SELECT MAX\(position\)/.test(sql)) {
            return [{ m: rows.length ? Math.max(...rows.map((r) => r.position)) : null }];
          }
          const m = /WHERE position > (\d+) ORDER BY position LIMIT (\d+)/.exec(sql);
          assert.ok(m, `unexpected SQL: ${sql}`);
          const after = Number(m[1]);
          const limit = Number(m[2]);
          return rows
            .filter((r) => r.position > after)
            .sort((a, b) => a.position - b.position)
            .slice(0, limit)
            .map((r) => ({
              position: r.position,
              kind: r.kind,
              payload: r.kind === 'user_message' || r.kind === 'agent_message' ? r.payload : null,
            }));
        },
      };
    }
    close() { log.closes += 1; }
  }
  return { module: { DatabaseSync }, log };
}

function devin(rows, fakeOpts) {
  const fake = makeFakeSqlite(rows, fakeOpts);
  return { adapter: new DevinSource({ acpDir: '/mem/acp', sqliteModule: fake.module }), fake };
}

const texts = (res) => res.segments.map((s) => s.text).join('\n\n');

describe('devin rowid: flags and first read', () => {
  it('is offset-capable and always incremental', () => {
    const a = new DevinSource({ acpDir: '/mem/acp' });
    assert.equal(a.offsetCapable, true);
    assert.equal(a.requiresIncremental(REF), true);
  });

  it('no state: reads every message in position order, skips non-message rows, state = last position', async () => {
    const rows = [
      row(1, 'user_message', 'hello'),
      row(2, 'agent_thought', ''),
      row(3, 'agent_message', 'hi back'),
      row(4, 'tool_call', ''),
    ];
    const { adapter } = devin(rows);
    const res = await adapter.readNewSegments(REF, null, OPTS);
    assert.equal(texts(res), '[user]: hello\n\n[assistant]: hi back');
    assert.deepEqual(res.state, { kind: 'rowid', highWater: 4 });
    assert.equal(res.caughtUp, true);
    assert.equal(res.segments.length, 1);
    assert.deepEqual(res.segments[0].nextState, { kind: 'rowid', highWater: 4 });
  });

  it('streaming chunks of one row are concatenated exactly as readSession does', async () => {
    const chunks = ['Hel', 'lo ', 'world'].map((t) => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: t } }));
    const rows = [{ position: 1, kind: 'agent_message', payload: JSON.stringify({ content: chunks }) }];
    const { adapter } = devin(rows);
    assert.equal(texts(await adapter.readNewSegments(REF, null, OPTS)), '[assistant]: Hello world');
  });
});

describe('devin rowid: only rows past highWater', () => {
  it('reads strictly after highWater and never re-reads earlier rows', async () => {
    const rows = [row(1, 'user_message', 'one'), row(2, 'agent_message', 'two'), row(3, 'user_message', 'three')];
    const { adapter, fake } = devin(rows);
    const res = await adapter.readNewSegments(REF, { kind: 'rowid', highWater: 2 }, OPTS);
    assert.equal(texts(res), '[user]: three');
    assert.deepEqual(res.state, { kind: 'rowid', highWater: 3 });
    const selects = fake.log.prepares.filter((s) => s.includes('position >'));
    assert.ok(selects.every((s) => s.includes('position > 2')), 'every row query starts after highWater');
  });

  it('new rows after a caught-up state are the only thing returned; nothing new yields no segments', async () => {
    const rows = [row(1, 'user_message', 'one')];
    const { adapter } = devin(rows);
    const first = await adapter.readNewSegments(REF, null, OPTS);
    const quiet = await adapter.readNewSegments(REF, first.state, OPTS);
    assert.equal(quiet.segments.length, 0);
    assert.equal(quiet.caughtUp, true);
    assert.deepEqual(quiet.state, { kind: 'rowid', highWater: 1 });
    rows.push(row(2, 'agent_message', 'two'), row(3, 'agent_thought', ''));
    const more = await adapter.readNewSegments(REF, quiet.state, OPTS);
    assert.equal(texts(more), '[assistant]: two');
    assert.deepEqual(more.state, { kind: 'rowid', highWater: 3 }, 'trailing non-message rows are passed');
  });

  it('batches: more rows than one batch are all read in position order', async () => {
    const rows = [];
    for (let i = 1; i <= 1203; i++) rows.push(row(i, i % 2 ? 'user_message' : 'agent_message', `m${i}`));
    const { adapter, fake } = devin(rows);
    const res = await adapter.readNewSegments(REF, null, { charBudget: 1e9, maxSegments: 1 });
    assert.equal(res.segments.length, 1);
    assert.equal(res.segments[0].text.split('\n\n').length, 1203);
    assert.equal(res.state.highWater, 1203);
    assert.ok(fake.log.prepares.filter((s) => s.includes('LIMIT 500')).length >= 3);
  });

  it('segments are grouped to the charBudget; backlog resumes at the first unconsumed turn', async () => {
    const rows = [];
    for (let i = 1; i <= 6; i++) rows.push(row(i, 'user_message', String(i).repeat(40)));
    const { adapter } = devin(rows);
    const small = { charBudget: 100, maxSegments: 2 };
    const a = await adapter.readNewSegments(REF, null, small);
    assert.equal(a.segments.length, 2);
    assert.equal(a.caughtUp, false);
    assert.ok(a.segments.every((s) => s.text.length <= 100));
    assert.equal(a.state.highWater, a.segments[1].nextState.highWater);
    assert.ok(a.state.highWater < 6, 'unconsumed rows stay past highWater');
    const b = await adapter.readNewSegments(REF, a.state, { charBudget: 100, maxSegments: 9 });
    assert.equal(b.caughtUp, true);
    const joined = [...a.segments, ...b.segments].map((s) => s.text).join('\n\n');
    assert.equal(joined, rows.map((r) => `[user]: ${String(r.position).repeat(40)}`).join('\n\n'));
  });

  it('a highWater beyond the table max (db recreated) resets to a full re-read', async () => {
    const rows = [row(1, 'user_message', 'fresh')];
    const { adapter } = devin(rows);
    const res = await adapter.readNewSegments(REF, { kind: 'rowid', highWater: 99 }, OPTS);
    assert.equal(res.resetReason, 'highwater_beyond_max');
    assert.equal(texts(res), '[user]: fresh');
  });
});

describe('devin rowid: read-only open, busy database is transient', () => {
  it('opens with readOnly:true, runs only SELECTs and the busy_timeout pragma, and always closes', async () => {
    const rows = [row(1, 'user_message', 'hello')];
    const { adapter, fake } = devin(rows);
    await adapter.readNewSegments(REF, null, OPTS);
    await adapter.forwardOnlyState(REF);
    assert.ok(fake.log.opens.length >= 3);
    for (const o of fake.log.opens) {
      assert.equal(o.path, REF.path);
      assert.deepEqual(o.opts, { readOnly: true });
    }
    for (const sql of fake.log.prepares) assert.match(sql, /^SELECT /);
    for (const sql of fake.log.execs) assert.equal(sql, 'PRAGMA busy_timeout = 2000');
    assert.equal(fake.log.closes, fake.log.opens.length);
  });

  it('a locked database returns the state UNCHANGED and marks the result transient', async () => {
    const rows = [row(1, 'user_message', 'a'), row(2, 'user_message', 'b')];
    const prior = { kind: 'rowid', highWater: 1 };
    for (const busyOn of ['open', 'query']) {
      const { adapter } = devin(rows, { busyOn });
      const res = await adapter.readNewSegments(REF, prior, OPTS);
      assert.equal(res.transient, true, busyOn);
      assert.equal(res.transientReason, 'sqlite_busy');
      assert.deepEqual(res.state, prior);
      assert.equal(res.segments.length, 0);
      assert.equal(res.caughtUp, false);
      assert.equal(res.unsupported, undefined);
    }
  });

  it('a busy DB on first sight returns an explicit unadvanced state so the session stays in the backlog', async () => {
    const { adapter } = devin([row(1, 'user_message', 'a')], { busyOn: 'open' });
    const res = await adapter.readNewSegments(REF, null, OPTS);
    assert.equal(res.transient, true);
    assert.deepEqual(res.state, { kind: 'rowid', highWater: 0 });
  });

  it('classifies SQLITE_BUSY / LOCKED / READONLY (incl. extended codes) as transient, other errors as unsupported', () => {
    assert.equal(classifySqliteError({ errcode: 5 }).transient, true);
    assert.equal(classifySqliteError({ errcode: 6 }).transient, true);
    assert.equal(classifySqliteError({ errcode: 8 }).transient, true);
    assert.equal(classifySqliteError({ errcode: 5 | (2 << 8) }).transient, true);
    assert.equal(classifySqliteError({ message: 'database is locked' }).transient, true);
    assert.deepEqual(classifySqliteError({ errcode: 11, message: 'database disk image is malformed' }), { unsupported: 'sqlite_query_failed' });
  });

  it('a corrupt or unreadable database is unsupported (counted), not transient', async () => {
    const { adapter } = devin([], { busyOn: 'query', busyErr: Object.assign(new Error('no such table: messages'), { errcode: 1 }) });
    const res = await adapter.readNewSegments(REF, { kind: 'rowid', highWater: 3 }, OPTS);
    assert.equal(res.unsupported, 'sqlite_query_failed');
    assert.equal(res.transient, undefined);
    assert.deepEqual(res.state, { kind: 'rowid', highWater: 3 });
  });

  it('no sqlite module and no CLI is unsupported sqlite_unavailable', async () => {
    const a = new DevinSource({ acpDir: '/mem/acp', sqliteModule: null, selectRows: undefined });
    // sqliteModule:null forces the CLI branch; a stubbed probe says it is absent.
    const { selectRowsReadOnly } = require('../scripts/sources/devin');
    assert.deepEqual(selectRowsReadOnly(REF.path, 'SELECT 1', { sqliteModule: null, cliAvailable: false }), { unsupported: 'sqlite_unavailable' });
    assert.equal(a.offsetCapable, true);
  });
});

describe('devin rowid: forward-only first sight', () => {
  it('highWater = current max position (empty table = 0); later rows are the only new ones', async () => {
    const rows = [row(1, 'user_message', 'one'), row(7, 'agent_message', 'seven')];
    const { adapter } = devin(rows);
    const st = await adapter.forwardOnlyState(REF);
    assert.deepEqual(st, { kind: 'rowid', highWater: 7 });
    rows.push(row(8, 'user_message', 'eight'));
    assert.equal(texts(await adapter.readNewSegments(REF, st, OPTS)), '[user]: eight');
    const empty = devin([]);
    assert.deepEqual(await empty.adapter.forwardOnlyState(REF), { kind: 'rowid', highWater: 0 });
  });

  it('a busy DB during forward-only init is reported, never as a state', async () => {
    const { adapter } = devin([row(1, 'user_message', 'a')], { busyOn: 'open' });
    assert.deepEqual(await adapter.forwardOnlyState(REF), { unsupported: 'sqlite_busy' });
  });
});
