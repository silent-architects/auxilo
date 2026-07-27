'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const dryrun = require('../scripts/extract-dedup-dryrun.js');

function resolvedFixture() {
  return dryrun.resolveReplayFixture(
    dryrun.loadReplayFixture(dryrun.DEFAULT_FIXTURE)
  );
}

describe('SPEC3-F2 offline extraction replay harness', () => {
  it('pins five F1 flood clusters and the three same-domain Apps Script keep items', () => {
    const resolved = resolvedFixture();
    assert.equal(resolved.mustDrop.length, 5);
    assert.equal(new Set(resolved.mustDrop.map((item) => item.cluster_id)).size, 5);
    assert.equal(resolved.mustKeep.length, 3);
    assert.ok(resolved.mustKeep.every((row) => /Apps Script/i.test(`${row.title} ${row.body}`)));
  });

  it('builds replay transcripts from the pinned operational findings', () => {
    const resolved = resolvedFixture();
    const transcript = dryrun.buildReplayTranscript(
      resolved.mustDrop.map((item) => item.replay),
      'must-drop'
    );
    assert.match(transcript, /Offline SPEC3-F2 must-drop replay/);
    assert.equal((transcript.match(/LESSON \d+/g) || []).length, 5);
    for (const item of resolved.mustDrop) assert.ok(transcript.includes(item.replay.title));
  });

  it('runs without any server call and measures prompt plus post-filter outcomes', async () => {
    const resolved = resolvedFixture();
    const extractImpl = async (transcript, _sourceType, opts) => {
      if (transcript.includes('must-drop replay')) {
        const drop_audit = resolved.mustDrop.map((item) => ({
          title: item.replay.title,
          drop_stage: 'anchored_judge',
          matched_index_title: item.index.title,
          matched_index_id: item.index.id,
        }));
        for (const entry of drop_audit) {
          opts.log(`[dedup-drop] ${JSON.stringify(entry)}`);
        }
        return {
          learnings: [],
          dedup_dropped: 5,
          drop_audit,
          prompt_memory_tokens: 600,
          prompt_memory_rows: 5,
          judge_calls: 1,
          judge_prompt_tokens: 700,
          judge_completion_tokens: 30,
        };
      }
      return {
        learnings: resolved.mustKeep,
        dedup_dropped: 0,
        drop_audit: [],
        prompt_memory_tokens: 600,
        prompt_memory_rows: 5,
        judge_calls: 1,
        judge_prompt_tokens: 300,
        judge_completion_tokens: 20,
      };
    };
    const result = await dryrun.runReplay(resolved, 1, { extractImpl });
    assert.equal(result.must_drop_dropped, 5);
    assert.equal(result.must_drop_rate, 1);
    assert.equal(result.drops_by_stage.anchored_judge, 5);
    assert.equal(result.post_filter_dropped, 0);
    assert.equal(result.must_keep_retained, 3);
    assert.equal(result.must_keep_dropped, 0);
    assert.equal(result.drop_log_complete, true);
    assert.deepEqual(result.must_drop_unaccounted_ids, []);
    assert.equal(result.judge_calls, 2);
    assert.equal(result.judge_prompt_tokens, 1000);
    assert.equal(result.judge_completion_tokens, 50);
  });

  it('evaluates the acceptance gate against the worst of all replay runs', () => {
    const pass = dryrun.gateVerdict([
      { must_drop_rate: 1, must_keep_dropped: 0, drop_log_complete: true, must_drop_unaccounted_ids: [] },
      { must_drop_rate: 0.9, must_keep_dropped: 0, drop_log_complete: true, must_drop_unaccounted_ids: [] },
      { must_drop_rate: 1, must_keep_dropped: 0, drop_log_complete: true, must_drop_unaccounted_ids: [] },
    ]);
    assert.equal(pass.pass, true);
    assert.equal(pass.worst_must_drop_rate, 0.9);

    const dropFailure = dryrun.gateVerdict([
      { must_drop_rate: 1, must_keep_dropped: 0, drop_log_complete: true, must_drop_unaccounted_ids: [] },
      { must_drop_rate: 0.8, must_keep_dropped: 0, drop_log_complete: true, must_drop_unaccounted_ids: [] },
      { must_drop_rate: 1, must_keep_dropped: 0, drop_log_complete: true, must_drop_unaccounted_ids: [] },
    ]);
    assert.equal(dropFailure.pass, false);

    const keepFailure = dryrun.gateVerdict([
      { must_drop_rate: 1, must_keep_dropped: 0, drop_log_complete: true, must_drop_unaccounted_ids: [] },
      { must_drop_rate: 1, must_keep_dropped: 1, drop_log_complete: true, must_drop_unaccounted_ids: [] },
      { must_drop_rate: 1, must_keep_dropped: 0, drop_log_complete: true, must_drop_unaccounted_ids: [] },
    ]);
    assert.equal(keepFailure.pass, false);

    const auditFailure = dryrun.gateVerdict([
      { must_drop_rate: 1, must_keep_dropped: 0, drop_log_complete: true, must_drop_unaccounted_ids: [] },
      { must_drop_rate: 1, must_keep_dropped: 0, drop_log_complete: false, must_drop_unaccounted_ids: ['lrn_missing'] },
      { must_drop_rate: 1, must_keep_dropped: 0, drop_log_complete: true, must_drop_unaccounted_ids: [] },
    ]);
    assert.equal(auditFailure.pass, false);
    assert.equal(auditFailure.drop_log_complete, false);
  });

  it('reports capped token estimates for index sizes 10, 100, and 1000', () => {
    const table = dryrun.tokenCostTable(resolvedFixture());
    assert.deepEqual(table.map((row) => row.index_size), [10, 100, 1000]);
    assert.ok(table.every((row) => row.held));
    assert.ok(table.every((row) => row.prompt_tokens_estimated <= row.cap_tokens));
    assert.ok(table[2].rows_included < 1000);
  });

  it('requires at least three runs and remains offline/read-only with respect to Auxilo', () => {
    assert.throws(() => dryrun.parseArgs(['--runs', '2']), /integer >= 3/);
    assert.equal(dryrun.parseArgs(['--runs', '3', '--json']).runs, 3);
    assert.match(dryrun.usage(), /--runs N>=3/);

    const source = fs.readFileSync(
      path.join(__dirname, '..', 'scripts', 'extract-dedup-dryrun.js'),
      'utf8'
    );
    assert.doesNotMatch(source, /submitLearnings|fetch\(|https?:\/\/|AUXILO_BASE_URL/);
  });
});
