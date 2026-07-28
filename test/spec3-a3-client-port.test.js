'use strict';

/**
 * SPEC3-A3 — CLI/dashboard three-lane port + hook status + CLI help/input.
 *
 * Runner: node --test test/spec3-a3-client-port.test.js
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const cli = require('../bin/auxilo-cli.js');
const review = require('../lib/review.js');
const installer = require('../lib/installer.js');
const dashboardReview = require('../public/dashboard-review.js');
const { hasAuxiloSessionEndHook } = require('../lib/hook-status.js');

const CLI_PATH = path.join(__dirname, '..', 'bin', 'auxilo-cli.js');
const RUNNER_PATH = path.join(__dirname, '..', 'scripts', 'runner.js');

function row(id, lane, quality, overrides = {}) {
  return {
    id,
    lane,
    quality,
    screens_passed: lane !== 'needs_your_eyes',
    flags: [],
    category: 'code-execution',
    title: `Title ${id}`,
    created_at: '2026-07-26T00:00:00.000Z',
    ...overrides,
  };
}

function fixtureSummary() {
  return {
    pending_count: 6,
    approvable_count: 2,
    counts: {
      by_lane: { ready_to_publish: 2, needs_score: 2, needs_your_eyes: 2 },
      by_quality_band: { '18-20': 2, '14-17': 2, '10-13': 1, below_10: 0, unscored: 1 },
    },
    items: [
      row('ready18', 'ready_to_publish', 18),
      row('ready14', 'ready_to_publish', 14),
      row('score13', 'needs_score', 13),
      row('score-null', 'needs_score', null),
      row('advice19', 'needs_your_eyes', 19, {
        screens_passed: false,
        flags: ['process_advice'],
        why: 'This is process/workflow advice rather than a reusable system fact.',
      }),
      row('vocab20', 'needs_your_eyes', 20, {
        screens_passed: false,
        flags: ['account_vocab'],
        why: 'This term recurs only in your private account vocabulary.',
      }),
    ],
  };
}

function runNode(script, args, env, input = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`timed out: ${path.basename(script)} ${args.join(' ')}`));
    }, 10000);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

describe('SPEC3-A3 CLI lane rendering and selection', () => {
  let home;
  let server;
  let baseUrl;
  let requestCount = 0;
  let mutationCount = 0;

  before(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'auxilo-spec3-a3-'));
    fs.mkdirSync(path.join(home, '.auxilo'), { recursive: true });

    server = http.createServer((req, res) => {
      requestCount += 1;
      res.setHeader('content-type', 'application/json');
      if (req.method === 'GET' && req.url.startsWith('/account/pending/summary')) {
        res.end(JSON.stringify(fixtureSummary()));
        return;
      }
      if (req.method === 'GET' && req.url.startsWith('/account/pending')) {
        const learnings = fixtureSummary().items.map((item) => ({
          ...item,
          body: `FULL BODY ${item.id}`,
        }));
        res.end(JSON.stringify({ pending_count: learnings.length, learnings }));
        return;
      }
      if (req.method === 'POST') {
        mutationCount += 1;
        res.end(JSON.stringify({ approved: 0, rejected: 0, idempotent: 0, failed: 0, results: [] }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'not found' }));
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

  it('renders all three lane names in order, both new flag codes, and per-row why', () => {
    const lines = [];
    const original = console.log;
    console.log = (...args) => lines.push(args.join(' '));
    try {
      cli.printSummaryTable(fixtureSummary());
    } finally {
      console.log = original;
    }
    const out = lines.join('\n');
    assert.ok(out.indexOf('READY TO PUBLISH') < out.indexOf('NEEDS A SCORE'));
    assert.ok(out.indexOf('NEEDS A SCORE') < out.indexOf('NEEDS YOUR EYES'));
    assert.match(out, /\badvice\b/);
    assert.match(out, /\bvocab\b/);
    assert.match(out, /why: This is process\/workflow advice/);
    assert.match(out, /why: This term recurs only/);
    assert.doesNotMatch(out, /^\s*CLEAN\b/m);
  });

  it('selects the server verdict exactly, narrows above 14, and broadens below 14', () => {
    const rows = fixtureSummary().items;
    const dflt = review.selectForBulkApprove(rows, { mode: 'ready' });
    assert.deepEqual(dflt.selected.map((r) => r.id), ['ready18', 'ready14']);

    const strict = review.selectForBulkApprove(rows, { mode: 'ready', minQuality: 16 });
    assert.deepEqual(strict.selected.map((r) => r.id), ['ready18']);

    const broad = review.selectForBulkApprove(rows, { mode: 'ready', minQuality: 0 });
    assert.deepEqual(broad.selected.map((r) => r.id), ['ready18', 'ready14', 'score13', 'score-null']);
    assert.deepEqual(broad.included_beyond_verdict.map((r) => r.id), ['score13', 'score-null']);
  });

  it('prints the beyond-verdict warning and exact exclusion arithmetic on bulk paths', async () => {
    mutationCount = 0;
    const env = { HOME: home, AUXILO_BASE_URL: baseUrl };

    const broad = await runNode(CLI_PATH, ['review', '--approve-ready', '--min-quality', '0'], env, '0\n');
    assert.equal(broad.code, 0, broad.stderr);
    assert.match(broad.stdout, /approvable_count=2\); including 2 items from needs_score/);
    assert.match(broad.stdout, /excluded 2 needs_your_eyes item/);

    const dflt = await runNode(CLI_PATH, ['review', '--approve-ready'], env, '0\n');
    assert.equal(dflt.code, 0, dflt.stderr);
    assert.match(dflt.stdout, /excluded 2 needs_your_eyes item/);
    assert.match(dflt.stdout, /excluded 1 below the quality threshold/);
    assert.match(dflt.stdout, /excluded 1 with no quality score/);

    const all = await runNode(CLI_PATH, ['review', '--all'], env, '0\n');
    assert.equal(all.code, 0, all.stderr);
    assert.match(all.stdout, /Excluding 2 needs_your_eyes item/);
    assert.equal(mutationCount, 0, 'wrong typed counts must abort every approve path before POST');
  });

  it('keeps --approve-clean as a hidden alias with a one-line rename notice', async () => {
    const result = await runNode(
      CLI_PATH,
      ['review', '--approve-clean'],
      { HOME: home, AUXILO_BASE_URL: baseUrl },
      '0\n'
    );
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /--approve-clean was renamed to --approve-ready/);
    assert.match(result.stdout, /approve-ready selection: 2 of 6/);
  });

  it('prints every subcommand help block with exit 0 and zero network calls', async () => {
    const commands = ['setup', 'init', 'status', 'review', 'disable'];
    const beforeRequests = requestCount;
    for (const command of commands) {
      const result = await runNode(
        CLI_PATH,
        [command, '--help'],
        { HOME: home, AUXILO_BASE_URL: baseUrl }
      );
      assert.equal(result.code, 0, `${command}: ${result.stderr}`);
      assert.match(result.stdout, new RegExp(`Usage: auxilo ${command}`));
    }
    assert.equal(requestCount, beforeRequests, 'subcommand help must perform no fetch');
  });

  it('queues piped lines so v then s stays on item one and q reaches item two', async () => {
    const result = await runNode(
      CLI_PATH,
      ['review'],
      { HOME: home, AUXILO_BASE_URL: baseUrl },
      'v\ns\nq\n'
    );
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /FULL BODY ready18/);
    assert.match(result.stdout, /Title ready14/);
    assert.match(result.stdout, /Review complete: approved 0, kept private 0, rejected 0, skipped 1 of 6/);
  });

  it('falls back without crashing when an old server omits lane and prints version skew', () => {
    const legacy = {
      pending_count: 3,
      items: [
        row('old-ready', undefined, 18, { screens_passed: true }),
        row('old-score', undefined, null, { screens_passed: true }),
        row('old-eyes', undefined, 20, { screens_passed: false, flags: ['injection'] }),
      ],
    };
    const grouped = cli.groupSummaryRows(legacy);
    assert.equal(grouped.versionSkew, true);
    assert.deepEqual(grouped.groups.ready_to_publish.map((r) => r.id), ['old-ready']);
    assert.deepEqual(grouped.groups.needs_score.map((r) => r.id), ['old-score']);
    assert.deepEqual(grouped.groups.needs_your_eyes.map((r) => r.id), ['old-eyes']);
  });

  it('feeds CLI status hookInstalled from the shared object/string helper', async () => {
    const settingsDir = path.join(home, '.claude');
    fs.mkdirSync(settingsDir, { recursive: true });
    fs.writeFileSync(path.join(settingsDir, 'settings.json'), JSON.stringify({
      hooks: { SessionEnd: [{ hooks: [{ type: 'command', command: '/tmp/auxilo-extract.sh' }] }] },
    }));
    const status = await installer.getStatus(home, { fetchImpl: async () => ({ ok: false }) });
    assert.equal(status.hookInstalled, true);
  });
});

describe('SPEC3-A3 shared hook checker', () => {
  let home;

  before(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'auxilo-spec3-a3-hook-'));
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  });

  after(() => fs.rmSync(home, { recursive: true, force: true }));

  async function runnerStatus(sessionEnd) {
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({
      hooks: { SessionEnd: sessionEnd },
    }));
    return runNode(RUNNER_PATH, ['--status'], { HOME: home });
  }

  it('object-shape SessionEnd fixture reports yes and prints the inspected path', async () => {
    const shape = [{ matcher: '', hooks: [{ type: 'command', command: '/x/auxilo-extract.sh' }] }];
    assert.equal(hasAuxiloSessionEndHook(shape), true);
    const result = await runnerStatus(shape);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Hook installed: yes/);
    assert.match(result.stdout, new RegExp(`Settings inspected: ${home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/\\.claude/settings\\.json`));
  });

  it('legacy string SessionEnd fixture reports yes', async () => {
    const shape = ['/x/auxilo-extract.sh'];
    assert.equal(hasAuxiloSessionEndHook(shape), true);
    const result = await runnerStatus(shape);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Hook installed: yes/);
  });

  it('absent Auxilo SessionEnd fixture reports no', async () => {
    const shape = [{ hooks: [{ type: 'command', command: '/x/something-else.sh' }] }];
    assert.equal(hasAuxiloSessionEndHook(shape), false);
    const result = await runnerStatus(shape);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Hook installed: no/);
  });
});

describe('SPEC3-A3 dashboard lane logic', () => {
  it('groups in lane order using counts.by_lane and selects only ready rows', () => {
    const summary = fixtureSummary();
    const grouped = dashboardReview.groupRows(summary);
    assert.deepEqual(grouped.order, ['ready_to_publish', 'needs_score', 'needs_your_eyes']);
    assert.deepEqual(grouped.counts, summary.counts.by_lane);
    assert.deepEqual(dashboardReview.selectReadyRows(summary).map((r) => r.id), ['ready18', 'ready14']);
  });

  it('falls back to legacy grouping with a version-skew signal', () => {
    const grouped = dashboardReview.groupRows({
      items: [
        { id: 'a', screens_passed: true, quality: 14 },
        { id: 'b', screens_passed: true, quality: null },
        { id: 'c', screens_passed: false, quality: 20 },
      ],
    });
    assert.equal(grouped.versionSkew, true);
    assert.deepEqual(grouped.counts, {
      ready_to_publish: 1,
      needs_score: 1,
      needs_your_eyes: 1,
    });
  });

  it('dashboard rendering uses select-ready lane logic and plain-text why output', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'dashboard.html'), 'utf8');
    assert.match(html, /AuxiloReviewLanes\.selectReadyRows\(summary\)/);
    assert.match(html, /Select ready to publish/);
    assert.match(html, /why\.textContent = row\.why/);
    assert.doesNotMatch(html, /Select clean/);
  });
});
