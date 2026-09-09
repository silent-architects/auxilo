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
      let payload;
      try {
        payload = JSON.parse(row.payload);
      } catch {
        continue; // one malformed row is ignored, not fatal to the session
      }
      const text = textFromChunks(payload && payload.content);
      if (!text) continue;
      const label = row.kind === 'user_message' ? '[user]' : '[assistant]';
      turns.push(`${label}: ${text}`);
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
  hasSqliteAccess,
  queryRows,
  textFromChunks,
};
