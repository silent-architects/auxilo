/**
 * scripts/sources/generic-jsonl.js — Generic Claude-style JSONL Source (UC-1)
 *
 * Best-effort normalizer for clients that speak a Claude-style JSONL dialect
 * (one JSON object per line carrying `role`/`content` or
 * `message.role`/`message.content`) but don't have a dedicated adapter yet
 * (cursor, windsurf, codex, copilot, factory). capture-core forwards the
 * client id via `--source <id>`; runner.js falls back to this adapter for
 * unknown ids in single-file mode and tags uploads with that id.
 *
 * FORMAT PROBE (UC §5 risk rule): at least 80% of non-empty lines must parse
 * as JSON objects, or readSession() refuses (returns null with a single
 * stderr line). Never throws on bad format, never mis-parses garbage into a
 * transcript.
 *
 * Poll-mode methods are inert: there is no canonical on-disk location for a
 * "generic" client, so detect() → false and discoverSessions() → [].
 *
 * @module sources/generic-jsonl
 */

'use strict';

const fs = require('fs');
const { TranscriptSource } = require('./source.interface');

/** Minimum fraction of non-empty lines that must parse as JSON objects. */
const PROBE_MIN_JSON_RATIO = 0.8;

/** Map dialect role names to our normalized two-role vocabulary. */
function normalizeRole(role) {
  const r = String(role || '').toLowerCase();
  if (r === 'user' || r === 'human') return 'user';
  if (r === 'assistant' || r === 'model' || r === 'gemini' || r === 'ai') return 'assistant';
  return null; // system / tool / function / unknown → skip
}

/** Extract plain text from a string | block-array | {text} content value. */
function extractText(raw) {
  if (raw == null) return '';
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) {
    return raw
      .filter(b => b && (b.type === 'text' || b.type === 'input_text' || typeof b.text === 'string'))
      .map(b => b.text || '')
      .filter(Boolean)
      .join('\n');
  }
  if (typeof raw === 'object' && typeof raw.text === 'string') return raw.text;
  return '';
}

/**
 * Normalize an array of raw JSONL lines into `[user]:`/`[assistant]:` turns.
 * Shared with the antigravity adapter. Skips tool/function internals and any
 * line whose role doesn't normalize to user/assistant.
 *
 * @param {string[]} lines - non-empty JSONL lines
 * @returns {string} normalized transcript (may be empty)
 */
function normalizeJsonlLines(lines) {
  const turns = [];
  for (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;

    // Skip explicit tool/function internals regardless of role fields.
    const t = String(entry.type || '').toLowerCase();
    if (['tool_use', 'tool_result', 'function_call', 'function_response', 'tool'].includes(t)) continue;

    const role = normalizeRole(entry.message?.role ?? entry.role ?? entry.sender ?? entry.type);
    if (!role) continue;

    const text = extractText(entry.message?.content ?? entry.content ?? entry.text);
    if (text.trim().length > 0) turns.push(`[${role}]: ${text}`);
  }
  return turns.join('\n\n');
}

/**
 * Format probe: true when the file looks like JSONL (≥80% of non-empty lines
 * parse as JSON objects).
 *
 * @param {string[]} lines - non-empty lines
 * @returns {boolean}
 */
function probeJsonl(lines) {
  if (lines.length === 0) return false;
  let objects = 0;
  for (const line of lines) {
    try {
      const v = JSON.parse(line);
      if (v && typeof v === 'object' && !Array.isArray(v)) objects++;
    } catch { /* not JSON */ }
  }
  return objects / lines.length >= PROBE_MIN_JSON_RATIO;
}

class GenericJsonlSource extends TranscriptSource {
  static id = 'generic-jsonl';
  static displayName = 'Generic Claude-style JSONL';
  static version = '1.0.0';

  /**
   * @param {object} [config]
   * @param {string} [config.id] - actual client id this instance represents
   *   (e.g. "cursor", "windsurf"); used as the upload source tag.
   */
  constructor(config = {}) {
    super(config);
    // The marketplace source tag is the CLIENT id, not "generic-jsonl".
    this.type = config.id || GenericJsonlSource.id;
    this.label = config.label || `${this.type} (generic JSONL)`;
  }

  /** No canonical data dir for a generic client — never auto-detected. */
  async detect() { return false; }

  /** Poll discovery unsupported — hook-fired single-file mode only. */
  async discoverSessions({ since } = {}) { return []; }

  /**
   * Read + normalize a JSONL transcript. Returns null (single stderr log
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
      process.stderr.write(`[generic-jsonl] format probe refused ${filePath} (source=${this.type}) — skipping\n`);
      return null;
    }

    const transcript = normalizeJsonlLines(lines);
    return {
      transcript,
      metadata: {
        sessionId: sessionRef.sessionId,
        source: this.type,
        adapter: GenericJsonlSource.id,
        mtime: sessionRef.mtime,
        bytes: sessionRef.bytes,
      },
    };
  }

  /** Hook wiring is the installer's job (UC-1). */
  async registerSessionEndHook(cb) { return null; }
}

module.exports = { GenericJsonlSource, normalizeJsonlLines, probeJsonl, normalizeRole, extractText };
