/**
 * test/p2-1a-extract-handler.test.js — /extract handler structural tests
 *
 * Covers: A4 (body cap), B4 (usage tokens), B9 (contributor_agent), B20 (patterns_matched)
 * Phase 5 additions: A6 scheduled-rejection assertions
 *
 * Strategy: Structural source-code analysis tests that verify the server.js
 * implementation matches the spec. These read server.js source and check
 * for the required patterns. Integration tests against a running server
 * belong in the E2E suite.
 *
 * Runner: node --test test/p2-1a-extract-handler.test.js
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SERVER_SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf-8');

// ── A4: 256KB body cap reachable for /extract ───────────────────────────────

describe('A4: /extract gets 256KB body cap', () => {
  it('global middleware uses path-aware cap for /extract', () => {
    assert.ok(
      SERVER_SRC.includes("c.req.path === '/extract' ? 262144 : MAX_BODY_SIZE"),
      'Global body middleware must route /extract to 262144 (256KB) cap'
    );
  });

  it('MAX_BODY_SIZE remains 100KB for non-extract routes', () => {
    assert.ok(
      SERVER_SRC.includes('100 * 1024') || SERVER_SRC.includes('102400'),
      'MAX_BODY_SIZE must be 100KB for normal routes'
    );
  });

  it('error response includes max_bytes for path-aware cap', () => {
    // Find the global middleware error response
    const capIdx = SERVER_SRC.indexOf("let cap = c.req.path === '/extract'");
    assert.ok(capIdx > -1, 'cap variable must exist');
    const after = SERVER_SRC.slice(capIdx, capIdx + 500);
    assert.ok(after.includes('max_bytes: cap'),
      'error response must include max_bytes referencing the cap variable');
  });
});

// ── B4: Audit row usage tokens accumulated from provider ────────────────────

describe('B4: Real usage tokens in audit row', () => {
  it('totalInputTokens accumulator exists in /extract handler', () => {
    // Search in the /extract handler scope (after Step 9)
    const step9Idx = SERVER_SRC.indexOf('Step 9: Provider call');
    assert.ok(step9Idx > -1, 'Step 9 must exist');
    const handlerScope = SERVER_SRC.slice(step9Idx, step9Idx + 2000);
    assert.ok(handlerScope.includes('let totalInputTokens = 0'),
      'handler must declare totalInputTokens accumulator');
  });

  it('totalOutputTokens accumulator exists in /extract handler', () => {
    const step9Idx = SERVER_SRC.indexOf('Step 9: Provider call');
    const handlerScope = SERVER_SRC.slice(step9Idx, step9Idx + 2000);
    assert.ok(handlerScope.includes('let totalOutputTokens = 0'),
      'handler must declare totalOutputTokens accumulator');
  });

  it('llmCall closure accumulates tokens from provider result', () => {
    // Find llmCall WITHIN the /extract handler (after Step 9, not the older one)
    const step9Idx = SERVER_SRC.indexOf('Step 9: Provider call');
    const handlerScope = SERVER_SRC.slice(step9Idx, step9Idx + 2000);
    assert.ok(handlerScope.includes('totalInputTokens += result.usage.input_tokens'),
      'llmCall must accumulate input tokens');
    assert.ok(handlerScope.includes('totalOutputTokens += result.usage.output_tokens'),
      'llmCall must accumulate output tokens');
  });

  it('audit row uses accumulated tokens (not hardcoded zeros)', () => {
    const auditIdx = SERVER_SRC.indexOf('Step 17: Audit log');
    assert.ok(auditIdx > -1, 'Step 17 audit log must exist');
    const auditBlock = SERVER_SRC.slice(auditIdx, auditIdx + 2500);
    assert.ok(auditBlock.includes('input_tokens: totalInputTokens'),
      'audit row must use totalInputTokens');
    assert.ok(auditBlock.includes('output_tokens: totalOutputTokens'),
      'audit row must use totalOutputTokens');
  });

  it('cost_usd is computed (not hardcoded zero)', () => {
    const auditIdx = SERVER_SRC.indexOf('Step 17: Audit log');
    const auditBlock = SERVER_SRC.slice(auditIdx, auditIdx + 2500);
    assert.ok(auditBlock.includes('cost_usd: totalCostUsd'),
      'audit row cost_usd must use totalCostUsd accumulator');
  });
});

// ── B9: contributor_agent string ────────────────────────────────────────────

describe('B9: contributor_agent identifier', () => {
  it('stamps auxilo-autonomous-extractor/0.1.0', () => {
    assert.ok(
      SERVER_SRC.includes("candidate.contributor_agent = 'auxilo-autonomous-extractor/0.1.0'"),
      'contributor_agent must be exactly auxilo-autonomous-extractor/0.1.0'
    );
  });

  it('no longer uses old auxilo-extract/* pattern', () => {
    // Search specifically for the old contributor_agent = pattern
    const oldPattern = /contributor_agent\s*=\s*`auxilo-extract\//;
    assert.ok(!oldPattern.test(SERVER_SRC),
      'old auxilo-extract/* contributor_agent pattern must not exist');
  });
});

// ── B20: patterns_matched validation ────────────────────────────────────────

describe('B20: patterns_matched input validation', () => {
  it('validates patterns_matched is array of strings', () => {
    assert.ok(
      SERVER_SRC.includes("Array.isArray(client_scrub_report?.patterns_matched)"),
      'must check patterns_matched is an array'
    );
  });

  it('filters invalid patterns (non-string, too long, invalid chars)', () => {
    assert.ok(
      SERVER_SRC.includes("typeof p === 'string' && p.length <= 64 && /^[a-z_]+$/.test(p)"),
      'must validate each pattern is string, <= 64 chars, lowercase+underscore'
    );
  });

  it('caps at 50 patterns', () => {
    assert.ok(
      SERVER_SRC.includes('.slice(0, 50)'),
      'must cap patterns_matched at 50 entries'
    );
  });

  it('audit row uses validatedPatterns (not raw client input)', () => {
    const auditIdx = SERVER_SRC.indexOf('Step 17: Audit log');
    const auditBlock = SERVER_SRC.slice(auditIdx, auditIdx + 1500);
    assert.ok(auditBlock.includes('client_scrub_matches: validatedPatterns'),
      'audit row must use validatedPatterns, not raw client_scrub_report');
  });
});

// ── B1: consent_version in audit rows (structural checks in server.js) ──────

describe('B1: consent_version audit row structural checks', () => {
  it('publish audit row uses fresh consent recheck (auditConsentVersion)', () => {
    const auditIdx = SERVER_SRC.indexOf('Step 17: Audit log');
    const auditBlock = SERVER_SRC.slice(auditIdx, auditIdx + 1200);
    assert.ok(auditBlock.includes('consent_version: auditConsentVersion'),
      'publish audit row must use auditConsentVersion from fresh recheck');
  });

  it("retraction audit row null-guards consent and records 'none' — never a fabricated stamp, never || null (B4-1)", () => {
    // Wave 2b (SPEC3 B4-1) superseded the CORRECTION-1 pin: the unguarded
    // `getConsentState(accountId).consent_version` deref threw for every
    // never-consented account (getConsentState returns null when no consent
    // record exists — i.e. most direct /learn + MCP contributors), 500ing the
    // retraction path. The new contract keeps CORRECTION-1's spirit — no
    // silent null masking (`|| null` would just re-trip the audit writer's
    // truthiness assertion) — while recording the truthful literal 'none' for
    // never-consented retractors.
    const retractIdx = SERVER_SRC.indexOf("action: 'retract'");
    assert.ok(retractIdx > -1, 'retraction audit row must exist');
    const retractBlock = SERVER_SRC.slice(retractIdx - 600, retractIdx + 200);
    const consentLine = retractBlock.split('\n').find(l => l.includes('consent_version:'));
    assert.ok(consentLine, 'must find consent_version line near retract');
    assert.ok(consentLine.includes("retractConsent ? retractConsent.consent_version : 'none'"),
      "guarded read with the explicit 'none' fallback (B4-1)");
    assert.ok(!consentLine.includes('|| null'),
      'no || null masking (CORRECTION 1 spirit preserved)');
    assert.ok(SERVER_SRC.includes('const retractConsent = getConsentState(accountId);'),
      'the consent state is read once, guarded');
  });
});

// ── A6: Scheduled mode removed ──────────────────────────────────────────────

describe('A6: validModes does not include scheduled', () => {
  it('server.js validModes contains only off, automatic, manual', () => {
    const modesLine = SERVER_SRC.split('\n').find(l => l.includes('const validModes'));
    assert.ok(modesLine, 'validModes declaration must exist');
    assert.ok(modesLine.includes("'off'"), 'must include off');
    assert.ok(modesLine.includes("'automatic'"), 'must include automatic');
    assert.ok(modesLine.includes("'manual'"), 'must include manual');
    // Extract just the array portion (before any comment) to avoid matching
    // the A6 audit trail comment that mentions 'scheduled'
    const arrayPortion = modesLine.split('//')[0];
    assert.ok(!arrayPortion.includes("'scheduled'"),
      "validModes array must NOT include 'scheduled' — A6 Option B");
  });

  it('openapi.json enum does not include scheduled', () => {
    const openapi = fs.readFileSync(path.join(__dirname, '..', 'openapi.json'), 'utf-8');
    // Find the autonomous_extraction_mode enum
    const modeIdx = openapi.indexOf('"autonomous_extraction_mode"');
    assert.ok(modeIdx > -1, 'autonomous_extraction_mode must exist in openapi.json');
    const enumBlock = openapi.slice(modeIdx, modeIdx + 300);
    assert.ok(!enumBlock.includes('"scheduled"'),
      'openapi.json enum must NOT include "scheduled" — A6 Option B');
  });

  it('no scheduled-mode setInterval/setTimeout scheduling in server.js', () => {
    // Verify server.js has no extraction-scheduling setInterval
    // (legitimate setIntervals: cache cleanup, rate limiter cleanup, OFAC refresh, pricing cron, etc.)
    // None should relate to extraction scheduling
    const intervals = SERVER_SRC.split('\n').filter(l =>
      l.includes('setInterval') && (l.includes('extract') || l.includes('autonomous'))
    );
    assert.equal(intervals.length, 0,
      'no setInterval should reference extraction or autonomous scheduling');
  });

  it('A6 Option B comment is present in validModes declaration', () => {
    const modesLine = SERVER_SRC.split('\n').find(l => l.includes('const validModes'));
    assert.ok(modesLine.includes('A6 Option B'),
      'validModes line must have A6 Option B comment for audit trail');
  });
});

// ── ITEM 1 (Phase 8): audit-before-mutate on publish path ───────────────────

describe('ITEM 1: publish path audit-before-mutate', () => {
  it('appendAuditRow occurs BEFORE safeWrite(LEARNINGS_FILE) in /extract handler', () => {
    // Find the /extract handler
    const handlerIdx = SERVER_SRC.indexOf("app.post('/extract'");
    assert.ok(handlerIdx > -1, '/extract handler must exist');
    const handler = SERVER_SRC.slice(handlerIdx, handlerIdx + 24000);

    const auditIdx = handler.indexOf('appendAuditRow');
    const safeWriteIdx = handler.indexOf('safeWrite(LEARNINGS_FILE');
    assert.ok(auditIdx > -1, 'appendAuditRow must exist in handler');
    assert.ok(safeWriteIdx > -1, 'safeWrite(LEARNINGS_FILE) must exist in handler');
    assert.ok(auditIdx < safeWriteIdx,
      'appendAuditRow must come BEFORE safeWrite(LEARNINGS_FILE) — audit-first/mutate-second invariant');
  });

  it('audit failure returns 500 with code audit_integrity_error', () => {
    const handlerIdx = SERVER_SRC.indexOf("app.post('/extract'");
    const handler = SERVER_SRC.slice(handlerIdx, handlerIdx + 24000);

    assert.ok(handler.includes("code: 'audit_integrity_error'"),
      'audit failure must return code: audit_integrity_error');
    assert.ok(handler.includes('500'),
      'audit failure must return 500');
    assert.ok(handler.includes('Publication failed: audit integrity error'),
      'error message must indicate publication was blocked');
  });

  it('catalog is NOT mutated when audit write fails (published.length = 0)', () => {
    const handlerIdx = SERVER_SRC.indexOf("app.post('/extract'");
    const handler = SERVER_SRC.slice(handlerIdx, handlerIdx + 24000);

    // After the catch block for audit failure, published must be emptied
    const catchIdx = handler.indexOf('audit_integrity_error');
    assert.ok(catchIdx > -1);
    const catchBlock = handler.slice(catchIdx - 500, catchIdx + 500);
    assert.ok(catchBlock.includes('published.length = 0'),
      'audit failure must clear published array to prevent catalog mutation');
  });

  it('in-memory catalog mutation uses deferred pendingCatalogEntries pattern', () => {
    // The for-loop that processes candidates must NOT directly push to learnings[].
    // Instead, it collects candidates in pendingCatalogEntries, which are committed
    // to learnings[] only after the audit write succeeds.
    const handlerIdx = SERVER_SRC.indexOf("app.post('/extract'");
    assert.ok(handlerIdx > -1);
    const handler = SERVER_SRC.slice(handlerIdx, handlerIdx + 24000);

    // Verify pendingCatalogEntries array is declared
    assert.ok(handler.includes('const pendingCatalogEntries = []'),
      'must declare pendingCatalogEntries array for deferred mutation');

    // Verify the for-loop pushes to pendingCatalogEntries, not learnings
    // Find the candidate processing for-loop (between Steps 10-14 and Step 17)
    const loopStart = handler.indexOf('for (const candidate of candidates)');
    const auditStart = handler.indexOf('Step 17: Audit log');
    assert.ok(loopStart > -1, 'candidate for-loop must exist');
    assert.ok(auditStart > -1, 'Step 17 must exist');
    const loopBody = handler.slice(loopStart, auditStart);

    assert.ok(loopBody.includes('pendingCatalogEntries.push(candidate)'),
      'for-loop must push to pendingCatalogEntries, not directly to learnings[]');
    assert.ok(!loopBody.includes('learnings.push(candidate)'),
      'for-loop must NOT push directly to learnings[] — use deferred pattern');
  });

  it('learnings.push happens AFTER audit write succeeds (from pendingCatalogEntries)', () => {
    const handlerIdx = SERVER_SRC.indexOf("app.post('/extract'");
    const handler = SERVER_SRC.slice(handlerIdx, handlerIdx + 24000);

    // Find the catalog mutation section (after audit)
    const catalogMutationIdx = handler.indexOf('Catalog mutation: ONLY after successful audit');
    assert.ok(catalogMutationIdx > -1, 'post-audit catalog mutation section must exist');
    // Window widened for the Wave-2b learnings-lock wrapper around the commit.
    const postAudit = handler.slice(catalogMutationIdx, catalogMutationIdx + 800);

    assert.ok(postAudit.includes('pendingCatalogEntries'),
      'post-audit section must reference pendingCatalogEntries');
    assert.ok(postAudit.includes('learnings.push'),
      'post-audit section must push deferred entries to learnings[]');
  });
});
