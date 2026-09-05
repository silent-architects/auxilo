'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const SERVER = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');
const PRICING = fs.readFileSync(path.join(REPO, 'lib', 'pricing.js'), 'utf8');
const OPENAPI = require('../openapi.json');
const similarity = require('../lib/similarity.js');
const selfReview = require('../lib/self-review.js');
const pricing = require('../lib/pricing.js');

function route(startMarker, endMarker) {
  const start = SERVER.indexOf(startMarker);
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`);
  const end = endMarker ? SERVER.indexOf(endMarker, start + startMarker.length) : SERVER.length;
  assert.ok(end > start, `missing end marker: ${endMarker}`);
  return SERVER.slice(start, end);
}

function learning(id, overrides = {}) {
  return {
    id,
    title: 'Deterministic private learning fixture',
    body: 'A deterministic learning body with enough repeated technical detail to exercise exact and near duplicate gates.',
    category: 'code-execution',
    tags: ['node', 'testing'],
    task_context: 'Testing a server-side privacy boundary.',
    outcome: 'The privacy boundary remains closed.',
    status: 'pending_review',
    contributor_account_id: 'acc_owner',
    quality: { unlocks: 0, ratings: 0, avg_helpfulness: 0 },
    ...overrides,
  };
}

describe('SPEC3-G1 private learnings acceptance pins', () => {
  it('1. count-pins every retained audited raw-read path with stable allow markers', () => {
    const markers = [...SERVER.matchAll(/G1_RAW_READ_ALLOW:(\d+)/g)].map((m) => Number(m[1]));
    const retained = [1, 2, 3, 4, 5, 6, 8, 9, 10, 12, 13, 14, 15, 16,
      19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 32, 33, 34, 35, 36];
    assert.deepEqual([...new Set(markers)].sort((a, b) => a - b), retained);
    assert.equal(markers.length, retained.length,
      'each retained semantic raw-read path has exactly one allow marker');
    const rawReadShape =
      /\blearnings\.(?:findIndex|find|filter|some|map|slice|concat)\s*\(|\bfor\s*\([^\n]*\bof\s+learnings\s*\)|\b(?:migratePipelineOwners|migrateRetiredCategories|adoptWalletOrphans|computeCleanLaneRetractionStats|listOwnPending|applySelfDecision|applyBulkDecisions)\(learnings\b/g;
    const canonicalStart = SERVER.indexOf('function visibleCatalog()');
    const canonicalEnd = SERVER.indexOf('function matchLearnings', canonicalStart);
    const rawCalls = [...SERVER.matchAll(rawReadShape)].filter((match) => {
      const insideCanonical = match.index > canonicalStart && match.index < canonicalEnd;
      const nestedProperty = SERVER[match.index - 1] === '.';
      return !insideCanonical && !nestedProperty;
    });
    assert.equal(rawCalls.length, 30,
      'post-G1 retained raw-read call-site count drifted; audit and mark any new path');
  });

  it('2. makes private exclusion unconditional in the one canonical public predicate', () => {
    const helper = route('function visibleCatalog()', 'function matchLearnings');
    assert.match(helper, /filter\(\(l\) => l && l\.visibility !== 'private'\)/);
    assert.equal((SERVER.match(/function visibleCatalog\(\)/g) || []).length, 1);
    assert.ok(helper.indexOf("visibility !== 'private'") < helper.indexOf('CONTENT_MODERATION_ENABLED'));
  });

  it('3. keeps all public catalog projections delegated to visibleCatalog', () => {
    for (const marker of [
      "app.get('/knowledge/stats'",
      "app.get('/pricing/categories'",
      "app.get('/contributor/:wallet/pricing-insights'",
    ]) {
      assert.match(route(marker, '\n});'), /visible(Catalog|LearningsList)\(\)/);
    }
    assert.match(SERVER, /knowledge_hint:\s*visibleLearningsList\(\)\.length/);
  });

  it('4. removes private rows from every pricing and demand comparison input', () => {
    assert.equal(pricing.isMarketVisible(learning('private', {
      status: 'approved', visibility: 'private',
    })), false);
    assert.doesNotMatch(SERVER, /pricingEngine\.(?:calculateLearningPrice|getCurrentPrice)\([^;\n]*,\s*learnings\)/);
    assert.match(route('async function runDailyPricingCron()', 'const _pricingCronStartup'),
      /const catalog = visibleCatalog\(\)\.slice\(\)/);
    assert.match(PRICING,
      /catalog\.filter\(l =>\s*isMarketVisible\(l\) && l\.category === category && l\.demand\)/);
  });

  it('5. passes contributor identity to all three near-duplicate screens', () => {
    const calls = [...SERVER.matchAll(/findNearDuplicate\(/g)];
    assert.equal(calls.length, 3);
    assert.equal((SERVER.match(/contributorAccountId:\s*(?:contributor_account_id|accountId)/g) || []).length, 3);
  });

  it('6. scopes comparisons: public for all, non-public only for the owner', () => {
    const candidate = learning('candidate');
    const crossPrivate = learning('private-other', {
      status: 'approved', visibility: 'private', contributor_account_id: 'acc_other',
    });
    const samePrivate = learning('private-own', { status: 'approved', visibility: 'private' });
    const publicOther = learning('public-other', {
      status: 'approved', visibility: 'public', contributor_account_id: 'acc_other',
    });
    assert.equal(similarity.findNearDuplicate(candidate, [crossPrivate], {
      contributorAccountId: 'acc_owner',
    }).verdict, 'clean');
    assert.equal(similarity.findNearDuplicate(candidate, [samePrivate], {
      contributorAccountId: 'acc_owner',
    }).match.id, 'private-own');
    assert.match(SERVER, /re-extraction of your private learning/);
    assert.equal(similarity.findNearDuplicate(candidate, [publicOther], {
      contributorAccountId: 'acc_owner',
    }).match.id, 'public-other');
  });

  it('7. existence-hides private ids on GET, rate, and report', () => {
    const unlock = route("app.get('/knowledge/:id'", '// R-01 router mode');
    const rate = route("app.post('/knowledge/:id/rate'", "app.get('/pricing/categories'");
    const report = route("app.post('/report'", "app.get('/admin/reports'");
    assert.match(unlock, /if \(learning\.visibility === 'private' && !dr8OwnerAccountId\)[\s\S]*Learning not found/);
    assert.match(rate, /visibleCatalog\(\)\.findIndex/);
    assert.match(report, /visibleCatalog\(\)\.findIndex/);
  });

  it('8. owner search includes only the caller private rows and omits all economics', () => {
    const search = route("app.post('/knowledge'", '// Gate-A W2B-2');
    assert.match(search, /matchLearnings\(query,[\s\S]*accountId:\s*callerAccountId/);
    assert.match(search, /if \(r\.visibility === 'private'\)/);
    assert.match(search, /visibility:\s*'private'/);
    assert.match(search, /owner_recall_free:\s*true/);
    assert.doesNotMatch(search.match(/if \(r\.visibility === 'private'\)[\s\S]*?\n\s*}/)[0],
      /unlock_price_usd|current_price|value_signal|recordSearchSource/);
  });

  it('9. private rows cannot change public catalog coherence', () => {
    assert.match(route('function matchLearnings', '// SPEC3-F1'), /comparisonCatalog\(/);
    assert.match(route('function visibleLearningsList()', '\n}'), /return visibleCatalog\(\)/);
    assert.equal((SERVER.match(/catalog_size:\s*visibleLearningsList\(\)\.length/g) || []).length, 2);
  });

  it('10. owner-private recall is a pre-pricing DR-8 pure read with omission shape', () => {
    const unlock = route("app.get('/knowledge/:id'", '// R-01 router mode');
    const privateBranch = unlock.match(/if \(learning\.visibility === 'private'[\s\S]*?\n\s*}\n\n/);
    assert.ok(privateBranch);
    const ownedBranchAt = privateBranch[0].indexOf("if (learning.visibility === 'private') {");
    const responseAt = privateBranch[0].indexOf('return c.json', ownedBranchAt);
    const response = privateBranch[0].slice(responseAt);
    for (const field of ['unlock_price:', 'pricing:', 'demand:', 'unlock_price_usd:']) {
      assert.doesNotMatch(response, new RegExp(field));
    }
    assert.doesNotMatch(privateBranch[0], /earnings:\s*_eo/,
      'private-owner recall must retain the owner earnings field');
    assert.match(privateBranch[0], /amount_paid_usd:\s*0/);
    assert.match(privateBranch[0], /owner_recall_free:\s*true/);
    assert.ok(unlock.indexOf("learning.visibility === 'private'") < unlock.indexOf('getLockedPrice('));
  });

  it('11. private rows have no economics and cannot activate or auto-publish', () => {
    assert.match(route('function getAccountTier', 'function checkExtractRateLimit'),
      /visibleCatalog\(\)\.some/);
    assert.match(route("app.post('/learn'", "app.post('/extract'"),
      /visibility:\s*destinationVisibility/);
    assert.match(route("app.post('/learn'", "app.post('/extract'"),
      /destinationVisibility === 'private'[\s\S]*seamlessEligible = false/);
  });

  it('12. owner listing filters and returns exactly seven metadata fields', () => {
    const listing = route("app.get('/account/learnings'", "app.get('/account/settings'");
    assert.match(listing, /visibility must be one of: public,private/);
    assert.match(listing, /visibility:\s*learning\.visibility === 'private' \? 'private' : 'public'/);
    const schema = OPENAPI.paths['/account/learnings'].get.responses['200'].content['application/json'].schema;
    const row = schema.properties.learnings.items;
    assert.deepEqual(Object.keys(row.properties).sort(),
      ['category', 'created_at', 'id', 'status', 'tags', 'title', 'visibility']);
    assert.equal(row.additionalProperties, false);
  });

  it('13. single and bulk keep_private preserve confirmation and visibility-aware idempotency', () => {
    const one = learning('one', {
      unlock_price: 1, pricing: {}, demand: {}, earnings: {},
    });
    const kept = selfReview.applySelfDecision([one], 'acc_owner', 'one', 'keep_private');
    assert.equal(kept.ok, true);
    assert.equal(one.status, 'approved');
    assert.equal(one.visibility, 'private');
    for (const field of ['unlock_price', 'pricing', 'demand', 'earnings']) {
      assert.equal(Object.hasOwn(one, field), false);
    }
    const retry = selfReview.applyBulkDecisions([one], 'acc_owner',
      [{ id: 'one', decision: 'keep_private' }], { confirmCount: 1 });
    assert.equal(retry.counts.idempotent, 1);
    assert.equal(retry.counts.kept_private, 0);
    const mismatch = selfReview.applyBulkDecisions([learning('two')], 'acc_owner',
      [{ id: 'two', decision: 'keep_private' }], { confirmCount: 0 });
    assert.equal(mismatch.code, 'confirm_count_mismatch');
  });

  it('14. non-technical is private-only and every public approval gate enforces CI-5', () => {
    const learn = route("app.post('/learn'", "app.post('/extract'");
    assert.match(learn, /PRIVATE_LEARNING_CATEGORY/);
    assert.match(learn, /CI-5/);
    const pending = learning('nontech', { category: 'non-technical' });
    assert.equal(selfReview.applySelfDecision([pending], 'acc_owner', pending.id, 'approve').code,
      'category_out_of_scope');
    assert.equal(selfReview.applySelfDecision([pending], 'acc_owner', pending.id, 'keep_private').ok, true);
    const privatePending = learning('private-pending', { visibility: 'private' });
    assert.equal(selfReview.applySelfDecision(
      [privatePending], 'acc_owner', privatePending.id, 'approve'
    ).code, 'private_requires_sanitize');
    assert.match(route("app.post('/admin/moderation/:id/approve'", "app.post('/admin/moderation/:id/reject'"),
      /TECH_LEARNING_CATEGORIES\.includes/);
  });

  it('15. promotion accepts only owner-private sources and always yields public pending through all screens', () => {
    const sanitize = route("app.post('/account/pending/:id/sanitize'", '// ─── S21-3');
    assert.match(sanitize, /original\.status === 'approved' && original\.visibility === 'private'/);
    assert.match(sanitize, /TECH_LEARNING_CATEGORIES\.includes\(replacementCategory\)/);
    assert.match(sanitize, /visibility:\s*'public'/);
    assert.match(sanitize, /sanitized_from:\s*original\.id,\s*\n\s*status:\s*'pending_review'/);
    assert.match(sanitize, /originalDisposition = 'kept_private'/);
    for (const call of ['scanLearning(', 'screenLearningSafe(', 'evaluateContentSensitivity(', 'findNearDuplicate(']) {
      assert.ok(sanitize.includes(call), `sanitize keeps full screen: ${call}`);
    }
  });

  it('16. preserves the exact four buyer quality-strip projections', () => {
    assert.equal((SERVER.match(/quality:\s*stripOpsCounters\(/g) || []).length, 6);
    const privateSearch = route("app.post('/knowledge'", '// Gate-A W2B-2');
    assert.match(privateSearch, /quality:\s*stripOpsCounters\(/);
  });

  it('17. keeps GOV-2 deletion behind fresh, purpose-bound proof and two ownership axes', () => {
    const request = route("app.post('/account/delete-request'", "app.get('/account/delete-confirm'");
    const confirm = route("app.post('/account/delete-confirm'", '// ── GET /account/api-keys');
    assert.match(request, /issuePurposeMagicLink\(account\.email, 'delete-account'\)/);
    assert.match(request, /createNonce\(body\.wallet, 'delete-account'\)/);
    assert.match(confirm, /consumePurposeMagicLink\(body\.token, 'delete-account'\)/);
    assert.match(confirm, /consumeNonce\(body\.wallet\)/);
    assert.match(SERVER, /learning\.contributor_account_id === accountId/);
    assert.match(SERVER, /normalizedWallet\(learning\.contributor_wallet\) === wallet/);
  });
});
