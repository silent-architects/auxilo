'use strict';

/**
 * BUILD-SPEC UC-6 — Codex CLI + Desktop rollout capture.
 *
 * All rollout fixtures are synthetic. They intentionally carry privacy
 * canaries in base_instructions/world_state so leakage fails loudly.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..');
const FIXTURES = path.join(__dirname, 'fixtures', 'codex');
const ADAPTER_REL = 'scripts/sources/codex-cli.js';

const runner = require('../scripts/runner.js');
const installer = require('../lib/installer.js');
const { extractLocally } = require('../scripts/extract-local.js');
const { CodexCliSource } = require('../scripts/sources/codex-cli.js');

function tmpdir(prefix = 'aux-uc6-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

function fixture(name) {
  return fs.readFileSync(path.join(FIXTURES, name), 'utf8');
}

function refFor(filePath, sessionId = path.basename(filePath, '.jsonl')) {
  const stat = fs.statSync(filePath);
  return {
    sessionId,
    path: filePath,
    mtime: stat.mtime.toISOString(),
    bytes: stat.size,
  };
}

function count(text, needle) {
  return text.split(needle).length - 1;
}

describe('UC-6 — Codex Desktop capture', () => {
  it('T1 registers codex-cli and closes both installed-runner manifests', () => {
    const registered = runner.loadSources().map((Source) => Source.id);
    assert.ok(registered.includes('codex-cli'));
    assert.ok(runner.SOURCES.some((Source) => Source.id === 'codex-cli'));

    const stack = new Set(installer.RUNNER_STACK.map(([src]) => src));
    const sweeper = new Set(runner.sweeperManifest(REPO_ROOT).map(([src]) => src));
    assert.ok(stack.has(ADAPTER_REL));
    assert.ok(sweeper.has(ADAPTER_REL));
  });

  it('T2 detects only when the CODEX_HOME-style sessions directory exists', async () => {
    const home = tmpdir();
    try {
      const source = new CodexCliSource({ homeDir: home });
      assert.equal(await source.detect(), false);
      fs.mkdirSync(path.join(home, '.codex', 'sessions'), { recursive: true });
      assert.equal(await source.detect(), true);
    } finally {
      cleanup(home);
    }
  });

  it('T3 discovers active and archived quiescent rollouts, honoring since and parsing UUIDs', async () => {
    const home = tmpdir();
    try {
      const sessions = path.join(home, '.codex', 'sessions', '2026', '07', '27');
      const archived = path.join(home, '.codex', 'archived_sessions');
      fs.mkdirSync(sessions, { recursive: true });
      fs.mkdirSync(archived, { recursive: true });

      const now = Date.now();
      const oldId = '11111111-1111-4111-8111-111111111111';
      const archivedId = '44444444-4444-4444-8444-444444444444';
      const youngId = '55555555-5555-4555-8555-555555555555';
      const beforeId = '66666666-6666-4666-8666-666666666666';
      const paths = {
        old: path.join(sessions, `rollout-2026-07-27T12-00-00-${oldId}.jsonl`),
        archived: path.join(archived, `rollout-2026-07-26T12-00-00-${archivedId}.jsonl`),
        young: path.join(sessions, `rollout-2026-07-27T12-10-00-${youngId}.jsonl`),
        before: path.join(sessions, `rollout-2026-07-27T11-00-00-${beforeId}.jsonl`),
      };
      for (const filePath of Object.values(paths)) fs.writeFileSync(filePath, fixture('user-thread.jsonl'));
      fs.utimesSync(paths.old, new Date(now - 120000), new Date(now - 120000));
      fs.utimesSync(paths.archived, new Date(now - 180000), new Date(now - 180000));
      fs.utimesSync(paths.young, new Date(now - 1000), new Date(now - 1000));
      fs.utimesSync(paths.before, new Date(now - 300000), new Date(now - 300000));

      const source = new CodexCliSource({
        homeDir: home,
        env: { AUXILO_CODEX_QUIESCENCE_MS: '60000' },
      });
      const found = await source.discoverSessions({
        since: new Date(now - 240000).toISOString(),
      });
      assert.deepEqual(found.map((row) => row.sessionId).sort(), [archivedId, oldId].sort());
      assert.ok(found.some((row) => row.path === paths.archived));
      assert.ok(found.every((row) => row.mtime && Number.isFinite(row.bytes)));
    } finally {
      cleanup(home);
    }
  });

  it('T4 refuses subagent, guardian, missing-meta, and non-JSON rollouts without throwing', async () => {
    const source = new CodexCliSource({ homeDir: '/fixture/home' });
    for (const name of [
      'subagent-thread.jsonl',
      'guardian-thread.jsonl',
      'no-session-meta.jsonl',
      'non-json.jsonl',
    ]) {
      const filePath = path.join(FIXTURES, name);
      assert.equal(await source.readSession(refFor(filePath)), null, name);
    }
  });

  it('T5 normalizes messages/tools once and excludes private, reasoning, and duplicate records', async () => {
    const dir = tmpdir();
    try {
      const filePath = path.join(dir, 'user-thread.jsonl');
      const toolArgs = 'A'.repeat(700) + 'TOOL-ARGS-TAIL';
      const toolOutput = 'O'.repeat(2500) + 'TOOL-OUTPUT-TAIL';
      fs.writeFileSync(filePath, fixture('user-thread.jsonl') + [
        JSON.stringify({
          timestamp: '2026-07-27T12:00:07.000Z',
          type: 'response_item',
          payload: { type: 'custom_tool_call', name: 'fixture_tool', arguments: toolArgs },
        }),
        JSON.stringify({
          timestamp: '2026-07-27T12:00:08.000Z',
          type: 'response_item',
          payload: { type: 'custom_tool_call_output', output: toolOutput },
        }),
      ].join('\n') + '\n');

      const source = new CodexCliSource({ homeDir: '/fixture/home' });
      const result = await source.readSession(refFor(filePath));
      assert.match(result.transcript, /User: Synthetic user request/);
      assert.match(result.transcript, /Assistant: Synthetic assistant answer/);
      assert.match(result.transcript, /Tool: fixture_tool/);
      assert.ok(result.transcript.includes('A'.repeat(500)));
      assert.ok(!result.transcript.includes('A'.repeat(501)));
      assert.ok(result.transcript.includes('O'.repeat(2000)));
      assert.ok(!result.transcript.includes('O'.repeat(2001)));
      assert.ok(!result.transcript.includes('TOOL-ARGS-TAIL'));
      assert.ok(!result.transcript.includes('TOOL-OUTPUT-TAIL'));
      assert.equal(count(result.transcript, 'DUPLICATE-EVENT-MESSAGE'), 1);
      assert.ok(!result.transcript.includes('FIXTURE-AGENTS-MD-CANARY'));
      assert.ok(!result.transcript.includes('FIXTURE-REASONING-CANARY'));
    } finally {
      cleanup(dir);
    }
  });

  it('T6 permits codex-cli local extraction while unknown sources retain the short-circuit', async () => {
    const dir = tmpdir();
    try {
      const indexPath = path.join(dir, 'extracted-index.jsonl');
      fs.writeFileSync(indexPath, '');
      const invoked = [];
      const codex = await extractLocally('synthetic transcript', 'codex-cli', {
        indexPath,
        invokeModel: async () => {
          invoked.push('codex-cli');
          return { ok: false, reason: 'fixture-model-stop' };
        },
      });
      assert.deepEqual(invoked, ['codex-cli']);
      assert.equal(codex.skipped, 'fixture-model-stop');
      assert.doesNotMatch(codex.skipped, /local extraction not implemented/);

      const unknown = await extractLocally('synthetic transcript', 'windsurf-x', {
        invokeModel: async () => {
          throw new Error('unknown source must short-circuit before model invocation');
        },
      });
      assert.match(unknown.skipped, /local extraction not implemented for "windsurf-x"/);
    } finally {
      cleanup(dir);
    }
  });

  it('T7 surfaces Codex rollout provenance metadata', async () => {
    const filePath = path.join(FIXTURES, 'user-thread.jsonl');
    const source = new CodexCliSource({ homeDir: '/fixture/home' });
    const result = await source.readSession(refFor(filePath, 'fixture-user-thread'));
    assert.deepEqual(
      {
        sessionId: result.metadata.sessionId,
        source: result.metadata.source,
        originator: result.metadata.originator,
        cwd: result.metadata.cwd,
        model_provider: result.metadata.model_provider,
      },
      {
        sessionId: 'fixture-user-thread',
        source: 'codex-cli',
        originator: 'Codex Desktop',
        cwd: '/fixture/workspace',
        model_provider: 'fixture-provider',
      }
    );
  });

  it('T8 inherits the shared oversize guard and never overrides readSessionCapped', async () => {
    assert.ok(!Object.prototype.hasOwnProperty.call(CodexCliSource.prototype, 'readSessionCapped'));
    const previous = process.env.AUXILO_MAX_SESSION_BYTES;
    process.env.AUXILO_MAX_SESSION_BYTES = '1024';
    try {
      const source = new CodexCliSource({ homeDir: '/fixture/home' });
      await assert.rejects(
        () => source.readSessionCapped({
          sessionId: 'oversize-fixture',
          path: '/nonexistent/uc6-oversize.jsonl',
          mtime: new Date().toISOString(),
          bytes: 2048,
        }),
        (error) => error && error.code === 'SESSION_TOO_LARGE'
      );
    } finally {
      if (previous === undefined) delete process.env.AUXILO_MAX_SESSION_BYTES;
      else process.env.AUXILO_MAX_SESSION_BYTES = previous;
    }
  });

  it('Gate-A F-A never throws when a real-shape tool call omits arguments', async () => {
    const filePath = path.join(FIXTURES, 'missing-tool-arguments.jsonl');
    const source = new CodexCliSource({ homeDir: '/fixture/home' });
    const result = await source.readSession(refFor(filePath, 'missing-tool-arguments'));
    assert.match(result.transcript, /Tool: fixture_tool_without_arguments/);
    assert.ok(!result.transcript.includes('undefined'));

    const drifted = new CodexCliSource({ homeDir: '/fixture/home' });
    drifted._readSession = () => { throw new Error('synthetic future shape drift'); };
    assert.equal(
      await drifted.readSession(refFor(filePath, 'future-shape-drift')),
      null,
      'the public readSession boundary must convert every unexpected normalizer throw to null'
    );

    drifted._readSession = async () => { throw new Error('synthetic future async drift'); };
    assert.equal(
      await drifted.readSession(refFor(filePath, 'future-async-drift')),
      null,
      'the public readSession boundary must also convert rejected normalizer promises to null'
    );
  });

  it('Gate-A F-B reports one end-of-sweep refusal summary without per-file path logs', () => {
    const home = tmpdir();
    try {
      const sessions = path.join(home, '.codex', 'sessions', '2026', '07', '27');
      fs.mkdirSync(sessions, { recursive: true });
      fs.mkdirSync(path.join(home, '.auxilo'), { recursive: true });
      fs.writeFileSync(path.join(home, '.auxilo', 'autonomous-enabled'), 'enabled\n');

      const refusedFixtures = [
        ['subagent-thread.jsonl', '88888888-8888-4888-8888-888888888888'],
        ['guardian-thread.jsonl', '99999999-9999-4999-8999-999999999999'],
        ['no-session-meta.jsonl', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
      ];
      const old = new Date(Date.now() - 60000);
      for (const [name, id] of refusedFixtures) {
        const filePath = path.join(sessions, `rollout-2026-07-27T12-00-00-${id}.jsonl`);
        fs.writeFileSync(filePath, fixture(name));
        fs.utimesSync(filePath, old, old);
      }

      const env = {
        ...process.env,
        HOME: home,
        AUXILO_CODEX_QUIESCENCE_MS: '1',
        AUXILO_NO_NOTIFY: '1',
      };
      delete env.AUXILO_EXTRACTING;
      const result = spawnSync(
        process.execPath,
        [path.join(REPO_ROOT, 'scripts', 'runner.js'), '--source', 'codex-cli', '--dry-run', '--force'],
        { env, encoding: 'utf8', timeout: 30000 }
      );
      assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
      assert.equal(
        count(result.stdout, 'codex-cli: 3 refused (non-user/format)'),
        1,
        result.stdout
      );
      assert.doesNotMatch(result.stdout + result.stderr, /format probe refused/);
      assert.ok(!result.stderr.includes(sessions), 'stderr must not disclose each refused rollout path');
    } finally {
      cleanup(home);
    }
  });
});
