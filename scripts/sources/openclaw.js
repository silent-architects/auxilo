/**
 * scripts/sources/openclaw.js — OpenClaw Transcript Source (P2.1a §4.3)
 *
 * Discovers and reads session transcripts from the OpenClaw runtime directory.
 * A5.4 FIX: Correct path is ~/.openclaw/agents/{agentId}/sessions/{sessionId}.jsonl
 * (NOT data/openclaw/ inside the repo)
 *
 * Storage layout (from BUILD-1 research, spec §4.3):
 *   ~/.openclaw/agents/{agentId}/sessions/{sessionId}.jsonl
 *   with sessions.json index in that same directory.
 *   First line of each JSONL = session metadata; subsequent lines = messages.
 *
 * @module sources/openclaw
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { TranscriptSource } = require('./source.interface');

class OpenClawSource extends TranscriptSource {
  static id = 'openclaw';
  static displayName = 'OpenClaw Memory System';
  static version = '1.0.0';

  constructor(config = {}) {
    super(config);
    // A5.4: Correct path — ~/.openclaw/agents (NOT data/openclaw/ inside repo)
    this.dataDir = config.dataDir || path.join(os.homedir(), '.openclaw', 'agents');
  }

  /**
   * Detect if OpenClaw is installed: ~/.openclaw/agents exists AND
   * contains at least one agent directory.
   */
  async detect() {
    try {
      if (!fs.existsSync(this.dataDir)) return false;
      const agents = fs.readdirSync(this.dataDir).filter(d => {
        try { return fs.statSync(path.join(this.dataDir, d)).isDirectory(); }
        catch { return false; }
      });
      return agents.length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Discover sessions modified after `since`.
   * Reads sessions.json index in each agent's sessions dir, filters by updatedAt.
   */
  async discoverSessions({ since } = {}) {
    const results = [];
    if (!fs.existsSync(this.dataDir)) return results;

    const sinceMs = since ? new Date(since).getTime() : 0;

    let agents;
    try {
      agents = fs.readdirSync(this.dataDir).filter(d => {
        try { return fs.statSync(path.join(this.dataDir, d)).isDirectory(); }
        catch { return false; }
      });
    } catch {
      return results;
    }

    for (const agentId of agents) {
      const sessionsDir = path.join(this.dataDir, agentId, 'sessions');
      if (!fs.existsSync(sessionsDir)) continue;

      // Try sessions.json index first
      const indexPath = path.join(sessionsDir, 'sessions.json');
      if (fs.existsSync(indexPath)) {
        try {
          const index = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
          const sessions = Array.isArray(index) ? index : (index.sessions || []);
          for (const entry of sessions) {
            const updatedAt = entry.updatedAt || entry.updated_at || entry.mtime;
            if (updatedAt && new Date(updatedAt).getTime() <= sinceMs) continue;
            const sessionFile = path.join(sessionsDir, `${entry.sessionId || entry.id}.jsonl`);
            if (!fs.existsSync(sessionFile)) continue;
            const stat = fs.statSync(sessionFile);
            results.push({
              sessionId: entry.sessionId || entry.id,
              path: sessionFile,
              mtime: stat.mtime.toISOString(),
              bytes: stat.size,
            });
          }
          continue; // Used index, skip file scan for this agent
        } catch {
          // Fall through to direct file scan
        }
      }

      // Fallback: direct .jsonl scan
      try {
        const files = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.jsonl'));
        for (const file of files) {
          const filePath = path.join(sessionsDir, file);
          try {
            const stat = fs.statSync(filePath);
            if (stat.mtimeMs <= sinceMs) continue;
            results.push({
              sessionId: path.basename(file, '.jsonl'),
              path: filePath,
              mtime: stat.mtime.toISOString(),
              bytes: stat.size,
            });
          } catch { /* skip unreadable */ }
        }
      } catch { /* skip unreadable dir */ }
    }

    return results;
  }

  /**
   * Read a session transcript. Skip first (metadata) line per spec §4.3.
   * Convert messages into "ROLE: text" format.
   */
  async readSession(sessionRef) {
    const filePath = sessionRef.path;
    if (!filePath || !fs.existsSync(filePath)) {
      throw new Error(`Session file not found: ${filePath}`);
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());

    // First line is session metadata per spec §4.3 — skip it
    const turns = [];
    for (let i = 1; i < lines.length; i++) {
      try {
        const msg = JSON.parse(lines[i]);
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
        source: 'openclaw',
        mtime: sessionRef.mtime,
        bytes: sessionRef.bytes,
      },
    };
  }

  /**
   * Register session-end hook.
   * Returns null — OpenClaw is poll-only at launch per spec §4.3.
   * Live hooks deferred pending SPEC-2 confirmation of plugin manifest.
   */
  async registerSessionEndHook(cb) {
    return null;
  }
}

module.exports = { OpenClawSource };
