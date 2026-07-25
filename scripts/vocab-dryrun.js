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
const path = require('node:path');
const {
  classifySensitivity,
  TECH_ALLOWLIST,
  COMMON_CAPS,
} = require(path.join(__dirname, '..', 'lib', 'content-sensitivity.js'));
const {
  screenFlags,
} = require(path.join(__dirname, '..', 'lib', 'self-review.js'));

const DEFAULT_RECURRENCE_MIN = 2;
const DEFAULT_PUBLIC_DF = 3;
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
const SHAPE_CLASSES = Object.freeze(['S1', 'S2', 'S3', 'S4', 'S5', 'S6']);
const SHAPE_LABELS = Object.freeze({
  S1: 'kebab-case',
  S2: 'snake_case',
  S3: 'camel/Pascal',
  S4: 'ALL-CAPS',
  S5: 'filename',
  S6: 'title-case proper noun',
});
const ACRONYM_ALLOWLIST = new Set([
  'HTTP', 'HTTPS', 'JSON', 'API', 'URL', 'URI', 'CI', 'CLI', 'SDK', 'PDF',
  'HTML', 'CSS', 'SQL', 'AWS', 'GCP', 'DNS', 'TLS', 'SSL', 'SSH', 'JWT',
  'UUID', 'XML', 'YAML', 'CSV', 'TSV', 'TCP', 'UDP', 'REST', 'RPC', 'GRPC',
  'CPU', 'GPU', 'RAM', 'DOM', 'UI', 'UX', 'LLM', 'AI', 'OS', 'IP', 'IO',
  'UTF', 'RGB', 'SVG', 'PNG', 'JPG', 'JPEG', 'GIF', 'NPM', 'YARN', 'PNPM',
  'PR',
]);
const COMMON_DEV_TERMS_PATH = path.join(__dirname, '..', 'data', 'common-dev-terms.txt');

function loadCommonDevTerms(file = COMMON_DEV_TERMS_PATH) {
  return new Set(fs.readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim().toLowerCase())
    .filter((line) => line && !line.startsWith('#')));
}

const COMMON_DEV_TERMS = loadCommonDevTerms();
const STATIC_EXCLUSION_TERMS = new Set([
  ...[...TECH_ALLOWLIST].map((term) => String(term).toLowerCase()),
  ...[...COMMON_CAPS].map((term) => String(term).toLowerCase()),
  ...COMMON_DEV_TERMS,
]);

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

function replaceToken(value, token) {
  if (typeof value !== 'string' || !value) return value;
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return value.replace(new RegExp(`\\b${escaped}\\b`, 'g'), token.toLowerCase());
}

/**
 * Enumerate the existing unknown-proper-noun evidence for REV 2.1 class S6.
 * Masking each exposed token lets the classifier reveal the next token without
 * duplicating its title-case tokenizer.
 */
function extractUnknownProperTerms(learning) {
  const working = {
    title: typeof learning.title === 'string' ? learning.title : '',
    body: typeof learning.body === 'string' ? learning.body : '',
    tags: Array.isArray(learning.tags) ? learning.tags.map(String) : [],
  };
  const terms = new Map();

  for (let guard = 0; guard < 200; guard++) {
    const result = classifySensitivity(working.title, working.body, working.tags);
    const evidence = Array.isArray(result.evidence)
      ? result.evidence.find((row) => row && row.signal === 'unknown_proper_noun')
      : null;
    const token = evidence && typeof evidence.excerpt === 'string'
      ? evidence.excerpt.trim()
      : '';
    if (!token) break;

    const key = token.toLowerCase();
    if (terms.has(key)) break;
    terms.set(key, token);
    working.title = replaceToken(working.title, token);
    working.body = replaceToken(working.body, token);
    working.tags = working.tags.map((tag) => replaceToken(tag, token));
  }

  return [...terms.entries()].map(([key, display]) => ({ key, display }));
}

function learningText(learning) {
  return [
    typeof learning.title === 'string' ? learning.title : '',
    typeof learning.body === 'string' ? learning.body : '',
    Array.isArray(learning.tags) ? learning.tags.join(' ') : '',
  ].join('\n');
}

function addCandidate(candidates, display, shape) {
  const normalizedDisplay = String(display || '').trim();
  if (!normalizedDisplay) return;
  const key = normalizedDisplay.toLowerCase();
  if (!candidates.has(key)) {
    candidates.set(key, { key, display: normalizedDisplay, classes: new Set() });
  }
  candidates.get(key).classes.add(shape);
}

/**
 * REV 2.1 zero-inference candidate extraction.
 *
 * A surface form may belong to more than one class. That overlap is preserved
 * so the report can attribute recall and hold-rate contribution to every class.
 */
function extractCandidateTerms(learning) {
  const text = learningText(learning);
  const candidates = new Map();
  const collect = (regex, shape, predicate = () => true) => {
    for (const match of text.matchAll(regex)) {
      if (predicate(match[0])) addCandidate(candidates, match[0], shape);
    }
  };

  collect(/(?<![A-Za-z0-9_])[a-z0-9]+(?:-[a-z0-9]+)+(?![A-Za-z0-9_])/g, 'S1');
  collect(/(?<![A-Za-z0-9])[a-z0-9]+(?:_[a-z0-9]+)+(?![A-Za-z0-9])/g, 'S2');
  collect(/\b[A-Za-z][A-Za-z0-9]*[a-z][A-Z][A-Za-z0-9]*\b/g, 'S3');
  collect(/\b[A-Z][A-Z0-9]{1,5}\b/g, 'S4', (token) => !ACRONYM_ALLOWLIST.has(token));
  collect(/(?<![\w-])[\w-]+\.(?:py|js|sh|ts|mjs|cjs|json|yaml|yml)\b/gi, 'S5');
  for (const term of extractUnknownProperTerms(learning)) {
    addCandidate(candidates, term.display, 'S6');
  }

  return [...candidates.values()]
    .map((term) => ({ ...term, classes: [...term.classes].sort() }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

function isApproved(learning) {
  return !learning.status || learning.status === 'approved';
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
  const accountLearningCounts = new Map();
  const itemCandidates = new Map();
  const termLearningIdsByAccount = new Map();
  const displayByAccountTerm = new Map();
  const classesByAccountTerm = new Map();
  const approvedLearningIdsByTerm = new Map();
  const approvedAccountsByTerm = new Map();
  let rowsWithoutAccount = 0;

  for (const learning of rows) {
    const accountId = learning && typeof learning.contributor_account_id === 'string'
      ? learning.contributor_account_id
      : '';
    const candidates = extractCandidateTerms(learning || {});
    if (learning && learning.id) itemCandidates.set(learning.id, candidates);

    if (isApproved(learning || {})) {
      for (const term of candidates) {
        if (!approvedLearningIdsByTerm.has(term.key)) {
          approvedLearningIdsByTerm.set(term.key, new Set());
          approvedAccountsByTerm.set(term.key, new Set());
        }
        if (learning.id) approvedLearningIdsByTerm.get(term.key).add(learning.id);
        approvedAccountsByTerm.get(term.key).add(accountId);
      }
    }

    if (!accountId) {
      rowsWithoutAccount += 1;
      continue;
    }
    accountLearningCounts.set(accountId, (accountLearningCounts.get(accountId) || 0) + 1);
    if (!termLearningIdsByAccount.has(accountId)) termLearningIdsByAccount.set(accountId, new Map());
    const byTerm = termLearningIdsByAccount.get(accountId);
    for (const term of candidates) {
      if (!byTerm.has(term.key)) byTerm.set(term.key, new Set());
      byTerm.get(term.key).add(learning.id);
      const compoundKey = `${accountId}\0${term.key}`;
      if (!displayByAccountTerm.has(compoundKey)) {
        displayByAccountTerm.set(compoundKey, term.display);
      }
      if (!classesByAccountTerm.has(compoundKey)) {
        classesByAccountTerm.set(compoundKey, new Set());
      }
      for (const shape of term.classes) classesByAccountTerm.get(compoundKey).add(shape);
    }
  }

  function exclusionReasons(accountId, term) {
    const reasons = [];
    if (STATIC_EXCLUSION_TERMS.has(term)) reasons.push('static_common_dev');
    const approvedAccounts = approvedAccountsByTerm.get(term) || new Set();
    if ([...approvedAccounts].some((approvedAccount) => approvedAccount !== accountId)) {
      reasons.push('approved_other_account');
    }
    const approvedDf = (approvedLearningIdsByTerm.get(term) || new Set()).size;
    if (approvedDf >= publicDf) reasons.push(`approved_df_${approvedDf}`);
    return reasons;
  }

  const accountTerms = {};
  const excludedAccountTerms = {};
  for (const accountId of [...termLearningIdsByAccount.keys()].sort()) {
    const terms = [];
    const excluded = [];
    for (const [term, ids] of termLearningIdsByAccount.get(accountId)) {
      if (ids.size < recurrenceMin) continue;
      const compoundKey = `${accountId}\0${term}`;
      const row = {
        term: displayByAccountTerm.get(compoundKey) || term,
        normalized: term,
        classes: [...(classesByAccountTerm.get(compoundKey) || [])].sort(),
        learning_count: ids.size,
        learning_ids: [...ids].sort(),
      };
      const reasons = exclusionReasons(accountId, term);
      if (reasons.length > 0) excluded.push({ ...row, exclusion_reasons: reasons });
      else terms.push(row);
    }
    const sorter = (a, b) =>
      b.learning_count - a.learning_count ||
      a.normalized.localeCompare(b.normalized);
    terms.sort(sorter);
    excluded.sort(sorter);
    accountTerms[accountId] = terms;
    excludedAccountTerms[accountId] = excluded;
  }

  const flaggedItems = [];
  for (const learning of rows) {
    const accountId = learning && learning.contributor_account_id;
    if (!accountId || !learning.id) continue;
    const recurring = new Map((accountTerms[accountId] || [])
      .map((row) => [row.normalized, row]));
    const details = (itemCandidates.get(learning.id) || [])
      .filter((term) => recurring.has(term.key))
      .map((term) => ({
        term: term.display,
        normalized: term.key,
        classes: recurring.get(term.key).classes,
      }))
      .sort((a, b) => a.normalized.localeCompare(b.normalized));
    if (details.length > 0) {
      flaggedItems.push({
        id: learning.id,
        account_id: accountId,
        status: learning.status || '(live)',
        terms: details.map((term) => term.term),
        term_details: details,
        classes: [...new Set(details.flatMap((term) => term.classes))].sort(),
      });
    }
  }
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
      const byTerm = termLearningIdsByAccount.get(matched.contributor_account_id) || new Map();
      for (const term of candidates) {
        const occurrenceCount = (byTerm.get(term.key) || new Set()).size;
        diagnostics.push({
          term: term.display,
          classes: term.classes,
          same_account_learning_count: occurrenceCount,
          exclusion_reasons: occurrenceCount >= recurrenceMin
            ? exclusionReasons(matched.contributor_account_id, term.key)
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
    account_count: accountLearningCounts.size,
    rows_without_account: rowsWithoutAccount,
    recurrence_min: recurrenceMin,
    public_df: publicDf,
    common_dev_term_count: COMMON_DEV_TERMS.size,
    account_learning_counts: Object.fromEntries(
      [...accountLearningCounts.entries()].sort((a, b) => a[0].localeCompare(b[0]))),
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
  console.log(`Accounts: ${result.account_count}; rows without account: ${result.rows_without_account}`);
  console.log(`Recurrence minimum: ${result.recurrence_min}; approved public DF: ${result.public_df}`);
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
  console.log('PHASE 1: BLOCKED pending human review of this report.');
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
  DEFAULT_RECURRENCE_MIN,
  DEFAULT_PUBLIC_DF,
  HOLD_RATE_MAX,
  FIXTURE_RECALL_MIN,
  RUN3_FIXTURES,
  SHAPE_CLASSES,
  SHAPE_LABELS,
  ACRONYM_ALLOWLIST,
  COMMON_DEV_TERMS,
  STATIC_EXCLUSION_TERMS,
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
