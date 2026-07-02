/**
 * scripts/sources/antigravity.js — Antigravity Transcript Source (UC-1)
 *
 * Discovers and reads Antigravity per-conversation JSONL transcript logs.
 * Default location:
 *   ~/.gemini/antigravity/brain/<conversation-id>/.system_generated/logs/*.jsonl
 *
 * Expected line shape: Claude-style JSONL dialect — one JSON object per line
 * carrying `role`/`content`, `message.role`/`message.content`, or
 * `sender`/`content`. Tool/function-call internals are skipped.
 *
 * GROUND-TRUTH NOTE (verified on this machine, 2026-06-12): the local
 * Antigravity install stores conversations as binary protobuf
 * (~/.gemini/antigravity/conversations/*.pb) and its brain dirs contained NO
 * .system_generated/logs/*.jsonl — only click_feedback PNGs and inter-agent
 * messages/*.json ({id, recipient, sender, priority, timestamp, hideFromUser,
 * content}). The logs/*.jsonl path comes from the UC research pass (hook
 * payloads hand a `transcriptPath` pointing there on hook-enabled builds).
 * The strict JSONL probe + fail-silent contract means that if the real format
 * differs, this adapter degrades to "skipped with one log line" — it never
 * mis-parses (UC §5 risk rule).
 *
 * @module sources/antigravity
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { TranscriptSource } = require('./source.interface');
const { normalizeJsonlLines, probeJsonl } = require('./generic-jsonl');

class AntigravitySource extends TranscriptSource {
  static id = 'antigravity';
  static displayName = 'Antigravity (Google)';
  static version = '1.0.0';

  constructor(config = {}) {
    super(config);
    /** @type {string} Root brain dir holding per-conversation artifacts */
    this.dataDir = config.dataDir || path.join(os.homedir(), '.gemini', 'antigravity', 'brain');
  }

  /** Detect: the brain directory exists and is readable. */
  async detect() {
    try {
      return fs.statSync(this.dataDir).isDirectory();
    } catch {
      return false;
    }
  }

  /**
   * Discover transcript logs under
   * <dataDir>/<conversation-id>/.system_generated/logs/*.jsonl
   * modified after `since`.
   */
  async discoverSessions({ since } = {}) {
    const results = [];
    const sinceMs = since ? new Date(since).getTime() : 0;

    let conversations;
    try {
      conversations = fs.readdirSync(this.dataDir).filter(c => {
        try { return fs.statSync(path.join(this.dataDir, c)).isDirectory(); }
        catch { return false; }
      });
    } catch {
      return results;
    }

    for (const conv of conversations) {
      const logsDir = path.join(this.dataDir, conv, '.system_generated', 'logs');
      let files;
      try { files = fs.readdirSync(logsDir).filter(f => f.endsWith('.jsonl')); }
      catch { continue; } // most brain dirs have no logs — fine

      for (const file of files) {
        const filePath = path.join(logsDir, file);
        try {
          const stat = fs.statSync(filePath);
          if (!stat.isFile()) continue;
          if (stat.mtimeMs <= sinceMs) continue;
          results.push({
            sessionId: `${conv}-${path.basename(file, '.jsonl')}`,
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
   * Read + normalize one JSONL transcript. Returns null (single stderr log
   * line) when the format probe refuses — never throws on bad format.
   */
  async readSession(sessionRef) {
    const filePath = sessionRef.path;
    if (!filePath || !fs.existsSync(filePath)) {
      throw new Error(`Transcript file not found: ${filePath}`);
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());

    if (!probeJsonl(lines)) {
      process.stderr.write(`[antigravity] format probe refused ${filePath} — skipping\n`);
      return null;
    }

    return {
      transcript: normalizeJsonlLines(lines),
      metadata: {
        sessionId: sessionRef.sessionId,
        source: 'antigravity',
        mtime: sessionRef.mtime,
        bytes: sessionRef.bytes,
      },
    };
  }

  /** Hook wiring (Antigravity hooks.json, Stop event) is the installer's job. */
  async registerSessionEndHook(cb) { return null; }
}

module.exports = { AntigravitySource };
