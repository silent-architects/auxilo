'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const indexLib = require('../lib/extraction-index.js');
const extractLocal = require('../scripts/extract-local.js');
const runner = require('../scripts/runner.js');
const {
  DEFAULT_FIXTURE,
  loadFixture,
} = require('../scripts/neardup-dryrun.js');

function tempIndex() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auxilo-spec3-f2-index-'));
  return {
    dir,
    file: path.join(dir, 'extracted-index.jsonl'),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

function learning(overrides = {}) {
  return {
    title: 'Node fetch retries require a fresh request body',
    body: 'When a streamed request fails, construct a fresh body before retrying because the original stream has already been consumed.',
    category: 'web-interaction',
    tags: ['node', 'fetch', 'retry'],
    task_context: 'Retry an HTTP request.',
    outcome: 'workaround',
    ...overrides,
  };
}

function modelJson(rows) {
  return { ok: true, out: JSON.stringify(rows), reason: null };
}

describe('SPEC3-F2 local extraction index', () => {
  it('appends an authoritative local row with body hash, body, timestamp, and returned learning id', () => {
    const tmp = tempIndex();
    try {
      const row = learning();
      const appended = indexLib.appendSubmittedLearning(
        row,
        { id: 'lrn_local_1', status: 'pending_review' },
        { indexPath: tmp.file, now: '2026-07-26T12:00:00.000Z' }
      );
      assert.equal(appended, true);
      const state = indexLib.readExtractionIndex({ indexPath: tmp.file });
      assert.equal(state.usable, true);
      assert.equal(state.rows.length, 1);
      assert.deepEqual(state.rows[0], {
        title: row.title,
        category: row.category,
        tags: row.tags,
        body_hash: crypto.createHash('sha256').update(row.body).digest('hex'),
        body: row.body,
        submitted_at: '2026-07-26T12:00:00.000Z',
        learning_id: 'lrn_local_1',
        status: 'pending_review',
      });
      assert.equal(fs.statSync(tmp.file).mode & 0o777, 0o600);
    } finally {
      tmp.cleanup();
    }
  });

  it('skips corrupt JSONL lines, logs loudly, and disables advisory dedup for that run', () => {
    const tmp = tempIndex();
    const logs = [];
    try {
      fs.writeFileSync(
        tmp.file,
        `${JSON.stringify(indexLib.localIndexRow(learning(), {}, {
          now: '2026-07-26T12:00:00.000Z',
        }))}\n{broken-json\n`,
        { mode: 0o600 }
      );
      const state = indexLib.readExtractionIndex({
        indexPath: tmp.file,
        log: (line) => logs.push(line),
      });
      assert.equal(state.state, 'corrupt');
      assert.equal(state.usable, false);
      assert.equal(state.rows.length, 1);
      assert.equal(state.bad_lines, 1);
      assert.ok(logs.some((line) => line.includes('skipping corrupt line 2')));
      assert.ok(logs.some((line) => line.includes('dedup are disabled')));
    } finally {
      tmp.cleanup();
    }
  });

  it('hydrates a missing index through authenticated, paginated metadata reads only', async () => {
    const tmp = tempIndex();
    const calls = [];
    const rows = Array.from({ length: 501 }, (_, index) => ({
      id: `lrn_hydrated_${index}`,
      title: `Hydrated lesson ${index}`,
      category: index % 2 ? 'monitoring' : 'code-execution',
      tags: ['hydrated'],
      status: index % 3 === 0 ? 'rejected' : 'approved',
      created_at: `2026-07-${String((index % 25) + 1).padStart(2, '0')}T00:00:00.000Z`,
      body: 'must never be copied even if a malformed server includes it',
    }));
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      const offset = Number(new URL(url).searchParams.get('offset'));
      const page = rows.slice(offset, offset + 500);
      return {
        ok: true,
        status: 200,
        json: async () => ({ total: rows.length, learnings: page }),
      };
    };
    try {
      const result = await indexLib.hydrateExtractionIndex({
        indexPath: tmp.file,
        fetchImpl,
        baseUrl: 'https://auxilo.test/',
        apiKey: 'axl_test',
        log: () => {},
      });
      assert.deepEqual(result, { hydrated: true, count: 501 });
      assert.equal(calls.length, 2);
      assert.ok(calls[0].url.endsWith('/account/learnings?limit=500&offset=0'));
      assert.ok(calls[1].url.endsWith('/account/learnings?limit=500&offset=500'));
      assert.equal(calls[0].init.headers['X-API-Key'], 'axl_test');

      const state = indexLib.readExtractionIndex({ indexPath: tmp.file });
      assert.equal(state.rows.length, 501);
      assert.ok(state.rows.every((row) => !Object.hasOwn(row, 'body')));
      assert.ok(state.rows.every((row) => row.body_hash === null));
    } finally {
      tmp.cleanup();
    }
  });

  it('fails open and leaves the fresh-machine index absent when hydration is unreachable', async () => {
    const tmp = tempIndex();
    const logs = [];
    try {
      const result = await indexLib.hydrateExtractionIndex({
        indexPath: tmp.file,
        fetchImpl: async () => { throw new Error('offline'); },
        baseUrl: 'https://auxilo.test',
        apiKey: 'axl_test',
        log: (line) => logs.push(line),
      });
      assert.deepEqual(result, { hydrated: false, reason: 'request_failed' });
      assert.equal(fs.existsSync(tmp.file), false);
      assert.ok(logs.some((line) => line.includes('extracting without memory')));
    } finally {
      tmp.cleanup();
    }
  });
});

describe('SPEC3-F2 prompt memory', () => {
  function rows(size) {
    return Array.from({ length: size }, (_, index) => ({
      title: `Previously captured lesson ${index} about a concrete operational failure`,
      body: `The operational behavior for fixture ${index} requires a specific workaround before the next action can safely continue.`,
      category: index % 4 === 0 ? 'monitoring' : 'code-execution',
      tags: ['fixture', `row-${index}`],
      submitted_at: new Date(Date.UTC(2026, 6, 1, 0, 0, index)).toISOString(),
      learning_id: `lrn_${index}`,
    }));
  }

  it('carries the drop-not-improve rule and prioritizes same-category rows before recency', () => {
    const memory = indexLib.buildPromptMemory([
      {
        title: 'Newest code lesson',
        category: 'code-execution',
        tags: [],
        submitted_at: '2026-07-26T12:00:00.000Z',
      },
      {
        title: 'Older monitoring lesson',
        category: 'monitoring',
        tags: [],
        submitted_at: '2026-07-01T12:00:00.000Z',
      },
    ], {
      transcript: 'The health monitor emitted an alert metric.',
      maxRows: 2,
    });
    assert.match(memory.section, /re-states any listed lesson/);
    assert.match(memory.section, /behavioral difference, not merely a wording difference/);
    assert.ok(
      memory.section.indexOf('Older monitoring lesson') <
      memory.section.indexOf('Newest code lesson')
    );
    assert.deepEqual(memory.category_hints, ['monitoring']);
  });

  it('holds the complete memory section under the token cap at index sizes 10, 100, and 1000', () => {
    const table = [10, 100, 1000].map((size) => {
      const memory = indexLib.buildPromptMemory(rows(size), {
        transcript: 'Run the code script in the Node runtime.',
      });
      return {
        size,
        tokens: memory.estimated_tokens,
        included: memory.included_count,
      };
    });
    assert.ok(table.every((row) => row.tokens <= indexLib.PROMPT_MEMORY_MAX_TOKENS));
    assert.ok(table.every((row) => row.included <= indexLib.PROMPT_MEMORY_MAX_ROWS));
    assert.ok(table[0].tokens <= table[1].tokens);
    assert.ok(table[1].tokens <= table[2].tokens);
    assert.ok(table[2].included < 1000, '1000-row index must be budget-capped');
  });

  it('omits the section completely when no usable rows exist', () => {
    assert.deepEqual(indexLib.buildPromptMemory([], {}), {
      section: '',
      estimated_tokens: 0,
      included_count: 0,
      category_hints: [],
    });
    const prompt = extractLocal.buildExtractionPrompt({ previousLessonsSection: '' });
    assert.doesNotMatch(prompt, /PREVIOUSLY CAPTURED LESSONS/);
  });
});

describe('SPEC3-F2 shared-detector post-filter and fail-open extraction', () => {
  it('drops a ground-truth flood re-extraction and keeps all three same-domain different lessons', () => {
    const fixture = loadFixture(DEFAULT_FIXTURE);
    const cluster = fixture.duplicate_clusters.find(
      (item) => item.id === 'published_ci_require_tier2_duplicate'
    );
    assert.ok(cluster);
    const duplicateIndex = {
      usable: true,
      rows: [{
        ...cluster.members[0],
        learning_id: cluster.members[0].id,
        submitted_at: cluster.members[0].created_at,
      }],
    };
    const duplicate = indexLib.filterIndexedNearDuplicates(
      [cluster.members[1]],
      duplicateIndex
    );
    assert.equal(duplicate.dropped.length, 1);
    assert.equal(duplicate.kept.length, 0);

    const byId = new Map([
      ...fixture.duplicate_clusters.flatMap((item) => item.members),
      ...fixture.clean_approved,
    ].map((row) => [row.id, row]));
    const negativeIds = [...new Set(fixture.same_domain_different_lesson_pairs.flat())];
    const negativeRows = negativeIds.map((id) => byId.get(id));
    assert.ok(negativeRows.every(Boolean));
    const negativeIndex = {
      usable: true,
      rows: [{
        ...negativeRows[0],
        learning_id: negativeRows[0].id,
        submitted_at: negativeRows[0].created_at,
      }],
    };
    const kept = indexLib.filterIndexedNearDuplicates(negativeRows.slice(1), negativeIndex);
    assert.equal(kept.dropped.length, 0);
    assert.equal(kept.kept.length, 2);
  });

  it('never runs lexical filtering against metadata-only hydrated rows', () => {
    const candidate = learning();
    const result = indexLib.filterIndexedNearDuplicates([candidate], {
      usable: true,
      rows: [{
        title: candidate.title,
        category: candidate.category,
        tags: candidate.tags,
        body_hash: null,
        submitted_at: '2026-07-26T12:00:00.000Z',
      }],
    });
    assert.equal(result.dropped.length, 0);
    assert.deepEqual(result.kept, [candidate]);
  });

  it('delete-the-index-mid-run keeps the candidate and logs the fail-open transition', async () => {
    const tmp = tempIndex();
    const logs = [];
    const candidate = learning();
    try {
      indexLib.appendSubmittedLearning(
        learning({
          title: 'An unrelated prior lesson about database transactions',
          body: 'A database transaction must be retried after serialization failure with a new transaction boundary and fresh reads.',
          category: 'storage-state',
        }),
        { id: 'lrn_prior', status: 'approved' },
        { indexPath: tmp.file, now: '2026-07-26T10:00:00.000Z' }
      );
      const result = await extractLocal.extractLocally(
        'A streamed Node fetch request failed during retry.',
        'claude-code',
        {
          indexPath: tmp.file,
          log: (line) => logs.push(line),
          invokeModel: async () => {
            fs.unlinkSync(tmp.file);
            return modelJson([candidate]);
          },
        }
      );
      assert.deepEqual(result.learnings, [candidate]);
      assert.equal(result.dedup_dropped, 0);
      assert.ok(logs.some((line) => line.includes('became missing during extraction')));
    } finally {
      tmp.cleanup();
    }
  });

  it('an unreachable hydration endpoint still invokes extraction without a memory section', async () => {
    const tmp = tempIndex();
    const logs = [];
    let capturedPrompt = null;
    try {
      const result = await extractLocal.extractLocally('A new technical transcript.', 'claude-code', {
        indexPath: tmp.file,
        baseUrl: 'https://auxilo.test',
        apiKey: 'axl_test',
        fetchImpl: async () => { throw new Error('offline'); },
        log: (line) => logs.push(line),
        invokeModel: async (_transcript, { prompt }) => {
          capturedPrompt = prompt;
          return modelJson([]);
        },
      });
      assert.deepEqual(result.learnings, []);
      assert.doesNotMatch(capturedPrompt, /PREVIOUSLY CAPTURED LESSONS/);
      assert.ok(logs.some((line) => line.includes('extracting without memory')));
    } finally {
      tmp.cleanup();
    }
  });
});

describe('SPEC3-F2 submission and packaging invariants', () => {
  it('appends only successful /learn submissions and preserves response ids', async () => {
    const tmp = tempIndex();
    let call = 0;
    const fetchImpl = async () => {
      call += 1;
      if (call === 1) {
        return {
          ok: true,
          json: async () => ({ id: 'lrn_saved', status: 'pending_review' }),
        };
      }
      if (call === 2) return { ok: false, json: async () => ({ error: 'invalid' }) };
      throw new Error('network');
    };
    try {
      const totals = await runner.submitLearnings(
        [learning(), learning(), learning()],
        'claude-code',
        {
          fetchImpl,
          baseUrl: 'https://auxilo.test',
          apiKey: 'axl_test',
          indexPath: tmp.file,
          now: '2026-07-26T12:00:00.000Z',
        }
      );
      assert.deepEqual(totals, { published: 0, held: 1, rejected: 2 });
      const state = indexLib.readExtractionIndex({ indexPath: tmp.file });
      assert.equal(state.rows.length, 1);
      assert.equal(state.rows[0].learning_id, 'lrn_saved');
    } finally {
      tmp.cleanup();
    }
  });

  it('packages every installed-runtime dependency and bumps the npm rider to 0.9.5', () => {
    const pkg = require('../package.json');
    const manifest = new Set(runner.sweeperManifest(path.join(__dirname, '..')).map(([src]) => src));
    assert.equal(pkg.version, '0.9.5');
    for (const file of [
      'lib/extraction-index.js',
      'lib/similarity.js',
      'config/near-duplicate.json',
    ]) {
      assert.ok(pkg.files.includes(file), `${file} must ship in npm`);
      assert.ok(manifest.has(file), `${file} must ship in installed sweepers`);
    }
  });

  it('leaves UC-0/UC-1 detection and the consent sentinel ahead of extraction work', () => {
    const runnerSource = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'runner.js'), 'utf8');
    const installerSource = fs.readFileSync(path.join(__dirname, '..', 'lib', 'installer.js'), 'utf8');
    const mainStart = runnerSource.indexOf('async function main()');
    const killSwitch = runnerSource.indexOf('fs.existsSync(KILL_SWITCH_PATH)', mainStart);
    const extraction = runnerSource.indexOf('postExtract(', mainStart);
    assert.ok(killSwitch > mainStart && killSwitch < extraction);
    assert.match(installerSource, /function detectClients/);
    assert.doesNotMatch(installerSource, /extraction-index/);
  });
});
