'use strict';

/**
 * SPEC3-F1 rider — the counted account_vocab rejection route must consume the
 * same review-time derivation as the pending summary. The signal is deliberately
 * not persisted by submission screening, so only a real summary -> route test
 * proves the selector can act on the count it reports.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  reservePort,
  stageServer,
  bootServer,
  stopServer,
  BOOT_SANDBOX_SKIP_REASON,
} = require('./helpers/staged-server');

const REPO = path.join(__dirname, '..');
const RAW_API_KEY = `axl_${'f'.repeat(40)}`;
const ACCOUNT_ID = 'acc_spec3_f1_rider';
const FIXED_AT = '2026-07-26T12:00:00.000Z';
const VOCAB_TERM = 'rider-widget';
const ACCOUNT_VOCAB_CONFIG = require('../config/account-vocab.json');
const {
  parseCommonDevTerms,
  selectPendingIdsBySignal,
  summarizeOwnPending,
} = require('../lib/self-review.js');

const ACCOUNT_VOCAB_OPTS = {
  config: ACCOUNT_VOCAB_CONFIG,
  commonDevTerms: parseCommonDevTerms(fs.readFileSync(
    path.join(REPO, 'config', 'common-dev-terms.txt'),
    'utf8'
  )),
};

function pending(id, body) {
  return {
    id,
    title: `Account vocabulary rider ${id}`,
    body,
    category: 'code-execution',
    tags: ['review'],
    status: 'pending_review',
    contributor_account_id: ACCOUNT_ID,
    contributor_agent: 'spec3-f1-test',
    created_at: FIXED_AT,
    updated_at: FIXED_AT,
    quality_self_assessment: {
      specificity: 4,
      actionability: 4,
      novelty: 4,
      completeness: 4,
      total: 16,
    },
  };
}

function riderPendingRows() {
  return [
    pending('lrn_vocab_rider_a',
      `Use ${VOCAB_TERM} to validate a staged operation before committing it.`),
    pending('lrn_vocab_rider_b',
      `Retry ${VOCAB_TERM} only after the prior operation reports a terminal failure.`),
  ];
}

function bootCatalog() {
  const seed = JSON.parse(fs.readFileSync(path.join(REPO, 'seed-knowledge.json'), 'utf8'));
  const base = Array.isArray(seed) ? seed[0] : seed.learnings[0];
  assert.ok(base, 'seed-knowledge.json must contain a learning');
  return [
    {
      ...JSON.parse(JSON.stringify(base)),
      id: 'lrn_vocab_rider_public_seed',
      status: 'approved',
    },
    ...riderPendingRows(),
  ];
}

function bootAccounts() {
  return {
    [ACCOUNT_ID]: {
      id: ACCOUNT_ID,
      email: 'spec3-f1-rider@test.local',
      created_at: FIXED_AT,
      tos_version: '2026-07-04-payee-agency-a1',
      accepted_at: FIXED_AT,
      api_keys: [{
        id: 'key_spec3_f1_rider',
        hash: crypto.createHash('sha256').update(RAW_API_KEY).digest('hex'),
        label: 'spec3-f1-rider',
        scope: 'contribute',
        scope_version: 2,
        created_at: FIXED_AT,
        active: true,
      }],
    },
  };
}

describe('SPEC3-F1 account_vocab reject-by-signal rider', () => {
  it('keeps the pure selector exactly aligned with the summary-derived count', () => {
    const rows = riderPendingRows();
    const opts = { accountVocab: ACCOUNT_VOCAB_OPTS };
    const summary = summarizeOwnPending(rows, ACCOUNT_ID, opts);
    const selected = selectPendingIdsBySignal(rows, ACCOUNT_ID, 'account_vocab', opts);
    const summaryIds = summary.items
      .filter((row) => row.flags.includes('account_vocab'))
      .map((row) => row.id);

    assert.equal(summary.counts.by_signal.account_vocab, 2);
    assert.deepEqual(selected, summaryIds);
  });

  it('rejects the review-time account_vocab selection using the summary count', {
    timeout: 180_000,
  }, async (t) => {
    let nodeModulesDir;
    try {
      const honoEntry = require.resolve('hono', { paths: [REPO] });
      nodeModulesDir = honoEntry.slice(
        0,
        honoEntry.lastIndexOf(`${path.sep}node_modules${path.sep}`) +
          '/node_modules'.length
      );
    } catch {
      t.skip('hono not resolvable from repo root');
      return;
    }

    const reservation = await reservePort();
    if ('skipReason' in reservation) {
      assert.equal(reservation.skipReason, BOOT_SANDBOX_SKIP_REASON);
      t.skip(BOOT_SANDBOX_SKIP_REASON);
      return;
    }

    const { port } = reservation;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auxilo-spec3-f1-rider-'));
    let child;
    const headers = {
      'X-API-Key': RAW_API_KEY,
      'Content-Type': 'application/json',
    };

    try {
      stageServer({
        repoRoot: REPO,
        tmpDir,
        nodeModulesDir,
        port,
        rootFiles: [
          'server.js',
          'seed-knowledge.json',
          'skills.json',
          'openapi.json',
          'package.json',
          'model_config.json',
        ],
        linkDirs: ['lib', 'public', 'prompts', 'config'],
        replacements: [],
      });
      fs.writeFileSync(
        path.join(tmpDir, 'data', 'learnings.json'),
        JSON.stringify(bootCatalog(), null, 2)
      );
      fs.writeFileSync(
        path.join(tmpDir, 'data', 'accounts.json'),
        JSON.stringify(bootAccounts(), null, 2)
      );

      const boot = await bootServer({
        tmpDir,
        port,
        env: {
          ...process.env,
          NODE_ENV: 'test',
          WALLET_PRIVATE_KEY: `0x${'11'.repeat(32)}`,
          LLM_SENSITIVITY_ENABLED: 'false',
          AUXILO_DATA_DIR: path.join(tmpDir, 'data'),
          AUXILO_ACCOUNTS_FILE: path.join(tmpDir, 'data', 'accounts.json'),
        },
        timeoutMs: 60_000,
        maxAttempts: 4,
      });
      if ('skipReason' in boot) {
        assert.equal(boot.skipReason, BOOT_SANDBOX_SKIP_REASON);
        t.skip(BOOT_SANDBOX_SKIP_REASON);
        return;
      }
      child = boot.child;
      const base = boot.baseUrl;

      const summaryResponse = await fetch(`${base}/account/pending/summary`, { headers });
      assert.equal(summaryResponse.status, 200);
      const summary = await summaryResponse.json();
      assert.equal(summary.counts.by_signal.account_vocab, 2);
      const flagged = summary.items.filter((row) => row.flags.includes('account_vocab'));
      assert.deepEqual(flagged.map((row) => row.id), [
        'lrn_vocab_rider_a',
        'lrn_vocab_rider_b',
      ]);
      assert.ok(flagged.every((row) => row.lane === 'needs_your_eyes'));

      const rejectionResponse = await fetch(
        `${base}/account/pending/reject-by-signal`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            signal: 'account_vocab',
            expected_count: summary.counts.by_signal.account_vocab,
            reason: 'SPEC3-F1 behavioral account_vocab rejection',
          }),
        }
      );
      assert.equal(
        rejectionResponse.status,
        200,
        `reject-by-signal returned ${rejectionResponse.status}: ${await rejectionResponse.clone().text()}`
      );
      const rejection = await rejectionResponse.json();
      assert.equal(rejection.expected_count, 2);
      assert.equal(rejection.processed, 2);
      assert.equal(rejection.rejected, 2);
      assert.equal(rejection.failed, 0);
      assert.ok(rejection.results.every((result) => result.ok && result.changed));

      const persisted = JSON.parse(fs.readFileSync(
        path.join(tmpDir, 'data', 'learnings.json'),
        'utf8'
      ));
      const byId = new Map(persisted.map((row) => [row.id, row]));
      for (const id of ['lrn_vocab_rider_a', 'lrn_vocab_rider_b']) {
        assert.equal(byId.get(id).status, 'rejected');
        assert.equal(
          byId.get(id).self_review_action.reason,
          'SPEC3-F1 behavioral account_vocab rejection'
        );
      }
    } finally {
      if (child) await stopServer(child);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
