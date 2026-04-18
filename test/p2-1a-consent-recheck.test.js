/**
 * test/p2-1a-consent-recheck.test.js — §3.5.4 pre-publish consent recheck
 *
 * Covers:
 *   - server.js performs consent recheck after LLM call (Step 15)
 *   - Recheck uses forceReload: true
 *   - Recheck occurs before catalog mutation
 *   - auditConsentVersion comes from the recheck, not initial check
 *
 * Strategy: Structural source-code analysis (reads server.js, checks patterns)
 *
 * Runner: node --test test/p2-1a-consent-recheck.test.js
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SERVER_SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf-8');

describe('§3.5.4: Pre-publish consent recheck', () => {
  it('Step 15 exists in /extract handler', () => {
    assert.ok(SERVER_SRC.includes('Step 15'),
      'Step 15 must exist in server.js');
  });

  it('Step 15 uses getConsentState with forceReload: true', () => {
    const step15Idx = SERVER_SRC.indexOf('Step 15');
    assert.ok(step15Idx > -1, 'Step 15 must exist');
    const block = SERVER_SRC.slice(step15Idx, step15Idx + 500);
    assert.ok(block.includes('forceReload: true') || block.includes('forceReload:true'),
      'consent recheck must use forceReload: true');
  });

  it('Recheck occurs after LLM call (Step 9) and before publish (Step 16)', () => {
    const step9Idx = SERVER_SRC.indexOf('Step 9: Provider call');
    const step15Idx = SERVER_SRC.indexOf('Step 15');
    const step16Idx = SERVER_SRC.indexOf('Step 16: Mode branch');
    assert.ok(step9Idx > -1, 'Step 9 must exist');
    assert.ok(step15Idx > -1, 'Step 15 must exist');
    assert.ok(step16Idx > -1, 'Step 16 must exist');
    assert.ok(step9Idx < step15Idx, 'Step 15 must come after Step 9');
    assert.ok(step15Idx < step16Idx, 'Step 15 must come before Step 16');
  });

  it('auditConsentVersion captures fresh consent version', () => {
    // auditConsentVersion is an IIFE at Step 17 that does a fresh getConsentState
    assert.ok(SERVER_SRC.includes('auditConsentVersion'),
      'auditConsentVersion must exist in server.js');
    const aIdx = SERVER_SRC.indexOf('auditConsentVersion');
    const block = SERVER_SRC.slice(aIdx, aIdx + 200);
    assert.ok(block.includes('forceReload: true'),
      'auditConsentVersion must use forceReload: true for fresh state');
  });

  it('audit row uses auditConsentVersion from recheck (not initial check)', () => {
    const step17Idx = SERVER_SRC.indexOf('Step 17: Audit log');
    assert.ok(step17Idx > -1, 'Step 17 must exist');
    const block = SERVER_SRC.slice(step17Idx, step17Idx + 1200);
    assert.ok(block.includes('consent_version: auditConsentVersion'),
      'audit row must use auditConsentVersion from recheck');
  });

  it('revoked consent during extraction marks as revoked_in_flight', () => {
    const step15Idx = SERVER_SRC.indexOf('Step 15');
    const block = SERVER_SRC.slice(step15Idx, step15Idx + 500);
    assert.ok(block.includes('revoked_in_flight'),
      'revoked consent during extraction must push revoked_in_flight rejection');
  });
});
