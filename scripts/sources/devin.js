/**
 * scripts/sources/devin.js — Devin Desktop Transcript Source (BUILD-SPEC-0919)
 *
 * Best-effort UC-3 poll adapter, modeled on scripts/sources/codex-cli.js.
 * Replaces the pre-0.9.19 `windsurf` capture HOOK (the legacy
 * `post_cascade_response_with_transcript` event, VERIFIED to deliver
 * `tool_info:null` — useless) — Devin Desktop drops the hook entirely
 * (lib/installer.js clientRegistry `windsurf` entry) and this poll adapter
 * covers it instead.
 *
 * STORE (verified against a live install 2026-09-09):
 *   ~/Library/Application Support/Devin/User/acp-messages/<session-uuid>.db
 *   SQLite, schema: messages(position INTEGER PRIMARY KEY, kind TEXT NOT NULL,
 *   payload TEXT NOT NULL) + meta(key TEXT PRIMARY KEY, value TEXT NOT NULL).
 *   `.db-wal` / `.db-shm` siblings exist alongside an actively-open session —
 *   we only ever glob `*.db` and open read-only, which is safe to do
 *   concurrently with Devin's own WAL-mode writer.
 *
 * CRITICAL FILTER: many DBs in this directory are SUB-AGENT sessions —
 * agent_message/agent_thought/tool_call rows only, never a user_message. An
 * agent-only DB would yield an assistant-only transcript, so discoverSessions
 * opens each candidate and skips any DB with zero `user_message` rows.
 *
 * PAYLOAD SHAPE (verified): each `messages.payload` is JSON
 *   {"kind":"user_message"|"agent_message","content":[{"sessionUpdate":
 *   "user_message_chunk"|"agent_message_chunk","content":{"type":"text",
 *   "text":"..."}}, ...]}
 *   A short message is one chunk; a long agent_message can be split into
 *   dozens of small streaming deltas that must be concatenated IN ORDER
 *   (join, not newline-join) to reconstruct the full text.
 *
 * SQLITE READ STRATEGY: PRIMARY `node:sqlite` (DatabaseSync, readOnly) —
 * experimental, present on Node >=22.5, guarded in try/catch since it is
 * absent on older runtimes. FALLBACK: the system `sqlite3` binary via
 * `spawnSync(...,'-readonly','-json',...)`. When NEITHER is available,
 * discoverSessions returns [] and logs one best-effort line — never throws.
 * No new package.json dependency (no better-sqlite3).
 *
 * MODEL PROVENANCE: the store does not record which model produced the
 * conversation — neither `meta` (schema_version/info/message_count) nor any
 * per-message `payload` carries it. `meta.info` DOES carry a config-options
 * UI schema that happens to include a "model" *setting* (e.g. the currently
 * selected model in Devin's own settings panel at snapshot time) — that is
 * an app-preference snapshot, not a per-message attribution, and using it
 * would be exactly the kind of guess this field exists to forbid. Every
 * emitted session is stamped `model_provider: 'unknown'`, never inferred.
 *
 * @module sources/devin
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { TranscriptSource } = require('./source.interface');

// Guarded require: node:sqlite is experimental and absent on Node <22.5.
let NODE_SQLITE = null;
try {
  // eslint-disable-next-line global-require
  NODE_SQLITE = require('node:sqlite');
} catch {
  NODE_SQLITE = null;
}

// Cached presence probe for the system `sqlite3` binary (one spawnSync per
// process, not per file/session).
let _cliProbed = false;
let _cliAvailable = false;
function sqliteCliAvailable() {
  if (_cliProbed) return _cliAvailable;
  _cliProbed = true;
  try {
    const res = spawnSync('sqlite3', ['-version'], { encoding: 'utf8', timeout: 5000 });
    _cliAvailable = !res.error && res.status === 0;
  } catch {
    _cliAvailable = false;
  }
  return _cliAvailable;
}

/** True when either read path could plausibly open a database. */
function hasSqliteAccess() {
  return Boolean(NODE_SQLITE) || sqliteCliAvailable();
}

/**
 * Query `sql` (no params — every caller here uses a fixed literal, no user
 * input) against a readonly-opened sqlite db. Tries node:sqlite first, then
 * the `sqlite3 -json` CLI. Returns an array of row objects, or `null` when
 * the file could not be queried at all (missing, corrupt, locked mid-write
 * in a way that defeats even WAL-mode readers, or neither read method
 * available). Callers treat `null` as "skip this file" — this function
 * itself never throws.
 *
 * @param {string} dbPath
 * @param {string} sql
 * @returns {Array<object>|null}
 */
function queryRows(dbPath, sql) {
  if (NODE_SQLITE) {
    let db = null;
    try {
      db = new NODE_SQLITE.DatabaseSync(dbPath, { readOnly: true });
      return db.prepare(sql).all();
    } catch {
      // Fall through to the CLI fallback below.
    } finally {
      if (db) {
        try { db.close(); } catch { /* best-effort */ }
      }
    }
  }
  if (sqliteCliAvailable()) {
    try {
      const res = spawnSync('sqlite3', ['-readonly', '-json', dbPath, sql], {
        encoding: 'utf8',
        timeout: 15000,
      });
      if (res.error || res.status !== 0) return null;
      const trimmed = (res.stdout || '').trim();
      if (!trimmed) return [];
      const parsed = JSON.parse(trimmed);
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** True when the db at `dbPath` contains at least one user_message row. */
function hasUserMessage(dbPath, queryRowsFn) {
  const rows = queryRowsFn(dbPath, "SELECT 1 AS x FROM messages WHERE kind = 'user_message' LIMIT 1");
  return Array.isArray(rows) && rows.length > 0;
}

/**
 * Reassemble a message's full text by concatenating (NOT newline-joining)
 * `chunk.content.text` across the payload's `content[]` streaming-chunk
 * array, in order. A chunk missing a string `.content.text` contributes
 * nothing (never throws on shape drift).
 */
function textFromChunks(content) {
  if (!Array.isArray(content)) return '';
  let text = '';
  for (const chunk of content) {
    if (chunk && chunk.content && typeof chunk.content.text === 'string') {
      text += chunk.content.text;
    }
  }
  return text;
}

/** One messages row -> `[user]: ...` / `[assistant]: ...` turn, or null (malformed / empty). */
function turnOfRow(row) {
  let payload;
  try {
    payload = JSON.parse(row.payload);
  } catch {
    return null; // one malformed row is ignored, not fatal to the session
  }
  const text = textFromChunks(payload && payload.content);
  if (!text) return null;
  const label = row.kind === 'user_message' ? '[user]' : '[assistant]';
  return `${label}: ${text}`;
}

// ─── Incremental reads (INCREMENTAL-SWEEP D3b, state kind 'rowid') ───────────

const ROW_BATCH = 500;
const SQLITE_BUSY_CODES = new Set([5, 6, 8]); // BUSY, LOCKED, READONLY (WAL recovery needs a writer)

/**
 * Classify a thrown SQLite error. Busy/locked/readonly-recovery are TRANSIENT
 * (the same query succeeds later); anything else is a permanent unsupported.
 */
function classifySqliteError(err) {
  const code = Number.isInteger(err && err.errcode) ? (err.errcode & 0xff) : null;
  if (code !== null && SQLITE_BUSY_CODES.has(code)) return { transient: true, reason: 'sqlite_busy' };
  const msg = String((err && (err.message || err.errstr)) || '');
  if (/database is locked|database table is locked|SQLITE_BUSY|SQLITE_LOCKED|busy/i.test(msg)) {
    return { transient: true, reason: 'sqlite_busy' };
  }
  return { unsupported: 'sqlite_query_failed' };
}

/**
 * Run one fixed SELECT against `dbPath`, READ-ONLY, never writing and never
 * holding a write lock (node:sqlite `readOnly: true`; the CLI fallback passes
 * `-readonly`). The SQL is built by this adapter from validated integers only.
 * Returns {rows} | {transient:true, reason} | {unsupported:reason}. Never throws.
 */
function selectRowsReadOnly(dbPath, sql, deps = {}) {
  const sqlite = deps.sqliteModule !== undefined ? deps.sqliteModule : NODE_SQLITE;
  if (sqlite) {
    let db = null;
    try {
      db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
      try { db.exec('PRAGMA busy_timeout = 2000'); } catch { /* connection setting only; best-effort */ }
      return { rows: db.prepare(sql).all() };
    } catch (err) {
      return classifySqliteError(err);
    } finally {
      if (db) { try { db.close(); } catch { /* best-effort */ } }
    }
  }
  const cliOk = deps.cliAvailable !== undefined ? deps.cliAvailable : sqliteCliAvailable();
  if (cliOk) {
    try {
      const res = (deps.spawn || spawnSync)('sqlite3', ['-readonly', '-json', dbPath, sql], { encoding: 'utf8', timeout: 15000 });
      if (res.error) return { unsupported: 'sqlite_query_failed' };
      if (res.status !== 0) return classifySqliteError({ message: res.stderr || '' });
      const trimmed = (res.stdout || '').trim();
      if (!trimmed) return { rows: [] };
      const parsed = JSON.parse(trimmed);
      return Array.isArray(parsed) ? { rows: parsed } : { unsupported: 'sqlite_query_failed' };
    } catch {
      return { unsupported: 'sqlite_query_failed' };
    }
  }
  return { unsupported: 'sqlite_unavailable' };
}

function safeInt(n) {
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

class DevinSource extends TranscriptSource {
  static id = 'devin';
  static displayName = 'Devin Desktop';
  static version = '1.0.0';

  constructor(config = {}) {
    super(config);
    const homeDir = config.homeDir || os.homedir();
    this.acpDir = config.acpDir ||
      path.join(homeDir, 'Library', 'Application Support', 'Devin', 'User', 'acp-messages');
    // Test seams (spec: "(can stub)") — default to the real implementations
    // above. Injecting these lets tests exercise the discovery filter and
    // the streaming-chunk reassembly against fixture data, and simulate the
    // "neither sqlite method available" best-effort path, all without
    // touching the module-level require/spawnSync probes.
    this._queryRows = config.queryRows || queryRows;
    this._hasSqliteAccess = config.hasSqliteAccess || hasSqliteAccess;
    // Incremental read seam: (dbPath, sql) -> {rows}|{transient,reason}|{unsupported}.
    this._selectRows = config.selectRows || ((dbPath, sql) => selectRowsReadOnly(dbPath, sql, { sqliteModule: config.sqliteModule }));
  }

  async detect() {
    try {
      return fs.statSync(this.acpDir).isDirectory();
    } catch {
      return false;
    }
  }

  async discoverSessions({ since } = {}) {
    let entries;
    try {
      entries = fs.readdirSync(this.acpDir);
    } catch {
      return [];
    }
    // Glob *.db only — NOT the -wal/-shm siblings of an actively-open session.
    const dbFiles = entries.filter((f) => f.endsWith('.db'));
    if (dbFiles.length === 0) return [];

    if (!this._hasSqliteAccess()) {
      this._logNoSqliteAccess();
      return [];
    }

    const parsedSince = since ? Date.parse(since) : 0;
    const sinceMs = Number.isFinite(parsedSince) ? parsedSince : 0;
    const sessions = [];

    for (const file of dbFiles) {
      const filePath = path.join(this.acpDir, file);
      let stat;
      try {
        stat = fs.statSync(filePath);
        if (!stat.isFile()) continue;
      } catch {
        continue; // a session db can disappear while the sweep walks
      }
      if (stat.mtimeMs <= sinceMs) continue;
      // CRITICAL FILTER: agent-only (sub-agent) DBs carry zero user_message
      // rows and would yield an assistant-only transcript — skip them.
      if (!hasUserMessage(filePath, this._queryRows)) continue;
      sessions.push({
        sessionId: path.basename(file, '.db'),
        path: filePath,
        mtime: stat.mtime.toISOString(),
        bytes: stat.size,
      });
    }

    return sessions.sort((a, b) =>
      Date.parse(a.mtime) - Date.parse(b.mtime) || a.path.localeCompare(b.path)
    );
  }

  async readSession(sessionRef) {
    try {
      return this._readSession(sessionRef);
    } catch {
      // Adapter contract is never-throw (matches codex-cli.js Gate-A F-A):
      // an unexpected shape refuses the whole session rather than escaping
      // into the runner as a failed read.
      return null;
    }
  }

  _readSession(sessionRef) {
    const filePath = sessionRef && sessionRef.path;
    if (!filePath) return null;

    const rows = this._queryRows(
      filePath,
      "SELECT position, kind, payload FROM messages WHERE kind IN ('user_message','agent_message') ORDER BY position"
    );
    if (!Array.isArray(rows)) return null; // unreadable/unqueryable — best-effort skip, not a failure

    const turns = [];
    for (const row of rows) {
      const turn = turnOfRow(row);
      if (turn !== null) turns.push(turn);
    }

    if (turns.length === 0) return null;

    return {
      transcript: turns.join('\n\n'),
      metadata: {
        sessionId: sessionRef.sessionId,
        source: 'devin',
        mtime: sessionRef.mtime,
        bytes: sessionRef.bytes,
        // MODEL PROVENANCE: never inferred — see module header. Stamped
        // explicitly rather than omitted so the field's absence is never
        // mistaken for an oversight.
        model_provider: 'unknown',
      },
    };
  }

  // ─── INCREMENTAL-SWEEP: state kind 'rowid' ────────────────────────────────
  //
  // `messages.position INTEGER PRIMARY KEY` IS the SQLite rowid (an alias), so
  // it is unique and, for append-only inserts, monotonic; it is also the column
  // readSession already orders by. highWater = the greatest `position` already
  // handled. Only rows past it are read, ascending, in batches, read-only.

  get offsetCapable() { return true; }

  /** Rows are keyed by position, not bytes: route every session through the incremental path. */
  requiresIncremental() { return true; }

  async probeSession(sessionRef) { return { ok: true }; }

  async readNewSegments(sessionRef, state, opts = {}) {
    const dbPath = sessionRef && sessionRef.path;
    const charBudget = opts.charBudget > 0 ? opts.charBudget : 30000;
    const maxSegments = opts.maxSegments > 0 ? opts.maxSegments : 3;
    const prior = state && state.kind === 'rowid' && safeInt(state.highWater) !== null ? state : null;
    const unchanged = prior || { kind: 'rowid', highWater: 0 };
    if (!dbPath) return { segments: [], state: unchanged, caughtUp: false, unsupported: 'no_path' };

    const fail = (r) => (r.transient
      ? { segments: [], state: unchanged, caughtUp: false, transient: true, transientReason: r.reason }
      : { segments: [], state: unchanged, caughtUp: false, unsupported: r.unsupported });

    const maxRes = this._selectRows(dbPath, 'SELECT MAX(position) AS m FROM messages');
    if (!maxRes.rows) return fail(maxRes);
    const maxPos = maxRes.rows.length > 0 && maxRes.rows[0] ? safeInt(Number(maxRes.rows[0].m)) : null;

    let cursor = prior ? prior.highWater : 0;
    let resetReason = null;
    if (cursor > (maxPos === null ? 0 : maxPos)) { resetReason = 'highwater_beyond_max'; cursor = 0; }

    const segments = [];
    let cur = [];
    let curLen = 0;
    let curLast = cursor;
    let scanned = cursor; // greatest position looked at (incl. non-message rows)
    let caughtUp = false;
    let stoppedForSegments = false;

    const flush = () => {
      segments.push({
        text: cur.join('\n\n'),
        startOffset: segments.length === 0 ? (prior && !resetReason ? prior.highWater : 0) : segments[segments.length - 1].endOffset,
        endOffset: curLast,
        linesSkippedOversize: 0,
        nextState: { kind: 'rowid', highWater: curLast },
      });
      cur = []; curLen = 0;
    };

    for (;;) {
      const sql = "SELECT position, kind, CASE WHEN kind IN ('user_message','agent_message') THEN payload ELSE NULL END AS payload"
        + ` FROM messages WHERE position > ${cursor} ORDER BY position LIMIT ${ROW_BATCH}`;
      const res = this._selectRows(dbPath, sql);
      if (!res.rows) return fail(res);
      const rows = res.rows;
      for (const row of rows) {
        const pos = safeInt(Number(row.position));
        if (pos === null) continue;
        scanned = pos;
        cursor = pos;
        if (row.kind !== 'user_message' && row.kind !== 'agent_message') continue;
        let t = turnOfRow(row);
        if (t === null) continue;
        if (t.length > charBudget) t = t.slice(0, charBudget);
        if (cur.length > 0 && curLen + 2 + t.length > charBudget) {
          flush();
          if (segments.length >= maxSegments) { stoppedForSegments = true; break; }
        }
        curLen += (cur.length > 0 ? 2 : 0) + t.length;
        cur.push(t);
        curLast = pos;
      }
      if (stoppedForSegments) break;
      if (rows.length < ROW_BATCH) { caughtUp = true; break; }
    }

    if (stoppedForSegments) {
      // The turn that did not fit was NOT consumed: resume from just before it.
      // `cursor` is its position; the row is re-read next time.
      const resume = segments[segments.length - 1].nextState.highWater;
      return { segments, state: { kind: 'rowid', highWater: resume }, caughtUp: false, resetReason };
    }
    if (cur.length > 0) flush();
    // Fully scanned: the cursor may advance past trailing non-message rows too.
    const finalHigh = caughtUp ? Math.max(scanned, segments.length ? segments[segments.length - 1].endOffset : 0) : cursor;
    const finalState = { kind: 'rowid', highWater: finalHigh };
    if (segments.length > 0) segments[segments.length - 1].nextState = { kind: 'rowid', highWater: finalHigh };
    return { segments, state: finalState, caughtUp, resetReason };
  }

  /** Everything currently in the DB counts as handled: highWater = current max position. */
  async forwardOnlyState(sessionRef) {
    const dbPath = sessionRef && sessionRef.path;
    if (!dbPath) return { unsupported: 'no_path' };
    const res = this._selectRows(dbPath, 'SELECT MAX(position) AS m FROM messages');
    if (!res.rows) return { unsupported: res.transient ? res.reason : res.unsupported };
    const m = res.rows.length > 0 && res.rows[0] ? safeInt(Number(res.rows[0].m)) : null;
    return { kind: 'rowid', highWater: m === null ? 0 : m };
  }

  /** Best-effort, never-throw single log line (spec: "logs one best-effort line"). */
  _logNoSqliteAccess() {
    try {
      process.stderr.write(
        '[devin] no SQLite access available (node:sqlite absent and sqlite3 CLI not found) — Devin capture skipped this sweep\n'
      );
    } catch {
      /* best-effort */
    }
  }

  async registerSessionEndHook(cb) {
    return null; // poll-only source — no live hook (see module header)
  }
}

module.exports = {
  DevinSource,
  selectRowsReadOnly,
  classifySqliteError,
  turnOfRow,
  hasSqliteAccess,
  queryRows,
  textFromChunks,
};
