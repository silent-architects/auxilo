/**
 * scripts/sources/gemini-cli.js — Gemini CLI Transcript Source (UC-1)
 *
 * Discovers and reads auto-saved Gemini CLI session JSON files.
 * Default location: ~/.gemini/tmp/<project_hash>/chats/*.json
 *
 * KNOWN SHAPES (format probe accepts exactly these, refuses everything else):
 *
 *   A. Session auto-save object:
 *        { sessionId?, startTime?, lastUpdated?,
 *          messages: [ { id?, type: "user"|"gemini", content: string, ... } ] }
 *
 *   B. Checkpoint (`/chat save`) — Gemini API Content list, either bare or
 *      wrapped:
 *        [ { role: "user"|"model", parts: [ {text} | {functionCall} | {functionResponse} ] } ]
 *        { history: [ ...same... ] }
 *
 *   NOTE (2026-06-12): built from the documented Gemini CLI session formats.
 *   No ~/.gemini/tmp data existed on the build machine to verify against —
 *   only Antigravity uses ~/.gemini here. The strict probe + fail-silent
 *   contract means a drifted real-world format degrades to "skipped with one
 *   log line", never a mis-parse (UC §5 risk rule).
 *
 * Normalization: user/model turns concatenated as `[user]:` / `[assistant]:`
 * blocks (same convention as the claude-code adapter). Tool/function-call
 * internals and thinking parts are skipped.
 *
 * @module sources/gemini-cli
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { TranscriptSource } = require('./source.interface');
const { normalizeRole } = require('./generic-jsonl');

/** Extract user-visible text from a Gemini Content `parts` array. */
function textFromParts(parts) {
  if (!Array.isArray(parts)) return '';
  return parts
    .filter(p => p && typeof p.text === 'string' && !p.thought) // skip functionCall/functionResponse/thought parts
    .map(p => p.text)
    .filter(Boolean)
    .join('\n');
}

class GeminiCliSource extends TranscriptSource {
  static id = 'gemini-cli';
  static displayName = 'Gemini CLI (Google)';
  static version = '1.0.0';

  constructor(config = {}) {
    super(config);
    /** @type {string} Root dir for Gemini CLI per-project temp data */
    this.dataDir = config.dataDir || path.join(os.homedir(), '.gemini', 'tmp');
  }

  /** Detect: ~/.gemini/tmp exists and is a readable directory. */
  async detect() {
    try {
      return fs.statSync(this.dataDir).isDirectory();
    } catch {
      return false;
    }
  }

  /**
   * Discover session JSON files under <dataDir>/<project_hash>/chats/*.json
   * modified after `since`.
   */
  async discoverSessions({ since } = {}) {
    const results = [];
    const sinceMs = since ? new Date(since).getTime() : 0;

    let hashes;
    try {
      hashes = fs.readdirSync(this.dataDir).filter(h => {
        try { return fs.statSync(path.join(this.dataDir, h)).isDirectory(); }
        catch { return false; }
      });
    } catch {
      return results;
    }

    for (const hash of hashes) {
      const chatsDir = path.join(this.dataDir, hash, 'chats');
      let files;
      try { files = fs.readdirSync(chatsDir).filter(f => f.endsWith('.json')); }
      catch { continue; } // no chats dir for this project — fine

      for (const file of files) {
        const filePath = path.join(chatsDir, file);
        try {
          const stat = fs.statSync(filePath);
          if (!stat.isFile()) continue;
          if (stat.mtimeMs <= sinceMs) continue;
          results.push({
            sessionId: `${hash}-${path.basename(file, '.json')}`,
            path: filePath,
            mtime: stat.mtime.toISOString(),
            bytes: stat.size,
          });
        } catch { /* skip unreadable files */ }
      }
    }

    return results;
  }

  /**
   * Read + normalize one session file. Returns null (single stderr log line)
   * when the format probe refuses — never throws on bad format, never
   * mis-parses garbage into a transcript.
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

    const turns = [];

    if (parsed && !Array.isArray(parsed) && Array.isArray(parsed.messages)) {
      // Shape A: session auto-save { messages: [{ type, content }] }
      for (const m of parsed.messages) {
        if (!m || typeof m !== 'object') continue;
        const role = normalizeRole(m.type ?? m.role);
        if (!role) continue; // tool/info/error entries — skip
        const text = typeof m.content === 'string' ? m.content : textFromParts(m.content);
        if (text && text.trim().length > 0) turns.push(`[${role}]: ${text}`);
      }
    } else {
      // Shape B: checkpoint Content list — bare array or { history: [...] }
      const history = Array.isArray(parsed) ? parsed
        : (parsed && Array.isArray(parsed.history)) ? parsed.history
        : null;
      if (!history) return this._refuse(filePath, 'no messages/history array');

      for (const c of history) {
        if (!c || typeof c !== 'object') continue;
        const role = normalizeRole(c.role);
        if (!role) continue;
        const text = textFromParts(c.parts);
        if (text && text.trim().length > 0) turns.push(`[${role}]: ${text}`);
      }
    }

    return {
      transcript: turns.join('\n\n'),
      metadata: {
        sessionId: sessionRef.sessionId,
        source: 'gemini-cli',
        mtime: sessionRef.mtime,
        bytes: sessionRef.bytes,
      },
    };
  }

  /** Single log line + null per the UC §5 fail-silent rule. */
  _refuse(filePath, reason) {
    process.stderr.write(`[gemini-cli] format probe refused ${filePath} (${reason}) — skipping\n`);
    return null;
  }

  /** Hook wiring (Gemini settings.json hooks) is the installer's job. */
  async registerSessionEndHook(cb) { return null; }
}

module.exports = { GeminiCliSource };
