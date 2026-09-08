'use strict';
/*
 * test/clean-lane-calibration.test.js — EXTRACT-PER-CLIENT W1 PART C
 *
 * Covers lib/clean-lane.js's provider-calibration gate: CLEAN_LANE_CALIBRATED_
 * PROVIDERS, HOLD_UNCALIBRATED_PROVIDER, and evaluateExtractionPublish's new
 * extractionModel param — checked FIRST, unconditionally, ahead of flag/
 * consent/quality. Also pins bin/auxilo-cli.js's mirrored copy of the
 * allowlist (that module cannot require lib/clean-lane.js — server-side,
 * excluded from the published package's files[]).
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const cleanLane = require('../lib/clean-lane.js');
const cli = require('../bin/auxilo-cli.js');

const CLI_SRC = fs.readFileSync(path.join(__dirname, '..', 'bin', 'auxilo-cli.js'), 'utf8');

const GRANT = { action: 'grant', consent_version: cleanLane.CLEAN_LANE_CONSENT_VERSION, min_auto_publish_quality: 16 };

describe('lib/clean-lane.js: CLEAN_LANE_CALIBRATED_PROVIDERS / HOLD_UNCALIBRATED_PROVIDER', () => {
  it('is frozen and contains exactly claude-code today', () => {
    assert.ok(Object.isFrozen(cleanLane.CLEAN_LANE_CALIBRATED_PROVIDERS));
    assert.deepEqual(cleanLane.CLEAN_LANE_CALIBRATED_PROVIDERS, ['claude-code']);
  });

  it('HOLD_UNCALIBRATED_PROVIDER is a stable, distinct reason string', () => {
    assert.equal(cleanLane.HOLD_UNCALIBRATED_PROVIDER, 'uncalibrated_extraction_provider');
    assert.notEqual(cleanLane.HOLD_UNCALIBRATED_PROVIDER, cleanLane.HOLD_STANDING_CONSENT_OFF);
    assert.notEqual(cleanLane.HOLD_UNCALIBRATED_PROVIDER, cleanLane.HOLD_BELOW_AUTO_PUBLISH_THRESHOLD);
  });
});

describe('evaluateExtractionPublish: provider calibration gate (PART C)', () => {
  // EXTRACTION-MODEL-PROVENANCE (PUNCH-LIST P1): the old "missing stamp is
  // calibrated-equivalent" fail-open is GONE. Every shipped client now
  // stamps `extraction_model` (providers/index.js's runModel() makes
  // `identity` mandatory), so a missing stamp today means a client too old
  // to have ever stamped one, or one whose stamp got dropped — neither of
  // which this gate should treat as "known claude-code quality". Omitted,
  // explicit `null`, and an explicit `{provider:'unknown'}` stamp all now
  // HOLD under the SAME distinct reason, HOLD_UNKNOWN_EXTRACTION_PROVIDER —
  // never auto-publish, never refuse; one operator click in pending_review.
  it('extractionModel omitted, explicit null, and an explicit unknown provider all HOLD under the same distinct reason (no more calibrated-equivalent fail-open)', () => {
    const omitted = cleanLane.evaluateExtractionPublish({
      flagEnabled: true, consentState: GRANT, qualityTotal: 20,
    });
    const explicitUndefined = cleanLane.evaluateExtractionPublish({
      flagEnabled: true, consentState: GRANT, qualityTotal: 20, extractionModel: undefined,
    });
    const explicitNull = cleanLane.evaluateExtractionPublish({
      flagEnabled: true, consentState: GRANT, qualityTotal: 20, extractionModel: null,
    });
    const explicitUnknown = cleanLane.evaluateExtractionPublish({
      flagEnabled: true, consentState: GRANT, qualityTotal: 20,
      extractionModel: { provider: 'unknown', model: null, version: null, vendor: null },
    });
    const expected = { decision: 'hold', reason: cleanLane.HOLD_UNKNOWN_EXTRACTION_PROVIDER };
    assert.deepEqual(omitted, expected);
    assert.deepEqual(explicitUndefined, expected);
    assert.deepEqual(explicitNull, expected);
    assert.deepEqual(explicitUnknown, expected);
    assert.notEqual(cleanLane.HOLD_UNKNOWN_EXTRACTION_PROVIDER, cleanLane.HOLD_UNCALIBRATED_PROVIDER,
      '"we don\'t know who ran this" must read differently from "we know and it is not calibrated yet"');
  });

  it('a genuinely calibrated {provider:"claude-code"} stamp still auto-publishes — the new unknown/missing hold does not touch the real calibrated path', () => {
    const v = cleanLane.evaluateExtractionPublish({
      flagEnabled: true, consentState: GRANT, qualityTotal: 20,
      extractionModel: { provider: 'claude-code', model: 'sonnet', version: null, vendor: null },
    });
    assert.equal(v.decision, 'auto_publish');
  });

  it('{provider:"codex-cli"} (a NAMED, known, but not-yet-calibrated provider) ALWAYS holds, even with flag on + active grant + quality 20 — distinct reason from the unknown/missing case', () => {
    const v = cleanLane.evaluateExtractionPublish({
      flagEnabled: true, consentState: GRANT, qualityTotal: 20,
      extractionModel: { provider: 'codex-cli', model: null, version: '0.144.5', vendor: null },
    });
    assert.deepEqual(v, { decision: 'hold', reason: 'uncalibrated_extraction_provider' });
  });

  it('{provider:"byo-key"} (not calibrated) holds regardless of vendor', () => {
    for (const vendor of ['openai-compatible', 'anthropic', 'gemini']) {
      const v = cleanLane.evaluateExtractionPublish({
        flagEnabled: true, consentState: GRANT, qualityTotal: 20,
        extractionModel: { provider: 'byo-key', model: 'gpt-4o-mini', version: null, vendor },
      });
      assert.equal(v.decision, 'hold');
      assert.equal(v.reason, cleanLane.HOLD_UNCALIBRATED_PROVIDER);
    }
  });

  it('the uncalibrated-provider check runs BEFORE flag/consent/quality — still uncalibrated even when every other check would also fail', () => {
    const v = cleanLane.evaluateExtractionPublish({
      flagEnabled: false, consentState: null, qualityTotal: 0,
      extractionModel: { provider: 'codex-cli' },
    });
    assert.deepEqual(v, { decision: 'hold', reason: 'uncalibrated_extraction_provider' },
      'must report the calibration reason, not standing_consent_off, even though the flag is also off');
  });

  it('the unknown/missing-provider check ALSO runs BEFORE flag/consent/quality', () => {
    const v = cleanLane.evaluateExtractionPublish({
      flagEnabled: false, consentState: null, qualityTotal: 0,
    });
    assert.deepEqual(v, { decision: 'hold', reason: cleanLane.HOLD_UNKNOWN_EXTRACTION_PROVIDER },
      'must report the unknown-provider reason, not standing_consent_off, even though the flag is also off');
  });

  it('a non-string provider field holds under the unknown reason (never crashes, never silently auto-publishes)', () => {
    const v = cleanLane.evaluateExtractionPublish({
      flagEnabled: true, consentState: GRANT, qualityTotal: 20,
      extractionModel: { provider: 12345 },
    });
    assert.deepEqual(v, { decision: 'hold', reason: cleanLane.HOLD_UNKNOWN_EXTRACTION_PROVIDER },
      'a malformed provider value must hold as unknown, not fall through to auto-publish');
  });

  it('extractionModel itself malformed (not an object) never throws, and holds as unknown rather than auto-publishing', () => {
    for (const bad of ['codex-cli', 42, [], true]) {
      let v;
      assert.doesNotThrow(() => {
        v = cleanLane.evaluateExtractionPublish({
          flagEnabled: true, consentState: GRANT, qualityTotal: 20, extractionModel: bad,
        });
      });
      assert.deepEqual(v, { decision: 'hold', reason: cleanLane.HOLD_UNKNOWN_EXTRACTION_PROVIDER });
    }
  });
});

describe('bin/auxilo-cli.js: CLI mirror of the calibration allowlist', () => {
  it('CLI_CLEAN_LANE_CALIBRATED_PROVIDERS is array-equal to lib/clean-lane.js CLEAN_LANE_CALIBRATED_PROVIDERS', () => {
    assert.deepEqual(cli.CLI_CLEAN_LANE_CALIBRATED_PROVIDERS, [...cleanLane.CLEAN_LANE_CALIBRATED_PROVIDERS]);
  });

  it('the CLI does not require the unshipped server module (package.json files[] excludes lib/clean-lane.js)', () => {
    assert.ok(!CLI_SRC.includes("require('../lib/clean-lane.js')"));
  });

  it('extractionProviderLine names the calibration state for a resolved provider', () => {
    const calibrated = cli.extractionProviderLine({ ok: true, id: 'claude-code' });
    assert.match(calibrated, /clean-lane calibrated/);
    const reviewOnly = cli.extractionProviderLine({ ok: true, id: 'byo-key' });
    assert.match(reviewOnly, /review-lane only/);
  });
});

describe('bin/auxilo-cli.js: extractionSkipReasonLine (PART C, last_reason_code status line)', () => {
  it('prints nothing for a fresh/zero state', () => {
    assert.equal(cli.extractionSkipReasonLine({ last_reason_code: null }), null);
    assert.equal(cli.extractionSkipReasonLine(null), null);
    assert.equal(cli.extractionSkipReasonLine(undefined), null);
  });

  it('prints nothing for a reasonCode outside the named set (e.g. a real model-error)', () => {
    assert.equal(cli.extractionSkipReasonLine({ last_reason_code: 'model-error' }), null);
    assert.equal(cli.extractionSkipReasonLine({ last_reason_code: 'unknown' }), null);
  });

  it('prints the named line for each of the four status-worthy reasonCodes', () => {
    for (const code of cli.STATUS_WORTHY_SKIP_REASON_CODES) {
      const line = cli.extractionSkipReasonLine({ last_reason_code: code });
      assert.match(line, new RegExp(code.replace(/[-]/g, '\\-')));
    }
    // EXTRACT-PER-CLIENT W1 P1 fix (PUNCH-LIST): 'no-usable-provider' added —
    // the selection-fall-through exhaustion code (every provider in
    // PROVIDER_ORDER was actually tried), distinct from
    // 'no-model-provider-available' (nothing even looked usable at detect()).
    assert.deepEqual(cli.STATUS_WORTHY_SKIP_REASON_CODES, [
      'cli-billing-helper-configured', 'cli-unauthenticated', 'no-model-provider-available', 'no-usable-provider',
    ]);
  });
});
