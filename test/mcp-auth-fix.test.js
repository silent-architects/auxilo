'use strict';

/**
 * test/mcp-auth-fix.test.js
 *
 * UX-N2 fix: auxilo_link_wallet and auxilo_account_earnings must be callable by
 * an MCP-only agent using the configured API key — i.e. when NO session_token is
 * passed, no bogus "Authorization: Bearer undefined" header may be emitted, and
 * the configured API key (via baseHeaders) must be the credential that travels.
 *
 * Runner: node --test test/mcp-auth-fix.test.js
 *
 * Strategy:
 *   - baseHeaders() is the pure header-builder both handlers use. The fix routes
 *     auth through the SAME conditional idiom as auxilo_accept_terms:
 *       baseHeaders(session_token ? { Authorization: `Bearer ${token}` } : {})
 *   - We exercise the real exported baseHeaders() plus that idiom directly, so we
 *     assert the actual header contract without starting the stdio transport.
 *   - credentials are loaded once at module import from ~/.auxilo/credentials.json;
 *     the API-key assertion is guarded so the suite is deterministic on machines
 *     with or without a credentials file.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { baseHeaders } = require('../mcp-server.js');

// Mirror the exact idiom the fixed handlers use to select auth headers.
function authHeaders(session_token) {
  return baseHeaders(session_token ? { Authorization: `Bearer ${session_token}` } : {});
}

test('no session_token: never emits an Authorization header (no "Bearer undefined")', () => {
  const h = authHeaders(undefined);
  assert.equal('Authorization' in h, false, 'Authorization must be absent when no token is supplied');
  // Belt-and-suspenders: the broken pre-fix behavior produced this literal string.
  assert.notEqual(h.Authorization, 'Bearer undefined');
});

test('with session_token: emits exactly the Bearer Authorization header', () => {
  const h = authHeaders('jwt-abc.def.ghi');
  assert.equal(h.Authorization, 'Bearer jwt-abc.def.ghi');
});

test('baseHeaders always sets JSON content type', () => {
  assert.equal(baseHeaders()['Content-Type'], 'application/json');
});

test('API-key branch: when a key is configured it travels as X-API-Key alongside no Authorization', () => {
  const h = baseHeaders(); // no session_token -> API-key-only auth path
  if (!('X-API-Key' in h)) {
    // No credentials.json on this machine — nothing to assert about the key value.
    // The critical no-"Bearer undefined" invariant is covered by the test above.
    return;
  }
  assert.equal(typeof h['X-API-Key'], 'string');
  assert.ok(h['X-API-Key'].length > 0, 'configured API key must be non-empty');
  assert.equal('Authorization' in h, false, 'API-key auth must not carry an Authorization header');
});
