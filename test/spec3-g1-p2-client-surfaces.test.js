'use strict';

/**
 * SPEC3-G1-P2 rev 1.1 — private-tier client surfaces.
 *
 * Runner: node --test test/spec3-g1-p2-client-surfaces.test.js
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const review = require('../lib/review.js');
const selfReview = require('../lib/self-review.js');
const dashboardReview = require('../public/dashboard-review.js');
const runner = require('../scripts/runner.js');
const extractor = require('../scripts/extract-local.js');
const { planKeepPrivate, keepPrivateDecisions } = require('../mcp-server.js');

const REPO = path.join(__dirname, '..');
const CLI = path.join(REPO, 'bin', 'auxilo-cli.js');
const DASHBOARD_HTML = fs.readFileSync(path.join(REPO, 'public', 'dashboard.html'), 'utf8');
const MCP_SOURCE = fs.readFileSync(path.join(REPO, 'mcp-server.js'), 'utf8');

function row(id, lane, overrides = {}) {
  return {
    id,
    lane,
    quality: lane === 'needs_score' ? 10 : 18,
    screens_passed: lane !== 'needs_your_eyes',
    flags: lane === 'needs_your_eyes' ? ['account_vocab'] : [],
    category: 'code-execution',
    title: `Title ${id}`,
    created_at: '2026-07-27T00:00:00.000Z',
    visibility: 'public',
    ...overrides,
  };
}

function summaryFixture(items = [
  row('ready-public', 'ready_to_publish'),
  row('ready-private', 'ready_to_publish', { visibility: 'private' }),
  row('score-public', 'needs_score'),
  row('eyes-public', 'needs_your_eyes'),
  row('eyes-private', 'needs_your_eyes', { visibility: 'private' }),
]) {
  const counts = {
    ready_to_publish: items.filter((r) => r.lane === 'ready_to_publish').length,
    needs_score: items.filter((r) => r.lane === 'needs_score').length,
    needs_your_eyes: items.filter((r) => r.lane === 'needs_your_eyes').length,
  };
  return {
    pending_count: items.length,
    approvable_count: counts.ready_to_publish,
    counts: {
      by_lane: counts,
      by_quality_band: { '18-20': 4, '14-17': 0, '10-13': 1, below_10: 0, unscored: 0 },
    },
    items,
  };
}

function runCli(args, env, input = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`CLI timed out: ${args.join(' ')}`));
    }, 10000);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

describe('shared private-tier selection and summary projection', () => {
  it('keep-private defaults exactly to needs_your_eyes and reports every excluded lane', () => {
    const plan = review.selectForKeepPrivate(summaryFixture().items);
    assert.deepEqual(plan.selected.map((r) => r.id), ['eyes-public', 'eyes-private']);
    assert.deepEqual(plan.excluded_by_lane.ready_to_publish.map((r) => r.id),
      ['ready-public', 'ready-private']);
    assert.deepEqual(plan.excluded_by_lane.needs_score.map((r) => r.id), ['score-public']);
  });

  it('--lane may select another server lane without changing approve selection semantics', () => {
    const plan = review.selectForKeepPrivate(summaryFixture().items, { lane: 'needs_score' });
    assert.deepEqual(plan.selected.map((r) => r.id), ['score-public']);
    assert.throws(() => review.selectForKeepPrivate([], { lane: 'bogus' }), /--lane/);
  });

  it('approve-ready and all exclude private-destined rows up front', () => {
    const rows = summaryFixture().items;
    const ready = review.selectForBulkApprove(rows, { mode: 'ready' });
    const all = review.selectForBulkApprove(rows, { mode: 'all', includeFlagged: true });
    assert.deepEqual(ready.selected.map((r) => r.id), ['ready-public']);
    assert.deepEqual(ready.excluded_private.map((r) => r.id).sort(),
      ['eyes-private', 'ready-private']);
    assert.deepEqual(all.excluded_private.map((r) => r.id).sort(),
      ['eyes-private', 'ready-private']);
  });

  it('the §3.5 rider projects visibility on every compact pending-summary row', () => {
    const items = [
      {
        id: 'private',
        title: 'Private row',
        body: 'A private body that must not be projected into the compact summary.',
        category: 'non-technical',
        tags: [],
        status: 'pending_review',
        visibility: 'private',
        contributor_account_id: 'acc_owner',
        created_at: '2026-07-27T00:00:00.000Z',
      },
      {
        id: 'legacy-public',
        title: 'Legacy public row',
        body: 'A legacy public body that also stays out of this compact summary.',
        category: 'code-execution',
        tags: [],
        status: 'pending_review',
        contributor_account_id: 'acc_owner',
        created_at: '2026-07-27T00:00:00.000Z',
      },
    ];
    const projected = selfReview.summarizeOwnPending(items, 'acc_owner').items;
    assert.deepEqual(projected.map((r) => [r.id, r.visibility]),
      [['private', 'private'], ['legacy-public', 'public']]);
    assert.ok(projected.every((r) => !Object.hasOwn(r, 'body')));
  });
});

describe('CLI private-tier review surfaces', () => {
  let home;
  let server;
  let baseUrl;
  let fixture;
  let posts;
  let singleResponse;

  before(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'auxilo-g1p2-cli-'));
    fs.mkdirSync(path.join(home, '.auxilo'), { recursive: true });
    fixture = summaryFixture();
    posts = [];
    singleResponse = null;
    server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        if (req.method === 'GET' && req.url.startsWith('/account/pending/summary')) {
          res.end(JSON.stringify(fixture));
          return;
        }
        if (req.method === 'GET' && req.url.startsWith('/account/pending')) {
          res.end(JSON.stringify({
            pending_count: fixture.items.length,
            learnings: fixture.items.map((item) => ({ ...item, body: `FULL BODY ${item.id}` })),
          }));
          return;
        }
        if (req.method === 'POST') {
          let body = {};
          try { body = raw ? JSON.parse(raw) : {}; } catch { /* fixture keeps {} */ }
          posts.push({ url: req.url, body });
          if (singleResponse && !req.url.endsWith('/bulk')) {
            res.statusCode = singleResponse.status;
            res.end(JSON.stringify(singleResponse.body));
            return;
          }
          const decisions = body.decisions || [];
          res.end(JSON.stringify({
            approved: decisions.filter((d) => d.decision === 'approve').length,
            kept_private: decisions.filter((d) => d.decision === 'keep_private').length,
            rejected: decisions.filter((d) => d.decision === 'reject').length,
            idempotent: 0,
            failed: 0,
            results: decisions.map((d, index) => ({ ok: true, id: d.id, index })),
          }));
          return;
        }
        res.statusCode = 404;
        res.end(JSON.stringify({ error: 'not found' }));
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    fs.writeFileSync(path.join(home, '.auxilo', 'credentials.json'), JSON.stringify({
      api_key: 'test-key',
      base_url: baseUrl,
    }));
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('rapid p posts keep_private and renders the owner-only success line', async () => {
    fixture = summaryFixture([row('one', 'needs_your_eyes')]);
    posts = [];
    singleResponse = null;
    const result = await runCli(['review'], { HOME: home, AUXILO_BASE_URL: baseUrl }, 'p\n');
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(posts.map((p) => p.url), ['/account/pending/one/keep-private']);
    assert.match(result.stdout, /✓ kept private \(owner-only\)/);
  });

  it('a 400 bad_decision prints the private-tier version-skew message', async () => {
    fixture = summaryFixture([row('one', 'needs_your_eyes')]);
    posts = [];
    singleResponse = {
      status: 400,
      body: { code: 'bad_decision', error: 'decision must be approve or reject' },
    };
    const result = await runCli(['review'], { HOME: home, AUXILO_BASE_URL: baseUrl }, 'p\n');
    assert.equal(result.code, 0);
    assert.match(result.stderr, /server predates the private tier — update the server/);
    assert.doesNotMatch(result.stderr, /decision must be approve or reject/);
  });

  it('single-item approve surfaces private_requires_sanitize server text verbatim', async () => {
    fixture = summaryFixture([row('one', 'ready_to_publish', { visibility: 'private' })]);
    posts = [];
    singleResponse = {
      status: 409,
      body: {
        code: 'private_requires_sanitize',
        error: 'A private-destined learning cannot be published by approval. Keep it private, or promote it through sanitize.',
      },
    };
    const result = await runCli(['review'], { HOME: home, AUXILO_BASE_URL: baseUrl }, 'y\n');
    assert.equal(result.code, 0);
    assert.match(result.stderr,
      /A private-destined learning cannot be published by approval\. Keep it private, or promote it through sanitize\./);
  });

  it('bulk --keep-private defaults to needs_your_eyes and --yes bypasses only its safe rail', async () => {
    fixture = summaryFixture();
    posts = [];
    singleResponse = null;
    const result = await runCli(
      ['review', '--keep-private', '--yes'],
      { HOME: home, AUXILO_BASE_URL: baseUrl }
    );
    assert.equal(result.code, 0, result.stderr);
    const bulk = posts.find((p) => p.url === '/account/pending/bulk');
    assert.deepEqual(bulk.body.decisions, [
      { id: 'eyes-public', decision: 'keep_private' },
      { id: 'eyes-private', decision: 'keep_private' },
    ]);
    assert.equal(bulk.body.confirm_count, 2);
    assert.match(result.stdout, /excluded 2 ready_to_publish item/);
    assert.match(result.stdout, /excluded 1 needs_score item/);
  });

  it('bulk keep-private retains counted confirmation when --yes is absent', async () => {
    fixture = summaryFixture();
    posts = [];
    singleResponse = null;
    const result = await runCli(
      ['review', '--keep-private'],
      { HOME: home, AUXILO_BASE_URL: baseUrl },
      '0\n'
    );
    assert.equal(result.code, 0, result.stderr);
    assert.equal(posts.length, 0);
    assert.match(result.stdout, /Type the count \(2\) to confirm/);
    assert.match(result.stdout, /Aborted\. Nothing changed\./);
  });

  it('approve-ready exclusion line is pinned and only public rows reach the bulk endpoint', async () => {
    fixture = summaryFixture([
      row('public', 'ready_to_publish'),
      row('private', 'ready_to_publish', { visibility: 'private' }),
    ]);
    posts = [];
    singleResponse = null;
    const result = await runCli(
      ['review', '--approve-ready'],
      { HOME: home, AUXILO_BASE_URL: baseUrl },
      '1\n'
    );
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout,
      /excluded 1 private-destined item\(s\).*keep-private.*sanitize-promote/i);
    assert.deepEqual(posts[0].body.decisions, [{ id: 'public', decision: 'approve' }]);
  });

  it('triage lines render a priv marker and rapid help includes p', async () => {
    fixture = summaryFixture([row('one', 'needs_your_eyes', { visibility: 'private' })]);
    posts = [];
    singleResponse = null;
    const result = await runCli(['review'], { HOME: home, AUXILO_BASE_URL: baseUrl }, 'q\n');
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /\bpriv\b/);
    assert.match(result.stdout, /\[p\] keep private \(owner-only, \$0 recall\)/);
  });
});

describe('dashboard and MCP private-tier surfaces', () => {
  it('dashboard helper selects needs_your_eyes for keep-private and recognizes private rows', () => {
    const summary = summaryFixture();
    assert.deepEqual(dashboardReview.selectKeepPrivateRows(summary).map((r) => r.id),
      ['eyes-public', 'eyes-private']);
    assert.equal(dashboardReview.isPrivateRow(summary.items[1]), true);
  });

  it('dashboard has per-row and counted bulk keep-private actions with text-only badges', () => {
    assert.match(DASHBOARD_HTML, /Keep private/);
    assert.match(DASHBOARD_HTML, /bulkDecide\('keep_private'\)/);
    assert.match(DASHBOARD_HTML, /decision:\s*decision/);
    assert.match(DASHBOARD_HTML, /kept private \(owner-only\)/);
    assert.match(DASHBOARD_HTML, /textContent = 'priv'/);
    assert.doesNotMatch(DASHBOARD_HTML, /\.innerHTML\s*=/);
  });

  it('MCP keep-private dry-run ids equal its confirmed bulk decisions and supports a single id', () => {
    const plan = planKeepPrivate(summaryFixture());
    const decisions = keepPrivateDecisions(plan);
    assert.deepEqual(plan.would_keep_private.map((r) => r.id),
      decisions.map((d) => d.id));
    assert.ok(decisions.every((d) => d.decision === 'keep_private'));
    assert.match(MCP_SOURCE, /args\.action === 'keep_private'/);
    assert.match(MCP_SOURCE, /args\.id[\s\S]*?keep-private/);
    assert.match(MCP_SOURCE, /decision:\s*'keep_private'/);
    assert.match(MCP_SOURCE, /stays yours; owner-only recall at \$0; never published/i);
  });
});

describe('runner private capture mode', () => {
  const publicLearning = {
    title: 'A sufficiently long technical title',
    body: 'A sufficiently long technical body that exceeds the minimum validation length for extraction.',
    category: 'code-execution',
    tags: ['node'],
    task_context: 'Testing capture visibility.',
    outcome: 'success',
  };
  const nonTechnicalLearning = {
    ...publicLearning,
    title: 'A sufficiently long nontechnical title',
    category: 'non-technical',
  };

  it('env overrides config; config mirrors private mode; invalid or absent stays public', () => {
    assert.equal(runner.resolveCaptureVisibility({ AUXILO_CAPTURE_VISIBILITY: 'private' }, { capture_visibility: 'public' }), 'private');
    assert.equal(runner.resolveCaptureVisibility({}, { capture_visibility: 'private' }), 'private');
    assert.equal(runner.resolveCaptureVisibility({}, {}), 'public');
    assert.equal(runner.resolveCaptureVisibility({ AUXILO_CAPTURE_VISIBILITY: 'bogus' }, { capture_visibility: 'private' }), 'public');
  });

  it('private submissions carry visibility while the default request body omits it', async () => {
    const bodies = [];
    const fetchImpl = async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      return { ok: true, json: async () => ({ id: `lrn_${bodies.length}`, status: 'pending_review' }) };
    };
    await runner.submitLearnings([publicLearning], 'claude-code', {
      fetchImpl, apiKey: 'key', baseUrl: 'https://fixture', captureVisibility: 'private',
      indexPath: path.join(os.tmpdir(), `g1p2-${crypto.randomUUID()}.jsonl`),
    });
    await runner.submitLearnings([publicLearning], 'claude-code', {
      fetchImpl, apiKey: 'key', baseUrl: 'https://fixture', captureVisibility: 'public',
      indexPath: path.join(os.tmpdir(), `g1p2-${crypto.randomUUID()}.jsonl`),
    });
    assert.equal(bodies[0].visibility, 'private');
    assert.equal(Object.hasOwn(bodies[1], 'visibility'), false);
  });

  it('private prompt relaxes scope and accepts non-technical; public prompt stays byte-identical', () => {
    const publicPrompt = extractor.buildExtractionPrompt({ scoreExtraction: false });
    assert.equal(publicPrompt.length, 3084);
    assert.equal(crypto.createHash('sha256').update(publicPrompt).digest('hex'),
      'f80c2230bc463ba862ba4dde04e63aa075421a0b77b594a6a167118234fcf854');
    const privatePrompt = extractor.buildExtractionPrompt({
      scoreExtraction: false,
      captureVisibility: 'private',
    });
    assert.match(privatePrompt, /PRIVATE CAPTURE SCOPE/);
    assert.match(privatePrompt, /non-technical/);
    assert.doesNotMatch(privatePrompt, /HARD SCOPE RULE — TECHNICAL LEARNINGS ONLY/);

    const raw = JSON.stringify({ learnings: [nonTechnicalLearning], dedup_drops: [] });
    assert.equal(extractor.parseLearnings(raw, { captureVisibility: 'public' }).length, 0);
    assert.equal(extractor.parseLearnings(raw, { captureVisibility: 'private' })[0].category,
      'non-technical');
  });

  it('the mandatory local scrub runs identically for public and private capture', () => {
    const transcript = 'Use token sk-abcdefghijklmnopqrstuvwxyz0123456789 and then continue.';
    const publicResult = runner.scrubAndVerify(transcript, { captureVisibility: 'public' });
    const privateResult = runner.scrubAndVerify(transcript, { captureVisibility: 'private' });
    assert.deepEqual(privateResult, publicResult);
    assert.equal(privateResult.report.patterns_matched.length > 0, true);
    assert.equal(privateResult.refused, true);
  });
});
