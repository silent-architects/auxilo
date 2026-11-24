/**
 * scripts/sources/segment-reader.js — streamed, offset-resumable segment reader
 * for append-only JSONL transcripts (INCREMENTAL-SWEEP D2, state kind 'offset').
 *
 * Reads bytes from `fromOffset` (for `.zst`: streams through zstd decompression
 * and discards `fromOffset` DECOMPRESSED bytes), splits on 0x0A at the byte
 * level, consumes ONLY complete lines (a trailing partial line stays
 * unconsumed), asks the adapter to turn each line into a text turn
 * (adapter.parseLine), and groups turns into segments of at most `charBudget`
 * chars. A line longer than `maxLineBytes` is drained without buffering,
 * counted, and skipped. Memory is bounded by maxLineBytes + one chunk.
 *
 * Segment boundaries fall on line starts and a single turn longer than the
 * budget is truncated to its head (as the whole-file path truncates), so a
 * segment never needs a mid-line resume point and the reader can never livelock.
 *
 * fs and zlib are injectable. This file exports no TranscriptSource subclass,
 * so the runner's adapter registry ignores it.
 *
 * @module sources/segment-reader
 */

'use strict';

const fs = require('fs');
const zlib = require('zlib');
const crypto = require('crypto');
const { pipeline } = require('stream');

const DEFAULT_CHAR_BUDGET = 30000;
const DEFAULT_MAX_LINE_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_SEGMENTS = 3;
const HEAD_BYTES = 4096;
const ZST_UNSUPPORTED = 'zst_requires_node_22_15';
const SEGMENT_SEPARATOR = '\n\n';
const NL = 0x0a;

function codecFor(filePath) {
  return /\.zst$/i.test(String(filePath || '')) ? 'zst' : 'plain';
}

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * Open the decoded byte stream. Returns {stream} or {unsupported}.
 * For 'plain' the stream starts at `fromOffset`; for 'zst' it starts at 0
 * (the caller discards fromOffset decompressed bytes).
 */
function openDecoded(filePath, codec, fromOffset, deps = {}) {
  const fsImpl = deps.fsImpl || fs;
  const zlibImpl = deps.zlibImpl || zlib;
  if (codec === 'zst') {
    if (typeof zlibImpl.createZstdDecompress !== 'function') return { unsupported: ZST_UNSUPPORTED };
    const raw = fsImpl.createReadStream(filePath);
    const dec = zlibImpl.createZstdDecompress();
    pipeline(raw, dec, () => { /* errors surface on the decoded stream via destroy */ });
    return { stream: dec, discard: fromOffset };
  }
  return { stream: fsImpl.createReadStream(filePath, fromOffset > 0 ? { start: fromOffset } : undefined), discard: 0 };
}

/** First `HEAD_BYTES` decoded bytes (fewer if the file is shorter). */
async function readHead(filePath, codec, deps = {}) {
  const opened = openDecoded(filePath, codec, 0, deps);
  if (opened.unsupported) return { unsupported: opened.unsupported };
  const parts = [];
  let total = 0;
  try {
    for await (const chunk of opened.stream) {
      parts.push(chunk);
      total += chunk.length;
      if (total >= HEAD_BYTES) break;
    }
  } finally {
    if (typeof opened.stream.destroy === 'function') opened.stream.destroy();
  }
  return { head: Buffer.concat(parts).subarray(0, HEAD_BYTES) };
}

/** First complete line (as a string), up to maxBytes; null when none. */
async function readFirstLine(filePath, codec, deps = {}, maxBytes = 4 * 1024 * 1024) {
  const opened = openDecoded(filePath, codec, 0, deps);
  if (opened.unsupported) return { unsupported: opened.unsupported };
  const parts = [];
  let total = 0;
  let line = null;
  try {
    for await (const chunk of opened.stream) {
      const nl = chunk.indexOf(NL);
      if (nl >= 0) {
        parts.push(chunk.subarray(0, nl));
        line = Buffer.concat(parts).toString('utf8');
        break;
      }
      parts.push(chunk);
      total += chunk.length;
      if (total > maxBytes) break;
    }
  } finally {
    if (typeof opened.stream.destroy === 'function') opened.stream.destroy();
  }
  return { line };
}

/** Total decoded length (used for forward-only initialisation of .zst files). */
async function decodedLength(filePath, codec, deps = {}) {
  const opened = openDecoded(filePath, codec, 0, deps);
  if (opened.unsupported) return { unsupported: opened.unsupported };
  let total = 0;
  try {
    for await (const chunk of opened.stream) total += chunk.length;
  } finally {
    if (typeof opened.stream.destroy === 'function') opened.stream.destroy();
  }
  return { length: total };
}

/**
 * Async generator of segments. Summary facts land on `opts.outcome`:
 *   { consumedOffset, caughtUp, unsupported, offsetBeyondEof, partialTailBytes,
 *     linesSkippedOversize, linesTruncated }
 *
 * @param {object} sessionRef {path}
 * @param {object} adapter    needs parseLine(line, {isFirstRecord}) -> string|null
 * @param {object} opts       {fromOffset, charBudget, maxLineBytes, maxSegments, codec, fsImpl, zlibImpl, outcome}
 * @yields {{text, startOffset, endOffset, linesSkippedOversize, linesTruncated}}
 */
async function* readSegments(sessionRef, adapter, opts = {}) {
  const fromOffset = opts.fromOffset > 0 ? opts.fromOffset : 0;
  const charBudget = opts.charBudget > 0 ? opts.charBudget : DEFAULT_CHAR_BUDGET;
  const maxLineBytes = opts.maxLineBytes > 0 ? opts.maxLineBytes : DEFAULT_MAX_LINE_BYTES;
  const maxSegments = opts.maxSegments > 0 ? opts.maxSegments : Infinity;
  const codec = opts.codec || codecFor(sessionRef.path);
  const outcome = opts.outcome || {};
  Object.assign(outcome, {
    consumedOffset: fromOffset,
    caughtUp: false,
    unsupported: null,
    offsetBeyondEof: false,
    partialTailBytes: 0,
    linesSkippedOversize: 0,
    linesTruncated: 0,
  });

  const opened = openDecoded(sessionRef.path, codec, fromOffset, opts);
  if (opened.unsupported) {
    outcome.unsupported = opened.unsupported;
    return;
  }

  let toDiscard = opened.discard;
  let pos = fromOffset; // absolute offset of the first byte of the in-progress line
  let chunks = [];
  let lineBytes = 0; // bytes of the in-progress line seen so far (counted even while draining)
  let draining = false;
  let sawFirstRecord = false;

  let cur = []; // texts of the segment being built
  let curLen = 0;
  let curStart = fromOffset;
  let lastEnd = fromOffset; // end offset of the last complete line seen
  let segments = 0;
  let skippedSinceYield = 0;
  let truncatedSinceYield = 0;
  let pending = null; // {text, start, end} a text line that did not fit the closed segment

  function textOf(line) {
    if (!line.trim()) return null;
    const isFirstRecord = !sawFirstRecord && fromOffset === 0;
    sawFirstRecord = true;
    try {
      const t = adapter.parseLine(line, { isFirstRecord });
      return typeof t === 'string' && t.length > 0 ? t : null;
    } catch {
      return null;
    }
  }

  function takeSegment(endOffset) {
    const seg = {
      text: cur.join(SEGMENT_SEPARATOR),
      startOffset: curStart,
      endOffset,
      linesSkippedOversize: skippedSinceYield,
      linesTruncated: truncatedSinceYield,
    };
    cur = [];
    curLen = 0;
    skippedSinceYield = 0;
    truncatedSinceYield = 0;
    segments += 1;
    return seg;
  }

  // Handles one complete line; returns a segment to yield or null.
  function onLine(start, end, text) {
    lastEnd = end;
    if (text === null) return null;
    let t = text;
    if (t.length > charBudget) {
      t = t.slice(0, charBudget);
      truncatedSinceYield += 1;
      outcome.linesTruncated += 1;
    }
    if (cur.length > 0 && curLen + SEGMENT_SEPARATOR.length + t.length > charBudget) {
      const seg = takeSegment(start);
      pending = { text: t, start, end };
      return seg;
    }
    if (cur.length === 0) curStart = start;
    cur.push(t);
    curLen += (cur.length > 1 ? SEGMENT_SEPARATOR.length : 0) + t.length;
    return null;
  }

  const stream = opened.stream;
  try {
    for await (let chunk of stream) {
      if (toDiscard > 0) {
        if (chunk.length <= toDiscard) { toDiscard -= chunk.length; continue; }
        chunk = chunk.subarray(toDiscard);
        toDiscard = 0;
      }
      let i = 0;
      while (i < chunk.length) {
        const nl = chunk.indexOf(NL, i);
        const end = nl === -1 ? chunk.length : nl;
        const len = end - i;
        if (len > 0) {
          lineBytes += len;
          if (!draining) {
            if (lineBytes > maxLineBytes) { draining = true; chunks = []; } else chunks.push(chunk.subarray(i, end));
          }
        }
        if (nl === -1) break;

        const lineStart = pos;
        const lineEnd = pos + lineBytes + 1;
        let text = null;
        if (draining) {
          outcome.linesSkippedOversize += 1;
          skippedSinceYield += 1;
        } else {
          text = textOf(Buffer.concat(chunks).toString('utf8'));
        }
        chunks = [];
        lineBytes = 0;
        draining = false;
        pos = lineEnd;
        i = nl + 1;

        const seg = onLine(lineStart, lineEnd, text);
        if (seg) {
          yield seg;
          if (segments >= maxSegments) {
            // More content exists (the pending text line); resume at its start.
            outcome.consumedOffset = pending.start;
            outcome.caughtUp = false;
            return;
          }
          // Start the next segment with the line that did not fit.
          curStart = pending.start;
          cur = [pending.text];
          curLen = pending.text.length;
          pending = null;
        }
      }
    }

    if (toDiscard > 0) {
      outcome.offsetBeyondEof = true;
      return;
    }
    outcome.partialTailBytes = lineBytes;
    if (cur.length > 0) {
      const seg = takeSegment(lastEnd);
      outcome.consumedOffset = lastEnd;
      outcome.caughtUp = true;
      yield seg;
      return;
    }
    outcome.consumedOffset = lastEnd;
    outcome.caughtUp = true;
  } finally {
    if (stream && typeof stream.destroy === 'function') stream.destroy();
  }
}

function headStateFor(headBuf, offset, codec) {
  const headLen = Math.min(HEAD_BYTES, offset, headBuf ? headBuf.length : 0);
  return {
    kind: 'offset',
    offset,
    headLen,
    headSha: headLen > 0 ? sha256Hex(headBuf.subarray(0, headLen)) : null,
    codec,
  };
}

/**
 * Uniform-contract implementation for state kind 'offset'. Validates the stored
 * state (resets to 0 on size shrink, head mismatch, or an offset beyond EOF),
 * reads up to maxSegments segments, and returns
 *   { segments:[{text,nextState,startOffset,endOffset,linesSkippedOversize}],
 *     state, caughtUp, resetReason, unsupported?, ... }
 */
async function readNewSegmentsOffset(adapter, sessionRef, state, opts = {}) {
  const deps = { fsImpl: opts.fsImpl || fs, zlibImpl: opts.zlibImpl || zlib };
  const codec = codecFor(sessionRef.path);
  const base = {
    kind: 'offset', offset: 0, headLen: 0, headSha: null, codec,
  };
  const prior = state && state.kind === 'offset' && Number.isInteger(state.offset) && state.offset >= 0
    ? state
    : null;

  if (codec === 'zst' && typeof deps.zlibImpl.createZstdDecompress !== 'function') {
    return { segments: [], state: prior || base, caughtUp: false, unsupported: ZST_UNSUPPORTED };
  }

  const headRes = await readHead(sessionRef.path, codec, deps);
  if (headRes.unsupported) return { segments: [], state: prior || base, caughtUp: false, unsupported: headRes.unsupported };
  const head = headRes.head;

  let fromOffset = prior ? prior.offset : 0;
  let resetReason = null;

  if (prior && fromOffset > 0) {
    let size = null;
    if (codec === 'plain') {
      try { size = deps.fsImpl.statSync(sessionRef.path).size; } catch { size = null; }
    }
    if (size !== null && size < fromOffset) {
      resetReason = 'size_shrank';
    } else if (prior.headLen > 0) {
      if (head.length < prior.headLen || sha256Hex(head.subarray(0, prior.headLen)) !== prior.headSha) {
        resetReason = 'head_changed';
      }
    }
    if (resetReason) fromOffset = 0;
  }

  const run = async (from) => {
    const outcome = {};
    const segs = [];
    for await (const seg of readSegments(sessionRef, adapter, {
      fromOffset: from,
      charBudget: opts.charBudget,
      maxLineBytes: opts.maxLineBytes,
      maxSegments: opts.maxSegments > 0 ? opts.maxSegments : DEFAULT_MAX_SEGMENTS,
      codec,
      fsImpl: deps.fsImpl,
      zlibImpl: deps.zlibImpl,
      outcome,
    })) {
      segs.push(seg);
    }
    return { outcome, segs };
  };

  let { outcome, segs } = await run(fromOffset);
  if (outcome.offsetBeyondEof) {
    resetReason = resetReason || 'offset_beyond_eof';
    fromOffset = 0;
    ({ outcome, segs } = await run(0));
  }
  if (outcome.unsupported) {
    return { segments: [], state: prior || base, caughtUp: false, unsupported: outcome.unsupported };
  }

  const segments = segs.map((s) => ({
    text: s.text,
    startOffset: s.startOffset,
    endOffset: s.endOffset,
    linesSkippedOversize: s.linesSkippedOversize,
    nextState: headStateFor(head, s.endOffset, codec),
  }));
  const finalState = headStateFor(head, outcome.consumedOffset, codec);
  return {
    segments,
    state: finalState,
    caughtUp: outcome.caughtUp,
    resetReason,
    linesSkippedOversize: outcome.linesSkippedOversize,
    linesTruncated: outcome.linesTruncated,
    partialTailBytes: outcome.partialTailBytes,
  };
}

/** Forward-only initial state: everything currently present counts as already handled. */
async function forwardOnlyStateOffset(sessionRef, opts = {}) {
  const deps = { fsImpl: opts.fsImpl || fs, zlibImpl: opts.zlibImpl || zlib };
  const codec = codecFor(sessionRef.path);
  const headRes = await readHead(sessionRef.path, codec, deps);
  if (headRes.unsupported) return { unsupported: headRes.unsupported };
  let offset;
  if (codec === 'plain') {
    offset = deps.fsImpl.statSync(sessionRef.path).size;
  } else {
    const len = await decodedLength(sessionRef.path, codec, deps);
    if (len.unsupported) return { unsupported: len.unsupported };
    offset = len.length;
  }
  return headStateFor(headRes.head, offset, codec);
}

// ─── Whole-document state (kind 'hashes', ERRATUM-1 D3b) ─────────────────────
//
// For adapters whose transcript is ONE rewritten JSON document (cline, roo-code,
// continue, gemini-cli). The adapter supplies `turnsFromDocument(parsed)` ->
// {turns:[string]} | {refuse:reason}; this engine hashes each normalized turn
// (sha256, 16 hex), remembers which were handled, and extracts only the unseen
// ones in document order. An edited message hashes differently, so it counts as
// new. The k-th occurrence of an identical turn is keyed sha256(hash#k) so a
// NEW repeat of an old message ("ok") is not mistaken for the old one.

const HASH_SEEN_CAP = 20000;
const HASH_HEX_LEN = 16;
const OVERSIZE_DOCUMENT = 'oversize_document';
const INVALID_JSON_DOCUMENT = 'invalid_json_document';
const FORMAT_REFUSED = 'format_probe_refused';

function hash16(s) {
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, HASH_HEX_LEN);
}

/** Per-turn keys: sha256 prefix, with an occurrence suffix for repeated turns. */
function turnKeys(turns) {
  const counts = new Map();
  return turns.map((t) => {
    const h = hash16(t);
    const k = counts.get(h) || 0;
    counts.set(h, k + 1);
    return k === 0 ? h : hash16(`${h}#${k}`);
  });
}

function hashesDeps(adapter, opts) {
  const fsImpl = opts.fsImpl || adapter.fsImpl || fs;
  let maxBytes = opts.maxBytes;
  if (!(maxBytes > 0)) maxBytes = require('./source.interface').resolveMaxSessionBytes();
  return { fsImpl, maxBytes };
}

/**
 * Load + parse the document. Returns {turns, keys, docSha} or exactly one of
 * {unsupported:reason} (oversize / invalid JSON / unreadable: transient, never
 * marked) or {refuse:reason} (valid JSON, wrong shape: permanent).
 */
function loadDocument(adapter, sessionRef, opts) {
  const { fsImpl, maxBytes } = hashesDeps(adapter, opts);
  const p = sessionRef && sessionRef.path;
  if (!p) return { unsupported: 'no_path' };
  let size;
  try { size = fsImpl.statSync(p).size; } catch { return { unsupported: 'document_unreadable' }; }
  if (size > maxBytes) return { unsupported: OVERSIZE_DOCUMENT };
  let buf;
  try { buf = fsImpl.readFileSync(p); } catch { return { unsupported: 'document_unreadable' }; }
  if (buf.length > maxBytes) return { unsupported: OVERSIZE_DOCUMENT };
  let parsed;
  try { parsed = JSON.parse(buf.toString('utf-8')); } catch { return { unsupported: INVALID_JSON_DOCUMENT }; }
  const r = adapter.turnsFromDocument(parsed);
  if (!r || r.refuse) return { refuse: (r && r.refuse) || 'unrecognised document' };
  return { turns: r.turns, keys: turnKeys(r.turns), docSha: sha256Hex(buf).slice(0, HASH_HEX_LEN) };
}

function hashesStateOf(seen, docSha, truncatedSticky) {
  let out = seen;
  let truncated = Boolean(truncatedSticky);
  if (out.length > HASH_SEEN_CAP) { out = out.slice(-HASH_SEEN_CAP); truncated = true; }
  const st = { kind: 'hashes', seen: out.slice(), docSha };
  if (truncated) st.truncated = true;
  return st;
}

function priorHashes(state) {
  return state && state.kind === 'hashes' && Array.isArray(state.seen) ? state : null;
}

async function probeHashesSession(adapter, sessionRef, opts = {}) {
  const doc = loadDocument(adapter, sessionRef, opts);
  if (doc.unsupported) return { ok: false, unsupported: true, reason: doc.unsupported };
  if (doc.refuse) return { ok: false, reason: `${FORMAT_REFUSED}: ${doc.refuse}` };
  return { ok: true };
}

async function readNewSegmentsHashes(adapter, sessionRef, state, opts = {}) {
  const prior = priorHashes(state);
  const keep = prior || null;
  const doc = loadDocument(adapter, sessionRef, opts);
  if (doc.unsupported) return { segments: [], state: keep, caughtUp: false, unsupported: doc.unsupported };
  if (doc.refuse) return { segments: [], state: keep, caughtUp: false, unsupported: FORMAT_REFUSED };

  const charBudget = opts.charBudget > 0 ? opts.charBudget : DEFAULT_CHAR_BUDGET;
  const maxSegments = opts.maxSegments > 0 ? opts.maxSegments : DEFAULT_MAX_SEGMENTS;
  const seenSet = new Set(prior ? prior.seen : []);
  const truncatedSticky = Boolean(prior && prior.truncated);

  // After a cap overflow the oldest keys are gone; everything before the first
  // retained key (in document order) is treated as handled, so a long session is
  // not re-extracted from its start.
  let anchor = 0;
  if (truncatedSticky) {
    const first = doc.keys.findIndex((k) => seenSet.has(k));
    anchor = first < 0 ? 0 : first;
  }

  const running = prior ? prior.seen.slice() : [];
  const segments = [];
  let cur = [];
  let curLen = 0;
  let curIdx = [];
  let consumedAll = true;

  const flush = () => {
    for (const i of curIdx) running.push(doc.keys[i]);
    segments.push({
      text: cur.join(SEGMENT_SEPARATOR),
      startOffset: curIdx[0],
      endOffset: curIdx[curIdx.length - 1] + 1,
      linesSkippedOversize: 0,
      nextState: hashesStateOf(running, doc.docSha, truncatedSticky),
    });
    cur = []; curLen = 0; curIdx = [];
  };

  for (let i = anchor; i < doc.turns.length; i++) {
    if (seenSet.has(doc.keys[i])) continue;
    let t = doc.turns[i];
    if (t.length > charBudget) t = t.slice(0, charBudget);
    if (cur.length > 0 && curLen + SEGMENT_SEPARATOR.length + t.length > charBudget) {
      flush();
      if (segments.length >= maxSegments) { consumedAll = false; break; }
    }
    curLen += (cur.length > 0 ? SEGMENT_SEPARATOR.length : 0) + t.length;
    cur.push(t);
    curIdx.push(i);
  }
  if (consumedAll && cur.length > 0) flush();

  const finalState = segments.length > 0
    ? segments[segments.length - 1].nextState
    : hashesStateOf(running, doc.docSha, truncatedSticky);
  return { segments, state: finalState, caughtUp: consumedAll };
}

async function forwardOnlyStateHashes(adapter, sessionRef, opts = {}) {
  const doc = loadDocument(adapter, sessionRef, opts);
  if (doc.unsupported) return { unsupported: doc.unsupported };
  if (doc.refuse) return { unsupported: FORMAT_REFUSED };
  return hashesStateOf(doc.keys, doc.docSha, false);
}

/**
 * Install the 'hashes' contract on an adapter class. The adapter must define
 * `turnsFromDocument(parsed)` and `sessionIdForPath(p)`. These sessions are
 * routed through the incremental path on first sight (requiresIncremental) so
 * a growing or edited document is extracted by unseen message, never by its
 * first 30,000 characters again.
 */
function installHashesContract(Class) {
  Object.defineProperty(Class.prototype, 'offsetCapable', { get() { return true; }, configurable: true });
  Class.prototype.requiresIncremental = function requiresIncremental() { return true; };
  Class.prototype.probeSession = function probeSession(ref) { return probeHashesSession(this, ref, {}); };
  Class.prototype.readNewSegments = function readNewSegments(ref, state, opts) { return readNewSegmentsHashes(this, ref, state, opts || {}); };
  Class.prototype.forwardOnlyState = function forwardOnlyState(ref, opts) { return forwardOnlyStateHashes(this, ref, opts || {}); };
}

module.exports = {
  readSegments,
  readNewSegmentsOffset,
  forwardOnlyStateOffset,
  readFirstLine,
  readHead,
  codecFor,
  headStateFor,
  installHashesContract,
  readNewSegmentsHashes,
  forwardOnlyStateHashes,
  probeHashesSession,
  turnKeys,
  HASH_SEEN_CAP,
  OVERSIZE_DOCUMENT,
  DEFAULT_CHAR_BUDGET,
  DEFAULT_MAX_LINE_BYTES,
  DEFAULT_MAX_SEGMENTS,
  HEAD_BYTES,
  ZST_UNSUPPORTED,
};
