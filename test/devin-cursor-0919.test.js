'use strict';

/**
 * BUILD-SPEC-0919 — Cursor stop-hook + Devin poll capture.
 *
 * Row 1: Cursor's captureEvent moves 'sessionEnd' -> 'stop' (sessionEnd fires
 * only on IDE quit, after shell-exec is already torn down, so the hook never
 * actually ran; 'stop' fires at agent-turn completion and was VERIFIED with a
 * real payload).
 *
 * Row 2: the `windsurf` registry entry (id kept for ledger continuity) is
 * renamed to "Devin Desktop", detects EITHER ~/.config/devin/ (primary) or
 * the legacy ~/.codeium/windsurf/, and DROPS its capture hook entirely (the
 * legacy post_cascade_response_with_transcript hook delivered tool_info:null
 * — verified useless).
 *
 * Row 3: scripts/sources/devin.js is a new poll TranscriptSource that reads
 * Devin's own SQLite acp-messages store directly, replacing the dropped
 * hook. Fixture .db files here are built via the system `sqlite3` CLI (never
 * node:sqlite) specifically so these tests do not themselves depend on
 * node:sqlite being present — CI runs Node 20 (.github/workflows/ci.yml),
 * where node:sqlite does not exist, so devin.js's own CLI fallback path is
 * exactly what gets exercised there; building fixtures the same way keeps
 * the tests honest about what actually runs in CI.
 *
 * No fixture ever touches the real HOME — every .db lives under a
 * fs.mkdtempSync(os.tmpdir()) directory, per the repo's test-isolation rule.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..');
const ADAPTER_REL = 'scripts/sources/devin.js';

const installer = require('../lib/installer.js');
const runner = require('../scripts/runner.js');
const { EXTRACTABLE_SOURCES } = require('../scripts/extract-local.js');
const { DevinSource } = require('../scripts/sources/devin.js');

function tmpdir(prefix = 'aux-0919-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

/**
 * Build a fixture Devin acp-messages .db at `dbPath` with the given
 * {kind, payload} rows, via the system sqlite3 CLI (see module header for
 * why: keeps these tests honest against the Node-20 CI matrix).
 */
function buildFixtureDb(dbPath, rows) {
  const statements = [
    'CREATE TABLE messages (position INTEGER PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL);',
    'CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);',
  ];
  rows.forEach((row, i) => {
    const kind = row.kind.replace(/'/g, "''");
    const payload = JSON.stringify(row.payload).replace(/'/g, "''");
    statements.push(`INSERT INTO messages (position, kind, payload) VALUES (${i}, '${kind}', '${payload}');`);
  });
  statements.push(`INSERT INTO meta (key, value) VALUES ('message_count', '${rows.length}');`);
  execFileSync('sqlite3', [dbPath], { input: statements.join('\n'), encoding: 'utf8' });
}

/** A user_message row shaped exactly like a real Devin acp-messages payload. */
function userChunk(text) {
  return {
    kind: 'user_message',
    payload: { kind: 'user_message', content: [
      { sessionUpdate: 'user_message_chunk', content: { type: 'text', text } },
    ] },
  };
}

/** An agent_message row whose content[] is split across N streaming chunks. */
function agentChunks(...texts) {
  return {
    kind: 'agent_message',
    payload: {
      kind: 'agent_message',
      turnId: 'turn-1',
      content: texts.map((text) => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } })),
    },
  };
}

function agentThought(text) {
  return {
    kind: 'agent_thought',
    payload: { kind: 'agent_thought', content: [{ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text } }] },
  };
}

function toolCall() {
  return { kind: 'tool_call', payload: { kind: 'tool_call', content: [] } };
}

// ─── Row 1: Cursor stop hook ────────────────────────────────────────────────

describe('BUILD-SPEC-0919 Row 1 — Cursor stop hook', () => {
  it('cursor registry entry: captureEvent is "stop"', () => {
    const cursor = installer.clientRegistry(os.homedir()).find((c) => c.id === 'cursor');
    assert.ok(cursor, 'cursor must be in the registry');
    assert.equal(cursor.captureEvent, 'stop');
    assert.equal(cursor.captureHook, true);
  });

  it('registerCaptureHook writes the shim under hooks.stop, never hooks.sessionEnd', () => {
    const home = tmpdir();
    try {
      const cursor = installer.clientRegistry(home, { platform: 'darwin', env: {} }).find((c) => c.id === 'cursor');
      const result = installer.registerCaptureHook(cursor, home);
      const config = JSON.parse(fs.readFileSync(cursor.captureConfigPath, 'utf-8'));
      assert.ok(Array.isArray(config.hooks.stop), 'must register under hooks.stop');
      assert.ok(config.hooks.stop.some((e) => e.command === result.hookPath));
      assert.equal(config.hooks.sessionEnd, undefined, 'no stray hooks.sessionEnd key');
      assert.equal(config.version, 1, 'Cursor requires version:1');
    } finally {
      cleanup(home);
    }
  });

  it('idempotent re-run leaves hooks.stop byte-identical (changed:false)', () => {
    const home = tmpdir();
    try {
      const cursor = installer.clientRegistry(home, { platform: 'darwin', env: {} }).find((c) => c.id === 'cursor');
      installer.registerCaptureHook(cursor, home);
      const before = fs.readFileSync(cursor.captureConfigPath, 'utf-8');
      const again = installer.registerCaptureHook(cursor, home);
      assert.equal(again.changed, false);
      assert.equal(fs.readFileSync(cursor.captureConfigPath, 'utf-8'), before);
    } finally {
      cleanup(home);
    }
  });

  it('docs/SUPPORTED-CLIENTS.md Cursor row says the stop hook, not sessionEnd', () => {
    const md = fs.readFileSync(path.join(REPO_ROOT, 'docs', 'SUPPORTED-CLIENTS.md'), 'utf8');
    const cursorRow = md.split('\n').find((line) => line.includes('**Cursor**'));
    assert.ok(cursorRow, 'Cursor row must exist in the client matrix');
    assert.match(cursorRow, /`stop` hook/);
    assert.doesNotMatch(cursorRow, /`sessionEnd` hook/);
  });
});

// ─── Row 2: Devin registry rename ───────────────────────────────────────────

describe('BUILD-SPEC-0919 Row 2 — Devin registry (windsurf entry renamed)', () => {
  it('name is "Devin Desktop"; id stays "windsurf" for ledger continuity; sourceId is "devin"', () => {
    const devin = installer.clientRegistry(os.homedir()).find((c) => c.id === 'windsurf');
    assert.ok(devin, 'the windsurf/Devin entry must still be registered under id "windsurf"');
    assert.equal(devin.name, 'Devin Desktop');
    assert.equal(devin.sourceId, 'devin');
  });

  it('drops the capture hook entirely — no more useless post_cascade_response_with_transcript writes', () => {
    const devin = installer.clientRegistry(os.homedir()).find((c) => c.id === 'windsurf');
    assert.equal(devin.captureHook, undefined);
    assert.equal(devin.captureEvent, undefined);
    assert.equal(devin.captureConfigPath, undefined);
    assert.equal(installer.clientHasCaptureHookMode(devin), false);
  });

  it('MCP config still registers (mcp:true) at ~/.config/devin/mcp_config.json', () => {
    const devin = installer.clientRegistry(os.homedir()).find((c) => c.id === 'windsurf');
    assert.equal(devin.mcp, true);
    assert.equal(devin.configPath, path.join(os.homedir(), '.config', 'devin', 'mcp_config.json'));
  });

  it('detects EITHER ~/.config/devin/ (primary) or the legacy ~/.codeium/windsurf/', () => {
    const primaryHome = tmpdir();
    const legacyHome = tmpdir();
    const neitherHome = tmpdir();
    try {
      fs.mkdirSync(path.join(primaryHome, '.config', 'devin'), { recursive: true });
      fs.mkdirSync(path.join(legacyHome, '.codeium', 'windsurf'), { recursive: true });

      const viaPrimary = installer.detectClients(primaryHome, { platform: 'darwin', env: {} });
      const viaLegacy = installer.detectClients(legacyHome, { platform: 'darwin', env: {} });
      const viaNeither = installer.detectClients(neitherHome, { platform: 'darwin', env: {} });

      assert.ok(viaPrimary.some((c) => c.id === 'windsurf'), 'must detect via ~/.config/devin/');
      assert.ok(viaLegacy.some((c) => c.id === 'windsurf'), 'must detect via legacy ~/.codeium/windsurf/');
      assert.ok(!viaNeither.some((c) => c.id === 'windsurf'), 'must not detect when neither dir exists');
    } finally {
      cleanup(primaryHome); cleanup(legacyHome); cleanup(neitherHome);
    }
  });

  it('MCP registration writer still works for the renamed entry (format json-mcpServers, unaffected by the rename)', () => {
    const home = tmpdir();
    try {
      const devin = installer.clientRegistry(home, { platform: 'darwin', env: {} }).find((c) => c.id === 'windsurf');
      fs.mkdirSync(path.dirname(devin.configPath), { recursive: true });
      const result = installer.registerMcp(devin, '0.9.19');
      assert.equal(result.status, 'registered');
      const config = JSON.parse(fs.readFileSync(devin.configPath, 'utf-8'));
      assert.deepEqual(config.mcpServers.auxilo.args, ['auxilo-mcp@0.9.19']);
    } finally {
      cleanup(home);
    }
  });
});

// ─── Row 3: devin.js poll source adapter ────────────────────────────────────

describe('BUILD-SPEC-0919 Row 3 — devin.js poll source adapter', () => {
  it('registers as source id "devin" and ships in the runner stack + sweeper manifest', () => {
    const registered = runner.loadSources().map((S) => S.id);
    assert.ok(registered.includes('devin'), 'runner.loadSources() must auto-discover devin.js');
    assert.ok(runner.SOURCES.some((S) => S.id === 'devin'));

    const stack = new Set(installer.RUNNER_STACK.map(([src]) => src));
    const sweeper = new Set(runner.sweeperManifest(REPO_ROOT).map(([src]) => src));
    assert.ok(stack.has(ADAPTER_REL), 'devin.js must ship in the installed runner stack');
    assert.ok(sweeper.has(ADAPTER_REL), 'devin.js must ship in the sweeper manifest');
  });

  it('extract-local EXTRACTABLE_SOURCES carries "devin", never "windsurf"', () => {
    assert.ok(EXTRACTABLE_SOURCES.has('devin'));
    assert.ok(!EXTRACTABLE_SOURCES.has('windsurf'));
  });

  it('detect(): true only once the acp-messages dir exists', async () => {
    const home = tmpdir();
    try {
      const source = new DevinSource({ homeDir: home });
      assert.equal(await source.detect(), false);
      fs.mkdirSync(path.join(home, 'Library', 'Application Support', 'Devin', 'User', 'acp-messages'), { recursive: true });
      assert.equal(await source.detect(), true);
    } finally {
      cleanup(home);
    }
  });

  it('discoverSessions: keeps a DB with >=1 user_message, skips an agent-only (sub-agent) DB', async () => {
    const dir = tmpdir();
    try {
      const withUser = path.join(dir, '11111111-1111-4111-8111-111111111111.db');
      const agentOnly = path.join(dir, '22222222-2222-4222-8222-222222222222.db');
      buildFixtureDb(withUser, [userChunk('hello'), agentChunks('hi there')]);
      buildFixtureDb(agentOnly, [agentThought('internal planning'), agentChunks('unsolicited'), toolCall()]);

      const source = new DevinSource({ acpDir: dir });
      const sessions = await source.discoverSessions({});
      const ids = sessions.map((s) => s.sessionId);
      assert.ok(ids.includes('11111111-1111-4111-8111-111111111111'), 'a DB with a user_message must be discovered');
      assert.ok(!ids.includes('22222222-2222-4222-8222-222222222222'), 'an agent-only DB must be skipped');
    } finally {
      cleanup(dir);
    }
  });

  it('discoverSessions: honors since (mtime) and ignores non-.db siblings (-wal/-shm)', async () => {
    const dir = tmpdir();
    try {
      const dbPath = path.join(dir, '33333333-3333-4333-8333-333333333333.db');
      buildFixtureDb(dbPath, [userChunk('hi')]);
      // Simulate an actively-open session's WAL siblings — must never be
      // treated as their own candidate session.
      fs.writeFileSync(`${dbPath}-wal`, 'not a real wal file');
      fs.writeFileSync(`${dbPath}-shm`, 'not a real shm file');

      const source = new DevinSource({ acpDir: dir });

      const future = new Date(Date.now() + 60_000).toISOString();
      assert.deepEqual(await source.discoverSessions({ since: future }), [],
        'a since in the future must exclude everything');

      const sessions = await source.discoverSessions({});
      assert.equal(sessions.length, 1, 'exactly one real .db session; -wal/-shm siblings ignored');
      assert.equal(sessions[0].sessionId, '33333333-3333-4333-8333-333333333333');
    } finally {
      cleanup(dir);
    }
  });

  it('readSession: reassembles streaming chunks into [user]/[assistant] turns, joined by blank lines', async () => {
    const dir = tmpdir();
    try {
      const dbPath = path.join(dir, '44444444-4444-4444-8444-444444444444.db');
      buildFixtureDb(dbPath, [
        userChunk('Can you help me with X?'),
        agentChunks('Sure', ', ', "I'd be happy to help with X."),
        agentThought('internal reasoning, never surfaced'),
        toolCall(),
        userChunk('Great, thanks.'),
      ]);

      const source = new DevinSource({ acpDir: dir });
      const [sessionRef] = await source.discoverSessions({});
      assert.ok(sessionRef, 'fixture session must be discovered');

      const result = await source.readSession(sessionRef);
      assert.ok(result, 'readSession must not refuse a well-formed fixture');
      assert.equal(result.transcript, [
        '[user]: Can you help me with X?',
        "[assistant]: Sure, I'd be happy to help with X.",
        '[user]: Great, thanks.',
      ].join('\n\n'));
      assert.doesNotMatch(result.transcript, /internal reasoning/, 'agent_thought must never leak into the transcript');
      assert.equal(result.metadata.sessionId, sessionRef.sessionId);
      assert.equal(result.metadata.source, 'devin');
    } finally {
      cleanup(dir);
    }
  });

  it('readSession: model provenance is stamped "unknown", never inferred', async () => {
    const dir = tmpdir();
    try {
      const dbPath = path.join(dir, '66666666-6666-4666-8666-666666666666.db');
      buildFixtureDb(dbPath, [userChunk('hi'), agentChunks('hello back')]);
      const source = new DevinSource({ acpDir: dir });
      const [sessionRef] = await source.discoverSessions({});
      const result = await source.readSession(sessionRef);
      assert.equal(result.metadata.model_provider, 'unknown');
    } finally {
      cleanup(dir);
    }
  });

  it('best-effort: neither node:sqlite nor sqlite3 available -> discoverSessions returns [] and never throws', async () => {
    const dir = tmpdir();
    try {
      buildFixtureDb(path.join(dir, '55555555-5555-4555-8555-555555555555.db'), [userChunk('hi')]);
      const source = new DevinSource({ acpDir: dir, hasSqliteAccess: () => false });
      const sessions = await source.discoverSessions({});
      assert.deepEqual(sessions, []);
    } finally {
      cleanup(dir);
    }
  });

  it('best-effort: a queryRows failure inside readSession returns null, never throws', async () => {
    const source = new DevinSource({ queryRows: () => null });
    const result = await source.readSession({
      path: '/does/not/matter.db', sessionId: 'x', mtime: new Date().toISOString(), bytes: 0,
    });
    assert.equal(result, null);
  });

  it('best-effort: a missing acp-messages directory -> discoverSessions returns [], detect() is false', async () => {
    const dir = tmpdir();
    cleanup(dir); // remove it — simulate "Devin never installed"
    const source = new DevinSource({ acpDir: dir });
    assert.equal(await source.detect(), false);
    assert.deepEqual(await source.discoverSessions({}), []);
  });

  it('registerSessionEndHook resolves null — poll-only source, no live hook', async () => {
    const source = new DevinSource({});
    assert.equal(await source.registerSessionEndHook(() => {}), null);
  });
});
