'use strict';

/**
 * SPEC3-E1 — corpus-relative account vocabulary (review-time signal only).
 *
 * Pure and zero-inference: callers inject the catalog and the static common-dev
 * terms. This module performs no file reads, network calls, writes, mutation,
 * timestamps, randomness, or model calls.
 *
 * IMPORTANT: this module is for contributor review surfaces only. Submission
 * screening must never import or call it.
 */

const DEFAULT_CONFIG = require('../config/account-vocab.json');
const {
  classifySensitivity,
  TECH_ALLOWLIST,
  COMMON_CAPS,
} = require('./content-sensitivity.js');

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
const VOCABULARY_STATUSES = new Set(['pending_review', 'approved', 'rejected']);
const COMPOUND_SEGMENT_SPLIT = /[-_]+/;
const NUMERIC_SEGMENT = /^\d+$/;

/**
 * Is this token an ordinary compound built entirely from known terms?
 *
 * The shape classes (S1 kebab, S2 snake) match any hyphen/underscore-joined
 * token, so ordinary English compounds — `already-vetted`, `race-condition`,
 * `auto-generated`, `7-day` — are structurally indistinguishable from real
 * account identifiers. A flat wordlist can never close that gap: it grows
 * additively while compounds grow combinatorially.
 *
 * Decomposing instead makes the wordlist multiplicative — N known segments
 * cover every compound they can form. A token is excluded only when EVERY
 * segment is known (or purely numeric); one unknown segment keeps the flag,
 * which is what preserves detection of `vandelay-brain`, `acme-widget`, and
 * the rest of the genuine-identifier class.
 *
 * Known cost: a compound whose segments are all ordinary words but whose
 * MEANING is account-internal (`auto-publish`) now passes. That is the
 * intended trade — this signal exists to catch unknown proper nouns and system
 * identifiers, it never hard-blocks, and per-item screens still run.
 *
 * @param {string} term normalized (lowercase) candidate term
 * @param {Set<string>} knownTerms lowercase exclusion vocabulary
 * @returns {boolean}
 */
function isCompoundOfKnownTerms(term, knownTerms) {
  if (typeof term !== 'string' || !term) return false;
  if (!(knownTerms instanceof Set)) return false;
  const segments = term.split(COMPOUND_SEGMENT_SPLIT).filter(Boolean);
  if (segments.length < 2) return false;
  return segments.every((segment) =>
    NUMERIC_SEGMENT.test(segment) || knownTerms.has(segment));
}

function normalizeConfig(config = DEFAULT_CONFIG) {
  const source = config && typeof config === 'object' ? config : DEFAULT_CONFIG;
  const recurrenceMin = Number(source.VOCAB_RECURRENCE_MIN);
  const publicDf = Number(source.VOCAB_PUBLIC_DF);
  const contrastMinAccounts = Number(source.VOCAB_CONTRAST_MIN_ACCOUNTS);
  const contrastMinLearnings = Number(source.VOCAB_CONTRAST_MIN_LEARNINGS);
  const enabled = Array.isArray(source.VOCAB_SHAPES_ENABLED)
    ? source.VOCAB_SHAPES_ENABLED.filter((shape) => SHAPE_CLASSES.includes(shape))
    : [];

  if (!Number.isInteger(recurrenceMin) || recurrenceMin < 2) {
    throw new Error('VOCAB_RECURRENCE_MIN must be an integer >= 2');
  }
  if (!Number.isInteger(publicDf) || publicDf < 1) {
    throw new Error('VOCAB_PUBLIC_DF must be an integer >= 1');
  }
  if (!Number.isInteger(contrastMinAccounts) || contrastMinAccounts < 2) {
    throw new Error('VOCAB_CONTRAST_MIN_ACCOUNTS must be an integer >= 2');
  }
  if (!Number.isInteger(contrastMinLearnings) || contrastMinLearnings < 1) {
    throw new Error('VOCAB_CONTRAST_MIN_LEARNINGS must be an integer >= 1');
  }
  if (enabled.length === 0) throw new Error('VOCAB_SHAPES_ENABLED must enable at least one shape');

  return Object.freeze({
    recurrenceMin,
    publicDf,
    shapesEnabled: Object.freeze([...new Set(enabled)]),
    contrastMinAccounts,
    contrastMinLearnings,
  });
}

function parseCommonDevTerms(raw) {
  return new Set(String(raw || '')
    .split(/\r?\n/)
    .map((line) => line.trim().toLowerCase())
    .filter((line) => line && !line.startsWith('#')));
}

function replaceToken(value, token) {
  if (typeof value !== 'string' || !value) return value;
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return value.replace(new RegExp(`\\b${escaped}\\b`, 'g'), token.toLowerCase());
}

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

function extractCandidateTerms(learning, config = DEFAULT_CONFIG) {
  const normalizedConfig = normalizeConfig(config);
  const enabled = new Set(normalizedConfig.shapesEnabled);
  const text = learningText(learning || {});
  const candidates = new Map();
  const collect = (regex, shape, predicate = () => true) => {
    if (!enabled.has(shape)) return;
    for (const match of text.matchAll(regex)) {
      if (predicate(match[0])) addCandidate(candidates, match[0], shape);
    }
  };

  collect(/(?<![A-Za-z0-9_])[a-z0-9]+(?:-[a-z0-9]+)+(?![A-Za-z0-9_])/g, 'S1');
  collect(/(?<![A-Za-z0-9])[a-z0-9]+(?:_[a-z0-9]+)+(?![A-Za-z0-9])/g, 'S2');
  collect(/\b[A-Za-z][A-Za-z0-9]*[a-z][A-Z][A-Za-z0-9]*\b/g, 'S3');
  collect(/\b[A-Z][A-Z0-9]{1,5}\b/g, 'S4', (token) => !ACRONYM_ALLOWLIST.has(token));
  collect(/(?<![\w-])[\w-]+\.(?:py|js|sh|ts|mjs|cjs|json|yaml|yml)\b/gi, 'S5');
  if (enabled.has('S6')) {
    for (const term of extractUnknownProperTerms(learning || {})) {
      addCandidate(candidates, term.display, 'S6');
    }
  }

  return [...candidates.values()]
    .map((term) => ({ ...term, classes: [...term.classes].sort() }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

function isVocabularyCorpusRow(learning) {
  return !!learning && (
    !learning.status ||
    VOCABULARY_STATUSES.has(learning.status)
  );
}

function isApproved(learning) {
  return !!learning && (!learning.status || learning.status === 'approved');
}

function buildAccountVocabulary(corpus, options = {}) {
  const config = normalizeConfig(options.config);
  const commonDevTerms = options.commonDevTerms instanceof Set
    ? new Set([...options.commonDevTerms].map((term) => String(term).toLowerCase()))
    : new Set(Array.isArray(options.commonDevTerms)
      ? options.commonDevTerms.map((term) => String(term).toLowerCase())
      : []);
  const staticExclusions = new Set([
    ...[...TECH_ALLOWLIST].map((term) => String(term).toLowerCase()),
    ...[...COMMON_CAPS].map((term) => String(term).toLowerCase()),
    ...[...ACRONYM_ALLOWLIST].map((term) => term.toLowerCase()),
    ...commonDevTerms,
  ]);

  const rows = Array.isArray(corpus)
    ? corpus.filter((learning) => isVocabularyCorpusRow(learning))
    : [];
  const itemCandidates = new Map();
  const accountLearningCounts = new Map();
  const termLearningIdsByAccount = new Map();
  const displayByAccountTerm = new Map();
  const classesByAccountTerm = new Map();
  const approvedLearningIdsByTerm = new Map();
  const approvedAccountsByTerm = new Map();

  for (const learning of rows) {
    const candidates = extractCandidateTerms(learning, {
      VOCAB_RECURRENCE_MIN: config.recurrenceMin,
      VOCAB_PUBLIC_DF: config.publicDf,
      VOCAB_SHAPES_ENABLED: config.shapesEnabled,
      VOCAB_CONTRAST_MIN_ACCOUNTS: config.contrastMinAccounts,
      VOCAB_CONTRAST_MIN_LEARNINGS: config.contrastMinLearnings,
    });
    if (learning.id) itemCandidates.set(learning.id, candidates);
    const accountId = typeof learning.contributor_account_id === 'string'
      ? learning.contributor_account_id
      : '';

    if (isApproved(learning)) {
      for (const term of candidates) {
        if (!approvedLearningIdsByTerm.has(term.key)) {
          approvedLearningIdsByTerm.set(term.key, new Set());
          approvedAccountsByTerm.set(term.key, new Set());
        }
        if (learning.id) approvedLearningIdsByTerm.get(term.key).add(learning.id);
        approvedAccountsByTerm.get(term.key).add(accountId);
      }
    }

    if (!accountId) continue;
    accountLearningCounts.set(accountId, (accountLearningCounts.get(accountId) || 0) + 1);
    if (!termLearningIdsByAccount.has(accountId)) termLearningIdsByAccount.set(accountId, new Map());
    const byTerm = termLearningIdsByAccount.get(accountId);
    for (const term of candidates) {
      if (!byTerm.has(term.key)) byTerm.set(term.key, new Set());
      if (learning.id) byTerm.get(term.key).add(learning.id);
      const compoundKey = `${accountId}\0${term.key}`;
      if (!displayByAccountTerm.has(compoundKey)) displayByAccountTerm.set(compoundKey, term.display);
      if (!classesByAccountTerm.has(compoundKey)) classesByAccountTerm.set(compoundKey, new Set());
      for (const shape of term.classes) classesByAccountTerm.get(compoundKey).add(shape);
    }
  }

  const eligibleContrastAccounts = [...accountLearningCounts.entries()]
    .filter(([, count]) => count >= config.contrastMinLearnings)
    .map(([accountId]) => accountId)
    .sort();
  const contrastActive = eligibleContrastAccounts.length >= config.contrastMinAccounts;

  const accountsByRecurringTerm = new Map();
  for (const [accountId, byTerm] of termLearningIdsByAccount) {
    for (const [term, ids] of byTerm) {
      if (ids.size < config.recurrenceMin) continue;
      if (!accountsByRecurringTerm.has(term)) accountsByRecurringTerm.set(term, new Set());
      accountsByRecurringTerm.get(term).add(accountId);
    }
  }
  const contrastSuppressedTerms = new Set();
  if (contrastActive) {
    for (const [term, accounts] of accountsByRecurringTerm) {
      if (accounts.size >= 2) contrastSuppressedTerms.add(term);
    }
  }

  function exclusionReasons(accountId, term) {
    const reasons = [];
    if (staticExclusions.has(term)) reasons.push('static_common_dev');
    else if (isCompoundOfKnownTerms(term, staticExclusions)) {
      reasons.push('static_common_dev_compound');
    }
    const approvedAccounts = approvedAccountsByTerm.get(term) || new Set();
    if (approvedAccounts.has(accountId)) reasons.push('approved_same_account');
    if ([...approvedAccounts].some((approvedAccount) => approvedAccount !== accountId)) {
      reasons.push('approved_other_account');
    }
    const approvedDf = (approvedLearningIdsByTerm.get(term) || new Set()).size;
    if (approvedDf >= config.publicDf) reasons.push(`approved_df_${approvedDf}`);
    if (contrastSuppressedTerms.has(term)) reasons.push('cross_account_contrast');
    return reasons;
  }

  const accountTerms = {};
  const excludedAccountTerms = {};
  for (const accountId of [...termLearningIdsByAccount.keys()].sort()) {
    const surviving = [];
    const excluded = [];
    for (const [term, ids] of termLearningIdsByAccount.get(accountId)) {
      if (ids.size < config.recurrenceMin) continue;
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
      else surviving.push(row);
    }
    const sorter = (a, b) =>
      b.learning_count - a.learning_count ||
      a.normalized.localeCompare(b.normalized);
    accountTerms[accountId] = surviving.sort(sorter);
    excludedAccountTerms[accountId] = excluded.sort(sorter);
  }

  const matchesByLearningId = {};
  for (const learning of rows) {
    if (!learning.id || !learning.contributor_account_id) continue;
    const recurring = new Map((accountTerms[learning.contributor_account_id] || [])
      .map((term) => [term.normalized, term]));
    const matches = (itemCandidates.get(learning.id) || [])
      .filter((term) => recurring.has(term.key))
      .map((term) => ({
        term: term.display.slice(0, 60),
        normalized: term.key,
        classes: recurring.get(term.key).classes,
      }))
      .sort((a, b) => a.normalized.localeCompare(b.normalized));
    if (matches.length > 0) matchesByLearningId[learning.id] = matches;
  }

  return {
    config,
    corpus_count: rows.length,
    account_learning_counts: Object.fromEntries(
      [...accountLearningCounts.entries()].sort((a, b) => a[0].localeCompare(b[0]))),
    contrast_eligible_accounts: eligibleContrastAccounts,
    contrast_active: contrastActive,
    contrast_suppressed_terms: [...contrastSuppressedTerms].sort(),
    account_terms: accountTerms,
    excluded_account_terms: excludedAccountTerms,
    matches_by_learning_id: matchesByLearningId,
  };
}

module.exports = {
  DEFAULT_CONFIG,
  SHAPE_CLASSES,
  SHAPE_LABELS,
  ACRONYM_ALLOWLIST,
  VOCABULARY_STATUSES,
  normalizeConfig,
  parseCommonDevTerms,
  extractUnknownProperTerms,
  extractCandidateTerms,
  isVocabularyCorpusRow,
  isApproved,
  isCompoundOfKnownTerms,
  buildAccountVocabulary,
};
