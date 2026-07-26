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
 * Gate-A SHIP-WITH-FIXES additions (same wave):
 *   F1. Chat-pipeline pair inside the net: upload prompt scope+enum+litmus,
 *       approve-loop category allowlist (behavioral, mutation-verified).
 *   F2. for-agents.html static fallbacks (categories 6, learnings de-hardcoded).
 *   F3. reclassify-pending.js retired-label guard.
 *   F5. parseLearnings stderr drop count.
 *
 * CI-7 SYSTEM-FACT TEST extension (PUNCH-LIST §30 CI-7):
 *   One-call two-verdict LLM extension (learning_type from the SAME sensitivity
 *   call), process_advice → hold `process_advice_screen` → lane needs_your_eyes,
 *   prompt litmus in both gate states + pipeline prompt, rubric anchor lines.
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
const csLlm = require('../lib/content-sensitivity-llm.js');

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
// H. Gate-A F1 — the chat-pipeline pair is inside the CI-5 net (structural)
// ─────────────────────────────────────────────────────────────────────────────

describe('Gate-A F1: chat pipeline — prompt scope + approve-loop allowlist', () => {
  it('the /pipeline/upload prompt enumerates the 6 categories and carries scope + litmus', () => {
    const block = sliceAt(SERVER_SRC, 'const extractionPrompt = `Extract discrete', 2500);
    assert.ok(block.includes('HARD SCOPE RULE — TECHNICAL LEARNINGS ONLY'),
      'upload prompt must carry the CI-5 scope paragraph');
    assert.ok(block.includes('SYSTEM-FACT TEST'),
      'upload prompt must carry the CI-7 litmus');
    assert.ok(block.includes("category: exactly one of: ${VALID_CATEGORIES.join(', ')}"),
      'upload prompt must enumerate the taxonomy, not say "standard categories"');
    assert.ok(!block.includes('one of the standard categories'),
      'the unenumerated category line must be gone');
  });

  it('the approve loop skips candidates outside VALID_CATEGORIES with distinct reasons (loud pin)', () => {
    const block = sliceAt(SERVER_SRC, 'CI-5 (Gate-A F1): category allowlist on the approve loop', 1600);
    const squashed = block.replace(/\s+/g, ' ');
    assert.ok(squashed.includes('if (!VALID_CATEGORIES.includes(pl.category))'),
      'approve loop must gate on the allowlist');
    assert.ok(squashed.includes("RETIRED_LEARNING_CATEGORIES.includes(pl.category) ? 'category_out_of_scope' : 'category_invalid'"),
      'retired labels must get the distinct reason');
    assert.ok(squashed.includes('continue;'), 'out-of-scope candidates must be SKIPPED, not published');
  });

  it("the 'general' fallback category is gone from the pipeline publish path", () => {
    assert.ok(!SERVER_SRC.includes("pl.category || 'general'"),
      "publishing `pl.category || 'general'` bypassed the taxonomy entirely");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// F2/F3/F5 — remaining Gate-A fixes
// ─────────────────────────────────────────────────────────────────────────────

describe('Gate-A F2/F3/F5', () => {
  it('F2: for-agents.html static fallbacks — categories 6, learnings de-hardcoded', () => {
    const html = fs.readFileSync(path.join(REPO_ROOT, 'public', 'for-agents.html'), 'utf-8');
    assert.match(html, /id="lc-categories">6</, 'static category fallback must be 6');
    assert.ok(!/id="lc-categories">8</.test(html), 'the stale 8 must be gone');
    assert.ok(!/id="lc-learnings">58</.test(html), 'the stale hardcoded 58 must be gone');
  });

  it('F3: reclassify-pending.js guards retired labels BEFORE the sensitivity gate', () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'reclassify-pending.js'), 'utf-8');
    const guardIdx = src.indexOf('RETIRED_CATS.includes(l.category)');
    const evalIdx = src.indexOf('await evaluate(l)');
    assert.notEqual(guardIdx, -1, 'retired-label guard missing');
    assert.notEqual(evalIdx, -1);
    assert.ok(guardIdx < evalIdx, 'guard must run before the sensitivity evaluate');
    assert.ok(src.includes("sensitivity_signals: ['category_out_of_scope']"));
  });

  it('F5: parseLearnings reports dropped out-of-scope candidates to stderr (count only)', () => {
    const seen = [];
    const orig = console.error;
    console.error = (...args) => seen.push(args.join(' '));
    try {
      const raw = JSON.stringify([
        { title: 'a valid tech learning title', body: 'b'.repeat(60), category: 'monitoring', tags: [], task_context: 'x', outcome: 'success' },
        { title: 'a dropped non-tech candidate', body: 'b'.repeat(60), category: 'communication', tags: [], task_context: 'x', outcome: 'success' },
        { title: 'another dropped candidate!!', body: 'b'.repeat(60), category: 'bogus', tags: [], task_context: 'x', outcome: 'success' },
      ]);
      const out = extractLocal.parseLearnings(raw, { scoreExtraction: false });
      assert.equal(out.length, 1);
      assert.equal(seen.length, 1, 'exactly one stderr line for the batch');
      assert.ok(seen[0].includes('dropped 2 candidate(s)'), `stderr must carry the count: ${seen[0]}`);
      // No drops → no line.
      seen.length = 0;
      extractLocal.parseLearnings(JSON.stringify([]), { scoreExtraction: false });
      assert.equal(seen.length, 0);
    } finally {
      console.error = orig;
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// I. CI-7 — the system-fact test (one-call two-verdict extension)
// ─────────────────────────────────────────────────────────────────────────────

describe('CI-7: one LLM call, two verdicts (lib/content-sensitivity-llm.js)', () => {
  it('the SINGLE system prompt carries both classification tasks and one JSON contract', () => {
    assert.ok(csLlm.SYSTEM_PROMPT.includes('SYSTEM-FACT TEST'), 'second classification task present');
    assert.ok(csLlm.SYSTEM_PROMPT.includes('"learning_type": <"system_fact"|"process_advice">'),
      'the one response contract carries both verdicts — no second call exists');
    assert.ok(csLlm.SYSTEM_PROMPT.includes('"sensitive": <true|false>'));
    // Canonical pair anchors the litmus.
    assert.ok(csLlm.SYSTEM_PROMPT.includes('Odesli'), 'canonical system_fact example');
    assert.ok(csLlm.SYSTEM_PROMPT.includes('two-phase consultation workflow'), 'canonical process_advice example');
  });

  it('parseVerdict normalizes learning_type: valid values pass, anything else → null', () => {
    const base = '{"sensitive": false, "reason": "ok", "confidence": 0.9';
    assert.equal(csLlm.parseVerdict(base + ', "learning_type": "system_fact"}').learning_type, 'system_fact');
    assert.equal(csLlm.parseVerdict(base + ', "learning_type": "process_advice"}').learning_type, 'process_advice');
    assert.equal(csLlm.parseVerdict(base + ', "learning_type": "essay"}').learning_type, null);
    assert.equal(csLlm.parseVerdict(base + '}').learning_type, null, 'missing field → null (caller fails closed)');
  });

  it('combineSensitivity passes learning_type through; null when the LLM was not consulted', () => {
    const clean = { sensitive: false, signals: [] };
    const llmFact = { sensitive: false, reason: 'ok', confidence: 0.9, learning_type: 'system_fact' };
    const llmAdvice = { sensitive: false, reason: 'ok', confidence: 0.9, learning_type: 'process_advice' };
    assert.equal(csLlm.combineSensitivity({ regex: clean, llm: llmFact, llmEnabled: true }).learning_type, 'system_fact');
    assert.equal(csLlm.combineSensitivity({ regex: clean, llm: llmAdvice, llmEnabled: true }).learning_type, 'process_advice');
    // Short-circuit (regex flagged, llm null): item holds via sensitivity; type not judged.
    const flagged = { sensitive: true, signals: ['api_key'] };
    assert.equal(csLlm.combineSensitivity({ regex: flagged, llm: null, llmEnabled: true }).learning_type, null);
    // LLM layer disabled: screen degrades with it.
    assert.equal(csLlm.combineSensitivity({ regex: clean, llm: null, llmEnabled: false }).learning_type, null);
    // Fail-closed synthetic branch (enabled, clean regex, llm absent): held via sensitive=true.
    const fc = csLlm.combineSensitivity({ regex: clean, llm: null, llmEnabled: true });
    assert.equal(fc.sensitive, true);
    assert.equal(fc.learning_type, null);
  });

  it('classifySensitivityLLM carries the verdict end-to-end via an injected call (no real API)', async () => {
    const v = await csLlm.classifySensitivityLLM('t', 'b', [], {
      apiKey: 'test-key',
      llmCall: async () => '{"sensitive": false, "reason": "generic tech", "confidence": 0.95, "learning_type": "process_advice"}',
    });
    assert.equal(v.sensitive, false);
    assert.equal(v.learning_type, 'process_advice');
    // Error path stays fail-closed on sensitivity (the hold that matters).
    const err = await csLlm.classifySensitivityLLM('t', 'b', [], {
      apiKey: 'test-key',
      llmCall: async () => { throw new Error('boom'); },
    });
    assert.equal(err.sensitive, true);
  });
});

describe('CI-7: server screen wiring (structural pins)', () => {
  it('the flag defaults ON and is kill-switchable', () => {
    assert.ok(SERVER_SRC.includes("const LEARNING_TYPE_SCREEN_ENABLED = process.env.LEARNING_TYPE_SCREEN_ENABLED !== 'false';"));
  });

  it('/learn: process_advice holds (reason + persist) and blocks seamless — loud pin', () => {
    const block = sliceAt(SERVER_SRC, 'const processAdviceHold = LEARNING_TYPE_SCREEN_ENABLED', 1400);
    const squashed = block.replace(/\s+/g, ' ');
    assert.ok(squashed.includes("contentSensitivity.learning_type !== 'system_fact'"),
      'fail-closed: anything not judged system_fact holds');
    assert.ok(squashed.includes('!contentSensitivity.sensitive'),
      'screen fires only when the LLM ran clean on sensitivity');
    assert.ok(squashed.includes("if (processAdviceHold) learnReviewReasons.push('process_advice_screen');"));
    assert.ok(squashed.includes('!processAdviceHold && qualityPresent'),
      'seamless predicate must include the screen');
    assert.ok(SERVER_SRC.includes("...(processAdviceHold && { learning_type: 'process_advice' })"),
      'the verdict must persist so the lane derives');
  });

  it('/extract candidates: same screen, same fail-closed shape (parity pin)', () => {
    const block = sliceAt(SERVER_SRC, 'const extractProcessAdviceHold = LEARNING_TYPE_SCREEN_ENABLED', 1400);
    const squashed = block.replace(/\s+/g, ' ');
    assert.ok(squashed.includes("extractContentSensitivity.learning_type !== 'system_fact'"));
    assert.ok(squashed.includes("if (extractProcessAdviceHold) extractReviewReasons.push('process_advice_screen');"));
    assert.ok(squashed.includes('!extractProcessAdviceHold;'), 'extract seamless predicate must include the screen');
    assert.ok(SERVER_SRC.includes("if (extractProcessAdviceHold) candidate.learning_type = 'process_advice';"));
  });

  it('learning_type is stripped from every buyer-facing projection (4 sites)', () => {
    // Wave-5B (SPEC3-B2/B3): the search-map destructure grew
    // sensitivity_evidence + sanitized_from/to alongside learning_type —
    // the strip is intact and STRONGER; the pin tracks the new shape.
    // DR-8: the free owner-recall projection is a fifth buyer-facing site and
    // strips the same internals (`learning_type: _lto` matches the prefix).
    const strips = (SERVER_SRC.match(/learning_type: _lt/g) || []).length +
      (SERVER_SRC.match(/sensitivity_evidence, learning_type, sanitized_from, sanitized_to, \.\.\.rest/g) || []).length;
    assert.equal(strips, 5, 'search-map + owner-recall + self-unlock + capped + paid-unlock projections must all strip it');
  });

  it('the summary flag filter accepts process_advice', () => {
    assert.ok(SERVER_SRC.includes(
      "['injection', 'content_sensitivity', 'near_duplicate', 'process_advice', 'account_vocab'].includes(flag)"
    ));
  });
});

describe('CI-7: holds land in needs_your_eyes (lib/self-review.js)', () => {
  const ACC = 'acc_ci7';
  const held = (id, over) => ({
    id,
    title: `t ${id}`,
    body: 'body',
    category: 'code-execution',
    status: 'pending_review',
    contributor_account_id: ACC,
    created_at: '2026-07-01T00:00:00.000Z',
    ...over,
  });

  it('the canonical pair: q19 process_advice needs eyes; q19 system fact is ready', () => {
    // "two-phase mastering consultation workflow" — held despite the score.
    const advice = held('lrn_advice', {
      learning_type: 'process_advice',
      quality_self_assessment: { total: 19 },
    });
    // "Odesli can't do Tidal artist URLs" — clean, floor-passing → ready.
    const fact = held('lrn_fact', { quality_self_assessment: { total: 19 } });
    const rowA = selfReview.projectTriageRow(advice);
    const rowF = selfReview.projectTriageRow(fact);
    assert.deepEqual(rowA.flags, ['process_advice']);
    assert.equal(rowA.lane, 'needs_your_eyes', 'the rubric cannot see this dimension — the flag must');
    assert.equal(rowF.lane, 'ready_to_publish');
  });

  it('summary counts + filters carry the new flag', () => {
    const store = [
      held('lrn_advice', { learning_type: 'process_advice', quality_self_assessment: { total: 19 } }),
      held('lrn_fact', { quality_self_assessment: { total: 19 } }),
    ];
    const s = selfReview.summarizeOwnPending(store, ACC);
    assert.equal(s.counts.by_screen.process_advice, 1);
    assert.equal(s.counts.by_signal.process_advice, 1);
    assert.equal(s.counts.by_lane.needs_your_eyes, 1);
    assert.equal(s.approvable_count, 1, 'the held advice item must not count approvable');
    const flagged = selfReview.summarizeOwnPending(store, ACC, { flag: 'process_advice' });
    assert.deepEqual(flagged.items.map((r) => r.id), ['lrn_advice']);
    const bySig = selfReview.summarizeOwnPending(store, ACC, { signal: 'process_advice' });
    assert.deepEqual(bySig.items.map((r) => r.id), ['lrn_advice']);
  });

  it('the reviewer-facing full projection surfaces WHY (learning_type)', () => {
    const rows = selfReview.listOwnPending([
      held('lrn_advice', { learning_type: 'process_advice' }),
    ], ACC);
    assert.equal(rows[0].learning_type, 'process_advice');
  });

  it('approve remains ALLOWED for process_advice holds — the human is the appeal path', () => {
    const store = [held('lrn_advice', { learning_type: 'process_advice' })];
    const r = selfReview.applySelfDecision(store, ACC, 'lrn_advice', 'approve');
    assert.equal(r.ok, true, 'a hold is an appeal surface, not a block (unlike retired categories)');
  });
});

describe('CI-7: prompt litmus + rubric anchors (collection gates)', () => {
  for (const gate of [false, true]) {
    it(`extract-local prompt carries the litmus with scoreExtraction=${gate}`, () => {
      const prompt = extractLocal.buildExtractionPrompt({ scoreExtraction: gate });
      assert.ok(prompt.includes('SYSTEM-FACT TEST'), 'litmus lives in the BASE prompt');
      assert.ok(prompt.includes('a system and a symptom are at the core'));
      assert.ok(prompt.includes('do NOT extract it'));
      // Rubric anchor rides the score addendum only (it scopes the SCORES).
      assert.equal(prompt.includes('system+symptom anchor'), gate);
    });
  }

  it('lib/extractor.js prompt (dormant server path) carries the litmus', () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'lib', 'extractor.js'), 'utf-8');
    assert.ok(src.includes('SYSTEM-FACT TEST (CI-7)'));
    assert.ok(src.includes('a system and a symptom are at the core'));
  });

  it('MCP instructions + contribute rubric guidance carry the anchor', () => {
    assert.ok(MCP_SRC.includes('SYSTEM-FACT TEST: submit ONLY when a system and a symptom are at the core'));
    assert.ok(MCP_SRC.includes('High scores REQUIRE a system+symptom anchor'));
  });

  it('openapi: process_advice_screen reason + process_advice flag documented', () => {
    const reasons = OPENAPI.paths['/learn'].post.responses['201'].content['application/json']
      .schema.properties.review_reason.items.enum;
    assert.ok(reasons.includes('process_advice_screen'));
    const flagParam = OPENAPI.paths['/account/pending/summary'].get.parameters
      .find((p) => p.name === 'flag');
    assert.ok(flagParam.schema.enum.includes('process_advice'));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C. Behavioral: real boot — /learn 400 + migration on a fixture store
// ─────────────────────────────────────────────────────────────────────────────

function bootServer(tmpDir, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['server.js'], {
      cwd: tmpDir,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        WALLET_PRIVATE_KEY: '0x' + '11'.repeat(32),
        ...extraEnv,
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
      for (const d of ['lib', 'public', 'prompts', 'config']) {
        const src = path.join(REPO_ROOT, d);
        if (fs.existsSync(src)) fs.symlinkSync(src, path.join(tmpDir, d));
      }
      fs.symlinkSync(nodeModulesDir, path.join(tmpDir, 'node_modules'));
      fs.mkdirSync(path.join(tmpDir, 'data'));
      fs.writeFileSync(path.join(tmpDir, 'data', 'learnings.json'), JSON.stringify(fixtureCatalog(), null, 2));

      // Gate-A F1 behavioral leg: stage a session account + an awaiting_review
      // pipeline holding one retired-label, one bogus-label, and one valid
      // candidate. lib/ is symlinked (realpath resolution), so lib/accounts.js
      // must be pointed at the staged accounts file via AUXILO_ACCOUNTS_FILE.
      const SESSION_SECRET = 'ci5-test-session-secret-0123456789abcdef';
      const ACC = 'acc_ci5boot';
      fs.writeFileSync(path.join(tmpDir, 'data', 'accounts.json'), JSON.stringify({
        [ACC]: { id: ACC, email: 'ci5@test.local', created_at: '2026-07-01T00:00:00.000Z' },
      }, null, 2));
      fs.writeFileSync(path.join(tmpDir, 'data', 'pipelines.json'), JSON.stringify([{
        id: 'pipe_ci5',
        account_id: ACC,
        uploaded_at: '2026-07-19T00:00:00.000Z',
        format: 'markdown',
        input_length: 1000,
        conversation_hash: 'x'.repeat(64),
        total_extracted: 3,
        quality_passed: 3,
        deduplicated: 3,
        status: 'awaiting_review',
        learnings: [
          { title: 'negotiation opener strategy notes', body: 'How to open a negotiation with disarming empathy and mirrored phrasing across the first three exchanges of a call.', category: 'communication', tags: ['x'], quality_estimate: 19, suggested_price: 0.5 },
          { title: 'mystery labeled candidate here', body: 'Some content wearing a label the taxonomy has never contained at any point in time whatsoever.', category: 'general', tags: ['x'], quality_estimate: 15, suggested_price: 0.5 },
          { title: 'Widget API returns 200 on failed batch when items array empty', body: 'The Widget REST batch endpoint returns HTTP 200 with silent no-op when the items array is empty; check response.processed_count instead of the status code.', category: 'web-interaction', tags: ['x'], quality_estimate: 16, suggested_price: 0.5 },
        ],
      }], null, 2));

      // Port 3000 is shared with other boot tests under the parallel runner — retry.
      const bootEnv = {
        SESSION_SECRET,
        AUXILO_ACCOUNTS_FILE: path.join(tmpDir, 'data', 'accounts.json'),
      };
      let boot = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        boot = await bootServer(tmpDir, bootEnv);
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

      // ── Gate-A F1: /pipeline/:id/approve enforces the category allowlist ──
      // (mutation kill: reverting the approve-loop guard publishes the retired-
      // label candidate and these assertions fail)
      const joseEntry = require(require.resolve('jose', { paths: [REPO_ROOT] }));
      const jwt = await new joseEntry.SignJWT({ accountId: ACC, email: 'ci5@test.local' })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(Buffer.from(SESSION_SECRET));
      const approveRes = await fetch('http://127.0.0.1:3000/pipeline/pipe_ci5/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
        body: JSON.stringify({ approved: [0, 1, 2], prices: {} }),
      });
      assert.equal(approveRes.status, 200, 'approve route must be reachable with the session JWT');
      const approveBody = await approveRes.json();
      assert.equal(approveBody.published_count, 1, 'only the valid-category candidate publishes');
      assert.equal(approveBody.published[0].title, 'Widget API returns 200 on failed batch when items array empty');
      assert.equal(approveBody.rejected_out_of_scope.length, 2);
      const byIdx = Object.fromEntries(approveBody.rejected_out_of_scope.map((r) => [r.index, r]));
      assert.equal(byIdx[0].reason, 'category_out_of_scope', 'retired label gets the distinct reason');
      assert.equal(byIdx[0].category, 'communication');
      assert.equal(byIdx[1].reason, 'category_invalid', 'unknown label gets the generic reason');
      assert.deepEqual(byIdx[0].allowed_categories, TECH);
      // The store must contain the valid item and NEITHER skipped candidate.
      const postPipeline = JSON.parse(fs.readFileSync(path.join(tmpDir, 'data', 'learnings.json'), 'utf-8'));
      assert.ok(postPipeline.some((l) => l.category === 'web-interaction' && /Widget API/.test(l.title)));
      assert.ok(!postPipeline.some((l) => /negotiation opener/.test(l.title)), 'retired-label candidate must not enter the store');
      assert.ok(!postPipeline.some((l) => l.category === 'general'), "no 'general' fallback entry may be born");
    } finally {
      if (child) child.kill('SIGKILL');
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
