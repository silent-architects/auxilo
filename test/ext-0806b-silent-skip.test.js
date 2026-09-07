'use strict';

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const extractLocal = require('../scripts/extract-local.js');
const runner = require('../scripts/runner.js');
const opsAlert = require('../lib/ops-alert.js');

const RUNNER_PATH = path.join(__dirname, '..', 'scripts', 'runner.js');
const ZERO_STATE = {
  consecutive_skips: 0,
  consecutive_unknown: 0,
  first_skip_at: null,
  last_skip_at: null,
  last_alert_at: null,
  // EXTRACT-PER-CLIENT W1 PART C: last_reason_code, additive to this shape.
  last_reason_code: null,
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

function installFakeLoggedOutClaude(home) {
  const script = '#!/bin/sh\nprintf \'%s\\n\' \'{"loggedIn":false}\'\n';
  const paths = [
    path.join(home, '.claude', 'local', 'claude'),
    path.join(home, 'bin', 'claude'),
  ];
  for (const filePath of paths) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, script, { mode: 0o700 });
    fs.chmodSync(filePath, 0o700);
  }
  return path.join(home, 'bin');
}

function clientRunnerEnv(home) {
  const env = {
    ...process.env,
    HOME: home,
    PATH: installFakeLoggedOutClaude(home),
    AUXILO_API_KEY: 'focused-test-key',
    AUXILO_NO_NOTIFY: '1',
    AUXILO_SKIP_ALERT_THRESHOLD: '99',
  };
  delete env.AUXILO_EXTRACTING;
  delete env.RESEND_API_KEY;
  delete env.OPS_ALERT_EMAIL;
  return env;
}

function enableClientRunner(home) {
  const auxiloDir = path.join(home, '.auxilo');
  fs.mkdirSync(auxiloDir, { recursive: true });
  fs.writeFileSync(path.join(auxiloDir, 'autonomous-enabled'), 'enabled\n');
}

describe('EXT-0806b Claude auth and cause classification', () => {
  it('prefers an existing absolute Claude binary before falling back to PATH', () => {
    const resolve = mustFunction(extractLocal, 'resolveClaudeBin');
    const checked = [];
    const resolved = resolve({
      homeDir: '/fixture/home',
      existsSync: (candidate) => {
        checked.push(candidate);
        return candidate === '/opt/homebrew/bin/claude';
      },
    });
    assert.equal(resolved, '/opt/homebrew/bin/claude');
    assert.deepEqual(checked, [
      '/fixture/home/.claude/local/claude',
      '/usr/local/bin/claude',
      '/opt/homebrew/bin/claude',
    ]);
    assert.equal(resolve({ homeDir: '/fixture/home', existsSync: () => false }), 'claude');
  });

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
    assert.match(skipped.reason, /claude auth login/);
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
    // EXTRACT-TOOLS-LOCK (PUNCH-LIST): the extraction spawn now carries
    // '--tools',''  — the same tool-lock the dedup judge always had — so the
    // stdin-fed model can't reach outside the transcript it was given.
    // EXTRACT-PER-CLIENT W1 FIX GIVENS: it also carries
    // '--no-session-persistence', matching the judge spawn.
    // EXTRACTION-CHILD-HOOKS (0.9.15): and '--setting-sources',''  — the child
    // loads none of the operator's own user/project/local settings, so their
    // personal SessionStart hooks never fire into this prompt.
    assert.deepEqual(unknown.calls.map((call) => call.args), [['auth', 'status'], ['-p', '--no-session-persistence', '--tools', '', '--setting-sources', '']]);
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
      assert.match(line, /session=session\.jsonl/);
      assert.doesNotMatch(line, /\/tmp\//);
      assert.doesNotMatch(line, /✓/);
    }

    const real = render({
      skipped: false,
      result: { learnings_published: 1, learnings_held: 0, learnings_rejected: 0, extraction_id: 'client-real' },
    });
    assert.match(real, /✓/);
    assert.doesNotMatch(real, /extraction SKIPPED/);

    const idOnlySkip = render({
      skipped: false,
      reasonCode: 'unknown',
      result: { ...SKIP_RESULT },
    }, { sessionFile: '/tmp/id-only.jsonl' });
    assert.match(idOnlySkip, /⊘ extraction SKIPPED/);
    assert.match(idOnlySkip, /session=id-only\.jsonl/);
    assert.doesNotMatch(idOnlySkip, /✓/);
  });

  it('shows the loggedIn:true discrepancy and only basenames on every skip token line', () => {
    const render = mustFunction(runner, 'renderExtractionResult');
    const discrepancy = render(skipOutcome('cli-unauthenticated', {
      authStatus: 'logged-in', authDiscrepancy: true,
    }), { consecutiveSkips: 2, sessionFile: '/private/sessions/auth.jsonl' });
    assert.match(discrepancy, /loggedIn:true/);
    assert.match(discrepancy, /session=auth\.jsonl/);
    assert.match(discrepancy, /claude auth login/);
    assert.doesNotMatch(discrepancy, /\/private\/sessions/);

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

    const flushBody = mainBody.slice(mainBody.indexOf('// ── Flush pending'), mainBody.indexOf('// ── Enumerate sources'));
    assert.doesNotMatch(flushBody, /const flushLedger = loadLedger\(\)/,
      'flush must not hold a whole-ledger snapshot across the extraction loop');
    assert.match(flushBody, /persistRealExtractionCompletion\(/);

    const sweepTail = mainBody.slice(mainBody.lastIndexOf('for (const [sourceType, count]'), mainBody.lastIndexOf('notifyHeld(totalHeld)'));
    const finalSaveIndex = sweepTail.lastIndexOf('saveLedger(ledger)');
    const finalFinishIndex = sweepTail.lastIndexOf('await finishExtractionRun()');
    assert.ok(finalSaveIndex >= 0, 'sweep final ledger save must exist');
    assert.ok(finalFinishIndex >= 0, 'sweep extraction finalizer must exist');
    assert.ok(finalSaveIndex < finalFinishIndex,
      'sweep must durably save all ledger marks before finalizing extraction state');
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
        // PART C: a real success carries no reasonCode (null); a real
        // model-error carries its own reasonCode through the reset.
        last_reason_code: outcome.reasonCode || null,
      });
    }
  });

  it('keeps UNKNOWN out of the auth counter, increments its own once per run, and never alerts', async () => {
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
    const state = await finalize([skipOutcome('unknown'), skipOutcome('unknown')], {
      statePath,
      now: () => '2026-08-30T12:00:00.000Z',
      threshold: 2,
      sendOpsAlert: async (...args) => alerts.push(args),
      log: () => {},
    });
    assert.deepEqual(state, { ...original, consecutive_unknown: 1, last_reason_code: 'unknown' });
    assert.deepEqual(JSON.parse(fs.readFileSync(statePath, 'utf8')), state);
    const second = await finalize([skipOutcome('unknown')], {
      statePath,
      now: () => '2026-08-30T13:00:00.000Z',
      threshold: 2,
      sendOpsAlert: async (...args) => alerts.push(args),
      log: () => {},
    });
    assert.equal(second.consecutive_skips, 3);
    assert.equal(second.consecutive_unknown, 2);
    assert.equal(alerts.length, 0);
  });

  it('loads legacy state additively and treats missing/corrupt state as exact five-key zeros without path leakage', () => {
    const load = mustFunction(runner, 'loadExtractionSkipState');
    const legacyPath = path.join(tempDir(), 'legacy-state.json');
    fs.writeFileSync(legacyPath, JSON.stringify({
      consecutive_skips: 2,
      first_skip_at: '2026-08-29T00:00:00.000Z',
      last_skip_at: '2026-08-30T00:00:00.000Z',
      last_alert_at: null,
    }));
    assert.deepEqual(load({ statePath: legacyPath, log: () => {} }), {
      ...ZERO_STATE,
      consecutive_skips: 2,
      first_skip_at: '2026-08-29T00:00:00.000Z',
      last_skip_at: '2026-08-30T00:00:00.000Z',
    });

    for (const fixture of ['missing', 'invalid-json', 'invalid-timestamp']) {
      const privateParent = path.join(tempDir(), 'session-owner-private');
      const statePath = path.join(privateParent, 'extraction-skip-state.json');
      if (fixture !== 'missing') fs.mkdirSync(privateParent, { recursive: true });
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
      if (fixture === 'missing') {
        assert.match(warnings[0], /extraction-skip-state\.json/);
        assert.doesNotMatch(warnings[0], /session-owner-private/);
        assert.doesNotMatch(warnings[0], new RegExp(tempDirs.at(-1).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      }
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
    assert.equal(state.last_alert_at, '2026-08-30T12:00:00.000Z',
      'a configured transient delivery failure may arm the dedup marker');
    assert.ok(logs.some((line) => /alert.*delivery down|delivery down.*alert/i.test(line)));
  });

  it('never arms last_alert_at for unconfigured delivery even when a rollback write would fail', async () => {
    const finalize = mustFunction(runner, 'finalizeExtractionRun');
    const statePath = path.join(tempDir(), 'state.json');
    const initialState = {
      ...ZERO_STATE,
      consecutive_skips: 1,
      first_skip_at: '2026-08-29T00:00:00.000Z',
      last_skip_at: '2026-08-29T00:00:00.000Z',
    };
    let stateWrites = 0;
    const fsImpl = {
      mkdirSync: (...args) => fs.mkdirSync(...args),
      writeFileSync: (...args) => {
        stateWrites++;
        if (stateWrites > 1) throw new Error('second state write refused');
        return fs.writeFileSync(...args);
      },
      renameSync: (...args) => fs.renameSync(...args),
    };
    const calls = [];
    const state = await finalize([skipOutcome('cli-unauthenticated')], {
      state: initialState,
      statePath,
      fsImpl,
      now: () => '2026-08-30T12:00:00.000Z',
      threshold: 2,
      sendOpsAlert: async (...args) => {
        calls.push(args);
        return { ok: false, skipped: 'unconfigured' };
      },
      log: () => {},
    });
    assert.equal(state.consecutive_skips, 2);
    assert.equal(state.last_alert_at, null);
    assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).last_alert_at, null);
    assert.equal(stateWrites, 1, 'unconfigured delivery must not depend on a rollback write');
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0][2], {
      category: 'extraction-skip', omitHost: true, localFallback: true,
    });
  });

  it('honors AUXILO_SKIP_ALERT_THRESHOLD from env and documents the sentinel as the off switch', async () => {
    const finalize = mustFunction(runner, 'finalizeExtractionRun');
    const statePath = path.join(tempDir(), 'state.json');
    fs.writeFileSync(statePath, JSON.stringify({
      ...ZERO_STATE,
      consecutive_skips: 1,
      consecutive_unknown: 4,
      first_skip_at: '2026-08-29T00:00:00.000Z',
      last_skip_at: '2026-08-29T00:00:00.000Z',
    }));
    const alerts = [];
    const env = { AUXILO_SKIP_ALERT_THRESHOLD: '3' };
    const atTwo = await finalize([skipOutcome('cli-unauthenticated')], {
      statePath, env, now: () => '2026-08-30T12:00:00.000Z',
      sendOpsAlert: async (...args) => alerts.push(args), log: () => {},
    });
    assert.equal(atTwo.consecutive_skips, 2);
    assert.equal(atTwo.consecutive_unknown, 0);
    assert.equal(alerts.length, 0);
    await finalize([skipOutcome('cli-unauthenticated')], {
      statePath, env, now: () => '2026-08-31T12:00:00.000Z',
      sendOpsAlert: async (...args) => alerts.push(args), log: () => {},
    });
    assert.equal(alerts.length, 1);

    const source = fs.readFileSync(RUNNER_PATH, 'utf8');
    assert.match(source, /kill-switch sentinel is the supported off switch/i);
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
    assert.match(alerts[0][0], /sweeps\/attempts/);
    assert.match(payload, /test-platform/);
    assert.match(payload, /test-arch/);
    assert.match(payload, /2026-08-29T00:00:00\.000Z/);
    assert.match(payload, /run `claude auth login`/);
    assert.doesNotMatch(payload, /session-owner|secret-session|never send me|hostname|username|\/private\//i);

    assert.deepEqual(alerts[0][2], {
      category: 'extraction-skip', omitHost: true, localFallback: true,
    });

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

  it('routes an unconfigured email alert to a fail-silent, subject-only local notifier', async () => {
    const localCalls = [];
    const result = await opsAlert.sendOpsAlert(
      'Extraction skipped 2 consecutive sweeps/attempts',
      'private body must never reach the local notifier',
      {
        category: 'extraction-skip-local-fallback-test',
        localFallback: true,
        env: {},
        notifyLocalOpsAlert: (...args) => {
          localCalls.push(args);
          return { ok: true };
        },
      }
    );
    assert.deepEqual(result, { ok: false, skipped: 'unconfigured', localFallback: true });
    assert.equal(localCalls.length, 1);
    assert.equal(localCalls[0][0], 'Extraction skipped 2 consecutive sweeps/attempts');
    assert.doesNotMatch(JSON.stringify(localCalls), /private body/);

    const failedFallback = await opsAlert.sendOpsAlert('safe subject', 'private body', {
      category: 'extraction-skip-local-fallback-throw-test',
      localFallback: true,
      env: {},
      notifyLocalOpsAlert: () => { throw new Error('local notifier down'); },
    });
    assert.deepEqual(failedFallback, { ok: false, skipped: 'unconfigured' });

    const spawned = [];
    const child = { unref: () => spawned.push('unref'), on: () => child };
    assert.doesNotThrow(() => opsAlert.notifyLocalOpsAlert('safe subject', {
      platform: 'darwin', env: {},
      spawnImpl: (...args) => { spawned.push(args); return child; },
    }));
    assert.equal(spawned[0][0], '/usr/bin/osascript');
    assert.deepEqual(spawned[0][2], { stdio: 'ignore', detached: true });
    assert.match(spawned[0][1][1], /safe subject/);
    assert.match(spawned[0][1][1], /claude auth login/);
    assert.doesNotThrow(() => opsAlert.notifyLocalOpsAlert('safe subject', {
      platform: 'darwin', env: {}, spawnImpl: () => { throw new Error('notifier down'); },
    }));
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
        consecutive_unknown: 2,
        first_skip_at: '2026-08-29T00:00:00.000Z',
        last_skip_at: '2026-08-30T00:00:00.000Z',
        last_alert_at: null,
      },
      ledger: { lastRealExtractionAt: '2026-08-28T00:00:00.000Z' },
      authStatus: 'logged-out',
    });
    assert.match(line, /^Extraction: SKIPPING since 2026-08-29T00:00:00\.000Z/);
    assert.match(line, /3 consecutive/);
    assert.match(line, /2 unknown/);
    assert.match(line, /loggedIn:false/);
    assert.match(line, /run `claude auth login`/);
  });

  it('renders a persisted UNKNOWN streak instead of reporting extraction OK', () => {
    const render = mustFunction(runner, 'renderExtractionStatus');
    const line = render({
      state: { ...ZERO_STATE, consecutive_unknown: 2 },
      ledger: { lastRealExtractionAt: '2026-08-30T11:00:00.000Z' },
      authStatus: 'unknown',
    });
    assert.match(line, /^Extraction: UNKNOWN/);
    assert.match(line, /2 consecutive attempts/);
    assert.doesNotMatch(line, /^Extraction: OK/);
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

describe('EXT-0806b durable skip retention and ledger concurrency', () => {
  it('classifies either skip signal and reloads the ledger before persisting a real completion', () => {
    const isSkipped = mustFunction(runner, 'isSkippedExtraction');
    assert.equal(isSkipped({ skipped: true, result: { extraction_id: 'client-real' } }), true);
    assert.equal(isSkipped({ skipped: false, result: { extraction_id: 'client-skip' } }), true);
    assert.equal(isSkipped({ skipped: false, result: { extraction_id: 'client-real' } }), false);

    const persistReal = mustFunction(runner, 'persistRealExtractionCompletion');
    const concurrentLedger = {
      sources: {
        'claude-code': {
          highWater: '2026-08-30T11:59:00.000Z',
          sessions: { 'claude-code:hook-session:hook-sha': true },
        },
      },
      lastSweep: '2026-08-30T11:59:00.000Z',
    };
    let saved;
    assert.equal(persistReal({
      skipped: false, result: { extraction_id: 'client-real' },
    }, {
      loadLedger: () => structuredClone(concurrentLedger),
      saveLedger: (ledger) => { saved = ledger; },
      now: () => '2026-08-30T12:00:00.000Z',
    }), true);
    assert.equal(saved.sources['claude-code'].sessions['claude-code:hook-session:hook-sha'], true);
    assert.equal(saved.lastRealExtractionAt, '2026-08-30T12:00:00.000Z');
  });

  it('sweep retains a skip-classified queue file without ledger-marking or counting it processed', () => {
    const home = tempDir();
    enableClientRunner(home);
    const projectDir = path.join(home, '.claude', 'projects', 'fixture-project');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{}');
    const transcriptPath = path.join(projectDir, 'sweep-retained.jsonl');
    const transcript = 'Durable retained extraction work. '.repeat(70);
    fs.writeFileSync(transcriptPath,
      JSON.stringify({ type: 'user', message: { role: 'user', content: transcript } }) + '\n');

    const result = spawnSync(process.execPath,
      [RUNNER_PATH, '--source', 'claude-code', '--force'], {
        env: clientRunnerEnv(home), encoding: 'utf8', timeout: 30000,
      });
    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    const pendingDir = path.join(home, '.auxilo', 'pending-learnings');
    assert.equal(fs.readdirSync(pendingDir).filter((name) => name.endsWith('.json')).length, 1);
    const ledger = JSON.parse(fs.readFileSync(path.join(home, '.auxilo', 'ledger.json'), 'utf8'));
    assert.equal(runner.ledgerHas(ledger, 'claude-code', 'sweep-retained',
      require('node:crypto').createHash('sha256').update(`[user]: ${transcript}`).digest('hex')), false);
    assert.match(result.stdout,
      /Summary: 1 discovered, 0 processed, 0 skipped \(0 oversize\), 1 retained \(extraction skipped\), 0 failed/);
    assert.match(result.stdout, /⊘ extraction SKIPPED .*session=sweep-retained\.jsonl/);
  });

  it('flush retains a skip-classified queue file and reports a truthful split summary', () => {
    const home = tempDir();
    enableClientRunner(home);
    const pendingDir = path.join(home, '.auxilo', 'pending-learnings');
    fs.mkdirSync(pendingDir, { recursive: true });
    const queuePath = path.join(pendingDir, 'flush-retained.json');
    fs.writeFileSync(queuePath, JSON.stringify({
      source: 'claude-code',
      sessionId: 'flush-retained',
      session_basename: 'flush-retained.jsonl',
      transcript: 'Retain this durable flush work.',
      sha: 'fixture-sha',
      scrubReport: { clean: true, patterns_matched: [] },
      mtime: '2026-08-30T12:00:00.000Z',
    }));

    const result = spawnSync(process.execPath, [RUNNER_PATH, '--flush-pending'], {
      env: clientRunnerEnv(home), encoding: 'utf8', timeout: 30000,
    });
    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.equal(fs.existsSync(queuePath), true, 'skip-classified flush work must stay durable');
    assert.match(result.stdout, /Flush complete: 0\/1 succeeded, 1 retained \(extraction skipped\)/);
    assert.match(result.stdout, /⊘ extraction SKIPPED .*session=flush-retained\.jsonl/);
  });
});
