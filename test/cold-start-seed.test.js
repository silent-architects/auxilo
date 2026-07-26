/**
 * test/cold-start-seed.test.js — cold-start seeding regression (CS-1)
 *
 * Bug (found + fixed 2026-07-18): server.js's startup migration/seed blocks
 * call safeWrite() during module init. safeWrite() reads the module-scope
 * `let cleanupRunning` / `let lastBackupCleanup` backup-cleanup state, which
 * was declared ~120 lines BELOW the seed block. On a fresh install (empty
 * data/), the seed-knowledge write — the first top-level safeWrite() call —
 * hit the temporal dead zone and threw "Cannot access 'cleanupRunning'
 * before initialization" inside the seed try/catch, which mislabeled the
 * error as "Failed to load seed knowledge" and swallowed the success log.
 * The same TDZ sat under all four top-level migration write sites (AC-1 /
 * M-1 / M-B), where a mid-block throw skips the paired earnings write
 * (partial-write hazard on a populated install). Prod never hit it because
 * its data dir is already populated. Fix: the declarations are hoisted next
 * to the BACKUP_DIR setup, above every top-level call site.
 *
 * Two guards:
 *   1. Structural — source-order assertion (repo convention, same as
 *      test/x402-router-server.test.js): both `let` declarations precede
 *      every top-level safeWrite() call site.
 *   2. Behavioral — spawn `node server.js` in a temp app dir with an EMPTY
 *      data dir and assert seeding completes. Self-skips (loudly) when the
 *      server's runtime deps (hono) aren't installed — CI's `npm ci`
 *      installs only the declared package.json deps, so there the
 *      structural guard is the enforcing test.
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const SERVER_SRC = fs.readFileSync(path.join(REPO_ROOT, 'server.js'), 'utf-8');

describe('CS-1 structural: safeWrite() state is declared before its first callers', () => {
  const declCleanup = SERVER_SRC.indexOf('let cleanupRunning');
  const declBackup = SERVER_SRC.indexOf('let lastBackupCleanup');

  it('declarations exist', () => {
    assert.notEqual(declCleanup, -1, 'let cleanupRunning must exist in server.js');
    assert.notEqual(declBackup, -1, 'let lastBackupCleanup must exist in server.js');
  });

  it('declarations precede the first safeWrite(LEARNINGS_FILE) call site', () => {
    const firstLearningsWrite = SERVER_SRC.indexOf('safeWrite(LEARNINGS_FILE');
    assert.notEqual(firstLearningsWrite, -1);
    assert.ok(declCleanup < firstLearningsWrite,
      'let cleanupRunning must be declared before the first safeWrite(LEARNINGS_FILE) call — a later declaration is in the TDZ during startup migrations/seeding');
    assert.ok(declBackup < firstLearningsWrite,
      'let lastBackupCleanup must be declared before the first safeWrite(LEARNINGS_FILE) call');
  });

  it('declarations precede the first safeWrite(EARNINGS_FILE) call site', () => {
    const firstEarningsWrite = SERVER_SRC.indexOf('safeWrite(EARNINGS_FILE');
    assert.notEqual(firstEarningsWrite, -1);
    assert.ok(declCleanup < firstEarningsWrite);
    assert.ok(declBackup < firstEarningsWrite);
  });

  it('declarations precede the seed-knowledge block', () => {
    const seedCatch = SERVER_SRC.indexOf('Failed to load seed knowledge');
    assert.notEqual(seedCatch, -1, 'seed block catch marker must exist');
    assert.ok(declCleanup < seedCatch);
    assert.ok(declBackup < seedCatch);
  });
});

describe('CS-1 behavioral: fresh install seeds the catalog', () => {
  it('cold start against an empty data dir seeds learnings.json', { timeout: 30_000 }, async (t) => {
    // The server's runtime deps (hono etc.) are not in package.json — CI's
    // `npm ci` won't install them. Skip the boot there; structural guard above
    // still enforces the fix.
    // Resolve the ACTUAL node_modules dir hono lives in — in a git worktree the
    // repo root has no node_modules and resolution walks up to the main checkout,
    // so symlinking REPO_ROOT/node_modules would stage nothing and the boot
    // would die on `Cannot find module 'hono'` instead of exercising the seed.
    let nodeModulesDir;
    try {
      const honoEntry = require.resolve('hono', { paths: [REPO_ROOT] });
      nodeModulesDir = honoEntry.slice(0, honoEntry.lastIndexOf(`${path.sep}node_modules${path.sep}`) + '/node_modules'.length);
    } catch {
      t.skip('hono not resolvable from repo root — skipping real cold boot (structural guard still enforces declaration order)');
      return;
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auxilo-coldstart-'));
    let child = null;
    try {
      // Stage a minimal app dir: real server.js + seed file, shared code and
      // deps symlinked. data/ intentionally absent — the cold-start case.
      for (const f of ['server.js', 'seed-knowledge.json', 'skills.json', 'openapi.json', 'package.json']) {
        const src = path.join(REPO_ROOT, f);
        if (fs.existsSync(src)) fs.copyFileSync(src, path.join(tmpDir, f));
      }
      for (const d of ['lib', 'public', 'prompts', 'config']) {
        const src = path.join(REPO_ROOT, d);
        if (fs.existsSync(src)) fs.symlinkSync(src, path.join(tmpDir, d));
      }
      fs.mkdirSync(path.join(tmpDir, 'data'));
      fs.copyFileSync(
        path.join(REPO_ROOT, 'data', 'common-dev-terms.txt'),
        path.join(tmpDir, 'data', 'common-dev-terms.txt')
      );
      fs.symlinkSync(nodeModulesDir, path.join(tmpDir, 'node_modules'));

      const output = await new Promise((resolve, reject) => {
        child = spawn(process.execPath, ['server.js'], {
          cwd: tmpDir,
          env: {
            ...process.env,
            NODE_ENV: 'test',
            // dummy key so the boot survives the WALLET_PRIVATE_KEY gate
            // (that gate sits after the seed block, but keep the boot clean)
            WALLET_PRIVATE_KEY: '0x' + '11'.repeat(32),
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        let out = '';
        let settled = false;
        const decisive = () =>
          out.includes('Failed to load seed knowledge') || /Seeded \d+ initial learnings/.test(out);
        const settle = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(out);
        };
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          reject(new Error(`cold boot produced no seed marker within 20s. Output so far:\n${out}`));
        }, 20_000);

        const onData = (d) => {
          out += d.toString();
          if (decisive()) settle();
        };
        child.stdout.on('data', onData);
        child.stderr.on('data', onData);
        child.on('exit', settle);
        child.on('error', (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(err);
        });
      });

      // Stop the server before inspecting its data dir.
      try { child.kill('SIGKILL'); } catch { /* already gone */ }

      assert.match(output, /Seeded \d+ initial learnings/,
        `cold start must log the seed success line. Output:\n${output}`);
      assert.ok(!output.includes('Failed to load seed knowledge'),
        `cold start must not hit the seed catch. Output:\n${output}`);

      const seeded = JSON.parse(fs.readFileSync(path.join(tmpDir, 'data', 'learnings.json'), 'utf-8'));
      assert.ok(Array.isArray(seeded) && seeded.length > 0,
        'cold start must materialize a non-empty data/learnings.json');
    } finally {
      if (child) { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
