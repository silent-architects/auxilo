'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const installer = require('../lib/installer');
const review = require('../lib/review');
function fixture(t, platform = 'darwin') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'client-connect-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, '.claude'));
  const client = installer.clientRegistry(home, { platform, env: {} }).find(c => c.id === 'claude-code');
  const calls = [];
  const opts = { claudeBin: '/fixture/claude', commandRunner(bin, args, options) {
    calls.push({ bin, args, options });
    if (args[1] === 'add') {
      const commandAt = args.indexOf('--') + 1;
      fs.writeFileSync(client.configPath, JSON.stringify({ mcpServers: { auxilo: { command: args[commandAt], args: args.slice(commandAt + 1) } } }));
      return { status: 0 };
    }
    if (args[1] === 'remove') { fs.unlinkSync(client.configPath); return { status: 0 }; }
    return { status: 0, stdout: fs.existsSync(client.configPath) ? `Status: Connected\nCommand: npx\nArgs: auxilo-mcp@${installer.mcpPinnedVersion(client)}` : 'No MCP server named "auxilo"' };
  } };
  return { home, client, calls, opts };
}
test('a1 registers through CLI then reads back, without writing legacy settings', t => {
  const { client, calls, opts } = fixture(t);
  const result = installer.registerMcp(client, '0.9.28', opts);
  assert.equal(result.connection, 'connected');
  assert.deepEqual(calls[0].args, ['mcp', 'add', '--scope', 'user', 'auxilo', '--', 'npx', 'auxilo-mcp@0.9.28']);
  assert.deepEqual(calls[1].args, ['mcp', 'get', 'auxilo']);
  assert.equal(calls[1].options.timeout, 20000);
  assert.equal(fs.existsSync(client.legacyConfigPath), false);
});
test('a2 three states and read-back pin, including timeout after add', t => {
  const { client, opts } = fixture(t);
  installer.registerMcp(client, '0.9.28', opts);
  for (const [output, connection] of [['Status: Connected\nArgs: auxilo-mcp@1.2.3', 'connected'], ['No MCP server named "auxilo"', 'not-connected'], ['', 'added']]) {
    const state = installer.claudeMcpState(client, { ...opts, commandRunner: () => ({ stdout: output, error: new Error('timeout') }) });
    assert.equal(state.connection, connection);
    if (connection === 'connected') assert.equal(state.mcpPin, '1.2.3');
  }
});
test('a3 omission never invokes a runner and reports not connected', t => {
  const { client, calls } = fixture(t);
  assert.equal(installer.registerMcp(client, '0.9.28').connection, 'not-connected');
  assert.equal(calls.length, 0);
  assert.equal(fs.existsSync(client.configPath), false);
});
test('a4 missing CLI reports the specified platform command without invocation', t => {
  const { client } = fixture(t, 'win32');
  let calls = 0;
  const result = installer.registerMcp(client, '0.9.28', { env: { PATH: '' }, commandRunner() { calls++; } });
  assert.equal(result.failed, true);
  assert.equal(calls, 0);
  assert.equal(installer.claudeMcpStatusLine(result, 'win32'), 'Claude Code: not connected. Run claude mcp add --scope user auxilo -- cmd /c npx auxilo-mcp');
});
test('a5 removes only owned legacy registration after good read-back, preserving hooks', t => {
  const { client, opts } = fixture(t);
  const hooks = { SessionEnd: [{ hooks: [{ command: 'other-hook', type: 'command' }] }] };
  fs.writeFileSync(client.legacyConfigPath, JSON.stringify({ hooks, mcpServers: { auxilo: { command: 'npx', args: ['auxilo-mcp@0.9.19'] } } }));
  installer.registerMcp(client, '0.9.28', opts);
  const state = JSON.parse(fs.readFileSync(client.legacyConfigPath));
  assert.deepEqual(state.hooks, hooks);
  assert.equal(state.mcpServers.auxilo, undefined);
});
test('a5 foreign or failed-readback legacy entry remains byte-identical', t => {
  const { client, opts } = fixture(t);
  for (const foreign of [false, true]) {
    const raw = JSON.stringify({ mcpServers: { auxilo: { command: foreign ? 'custom' : 'npx', args: ['auxilo-mcp'] } }, hooks: { SessionStart: [] } });
    fs.writeFileSync(client.legacyConfigPath, raw);
    installer.registerMcp(client, '0.9.28', foreign ? opts : { ...opts, commandRunner: (_, args) => ({ status: 0, stdout: args[1] === 'get' ? 'No MCP server named "auxilo"' : '' }) });
    assert.equal(fs.readFileSync(client.legacyConfigPath, 'utf8'), raw);
  }
});
test('a6 rewrite replaces existing registration only and rolls back failed add', t => {
  const { home, client, opts, calls } = fixture(t);
  assert.deepEqual(installer.rewriteMcpPins(home, '0.9.28', opts), []);
  installer.registerMcp(client, '0.9.19', opts);
  const baseRunner = opts.commandRunner;
  let rejected = false;
  opts.commandRunner = (bin, args, options) => {
    if (args[1] === 'add' && args.includes('auxilo-mcp@0.9.28')) { rejected = true; return { status: 1 }; }
    return baseRunner(bin, args, options);
  };
  const result = installer.rewriteMcpPins(home, '0.9.28', opts)[0];
  assert.equal(rejected, true);
  assert.equal(result.changed, false);
  assert.equal(result.restored, true);
  assert.equal(installer.mcpPinnedVersion(client), '0.9.19');
  assert.ok(calls.some(c => c.args[1] === 'remove'));
  opts.commandRunner = baseRunner;
  assert.equal(installer.rewriteMcpPins(home, '0.9.28', opts)[0].changed, true);
  assert.equal(installer.mcpPinnedVersion(client), '0.9.28');
});
test('a7 Windows registration uses cmd /c npx and ownership recognizes it', t => {
  const { client, calls, opts } = fixture(t, 'win32');
  installer.registerMcp(client, '0.9.28', opts);
  assert.deepEqual(calls[0].args.slice(6), ['cmd', '/c', 'npx', 'auxilo-mcp@0.9.28']);
  assert.equal(installer.mcpPinnedVersion(client), '0.9.28');
});
test('a8 every CLI review request carries its client version hint', async () => {
  const headers = [];
  const opts = { apiKey: 'fixture', fetchImpl: async (_, init) => { headers.push(init.headers); return { ok: true, json: async () => ({ items: [], results: [] }) }; } };
  await review.fetchPending(opts);
  await review.fetchPendingSummary(opts);
  await review.submitDecision({ ...opts, id: 'fixture', decision: 'approve' });
  await review.submitBulk({ ...opts, decisions: [{ id: 'fixture', decision: 'approve' }] });
  assert.equal(headers.length, 4);
  for (const row of headers) assert.equal(row['X-Auxilo-Client'], 'cli/0.9.29');
  const source = fs.readFileSync(path.join(__dirname, '..', 'mcp-server.js'), 'utf8');
  assert.match(source.slice(source.indexOf("case 'auxilo_review':")), /headers\['X-Auxilo-Client'\] = `mcp\/\$\{require\('\.\/package.json'\).version\}`/);
});

test('a6 failed rollback is reported as failure, never unchanged', t => {
  const { home, client, opts } = fixture(t);
  installer.registerMcp(client, '0.9.19', opts);
  const run = opts.commandRunner;
  opts.commandRunner = (bin, args, options) => args[1] === 'add' ? { status: 1 } : run(bin, args, options);
  const result = installer.rewriteMcpPins(home, '0.9.28', opts)[0];
  assert.equal(result.status, 'error');
  assert.equal(result.restored, false);
  assert.equal(result.registered, false);
  assert.equal(result.mcpPin, null);
  assert.equal(fs.existsSync(client.configPath), false);
});
