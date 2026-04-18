/**
 * lib/openclaw-adapter.js — OpenClaw Memory Adapter (Phase 1.3)
 *
 * Bridges OpenClaw's agent memory system and Auxilo's learning marketplace.
 * Reads .md memory files from configurable filesystem paths, converts them
 * into transcript format, runs them through the Learning Extractor pipeline
 * (Phase 1.2), and optionally publishes extracted learnings.
 *
 * File-system-based, idempotent (content-hash dedup), resilient (skip failed
 * files, collect errors, never crash), and pipeline-integrated.
 *
 * @module openclaw-adapter
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { extractLearnings } = require('./extractor');

// ─── Error Class ────────────────────────────────────────────────────────────

class AdapterError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'AdapterError';
    this.code = code;
  }
}

// ─── Config ─────────────────────────────────────────────────────────────────

const DEFAULT_ADAPTER_CONFIG = Object.freeze({
  // File discovery
  glob_pattern: '**/*.md',
  max_depth: 2,
  max_file_size: 1_000_000,   // 1MB
  max_files_per_run: 20,
  min_file_size: 50,

  // Processing
  delay_between_files_ms: 2000,
  auto_publish: true,

  // Extraction config overrides (passed to extractLearnings)
  extraction_config: {},

  // State
  state_file: 'data/openclaw-state.jsonl',
});

// ─── AdapterState ───────────────────────────────────────────────────────────

/**
 * JSONL file-based state persistence for tracking processed files.
 *
 * State file is append-only JSONL. On load, entries are read into a Map
 * (last-write-wins for duplicate file paths). Compaction runs when the
 * file exceeds 10 000 lines.
 */
class AdapterState {
  /**
   * @param {string} [filePath] - Path to the JSONL state file
   */
  constructor(filePath) {
    this.filePath = filePath || DEFAULT_ADAPTER_CONFIG.state_file;
    /** @type {Map<string, {hash: string, ts: string, learnings: number}>} */
    this.entries = new Map();
    this._lineCount = 0;
  }

  /**
   * Load state from the JSONL file on disk.
   * Parses line by line, building the internal Map (last write wins).
   * Handles file-not-found gracefully (starts with empty state).
   *
   * @returns {Promise<void>}
   */
  async load() {
    try {
      const raw = await fs.promises.readFile(this.filePath, 'utf-8');
      const lines = raw.split('\n').filter(l => l.trim().length > 0);
      this._lineCount = lines.length;

      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          if (entry.file && entry.hash) {
            this.entries.set(entry.file, {
              hash: entry.hash,
              ts: entry.ts || '',
              learnings: entry.learnings || 0,
            });
          }
        } catch {
          // Skip malformed lines silently
        }
      }
    } catch (err) {
      if (err.code === 'ENOENT') {
        // File does not exist yet — empty state is fine
        this.entries = new Map();
        this._lineCount = 0;
      } else {
        throw err;
      }
    }
  }

  /**
   * Check whether a file (by path + content hash) has already been processed.
   *
   * @param {string} filePath - Absolute path to the file
   * @param {string} contentHash - SHA-256 hex digest of the file content
   * @returns {boolean} true if already processed with the same hash
   */
  isProcessed(filePath, contentHash) {
    const entry = this.entries.get(filePath);
    if (!entry) return false;
    return entry.hash === contentHash;
  }

  /**
   * Mark a file as processed by appending a JSON line to the state file.
   * Ensures the parent directory exists before writing.
   *
   * @param {string} filePath - Absolute path to the processed file
   * @param {string} contentHash - SHA-256 hex digest of the file content
   * @param {number} learningCount - Number of learnings extracted
   * @returns {Promise<void>}
   */
  async markProcessed(filePath, contentHash, learningCount) {
    const record = {
      file: filePath,
      hash: contentHash,
      ts: new Date().toISOString(),
      learnings: learningCount,
    };

    // Update in-memory map
    this.entries.set(filePath, {
      hash: contentHash,
      ts: record.ts,
      learnings: learningCount,
    });

    // Ensure directory exists
    const dir = path.dirname(this.filePath);
    await fs.promises.mkdir(dir, { recursive: true });

    // Append to file
    await fs.promises.appendFile(this.filePath, JSON.stringify(record) + '\n', 'utf-8');
    this._lineCount++;
  }

  /**
   * Compact the state file if it exceeds 10 000 lines.
   * Rewrites with only the latest entry per file path.
   *
   * @returns {Promise<boolean>} true if compaction was performed
   */
  async compact() {
    if (this._lineCount <= 10_000) return false;

    const dir = path.dirname(this.filePath);
    await fs.promises.mkdir(dir, { recursive: true });

    const lines = [];
    for (const [file, entry] of this.entries) {
      lines.push(JSON.stringify({
        file,
        hash: entry.hash,
        ts: entry.ts,
        learnings: entry.learnings,
      }));
    }

    const compacted = lines.join('\n') + '\n';
    const tmpPath = this.filePath + '.tmp';
    await fs.promises.writeFile(tmpPath, compacted, 'utf-8');
    await fs.promises.rename(tmpPath, this.filePath);
    this._lineCount = lines.length;

    return true;
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Compute SHA-256 hex digest of raw file content.
 * @param {string} content - File content
 * @returns {string} hex digest
 */
function contentHash(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Count path depth relative to a base directory.
 * @param {string} filePath - Absolute file path
 * @param {string} basePath - Absolute base directory path
 * @returns {number} depth (0 = directly in basePath)
 */
function relativeDepth(filePath, basePath) {
  const rel = path.relative(basePath, filePath);
  if (!rel || rel === '.') return 0;
  return rel.split(path.sep).length - 1; // subtract the filename itself
}

/**
 * Check whether a file extension matches the configured glob pattern.
 * Supports simple *.ext patterns and **\/*.ext patterns.
 * @param {string} fileName - File name
 * @param {string} pattern - Glob pattern (e.g. '**\/*.md')
 * @returns {boolean}
 */
function matchesPattern(fileName, pattern) {
  // Extract extension from pattern (handles '*.md' and '**/*.md')
  const extMatch = pattern.match(/\*(\.\w+)$/);
  if (extMatch) {
    return path.extname(fileName).toLowerCase() === extMatch[1].toLowerCase();
  }
  // Fallback: default to .md
  return path.extname(fileName).toLowerCase() === '.md';
}

// ─── discoverMemoryFiles ────────────────────────────────────────────────────

/**
 * Scan a directory for .md memory files matching the adapter configuration.
 *
 * Discovers files by recursively reading the directory (up to max_depth),
 * filtering by extension (glob_pattern), and checking file size constraints.
 * Returns metadata for each discovered file, sorted alphabetically.
 *
 * @param {string} memoryPath - Base directory containing .md memory files
 * @param {object} [config] - Override discovery config (glob_pattern, max_depth, max_file_size, min_file_size)
 * @returns {Promise<Array<{path: string, size: number, modified: Date}>>} Discovered file metadata
 * @throws {AdapterError} If memoryPath is invalid (INVALID_PATH)
 */
async function discoverMemoryFiles(memoryPath, config) {
  const cfg = { ...DEFAULT_ADAPTER_CONFIG, ...(config || {}) };

  // Validate memoryPath
  if (!memoryPath || typeof memoryPath !== 'string') {
    throw new AdapterError('memoryPath must be a non-empty string', 'INVALID_PATH');
  }

  const resolvedBase = path.resolve(memoryPath);

  let baseStat;
  try {
    baseStat = await fs.promises.stat(resolvedBase);
  } catch {
    throw new AdapterError(`memoryPath does not exist: ${resolvedBase}`, 'INVALID_PATH');
  }

  if (!baseStat.isDirectory()) {
    throw new AdapterError(`memoryPath is not a directory: ${resolvedBase}`, 'INVALID_PATH');
  }

  // Recursively read directory entries
  let entries;
  try {
    entries = await fs.promises.readdir(resolvedBase, { recursive: true });
  } catch (err) {
    throw new AdapterError(`Failed to read directory: ${err.message}`, 'INVALID_PATH');
  }

  const results = [];

  for (const entry of entries) {
    const fullPath = path.resolve(resolvedBase, entry);

    // Extension / pattern check
    if (!matchesPattern(path.basename(fullPath), cfg.glob_pattern)) {
      continue;
    }

    // Depth check
    const depth = relativeDepth(fullPath, resolvedBase);
    if (depth > cfg.max_depth) {
      continue;
    }

    // Stat for size and modified time
    let fileStat;
    try {
      fileStat = await fs.promises.stat(fullPath);
    } catch {
      continue; // Skip files we cannot stat
    }

    if (!fileStat.isFile()) continue;

    results.push({
      path: fullPath,
      size: fileStat.size,
      modified: fileStat.mtime,
    });
  }

  // Sort alphabetically by path
  results.sort((a, b) => a.path.localeCompare(b.path));

  return results;
}

// ─── processMemoryFile ──────────────────────────────────────────────────────

/**
 * Process a single .md memory file through the learning extraction pipeline.
 *
 * Reads the file, converts it to transcript format, runs it through
 * extractLearnings(), and optionally publishes each extracted learning
 * via the provided publishFn.
 *
 * @param {string} filePath - Absolute path to the .md file
 * @param {string} memoryPath - Base memory directory (used for path traversal check)
 * @param {object} options
 * @param {function} options.llmCall - async (prompt) => string — LLM invocation function (REQUIRED)
 * @param {function} [options.searchFn] - async (query, opts) => results[] — for external dedup
 * @param {function} [options.publishFn] - async (learning) => object — publish function
 * @param {object}   [options.extraction_config] - Override extraction config
 * @param {string}   [options.contributorWallet] - Wallet address to stamp on learnings
 * @param {boolean}  [options.auto_publish=true] - Whether to auto-publish learnings
 * @returns {Promise<object>} FileProcessResult
 * @throws {AdapterError} On path traversal (PATH_TRAVERSAL) or missing llmCall (MISSING_LLM)
 */
async function processMemoryFile(filePath, memoryPath, options = {}) {
  // Validate llmCall
  if (!options.llmCall || typeof options.llmCall !== 'function') {
    throw new AdapterError('llmCall function is required', 'MISSING_LLM');
  }

  // Path traversal check
  const resolvedPath = path.resolve(filePath);
  const resolvedBase = path.resolve(memoryPath);
  if (!resolvedPath.startsWith(resolvedBase + path.sep) && resolvedPath !== resolvedBase) {
    throw new AdapterError('Path traversal detected', 'PATH_TRAVERSAL');
  }

  const errors = [];
  let learningsPublished = 0;
  let learningsFailedPublish = 0;

  // Read file content
  const content = await fs.promises.readFile(resolvedPath, 'utf-8');
  const hash = contentHash(content);
  const fileStat = await fs.promises.stat(resolvedPath);

  // Transform to transcript format
  const transcript = 'User: ' + content + '\n\nAssistant: I have processed this memory file.';

  // Run through extraction pipeline
  const extractionResult = await extractLearnings(transcript, {
    llmCall: options.llmCall,
    searchFn: options.searchFn,
    config: options.extraction_config || {},
    source_type: 'memory_file',
    contributor_wallet: options.contributorWallet,
  });

  // Auto-publish if configured
  const autoPublish = options.auto_publish !== undefined ? options.auto_publish : true;
  const publishResults = [];

  if (autoPublish && options.publishFn && extractionResult.learnings) {
    for (const learning of extractionResult.learnings) {
      try {
        const pubResult = await options.publishFn(learning);
        learningsPublished++;
        publishResults.push({
          learning_title: learning.title,
          published: true,
          learning_id: pubResult && pubResult.id ? pubResult.id : undefined,
        });
      } catch (err) {
        learningsFailedPublish++;
        publishResults.push({
          learning_title: learning.title,
          published: false,
          error: err.message,
        });
        errors.push({
          stage: 'publish',
          learning_title: learning.title,
          message: err.message,
        });
      }
    }
  }

  // Determine status
  let status = 'processed';
  if (extractionResult.learnings && extractionResult.learnings.length > 0 && learningsPublished === 0 && autoPublish) {
    status = 'extracted_not_published';
  }

  return {
    file: resolvedPath,
    file_size: fileStat.size,
    hash,
    status,
    extraction_result: extractionResult,
    learnings_extracted: extractionResult.learnings ? extractionResult.learnings.length : 0,
    learnings_published: learningsPublished,
    learnings_failed_publish: learningsFailedPublish,
    publish_results: publishResults,
    processing_time_ms: extractionResult.stats ? extractionResult.stats.processing_time_ms : 0,
    errors,
  };
}

// ─── processMemoryFiles ─────────────────────────────────────────────────────

/**
 * Discover and process all unprocessed .md memory files in a directory.
 *
 * This is the main batch entry point. It discovers files, checks state for
 * already-processed content, runs each file through the extraction pipeline,
 * publishes learnings if configured, and persists state. Individual file
 * failures are collected in the errors array — this function never throws.
 *
 * @param {object} options
 * @param {string}   options.memoryPath - Base directory containing .md memory files (REQUIRED)
 * @param {function} options.llmCall - async (prompt) => string — LLM invocation function (REQUIRED)
 * @param {function} [options.searchFn] - async (query, opts) => results[] — for external dedup
 * @param {function} [options.publishFn] - async (learning) => object — publish function
 * @param {string}   [options.contributorWallet] - Wallet address to stamp on learnings
 * @param {object}   [options.config] - Override DEFAULT_ADAPTER_CONFIG values
 * @param {string}   [options.statePath] - Path to state file (overrides config.state_file)
 * @returns {Promise<object>} AdapterRunResult — always returns, never throws
 */
async function processMemoryFiles(options = {}) {
  const startTime = Date.now();
  const runTimestamp = new Date().toISOString();

  // Result skeleton — filled progressively
  const result = {
    success: true,
    files_discovered: 0,
    files_skipped_already_processed: 0,
    files_skipped_too_large: 0,
    files_skipped_too_small: 0,
    files_processed: 0,
    files_failed: 0,
    total_learnings_extracted: 0,
    total_learnings_published: 0,
    total_learnings_failed_publish: 0,
    results: [],
    errors: [],
    processing_time_ms: 0,
    run_timestamp: runTimestamp,
  };

  try {
    // ── Validate required options ──────────────────────────────────────
    if (!options.memoryPath || typeof options.memoryPath !== 'string') {
      throw new AdapterError('options.memoryPath is required', 'INVALID_PATH');
    }
    if (!options.llmCall || typeof options.llmCall !== 'function') {
      throw new AdapterError('options.llmCall function is required', 'MISSING_LLM');
    }

    // ── Merge config ───────────────────────────────────────────────────
    const cfg = { ...DEFAULT_ADAPTER_CONFIG, ...(options.config || {}) };

    // ── Initialize state ───────────────────────────────────────────────
    const statePath = options.statePath || cfg.state_file;
    const state = new AdapterState(statePath);
    try {
      await state.load();
    } catch (err) {
      result.errors.push({
        stage: 'state_load',
        message: `Failed to load state: ${err.message}`,
      });
      // Continue with empty state — files will be re-processed (safe due to dedup)
    }

    // ── Discover files ─────────────────────────────────────────────────
    const discovered = await discoverMemoryFiles(options.memoryPath, cfg);
    result.files_discovered = discovered.length;

    // ── Filter by size and state ───────────────────────────────────────
    const toProcess = [];

    for (const fileInfo of discovered) {
      // Size filters
      if (fileInfo.size > cfg.max_file_size) {
        result.files_skipped_too_large++;
        continue;
      }
      if (fileInfo.size < cfg.min_file_size) {
        result.files_skipped_too_small++;
        continue;
      }

      // Read content and compute hash for state check
      let content;
      try {
        content = await fs.promises.readFile(fileInfo.path, 'utf-8');
      } catch (err) {
        result.errors.push({
          stage: 'file_read',
          file: fileInfo.path,
          message: err.message,
        });
        result.files_failed++;
        continue;
      }

      const hash = contentHash(content);

      // State dedup check
      if (state.isProcessed(fileInfo.path, hash)) {
        result.files_skipped_already_processed++;
        continue;
      }

      toProcess.push({ path: fileInfo.path, size: fileInfo.size, hash, content });
    }

    // ── Cap at max_files_per_run ────────────────────────────────────────
    const batch = toProcess.slice(0, cfg.max_files_per_run);

    // ── Process each file ──────────────────────────────────────────────
    for (let i = 0; i < batch.length; i++) {
      const fileEntry = batch[i];

      // Delay between files (skip before first file)
      if (i > 0 && cfg.delay_between_files_ms > 0) {
        await new Promise(resolve => setTimeout(resolve, cfg.delay_between_files_ms));
      }

      try {
        const fileResult = await processMemoryFile(
          fileEntry.path,
          options.memoryPath,
          {
            llmCall: options.llmCall,
            searchFn: options.searchFn,
            publishFn: options.publishFn,
            extraction_config: cfg.extraction_config,
            contributorWallet: options.contributorWallet,
            auto_publish: cfg.auto_publish,
          }
        );

        result.results.push(fileResult);
        result.files_processed++;
        result.total_learnings_extracted += fileResult.learnings_extracted;
        result.total_learnings_published += fileResult.learnings_published;
        result.total_learnings_failed_publish += fileResult.learnings_failed_publish;

        if (fileResult.errors.length > 0) {
          result.errors.push(...fileResult.errors);
        }

        // Mark processed in state
        try {
          await state.markProcessed(fileEntry.path, fileEntry.hash, fileResult.learnings_extracted);
        } catch (err) {
          result.errors.push({
            stage: 'state_write',
            file: fileEntry.path,
            message: `Failed to write state: ${err.message}`,
          });
          // Non-fatal — next run will re-process (safe due to extraction dedup)
        }
      } catch (err) {
        result.files_failed++;
        result.errors.push({
          stage: 'file_processing',
          file: fileEntry.path,
          message: err.message,
        });
      }
    }

    // ── Compact state if needed ────────────────────────────────────────
    try {
      await state.compact();
    } catch (err) {
      result.errors.push({
        stage: 'state_compact',
        message: `Compaction failed: ${err.message}`,
      });
    }
  } catch (err) {
    // Catastrophic error — still return result, never throw
    result.success = false;
    result.errors.push({
      stage: 'adapter_run',
      message: err.message,
      code: err.code || undefined,
    });
  }

  result.processing_time_ms = Date.now() - startTime;
  return result;
}

// ─── Exports ────────────────────────────────────────────────────────────────

module.exports = {
  processMemoryFiles,
  processMemoryFile,
  discoverMemoryFiles,
  AdapterState,
  DEFAULT_ADAPTER_CONFIG,
};
