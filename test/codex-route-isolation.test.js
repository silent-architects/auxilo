'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const codexCli = require('../scripts/providers/codex-cli.js');
const extractLocal = require('../scripts/extract-local.js');

const REPO = path.join(__dirname, '..');
const tempDirs = [];

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function withAuth(home) {
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(home, '.codex', 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt' }));
  return home;
}

function cleanupTempDirs() {
  while (tempDirs.length) fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
}

function jsonl(events) {
  return events.map((event) => JSON.stringify(event)).join('\n');
}

function lifecycle(agentText) {
  const events = [
    { type: 'thread.started', thread_id: 'fixture-thread' },
    { type: 'turn.started' },
  ];
  if (typeof agentText === 'string') {
    events.push({ type: 'item.completed', item: { type: 'agent_message', text: agentText } });
  }
  events.push({ type: 'turn.completed' });
  return jsonl(events);
}

function expectedArgs(workDir, schemaPath, outputPath) {
  return [
    'exec',
    '-s', 'read-only',
    '--skip-git-repo-check',
    '--ephemeral',
    '--ignore-user-config',
    '--ignore-rules',
    '--strict-config',
    '-C', workDir,
    '--json',
    ...codexCli.ISOLATION_DISABLED_FEATURES.flatMap((feature) => ['--disable', feature]),
    ...codexCli.ISOLATION_CONFIG_OVERRIDES.flatMap((override) => ['-c', override]),
    '--output-schema', schemaPath,
    '-o', outputPath,
    '-',
  ];
}

function versionResult() {
  return { status: 0, stdout: 'codex-cli 0.144.5', stderr: '', error: null, signal: null };
}

describe('CODEX-ROUTE-ISOLATION', () => {
  it('T1: extract and judge use the exact isolated argv and a fresh empty cwd that is removed', async () => {
    const home = withAuth(tempDir('auxilo-codex-isolation-t1-'));
    codexCli._resetVersionCacheForTests();
    try {
      assert.equal(Object.isFrozen(codexCli.ISOLATION_DISABLED_FEATURES), true);
      assert.equal(Object.isFrozen(codexCli.ISOLATION_CONFIG_OVERRIDES), true);
      for (const mode of ['extract', 'judge']) {
        let captured;
        const spawnSyncImpl = (bin, args, opts) => {
          if (args[0] === '--version') return versionResult();
          const workDir = args[args.indexOf('-C') + 1];
          const outputPath = args[args.indexOf('-o') + 1];
          assert.equal(bin, 'codex');
          assert.equal(fs.existsSync(workDir), true);
          assert.deepEqual(fs.readdirSync(workDir), []);
          assert.equal(opts.cwd, workDir);
          assert.notEqual(path.dirname(outputPath), workDir);
          fs.writeFileSync(outputPath, mode === 'judge' ? '{"decisions":[]}' : '{"learnings":[]}');
          captured = { args, workDir, outputPath, cwd: opts.cwd };
          return { status: 0, stdout: lifecycle(), stderr: '', error: null, signal: null };
        };
        const result = await codexCli.runModel({
          mode,
          prompt: 'P',
          input: mode === 'extract' ? 'T' : undefined,
          homeDir: home,
          codexBin: 'codex',
          spawnSyncImpl,
          systemConfigPaths: [],
        });
        assert.equal(result.ok, true);
        assert.deepEqual(
          captured.args,
          expectedArgs(
            captured.workDir,
            mode === 'judge' ? codexCli.JUDGE_SCHEMA_PATH : codexCli.EXTRACTION_SCHEMA_PATH,
            captured.outputPath
          )
        );
        assert.equal(captured.cwd, captured.workDir);
        assert.equal(fs.existsSync(captured.workDir), false);
        assert.equal(fs.existsSync(path.dirname(captured.outputPath)), false);
      }
    } finally {
      codexCli._resetVersionCacheForTests();
      cleanupTempDirs();
    }
  });

  it('T2: argv and module source contain no destructive or bypass flags', async () => {
    const home = withAuth(tempDir('auxilo-codex-isolation-t2-'));
    const outputPath = path.join(home, 'out.txt');
    fs.writeFileSync(outputPath, '{"learnings":[]}');
    let execArgs;
    codexCli._resetVersionCacheForTests();
    try {
      const result = await codexCli.runModel({
        mode: 'extract', prompt: 'P', input: 'T', homeDir: home, codexBin: 'codex', outputPath,
        systemConfigPaths: [],
        spawnSyncImpl: (bin, args) => {
          if (args[0] === '--version') return versionResult();
          execArgs = args;
          return { status: 0, stdout: lifecycle(), stderr: '', error: null, signal: null };
        },
      });
      assert.equal(result.ok, true);
      const serialized = JSON.stringify(execArgs);
      const source = fs.readFileSync(path.join(REPO, 'scripts', 'providers', 'codex-cli.js'), 'utf8');
      for (const forbidden of [
        'skills.' + 'bundled.enabled',
        '--dangerously-bypass-approvals-and-sandbox',
        '--dangerously-bypass-hook-trust',
      ]) {
        assert.equal(serialized.includes(forbidden), false, `${forbidden} must not appear in argv`);
        assert.equal(source.includes(forbidden), false, `${forbidden} must not appear in module source`);
      }
    } finally {
      codexCli._resetVersionCacheForTests();
      cleanupTempDirs();
    }
  });

  it('T3: child env removes every inherited exec-server control while preserving CODEX_HOME', async () => {
    const home = withAuth(tempDir('auxilo-codex-isolation-t3-'));
    const outputPath = path.join(home, 'out.txt');
    fs.writeFileSync(outputPath, '{"learnings":[]}');
    const originalEnv = process.env;
    process.env = {
      ...originalEnv,
      CODEX_EXEC_SERVER_URL: 'http://x',
      CODEX_EXEC_SERVER_NOISE_URL: 'http://noise',
      CODEX_EXEC_SERVER_NOISE_SOCKET: '/tmp/noise.sock',
      CODEX_EXEC_SERVER_NOISE_TOKEN: 'secret',
      CODEX_HOME: '/fixture/codex',
      OPENAI_API_KEY: 'sk-parent',
    };
    let spawnedEnv;
    codexCli._resetVersionCacheForTests();
    try {
      const result = await codexCli.runModel({
        mode: 'extract', prompt: 'P', input: 'T', homeDir: home, codexBin: 'codex', outputPath,
        systemConfigPaths: [],
        spawnSyncImpl: (bin, args, opts) => {
          if (args[0] === '--version') return versionResult();
          spawnedEnv = opts.env;
          return { status: 0, stdout: lifecycle(), stderr: '', error: null, signal: null };
        },
      });
      assert.equal(result.ok, true);
      assert.equal(spawnedEnv.CODEX_EXEC_SERVER_URL, 'none');
      assert.deepEqual(
        Object.keys(spawnedEnv).filter((key) => key.startsWith('CODEX_EXEC_SERVER_')),
        ['CODEX_EXEC_SERVER_URL']
      );
      assert.equal(spawnedEnv.CODEX_HOME, '/fixture/codex');
      assert.equal(spawnedEnv.OPENAI_API_KEY, undefined);
      assert.equal(spawnedEnv.AUXILO_EXTRACTING, '1');
    } finally {
      process.env = originalEnv;
      codexCli._resetVersionCacheForTests();
      cleanupTempDirs();
    }
  });

  it('T4: skill mention neutralization covers the full grammar and is exactly reversible', () => {
    const cases = [
      '$skill-a', '[$b](/x/SKILL.md)', '$HOME', '$1', '$:x', '$_y',
      '$ z', '$$c', 'a$', '$', 'plain text',
    ];
    for (const input of cases) {
      const neutralized = codexCli.neutralizeSkillMentions(input);
      assert.equal(neutralized, input.replace(/\$(?=[A-Za-z0-9_:-])/g, '$\u200B'));
      assert.equal(codexCli.stripNeutralizationMarker(neutralized), input);
    }
  });

  it('T5: spawned stdin is the neutralized prompt plus input', async () => {
    const home = withAuth(tempDir('auxilo-codex-isolation-t5-'));
    const outputPath = path.join(home, 'out.txt');
    fs.writeFileSync(outputPath, '{"learnings":[]}');
    let stdin;
    codexCli._resetVersionCacheForTests();
    try {
      const prompt = 'Use $skill-a and [$b](/x/SKILL.md). ';
      const input = 'Transcript says $HOME and $$c.';
      const result = await codexCli.runModel({
        mode: 'extract', prompt, input, homeDir: home, codexBin: 'codex', outputPath,
        systemConfigPaths: [],
        spawnSyncImpl: (bin, args, opts) => {
          if (args[0] === '--version') return versionResult();
          stdin = opts.input;
          return { status: 0, stdout: lifecycle(), stderr: '', error: null, signal: null };
        },
      });
      assert.equal(result.ok, true);
      assert.equal(stdin, codexCli.neutralizeSkillMentions(prompt + input));
    } finally {
      codexCli._resetVersionCacheForTests();
      cleanupTempDirs();
    }
  });

  it('T6: neutralization markers are stripped from the -o answer', async () => {
    const home = withAuth(tempDir('auxilo-codex-isolation-t6-'));
    const outputPath = path.join(home, 'out.txt');
    fs.writeFileSync(outputPath, '{"answer":"$\u200Bskill"}');
    codexCli._resetVersionCacheForTests();
    try {
      const result = await codexCli.runModel({
        mode: 'extract', prompt: 'P', input: 'T', homeDir: home, codexBin: 'codex', outputPath,
        systemConfigPaths: [],
        spawnSyncImpl: (bin, args) => args[0] === '--version'
          ? versionResult()
          : { status: 0, stdout: lifecycle(), stderr: '', error: null, signal: null },
      });
      assert.equal(result.ok, true);
      assert.equal(result.text.includes('\u200B'), false);
      assert.equal(result.text, '{"answer":"$skill"}');
    } finally {
      codexCli._resetVersionCacheForTests();
      cleanupTempDirs();
    }
  });

  it('T7: a valid lifecycle stream returns the -o answer', async () => {
    const home = withAuth(tempDir('auxilo-codex-isolation-t7-'));
    const outputPath = path.join(home, 'out.txt');
    fs.writeFileSync(outputPath, '{"learnings":[]}');
    codexCli._resetVersionCacheForTests();
    try {
      const result = await codexCli.runModel({
        mode: 'extract', prompt: 'P', input: 'T', homeDir: home, codexBin: 'codex', outputPath,
        systemConfigPaths: [],
        spawnSyncImpl: (bin, args) => args[0] === '--version'
          ? versionResult()
          : { status: 0, stdout: lifecycle('event answer is not selected'), stderr: '', error: null, signal: null },
      });
      assert.equal(result.ok, true);
      assert.equal(result.text, '{"learnings":[]}');
    } finally {
      codexCli._resetVersionCacheForTests();
      cleanupTempDirs();
    }
  });

  it('T8: every tool-like or unknown item type fails closed and cleans both private directories', async () => {
    const itemTypes = [
      'command_execution', 'file_change', 'mcp_tool_call',
      'collab_tool_call', 'web_search', 'dynamic_tool_call',
    ];
    const home = withAuth(tempDir('auxilo-codex-isolation-t8-'));
    try {
      for (const itemType of itemTypes) {
        let workDir;
        let outputDir;
        const result = await codexCli.runModel({
          mode: 'extract', prompt: 'P', input: 'T', homeDir: home, codexBin: 'codex',
          systemConfigPaths: [],
          spawnSyncImpl: (bin, args) => {
            workDir = args[args.indexOf('-C') + 1];
            const outputPath = args[args.indexOf('-o') + 1];
            outputDir = path.dirname(outputPath);
            fs.writeFileSync(outputPath, '{"learnings":[]}');
            return {
              status: 0,
              stdout: jsonl([
                { type: 'thread.started' },
                { type: 'item.started', item: { type: itemType, text: 'secret-content' } },
              ]),
              stderr: '', error: null, signal: null,
            };
          },
        });
        assert.equal(result.ok, false);
        assert.equal(result.reasonCode, 'isolation-violation');
        assert.equal(result.text, '');
        assert.match(result.reason, new RegExp(`${itemType}$`));
        assert.equal(result.reason.includes('secret-content'), false);
        assert.equal(fs.existsSync(workDir), false);
        assert.equal(fs.existsSync(outputDir), false);
      }
    } finally {
      cleanupTempDirs();
    }
  });

  it('T9: exit zero with no parseable JSONL event is isolation-unverified', async () => {
    const home = withAuth(tempDir('auxilo-codex-isolation-t9-'));
    const outputPath = path.join(home, 'out.txt');
    fs.writeFileSync(outputPath, '{"learnings":[]}');
    try {
      const result = await codexCli.runModel({
        mode: 'extract', prompt: 'P', input: 'T', homeDir: home, codexBin: 'codex', outputPath,
        systemConfigPaths: [],
        spawnSyncImpl: () => ({ status: 0, stdout: 'banner only\nnot json', stderr: '', error: null, signal: null }),
      });
      assert.equal(result.ok, false);
      assert.equal(result.reasonCode, 'isolation-unverified');
      assert.equal(result.text, '');
    } finally {
      cleanupTempDirs();
    }
  });

  it('T10: unreadable -o falls back only to the last completed agent message', async () => {
    const home = withAuth(tempDir('auxilo-codex-isolation-t10-'));
    const outputPath = path.join(home, 'missing.txt');
    codexCli._resetVersionCacheForTests();
    try {
      const stdout = jsonl([
        { type: 'thread.started' },
        { type: 'item.completed', item: { type: 'agent_message', text: 'first answer' } },
        { type: 'item.completed', item: { type: 'reasoning', text: 'private reasoning' } },
        { type: 'item.completed', item: { type: 'agent_message', text: 'last answer' } },
        { type: 'turn.completed' },
      ]);
      const result = await codexCli.runModel({
        mode: 'extract', prompt: 'P', input: 'T', homeDir: home, codexBin: 'codex', outputPath,
        systemConfigPaths: [],
        spawnSyncImpl: (bin, args) => args[0] === '--version'
          ? versionResult()
          : { status: 0, stdout, stderr: '', error: null, signal: null },
      });
      assert.equal(result.ok, true);
      assert.equal(result.text, 'last answer');
      assert.notEqual(result.text, stdout);
    } finally {
      codexCli._resetVersionCacheForTests();
      cleanupTempDirs();
    }
  });

  it('T11: agent text that says not logged in is never classified as an auth failure', async () => {
    const home = withAuth(tempDir('auxilo-codex-isolation-t11-'));
    const outputPath = path.join(home, 'out.txt');
    fs.writeFileSync(outputPath, '{"learnings":[]}');
    codexCli._resetVersionCacheForTests();
    try {
      const result = await codexCli.runModel({
        mode: 'extract', prompt: 'P', input: 'T', homeDir: home, codexBin: 'codex', outputPath,
        systemConfigPaths: [],
        spawnSyncImpl: (bin, args) => args[0] === '--version'
          ? versionResult()
          : { status: 0, stdout: lifecycle('the transcript says not logged in'), stderr: '', error: null, signal: null },
      });
      assert.equal(result.ok, true);
      assert.notEqual(result.reasonCode, 'cli-unauthenticated');
    } finally {
      codexCli._resetVersionCacheForTests();
      cleanupTempDirs();
    }
  });

  it('T12: an auth failure on stderr keeps the cli-unauthenticated classification', async () => {
    const home = withAuth(tempDir('auxilo-codex-isolation-t12-'));
    try {
      const result = await codexCli.runModel({
        mode: 'extract', prompt: 'P', input: 'T', homeDir: home, codexBin: 'codex',
        systemConfigPaths: [],
        spawnSyncImpl: () => ({ status: 1, stdout: lifecycle(), stderr: 'not authenticated', error: null, signal: null }),
      });
      assert.equal(result.ok, false);
      assert.equal(result.reasonCode, 'cli-unauthenticated');
    } finally {
      cleanupTempDirs();
    }
  });

  it('T13: a system config path refuses before spawn and is a pre-spawn skip', async () => {
    const home = withAuth(tempDir('auxilo-codex-isolation-t13-'));
    const blockedPath = path.join(home, 'system-config.toml');
    let spawnCalls = 0;
    try {
      const result = await codexCli.runModel({
        mode: 'extract', prompt: 'P', input: 'T', homeDir: home, codexBin: 'codex',
        systemConfigPaths: [blockedPath],
        existsSync: (candidate) => candidate === blockedPath,
        spawnSyncImpl: () => {
          spawnCalls += 1;
          throw new Error('must not spawn');
        },
      });
      assert.equal(result.ok, false);
      assert.equal(result.reasonCode, 'isolation-precondition');
      assert.match(result.reason, new RegExp(blockedPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.equal(spawnCalls, 0);
      assert.equal(extractLocal.PRE_SPAWN_SKIP_REASON_CODES.has('isolation-precondition'), true);
    } finally {
      cleanupTempDirs();
    }
  });

  it('T14: absent system config paths allow the stubbed spawn to proceed', async () => {
    const home = withAuth(tempDir('auxilo-codex-isolation-t14-'));
    const outputPath = path.join(home, 'out.txt');
    fs.writeFileSync(outputPath, '{"learnings":[]}');
    let spawnCalls = 0;
    codexCli._resetVersionCacheForTests();
    try {
      const result = await codexCli.runModel({
        mode: 'extract', prompt: 'P', input: 'T', homeDir: home, codexBin: 'codex', outputPath,
        systemConfigPaths: ['/fixture/config.toml', '/fixture/requirements.toml'],
        existsSync: () => false,
        spawnSyncImpl: (bin, args) => {
          spawnCalls += 1;
          if (args[0] === '--version') return versionResult();
          return { status: 0, stdout: lifecycle(), stderr: '', error: null, signal: null };
        },
      });
      assert.equal(result.ok, true);
      assert.ok(spawnCalls >= 1);
    } finally {
      codexCli._resetVersionCacheForTests();
      cleanupTempDirs();
    }
  });

  it('T15: throw, timeout and non-zero exits clean both private directories; non-zero reason is stderr-only', async () => {
    const home = withAuth(tempDir('auxilo-codex-isolation-t15-'));
    const cases = [
      {
        name: 'throw',
        response: () => { throw new Error('stubbed spawn failure'); },
        reasonCode: 'unknown',
      },
      {
        name: 'timeout',
        response: () => ({ status: null, signal: 'SIGTERM', stdout: '', stderr: '', error: null }),
        reasonCode: 'cli-timeout',
      },
      {
        name: 'non-zero',
        response: () => ({ status: 1, signal: null, stdout: 'stdout-secret', stderr: 'safe stderr', error: null }),
        reasonCode: 'model-error',
      },
    ];
    try {
      for (const fixture of cases) {
        let workDir;
        let outputDir;
        const result = await codexCli.runModel({
          mode: 'extract', prompt: 'P', input: 'T', homeDir: home, codexBin: 'codex',
          systemConfigPaths: [],
          spawnSyncImpl: (bin, args) => {
            workDir = args[args.indexOf('-C') + 1];
            outputDir = path.dirname(args[args.indexOf('-o') + 1]);
            return fixture.response();
          },
        });
        assert.equal(result.ok, false, fixture.name);
        assert.equal(result.reasonCode, fixture.reasonCode, fixture.name);
        assert.equal(fs.existsSync(workDir), false, `${fixture.name}: cwd must be removed`);
        assert.equal(fs.existsSync(outputDir), false, `${fixture.name}: output dir must be removed`);
        if (fixture.name === 'non-zero') {
          assert.match(result.reason, /safe stderr/);
          assert.doesNotMatch(result.reason, /stdout-secret/);
        }
      }
    } finally {
      cleanupTempDirs();
    }
  });
});
