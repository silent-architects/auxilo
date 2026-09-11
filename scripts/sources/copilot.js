/**
 * scripts/sources/copilot.js — GitHub Copilot CLI Transcript Source (BUILD-SPEC-0920)
 *
 * What already works (DO NOT touch — lib/installer.js registry entry
 * 'copilot-cli' is correct as shipped): the capture Stop hook fires and
 * hands runner.js a real `transcript_path` resolving to
 * `~/.copilot/session-state/<sessionId>/events.jsonl`. That part was
 * VERIFIED live (Copilot CLI 1.0.83/1.0.84, 2026-09-10). The gap this file
 * closes: that transcript is a TYPED EVENT STREAM, not the plain
 * role/content JSONL the generic-jsonl fallback expects, so capture fired,
 * found the file, and silently extracted 0 turns. This is the dedicated
 * parser so the 'copilot' entry on the client matrix is actually true.
 *
 * Line shape (VERIFIED live): one JSON object per line, `{"type":"<t>",
 * "data":{...}}`. Types observed: session.start,
 * session.permissions_changed, hook.start, hook.end, user.message,
 * system.message, assistant.turn_start, assistant.message,
 * tool.execution_start, tool.execution_complete, assistant.turn_end,
 * session.usage_checkpoint, session.shutdown. Only two contribute
 * conversation text; every other type — named above or not yet observed —
 * is deliberately ignored rather than enumerated, so an unfamiliar future
 * type is skipped, not a parse break.
 *
 * Extracted:
 *   - user.message      -> [user]: data.content (a plain string). We
 *     deliberately ignore data.transformedContent — it wraps the same
 *     prompt in a <current_datetime> block and would duplicate/pollute
 *     the turn.
 *   - assistant.message  -> [assistant]: data.content WHEN non-empty. An
 *     assistant.message with content:"" is a pure tool-call turn (its
 *     data.toolRequests[] carries the call instead) and contributes no
 *     text — skipped, not an empty turn.
 *
 * MODEL PROVENANCE (real, not 'unknown' — Copilot is the first client that
 * records this on disk, unlike e.g. Devin which has no such field anywhere
 * in its store): `session.start.data.selectedModel` (e.g. "gpt-5.6-terra")
 * is authoritative; when a session lacks a readable session.start record,
 * the last-seen `assistant.message.data.model` is used as a fallback.
 * Never guessed beyond those two on-disk fields.
 *
 * SESSION ID: preferring the in-file `session.start.data.sessionId` over
 * the caller-supplied `sessionRef.sessionId` matters for the hook path —
 * runner.js's single-file mode derives sessionId from the transcript
 * filename minus extension, and the filename here is always literally
 * `events.jsonl` (the real session id is the PARENT directory, not the
 * file), so relying on the caller's guess alone would stamp every
 * hook-fired session as "events". The poll path below already discovers
 * the correct id from the directory name, so this is primarily a hook-path
 * correction, but the file's own value wins in both paths when present.
 *
 * @module sources/copilot
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { TranscriptSource } = require('./source.interface');

class CopilotSource extends TranscriptSource {
  static id = 'copilot';
  static displayName = 'GitHub Copilot CLI';
  static version = '1.0.0';

  constructor(config = {}) {
    super(config);
    const homeDir = config.homeDir || os.homedir();
    this.stateDir = config.stateDir || path.join(homeDir, '.copilot', 'session-state');
  }

  async detect() {
    try {
      return fs.statSync(this.stateDir).isDirectory();
    } catch {
      return false;
    }
  }

  /**
   * Hook-fired single-file capture is the primary path (see module header):
   * the Stop hook hands runner.js the exact events.jsonl path directly, so
   * this poll is a best-effort backfill only — a session the hook missed
   * (e.g. capture briefly disabled) is still picked up by a later sweep.
   * Returning [] here would be a perfectly valid contract too (hook-only
   * clients do exactly that); this is simple enough over the fixed
   * `<sessionId>/events.jsonl` layout to be worth the extra coverage.
   */
  async discoverSessions({ since } = {}) {
    const parsedSince = since ? Date.parse(since) : 0;
    const sinceMs = Number.isFinite(parsedSince) ? parsedSince : 0;

    let entries;
    try {
      entries = fs.readdirSync(this.stateDir, { withFileTypes: true });
    } catch {
      return [];
    }

    const sessions = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const filePath = path.join(this.stateDir, entry.name, 'events.jsonl');
      let stat;
      try {
        stat = fs.statSync(filePath);
        if (!stat.isFile()) continue;
      } catch {
        continue; // a session dir can lack/lose events.jsonl mid-sweep
      }
      if (stat.mtimeMs <= sinceMs) continue;
      sessions.push({
        sessionId: entry.name,
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
      // Adapter contract is never-throw (matches codex-cli.js / devin.js):
      // unexpected shape drift refuses the whole session, never escapes
      // into the runner as a failed read.
      return null;
    }
  }

  _readSession(sessionRef) {
    const filePath = sessionRef && sessionRef.path;
    if (!filePath) return null;

    let raw;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch {
      return null;
    }

    const turns = [];
    let sessionId = null;
    let selectedModel = null;
    let lastAssistantModel = null;

    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue; // one malformed line is skipped, not fatal to the session
      }
      if (!event || typeof event !== 'object') continue;
      const data = event.data;
      const type = event.type;

      if (type === 'session.start') {
        if (data && typeof data.selectedModel === 'string' && data.selectedModel) {
          selectedModel = data.selectedModel;
        }
        if (data && typeof data.sessionId === 'string' && data.sessionId) {
          sessionId = data.sessionId;
        }
        continue;
      }

      if (type === 'user.message') {
        if (data && typeof data.content === 'string' && data.content.length > 0) {
          turns.push(`[user]: ${data.content}`);
        }
        continue;
      }

      if (type === 'assistant.message') {
        if (data && typeof data.model === 'string' && data.model) {
          lastAssistantModel = data.model;
        }
        // Empty content = a pure tool-call turn (data.toolRequests[] carries
        // the call instead) — no text to extract, not an empty turn.
        if (data && typeof data.content === 'string' && data.content.length > 0) {
          turns.push(`[assistant]: ${data.content}`);
        }
        continue;
      }

      // Every other type (session.*, hook.*, tool.*, system.message, the
      // assistant.turn_start/turn_end markers, session.usage_checkpoint,
      // session.shutdown, and anything not yet observed) is deliberately
      // ignored — not conversation content.
    }

    if (turns.length === 0) return null;

    return {
      transcript: turns.join('\n\n'),
      metadata: {
        sessionId: sessionId || (sessionRef && sessionRef.sessionId) || null,
        source: 'copilot',
        mtime: sessionRef.mtime,
        bytes: sessionRef.bytes,
        // MODEL PROVENANCE: real, on-disk — see module header. Prefer the
        // session-level selectedModel; fall back to the last observed
        // assistant.message.model; 'unknown' only when the file carries
        // neither (never guessed beyond those two fields).
        model: selectedModel || lastAssistantModel || 'unknown',
      },
    };
  }

  async registerSessionEndHook(cb) {
    return null; // hook-fired via the shipped Stop-event capture path (lib/installer.js); the poll above is best-effort backfill only
  }
}

module.exports = { CopilotSource };
