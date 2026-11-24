/**
 * lib/incremental-sweep.js — per-session incremental extraction (INCREMENTAL-SWEEP D4).
 *
 * The decision and persistence logic behind the runner's segmented extraction,
 * kept free of module-level state so tests can drive it with fakes:
 *
 *   decideMode()          legacy | incremental | forward-only-init
 *   collectBacklog()      sessions whose stored state is not caught up
 *   processSession()      one session: gate -> readNewSegments -> per segment
 *                         scrub -> ledger sha check -> extract -> submit; the
 *                         stored state advances only after a segment is
 *                         terminally handled. A transient failure (extraction
 *                         skipped by the classifier, provider unreachable,
 *                         upload error) never advances state and never marks
 *                         the session done.
 *
 * The runner supplies the real scrub/ledger/extract/queue functions as `deps`.
 *
 * @module lib/incremental-sweep
 */

'use strict';

const DEFAULT_MAX_SEGMENTS_PER_SESSION = 3;
const DEFAULT_MAX_SEGMENTS_PER_SWEEP = 30;

/** AUXILO_MAX_SEGMENTS_PER_SESSION: positive integer, default 3. */
function resolveMaxSegments(env = process.env, override) {
  const raw = override !== undefined && override !== null ? override : env.AUXILO_MAX_SEGMENTS_PER_SESSION;
  if (raw === undefined || raw === null || raw === '') return DEFAULT_MAX_SEGMENTS_PER_SESSION;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_MAX_SEGMENTS_PER_SESSION;
}

/** AUXILO_MAX_SEGMENTS_PER_SWEEP: positive integer, default 30 (all sessions together). */
function resolveSweepSegmentBudget(env = process.env) {
  const raw = env.AUXILO_MAX_SEGMENTS_PER_SWEEP;
  if (raw === undefined || raw === null || raw === '') return DEFAULT_MAX_SEGMENTS_PER_SWEEP;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_MAX_SEGMENTS_PER_SWEEP;
}

/**
 * Sweep order: sessions that already have stored state or a backlog flag first,
 * then the rest; newest mtime first inside each group. Stable for equal keys.
 */
function orderForSweep(store, sourceId, sessions) {
  const t = (s) => { const n = Date.parse(s && s.mtime); return Number.isFinite(n) ? n : 0; };
  const rank = (s) => {
    if (s.fromBacklog) return 0;
    const e = store.get(sourceId, s.sessionId);
    return e && (e.state || e.more) ? 0 : 1;
  };
  return sessions
    .map((s, i) => ({ s, i, r: rank(s), t: t(s) }))
    .sort((a, b) => (a.r - b.r) || (b.t - a.t) || (a.i - b.i))
    .map((x) => x.s);
}

/** Ledger mark suffixes for one session ('oversize', 'skipped', '<sha>', ...). */
function ledgerMarksFor(ledger, sourceId, sessionId) {
  const sessions = (ledger && ledger.sources && ledger.sources[sourceId] && ledger.sources[sourceId].sessions) || {};
  const prefix = `${sourceId}:${sessionId}:`;
  const out = [];
  for (const key of Object.keys(sessions)) {
    if (sessions[key] === true && key.startsWith(prefix)) out.push(key.slice(prefix.length));
  }
  return out;
}

/**
 * Which path a session takes.
 *  - 'legacy'            adapter not incremental, or under the cap: today's whole-session path
 *  - 'incremental'       a stored state exists, or first sight with an oversize/never-seen session
 *  - 'forward-only-init' first sight, over the cap, already handled before: start at "now"
 */
function decideMode({ adapter, sessionRef, entry, size, capBytes, marks, incrementalForced }) {
  if (!adapter || !adapter.offsetCapable) return 'legacy';
  if (entry && entry.state) return 'incremental';
  // `--incremental` (a hook run on one transcript): never fall through to the
  // whole-file read, whatever the size; the first-sight rules below decide.
  const needs = Boolean(incrementalForced)
    || (size !== null && size > capBytes)
    || Boolean(typeof adapter.requiresIncremental === 'function' && adapter.requiresIncremental(sessionRef));
  if (!needs) return 'legacy';
  const hasOversize = marks.includes('oversize');
  const hasDone = marks.some((m) => m !== 'oversize');
  return hasOversize || !hasDone ? 'incremental' : 'forward-only-init';
}

/**
 * Backlog sessions that discovery did not return this run (their mtime is at or
 * below the highWater), as session refs. `statSize(path)` returns null when the
 * file is gone; such entries are reported in `gone` so the caller can clear them.
 */
function collectBacklog(store, sourceId, discoveredIds, statSize) {
  const refs = [];
  const gone = [];
  for (const { sessionId, entry } of store.backlog(sourceId)) {
    if (discoveredIds.has(sessionId)) continue;
    const p = entry.path;
    const size = p ? statSize(p) : null;
    if (size === null || size === undefined) { gone.push(sessionId); continue; }
    refs.push({ sessionId, path: p, mtime: entry.mtime || new Date(0).toISOString(), bytes: size, fromBacklog: true });
  }
  return { refs, gone };
}

function newStats() {
  return {
    incrementalSegments: 0,
    backlogSessions: 0,
    processed: 0,
    skipped: 0,
    failed: 0,
    retained: 0,
    held: 0,
    refused: 0,
    unchanged: 0,
    tailPending: 0,
    forwardInit: 0,
    sessionLocked: 0,
    transientRetained: 0,
    budgetDeferred: 0,
    backlogDiscovered: 0,
    unsupported: {},
    offsetResets: 0,
  };
}

/**
 * @param {object} p
 * @param {object} p.source      adapter instance (offsetCapable)
 * @param {object} p.sessionRef  {sessionId, path, mtime, bytes}
 * @param {object} p.ledger      in-memory ledger
 * @param {object} p.store       offsets store
 * @param {object} p.stats       newStats() accumulator
 * @param {object} p.opts        {dryRun, maxSegments, charBudget, minChars, capBytes, accountLabel}
 * @param {object} p.deps        see runner.js (statSize, scrubAndVerify, sha256, ledgerHas, ledgerMark,
 *                               saveLedger, writeQueueFile, deleteQueueFile, postExtract, isSkippedExtraction,
 *                               recordRealExtractionCompletion, onOutcome, log, captureVisibilityPrivate)
 * @returns {Promise<{handled:boolean, mode:string}>} handled=false means "use the legacy path"
 */
async function processSession({ source, sessionRef, ledger, store, stats, opts, deps }) {
  const type = source.type;
  const sessionId = sessionRef.sessionId;
  const log = deps.log;
  let entry = store.get(type, sessionId);
  const size = (() => {
    const s = sessionRef.path ? deps.statSize(sessionRef.path) : null;
    return s !== null && s !== undefined ? s : (Number.isFinite(sessionRef.bytes) ? sessionRef.bytes : null);
  })();
  const marks = ledgerMarksFor(ledger, type, sessionId);
  const mode = decideMode({ adapter: source, sessionRef, entry, size, capBytes: opts.capBytes, marks, incrementalForced: opts.incrementalForced });
  if (mode === 'legacy') {
    // A stale backlog flag on a session that now takes the whole-file path must not loop forever.
    if (entry && entry.more && !opts.dryRun) store.update(type, sessionId, { more: false });
    return { handled: false, mode };
  }

  // One process per session at a time (a hook run and the sweep can meet on the
  // same transcript). Never blocks: a held lock skips the session this pass.
  let release = null;
  if (!opts.dryRun && typeof store.tryLockSession === 'function') {
    release = store.tryLockSession(type, sessionId);
    if (!release) {
      stats.sessionLocked += 1;
      log(`[runner]   session_locked ${sessionId}: another run holds it; skipped this pass`);
      return { handled: true, mode: 'session_locked' };
    }
    entry = store.get(type, sessionId); // re-read under the lock
  }
  try {
    return await processLocked({ source, sessionRef, ledger, store, stats, opts, deps, type, sessionId, log, entry, size, marks, mode });
  } finally {
    if (release) { try { release(); } catch { /* best-effort */ } }
  }
}

async function processLocked({ source, sessionRef, ledger, store, stats, opts, deps, type, sessionId, log, entry, size, marks, mode }) {
  const persist = (patch) => {
    if (opts.dryRun) return;
    const clean = {};
    for (const k of Object.keys(patch)) if (patch[k] !== undefined) clean[k] = patch[k];
    store.update(type, sessionId, { path: sessionRef.path, mtime: sessionRef.mtime, ...clean });
  };

  if (entry && !entry.more) {
    let same = entry.size === size && (entry.state || entry.tailPendingSize === size);
    // Adapters whose file size does not track their content (SQLite WAL) answer
    // with a cheap probe instead of trusting size equality.
    if (entry.state && typeof source.isUnchanged === 'function') {
      try { same = Boolean(await source.isUnchanged(sessionRef, entry.state)); } catch { same = false; }
    }
    if (same) {
      stats.unchanged += 1;
      return { handled: true, mode: 'unchanged' };
    }
  }
  if (sessionRef.fromBacklog) stats.backlogSessions += 1;

  // Per-sweep segment budget: when spent, start nothing new; the session stays backlog.
  const budget = opts.budget || null;
  if (budget && budget.remaining <= 0) {
    stats.budgetDeferred += 1;
    persist({ size, more: true });
    return { handled: true, mode: 'budget-deferred' };
  }

  // First entry into incremental mode: adapter gate (e.g. Codex non-user threads).
  if (!(entry && entry.state)) {
    let probe;
    try { probe = await source.probeSession(sessionRef); } catch (err) { probe = { ok: false, reason: `probe error: ${err.message}` }; }
    if (probe && probe.ok === false) {
      if (probe.unsupported) {
        stats.unsupported[probe.reason] = (stats.unsupported[probe.reason] || 0) + 1;
        log(`[runner]   Incremental unsupported for ${sessionId}: ${probe.reason} (not marked, not skipped silently)`);
        return { handled: true, mode: 'unsupported' };
      }
      stats.refused += 1;
      stats.skipped += 1;
      if (!opts.dryRun) deps.ledgerMark(ledger, type, sessionId, 'probe-refused', sessionRef.mtime);
      return { handled: true, mode: 'refused' };
    }
  }

  if (mode === 'forward-only-init') {
    const st = await source.forwardOnlyState(sessionRef);
    if (st && st.unsupported) {
      stats.unsupported[st.unsupported] = (stats.unsupported[st.unsupported] || 0) + 1;
      log(`[runner]   Incremental unsupported for ${sessionId}: ${st.unsupported}`);
      return { handled: true, mode: 'unsupported' };
    }
    persist({ state: st, size, more: false, tailPendingSize: null, forwardOnly: true });
    stats.forwardInit += 1;
    log(`[runner]   Incremental forward-only start for ${sessionId} (already handled before; only new content from here)`);
    return { handled: true, mode };
  }

  let res;
  try {
    const hasDone = marks.some((m) => m !== 'oversize');
    const perSession = opts.maxSegments > 0 ? opts.maxSegments : DEFAULT_MAX_SEGMENTS_PER_SESSION;
    res = await source.readNewSegments(sessionRef, entry && entry.state ? entry.state : null, {
      charBudget: opts.charBudget,
      maxSegments: budget ? Math.max(1, Math.min(perSession, budget.remaining)) : opts.maxSegments,
      maxBytes: opts.capBytes,
      // A reset on a session already extracted (or started forward-only) must not re-extract it from 0.
      resetPolicy: (entry && entry.forwardOnly) || hasDone ? 'forward-only' : 'backfill',
    });
  } catch (err) {
    log(`[runner]   Incremental read failed for ${sessionId}: ${err.message}`);
    stats.failed += 1;
    if (entry && entry.state) persist({ more: true });
    return { handled: true, mode: 'read-failed' };
  }

  if (res.unsupported) {
    stats.unsupported[res.unsupported] = (stats.unsupported[res.unsupported] || 0) + 1;
    log(`[runner]   Incremental unsupported for ${sessionId}: ${res.unsupported}`);
    return { handled: true, mode: 'unsupported' };
  }
  if (res.transient) {
    stats.transientRetained += 1;
    log(`[runner]   transient_retained ${sessionId}: ${res.transientReason || 'transient'}; state not advanced`);
    persist({ state: entry && entry.state ? entry.state : undefined, size, more: true });
    return { handled: true, mode: 'transient-read' };
  }
  if (res.resetReason) {
    stats.offsetResets += 1;
    store.noteReset();
    if (res.resetForwardOnly) {
      log(`[runner]   offset_reset ${sessionId}: ${res.resetReason}; session already handled, restarting from the current end`);
      persist({ state: res.state, size, more: false, tailPendingSize: null, forwardOnly: true });
      stats.forwardInit += 1;
      return { handled: true, mode: 'reset-forward-only' };
    }
    log(`[runner]   offset_reset ${sessionId}: ${res.resetReason}; re-reading from the start`);
  }

  const segments = res.segments || [];
  const sessionFile = require('path').basename(sessionRef.path || sessionId);
  let lastGoodState = res.resetReason ? null : (entry && entry.state ? entry.state : null);

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const isLast = i === segments.length - 1;
    const moreAfter = !isLast || !res.caughtUp;
    stats.incrementalSegments += 1;
    if (budget) budget.remaining -= 1;
    const verdict = await handleSegment({ source, sessionRef, seg, isTail: isLast && Boolean(res.caughtUp), ledger, stats, opts, deps, sessionFile });

    if (verdict === 'transient') {
      // Do NOT advance and do NOT mark the session done; keep it in the backlog.
      persist({ state: lastGoodState || undefined, size, more: true });
      return { handled: true, mode: 'transient' };
    }
    if (verdict === 'dry-run') continue;
    if (verdict === 'tail-pending') {
      persist({ state: lastGoodState || undefined, size, more: false, tailPendingSize: size });
      stats.tailPending += 1;
      return { handled: true, mode: 'tail-pending' };
    }
    // terminal: extracted | duplicate | scrub-refused | short
    lastGoodState = seg.nextState;
    persist({ state: lastGoodState, size, more: moreAfter, tailPendingSize: null });
  }

  if (budget && budget.remaining <= 0 && !res.caughtUp && segments.length > 0) stats.budgetDeferred += 1;
  if (!opts.dryRun && segments.length === 0 && res.state) {
    // Nothing extractable, but the cursor may have moved past non-text lines.
    persist({ state: res.state, size, more: !res.caughtUp, tailPendingSize: null });
  }
  return { handled: true, mode: 'incremental' };
}

/**
 * Same scrub -> extract -> submit path a whole session uses.
 * Verdicts: extracted | duplicate | scrub-refused | short | tail-pending | dry-run | transient
 */
async function handleSegment({ source, sessionRef, seg, isTail, ledger, stats, opts, deps, sessionFile }) {
  const type = source.type;
  const sessionId = sessionRef.sessionId;
  const log = deps.log;
  let text = seg.text;

  if (text.length < opts.minChars) {
    log(`[runner]   Segment too short (${text.length} chars, min ${opts.minChars})${isTail ? ' — waiting for more' : ''}`);
    if (isTail) return 'tail-pending';
    stats.skipped += 1;
    return 'short';
  }
  if (text.length > opts.charBudget) text = text.slice(0, opts.charBudget);

  const { cleaned, report, refused } = deps.scrubAndVerify(text);
  if (refused || !cleaned) {
    log(`[runner]   Scrub fail-closed — refusing to upload segment ${deps.accountTag || ''}`.trimEnd());
    stats.skipped += 1;
    return 'scrub-refused';
  }
  if (!report.clean) {
    log(`[runner]   Scrubbed ${report.patterns_matched.length} sensitive pattern(s): ${[...new Set(report.patterns_matched)].join(', ')} ${deps.accountTag || ''}`.trimEnd());
  }
  if (opts.dryRun) {
    log(`[runner]   [DRY RUN] Would extract locally from ${cleaned.length} scrubbed chars (segment ${seg.startOffset}-${seg.endOffset})`);
    stats.processed += 1;
    return 'dry-run';
  }

  // Ledger check happens BEFORE any extraction (LLM) call.
  const sha = deps.sha256(cleaned);
  // Another process (a hook run) may have marked this segment since the ledger was loaded.
  if (typeof deps.refreshLedger === 'function') deps.refreshLedger(ledger);
  if (deps.ledgerHas(ledger, type, sessionId, sha)) {
    log(`[runner]   Skipped segment — already in ledger ${deps.accountTag || ''}`.trimEnd());
    stats.skipped += 1;
    return 'duplicate';
  }

  const queueFile = deps.writeQueueFile({
    source: type,
    sessionId,
    session_basename: sessionFile,
    transcript: cleaned,
    sha,
    scrubReport: report,
    mtime: sessionRef.mtime,
    queuedAt: new Date().toISOString(),
    segment: { startOffset: seg.startOffset, endOffset: seg.endOffset },
    ...(deps.captureVisibilityPrivate && { capture_visibility: 'private' }),
  });

  try {
    const detailed = await deps.postExtract(cleaned, sessionId, type, report, { sessionFile, returnDetailed: true });
    deps.onOutcome(detailed, sessionFile);
    if (deps.isSkippedExtraction(detailed)) {
      stats.retained += 1;
      // The segment is re-read next pass (state not advanced); a queue file would
      // let --flush-pending submit it a second time.
      deps.deleteQueueFile(queueFile);
      return 'transient';
    }
    stats.held += detailed.result.learnings_held || 0;
    deps.ledgerMark(ledger, type, sessionId, sha, sessionRef.mtime);
    deps.recordRealExtractionCompletion(ledger, detailed);
    deps.deleteQueueFile(queueFile);
    deps.saveLedger(ledger);
    stats.processed += 1;
    return 'extracted';
  } catch (err) {
    log(`[runner]   ✗ Upload failed: ${err.message} — segment not marked; it is re-read next pass`);
    deps.deleteQueueFile(queueFile);
    stats.failed += 1;
    return 'transient';
  }
}

module.exports = {
  resolveMaxSegments,
  resolveSweepSegmentBudget,
  orderForSweep,
  ledgerMarksFor,
  decideMode,
  collectBacklog,
  newStats,
  processSession,
  handleSegment,
  DEFAULT_MAX_SEGMENTS_PER_SESSION,
  DEFAULT_MAX_SEGMENTS_PER_SWEEP,
};
