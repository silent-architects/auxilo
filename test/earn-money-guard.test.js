'use strict';

/**
 * test/earn-money-guard.test.js — MONEY-0928 guard.
 *
 * The owner's ruling (BUILD-BRIEF-EARN-MONEY.md, 2026-09-28), verbatim:
 * "I keep seeing this "earn a share" - what the hell is a share? I would
 * prefer earn money". REGISTER-M-MONEY.md placed 41 of its 42 rows (M-42,
 * docs/ONBOARDING-COPY.md, was dropped by the PM's ruling on flag F-11) plus
 * five additional flag placements (F-01, F-02, F-03, F-04, F-05). This is
 * the standing guard: it fails the build the moment any of the retired
 * "share" phrasing comes back into a served surface.
 *
 * Enumerated via `git ls-files` (ruling: a directory listing is not "every
 * tracked file" -- see the sweep-enumerates-from-git-ls-files lesson), same
 * convention as test/no-local-paths-guard.test.js and
 * test/hero-0927.test.js's namedSurfaceFiles(). Covers every file under
 * public/ and .well-known/, plus openapi.json, lib/email.js, mcp-server.js,
 * bin/auxilo-cli.js, AGENT-LEARNING-GUIDE.md and README.md, per the build
 * brief's guard scope. docs/TERMS-OF-SERVICE.md and docs/PRIVACY-POLICY.md
 * are outside this guard by the brief's own rule (legal copy, untouched).
 *
 * "Builder Share" (the Terms' defined term) is allowed to survive ONLY where
 * the PM's ruling on flag F-06 keeps it (mcp-server.js's auxilo_accept_terms
 * tool description, which states the Section 5.10 legal mechanism in the
 * Terms' own capitalized vocabulary). NOTE ON A BRIEF DISCREPANCY, surfaced
 * rather than silently resolved: the build brief's Tests section names two
 * allowed locations, "F-06 and F-12". F-06 (mcp-server.js:422) does carry
 * "Builder Share", verified below. F-12 (mcp-server.js:365, the
 * auxilo_withdraw description, parked around row M-32) does NOT contain the
 * string "Builder Share" anywhere in the source as placed -- confirmed by
 * grep before this guard was written. Per the build brief's own rule ("If a
 * row's Now string does not match the file exactly, do not guess"), this
 * guard checks the one real surviving location rather than asserting a
 * second one that isn't in the source; the discrepancy is reported to the
 * PM in the build report so the brief's own text can be corrected.
 *
 * Runner: node --test test/earn-money-guard.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO = path.join(__dirname, '..');

const GUARD_PATHSPECS = [
  'public/',
  '.well-known/',
  'openapi.json',
  'lib/email.js',
  'mcp-server.js',
  'bin/auxilo-cli.js',
  'AGENT-LEARNING-GUIDE.md',
  'README.md',
];

// The eleven retired phrases (REGISTER-M-MONEY.md's rows), matched without
// regard to case, exactly as the build brief specifies.
const FORBIDDEN_PHRASES = [
  'earn a share',
  'earns a share',
  'earn your share',
  'your share',
  'their share',
  "builder's share",
  'share accrues',
  'share accrued',
  'revenue share',
  'platform share',
  'a share when',
];

// The one place "Builder Share" is allowed to survive (flag F-06; see file
// header for the F-12 discrepancy note).
const ALLOWED_BUILDER_SHARE = [
  {
    file: 'mcp-server.js',
    sentence:
      "under which the builder appoints Auxilo as their limited agent to receive the Builder Share on their behalf.",
  },
];

function trackedFiles() {
  const out = execFileSync('git', ['ls-files', ...GUARD_PATHSPECS], {
    cwd: REPO,
    encoding: 'utf8',
  });
  return out.split('\n').filter(Boolean).sort();
}

function readTextFiles(files) {
  const out = [];
  for (const f of files) {
    try {
      out.push({ file: f, text: fs.readFileSync(path.join(REPO, f), 'utf8') });
    } catch {
      // binary asset (png/woff2/etc.) or otherwise unreadable as utf8 --
      // not a text surface this guard can search, skip it.
    }
  }
  return out;
}

describe('earn-money-guard: sweep enumeration', () => {
  const files = trackedFiles();

  it('enumerates the covered fileset from git ls-files and prints the count', () => {
    console.log('earn-money-guard: covered file count =', files.length);
    assert.ok(files.length > 40, `expected a substantial file set, got ${files.length}`);
    assert.ok(files.includes('public/index.html'), 'public/index.html must be in the covered set');
    assert.ok(files.includes('mcp-server.js'), 'mcp-server.js must be in the covered set');
    assert.ok(files.includes('openapi.json'), 'openapi.json must be in the covered set');
  });
});

describe('earn-money-guard: positive controls (the matcher is not vacuous)', () => {
  for (const phrase of FORBIDDEN_PHRASES) {
    it(`matcher finds "${phrase}" in a fixture string, case-insensitively`, () => {
      const fixture = `Example fixture sentence where you ${phrase.toUpperCase()} on purpose.`;
      assert.ok(
        fixture.toLowerCase().includes(phrase.toLowerCase()),
        `fixture must contain "${phrase}" for the positive control to mean anything`
      );
    });
  }

  it('matcher finds "Builder Share" in the Terms file (docs/TERMS-OF-SERVICE.md, outside this guard\'s covered scope by rule)', () => {
    const termsText = fs.readFileSync(path.join(REPO, 'docs/TERMS-OF-SERVICE.md'), 'utf8');
    assert.match(termsText, /builder share/i, 'positive control: "Builder Share" must be found in the Terms file');
  });
});

describe('earn-money-guard: no forbidden "share" phrase survives in the covered fileset', () => {
  const files = readTextFiles(trackedFiles());

  it('the sweep actually read a substantial number of text files (not vacuously empty)', () => {
    assert.ok(files.length > 30, `expected a substantial readable text-file set, got ${files.length}`);
  });

  for (const phrase of FORBIDDEN_PHRASES) {
    it(`"${phrase}" appears in no covered file (case-insensitive)`, () => {
      const needle = phrase.toLowerCase();
      const hits = files.filter((f) => f.text.toLowerCase().includes(needle)).map((f) => f.file);
      assert.deepEqual(hits, [], `forbidden phrase "${phrase}" must be gone; still found in: ${hits.join(', ')}`);
    });
  }
});

describe('earn-money-guard: "Builder Share" survives only where flag F-06 leaves it', () => {
  const files = readTextFiles(trackedFiles());
  const BUILDER_SHARE_PATTERN = /builder'?s? share/i;

  it('every remaining case-insensitive "Builder Share" / "builder\'s share" occurrence is the one F-06 location', () => {
    const hits = files.filter((f) => BUILDER_SHARE_PATTERN.test(f.text)).map((f) => f.file);
    const expected = ALLOWED_BUILDER_SHARE.map((a) => a.file).sort();
    assert.deepEqual(
      hits.sort(),
      expected,
      `"Builder Share" must survive only in: ${expected.join(', ')}; found in: ${hits.join(', ')}`
    );
  });

  for (const { file, sentence } of ALLOWED_BUILDER_SHARE) {
    it(`${file} carries the F-06 sentence verbatim (naming it here, per the brief's instruction)`, () => {
      const text = fs.readFileSync(path.join(REPO, file), 'utf8');
      assert.ok(text.includes(sentence), `${file} must carry the F-06 sentence verbatim: ${sentence}`);
    });
  }
});

describe('earn-money-guard: the other meaning of "share" (agents sharing what they learned) survives', () => {
  it('public/index.html still asks how agents share knowledge (FAQ question, both the rendered span and its JSON-LD mirror)', () => {
    const text = fs.readFileSync(path.join(REPO, 'public/index.html'), 'utf8');
    const count = text.split('How do AI agents share knowledge with each other?').length - 1;
    assert.ok(count >= 2, `expected the sharing-sense FAQ question at least twice (visible + JSON-LD), found ${count}`);
  });

  it('public/for-agents.html still says agents share what they learned (hero sentence)', () => {
    const text = fs.readFileSync(path.join(REPO, 'public/for-agents.html'), 'utf8');
    assert.ok(text.includes('agents share what they learned'), 'for-agents.html must still carry the sharing-sense hero sentence');
  });
});
