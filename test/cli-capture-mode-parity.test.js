'use strict';

/**
 * test/cli-capture-mode-parity.test.js — CLI-CAPTURE-MODE-DISAGREE
 *
 * `auxilo setup`'s detected-clients screen (bin/auxilo-cli.js cmdSetup)
 * decided whether to print "background extraction" for a client from
 * `c.hooks` alone — true ONLY for Claude Code (lib/installer.js
 * clientRegistry). The seven `captureHook:true` clients (cursor, windsurf,
 * codex, gemini-cli, antigravity, factory, copilot-cli) got no dedicated
 * `hooks.js`-style flag, so setup printed "(MCP)" for all of them even
 * though setup itself wires their capture hook a few steps later in the
 * same run. `auxilo status` (cmdStatus) already filtered its own per-client
 * "Capture hooks: ..." line on `c.captureHook` and reported these seven
 * correctly — so the two screens of the same CLI disagreed about how the
 * same client is captured.
 *
 * The fix is `installer.clientHasCaptureHookMode(client)` — one exported
 * predicate (`Boolean(client.hooks || client.captureHook)`) that cmdSetup's
 * extras line now calls instead of the bare `c.hooks` check. This suite
 * pins that fix three ways:
 *   1. Registry-level parity: for EVERY client, the helper's answer matches
 *      a hand-derived reconstruction of what `auxilo status` reports for
 *      that client (its own `captureHook` field for the seven hook clients,
 *      or its separate always-present SessionEnd-hook line for Claude Code)
 *      — one shared predicate, not two independently-maintained ones.
 *   2. Source pins: the old buggy `c.hooks ? 'background extraction' :`
 *      expression is gone from bin/auxilo-cli.js, the fixed extras line
 *      calls the shared helper, and cmdStatus's own capture-hook filter is
 *      untouched (status was already correct — only setup was broken).
 *   3. A real end-to-end run: `auxilo setup` and `auxilo status` against the
 *      SAME fixture HOME (Claude Code + Cursor detected, nothing installed
 *      yet) print the same capture-mode verdict for both clients.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const REPO = path.join(__dirname, '..');
const CLI_PATH = path.join(REPO, 'bin', 'auxilo-cli.js');
const CLI_SRC = fs.readFileSync(CLI_PATH, 'utf-8');
const installer = require('../lib/installer.js');
const { clientRegistry, clientHasCaptureHookMode } = installer;

function tmpHome(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ─── 1. Registry-level parity ────────────────────────────────────────────────

describe('CLI-CAPTURE-MODE-DISAGREE: clientHasCaptureHookMode is the one shared predicate', () => {
  const registry = clientRegistry(os.homedir());

  it('for EVERY client: the helper equals a status-shaped reconstruction (its own captureHook field, or hooks for Claude Code)', () => {
    assert.ok(registry.length >= 12, `expected at least 12 registry entries, got ${registry.length}`);
    for (const c of registry) {
      // What `auxilo status` reports for this client: the seven captureHook
      // clients via their own field (cmdStatus's `s.clients.filter((c) =>
      // c.captureHook)` loop); Claude Code via its separate, always-present
      // "SessionEnd hook: ..." line, which is driven by `c.hooks`. No other
      // client has any status-reported hook mechanism.
      const statusReportsHookMode = Boolean(c.captureHook) || Boolean(c.hooks);
      assert.equal(
        clientHasCaptureHookMode(c),
        statusReportsHookMode,
        `${c.id}: setup predicate and status-reported mode disagree`
      );
    }
  });

  it('cursor (a captureHook client, hooks:false): reports hook-capture mode true', () => {
    const cursor = registry.find((c) => c.id === 'cursor');
    assert.ok(cursor, 'cursor must be in the registry');
    assert.equal(cursor.hooks, false);
    assert.equal(cursor.captureHook, true);
    assert.equal(clientHasCaptureHookMode(cursor), true);
  });

  it('Claude Code (hooks:true, no captureHook field): reports hook-capture mode true', () => {
    const claudeCode = registry.find((c) => c.id === 'claude-code');
    assert.ok(claudeCode, 'claude-code must be in the registry');
    assert.equal(claudeCode.hooks, true);
    assert.equal(claudeCode.captureHook, undefined);
    assert.equal(clientHasCaptureHookMode(claudeCode), true);
  });

  it('a pure-MCP client with neither flag (Claude Desktop) reports hook-capture mode false', () => {
    const claudeDesktop = registry.find((c) => c.id === 'claude-desktop');
    assert.ok(claudeDesktop, 'claude-desktop must be in the registry');
    assert.equal(claudeDesktop.hooks, false);
    assert.equal(claudeDesktop.captureHook, undefined);
    assert.equal(clientHasCaptureHookMode(claudeDesktop), false);
  });

  it('the other six captureHook clients (windsurf, codex, gemini-cli, antigravity, factory, copilot-cli) also report true', () => {
    for (const id of ['windsurf', 'codex', 'gemini-cli', 'antigravity', 'factory', 'copilot-cli']) {
      const c = registry.find((x) => x.id === id);
      assert.ok(c, `${id} must be in the registry`);
      assert.equal(c.captureHook, true, `${id}: expected captureHook:true`);
      assert.equal(clientHasCaptureHookMode(c), true, `${id}: expected hook-capture mode true`);
    }
  });
});

// ─── 2. Source pins ───────────────────────────────────────────────────────────

describe('CLI-CAPTURE-MODE-DISAGREE: source pins', () => {
  it('the old buggy extras array (bare c.hooks, no shared helper) is gone from the live code', () => {
    assert.ok(
      !CLI_SRC.includes("[c.mcp ? 'MCP' : 'poll-based source', c.hooks ? 'background extraction' : null]"),
      'the pre-fix extras array (deciding the label from bare c.hooks) must not reappear in bin/auxilo-cli.js'
    );
  });

  it('cmdSetup\'s extras line calls the shared installer.clientHasCaptureHookMode helper', () => {
    assert.match(
      CLI_SRC,
      /installer\.clientHasCaptureHookMode\(c\)\s*\?\s*'background extraction'\s*:\s*null/,
      'setup screen must derive the "background extraction" label from the shared helper'
    );
  });

  it('cmdStatus\'s per-client capture-hook line is untouched (status was already correct)', () => {
    assert.ok(
      CLI_SRC.includes('s.clients.filter((c) => c.captureHook)'),
      'status\'s own capture-hook filter must remain the reference implementation this fix aligns setup to'
    );
  });

  it('lib/installer.js exports clientHasCaptureHookMode', () => {
    assert.equal(typeof installer.clientHasCaptureHookMode, 'function');
  });
});

// ─── 3. End-to-end: setup and status agree, against the same fixture HOME ───

describe('CLI-CAPTURE-MODE-DISAGREE: `auxilo setup` and `auxilo status` print the same capture mode', () => {
  function makeHome() {
    const home = tmpHome('aux-cli-capture-mode-');
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(home, '.cursor'), { recursive: true });
    return home;
  }

  /**
   * Runs `auxilo setup` far enough to print the "Detected clients:" block,
   * then kills the child the moment the next prompt ("Configure which
   * clients?") appears — no consent server, no stdin script needed, since
   * the block this test cares about prints unconditionally before any
   * prompt is answered.
   */
  function runSetupDetectionBlock(home) {
    return new Promise((resolve, reject) => {
      const env = { ...process.env, HOME: home, AUXILO_NO_NOTIFY: '1' };
      delete env.AUXILO_BASE_URL;
      const child = spawn(process.execPath, [CLI_PATH, 'setup', '--base-url', 'http://127.0.0.1:1'], {
        env, stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`setup subprocess hung waiting for the client-selection prompt\nstdout:\n${stdout}\nstderr:\n${stderr}`));
      }, 15000);
      child.stdout.on('data', (c) => {
        stdout += c;
        if (/Configure which clients\?/.test(stdout)) {
          clearTimeout(timer);
          child.kill('SIGKILL');
        }
      });
      child.stderr.on('data', (c) => { stderr += c; });
      child.on('error', (err) => { clearTimeout(timer); reject(err); });
      child.on('close', () => resolve({ stdout, stderr }));
    });
  }

  function runStatus(home) {
    return new Promise((resolve, reject) => {
      const env = { ...process.env, HOME: home, AUXILO_NO_NOTIFY: '1' };
      delete env.AUXILO_BASE_URL;
      const child = spawn(process.execPath, [CLI_PATH, 'status'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`status timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`)); }, 15000);
      child.stdout.on('data', (c) => { stdout += c; });
      child.stderr.on('data', (c) => { stderr += c; });
      child.on('error', (err) => { clearTimeout(timer); reject(err); });
      child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    });
  }

  it('setup labels both Cursor and Claude Code "background extraction", and status independently reports a hook mechanism for both', async () => {
    const home = makeHome();

    const setupRes = await runSetupDetectionBlock(home);
    assert.match(setupRes.stdout, /Cursor \(MCP, background extraction\)/,
      `setup must label cursor with background extraction\nfull stdout:\n${setupRes.stdout}`);
    assert.match(setupRes.stdout, /Claude Code \(MCP, background extraction\)/,
      `setup must label Claude Code with background extraction\nfull stdout:\n${setupRes.stdout}`);

    const statusRes = await runStatus(home);
    assert.equal(statusRes.code, 0, `status must exit 0\nstdout:\n${statusRes.stdout}\nstderr:\n${statusRes.stderr}`);
    // Cursor: status's own per-client "Capture hooks" line (unconditionally
    // present once cursor is detected — captureHook is a registry fact, not
    // dependent on the hook actually having been installed yet).
    assert.match(statusRes.stdout, /Capture hooks: Cursor \(sessionEnd, not registered\)/,
      `status must report cursor's capture hook\nfull stdout:\n${statusRes.stdout}`);
    // Claude Code: status's separate, always-present SessionEnd-hook line —
    // "not installed" here because setup was killed before completing.
    assert.match(statusRes.stdout, /SessionEnd hook: not installed/,
      `status must report Claude Code's SessionEnd hook line\nfull stdout:\n${statusRes.stdout}`);
  });
});
