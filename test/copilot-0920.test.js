'use strict';

/**
 * test/copilot-0920.test.js — BUILD-SPEC-0920: GitHub Copilot CLI dedicated
 * source adapter (scripts/sources/copilot.js).
 *
 * Context: the capture Stop hook already works as shipped (lib/installer.js
 * 'copilot-cli' registry entry, untouched by this wave) — Copilot's own Stop
 * event fires and hands runner.js a real transcript_path resolving to
 * ~/.copilot/session-state/<sessionId>/events.jsonl. What was missing is the
 * PARSE: that file is a typed event stream (one JSON object per line,
 * {"type":"<t>","data":{...}}), not the plain role/content JSONL the
 * generic-jsonl fallback expects, so capture fired, found the file, and
 * silently extracted 0 turns. This suite exercises the dedicated parser.
 *
 * Fixture event shapes below mirror the REAL events.jsonl format verified
 * live against an operator install (Copilot CLI 1.0.83/1.0.84, 2026-09-10):
 * session.start carries data.selectedModel + data.sessionId; user.message
 * carries data.content (a plain string) plus a data.transformedContent this
 * adapter must ignore; assistant.message carries data.content + data.model,
 * and a pure tool-call turn has content:"" alongside a non-empty
 * data.toolRequests[].
 *
 * No fixture ever touches the real HOME — every events.jsonl lives under a
 * fs.mkdtempSync(os.tmpdir()) directory, per the repo's test-isolation rule.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..');
const ADAPTER_REL = 'scripts/sources/copilot.js';

const installer = require('../lib/installer.js');
const runner = require('../scripts/runner.js');
const { EXTRACTABLE_SOURCES } = require('../scripts/extract-local.js');
const { CopilotSource } = require('../scripts/sources/copilot.js');

function tmpdir(prefix = 'aux-0920-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

/** Write `lines` (objects) as JSONL to `<dir>/<sessionId>/events.jsonl`. */
function buildFixtureSession(dir, sessionId, lines) {
  const sessionDir = path.join(dir, sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });
  const filePath = path.join(sessionDir, 'events.jsonl');
  fs.writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return filePath;
}

// ─── Real-shape fixture line builders ───────────────────────────────────────

function sessionStart({ sessionId = '841c6d3e-9943-4733-a96b-98612feb9eab', selectedModel = 'gpt-5.6-terra' } = {}) {
  return {
    type: 'session.start',
    data: { sessionId, version: 1, producer: 'copilot-agent', copilotVersion: '0.0.0', selectedModel, reasoningEffort: 'medium' },
    id: 'evt-start', timestamp: new Date().toISOString(), parentId: null,
  };
}

function userMessage(content, transformedContent = `<current_datetime>2026-09-10</current_datetime>\n${content}`) {
  return { type: 'user.message', data: { content, transformedContent, messageId: 'm1', turnId: 't1' } };
}

function assistantMessage(content, { model = 'gpt-5.6-terra', toolRequests = [] } = {}) {
  return { type: 'assistant.message', data: { model, content, toolRequests, messageId: 'm2', turnId: 't1' } };
}

/** A pure tool-call turn: empty content, non-empty toolRequests. */
function assistantToolCall({ model = 'gpt-5.6-terra' } = {}) {
  return assistantMessage('', { model, toolRequests: [{ name: 'read_file', arguments: '{"path":"x"}' }] });
}

function skipLine(type) {
  return { type, data: {} };
}

// ─── Registry wiring ─────────────────────────────────────────────────────────

describe('BUILD-SPEC-0920 — copilot.js source adapter registration', () => {
  it('registers as source id "copilot" and ships in the runner stack + sweeper manifest', () => {
    const registered = runner.loadSources().map((S) => S.id);
    assert.ok(registered.includes('copilot'), 'runner.loadSources() must auto-discover copilot.js');
    assert.ok(runner.SOURCES.some((S) => S.id === 'copilot'));

    const stack = new Set(installer.RUNNER_STACK.map(([src]) => src));
    const sweeper = new Set(runner.sweeperManifest(REPO_ROOT).map(([src]) => src));
    assert.ok(stack.has(ADAPTER_REL), 'copilot.js must ship in the installed runner stack');
    assert.ok(sweeper.has(ADAPTER_REL), 'copilot.js must ship in the sweeper manifest');
  });

  it('extract-local EXTRACTABLE_SOURCES carries "copilot"', () => {
    assert.ok(EXTRACTABLE_SOURCES.has('copilot'));
  });
});

// ─── detect() / discoverSessions() ──────────────────────────────────────────

describe('BUILD-SPEC-0920 — copilot.js detect() and discoverSessions()', () => {
  it('detect(): true only once ~/.copilot/session-state exists', async () => {
    const home = tmpdir();
    try {
      const source = new CopilotSource({ homeDir: home });
      assert.equal(await source.detect(), false);
      fs.mkdirSync(path.join(home, '.copilot', 'session-state'), { recursive: true });
      assert.equal(await source.detect(), true);
    } finally {
      cleanup(home);
    }
  });

  it('discoverSessions: finds a session dir with events.jsonl, skips a dir without one', async () => {
    const dir = tmpdir();
    try {
      buildFixtureSession(dir, 'session-with-events', [sessionStart(), userMessage('hi')]);
      fs.mkdirSync(path.join(dir, 'session-without-events'), { recursive: true }); // no events.jsonl inside

      const source = new CopilotSource({ stateDir: dir });
      const sessions = await source.discoverSessions({});
      const ids = sessions.map((s) => s.sessionId);
      assert.ok(ids.includes('session-with-events'));
      assert.ok(!ids.includes('session-without-events'));
    } finally {
      cleanup(dir);
    }
  });

  it('discoverSessions: honors since (mtime) and returns [] when the state dir is missing', async () => {
    const dir = tmpdir();
    try {
      buildFixtureSession(dir, 'sess-1', [sessionStart(), userMessage('hi')]);
      const source = new CopilotSource({ stateDir: dir });

      const future = new Date(Date.now() + 60_000).toISOString();
      assert.deepEqual(await source.discoverSessions({ since: future }), [],
        'a since in the future must exclude everything');

      const sessions = await source.discoverSessions({});
      assert.equal(sessions.length, 1);
      assert.equal(sessions[0].sessionId, 'sess-1');

      cleanup(dir);
      assert.deepEqual(await source.discoverSessions({}), [], 'missing state dir -> []');
    } finally {
      cleanup(dir);
    }
  });
});

// ─── readSession() ──────────────────────────────────────────────────────────

describe('BUILD-SPEC-0920 — copilot.js readSession()', () => {
  it('reconstructs [user]/[assistant] turns and stamps the model from session.start.selectedModel', async () => {
    const dir = tmpdir();
    try {
      const filePath = buildFixtureSession(dir, 'sess-full', [
        sessionStart({ selectedModel: 'gpt-5.6-terra' }),
        skipLine('session.permissions_changed'),
        userMessage('Why does strings show runtime internals?'),
        skipLine('hook.start'),
        skipLine('hook.end'),
        skipLine('assistant.turn_start'),
        assistantMessage("Because it's a Node SEA binary.", { model: 'gpt-5.6-terra' }),
        skipLine('assistant.turn_end'),
        skipLine('session.usage_checkpoint'),
      ]);

      const source = new CopilotSource({ stateDir: dir });
      const result = await source.readSession({ path: filePath, sessionId: 'sess-full', mtime: new Date().toISOString(), bytes: 1 });

      assert.ok(result, 'readSession must not refuse a well-formed fixture');
      assert.equal(result.transcript, [
        '[user]: Why does strings show runtime internals?',
        "[assistant]: Because it's a Node SEA binary.",
      ].join('\n\n'));
      assert.equal(result.metadata.model, 'gpt-5.6-terra');
      assert.equal(result.metadata.source, 'copilot');
      assert.equal(result.metadata.sessionId, '841c6d3e-9943-4733-a96b-98612feb9eab', 'in-file session.start.data.sessionId wins over the caller-supplied ref');
    } finally {
      cleanup(dir);
    }
  });

  it('ignores data.transformedContent — only the plain data.content string is extracted', async () => {
    const dir = tmpdir();
    try {
      const filePath = buildFixtureSession(dir, 'sess-tc', [
        sessionStart(),
        userMessage('plain prompt text'),
        assistantMessage('reply'),
      ]);
      const source = new CopilotSource({ stateDir: dir });
      const result = await source.readSession({ path: filePath, sessionId: 'sess-tc', mtime: new Date().toISOString(), bytes: 1 });
      assert.ok(result.transcript.includes('[user]: plain prompt text'));
      assert.doesNotMatch(result.transcript, /current_datetime/, 'transformedContent wrapper must never leak into the transcript');
    } finally {
      cleanup(dir);
    }
  });

  it('an assistant.message with empty content + toolRequests contributes no turn', async () => {
    const dir = tmpdir();
    try {
      const filePath = buildFixtureSession(dir, 'sess-tool', [
        sessionStart(),
        userMessage('read that file for me'),
        assistantToolCall(),
        assistantMessage('Done — here is what the file contains.'),
      ]);
      const source = new CopilotSource({ stateDir: dir });
      const result = await source.readSession({ path: filePath, sessionId: 'sess-tool', mtime: new Date().toISOString(), bytes: 1 });
      assert.equal(result.transcript, [
        '[user]: read that file for me',
        '[assistant]: Done — here is what the file contains.',
      ].join('\n\n'), 'the empty-content tool-call turn must not appear as a blank [assistant]: turn');
    } finally {
      cleanup(dir);
    }
  });

  it('non-conversation types (session.*/hook.*/tool.*/system.message/turn markers/usage) are ignored', async () => {
    const dir = tmpdir();
    try {
      const filePath = buildFixtureSession(dir, 'sess-skip', [
        sessionStart(),
        skipLine('session.permissions_changed'),
        skipLine('hook.start'),
        skipLine('hook.end'),
        { type: 'system.message', data: { content: 'you are a helpful assistant, SECRET SYSTEM PROMPT' } },
        userMessage('hello'),
        skipLine('assistant.turn_start'),
        skipLine('tool.execution_start'),
        skipLine('tool.execution_complete'),
        assistantMessage('hi there'),
        skipLine('assistant.turn_end'),
        skipLine('session.usage_checkpoint'),
        skipLine('session.shutdown'),
      ]);
      const source = new CopilotSource({ stateDir: dir });
      const result = await source.readSession({ path: filePath, sessionId: 'sess-skip', mtime: new Date().toISOString(), bytes: 1 });
      assert.equal(result.transcript, ['[user]: hello', '[assistant]: hi there'].join('\n\n'));
      assert.doesNotMatch(result.transcript, /SECRET SYSTEM PROMPT/, 'system.message must never leak into the transcript');
    } finally {
      cleanup(dir);
    }
  });

  it('model falls back to the last assistant.message.model when session.start lacks selectedModel', async () => {
    const dir = tmpdir();
    try {
      const filePath = buildFixtureSession(dir, 'sess-fallback', [
        { type: 'session.start', data: { sessionId: 'sess-fallback' } }, // no selectedModel field
        userMessage('hi'),
        assistantMessage('first reply', { model: 'gpt-5.5-old' }),
        userMessage('and?'),
        assistantMessage('second reply', { model: 'gpt-5.6-terra' }),
      ]);
      const source = new CopilotSource({ stateDir: dir });
      const result = await source.readSession({ path: filePath, sessionId: 'sess-fallback', mtime: new Date().toISOString(), bytes: 1 });
      assert.equal(result.metadata.model, 'gpt-5.6-terra', 'must use the LAST assistant.message.model, not the first');
    } finally {
      cleanup(dir);
    }
  });

  it('malformed JSON line is skipped, not fatal — surrounding valid turns still extract', async () => {
    const dir = tmpdir();
    try {
      const sessionDir = path.join(dir, 'sess-malformed');
      fs.mkdirSync(sessionDir, { recursive: true });
      const filePath = path.join(sessionDir, 'events.jsonl');
      const goodLines = [sessionStart(), userMessage('before the garbage')].map((l) => JSON.stringify(l));
      const badLine = '{"type":"user.message","data":{"content": UNTERMINATED';
      const moreGood = [assistantMessage('after the garbage')].map((l) => JSON.stringify(l));
      fs.writeFileSync(filePath, [...goodLines, badLine, ...moreGood].join('\n') + '\n');

      const source = new CopilotSource({ stateDir: dir });
      const result = await source.readSession({ path: filePath, sessionId: 'sess-malformed', mtime: new Date().toISOString(), bytes: 1 });
      assert.ok(result, 'a single malformed line must not refuse the whole session');
      assert.equal(result.transcript, [
        '[user]: before the garbage',
        '[assistant]: after the garbage',
      ].join('\n\n'));
    } finally {
      cleanup(dir);
    }
  });

  it('a line that parses to a non-object JSON value is ignored, never throws', async () => {
    const dir = tmpdir();
    try {
      const sessionDir = path.join(dir, 'sess-nonobj');
      fs.mkdirSync(sessionDir, { recursive: true });
      const filePath = path.join(sessionDir, 'events.jsonl');
      const lines = [JSON.stringify(sessionStart()), JSON.stringify(userMessage('hi')), '42', '"just a string"', '[1,2,3]', JSON.stringify(assistantMessage('hello back'))];
      fs.writeFileSync(filePath, lines.join('\n') + '\n');

      const source = new CopilotSource({ stateDir: dir });
      const result = await source.readSession({ path: filePath, sessionId: 'sess-nonobj', mtime: new Date().toISOString(), bytes: 1 });
      assert.ok(result);
      assert.equal(result.transcript, ['[user]: hi', '[assistant]: hello back'].join('\n\n'));
    } finally {
      cleanup(dir);
    }
  });

  it('a file with only non-conversation lines -> null (no turns)', async () => {
    const dir = tmpdir();
    try {
      const filePath = buildFixtureSession(dir, 'sess-empty', [
        sessionStart(),
        skipLine('hook.start'),
        skipLine('hook.end'),
        skipLine('session.shutdown'),
      ]);
      const source = new CopilotSource({ stateDir: dir });
      const result = await source.readSession({ path: filePath, sessionId: 'sess-empty', mtime: new Date().toISOString(), bytes: 1 });
      assert.equal(result, null);
    } finally {
      cleanup(dir);
    }
  });

  it('unreadable/missing file -> null, never throws', async () => {
    const source = new CopilotSource({});
    const result = await source.readSession({ path: '/does/not/exist/events.jsonl', sessionId: 'x', mtime: new Date().toISOString(), bytes: 0 });
    assert.equal(result, null);
  });

  it('a sessionRef with no path -> null, never throws', async () => {
    const source = new CopilotSource({});
    assert.equal(await source.readSession({}), null);
    assert.equal(await source.readSession(null), null);
  });

  it('registerSessionEndHook resolves null — hook-fired via the shipped Stop event, not a poll-only live hook', async () => {
    const source = new CopilotSource({});
    assert.equal(await source.registerSessionEndHook(() => {}), null);
  });
});
