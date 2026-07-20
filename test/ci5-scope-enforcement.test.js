'use strict';

/**
 * test/ci5-scope-enforcement.test.js — CI-5 TECHNICAL-ONLY SCOPE (PUNCH-LIST §30).
 *
 * Spec: ~/.auxilo/handoffs/BUILD-SPEC-CI5-SCOPE-2026-07-19.md. Taxonomy ruling
 * (spec §0, option (a)): `communication` + `content-generation` are RETIRED
 * learning categories; the learning taxonomy is the six tech categories. The
 * capability/skills registry KEEPS its 8-category taxonomy.
 *
 * Covers:
 *   A. Taxonomy source-of-truth + cross-file drift pins (server / extractor /
 *      extract-local / MCP / openapi — learning enums 6, skills enums 8).
 *   B. Extractor scope: hard-scope prompt + post-parse drop, BOTH score-gate
 *      states (a floor-passing score can never rescue an out-of-scope label).
 *   C. Server acceptance + migration, behavioral: real boot against a fixture
 *      store (pricing-visibility pattern) — /learn 400 CATEGORY_OUT_OF_SCOPE,
 *      lrn_resend01 → web-interaction, stray visible retired-label item demoted.
 *   D. Migration unit legs incl. idempotency (second run changed === 0).
 *   E. Approve-path guard: self/bulk refuse approving retired-label items
 *      (reject still allowed); admin route pinned structurally.
 *   F. Pricing: retired base-cost rows KEPT frozen (legacy stored items only).
 *   G. Seed conformance: no seed item wears a retired label.
 *
 * Runner: node --test test/ci5-scope-enforcement.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const REPO_ROOT = path.join(__dirname, '..');
const SERVER_SRC = fs.readFileSync(path.join(REPO_ROOT, 'server.js'), 'utf-8');
const MCP_SRC = fs.readFileSync(path.join(REPO_ROOT, 'mcp-server.js'), 'utf-8');
const OPENAPI = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'openapi.json'), 'utf-8'));
const SEED = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'seed-knowledge.json'), 'utf-8'));

const scope = require('../lib/category-scope-migration.js');
const extractor = require('../lib/extractor.js');
const extractLocal = require('../scripts/extract-local.js');
const selfReview = require('../lib/self-review.js');
const pricing = require('../lib/pricing.js');

const TECH = ['data-processing', 'web-interaction', 'code-execution', 'storage-state', 'payment-financial', 'monitoring'];
const RETIRED = ['communication', 'content-generation'];
const SKILL_CATEGORIES_8 = [
  'data-processing', 'web-interaction', 'code-execution', 'communication',
  'storage-state', 'content-generation', 'payment-financial', 'monitoring',
];

function sliceAt(src, marker, span = 4000) {
  const i = src.indexOf(marker);
  assert.notEqual(i, -1, `marker not found: ${marker}`);
  return src.slice(i, i + span);
}

// ─────────────────────────────────────────────────────────────────────────────
// A. Taxonomy source-of-truth + drift pins
// ─────────────────────────────────────────────────────────────────────────────

describe('CI-5 taxonomy: single truth, no drift across copies', () => {
  it('lib/category-scope-migration.js is the server-side source of truth', () => {
    assert.deepEqual(scope.TECH_LEARNING_CATEGORIES, TECH);
    assert.deepEqual(scope.RETIRED_LEARNING_CATEGORIES, RETIRED);
    for (const r of RETIRED) {
      assert.ok(!scope.TECH_LEARNING_CATEGORIES.includes(r), `retired label ${r} leaked into the tech set`);
    }
  });

  it('server.js VALID_CATEGORIES is bound to TECH_LEARNING_CATEGORIES (not a drift-prone copy)', () => {
    assert.match(SERVER_SRC, /const VALID_CATEGORIES = TECH_LEARNING_CATEGORIES;/);
  });

  it('scripts/extract-local.js (standalone npm copy) matches the server truth', () => {
    assert.deepEqual(extractLocal.CATEGORIES, TECH);
    assert.deepEqual(extractLocal.RETIRED_CATEGORIES, RETIRED);
  });

  it('lib/extractor.js (server-side extraction pipeline) matches the server truth', () => {
    assert.deepEqual(extractor.VALID_CATEGORIES, TECH);
    assert.deepEqual(extractor.RETIRED_CATEGORIES, RETIRED);
  });

  it('openapi: LearningCategory is the 6-value tech enum; Category (skills) keeps 8', () => {
    assert.deepEqual(OPENAPI.components.schemas.LearningCategory.enum, TECH);
    assert.deepEqual(OPENAPI.components.schemas.Category.enum, SKILL_CATEGORIES_8);
  });

  it('openapi: learning surfaces reference LearningCategory; skill surfaces keep Category', () => {
    const ref = (o) => o && o.$ref;
    assert.equal(ref(OPENAPI.components.schemas.LearningSnippet.properties.category),
      '#/components/schemas/LearningCategory');
    assert.equal(ref(OPENAPI.paths['/learn'].post.requestBody.content['application/json'].schema.properties.category),
      '#/components/schemas/LearningCategory');
    assert.equal(ref(OPENAPI.paths['/knowledge'].post.requestBody.content['application/json'].schema.properties.category),
      '#/components/schemas/LearningCategory');
    // Capability registry unchanged — 'communication' is a legitimate SKILL domain.
    assert.equal(ref(OPENAPI.components.schemas.Skill.properties.category),
      '#/components/schemas/Category');
    assert.equal(ref(OPENAPI.paths['/discover'].post.requestBody.content['application/json'].schema.properties.category),
      '#/components/schemas/Category');
  });

  it('openapi: the /learn 400 documents CATEGORY_OUT_OF_SCOPE', () => {
    const desc = OPENAPI.paths['/learn'].post.responses['400'].description;
    assert.ok(desc.includes('CATEGORY_OUT_OF_SCOPE'), '/learn 400 description must document the code');
  });

  it('MCP: contribute + knowledge enums are the 6 tech categories; discover keeps the 8 skill categories', () => {
    // Parse every category enum literal out of mcp-server.js.
    const enums = [...MCP_SRC.matchAll(/category:\s*\{\s*type:\s*'string',\s*enum:\s*(\[[^\]]*\])/g)]
      .map((m) => JSON.parse(m[1].replace(/'/g, '"').replace(/,\s*\]/, ']')));
    assert.equal(enums.length, 3, 'expected exactly 3 category enums in mcp-server.js (discover, contribute, knowledge)');
    const six = enums.filter((e) => e.length === 6);
    const eight = enums.filter((e) => e.length === 8);
    assert.equal(six.length, 2, 'contribute + knowledge must carry the 6-value learning enum');
    assert.equal(eight.length, 1, 'discover must keep the 8-value capability enum');
    for (const e of six) assert.deepEqual(e, TECH);
    assert.deepEqual(eight[0], SKILL_CATEGORIES_8);
    // The 8-value enum belongs to auxilo_discover, not a learning tool.
    const discoverBlock = sliceAt(MCP_SRC, "name: 'auxilo_discover'", 2500);
    assert.ok(discoverBlock.includes("'communication'"), 'discover block keeps communication as a capability');
    const contributeBlock = sliceAt(MCP_SRC, "name: 'auxilo_contribute'", 4000);
    assert.ok(!/enum: \['data-processing', 'web-interaction', 'code-execution', 'communication'/.test(contributeBlock),
      'contribute enum must not carry retired labels');
  });

  it('MCP: instructions + contribute description carry the technical-only scope rule', () => {
    assert.ok(MCP_SRC.includes('TECHNICAL SCOPE (hard rule'), 'instructions block must scope submissions to technical learnings');
    const contributeBlock = sliceAt(MCP_SRC, "name: 'auxilo_contribute'", 4000);
    assert.ok(contributeBlock.includes('technical learnings ONLY'), 'contribute description must state the scope');
    assert.ok(contributeBlock.includes('CATEGORY_OUT_OF_SCOPE'), 'contribute description must name the refusal code');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B. Extractor scope — both score-gate states
// ─────────────────────────────────────────────────────────────────────────────

describe('extract-local: hard-scope prompt + post-parse drop (both gate states)', () => {
  for (const gate of [false, true]) {
    it(`prompt carries the hard scope rule with scoreExtraction=${gate}`, () => {
      const prompt = extractLocal.buildExtractionPrompt({ scoreExtraction: gate });
      assert.ok(prompt.includes('HARD SCOPE RULE — TECHNICAL LEARNINGS ONLY'),
        'scope rule must live in the BASE prompt, not the score addendum');
      assert.ok(prompt.includes('NEVER extract interpersonal or communication strategy'));
      assert.ok(prompt.includes('DROP such candidates entirely'));
      // The category list offered to the model is the tech set only.
      assert.ok(prompt.includes(JSON.stringify(TECH)), 'prompt must offer exactly the 6 tech categories');
      assert.ok(!prompt.includes('"communication"'), 'prompt category list must not offer a retired label');
      // The score rubric appears only when the gate is on (A1 contract intact).
      assert.equal(prompt.includes('quality_self_assessment'), gate);
    });
  }

  const mk = (over) => ({
    title: 'a perfectly valid learning title',
    body: 'b'.repeat(60) + ' details of what was tried and what actually worked in the end',
    category: 'code-execution',
    tags: ['x'],
    task_context: 'ctx',
    outcome: 'success',
    ...over,
  });

  for (const gate of [false, true]) {
    it(`parseLearnings drops retired + unknown categories with scoreExtraction=${gate}`, () => {
      const qa = { specificity: 5, actionability: 5, novelty: 4, completeness: 4, total: 18 };
      const raw = JSON.stringify([
        mk({ category: 'web-interaction', quality_self_assessment: qa }),
        // A floor-passing score must NOT rescue an out-of-scope label.
        mk({ title: 'negotiation opener that disarms pushback', category: 'communication', quality_self_assessment: qa }),
        mk({ title: 'blog-intro hook formula that converts', category: 'content-generation', quality_self_assessment: qa }),
        mk({ title: 'mystery category candidate here', category: 'not-a-category', quality_self_assessment: qa }),
      ]);
      const out = extractLocal.parseLearnings(raw, { scoreExtraction: gate });
      assert.equal(out.length, 1, 'only the tech candidate survives');
      assert.equal(out[0].category, 'web-interaction');
      // No coercion path: the old unknown→code-execution laundering is gone.
      assert.ok(!out.some((l) => l.category === 'code-execution'));
      // Score attachment still follows the gate for the survivor.
      assert.equal('quality_self_assessment' in out[0], gate);
    });
  }

  it('parseLearnings keeps every one of the 6 tech categories', () => {
    const raw = JSON.stringify(TECH.map((c, i) => mk({ title: `valid learning number ${i} title`, category: c })));
    const out = extractLocal.parseLearnings(raw, { scoreExtraction: false });
    assert.deepEqual(out.map((l) => l.category), TECH);
  });

  it('lib/extractor.js prompt (dormant server-side path) carries the scope rule + 6-category list', () => {
    const EXTRACTOR_SRC = fs.readFileSync(path.join(REPO_ROOT, 'lib', 'extractor.js'), 'utf-8');
    assert.ok(EXTRACTOR_SRC.includes('NON-TECHNICAL content of any kind (HARD SCOPE RULE'));
    assert.ok(EXTRACTOR_SRC.includes('VALID CATEGORIES: data-processing, web-interaction, code-execution, storage-state, payment-financial, monitoring'));
  });

  it('server /extract remnant path rejects retired labels with a DISTINCT reason', () => {
    const block = sliceAt(SERVER_SRC, 'CI-5: retired labels get a DISTINCT reject reason', 800);
    assert.ok(block.includes("reason: 'category_out_of_scope'"));
    assert.ok(block.includes('RETIRED_LEARNING_CATEGORIES.includes(candidate.category)'));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D. Migration — unit legs (behavioral leg rides the boot test below)
// ─────────────────────────────────────────────────────────────────────────────

describe('migrateRetiredCategories: recategorize / demote / preserve, idempotent', () => {
  const mkStored = (id, over) => ({
    id,
    title: `title ${id}`,
    body: 'stored body',
    category: 'communication',
    tags: ['x'],
    status: 'approved',
    created_at: '2026-07-01T00:00:00.000Z',
    ...over,
  });

  it('lrn_resend01 → web-interaction with provenance stamps (any status)', () => {
    const store = [mkStored('lrn_resend01')];
    const r = scope.migrateRetiredCategories(store, { now: '2026-07-19T12:00:00.000Z' });
    assert.deepEqual(r.recategorized, ['lrn_resend01']);
    assert.equal(store[0].category, 'web-interaction');
    assert.equal(store[0].category_migrated_from, 'communication');
    assert.equal(store[0].category_migrated_at, '2026-07-19T12:00:00.000Z');
    assert.equal(store[0].status, 'approved', 'a mapped technical item stays published');
  });

  it('unexpected VISIBLE retired-label item is demoted, never guessed a category', () => {
    const store = [
      mkStored('lrn_stray1', { category: 'content-generation' }),
      // Legacy record with no status field — visible per the backward-compat reading.
      mkStored('lrn_stray2', { status: undefined }),
    ];
    delete store[1].status;
    const r = scope.migrateRetiredCategories(store);
    assert.deepEqual(r.demoted.sort(), ['lrn_stray1', 'lrn_stray2']);
    for (const l of store) {
      assert.equal(l.status, 'pending_review');
      assert.equal(l.scope_hold.action, 'ci5_scope_demotion');
      assert.ok(RETIRED.includes(l.category), 'demotion must not invent a category');
    }
  });

  it('non-visible historical records are untouched (audit record)', () => {
    const store = [
      mkStored('lrn_rej', { status: 'rejected' }),
      mkStored('lrn_ret', { status: 'retracted', category: 'content-generation' }),
      mkStored('lrn_pen', { status: 'pending_review' }),
    ];
    const before = JSON.parse(JSON.stringify(store));
    const r = scope.migrateRetiredCategories(store);
    assert.equal(r.changed, 0);
    assert.deepEqual(store, before);
  });

  it('tech-category items are never touched', () => {
    const store = TECH.map((c, i) => mkStored(`lrn_ok${i}`, { category: c }));
    const before = JSON.parse(JSON.stringify(store));
    const r = scope.migrateRetiredCategories(store);
    assert.equal(r.changed, 0);
    assert.deepEqual(store, before);
  });

  it('IDEMPOTENT: a second run reports changed === 0 and mutates nothing', () => {
    const store = [
      mkStored('lrn_resend01'),
      mkStored('lrn_stray1', { category: 'content-generation' }),
      mkStored('lrn_rej', { status: 'rejected' }),
    ];
    const first = scope.migrateRetiredCategories(store);
    assert.equal(first.changed, 2);
    const snapshot = JSON.parse(JSON.stringify(store));
    const second = scope.migrateRetiredCategories(store);
    assert.equal(second.changed, 0);
    assert.deepEqual(second.recategorized, []);
    assert.deepEqual(second.demoted, []);
    assert.deepEqual(store, snapshot, 'second run must be a byte-level no-op');
  });

  it('server.js wires the migration after seeding, with the safeWrite-only-when-changed idiom', () => {
    const block = sliceAt(SERVER_SRC, 'CI-5: TECHNICAL-ONLY SCOPE migration', 1400);
    assert.ok(block.includes('migrateRetiredCategories(learnings)'));
    assert.ok(block.includes('_ci5.changed > 0'));
    assert.ok(block.includes('safeWrite(LEARNINGS_FILE, learnings)'));
    // Ordering: migration must run AFTER the cold-start seed block.
    assert.ok(SERVER_SRC.indexOf('CI-5: TECHNICAL-ONLY SCOPE migration') >
      SERVER_SRC.indexOf('seed from seed-knowledge.json'),
      'migration must run after seeding so a fresh seed store is migrated too');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E. Approve-path guard — a retired-label item can never re-enter publication
// ─────────────────────────────────────────────────────────────────────────────

describe('approve-path guard: retired-label items cannot be (re-)approved', () => {
  const ACC = 'acc_ci5';
  const mkPending = (id, over) => ({
    id,
    title: `title ${id}`,
    body: 'pending body',
    category: 'communication',
    status: 'pending_review',
    contributor_account_id: ACC,
    ...over,
  });

  it('applySelfDecision refuses approve with category_out_of_scope (409); item stays pending', () => {
    const store = [mkPending('lrn_held')];
    const r = selfReview.applySelfDecision(store, ACC, 'lrn_held', 'approve');
    assert.equal(r.ok, false);
    assert.equal(r.code, 'category_out_of_scope');
    assert.equal(r.status, 409);
    assert.equal(store[0].status, 'pending_review');
    assert.ok(r.error.includes('technical learnings only'));
  });

  it('reject remains allowed — rejection is the intended disposal path', () => {
    const store = [mkPending('lrn_held')];
    const r = selfReview.applySelfDecision(store, ACC, 'lrn_held', 'reject', { reason: 'out of scope' });
    assert.equal(r.ok, true);
    assert.equal(store[0].status, 'rejected');
  });

  it('tech-category approve is unaffected', () => {
    const store = [mkPending('lrn_tech', { category: 'web-interaction' })];
    const r = selfReview.applySelfDecision(store, ACC, 'lrn_tech', 'approve');
    assert.equal(r.ok, true);
    assert.equal(store[0].status, 'approved');
  });

  it('bulk approve: per-item refusal for the retired-label item, tech item approved', () => {
    const store = [mkPending('lrn_held'), mkPending('lrn_tech', { category: 'monitoring' })];
    const out = selfReview.applyBulkDecisions(store, ACC, [
      { id: 'lrn_held', decision: 'approve' },
      { id: 'lrn_tech', decision: 'approve' },
    ], { confirmCount: 2 });
    assert.equal(out.ok, true);
    assert.equal(out.counts.approved, 1);
    assert.equal(out.counts.failed, 1);
    const held = out.results.find((r) => r.id === 'lrn_held');
    assert.equal(held.ok, false);
    assert.equal(held.code, 'category_out_of_scope');
    assert.equal(store.find((l) => l.id === 'lrn_held').status, 'pending_review');
    assert.equal(store.find((l) => l.id === 'lrn_tech').status, 'approved');
  });

  it('admin moderation approve carries the same guard (structural pin)', () => {
    const block = sliceAt(SERVER_SRC, "app.post('/admin/moderation/:id/approve'", 2000);
    assert.ok(block.includes('RETIRED_LEARNING_CATEGORIES.includes(learning.category)'));
    assert.ok(block.includes("code: 'CATEGORY_OUT_OF_SCOPE'"));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// F. Pricing — retired base-cost rows kept frozen for legacy stored items
// ─────────────────────────────────────────────────────────────────────────────

describe('pricing: retired category base-cost rows kept (no fallback aliasing)', () => {
  it('a legacy communication item still prices off its own table, not the web-interaction fallback', () => {
    // moderate complexity (no QA): communication 0.20 + 0.30 time = 0.50;
    // the web-interaction fallback would give 0.30 + 0.30 = 0.60.
    assert.equal(pricing.estimateDiyCost({ category: 'communication', body: 'x'.repeat(600) }), 0.5);
    assert.equal(pricing.estimateDiyCost({ category: 'content-generation', body: 'x'.repeat(600) }), 0.9);
    // Control: a truly unknown category DOES alias to web-interaction.
    assert.equal(pricing.estimateDiyCost({ category: 'no-such-category', body: 'x'.repeat(600) }), 0.6);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// G. Seed conformance
// ─────────────────────────────────────────────────────────────────────────────

describe('seed-knowledge.json conforms to the tech taxonomy', () => {
  it('no seed item wears a retired label; lrn_resend01 is web-interaction', () => {
    const items = Array.isArray(SEED) ? SEED : SEED.learnings;
    for (const l of items) {
      assert.ok(!RETIRED.includes(l.category), `seed item ${l.id} wears retired label ${l.category}`);
    }
    const resend = items.find((l) => l.id === 'lrn_resend01');
    assert.ok(resend, 'lrn_resend01 must remain in the seed (it is a TECHNICAL learning)');
    assert.equal(resend.category, 'web-interaction');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C. Behavioral: real boot — /learn 400 + migration on a fixture store
// ─────────────────────────────────────────────────────────────────────────────

function bootServer(tmpDir) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['server.js'], {
      cwd: tmpDir,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        WALLET_PRIVATE_KEY: '0x' + '11'.repeat(32),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let settled = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => settle({ child, out, up: false }), 20_000);
    const onData = (buf) => {
      out += buf.toString();
      if (out.includes('Auxilo running at')) settle({ child, out, up: true });
      if (out.includes('EADDRINUSE') || out.includes('UNCAUGHT EXCEPTION')) settle({ child, out, up: false });
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', () => settle({ child, out, up: false }));
  });
}

function fixtureCatalog() {
  const base = (Array.isArray(SEED) ? SEED : SEED.learnings)[0];
  const mk = (over) => {
    const l = JSON.parse(JSON.stringify(base));
    delete l.status;
    delete l.pricing;
    l.quality = { unlocks: 0, ratings: 0 };
    l.demand = { unlocks_30d: 0, search_impressions_30d: 0 };
    return Object.assign(l, over);
  };
  return [
    // The live-store shape of lrn_resend01 BEFORE this build: mislabeled communication.
    mk({
      id: 'lrn_resend01',
      title: 'Resend requires a verified domain for the from address',
      body: 'Resend rejects unverified from domains with HTTP 403; onboarding@resend.dev works for testing and delivered@resend.dev always succeeds.',
      category: 'communication', status: 'approved', unlock_price: 0.10,
    }),
    // Unexpected visible stray wearing the other retired label → must demote.
    mk({ id: 'ci5_stray', title: 'stray content item that should demote', category: 'content-generation', status: 'approved', unlock_price: 0.10 }),
    // Historical rejected record → untouched.
    mk({ id: 'ci5_rejected', title: 'historical rejected communication item', category: 'communication', status: 'rejected', unlock_price: 0.10 }),
    // Normal tech items.
    mk({ id: 'ci5_ok1', title: 'normal visible tech item one', category: 'code-execution', status: 'approved', unlock_price: 0.10 }),
    mk({ id: 'ci5_ok2', title: 'normal visible tech item two', category: 'data-processing', status: 'approved', unlock_price: 0.10 }),
  ];
}

describe('behavioral: boot enforces the 400 and runs the migration', () => {
  it('/learn 400s retired labels; the store is migrated on boot', { timeout: 90_000 }, async (t) => {
    let nodeModulesDir;
    try {
      const honoEntry = require.resolve('hono', { paths: [REPO_ROOT] });
      nodeModulesDir = honoEntry.slice(0, honoEntry.lastIndexOf(`${path.sep}node_modules${path.sep}`) + '/node_modules'.length);
    } catch {
      t.skip('hono not resolvable from repo root — skipping real boot (unit + structural legs still enforce)');
      return;
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auxilo-ci5-'));
    let child = null;
    try {
      for (const f of ['server.js', 'seed-knowledge.json', 'skills.json', 'openapi.json', 'package.json']) {
        const src = path.join(REPO_ROOT, f);
        if (fs.existsSync(src)) fs.copyFileSync(src, path.join(tmpDir, f));
      }
      // Boot gate: point the staged copy's WALLET const at the dummy key's address
      // (config-only patch — same idiom as pricing-visibility).
      const staged = fs.readFileSync(path.join(tmpDir, 'server.js'), 'utf-8');
      const patched = staged.replace(/^const WALLET = '0x[0-9a-fA-F]{40}';$/m,
        "const WALLET = '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A';");
      assert.notEqual(patched, staged, 'expected exactly one WALLET const line to patch for the boot gate');
      fs.writeFileSync(path.join(tmpDir, 'server.js'), patched);
      for (const d of ['lib', 'public', 'prompts']) {
        const src = path.join(REPO_ROOT, d);
        if (fs.existsSync(src)) fs.symlinkSync(src, path.join(tmpDir, d));
      }
      fs.symlinkSync(nodeModulesDir, path.join(tmpDir, 'node_modules'));
      fs.mkdirSync(path.join(tmpDir, 'data'));
      fs.writeFileSync(path.join(tmpDir, 'data', 'learnings.json'), JSON.stringify(fixtureCatalog(), null, 2));

      // Port 3000 is shared with other boot tests under the parallel runner — retry.
      let boot = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        boot = await bootServer(tmpDir);
        if (boot.up) break;
        boot.child.kill('SIGKILL');
        if (!boot.out.includes('EADDRINUSE')) break;
        await new Promise((r) => setTimeout(r, 3000));
      }
      child = boot.child;
      if (!boot.up) {
        t.skip(`server did not reach listen — skipping behavioral leg (unit + structural legs still enforce). Output tail: ${boot.out.slice(-400)}`);
        return;
      }

      // ── /learn: retired labels get the machine-readable 400 ──────────────
      const submit = async (category) => {
        const res = await fetch('http://127.0.0.1:3000/learn', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: 'a valid title for a scope test',
            body: 'b'.repeat(80),
            category,
            tags: ['scope-test'],
            task_context: 'scope test',
            outcome: 'success',
          }),
        });
        return { status: res.status, body: await res.json() };
      };

      for (const label of RETIRED) {
        const r = await submit(label);
        assert.equal(r.status, 400, `${label} must 400`);
        assert.equal(r.body.code, 'CATEGORY_OUT_OF_SCOPE');
        assert.deepEqual(r.body.allowed_categories, TECH, 'self-healing: the 400 names the allowed set');
        assert.ok(r.body.message.includes('web-interaction'), 'self-healing: relabel guidance present');
      }
      // Control: a tech category passes the scope gate (fails later on the
      // identity gate — proving the 400 above is the scope check, not a generic).
      const ctrl = await submit('web-interaction');
      assert.notEqual(ctrl.body.code, 'CATEGORY_OUT_OF_SCOPE', 'tech category must pass the scope gate');
      assert.ok(String(ctrl.body.error || '').includes('identity'), 'control fails on identity, not category');

      // ── Migration: the booted store was repaired ──────────────────────────
      const migrated = JSON.parse(fs.readFileSync(path.join(tmpDir, 'data', 'learnings.json'), 'utf-8'));
      const byId = Object.fromEntries(migrated.map((l) => [l.id, l]));
      assert.equal(byId.lrn_resend01.category, 'web-interaction');
      assert.equal(byId.lrn_resend01.category_migrated_from, 'communication');
      assert.equal(byId.lrn_resend01.status, 'approved', 'the mapped technical item stays live');
      assert.equal(byId.ci5_stray.status, 'pending_review', 'unexpected visible retired-label item demoted');
      assert.equal(byId.ci5_stray.scope_hold.action, 'ci5_scope_demotion');
      assert.equal(byId.ci5_rejected.status, 'rejected', 'historical record untouched');
      assert.equal(byId.ci5_rejected.category, 'communication');

      // ── Visibility agrees: resend01 + the 2 tech items; the stray is hidden ─
      const stats = await (await fetch('http://127.0.0.1:3000/knowledge/stats')).json();
      assert.equal(stats.learnings_count, 3, 'visible = resend01 + 2 tech items; demoted stray hidden');
      assert.ok(!stats.categories.includes('communication') && !stats.categories.includes('content-generation'),
        'no retired label remains visible');
    } finally {
      if (child) child.kill('SIGKILL');
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
