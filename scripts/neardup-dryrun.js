#!/usr/bin/env node
/**
 * SPEC3-F1 Phase 0 — cross-session near-duplicate dry-run.
 *
 * READ-ONLY. This analyzer loads a corpus snapshot and pinned ground-truth
 * fixtures, runs deterministic lexical detectors, prints the measured gate,
 * and never writes corpus or runtime state.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const {
  similarityScore,
  findNearDuplicate,
  tokenize,
  REJECT_THRESHOLD,
  FLAG_THRESHOLD,
} = require('../lib/similarity');

const DEFAULT_FIXTURE = path.resolve(
  __dirname,
  '../test/fixtures/spec3-f1-phase0-ground-truth.json',
);
const D1_THRESHOLD = FLAG_THRESHOLD;
const D2_THRESHOLD = 0.60;
const D3_THRESHOLD = 0.75;
const D4_THRESHOLD = 0.60;
const COMPOSITE_THRESHOLD = 0.60;
const RECALL_MIN = 0.90;
const FALSE_PAIR_RATE_MAX = 0.02;

function tokenSet(text) {
  return new Set(tokenize(text));
}

function setJaccard(a, b) {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const value of small) {
    if (large.has(value)) intersection++;
  }
  return intersection / (a.size + b.size - intersection);
}

function combinedText(learning) {
  return `${learning.title || ''} ${learning.body || ''}`;
}

function unigramJaccard(a, b) {
  return setJaccard(tokenSet(combinedText(a)), tokenSet(combinedText(b)));
}

function termFrequency(tokens) {
  const counts = new Map();
  for (const token of tokens) counts.set(token, (counts.get(token) || 0) + 1);
  return counts;
}

function tfCosine(a, b) {
  const aTf = termFrequency(tokenize(combinedText(a)));
  const bTf = termFrequency(tokenize(combinedText(b)));
  if (aTf.size === 0 || bTf.size === 0) return 0;

  let aNorm = 0;
  let bNorm = 0;
  for (const value of aTf.values()) aNorm += value * value;
  for (const value of bTf.values()) bNorm += value * value;

  let dot = 0;
  const [small, large] = aTf.size <= bTf.size ? [aTf, bTf] : [bTf, aTf];
  for (const [token, value] of small) dot += value * (large.get(token) || 0);
  return dot / Math.sqrt(aNorm * bNorm);
}

function titleJaccard(a, b) {
  return setJaccard(tokenSet(a.title || ''), tokenSet(b.title || ''));
}

function calibrateCosine(cosine) {
  if (cosine <= 0) return 0;
  if (cosine >= 1) return 1;
  return cosine / (2 - cosine);
}

function scoreChannels(a, b) {
  const d1 = similarityScore(a, b);
  const d2 = unigramJaccard(a, b);
  const d3 = tfCosine(a, b);
  const d4 = titleJaccard(a, b);
  const content = Math.max(d1, d2, calibrateCosine(d3));
  const composite = Math.max(content, (0.75 * content) + (0.25 * d4));
  return { d1, d2, d3, d4, content, composite };
}

function pairKey(aId, bId) {
  return [String(aId), String(bId)].sort().join('\u0000');
}

function makePair(a, b, extra = {}) {
  return {
    key: pairKey(a.id, b.id),
    a,
    b,
    ...extra,
  };
}

function allPairs(records, extraFactory = () => ({})) {
  const sorted = [...records].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const pairs = [];
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      pairs.push(makePair(sorted[i], sorted[j], extraFactory(sorted[i], sorted[j])));
    }
  }
  return pairs;
}

function rowsFromSnapshot(value) {
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value.learnings)) return value.learnings;
  throw new Error('snapshot must be a JSON array or an object with a learnings array');
}

function loadJson(file, label) {
  if (!file || !fs.existsSync(file)) throw new Error(`${label} not found: ${file}`);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

function loadFixture(file) {
  const fixture = loadJson(file, 'fixture');
  if (!fixture || typeof fixture !== 'object' || Array.isArray(fixture)) {
    throw new Error('fixture must be a JSON object');
  }
  const referencedFiles = fixture.clean_approved_files || [];
  if (!Array.isArray(referencedFiles)) {
    throw new Error('fixture clean_approved_files must be an array');
  }

  const cleanApproved = Array.isArray(fixture.clean_approved)
    ? [...fixture.clean_approved]
    : [];
  if (fixture.clean_approved !== undefined && !Array.isArray(fixture.clean_approved)) {
    throw new Error('fixture clean_approved must be an array');
  }
  for (let index = 0; index < referencedFiles.length; index++) {
    const relativeFile = referencedFiles[index];
    if (typeof relativeFile !== 'string' || relativeFile.length === 0) {
      throw new Error(`clean_approved_files[${index}] must be a non-empty path`);
    }
    const referencedPath = path.resolve(path.dirname(file), relativeFile);
    const referenced = loadJson(referencedPath, `clean approved fixture ${relativeFile}`);
    if (!referenced || !Array.isArray(referenced.clean_approved)) {
      throw new Error(
        `clean approved fixture ${relativeFile} must be an object with a clean_approved array`,
      );
    }
    cleanApproved.push(...referenced.clean_approved);
  }
  return { ...fixture, clean_approved: cleanApproved };
}

function assertLearning(record, context) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new Error(`${context} must be a learning object`);
  }
  if (!record.id) throw new Error(`${context} is missing id`);
  if (typeof record.title !== 'string') throw new Error(`${context} is missing title`);
  if (typeof record.body !== 'string') throw new Error(`${context} is missing body`);
  if (typeof record.category !== 'string') throw new Error(`${context} is missing category`);
}

function addFixtureRecord(recordMap, record, context) {
  assertLearning(record, context);
  const prior = recordMap.get(record.id);
  if (prior) {
    for (const field of ['title', 'body', 'category']) {
      if (String(prior[field] || '') !== String(record[field] || '')) {
        throw new Error(`conflicting fixture ${field} for ${record.id}`);
      }
    }
    return prior;
  }
  const pinned = { ...record };
  recordMap.set(pinned.id, pinned);
  return pinned;
}

function prepareFixture(fixture, snapshotRows) {
  if (!fixture || typeof fixture !== 'object' || Array.isArray(fixture)) {
    throw new Error('fixture must be a JSON object');
  }
  if (!Array.isArray(fixture.duplicate_clusters) || fixture.duplicate_clusters.length === 0) {
    throw new Error('fixture duplicate_clusters must be a non-empty array');
  }
  if (!Array.isArray(fixture.clean_approved)) {
    throw new Error('fixture clean_approved must be an array');
  }

  const recordMap = new Map();
  const clusters = fixture.duplicate_clusters.map((cluster, clusterIndex) => {
    if (!cluster || !Array.isArray(cluster.members) || cluster.members.length < 2) {
      throw new Error(`duplicate_clusters[${clusterIndex}] must have at least two members`);
    }
    const id = String(cluster.id || `cluster_${clusterIndex + 1}`);
    const label = String(cluster.label || id);
    const members = cluster.members.map((record, memberIndex) => addFixtureRecord(
      recordMap,
      record,
      `duplicate_clusters[${clusterIndex}].members[${memberIndex}]`,
    ));
    if (new Set(members.map((record) => record.id)).size !== members.length) {
      throw new Error(`duplicate cluster ${id} contains duplicate member IDs`);
    }
    let currentAlgorithmOrientation = null;
    if (cluster.current_algorithm_orientation !== undefined) {
      const orientation = cluster.current_algorithm_orientation;
      if (
        !orientation ||
        typeof orientation !== 'object' ||
        Array.isArray(orientation) ||
        !orientation.candidate_id ||
        !orientation.existing_id
      ) {
        throw new Error(
          `duplicate cluster ${id} current_algorithm_orientation must name candidate_id and existing_id`,
        );
      }
      if (members.length !== 2) {
        throw new Error(
          `duplicate cluster ${id} current_algorithm_orientation is allowed only for two members`,
        );
      }
      if (orientation.candidate_id === orientation.existing_id) {
        throw new Error(
          `duplicate cluster ${id} current_algorithm_orientation IDs must be distinct`,
        );
      }
      const memberIds = new Set(members.map((member) => member.id));
      if (
        !memberIds.has(orientation.candidate_id) ||
        !memberIds.has(orientation.existing_id)
      ) {
        throw new Error(
          `duplicate cluster ${id} current_algorithm_orientation IDs must both be cluster members`,
        );
      }
      currentAlgorithmOrientation = {
        candidateId: orientation.candidate_id,
        existingId: orientation.existing_id,
      };
    }
    return { id, label, members, currentAlgorithmOrientation };
  });

  const cleanApproved = fixture.clean_approved.map((record, index) => addFixtureRecord(
    recordMap,
    record,
    `clean_approved[${index}]`,
  ));
  if (new Set(cleanApproved.map((record) => record.id)).size !== cleanApproved.length) {
    throw new Error('clean_approved contains duplicate member IDs');
  }

  const snapshotById = new Map();
  for (const row of snapshotRows) {
    if (row && row.id && !snapshotById.has(row.id)) snapshotById.set(row.id, row);
  }
  const missing = [];
  const mismatches = [];
  for (const [id, pinned] of recordMap) {
    const current = snapshotById.get(id);
    if (!current) {
      missing.push(id);
      continue;
    }
    for (const field of ['title', 'body', 'category']) {
      if (String(current[field] || '') !== String(pinned[field] || '')) {
        mismatches.push(`${id}.${field}`);
      }
    }
  }
  if (missing.length > 0) {
    throw new Error(`fixture IDs missing from snapshot: ${missing.sort().join(', ')}`);
  }
  if (mismatches.length > 0) {
    throw new Error(`fixture content differs from snapshot: ${mismatches.sort().join(', ')}`);
  }

  const positivePairs = [];
  for (const cluster of clusters) {
    positivePairs.push(...allPairs(cluster.members, () => ({
      clusterId: cluster.id,
      clusterLabel: cluster.label,
      currentAlgorithmOrientation: cluster.currentAlgorithmOrientation,
    })));
  }

  const negativeByKey = new Map();
  for (const pair of allPairs(cleanApproved, () => ({ classes: ['historically_clean'] }))) {
    negativeByKey.set(pair.key, pair);
  }
  const explicitPairs = fixture.same_domain_different_lesson_pairs || [];
  if (!Array.isArray(explicitPairs)) {
    throw new Error('same_domain_different_lesson_pairs must be an array');
  }
  for (let index = 0; index < explicitPairs.length; index++) {
    const ids = explicitPairs[index];
    if (!Array.isArray(ids) || ids.length !== 2 || ids[0] === ids[1]) {
      throw new Error(`same_domain_different_lesson_pairs[${index}] must contain two distinct IDs`);
    }
    const a = recordMap.get(ids[0]);
    const b = recordMap.get(ids[1]);
    if (!a || !b) {
      throw new Error(`same-domain pair references an unpinned fixture ID: ${ids.join(', ')}`);
    }
    const key = pairKey(a.id, b.id);
    const prior = negativeByKey.get(key);
    if (prior) {
      prior.classes = [...new Set([...prior.classes, 'same_domain_different_lesson'])].sort();
    } else {
      negativeByKey.set(key, makePair(a, b, {
        classes: ['same_domain_different_lesson'],
      }));
    }
  }

  const positiveKeys = new Set(positivePairs.map((pair) => pair.key));
  const overlap = [...negativeByKey.keys()].filter((key) => positiveKeys.has(key));
  if (overlap.length > 0) {
    throw new Error(`pairs labeled both positive and negative: ${overlap.join(', ')}`);
  }

  return {
    metadata: fixture.metadata || {},
    clusters,
    cleanApproved,
    records: [...recordMap.values()].sort((a, b) => String(a.id).localeCompare(String(b.id))),
    positivePairs: positivePairs.sort((a, b) => a.key.localeCompare(b.key)),
    negativePairs: [...negativeByKey.values()].sort((a, b) => a.key.localeCompare(b.key)),
    validation: {
      pinned_records: recordMap.size,
      snapshot_records: snapshotRows.length,
      missing: 0,
      content_mismatches: 0,
    },
  };
}

function timestampFor(record) {
  return String(
    record.created_at ||
    record.submitted_at ||
    record.extracted_at ||
    record.reviewed_at ||
    '',
  );
}

function orientPair(pair) {
  if (pair.currentAlgorithmOrientation) {
    const { candidateId, existingId } = pair.currentAlgorithmOrientation;
    const records = new Map([
      [pair.a.id, pair.a],
      [pair.b.id, pair.b],
    ]);
    return {
      existing: records.get(existingId),
      candidate: records.get(candidateId),
    };
  }
  const aOrder = `${timestampFor(pair.a)}\u0000${pair.a.id}`;
  const bOrder = `${timestampFor(pair.b)}\u0000${pair.b.id}`;
  return aOrder.localeCompare(bOrder) <= 0
    ? { existing: pair.a, candidate: pair.b }
    : { existing: pair.b, candidate: pair.a };
}

function isDetectedVerdict(result) {
  return result.verdict === 'flag' || result.verdict === 'reject';
}

function quantile(sorted, proportion) {
  if (sorted.length === 0) return null;
  return sorted[Math.floor((sorted.length - 1) * proportion)];
}

function scoreDistribution(scores) {
  const sorted = [...scores].sort((a, b) => a - b);
  return {
    count: sorted.length,
    min: sorted.length ? sorted[0] : null,
    p25: quantile(sorted, 0.25),
    median: quantile(sorted, 0.50),
    p75: quantile(sorted, 0.75),
    p90: quantile(sorted, 0.90),
    max: sorted.length ? sorted[sorted.length - 1] : null,
    at_or_above_flag: sorted.filter((score) => score >= FLAG_THRESHOLD).length,
    at_or_above_reject: sorted.filter((score) => score >= REJECT_THRESHOLD).length,
  };
}

function diagnoseCurrentAlgorithm(positivePairs) {
  const rows = positivePairs.map((pair) => {
    const { existing, candidate } = orientPair(pair);
    const rawScore = similarityScore(candidate, existing);
    const current = findNearDuplicate(candidate, [existing]);
    const statusFixedExisting = existing.status === 'rejected'
      ? { ...existing, status: 'approved' }
      : existing;
    const categoryFixedExisting = existing.category !== candidate.category
      ? { ...existing, category: candidate.category }
      : existing;
    const fullyFixedExisting = {
      ...existing,
      ...(existing.status === 'rejected' && { status: 'approved' }),
      category: candidate.category,
    };
    const statusFixOnly = findNearDuplicate(candidate, [statusFixedExisting]);
    const categoryFixOnly = findNearDuplicate(candidate, [categoryFixedExisting]);
    const fullScopeFix = findNearDuplicate(candidate, [fullyFixedExisting]);
    return {
      pair,
      existing,
      candidate,
      rawScore,
      rejectedExisting: existing.status === 'rejected',
      categoryMismatch: existing.category !== candidate.category,
      current,
      statusFixOnly,
      categoryFixOnly,
      fullScopeFix,
    };
  });

  const count = (predicate) => rows.filter(predicate).length;
  const currentMiss = (row) => !isDetectedVerdict(row.current);
  const flaggable = (row) => row.rawScore >= FLAG_THRESHOLD;
  const rejected = (row) => row.rejectedExisting;
  const categoryMismatch = (row) => row.categoryMismatch;
  const compared = (result) => result.match !== null;

  return {
    rows,
    distribution: scoreDistribution(rows.map((row) => row.rawScore)),
    scope: {
      total_pairs: rows.length,
      rejected_existing: count(rejected),
      category_mismatch: count(categoryMismatch),
      rejected_and_category_mismatch: count(
        (row) => rejected(row) && categoryMismatch(row),
      ),
      scope_pass: count((row) => !rejected(row) && !categoryMismatch(row)),
      rejected_existing_flaggable_misses: count(
        (row) => rejected(row) && flaggable(row) && currentMiss(row),
      ),
      category_mismatch_flaggable_misses: count(
        (row) => categoryMismatch(row) && flaggable(row) && currentMiss(row),
      ),
      current_compared: count((row) => compared(row.current)),
      status_fix_only_compared: count((row) => compared(row.statusFixOnly)),
      category_fix_only_compared: count((row) => compared(row.categoryFixOnly)),
      full_scope_fix_compared: count((row) => compared(row.fullScopeFix)),
      h1_recovered_comparisons: count(
        (row) =>
          rejected(row) &&
          !categoryMismatch(row) &&
          !compared(row.current) &&
          compared(row.statusFixOnly),
      ),
      h2_recovered_comparisons: count(
        (row) =>
          categoryMismatch(row) &&
          !compared(row.statusFixOnly) &&
          compared(row.fullScopeFix),
      ),
      current_detected: count((row) => isDetectedVerdict(row.current)),
      status_fix_only_detected: count((row) => isDetectedVerdict(row.statusFixOnly)),
      category_fix_only_detected: count((row) => isDetectedVerdict(row.categoryFixOnly)),
      full_scope_fix_detected: count((row) => isDetectedVerdict(row.fullScopeFix)),
    },
  };
}

function scoreAllPairs(pairs) {
  return new Map(pairs.map((pair) => [pair.key, scoreChannels(pair.a, pair.b)]));
}

function buildUnionFind(records) {
  const parent = new Map(records.map((record) => [record.id, record.id]));
  function find(id) {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root);
    let cursor = id;
    while (parent.get(cursor) !== cursor) {
      const next = parent.get(cursor);
      parent.set(cursor, root);
      cursor = next;
    }
    return root;
  }
  function union(a, b) {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA === rootB) return;
    if (String(rootA).localeCompare(String(rootB)) <= 0) parent.set(rootB, rootA);
    else parent.set(rootA, rootB);
  }
  return { find, union };
}

function connectedComponents(records, threshold = COMPOSITE_THRESHOLD) {
  const sorted = [...records].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const unionFind = buildUnionFind(sorted);
  const edges = [];
  for (const pair of allPairs(sorted)) {
    const scores = scoreChannels(pair.a, pair.b);
    if (scores.composite >= threshold) {
      unionFind.union(pair.a.id, pair.b.id);
      edges.push({ a: pair.a.id, b: pair.b.id, score: scores.composite });
    }
  }
  const grouped = new Map();
  for (const record of sorted) {
    const root = unionFind.find(record.id);
    if (!grouped.has(root)) grouped.set(root, []);
    grouped.get(root).push(record.id);
  }
  const components = [...grouped.values()]
    .map((ids) => ids.sort())
    .filter((ids) => ids.length >= 2)
    .sort((a, b) => a[0].localeCompare(b[0]));
  const componentById = new Map();
  components.forEach((ids, index) => {
    for (const id of ids) componentById.set(id, index);
  });
  return {
    edges: edges.sort((a, b) => pairKey(a.a, a.b).localeCompare(pairKey(b.a, b.b))),
    components,
    componentById,
  };
}

function evaluateDetector(name, threshold, positivePairs, negativePairs, scoreMap, detected) {
  const assess = (pair) => {
    const scores = scoreMap.get(pair.key) || scoreChannels(pair.a, pair.b);
    return {
      pair,
      scores,
      score: name === 'D1' ? scores.d1
        : name === 'D2' ? scores.d2
          : name === 'D3' ? scores.d3
            : name === 'D4' ? scores.d4
              : scores.composite,
      detected: detected(pair, scores),
    };
  };
  const positives = positivePairs.map(assess);
  const negatives = negativePairs.map(assess);
  const hits = positives.filter((row) => row.detected);
  const misses = positives.filter((row) => !row.detected);
  const falsePairs = negatives.filter((row) => row.detected);
  const classMetrics = {};
  for (const className of ['historically_clean', 'same_domain_different_lesson']) {
    const rows = negatives.filter((row) => row.pair.classes.includes(className));
    const falseRows = rows.filter((row) => row.detected);
    classMetrics[className] = {
      pairs: rows.length,
      false_pairs: falseRows.length,
      false_pair_rate: rows.length ? falseRows.length / rows.length : 0,
    };
  }
  return {
    name,
    threshold,
    positive_pairs: positives.length,
    hits: hits.length,
    recall: positives.length ? hits.length / positives.length : 0,
    negative_pairs: negatives.length,
    false_pairs: falsePairs.length,
    false_pair_rate: negatives.length ? falsePairs.length / negatives.length : 0,
    class_metrics: classMetrics,
    misses,
    falsePairRows: falsePairs,
    positiveRows: positives,
  };
}

function perClusterMetrics(clusters, detectorResults) {
  return clusters.map((cluster) => {
    const detectorMetrics = {};
    for (const detector of detectorResults) {
      const rows = detector.positiveRows.filter(
        (row) => row.pair.clusterId === cluster.id,
      );
      const hits = rows.filter((row) => row.detected).length;
      detectorMetrics[detector.name] = {
        pairs: rows.length,
        hits,
        misses: rows.length - hits,
        recall: rows.length ? hits / rows.length : 0,
      };
    }
    return {
      id: cluster.id,
      label: cluster.label,
      members: cluster.members.map((member) => member.id).sort(),
      detectors: detectorMetrics,
    };
  });
}

function analyzeFixture(prepared) {
  const allGatePairs = [...prepared.positivePairs, ...prepared.negativePairs];
  const scoreMap = scoreAllPairs(allGatePairs);
  const components = connectedComponents(prepared.records, COMPOSITE_THRESHOLD);
  const direct = [
    {
      name: 'D1',
      threshold: D1_THRESHOLD,
      detect: (_pair, scores) => scores.d1 >= D1_THRESHOLD,
    },
    {
      name: 'D2',
      threshold: D2_THRESHOLD,
      detect: (_pair, scores) => scores.d2 >= D2_THRESHOLD,
    },
    {
      name: 'D3',
      threshold: D3_THRESHOLD,
      detect: (_pair, scores) => scores.d3 >= D3_THRESHOLD,
    },
    {
      name: 'D4',
      threshold: D4_THRESHOLD,
      detect: (_pair, scores) => scores.d4 >= D4_THRESHOLD,
    },
    {
      name: 'Composite',
      threshold: COMPOSITE_THRESHOLD,
      detect: (_pair, scores) => scores.composite >= COMPOSITE_THRESHOLD,
    },
  ].map((definition) => evaluateDetector(
    definition.name,
    definition.threshold,
    prepared.positivePairs,
    prepared.negativePairs,
    scoreMap,
    definition.detect,
  ));

  const d5 = evaluateDetector(
    'D5',
    COMPOSITE_THRESHOLD,
    prepared.positivePairs,
    prepared.negativePairs,
    scoreMap,
    (pair) => {
      const aComponent = components.componentById.get(pair.a.id);
      const bComponent = components.componentById.get(pair.b.id);
      return aComponent !== undefined && aComponent === bComponent;
    },
  );
  const detectors = [...direct, d5];
  const composite = detectors.find((detector) => detector.name === 'Composite');
  const d1 = detectors.find((detector) => detector.name === 'D1');
  const stage1 = diagnoseCurrentAlgorithm(prepared.positivePairs);
  const acceptance = {
    recall_min: RECALL_MIN,
    false_pair_rate_max: FALSE_PAIR_RATE_MAX,
    recall_pass: composite.recall >= RECALL_MIN,
    false_pair_rate_pass: composite.false_pair_rate <= FALSE_PAIR_RATE_MAX,
  };
  acceptance.pass = acceptance.recall_pass && acceptance.false_pair_rate_pass;

  const h1 = {
    verdict: stage1.scope.h1_recovered_comparisons > 0 ? 'CONFIRMED' : 'NOT CONFIRMED',
    tested_pairs: stage1.scope.rejected_existing,
    recovered_comparisons: stage1.scope.h1_recovered_comparisons,
  };
  const h2 = {
    verdict: stage1.scope.h2_recovered_comparisons > 0 ? 'CONFIRMED' : 'NOT CONFIRMED',
    tested_pairs: stage1.scope.category_mismatch,
    overlap_with_rejected: stage1.scope.rejected_and_category_mismatch,
    recovered_comparisons: stage1.scope.h2_recovered_comparisons,
  };
  const h3 = {
    verdict: d1.recall < RECALL_MIN ? 'CONFIRMED' : 'NOT CONFIRMED',
    d1_hits: d1.hits,
    positive_pairs: d1.positive_pairs,
    d1_recall: d1.recall,
  };

  return {
    stage1,
    hypotheses: { h1, h2, h3 },
    detectors,
    perCluster: perClusterMetrics(prepared.clusters, detectors),
    components,
    acceptance,
    counts: {
      fixture_records: prepared.records.length,
      duplicate_clusters: prepared.clusters.length,
      positive_pairs: prepared.positivePairs.length,
      clean_approved_records: prepared.cleanApproved.length,
      negative_pairs: prepared.negativePairs.length,
    },
    validation: prepared.validation,
  };
}

function scanPendingCorpus(snapshotRows) {
  const corpus = snapshotRows
    .filter((row) => row && row.id)
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const pending = corpus.filter((row) => row.status === 'pending_review');
  let comparisons = 0;
  const candidates = pending.map((candidate) => {
    let best = null;
    for (const existing of corpus) {
      if (existing.id === candidate.id) continue;
      const score = scoreChannels(candidate, existing).composite;
      comparisons++;
      if (
        !best ||
        score > best.score ||
        (score === best.score && String(existing.id).localeCompare(String(best.id)) < 0)
      ) {
        best = { id: existing.id, score };
      }
    }
    return {
      id: candidate.id,
      best,
      flagged: Boolean(best && best.score >= COMPOSITE_THRESHOLD),
    };
  });
  return {
    pending_count: pending.length,
    corpus_count: corpus.length,
    comparisons,
    flagged_candidates: candidates.filter((candidate) => candidate.flagged).length,
    candidates,
  };
}

function pct(value) {
  return `${(value * 100).toFixed(2)}%`;
}

function fixed(value) {
  return value === null || value === undefined ? 'n/a' : value.toFixed(4);
}

function pairLabel(row) {
  const { pair, scores } = row;
  return `${pair.a.id} "${pair.a.title}" <-> ${pair.b.id} "${pair.b.title}" ` +
    `[score=${fixed(row.score)} d1=${fixed(scores.d1)} d2=${fixed(scores.d2)} ` +
    `d3=${fixed(scores.d3)} d4=${fixed(scores.d4)} composite=${fixed(scores.composite)}]`;
}

function printReport(result, context, emit = console.log) {
  emit('SPEC3-F1 PHASE 0 — CROSS-SESSION NEAR-DUPLICATE DRY RUN');
  emit(`Snapshot: ${context.snapshotPath}`);
  emit(`Fixture: ${context.fixturePath}`);
  emit('READ-ONLY: no corpus, screening, lane, or earnings state can be changed.');
  emit('');
  emit('Pinned fixture validation');
  emit(
    `  ${result.validation.pinned_records} records matched by id/title/body/category ` +
    `against ${result.validation.snapshot_records} snapshot records; ` +
    `${result.validation.missing} missing; ${result.validation.content_mismatches} mismatched.`,
  );
  emit(
    `  ${result.counts.duplicate_clusters} duplicate clusters; ` +
    `${result.counts.positive_pairs} positive pairs; ` +
    `${result.counts.clean_approved_records} historically-clean records; ` +
    `${result.counts.negative_pairs} unique negative pairs.`,
  );
  emit('');
  emit('Stage 1 — imported current algorithm');
  emit(
    `  Production thresholds: FLAG=${fixed(FLAG_THRESHOLD)} REJECT=${fixed(REJECT_THRESHOLD)}`,
  );
  const distribution = result.stage1.distribution;
  emit(
    `  Raw current-score distribution n=${distribution.count}: ` +
    `min=${fixed(distribution.min)} p25=${fixed(distribution.p25)} ` +
    `median=${fixed(distribution.median)} p75=${fixed(distribution.p75)} ` +
    `p90=${fixed(distribution.p90)} max=${fixed(distribution.max)}; ` +
    `>=FLAG ${distribution.at_or_above_flag}; >=REJECT ${distribution.at_or_above_reject}.`,
  );
  const scope = result.stage1.scope;
  emit(
    `  Scope counts: rejected-existing=${scope.rejected_existing}; ` +
    `category-mismatch=${scope.category_mismatch}; overlap=${scope.rejected_and_category_mismatch}; ` +
    `scope-pass=${scope.scope_pass}.`,
  );
  emit(
    `  Scan reach (match non-null): current=${scope.current_compared}/${scope.total_pairs}; ` +
    `status-fix-only=${scope.status_fix_only_compared}; ` +
    `category-fix-only=${scope.category_fix_only_compared}; ` +
    `both-scope-fixes=${scope.full_scope_fix_compared}.`,
  );
  emit(
    `  Threshold detections (score >=FLAG): current=${scope.current_detected}/${scope.total_pairs}; ` +
    `status-fix-only=${scope.status_fix_only_detected}; ` +
    `category-fix-only=${scope.category_fix_only_detected}; ` +
    `both-scope-fixes=${scope.full_scope_fix_detected}.`,
  );
  emit('');
  emit('H1–H3 verdicts');
  emit(
    `  H1 ${result.hypotheses.h1.verdict}: ` +
    `${result.hypotheses.h1.tested_pairs} pairs had a rejected existing item; ` +
    `${result.hypotheses.h1.recovered_comparisons} same-category comparisons changed ` +
    `from match=null to match present when only rejected status was made non-rejected.`,
  );
  emit(
    `  H2 ${result.hypotheses.h2.verdict}: ` +
    `${result.hypotheses.h2.tested_pairs} pairs crossed categories; ` +
    `${result.hypotheses.h2.overlap_with_rejected} also had a rejected existing item; ` +
    `${result.hypotheses.h2.recovered_comparisons} comparisons changed from match=null ` +
    `after status fix to match present when category was additionally aligned.`,
  );
  emit(
    `  H3 ${result.hypotheses.h3.verdict}: D1 current-shingle recall ` +
    `${result.hypotheses.h3.d1_hits}/${result.hypotheses.h3.positive_pairs} ` +
    `(${pct(result.hypotheses.h3.d1_recall)}), confirmation boundary <${pct(RECALL_MIN)}.`,
  );
  emit('');
  emit('Stage 2 — detector results');
  emit('  Detector   Threshold   Hits/Positive   Recall    False/Negative   False-pair rate');
  for (const detector of result.detectors) {
    emit(
      `  ${detector.name.padEnd(10)} ${fixed(detector.threshold).padEnd(11)} ` +
      `${`${detector.hits}/${detector.positive_pairs}`.padEnd(15)} ` +
      `${pct(detector.recall).padEnd(9)} ` +
      `${`${detector.false_pairs}/${detector.negative_pairs}`.padEnd(16)} ` +
      `${pct(detector.false_pair_rate)}`,
    );
    const clean = detector.class_metrics.historically_clean;
    const sameDomain = detector.class_metrics.same_domain_different_lesson;
    emit(
      `    classes: historically-clean ${clean.false_pairs}/${clean.pairs} ` +
      `(${pct(clean.false_pair_rate)}); same-domain-different-lesson ` +
      `${sameDomain.false_pairs}/${sameDomain.pairs} (${pct(sameDomain.false_pair_rate)}).`,
    );
  }
  emit('');
  emit('Per-cluster hits/misses');
  for (const cluster of result.perCluster) {
    emit(`  ${cluster.id} — ${cluster.label} (${cluster.members.length} members)`);
    for (const detector of result.detectors) {
      const metrics = cluster.detectors[detector.name];
      emit(
        `    ${detector.name}: ${metrics.hits}/${metrics.pairs} hits, ` +
        `${metrics.misses} misses (${pct(metrics.recall)})`,
      );
    }
  }
  emit('');
  emit(
    `D5 near_dup_clusters surface: ${result.components.components.length} connected ` +
    `component(s), ${result.components.edges.length} direct composite flag edge(s).`,
  );
  result.components.components.forEach((ids, index) => {
    emit(`  cluster ${index + 1}: ${ids.join(', ')}`);
  });
  emit('');
  emit('Every missed positive pair and false negative-class pair');
  for (const detector of result.detectors) {
    emit(`  ${detector.name} misses (${detector.misses.length}):`);
    if (detector.misses.length === 0) emit('    (none)');
    for (const row of detector.misses) emit(`    ${pairLabel(row)}`);
    emit(`  ${detector.name} false pairs (${detector.falsePairRows.length}):`);
    if (detector.falsePairRows.length === 0) emit('    (none)');
    for (const row of detector.falsePairRows) {
      emit(`    ${pairLabel(row)} classes=${row.pair.classes.join(',')}`);
    }
  }
  emit('');
  emit('Top composite false pairs by score');
  const composite = result.detectors.find((detector) => detector.name === 'Composite');
  const topFalse = [...composite.falsePairRows]
    .sort((a, b) => b.score - a.score || a.pair.key.localeCompare(b.pair.key))
    .slice(0, 10);
  if (topFalse.length === 0) emit('  (none)');
  for (const row of topFalse) emit(`  ${pairLabel(row)}`);
  emit('');
  emit('Full pending_review × corpus performance');
  emit(
    `  ${result.performance.pending_count} pending × ${result.performance.corpus_count} corpus; ` +
    `${result.performance.comparisons} comparisons; ` +
    `${result.performance.wall_time_ms.toFixed(3)} ms wall-time; ` +
    `${result.performance.flagged_candidates} pending candidate(s) flagged.`,
  );
  emit('');
  emit(
    `ACCEPTANCE: recall ${result.acceptance.recall_pass ? 'PASS' : 'FAIL'} ` +
    `(${pct(composite.recall)} required >=${pct(result.acceptance.recall_min)}); ` +
    `false-pair rate ${result.acceptance.false_pair_rate_pass ? 'PASS' : 'FAIL'} ` +
    `(${pct(composite.false_pair_rate)} required <=${pct(result.acceptance.false_pair_rate_max)}).`,
  );
  emit(
    result.acceptance.pass
      ? 'GATE VERDICT: PASS. Phase 1 remains blocked for PM review.'
      : 'GATE VERDICT: FAIL — STOP. Phase 1 remains blocked for human/PM review.',
  );
  emit('READ-ONLY: report complete; no corpus data changed.');
}

function parseArgs(argv) {
  const args = { snapshot: null, fixture: DEFAULT_FIXTURE, help: false };
  const positional = [];
  for (let index = 2; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--snapshot') {
      if (!argv[index + 1]) throw new Error('--snapshot requires a path');
      args.snapshot = argv[++index];
    } else if (arg === '--fixture') {
      if (!argv[index + 1]) throw new Error('--fixture requires a path');
      args.fixture = argv[++index];
    } else if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg.startsWith('--')) {
      throw new Error(`unknown flag: ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  if (positional.length > 1) throw new Error('only one positional snapshot path is allowed');
  if (args.snapshot && positional.length === 1) {
    throw new Error('provide the snapshot as either positional or --snapshot, not both');
  }
  if (!args.snapshot && positional.length === 1) args.snapshot = positional[0];
  return args;
}

function usage() {
  return [
    'Usage: node scripts/neardup-dryrun.js <snapshot.json>',
    '       node scripts/neardup-dryrun.js --snapshot <snapshot.json>',
    '  [--fixture <ground-truth.json>]',
    '',
    'Exit 0: gate pass/help; exit 2: measured gate failure; exit 1: input/runtime error.',
  ].join('\n');
}

function main(argv = process.argv, emit = console.log) {
  const args = parseArgs(argv);
  if (args.help) {
    emit(usage());
    return 0;
  }
  if (!args.snapshot) throw new Error(usage());

  const snapshotPath = path.resolve(args.snapshot);
  const fixturePath = path.resolve(args.fixture);
  const snapshotRows = rowsFromSnapshot(loadJson(snapshotPath, 'snapshot'));
  const fixture = loadFixture(fixturePath);
  const prepared = prepareFixture(fixture, snapshotRows);
  const result = analyzeFixture(prepared);

  const started = process.hrtime.bigint();
  const scan = scanPendingCorpus(snapshotRows);
  const elapsed = process.hrtime.bigint() - started;
  result.performance = {
    ...scan,
    wall_time_ms: Number(elapsed) / 1e6,
  };
  printReport(result, { snapshotPath, fixturePath }, emit);
  return result.acceptance.pass ? 0 : 2;
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv);
  } catch (error) {
    console.error(`neardup-dryrun: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  DEFAULT_FIXTURE,
  D1_THRESHOLD,
  D2_THRESHOLD,
  D3_THRESHOLD,
  D4_THRESHOLD,
  COMPOSITE_THRESHOLD,
  RECALL_MIN,
  FALSE_PAIR_RATE_MAX,
  tokenSet,
  setJaccard,
  unigramJaccard,
  termFrequency,
  tfCosine,
  titleJaccard,
  calibrateCosine,
  scoreChannels,
  pairKey,
  allPairs,
  rowsFromSnapshot,
  loadJson,
  loadFixture,
  prepareFixture,
  orientPair,
  scoreDistribution,
  diagnoseCurrentAlgorithm,
  connectedComponents,
  evaluateDetector,
  analyzeFixture,
  scanPendingCorpus,
  printReport,
  parseArgs,
  usage,
  main,
};
