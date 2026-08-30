'use strict';

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const extractLocal = require('../scripts/extract-local.js');
const runner = require('../scripts/runner.js');
const opsAlert = require('../lib/ops-alert.js');

const RUNNER_PATH = path.join(__dirname, '..', 'scripts', 'runner.js');
const ZERO_STATE = {
  consecutive_skips: 0,
  first_skip_at: null,
  last_skip_at: null,
  last_alert_at: null,
};
const SKIP_RESULT = {
  learnings_published: 0,
  learnings_held: 0,
  learnings_rejected: 0,
  extraction_id: 'client-skip',
};

const tempDirs = [];
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auxilo-ext-0806b-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

function mustFunction(object, name) {
  assert.equal(typeof object[name], 'function', `${name} must be exported for focused verification`);
  return object[name];
}

function spawnQueue(responses) {
  const calls = [];
  const spawnSyncImpl = (bin, args, opts) => {
    calls.push({ bin, args, opts });
    assert.ok(responses.length, `unexpected spawn: ${bin} ${args.join(' ')}`);
    return responses.shift();
  };
  return { calls, spawnSyncImpl };
}

function authJson(loggedIn) {
  return { status: 0, stdout: JSON.stringify({ loggedIn }), stderr: '' };
}

function skipOutcome(reasonCode, extra = {}) {
  return {
    skipped: true,
    reasonCode,
    result: { ...SKIP_RESULT },
    ...extra,
  };
}

describe('EXT-0806b Claude auth and cause classification', () => {
  it('uses a five-second authoritative pre-check and returns logged-in, logged-out, or unknown', () => {
    const check = mustFunction(extractLocal, 'checkClaudeAuthStatus');
    const fixtures = [
      [authJson(true), 'logged-in'],
      [authJson(false), 'logged-out'],
      [{ status: 1, stdout: '', stderr: 'failed' }, 'unknown'],
      [{ status: 0, stdout: 'not json', stderr: '' }, 'unknown'],
      [{ status: 0, stdout: '{}', stderr: '' }, 'unknown'],
    ];

    for (const [response, expected] of fixtures) {
      const stub = spawnQueue([response]);
      assert.equal(check({ spawnSyncImpl: stub.spawnSyncImpl, claudeBin: 'claude' }), expected);
      assert.deepEqual(stub.calls[0].args, ['auth', 'status']);
      assert.equal(stub.calls[0].opts.timeout, 5000);
    }
  });

  it('short-circuits loggedIn:false, while UNKNOWN falls through to the real model call', () => {
    const invoke = mustFunction(extractLocal, 'extractWithClaudeCode');

    const loggedOut = spawnQueue([authJson(false)]);
    const skipped = invoke('transcript', {
      prompt: '', claudeBin: 'claude', spawnSyncImpl: loggedOut.spawnSyncImpl,
    });
    assert.equal(skipped.reasonCode, 'cli-unauthenticated');
    assert.equal(skipped.authStatus, 'logged-out');
    assert.equal(loggedOut.calls.length, 1, 'loggedIn:false must not invoke claude -p');

    const unknown = spawnQueue([
      { status: 1, stdout: '', stderr: 'pre-check failed' },
      { status: 0, stdout: '{"learnings":[]}', stderr: '' },
    ]);
    const completed = invoke('transcript', {
      prompt: '', claudeBin: 'claude', spawnSyncImpl: unknown.spawnSyncImpl,
    });
    assert.equal(completed.ok, true);
    assert.equal(completed.authStatus, 'unknown');
    assert.deepEqual(unknown.calls.map((call) => call.args), [['auth', 'status'], ['-p']]);
  });

  it('maps auth regex, non-zero model exit, and spawn failure to the exact three reason codes', () => {
    const invoke = mustFunction(extractLocal, 'extractWithClaudeCode');
    const cases = [
      [{ status: 0, stdout: 'Not logged in - Please run /login', stderr: '' }, 'cli-unauthenticated'],
      [{ status: 0, stdout: '', stderr: 'authentication_error' }, 'cli-unauthenticated'],
      [{ status: 1, stdout: '', stderr: 'API Error: 400 bad transcript' }, 'model-error'],
      [{ error: Object.assign(new Error('spawn failed'), { code: 'ENOENT' }), stdout: '', stderr: '' }, 'unknown'],
    ];

    for (const [modelResponse, reasonCode] of cases) {
      const stub = spawnQueue([authJson(true), modelResponse]);
      const result = invoke('transcript', {
        prompt: '', claudeBin: 'claude', spawnSyncImpl: stub.spawnSyncImpl,
      });
      assert.equal(result.ok, false);
      assert.equal(result.reasonCode, reasonCode);
      assert.equal(result.authStatus, 'logged-in');
      if (reasonCode === 'cli-unauthenticated') {
        assert.equal(result.authDiscrepancy, true, 'loggedIn:true disagreement must survive for logging');
      }
    }
  });
});

describe('EXT-0806b truthful result rendering', () => {
  it('renders every skip cause with ⊘ + extraction SKIPPED and never with a checkmark', () => {
    const render = mustFunction(runner, 'renderExtractionResult');
    for (const reasonCode of ['cli-unauthenticated', 'model-error', 'unknown']) {
      const line = render(skipOutcome(reasonCode), { consecutiveSkips: 3, sessionFile: '/tmp/session.jsonl' });
      assert.match(line, /⊘/);
      assert.match(line, /extraction SKIPPED/);
      assert.match(line, new RegExp(reasonCode));
      assert.doesNotMatch(line, /✓/);
    }

    const real = render({
      skipped: false,
      result: { learnings_published: 1, learnings_held: 0, learnings_rejected: 0, extraction_id: 'client-real' },
    });
    assert.match(real, /✓/);
    assert.doesNotMatch(real, /extraction SKIPPED/);
  });

  it('shows the loggedIn:true discrepancy and only the basename on model-error token lines', () => {
    const render = mustFunction(runner, 'renderExtractionResult');
    const discrepancy = render(skipOutcome('cli-unauthenticated', {
      authStatus: 'logged-in', authDiscrepancy: true,
    }), { consecutiveSkips: 2, sessionFile: '/private/sessions/auth.jsonl' });
    assert.match(discrepancy, /loggedIn:true/);

    const modelError = render(skipOutcome('model-error'), {
      sessionFile: '/private/sessions/repeat-offender.jsonl',
    });
    assert.match(modelError, /repeat-offender\.jsonl/);
    assert.doesNotMatch(modelError, /\/private\/sessions/);
  });

  it('routes all three production caller sites through the shared renderer', () => {
    const source = fs.readFileSync(RUNNER_PATH, 'utf8');
    const mainBody = source.slice(source.indexOf('async function main()'), source.indexOf('// ─── Exports'));
    assert.equal((mainBody.match(/renderExtractionResult\(/g) || []).length, 3);
    assert.equal((mainBody.match(/log\(`\[runner\].*✓/g) || []).length, 0,
      'caller sites must not stamp their own unconditional checkmark');
  });

  it('defers caller tokens until the finalized run-level consecutive count is known', async () => {
    const finalize = mustFunction(runner, 'finalizeExtractionRun');
    const render = mustFunction(runner, 'renderExtractionResult');
    const statePath = path.join(tempDir(), 'state.json');
    fs.writeFileSync(statePath, JSON.stringify({
      consecutive_skips: 5,
      first_skip_at: '2026-08-25T00:00:00.000Z',
      last_skip_at: '2026-08-29T00:00:00.000Z',
      last_alert_at: null,
    }));
    const finalState = await finalize([
      skipOutcome('cli-unauthenticated'),
      { skipped: false, result: { extraction_id: 'client-real' } },
    ], { statePath, log: () => {} });
    const line = render(skipOutcome('cli-unauthenticated'), {
      consecutiveSkips: finalState.consecutive_skips,
    });
    assert.match(line, /consecutive=0$/);

    const source = fs.readFileSync(RUNNER_PATH, 'utf8');
    const mainBody = source.slice(source.indexOf('async function main()'), source.indexOf('// ─── Exports'));
    assert.equal((mainBody.match(/extractionResultLines\.push\(/g) || []).length, 3);
    assert.doesNotMatch(mainBody, /projectedConsecutiveSkips/);
  });

  it('keeps postExtract return value frozen at the exact downstream four-key shape', async () => {
    mustFunction(runner, 'postExtractDetailed');
    const extractLocally = async () => ({
      learnings: [], skipped: 'model rejected transcript', reasonCode: 'model-error', authStatus: 'logged-in',
    });
    const result = await runner.postExtract('transcript', 'session-id', 'claude-code', {}, {
      extractLocally, log: () => {}, sessionFile: '/tmp/session.jsonl',
    });
    assert.deepEqual(result, SKIP_RESULT);
    assert.deepEqual(Object.keys(result), Object.keys(SKIP_RESULT));
  });
});

describe('EXT-0806b persistent once-per-run state and alerting', () => {
  it('increments once for a run containing multiple unauthenticated session outcomes', async () => {
    const finalize = mustFunction(runner, 'finalizeExtractionRun');
    const statePath = path.join(tempDir(), 'extraction-skip-state.json');
    const state = await finalize([
      skipOutcome('cli-unauthenticated'),
      skipOutcome('cli-unauthenticated'),
    ], {
      statePath, now: () => '2026-08-30T12:00:00.000Z', threshold: 99,
      sendOpsAlert: async () => {}, log: () => {},
    });
    assert.equal(state.consecutive_skips, 1);
    assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).consecutive_skips, 1);
  });

  it('resets after a real success or a real model failure', async () => {
    const finalize = mustFunction(runner, 'finalizeExtractionRun');
    for (const outcome of [
      { skipped: false, result: { extraction_id: 'client-real' } },
      skipOutcome('model-error'),
    ]) {
      const statePath = path.join(tempDir(), 'state.json');
      fs.writeFileSync(statePath, JSON.stringify({
        consecutive_skips: 7,
        first_skip_at: '2026-08-20T00:00:00.000Z',
        last_skip_at: '2026-08-29T00:00:00.000Z',
        last_alert_at: '2026-08-29T00:00:00.000Z',
      }));
      const state = await finalize([outcome], {
        statePath, now: () => '2026-08-30T12:00:00.000Z', sendOpsAlert: async () => {}, log: () => {},
      });
      assert.deepEqual(state, {
        ...ZERO_STATE,
        last_alert_at: '2026-08-29T00:00:00.000Z',
      });
    }
  });

  it('leaves the counter unchanged and never alerts for UNKNOWN', async () => {
    const finalize = mustFunction(runner, 'finalizeExtractionRun');
    const statePath = path.join(tempDir(), 'state.json');
    const original = {
      consecutive_skips: 3,
      first_skip_at: '2026-08-27T00:00:00.000Z',
      last_skip_at: '2026-08-29T00:00:00.000Z',
      last_alert_at: '2026-08-29T00:00:00.000Z',
    };
    fs.writeFileSync(statePath, JSON.stringify(original));
    const alerts = [];
    const state = await finalize([skipOutcome('unknown')], {
      statePath,
      now: () => '2026-08-30T12:00:00.000Z',
      threshold: 2,
      sendOpsAlert: async (...args) => alerts.push(args),
      log: () => {},
    });
    assert.deepEqual(state, original);
    assert.deepEqual(JSON.parse(fs.readFileSync(statePath, 'utf8')), original);
    assert.equal(alerts.length, 0);
  });

  it('treats missing, corrupt, or non-timestamp state as exact four-key zeros and logs one warning', () => {
    const load = mustFunction(runner, 'loadExtractionSkipState');
    for (const fixture of ['missing', 'invalid-json', 'invalid-timestamp']) {
      const statePath = path.join(tempDir(), 'state.json');
      if (fixture === 'invalid-json') fs.writeFileSync(statePath, '{not-json');
      if (fixture === 'invalid-timestamp') {
        fs.writeFileSync(statePath, JSON.stringify({
          consecutive_skips: 1,
          first_skip_at: '/private/session-owner/secret-session.jsonl',
          last_skip_at: '2026-08-30T12:00:00.000Z',
          last_alert_at: null,
        }));
      }
      const warnings = [];
      const state = load({ statePath, log: (line) => warnings.push(String(line)) });
      assert.deepEqual(state, ZERO_STATE);
      assert.deepEqual(Object.keys(state).sort(), Object.keys(ZERO_STATE).sort());
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /state|skip/i);
    }
  });

  it('saves state atomically with a temporary write followed by rename', () => {
    const save = mustFunction(runner, 'saveExtractionSkipState');
    const calls = [];
    const fsImpl = {
      mkdirSync: (...args) => calls.push(['mkdir', ...args]),
      writeFileSync: (...args) => calls.push(['write', ...args]),
      renameSync: (...args) => calls.push(['rename', ...args]),
    };
    const statePath = '/tmp/ext-0806b-state.json';
    save({ ...ZERO_STATE, consecutive_skips: 2 }, { statePath, fsImpl });
    const write = calls.find((call) => call[0] === 'write');
    const rename = calls.find((call) => call[0] === 'rename');
    assert.ok(write[1].startsWith(`${statePath}.tmp`));
    assert.deepEqual(rename.slice(1), [write[1], statePath]);
    assert.ok(calls.indexOf(write) < calls.indexOf(rename));
  });

  it('swallows skip-state persistence failure so visibility never breaks a sweep', async () => {
    const finalize = mustFunction(runner, 'finalizeExtractionRun');
    const logs = [];
    const alerts = [];
    const state = await finalize([skipOutcome('cli-unauthenticated')], {
      state: { ...ZERO_STATE },
      statePath: '/tmp/ext-0806b-unwritable/state.json',
      fsImpl: {
        mkdirSync: () => { throw new Error('read-only filesystem'); },
      },
      now: () => '2026-08-30T12:00:00.000Z',
      threshold: 1,
      sendOpsAlert: async (...args) => alerts.push(args),
      log: (line) => logs.push(String(line)),
    });
    assert.equal(state.consecutive_skips, 1);
    assert.equal(alerts.length, 0, 'never alert until the durable dedup marker is armed');
    assert.ok(logs.some((line) => /state.*write.*read-only filesystem/i.test(line)));
  });

  it('alerts at 2 and 4, never 1 or 3', async () => {
    const finalize = mustFunction(runner, 'finalizeExtractionRun');
    const statePath = path.join(tempDir(), 'state.json');
    const alerts = [];
    const times = [0, 21, 42, 63].map((hours) => new Date(Date.UTC(2026, 7, 28, hours)).toISOString());
    const counts = [];
    for (const timestamp of times) {
      const state = await finalize([skipOutcome('cli-unauthenticated')], {
        statePath, now: () => timestamp, threshold: 2,
        sendOpsAlert: async (...args) => alerts.push(args), log: () => {},
      });
      counts.push(state.consecutive_skips);
    }
    assert.deepEqual(counts, [1, 2, 3, 4]);
    assert.equal(alerts.length, 2);
    assert.match(String(alerts[0][1]), /consecutive[^\d]*2/i);
    assert.match(String(alerts[1][1]), /consecutive[^\d]*4/i);
  });

  it('deduplicates threshold alerts inside twenty hours', async () => {
    const finalize = mustFunction(runner, 'finalizeExtractionRun');
    const statePath = path.join(tempDir(), 'state.json');
    fs.writeFileSync(statePath, JSON.stringify({
      consecutive_skips: 3,
      first_skip_at: '2026-08-29T00:00:00.000Z',
      last_skip_at: '2026-08-30T10:00:00.000Z',
      last_alert_at: '2026-08-30T10:00:00.000Z',
    }));
    const alerts = [];
    const reset = await finalize([{ skipped: false, result: { extraction_id: 'client-real' } }], {
      statePath, now: () => '2026-08-30T10:30:00.000Z', threshold: 2,
      sendOpsAlert: async (...args) => alerts.push(args), log: () => {},
    });
    assert.equal(reset.consecutive_skips, 0);
    assert.equal(reset.last_alert_at, '2026-08-30T10:00:00.000Z');
    await finalize([skipOutcome('cli-unauthenticated')], {
      statePath, now: () => '2026-08-30T11:00:00.000Z', threshold: 2,
      sendOpsAlert: async (...args) => alerts.push(args), log: () => {},
    });
    const state = await finalize([skipOutcome('cli-unauthenticated')], {
      statePath, now: () => '2026-08-30T12:00:00.000Z', threshold: 2,
      sendOpsAlert: async (...args) => alerts.push(args), log: () => {},
    });
    assert.equal(state.consecutive_skips, 2);
    assert.equal(alerts.length, 0);
    assert.equal(state.last_alert_at, '2026-08-30T10:00:00.000Z');
  });

  it('swallows alert delivery failure without failing the run', async () => {
    const finalize = mustFunction(runner, 'finalizeExtractionRun');
    const statePath = path.join(tempDir(), 'state.json');
    fs.writeFileSync(statePath, JSON.stringify({
      consecutive_skips: 1,
      first_skip_at: '2026-08-29T00:00:00.000Z',
      last_skip_at: '2026-08-29T00:00:00.000Z',
      last_alert_at: null,
    }));
    const logs = [];
    const state = await finalize([skipOutcome('cli-unauthenticated')], {
      statePath, now: () => '2026-08-30T12:00:00.000Z', threshold: 2,
      sendOpsAlert: async () => { throw new Error('delivery down'); },
      log: (line) => logs.push(String(line)),
    });
    assert.equal(state.consecutive_skips, 2);
    assert.ok(logs.some((line) => /alert.*delivery down|delivery down.*alert/i.test(line)));
  });

  it('alert payload contains counts/timestamps/remediation plus platform/arch only', async () => {
    const finalize = mustFunction(runner, 'finalizeExtractionRun');
    const statePath = path.join(tempDir(), 'state.json');
    fs.writeFileSync(statePath, JSON.stringify({
      consecutive_skips: 1,
      first_skip_at: '2026-08-29T00:00:00.000Z',
      last_skip_at: '2026-08-29T00:00:00.000Z',
      last_alert_at: null,
    }));
    const alerts = [];
    await finalize([skipOutcome('cli-unauthenticated', {
      sessionFile: '/private/session-owner/secret-session.jsonl', transcript: 'never send me',
    })], {
      statePath, now: () => '2026-08-30T12:00:00.000Z', threshold: 2,
      platform: 'test-platform', arch: 'test-arch',
      sendOpsAlert: async (...args) => alerts.push(args), log: () => {},
    });
    assert.equal(alerts.length, 1);
    const payload = `${alerts[0][0]}\n${alerts[0][1]}`;
    assert.match(payload, /test-platform/);
    assert.match(payload, /test-arch/);
    assert.match(payload, /2026-08-29T00:00:00\.000Z/);
    assert.match(payload, /run `claude` and \/login/);
    assert.doesNotMatch(payload, /session-owner|secret-session|never send me|hostname|username|\/private\//i);

    assert.deepEqual(alerts[0][2], { category: 'extraction-skip', omitHost: true });

    const saved = {
      key: process.env.RESEND_API_KEY,
      to: process.env.OPS_ALERT_EMAIL,
      baseUrl: process.env.BASE_URL,
      fetch: global.fetch,
    };
    let delivered;
    try {
      process.env.RESEND_API_KEY = 'test-key';
      process.env.OPS_ALERT_EMAIL = 'ops@example.invalid';
      process.env.BASE_URL = 'https://session-owner.example.invalid';
      global.fetch = async (_url, init) => {
        delivered = JSON.parse(init.body);
        return { ok: true, status: 202 };
      };
      opsAlert._resetOpsAlertStateForTests();
      const result = await opsAlert.sendOpsAlert('subject', payload, {
        category: 'extraction-skip-identity-test',
        omitHost: true,
      });
      assert.equal(result.ok, true);
      assert.doesNotMatch(delivered.text, /session-owner|— host:/i);
    } finally {
      if (saved.key === undefined) delete process.env.RESEND_API_KEY;
      else process.env.RESEND_API_KEY = saved.key;
      if (saved.to === undefined) delete process.env.OPS_ALERT_EMAIL;
      else process.env.OPS_ALERT_EMAIL = saved.to;
      if (saved.baseUrl === undefined) delete process.env.BASE_URL;
      else process.env.BASE_URL = saved.baseUrl;
      global.fetch = saved.fetch;
      opsAlert._resetOpsAlertStateForTests();
    }
  });
});

describe('EXT-0806b status surface', () => {
  it('writes ledger.lastRealExtractionAt only for a completed real extraction', () => {
    const stamp = mustFunction(runner, 'recordRealExtractionCompletion');
    const ledger = { sources: {}, lastSweep: null };
    const now = () => '2026-08-30T11:00:00.000Z';

    assert.equal(stamp(ledger, skipOutcome('model-error'), { now }), false);
    assert.equal(ledger.lastRealExtractionAt, undefined);
    assert.equal(stamp(ledger, {
      skipped: false,
      result: { extraction_id: 'client-real' },
    }, { now }), true);
    assert.equal(ledger.lastRealExtractionAt, '2026-08-30T11:00:00.000Z');
  });

  it('renders OK with a valid ledger last-real-extraction timestamp', () => {
    const render = mustFunction(runner, 'renderExtractionStatus');
    assert.equal(render({
      state: { ...ZERO_STATE },
      ledger: { lastRealExtractionAt: '2026-08-30T11:00:00.000Z' },
      authStatus: 'logged-in',
    }), 'Extraction: OK (last real extraction 2026-08-30T11:00:00.000Z)');
  });

  it('renders SKIPPING since/count/remedy and explicitly exposes loggedIn:false', () => {
    const render = mustFunction(runner, 'renderExtractionStatus');
    const line = render({
      state: {
        consecutive_skips: 3,
        first_skip_at: '2026-08-29T00:00:00.000Z',
        last_skip_at: '2026-08-30T00:00:00.000Z',
        last_alert_at: null,
      },
      ledger: { lastRealExtractionAt: '2026-08-28T00:00:00.000Z' },
      authStatus: 'logged-out',
    });
    assert.match(line, /^Extraction: SKIPPING since 2026-08-29T00:00:00\.000Z/);
    assert.match(line, /3 consecutive/);
    assert.match(line, /loggedIn:false/);
    assert.match(line, /run `claude auth login`/);
  });

  it('reports loggedIn:false even before a counter exists', () => {
    const render = mustFunction(runner, 'renderExtractionStatus');
    const line = render({ state: { ...ZERO_STATE }, ledger: {}, authStatus: 'logged-out' });
    assert.match(line, /loggedIn:false/);
    assert.match(line, /claude auth login/);
    assert.doesNotMatch(line, /^Extraction: OK/);
  });

  it('degrades missing or corrupt lastRealExtractionAt to state-only output without throwing', () => {
    const render = mustFunction(runner, 'renderExtractionStatus');
    for (const lastRealExtractionAt of [
      undefined,
      null,
      'not-a-timestamp',
      '2026-08-30',
      '2026-02-30T00:00:00.000Z',
      42,
    ]) {
      assert.doesNotThrow(() => {
        const line = render({
          state: { ...ZERO_STATE }, ledger: { lastRealExtractionAt }, authStatus: 'logged-in',
        });
        assert.equal(line, 'Extraction: OK (last real extraction unavailable)');
      });
    }
  });
});
