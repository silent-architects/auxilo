'use strict';

const { it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const provider = require('../scripts/providers/claude-code.js');
const installer = require('../lib/installer.js');

const HOME = '/fixture/cli-resolution-home';
const CONFIG = path.join(HOME, '.auxilo', 'runner-config.json');
const LOCAL = path.join(HOME, '.claude', 'local', 'claude');
const SYSTEM = '/usr/local/bin/claude';
const NPM = path.join(HOME, '.npm-global', 'bin', 'claude');
const RECORDED = '/fixture/custom/bin/claude';
const NATIVE = '/fixture/npm/@anthropic-ai/claude-code/bin/claude.exe';
const NATIVE_PACKAGE = '/fixture/npm/@anthropic-ai/claude-code/package.json';
const temps = [];

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auxilo-cli-binary-resolution-'));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  provider._resetSettingSourcesCacheForTests();
  while (temps.length) fs.rmSync(temps.pop(), { recursive: true, force: true });
});

function fixture() {
  const files = new Map();
  const binaries = new Map();
  const checked = [];
  const reads = [];
  const spawns = [];
  const opts = {
    homeDir: HOME,
    cwd: HOME,
    existsSync: (file) => { checked.push(file); return binaries.has(file); },
    realpathSyncImpl: (bin) => {
      if (!binaries.has(bin)) throw new Error('fixture binary absent');
      return binaries.get(bin);
    },
    readFileSyncImpl: (file) => {
      reads.push(file);
      if (!files.has(file)) throw new Error('fixture file absent');
      return files.get(file);
    },
    spawnSyncImpl: (...args) => {
      spawns.push(args);
      throw new Error('unexpected spawn');
    },
  };
  function add(bin, version, real = bin) {
    binaries.set(bin, real);
    if (version !== undefined) files.set(path.join(path.dirname(real), 'package.json'), JSON.stringify({ version }));
  }
  return { files, binaries, checked, reads, spawns, opts, add };
}

function oldAndNative() {
  const f = fixture();
  f.add(SYSTEM, '2.1.12', '/fixture/global/@anthropic-ai/claude-code/cli.js');
  f.add(NPM, undefined, NATIVE);
  f.files.set(NATIVE_PACKAGE, JSON.stringify({ name: '@anthropic-ai/claude-code', version: '2.1.251' }));
  return f;
}

function executable(dir, name = 'claude') {
  fs.mkdirSync(dir, { recursive: true });
  const bin = path.join(dir, name);
  fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  return bin;
}

it('T1: newest native npm-global CLI wins over the old system CLI', () => {
  const f = oldAndNative();
  assert.equal(provider.resolveClaudeBin(f.opts), NPM);
  assert.deepEqual(f.checked, [LOCAL, SYSTEM, '/opt/homebrew/bin/claude', path.join(HOME, '.local/bin/claude'), NPM]);
  assert.deepEqual(f.spawns, []);
});

it('T2: a newer recorded CLI wins; equal versions preserve the earlier candidate', () => {
  const f = oldAndNative();
  f.files.set(CONFIG, JSON.stringify({ claude_bin: RECORDED }));
  f.add(RECORDED, '2.1.266');
  assert.equal(provider.resolveClaudeBin(f.opts), RECORDED);
  f.add(RECORDED, '2.1.251-fixture');
  assert.equal(provider.resolveClaudeBin(f.opts), RECORDED, 'leading triple ties the native version');
  f.add(RECORDED, '2.1.9');
  assert.equal(provider.resolveClaudeBin(f.opts), NPM, 'a recorded path does not override a newer CLI');
  f.add(RECORDED, '2.10.0');
  assert.equal(provider.resolveClaudeBin(f.opts), RECORDED, 'minor versions compare numerically');
  f.add(RECORDED, '3.0.0');
  assert.equal(provider.resolveClaudeBin(f.opts), RECORDED, 'major versions compare numerically');
  assert.deepEqual(f.spawns, []);
});

it('T3: missing, relative and wrong-basename records plus malformed config are ignored', () => {
  for (const value of ['/fixture/missing/claude', 'relative/claude', '/fixture/custom/bin/not-claude', null, 42]) {
    const f = oldAndNative();
    f.files.set(CONFIG, JSON.stringify({ claude_bin: value }));
    if (typeof value === 'string' && !value.includes('missing')) f.add(value, '99.0.0');
    assert.equal(provider.resolveClaudeBin(f.opts), NPM, String(value));
    if (value !== '/fixture/missing/claude') assert.ok(!f.checked.includes(value));
    assert.deepEqual(f.spawns, []);
  }
  for (const config of ['{bad json', 'null', '{}', '[]']) {
    const f = oldAndNative();
    f.files.set(CONFIG, config);
    assert.equal(provider.resolveClaudeBin(f.opts), NPM, config);
    assert.deepEqual(f.spawns, []);
  }
});

it('T4: no readable version preserves first-existing order, including a recorded candidate', () => {
  const f = fixture();
  f.add(LOCAL, 'unknown');
  f.add(SYSTEM, 'v9.9.9');
  f.add(NPM, '2.1');
  assert.equal(provider.resolveClaudeBin(f.opts), LOCAL);
  f.add(RECORDED);
  f.files.set(CONFIG, JSON.stringify({ claude_bin: RECORDED }));
  assert.equal(provider.resolveClaudeBin(f.opts), RECORDED);
  f.binaries.delete(RECORDED);
  f.binaries.delete(LOCAL);
  assert.equal(provider.resolveClaudeBin(f.opts), SYSTEM);
  assert.deepEqual(f.spawns, []);
});

it('T5: all candidates missing returns bare claude', () => {
  const f = fixture();
  assert.equal(provider.resolveClaudeBin(f.opts), 'claude');
  assert.deepEqual(f.spawns, []);
});

it('T6: native package version is returned and follows the selected binary into extract and judge provenance', async () => {
  const f = oldAndNative();
  assert.equal(provider.getClaudeCliVersion(NPM, f.opts), '2.1.251');
  assert.deepEqual(f.spawns, []);
  const calls = [];
  const spawnSyncImpl = (bin, argv) => {
    calls.push({ bin, argv });
    if (argv[0] === 'auth') return { status: 0, stdout: '{"loggedIn":true}' };
    return { status: 0, stdout: '{"result":"SAME","learnings":[]}' };
  };
  for (const mode of ['extract', 'judge']) {
    const result = await provider.runModel({ ...f.opts, mode, prompt: 'fixture', input: 'fixture', spawnSyncImpl });
    assert.equal(result.ok, true, mode);
    assert.equal(result.cliVersion, '2.1.251', mode);
  }
  assert.deepEqual(calls, [
    { bin: NPM, argv: ['auth', 'status'] },
    { bin: NPM, argv: ['-p', '--no-session-persistence', '--tools', '', '--setting-sources', ''] },
    { bin: NPM, argv: ['-p', '--output-format', 'json', '--no-session-persistence', '--tools', '', '--setting-sources', ''] },
  ]);
});

it('T7: foreign parent metadata is rejected, sibling compatibility retained, and reads never climb above the parent', () => {
  const f = oldAndNative();
  f.files.set(NATIVE_PACKAGE, JSON.stringify({ name: 'some-other-project', version: '99.0.0' }));
  f.files.set('/fixture/npm/@anthropic-ai/package.json', JSON.stringify({ name: '@anthropic-ai/claude-code', version: '100.0.0' }));
  f.reads.length = 0;
  assert.equal(provider.getClaudeCliVersion(NPM, f.opts), null);
  assert.deepEqual(f.reads, [path.join(path.dirname(NATIVE), 'package.json'), NATIVE_PACKAGE]);
  const sibling = path.join(path.dirname(NATIVE), 'package.json');
  f.files.set(sibling, '{"version":"9.9.9-fixture"}');
  assert.equal(provider.getClaudeCliVersion(NPM, f.opts), '9.9.9-fixture', 'no name check on sibling');
  for (const invalid of ['{bad json', 'null', '{"version":42}', '{}']) {
    f.files.set(sibling, invalid);
    f.files.set(NATIVE_PACKAGE, JSON.stringify({ name: '@anthropic-ai/claude-code', version: '2.1.251' }));
    assert.equal(provider.getClaudeCliVersion(NPM, f.opts), '2.1.251', 'invalid sibling still tries parent');
    f.files.set(NATIVE_PACKAGE, invalid);
    assert.equal(provider.getClaudeCliVersion(NPM, f.opts), null);
  }
  assert.equal(provider.getClaudeCliVersion('/fixture/missing/claude', f.opts), null);
  assert.deepEqual(f.spawns, []);
});

it('T8: known versions below 2.1.41 return unknown without any spawn', () => {
  const f = fixture();
  for (const version of ['2.1.12', '2.1.40', '2.0.999', '1.99.99']) {
    f.add(SYSTEM, version);
    assert.equal(provider.checkAuthStatus({ ...f.opts, claudeBin: SYSTEM }), 'unknown', version);
  }
  // checkAuthStatus catches spawn errors: the counter is needed as well as a throwing stub.
  assert.deepEqual(f.spawns, []);
});

it('T9: 2.1.251 and the exact 2.1.41 boundary retain auth status and its five-second timeout', () => {
  const f = fixture();
  for (const version of ['2.1.251', '2.1.41']) {
    f.add(SYSTEM, version);
    const calls = [];
    assert.equal(provider.checkAuthStatus({
      ...f.opts, claudeBin: SYSTEM,
      spawnSyncImpl: (bin, args, opts) => { calls.push({ bin, args, opts }); return { status: 0, stdout: '{"loggedIn":true}' }; },
    }), 'logged-in');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].bin, SYSTEM);
    assert.deepEqual(calls[0].args, ['auth', 'status']);
    assert.equal(calls[0].opts.timeout, 5000);
  }
});

it('T10: bare claude and unreadable versions retain the existing auth probe', () => {
  const f = fixture();
  f.add(SYSTEM, 'unreadable');
  for (const bin of ['claude', SYSTEM]) {
    const calls = [];
    assert.equal(provider.checkAuthStatus({
      ...f.opts, claudeBin: bin,
      spawnSyncImpl: (actualBin, args) => { calls.push({ bin: actualBin, args }); return { status: 0, stdout: '{"loggedIn":false}' }; },
    }), 'logged-out');
    assert.deepEqual(calls, [{ bin, args: ['auth', 'status'] }]);
  }
});

it('T11: only 2.1.12 installed means detect has zero spawns and extract still invokes its unchanged argv', async () => {
  const f = fixture();
  f.add(SYSTEM, '2.1.12');
  assert.equal(provider.detect(f.opts), true);
  assert.deepEqual(f.spawns, []);
  const calls = [];
  const result = await provider.runModel({
    ...f.opts, mode: 'extract', prompt: 'fixture', input: 'transcript',
    spawnSyncImpl: (bin, args) => {
      calls.push({ bin, args });
      if (args[0] === 'auth') throw new Error('known-old CLI must never receive auth status');
      return { status: 0, stdout: '{"learnings":[]}' };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.authStatus, 'unknown');
  assert.equal(result.cliVersion, '2.1.12');
  assert.deepEqual(calls, [{ bin: SYSTEM, args: ['-p', '--no-session-persistence', '--tools', '', '--setting-sources', ''] }]);
});

it('T12: resolution and version reads tolerate filesystem errors without spawning', () => {
  const f = oldAndNative();
  assert.equal(provider.resolveClaudeBin(f.opts), NPM);
  assert.equal(provider.getClaudeCliVersion(NPM, f.opts), '2.1.251');
  const fail = () => { throw new Error('fixture filesystem denied'); };
  assert.equal(provider.resolveClaudeBin({ ...f.opts, existsSync: fail }), 'claude');
  assert.equal(provider.getClaudeCliVersion(NPM, { ...f.opts, realpathSyncImpl: fail }), null);
  assert.equal(provider.getClaudeCliVersion(NPM, { ...f.opts, readFileSyncImpl: fail }), null);
  assert.deepEqual(f.spawns, []);
});

it('T13: PATH scanning skips missing, non-regular and non-executable entries, and preserves an executable symlink', () => {
  const root = tempDir();
  const missing = path.join(root, 'missing');
  const nonexec = path.join(root, 'nonexec');
  const working = path.join(root, 'working');
  const blocked = executable(nonexec);
  fs.chmodSync(blocked, 0o600);
  const bin = executable(working);
  assert.equal(installer.findExecutableOnPath('claude', [missing, nonexec, working].join(path.delimiter)), bin);
  const directory = path.join(root, 'directory');
  fs.mkdirSync(path.join(directory, 'claude'), { recursive: true });
  assert.equal(installer.findExecutableOnPath('claude', [directory, working].join(path.delimiter)), bin);
  assert.equal(installer.findExecutableOnPath('claude', undefined), null);
  assert.equal(installer.findExecutableOnPath('claude', ''), null);
  const linkDir = path.join(root, 'links');
  fs.mkdirSync(linkDir);
  const link = path.join(linkDir, 'claude');
  fs.symlinkSync(bin, link);
  assert.equal(installer.findExecutableOnPath('claude', [linkDir, working].join(path.delimiter)), link);
  const accesses = [];
  const fsImpl = {
    statSync: (file) => { assert.equal(file, '/fixture/path/claude'); return { isFile: () => true }; },
    accessSync: (file, mode) => accesses.push({ file, mode }),
  };
  assert.equal(installer.findExecutableOnPath('claude', '/fixture/path', fsImpl), '/fixture/path/claude');
  assert.deepEqual(accesses, [{ file: '/fixture/path/claude', mode: fs.constants.X_OK }]);
});

it('T14: setup recording returns the persisted symlink path, preserves other config and writes nothing on a miss', () => {
  const home = tempDir();
  const target = executable(path.join(home, 'real'));
  const dir = path.join(home, 'path');
  fs.mkdirSync(dir);
  const bin = path.join(dir, 'claude');
  fs.symlinkSync(target, bin);
  installer.writeRunnerConfig(home, { autoupdate: false, other: 'keep' });
  assert.equal(installer.recordClaudeBin(home, dir), bin);
  assert.deepEqual(installer.readRunnerConfig(home), { autoupdate: false, other: 'keep', claude_bin: bin });
  const config = installer.runnerConfigPath(home);
  const before = fs.readFileSync(config);
  const statBefore = fs.statSync(config);
  assert.equal(installer.recordClaudeBin(home, path.join(home, 'missing')), null);
  assert.deepEqual(fs.readFileSync(config), before);
  assert.equal(fs.statSync(config).mtimeMs, statBefore.mtimeMs);
  const freshHome = tempDir();
  assert.equal(installer.recordClaudeBin(freshHome, ''), null);
  assert.equal(fs.existsSync(path.join(freshHome, '.auxilo')), false);
  // A failed rewrite still counts when the value already persisted is correct.
  fs.mkdirSync(`${config}.tmp`);
  assert.equal(installer.recordClaudeBin(home, dir), bin);
  assert.deepEqual(fs.readFileSync(config), before);
});

it('T15: a failed config write returns null, leaves no persisted claude_bin and does not throw', () => {
  const home = tempDir();
  const dir = path.join(home, 'path');
  executable(dir);
  fs.writeFileSync(path.join(home, '.auxilo'), 'blocks the config directory');
  let result;
  assert.doesNotThrow(() => { result = installer.recordClaudeBin(home, dir); });
  assert.equal(result, null);
  assert.equal(installer.readRunnerConfig(home).claude_bin, undefined);
  assert.equal(fs.readFileSync(path.join(home, '.auxilo'), 'utf8'), 'blocks the config directory');
});
