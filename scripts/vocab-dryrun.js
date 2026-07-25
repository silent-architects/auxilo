#!/usr/bin/env node
'use strict';

/**
 * SPEC3-E1 Phase 0 — read-only corpus-relative vocabulary dry run.
 *
 * This file intentionally does not wire a signal into submission screening or
 * lib/self-review.js. Phase 0 measures the proposed signal over a snapshot;
 * Tyler's acceptance of that report is the gate for production integration.
 *
 * Usage:
 *   node scripts/vocab-dryrun.js <learnings.json>
 *     [--archive <archived-pending-dump> ...]
 *     [--known-id <id-or-prefix> ...]
 *     [--recurrence-min 2]
 *     [--contrast-min-accounts 10]
 *
 * Inputs are read only. Reports are printed to stdout; this script never writes
 * the corpus, calls the network, or mutates live data.
 */

const fs = require('node:fs');
const path = require('node:path');
const {
  classifySensitivity,
} = require(path.join(__dirname, '..', 'lib', 'content-sensitivity.js'));
const {
  screenFlags,
} = require(path.join(__dirname, '..', 'lib', 'self-review.js'));

const DEFAULT_RECURRENCE_MIN = 2;
const DEFAULT_CONTRAST_MIN_ACCOUNTS = 10;
const MIN_LEARNINGS_FOR_CONTRAST = 5;
const HOLD_RATE_MAX = 0.10;
const FIXTURE_RECALL_MIN = 8;

/**
 * Extract the first complete JSON value from a string. Besides plain JSON,
 * this accepts archived CLI/tool captures shaped as:
 *
 *   http=200
 *   {"account_id":"...","learnings":[...]}pending_count: 27
 *
 * That lets the private authoring-session dump participate in the dry run
 * without copying its contents into the public repository.
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
 * Enumerate the same unknown-proper-noun tokens the existing sensitivity
 * classifier sees, without exporting or duplicating its private allowlist
 * helpers. classifySensitivity exposes the first exact token as evidence
 * (lib/content-sensitivity.js:445-472). Mask it and repeat until none remains.
 *
 * This deliberately preserves the current tokenizer/shape discipline for the
 * Phase 0 measurement. A broader identifier grammar would be an architecture
 * change, not a dry-run implementation detail.
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

function isLiveApproved(learning) {
  return !learning.status || learning.status === 'approved';
}

function rate(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : 0;
}

function analyzeCorpus(corpus, options = {}) {
  const recurrenceMin = Number.isInteger(options.recurrenceMin)
    ? options.recurrenceMin
    : DEFAULT_RECURRENCE_MIN;
  const contrastMinAccounts = Number.isInteger(options.contrastMinAccounts)
    ? options.contrastMinAccounts
    : DEFAULT_CONTRAST_MIN_ACCOUNTS;
  const knownIdPrefixes = Array.isArray(options.knownIdPrefixes)
    ? [...new Set(options.knownIdPrefixes.map(String).filter(Boolean))]
    : [];
  if (recurrenceMin < 2) throw new Error('recurrenceMin must be at least 2');
  if (contrastMinAccounts < 1) throw new Error('contrastMinAccounts must be at least 1');

  const rows = mergeCorpora(Array.isArray(corpus) ? corpus : []);
  const accountLearningCounts = new Map();
  const itemTerms = new Map();
  const termLearningIdsByAccount = new Map();
  const displayByAccountTerm = new Map();
  let rowsWithoutAccount = 0;

  for (const learning of rows) {
    const accountId = learning && typeof learning.contributor_account_id === 'string'
      ? learning.contributor_account_id
      : '';
    if (!accountId) {
      rowsWithoutAccount += 1;
      continue;
    }
    accountLearningCounts.set(accountId, (accountLearningCounts.get(accountId) || 0) + 1);
    const terms = extractUnknownProperTerms(learning);
    itemTerms.set(learning.id, terms);
    if (!termLearningIdsByAccount.has(accountId)) termLearningIdsByAccount.set(accountId, new Map());
    const byTerm = termLearningIdsByAccount.get(accountId);
    for (const term of terms) {
      if (!byTerm.has(term.key)) byTerm.set(term.key, new Set());
      byTerm.get(term.key).add(learning.id);
      displayByAccountTerm.set(`${accountId}\0${term.key}`, term.display);
    }
  }

  const eligibleContrastAccounts = [...accountLearningCounts.entries()]
    .filter(([, count]) => count >= MIN_LEARNINGS_FOR_CONTRAST)
    .map(([accountId]) => accountId)
    .sort();
  const contrastActive = eligibleContrastAccounts.length >= contrastMinAccounts;

  const accountsByRecurringTerm = new Map();
  for (const [accountId, byTerm] of termLearningIdsByAccount) {
    for (const [term, ids] of byTerm) {
      if (ids.size < recurrenceMin) continue;
      if (!accountsByRecurringTerm.has(term)) accountsByRecurringTerm.set(term, new Set());
      accountsByRecurringTerm.get(term).add(accountId);
    }
  }
  const suppressedTerms = new Set();
  if (contrastActive) {
    for (const [term, accountIds] of accountsByRecurringTerm) {
      if (accountIds.size >= 2) suppressedTerms.add(term);
    }
  }

  const accountTerms = {};
  for (const accountId of [...termLearningIdsByAccount.keys()].sort()) {
    const terms = [];
    for (const [term, ids] of termLearningIdsByAccount.get(accountId)) {
      if (ids.size < recurrenceMin || suppressedTerms.has(term)) continue;
      terms.push({
        term: displayByAccountTerm.get(`${accountId}\0${term}`) || term,
        normalized: term,
        learning_count: ids.size,
        learning_ids: [...ids].sort(),
      });
    }
    terms.sort((a, b) =>
      b.learning_count - a.learning_count ||
      a.normalized.localeCompare(b.normalized));
    accountTerms[accountId] = terms;
  }

  const flaggedItems = [];
  for (const learning of rows) {
    const accountId = learning && learning.contributor_account_id;
    if (!accountId || !learning.id) continue;
    const recurring = new Set((accountTerms[accountId] || []).map((row) => row.normalized));
    const terms = (itemTerms.get(learning.id) || [])
      .filter((term) => recurring.has(term.key))
      .map((term) => term.display)
      .sort((a, b) => a.localeCompare(b));
    if (terms.length > 0) {
      flaggedItems.push({
        id: learning.id,
        account_id: accountId,
        status: learning.status || '(live)',
        terms,
      });
    }
  }
  flaggedItems.sort((a, b) => a.id.localeCompare(b.id));
  const flaggedIds = new Set(flaggedItems.map((row) => row.id));

  const cleanApproved = rows.filter((learning) =>
    learning &&
    isLiveApproved(learning) &&
    screenFlags(learning).length === 0);
  const heldCleanApproved = cleanApproved.filter((learning) => flaggedIds.has(learning.id));

  let recallFound = 0;
  let recallFlagged = 0;
  const recallItems = [];
  for (const prefix of knownIdPrefixes) {
    const matches = rows.filter((learning) =>
      learning && typeof learning.id === 'string' && learning.id.startsWith(prefix));
    const found = matches.length === 1;
    const flagged = found && flaggedIds.has(matches[0].id);
    if (found) recallFound += 1;
    if (flagged) recallFlagged += 1;
    recallItems.push({
      prefix,
      matched_id: found ? matches[0].id : null,
      found,
      flagged,
      terms: flagged
        ? flaggedItems.find((row) => row.id === matches[0].id).terms
        : [],
      ambiguous_matches: matches.length > 1 ? matches.length : 0,
    });
  }

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
  const recallRequired = Math.min(FIXTURE_RECALL_MIN, knownIdPrefixes.length);

  return {
    corpus_count: rows.length,
    account_count: accountLearningCounts.size,
    rows_without_account: rowsWithoutAccount,
    recurrence_min: recurrenceMin,
    contrast_min_accounts: contrastMinAccounts,
    contrast_eligible_accounts: eligibleContrastAccounts,
    contrast_active: contrastActive,
    suppressed_cross_account_terms: [...suppressedTerms].sort(),
    account_learning_counts: Object.fromEntries(
      [...accountLearningCounts.entries()].sort((a, b) => a[0].localeCompare(b[0]))),
    account_terms: accountTerms,
    flagged_items: flaggedItems,
    recall,
    recall_items: recallItems,
    hold_rate: holdRate,
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
  console.log('VOCAB DRY RUN (read-only)');
  console.log('=========================');
  console.log(`Sources: ${sources.join(', ')}`);
  console.log(`Unique learnings: ${result.corpus_count}`);
  console.log(`Accounts: ${result.account_count}; rows without account: ${result.rows_without_account}`);
  console.log(`Recurrence minimum: ${result.recurrence_min}`);
  console.log(
    `Cross-account contrast: ${result.contrast_active ? 'ACTIVE' : 'DARK'} ` +
    `(${result.contrast_eligible_accounts.length}/${result.contrast_min_accounts} accounts have >=${MIN_LEARNINGS_FOR_CONTRAST} learnings)`);

  console.log('\nPer-account recurring terms:');
  for (const accountId of Object.keys(result.account_terms).sort()) {
    const terms = result.account_terms[accountId];
    console.log(`  ${accountId}: ${terms.length}`);
    for (const row of terms) {
      console.log(`    ${row.term} — ${row.learning_count} learnings [${row.learning_ids.join(', ')}]`);
    }
  }

  console.log(`\nFlagged items: ${result.flagged_items.length}`);
  for (const row of result.flagged_items) {
    console.log(`  ${row.id} [${row.account_id}; ${row.status}] — ${row.terms.join(', ')}`);
  }

  if (result.recall.expected > 0) {
    console.log(
      `\nHEADLINE recall: ${result.recall.flagged}/${result.recall.expected} ` +
      `(${pct(result.recall.rate)}); fixtures found ${result.recall.found}/${result.recall.expected}`);
    for (const row of result.recall_items) {
      const state = row.flagged ? `FLAGGED (${row.terms.join(', ')})` : row.found ? 'MISSED' : 'NOT FOUND';
      console.log(`  ${row.prefix}: ${state}`);
    }
  } else {
    console.log('\nHEADLINE recall: not measured (no --known-id values supplied)');
  }

  console.log(
    `HEADLINE hold-rate: ${result.hold_rate.flagged}/${result.hold_rate.eligible} ` +
    `historically-clean live/approved learnings (${pct(result.hold_rate.rate)})`);

  if (result.acceptance.recall_pass != null) {
    console.log(
      `ACCEPTANCE: recall ${result.acceptance.recall_pass ? 'PASS' : 'FAIL'} ` +
      `(required >=${result.acceptance.recall_required}/${result.recall.expected}); ` +
      `hold-rate ${result.acceptance.hold_rate_pass ? 'PASS' : 'FAIL'} ` +
      `(required <=${pct(result.acceptance.hold_rate_max)})`);
  } else {
    console.log(
      `ACCEPTANCE: hold-rate ${result.acceptance.hold_rate_pass ? 'PASS' : 'FAIL'} ` +
      `(required <=${pct(result.acceptance.hold_rate_max)}); recall not evaluated`);
  }
  if (!result.acceptance.hold_rate_pass && result.recurrence_min === DEFAULT_RECURRENCE_MIN) {
    console.log('REQUIRED NEXT DRY RUN: repeat with --recurrence-min 3 before changing any other threshold.');
  }
}

function parseArgs(argv) {
  const args = {
    file: null,
    archives: [],
    knownIds: [],
    recurrenceMin: DEFAULT_RECURRENCE_MIN,
    contrastMinAccounts: DEFAULT_CONTRAST_MIN_ACCOUNTS,
  };
  const positional = [];
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--archive') args.archives.push(argv[++i]);
    else if (arg === '--known-id') args.knownIds.push(argv[++i]);
    else if (arg === '--recurrence-min') args.recurrenceMin = Number(argv[++i]);
    else if (arg === '--contrast-min-accounts') args.contrastMinAccounts = Number(argv[++i]);
    else if (arg === '--file') args.file = argv[++i];
    else if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg.startsWith('--')) throw new Error(`unknown flag: ${arg}`);
    else positional.push(arg);
  }
  if (!args.file && positional[0]) args.file = positional[0];
  if (!Number.isInteger(args.recurrenceMin)) throw new Error('--recurrence-min must be an integer');
  if (!Number.isInteger(args.contrastMinAccounts)) throw new Error('--contrast-min-accounts must be an integer');
  return args;
}

function usage() {
  return [
    'Usage: node scripts/vocab-dryrun.js <learnings.json>',
    '  [--archive <archived-dump> ...]',
    '  [--known-id <id-or-prefix> ...]',
    '  [--recurrence-min 2]',
    '  [--contrast-min-accounts 10]',
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
  const result = analyzeCorpus(corpus, {
    recurrenceMin: args.recurrenceMin,
    contrastMinAccounts: args.contrastMinAccounts,
    knownIdPrefixes: args.knownIds,
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
  DEFAULT_CONTRAST_MIN_ACCOUNTS,
  MIN_LEARNINGS_FOR_CONTRAST,
  HOLD_RATE_MAX,
  FIXTURE_RECALL_MIN,
  extractFirstJsonValue,
  rowsFromValue,
  loadCorpusFile,
  mergeCorpora,
  extractUnknownProperTerms,
  analyzeCorpus,
  printReport,
  parseArgs,
  main,
};
