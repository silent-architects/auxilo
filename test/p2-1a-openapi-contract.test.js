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

// ─── CLEAN-LANE-FLIP Phase B: the three consent routes + /learn 201 stamps ──

describe('CLEAN-LANE-FLIP Phase B: /account/clean-lane* contract', () => {
  it('GET /account/clean-lane exists with the status shape (active flag, current version, min quality, freeze reason)', () => {
    const get = spec.paths['/account/clean-lane'] && spec.paths['/account/clean-lane'].get;
    assert.ok(get, 'GET /account/clean-lane must exist');
    const props = get.responses['200'].content['application/json'].schema.properties;
    for (const k of ['account_id', 'clean_lane_active', 'consent_version_current', 'last_action',
      'min_auto_publish_quality', 'tos_version_at_grant', 'freeze_reason']) {
      assert.ok(props[k], `status response must document ${k}`);
    }
    assert.equal(props.clean_lane_active.type, 'boolean');
    assert.deepEqual(props.last_action.enum, ['grant', 'revoke', 'freeze']);
    assert.equal(props.min_auto_publish_quality.minimum, 14);
    assert.equal(props.min_auto_publish_quality.maximum, 20);
    assert.ok(get.responses['404'], 'the flag-dark 404 must be documented');
    assert.ok(get.responses['403'], 'Gate-A S9: 403 (suspended / scope) must be documented');
    assert.match(get.description, /EXTRACTION_AUTOPUBLISH_CONSENT_ENABLED/);
    assert.match(get.description, /the only advertised enrollment surfaces are the dashboard and the TTY CLI; no MCP tool exists for these routes/);
    assert.doesNotMatch(get.description, /never agent-enrollable/i, 'Gate-A S5: the over-claim is gone');
    assert.match(spec.paths['/account/clean-lane/grant'].post.description, /the only advertised enrollment surfaces are the dashboard and the TTY CLI; no MCP tool exists for these routes/);
    assert.match(get.description, /evidentiary/i);
  });

  it('POST /account/clean-lane/grant requires consent_version + agree + the verbatim affirmation; documents 400/409 codes and the 14-20 threshold (default 16)', () => {
    const post = spec.paths['/account/clean-lane/grant'] && spec.paths['/account/clean-lane/grant'].post;
    assert.ok(post, 'POST /account/clean-lane/grant must exist');
    const schema = post.requestBody.content['application/json'].schema;
    assert.deepEqual(schema.required, ['consent_version', 'agree', 'affirmation']);
    assert.match(schema.properties.affirmation.description, /verbatim|byte-for-byte/i);
    assert.equal(schema.properties.min_auto_publish_quality.minimum, 14);
    assert.equal(schema.properties.min_auto_publish_quality.maximum, 20);
    assert.equal(schema.properties.min_auto_publish_quality.default, 16);
    const codes400 = post.responses['400'].content['application/json'].schema.properties.code.enum;
    assert.deepEqual(codes400, ['AFFIRMATION_REQUIRED', 'AFFIRMATION_TEXT_MISMATCH']);
    const codes409 = post.responses['409'].content['application/json'].schema.properties.code.enum;
    assert.deepEqual(codes409, ['CONSENT_VERSION_MISMATCH']);
    assert.ok(post.responses['404'], 'the flag-dark 404 must be documented');
    // Gate-A F3 (fcf606b): the API must not teach callers the sentence.
    assert.ok(!JSON.stringify(post).includes('I understand and choose auto-publish'),
      'openapi must not carry the affirmation sentence itself');
    // Both auth modes: session (bearer) or API key with contribute scope.
    assert.deepEqual(post.security, [{ bearerAuth: [] }, { apiKeyAuth: [] }]);
    assert.match(post.description, /contribute scope/);
  });

  it('POST /account/clean-lane/revoke exists; 200 returns clean_lane_active:false + revoked_at', () => {
    const post = spec.paths['/account/clean-lane/revoke'] && spec.paths['/account/clean-lane/revoke'].post;
    assert.ok(post, 'POST /account/clean-lane/revoke must exist');
    const props = post.responses['200'].content['application/json'].schema.properties;
    assert.deepEqual(props.clean_lane_active.enum, [false]);
    assert.ok(props.revoked_at);
    assert.ok(post.responses['404'], 'the flag-dark 404 must be documented');
    assert.ok(post.responses['403'], 'Gate-A S9: 403 (suspended / scope) must be documented');
    assert.ok(spec.paths['/account/settings'].patch.responses['403'],
      'Gate-A S9: PATCH /account/settings documents 403 (suspended / scope) — the ack cursor writer');
  });

  it('POST /learn 201 documents the standing-consent stamps (WAVE-0905-RESIDUALS 4)', () => {
    const props = spec.paths['/learn'].post.responses['201'].content['application/json'].schema.properties;
    assert.deepEqual(props.published_via.enum, ['clean_lane_standing_consent']);
    assert.ok(props.standing_consent_version);
    assert.equal(props.retractable_until.format, 'date-time');
    assert.ok(props.standing_consent_notice);
  });
});

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
