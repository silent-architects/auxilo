'use strict';

/**
 * SPEC3-F1 Phase 1 — behavioral hold semantics.
 *
 * The real-server leg proves a submitted near-verbatim learning is held with
 * event-time predecessor evidence, that rejected/cross-category predecessors
 * participate, and that sanitize still excludes its retiring predecessor while
 * preserving ADMIN_REJECTED_FINAL.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const REPO = path.join(__dirname, '..');
const SERVER_SOURCE = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');
const GROUND_TRUTH = require('./fixtures/spec3-f1-phase0-ground-truth.json');
const RAW_API_KEY = `axl_${'e'.repeat(40)}`;
const ACCOUNT_ID = 'acc_spec3_f1_neardup';
const FIXED_AT = '2026-07-26T12:00:00.000Z';

const publishedCluster = GROUND_TRUTH.duplicate_clusters.find(
  (cluster) => cluster.id === 'published_ci_require_tier2_duplicate',
);
const publishedPredecessor = publishedCluster.members.find(
  (learning) => learning.status === 'approved',
);
const publishedCandidate = publishedCluster.members.find(
  (learning) => learning.status === 'rejected',
);

const rejectedPredecessor = {
  id: 'lrn_spec3_f1_rejected_predecessor',
  title: 'Retry a prepared filesystem operation after its commit marker fails',
  body: 'A prepared filesystem operation writes its payload and a durable commit marker in two phases. If the marker write fails, retain the prepared payload, retry only the marker operation, and treat an existing matching marker as success. Never repeat the payload write because that can duplicate the underlying operation.',
  category: 'monitoring',
  tags: ['filesystem', 'retry'],
  status: 'rejected',
  contributor_account_id: ACCOUNT_ID,
  created_at: FIXED_AT,
  updated_at: FIXED_AT,
};

const sanitizeSource = {
  id: 'lrn_spec3_f1_sanitize_source',
  title: 'Sanitize source retains its predecessor exclusion during resubmit',
  body: 'A sanitized resubmission must compare against every catalog status while excluding the one predecessor it retires. The exclusion applies to both exact-body matching and near-verbatim matching so including rejected history does not cause the replacement to flag itself.',
  category: 'storage-state',
  tags: ['sanitize', 'dedup'],
  outcome: 'success',
  status: 'rejected',
  contributor_account_id: ACCOUNT_ID,
  contributor_agent: 'spec3-f1-test',
  self_review_action: {
    action: 'rejected',
    reason: 'operator requested genericization',
    at: FIXED_AT,
  },
  quality_self_assessment: {
    specificity: 4,
    actionability: 4,
    novelty: 4,
    completeness: 4,
    total: 16,
  },
  created_at: FIXED_AT,
  updated_at: FIXED_AT,
};

const adminRejectedSource = {
  ...sanitizeSource,
  id: 'lrn_spec3_f1_admin_rejected',
  title: 'Admin rejected source remains final during sanitize attempts',
  body: 'An administrator rejected this distinct learning and the contributor cannot revive it through sanitize-and-resubmit. Both the early guard and the under-lock guard preserve that moderation decision as final.',
  moderation_action: {
    action: 'rejected',
    at: FIXED_AT,
  },
};

function extractionCandidate() {
  return {
    title: 'Extracted conditionally skipped test tier must fail loudly in CI',
    body: `${publishedCandidate.body} Extraction-channel verification adds this final sentence.`,
    category: publishedCandidate.category,
    tags: ['ci', 'testing'],
    task_context: 'Autonomous extraction found a conditionally skipped CI tier.',
    outcome: 'success',
    quality_self_assessment: {
      specificity: 4,
      actionability: 4,
      novelty: 4,
      completeness: 4,
      total: 16,
      extraction_confidence: 0.95,
      reasoning: 'Near-verbatim operational lesson with a concrete failure and guard.',
    },
    extraction_context: {
      trigger: 'problem_solved',
      source_type: 'conversation',
    },
  };
}

function accountRecord() {
  return {
    [ACCOUNT_ID]: {
      id: ACCOUNT_ID,
      email: 'spec3-f1-neardup@test.local',
      created_at: FIXED_AT,
      tos_version: '2026-07-04-payee-agency-a1',
      accepted_at: FIXED_AT,
      autonomous_extraction_mode: 'automatic',
      api_keys: [{
        id: 'key_spec3_f1_neardup',
        hash: crypto.createHash('sha256').update(RAW_API_KEY).digest('hex'),
        label: 'spec3-f1-neardup',
        scope: 'contribute',
        scope_version: 2,
        created_at: FIXED_AT,
        active: true,
      }],
    },
  };
}

function catalog() {
  return [
    {
      ...publishedPredecessor,
      contributor_account_id: ACCOUNT_ID,
    },
    rejectedPredecessor,
    sanitizeSource,
    adminRejectedSource,
  ];
}

function stageServer(tmpDir, nodeModulesDir) {
  for (const file of [
    'server.js',
    'seed-knowledge.json',
    'skills.json',
    'openapi.json',
    'package.json',
    'model_config.json',
  ]) {
    const source = path.join(REPO, file);
    if (fs.existsSync(source)) fs.copyFileSync(source, path.join(tmpDir, file));
  }

  const staged = fs.readFileSync(path.join(tmpDir, 'server.js'), 'utf8');
  let patched = staged.replace(
    /^const WALLET = '0x[0-9a-fA-F]{40}';$/m,
    "const WALLET = '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A';",
  );
  assert.notEqual(patched, staged, 'expected the staged wallet constant to be patched');
  const providerResponse = JSON.stringify([extractionCandidate()]);
  const beforeProvider = patched;
  patched = patched.replace(
    "const { extractWithRetry } = require('./lib/providers/anthropic.js');",
    `const extractWithRetry = async () => ({ text: ${JSON.stringify(providerResponse)}, usage: { input_tokens: 100, output_tokens: 100 }, model: 'spec3-f1-test' });`,
  );
  assert.notEqual(patched, beforeProvider, 'expected the staged extraction provider to be stubbed');
  const beforeSearch = patched;
  patched = patched.replace(
    'searchFn: (query, opts) => matchLearnings(query, opts),',
    'searchFn: () => [],',
  );
  assert.notEqual(patched, beforeSearch, 'expected extractor pre-dedup search to be isolated');
  fs.writeFileSync(path.join(tmpDir, 'server.js'), patched);

  for (const directory of ['lib', 'public', 'prompts', 'config']) {
    fs.symlinkSync(path.join(REPO, directory), path.join(tmpDir, directory));
  }
  fs.symlinkSync(nodeModulesDir, path.join(tmpDir, 'node_modules'));
  fs.mkdirSync(path.join(tmpDir, 'data'));
  fs.writeFileSync(
    path.join(tmpDir, 'data', 'learnings.json'),
    JSON.stringify(catalog(), null, 2),
  );
  fs.writeFileSync(
    path.join(tmpDir, 'data', 'accounts.json'),
    JSON.stringify(accountRecord(), null, 2),
  );
  fs.writeFileSync(
    path.join(tmpDir, 'data', 'extraction-consent.jsonl'),
    `${JSON.stringify({
      account_id: ACCOUNT_ID,
      action: 'grant',
      consent_version: '2026-04-14',
      timestamp: FIXED_AT,
      ip_redacted: '127.0.*.*',
      user_agent: 'spec3-f1-test',
    })}\n`,
  );
}

function bootServer(tmpDir) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['server.js'], {
      cwd: tmpDir,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        WALLET_PRIVATE_KEY: `0x${'11'.repeat(32)}`,
        LLM_SENSITIVITY_ENABLED: 'false',
        LEARNING_TYPE_SCREEN_ENABLED: 'false',
        SERVER_SIDE_EXTRACTION_ENABLED: 'true',
        AUXILO_DATA_DIR: path.join(tmpDir, 'data'),
        AUXILO_ACCOUNTS_FILE: path.join(tmpDir, 'data', 'accounts.json'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let settled = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => settle({ child, output, up: false }), 20_000);
    const onData = (buffer) => {
      output += buffer.toString();
      if (output.includes('Auxilo running at')) settle({ child, output, up: true });
      if (output.includes('EADDRINUSE') || output.includes('UNCAUGHT EXCEPTION')) {
        settle({ child, output, up: false });
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', () => settle({ child, output, up: false }));
  });
}

async function bootWithRetry(tmpDir) {
  let boot;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    boot = await bootServer(tmpDir);
    if (boot.up) return boot;
    boot.child.kill('SIGKILL');
    if (!boot.output.includes('EADDRINUSE')) return boot;
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  return boot;
}

function submission(learning, overrides = {}) {
  return {
    title: learning.title,
    body: learning.body,
    category: learning.category,
    tags: ['ci', 'testing'],
    task_context: 'SPEC3-F1 near-verbatim behavioral verification',
    outcome: 'success',
    contributor_agent: 'spec3-f1-test',
    quality_self_assessment: {
      specificity: 4,
      actionability: 4,
      novelty: 4,
      completeness: 4,
      total: 16,
    },
    ...overrides,
  };
}

describe('SPEC3-F1 Phase 1 near-duplicate runtime', () => {
  it('/extract keeps exact-duplicate rejection separate and holds similarity matches', () => {
    const route = SERVER_SOURCE.slice(
      SERVER_SOURCE.indexOf("app.post('/extract'"),
      SERVER_SOURCE.indexOf("app.post('/extract/consent'"),
    );
    assert.match(route, /if \(exactDup\) \{[\s\S]*reason: 'duplicate'/);
    assert.match(route, /const extractNearDupHold = nearDuplicateHold\(extractNearDup\)/);
    assert.match(route, /if \(extractNearDupHold\) extractReviewReasons\.push\('near_duplicate'\)/);
    assert.match(route, /if \(extractNearDupHold\) Object\.assign\(candidate, extractNearDupHold\)/);
    assert.doesNotMatch(route, /extractNearDup\.verdict === 'reject'/);
  });

  it('strips event-time duplicate evidence from all five buyer projections', () => {
    assert.equal(
      (SERVER_SOURCE.match(/near_duplicate_evidence: _nde/g) || []).length +
        (SERVER_SOURCE.match(/possible_duplicate_similarity, near_duplicate_evidence,/g) || []).length,
      5,
    );
    assert.match(SERVER_SOURCE, /near_duplicate_evidence: l\.near_duplicate_evidence/,
      'admin reviewer projection retains evidence');
  });

  it('holds published and rejected/cross-category re-extractions and preserves sanitize guards', {
    timeout: 180_000,
  }, async (t) => {
    let nodeModulesDir;
    try {
      const honoEntry = require.resolve('hono', { paths: [REPO] });
      nodeModulesDir = honoEntry.slice(
        0,
        honoEntry.lastIndexOf(`${path.sep}node_modules${path.sep}`) +
          '/node_modules'.length,
      );
    } catch {
      t.skip('hono not resolvable from repo root');
      return;
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auxilo-spec3-f1-neardup-'));
    const headers = {
      'X-API-Key': RAW_API_KEY,
      'Content-Type': 'application/json',
    };
    const base = 'http://127.0.0.1:3000';
    let child;
    try {
      stageServer(tmpDir, nodeModulesDir);
      const boot = await bootWithRetry(tmpDir);
      child = boot.child;
      assert.equal(boot.up, true, `server failed to boot: ${boot.output.slice(-1000)}`);

      const publishedResponse = await fetch(`${base}/learn`, {
        method: 'POST',
        headers,
        body: JSON.stringify(submission(publishedCandidate)),
      });
      assert.equal(
        publishedResponse.status,
        201,
        `published-pair submission failed: ${await publishedResponse.clone().text()}`,
      );
      const published = await publishedResponse.json();
      assert.equal(published.status, 'pending_review');
      assert.ok(published.review_reason.includes('near_duplicate'));
      assert.equal(
        published.near_duplicate_why,
        `re-extraction of your published learning ${publishedPredecessor.id}`,
      );
      assert.equal(
        published.near_duplicate_evidence.predecessor_status,
        'approved',
      );

      const rejectedCandidate = {
        ...rejectedPredecessor,
        title: 'Resume a prepared operation after its durable marker write fails',
        body: rejectedPredecessor.body.replace(
          'retry only the marker operation',
          'retry the marker operation only',
        ),
        category: 'code-execution',
      };
      const rejectedResponse = await fetch(`${base}/learn`, {
        method: 'POST',
        headers,
        body: JSON.stringify(submission(rejectedCandidate)),
      });
      assert.equal(
        rejectedResponse.status,
        201,
        `rejected-pair submission failed: ${await rejectedResponse.clone().text()}`,
      );
      const rejected = await rejectedResponse.json();
      assert.equal(rejected.status, 'pending_review');
      assert.ok(rejected.review_reason.includes('near_duplicate'));
      assert.equal(
        rejected.near_duplicate_why,
        're-extraction of a lesson you previously rejected',
      );
      assert.equal(
        rejected.near_duplicate_evidence.predecessor_id,
        rejectedPredecessor.id,
      );
      assert.equal(
        rejected.near_duplicate_evidence.predecessor_status,
        'rejected',
      );

      const transcript = (
        'This technical transcript verifies that a conditionally skipped test tier must fail loudly in continuous integration. '
      ).repeat(18);
      const extractionResponse = await fetch(`${base}/extract`, {
        method: 'POST',
        headers: {
          ...headers,
          'Idempotency-Key': 'spec3-f1-neardup-extract-1',
        },
        body: JSON.stringify({
          source: {
            type: 'claude-code',
            session_id: 'spec3-f1-neardup-runtime',
          },
          transcript,
          transcript_sha256: crypto.createHash('sha256').update(transcript).digest('hex'),
          mode_hint: 'automatic',
          client_scrub_report: {
            patterns_matched: [],
          },
        }),
      });
      assert.equal(
        extractionResponse.status,
        200,
        `extraction submission failed: ${await extractionResponse.clone().text()}`,
      );
      const extraction = await extractionResponse.json();
      assert.equal(extraction.learnings_found, 1);
      assert.equal(extraction.learnings_published, 1);
      assert.equal(extraction.learnings_rejected, 0);
      assert.equal(extraction.published[0].status, 'pending_review');
      assert.ok(extraction.published[0].review_reason.includes('near_duplicate'));
      assert.ok(extraction.published[0].near_duplicate_why);
      assert.equal(
        extraction.published[0].near_duplicate_evidence.predecessor_id,
        published.id,
      );

      const sanitizeResponse = await fetch(
        `${base}/account/pending/${sanitizeSource.id}/sanitize`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            title: 'Sanitized replacement keeps its retiring predecessor excluded',
          }),
        },
      );
      assert.equal(
        sanitizeResponse.status,
        200,
        `sanitize predecessor exclusion failed: ${await sanitizeResponse.clone().text()}`,
      );
      const sanitized = await sanitizeResponse.json();
      assert.equal(sanitized.status, 'pending_review');
      assert.ok(sanitized.review_reason.includes('sanitized_resubmission'));
      assert.equal(sanitized.review_reason.includes('near_duplicate'), false);

      const adminFinalResponse = await fetch(
        `${base}/account/pending/${adminRejectedSource.id}/sanitize`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            title: 'Admin rejected replacement must remain impossible to create',
          }),
        },
      );
      assert.equal(adminFinalResponse.status, 409);
      assert.equal((await adminFinalResponse.json()).code, 'ADMIN_REJECTED_FINAL');

      const persisted = JSON.parse(fs.readFileSync(
        path.join(tmpDir, 'data', 'learnings.json'),
        'utf8',
      ));
      const publishedHeld = persisted.find((row) => row.id === published.id);
      const rejectedHeld = persisted.find((row) => row.id === rejected.id);
      const extractedHeld = persisted.find(
        (row) => row.id === extraction.published[0].id,
      );
      assert.equal(publishedHeld.status, 'pending_review');
      assert.equal(publishedHeld.possible_duplicate_of, publishedPredecessor.id);
      assert.equal(publishedHeld.near_duplicate_why, published.near_duplicate_why);
      assert.equal(rejectedHeld.status, 'pending_review');
      assert.equal(rejectedHeld.possible_duplicate_of, rejectedPredecessor.id);
      assert.equal(rejectedHeld.near_duplicate_why, rejected.near_duplicate_why);
      assert.equal(extractedHeld.status, 'pending_review');
      assert.equal(extractedHeld.possible_duplicate_of, published.id);
      assert.equal(extractedHeld.near_duplicate_why, extraction.published[0].near_duplicate_why);
    } finally {
      if (child) child.kill('SIGKILL');
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
