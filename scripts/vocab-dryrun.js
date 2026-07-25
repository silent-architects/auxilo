#!/usr/bin/env node
'use strict';

/**
 * SPEC3-E1 Phase 0 — read-only corpus-relative vocabulary dry run (REV 2.1).
 *
 * This file intentionally does not wire a signal into submission screening or
 * lib/self-review.js. It reads snapshots, prints a report, and writes nothing.
 *
 * Usage:
 *   node scripts/vocab-dryrun.js <learnings.json>
 *     [--archive <archived-pending-dump> ...]
 *     [--known-id <id-or-prefix> ...]
 *     [--known-miss-id <id-or-prefix> ...]
 *     [--reclassified-out-id <id-or-prefix> ...]
 *     [--run3-fixtures]
 *     [--recurrence-min 2]
 *     [--public-df 3]
 */

const fs = require('node:fs');
const {
  DEFAULT_CONFIG,
  SHAPE_CLASSES,
  SHAPE_LABELS,
  ACRONYM_ALLOWLIST,
  parseCommonDevTerms,
  extractUnknownProperTerms,
  extractCandidateTerms,
  isApproved,
  buildAccountVocabulary,
} = require('../lib/account-vocab.js');
const {
  screenFlags,
} = require('../lib/self-review.js');

const DEFAULT_RECURRENCE_MIN = DEFAULT_CONFIG.VOCAB_RECURRENCE_MIN;
const DEFAULT_PUBLIC_DF = DEFAULT_CONFIG.VOCAB_PUBLIC_DF;
const HOLD_RATE_MAX = 0.10;
const FIXTURE_RECALL_MIN = 7;
const RUN3_FIXTURES = Object.freeze({
  must_flag: Object.freeze([
    'lrn_79420271-6e3c-4da9-85b0-c19aa7888b4d',
    'lrn_3bd59e6a-422f-4561-addc-e12a7dd32d0e',
    'lrn_ed03b3f6-7380-4506-88a5-15422639d41a',
    'lrn_88a9757a-c09a-42ac-9d95-5975a05bf804',
    'lrn_3cf14441-5ab6-4333-b972-e249f514f054',
    'lrn_c50066f6-787a-4c66-994c-3c7ac5c54bac',
    'lrn_e2680863-9b3c-449e-9ab2-98e8564a7a6f',
  ]),
  known_miss: Object.freeze([
    'lrn_55390ea4-63de-41ed-bf61-3543dddac58d',
  ]),
  reclassified_out: Object.freeze([
    'lrn_63248f8e-edf5-4569-a153-e1f05b59a6b1',
  ]),
});
const COMMON_DEV_TERMS_PATH = require('node:path').join(__dirname, '..', 'data', 'common-dev-terms.txt');

function loadCommonDevTerms(file = COMMON_DEV_TERMS_PATH) {
  return parseCommonDevTerms(fs.readFileSync(file, 'utf8'));
}

const COMMON_DEV_TERMS = loadCommonDevTerms();

/**
 * Extract the first complete JSON value from a string. Besides plain JSON,
 * this accepts archived CLI/tool captures shaped as:
 *
 *   http=200
 *   {"account_id":"...","learnings":[...]}pending_count: 27
 */
function extractFirstJsonValue(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) throw new Error('input is empty');
  try {
    return JSON.parse(trimmed);
  } catch {
    // Continue with a balanced JSON scan.
  }

  const objectAt = trimmed.indexOf('{');
  const arrayAt = trimmed.indexOf('[');
  let start = -1;
  if (objectAt >= 0 && arrayAt >= 0) start = Math.min(objectAt, arrayAt);
  else start = Math.max(objectAt, arrayAt);
  if (start < 0) throw new Error('no JSON object or array found');

  const opener = trimmed[start];
  const closer = opener === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === opener) depth += 1;
    else if (ch === closer) {
      depth -= 1;
      if (depth === 0) return JSON.parse(trimmed.slice(start, i + 1));
    }
  }
  throw new Error('unterminated JSON value');
}

function rowsFromValue(value) {
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value.learnings)) return value.learnings;
  throw new Error('input must be a learning array or an object with learnings[]');
}

function loadCorpusFile(file) {
  return rowsFromValue(extractFirstJsonValue(fs.readFileSync(file, 'utf8')));
}

/**
 * Merge snapshots without changing either input. The primary/current snapshot
 * wins on exact-id collisions; archived rows fill records no longer present.
 */
function mergeCorpora(primary, ...archives) {
  const byId = new Map();
  let anonymousIndex = 0;
  for (const rows of [primary, ...archives]) {
    for (const row of Array.isArray(rows) ? rows : []) {
      if (!row || typeof row !== 'object') continue;
      const key = typeof row.id === 'string' && row.id
        ? `id:${row.id}`
        : `anonymous:${anonymousIndex++}`;
      if (!byId.has(key)) byId.set(key, row);
    }
  }
  return [...byId.values()];
}

function rate(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : 0;
}

function analyzeCorpus(corpus, options = {}) {
  const recurrenceMin = Number.isInteger(options.recurrenceMin)
    ? options.recurrenceMin
    : DEFAULT_RECURRENCE_MIN;
  const publicDf = Number.isInteger(options.publicDf)
    ? options.publicDf
    : DEFAULT_PUBLIC_DF;
  const knownIdPrefixes = Array.isArray(options.knownIdPrefixes)
    ? [...new Set(options.knownIdPrefixes.map(String).filter(Boolean))]
    : [];
  const knownMissIdPrefixes = Array.isArray(options.knownMissIdPrefixes)
    ? [...new Set(options.knownMissIdPrefixes.map(String).filter(Boolean))]
    : [];
  const reclassifiedOutIdPrefixes = Array.isArray(options.reclassifiedOutIdPrefixes)
    ? [...new Set(options.reclassifiedOutIdPrefixes.map(String).filter(Boolean))]
    : [];
  if (recurrenceMin < 2) throw new Error('recurrenceMin must be at least 2');
  if (publicDf < 1) throw new Error('publicDf must be at least 1');

  const rows = mergeCorpora(Array.isArray(corpus) ? corpus : []);
  const shapesEnabled = Array.isArray(options.shapesEnabled)
    ? options.shapesEnabled
    : DEFAULT_CONFIG.VOCAB_SHAPES_ENABLED;
  const config = {
    ...DEFAULT_CONFIG,
    VOCAB_RECURRENCE_MIN: recurrenceMin,
    VOCAB_PUBLIC_DF: publicDf,
    VOCAB_SHAPES_ENABLED: shapesEnabled,
  };
  const vocabulary = buildAccountVocabulary(rows, {
    config,
    commonDevTerms: COMMON_DEV_TERMS,
  });
  const accountTerms = vocabulary.account_terms;
  const excludedAccountTerms = vocabulary.excluded_account_terms;
  const itemCandidates = new Map(rows
    .filter((learning) => learning && learning.id)
    .map((learning) => [learning.id, extractCandidateTerms(learning, config)]));
  const recurringByAccount = new Map();
  for (const accountId of new Set([
    ...Object.keys(accountTerms),
    ...Object.keys(excludedAccountTerms),
  ])) {
    recurringByAccount.set(accountId, new Map([
      ...(accountTerms[accountId] || []).map((term) => [term.normalized, term]),
      ...(excludedAccountTerms[accountId] || []).map((term) => [term.normalized, term]),
    ]));
  }
  const flaggedItems = Object.entries(vocabulary.matches_by_learning_id)
    .map(([id, details]) => {
      const learning = rows.find((row) => row && row.id === id);
      return {
        id,
        account_id: learning && learning.contributor_account_id,
        status: (learning && learning.status) || '(live)',
        terms: details.map((term) => term.term),
        term_details: details,
        classes: [...new Set(details.flatMap((term) => term.classes))].sort(),
      };
    });
  flaggedItems.sort((a, b) => a.id.localeCompare(b.id));
  const flaggedById = new Map(flaggedItems.map((row) => [row.id, row]));

  const cleanApproved = rows.filter((learning) =>
    learning &&
    isApproved(learning) &&
    screenFlags(learning).length === 0);
  const heldCleanApproved = cleanApproved.filter((learning) => flaggedById.has(learning.id));

  function evaluateReferenceItem(prefix) {
    const matches = rows.filter((learning) =>
      learning && typeof learning.id === 'string' && learning.id.startsWith(prefix));
    const found = matches.length === 1;
    const matched = found ? matches[0] : null;
    const flagged = found && flaggedById.has(matched.id);

    let missReason = null;
    const diagnostics = [];
    if (!found) {
      missReason = matches.length > 1 ? `ambiguous prefix (${matches.length} matches)` : 'fixture not found';
    } else if (!flagged) {
      const candidates = itemCandidates.get(matched.id) || [];
      const byTerm = recurringByAccount.get(matched.contributor_account_id) || new Map();
      for (const term of candidates) {
        const recurring = byTerm.get(term.key);
        const occurrenceCount = recurring ? recurring.learning_count : 0;
        diagnostics.push({
          term: term.display,
          classes: term.classes,
          same_account_learning_count: occurrenceCount,
          exclusion_reasons: recurring && Array.isArray(recurring.exclusion_reasons)
            ? recurring.exclusion_reasons
            : [],
        });
      }
      if (candidates.length === 0) {
        missReason = 'no REV 2.1 candidates';
      } else if (!diagnostics.some((term) => term.same_account_learning_count >= recurrenceMin)) {
        missReason = 'candidate terms did not meet same-account recurrence';
      } else {
        const excluded = diagnostics.filter((term) =>
          term.same_account_learning_count >= recurrenceMin && term.exclusion_reasons.length > 0);
        missReason = excluded.length > 0
          ? `all recurring candidates excluded: ${excluded.map((term) =>
            `${term.term}(${term.exclusion_reasons.join('+')})`).join(', ')}`
          : 'no surviving recurring candidate';
      }
    }

    return {
      prefix,
      matched_id: matched ? matched.id : null,
      found,
      flagged,
      terms: flagged ? flaggedById.get(matched.id).terms : [],
      classes: flagged ? flaggedById.get(matched.id).classes : [],
      miss_reason: missReason,
      diagnostics,
      ambiguous_matches: matches.length > 1 ? matches.length : 0,
    };
  }

  const recallItems = knownIdPrefixes.map(evaluateReferenceItem);
  const knownMissItems = knownMissIdPrefixes.map(evaluateReferenceItem);
  const reclassifiedOutItems = reclassifiedOutIdPrefixes.map(evaluateReferenceItem);
  const recallFound = recallItems.filter((row) => row.found).length;
  const recallFlagged = recallItems.filter((row) => row.flagged).length;
  const recall = {
    expected: knownIdPrefixes.length,
    found: recallFound,
    flagged: recallFlagged,
    rate: rate(recallFlagged, knownIdPrefixes.length),
  };
  const holdRate = {
    eligible: cleanApproved.length,
    flagged: heldCleanApproved.length,
    rate: rate(heldCleanApproved.length, cleanApproved.length),
  };

  const perShapeClass = {};
  for (const shape of SHAPE_CLASSES) {
    const recallClassFlagged = recallItems.filter((row) =>
      row.flagged && row.classes.includes(shape)).length;
    const holdClassFlagged = heldCleanApproved.filter((learning) =>
      flaggedById.get(learning.id).classes.includes(shape)).length;
    perShapeClass[shape] = {
      label: SHAPE_LABELS[shape],
      recall_flagged: recallClassFlagged,
      recall_expected: knownIdPrefixes.length,
      recall_rate: rate(recallClassFlagged, knownIdPrefixes.length),
      hold_flagged: holdClassFlagged,
      hold_eligible: cleanApproved.length,
      hold_rate: rate(holdClassFlagged, cleanApproved.length),
    };
  }

  const falsePositiveTerms = new Map();
  for (const learning of heldCleanApproved) {
    const flagged = flaggedById.get(learning.id);
    for (const term of flagged.term_details) {
      if (!falsePositiveTerms.has(term.normalized)) {
        falsePositiveTerms.set(term.normalized, {
          term: term.term,
          normalized: term.normalized,
          classes: new Set(),
          learning_ids: new Set(),
        });
      }
      const aggregate = falsePositiveTerms.get(term.normalized);
      for (const shape of term.classes) aggregate.classes.add(shape);
      aggregate.learning_ids.add(learning.id);
    }
  }
  const topFalsePositiveTerms = [...falsePositiveTerms.values()]
    .map((term) => ({
      term: term.term,
      normalized: term.normalized,
      classes: [...term.classes].sort(),
      clean_learning_count: term.learning_ids.size,
      learning_ids: [...term.learning_ids].sort(),
    }))
    .sort((a, b) =>
      b.clean_learning_count - a.clean_learning_count ||
      a.normalized.localeCompare(b.normalized))
    .slice(0, 20);

  const recallRequired = Math.min(FIXTURE_RECALL_MIN, knownIdPrefixes.length);
  return {
    corpus_count: rows.length,
    vocabulary_corpus_count: vocabulary.corpus_count,
    account_count: Object.keys(vocabulary.account_learning_counts).length,
    rows_without_account: rows.filter((learning) =>
      !learning || typeof learning.contributor_account_id !== 'string' ||
      !learning.contributor_account_id).length,
    recurrence_min: recurrenceMin,
    public_df: publicDf,
    shapes_enabled: vocabulary.config.shapesEnabled,
    contrast_active: vocabulary.contrast_active,
    contrast_eligible_accounts: vocabulary.contrast_eligible_accounts,
    common_dev_term_count: COMMON_DEV_TERMS.size,
    account_learning_counts: vocabulary.account_learning_counts,
    account_terms: accountTerms,
    excluded_account_terms: excludedAccountTerms,
    flagged_items: flaggedItems,
    recall,
    recall_items: recallItems,
    known_miss_items: knownMissItems,
    reclassified_out_items: reclassifiedOutItems,
    hold_rate: holdRate,
    per_shape_class: perShapeClass,
    top_false_positive_terms: topFalsePositiveTerms,
    acceptance: {
      recall_required: recallRequired,
      recall_pass: knownIdPrefixes.length === 0
        ? null
        : recallFound === knownIdPrefixes.length && recallFlagged >= recallRequired,
      hold_rate_max: HOLD_RATE_MAX,
      hold_rate_pass: holdRate.rate <= HOLD_RATE_MAX,
    },
  };
}

function pct(value) {
  return `${(value * 100).toFixed(2)}%`;
}

function printReport(result, sources) {
  console.log('VOCAB DRY RUN REV 2.1 (read-only)');
  console.log('=================================');
  console.log(`Sources: ${sources.join(', ')}`);
  console.log(`Unique learnings: ${result.corpus_count}`);
  console.log(`Vocabulary corpus (pending+approved+rejected): ${result.vocabulary_corpus_count}`);
  console.log(`Accounts: ${result.account_count}; rows without account: ${result.rows_without_account}`);
  console.log(`Recurrence minimum: ${result.recurrence_min}; approved public DF: ${result.public_df}`);
  console.log(`Shapes enabled: ${result.shapes_enabled.join(',')}`);
  console.log(
    `Cross-account contrast: ${result.contrast_active ? 'ACTIVE' : 'DARK'} ` +
    `(${result.contrast_eligible_accounts.length}/${DEFAULT_CONFIG.VOCAB_CONTRAST_MIN_ACCOUNTS} eligible accounts)`);
  console.log(`Static common-dev baseline: ${result.common_dev_term_count} terms`);
  console.log(`Surviving account-vocabulary terms: ${
    Object.values(result.account_terms).reduce((sum, terms) => sum + terms.length, 0)}`);
  console.log(`Flagged items: ${result.flagged_items.length}`);

  if (result.recall.expected > 0) {
    console.log(
      `\nHEADLINE recall: ${result.recall.flagged}/${result.recall.expected} ` +
      `(${pct(result.recall.rate)}); fixtures found ${result.recall.found}/${result.recall.expected}`);
    for (const row of result.recall_items) {
      const state = row.flagged
        ? `FLAGGED [${row.classes.join(',')}] (${row.terms.join(', ')})`
        : row.found
          ? `MISSED — ${row.miss_reason}`
          : `NOT FOUND — ${row.miss_reason}`;
      console.log(`  ${row.prefix}: ${state}`);
    }
  } else {
    console.log('\nHEADLINE recall: not measured (no --known-id values supplied)');
  }

  console.log('\nKnown-miss confirmation (excluded from recall):');
  if (result.known_miss_items.length === 0) console.log('  (none supplied)');
  for (const row of result.known_miss_items) {
    const state = !row.found
      ? 'NOT FOUND'
      : row.flagged
        ? `UNEXPECTEDLY FLAGGED (${row.terms.join(', ')})`
        : `CONFIRMED KNOWN MISS — ${row.miss_reason}`;
    console.log(`  ${row.prefix}: ${state}`);
  }

  console.log('\nReclassified-out confirmation (excluded from recall):');
  if (result.reclassified_out_items.length === 0) console.log('  (none supplied)');
  for (const row of result.reclassified_out_items) {
    const state = !row.found
      ? 'NOT FOUND'
      : row.flagged
        ? `FLAGGED BUT OUT OF GROUND TRUTH (${row.terms.join(', ')})`
        : `CONFIRMED OUT — ${row.miss_reason}`;
    console.log(`  ${row.prefix}: ${state}`);
  }

  console.log(
    `HEADLINE hold-rate: ${result.hold_rate.flagged}/${result.hold_rate.eligible} ` +
    `historically-clean live/approved learnings (${pct(result.hold_rate.rate)})`);

  console.log('\nPer-shape-class contribution:');
  for (const shape of SHAPE_CLASSES) {
    const row = result.per_shape_class[shape];
    console.log(
      `  ${shape} ${row.label}: recall ${row.recall_flagged}/${row.recall_expected} ` +
      `(${pct(row.recall_rate)}); hold ${row.hold_flagged}/${row.hold_eligible} ` +
      `(${pct(row.hold_rate)})`);
  }

  console.log('\nTop false-positive terms:');
  if (result.top_false_positive_terms.length === 0) console.log('  (none)');
  for (const row of result.top_false_positive_terms) {
    console.log(
      `  ${row.term} [${row.classes.join(',')}] — ${row.clean_learning_count} clean learnings`);
  }

  if (result.acceptance.recall_pass != null) {
    console.log(
      `\nACCEPTANCE: recall ${result.acceptance.recall_pass ? 'PASS' : 'FAIL'} ` +
      `(required >=${result.acceptance.recall_required}/${result.recall.expected}); ` +
      `hold-rate ${result.acceptance.hold_rate_pass ? 'PASS' : 'FAIL'} ` +
      `(required <=${pct(result.acceptance.hold_rate_max)})`);
  } else {
    console.log(
      `\nACCEPTANCE: hold-rate ${result.acceptance.hold_rate_pass ? 'PASS' : 'FAIL'} ` +
      `(required <=${pct(result.acceptance.hold_rate_max)}); recall not evaluated`);
  }
  console.log('READ-ONLY: report complete; no corpus data changed.');
}

function parseArgs(argv) {
  const args = {
    file: null,
    archives: [],
    knownIds: [],
    knownMissIds: [],
    reclassifiedOutIds: [],
    run3Fixtures: false,
    recurrenceMin: DEFAULT_RECURRENCE_MIN,
    publicDf: DEFAULT_PUBLIC_DF,
  };
  const positional = [];
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--archive') args.archives.push(argv[++i]);
    else if (arg === '--known-id' || arg === '--must-flag-id') args.knownIds.push(argv[++i]);
    else if (arg === '--known-miss-id') args.knownMissIds.push(argv[++i]);
    else if (arg === '--reclassified-out-id') args.reclassifiedOutIds.push(argv[++i]);
    else if (arg === '--run3-fixtures') args.run3Fixtures = true;
    else if (arg === '--recurrence-min') args.recurrenceMin = Number(argv[++i]);
    else if (arg === '--public-df') args.publicDf = Number(argv[++i]);
    else if (arg === '--file') args.file = argv[++i];
    else if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg.startsWith('--')) throw new Error(`unknown flag: ${arg}`);
    else positional.push(arg);
  }
  if (!args.file && positional[0]) args.file = positional[0];
  if (!Number.isInteger(args.recurrenceMin)) throw new Error('--recurrence-min must be an integer');
  if (!Number.isInteger(args.publicDf)) throw new Error('--public-df must be an integer');
  return args;
}

function usage() {
  return [
    'Usage: node scripts/vocab-dryrun.js <learnings.json>',
    '  [--archive <archived-dump> ...]',
    '  [--known-id <id-or-prefix> ...]',
    '  [--known-miss-id <id-or-prefix> ...]',
    '  [--reclassified-out-id <id-or-prefix> ...]',
    '  [--run3-fixtures]',
    '  [--recurrence-min 2]',
    '  [--public-df 3]',
  ].join('\n');
}

function main(argv = process.argv) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(usage());
    return 0;
  }
  if (!args.file) throw new Error(usage());
  const sourcePaths = [args.file, ...args.archives];
  for (const file of sourcePaths) {
    if (!fs.existsSync(file)) throw new Error(`file not found: ${file}`);
  }
  const primary = loadCorpusFile(args.file);
  const archives = args.archives.map(loadCorpusFile);
  const corpus = mergeCorpora(primary, ...archives);
  const knownIdPrefixes = args.run3Fixtures
    ? [...RUN3_FIXTURES.must_flag, ...args.knownIds]
    : args.knownIds;
  const knownMissIdPrefixes = args.run3Fixtures
    ? [...RUN3_FIXTURES.known_miss, ...args.knownMissIds]
    : args.knownMissIds;
  const reclassifiedOutIdPrefixes = args.run3Fixtures
    ? [...RUN3_FIXTURES.reclassified_out, ...args.reclassifiedOutIds]
    : args.reclassifiedOutIds;
  const result = analyzeCorpus(corpus, {
    recurrenceMin: args.recurrenceMin,
    publicDf: args.publicDf,
    knownIdPrefixes,
    knownMissIdPrefixes,
    reclassifiedOutIdPrefixes,
  });
  printReport(result, sourcePaths);

  const acceptanceFailed =
    result.acceptance.hold_rate_pass === false ||
    result.acceptance.recall_pass === false;
  return acceptanceFailed ? 2 : 0;
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv);
  } catch (error) {
    console.error(`vocab-dryrun: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  DEFAULT_CONFIG,
  DEFAULT_RECURRENCE_MIN,
  DEFAULT_PUBLIC_DF,
  HOLD_RATE_MAX,
  FIXTURE_RECALL_MIN,
  RUN3_FIXTURES,
  SHAPE_CLASSES,
  SHAPE_LABELS,
  ACRONYM_ALLOWLIST,
  COMMON_DEV_TERMS,
  extractFirstJsonValue,
  rowsFromValue,
  loadCorpusFile,
  mergeCorpora,
  extractUnknownProperTerms,
  extractCandidateTerms,
  analyzeCorpus,
  printReport,
  parseArgs,
  main,
};
