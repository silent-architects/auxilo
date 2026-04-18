/**
 * scripts/sources/source.interface.js — Transcript Source Interface (P2.1a §4.1)
 *
 * Base class for all transcript source adapters.
 * Spec contract from BUILD-SPEC-P2.1a §4.1:
 *   - detect()                      → boolean (installed on host?)
 *   - discoverSessions({ since })   → [{ sessionId, path, mtime, bytes }]
 *   - readSession(sessionRef)       → { transcript: string, metadata: {...} }
 *   - registerSessionEndHook(cb)    → unregister fn | null (null = poll-only)
 *
 * @module sources/source.interface
 */

'use strict';

/**
 * Abstract base class for transcript source adapters.
 *
 * Subclasses MUST set the static fields and implement all four methods.
 *
 * @abstract
 */
class TranscriptSource {
  /** @type {string} Source type identifier, e.g. "claude-code" */
  static id = 'abstract';

  /** @type {string} Human-readable display name */
  static displayName = 'Abstract Source';

  /** @type {string} Semantic version of this adapter */
  static version = '0.0.0';

  constructor(config = {}) {
    /** @type {string} Instance-level reference to the source type */
    this.type = this.constructor.id || config.type || 'abstract';
    /** @type {string} Instance-level display name */
    this.label = this.constructor.displayName || config.label || '';
  }

  /**
   * Detect whether this source is installed on the host.
   *
   * @returns {Promise<boolean>} true if the source data directory exists and is readable
   */
  async detect() {
    throw new Error('TranscriptSource.detect() must be implemented by subclass');
  }

  /**
   * Discover new sessions since a high-water mark.
   *
   * @param {object} opts
   * @param {string} [opts.since] - ISO timestamp; only return sessions modified after this time
   * @returns {Promise<Array<{sessionId: string, path: string, mtime: string, bytes: number}>>}
   */
  async discoverSessions({ since } = {}) {
    throw new Error('TranscriptSource.discoverSessions() must be implemented by subclass');
  }

  /**
   * Read a session's transcript.
   *
   * @param {object} sessionRef - A session reference object from discoverSessions()
   * @returns {Promise<{transcript: string, metadata: {sessionId: string, source: string, mtime: string, bytes: number}}>}
   */
  async readSession(sessionRef) {
    throw new Error('TranscriptSource.readSession() must be implemented by subclass');
  }

  /**
   * Register a callback for session-end events (live hook mode).
   *
   * Returns null if the source only supports poll-based discovery (no live hooks).
   * Returns an unregister function if hooks are supported.
   *
   * @param {Function} cb - Callback invoked with session path on session end
   * @returns {Promise<Function|null>} Unregister function, or null for poll-only sources
   */
  async registerSessionEndHook(cb) {
    // Default: poll-only source — no live hooks available
    return null;
  }
}

module.exports = { TranscriptSource };
