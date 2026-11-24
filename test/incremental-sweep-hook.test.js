'use strict';

/**
 * INCREMENTAL-SWEEP D7: Claude Code PreCompact hook entry + capture-core
 * routing of over-25MB transcripts. Delete-free: every case writes under a
 * unique new directory in os.tmpdir() and nothing is removed.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const installer = require('../lib/installer.js');
const capture = require('../scripts/capture-core.js');

let seq = 0;
function freshHome(tag) {
  const dir = path.join(os.tmpdir(), `auxilo-incsweep-hook-${process.pid}-${Date.now()}-${seq++}-${tag}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function settingsOf(home) {
  return JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf-8'));
}
function writeSettings(home, obj) {
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify(obj, null, 2));
}

describe('INCREMENTAL-SWEEP D7 - installer PreCompact entry', () => {
  it('registers one structured command entry under hooks.PreCompact', () => {
    const home = freshHome('reg');
    const r = installer.registerClaudeCodePreCompactHook(home);
    assert.equal(r.changed, true);
    const s = settingsOf(home);
    assert.equal(s.hooks.PreCompact.length, 1);
    assert.deepEqual(s.hooks.PreCompact[0], { hooks: [{ type: 'command', command: r.hookCmd }] });
    assert.match(r.hookCmd, /^node ".*\/\.auxilo\/bin\/scripts\/capture-core\.js" --source claude-code$/);
    assert.equal(r.hookCmd, installer.preCompactHookCommand(home));
  });

  it('is idempotent: a second registration changes nothing', () => {
    const home = freshHome('idem');
    installer.registerClaudeCodePreCompactHook(home);
    const before = fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf-8');
    const again = installer.registerClaudeCodePreCompactHook(home);
    assert.equal(again.changed, false);
    assert.equal(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf-8'), before);
  });

  it('preserves non-Auxilo entries and does not touch SessionEnd', () => {
    const home = freshHome('keep');
    writeSettings(home, {
      theme: 'dark',
      hooks: {
        PreCompact: [{ hooks: [{ type: 'command', command: '/usr/local/bin/other-hook.sh' }] }],
        SessionEnd: [{ hooks: [{ type: 'command', command: '/usr/local/bin/end.sh' }] }],
      },
    });
    installer.registerClaudeCodePreCompactHook(home);
    const s = settingsOf(home);
    assert.equal(s.theme, 'dark');
    assert.equal(s.hooks.PreCompact.length, 2);
    assert.equal(s.hooks.PreCompact[0].hooks[0].command, '/usr/local/bin/other-hook.sh');
    assert.equal(s.hooks.SessionEnd.length, 1);
  });

  it('replaces a stale Auxilo entry instead of duplicating it', () => {
    const home = freshHome('stale');
    writeSettings(home, { hooks: { PreCompact: [
      { hooks: [{ type: 'command', command: '/old/.auxilo/bin/auxilo-extract.sh' }] },
    ] } });
    const r = installer.registerClaudeCodePreCompactHook(home);
    assert.equal(r.changed, true);
    assert.deepEqual(r.removedLegacy, ['/old/.auxilo/bin/auxilo-extract.sh']);
    assert.equal(settingsOf(home).hooks.PreCompact.length, 1);
  });

  it('remove drops only Auxilo commands, keeps a shared group sibling, and is idempotent', () => {
    const home = freshHome('rm');
    const cmd = installer.preCompactHookCommand(home);
    writeSettings(home, { hooks: { PreCompact: [
      { hooks: [{ type: 'command', command: cmd }, { type: 'command', command: '/x/mine.sh' }] },
    ] } });
    const r = installer.removeClaudeCodePreCompactHook(home);
    assert.equal(r.changed, true);
    assert.deepEqual(r.removed, [cmd]);
    assert.deepEqual(settingsOf(home).hooks.PreCompact, [{ hooks: [{ type: 'command', command: '/x/mine.sh' }] }]);
    assert.equal(installer.removeClaudeCodePreCompactHook(home).changed, false);
  });

  it('remove on a missing settings file is a no-op', () => {
    const home = freshHome('none');
    assert.deepEqual(installer.removeClaudeCodePreCompactHook(home), { changed: false, removed: [] });
  });

  it('malformed settings.json throws and is not overwritten', () => {
    const home = freshHome('bad');
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{ not json');
    assert.throws(() => installer.registerClaudeCodePreCompactHook(home));
    assert.equal(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf-8'), '{ not json');
  });
});

describe('INCREMENTAL-SWEEP D7 - capture-core routing (pure)', () => {
  const base = { runnerPath: '/r/runner.js', transcriptPath: '/t/a.jsonl', source: 'claude-code' };

  it('under the gate: whole-file run, unchanged args', () => {
    const p = capture.planRunnerArgs({ ...base, size: 1000, offsetCapable: true });
    assert.equal(p.action, 'whole');
    assert.deepEqual(p.args, ['/r/runner.js', '--transcript', '/t/a.jsonl', '--source', 'claude-code']);
  });

  it('exactly at the gate stays whole-file; one byte over routes by capability', () => {
    assert.equal(capture.planRunnerArgs({ ...base, size: capture.MAX_TRANSCRIPT_BYTES, offsetCapable: false }).action, 'whole');
    assert.equal(capture.planRunnerArgs({ ...base, size: capture.MAX_TRANSCRIPT_BYTES + 1, offsetCapable: true }).action, 'incremental');
  });

  it('over the gate and capable: incremental args with --max-segments 3', () => {
    const p = capture.planRunnerArgs({ ...base, size: capture.MAX_TRANSCRIPT_BYTES + 1, offsetCapable: true });
    assert.deepEqual(p.args, ['/r/runner.js', '--transcript', '/t/a.jsonl', '--source', 'claude-code', '--incremental', '--max-segments', '3']);
  });

  it('over the gate and not capable: refused with no args', () => {
    const p = capture.planRunnerArgs({ ...base, size: capture.MAX_TRANSCRIPT_BYTES + 1, offsetCapable: false });
    assert.deepEqual(p, { action: 'refuse', args: [] });
  });

  it('sourceIsOffsetCapable reads the adapter flag and fails closed', () => {
    assert.equal(capture.sourceIsOffsetCapable('x', { loadClass: () => class { get offsetCapable() { return true; } } }), true);
    assert.equal(capture.sourceIsOffsetCapable('x', { loadClass: () => class { get offsetCapable() { return false; } } }), false);
    assert.equal(capture.sourceIsOffsetCapable('x', { loadClass: () => { throw new Error('boom'); } }), false);
    assert.equal(capture.sourceIsOffsetCapable('x', { loadClass: () => null }), false);
  });

  it('real adapters: claude-code and codex-cli capable', () => {
    assert.equal(capture.sourceIsOffsetCapable('claude-code'), true);
    assert.equal(capture.sourceIsOffsetCapable('codex-cli'), true);
  });

  it('extension allowlist is unchanged (.zst and .db stay refused)', () => {
    assert.deepEqual([...capture.TRANSCRIPT_EXTS], ['.jsonl', '.json', '.md', '.txt']);
  });

  it('payload without a transcript path yields null', () => {
    assert.equal(capture.extractTranscriptPath({ hook_event_name: 'PreCompact', trigger: 'auto' }), null);
    assert.equal(capture.extractTranscriptPath(null), null);
  });
});

// End-to-end through the real capture-core process with a fake runner that
// records its argv. The runner is spawned detached, so poll for the marker.
function runCapture({ home, source, payload, env, sentinel = true }) {
  fs.mkdirSync(path.join(home, '.auxilo'), { recursive: true });
  if (sentinel) fs.writeFileSync(path.join(home, '.auxilo', 'autonomous-enabled'), '1');
  const marker = path.join(home, 'runner-argv.json');
  const fake = path.join(home, 'fake-runner.js');
  fs.writeFileSync(fake, `require('fs').writeFileSync(${JSON.stringify(marker)}, JSON.stringify(process.argv.slice(2)));`);
  return new Promise((resolve) => {
    const child = spawn(process.execPath,
      [path.join(__dirname, '..', 'scripts', 'capture-core.js'), '--source', source, '--home', home, '--runner', fake],
      { stdio: ['pipe', 'ignore', 'ignore'], env: { ...process.env, ...env } });
    child.on('close', async (code) => {
      let argv = null;
      for (let i = 0; i < 25 && !argv; i++) {
        if (fs.existsSync(marker)) { try { argv = JSON.parse(fs.readFileSync(marker, 'utf-8')); } catch { /* partial write */ } }
        if (!argv) await new Promise(r => setTimeout(r, 100));
      }
      resolve({ code, argv });
    });
    child.stdin.end(payload);
  });
}
function bigFile(home, rel) {
  const p = path.join(home, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, '');
  fs.truncateSync(p, capture.MAX_TRANSCRIPT_BYTES + 4096); // sparse
  return fs.realpathSync(p);
}

describe('INCREMENTAL-SWEEP D7 - capture-core process behavior', () => {
  it('over 25MB + offset-capable: spawns the runner in incremental mode', async () => {
    const home = freshHome('big');
    const t = bigFile(home, '.claude/projects/p/s.jsonl');
    const r = await runCapture({ home, source: 'claude-code', payload: JSON.stringify({ transcript_path: t, hook_event_name: 'PreCompact' }) });
    assert.equal(r.code, 0);
    assert.deepEqual(r.argv, ['--transcript', t, '--source', 'claude-code', '--incremental', '--max-segments', '3']);
  });

  it('every shipped adapter is offset-capable, so the refusal is reachable only for a disallowed extension or a failed adapter load', async () => {
    for (const id of ['claude-code', 'codex-cli', 'cline', 'roo-code', 'continue', 'gemini-cli', 'devin', 'copilot', 'antigravity', 'openclaw']) {
      assert.equal(capture.sourceIsOffsetCapable(id), true, id);
    }
    const home = freshHome('ext');
    const t = bigFile(home, '.claude/projects/p/s.db'); // over 25MB, extension not allowed
    const r = await runCapture({ home, source: 'claude-code', payload: JSON.stringify({ transcript_path: t }) });
    assert.equal(r.code, 0);
    assert.equal(r.argv, null);
  });

  it('kill switch (no consent sentinel): no spawn', async () => {
    const home = freshHome('kill');
    const t = bigFile(home, '.claude/projects/p/s.jsonl');
    const r = await runCapture({ home, source: 'claude-code', sentinel: false, payload: JSON.stringify({ transcript_path: t }) });
    assert.equal(r.code, 0);
    assert.equal(r.argv, null);
  });

  it('recursion guard (AUXILO_EXTRACTING=1): no spawn', async () => {
    const home = freshHome('guard');
    const t = bigFile(home, '.claude/projects/p/s.jsonl');
    const r = await runCapture({ home, source: 'claude-code', env: { AUXILO_EXTRACTING: '1' }, payload: JSON.stringify({ transcript_path: t }) });
    assert.equal(r.code, 0);
    assert.equal(r.argv, null);
  });

  it('missing transcript_path: silent exit 0, no spawn', async () => {
    const home = freshHome('nopath');
    const r = await runCapture({ home, source: 'claude-code', payload: JSON.stringify({ hook_event_name: 'PreCompact', trigger: 'auto' }) });
    assert.equal(r.code, 0);
    assert.equal(r.argv, null);
  });

  it('non-JSON stdin: silent exit 0, no spawn', async () => {
    const home = freshHome('junk');
    const r = await runCapture({ home, source: 'claude-code', payload: 'not json' });
    assert.equal(r.code, 0);
    assert.equal(r.argv, null);
  });

  it('under 25MB: whole-file args, no incremental flags', async () => {
    const home = freshHome('small');
    const p = path.join(home, '.claude', 'projects', 'p', 's.jsonl');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '{"type":"user"}\n');
    const t = fs.realpathSync(p);
    const r = await runCapture({ home, source: 'claude-code', payload: JSON.stringify({ transcript_path: t }) });
    assert.deepEqual(r.argv, ['--transcript', t, '--source', 'claude-code']);
  });
});
