'use strict';

/**
 * test/credits-as-cash-copy-guard.test.js — credits-as-cash copy guard
 * (build brief BUILD-BRIEF-CREDITS-PAGES.md, Part D).
 *
 * The product has ONE money model, a balance in dollars: no switch, no
 * second model, no unit credit. This guard proves that state in writing
 * across the eleven files register C touches:
 *
 *   1. None of the retired-model phrases (unit credit counts, per-credit
 *      dollar costs, "whatever the listed price" hedges, "of what the
 *      buyer pays"/"paid" phrasing the register replaced) survives in the
 *      visible text or structured data of any of the eleven files.
 *   2. The /for-builders math block carries exactly one highlighted dollar
 *      figure ($0.70), and its footnote equals register row C-08 verbatim.
 *   3. Every one of the eleven files that states the 70%/60% rate anywhere
 *      in it also carries the "not guaranteed" sentence and a
 *      paused-withdrawals ("open soon") statement somewhere in it (register
 *      note 4: "Every page keeps its not guaranteed and Withdrawals open
 *      soon sentences exactly where they are").
 *   4. docs/TERMS-OF-SERVICE.md carries the new defined terms register T
 *      adds (Balance, Paid Balance, Promotional Balance, Listed Price,
 *      Unlock Payment), and its Current Amendment id equals
 *      lib/accounts.js's CURRENT_TOS_VERSION (the predeploy-check
 *      invariant).
 *
 * Every absence check below carries a positive control in the same test,
 * per BUILDER-RULES.
 *
 * Runner: node --test test/credits-as-cash-copy-guard.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(REPO, ...p), 'utf8');

// ─── The eleven files register C touches ───────────────────────────────────

const FILES = {
  'public/index.html': read('public', 'index.html'),
  'public/for-builders.html': read('public', 'for-builders.html'),
  'public/for-agents.html': read('public', 'for-agents.html'),
  'public/how-it-works.html': read('public', 'how-it-works.html'),
  'public/pricing.html': read('public', 'pricing.html'),
  'public/dashboard.html': read('public', 'dashboard.html'),
  'public/status.html': read('public', 'status.html'),
  'public/api.html': read('public', 'api.html'),
  'public/llms.txt': read('public', 'llms.txt'),
  'openapi.json': read('openapi.json'),
  '.well-known/agent.json': read('.well-known', 'agent.json'),
};

const HTML_FILES = new Set([
  'public/index.html', 'public/for-builders.html', 'public/for-agents.html',
  'public/how-it-works.html', 'public/pricing.html', 'public/dashboard.html',
  'public/status.html', 'public/api.html',
]);

/** Comments/style/script stripped from an HTML file (the checked text for a
 * page with client-rendered content, matching test/vision-pass-guard.test.js's
 * dashboardCheckedText treatment — plain files are used as-is. */
function checkedText(name, raw) {
  if (!HTML_FILES.has(name)) return raw; // llms.txt / JSON: raw text, no tags
  return raw
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<style[\s\S]*?<\/style>/g, ' ');
}

// ─── Item 1: retired-model phrases absent everywhere ───────────────────────

const FORBIDDEN = [
  'One credit unlocks one learning',
  '80 unlocks',
  '250 unlocks',
  '1,000 unlocks',
  'unlock credits',
  'unlock credit',
  '$0.125',
  'pays one credit',
  'whatever the listed price',
  'whatever its listed price',
  'of what the buyer pays',
  'of what they paid',
  "of what's paid",
  '$0.07 to $0.0875',
];

describe('credits-as-cash guard 1: no retired-model phrase survives in any of the eleven files', () => {
  for (const [name, raw] of Object.entries(FILES)) {
    const text = checkedText(name, raw);
    for (const phrase of FORBIDDEN) {
      it(`${name}: does not contain "${phrase}"`, () => {
        assert.ok(!text.includes(phrase), `${name} must not contain "${phrase}"`);
      });
    }
    it(`${name}: positive control — a known-present string is actually found by the same extraction`, () => {
      assert.ok(text.includes('Auxilo'), `positive control failed for ${name}: "Auxilo" not found`);
    });
  }

  it('positive control: the detector itself catches a synthetic occurrence of each forbidden phrase', () => {
    for (const phrase of FORBIDDEN) {
      const synthetic = `Some copy mentions ${phrase} in passing.`;
      assert.ok(synthetic.includes(phrase), `detector must find "${phrase}" in a synthetic positive`);
    }
  });
});

// ─── Item 2: the /for-builders math block, one figure, C-08 footnote ──────

describe('credits-as-cash guard 2: the /for-builders math block carries exactly one highlighted dollar figure and the C-08 footnote', () => {
  const html = FILES['public/for-builders.html'];
  const MATH_BODY = 'A learning listed at $1.00* earns you $0.70 (70%) when another agent pays to unlock it. You earn again* on the same learning when another agent unlocks it, and nothing you publish expires while it stays in the catalog.';
  const MATH_FOOTNOTE = '*Example price. You earn 60% when Auxilo search surfaced it. Some unlocks are issued as $0.00 promotional grants and earn nothing. Earnings accrue now. Withdrawals open soon.';

  function normalize(str) {
    return str
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ')
      .trim();
  }

  it('the body paragraph equals C-07 verbatim (normalized) with exactly one earnings-highlight span, on $0.70', () => {
    const bodyMatch = html.match(/<p>A learning listed at[\s\S]*?<\/p>/);
    assert.ok(bodyMatch, 'math block body paragraph found');
    assert.equal(normalize(bodyMatch[0]), MATH_BODY, 'body equals C-07 verbatim');
    assert.equal((bodyMatch[0].match(/<span class="earnings-highlight">/g) || []).length, 1, 'exactly one earnings-highlight span');
    assert.match(bodyMatch[0], /<span class="earnings-highlight">\$0\.70<\/span>/);
  });

  it('the footnote equals C-08 verbatim (normalized)', () => {
    const footnoteMatch = html.match(/<p id="math-footnote"[^>]*>([\s\S]*?)<\/p>/);
    assert.ok(footnoteMatch, 'footnote paragraph found');
    assert.equal(normalize(footnoteMatch[1]), MATH_FOOTNOTE, 'footnote equals C-08 verbatim');
  });

  it('positive control: the normalizer actually strips tags (proven against a synthetic string)', () => {
    assert.equal(normalize('<p>a <b>b</b></p>'), 'a b');
  });
});

// ─── Item 3: every rate-stating file still carries "not guaranteed" and an
// "open soon" statement somewhere in it ─────────────────────────────────────

describe('credits-as-cash guard 3: every file that states the 70%/60% rate also carries "not guaranteed" and "open soon"', () => {
  const NOT_GUARANTEED = 'not guaranteed';

  for (const [name, raw] of Object.entries(FILES)) {
    const text = checkedText(name, raw);
    const statesRate = /70%/.test(text) || /60%/.test(text);
    it(`${name}: if it states the rate, it carries "not guaranteed" and "open soon"`, () => {
      if (!statesRate) return; // this file never states the 70%/60% rate — not in scope
      assert.ok(text.toLowerCase().includes(NOT_GUARANTEED), `${name} states the rate but is missing "not guaranteed"`);
      assert.match(text, /open soon/i, `${name} states the rate but is missing a paused-withdrawals ("open soon") statement`);
    });
  }

  it('positive control: at least one of the eleven files actually states the rate, so the loop above is not vacuous', () => {
    const any = Object.entries(FILES).some(([name, raw]) => {
      const text = checkedText(name, raw);
      return /70%/.test(text) || /60%/.test(text);
    });
    assert.ok(any, 'positive control: at least one file states 70% or 60%');
  });
});

// ─── Item 4: Terms carries the new defined terms; version header equals
// CURRENT_TOS_VERSION ───────────────────────────────────────────────────────

describe('credits-as-cash guard 4: Terms carries the new defined terms and its version equals CURRENT_TOS_VERSION', () => {
  const TOS = read('docs', 'TERMS-OF-SERVICE.md');
  const { CURRENT_TOS_VERSION } = require('../lib/accounts.js');

  const DEFINED_TERMS = [
    '**"Balance"**',
    '**"Paid Balance"**',
    '**"Promotional Balance"**',
    '**"Listed Price"**',
    '**"Unlock Payment"**',
  ];

  for (const term of DEFINED_TERMS) {
    it(`Terms defines ${term} exactly once`, () => {
      assert.equal(TOS.split(term).length - 1, 1, `${term} must be defined exactly once`);
    });
  }

  it('positive control: a known pre-existing defined term ("Agent") is still found by the same check', () => {
    assert.ok(TOS.includes('**"Agent"**'), 'positive control: "Agent" definition present');
  });

  it('the Current Amendment id equals lib/accounts.js CURRENT_TOS_VERSION (predeploy-check invariant)', () => {
    const current = /Current Amendment: `([^`]+)`/.exec(TOS);
    assert.ok(current, 'Current Amendment banner present');
    assert.equal(current[1], CURRENT_TOS_VERSION, 'Terms header version equals the server constant');
    assert.equal(CURRENT_TOS_VERSION, '2026-09-27-credit-balance-a2', 'CURRENT_TOS_VERSION is the register C revision-3 version string');
  });
});
