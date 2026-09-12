'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const extractLocal = require('../scripts/extract-local.js');
const promptBundle = require('../scripts/prompts');

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'epc2-1-prompts');
const PREVIOUS_LESSONS_SECTION = [
  'PREVIOUSLY CAPTURED LESSONS:',
  '- [lrn_existing] Existing lesson title',
].join('\n');

function golden(name) {
  return fs.readFileSync(path.join(FIXTURE_DIR, name));
}

function assertByteEqual(actual, fixtureName) {
  assert.equal(
    Buffer.compare(Buffer.from(actual), golden(fixtureName)),
    0,
    `${fixtureName} differs byte-for-byte from the pinned-base golden`
  );
}

function assertPrivateScope(prompt) {
  assert.ok(prompt.includes(promptBundle.PRIVATE_SCOPE_BLOCK));
  assert.ok(prompt.includes(JSON.stringify(promptBundle.PRIVATE_CATEGORIES)));
  assert.ok(!prompt.includes(promptBundle.PUBLIC_SCOPE_BLOCK));
  assert.ok(!prompt.includes('to publish to a PUBLIC knowledge marketplace read by other AI agents.'));
}

const EXTRACTION_CASES = [];
for (const captureVisibility of ['public', 'private']) {
  for (const scoreExtraction of [true, false]) {
    for (const hasPreviousLessons of [false, true]) {
      EXTRACTION_CASES.push({ captureVisibility, scoreExtraction, hasPreviousLessons });
    }
  }
}

describe('EPC2-1 extraction prompt byte equivalence', () => {
  for (const { captureVisibility, scoreExtraction, hasPreviousLessons } of EXTRACTION_CASES) {
    const fixtureName = [
      'extraction',
      captureVisibility,
      scoreExtraction ? 'score-on' : 'score-off',
      hasPreviousLessons ? 'memory-present' : 'memory-absent',
    ].join('-') + '.txt';

    it(`${captureVisibility}, scoring ${scoreExtraction ? 'on' : 'off'}, memory ${hasPreviousLessons ? 'present' : 'absent'}`, () => {
      const prompt = extractLocal.buildExtractionPrompt({
        captureVisibility,
        scoreExtraction,
        previousLessonsSection: hasPreviousLessons ? PREVIOUS_LESSONS_SECTION : undefined,
      });
      assertByteEqual(prompt, fixtureName);
      if (captureVisibility === 'private') assertPrivateScope(prompt);
    });
  }

  it('keeps the EXTRACTION_PROMPT back-compat export byte-identical', () => {
    assertByteEqual(extractLocal.EXTRACTION_PROMPT, 'extraction-backcompat.txt');
  });

  it('keeps the category exports identical to the governed bundle values', () => {
    assert.strictEqual(extractLocal.CATEGORIES, promptBundle.CATEGORIES);
    assert.strictEqual(extractLocal.PRIVATE_CATEGORIES, promptBundle.PRIVATE_CATEGORIES);
    assert.strictEqual(extractLocal.RETIRED_CATEGORIES, promptBundle.RETIRED_CATEGORIES);
  });
});

const SINGLE_CANDIDATES = [{
  title: 'Retry the upload after renewing the signed URL',
  body: 'The storage API returns an expired-signature error when a queued upload waits too long.',
  category: 'storage-state',
}];
const SINGLE_INDEX_ROWS = [{
  learning_id: 'lrn_signed_url',
  title: 'Renew expired signed URLs before retrying uploads',
  body: 'A delayed upload must request a fresh signed URL before retrying the storage operation.',
  category: 'storage-state',
}];

describe('EPC2-1 anchored judge prompt byte equivalence', () => {
  it('keeps the single-candidate prompt byte-identical with one ranked index row', () => {
    const result = extractLocal.buildAnchoredJudgePrompt(
      SINGLE_CANDIDATES,
      SINGLE_INDEX_ROWS,
      { topK: 3 }
    );
    assertByteEqual(result.prompt, 'judge-single.txt');
    assert.deepEqual(result.rankings.map((rows) => rows.map((row) => row.id)), [['lrn_signed_url']]);
  });

  it('keeps the multi-candidate ranking prompt byte-identical', () => {
    const candidates = [
      ...SINGLE_CANDIDATES,
      {
        title: 'Disable redirects while diagnosing an OAuth callback',
        body: 'Inspect the first callback response directly so redirect handling does not hide the provider error.',
        category: 'web-interaction',
      },
    ];
    const indexRows = [
      ...SINGLE_INDEX_ROWS,
      {
        learning_id: 'lrn_oauth_redirect',
        title: 'Inspect OAuth callback responses before following redirects',
        body: 'Temporarily disable redirects to expose the identity provider callback error body.',
        category: 'web-interaction',
      },
      {
        learning_id: 'lrn_unrelated_monitor',
        title: 'Back off health checks after repeated rate limits',
        body: 'A monitoring API can return rate limits when polling too aggressively.',
        category: 'monitoring',
      },
    ];
    const result = extractLocal.buildAnchoredJudgePrompt(candidates, indexRows, { topK: 2 });
    assertByteEqual(result.prompt, 'judge-multi.txt');
    assert.equal(result.rankings.length, 2);
    assert.deepEqual(result.rankings.map((rows) => rows.length), [2, 2]);
    assert.match(result.prompt, /"candidate_index":0/);
    assert.match(result.prompt, /"candidate_index":1/);
  });
});

describe('EPC2-1 prompt bundle governance', () => {
  it('exports non-empty static and assembly contract versions', () => {
    assert.equal(promptBundle.PROMPT_BUNDLE_VERSION, '1');
    assert.equal(promptBundle.ASSEMBLY_CONTRACT_VERSION, '1');
    assert.ok(promptBundle.PROMPT_BUNDLE_VERSION.length > 0);
    assert.ok(promptBundle.ASSEMBLY_CONTRACT_VERSION.length > 0);
    assert.ok(Object.isFrozen(promptBundle));
  });

  it('bundleDigest is stable and changes when the copied bundle file changes', () => {
    assert.equal(promptBundle.bundleDigest(), promptBundle.bundleDigest());

    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'auxilo-epc2-digest-'));
    try {
      const copiedPrompts = path.join(tempRoot, 'prompts');
      fs.cpSync(path.join(__dirname, '..', 'scripts', 'prompts'), copiedPrompts, { recursive: true });
      const copiedLoader = require(path.join(copiedPrompts, 'index.js'));
      const before = copiedLoader.bundleDigest();
      fs.appendFileSync(path.join(copiedPrompts, 'extraction.v1.js'), '\n');
      const after = copiedLoader.bundleDigest();
      assert.notEqual(after, before);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
