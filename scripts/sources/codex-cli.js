/**
 * scripts/sources/codex-cli.js — Codex CLI + Desktop Transcript Source (UC-6)
 *
 * Best-effort UC-3 poll adapter.
 * UC-3 disclaimer: format community-reverse-engineered; verified against live operator install 2026-07-26 (247 rollouts).
 * Shape drift fails silent instead of producing a guessed transcript.
 *
 * Upstream context:
 *   openai/codex#21639 — Codex Desktop hooks regression
 *   openai/codex#24948 — rollout files can grow to multi-GB size
 *   openai/codex#21660 — rollout files may be created with 0644 permissions
 *
 * Desktop embeds the CLI and shares its ~/.codex rollout store, so one source
 * id deliberately covers both clients. Privacy-sensitive base instructions,
 * world state (including AGENTS.md), reasoning, and duplicate event messages
 * are never normalized into transcript output.
 *
 * @module sources/codex-cli
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { TranscriptSource } = require('./source.interface');

const DEFAULT_QUIESCENCE_MS = 30 * 60 * 1000;
const UUID_AT_END_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl(?:\.zst)?$/i;
// Rollout files only: rollout-*.jsonl, or rollout-*.jsonl.zst once Codex compresses a finished
// rollout. Nothing else under ~/.codex (shell_snapshots, generated_images, *.sqlite, ...) matches.
const ROLLOUT_NAME_RE = /^rollout-.*\.jsonl(?:\.zst)?$/i;

function resolveQuiescenceMs(env = process.env) {
  const raw = env && env.AUXILO_CODEX_QUIESCENCE_MS;
  if (raw === undefined || raw === null || raw === '') return DEFAULT_QUIESCENCE_MS;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_QUIESCENCE_MS;
}

function rolloutSessionId(filePath) {
  const name = path.basename(filePath);
  const match = name.match(UUID_AT_END_RE);
  return match ? match[1] : path.basename(name, path.extname(name));
}

function listRollouts(root, recursive) {
  const found = [];
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const filePath = path.join(root, entry.name);
    if (recursive && entry.isDirectory()) {
      found.push(...listRollouts(filePath, true));
      continue;
    }
    if (entry.isFile() && ROLLOUT_NAME_RE.test(entry.name)) found.push(filePath);
  }
  return found;
}

function textContentItems(content) {
  if (!Array.isArray(content)) return [];
  return content
    .filter((item) =>
      item &&
      typeof item === 'object' &&
      ['input_text', 'output_text', 'text'].includes(item.type) &&
      typeof item.text === 'string'
    )
    .map((item) => item.text);
}

function stringifyValue(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value) ?? ''; } catch { return String(value); }
}

function oneLine(value) {
  return stringifyValue(value).replace(/\s+/g, ' ').trim();
}

function toolOutputItems(payload) {
  const output = payload.output !== undefined ? payload.output : payload.content;
  if (typeof output === 'string') return [output];
  if (Array.isArray(output)) {
    return output.flatMap((item) => {
      if (typeof item === 'string') return [item];
      if (!item || typeof item !== 'object') return [];
      if (typeof item.text === 'string') return [item.text];
      if (typeof item.output === 'string') return [item.output];
      if (typeof item.content === 'string') return [item.content];
      return [];
    });
  }
  if (output && typeof output === 'object') {
    if (typeof output.text === 'string') return [output.text];
    if (typeof output.output === 'string') return [output.output];
  }
  return [];
}

/**
 * One parsed rollout record -> transcript turn, or null. Shared by readSession
 * and the incremental segment reader so both normalize identically.
 */
function recordToTurn(record) {
  if (!record || record.type !== 'response_item') return null;
  const payload = record.payload;
  if (!payload || typeof payload !== 'object') return null;

  if (payload.type === 'message') {
    const role = payload.role === 'user'
      ? 'User'
      : payload.role === 'assistant'
        ? 'Assistant'
        : null;
    if (!role) return null;
    const text = textContentItems(payload.content).join('\n').trim();
    return text ? `${role}: ${text}` : null;
  }

  if (payload.type === 'custom_tool_call') {
    const name = oneLine(payload.name || payload.tool_name || payload.tool || 'unknown');
    const args = oneLine(payload.arguments).slice(0, 500);
    return `Tool: ${name}${args ? ` ${args}` : ''}`;
  }

  if (payload.type === 'custom_tool_call_output') {
    const items = toolOutputItems(payload)
      .map((item) => String(item).slice(0, 2000))
      .filter(Boolean);
    return items.length > 0 ? `Tool result: ${items.join('\n')}` : null;
  }
  return null;
}

class CodexCliSource extends TranscriptSource {
  static id = 'codex-cli';
  static displayName = 'Codex (CLI + Desktop)';
  static version = '1.0.0';

  constructor(config = {}) {
    super(config);
    const homeDir = config.homeDir || os.homedir();
    this.codexDir = config.codexDir || path.join(homeDir, '.codex');
    this.sessionsDir = path.join(this.codexDir, 'sessions');
    this.archivedSessionsDir = path.join(this.codexDir, 'archived_sessions');
    this.env = config.env || process.env;
  }

  async detect() {
    try {
      return fs.statSync(this.sessionsDir).isDirectory();
    } catch {
      return false;
    }
  }

  async discoverSessions({ since } = {}) {
    const parsedSince = since ? Date.parse(since) : 0;
    const sinceMs = Number.isFinite(parsedSince) ? parsedSince : 0;
    const quiescentBefore = Date.now() - resolveQuiescenceMs(this.env);
    const candidates = [
      ...listRollouts(this.sessionsDir, true),
      ...listRollouts(this.archivedSessionsDir, false),
    ];
    const sessions = [];

    for (const filePath of candidates) {
      try {
        const stat = fs.statSync(filePath);
        if (!stat.isFile()) continue;
        if (stat.mtimeMs <= sinceMs || stat.mtimeMs >= quiescentBefore) continue;
        sessions.push({
          sessionId: rolloutSessionId(filePath),
          path: filePath,
          mtime: stat.mtime.toISOString(),
          bytes: stat.size,
        });
      } catch {
        // A rollout can disappear or become unreadable while the sweep walks.
      }
    }

    return sessions.sort((a, b) =>
      Date.parse(a.mtime) - Date.parse(b.mtime) || a.path.localeCompare(b.path)
    );
  }

  /** INCREMENTAL-SWEEP: append-only JSONL (plain or zstd-compressed), offset-resumable. */
  get offsetCapable() { return true; }

  sessionIdForPath(filePath) { return rolloutSessionId(filePath); }

  /** A zstd rollout cannot be read by the whole-file readSession; it must stream. */
  requiresIncremental(sessionRef) {
    return /\.zst$/i.test(String((sessionRef && sessionRef.path) || ''));
  }

  /** One rollout line -> turn, or null. session_meta and non-response items yield null. */
  parseLine(line) {
    try {
      const record = JSON.parse(line);
      return record && typeof record === 'object' ? recordToTurn(record) : null;
    } catch {
      return null;
    }
  }

  /**
   * Same user-thread gate readSession applies (first record must be a
   * session_meta with thread_source 'user'), evaluated on the first line only
   * so an incremental read never has to see the head again.
   */
  async probeSession(sessionRef) {
    try {
      const { readFirstLine, codecFor } = require('./segment-reader');
      const res = await readFirstLine(sessionRef.path, codecFor(sessionRef.path), this._readerDeps || {});
      if (res.unsupported) return { ok: false, reason: res.unsupported, unsupported: true };
      if (!res.line) return { ok: false, reason: 'first record unreadable' };
      let record;
      try { record = JSON.parse(res.line); } catch { return { ok: false, reason: 'first record is not JSON' }; }
      if (!record || record.type !== 'session_meta') return { ok: false, reason: 'first record is not session_meta' };
      const meta = record.payload;
      if (!meta || typeof meta !== 'object') return { ok: false, reason: 'session_meta payload missing' };
      if (meta.thread_source !== 'user') return { ok: false, reason: 'non-user thread' };
      return { ok: true };
    } catch {
      return { ok: false, reason: 'unreadable rollout' };
    }
  }

  async readSession(sessionRef) {
    try {
      return await this._readSession(sessionRef);
    } catch {
      // Gate-A F-A: the adapter contract is never-throw. A newly observed
      // optional field or other shape drift refuses the whole rollout rather
      // than escaping into the runner as a failed session.
      return this._refuse(sessionRef && sessionRef.path, 'unexpected normalization error');
    }
  }

  _readSession(sessionRef) {
    const filePath = sessionRef && sessionRef.path;
    if (/\.zst$/i.test(String(filePath || ''))) {
      return this._refuse(filePath, 'compressed rollout requires the incremental reader');
    }
    let raw;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch {
      return this._refuse(filePath, 'unreadable rollout');
    }

    const records = [];
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line);
        if (record && typeof record === 'object') records.push(record);
      } catch {
        // Individual malformed records are ignored; the format probe below
        // still requires a valid first record and at least two valid records.
      }
    }

    if (records.length === 0 || records[0].type !== 'session_meta') {
      return this._refuse(filePath, 'first parseable record is not session_meta');
    }
    const sessionMeta = records[0].payload;
    if (!sessionMeta || typeof sessionMeta !== 'object') {
      return this._refuse(filePath, 'session_meta payload missing');
    }
    if (sessionMeta.thread_source !== 'user') {
      return this._refuse(filePath, 'non-user thread');
    }
    if (records.length < 2) {
      return this._refuse(filePath, 'fewer than two parseable records');
    }

    const turns = [];
    for (const record of records) {
      const turn = recordToTurn(record);
      if (turn !== null) turns.push(turn);
    }

    return {
      transcript: turns.join('\n\n'),
      metadata: {
        sessionId: sessionRef.sessionId,
        source: 'codex-cli',
        mtime: sessionRef.mtime,
        bytes: sessionRef.bytes,
        originator: sessionMeta.originator,
        cwd: sessionMeta.cwd,
        model_provider: sessionMeta.model_provider,
      },
    };
  }

  _refuse(filePath, reason) {
    // Gate-A F-B: sweeps summarize refusals once in runner.js. Per-file paths
    // are available only under an explicit local debug opt-in.
    if (this.env.AUXILO_CODEX_DEBUG === '1') {
      process.stderr.write(`[codex-cli] format probe refused ${filePath || '(unknown)'} (${reason}) — skipping\n`);
    }
    return null;
  }

  async registerSessionEndHook(cb) { return null; }
}

module.exports = {
  CodexCliSource,
  DEFAULT_QUIESCENCE_MS,
  resolveQuiescenceMs,
  rolloutSessionId,
  recordToTurn,
  ROLLOUT_NAME_RE,
};
