/**
 * scripts/sources/cline.js — Cline (VS Code extension) Transcript Source (UC-3)
 *
 * Discovers and reads Cline task conversation histories from VS Code global
 * storage:
 *
 *   <vscode-user-dir>/globalStorage/saoudrizwan.claude-dev/tasks/<taskId>/
 *     api_conversation_history.json   ← read (Anthropic Messages format)
 *     ui_messages.json                ← ignored (UI event stream)
 *
 * Candidate VS Code roots probed (any-of): Code, Code - Insiders, VSCodium —
 * per-platform user-data locations (darwin: ~/Library/Application Support,
 * linux: ~/.config, win32: %APPDATA%).
 *
 * KNOWN SHAPE (format probe accepts exactly this, refuses everything else):
 *   [ { role: "user"|"assistant", content: string | [ {type:"text", text} | ... ] } ]
 *   (tool_use / tool_result blocks and non-text parts are skipped)
 *
 * NOTE (2026-07-19): built from Cline's documented/observed storage layout.
 * No Cline installation existed on the build machine to verify against
 * (probed all globalStorage roots — absent). The strict probe + fail-silent
 * contract means a drifted real-world format degrades to "skipped with one
 * log line", never a mis-parse (UC §5 risk rule) — the same posture the
 * gemini-cli adapter shipped with. Publicly labeled best-effort (UC-3).
 *
 * @module sources/cline
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { TranscriptSource } = require('./source.interface');
const { normalizeRole, extractText } = require('./generic-jsonl');

/** Per-platform VS Code-family user-data roots (any-of detection). */
function vscodeUserDirs(homeDir, platform, env) {
  const apps = ['Code', 'Code - Insiders', 'VSCodium'];
  if (platform === 'darwin') {
    return apps.map(a => path.join(homeDir, 'Library', 'Application Support', a, 'User'));
  }
  if (platform === 'win32') {
    const appData = (env && env.APPDATA) || path.join(homeDir, 'AppData', 'Roaming');
    return apps.map(a => path.join(appData, a, 'User'));
  }
  return apps.map(a => path.join(homeDir, '.config', a, 'User'));
}

class ClineSource extends TranscriptSource {
  static id = 'cline';
  static displayName = 'Cline (VS Code)';
  static version = '1.0.0';

  /** Extension publisher dir(s) under globalStorage — subclass override point. */
  static publisherDirs = ['saoudrizwan.claude-dev'];

  constructor(config = {}) {
    super(config);
    const homeDir = config.homeDir || os.homedir();
    const platform = config.platform || process.platform;
    const env = config.env || process.env;
    /** @type {string[]} candidate tasks roots (first existing wins per discover) */
    this.taskRoots = config.taskRoots || vscodeUserDirs(homeDir, platform, env).flatMap(
      (userDir) => this.constructor.publisherDirs.map(
        (pub) => path.join(userDir, 'globalStorage', pub, 'tasks')
      )
    );
  }

  /** Detect: any candidate tasks root exists and is a directory. Fail-silent. */
  async detect() {
    return this.taskRoots.some((p) => {
      try { return fs.statSync(p).isDirectory(); } catch { return false; }
    });
  }

  /**
   * Discover task sessions: each task dir containing
   * api_conversation_history.json modified after `since`.
   */
  async discoverSessions({ since } = {}) {
    const results = [];
    const sinceMs = since ? new Date(since).getTime() : 0;

    for (const root of this.taskRoots) {
      let taskIds;
      try { taskIds = fs.readdirSync(root); } catch { continue; }
      for (const taskId of taskIds) {
        const historyPath = path.join(root, taskId, 'api_conversation_history.json');
        try {
          const stat = fs.statSync(historyPath);
          if (!stat.isFile()) continue;
          if (stat.mtimeMs <= sinceMs) continue;
          results.push({
            sessionId: `${this.type}-${taskId}`,
            path: historyPath,
            mtime: stat.mtime.toISOString(),
            bytes: stat.size,
          });
        } catch { /* task dir without a history file — skip */ }
      }
    }
    return results;
  }

  /**
   * Read + normalize one task history. Returns null (single stderr log line)
   * when the format probe refuses — never throws on bad format.
   */
  async readSession(sessionRef) {
    const filePath = sessionRef.path;
    if (!filePath || !fs.existsSync(filePath)) {
      throw new Error(`Transcript file not found: ${filePath}`);
    }

    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch {
      return this._refuse(filePath, 'not valid JSON');
    }

    // Probe: an ARRAY of {role, content} message objects (Anthropic format).
    if (!Array.isArray(parsed)) return this._refuse(filePath, 'not a messages array');
    const messageLike = parsed.filter((m) => m && typeof m === 'object' && m.role !== undefined && m.content !== undefined);
    if (parsed.length === 0 || messageLike.length === 0) {
      return this._refuse(filePath, 'no role/content messages');
    }

    const turns = [];
    for (const m of messageLike) {
      const role = normalizeRole(m.role);
      if (!role) continue; // system / tool roles — skip
      const text = extractText(m.content);
      if (text && text.trim().length > 0) turns.push(`[${role}]: ${text}`);
    }

    return {
      transcript: turns.join('\n\n'),
      metadata: {
        sessionId: sessionRef.sessionId,
        source: this.type,
        mtime: sessionRef.mtime,
        bytes: sessionRef.bytes,
      },
    };
  }

  /** Single log line + null per the UC §5 fail-silent rule. */
  _refuse(filePath, reason) {
    process.stderr.write(`[${this.type}] format probe refused ${filePath} (${reason}) — skipping\n`);
    return null;
  }

  /** No hook surface — poll-based via the sweeper (UC-3 P-class). */
  async registerSessionEndHook(cb) { return null; }
}

module.exports = { ClineSource, vscodeUserDirs };
