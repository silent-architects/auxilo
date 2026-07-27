'use strict';

/**
 * Client-side extraction memory for SPEC3-F2.
 *
 * The index is local, append-only, and advisory. Every read or write failure
 * fails open: extraction/submission continues without prompt memory or lexical
 * filtering. The only shared detector is lib/similarity.js.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { findNearDuplicate, scoreChannels } = require('./similarity.js');

const DEFAULT_INDEX_PATH = path.join(os.homedir(), '.auxilo', 'extracted-index.jsonl');
const HYDRATION_PAGE_SIZE = 500;
const PROMPT_MEMORY_MAX_TOKENS = 1200;
const PROMPT_MEMORY_MAX_ROWS = 40;
const VALID_STATUSES = new Set(['approved', 'rejected', 'pending_review']);

const MEMORY_INSTRUCTIONS = `PREVIOUSLY CAPTURED LESSONS
The following lessons were already submitted by this account.
A candidate that re-states any listed lesson — reworded, or a different facet of the same operational insight — is DROPPED, not relabeled and not "improved."
Extract new facts about a listed lesson ONLY when the new fact would change what another agent does: it must create a behavioral difference, not merely a wording difference.
Never discard a memory match invisibly. Put the complete candidate plus the matched lesson id/title in dedup_drops so the local runner can write its audit trail.`;

const CATEGORY_HINTS = Object.freeze({
  'data-processing': ['data', 'parse', 'parser', 'json', 'csv', 'transform', 'pipeline'],
  'web-interaction': ['api', 'http', 'browser', 'gmail', 'webhook', 'request', 'response'],
  'code-execution': ['code', 'script', 'python', 'node', 'shell', 'command', 'runtime'],
  'storage-state': ['state', 'queue', 'database', 'storage', 'file', 'commit', 'cache'],
  'payment-financial': ['payment', 'stripe', 'usdc', 'wallet', 'settlement', 'withdraw'],
  monitoring: ['monitor', 'alert', 'health', 'log', 'metric', 'observability', 'incident'],
});

function loud(log, message) {
  try {
    (log || console.error)(`[extraction-index] ${message}`);
  } catch {
    // A broken logger must not turn advisory dedup into a submission blocker.
  }
}

function normalizeTags(tags) {
  return Array.isArray(tags) ? tags.slice(0, 8).map(String) : [];
}

function validIndexRow(row) {
  return Boolean(
    row &&
    typeof row === 'object' &&
    typeof row.title === 'string' &&
    row.title.trim() &&
    typeof row.category === 'string'
  );
}

/**
 * Read an append-only JSONL index. A malformed line is skipped and logged, but
 * marks the read unusable so extraction fails open instead of trusting a
 * partially corrupt memory/filter corpus.
 */
function readExtractionIndex(opts = {}) {
  const indexPath = opts.indexPath || DEFAULT_INDEX_PATH;
  const fsImpl = opts.fsImpl || fs;
  let exists;
  try {
    exists = fsImpl.existsSync(indexPath);
  } catch (error) {
    loud(opts.log, `index existence check failed; dedup disabled for this run: ${error.message}`);
    return { state: 'unreadable', usable: false, rows: [], bad_lines: 0 };
  }
  if (!exists) return { state: 'missing', usable: false, rows: [], bad_lines: 0 };

  let raw;
  try {
    raw = fsImpl.readFileSync(indexPath, 'utf8');
  } catch (error) {
    loud(opts.log, `index read failed; dedup disabled for this run: ${error.message}`);
    return { state: 'unreadable', usable: false, rows: [], bad_lines: 0 };
  }

  const rows = [];
  let badLines = 0;
  const lines = String(raw).split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    try {
      const row = JSON.parse(line);
      if (!validIndexRow(row)) throw new Error('missing title/category');
      rows.push(row);
    } catch (error) {
      badLines += 1;
      loud(opts.log, `skipping corrupt line ${index + 1} in ${indexPath}: ${error.message}`);
    }
  }

  if (badLines > 0) {
    loud(opts.log, `index contains ${badLines} corrupt line(s); prompt memory and lexical dedup are disabled for this run`);
    return { state: 'corrupt', usable: false, rows, bad_lines: badLines };
  }
  return { state: 'ready', usable: true, rows, bad_lines: 0 };
}

function appendJsonlRows(rows, opts = {}) {
  const indexPath = opts.indexPath || DEFAULT_INDEX_PATH;
  const fsImpl = opts.fsImpl || fs;
  try {
    fsImpl.mkdirSync(path.dirname(indexPath), { recursive: true, mode: 0o700 });
    if (!rows.length) {
      const fd = fsImpl.openSync(indexPath, 'a', 0o600);
      fsImpl.closeSync(fd);
      return true;
    }
    const payload = rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
    fsImpl.appendFileSync(indexPath, payload, { encoding: 'utf8', mode: 0o600 });
    return true;
  } catch (error) {
    loud(opts.log, `index append failed; extraction/submission continues: ${error.message}`);
    return false;
  }
}

function localIndexRow(learning, response = {}, opts = {}) {
  const nowValue = typeof opts.now === 'function'
    ? opts.now()
    : (opts.now || new Date().toISOString());
  const body = String(learning.body || '');
  return {
    title: String(learning.title || ''),
    category: String(learning.category || ''),
    tags: normalizeTags(learning.tags),
    body_hash: crypto.createHash('sha256').update(body).digest('hex'),
    body,
    submitted_at: String(nowValue),
    ...(typeof response.id === 'string' && response.id && { learning_id: response.id }),
    ...(typeof response.status === 'string' && VALID_STATUSES.has(response.status) && {
      status: response.status,
    }),
  };
}

/**
 * Append only after POST /learn returns 2xx. A network/4xx failure remains
 * retryable and is not allowed to poison the local dedup memory.
 */
function appendSubmittedLearning(learning, response = {}, opts = {}) {
  if (!learning || typeof learning !== 'object') return false;
  return appendJsonlRows([localIndexRow(learning, response, opts)], opts);
}

function hydratedIndexRow(learning) {
  return {
    title: String(learning.title || ''),
    category: String(learning.category || ''),
    tags: normalizeTags(learning.tags),
    body_hash: null,
    submitted_at: learning.created_at || null,
    ...(typeof learning.id === 'string' && learning.id && { learning_id: learning.id }),
    ...(typeof learning.status === 'string' && VALID_STATUSES.has(learning.status) && {
      status: learning.status,
    }),
  };
}

/**
 * Hydrate only a missing index from the caller's own metadata endpoint. The
 * endpoint intentionally carries no body, so hydrated rows inform the prompt
 * only; lexical filtering is limited to locally appended rows with a body.
 */
async function hydrateExtractionIndex(opts = {}) {
  const indexPath = opts.indexPath || DEFAULT_INDEX_PATH;
  const fsImpl = opts.fsImpl || fs;
  try {
    if (fsImpl.existsSync(indexPath)) return { hydrated: false, reason: 'not_fresh' };
  } catch (error) {
    loud(opts.log, `fresh-index check failed; hydration skipped: ${error.message}`);
    return { hydrated: false, reason: 'unreadable' };
  }

  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const baseUrl = String(opts.baseUrl || '').replace(/\/+$/, '');
  const apiKey = opts.apiKey;
  if (typeof fetchImpl !== 'function' || !baseUrl || !apiKey) {
    loud(opts.log, 'fresh-machine hydration unavailable (missing fetch, base URL, or API key); extracting without memory');
    return { hydrated: false, reason: 'unavailable' };
  }

  const hydratedRows = [];
  let offset = 0;
  try {
    for (let page = 0; page < 10000; page += 1) {
      const response = await fetchImpl(
        `${baseUrl}/account/learnings?limit=${HYDRATION_PAGE_SIZE}&offset=${offset}`,
        { headers: { 'X-API-Key': apiKey } }
      );
      if (!response || !response.ok) {
        const status = response && Number.isFinite(response.status) ? response.status : 'unknown';
        throw new Error(`GET /account/learnings returned ${status}`);
      }
      const payload = await response.json();
      if (!payload || !Array.isArray(payload.learnings)) {
        throw new Error('GET /account/learnings returned an invalid payload');
      }
      for (const row of payload.learnings) {
        const hydrated = hydratedIndexRow(row);
        if (!validIndexRow(hydrated)) {
          loud(opts.log, 'skipping malformed hydration row from GET /account/learnings');
          continue;
        }
        hydratedRows.push(hydrated);
      }
      offset += payload.learnings.length;
      const total = Number.isFinite(payload.total) ? payload.total : null;
      if (payload.learnings.length < HYDRATION_PAGE_SIZE ||
          (total !== null && offset >= total)) break;
      if (payload.learnings.length === 0) break;
    }
  } catch (error) {
    loud(opts.log, `fresh-machine hydration failed; extracting without memory: ${error.message}`);
    return { hydrated: false, reason: 'request_failed' };
  }

  if (!appendJsonlRows(hydratedRows, { indexPath, fsImpl, log: opts.log })) {
    return { hydrated: false, reason: 'write_failed' };
  }
  loud(opts.log, `hydrated ${hydratedRows.length} own learning metadata row(s) into ${indexPath}`);
  return { hydrated: true, count: hydratedRows.length };
}

async function loadIndexForExtraction(opts = {}) {
  const first = readExtractionIndex(opts);
  if (first.state !== 'missing') return first;
  const hydration = await hydrateExtractionIndex(opts);
  if (!hydration.hydrated) return first;
  return readExtractionIndex(opts);
}

function estimatePromptTokens(text) {
  return Math.ceil(Buffer.byteLength(String(text || ''), 'utf8') / 4);
}

function inferCategoryHints(transcript) {
  const text = String(transcript || '').toLowerCase();
  const scores = [];
  for (const [category, words] of Object.entries(CATEGORY_HINTS)) {
    let score = 0;
    for (const word of words) {
      const matches = text.match(new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'));
      score += matches ? matches.length : 0;
    }
    if (score > 0) scores.push({ category, score });
  }
  scores.sort((a, b) => b.score - a.score || a.category.localeCompare(b.category));
  if (!scores.length) return [];
  const top = scores[0].score;
  return scores.filter((entry) => entry.score === top).map((entry) => entry.category);
}

function submittedTime(row) {
  const parsed = Date.parse(row.submitted_at || row.created_at || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function oneLineGist(row) {
  if (typeof row.body === 'string' && row.body.trim()) {
    const compact = row.body.replace(/\s+/g, ' ').trim();
    const sentence = compact.match(/^(.{1,220}?[.!?])(?:\s|$)/);
    return (sentence ? sentence[1] : compact.slice(0, 220)).trim();
  }
  const tags = normalizeTags(row.tags).filter(Boolean);
  if (tags.length) return `Previously captured ${row.category} lesson tagged ${tags.join(', ')}.`;
  return `Previously captured ${row.category} lesson.`;
}

function indexRowId(row, index = 0) {
  return String(
    row.learning_id ||
    row.id ||
    row.body_hash ||
    `local-index-${index}`
  );
}

function promptMemoryLine(row, index) {
  const title = String(row.title || '').replace(/\s+/g, ' ').trim().slice(0, 180);
  const gist = oneLineGist(row).slice(0, 240);
  return `- [id:${indexRowId(row, index)} category:${row.category}] ${title} — ${gist}`;
}

/**
 * Budget strategy: inferred same-category rows first, then most recent rows,
 * with deterministic title/ID tie-breaking. The instruction header and rows
 * together may never exceed maxTokens.
 */
function buildPromptMemory(rows, opts = {}) {
  const maxTokens = Number.isFinite(opts.maxTokens)
    ? Math.max(0, Math.floor(opts.maxTokens))
    : PROMPT_MEMORY_MAX_TOKENS;
  const maxRows = Number.isFinite(opts.maxRows)
    ? Math.max(0, Math.floor(opts.maxRows))
    : PROMPT_MEMORY_MAX_ROWS;
  const hints = new Set(opts.categoryHints || inferCategoryHints(opts.transcript));
  const eligible = (Array.isArray(rows) ? rows : [])
    .filter(validIndexRow)
    .slice()
    .sort((a, b) => {
      const aMatch = hints.has(a.category) ? 1 : 0;
      const bMatch = hints.has(b.category) ? 1 : 0;
      return bMatch - aMatch ||
        submittedTime(b) - submittedTime(a) ||
        String(a.title).localeCompare(String(b.title)) ||
        String(a.learning_id || '').localeCompare(String(b.learning_id || ''));
    });

  if (!eligible.length || maxRows === 0 || estimatePromptTokens(MEMORY_INSTRUCTIONS) > maxTokens) {
    return {
      section: '',
      estimated_tokens: 0,
      included_count: 0,
      included_rows: [],
      category_hints: [...hints],
    };
  }

  const lines = [];
  const includedRows = [];
  for (let index = 0; index < eligible.length; index += 1) {
    const row = eligible[index];
    if (lines.length >= maxRows) break;
    const candidateLines = [...lines, promptMemoryLine(row, index)];
    const candidate = `${MEMORY_INSTRUCTIONS}\n${candidateLines.join('\n')}\n\n`;
    if (estimatePromptTokens(candidate) > maxTokens) break;
    lines.push(candidateLines[candidateLines.length - 1]);
    includedRows.push({
      id: indexRowId(row, index),
      title: row.title,
      category: row.category,
    });
  }
  if (!lines.length) {
    return {
      section: '',
      estimated_tokens: 0,
      included_count: 0,
      included_rows: [],
      category_hints: [...hints],
    };
  }
  const section = `${MEMORY_INSTRUCTIONS}\n${lines.join('\n')}\n\n`;
  return {
    section,
    estimated_tokens: estimatePromptTokens(section),
    included_count: lines.length,
    included_rows: includedRows,
    category_hints: [...hints],
  };
}

/**
 * Rank index rows against one extracted candidate with the shared F1 scoring
 * implementation. No flag threshold is applied: the score is used only for a
 * deterministic candidate-anchored top-K list for the local judge.
 */
function rankIndexRowsForCandidate(candidate, rows, opts = {}) {
  const topK = Number.isFinite(opts.topK)
    ? Math.max(0, Math.floor(opts.topK))
    : 10;
  if (!candidate || topK === 0) return [];
  return (Array.isArray(rows) ? rows : [])
    .filter(validIndexRow)
    .map((row, index) => {
      const ranked = {
        id: indexRowId(row, index),
        title: row.title,
        category: row.category,
        body: typeof row.body === 'string' ? row.body : '',
      };
      const channels = scoreChannels(candidate, ranked);
      return {
        id: ranked.id,
        title: ranked.title,
        category: ranked.category,
        similarity: channels.composite,
        channels,
      };
    })
    .sort((a, b) =>
      b.similarity - a.similarity ||
      a.id.localeCompare(b.id) ||
      String(a.title).localeCompare(String(b.title))
    )
    .slice(0, topK);
}

/**
 * Filter candidates against locally appended rows only. Hydrated metadata has
 * no body and therefore never participates in lexical detection.
 */
function filterIndexedNearDuplicates(candidates, indexState, opts = {}) {
  const input = Array.isArray(candidates) ? candidates : [];
  if (!indexState || !indexState.usable) {
    return { kept: input.slice(), dropped: [], disabled: true };
  }
  const comparisonAccountId = opts.contributorAccountId || '__local_index_owner';
  const localRows = indexState.rows
    .filter((row) => typeof row.body === 'string' && row.body.trim())
    .map((row, index) => ({
      id: row.learning_id || `local-index-${index}`,
      title: row.title,
      body: row.body,
      category: row.category,
      status: row.status || null,
      visibility: row.visibility,
      contributor_account_id: row.contributor_account_id || comparisonAccountId,
    }));
  if (!localRows.length) return { kept: input.slice(), dropped: [], disabled: false };

  try {
    const kept = [];
    const dropped = [];
    for (const candidate of input) {
      const result = findNearDuplicate(candidate, localRows, {
        contributorAccountId: comparisonAccountId,
      });
      if (result.verdict === 'flag') {
        const matchedRow = localRows.find((row) => row.id === result.match.id);
        dropped.push({
          candidate,
          match: {
            ...result.match,
            title: matchedRow ? matchedRow.title : null,
          },
        });
      } else {
        kept.push(candidate);
      }
    }
    return { kept, dropped, disabled: false };
  } catch (error) {
    loud(opts.log, `lexical dedup failed; keeping all extracted candidates: ${error.message}`);
    return { kept: input.slice(), dropped: [], disabled: true };
  }
}

module.exports = {
  DEFAULT_INDEX_PATH,
  HYDRATION_PAGE_SIZE,
  PROMPT_MEMORY_MAX_TOKENS,
  PROMPT_MEMORY_MAX_ROWS,
  MEMORY_INSTRUCTIONS,
  readExtractionIndex,
  appendSubmittedLearning,
  hydrateExtractionIndex,
  loadIndexForExtraction,
  buildPromptMemory,
  estimatePromptTokens,
  inferCategoryHints,
  filterIndexedNearDuplicates,
  rankIndexRowsForCandidate,
  indexRowId,
  localIndexRow,
  hydratedIndexRow,
};
