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
const UUID_AT_END_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

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
    if (entry.isFile() && /^rollout-.*\.jsonl$/i.test(entry.name)) found.push(filePath);
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
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch { return String(value || ''); }
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

  async readSession(sessionRef) {
    const filePath = sessionRef && sessionRef.path;
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
      if (record.type !== 'response_item') continue;
      const payload = record.payload;
      if (!payload || typeof payload !== 'object') continue;

      if (payload.type === 'message') {
        const role = payload.role === 'user'
          ? 'User'
          : payload.role === 'assistant'
            ? 'Assistant'
            : null;
        if (!role) continue;
        const text = textContentItems(payload.content).join('\n').trim();
        if (text) turns.push(`${role}: ${text}`);
        continue;
      }

      if (payload.type === 'custom_tool_call') {
        const name = oneLine(payload.name || payload.tool_name || payload.tool || 'unknown');
        const args = oneLine(payload.arguments).slice(0, 500);
        turns.push(`Tool: ${name}${args ? ` ${args}` : ''}`);
        continue;
      }

      if (payload.type === 'custom_tool_call_output') {
        const items = toolOutputItems(payload)
          .map((item) => String(item).slice(0, 2000))
          .filter(Boolean);
        if (items.length > 0) turns.push(`Tool result: ${items.join('\n')}`);
      }
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
    process.stderr.write(`[codex-cli] format probe refused ${filePath || '(unknown)'} (${reason}) — skipping\n`);
    return null;
  }

  async registerSessionEndHook(cb) { return null; }
}

module.exports = {
  CodexCliSource,
  DEFAULT_QUIESCENCE_MS,
  resolveQuiescenceMs,
  rolloutSessionId,
};
