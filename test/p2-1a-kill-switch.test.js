/**
 * test/p2-1a-kill-switch.test.js — Kill-switch sentinel, ownership, recursion guard
 *
 * Covers:
 *   - KILL_SWITCH_PATH in runner.js is ~/.auxilo/autonomous-enabled (inverted sentinel)
 *   - AUXILO_EXTRACTING env guard in runner.js
 *   - Server-side kill-switch reset sentinel permissions check
 *   - Server-side kill-switch reset sentinel ownership check
 *   - Circuit breaker kill_switch returns 503
 *
 * Strategy: Structural source-code analysis (reads runner.js and server.js)
 *
 * Runner: node --test test/p2-1a-kill-switch.test.js
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const RUNNER_SRC = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'runner.js'), 'utf-8');
const SERVER_SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf-8');

// ─── Runner-side kill-switch + recursion guard ──────────────────────────────

describe('Kill-switch: runner.js sentinel', () => {
  it('KILL_SWITCH_PATH references ~/.auxilo/autonomous-enabled', () => {
    assert.ok(RUNNER_SRC.includes('autonomous-enabled'),
      'runner must reference autonomous-enabled sentinel');
  });

  it('AUXILO_EXTRACTING env guard exists', () => {
    assert.ok(RUNNER_SRC.includes('AUXILO_EXTRACTING'),
      'runner must check AUXILO_EXTRACTING env var');
  });

  it('AUXILO_EXTRACTING set to "1" prevents recursion', () => {
    // Find the recursion guard check
    const envIdx = RUNNER_SRC.indexOf('AUXILO_EXTRACTING');
    assert.ok(envIdx > -1);
    const block = RUNNER_SRC.slice(envIdx, envIdx + 300);
    assert.ok(block.includes("'1'") || block.includes('"1"'),
      'must check AUXILO_EXTRACTING === "1"');
  });

  it('runner sets AUXILO_EXTRACTING when running', () => {
    assert.ok(RUNNER_SRC.includes("process.env.AUXILO_EXTRACTING = '1'") ||
              RUNNER_SRC.includes('process.env.AUXILO_EXTRACTING = "1"'),
      'runner must set AUXILO_EXTRACTING to 1 during execution');
  });
});

// ─── Server-side kill-switch reset sentinel ─────────────────────────────────

describe('Kill-switch: server.js circuit breaker reset sentinel', () => {
  it('KILL_SWITCH_RESET_FILE constant exists', () => {
    assert.ok(SERVER_SRC.includes('KILL_SWITCH_RESET_FILE'),
      'server must define KILL_SWITCH_RESET_FILE');
  });

  it('sentinel has permission check (group/world-writable)', () => {
    assert.ok(SERVER_SRC.includes('group/world-writable') || SERVER_SRC.includes('statSync'),
      'server must check sentinel file permissions');
  });

  it('sentinel has ownership check (server uid)', () => {
    assert.ok(SERVER_SRC.includes('server uid') || SERVER_SRC.includes('process.getuid'),
      'server must check sentinel ownership against server uid');
  });

  it('kill_switch circuit breaker returns 503', () => {
    const cbIdx = SERVER_SRC.indexOf("kill_switch");
    assert.ok(cbIdx > -1);
    // Find the 503 return
    assert.ok(SERVER_SRC.includes("code: 'kill_switch'") &&
              SERVER_SRC.includes('503'),
      'kill_switch must return 503');
  });

  it('sentinel is unlinked after processing', () => {
    const resetIdx = SERVER_SRC.indexOf('KILL_SWITCH_RESET_FILE');
    const after = SERVER_SRC.slice(resetIdx, resetIdx + 1500);
    assert.ok(after.includes('unlinkSync'),
      'sentinel must be deleted after processing');
  });
});
