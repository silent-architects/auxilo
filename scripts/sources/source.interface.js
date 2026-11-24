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

const fs = require('fs');

// ─── Session read-size cap (Wave 5C N1) ─────────────────────────────────────
//
// discoverSessions() returns `bytes` per the contract above, but nothing ever
// enforced a ceiling: every adapter's readSession() did an unbounded
// fs.readFileSync (54MB observed in the wild; a multi-GB transcript OOMs a
// constrained sweeper node) — all to feed a pipeline that truncates to 30k
// chars anyway (runner.js MAX_CHARS).
//
// Why 64MB: the ceiling's job is OOM-protection, not thrift. 54MB was proven
// in the wild AND extracted successfully — a cap below that silently regresses
// real coverage (the exact silent-loss class Wave 5C closes). 64MB = proven
// max + ~18% headroom; worst-case read peaks at low-hundreds-MB RSS
// (survivable on a 512MB node) while multi-GB is structurally refused.
// Constrained sweepers tighten via AUXILO_MAX_SESSION_BYTES.

const DEFAULT_MAX_SESSION_BYTES = 64 * 1024 * 1024;

/**
 * Resolve the effective cap. Env override AUXILO_MAX_SESSION_BYTES must be a
 * positive integer; anything else (absent, garbage, zero, negative) falls back
 * to the default. Read at CALL time, not module load, so sweepers and tests
 * can tune per-invocation.
 */
function resolveMaxSessionBytes(env = process.env) {
  const raw = env.AUXILO_MAX_SESSION_BYTES;
  if (raw === undefined || raw === null || raw === '') return DEFAULT_MAX_SESSION_BYTES;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return DEFAULT_MAX_SESSION_BYTES;
  return n;
}

/** Thrown by readSessionCapped BEFORE any read when a session exceeds the cap. */
class SessionTooLargeError extends Error {
  constructor(sessionRef, bytes, maxBytes) {
    super(`Session ${sessionRef && sessionRef.sessionId ? sessionRef.sessionId : '(unknown)'} is ${bytes} bytes — exceeds the ${maxBytes}-byte cap (AUXILO_MAX_SESSION_BYTES)`);
    this.name = 'SessionTooLargeError';
    this.code = 'SESSION_TOO_LARGE';
    this.bytes = bytes;
    this.maxBytes = maxBytes;
  }
}

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

  /**
   * INCREMENTAL-SWEEP: true when this adapter can extract only what is new in a
   * session since a stored per-session state (see readNewSegments). Default
   * false: such adapters keep today's whole-session read and the
   * AUXILO_MAX_SESSION_BYTES cap.
   * @type {boolean}
   */
  get offsetCapable() { return false; }

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
   * Size-capped session read — the ONLY entry point the runner uses (N1).
   *
   * CONCRETE on the base class so every adapter (including the generic-jsonl
   * fallback and any future self-registered UC-3 adapter) inherits the cap
   * through the shared path — no per-adapter copies. Size resolution: a fresh
   * fs.statSync of sessionRef.path when the file stats (authoritative, costs
   * nothing), else the discoverSessions-supplied sessionRef.bytes. Over-cap
   * throws SessionTooLargeError BEFORE any byte is read; callers treat
   * code === 'SESSION_TOO_LARGE' as a counted skip, never a failure.
   *
   * Subclasses must NOT override this — override readSession() only.
   *
   * @param {object} sessionRef - A session reference from discoverSessions()
   * @returns {Promise<{transcript: string, metadata: object}>}
   * @throws {SessionTooLargeError} when the session exceeds the cap
   */
  async readSessionCapped(sessionRef) {
    const maxBytes = resolveMaxSessionBytes();
    let bytes = null;
    if (sessionRef && sessionRef.path) {
      try { bytes = fs.statSync(sessionRef.path).size; } catch { /* fall through */ }
    }
    if (bytes === null && sessionRef && Number.isFinite(sessionRef.bytes)) {
      bytes = sessionRef.bytes;
    }
    // Gate-A 5C F1: unknown size fails CLOSED — a future adapter without byte
    // metadata must not silently reopen the unbounded-read OOM class this cap exists for.
    if (bytes === null || bytes > maxBytes) {
      throw new SessionTooLargeError(sessionRef, bytes === null ? -1 : bytes, maxBytes);
    }
    return this.readSession(sessionRef);
  }

  // ─── Incremental extraction contract (INCREMENTAL-SWEEP D2/D3/D3b) ────────
  //
  // offsetCapable adapters implement the uniform contract below. `state` is an
  // opaque per-session value kept in lib/session-offsets.js:
  //   {kind:'offset', offset, headSha, headLen, codec}  append-only JSONL
  //   {kind:'hashes', seen:[16-hex...], docSha}          rewritten JSON documents
  //   {kind:'rowid',  highWater}                         SQLite
  // The runner treats every kind identically: scrub -> extract -> submit each
  // segment, persist segment.nextState only after the segment is terminally
  // handled, never advance on a transient failure.

  /**
   * Line parser for append-only JSONL adapters (kind 'offset'): turn one
   * complete line into a text turn, or null to skip it. `ctx.isFirstRecord` is
   * true for the first non-blank line of the file when reading from offset 0.
   * @param {string} line
   * @param {{isFirstRecord:boolean}} ctx
   * @returns {string|null}
   */
  parseLine(line, ctx) { return null; }

  /**
   * Cheap gate run before a session first enters incremental mode (e.g. Codex
   * refuses non-user threads). Return {ok:false, reason} to refuse.
   * @returns {Promise<{ok:boolean, reason?:string}>}
   */
  async probeSession(sessionRef) { return { ok: true }; }

  /**
   * True when this session cannot be read by the whole-file readSession at any
   * size (e.g. a compressed Codex rollout), so the runner must use the
   * incremental path regardless of the size cap.
   */
  requiresIncremental(sessionRef) { return false; }

  /** Session id for a transcript path (single-transcript incremental mode). */
  sessionIdForPath(filePath) {
    const base = require('path').basename(filePath);
    return base.replace(/\.[^.]*$/, '');
  }

  /**
   * Read what is new since `state`.
   * @param {object} sessionRef
   * @param {object|null} state  opaque stored state, or null on first read
   * @param {{charBudget:number, maxSegments:number, maxBytes?:number}} opts
   * @returns {Promise<{segments:Array<{text:string,nextState:object}>, state:object,
   *   caughtUp:boolean, resetReason?:string, unsupported?:string}>}
   *   `state` is the state after ALL returned segments; `unsupported` carries a
   *   machine-readable reason (never a silent skip) and returns no segments.
   */
  async readNewSegments(sessionRef, state, opts = {}) {
    if (!this.offsetCapable) {
      return { segments: [], state: state || null, caughtUp: false, unsupported: 'not_incremental_capable' };
    }
    return require('./segment-reader').readNewSegmentsOffset(this, sessionRef, state, opts);
  }

  /**
   * First-sight forward-only state: everything currently present counts as
   * already handled, so only future additions are extracted. Returns a state
   * object, or {unsupported}.
   */
  async forwardOnlyState(sessionRef, opts = {}) {
    if (!this.offsetCapable) return { unsupported: 'not_incremental_capable' };
    return require('./segment-reader').forwardOnlyStateOffset(sessionRef, opts);
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

module.exports = {
  TranscriptSource,
  SessionTooLargeError,
  DEFAULT_MAX_SESSION_BYTES,
  resolveMaxSessionBytes,
};
