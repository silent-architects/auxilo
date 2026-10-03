'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const installer = require('../lib/installer');
const hooks = require('../lib/hook-status');
const capture = require('../scripts/capture-core');
const provider = require('../scripts/providers/claude-code');
const byo = require('../scripts/providers/byo-key');
const runner = require('../scripts/runner');
const notice = require('../scripts/review-notice');
function home(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'client-win32-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function installedCore(dir) {
  const scripts = path.join(dir, '.auxilo', 'bin', 'scripts');
  fs.mkdirSync(scripts, { recursive: true });
  for (const file of ['capture-core.js', 'review-notice.js']) fs.writeFileSync(path.join(scripts, file), '// fixture');
}
function json(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
test('b1 Windows Claude hooks are node commands, idempotent and removable', t => {
  const dir = home(t); installedCore(dir);
  const options = { platform: 'win32' };
  const first = installer.registerClaudeCodeHook(dir, options);
  assert.equal(first.hookCmd, `node "${path.join(dir, '.auxilo/bin/scripts/capture-core.js').replace(/\\/g, '/')}" --source claude-code`);
  const start = installer.registerClaudeCodeSessionStartNotice(dir, options);
  assert.equal(start.hookCmd, `node "${path.join(dir, '.auxilo/bin/scripts/review-notice.js').replace(/\\/g, '/')}"`);
  assert.equal(installer.registerClaudeCodeHook(dir, options).changed, false);
  assert.equal(installer.registerClaudeCodeSessionStartNotice(dir, options).changed, false);
  const settings = json(path.join(dir, '.claude/settings.json'));
  assert.equal(hooks.hasAuxiloSessionEndHook(settings.hooks.SessionEnd), true);
  assert.equal(installer.sessionStartNoticeRegistered(dir, options), true);
  installer.removeClaudeCodeHook(dir);
  assert.equal(hooks.hasAuxiloSessionEndHook(json(path.join(dir, '.claude/settings.json')).hooks.SessionEnd), false);
  assert.equal(fs.readdirSync(path.join(dir, '.auxilo/bin')).some(name => name.endsWith('.sh')), false);
});
test('b1 every Windows capture client uses the shared node core and removal recognizes it', t => {
  const dir = home(t); installedCore(dir);
  const clients = installer.clientRegistry(dir, { platform: 'win32', env: {} }).filter(c => c.captureHook);
  assert.ok(clients.length >= 5);
  for (const client of clients) {
    const result = installer.registerCaptureHook(client, dir);
    assert.match(result.hookPath, /^node "[^\\]*\/capture-core\.js" --source [a-z-]+$/);
    assert.doesNotMatch(result.hookPath, /\.sh/);
    assert.equal(installer.captureHookRegistered(client, dir), true);
    assert.equal(installer.registerCaptureHook(client, dir).changed, false);
  }
  installer.removeCaptureHooks(dir, clients);
  for (const client of clients) assert.equal(installer.captureHookRegistered(client, dir), false);
});
test('b1 Darwin registration keeps the existing shell command shape', t => {
  const dir = home(t);
  const result = installer.registerClaudeCodeHook(dir, { platform: 'darwin' });
  assert.equal(result.hookCmd, path.join(dir, '.auxilo', 'bin', 'auxilo-extract.sh'));
  assert.deepEqual(json(path.join(dir, '.claude/settings.json')).hooks.SessionEnd,
    [{ hooks: [{ type: 'command', command: result.hookCmd }] }]);
});
test('b2 PATHEXT lookup finds exe and cmd without shell invocation', () => {
  for (const extension of ['.exe', '.cmd']) {
    const expected = `C:\\Fixture\\Tools\\claude${extension}`;
    const found = installer.findExecutableOnPath('claude', 'C:\\Fixture\\Tools', {
      statSync: value => ({ isFile: () => value === expected }), accessSync() {},
    }, { platform: 'win32', env: { PATHEXT: '.EXE;.CMD' } });
    assert.equal(found, expected);
  }
});
test('b2 Windows MCP CLI shim resolves to node and never executes cmd', t => {
  const dir = home(t);
  const bin = path.join(dir, 'claude.cmd');
  const cli = path.join(dir, 'node_modules/@anthropic-ai/claude-code/cli.js');
  fs.mkdirSync(path.dirname(cli), { recursive: true }); fs.writeFileSync(cli, '// fixture');
  const client = installer.clientRegistry(dir, { platform: 'win32', env: {} }).find(c => c.id === 'claude-code');
  const calls = [];
  installer.registerMcp(client, '0.9.28', { claudeBin: bin, commandRunner: (...args) => { calls.push(args); return { status: 0, stdout: 'Status: Connected' }; } });
  assert.equal(calls.length, 2);
  for (const [command, args, opts] of calls) { assert.equal(command, process.execPath); assert.equal(args[0], cli); assert.equal(opts.shell, undefined); assert.equal(opts.windowsHide, true); }
});
test('b3 npm shim resolves cli.js preserving shell characters and both empty arguments', async t => {
  const dir = home(t);
  const bin = path.join(dir, 'special & % ^ ( ) space', 'claude.cmd');
  const cli = path.join(path.dirname(bin), 'node_modules/@anthropic-ai/claude-code/cli.js');
  fs.mkdirSync(path.dirname(cli), { recursive: true }); fs.writeFileSync(cli, '// fixture');
  const calls = [];
  const result = await provider.runModel({ platform: 'win32', homeDir: dir, cwd: dir, env: {}, claudeBin: bin,
    beforeModelInvocation: () => true, input: 'fixture transcript', prompt: 'fixture prompt',
    spawnSyncImpl: (...args) => { calls.push(args); return { status: 0, stdout: JSON.stringify({ type: 'result', result: 'fixture output' }) }; } });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], process.execPath);
  assert.deepEqual(calls[0][1], [cli, ...provider.EXTRACT_MODE_ARGV]);
  assert.equal(calls[0][1].filter(value => value === '').length, 2);
  assert.equal(calls[0][2].windowsHide, true);
  assert.equal(calls[0][2].shell, undefined);
  assert.equal(calls[0][2].input, 'fixture promptfixture transcript');
});
test('b3 missing npm cli.js refuses before any invocation', async t => {
  const dir = home(t); let calls = 0;
  const result = await provider.runModel({ platform: 'win32', homeDir: dir, cwd: dir, env: {}, claudeBin: path.join(dir, 'claude.cmd'),
    beforeModelInvocation: () => true, spawnSyncImpl: () => { calls++; } });
  assert.equal(result.reasonCode, 'cli-not-installed'); assert.equal(result.refusal, 'pre-invocation'); assert.equal(calls, 0);
});
test('b2 native executable is passed directly and Windows recorded candidates are accepted', async t => {
  const dir = home(t); const bin = path.join(dir, '.local/bin/claude.exe');
  fs.mkdirSync(path.dirname(bin), { recursive: true }); fs.writeFileSync(bin, 'fixture');
  fs.mkdirSync(path.join(dir, '.auxilo')); fs.writeFileSync(path.join(dir, '.auxilo/runner-config.json'), JSON.stringify({ claude_bin: bin }));
  assert.equal(provider.resolveClaudeBin({ platform: 'win32', homeDir: dir, env: {} }), bin);
  const calls = [];
  await provider.runModel({ platform: 'win32', homeDir: dir, cwd: dir, env: {}, claudeBin: bin, beforeModelInvocation: () => true,
    spawnSyncImpl: (...args) => { calls.push(args); return { status: 0, stdout: JSON.stringify({ type: 'result', result: 'fixture' }) }; } });
  assert.equal(calls[0][0], bin); assert.equal(calls[0][2].windowsHide, true);
});
test('b4 parsed hook values recognize JSON-escaped backslash paths', t => {
  const dir = home(t); const client = installer.clientRegistry(dir, { platform: 'win32', env: {} }).find(c => c.id === 'cursor');
  const shim = installer.captureShimPath(dir, 'cursor');
  fs.mkdirSync(path.dirname(shim), { recursive: true }); fs.writeFileSync(shim, 'fixture');
  fs.mkdirSync(path.dirname(client.captureConfigPath), { recursive: true });
  fs.writeFileSync(client.captureConfigPath, JSON.stringify({ hooks: { stop: [{ command: shim }] } }));
  assert.equal(installer.captureHookRegistered(client, dir), true);
});
test('b5 provider file must stay under the canonical profile, including missing file and symlink escape', t => {
  const dir = home(t); const outside = home(t);
  const cli = require('../bin/auxilo-cli');
  const sentence = cli.providerKeyConsentSentence('win32');
  assert.match(sentence, /It stays on this machine in your user profile folder, at \.auxilo\\providers\.json, and Auxilo never receives it\./);
  assert.doesNotMatch(sentence, /readable only|chmod|mode 0600/);
  assert.equal(cli.providerKeyConsentSentence('darwin'), cli.PROVIDER_KEY_CONSENT_SENTENCE);
  const inside = path.join(dir, '.auxilo/providers.json');
  const opts = { platform: 'win32', homeDir: dir, providersStatePath: inside };
  assert.equal(byo.isProvidersFileModeUnsafe(opts), false);
  fs.mkdirSync(path.dirname(inside)); fs.writeFileSync(inside, '{}');
  assert.equal(byo.isProvidersFileModeUnsafe(opts), false);
  assert.equal(byo.isProvidersFileModeUnsafe({ ...opts, providersStatePath: path.join(outside, 'providers.json') }), true);
  assert.equal(byo.isProvidersFileModeUnsafe({ ...opts, realpathSyncImpl: value => value === inside ? path.join(outside, 'providers.json') : fs.realpathSync.native(value) }), true);
});
test('b6 Windows notification is hidden, count-only, optional and fail-silent', () => {
  const calls = []; const spawnImpl = (...args) => { calls.push(args); return { on() {}, unref() {} }; };
  runner.notifyHeld(1, { platform: 'win32', env: {}, spawnImpl });
  assert.equal(calls[0][0], 'powershell.exe'); assert.equal(calls[0][2].windowsHide, true); assert.equal(calls[0][2].detached, true);
  assert.match(calls[0][1].at(-1), /1 learning is waiting for your review\. Run npx auxilo review/);
  runner.notifyHeld(2, { platform: 'darwin', env: {}, spawnImpl });
  assert.match(calls[1][1][1], /2 learnings are waiting for your review\. Run npx auxilo review/);
  runner.notifyHeld(3, { platform: 'win32', env: { AUXILO_NO_NOTIFY: '1' }, spawnImpl });
  assert.equal(calls.length, 2);
  assert.doesNotThrow(() => runner.notifyHeld(2, { platform: 'win32', env: {}, spawnImpl() { throw new Error('fixture'); } }));
  assert.equal(notice.renderNotice(1), 'Auxilo: 1 learning is waiting for your review. Run auxilo_review (MCP) or `npx auxilo review`.');
  assert.equal(notice.renderNotice(2), 'Auxilo: 2 learnings are waiting for your review. Run auxilo_review (MCP) or `npx auxilo review`.');
});
test('b7 Windows home comes from homedir despite a conflicting POSIX HOME', t => {
  const dir = home(t); fs.mkdirSync(path.join(dir, '.auxilo')); fs.writeFileSync(path.join(dir, '.auxilo/autonomous-enabled'), '');
  const selected = capture.captureHome('win32', { HOME: '/fixture/wrong', USERPROFILE: dir }, () => dir);
  assert.equal(selected, dir); assert.equal(fs.existsSync(path.join(selected, '.auxilo/autonomous-enabled')), true);
});
test('b8 transcript allowlist compares real Windows paths case-insensitively and enforces root boundaries', () => {
  const dir = 'C:\\Users\\Fixture';
  const opts = { platform: 'win32', realpathSync: value => value };
  assert.equal(capture.transcriptPathAllowed('c:\\users\\fixture\\.claude\\session.jsonl', dir, opts), true);
  assert.equal(capture.transcriptPathAllowed('c:\\users\\fixture-other\\.claude\\session.jsonl', dir, opts), false);
  assert.equal(capture.transcriptPathAllowed('c:\\users\\fixture\\.claude\\session.exe', dir, opts), false);
});
test('b8 Windows Desktop gets cmd /c npx registration and a version rewrite', t => {
  const dir = home(t); const client = installer.clientRegistry(dir, { platform: 'win32', env: {} }).find(c => c.id === 'claude-desktop');
  installer.registerMcp(client, '0.9.19'); installer.registerMcp(client, '0.9.28');
  assert.deepEqual(json(client.configPath).mcpServers.auxilo, { command: 'cmd', args: ['/c', 'npx', 'auxilo-mcp@0.9.28'] });
});

test('b1 unrelated node hook basenames survive Claude registration/removal and never count as Auxilo', t => {
  const dir = home(t); installedCore(dir);
  const settingsFile = path.join(dir, '.claude', 'settings.json');
  const foreignCapture = { type: 'command', command: 'node "C:/third-party/scripts/capture-core.js" --source claude-code' };
  const foreignNotice = { type: 'command', command: 'node "C:/third-party/scripts/review-notice.js"' };
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify({ hooks: { SessionEnd: [{ hooks: [foreignCapture] }], SessionStart: [{ hooks: [foreignNotice] }] } }));
  assert.equal(hooks.hasAuxiloSessionEndHook(json(settingsFile).hooks.SessionEnd), false);
  assert.equal(installer.sessionStartNoticeRegistered(dir), false);
  installer.registerClaudeCodeHook(dir, { platform: 'win32' });
  installer.registerClaudeCodeSessionStartNotice(dir, { platform: 'win32' });
  assert.deepEqual(json(settingsFile).hooks.SessionEnd[0].hooks, [foreignCapture]);
  assert.deepEqual(json(settingsFile).hooks.SessionStart[0].hooks, [foreignNotice]);
  assert.equal(installer.registerClaudeCodeHook(dir, { platform: 'win32' }).changed, false);
  assert.equal(installer.registerClaudeCodeSessionStartNotice(dir, { platform: 'win32' }).changed, false);
  installer.removeClaudeCodeHook(dir);
  assert.deepEqual(json(settingsFile).hooks.SessionEnd, [{ hooks: [foreignCapture] }]);
  assert.deepEqual(json(settingsFile).hooks.SessionStart[0].hooks, [foreignNotice]);
  assert.equal(hooks.hasAuxiloSessionEndHook(json(settingsFile).hooks.SessionEnd), false);
  assert.equal(hooks.isAuxiloNodeHook('node "C:/PROFILE/.AUXILO/BIN/SCRIPTS/CAPTURE-CORE.JS" --source claude-code', 'capture-core.js', 'claude-code'), true);
  assert.equal(hooks.isAuxiloNodeHook('node "C:/profile/.auxilo/bin/scripts/capture-core.js" --source claude-code-extra', 'capture-core.js', 'claude-code'), false);
  assert.equal(hooks.isAuxiloNodeHook('node "C:/profile/.auxilo/bin/scripts/review-notice.js" && whoami', 'review-notice.js'), false);
});
test('b1 unrelated flat and group capture hooks survive registration and removal', t => {
  const dir = home(t); installedCore(dir);
  for (const [id, event] of [['cursor', 'stop'], ['gemini-cli', 'SessionEnd']]) {
    const client = installer.clientRegistry(dir, { platform: 'win32', env: {} }).find(c => c.id === id);
    const foreign = { type: 'command', command: `node "C:/third-party/scripts/capture-core.js" --source ${client.sourceId || id}` };
    const entry = id === 'cursor' ? foreign : { hooks: [foreign] };
    fs.mkdirSync(path.dirname(client.captureConfigPath), { recursive: true });
    fs.writeFileSync(client.captureConfigPath, JSON.stringify({ hooks: { [event]: [entry] } }));
    assert.equal(installer.captureHookRegistered(client, dir), false);
    installer.registerCaptureHook(client, dir);
    assert.deepEqual(json(client.captureConfigPath).hooks[event][0], entry);
    assert.equal(installer.captureHookRegistered(client, dir), true);
    assert.equal(installer.registerCaptureHook(client, dir).changed, false);
    installer.removeCaptureHook(client, dir);
    assert.deepEqual(json(client.captureConfigPath).hooks[event], [entry]);
    assert.equal(installer.captureHookRegistered(client, dir), false);
  }
});
