/**
 * test/p2-1a-agent-json.test.js — agent.json contract validation (B11)
 *
 * Covers:
 *   - agent.json is valid JSON
 *   - Has required top-level fields
 *   - autonomous-extraction skill exists
 *   - auxilo_contribute tool in MCP tools array
 *   - auxilo_extract tool in MCP tools array
 *   - auxilo_consent tool in MCP tools array
 *   - contributor_agent field in auxilo_contribute input schema
 *   - tool_schemas object exists
 *
 * Runner: node --test test/p2-1a-agent-json.test.js
 */

'use strict';

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

let agent;

before(() => {
  const raw = fs.readFileSync(path.join(__dirname, '..', '.well-known', 'agent.json'), 'utf-8');
  agent = JSON.parse(raw);
});

// ─── Structural validity ────────────────────────────────────────────────────

describe('B11: agent.json validity', () => {
  it('parses as valid JSON', () => {
    assert.ok(agent, 'must parse without error');
    assert.equal(typeof agent, 'object');
  });

  it('has required top-level fields', () => {
    assert.ok(agent.name, 'must have name');
    assert.ok(agent.version, 'must have version');
    assert.ok(agent.url, 'must have url');
    assert.ok(Array.isArray(agent.skills), 'must have skills array');
    assert.ok(agent.mcp, 'must have mcp section');
  });
});

// ─── Skills ─────────────────────────────────────────────────────────────────

describe('B11: agent.json skills', () => {
  it('autonomous-extraction skill exists', () => {
    const skill = agent.skills.find(s => s.id === 'autonomous-extraction');
    assert.ok(skill, 'autonomous-extraction skill must exist');
    assert.ok(skill.description.includes('extract'),
      'description must mention extract/extraction');
  });

  it('autonomous-extraction skill mentions contributor_agent', () => {
    const skill = agent.skills.find(s => s.id === 'autonomous-extraction');
    assert.ok(skill.description.includes('auxilo-autonomous-extractor'),
      'description must mention the contributor agent identifier');
  });

  it('autonomous-extraction skill mentions consent', () => {
    const skill = agent.skills.find(s => s.id === 'autonomous-extraction');
    assert.ok(skill.tags.includes('consent'),
      'tags must include consent');
  });

  it('autonomous-extraction skill mentions retraction window', () => {
    const skill = agent.skills.find(s => s.id === 'autonomous-extraction');
    assert.ok(skill.description.includes('retraction'),
      'description must mention retraction window');
  });
});

// ─── MCP tools ──────────────────────────────────────────────────────────────

describe('B11: MCP tools array', () => {
  it('auxilo_contribute tool exists', () => {
    assert.ok(agent.mcp.tools.includes('auxilo_contribute'),
      'tools must include auxilo_contribute');
  });

  it('auxilo_extract tool exists', () => {
    assert.ok(agent.mcp.tools.includes('auxilo_extract'),
      'tools must include auxilo_extract');
  });

  it('auxilo_consent tool exists', () => {
    assert.ok(agent.mcp.tools.includes('auxilo_consent'),
      'tools must include auxilo_consent');
  });
});

// ─── Tool schemas ───────────────────────────────────────────────────────────

describe('B11: tool_schemas', () => {
  it('tool_schemas object exists', () => {
    assert.ok(agent.mcp.tool_schemas, 'mcp.tool_schemas must exist');
    assert.equal(typeof agent.mcp.tool_schemas, 'object');
  });

  it('auxilo_contribute schema has contributor_agent field', () => {
    const schema = agent.mcp.tool_schemas.auxilo_contribute;
    assert.ok(schema, 'auxilo_contribute schema must exist');
    assert.ok(schema.input_schema.properties.contributor_agent,
      'input_schema must have contributor_agent property');
  });

  it('auxilo_extract schema has required source, transcript, transcript_sha256', () => {
    const schema = agent.mcp.tool_schemas.auxilo_extract;
    assert.ok(schema, 'auxilo_extract schema must exist');
    assert.deepStrictEqual(schema.input_schema.required,
      ['source', 'transcript', 'transcript_sha256']);
  });

  it('auxilo_extract transcript has maxLength', () => {
    const schema = agent.mcp.tool_schemas.auxilo_extract;
    assert.equal(schema.input_schema.properties.transcript.maxLength, 262144,
      'transcript maxLength must be 262144');
  });
});

// ── ITEM 6 (Phase 8): paid endpoints + tool_schemas gaps ────────────────────

describe('ITEM 6: P2.1a paid endpoints', () => {
  it('/extract in paid endpoints array', () => {
    const paid = agent.endpoints.paid;
    const extract = paid.find(e => e.path === '/extract' && e.method === 'POST');
    assert.ok(extract, '/extract POST must be in paid endpoints');
  });

  it('/extract/consent in paid endpoints array', () => {
    const paid = agent.endpoints.paid;
    const consent = paid.find(e => e.path === '/extract/consent' && e.method === 'POST');
    assert.ok(consent, '/extract/consent POST must be in paid endpoints');
  });

  it('DELETE /learn/{id} in paid endpoints array', () => {
    const paid = agent.endpoints.paid;
    const retract = paid.find(e => e.path === '/learn/{id}' && e.method === 'DELETE');
    assert.ok(retract, 'DELETE /learn/{id} must be in paid endpoints');
  });
});

describe('ITEM 6: tool_schemas gaps', () => {
  it('auxilo_consent schema exists with action enum', () => {
    const schema = agent.mcp.tool_schemas.auxilo_consent;
    assert.ok(schema, 'auxilo_consent schema must exist');
    assert.deepStrictEqual(schema.input_schema.required, ['action']);
    assert.deepStrictEqual(schema.input_schema.properties.action.enum, ['grant', 'revoke']);
  });

  it('auxilo_extract schema includes client_scrub_report', () => {
    const schema = agent.mcp.tool_schemas.auxilo_extract;
    assert.ok(schema.input_schema.properties.client_scrub_report,
      'auxilo_extract must include client_scrub_report');
    assert.equal(schema.input_schema.properties.client_scrub_report.type, 'object');
  });
});
