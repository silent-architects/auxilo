/**
 * test/p2-1a-consent.test.js — Consent grant/revoke, forceReload semantics
 *
 * Covers:
 *   - getConsentState returns null for unknown account
 *   - appendConsent writes grant, getConsentState reads it back
 *   - appendConsent revoke after grant → getConsentState returns revoke
 *   - hasActiveConsent returns true for grant, false for revoke/null
 *   - forceReload: true re-reads from disk (cache bypass)
 *   - Cache persists on normal reads (no forceReload)
 *   - Consent file is append-only JSONL
 *
 * Runner: node --test test/p2-1a-consent.test.js
 */

'use strict';

const { describe, it, before, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

// We test the module by manipulating its data file in a temp dir.
// We need to use a fresh require for each test group to reset the cache.

const CONSENT_FILE_ORIGINAL = path.join(__dirname, '..', 'data', 'extraction-consent.jsonl');

describe('Consent: getConsentState + appendConsent', () => {
  let backupContent = null;

  before(() => {
    // Back up real consent file if it exists
    if (fs.existsSync(CONSENT_FILE_ORIGINAL)) {
      backupContent = fs.readFileSync(CONSENT_FILE_ORIGINAL, 'utf-8');
    }
  });

  afterEach(() => {
    // Restore original
    if (backupContent !== null) {
      fs.writeFileSync(CONSENT_FILE_ORIGINAL, backupContent, 'utf-8');
    } else if (fs.existsSync(CONSENT_FILE_ORIGINAL)) {
      fs.unlinkSync(CONSENT_FILE_ORIGINAL);
    }
    // Force module to re-read by clearing the cache
    delete require.cache[require.resolve('../lib/extraction-consent-reader')];
  });

  it('getConsentState returns null for unknown account', () => {
    const { getConsentState } = require('../lib/extraction-consent-reader');
    const state = getConsentState('acc_nonexistent_12345', { forceReload: true });
    assert.equal(state, null);
  });

  it('appendConsent writes grant, getConsentState reads it back', () => {
    const { appendConsent, getConsentState } = require('../lib/extraction-consent-reader');
    const testAccount = `acc_test_grant_${Date.now()}`;

    appendConsent({
      accountId: testAccount,
      action: 'grant',
      consentVersion: '2026-04-15',
    });

    const state = getConsentState(testAccount, { forceReload: true });
    assert.ok(state, 'state must exist after grant');
    assert.equal(state.action, 'grant');
    assert.equal(state.consent_version, '2026-04-15');
    assert.equal(state.account_id, testAccount);
  });

  it('revoke after grant → getConsentState returns revoke', () => {
    const { appendConsent, getConsentState } = require('../lib/extraction-consent-reader');
    const testAccount = `acc_test_revoke_${Date.now()}`;

    appendConsent({ accountId: testAccount, action: 'grant', consentVersion: '2026-04-15' });
    appendConsent({ accountId: testAccount, action: 'revoke', consentVersion: '2026-04-16' });

    const state = getConsentState(testAccount, { forceReload: true });
    assert.equal(state.action, 'revoke');
  });

  it('hasActiveConsent true for grant, false for revoke', () => {
    const { appendConsent, hasActiveConsent } = require('../lib/extraction-consent-reader');
    const testAccount = `acc_test_active_${Date.now()}`;

    appendConsent({ accountId: testAccount, action: 'grant', consentVersion: '2026-04-15' });
    assert.equal(hasActiveConsent(testAccount, { forceReload: true }), true);

    appendConsent({ accountId: testAccount, action: 'revoke', consentVersion: '2026-04-16' });
    assert.equal(hasActiveConsent(testAccount, { forceReload: true }), false);
  });

  it('hasActiveConsent false for unknown account', () => {
    const { hasActiveConsent } = require('../lib/extraction-consent-reader');
    assert.equal(hasActiveConsent('acc_does_not_exist', { forceReload: true }), false);
  });

  it('forceReload bypasses cache', () => {
    const { appendConsent, getConsentState } = require('../lib/extraction-consent-reader');
    const testAccount = `acc_test_reload_${Date.now()}`;

    appendConsent({ accountId: testAccount, action: 'grant', consentVersion: '2026-04-15' });
    getConsentState(testAccount); // cache loaded

    // Append directly to file (bypassing appendConsent to avoid cache invalidation)
    const directRow = JSON.stringify({
      account_id: testAccount,
      action: 'revoke',
      consent_version: '2026-04-16',
      timestamp: new Date().toISOString(),
    });
    fs.appendFileSync(CONSENT_FILE_ORIGINAL, directRow + '\n', 'utf-8');

    // Without forceReload, cache shows stale data
    const stale = getConsentState(testAccount);
    assert.equal(stale.action, 'grant', 'cached value must be stale');

    // With forceReload, gets fresh data
    const fresh = getConsentState(testAccount, { forceReload: true });
    assert.equal(fresh.action, 'revoke', 'forceReload must see revoke');
  });

  it('consent file is JSONL (one JSON per line)', () => {
    const { appendConsent } = require('../lib/extraction-consent-reader');
    const testAccount = `acc_test_jsonl_${Date.now()}`;

    appendConsent({ accountId: testAccount, action: 'grant', consentVersion: '2026-04-15' });
    appendConsent({ accountId: testAccount, action: 'revoke', consentVersion: '2026-04-16' });

    const raw = fs.readFileSync(CONSENT_FILE_ORIGINAL, 'utf-8');
    const lines = raw.split('\n').filter(l => l.trim());
    const accountLines = lines.filter(l => l.includes(testAccount));
    assert.ok(accountLines.length >= 2, 'must have at least 2 lines for this account');
    // Each line must be valid JSON
    for (const line of accountLines) {
      assert.doesNotThrow(() => JSON.parse(line), 'each line must be valid JSON');
    }
  });
});
