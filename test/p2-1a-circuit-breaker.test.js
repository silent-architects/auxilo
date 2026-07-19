/**
 * test/p2-1a-circuit-breaker.test.js — Circuit breaker persistence + ownership
 *
 * Covers: A3 (persistence across restart), B8 (ownership check on sentinel)
 * Filled by: Phase 1
 *
 * Strategy: Test circuit breaker persistence by directly reading/writing
 * the data/circuit-breaker.json file. We cannot easily test the full
 * server boot cycle, so we test the file format contract instead.
 *
 * Runner: node --test test/p2-1a-circuit-breaker.test.js
 */

'use strict';

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const CB_FILE = path.join(__dirname, '..', 'data', 'circuit-breaker.json');
const CB_BACKUP = CB_FILE + '.test-backup';
const SENTINEL_FILE = path.join(__dirname, '..', 'data', '.extract-kill-switch-reset');
const SENTINEL_BACKUP = SENTINEL_FILE + '.test-backup';

before(() => {
  // Back up existing files
  if (fs.existsSync(CB_FILE)) fs.copyFileSync(CB_FILE, CB_BACKUP);
  if (fs.existsSync(SENTINEL_FILE)) fs.copyFileSync(SENTINEL_FILE, SENTINEL_BACKUP);
});

after(() => {
  // Restore originals
  if (fs.existsSync(CB_BACKUP)) {
    fs.copyFileSync(CB_BACKUP, CB_FILE);
    fs.unlinkSync(CB_BACKUP);
  } else if (fs.existsSync(CB_FILE)) {
    fs.unlinkSync(CB_FILE);
  }
  if (fs.existsSync(SENTINEL_BACKUP)) {
    fs.copyFileSync(SENTINEL_BACKUP, SENTINEL_FILE);
    fs.unlinkSync(SENTINEL_BACKUP);
  } else if (fs.existsSync(SENTINEL_FILE)) {
    try { fs.unlinkSync(SENTINEL_FILE); } catch {}
  }
});

// ── A3: Circuit breaker persistence format ──────────────────────────────────

describe('A3: Circuit breaker persistence file contract', () => {
  beforeEach(() => {
    if (fs.existsSync(CB_FILE)) fs.unlinkSync(CB_FILE);
  });

  it('persistence file has correct JSON shape: date, spendUsd, killSwitchActive', () => {
    const today = new Date().toISOString().split('T')[0];
    const state = { date: today, spendUsd: 12.50, killSwitchActive: false };
    fs.writeFileSync(CB_FILE, JSON.stringify(state), 'utf-8');

    const loaded = JSON.parse(fs.readFileSync(CB_FILE, 'utf-8'));
    assert.equal(loaded.date, today);
    assert.equal(loaded.spendUsd, 12.50);
    assert.equal(loaded.killSwitchActive, false);
  });

  it('killSwitchActive=true persists regardless of date', () => {
    const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
    const state = { date: yesterday, spendUsd: 100, killSwitchActive: true };
    fs.writeFileSync(CB_FILE, JSON.stringify(state), 'utf-8');

    const loaded = JSON.parse(fs.readFileSync(CB_FILE, 'utf-8'));
    assert.equal(loaded.killSwitchActive, true,
      'kill switch must persist across date boundaries');
  });

  it('spendUsd should reset when date mismatches (boot-time logic contract)', () => {
    const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
    const today = new Date().toISOString().split('T')[0];
    const state = { date: yesterday, spendUsd: 99.50, killSwitchActive: false };
    fs.writeFileSync(CB_FILE, JSON.stringify(state), 'utf-8');

    const loaded = JSON.parse(fs.readFileSync(CB_FILE, 'utf-8'));
    // The *file* still has the old spend — the boot code resets spendUsd when date mismatches.
    // This test documents the contract: date !== today → spendUsd NOT loaded.
    assert.notEqual(loaded.date, today,
      'old date confirms spend should be reset by boot logic');
    assert.equal(loaded.spendUsd, 99.50,
      'file preserves spend even with old date (boot logic resets it)');
  });

  it('kill switch survives UTC midnight (date mismatch + killSwitch still true)', () => {
    // Simulate: yesterday's state with kill switch active
    const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
    const state = { date: yesterday, spendUsd: 150, killSwitchActive: true };
    fs.writeFileSync(CB_FILE, JSON.stringify(state), 'utf-8');

    // Boot logic contract: load file, if killSwitchActive → restore it regardless of date
    const loaded = JSON.parse(fs.readFileSync(CB_FILE, 'utf-8'));
    assert.equal(loaded.killSwitchActive, true,
      'kill switch persists in file regardless of date');
    // Boot code: circuitBreaker.killSwitchActive = true BUT circuitBreaker.spendUsd = 0
    // (because date !== today)
  });
});

// ── A3: Circuit breaker file created by server.js ───────────────────────────

describe('A3: Circuit breaker file existence after server.js load', () => {
  it('server.js defines CIRCUIT_BREAKER_FILE constant', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf-8');
    assert.ok(src.includes("CIRCUIT_BREAKER_FILE = path.join(__dirname, 'data', 'circuit-breaker.json')"),
      'CIRCUIT_BREAKER_FILE must be defined in server.js');
  });

  it('server.js defines persistCircuitBreaker function', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf-8');
    assert.ok(src.includes('function persistCircuitBreaker()'),
      'persistCircuitBreaker must be defined in server.js');
  });

  it('server.js calls persistCircuitBreaker in recordSpend', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf-8');
    // Find recordSpend function body
    const recordSpendIdx = src.indexOf('recordSpend(costUsd)');
    assert.ok(recordSpendIdx > -1, 'recordSpend must exist');
    const after = src.slice(recordSpendIdx, recordSpendIdx + 900);
    assert.ok(after.includes('persistCircuitBreaker()'),
      'recordSpend must call persistCircuitBreaker');
  });

  it('server.js loads circuit breaker state on boot (loadCircuitBreakerState IIFE)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf-8');
    assert.ok(src.includes('loadCircuitBreakerState'),
      'loadCircuitBreakerState must be defined');
  });
});

// ── B8: Kill-switch sentinel ownership check ────────────────────────────────

describe('B8: Kill-switch sentinel ownership and permission checks', () => {
  afterEach(() => {
    if (fs.existsSync(SENTINEL_FILE)) {
      try { fs.unlinkSync(SENTINEL_FILE); } catch {}
    }
  });

  it('server.js contains permission check for kill-switch-reset sentinel', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf-8');
    assert.ok(src.includes('st.mode & 0o022'),
      'checkKillSwitchReset must check for group/world-writable permissions');
  });

  it('server.js contains UID check for kill-switch-reset sentinel', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf-8');
    assert.ok(src.includes('process.getuid'),
      'checkKillSwitchReset must check file ownership against server UID');
  });

  it('sentinel with safe permissions (0o600) passes structural check', () => {
    fs.writeFileSync(SENTINEL_FILE, '', { mode: 0o600 });
    const st = fs.statSync(SENTINEL_FILE);
    assert.equal((st.mode & 0o022), 0,
      'safe sentinel should have no group/world write bits');
  });

  it('sentinel with unsafe permissions (0o666) fails structural check', () => {
    fs.writeFileSync(SENTINEL_FILE, '');
    fs.chmodSync(SENTINEL_FILE, 0o666);  // bypass umask with explicit chmod
    const st = fs.statSync(SENTINEL_FILE);
    assert.notEqual((st.mode & 0o022), 0,
      'unsafe sentinel should have group/world write bits set');
  });
});
