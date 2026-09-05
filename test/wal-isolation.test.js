'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  bootServer,
  reservePort,
  stageServer,
  stopServer,
} = require('./helpers/staged-server');

const ROOT = path.join(__dirname, '..');
const REAL_WAL_DIR = path.join(ROOT, 'data', 'wal');

function walListing(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).sort();
}

test('AUXILO_WAL_DIR overrides WAL storage for a fresh lib/wal.js require', (t) => {
  const walDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auxilo-wal-override-'));
  t.after(() => fs.rmSync(walDir, { recursive: true, force: true }));
  const realBefore = walListing(REAL_WAL_DIR);
  const walModule = path.join(ROOT, 'lib', 'wal.js');
  const script = [
    `const wal = require(${JSON.stringify(walModule)});`,
    "const id = wal.createWalEntry('isolation_probe', { source: 'unit' });",
    'console.log(JSON.stringify({ dir: wal.walDir(), id }));',
  ].join('\n');

  const result = spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    env: { ...process.env, AUXILO_WAL_DIR: walDir },
  });
  assert.equal(result.status, 0, result.stderr);
  const reported = JSON.parse(result.stdout.trim());
  assert.equal(reported.dir, walDir);
  assert.equal(fs.existsSync(path.join(walDir, `${reported.id}.wal.json`)), true);
  assert.deepEqual(walListing(REAL_WAL_DIR), realBefore, 'override writes must not touch checkout WAL');
});

test('a staged server defaults WAL recovery to its own data/wal directory', { timeout: 90_000 }, async (t) => {
  let nodeModulesDir;
  try {
    const honoEntry = require.resolve('hono', { paths: [ROOT] });
    nodeModulesDir = honoEntry.slice(
      0,
      honoEntry.lastIndexOf(`${path.sep}node_modules${path.sep}`) + '/node_modules'.length,
    );
  } catch {
    t.skip('hono not resolvable from repo root');
    return;
  }

  const reservation = await reservePort();
  if (reservation.skipReason) {
    t.skip(reservation.skipReason);
    return;
  }

  const realBefore = walListing(REAL_WAL_DIR);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auxilo-wal-isolation-'));
  let child = null;
  t.after(async () => {
    await stopServer(child);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const { dataDir } = stageServer({
    repoRoot: ROOT,
    tmpDir,
    nodeModulesDir,
    port: reservation.port,
    rootFiles: [
      'server.js',
      'seed-knowledge.json',
      'skills.json',
      'openapi.json',
      'package.json',
      'model_config.json',
    ],
    linkDirs: ['lib', 'public', 'prompts', 'config'],
  });

  const stagedWalDir = path.join(dataDir, 'wal');
  const walDirCreatedByStageServer = fs.existsSync(stagedWalDir);
  fs.mkdirSync(stagedWalDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'learnings.json'), JSON.stringify([{
    id: 'lrn_wal_isolation',
    title: 'Staged WAL isolation fixture',
    body: 'The staged server must recover only the write-ahead log stored inside its own temporary data directory.',
    category: 'code-execution',
    tags: ['wal'],
    status: 'approved',
    created_at: '2026-09-02T12:00:00.000Z',
  }], null, 2));
  const probeFile = path.join(stagedWalDir, 'staged-isolation-probe.wal.json');
  fs.writeFileSync(probeFile, JSON.stringify({
    id: 'staged-isolation-probe',
    operation: 'pipeline_approve',
    payload: { pipeline_id: 'unused' },
    steps_completed: [],
    created_at: Date.now(),
  }, null, 2));

  const boot = await bootServer({
    tmpDir,
    port: reservation.port,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      WALLET_PRIVATE_KEY: `0x${'11'.repeat(32)}`,
      SESSION_SECRET: 'wal-isolation-test-session-secret-32-bytes',
      CONTENT_MODERATION_ENABLED: 'true',
      LLM_SENSITIVITY_ENABLED: 'false',
    },
    timeoutMs: 60_000,
    maxAttempts: 1,
  });
  if (boot.skipReason) {
    t.skip(boot.skipReason);
    return;
  }
  child = boot.child;

  assert.equal(walDirCreatedByStageServer, true, 'stageServer must create <tmpDir>/data/wal');
  assert.equal(fs.existsSync(probeFile), false, 'staged recovery must commit the staged WAL entry');
  assert.deepEqual(walListing(REAL_WAL_DIR), realBefore, 'staged boot must not touch checkout data/wal');
});
