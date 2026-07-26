#!/usr/bin/env node
'use strict';

/**
 * SPEC3-F2 offline replay harness.
 *
 * This script makes local Claude Code extraction calls only. It never calls an
 * Auxilo server, never submits a learning, and writes only a temporary local
 * index that is removed after each run.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  appendSubmittedLearning,
  buildPromptMemory,
  PROMPT_MEMORY_MAX_TOKENS,
} = require('../lib/extraction-index.js');
const { findNearDuplicate } = require('../lib/similarity.js');
const { extractLocally } = require('./extract-local.js');
const {
  DEFAULT_FIXTURE: F1_FIXTURE,
  loadFixture: loadF1Fixture,
} = require('./neardup-dryrun.js');

const DEFAULT_FIXTURE = path.resolve(
  __dirname,
  '../test/fixtures/spec3-f2-extraction-replays.json'
);
const GATE_MUST_DROP_RATE = 0.90;
const GATE_MUST_KEEP_DROPPED = 0;

function loadReplayFixture(filePath = DEFAULT_FIXTURE) {
  const parsed = JSON.parse(fs.readFileSync(path.resolve(filePath), 'utf8'));
  if (!Array.isArray(parsed.must_drop) || parsed.must_drop.length !== 5) {
    throw new Error('replay fixture must contain exactly five must_drop cluster mappings');
  }
  if (!Array.isArray(parsed.must_keep_ids) || parsed.must_keep_ids.length !== 3) {
    throw new Error('replay fixture must contain exactly three must_keep_ids');
  }
  return parsed;
}

function resolveReplayFixture(replayFixture, f1Fixture = loadF1Fixture(F1_FIXTURE)) {
  const allRows = [
    ...f1Fixture.duplicate_clusters.flatMap((cluster) => cluster.members),
    ...f1Fixture.clean_approved,
  ];
  const byId = new Map(allRows.map((row) => [row.id, row]));
  const mustDrop = replayFixture.must_drop.map((mapping) => {
    const cluster = f1Fixture.duplicate_clusters.find(
      (item) => item.id === mapping.cluster_id
    );
    const index = byId.get(mapping.index_id);
    const replay = byId.get(mapping.replay_id);
    if (!cluster || !index || !replay ||
        !cluster.members.some((row) => row.id === index.id) ||
        !cluster.members.some((row) => row.id === replay.id)) {
      throw new Error(`invalid must_drop mapping for ${mapping.cluster_id}`);
    }
    return { ...mapping, index, replay };
  });
  const mustKeep = replayFixture.must_keep_ids.map((id) => {
    const row = byId.get(id);
    if (!row) throw new Error(`must_keep id missing from F1 fixture: ${id}`);
    return row;
  });
  return { mustDrop, mustKeep };
}

function buildReplayTranscript(rows, label) {
  const lessons = rows.map((row, index) => [
    `LESSON ${index + 1}`,
    `Title: ${row.title}`,
    `Category: ${row.category}`,
    `Tags: ${(row.tags || []).join(', ')}`,
    `Operational finding: ${row.body}`,
  ].join('\n')).join('\n\n');
  return `Offline SPEC3-F2 ${label} replay. During this completed technical session, the agent independently encountered the following operational findings. Extract each finding only if it satisfies the extraction prompt.\n\n${lessons}`;
}

function expectedKeepsFound(expected, emitted) {
  const matched = [];
  for (const row of expected) {
    const result = findNearDuplicate(row, emitted || []);
    if (result.verdict === 'flag') matched.push(row.id);
  }
  return matched;
}

function tokenCostTable(resolved) {
  const seeds = [
    ...resolved.mustDrop.map((item) => item.index),
    ...resolved.mustKeep,
  ];
  return [10, 100, 1000].map((size) => {
    const rows = Array.from({ length: size }, (_, index) => {
      const seed = seeds[index % seeds.length];
      return {
        ...seed,
        title: `${seed.title} [memory ${index}]`,
        learning_id: `${seed.id}-memory-${index}`,
        submitted_at: new Date(Date.UTC(2026, 6, 1, 0, 0, index)).toISOString(),
      };
    });
    const memory = buildPromptMemory(rows, {
      transcript: buildReplayTranscript(
        resolved.mustDrop.map((item) => item.replay),
        'token-cost'
      ),
    });
    return {
      index_size: size,
      prompt_tokens_estimated: memory.estimated_tokens,
      rows_included: memory.included_count,
      cap_tokens: PROMPT_MEMORY_MAX_TOKENS,
      held: memory.estimated_tokens <= PROMPT_MEMORY_MAX_TOKENS,
    };
  });
}

async function runReplay(resolved, runNumber, opts = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `auxilo-spec3-f2-replay-${runNumber}-`));
  const indexPath = path.join(tmpDir, 'extracted-index.jsonl');
  const logs = [];
  const log = opts.log || ((line) => logs.push(line));
  const extractImpl = opts.extractImpl || extractLocally;
  try {
    for (let index = 0; index < resolved.mustDrop.length; index += 1) {
      const row = resolved.mustDrop[index].index;
      const ok = appendSubmittedLearning(
        row,
        { id: row.id, status: row.status || 'rejected' },
        {
          indexPath,
          now: row.created_at || `2026-07-26T12:00:0${index}.000Z`,
          log,
        }
      );
      if (!ok) throw new Error('could not construct temporary replay index');
    }

    const commonOpts = {
      indexPath,
      log,
      ...(opts.invokeModel && { invokeModel: opts.invokeModel }),
    };
    const duplicateResult = await extractImpl(
      buildReplayTranscript(resolved.mustDrop.map((item) => item.replay), 'must-drop'),
      'claude-code',
      commonOpts
    );
    if (duplicateResult.skipped) {
      throw new Error(`must-drop extraction skipped: ${duplicateResult.skipped}`);
    }
    const keepResult = await extractImpl(
      buildReplayTranscript(resolved.mustKeep, 'must-keep'),
      'claude-code',
      commonOpts
    );
    if (keepResult.skipped) {
      throw new Error(`must-keep extraction skipped: ${keepResult.skipped}`);
    }

    const duplicateLeaks = (duplicateResult.learnings || []).slice(0, resolved.mustDrop.length);
    const mustDropDropped = Math.max(0, resolved.mustDrop.length - duplicateLeaks.length);
    const keepMatchedIds = expectedKeepsFound(resolved.mustKeep, keepResult.learnings || []);
    return {
      run: runNumber,
      must_drop_total: resolved.mustDrop.length,
      must_drop_dropped: mustDropDropped,
      must_drop_rate: mustDropDropped / resolved.mustDrop.length,
      must_drop_leaks: duplicateLeaks.map((row) => row.title),
      post_filter_dropped: duplicateResult.dedup_dropped || 0,
      must_keep_total: resolved.mustKeep.length,
      must_keep_retained: keepMatchedIds.length,
      must_keep_dropped: resolved.mustKeep.length - keepMatchedIds.length,
      must_keep_matched_ids: keepMatchedIds,
      must_keep_emitted_titles: (keepResult.learnings || []).map((row) => row.title),
      prompt_memory_tokens: duplicateResult.prompt_memory_tokens || 0,
      prompt_memory_rows: duplicateResult.prompt_memory_rows || 0,
      logs,
    };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function gateVerdict(runs) {
  const worstDropRate = Math.min(...runs.map((run) => run.must_drop_rate));
  const worstKeepDropped = Math.max(...runs.map((run) => run.must_keep_dropped));
  return {
    pass: worstDropRate >= GATE_MUST_DROP_RATE &&
      worstKeepDropped === GATE_MUST_KEEP_DROPPED,
    worst_must_drop_rate: worstDropRate,
    worst_must_keep_dropped: worstKeepDropped,
    thresholds: {
      must_drop_rate_min: GATE_MUST_DROP_RATE,
      must_keep_dropped_max: GATE_MUST_KEEP_DROPPED,
    },
  };
}

function parseArgs(argv = process.argv.slice(2)) {
  const out = { fixture: DEFAULT_FIXTURE, runs: 3, json: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--fixture') out.fixture = path.resolve(argv[++index]);
    else if (arg === '--runs') out.runs = Number(argv[++index]);
    else if (arg === '--json') out.json = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!Number.isInteger(out.runs) || out.runs < 3) {
    throw new Error('--runs must be an integer >= 3');
  }
  return out;
}

function usage() {
  return 'Usage: node scripts/extract-dedup-dryrun.js [--fixture path] [--runs N>=3] [--json]';
}

function printHuman(report) {
  console.log('SPEC3-F2 client extraction replay');
  for (const run of report.runs) {
    console.log(
      `run ${run.run}: must-drop ${run.must_drop_dropped}/${run.must_drop_total} ` +
      `(${(run.must_drop_rate * 100).toFixed(2)}%), ` +
      `must-keep dropped ${run.must_keep_dropped}/${run.must_keep_total}, ` +
      `post-filter drops ${run.post_filter_dropped}`
    );
    if (run.must_drop_leaks.length) {
      console.log(`  leaks: ${run.must_drop_leaks.join(' | ')}`);
    }
  }
  console.log('prompt token cost (estimated at UTF-8 bytes / 4):');
  for (const row of report.token_cost) {
    console.log(
      `  index ${row.index_size}: ~${row.prompt_tokens_estimated} tokens, ` +
      `${row.rows_included} row(s), cap ${row.cap_tokens}, held=${row.held}`
    );
  }
  console.log(
    `gate: ${report.gate.pass ? 'PASS' : 'FAIL'}; worst must-drop ` +
    `${(report.gate.worst_must_drop_rate * 100).toFixed(2)}%; ` +
    `worst must-keep dropped ${report.gate.worst_must_keep_dropped}`
  );
}

async function main(argv = process.argv.slice(2), opts = {}) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(usage());
    return { help: true };
  }
  const replay = loadReplayFixture(args.fixture);
  const resolved = resolveReplayFixture(replay);
  const runs = [];
  for (let run = 1; run <= args.runs; run += 1) {
    runs.push(await runReplay(resolved, run, opts));
  }
  const report = {
    fixture: args.fixture,
    runs,
    token_cost: tokenCostTable(resolved),
    gate: gateVerdict(runs),
  };
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else printHuman(report);
  if (!report.gate.pass) process.exitCode = 1;
  return report;
}

module.exports = {
  DEFAULT_FIXTURE,
  GATE_MUST_DROP_RATE,
  GATE_MUST_KEEP_DROPPED,
  loadReplayFixture,
  resolveReplayFixture,
  buildReplayTranscript,
  expectedKeepsFound,
  tokenCostTable,
  runReplay,
  gateVerdict,
  parseArgs,
  usage,
  main,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(`[extract-dedup-dryrun] ${error.message}`);
    process.exitCode = 1;
  });
}
