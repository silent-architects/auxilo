'use strict';

/**
 * test/mcp-server-staleness.test.js — MCP-SERVER-STALENESS (0.9.17) coverage.
 *
 * The MCP server was registered in every client config as `npx auxilo-mcp`
 * with no version pin (lib/installer.js MCP_ENTRY) — npx resolves that to
 * whatever its LOCAL CACHE currently believes `latest` is, which only
 * refreshes when the cache happens to expire (INSTALL-0828: a 10-week-old
 * cached build served silently on a fresh machine). This build:
 *
 *   1. Pins every MCP registration to an exact version
 *      (`npx auxilo-mcp@<version>`) — lib/installer.js mcpEntry/registerMcp.
 *   2. Adds rewriteMcpPins(homeDir, version) — called from
 *      lib/runner-autoupdate.js's stageAndSwap after a successful
 *      self-update — which re-pins every client config ALREADY registered
 *      (never first-registers an unselected client) to the freshly
 *      installed runner version, and leaves any non-Auxilo-shaped entry
 *      completely untouched.
 *   3. Adds a mismatch-only startup notice in mcp-server.js (own package
 *      version vs ~/.auxilo/bin/VERSION).
 *   4. Surfaces the pin (and whether it's stale against the installed
 *      runner) in `auxilo status`.
 *
 * All homes are fresh mkdtemp'd fixture directories — NEVER the real
 * ~/.claude or ~/.auxilo. No network: registerMcp/rewriteMcpPins/
 * mcpPinnedVersion are pure fs. The mcp-server.js startup-notice tests spawn
 * the real file as a child process against a fixture HOME and read stderr;
 * the child is killed immediately after the notice line would have been
 * flushed (it otherwise blocks forever on stdio waiting for MCP protocol
 * input, which these tests never send).
 *
 * Runner: node --test test/mcp-server-staleness.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const REPO = path.join(__dirname, '..');
const installer = require('../lib/installer.js');

const REPO_PKG_VERSION = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf-8')).version;

function tmpHome(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n');
}

/** Minimal client-registry-shaped fixture for the direct writer tests. */
function fixtureClient(home, overrides = {}) {
  return {
    id: 'fixture',
    name: 'Fixture Client',
    configPath: path.join(home, 'config.json'),
    format: 'json-mcpServers',
    mcp: true,
    ...overrides,
  };
}

// ─── 1. mcpEntry / registerMcp pinning (per format) ─────────────────────────

describe('MCP-SERVER-STALENESS: registerMcp pins each format', () => {
  it('json-mcpServers: creates a pinned entry when absent', () => {
    const home = tmpHome('mcp-pin-json-');
    const client = fixtureClient(home);
    const result = installer.registerMcp(client, '9.9.9');
    assert.equal(result.changed, true);
    assert.equal(result.status, 'registered');
    const config = readJson(client.configPath);
    assert.deepEqual(config.mcpServers.auxilo, { command: 'npx', args: ['auxilo-mcp@9.9.9'] });
  });

  it('registerMcp defaults to packageVersion() when no version is passed', () => {
    const home = tmpHome('mcp-pin-default-');
    const client = fixtureClient(home);
    installer.registerMcp(client);
    const config = readJson(client.configPath);
    assert.deepEqual(config.mcpServers.auxilo.args, [`auxilo-mcp@${REPO_PKG_VERSION}`]);
  });

  it('json-mcpServers: idempotent no-op (byte-identical) when already pinned to target', () => {
    const home = tmpHome('mcp-pin-idem-');
    const client = fixtureClient(home);
    installer.registerMcp(client, '1.2.3');
    const before = fs.readFileSync(client.configPath, 'utf-8');
    const result = installer.registerMcp(client, '1.2.3');
    const after = fs.readFileSync(client.configPath, 'utf-8');
    assert.equal(result.changed, false);
    assert.equal(result.status, 'already-registered');
    assert.equal(after, before);
  });

  it('json-mcpServers: re-pins an owned entry when the version differs', () => {
    const home = tmpHome('mcp-pin-repin-');
    const client = fixtureClient(home);
    installer.registerMcp(client, '1.0.0');
    const result = installer.registerMcp(client, '2.0.0');
    assert.equal(result.changed, true);
    const config = readJson(client.configPath);
    assert.deepEqual(config.mcpServers.auxilo.args, ['auxilo-mcp@2.0.0']);
  });

  it('json-mcpServers: re-pins a legacy UNPINNED entry (pre-0.9.17 shape)', () => {
    const home = tmpHome('mcp-pin-legacy-');
    const client = fixtureClient(home);
    writeJson(client.configPath, { mcpServers: { auxilo: { command: 'npx', args: ['auxilo-mcp'] } } });
    const result = installer.registerMcp(client, '3.0.0');
    assert.equal(result.changed, true);
    const config = readJson(client.configPath);
    assert.deepEqual(config.mcpServers.auxilo.args, ['auxilo-mcp@3.0.0']);
  });

  it('json-mcpServers: preserves sibling servers and other keys byte-for-byte in unrelated content', () => {
    const home = tmpHome('mcp-pin-siblings-');
    const client = fixtureClient(home);
    writeJson(client.configPath, {
      someOtherTopLevelKey: { nested: true, n: 42 },
      mcpServers: {
        other_server: { command: 'node', args: ['/opt/other/server.js'], env: { FOO: 'bar' } },
      },
    });
    installer.registerMcp(client, '4.0.0');
    const config = readJson(client.configPath);
    assert.deepEqual(config.someOtherTopLevelKey, { nested: true, n: 42 });
    assert.deepEqual(config.mcpServers.other_server, { command: 'node', args: ['/opt/other/server.js'], env: { FOO: 'bar' } });
    assert.deepEqual(config.mcpServers.auxilo, { command: 'npx', args: ['auxilo-mcp@4.0.0'] });
  });

  it('json-mcpServers: never touches a foreign/hand-edited auxilo entry', () => {
    const home = tmpHome('mcp-pin-foreign-');
    const client = fixtureClient(home);
    const foreign = { command: 'node', args: ['/Users/me/dev/my-fork/mcp-server.js'] };
    writeJson(client.configPath, { mcpServers: { auxilo: foreign } });
    const before = fs.readFileSync(client.configPath, 'utf-8');
    const result = installer.registerMcp(client, '5.0.0');
    const after = fs.readFileSync(client.configPath, 'utf-8');
    assert.equal(after, before, 'foreign entry must be byte-identical after registerMcp');
    assert.equal(result.changed, false);
  });

  it('json-dropin (Continue.dev): pins the same shape as json-mcpServers', () => {
    const home = tmpHome('mcp-pin-dropin-');
    const client = fixtureClient(home, { format: 'json-dropin' });
    installer.registerMcp(client, '6.0.0');
    const config = readJson(client.configPath);
    assert.deepEqual(config.mcpServers.auxilo, { command: 'npx', args: ['auxilo-mcp@6.0.0'] });
  });

  it('opencode: pins the array command shape and re-pins on version change', () => {
    const home = tmpHome('mcp-pin-opencode-');
    const client = fixtureClient(home, { format: 'opencode' });
    installer.registerMcp(client, '7.0.0');
    let config = readJson(client.configPath);
    assert.deepEqual(config.mcp.auxilo, { type: 'local', command: ['npx', 'auxilo-mcp@7.0.0'] });
    const result = installer.registerMcp(client, '7.0.1');
    assert.equal(result.changed, true);
    config = readJson(client.configPath);
    assert.deepEqual(config.mcp.auxilo.command, ['npx', 'auxilo-mcp@7.0.1']);
  });

  it('opencode: never touches a foreign entry', () => {
    const home = tmpHome('mcp-pin-opencode-foreign-');
    const client = fixtureClient(home, { format: 'opencode' });
    const foreign = { type: 'remote', url: 'https://example.com/mcp' };
    writeJson(client.configPath, { mcp: { auxilo: foreign } });
    const before = fs.readFileSync(client.configPath, 'utf-8');
    installer.registerMcp(client, '7.0.2');
    assert.equal(fs.readFileSync(client.configPath, 'utf-8'), before);
  });

  it('amp: pins under amp.mcpServers and re-pins on version change', () => {
    const home = tmpHome('mcp-pin-amp-');
    const client = fixtureClient(home, { format: 'amp' });
    installer.registerMcp(client, '8.0.0');
    let config = readJson(client.configPath);
    assert.deepEqual(config['amp.mcpServers'].auxilo, { command: 'npx', args: ['auxilo-mcp@8.0.0'] });
    installer.registerMcp(client, '8.0.1');
    config = readJson(client.configPath);
    assert.deepEqual(config['amp.mcpServers'].auxilo.args, ['auxilo-mcp@8.0.1']);
  });

  it('openhands-stdio: pins the named array entry and re-pins in place (order preserved)', () => {
    const home = tmpHome('mcp-pin-openhands-');
    const client = fixtureClient(home, { format: 'openhands-stdio' });
    writeJson(client.configPath, {
      stdio_servers: [{ name: 'other', command: 'node', args: ['/opt/x.js'] }],
    });
    installer.registerMcp(client, '9.0.0');
    let config = readJson(client.configPath);
    assert.equal(config.stdio_servers.length, 2);
    assert.deepEqual(config.stdio_servers[0], { name: 'other', command: 'node', args: ['/opt/x.js'] });
    assert.deepEqual(config.stdio_servers[1], { name: 'auxilo', command: 'npx', args: ['auxilo-mcp@9.0.0'] });

    installer.registerMcp(client, '9.0.1');
    config = readJson(client.configPath);
    assert.equal(config.stdio_servers.length, 2, 're-pin must update in place, not append a duplicate');
    assert.deepEqual(config.stdio_servers[0], { name: 'other', command: 'node', args: ['/opt/x.js'] });
    assert.deepEqual(config.stdio_servers[1].args, ['auxilo-mcp@9.0.1']);
  });

  it('toml-codex: appends a pinned section when absent', () => {
    const home = tmpHome('mcp-pin-codex-');
    const client = fixtureClient(home, { format: 'toml-codex', configPath: path.join(home, 'config.toml') });
    installer.registerMcp(client, '10.0.0');
    const raw = fs.readFileSync(client.configPath, 'utf-8');
    assert.match(raw, /\[mcp_servers\.auxilo\]/);
    assert.match(raw, /args = \["auxilo-mcp@10\.0\.0"\]/);
  });

  it('toml-codex: rewrites ONLY the args line of an existing owned section, everything else byte-identical', () => {
    const home = tmpHome('mcp-pin-codex-rewrite-');
    const client = fixtureClient(home, { format: 'toml-codex', configPath: path.join(home, 'config.toml') });
    const raw =
      '# user preamble comment\n' +
      '[some_other_table]\n' +
      'key = "value"\n' +
      '\n' +
      '[mcp_servers.auxilo]\n' +
      'command = "npx"\n' +
      'args = ["auxilo-mcp"]\n' +
      '\n' +
      '[mcp_servers.other]\n' +
      'command = "node"\n' +
      'args = ["/opt/other.js"]\n';
    fs.writeFileSync(client.configPath, raw);
    installer.registerMcp(client, '11.0.0');
    const after = fs.readFileSync(client.configPath, 'utf-8');
    assert.match(after, /args = \["auxilo-mcp@11\.0\.0"\]/);
    // Everything outside the rewritten line is untouched.
    assert.match(after, /# user preamble comment/);
    assert.match(after, /\[some_other_table\]\nkey = "value"/);
    assert.match(after, /\[mcp_servers\.other\]\ncommand = "node"\nargs = \["\/opt\/other\.js"\]/);
    // The sibling table's args line must NOT have been touched by the
    // section-scoped regex (proves section-bounding, not a blind global replace).
    assert.doesNotMatch(after, /\/opt\/other\.js@/);
  });

  it('toml-codex: idempotent no-op (byte-identical) when already pinned to target', () => {
    const home = tmpHome('mcp-pin-codex-idem-');
    const client = fixtureClient(home, { format: 'toml-codex', configPath: path.join(home, 'config.toml') });
    installer.registerMcp(client, '12.0.0');
    const before = fs.readFileSync(client.configPath, 'utf-8');
    const result = installer.registerMcp(client, '12.0.0');
    assert.equal(result.changed, false);
    assert.equal(fs.readFileSync(client.configPath, 'utf-8'), before);
  });

  it('toml-codex: never touches a hand-edited/foreign section', () => {
    const home = tmpHome('mcp-pin-codex-foreign-');
    const client = fixtureClient(home, { format: 'toml-codex', configPath: path.join(home, 'config.toml') });
    const raw = '[mcp_servers.auxilo]\ncommand = "node"\nargs = ["/Users/me/fork/mcp-server.js"]\n';
    fs.writeFileSync(client.configPath, raw);
    installer.registerMcp(client, '13.0.0');
    assert.equal(fs.readFileSync(client.configPath, 'utf-8'), raw);
  });
});

// ─── 1b. 0.9.17 fix pass: F1 (in-place patch preserves user keys/order),
//         F2 (writers preserve file mode), F3 (unique tmp names + sweep) ────

describe('0.9.17 fix pass F1: re-pin patches command/args in place, other keys survive', () => {
  it('json-mcpServers: env + disabled survive a registerMcp re-pin, key order preserved', () => {
    const home = tmpHome('f1-json-');
    const client = fixtureClient(home);
    writeJson(client.configPath, {
      mcpServers: {
        auxilo: { command: 'npx', args: ['auxilo-mcp@0.9.16'], env: { FOO: 'bar' }, disabled: false },
      },
    });
    const result = installer.registerMcp(client, '0.9.17');
    assert.equal(result.changed, true);
    const config = readJson(client.configPath);
    assert.deepEqual(config.mcpServers.auxilo, {
      command: 'npx', args: ['auxilo-mcp@0.9.17'], env: { FOO: 'bar' }, disabled: false,
    });
    assert.deepEqual(Object.keys(config.mcpServers.auxilo), ['command', 'args', 'env', 'disabled'],
      'key order must be preserved — command/args updated in place, not re-inserted');
  });

  it('json-mcpServers: same survives via rewriteMcpPins (the self-update path)', () => {
    const home = tmpHome('f1-json-rewrite-');
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    const settingsPath = path.join(home, '.claude', 'settings.json');
    writeJson(settingsPath, {
      mcpServers: {
        auxilo: { command: 'npx', args: ['auxilo-mcp@0.9.16'], env: { FOO: 'bar' }, timeout: 30, alwaysAllow: ['search'] },
      },
    });
    const results = installer.rewriteMcpPins(home, '0.9.17');
    assert.equal(results.find((r) => r.id === 'claude-code').changed, true);
    const config = readJson(settingsPath);
    assert.deepEqual(config.mcpServers.auxilo, {
      command: 'npx', args: ['auxilo-mcp@0.9.17'], env: { FOO: 'bar' }, timeout: 30, alwaysAllow: ['search'],
    });
  });

  it('opencode: env key on the entry survives a re-pin', () => {
    const home = tmpHome('f1-opencode-');
    const client = fixtureClient(home, { format: 'opencode' });
    writeJson(client.configPath, {
      mcp: { auxilo: { type: 'local', command: ['npx', 'auxilo-mcp@0.9.16'], env: { FOO: 'bar' } } },
    });
    installer.registerMcp(client, '0.9.17');
    const config = readJson(client.configPath);
    assert.deepEqual(config.mcp.auxilo, { type: 'local', command: ['npx', 'auxilo-mcp@0.9.17'], env: { FOO: 'bar' } });
  });

  it('amp: env + disabled on the entry survive a re-pin', () => {
    const home = tmpHome('f1-amp-');
    const client = fixtureClient(home, { format: 'amp' });
    writeJson(client.configPath, {
      'amp.mcpServers': { auxilo: { command: 'npx', args: ['auxilo-mcp@0.9.16'], env: { FOO: 'bar' }, disabled: true } },
    });
    installer.registerMcp(client, '0.9.17');
    const config = readJson(client.configPath);
    assert.deepEqual(config['amp.mcpServers'].auxilo, {
      command: 'npx', args: ['auxilo-mcp@0.9.17'], env: { FOO: 'bar' }, disabled: true,
    });
  });

  it('openhands-stdio: cwd key + array position survive a re-pin', () => {
    const home = tmpHome('f1-openhands-');
    const client = fixtureClient(home, { format: 'openhands-stdio' });
    writeJson(client.configPath, {
      stdio_servers: [
        { name: 'other', command: 'node', args: ['/opt/x.js'] },
        { name: 'auxilo', command: 'npx', args: ['auxilo-mcp@0.9.16'], cwd: '/home/user' },
      ],
    });
    installer.registerMcp(client, '0.9.17');
    const config = readJson(client.configPath);
    assert.equal(config.stdio_servers.length, 2);
    assert.deepEqual(config.stdio_servers[0], { name: 'other', command: 'node', args: ['/opt/x.js'] });
    assert.deepEqual(config.stdio_servers[1], { name: 'auxilo', command: 'npx', args: ['auxilo-mcp@0.9.17'], cwd: '/home/user' });
  });
});

describe('0.9.17 fix pass F2: config writers preserve the existing file mode', () => {
  it('json-mcpServers: a 0600 config file stays 0600 after registerMcp re-pin', () => {
    const home = tmpHome('f2-json-');
    const client = fixtureClient(home);
    writeJson(client.configPath, { mcpServers: { auxilo: { command: 'npx', args: ['auxilo-mcp@0.9.16'] } } });
    fs.chmodSync(client.configPath, 0o600);
    installer.registerMcp(client, '0.9.17');
    assert.equal(fs.statSync(client.configPath).mode & 0o777, 0o600);
  });

  it('writeJsonAtomic: preserves an arbitrary existing mode (0640) across rewrite', () => {
    const home = tmpHome('f2-writejsonatomic-');
    const filePath = path.join(home, 'config.json');
    writeJson(filePath, { a: 1 });
    fs.chmodSync(filePath, 0o640);
    installer.writeJsonAtomic(filePath, { a: 2 });
    assert.equal(fs.statSync(filePath).mode & 0o777, 0o640);
    assert.deepEqual(readJson(filePath), { a: 2 });
  });

  it('toml-codex: a 0600 config.toml stays 0600 after rewriting the args line of an owned section', () => {
    const home = tmpHome('f2-codex-rewrite-');
    const client = fixtureClient(home, { format: 'toml-codex', configPath: path.join(home, 'config.toml') });
    fs.writeFileSync(client.configPath, '[mcp_servers.auxilo]\ncommand = "npx"\nargs = ["auxilo-mcp@0.9.16"]\n');
    fs.chmodSync(client.configPath, 0o600);
    installer.registerMcp(client, '0.9.17');
    assert.equal(fs.statSync(client.configPath).mode & 0o777, 0o600);
  });

  it('toml-codex: a 0600 config.toml stays 0600 after appending a fresh section', () => {
    const home = tmpHome('f2-codex-append-');
    const client = fixtureClient(home, { format: 'toml-codex', configPath: path.join(home, 'config.toml') });
    fs.writeFileSync(client.configPath, '# preamble\n');
    fs.chmodSync(client.configPath, 0o600);
    installer.registerMcp(client, '0.9.17');
    assert.equal(fs.statSync(client.configPath).mode & 0o777, 0o600);
  });
});

describe('0.9.17 fix pass F3: config writers use unique tmp names and sweep stale ones', () => {
  it('writeJsonAtomic: two consecutive writes to the same file use distinct tmp names', () => {
    const home = tmpHome('f3-unique-');
    const filePath = path.join(home, 'config.json');
    const seen = [];
    const origWriteFileSync = fs.writeFileSync;
    fs.writeFileSync = function patched(dest, ...rest) {
      if (typeof dest === 'string' && dest.startsWith(filePath + '.tmp-')) seen.push(dest);
      return origWriteFileSync.call(fs, dest, ...rest);
    };
    try {
      installer.writeJsonAtomic(filePath, { n: 1 });
      installer.writeJsonAtomic(filePath, { n: 2 });
    } finally {
      fs.writeFileSync = origWriteFileSync;
    }
    assert.equal(seen.length, 2, 'both writes must go through the tmp-name pattern');
    assert.notEqual(seen[0], seen[1], 'each write must pick a distinct tmp name');
    for (const tmp of seen) assert.match(path.basename(tmp), /^config\.json\.tmp-\d+-[0-9a-f]{12}$/);
  });

  it('writeJsonAtomic: sweeps a stale (>1h old) leftover tmp file matching our pattern, in this file\'s own dir only', () => {
    const home = tmpHome('f3-sweep-');
    const filePath = path.join(home, 'config.json');
    writeJson(filePath, { a: 1 });
    const staleTmp = `${filePath}.tmp-99999-deadbeef0000`;
    fs.writeFileSync(staleTmp, 'leftover from a crashed writer');
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    fs.utimesSync(staleTmp, twoHoursAgo, twoHoursAgo);

    const freshTmp = `${filePath}.tmp-88888-cafebabe0000`;
    fs.writeFileSync(freshTmp, 'a concurrent writer that started moments ago');

    const unrelated = path.join(home, 'other-file.tmp-1-abc');
    fs.writeFileSync(unrelated, 'not ours');

    installer.writeJsonAtomic(filePath, { a: 2 });

    assert.equal(fs.existsSync(staleTmp), false, 'stale (>1h) tmp matching our pattern must be swept');
    assert.equal(fs.existsSync(freshTmp), true, 'a fresh (<1h) tmp must be left alone — could be a concurrent writer');
    assert.equal(fs.existsSync(unrelated), true, 'a non-matching filename must never be touched');
    assert.deepEqual(readJson(filePath), { a: 2 });
  });
});

// ─── 2. mcpPinnedVersion probe ───────────────────────────────────────────────

describe('MCP-SERVER-STALENESS: mcpPinnedVersion', () => {
  it('returns null when not registered', () => {
    const home = tmpHome('mcp-probe-none-');
    const client = fixtureClient(home);
    writeJson(client.configPath, {});
    assert.equal(installer.mcpPinnedVersion(client), null);
  });

  it('returns the exact pin for a pinned entry', () => {
    const home = tmpHome('mcp-probe-pinned-');
    const client = fixtureClient(home);
    installer.registerMcp(client, '1.2.3');
    assert.equal(installer.mcpPinnedVersion(client), '1.2.3');
  });

  it("returns 'unpinned' for a legacy bare entry", () => {
    const home = tmpHome('mcp-probe-legacy-');
    const client = fixtureClient(home);
    writeJson(client.configPath, { mcpServers: { auxilo: { command: 'npx', args: ['auxilo-mcp'] } } });
    assert.equal(installer.mcpPinnedVersion(client), 'unpinned');
  });

  it('returns null for a foreign entry (not owned)', () => {
    const home = tmpHome('mcp-probe-foreign-');
    const client = fixtureClient(home);
    writeJson(client.configPath, { mcpServers: { auxilo: { command: 'node', args: ['/x.js'] } } });
    assert.equal(installer.mcpPinnedVersion(client), null);
  });

  it('works for toml-codex', () => {
    const home = tmpHome('mcp-probe-codex-');
    const client = fixtureClient(home, { format: 'toml-codex', configPath: path.join(home, 'config.toml') });
    installer.registerMcp(client, '2.0.0');
    assert.equal(installer.mcpPinnedVersion(client), '2.0.0');
  });
});

// ─── 3. rewriteMcpPins (the self-update path) ────────────────────────────────

describe('MCP-SERVER-STALENESS: rewriteMcpPins', () => {
  function setupHome() {
    return tmpHome('mcp-rewrite-');
  }

  it('re-pins an already-registered Claude Code (json-mcpServers) client, other servers untouched', () => {
    const home = setupHome();
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    const settingsPath = path.join(home, '.claude', 'settings.json');
    writeJson(settingsPath, {
      mcpServers: {
        auxilo: { command: 'npx', args: ['auxilo-mcp@0.9.16'] },
        unrelated: { command: 'node', args: ['/opt/unrelated.js'], env: { X: '1' } },
      },
    });

    const results = installer.rewriteMcpPins(home, '0.9.17');
    const cc = results.find((r) => r.id === 'claude-code');
    assert.ok(cc, 'claude-code result present');
    assert.equal(cc.changed, true);

    const config = readJson(settingsPath);
    assert.deepEqual(config.mcpServers.auxilo, { command: 'npx', args: ['auxilo-mcp@0.9.17'] });
    assert.deepEqual(config.mcpServers.unrelated, { command: 'node', args: ['/opt/unrelated.js'], env: { X: '1' } });
  });

  it('re-pins a LEGACY unpinned entry (JSON with other servers present) to the target version', () => {
    const home = setupHome();
    fs.mkdirSync(path.join(home, '.cursor'), { recursive: true });
    const configPath = path.join(home, '.cursor', 'mcp.json');
    writeJson(configPath, {
      mcpServers: {
        auxilo: { command: 'npx', args: ['auxilo-mcp'] }, // legacy string entry, pre-0.9.17
        github: { command: 'npx', args: ['@github/mcp-server'] },
      },
    });

    const results = installer.rewriteMcpPins(home, '0.9.17');
    const cursor = results.find((r) => r.id === 'cursor');
    assert.ok(cursor);
    assert.equal(cursor.changed, true);

    const config = readJson(configPath);
    assert.deepEqual(config.mcpServers.auxilo, { command: 'npx', args: ['auxilo-mcp@0.9.17'] });
    assert.deepEqual(config.mcpServers.github, { command: 'npx', args: ['@github/mcp-server'] });
  });

  it('never first-registers a detected client that has no existing Auxilo entry', () => {
    const home = setupHome();
    // Cursor is DETECTED (dir exists) but never configured with an Auxilo entry.
    fs.mkdirSync(path.join(home, '.cursor'), { recursive: true });
    assert.equal(fs.existsSync(path.join(home, '.cursor', 'mcp.json')), false);

    const results = installer.rewriteMcpPins(home, '0.9.17');
    const cursor = results.find((r) => r.id === 'cursor');
    assert.equal(cursor, undefined, 'an unregistered detected client must be skipped entirely, not appear in results');
    assert.equal(fs.existsSync(path.join(home, '.cursor', 'mcp.json')), false, 'must never create the config file');
  });

  it('is idempotent: a second rewrite to the same version changes nothing (byte-identical)', () => {
    const home = setupHome();
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    const settingsPath = path.join(home, '.claude', 'settings.json');
    writeJson(settingsPath, { mcpServers: { auxilo: { command: 'npx', args: ['auxilo-mcp@0.9.16'] } } });

    installer.rewriteMcpPins(home, '0.9.17');
    const after1 = fs.readFileSync(settingsPath, 'utf-8');
    const results2 = installer.rewriteMcpPins(home, '0.9.17');
    const after2 = fs.readFileSync(settingsPath, 'utf-8');
    assert.equal(after2, after1);
    assert.equal(results2.find((r) => r.id === 'claude-code').changed, false);
  });

  it('leaves a foreign/hand-edited entry completely untouched, byte-for-byte', () => {
    const home = setupHome();
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    const settingsPath = path.join(home, '.claude', 'settings.json');
    const raw = JSON.stringify({
      mcpServers: { auxilo: { command: 'node', args: ['/Users/me/dev/fork/mcp-server.js'] } },
    }, null, 2) + '\n';
    fs.writeFileSync(settingsPath, raw);

    installer.rewriteMcpPins(home, '0.9.17');
    assert.equal(fs.readFileSync(settingsPath, 'utf-8'), raw);
  });

  it('re-pins Codex CLI (toml-codex) leaving the rest of config.toml byte-identical', () => {
    const home = setupHome();
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    const configPath = path.join(home, '.codex', 'config.toml');
    const raw =
      '[some_setting]\n' +
      'value = 1\n' +
      '\n' +
      '[mcp_servers.auxilo]\n' +
      'command = "npx"\n' +
      'args = ["auxilo-mcp@0.9.16"]\n';
    fs.writeFileSync(configPath, raw);

    const results = installer.rewriteMcpPins(home, '0.9.17');
    assert.equal(results.find((r) => r.id === 'codex').changed, true);
    const after = fs.readFileSync(configPath, 'utf-8');
    assert.match(after, /args = \["auxilo-mcp@0\.9\.17"\]/);
    assert.match(after, /\[some_setting\]\nvalue = 1/);
  });

  it('skips a malformed client config without touching it or aborting the rest of the rewrite', () => {
    const home = setupHome();
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    const malformed = '{ not valid json';
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), malformed);
    fs.mkdirSync(path.join(home, '.cursor'), { recursive: true });
    writeJson(path.join(home, '.cursor', 'mcp.json'), { mcpServers: { auxilo: { command: 'npx', args: ['auxilo-mcp@0.9.16'] } } });

    const results = installer.rewriteMcpPins(home, '0.9.17');
    // mcpRegistrationPresent treats malformed JSON as "not registered" (same
    // read-only-probe tolerance `auxilo status` relies on) — so the gate
    // skips it before ever attempting a write; the file is never touched.
    const cc = results.find((r) => r.id === 'claude-code');
    assert.equal(cc, undefined);
    assert.equal(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf-8'), malformed);

    const cursor = results.find((r) => r.id === 'cursor');
    assert.equal(cursor.changed, true);
    const cursorConfig = readJson(path.join(home, '.cursor', 'mcp.json'));
    assert.deepEqual(cursorConfig.mcpServers.auxilo.args, ['auxilo-mcp@0.9.17']);
  });
});

// ─── 4. runner-autoupdate.js stageAndSwap calls rewriteMcpPins ──────────────

describe('MCP-SERVER-STALENESS: stageAndSwap invokes the extracted tree\'s rewriteMcpPins', () => {
  it('calls rewriteMcpPins(homeDir, result.version) when the extracted installer provides it', () => {
    const autoupdate = require('../lib/runner-autoupdate.js');
    const home = tmpHome('mcp-stage-');
    const extractedDir = tmpHome('mcp-stage-extracted-');
    fs.mkdirSync(path.join(extractedDir, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(extractedDir, 'package.json'), JSON.stringify({ name: 'auxilo-mcp', version: '9.9.9' }));
    fs.writeFileSync(path.join(extractedDir, 'scripts', 'runner.js'), '// fixture\nmodule.exports = {};\n');

    let rewriteCalledWith = null;
    const binRoot = path.join(home, '.auxilo', 'bin');
    fs.mkdirSync(binRoot, { recursive: true });
    const fakeExtractedInstaller = {
      RUNNER_STACK: [['scripts/runner.js', 'scripts/runner.js', 0o755]],
      binRootFor: () => binRoot,
      installRunnerAtomic(homeDir, opts) {
        const destPath = path.join(binRoot, 'scripts', 'runner.js');
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        fs.copyFileSync(path.join(opts.packageRoot, 'scripts', 'runner.js'), destPath);
        const versionPath = path.join(binRoot, 'VERSION');
        fs.writeFileSync(versionPath, '9.9.9\n');
        return { binRoot, hookPath: destPath, versionPath, version: '9.9.9', installed: [destPath, versionPath] };
      },
      rewriteMcpPins(homeDir, version) {
        rewriteCalledWith = { homeDir, version };
      },
    };

    // Requiring the extracted tree's own lib/installer.js is how stageAndSwap
    // normally gets `extractedInstaller` — fixture it via Module._cache so
    // require(extractedInstallerPath) returns our fake without touching disk.
    const extractedInstallerPath = path.join(extractedDir, 'lib', 'installer.js');
    fs.mkdirSync(path.dirname(extractedInstallerPath), { recursive: true });
    fs.writeFileSync(extractedInstallerPath, 'module.exports = {};\n'); // placeholder, cache override below wins
    require.cache[require.resolve(extractedInstallerPath)] = {
      id: extractedInstallerPath,
      filename: extractedInstallerPath,
      loaded: true,
      exports: fakeExtractedInstaller,
    };

    try {
      autoupdate.stageAndSwap(home, extractedDir, installer);
    } finally {
      delete require.cache[require.resolve(extractedInstallerPath)];
    }

    assert.deepEqual(rewriteCalledWith, { homeDir: home, version: '9.9.9' });
  });

  it('never throws when the extracted installer has no rewriteMcpPins (older/fixture tree)', () => {
    const autoupdate = require('../lib/runner-autoupdate.js');
    const home = tmpHome('mcp-stage-nolegacy-');
    const extractedDir = tmpHome('mcp-stage-nolegacy-extracted-');
    fs.mkdirSync(path.join(extractedDir, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(extractedDir, 'package.json'), JSON.stringify({ name: 'auxilo-mcp', version: '9.9.8' }));
    fs.writeFileSync(path.join(extractedDir, 'scripts', 'runner.js'), '// fixture\nmodule.exports = {};\n');
    const binRoot = path.join(home, '.auxilo', 'bin');
    fs.mkdirSync(binRoot, { recursive: true });
    const fakeExtractedInstaller = {
      binRootFor: () => binRoot,
      installRunnerAtomic(homeDir, opts) {
        const destPath = path.join(binRoot, 'scripts', 'runner.js');
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        fs.copyFileSync(path.join(opts.packageRoot, 'scripts', 'runner.js'), destPath);
        const versionPath = path.join(binRoot, 'VERSION');
        fs.writeFileSync(versionPath, '9.9.8\n');
        return { binRoot, hookPath: destPath, versionPath, version: '9.9.8', installed: [destPath, versionPath] };
      },
      // no rewriteMcpPins — mirrors a pre-0.9.17 extracted tree
    };
    const extractedInstallerPath = path.join(extractedDir, 'lib', 'installer.js');
    fs.mkdirSync(path.dirname(extractedInstallerPath), { recursive: true });
    fs.writeFileSync(extractedInstallerPath, 'module.exports = {};\n');
    require.cache[require.resolve(extractedInstallerPath)] = {
      id: extractedInstallerPath,
      filename: extractedInstallerPath,
      loaded: true,
      exports: fakeExtractedInstaller,
    };

    let result;
    try {
      assert.doesNotThrow(() => { result = autoupdate.stageAndSwap(home, extractedDir, installer); });
    } finally {
      delete require.cache[require.resolve(extractedInstallerPath)];
    }
    assert.equal(result, binRoot);
  });
});

// ─── 5. getStatus surfaces the pin + staleness ───────────────────────────────

describe('MCP-SERVER-STALENESS: getStatus pin/staleness fields', () => {
  it('reports mcpPin and mcpPinStale=false when the pin matches the installed runner', async () => {
    const home = tmpHome('mcp-status-match-');
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    writeJson(path.join(home, '.claude', 'settings.json'), {
      mcpServers: { auxilo: { command: 'npx', args: ['auxilo-mcp@0.9.17'] } },
    });
    const binRoot = path.join(home, '.auxilo', 'bin', 'scripts');
    fs.mkdirSync(binRoot, { recursive: true });
    fs.writeFileSync(path.join(binRoot, 'runner.js'), '// fixture\n');
    fs.writeFileSync(path.join(home, '.auxilo', 'bin', 'VERSION'), '0.9.17\n');

    const status = await installer.getStatus(home);
    const cc = status.clients.find((c) => c.id === 'claude-code');
    assert.equal(cc.mcpPin, '0.9.17');
    assert.equal(cc.mcpPinStale, false);
    assert.equal(status.runnerVersion, '0.9.17');
  });

  it('reports mcpPinStale=true when the pin is behind the installed runner', async () => {
    const home = tmpHome('mcp-status-stale-');
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    writeJson(path.join(home, '.claude', 'settings.json'), {
      mcpServers: { auxilo: { command: 'npx', args: ['auxilo-mcp@0.9.16'] } },
    });
    const binRoot = path.join(home, '.auxilo', 'bin', 'scripts');
    fs.mkdirSync(binRoot, { recursive: true });
    fs.writeFileSync(path.join(binRoot, 'runner.js'), '// fixture\n');
    fs.writeFileSync(path.join(home, '.auxilo', 'bin', 'VERSION'), '0.9.17\n');

    const status = await installer.getStatus(home);
    const cc = status.clients.find((c) => c.id === 'claude-code');
    assert.equal(cc.mcpPin, '0.9.16');
    assert.equal(cc.mcpPinStale, true);
  });

  it("reports mcpPin='unpinned' for a legacy entry and never marks it stale", async () => {
    const home = tmpHome('mcp-status-unpinned-');
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    writeJson(path.join(home, '.claude', 'settings.json'), {
      mcpServers: { auxilo: { command: 'npx', args: ['auxilo-mcp'] } },
    });
    const binRoot = path.join(home, '.auxilo', 'bin', 'scripts');
    fs.mkdirSync(binRoot, { recursive: true });
    fs.writeFileSync(path.join(binRoot, 'runner.js'), '// fixture\n');
    fs.writeFileSync(path.join(home, '.auxilo', 'bin', 'VERSION'), '0.9.17\n');

    const status = await installer.getStatus(home);
    const cc = status.clients.find((c) => c.id === 'claude-code');
    assert.equal(cc.mcpPin, 'unpinned');
    assert.equal(cc.mcpPinStale, false);
  });
});

// ─── 6. `auxilo status` CLI renders the pin line ─────────────────────────────

describe('MCP-SERVER-STALENESS: auxilo status CLI output', () => {
  const CLI_PATH = path.join(REPO, 'bin', 'auxilo-cli.js');

  function runStatus(home) {
    return new Promise((resolve, reject) => {
      const env = { ...process.env, HOME: home, AUXILO_NO_NOTIFY: '1' };
      delete env.AUXILO_BASE_URL;
      const child = spawn(process.execPath, [CLI_PATH, 'status'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (c) => { stdout += c; });
      child.stderr.on('data', (c) => { stderr += c; });
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('status timed out')); }, 15000);
      child.on('error', (err) => { clearTimeout(timer); reject(err); });
      child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    });
  }

  it('shows the STALE pin note when the client pin trails the installed runner', async () => {
    const home = tmpHome('mcp-cli-status-stale-');
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    writeJson(path.join(home, '.claude', 'settings.json'), {
      mcpServers: { auxilo: { command: 'npx', args: ['auxilo-mcp@0.9.16'] } },
    });
    const binRoot = path.join(home, '.auxilo', 'bin', 'scripts');
    fs.mkdirSync(binRoot, { recursive: true });
    fs.writeFileSync(path.join(binRoot, 'runner.js'), '// fixture\n');
    fs.writeFileSync(path.join(home, '.auxilo', 'bin', 'VERSION'), '0.9.17\n');

    const { stdout } = await runStatus(home);
    assert.match(stdout, /Claude Code: MCP registered \(pin: v0\.9\.16, runner: v0\.9\.17 — STALE, run `npx auxilo setup`\)/);
  });

  it('shows a plain pin note (no STALE) when the pin matches', async () => {
    const home = tmpHome('mcp-cli-status-match-');
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    writeJson(path.join(home, '.claude', 'settings.json'), {
      mcpServers: { auxilo: { command: 'npx', args: ['auxilo-mcp@0.9.17'] } },
    });
    const binRoot = path.join(home, '.auxilo', 'bin', 'scripts');
    fs.mkdirSync(binRoot, { recursive: true });
    fs.writeFileSync(path.join(binRoot, 'runner.js'), '// fixture\n');
    fs.writeFileSync(path.join(home, '.auxilo', 'bin', 'VERSION'), '0.9.17\n');

    const { stdout } = await runStatus(home);
    assert.match(stdout, /Claude Code: MCP registered \(pin: v0\.9\.17\)/);
    assert.doesNotMatch(stdout, /STALE/);
  });
});

// ─── 7. mcp-server.js startup version-skew notice ────────────────────────────

describe('MCP-SERVER-STALENESS: mcp-server.js startup notice', () => {
  const SERVER_PATH = path.join(REPO, 'mcp-server.js');

  /** Spawn mcp-server.js directly (not via require) against a fixture HOME,
   *  collect stderr briefly, then kill it — it otherwise blocks forever on
   *  stdio waiting for MCP protocol frames this test never sends. */
  function spawnServer(home) {
    return new Promise((resolve, reject) => {
      const env = { ...process.env, HOME: home };
      const child = spawn(process.execPath, [SERVER_PATH], { env, stdio: ['pipe', 'pipe', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (c) => { stderr += c; });
      child.on('error', reject);
      // 'Auxilo MCP server running' is the last thing main() logs on a
      // successful connect — its appearance proves the startup path (and
      // therefore the notice check just before it) has fully executed.
      const started = setTimeout(() => {
        child.kill('SIGKILL');
        resolve({ stderr });
      }, 1500);
      child.stderr.on('data', () => {
        if (stderr.includes('Auxilo MCP server running')) {
          clearTimeout(started);
          child.kill('SIGKILL');
          resolve({ stderr });
        }
      });
    });
  }

  it('prints ONE notice naming both versions when the runner VERSION stamp differs', async () => {
    const home = tmpHome('mcp-notice-mismatch-');
    fs.mkdirSync(path.join(home, '.auxilo', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(home, '.auxilo', 'bin', 'VERSION'), '0.0.1\n');

    const { stderr } = await spawnServer(home);
    const ownVersion = REPO_PKG_VERSION;
    const expected = `[auxilo-mcp] Note: this MCP server is running v${ownVersion}, but the installed runner is v0.0.1. Run \`npx auxilo setup\` to re-pin.`;
    const occurrences = stderr.split(expected).length - 1;
    assert.equal(occurrences, 1, `expected exactly one notice line in stderr, got ${occurrences}\nstderr:\n${stderr}`);
  });

  it('stays silent when the runner VERSION stamp matches the package version', async () => {
    const home = tmpHome('mcp-notice-match-');
    fs.mkdirSync(path.join(home, '.auxilo', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(home, '.auxilo', 'bin', 'VERSION'), `${REPO_PKG_VERSION}\n`);

    const { stderr } = await spawnServer(home);
    assert.doesNotMatch(stderr, /\[auxilo-mcp\] Note:/);
  });

  it('stays silent when there is no VERSION stamp at all (runner never installed)', async () => {
    const home = tmpHome('mcp-notice-absent-');
    // No ~/.auxilo/bin/VERSION written at all.
    const { stderr } = await spawnServer(home);
    assert.doesNotMatch(stderr, /\[auxilo-mcp\] Note:/);
  });
});
