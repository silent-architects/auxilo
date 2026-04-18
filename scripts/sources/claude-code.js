/**
 * scripts/sources/claude-code.js — Claude Code Transcript Source (P2.1a §4.2)
 *
 * Discovers and reads conversation transcripts from the Claude Code JSONL format.
 * Default location: ~/.claude/projects/{name}/conversations/{id}.jsonl
 *
 * @module sources/claude-code
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { TranscriptSource } = require('./source.interface');

class ClaudeCodeSource extends TranscriptSource {
  static id = 'claude-code';
  static displayName = 'Claude Code (Anthropic)';
  static version = '1.0.0';

  constructor(config = {}) {
    super(config);
    /** @type {string} Root dir for Claude Code projects */
    this.dataDir = config.dataDir || path.join(os.homedir(), '.claude', 'projects');
    /** @type {string} Path to settings.json for hook registration */
    this.settingsPath = config.settingsPath || path.join(os.homedir(), '.claude', 'settings.json');
  }

  /**
   * Detect if Claude Code is installed: ~/.claude/projects exists AND
   * ~/.claude/settings.json is readable.
   */
  async detect() {
    try {
      if (!fs.existsSync(this.dataDir)) return false;
      fs.accessSync(this.settingsPath, fs.constants.R_OK);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Discover sessions modified after `since`.
   * Walks ~/.claude/projects/*\/conversations/*.jsonl
   */
  async discoverSessions({ since } = {}) {
    const results = [];
    if (!fs.existsSync(this.dataDir)) return results;

    const sinceMs = since ? new Date(since).getTime() : 0;

    let projects;
    try {
      projects = fs.readdirSync(this.dataDir).filter(p => {
        const full = path.join(this.dataDir, p);
        try { return fs.statSync(full).isDirectory(); } catch { return false; }
      });
    } catch {
      return results;
    }

    for (const project of projects) {
      const convDir = path.join(this.dataDir, project, 'conversations');
      if (!fs.existsSync(convDir)) continue;

      let files;
      try { files = fs.readdirSync(convDir).filter(f => f.endsWith('.jsonl')); }
      catch { continue; }

      for (const file of files) {
        const filePath = path.join(convDir, file);
        try {
          const stat = fs.statSync(filePath);
          if (stat.mtimeMs <= sinceMs) continue;
          results.push({
            sessionId: path.basename(file, '.jsonl'),
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
   * Read a session transcript. JSONL → plain "ROLE: text" blocks.
   */
  async readSession(sessionRef) {
    const filePath = sessionRef.path;
    if (!filePath || !fs.existsSync(filePath)) {
      throw new Error(`Transcript file not found: ${filePath}`);
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());

    const turns = [];
    for (const line of lines) {
      try {
        const msg = JSON.parse(line);
        const role = msg.role || msg.type || 'unknown';
        const text = typeof msg.content === 'string'
          ? msg.content
          : (msg.content && msg.content[0]?.text) || JSON.stringify(msg.content || '');
        turns.push(`[${role}]: ${text}`);
      } catch {
        // Skip malformed lines
      }
    }

    return {
      transcript: turns.join('\n\n'),
      metadata: {
        sessionId: sessionRef.sessionId,
        source: 'claude-code',
        mtime: sessionRef.mtime,
        bytes: sessionRef.bytes,
      },
    };
  }

  /**
   * Register SessionEnd hook via ~/.claude/settings.json.
   * Returns an unregister function.
   */
  async registerSessionEndHook(cb) {
    // Hook registration is handled by installHooks() in runner.js.
    // This method returns null to indicate that the runner should
    // use the installHooks() path for setup, and poll for discovery.
    // Live hook support via settings.json SessionEnd array is wired
    // through the bash hook script, not through this JS method.
    return null;
  }
}

module.exports = { ClaudeCodeSource };
