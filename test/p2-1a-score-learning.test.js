/**
 * test/p2-1a-score-learning.test.js — Quality gate (scoreLearning)
 *
 * Covers:
 *   - scoreLearning exists and is exported
 *   - Accepted fixture passes quality gate (score >= threshold)
 *   - Rejected fixture fails quality gate (score < threshold)
 *   - Dimensions are extracted correctly from quality_self_assessment
 *   - Total is sum of all four dimensions
 *   - Per-dimension minimum enforced (below_dimension)
 *   - Threshold and min_dimension configurable
 *   - Missing quality_self_assessment defaults to zeros
 *
 * Strategy: Direct module import (lib/extractor.js exports scoreLearning)
 *
 * Runner: node --test test/p2-1a-score-learning.test.js
 */

'use strict';

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { scoreLearning } = require('../lib/extractor');
const FIXTURES = path.join(__dirname, 'fixtures');

let acceptedFixture, rejectedFixture;

before(() => {
  acceptedFixture = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'learning-accepted.json'), 'utf-8'));
  rejectedFixture = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'learning-rejected-low-quality.json'), 'utf-8'));
});

describe('scoreLearning: basic behavior', () => {
  it('scoreLearning function is exported', () => {
    assert.equal(typeof scoreLearning, 'function');
  });

  it('returns { total, dimensions, passed, failed_reason, threshold, min_dimension }', () => {
    const result = scoreLearning(acceptedFixture);
    assert.ok('total' in result);
    assert.ok('dimensions' in result);
    assert.ok('passed' in result);
    assert.ok('failed_reason' in result);
    assert.ok('threshold' in result);
    assert.ok('min_dimension' in result);
  });
});

describe('scoreLearning: fixture-based tests', () => {
  it('accepted fixture passes quality gate', () => {
    const result = scoreLearning(acceptedFixture);
    assert.equal(result.passed, true, 'accepted fixture must pass');
    assert.equal(result.failed_reason, null, 'must have no failure reason');
    assert.equal(result.total, acceptedFixture._expected.total,
      `total must be ${acceptedFixture._expected.total}`);
  });

  it('rejected fixture fails quality gate', () => {
    const result = scoreLearning(rejectedFixture);
    assert.equal(result.passed, false, 'rejected fixture must fail');
    assert.equal(result.total, rejectedFixture._expected.total,
      `total must be ${rejectedFixture._expected.total}`);
    assert.equal(result.failed_reason, rejectedFixture._expected.failed_reason);
  });
});

describe('scoreLearning: dimension extraction', () => {
  it('extracts all four dimensions from quality_self_assessment', () => {
    const result = scoreLearning(acceptedFixture);
    assert.equal(result.dimensions.specificity, acceptedFixture.quality_self_assessment.specificity);
    assert.equal(result.dimensions.actionability, acceptedFixture.quality_self_assessment.actionability);
    assert.equal(result.dimensions.novelty, acceptedFixture.quality_self_assessment.novelty);
    assert.equal(result.dimensions.completeness, acceptedFixture.quality_self_assessment.completeness);
  });

  it('total is sum of all four dimensions', () => {
    const result = scoreLearning(acceptedFixture);
    const expected = acceptedFixture.quality_self_assessment.specificity +
                     acceptedFixture.quality_self_assessment.actionability +
                     acceptedFixture.quality_self_assessment.novelty +
                     acceptedFixture.quality_self_assessment.completeness;
    assert.equal(result.total, expected);
  });
});

describe('scoreLearning: threshold enforcement', () => {
  it('below_total when total < threshold (default 14)', () => {
    const result = scoreLearning(rejectedFixture);
    assert.equal(result.failed_reason, 'below_total');
  });

  it('below_dimension when one dimension below min (default 3)', () => {
    const learning = {
      quality_self_assessment: {
        specificity: 5,
        actionability: 5,
        novelty: 2, // below 3
        completeness: 5,
      },
    };
    const result = scoreLearning(learning);
    assert.equal(result.passed, false);
    assert.ok(result.failed_reason.startsWith('below_dimension:'),
      'must fail with below_dimension');
    assert.ok(result.failed_reason.includes('novelty'),
      'failed dimension must be novelty');
  });

  it('custom threshold and min_dimension', () => {
    const learning = {
      quality_self_assessment: {
        specificity: 3,
        actionability: 3,
        novelty: 3,
        completeness: 3,
      },
    };
    // Default threshold 14, total 12 → fail
    assert.equal(scoreLearning(learning).passed, false);
    // Custom threshold 10 → pass
    assert.equal(scoreLearning(learning, { quality_threshold: 10 }).passed, true);
  });
});

describe('scoreLearning: missing data', () => {
  it('missing quality_self_assessment defaults to zeros', () => {
    const result = scoreLearning({});
    assert.equal(result.total, 0);
    assert.equal(result.passed, false);
    assert.equal(result.failed_reason, 'below_total');
  });

  it('partial quality_self_assessment fills missing with 0', () => {
    const result = scoreLearning({
      quality_self_assessment: { specificity: 5 },
    });
    assert.equal(result.total, 5);
    assert.equal(result.dimensions.actionability, 0);
    assert.equal(result.dimensions.novelty, 0);
    assert.equal(result.dimensions.completeness, 0);
  });
});
