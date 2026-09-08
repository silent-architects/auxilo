'use strict';

/**
 * test/mcp-pin-legacy-owned.test.js — MCP-PIN-LEGACY-OWNED (0.9.18) coverage.
 *
 * Gap observed live: after the organic 0.9.16→0.9.17 self-update on the
 * operator's machine, `auxilo status` showed all five registered clients as
 * `(pin: unpinned — run npx auxilo setup to pin)`. The concern was that the
 * legacy BARE MCP entry our own `auxilo setup` wrote for every pre-0.9.17
 * install — `command: 'npx'`, `args: ['auxilo-mcp']` (and the per-format
 * equivalents: opencode's array `command`, amp's `amp.mcpServers`,
 * openhands' `stdio_servers` array entry, and Codex's TOML `args = [...]`
 * line) — might be getting treated as a foreign/hand-edited entry and so
 * skipped forever by `rewriteMcpPins`.
 *
 * `git log -p -S'auxilo-mcp' -- lib/installer.js` shows MCP_ENTRY has only
 * ever had ONE shape across this repo's full history (back to the 0ca1e66
 * reconciliation squash): `{ command: 'npx', args: ['auxilo-mcp'] }`. There
 * is no '-y'-flag variant or other historical shape to account for.
 * lib/installer.js's `isOwnedMcpArgs` already recognizes that exact bare
 * shape (`args[0] === MCP_PACKAGE_NAME`) as owned, alongside the pinned
 * `auxilo-mcp@X.Y.Z` shape — this file is the regression suite that locks
 * that down PER CONFIG FORMAT, closing the gap between what
 * test/mcp-server-staleness.test.js already covered (json-mcpServers +
 * toml-codex legacy re-pin) and the full six-format matrix, plus the
 * negative case (a legacy entry with an EXTRA arg is NOT ours — extra args
 * make it foreign, must survive byte-for-byte) and a true multi-client,
 * multi-format rewriteMcpPins() end-to-end run.
 *
 * All homes are fresh mkdtemp'd fixture directories — NEVER the real
 * ~/.claude or ~/.auxilo. No network: every function under test here is
 * pure fs.
 *
 * Runner: node --test test/mcp-pin-legacy-owned.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const installer = require('../lib/installer.js');

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

const TARGET_VERSION = '0.9.18';

// ─── json-mcpServers (also covers json-dropin, an identical writer) ────────

describe('MCP-PIN-LEGACY-OWNED: json-mcpServers', () => {
  it('legacy bare entry → pinned in place, sibling server untouched', () => {
    const home = tmpHome('legacy-json-pin-');
    const client = fixtureClient(home);
    writeJson(client.configPath, {
      mcpServers: {
        auxilo: { command: 'npx', args: ['auxilo-mcp'] },
        other: { command: 'node', args: ['/opt/other.js'], env: { X: '1' } },
      },
    });
    const result = installer.registerMcp(client, TARGET_VERSION);
    assert.equal(result.changed, true);
    assert.equal(result.status, 'registered');
    const config = readJson(client.configPath);
    assert.deepEqual(config.mcpServers.auxilo, { command: 'npx', args: [`auxilo-mcp@${TARGET_VERSION}`] });
    assert.deepEqual(config.mcpServers.other, { command: 'node', args: ['/opt/other.js'], env: { X: '1' } });
  });

  it('legacy entry with an EXTRA arg is foreign — left byte-for-byte untouched', () => {
    const home = tmpHome('legacy-json-extra-arg-');
    const client = fixtureClient(home);
    const raw = JSON.stringify({
      mcpServers: { auxilo: { command: 'npx', args: ['auxilo-mcp', '--verbose'] } },
    }, null, 2) + '\n';
    fs.writeFileSync(client.configPath, raw);
    const result = installer.registerMcp(client, TARGET_VERSION);
    assert.equal(result.changed, false);
    assert.equal(result.status, 'already-registered');
    assert.equal(fs.readFileSync(client.configPath, 'utf-8'), raw);
  });

  it('already pinned to target → idempotent, byte-identical', () => {
    const home = tmpHome('legacy-json-idem-');
    const client = fixtureClient(home);
    installer.registerMcp(client, TARGET_VERSION);
    const before = fs.readFileSync(client.configPath, 'utf-8');
    const result = installer.registerMcp(client, TARGET_VERSION);
    assert.equal(result.changed, false);
    assert.equal(fs.readFileSync(client.configPath, 'utf-8'), before);
  });

  it('legacy bare entry with a user-added env key → pinned in place, env survives (extra ENV is fine, unlike extra ARGS)', () => {
    const home = tmpHome('legacy-json-env-');
    const client = fixtureClient(home);
    writeJson(client.configPath, {
      mcpServers: { auxilo: { command: 'npx', args: ['auxilo-mcp'], env: { FOO: 'bar' } } },
    });
    const result = installer.registerMcp(client, TARGET_VERSION);
    assert.equal(result.changed, true);
    const config = readJson(client.configPath);
    assert.deepEqual(config.mcpServers.auxilo, {
      command: 'npx', args: [`auxilo-mcp@${TARGET_VERSION}`], env: { FOO: 'bar' },
    });
  });
});

describe('MCP-PIN-LEGACY-OWNED: json-dropin (Continue.dev)', () => {
  it('legacy bare entry → pinned in place, sibling server untouched', () => {
    const home = tmpHome('legacy-dropin-pin-');
    const client = fixtureClient(home, { format: 'json-dropin' });
    writeJson(client.configPath, {
      mcpServers: {
        auxilo: { command: 'npx', args: ['auxilo-mcp'] },
        other: { command: 'node', args: ['/opt/other.js'] },
      },
    });
    const result = installer.registerMcp(client, TARGET_VERSION);
    assert.equal(result.changed, true);
    const config = readJson(client.configPath);
    assert.deepEqual(config.mcpServers.auxilo, { command: 'npx', args: [`auxilo-mcp@${TARGET_VERSION}`] });
    assert.deepEqual(config.mcpServers.other, { command: 'node', args: ['/opt/other.js'] });
  });

  it('legacy entry with an EXTRA arg is foreign — left byte-for-byte untouched', () => {
    const home = tmpHome('legacy-dropin-extra-arg-');
    const client = fixtureClient(home, { format: 'json-dropin' });
    const raw = JSON.stringify({
      mcpServers: { auxilo: { command: 'npx', args: ['auxilo-mcp', '--verbose'] } },
    }, null, 2) + '\n';
    fs.writeFileSync(client.configPath, raw);
    const result = installer.registerMcp(client, TARGET_VERSION);
    assert.equal(result.changed, false);
    assert.equal(fs.readFileSync(client.configPath, 'utf-8'), raw);
  });

  it('already pinned to target → idempotent, byte-identical', () => {
    const home = tmpHome('legacy-dropin-idem-');
    const client = fixtureClient(home, { format: 'json-dropin' });
    installer.registerMcp(client, TARGET_VERSION);
    const before = fs.readFileSync(client.configPath, 'utf-8');
    const result = installer.registerMcp(client, TARGET_VERSION);
    assert.equal(result.changed, false);
    assert.equal(fs.readFileSync(client.configPath, 'utf-8'), before);
  });
});

// ─── opencode ────────────────────────────────────────────────────────────

describe('MCP-PIN-LEGACY-OWNED: opencode', () => {
  it('legacy bare command array → pinned in place, sibling entry untouched', () => {
    const home = tmpHome('legacy-opencode-pin-');
    const client = fixtureClient(home, { format: 'opencode' });
    writeJson(client.configPath, {
      mcp: {
        auxilo: { type: 'local', command: ['npx', 'auxilo-mcp'] },
        other: { type: 'remote', url: 'https://example.com/mcp' },
      },
    });
    const result = installer.registerMcp(client, TARGET_VERSION);
    assert.equal(result.changed, true);
    const config = readJson(client.configPath);
    assert.deepEqual(config.mcp.auxilo, { type: 'local', command: ['npx', `auxilo-mcp@${TARGET_VERSION}`] });
    assert.deepEqual(config.mcp.other, { type: 'remote', url: 'https://example.com/mcp' });
  });

  it('legacy command array with an EXTRA arg is foreign — left byte-for-byte untouched', () => {
    const home = tmpHome('legacy-opencode-extra-arg-');
    const client = fixtureClient(home, { format: 'opencode' });
    const raw = JSON.stringify({
      mcp: { auxilo: { type: 'local', command: ['npx', 'auxilo-mcp', '--verbose'] } },
    }, null, 2) + '\n';
    fs.writeFileSync(client.configPath, raw);
    const result = installer.registerMcp(client, TARGET_VERSION);
    assert.equal(result.changed, false);
    assert.equal(fs.readFileSync(client.configPath, 'utf-8'), raw);
  });

  it('already pinned to target → idempotent, byte-identical', () => {
    const home = tmpHome('legacy-opencode-idem-');
    const client = fixtureClient(home, { format: 'opencode' });
    installer.registerMcp(client, TARGET_VERSION);
    const before = fs.readFileSync(client.configPath, 'utf-8');
    const result = installer.registerMcp(client, TARGET_VERSION);
    assert.equal(result.changed, false);
    assert.equal(fs.readFileSync(client.configPath, 'utf-8'), before);
  });

  it('legacy bare command array with a user-added env key → pinned in place, env survives', () => {
    const home = tmpHome('legacy-opencode-env-');
    const client = fixtureClient(home, { format: 'opencode' });
    writeJson(client.configPath, {
      mcp: { auxilo: { type: 'local', command: ['npx', 'auxilo-mcp'], env: { FOO: 'bar' } } },
    });
    const result = installer.registerMcp(client, TARGET_VERSION);
    assert.equal(result.changed, true);
    const config = readJson(client.configPath);
    assert.deepEqual(config.mcp.auxilo, {
      type: 'local', command: ['npx', `auxilo-mcp@${TARGET_VERSION}`], env: { FOO: 'bar' },
    });
  });
});

// ─── amp ─────────────────────────────────────────────────────────────────

describe('MCP-PIN-LEGACY-OWNED: amp', () => {
  it('legacy bare entry → pinned in place, sibling server untouched', () => {
    const home = tmpHome('legacy-amp-pin-');
    const client = fixtureClient(home, { format: 'amp' });
    writeJson(client.configPath, {
      'amp.mcpServers': {
        auxilo: { command: 'npx', args: ['auxilo-mcp'] },
        other: { command: 'node', args: ['/opt/other.js'] },
      },
    });
    const result = installer.registerMcp(client, TARGET_VERSION);
    assert.equal(result.changed, true);
    const config = readJson(client.configPath);
    assert.deepEqual(config['amp.mcpServers'].auxilo, { command: 'npx', args: [`auxilo-mcp@${TARGET_VERSION}`] });
    assert.deepEqual(config['amp.mcpServers'].other, { command: 'node', args: ['/opt/other.js'] });
  });

  it('legacy entry with an EXTRA arg is foreign — left byte-for-byte untouched', () => {
    const home = tmpHome('legacy-amp-extra-arg-');
    const client = fixtureClient(home, { format: 'amp' });
    const raw = JSON.stringify({
      'amp.mcpServers': { auxilo: { command: 'npx', args: ['auxilo-mcp', '--verbose'] } },
    }, null, 2) + '\n';
    fs.writeFileSync(client.configPath, raw);
    const result = installer.registerMcp(client, TARGET_VERSION);
    assert.equal(result.changed, false);
    assert.equal(fs.readFileSync(client.configPath, 'utf-8'), raw);
  });

  it('already pinned to target → idempotent, byte-identical', () => {
    const home = tmpHome('legacy-amp-idem-');
    const client = fixtureClient(home, { format: 'amp' });
    installer.registerMcp(client, TARGET_VERSION);
    const before = fs.readFileSync(client.configPath, 'utf-8');
    const result = installer.registerMcp(client, TARGET_VERSION);
    assert.equal(result.changed, false);
    assert.equal(fs.readFileSync(client.configPath, 'utf-8'), before);
  });
});

// ─── openhands-stdio ───────────────────────────────────────────────────────

describe('MCP-PIN-LEGACY-OWNED: openhands-stdio', () => {
  it('legacy bare entry → pinned in place, sibling entry + array order untouched', () => {
    const home = tmpHome('legacy-openhands-pin-');
    const client = fixtureClient(home, { format: 'openhands-stdio' });
    writeJson(client.configPath, {
      stdio_servers: [
        { name: 'other', command: 'node', args: ['/opt/other.js'] },
        { name: 'auxilo', command: 'npx', args: ['auxilo-mcp'] },
      ],
    });
    const result = installer.registerMcp(client, TARGET_VERSION);
    assert.equal(result.changed, true);
    const config = readJson(client.configPath);
    assert.equal(config.stdio_servers.length, 2);
    assert.deepEqual(config.stdio_servers[0], { name: 'other', command: 'node', args: ['/opt/other.js'] });
    assert.deepEqual(config.stdio_servers[1], { name: 'auxilo', command: 'npx', args: [`auxilo-mcp@${TARGET_VERSION}`] });
  });

  it('legacy entry with an EXTRA arg is foreign — left byte-for-byte untouched', () => {
    const home = tmpHome('legacy-openhands-extra-arg-');
    const client = fixtureClient(home, { format: 'openhands-stdio' });
    const raw = JSON.stringify({
      stdio_servers: [{ name: 'auxilo', command: 'npx', args: ['auxilo-mcp', '--verbose'] }],
    }, null, 2) + '\n';
    fs.writeFileSync(client.configPath, raw);
    const result = installer.registerMcp(client, TARGET_VERSION);
    assert.equal(result.changed, false);
    assert.equal(fs.readFileSync(client.configPath, 'utf-8'), raw);
  });

  it('already pinned to target → idempotent, byte-identical', () => {
    const home = tmpHome('legacy-openhands-idem-');
    const client = fixtureClient(home, { format: 'openhands-stdio' });
    installer.registerMcp(client, TARGET_VERSION);
    const before = fs.readFileSync(client.configPath, 'utf-8');
    const result = installer.registerMcp(client, TARGET_VERSION);
    assert.equal(result.changed, false);
    assert.equal(fs.readFileSync(client.configPath, 'utf-8'), before);
  });
});

// ─── toml-codex ─────────────────────────────────────────────────────────────

describe('MCP-PIN-LEGACY-OWNED: toml-codex', () => {
  it('legacy bare args line → pinned in place, rest of file byte-identical', () => {
    const home = tmpHome('legacy-codex-pin-');
    const client = fixtureClient(home, { format: 'toml-codex', configPath: path.join(home, 'config.toml') });
    const raw =
      '# preamble\n' +
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
    const result = installer.registerMcp(client, TARGET_VERSION);
    assert.equal(result.changed, true);
    const after = fs.readFileSync(client.configPath, 'utf-8');
    assert.match(after, new RegExp(`args = \\["auxilo-mcp@${TARGET_VERSION.replace(/\./g, '\\.')}"\\]`));
    assert.match(after, /# preamble\n\[some_other_table\]\nkey = "value"/);
    assert.match(after, /\[mcp_servers\.other\]\ncommand = "node"\nargs = \["\/opt\/other\.js"\]/);
  });

  it('legacy args line with an EXTRA arg is foreign — file left byte-for-byte untouched', () => {
    const home = tmpHome('legacy-codex-extra-arg-');
    const client = fixtureClient(home, { format: 'toml-codex', configPath: path.join(home, 'config.toml') });
    const raw =
      '[mcp_servers.auxilo]\n' +
      'command = "npx"\n' +
      'args = ["auxilo-mcp", "--verbose"]\n';
    fs.writeFileSync(client.configPath, raw);
    const result = installer.registerMcp(client, TARGET_VERSION);
    assert.equal(result.changed, false);
    assert.equal(fs.readFileSync(client.configPath, 'utf-8'), raw);
  });

  it('already pinned to target → idempotent, byte-identical', () => {
    const home = tmpHome('legacy-codex-idem-');
    const client = fixtureClient(home, { format: 'toml-codex', configPath: path.join(home, 'config.toml') });
    installer.registerMcp(client, TARGET_VERSION);
    const before = fs.readFileSync(client.configPath, 'utf-8');
    const result = installer.registerMcp(client, TARGET_VERSION);
    assert.equal(result.changed, false);
    assert.equal(fs.readFileSync(client.configPath, 'utf-8'), before);
  });
});

// ─── rewriteMcpPins end-to-end: legacy fixtures across two DIFFERENT clients ─

describe('MCP-PIN-LEGACY-OWNED: rewriteMcpPins end-to-end (multi-client, multi-format)', () => {
  it('re-pins legacy bare entries on two differently-formatted clients in one call', () => {
    const home = tmpHome('legacy-e2e-');

    // Claude Code — json-mcpServers, legacy bare shape.
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    const claudeConfigPath = path.join(home, '.claude', 'settings.json');
    writeJson(claudeConfigPath, {
      mcpServers: { auxilo: { command: 'npx', args: ['auxilo-mcp'] } },
    });

    // Codex CLI — toml-codex, legacy bare shape, with unrelated content.
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    const codexConfigPath = path.join(home, '.codex', 'config.toml');
    fs.writeFileSync(codexConfigPath,
      '[some_setting]\nvalue = 1\n\n[mcp_servers.auxilo]\ncommand = "npx"\nargs = ["auxilo-mcp"]\n');

    const results = installer.rewriteMcpPins(home, TARGET_VERSION);

    const cc = results.find((r) => r.id === 'claude-code');
    const codex = results.find((r) => r.id === 'codex');
    assert.ok(cc, 'claude-code must appear in results');
    assert.ok(codex, 'codex must appear in results');
    assert.equal(cc.changed, true);
    assert.equal(codex.changed, true);

    const claudeConfig = readJson(claudeConfigPath);
    assert.deepEqual(claudeConfig.mcpServers.auxilo, { command: 'npx', args: [`auxilo-mcp@${TARGET_VERSION}`] });

    const codexRaw = fs.readFileSync(codexConfigPath, 'utf-8');
    assert.match(codexRaw, new RegExp(`args = \\["auxilo-mcp@${TARGET_VERSION.replace(/\./g, '\\.')}"\\]`));
    assert.match(codexRaw, /\[some_setting\]\nvalue = 1/);

    // Idempotent re-run: both stay byte-identical, both report unchanged.
    const claudeBefore = fs.readFileSync(claudeConfigPath, 'utf-8');
    const codexBefore = fs.readFileSync(codexConfigPath, 'utf-8');
    const results2 = installer.rewriteMcpPins(home, TARGET_VERSION);
    assert.equal(results2.find((r) => r.id === 'claude-code').changed, false);
    assert.equal(results2.find((r) => r.id === 'codex').changed, false);
    assert.equal(fs.readFileSync(claudeConfigPath, 'utf-8'), claudeBefore);
    assert.equal(fs.readFileSync(codexConfigPath, 'utf-8'), codexBefore);
  });
});
