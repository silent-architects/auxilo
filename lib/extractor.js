/**
 * lib/extractor.js — Learning Extractor Pipeline (Phase 1.2)
 *
 * Processes session transcripts through a multi-stage pipeline:
 *   Input Validation → Chunking → LLM Extraction → Quality Gate →
 *   Sensitivity Check → Dedup → Output Formatting
 *
 * Runtime-agnostic, LLM-agnostic (llmCall injected), stateless.
 * Output: array of structured learning objects ready for POST /learn.
 *
 * @module extractor
 */

'use strict';

const crypto = require('crypto');
const { scanLearning } = require('./sensitivity-filter');

// ─── Error Class ────────────────────────────────────────────────────────────

class ExtractorError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ExtractorError';
    this.code = code;
  }
}

// ─── Config ─────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG = Object.freeze({
  chunk_size: 4000,
  chunk_overlap: 200,
  max_chunks: 50,
  quality_threshold: 14,
  quality_min_dimension: 3,
  dedup_similarity_limit: 5,
  max_learnings: 20,
});

// ─── Constants ──────────────────────────────────────────────────────────────

const VALID_CATEGORIES = [
  'data-processing', 'web-interaction', 'code-execution', 'communication',
  'storage-state', 'content-generation', 'payment-financial', 'monitoring'
];

const VALID_OUTCOMES = ['success', 'partial', 'failure', 'workaround'];

const VALID_TRIGGERS = [
  'problem_solved', 'undocumented_behavior', 'synthesis', 'bug_fix', 'user_request'
];

const VALID_DEDUP_STATUSES = ['checked', 'skipped', 'error'];

const VALID_SOURCE_TYPES = ['conversation', 'memory_file', 'code_review', 'synthesis'];

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * SHA-256 hash of normalized body text.
 * Normalization: lowercase, collapse whitespace, trim.
 */
function hashBody(body) {
  const normalized = body.toLowerCase().replace(/\s+/g, ' ').trim();
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

/**
 * Build the LLM extraction prompt for a transcript chunk.
 * Prompt template from SPEC-P1.2 §4.3.
 */
function buildPrompt(chunkText, sourceType) {
  return `You are a learning extraction system. Analyze the following transcript chunk and identify distinct, reusable learning moments.

EXTRACTION CRITERIA (all 5 must be met):
1. SPECIFIC — Contains concrete details (commands, config values, error messages, version numbers)
2. ACTIONABLE — Another agent could reproduce this approach from the description alone
3. NOVEL — Not common knowledge or basic documentation
4. COMPLETE — Includes both the problem/context AND the solution/insight
5. CLEAN — Free of sensitive data (credentials, PII, internal URLs)

EXTRACTION TRIGGERS (extract when you see):
- problem_solved: A specific technical problem was identified and resolved
- undocumented_behavior: Behavior not covered in official documentation was discovered
- synthesis: Multiple pieces of information were combined into a new insight
- bug_fix: A bug was found and a fix or workaround was applied
- user_request: The user explicitly asked to save or log something as a learning

DO NOT EXTRACT:
- Routine operations with no novel insight
- Incomplete attempts without resolution
- Opinions without supporting evidence
- Information that is basic/common documentation
- Content containing credentials, API keys, or PII
- Duplicate information within the same chunk

VALID CATEGORIES: data-processing, web-interaction, code-execution, communication, storage-state, content-generation, payment-financial, monitoring

VALID OUTCOMES: success, partial, failure, workaround

VALID TRIGGERS: problem_solved, undocumented_behavior, synthesis, bug_fix, user_request

For each learning found, produce a JSON object with these fields:
- title (string, 10-200 chars): Descriptive title
- body (string, 50-50000 chars): The full learning content
- category (string): One of the valid categories above
- tags (array of strings, 1+): Relevant tags
- task_context (string): Description of the task/scenario
- outcome (string): One of the valid outcomes above
- related_skills (array of strings): Optional related skills
- quality_self_assessment (object):
  - specificity (int 1-5)
  - actionability (int 1-5)
  - novelty (int 1-5)
  - completeness (int 1-5)
  - total (int, must equal sum of above 4)
  - extraction_confidence (float 0.0-1.0)
  - reasoning (string): Brief justification for scores
- extraction_context (object):
  - trigger (string): One of the valid triggers above
  - source_type: "${sourceType}"

Return ONLY a JSON array of learning objects. If no learnings are found, return an empty array [].
Do not include any text outside the JSON array.

--- TRANSCRIPT CHUNK ---
${chunkText}
--- END CHUNK ---`;
}

/**
 * Parse LLM response text into a JSON array.
 * Tries direct parse first, then regex extraction as fallback.
 */
function parseResponse(raw) {
  // Direct parse
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
  } catch { /* fallthrough to regex extraction */ }

  // Regex fallback: find first [ and last ]
  try {
    const first = raw.indexOf('[');
    const last = raw.lastIndexOf(']');
    if (first !== -1 && last !== -1 && last > first) {
      const sub = raw.substring(first, last + 1);
      const parsed = JSON.parse(sub);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch { /* parse failed */ }

  return null;
}

// ─── Chunking ───────────────────────────────────────────────────────────────

/**
 * Split transcript into boundary-aware overlapping chunks.
 *
 * Algorithm:
 * 1. Calculate nominal split points at every chunk_size chars
 * 2. For each boundary, search ±200 for paragraph break (\n\n)
 * 3. If none, search for sentence end (. ? !)
 * 4. If none, split at exact position
 * 5. Apply overlap — each chunk (except first) starts overlap chars before its start
 * 6. Cap at max_chunks (throw TRANSCRIPT_TOO_LARGE if exceeded)
 */
function splitChunks(transcript, config) {
  const len = transcript.length;

  // Single-chunk fast path
  if (len <= config.chunk_size) {
    return [{ index: 0, text: transcript, start: 0, end: len }];
  }

  // Calculate nominal split points
  const splitPoints = [];
  for (let pos = config.chunk_size; pos < len; pos += config.chunk_size) {
    splitPoints.push(pos);
  }

  // Adjust each split point to a natural boundary
  const adjustedSplits = [];
  for (const nominal of splitPoints) {
    let best = nominal;

    // Search ±200 chars for paragraph break
    const searchStart = Math.max(0, nominal - 200);
    const searchEnd = Math.min(len, nominal + 200);
    const searchRegion = transcript.substring(searchStart, searchEnd);

    const paraIdx = searchRegion.indexOf('\n\n');
    if (paraIdx !== -1) {
      best = searchStart + paraIdx + 2; // split after \n\n
    } else {
      // Search for sentence end
      let sentEnd = -1;
      for (const sep of ['. ', '? ', '! ']) {
        const idx = searchRegion.indexOf(sep);
        if (idx !== -1 && (sentEnd === -1 || idx < sentEnd)) {
          sentEnd = idx;
        }
      }
      if (sentEnd !== -1) {
        best = searchStart + sentEnd + 2; // split after separator + space
      }
      // else: keep nominal position
    }

    // Avoid duplicates or going backwards
    if (best > 0 && best < len) {
      adjustedSplits.push(best);
    }
  }

  // Deduplicate and sort
  const uniqueSplits = [...new Set(adjustedSplits)].sort((a, b) => a - b);

  // Build chunks with overlap
  const chunks = [];
  let prevEnd = 0;

  for (let i = 0; i <= uniqueSplits.length; i++) {
    const chunkEnd = i < uniqueSplits.length ? uniqueSplits[i] : len;
    let chunkStart = prevEnd;

    // Apply overlap (except for first chunk)
    if (i > 0 && config.chunk_overlap > 0) {
      chunkStart = Math.max(0, chunkStart - config.chunk_overlap);
    }

    const text = transcript.substring(chunkStart, chunkEnd);
    if (text.length > 0) {
      chunks.push({
        index: chunks.length,
        text,
        start: chunkStart,
        end: chunkEnd,
      });
    }

    prevEnd = chunkEnd;
  }

  // Cap check
  if (chunks.length > config.max_chunks) {
    throw new ExtractorError(
      `Transcript produces ${chunks.length} chunks (max ${config.max_chunks}). Reduce transcript size.`,
      'TRANSCRIPT_TOO_LARGE'
    );
  }

  return chunks;
}

// ─── Validation ─────────────────────────────────────────────────────────────

/**
 * Validate a single LLM-extracted learning candidate.
 * Returns { valid: true } or { valid: false, reason: '...' }.
 */
function validateCandidate(obj) {
  if (!obj || typeof obj !== 'object') {
    return { valid: false, reason: 'not an object' };
  }

  // title
  if (typeof obj.title !== 'string' || obj.title.length < 10 || obj.title.length > 200) {
    return { valid: false, reason: 'title must be string 10-200 chars' };
  }

  // body
  if (typeof obj.body !== 'string' || obj.body.length < 50 || obj.body.length > 50000) {
    return { valid: false, reason: 'body must be string 50-50000 chars' };
  }

  // category
  if (!VALID_CATEGORIES.includes(obj.category)) {
    return { valid: false, reason: `invalid category: ${obj.category}` };
  }

  // tags
  if (!Array.isArray(obj.tags) || obj.tags.length < 1 || !obj.tags.every(t => typeof t === 'string' && t.length > 0)) {
    return { valid: false, reason: 'tags must be array with 1+ non-empty strings' };
  }

  // task_context
  if (typeof obj.task_context !== 'string' || obj.task_context.length === 0) {
    return { valid: false, reason: 'task_context must be non-empty string' };
  }

  // outcome
  if (!VALID_OUTCOMES.includes(obj.outcome)) {
    return { valid: false, reason: `invalid outcome: ${obj.outcome}` };
  }

  // quality_self_assessment
  const qa = obj.quality_self_assessment;
  if (!qa || typeof qa !== 'object') {
    return { valid: false, reason: 'quality_self_assessment is required' };
  }
  for (const dim of ['specificity', 'actionability', 'novelty', 'completeness']) {
    if (!Number.isInteger(qa[dim]) || qa[dim] < 1 || qa[dim] > 5) {
      return { valid: false, reason: `quality_self_assessment.${dim} must be integer 1-5` };
    }
  }
  const expectedTotal = qa.specificity + qa.actionability + qa.novelty + qa.completeness;
  if (qa.total !== expectedTotal) {
    return { valid: false, reason: `quality_self_assessment.total (${qa.total}) != sum (${expectedTotal})` };
  }
  if (typeof qa.extraction_confidence !== 'number' || qa.extraction_confidence < 0 || qa.extraction_confidence > 1) {
    return { valid: false, reason: 'extraction_confidence must be number 0.0-1.0' };
  }
  if (typeof qa.reasoning !== 'string' || qa.reasoning.length === 0) {
    return { valid: false, reason: 'quality_self_assessment.reasoning must be non-empty string' };
  }

  // extraction_context
  const ec = obj.extraction_context;
  if (!ec || typeof ec !== 'object') {
    return { valid: false, reason: 'extraction_context is required' };
  }
  if (!VALID_TRIGGERS.includes(ec.trigger)) {
    return { valid: false, reason: `invalid extraction trigger: ${ec.trigger}` };
  }
  if (!VALID_SOURCE_TYPES.includes(ec.source_type)) {
    return { valid: false, reason: `invalid source_type: ${ec.source_type}` };
  }

  // Defaults for optional fields
  if (!obj.related_skills) {
    obj.related_skills = [];
  }

  return { valid: true };
}

// ─── Pipeline Stages ────────────────────────────────────────────────────────

// ── sanitizeLearningBody (P2.1a §5.1.6 / GOV-3 HIGH #6) ────────────────────

/**
 * Allowlisted URL domains for learning bodies.
 * Non-allowlisted URLs are converted to plain text.
 */
const ALLOWED_URL_DOMAINS = [
  'github.com', 'stackoverflow.com', 'developer.mozilla.org',
  'docs.python.org', 'docs.oracle.com', 'docs.microsoft.com',
  'learn.microsoft.com', 'cloud.google.com', 'docs.aws.amazon.com',
  'docs.docker.com', 'kubernetes.io', 'nodejs.org', 'npmjs.com',
  'crates.io', 'pkg.go.dev', 'pypi.org', 'rubygems.org',
];

/** Domain patterns (e.g., docs.* matches docs.anything.com) */
const ALLOWED_URL_DOMAIN_PATTERNS = [
  /^docs\./i,     // docs.*
  /\.dev$/i,      // *.dev
];

/**
 * Check if a URL's domain is in the allowlist.
 * @param {string} url
 * @returns {boolean}
 */
function isUrlAllowed(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (ALLOWED_URL_DOMAINS.some(d => host === d || host.endsWith('.' + d))) return true;
    if (ALLOWED_URL_DOMAIN_PATTERNS.some(p => p.test(host))) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * Sanitize a learning body for safe publication.
 * Per P2.1a §5.1.6 / GOV-3 HIGH #6:
 *   - Strip raw HTML tags from markdown
 *   - Allowlist URLs; non-allowlisted converted to plain text
 *   - Strip markdown image syntax (tracker pixel defense)
 *   - Reject if body contains base64-looking blobs >200 chars
 *
 * @param {string} body - The learning body text
 * @returns {{ clean: boolean, sanitized: string, reason?: string }}
 */
function sanitizeLearningBody(body) {
  if (!body || typeof body !== 'string') {
    return { clean: false, sanitized: '', reason: 'empty_body' };
  }

  let sanitized = body;

  // 1. Strip raw HTML tags
  sanitized = sanitized.replace(/<\/?[a-z][^>]*>/gi, '');

  // 2. Strip markdown image syntax entirely: ![alt](url) or ![alt][ref]
  sanitized = sanitized.replace(/!\[[^\]]*\]\([^)]*\)/g, '');
  sanitized = sanitized.replace(/!\[[^\]]*\]\[[^\]]*\]/g, '');

  // 3. Check for base64-looking blobs >200 chars
  const base64Pattern = /[A-Za-z0-9+/=]{200,}/g;
  if (base64Pattern.test(sanitized)) {
    return { clean: false, sanitized: '', reason: 'base64_blob_detected' };
  }

  // 4. URL allowlist: convert non-allowlisted URLs to plain text
  // Match markdown links [text](url) and bare URLs
  sanitized = sanitized.replace(/\[([^\]]*)\]\(([^)]+)\)/g, (match, text, url) => {
    if (isUrlAllowed(url)) return match;
    return text || '[link removed]';
  });
  // Bare URLs
  sanitized = sanitized.replace(/(https?:\/\/[^\s)]+)/g, (match) => {
    if (isUrlAllowed(match)) return match;
    return '[external link removed]';
  });

  return { clean: true, sanitized };
}

// ── scoreLearning (P2.1a §12.2) ─────────────────────────────────────────────

/**
 * Pure scoring function for a learning candidate.
 * Thin wrapper over the existing quality-gate logic.
 * No LLM call, no I/O.
 *
 * @param {object} learning - Learning object with quality_self_assessment
 * @param {object} [config] - Override thresholds
 * @param {number} [config.quality_threshold] - Total score threshold (default 14)
 * @param {number} [config.quality_min_dimension] - Per-dimension minimum (default 3)
 * @returns {{ total: number, dimensions: {specificity: number, actionability: number, novelty: number, completeness: number}, passed: boolean, failed_reason: null|string, threshold: number, min_dimension: number }}
 */
function scoreLearning(learning, config = {}) {
  const threshold = config.quality_threshold || DEFAULT_CONFIG.quality_threshold;
  const minDim = config.quality_min_dimension || DEFAULT_CONFIG.quality_min_dimension;
  const qa = learning.quality_self_assessment || {};

  const dimensions = {
    specificity: qa.specificity || 0,
    actionability: qa.actionability || 0,
    novelty: qa.novelty || 0,
    completeness: qa.completeness || 0,
  };

  const total = dimensions.specificity + dimensions.actionability + dimensions.novelty + dimensions.completeness;

  let failed_reason = null;
  if (total < threshold) {
    failed_reason = 'below_total';
  } else {
    for (const [name, val] of Object.entries(dimensions)) {
      if (val < minDim) {
        failed_reason = `below_dimension:${name}`;
        break;
      }
    }
  }

  return {
    total,
    dimensions,
    passed: failed_reason === null,
    failed_reason,
    threshold,
    min_dimension: minDim,
  };
}

/**
 * Extract learnings from a single chunk via LLM call.
 */
async function extractFromChunk(chunk, llmCall, sourceType) {
  const prompt = buildPrompt(chunk.text, sourceType);
  const raw = await llmCall(prompt);
  const parsed = parseResponse(raw);
  if (!parsed || !Array.isArray(parsed)) return { candidates: [], error: null };

  const validated = [];
  for (const obj of parsed) {
    const check = validateCandidate(obj);
    if (check.valid) {
      validated.push(obj);
    }
    // Invalid candidates silently dropped
  }
  return { candidates: validated, error: null };
}

/**
 * Filter learnings that meet quality threshold.
 * Threshold: total >= quality_threshold, no dimension below quality_min_dimension.
 */
function qualityGate(learnings, config) {
  return learnings.filter(l => {
    const qa = l.quality_self_assessment;
    if (qa.total < config.quality_threshold) return false;
    if (qa.specificity < config.quality_min_dimension) return false;
    if (qa.actionability < config.quality_min_dimension) return false;
    if (qa.novelty < config.quality_min_dimension) return false;
    if (qa.completeness < config.quality_min_dimension) return false;
    return true;
  });
}

/**
 * Filter learnings that pass sensitivity scan.
 * Fail-closed: any error drops the learning.
 */
function sensitivityCheck(learnings) {
  const clean = [];
  for (const learning of learnings) {
    try {
      const result = scanLearning(learning);
      if (result.clean) {
        clean.push(learning);
      }
      // else: dropped — sensitivity match
    } catch {
      // fail-closed: drop learning on error
    }
  }
  return clean;
}

/**
 * Two-tier deduplication:
 *   Tier 1 (internal): SHA-256 body hash + normalized title|category key
 *   Tier 2 (external): optional searchFn for cross-store dedup
 */
async function dedup(learnings, searchFn, config) {
  const seenHashes = new Set();
  const seenTitleCat = new Set();
  const deduplicated = [];

  for (const learning of learnings) {
    // Tier 1: Internal dedup — body hash
    const bHash = hashBody(learning.body);
    if (seenHashes.has(bHash)) continue;

    // Tier 1: Internal dedup — title+category
    const titleCatKey = (learning.title.toLowerCase().trim() + '|' + learning.category).toLowerCase();
    if (seenTitleCat.has(titleCatKey)) continue;

    seenHashes.add(bHash);
    seenTitleCat.add(titleCatKey);
    learning.body_hash = bHash;

    // Tier 2: External dedup
    if (!searchFn) {
      learning.extraction_context.dedup_check_status = 'skipped';
      learning.extraction_context.dedup_similar_ids = [];
    } else {
      try {
        const results = await searchFn(learning.title, { category: learning.category });
        const top = (results || []).slice(0, config.dedup_similarity_limit);
        const similar = top.filter(r => r.relevance > 100 && r.category === learning.category);
        learning.extraction_context.dedup_check_status = 'checked';
        learning.extraction_context.dedup_similar_ids = similar.map(r => r.id);
      } catch {
        learning.extraction_context.dedup_check_status = 'error';
        learning.extraction_context.dedup_similar_ids = [];
      }
    }

    deduplicated.push(learning);
  }

  return deduplicated;
}

// ─── Main Pipeline ──────────────────────────────────────────────────────────

/**
 * Extract structured learning objects from a session transcript.
 *
 * @param {string} transcript - Raw session transcript (100-500000 chars)
 * @param {object} options
 * @param {function} options.llmCall - async (prompt) => string — LLM invocation function (REQUIRED)
 * @param {function} [options.searchFn] - async (query, opts) => results[] — for external dedup
 * @param {object}   [options.config] - Override DEFAULT_CONFIG values
 * @param {string}   [options.contributor_wallet] - Wallet address to stamp on learnings
 * @returns {Promise<ExtractionResult>} - { success, learnings[], stats, errors[] }
 */
async function extractLearnings(transcript, options = {}) {
  const startTime = Date.now();
  const errors = [];

  // Belt-and-suspenders cost guard: server-side extraction is deprecated and
  // off by default (extraction is client-side via auxilo_contribute). Even if a
  // caller reaches here, do not run the (billable) LLM extraction. The entry
  // points (/extract, /pipeline/upload, OpenClaw daemon) also gate on this flag.
  if (process.env.SERVER_SIDE_EXTRACTION_ENABLED !== 'true') {
    return { learnings: [], errors: ['server-side extraction disabled (client-side now)'], stats: { disabled: true } };
  }

  // ── Stage 1: Input Validation ──────────────────────────────────────────
  if (!options.llmCall || typeof options.llmCall !== 'function') {
    throw new ExtractorError('llmCall function is required', 'MISSING_LLM');
  }
  if (typeof transcript !== 'string') {
    throw new ExtractorError('transcript must be a string', 'INVALID_INPUT');
  }
  const trimmed = transcript.trim();
  if (trimmed.length < 100) {
    throw new ExtractorError('transcript must be at least 100 characters', 'INVALID_INPUT');
  }
  if (trimmed.length > 500000) {
    throw new ExtractorError('transcript must be 500000 characters or less', 'INVALID_INPUT');
  }

  const config = { ...DEFAULT_CONFIG, ...(options.config || {}) };

  const sourceType = options.source_type || 'conversation';
  if (!VALID_SOURCE_TYPES.includes(sourceType)) {
    throw new ExtractorError(
      `Invalid source_type: ${sourceType}. Must be one of: ${VALID_SOURCE_TYPES.join(', ')}`,
      'INVALID_SOURCE_TYPE'
    );
  }

  // ── Stage 2: Chunking ─────────────────────────────────────────────────
  const chunks = splitChunks(trimmed, config);

  // ── Stage 3: LLM Extraction ───────────────────────────────────────────
  let allCandidates = [];
  let chunksFailed = 0;

  for (const chunk of chunks) {
    try {
      const { candidates } = await extractFromChunk(chunk, options.llmCall, sourceType);
      allCandidates = allCandidates.concat(candidates);
    } catch (err) {
      chunksFailed++;
      errors.push({ stage: 'llm_extraction', chunk: chunk.index, message: err.message });
    }
  }

  const rawCandidates = allCandidates.length;

  // ── Stage 4: Quality Gate ─────────────────────────────────────────────
  const afterQuality = qualityGate(allCandidates, config);

  // ── Stage 5: Sensitivity Check ────────────────────────────────────────
  const afterSensitivity = sensitivityCheck(afterQuality);

  // ── Stage 6: Dedup ────────────────────────────────────────────────────
  const afterDedup = await dedup(afterSensitivity, options.searchFn || null, config);

  // ── Stage 7: Output Formatting ────────────────────────────────────────
  // Sort by quality score descending, cap at max_learnings
  afterDedup.sort((a, b) => b.quality_self_assessment.total - a.quality_self_assessment.total);
  const final = afterDedup.slice(0, config.max_learnings);

  // Stamp fields
  for (const learning of final) {
    if (options.contributor_wallet) {
      learning.contributor_wallet = options.contributor_wallet;
    }
    learning.extraction_context.conversation_turns = 0;
    learning.extraction_context.source_type = sourceType;
    if (!learning.extraction_context.dedup_similar_ids) {
      learning.extraction_context.dedup_similar_ids = [];
    }
    if (!learning.body_hash) {
      learning.body_hash = hashBody(learning.body);
    }
    if (!learning.related_skills) {
      learning.related_skills = [];
    }
  }

  const success = chunksFailed < chunks.length || chunks.length === 0;

  return {
    success,
    learnings: final,
    stats: {
      transcript_length: trimmed.length,
      chunks_processed: chunks.length,
      chunks_failed: chunksFailed,
      raw_candidates: rawCandidates,
      passed_quality_gate: afterQuality.length,
      passed_sensitivity: afterSensitivity.length,
      passed_dedup: afterDedup.length,
      final_count: final.length,
      processing_time_ms: Date.now() - startTime,
    },
    errors,
  };
}

// ─── Exports ────────────────────────────────────────────────────────────────

module.exports = {
  extractLearnings,
  sanitizeLearningBody,
  scoreLearning,
  DEFAULT_CONFIG,
  VALID_CATEGORIES,
};

