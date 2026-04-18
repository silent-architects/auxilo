/**
 * test/p2-1a-sensitivity-filter-v04.test.js — Server-side scrubber v0.4 patterns
 *
 * Covers:
 *   - SENSITIVITY_FILTER_VERSION is '0.4.0'
 *   - scanText detects PII in fixture transcript
 *   - scanText passes clean fixture transcript
 *   - Email detection works
 *   - Stripe key detection works
 *   - Connection string detection works
 *   - Internal IP detection works
 *   - SSH private key header detection
 *   - JWT detection
 *   - scanText returns { clean, matches, redacted } shape
 *   - PATTERNS array has required pattern names
 *
 * Strategy: Direct module import testing (lib/sensitivity-filter.js exports scanText, scanLearning, PATTERNS)
 *
 * Runner: node --test test/p2-1a-sensitivity-filter-v04.test.js
 */

'use strict';

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  scanText,
  scanLearning,
  SENSITIVITY_FILTER_VERSION,
  PATTERNS,
} = require('../lib/sensitivity-filter');

const FIXTURES = path.join(__dirname, 'fixtures');

describe('Sensitivity filter v0.4: version', () => {
  it('SENSITIVITY_FILTER_VERSION is 0.4.0', () => {
    assert.equal(SENSITIVITY_FILTER_VERSION, '0.4.0');
  });
});

describe('Sensitivity filter v0.4: scanText with fixtures', () => {
  let piiTranscript, cleanTranscript, piiExpected, cleanExpected;

  before(() => {
    piiTranscript = fs.readFileSync(path.join(FIXTURES, 'transcript-with-pii.txt'), 'utf-8');
    cleanTranscript = fs.readFileSync(path.join(FIXTURES, 'transcript-clean.txt'), 'utf-8');
    piiExpected = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'transcript-with-pii.expected.json'), 'utf-8'));
    cleanExpected = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'transcript-clean.expected.json'), 'utf-8'));
  });

  it('detects PII in transcript-with-pii.txt', () => {
    const result = scanText(piiTranscript);
    assert.equal(result.clean, false, 'PII transcript must not be clean');
    assert.ok(result.matches.length > 0, 'must have matches');
  });

  it('matches expected patterns from fixture', () => {
    const result = scanText(piiTranscript);
    const patternNames = result.matches.map(m => m.pattern);
    for (const expected of piiExpected.expected_patterns) {
      assert.ok(patternNames.includes(expected),
        `must detect pattern: ${expected}`);
    }
  });

  it('clean transcript passes cleanly', () => {
    const result = scanText(cleanTranscript);
    assert.equal(result.clean, true, 'clean transcript must be clean');
    assert.equal(result.matches.length, 0, 'must have no matches');
  });
});

describe('Sensitivity filter v0.4: individual pattern tests', () => {
  it('detects email addresses', () => {
    const result = scanText('Contact me at admin@example.com for details');
    assert.equal(result.clean, false);
    assert.ok(result.matches.some(m => m.pattern === 'email_address'));
  });

  it('detects Stripe live keys', () => {
    const result = scanText('Use sk_live_abc123def456ghi789jkl012mno for payments');
    assert.equal(result.clean, false);
    assert.ok(result.matches.some(m => m.pattern === 'stripe_key'));
  });

  it('detects database connection strings', () => {
    const result = scanText('Connect via postgres://user:pass@db.host:5432/mydb');
    assert.equal(result.clean, false);
    assert.ok(result.matches.some(m => m.pattern === 'connection_string'));
  });

  it('detects internal IP addresses', () => {
    const result = scanText('The server is running on 192.168.1.100');
    assert.equal(result.clean, false);
    assert.ok(result.matches.some(m => m.pattern === 'internal_ip'));
  });

  it('detects SSH private key headers', () => {
    const result = scanText('-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAK...');
    assert.equal(result.clean, false);
    assert.ok(result.matches.some(m => m.pattern === 'ssh_private_key'));
  });

  it('detects JWT tokens', () => {
    const result = scanText('Token: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0');
    assert.equal(result.clean, false);
    assert.ok(result.matches.some(m => m.pattern === 'jwt_token'));
  });
});

describe('Sensitivity filter v0.4: return shape', () => {
  it('scanText returns { clean, matches, redacted }', () => {
    const result = scanText('some text');
    assert.ok('clean' in result, 'must have clean');
    assert.ok('matches' in result, 'must have matches');
    assert.ok('redacted' in result, 'must have redacted');
    assert.equal(typeof result.clean, 'boolean');
    assert.ok(Array.isArray(result.matches));
    assert.equal(typeof result.redacted, 'string');
  });

  it('PATTERNS array contains required P2.1a pattern names', () => {
    const names = PATTERNS.map(p => p.name);
    const required = ['email_address', 'stripe_key', 'ssh_private_key', 'jwt_token', 'connection_string'];
    for (const name of required) {
      assert.ok(names.includes(name), `PATTERNS must include: ${name}`);
    }
  });
});
