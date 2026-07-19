/**
 * test/p2-1a-agent-json.test.js — agent.json contract validation (B11)
 *
 * Covers:
 *   - agent.json is valid JSON
 *   - Has required top-level fields
 *   - autonomous-extraction skill exists
 *   - auxilo_contribute tool in MCP tools array
 *   - mcp.tools exactly matches the registry in mcp-server.js (17 tools)
 *   - extraction is NOT advertised as an MCP tool (it is the REST pair
 *     POST /extract + POST /extract/consent, listed in endpoints.paid);
 *     site-revision corrected the earlier drift that listed auxilo_extract
 *     and auxilo_consent in mcp.tools with schemas
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

  it('mcp.tools exactly matches the mcp-server.js registry', () => {
    // Source of truth: the ListToolsRequestSchema handler in mcp-server.js.
    // Same extraction logic as scripts/check-surface-drift.sh.
    const src = fs.readFileSync(path.join(__dirname, '..', 'mcp-server.js'), 'utf-8');
    const start = src.indexOf('server.setRequestHandler(ListToolsRequestSchema');
    const end = src.indexOf('server.setRequestHandler(CallToolRequestSchema');
    assert.ok(start !== -1 && end > start, 'must find the ListTools handler block');
    const block = src.slice(start, end);
    const canonical = [...block.matchAll(/name: '([a-z_]+)'/g)].map(m => m[1]).sort();
    const advertised = [...agent.mcp.tools].sort();
    assert.deepStrictEqual(advertised, canonical,
      'agent.json mcp.tools must exactly match the registered tool set');
  });

  it('extraction is NOT advertised as an MCP tool', () => {
    assert.ok(!agent.mcp.tools.includes('auxilo_extract'),
      'auxilo_extract is not a registered MCP tool; extraction is the REST pair');
    assert.ok(!agent.mcp.tools.includes('auxilo_consent'),
      'auxilo_consent is not a registered MCP tool; consent is POST /extract/consent');
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

  it('tool_schemas carries no schema for a tool outside the registry', () => {
    assert.ok(!agent.mcp.tool_schemas.auxilo_extract,
      'no schema may be advertised for the unregistered auxilo_extract');
    assert.ok(!agent.mcp.tool_schemas.auxilo_consent,
      'no schema may be advertised for the unregistered auxilo_consent');
    for (const name of Object.keys(agent.mcp.tool_schemas)) {
      assert.ok(agent.mcp.tools.includes(name),
        `tool_schemas.${name} must correspond to an advertised tool`);
    }
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

describe('ITEM 6: extraction surface routing', () => {
  it('extraction flow is documented as REST, not as MCP tool schemas', () => {
    // The consent + extract flow lives in endpoints.paid (asserted above).
    // The mcp section must route readers there instead of advertising
    // tool schemas for unregistered tools.
    assert.ok(agent.mcp.note && agent.mcp.note.includes('/extract'),
      'mcp.note must point extraction readers at the REST pair');
  });
});
