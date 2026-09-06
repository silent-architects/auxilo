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
  it('extractionModel omitted entirely is byte-identical to pre-PART-C behavior (back-compat)', () => {
    const withField = cleanLane.evaluateExtractionPublish({
      flagEnabled: true, consentState: GRANT, qualityTotal: 20,
    });
    const explicitUndefined = cleanLane.evaluateExtractionPublish({
      flagEnabled: true, consentState: GRANT, qualityTotal: 20, extractionModel: undefined,
    });
    const explicitNull = cleanLane.evaluateExtractionPublish({
      flagEnabled: true, consentState: GRANT, qualityTotal: 20, extractionModel: null,
    });
    assert.deepEqual(withField, { decision: 'auto_publish', consent_version: cleanLane.CLEAN_LANE_CONSENT_VERSION, min_quality: 16 });
    assert.deepEqual(explicitUndefined, withField);
    assert.deepEqual(explicitNull, withField);
  });

  it('{provider:"claude-code"} (calibrated) behaves identically to omitted', () => {
    const v = cleanLane.evaluateExtractionPublish({
      flagEnabled: true, consentState: GRANT, qualityTotal: 20,
      extractionModel: { provider: 'claude-code', model: 'sonnet', version: null, vendor: null },
    });
    assert.equal(v.decision, 'auto_publish');
  });

  it('{provider:"codex-cli"} (not calibrated) ALWAYS holds, even with flag on + active grant + quality 20', () => {
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

  it('a non-string provider field is treated as absent (calibrated-equivalent), never crashes', () => {
    const v = cleanLane.evaluateExtractionPublish({
      flagEnabled: true, consentState: GRANT, qualityTotal: 20,
      extractionModel: { provider: 12345 },
    });
    assert.equal(v.decision, 'auto_publish', 'malformed provider falls through to normal checks, not a crash or a hold');
  });

  it('extractionModel itself malformed (not an object) never throws, falls through', () => {
    for (const bad of ['codex-cli', 42, [], true]) {
      assert.doesNotThrow(() => cleanLane.evaluateExtractionPublish({
        flagEnabled: true, consentState: GRANT, qualityTotal: 20, extractionModel: bad,
      }));
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

  it('prints the named line for each of the three status-worthy reasonCodes', () => {
    for (const code of cli.STATUS_WORTHY_SKIP_REASON_CODES) {
      const line = cli.extractionSkipReasonLine({ last_reason_code: code });
      assert.match(line, new RegExp(code.replace(/[-]/g, '\\-')));
    }
    assert.deepEqual(cli.STATUS_WORTHY_SKIP_REASON_CODES, [
      'cli-billing-helper-configured', 'cli-unauthenticated', 'no-model-provider-available',
    ]);
  });
});
