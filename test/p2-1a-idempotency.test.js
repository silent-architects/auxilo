/**
 * test/p2-1a-idempotency.test.js — Per-account idempotency key behavior
 *
 * Covers:
 *   - checkIdempotency function exists in server.js
 *   - Idempotency-Key header is required
 *   - Layer 1: client-supplied key match returns cached response
 *   - Layer 2: session+transcript dedup (structural check)
 *   - Idempotency TTL is configurable (extractionConfig.idempotency_ttl_hours)
 *   - recordExtraction stores key+session+sha256+response
 *
 * Strategy: Structural source-code analysis
 *
 * Runner: node --test test/p2-1a-idempotency.test.js
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SERVER_SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf-8');

describe('Idempotency: checkIdempotency + recordExtraction', () => {
  it('checkIdempotency function exists', () => {
    assert.ok(SERVER_SRC.includes('function checkIdempotency('),
      'checkIdempotency function must exist');
  });

  it('recordExtraction function exists', () => {
    assert.ok(SERVER_SRC.includes('function recordExtraction('),
      'recordExtraction function must exist');
  });

  it('Idempotency-Key header is required in /extract handler', () => {
    // Find the pattern where missing key returns 400
    assert.ok(SERVER_SRC.includes("Idempotency-Key header is required"),
      'must return error when Idempotency-Key is missing');
  });

  it('Layer 1: client-supplied Idempotency-Key match returns cached response', () => {
    const fnIdx = SERVER_SRC.indexOf('function checkIdempotency');
    const fnBody = SERVER_SRC.slice(fnIdx, fnIdx + 900);
    assert.ok(fnBody.includes('idempotency_key') && fnBody.includes('response_cache'),
      'checkIdempotency must check idempotency_key and return response_cache');
  });

  it('Layer 2: session_id + transcript_sha256 dedup', () => {
    const fnIdx = SERVER_SRC.indexOf('function checkIdempotency');
    const fnBody = SERVER_SRC.slice(fnIdx, fnIdx + 900);
    assert.ok(fnBody.includes('session_id') && fnBody.includes('transcript_sha256'),
      'checkIdempotency must check session_id and transcript_sha256');
  });

  it('TTL is configurable via extractionConfig.idempotency_ttl_hours', () => {
    const fnIdx = SERVER_SRC.indexOf('function checkIdempotency');
    const fnBody = SERVER_SRC.slice(fnIdx, fnIdx + 600);
    assert.ok(fnBody.includes('idempotency_ttl_hours'),
      'must reference idempotency_ttl_hours for TTL window');
  });

  it('recordExtraction stores key, session, sha256, response', () => {
    const fnIdx = SERVER_SRC.indexOf('function recordExtraction');
    const fnBody = SERVER_SRC.slice(fnIdx, fnIdx + 400);
    assert.ok(fnBody.includes('idempotency_key') || fnBody.includes('idempotencyKey'),
      'recordExtraction must store idempotency key');
    assert.ok(fnBody.includes('response'),
      'recordExtraction must store response');
  });

  it('/extract handler calls checkIdempotency before processing', () => {
    const handler = extractHandlerSrc();
    assert.ok(handler.includes('checkIdempotency'),
      '/extract handler must call checkIdempotency');
  });

  it('/extract handler calls recordExtraction after processing', () => {
    const handler = extractHandlerSrc();
    assert.ok(handler.includes('recordExtraction'),
      '/extract handler must call recordExtraction');
  });
});

/**
 * Extract the FULL /extract handler source: from app.post('/extract' to the
 * next top-level route registration. Fixed-width windows (previously
 * 6000/18000 chars) broke when PR #5's client-side-extraction restructure
 * grew the handler past the window — this is length-independent.
 */
function extractHandlerSrc() {
  const start = SERVER_SRC.indexOf("app.post('/extract'");
  assert.ok(start > -1, '/extract handler must exist');
  const next = SERVER_SRC.indexOf('\napp.', start + 1);
  return next === -1 ? SERVER_SRC.slice(start) : SERVER_SRC.slice(start, next);
}
