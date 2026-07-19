/**
 * scripts/sources/continue.js — Continue.dev Transcript Source (UC-3)
 *
 * Discovers and reads Continue.dev saved sessions:
 *
 *   ~/.continue/sessions/<sessionId>.json    ← read (one file per session)
 *   ~/.continue/sessions/sessions.json       ← index (metadata only; ignored)
 *
 * KNOWN SHAPES (format probe accepts exactly these, refuses everything else):
 *
 *   { history: [ ...items ] , title?, sessionId?, workspaceDirectory? }
 *   where each item is either
 *     { message: { role: "user"|"assistant", content: string|[{...}] }, ... }
 *   or (older sessions)
 *     { role: "user"|"assistant", content: string|[{...}] }
 *
 * Tool/system roles and non-text content parts are skipped.
 *
 * NOTE (2026-07-19): built from Continue's documented session persistence
 * (~/.continue/sessions). No Continue installation existed on the build
 * machine to verify against (~/.continue absent). Strict probe + fail-silent
 * degradation per UC §5 — a drifted format is skipped with one log line,
 * never mis-parsed. Publicly labeled best-effort (UC-3).
 *
 * @module sources/continue
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { TranscriptSource } = require('./source.interface');
const { normalizeRole, extractText } = require('./generic-jsonl');

class ContinueSource extends TranscriptSource {
  static id = 'continue';
  static displayName = 'Continue.dev';
  static version = '1.0.0';

  constructor(config = {}) {
    super(config);
    /** @type {string} Sessions dir */
    this.sessionsDir = config.sessionsDir ||
      path.join(config.homeDir || os.homedir(), '.continue', 'sessions');
  }

  /** Detect: ~/.continue/sessions exists and is a directory. Fail-silent. */
  async detect() {
    try {
      return fs.statSync(this.sessionsDir).isDirectory();
    } catch {
      return false;
    }
  }

  /** Discover session JSON files (excluding the sessions.json index). */
  async discoverSessions({ since } = {}) {
    const results = [];
    const sinceMs = since ? new Date(since).getTime() : 0;

    let files;
    try {
      files = fs.readdirSync(this.sessionsDir)
        .filter(f => f.endsWith('.json') && f !== 'sessions.json');
    } catch {
      return results;
    }

    for (const file of files) {
      const filePath = path.join(this.sessionsDir, file);
      try {
        const stat = fs.statSync(filePath);
        if (!stat.isFile()) continue;
        if (stat.mtimeMs <= sinceMs) continue;
        results.push({
          sessionId: path.basename(file, '.json'),
          path: filePath,
          mtime: stat.mtime.toISOString(),
          bytes: stat.size,
        });
      } catch { /* skip unreadable files */ }
    }
    return results;
  }

  /**
   * Read + normalize one session. Returns null (single stderr log line) when
   * the format probe refuses — never throws on bad format.
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

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(parsed.history)) {
      return this._refuse(filePath, 'no history array');
    }

    const turns = [];
    for (const item of parsed.history) {
      if (!item || typeof item !== 'object') continue;
      // New shape nests the message; older items ARE the message.
      const msg = (item.message && typeof item.message === 'object') ? item.message : item;
      const role = normalizeRole(msg.role);
      if (!role) continue;
      const text = extractText(msg.content);
      if (text && text.trim().length > 0) turns.push(`[${role}]: ${text}`);
    }

    return {
      transcript: turns.join('\n\n'),
      metadata: {
        sessionId: sessionRef.sessionId,
        source: 'continue',
        mtime: sessionRef.mtime,
        bytes: sessionRef.bytes,
      },
    };
  }

  /** Single log line + null per the UC §5 fail-silent rule. */
  _refuse(filePath, reason) {
    process.stderr.write(`[continue] format probe refused ${filePath} (${reason}) — skipping\n`);
    return null;
  }

  /** No hook surface — poll-based via the sweeper (UC-3 P-class). */
  async registerSessionEndHook(cb) { return null; }
}

module.exports = { ContinueSource };
