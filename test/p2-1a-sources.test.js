/**
 * test/p2-1a-sources.test.js — TranscriptSource interface + adapters
 *
 * Covers: A5.1 interface contract, A5.4 OpenClaw path fix, T-107–T-110
 * Filled by: Phase 2
 *
 * Runner: node --test test/p2-1a-sources.test.js
 */

'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ── A5.1: TranscriptSource interface contract ───────────────────────────────

describe('A5.1: TranscriptSource interface contract', () => {
  let TranscriptSource;

  before(() => {
    ({ TranscriptSource } = require('../scripts/sources/source.interface'));
  });

  it('exports TranscriptSource class', () => {
    assert.ok(TranscriptSource, 'TranscriptSource must be exported');
    assert.equal(typeof TranscriptSource, 'function', 'must be a class/constructor');
  });

  it('has static id field', () => {
    assert.equal(TranscriptSource.id, 'abstract');
  });

  it('has static displayName field', () => {
    assert.equal(TranscriptSource.displayName, 'Abstract Source');
  });

  it('has static version field', () => {
    assert.ok(TranscriptSource.version, 'version must be set');
  });

  it('detect() throws on base class', async () => {
    const src = new TranscriptSource();
    await assert.rejects(() => src.detect(), /must be implemented/);
  });

  it('discoverSessions() throws on base class', async () => {
    const src = new TranscriptSource();
    await assert.rejects(() => src.discoverSessions(), /must be implemented/);
  });

  it('readSession() throws on base class', async () => {
    const src = new TranscriptSource();
    await assert.rejects(() => src.readSession({}), /must be implemented/);
  });

  it('registerSessionEndHook() returns null by default (poll-only)', async () => {
    const src = new TranscriptSource();
    const result = await src.registerSessionEndHook(() => {});
    assert.equal(result, null, 'base class registerSessionEndHook must return null');
  });
});

// ── Claude Code adapter ─────────────────────────────────────────────────────

describe('Claude Code adapter interface compliance', () => {
  let ClaudeCodeSource;

  before(() => {
    ({ ClaudeCodeSource } = require('../scripts/sources/claude-code'));
  });

  it('static id is "claude-code"', () => {
    assert.equal(ClaudeCodeSource.id, 'claude-code');
  });

  it('static displayName is set', () => {
    assert.ok(ClaudeCodeSource.displayName);
  });

  it('static version is semver', () => {
    assert.match(ClaudeCodeSource.version, /^\d+\.\d+\.\d+$/);
  });

  it('extends TranscriptSource', () => {
    const { TranscriptSource } = require('../scripts/sources/source.interface');
    const src = new ClaudeCodeSource();
    assert.ok(src instanceof TranscriptSource);
  });

  it('has detect() method', () => {
    const src = new ClaudeCodeSource();
    assert.equal(typeof src.detect, 'function');
  });

  it('has discoverSessions() method', () => {
    const src = new ClaudeCodeSource();
    assert.equal(typeof src.discoverSessions, 'function');
  });

  it('has readSession() method', () => {
    const src = new ClaudeCodeSource();
    assert.equal(typeof src.readSession, 'function');
  });

  it('has registerSessionEndHook() method', () => {
    const src = new ClaudeCodeSource();
    assert.equal(typeof src.registerSessionEndHook, 'function');
  });

  it('data dir defaults to ~/.claude/projects', () => {
    const src = new ClaudeCodeSource();
    assert.equal(src.dataDir, path.join(os.homedir(), '.claude', 'projects'));
  });

  it('detect() returns false when data dir does not exist', async () => {
    const src = new ClaudeCodeSource({ dataDir: '/nonexistent/path/test' });
    const result = await src.detect();
    assert.equal(result, false);
  });

  it('discoverSessions() returns empty array when data dir missing', async () => {
    const src = new ClaudeCodeSource({ dataDir: '/nonexistent/path/test' });
    const sessions = await src.discoverSessions();
    assert.deepStrictEqual(sessions, []);
  });

  it('discoverSessions() returns objects with correct shape', async () => {
    // Create temp dir structure
    const tmpDir = path.join(os.tmpdir(), `auxilo-test-cc-${Date.now()}`);
    const convDir = path.join(tmpDir, 'project1', 'conversations');
    fs.mkdirSync(convDir, { recursive: true });
    fs.writeFileSync(path.join(convDir, 'session1.jsonl'), '{"role":"user","content":"test"}\n');

    try {
      const src = new ClaudeCodeSource({
        dataDir: tmpDir,
        settingsPath: path.join(tmpDir, 'settings.json'),
      });
      // Create a dummy settings.json so detect works
      fs.writeFileSync(path.join(tmpDir, 'settings.json'), '{}');

      const sessions = await src.discoverSessions();
      assert.ok(sessions.length > 0, 'should find at least one session');

      const s = sessions[0];
      assert.ok(s.sessionId, 'must have sessionId');
      assert.ok(s.path, 'must have path');
      assert.ok(s.mtime, 'must have mtime');
      assert.ok(typeof s.bytes === 'number', 'must have bytes as number');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('readSession() returns { transcript, metadata }', async () => {
    const tmpDir = path.join(os.tmpdir(), `auxilo-test-cc-read-${Date.now()}`);
    const convDir = path.join(tmpDir, 'project1', 'conversations');
    fs.mkdirSync(convDir, { recursive: true });
    const testFile = path.join(convDir, 'sess_read.jsonl');
    fs.writeFileSync(testFile, '{"role":"user","content":"hello world"}\n{"role":"assistant","content":"hi"}\n');

    try {
      const src = new ClaudeCodeSource({ dataDir: tmpDir });
      const result = await src.readSession({
        sessionId: 'sess_read',
        path: testFile,
        mtime: new Date().toISOString(),
        bytes: 100,
      });

      assert.ok(result.transcript, 'must have transcript');
      assert.ok(result.metadata, 'must have metadata');
      assert.equal(result.metadata.sessionId, 'sess_read');
      assert.equal(result.metadata.source, 'claude-code');
      assert.ok(result.transcript.includes('[user]: hello world'));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ── A5.4: OpenClaw adapter path fix ─────────────────────────────────────────

describe('A5.4: OpenClaw adapter', () => {
  let OpenClawSource;

  before(() => {
    ({ OpenClawSource } = require('../scripts/sources/openclaw'));
  });

  it('static id is "openclaw"', () => {
    assert.equal(OpenClawSource.id, 'openclaw');
  });

  it('static version is semver', () => {
    assert.match(OpenClawSource.version, /^\d+\.\d+\.\d+$/);
  });

  it('extends TranscriptSource', () => {
    const { TranscriptSource } = require('../scripts/sources/source.interface');
    const src = new OpenClawSource();
    assert.ok(src instanceof TranscriptSource);
  });

  it('data dir defaults to ~/.openclaw/agents (NOT data/openclaw/)', () => {
    const src = new OpenClawSource();
    assert.equal(src.dataDir, path.join(os.homedir(), '.openclaw', 'agents'),
      'A5.4: must use ~/.openclaw/agents, not repo-local data/openclaw/');

    // Verify it does NOT use the old repo-local path
    assert.ok(!src.dataDir.includes('data/openclaw'),
      'must NOT contain data/openclaw');
  });

  it('registerSessionEndHook() returns null (poll-only per spec §4.3)', async () => {
    const src = new OpenClawSource();
    const result = await src.registerSessionEndHook(() => {});
    assert.equal(result, null, 'OpenClaw is poll-only at launch');
  });

  it('detect() returns false when data dir does not exist', async () => {
    const src = new OpenClawSource({ dataDir: '/nonexistent/path/test' });
    const result = await src.detect();
    assert.equal(result, false);
  });

  it('detect() returns false when dir exists but no agent subdirectories', async () => {
    const tmpDir = path.join(os.tmpdir(), `auxilo-test-oc-empty-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    try {
      const src = new OpenClawSource({ dataDir: tmpDir });
      const result = await src.detect();
      assert.equal(result, false, 'empty agents dir = not installed');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('discoverSessions() finds .jsonl files in agents/*/sessions/', async () => {
    const tmpDir = path.join(os.tmpdir(), `auxilo-test-oc-discover-${Date.now()}`);
    const sessDir = path.join(tmpDir, 'agent1', 'sessions');
    fs.mkdirSync(sessDir, { recursive: true });
    fs.writeFileSync(path.join(sessDir, 'sess1.jsonl'),
      '{"type":"metadata"}\n{"role":"user","content":"test"}\n');

    try {
      const src = new OpenClawSource({ dataDir: tmpDir });
      const sessions = await src.discoverSessions();
      assert.ok(sessions.length > 0, 'should find sessions');

      const s = sessions[0];
      assert.equal(s.sessionId, 'sess1');
      assert.ok(s.path.endsWith('.jsonl'));
      assert.ok(s.mtime);
      assert.ok(typeof s.bytes === 'number');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('readSession() skips first (metadata) line per spec §4.3', async () => {
    const tmpDir = path.join(os.tmpdir(), `auxilo-test-oc-read-${Date.now()}`);
    const sessDir = path.join(tmpDir, 'agent1', 'sessions');
    fs.mkdirSync(sessDir, { recursive: true });
    const testFile = path.join(sessDir, 'sess_read.jsonl');
    fs.writeFileSync(testFile,
      '{"type":"session_metadata","sessionId":"sess_read"}\n' +
      '{"role":"user","content":"hello openclaw"}\n' +
      '{"role":"assistant","content":"hi back"}\n'
    );

    try {
      const src = new OpenClawSource({ dataDir: tmpDir });
      const result = await src.readSession({
        sessionId: 'sess_read',
        path: testFile,
        mtime: new Date().toISOString(),
        bytes: 200,
      });

      assert.ok(result.transcript, 'must have transcript');
      assert.ok(!result.transcript.includes('session_metadata'),
        'first metadata line must be skipped');
      assert.ok(result.transcript.includes('[user]: hello openclaw'));
      assert.equal(result.metadata.source, 'openclaw');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
