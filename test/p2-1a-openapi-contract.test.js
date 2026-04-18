/**
 * test/p2-1a-openapi-contract.test.js — openapi.json ↔ wire format validation (B10)
 *
 * Covers:
 *   - /extract endpoint exists with POST method
 *   - /extract response schema includes consent_version
 *   - /extract response schema includes usage object (input_tokens, output_tokens)
 *   - /extract response schema includes contributor_agent
 *   - /extract response schema includes audit_ref
 *   - /extract request transcript has maxLength: 262144
 *   - /extract 503 response (circuit breaker)
 *   - DELETE /learn/{id} endpoint exists with audit_ref in response
 *   - /extract/consent endpoint exists with POST
 *   - No /extract/review paths exist
 *   - Valid JSON (parseable)
 *   - No 'scheduled' in autonomous_extraction_mode enum (A6 crosscheck)
 *
 * Runner: node --test test/p2-1a-openapi-contract.test.js
 */

'use strict';

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

let spec;

before(() => {
  const raw = fs.readFileSync(path.join(__dirname, '..', 'openapi.json'), 'utf-8');
  spec = JSON.parse(raw);
});

// ─── Structural validity ────────────────────────────────────────────────────

describe('B10: openapi.json validity', () => {
  it('parses as valid JSON', () => {
    assert.ok(spec, 'must parse without error');
    assert.equal(typeof spec, 'object');
  });

  it('has openapi version field', () => {
    assert.ok(spec.openapi, 'must have openapi version');
  });

  it('has paths object', () => {
    assert.ok(spec.paths, 'must have paths');
    assert.equal(typeof spec.paths, 'object');
  });
});

// ─── /extract endpoint ─────────────────────────────────────────────────────

describe('B10: /extract endpoint contract', () => {
  it('/extract exists with POST method', () => {
    assert.ok(spec.paths['/extract'], '/extract path must exist');
    assert.ok(spec.paths['/extract'].post, '/extract must have post method');
  });

  it('response schema includes consent_version', () => {
    const props = spec.paths['/extract'].post.responses['200']
      .content['application/json'].schema.properties;
    assert.ok(props.consent_version, 'must have consent_version in 200 response');
    assert.equal(props.consent_version.type, 'string');
  });

  it('response schema includes usage object with input_tokens and output_tokens', () => {
    const props = spec.paths['/extract'].post.responses['200']
      .content['application/json'].schema.properties;
    assert.ok(props.usage, 'must have usage in 200 response');
    assert.equal(props.usage.type, 'object');
    assert.ok(props.usage.properties.input_tokens, 'usage must have input_tokens');
    assert.ok(props.usage.properties.output_tokens, 'usage must have output_tokens');
  });

  it('response schema includes contributor_agent', () => {
    const props = spec.paths['/extract'].post.responses['200']
      .content['application/json'].schema.properties;
    assert.ok(props.contributor_agent, 'must have contributor_agent');
    assert.equal(props.contributor_agent.type, 'string');
  });

  it('response schema includes audit_ref', () => {
    const props = spec.paths['/extract'].post.responses['200']
      .content['application/json'].schema.properties;
    assert.ok(props.audit_ref, 'must have audit_ref');
    assert.equal(props.audit_ref.type, 'string');
  });

  it('request transcript has maxLength: 262144', () => {
    const transcriptProp = spec.paths['/extract'].post.requestBody
      .content['application/json'].schema.properties.transcript;
    assert.equal(transcriptProp.maxLength, 262144,
      'transcript maxLength must be 262144 (256KB)');
  });

  it('503 response documents circuit breaker', () => {
    const responses = spec.paths['/extract'].post.responses;
    assert.ok(responses['503'], '/extract must document 503 response');
    assert.ok(responses['503'].description.toLowerCase().includes('circuit breaker'),
      '503 description must mention circuit breaker');
  });

  it('413 response documents body limit', () => {
    const responses = spec.paths['/extract'].post.responses;
    assert.ok(responses['413'], '/extract must document 413 response');
  });
});

// ─── DELETE /learn/{id} ─────────────────────────────────────────────────────

describe('B10: DELETE /learn/{id} retraction contract', () => {
  it('/learn/{id} exists with delete method', () => {
    assert.ok(spec.paths['/learn/{id}'], '/learn/{id} path must exist');
    assert.ok(spec.paths['/learn/{id}'].delete, '/learn/{id} must have delete method');
  });

  it('response includes audit_ref', () => {
    const props = spec.paths['/learn/{id}'].delete.responses['200']
      .content['application/json'].schema.properties;
    assert.ok(props.audit_ref, 'retract 200 response must have audit_ref');
    assert.equal(props.audit_ref.type, 'string');
  });

  it('409 response documents expired retraction window', () => {
    const responses = spec.paths['/learn/{id}'].delete.responses;
    assert.ok(responses['409'], 'must document 409 for expired window');
  });
});

// ─── /extract/consent ───────────────────────────────────────────────────────

describe('B10: /extract/consent endpoint', () => {
  it('/extract/consent exists with POST method', () => {
    assert.ok(spec.paths['/extract/consent'], '/extract/consent path must exist');
    assert.ok(spec.paths['/extract/consent'].post, 'must have post method');
  });

  it('request schema requires action field', () => {
    const schema = spec.paths['/extract/consent'].post.requestBody
      .content['application/json'].schema;
    assert.ok(schema.required.includes('action'), 'action must be required');
  });

  it('action enum is [grant, revoke]', () => {
    const actionProp = spec.paths['/extract/consent'].post.requestBody
      .content['application/json'].schema.properties.action;
    assert.deepStrictEqual(actionProp.enum, ['grant', 'revoke']);
  });

  it('response includes consent_version', () => {
    const props = spec.paths['/extract/consent'].post.responses['200']
      .content['application/json'].schema.properties;
    assert.ok(props.consent_version, 'must have consent_version');
  });
});

// ─── No stale /extract/review paths ─────────────────────────────────────────

describe('B10: No stale /extract/review paths (A6 crosscheck)', () => {
  it('no /extract/review paths exist', () => {
    const reviewPaths = Object.keys(spec.paths).filter(p =>
      p.startsWith('/extract/review')
    );
    assert.equal(reviewPaths.length, 0,
      'no /extract/review/* paths should exist — A6 Option B');
  });

  it('autonomous_extraction_mode enum does not include scheduled', () => {
    const settingsSchema = spec.paths['/account/settings'].patch.requestBody
      .content['application/json'].schema.properties.autonomous_extraction_mode;
    assert.ok(!settingsSchema.enum.includes('scheduled'),
      'enum must not include scheduled — A6 Option B');
  });
});
