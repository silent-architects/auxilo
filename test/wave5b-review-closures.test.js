'use strict';

/**
 * test/wave5b-review-closures.test.js — Wave-5B: SPEC-3 B2+B3 + hardening
 *
 * Covers (BUILD-SPEC-WAVE5B-2026-07-19):
 *   B2  — sensitivity evidence spans (+ persisted LLM reason), reviewer-only
 *         projection discipline (count-pinned buyer strips), triage `why`,
 *         counted bulk reject-by-signal.
 *   B3  — sanitize-and-resubmit: atomic lineage, full-pipeline resubmission
 *         (zero bypass), predecessor-excluded dedup, depth guard.
 *   D2-F2 — active-only key caps, rotation compaction, rotate rate limit.
 *   #19 — Google Drive file-ID scrubber rules (URL shapes + guarded bare ID).
 *   N1  — openapi review_reason enum + new route docs.
 *   MCP — auxilo_review sanitize / reject_by_signal actions (0.9.4 rider).
 *
 * Structural tests follow the repo convention (server.js hardcodes
 * PORT/DATA_DIR, so route wiring is asserted against source). Per CH-7, every
 * slice is computed in before() — never at describe scope.
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const SERVER_SRC = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');
const ACCOUNTS_SRC = fs.readFileSync(path.join(REPO, 'lib', 'accounts.js'), 'utf8');
const MCP_SRC = fs.readFileSync(path.join(REPO, 'mcp-server.js'), 'utf8');

const {
  classifySensitivity,
  EVIDENCE_SPAN_MAX,
  EVIDENCE_EXCERPT_MAX,
} = require('../lib/content-sensitivity.js');
const { combineSensitivity } = require('../lib/content-sensitivity-llm.js');
const {
  projectPending,
  projectTriageRow,
  deriveWhy,
  laneOf,
  selectPendingIdsBySignal,
  applySelfDecision,
  summarizeOwnPending,
} = require('../lib/self-review.js');
const {
  compactRotatedKeys,
  rotateKeyEntry,
  ROTATED_INACTIVE_KEEP,
} = require('../lib/accounts.js');
const {
  scanLearning,
  scanText,
  getRedactionHint,
  PATTERNS,
  SENSITIVITY_FILTER_VERSION,
} = require('../lib/sensitivity-filter.js');

/** Slice helper (asserts inside — call ONLY from before()/it(), per CH-7). */
function sliceAt(src, marker, span = 5000) {
  const i = src.indexOf(marker);
  assert.notEqual(i, -1, `marker not found: ${marker}`);
  return src.slice(i, i + span);
}

// ═════════════════════════════════════════════════════════════════════════════
// A. B2 — evidence capture at classification time
// ═════════════════════════════════════════════════════════════════════════════

describe('B2: classifySensitivity evidence rows', () => {
  it('captures span+context evidence for hard token signals', () => {
    const r = classifySensitivity(
      'A learning about config',
      'Reach me at jane.doe@example.com about the /Users/janedoe/project path.',
      ['config']);
    assert.equal(r.sensitive, true);
    const bySignal = Object.fromEntries(r.evidence.map((e) => [e.signal, e]));
    assert.ok(bySignal.email, 'email evidence row present');
    assert.match(bySignal.email.hint, /jane\.doe@example\.com/);
    assert.ok(bySignal.email.excerpt.includes('jane.doe@example.com'));
    assert.ok(bySignal.private_path, 'private_path evidence row present');
    assert.match(bySignal.private_path.hint, /\/Users\/janedoe/);
    assert.match(bySignal.private_path.hint, /\/Users\/USER/, 'hint pairs with the sanitize cure');
  });

  it('social_handle hint carries the npm-scope explainer (CAT-1 §3 FP class)', () => {
    const r = classifySensitivity('Server setup', 'Ping @somelonghandle for access.', []);
    const ev = r.evidence.find((e) => e.signal === 'social_handle');
    assert.ok(ev, 'social_handle evidence present');
    assert.match(ev.hint, /@somelonghandle/);
    assert.match(ev.hint, /npm package scopes/i);
  });

  it('proprietary_context evidence quotes the fired phrase', () => {
    const r = classifySensitivity('Notes', 'We deployed this for our client last week.', []);
    const ev = r.evidence.find((e) => e.signal === 'proprietary_context');
    assert.ok(ev);
    assert.match(ev.hint, /our client/i);
  });

  it('person_name evidence carries the matched bigram', () => {
    const r = classifySensitivity('Meeting notes', 'Zorbella Quixtramand asked for the report.', []);
    assert.ok(r.signals.includes('person_name'));
    const ev = r.evidence.find((e) => e.signal === 'person_name');
    assert.ok(ev);
    assert.match(ev.hint, /Zorbella Quixtramand/);
  });

  it('hard caps hold: span <= 60 inside hint source, excerpt <= 120', () => {
    const longMail = 'a'.repeat(64) + '@' + 'b'.repeat(60) + '.com';
    const r = classifySensitivity('Contact info', `text ${longMail} text`, []);
    for (const ev of r.evidence) {
      if (ev.excerpt != null) assert.ok(ev.excerpt.length <= EVIDENCE_EXCERPT_MAX, `excerpt over cap: ${ev.excerpt.length}`);
    }
    assert.ok(EVIDENCE_SPAN_MAX === 60 && EVIDENCE_EXCERPT_MAX === 120, 'caps pinned');
  });

  it('verdict fields (sensitive/signals/score) are unchanged by evidence capture', () => {
    const clean = classifySensitivity(
      'Fix Postgres connection pooling',
      'Use PgBouncer in transaction mode when Lambda concurrency exceeds the Postgres max_connections limit.',
      ['postgres']);
    assert.equal(clean.sensitive, false);
    assert.ok(Array.isArray(clean.evidence), 'evidence array always present');
    const dirty = classifySensitivity('Note', 'Email me at a@b.co — our client asked.', []);
    assert.equal(dirty.sensitive, true);
    assert.ok(dirty.score >= 3);
  });
});

describe('B2: combineSensitivity persists the LLM reason as evidence', () => {
  it('llm flag → llm_semantic evidence row carrying the reason', () => {
    const out = combineSensitivity({
      regex: { sensitive: false, signals: [], evidence: [] },
      llm: { sensitive: true, reason: 'references a specific client project', confidence: 0.9 },
    });
    assert.equal(out.sensitive, true);
    assert.equal(out.llm_reason, 'references a specific client project');
    const ev = out.sensitivity_evidence.find((e) => e.signal === 'llm_semantic');
    assert.ok(ev, 'llm_semantic evidence row present');
    assert.equal(ev.excerpt, null);
    assert.match(ev.hint, /references a specific client project/);
  });

  it('regex evidence passes through; llm short-circuit adds no llm row', () => {
    const regexEv = [{ signal: 'email', excerpt: 'x a@b.co y', hint: "Contains an email address: 'a@b.co'." }];
    const out = combineSensitivity({
      regex: { sensitive: true, signals: ['email'], evidence: regexEv },
      llm: null, // short-circuited: regex already flagged
    });
    assert.deepEqual(out.sensitivity_evidence, regexEv);
  });

  it('fail-closed (llm enabled, not consulted, regex clean) carries its reason as evidence', () => {
    const out = combineSensitivity({
      regex: { sensitive: false, signals: [], evidence: [] },
      llm: null,
      llmEnabled: true,
    });
    assert.equal(out.sensitive, true);
    const ev = out.sensitivity_evidence.find((e) => e.signal === 'llm_semantic');
    assert.ok(ev);
    assert.match(ev.hint, /fail-closed/);
  });

  it('llm disabled (regex-only fallback) → no synthetic llm evidence', () => {
    const out = combineSensitivity({
      regex: { sensitive: false, signals: [], evidence: [] },
      llm: null,
      llmEnabled: false,
    });
    assert.equal(out.sensitive, false);
    assert.deepEqual(out.sensitivity_evidence, []);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// B. B2 — projection discipline
// ═════════════════════════════════════════════════════════════════════════════

function pendingLearning(id, extra = {}) {
  return {
    id,
    title: `Learning ${id} title long enough`,
    body: 'B'.repeat(80),
    category: 'code-execution',
    tags: ['t'],
    outcome: 'success',
    status: 'pending_review',
    contributor_account_id: 'acc_owner',
    created_at: '2026-07-19T00:00:00.000Z',
    ...extra,
  };
}

describe('B2: contributor projections carry evidence; triage rows carry why', () => {
  it('projectPending includes sensitivity_evidence and lineage', () => {
    const l = pendingLearning('lrn_ev', {
      sensitivity_signals: ['private_path'],
      sensitivity_evidence: [{ signal: 'private_path', excerpt: 'x /Users/bob y', hint: "Contains a home path exposing a username: '/Users/bob'. Usually fixable as /Users/USER/…" }],
      sanitized_from: 'lrn_prev',
    });
    const p = projectPending(l);
    assert.deepEqual(p.sensitivity_evidence, l.sensitivity_evidence);
    assert.equal(p.sanitized_from, 'lrn_prev');
  });

  it('projectTriageRow.why = first evidence hint; row stays body-free', () => {
    const l = pendingLearning('lrn_why', {
      sensitivity_signals: ['social_handle'],
      sensitivity_evidence: [{ signal: 'social_handle', excerpt: 'cc @teamlead now', hint: "Contains an @-handle: '@teamlead'. npm package scopes (@org/pkg) look like handles to this screen." }],
    });
    const row = projectTriageRow(l);
    assert.match(row.why, /@teamlead/);
    assert.equal(row.body, undefined, 'compact row must never carry the body');
    assert.equal(row.lane, 'needs_your_eyes');
  });

  it('why falls back per flag class for pre-B2 records (no evidence stored)', () => {
    const inj = pendingLearning('lrn_inj', {
      injection_flags: [{ pattern_id: 'ignore_previous', field: 'body', excerpt: 'ignore previous instructions' }],
    });
    assert.match(deriveWhy(inj, ['injection']), /ignore_previous/);
    const dup = pendingLearning('lrn_dup', { possible_duplicate_of: 'lrn_x', possible_duplicate_similarity: 0.72 });
    assert.match(deriveWhy(dup, ['near_duplicate']), /lrn_x/);
    const pa = pendingLearning('lrn_pa', { learning_type: 'process_advice' });
    assert.match(deriveWhy(pa, ['process_advice']), /process\/workflow advice/);
    const sens = pendingLearning('lrn_s', { sensitivity_signals: ['person_name'] });
    assert.match(deriveWhy(sens, ['content_sensitivity']), /person_name/);
    assert.equal(deriveWhy(pendingLearning('lrn_c'), []), null, 'unflagged rows have no why');
  });

  it('lane derivation is unchanged by evidence presence (B2 rule: lanes untouched)', () => {
    const base = pendingLearning('lrn_l1', {
      sensitivity_signals: ['email'],
      quality_self_assessment: { specificity: 5, actionability: 5, novelty: 5, completeness: 5, total: 20 },
    });
    const withEv = { ...base, sensitivity_evidence: [{ signal: 'email', excerpt: 'e', hint: 'h' }] };
    assert.equal(projectTriageRow(base).lane, projectTriageRow(withEv).lane);
    assert.equal(laneOf(projectTriageRow(withEv)), 'needs_your_eyes');
    const summary = summarizeOwnPending([base], 'acc_owner');
    const summaryEv = summarizeOwnPending([withEv], 'acc_owner');
    assert.deepEqual(summary.counts.by_lane, summaryEv.counts.by_lane);
  });
});

describe('B2: buyer projections NEVER carry evidence or lineage (count-pinned strips)', () => {
  it('sensitivity_evidence stripped at exactly 4 buyer sites', () => {
    const named = (SERVER_SRC.match(/sensitivity_evidence: _se\b/g) || []).length; // self-unlock + paid unlock
    const capped = (SERVER_SRC.match(/sensitivity_evidence: _sec\b/g) || []).length; // capped repeat
    const searchMap = (SERVER_SRC.match(/moderation, sensitivity_signals, sensitivity_source, sensitivity_evidence, learning_type/g) || []).length;
    assert.equal(named, 2, 'self-unlock + paid-unlock destructures must strip sensitivity_evidence');
    assert.equal(capped, 1, 'capped-repeat destructure must strip sensitivity_evidence');
    assert.equal(searchMap, 1, 'search-map destructure must strip sensitivity_evidence');
  });

  it('sanitize lineage stripped at the same 4 buyer sites', () => {
    const named = (SERVER_SRC.match(/sanitized_from: _sf\b/g) || []).length;
    const capped = (SERVER_SRC.match(/sanitized_from: _sfc\b/g) || []).length;
    const searchMap = (SERVER_SRC.match(/learning_type, sanitized_from, sanitized_to, \.\.\.rest/g) || []).length;
    assert.equal(named, 2);
    assert.equal(capped, 1);
    assert.equal(searchMap, 1);
  });

  it('admin moderation queue (reviewer surface) DOES include evidence', () => {
    const h = sliceAt(SERVER_SRC, '// LW-13/LW-14/LW-16: reviewer signals', 700);
    assert.ok(h.includes('sensitivity_evidence: l.sensitivity_evidence'),
      'the moderator sees the evidence rows');
  });

  it('/learn and /extract persist sensitivity_evidence when the classifier flags', () => {
    assert.ok(/sensitivity_evidence: contentSensitivity\.sensitivity_evidence/.test(SERVER_SRC),
      '/learn persists the combined evidence');
    assert.ok(/candidate\.sensitivity_evidence = extractContentSensitivity\.sensitivity_evidence/.test(SERVER_SRC),
      '/extract persists the combined evidence');
    // Both fail-closed fallbacks carry a classifier_error evidence row.
    const fallbacks = (SERVER_SRC.match(/signal: 'classifier_error'/g) || []).length;
    assert.ok(fallbacks >= 3, '/learn + /extract + sanitize fail-closed fallbacks say why');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// C. B2 — counted bulk reject-by-signal
// ═════════════════════════════════════════════════════════════════════════════

describe('B2: selectPendingIdsBySignal (pure)', () => {
  const rows = [
    pendingLearning('lrn_h1', { sensitivity_signals: ['social_handle'] }),
    pendingLearning('lrn_h2', { sensitivity_signals: ['social_handle', 'person_name'] }),
    pendingLearning('lrn_p1', { sensitivity_signals: ['person_name'] }),
    pendingLearning('lrn_i1', { injection_flags: [{ pattern_id: 'x', field: 'body', excerpt: 'y' }] }),
    pendingLearning('lrn_d1', { possible_duplicate_of: 'lrn_h1' }),
    pendingLearning('lrn_pa1', { learning_type: 'process_advice' }),
    pendingLearning('lrn_clean'),
    pendingLearning('lrn_foreign', { sensitivity_signals: ['social_handle'], contributor_account_id: 'acc_other' }),
    pendingLearning('lrn_approved', { sensitivity_signals: ['social_handle'], status: 'approved' }),
  ];

  it('matches sensitivity signal names, ownership- and status-filtered', () => {
    assert.deepEqual(selectPendingIdsBySignal(rows, 'acc_owner', 'social_handle'), ['lrn_h1', 'lrn_h2']);
    assert.deepEqual(selectPendingIdsBySignal(rows, 'acc_owner', 'person_name'), ['lrn_h2', 'lrn_p1']);
  });

  it('matches the three screen-level names like the summary filter', () => {
    assert.deepEqual(selectPendingIdsBySignal(rows, 'acc_owner', 'injection'), ['lrn_i1']);
    assert.deepEqual(selectPendingIdsBySignal(rows, 'acc_owner', 'near_duplicate'), ['lrn_d1']);
    assert.deepEqual(selectPendingIdsBySignal(rows, 'acc_owner', 'process_advice'), ['lrn_pa1']);
  });

  it('foreign account sees nothing; junk input safe', () => {
    assert.deepEqual(selectPendingIdsBySignal(rows, 'acc_nobody', 'social_handle'), []);
    assert.deepEqual(selectPendingIdsBySignal(rows, 'acc_owner', ''), []);
    assert.deepEqual(selectPendingIdsBySignal(null, 'acc_owner', 'x'), []);
  });
});

describe('B2: POST /account/pending/reject-by-signal (structural)', () => {
  let h;
  before(() => { h = sliceAt(SERVER_SRC, "app.post('/account/pending/reject-by-signal'", 3600); });

  it('contribute scope + counted gate (SIGNAL_COUNT_MISMATCH 409, nothing mutated)', () => {
    assert.ok(h.includes("resolveSelfReviewAccount(c, 'contribute')"));
    assert.ok(h.includes("code: 'SIGNAL_COUNT_MISMATCH'"));
    assert.ok(/ids\.length !== expectedCount/.test(h), 'live selection compared to the confirmed count');
    assert.ok(h.includes('}, 409)'));
  });

  it('selection is the shared pure selector; decisions flow through applyBulkDecisions under the learnings lock', () => {
    assert.ok(h.includes('selectPendingIdsBySignal(learnings, accountId, signal)'));
    assert.ok(h.includes('applyBulkDecisions(learnings, accountId, chunk'));
    assert.ok(h.includes('acquireLearningsLock()'));
    assert.ok(h.includes('safeWrite(LEARNINGS_FILE, learnings)'));
  });

  it("REJECT ONLY — the handler builds decision 'reject' and never 'approve'", () => {
    assert.ok(h.includes("decision: 'reject'"));
    assert.ok(!h.includes("decision: 'approve'"), 'no approve path may exist on this route');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// D. B3 — sanitize-and-resubmit
// ═════════════════════════════════════════════════════════════════════════════

describe('B3: POST /account/pending/:id/sanitize (structural)', () => {
  let h;
  before(() => { h = sliceAt(SERVER_SRC, "app.post('/account/pending/:id/sanitize'", 14000); });

  it('contribute scope; ownership checked BEFORE status (M-6); pending|rejected source only', () => {
    assert.ok(h.includes("resolveSelfReviewAccount(c, 'contribute')"));
    const own = h.indexOf('Not authorized to sanitize');
    const status = h.indexOf("original.status !== 'pending_review' && original.status !== 'rejected'");
    assert.ok(own !== -1 && status !== -1 && own < status, 'ownership gate sits above the status gate');
  });

  it('guards: ALREADY_SANITIZED, SANITIZE_DEPTH_EXCEEDED (2 hops), retired-category refusal', () => {
    assert.ok(h.includes("code: 'ALREADY_SANITIZED'"));
    assert.ok(h.includes("code: 'SANITIZE_DEPTH_EXCEEDED'"));
    assert.ok(/hops >= 2/.test(h));
    assert.ok(h.includes("code: 'CATEGORY_OUT_OF_SCOPE'"));
  });

  it('FULL screen pipeline — every /learn screen invoked, zero bypass', () => {
    assert.ok(h.includes('sanitizeLearningBody(content)'), 'LW-3(a) body sanitizer');
    assert.ok(h.includes('findNearDuplicate({ title, body: content, category: original.category }, dedupSet)'), 'near-dup screen');
    assert.ok(h.includes('scanLearning({ title, body: content'), 'credentials/PII filter');
    assert.ok(h.includes('screenLearningSafe({ title, body: content'), 'injection screen');
    assert.ok(h.includes('evaluateContentSensitivity(title, content, tags)'), 'two-layer content sensitivity');
    assert.ok(h.includes('meetsQualityFloor(carriedQA)'), 'quality floor');
    assert.ok(h.includes('LEARNING_TYPE_SCREEN_ENABLED'), 'system-fact screen');
  });

  it('predecessor is excluded from BOTH dup screens (the replacement retires it)', () => {
    assert.ok(h.includes('learnings.filter((l) => l && l.id !== original.id)'),
      'dedup candidate set excludes the original');
    // Both the exact-dup find and findNearDuplicate consume the same dedupSet.
    assert.ok(h.includes('dedupSet.find'), 'exact-dup runs over the exclusion set');
  });

  it('ALWAYS held: sanitized_resubmission appended unconditionally; status pending_review; no publish path', () => {
    assert.ok(h.includes("reviewReasons.push('sanitized_resubmission')"));
    assert.ok(h.includes("status: 'pending_review'"));
    assert.ok(!h.includes('seamlessEligible'), 'no seamless predicate on this route');
    assert.ok(!h.includes('cleanLanePublish'), 'no clean-lane path on this route');
  });

  it('lineage both directions + original retired with reason sanitize-resubmit, atomically (one lock, one write)', () => {
    assert.ok(h.includes('sanitized_from: original.id'));
    assert.ok(h.includes('original.sanitized_to = replacement.id'));
    assert.ok(h.includes("'reject', {") && h.includes("reason: 'sanitize-resubmit'"));
    assert.equal((h.match(/safeWrite\(LEARNINGS_FILE, learnings\)/g) || []).length, 1,
      'exactly ONE persist — both mutations land in the same write (no lost-item window)');
    assert.ok(h.includes('acquireLearningsLock()'));
  });
});

describe('B3: original-disposition semantics (pure)', () => {
  it('a pending original rejects with the sanitize-resubmit reason recorded', () => {
    const l = pendingLearning('lrn_orig');
    const res = applySelfDecision([l], 'acc_owner', 'lrn_orig', 'reject', { reason: 'sanitize-resubmit' });
    assert.equal(res.ok, true);
    assert.equal(l.status, 'rejected');
    assert.equal(l.self_review_action.reason, 'sanitize-resubmit');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// E. D2-F2 — key-store growth + rotation abuse
// ═════════════════════════════════════════════════════════════════════════════

function keyEntry(i, extra = {}) {
  return {
    id: `key_${i}`, hash: `hash_${i}`, label: 'ci', scope: 'contribute',
    scope_version: 2, created_at: `2026-07-0${(i % 9) + 1}T00:00:00.000Z`,
    active: true, ...extra,
  };
}

describe('D2-F2: compactRotatedKeys (pure)', () => {
  it('keeps the newest 3 rotated-out entries per label; actives + revoked untouched; order preserved', () => {
    const account = { api_keys: [] };
    for (let i = 0; i < 6; i++) {
      account.api_keys.push(keyEntry(i, { active: false, rotated_at: `2026-07-1${i}T00:00:00.000Z` }));
    }
    account.api_keys.push(keyEntry(90, { active: false, label: 'revoked-key' })); // revocation audit row: NO rotated_at
    account.api_keys.push(keyEntry(91, { label: 'ci' }));  // active
    account.api_keys.push(keyEntry(92, { label: 'other' })); // active

    const { removed } = compactRotatedKeys(account);
    assert.equal(removed, 3, '6 rotated - keep 3 = remove 3 (ROTATED_INACTIVE_KEEP)');
    assert.equal(ROTATED_INACTIVE_KEEP, 3);
    const rotatedLeft = account.api_keys.filter((k) => k.active === false && k.rotated_at);
    assert.deepEqual(rotatedLeft.map((k) => k.id), ['key_3', 'key_4', 'key_5'], 'newest 3 survive, order preserved');
    assert.ok(account.api_keys.some((k) => k.id === 'key_90'), 'revoked (non-rotated) audit row untouched');
    assert.equal(account.api_keys.filter((k) => k.active !== false).length, 2, 'active entries untouched');
  });

  it('per-label ceilings are independent', () => {
    const account = { api_keys: [] };
    for (let i = 0; i < 4; i++) account.api_keys.push(keyEntry(i, { active: false, label: 'a', rotated_at: `2026-07-1${i}T00:00:00.000Z` }));
    for (let i = 4; i < 8; i++) account.api_keys.push(keyEntry(i, { active: false, label: 'b', rotated_at: `2026-07-1${i - 4}T00:00:00.000Z` }));
    const { removed } = compactRotatedKeys(account);
    assert.equal(removed, 2, 'one over-ceiling entry per label');
  });

  it('no-op below the ceiling', () => {
    const account = { api_keys: [keyEntry(0, { active: false, rotated_at: '2026-07-10T00:00:00.000Z' }), keyEntry(1)] };
    assert.equal(compactRotatedKeys(account).removed, 0);
    assert.equal(account.api_keys.length, 2);
  });
});

describe('D2-F2: rotateKeyEntry compacts — the rotate-loop growth vector dies', () => {
  it('N rotations leave at most KEEP rotated-out entries for the label; new key stays LAST', () => {
    const account = { api_keys: [keyEntry(0)] };
    let target = account.api_keys[0];
    for (let n = 0; n < 12; n++) {
      const { entry } = rotateKeyEntry(account, target);
      assert.strictEqual(account.api_keys[account.api_keys.length - 1], entry,
        'the replacement entry must remain LAST (callers index it as length-1)');
      target = entry;
    }
    const rotatedDead = account.api_keys.filter((k) => k.active === false && k.rotated_at);
    assert.ok(rotatedDead.length <= ROTATED_INACTIVE_KEEP,
      `rotation debris bounded at ${ROTATED_INACTIVE_KEEP}, got ${rotatedDead.length}`);
    assert.equal(account.api_keys.filter((k) => k.active !== false).length, 1, 'exactly one live key');
    assert.ok(account.api_keys.length <= 1 + ROTATED_INACTIVE_KEEP, 'accounts.json growth is bounded');
  });

  it('reports the compacted count', () => {
    const account = { api_keys: [keyEntry(0)] };
    let target = account.api_keys[0];
    let sawCompaction = false;
    for (let n = 0; n < 6; n++) {
      const { compacted, entry } = rotateKeyEntry(account, target);
      if (compacted > 0) sawCompaction = true;
      target = entry;
    }
    assert.ok(sawCompaction, 'compaction must fire once the ceiling is crossed');
  });
});

describe('D2-F2: caps and route hardening (structural)', () => {
  it('labeled-creation cap counts ACTIVE keys only (lib/accounts.js)', () => {
    const labeled = sliceAt(ACCOUNTS_SRC, '// ── New-style labeled key creation', 1400);
    assert.ok(labeled.includes(".filter(k => k.active !== false).length >= 10"),
      'labeled path: active-only count');
  });

  it('legacy name-path creation gains the same active-only cap (was uncapped)', () => {
    const legacy = sliceAt(ACCOUNTS_SRC, '// ── Legacy name/scope key creation', 900);
    assert.ok(legacy.includes(".filter(k => k.active !== false).length >= 10"),
      'legacy path: active-only cap present');
  });

  it('rotate route: per-account rate limit before any work; 429 with Retry-After', () => {
    const h = sliceAt(SERVER_SRC, "app.post('/account/api-keys/rotate'", 2600);
    assert.ok(h.includes('isRotateRateLimited(accountId)'));
    assert.ok(h.includes('}, 429)'));
    assert.ok(h.includes("c.header('Retry-After'"));
    assert.ok(SERVER_SRC.includes('const ROTATE_RATE_LIMIT = { window_ms: 3600_000, max_per_account: 10 }'));
  });

  it('rotate route: index rebuilt when compaction shifted array positions (stale key_index kills)', () => {
    const h = sliceAt(SERVER_SRC, "app.post('/account/api-keys/rotate'", 2600);
    assert.ok(h.includes('if (compacted > 0) rebuildKeyIndex()'),
      'compaction shifts api_keys positions; the in-memory key_index must be rebuilt');
    const save = h.indexOf('saveAccounts(accts)');
    const rebuild = h.indexOf('rebuildKeyIndex()');
    assert.ok(save !== -1 && rebuild !== -1 && save < rebuild, 'rebuild reads the persisted state');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// F. #19 — Google Drive file-ID scrubber
// ═════════════════════════════════════════════════════════════════════════════

describe('#19: Drive-ID patterns (sensitivity-filter 0.5.0)', () => {
  const learn = (body) => scanLearning({
    title: 'A perfectly reasonable learning title',
    body: body + ' padded so the body clears the minimum length for realism.',
    task_context: 'testing', tags: ['drive'],
  });
  const driveHit = (r) => !r.clean && r.matches.some((m) => m.pattern.startsWith('google_drive'));

  it('version bumped and both patterns registered with /g', () => {
    assert.equal(SENSITIVITY_FILTER_VERSION, '0.5.0');
    const url = PATTERNS.find((p) => p.name === 'google_drive_url');
    const bare = PATTERNS.find((p) => p.name === 'google_drive_id');
    assert.ok(url && url.regex.global);
    assert.ok(bare && bare.regex.global);
    assert.equal(typeof bare.validate, 'function', 'bare heuristic carries its FP guard');
  });

  it('the real-world leak shape: a docs.google.com /d/<id>/edit URL is flagged', () => {
    const r = learn('Notes live in https://docs.google.com/document/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit#heading=h.2');
    assert.ok(driveHit(r), JSON.stringify(r.matches || []));
    assert.ok(r.matches.some((m) => m.pattern === 'google_drive_url'));
  });

  it('URL shapes: file/d, spreadsheets/d, presentation/d, open?id=, drive/folders, u/0/d', () => {
    for (const u of [
      'https://drive.google.com/file/d/1A2b3C4d5E6f7G8h9I0j1K2l3M4n5O6p7/view?usp=sharing',
      'https://docs.google.com/spreadsheets/d/1A2b3C4d5E6f7G8h9I0j1K2l3M4n5O6p7/edit',
      'https://docs.google.com/presentation/d/1A2b3C4d5E6f7G8h9I0j1K2l3M4n5O6p7/present',
      'https://drive.google.com/open?id=1A2b3C4d5E6f7G8h9I0j1K2l3M4n5O6p7',
      'https://drive.google.com/drive/folders/1A2b3C4d5E6f7G8h9I0j1K2l3M4n5O6p7',
      'https://docs.google.com/document/u/0/d/1A2b3C4d5E6f7G8h9I0j1K2l3M4n5O6p7/edit',
    ]) {
      assert.ok(driveHit(learn(`see ${u} for context`)), `must flag: ${u}`);
    }
  });

  it('bare IDs: 33-char and 44-char forms flagged (URL absent)', () => {
    assert.ok(driveHit(learn('the sheet id is 1A2b3C4d5E6f7G8h9I0j1K2l3M4n5O6p7 in config')));
    assert.ok(driveHit(learn('doc 1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms referenced')));
    assert.ok(driveHit(learn('legacy folder 0B7g8h9I0j1K2l3M4n5O6p7Q8r9S0t1U referenced')));
  });

  it('FP posture: git SHAs, lowercase words, decimal runs, generic prose all pass', () => {
    for (const t of [
      'commit 1f4e5d6c7b8a9f0e1d2c3b4a5f6e7d8c9b0a1f2e fixed it',       // 40-hex lowercase SHA starting with 1
      'supercalifragilisticexpialidocious appears in tests',
      'timestamp 1789456123789456123789456123 in the log',
      'Use the Google Drive API v3 files.list endpoint with pageSize 100 and a pageToken loop',
    ]) {
      assert.ok(!driveHit(learn(t)), `must NOT flag: ${t}`);
    }
  });

  it('scanText parity + redaction hints', () => {
    const t = scanText('grab https://docs.google.com/document/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit now');
    assert.equal(t.clean, false);
    assert.ok(t.redacted.includes('{DRIVE_FILE_ID}'), 'redacted text substitutes the hint');
    assert.ok(getRedactionHint('google_drive_url').includes('{DRIVE_FILE_ID}'));
    assert.equal(getRedactionHint('google_drive_id'), '{DRIVE_FILE_ID}');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// G. N1 — openapi + MCP rider pins
// ═════════════════════════════════════════════════════════════════════════════

describe('N1: openapi debt closed', () => {
  let spec;
  before(() => { spec = JSON.parse(fs.readFileSync(path.join(REPO, 'openapi.json'), 'utf8')); });

  it('/learn review_reason enum carries the B1/B2/B3 hold reasons', () => {
    const enumVals = spec.paths['/learn'].post.responses['201']
      .content['application/json'].schema.properties.review_reason.items.enum;
    for (const v of ['below_quality_floor', 'standing_consent_off', 'below_auto_publish_threshold', 'sanitized_resubmission']) {
      assert.ok(enumVals.includes(v), `enum missing ${v}`);
    }
  });

  it('sanitize + reject-by-signal routes documented', () => {
    assert.ok(spec.paths['/account/pending/{id}/sanitize'], 'sanitize path documented');
    assert.ok(spec.paths['/account/pending/reject-by-signal'], 'reject-by-signal path documented');
    const sanitize = spec.paths['/account/pending/{id}/sanitize'].post;
    assert.match(sanitize.description, /ZERO bypass/);
    const rbs = spec.paths['/account/pending/reject-by-signal'].post;
    assert.ok(rbs.requestBody.content['application/json'].schema.required.includes('expected_count'));
  });
});

describe('MCP 0.9.4 rider: auxilo_review gains sanitize + reject_by_signal', () => {
  it('action enum extended', () => {
    assert.ok(MCP_SRC.includes("enum: ['list', 'approve', 'reject', 'approve_clean', 'reject_by_signal', 'sanitize']"));
  });

  it('reject_by_signal handler enforces the counted gate client-side too', () => {
    const h = sliceAt(MCP_SRC, "if (args.action === 'reject_by_signal')", 1400);
    assert.ok(h.includes('expected_count'));
    assert.ok(h.includes('counted-confirmation gate'));
    assert.ok(h.includes('/account/pending/reject-by-signal'));
  });

  it('sanitize handler requires id + a correction and targets the route', () => {
    const h = sliceAt(MCP_SRC, "if (args.action === 'sanitize')", 1400);
    assert.ok(h.includes("args.title === undefined && args.body === undefined"));
    assert.ok(h.includes('/sanitize'));
  });

  it('never-agent-enrollable pin still holds: zero clean-lane references in mcp-server.js', () => {
    assert.ok(!/clean[-_]lane/i.test(MCP_SRC), 'the C1 consent surface must stay MCP-unreachable');
  });
});
