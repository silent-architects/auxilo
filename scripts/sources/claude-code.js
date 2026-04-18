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

    // Real Claude Code layout: ~/.claude/projects/<project>/<session-id>.jsonl
    // The jsonl files sit directly under the project directory. Historical
    // versions put them under a `conversations/` subdir — we still check
    // that as a fallback for safety, but the modern layout is the default.
    for (const project of projects) {
      const projectDir = path.join(this.dataDir, project);
      const candidateDirs = [
        projectDir,
        path.join(projectDir, 'conversations'), // legacy fallback
      ];

      for (const dir of candidateDirs) {
        if (!fs.existsSync(dir)) continue;

        let files;
        try { files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')); }
        catch { continue; }

        for (const file of files) {
          const filePath = path.join(dir, file);
          try {
            const stat = fs.statSync(filePath);
            // Skip directories masquerading via .jsonl suffix (shouldn't happen,
            // but be defensive); the readdirSync already excludes non-files in
            // practice, but stat check is cheap.
            if (!stat.isFile()) continue;
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

    // Real Claude Code JSONL shape:
    //   { type: 'user'|'assistant'|'system'|'queue-operation'|'attachment'|...,
    //     message: { role, content } }
    // For user:      message.content is a string OR [{type:'text', text:'...'}]
    // For assistant: message.content is [{type:'text'|'thinking'|'tool_use'|'tool_result', ...}]
    // We want user + assistant text content only, concatenated in order.
    const turns = [];
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        // Skip meta types — they don't contribute to the conversation
        if (entry.type && !['user', 'assistant', 'system'].includes(entry.type)) continue;

        const role = entry.message?.role || entry.role || entry.type || 'unknown';
        const raw = entry.message?.content ?? entry.content;
        if (raw == null) continue;

        let text = '';
        if (typeof raw === 'string') {
          text = raw;
        } else if (Array.isArray(raw)) {
          // Concatenate text-like blocks. Skip tool_use/tool_result payloads
          // and thinking blocks (internal reasoning, not conversation).
          text = raw
            .filter(b => b && (b.type === 'text' || b.type === 'input_text' || typeof b.text === 'string'))
            .map(b => b.text || '')
            .filter(Boolean)
            .join('\n');
        } else if (typeof raw === 'object' && typeof raw.text === 'string') {
          text = raw.text;
        }

        if (text.trim().length > 0) {
          turns.push(`[${role}]: ${text}`);
        }
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
