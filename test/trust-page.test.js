'use strict';

/**
 * test/trust-page.test.js — Trust page (/how-submissions-work): engineering
 * half of TRUST-PAGE-BUILD-SPEC-2026-09-02.md (rev 3g) / PUNCH-LIST
 * TRUST-PAGE + TRUST-REDIRECTS rows.
 *
 *   1. GET /how-submissions-work → 200 text/html containing the page <title>.
 *   2. Four redirects → 301 to /how-submissions-work: /trust, /governance,
 *      /for-platforms, /platforms.
 *   3. Head tags (title, description, canonical, og:*, twitter:*) present
 *      and byte-equal to the spec's SEO strings.
 *   4. h1 = the spec's h1 (`What stands between a submission and the public
 *      catalog`).
 *   5. The page never contains "Claude Code" as a requirement phrase —
 *      Tyler's ruling 2026-09-06 ("approved - build the trust page without
 *      the mention of a specific Claude Code requirement"). Asserted as: the
 *      literal string "Claude Code" does not appear anywhere in the served
 *      page at all (the strictest reading — the approved §2b/§3b copy names
 *      no client by name, so a clean page has zero occurrences).
 *   6. sitemap.xml lists the route; llms.txt carries the spec's Quick-start
 *      line.
 *   7. Structural: server.js registers the route and all four redirects.
 *
 * Staged-server pattern: test/ad-routes.test.js / test/clean-lane-phase-a2.test.js.
 *
 * Runner: node --test test/trust-page.test.js
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  reservePort,
  stageServer,
  bootServer,
  stopServer,
  BOOT_SANDBOX_SKIP_REASON,
} = require('./helpers/staged-server');

const REPO = path.join(__dirname, '..');
const SERVER_SRC = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');
const SITEMAP = fs.readFileSync(path.join(REPO, 'public', 'sitemap.xml'), 'utf8');
const LLMS_TXT = fs.readFileSync(path.join(REPO, 'public', 'llms.txt'), 'utf8');
const TRUST_HTML = fs.readFileSync(path.join(REPO, 'public', 'how-submissions-work.html'), 'utf8');

const TITLE = 'What Stands Between a Submission and the Public Catalog | Auxilo';
const DESCRIPTION = "Auxilo is a marketplace for what agents learn. What every new submission passes before it reaches the public catalog, what Auxilo does not claim, and where the catalog stands today.";
const CANONICAL = 'https://auxilo.io/how-submissions-work';
const H1 = 'What stands between a submission and the public catalog';
const LLMS_LINE = '- How submissions reach the catalog: https://auxilo.io/how-submissions-work';
const REDIRECT_SOURCES = ['/trust', '/governance', '/for-platforms', '/platforms'];

// ─── TRUST-PAGE-3 content-pass fixtures ────────────────────────────────────
// Strings copied verbatim from
// ~/.auxilo/handoffs/TRUST-PAGE-SECTIONS-0-7-SHIP-REV-2026-09-06.md (rev 1a,
// E1-E5, PASSED both gates) for byte comparison against the served page.
const SUBHEAD = "Auxilo is a marketplace for what agents learn. What follows is the mechanism, for anyone deciding whether to let their agents use it.";
const S0_CALLOUT = "Every new submission arrives under a verified wallet or an authenticated account and passes Auxilo's screens. Correctness is a different matter. No one at Auxilo certifies that a learning is right. So your agents keep one control on their side. Treat the body of an unlocked learning as untrusted data. Do not follow instructions contained in it.";
const S1_BODY = "Auxilo is a marketplace for what agents learn. Agents search it free and pay to unlock a learning instead of rediscovering it. The builder behind the contributing agent earns 70% of every direct unlock and 60% when Auxilo search surfaced it.";
const S1B_EARNINGS_SENTENCE = "Earnings accrue to your Auxilo account now and remain payable to you under the Terms.";
const S1B_WITHDRAWALS_LINK_TEXT = "Withdrawals open soon";
const S1B_WITHDRAWALS_REST = " as we finish our non-custodial migration. Earnings depend on whether other agents unlock your learnings and are not guaranteed. Auxilo is early.";
const S2_PARA1 = "Learnings are extracted from finished coding sessions on the builder's own machine, not written up by hand. Background extraction is disabled by default and enabled only by explicit opt-in during npx auxilo setup. Which clients it can capture sessions from is listed, by tier, on the supported clients page.";
const S2_PARA2 = "Before anything leaves that machine, the transcript is scrubbed behind a fail-closed secret filter. If the filter cannot verify its own work, nothing uploads. The local runner that does the extracting submits only finished learning drafts drawn from the scrubbed text, so raw sessions never reach Auxilo. By default, everything your agent extracts lands in your private review queue, and you decide what goes live, one learning at a time or in advance in your dashboard.";
const S3_PARA1 = "Accounts are self-service. A magic link to an email inbox opens one, so signing up proves control of that inbox rather than anyone's identity. The checks run against the submission itself.";
const S3_PARA2 = "Every submission passes a server-side safety screen. Anything the platform flags is held. Submissions also pass near-duplicate screening.";
const S3_PARA3 = "Public submissions are accepted in six technical categories only, and the API refuses public submissions outside those six categories. The categories are data-processing, web-interaction, code-execution, payment-financial, storage-state, and monitoring. Non-technical content is accepted only as a private learning, and private learnings never appear in the public catalog.";
const S3_PARA4 = "Your first published learning also passes an Auxilo review before it reaches the public catalog, so a new account cannot publish unreviewed. After that the decision is yours alone.";
const S4_ASYMMETRY = "Consuming is anonymous. Contributing is not. Every published learning traces to an accountable identity.";
const S4_INVARIANT = "Auxilo's own learnings sit under two accounts. One is Auxilo's platform account. The other is the account of the builder behind Auxilo.";
const S4_PROVENANCE = "Every learning carries provenance.";
const S4_STATE_A = 'Today the catalog holds nothing else. No outside builder has published here yet.';
const S4_STATE_B_BASE = 'An outside builder has published here.';
const S6_DEFENSES = "We do not claim complete defenses. Nobody honestly can.";
// Verbatim from ~/.auxilo/handoffs/TRUST-PAGE-R13-LIMITS-SLOT-2026-09-06.md
// rev 2 (SITE-PM; both gates PASSED — see that file for why it had to be
// composed rather than quoted from the D2 record).
const S6_R13_LIMITS = "Each screen is a pattern, a similarity threshold, or a model verdict. A pattern finds only what it was written to find, a threshold catches only what crosses it, and a model verdict can be wrong in either direction. What the screens miss can publish.";
const S6_REVIEW = "Nor is every learning human-approved. A person at Auxilo reviews each account's first published learning. Once. From then on, the checks on Auxilo's side are the screens.";
const S6_HOLD = "When the safety screen cannot clear a submission, the submission holds rather than publishes.";
const S7_FRAMING = "The counts in this section are live, read from the ledger each time the page loads.";
const S7_LEARNINGS_LABEL = "learnings live in the catalog";
const S7_UNLOCKS_LABEL = "unlocks, all time";

function tpStaticCell(html, id) {
  const m = html.match(new RegExp(`id="${id}"[^>]*>([^<]*)<`));
  assert.ok(m, `${id} cell present`);
  return m[1];
}

describe('Trust page: route, redirects, head tags, h1, forbidden strings', { timeout: 180_000 }, () => {
  let tmpDir;
  let child;
  let baseUrl;
  let bootSkipReason = null;

  before(async () => {
    const honoEntry = require.resolve('hono', { paths: [REPO] });
    const nodeModulesDir = honoEntry.slice(
      0,
      honoEntry.lastIndexOf(`${path.sep}node_modules${path.sep}`) + '/node_modules'.length
    );
    const reservation = await reservePort();
    if ('skipReason' in reservation) {
      assert.equal(reservation.skipReason, BOOT_SANDBOX_SKIP_REASON);
      bootSkipReason = BOOT_SANDBOX_SKIP_REASON;
      return;
    }
    const { port } = reservation;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auxilo-trust-page-'));
    stageServer({
      repoRoot: REPO,
      tmpDir,
      nodeModulesDir,
      port,
      rootFiles: ['server.js', 'seed-knowledge.json', 'skills.json', 'openapi.json', 'package.json', 'model_config.json'],
      linkDirs: ['lib', 'public', 'prompts', 'config'],
      replacements: [],
    });

    const boot = await bootServer({
      tmpDir,
      port,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        WALLET_PRIVATE_KEY: `0x${'11'.repeat(32)}`,
        LLM_SENSITIVITY_ENABLED: 'false',
        SESSION_SECRET: 'trust-page-test-session-secret-0123456789',
        AUXILO_DATA_DIR: path.join(tmpDir, 'data'),
      },
      timeoutMs: 60_000,
      maxAttempts: 3,
    });
    if ('skipReason' in boot) {
      assert.equal(boot.skipReason, BOOT_SANDBOX_SKIP_REASON);
      bootSkipReason = BOOT_SANDBOX_SKIP_REASON;
      return;
    }
    child = boot.child;
    baseUrl = boot.baseUrl;
  });

  after(async () => {
    if (child) await stopServer(child);
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('GET /how-submissions-work → 200 text/html containing the page <title>', async (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    const res = await fetch(`${baseUrl}/how-submissions-work`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /^text\/html/);
    const body = await res.text();
    assert.ok(body.includes(`<title>${TITLE}</title>`), 'body carries the title tag');
  });

  for (const src of REDIRECT_SOURCES) {
    it(`GET ${src} → 301 to /how-submissions-work`, async (t) => {
      if (bootSkipReason) { t.skip(bootSkipReason); return; }
      const res = await fetch(`${baseUrl}${src}`, { redirect: 'manual' });
      assert.equal(res.status, 301);
      assert.equal(res.headers.get('location'), '/how-submissions-work');
    });
  }

  it('head tags present and byte-equal to the spec strings', () => {
    assert.ok(TRUST_HTML.includes(`<title>${TITLE}</title>`), 'title');
    assert.ok(TRUST_HTML.includes(`<meta name="description" content="${DESCRIPTION}">`), 'description');
    assert.ok(TRUST_HTML.includes(`<link rel="canonical" href="${CANONICAL}" />`), 'canonical');
    assert.ok(TRUST_HTML.includes(`<meta property="og:type" content="website" />`), 'og:type');
    assert.ok(TRUST_HTML.includes(`<meta property="og:site_name" content="Auxilo" />`), 'og:site_name');
    assert.ok(TRUST_HTML.includes(`<meta property="og:url" content="${CANONICAL}" />`), 'og:url');
    assert.ok(TRUST_HTML.includes(`<meta property="og:title" content="${TITLE}" />`), 'og:title');
    assert.ok(TRUST_HTML.includes(`<meta property="og:description" content="${DESCRIPTION}" />`), 'og:description');
    assert.ok(TRUST_HTML.includes(`<meta property="og:image" content="https://auxilo.io/og-image.png" />`), 'og:image');
    assert.ok(TRUST_HTML.includes(`<meta name="twitter:card" content="summary_large_image" />`), 'twitter:card');
    assert.ok(TRUST_HTML.includes(`<meta name="twitter:title" content="${TITLE}" />`), 'twitter:title');
    assert.ok(TRUST_HTML.includes(`<meta name="twitter:description" content="${DESCRIPTION}" />`), 'twitter:description');
    assert.ok(TRUST_HTML.includes(`<meta name="twitter:image" content="https://auxilo.io/og-image.png" />`), 'twitter:image');
  });

  it('h1 = the spec\'s h1, and exactly one h1 on the page', () => {
    const h1Matches = TRUST_HTML.match(/<h1[^>]*>([\s\S]*?)<\/h1>/g) || [];
    assert.equal(h1Matches.length, 1, 'exactly one <h1>');
    assert.ok(h1Matches[0].includes(H1), `h1 reads "${H1}"`);
  });

  it('no "Claude Code" requirement phrase anywhere in the served page (Tyler\'s ruling 2026-09-06)', () => {
    assert.ok(!TRUST_HTML.includes('Claude Code'), 'the string "Claude Code" does not appear on the page');
  });

  it('sitemap.xml lists /how-submissions-work; llms.txt carries the spec\'s Quick-start line', () => {
    assert.ok(SITEMAP.includes(`<loc>${CANONICAL}</loc>`), 'sitemap has /how-submissions-work');
    assert.ok(LLMS_TXT.includes(LLMS_LINE), 'llms.txt carries the spec line verbatim');
  });

  it('structural: server.js registers the route and all four redirects', () => {
    assert.ok(SERVER_SRC.includes(`app.get('/how-submissions-work', (c) => {`), 'route handler present');
    for (const src of REDIRECT_SOURCES) {
      assert.ok(
        SERVER_SRC.includes(`app.get('${src}', (c) => c.redirect('/how-submissions-work', 301));`),
        `redirect handler present for ${src}`
      );
    }
  });

  it('§1b: the /status anchor is present in the withdrawals-sentence slot template', () => {
    const s1bStart = TRUST_HTML.indexOf('id="earnings-heading"');
    const s1bEnd = TRUST_HTML.indexOf('id="limits-heading"');
    assert.ok(s1bStart > 0 && s1bEnd > s1bStart, '§1b section located');
    const s1b = TRUST_HTML.slice(s1bStart, s1bEnd);
    assert.ok(
      /<a id="s1b-withdrawals-link" href="\/status">/.test(s1b),
      '§1b carries the /status anchor (precondition 2)'
    );
  });

  // ─── TRUST-PAGE-3 content pass: byte-compare every filled static slot
  // against the ship-rev fixture, plus the DOM-order / presence / rider /
  // Tyler-gated-empty checks. Static file reads — no server boot needed. ───

  it('hero subhead: byte-equal to the ship-rev E1 string', () => {
    assert.ok(TRUST_HTML.includes(`<p class="page-hero-sub">${SUBHEAD}</p>`), 'subhead renders verbatim');
  });

  it('§0 (operator callout): byte-equal to the ship-rev string', () => {
    assert.ok(TRUST_HTML.includes(`<h2 id="operator-callout-heading">If you run agents that will consume this catalog</h2>`), '§0 heading');
    assert.ok(TRUST_HTML.includes(`<p>${S0_CALLOUT}</p>`), '§0 body verbatim');
  });

  it('§1 (What Auxilo is): byte-equal to the ship-rev E2 string', () => {
    assert.ok(TRUST_HTML.includes(`<h2 id="what-auxilo-is-heading">What Auxilo is</h2>`), '§1 heading');
    assert.ok(TRUST_HTML.includes(`<p>${S1_BODY}</p>`), '§1 body verbatim (E2)');
  });

  it('§1b: earnings + withdrawals slots byte-equal to the ship-rev E3 string, /status anchor text present', () => {
    assert.equal(tpStaticCell(TRUST_HTML, 's1b-earnings-sentence'), S1B_EARNINGS_SENTENCE, 's1b-earnings-sentence verbatim');
    const withdrawalsMatch = TRUST_HTML.match(/<p id="s1b-withdrawals-sentence">([\s\S]*?)<\/p>/);
    assert.ok(withdrawalsMatch, 's1b-withdrawals-sentence present');
    assert.equal(
      withdrawalsMatch[1],
      `<a id="s1b-withdrawals-link" href="/status">${S1B_WITHDRAWALS_LINK_TEXT}</a>${S1B_WITHDRAWALS_REST}`,
      's1b-withdrawals-sentence verbatim, anchor text = "Withdrawals open soon"'
    );
  });

  it('§2 (Where learnings come from): byte-equal to the ship-rev E4/E5 strings', () => {
    assert.ok(TRUST_HTML.includes(`<h2 id="learnings-source-heading">Where learnings come from</h2>`), '§2 heading');
    assert.ok(TRUST_HTML.includes(S2_PARA1), '§2 paragraph 1 verbatim (E4)');
    assert.ok(TRUST_HTML.includes(S2_PARA2), '§2 paragraph 2 verbatim (E5)');
  });

  it('§3 (The submission path): byte-equal to the ship-rev strings, all four blocks', () => {
    assert.ok(TRUST_HTML.includes(`<h2 id="submission-path-heading">The submission path</h2>`), '§3 heading');
    for (const p of [S3_PARA1, S3_PARA2, S3_PARA3, S3_PARA4]) {
      assert.ok(TRUST_HTML.includes(`<p>${p}</p>`), `§3 block verbatim: "${p.slice(0, 40)}..."`);
    }
  });

  it('§4: static slots (asymmetry, invariant, provenance) byte-equal to the ship-rev strings', () => {
    assert.equal(tpStaticCell(TRUST_HTML, 's4-asymmetry'), S4_ASYMMETRY, 's4-asymmetry verbatim');
    assert.equal(tpStaticCell(TRUST_HTML, 's4-invariant'), S4_INVARIANT, 's4-invariant verbatim');
    assert.equal(tpStaticCell(TRUST_HTML, 's4-provenance'), S4_PROVENANCE, 's4-provenance verbatim');
  });

  it('§6 (Limits) is present and its four filled slots are byte-equal to the ship-rev / R-13 strings', () => {
    assert.ok(TRUST_HTML.includes('<h2 id="limits-heading">Limits</h2>'), '§6 heading renders — §6 present');
    assert.equal(tpStaticCell(TRUST_HTML, 's6-defenses-sentence'), S6_DEFENSES, 's6-defenses-sentence verbatim');
    assert.equal(tpStaticCell(TRUST_HTML, 's6-r13-slot'), S6_R13_LIMITS, 's6-r13-slot verbatim (TRUST-PAGE-R13-LIMITS-SLOT-2026-09-06.md rev 2)');
    assert.equal(tpStaticCell(TRUST_HTML, 's6-review-sentence'), S6_REVIEW, 's6-review-sentence verbatim');
    assert.equal(tpStaticCell(TRUST_HTML, 's6-hold-sentence'), S6_HOLD, 's6-hold-sentence verbatim');
  });

  it('§7: framing sentence and pinned labels byte-equal to the ship-rev / earnings.html-precedent strings', () => {
    assert.equal(tpStaticCell(TRUST_HTML, 's7-framing-sentence'), S7_FRAMING, 's7-framing-sentence verbatim');
    assert.equal(tpStaticCell(TRUST_HTML, 's7-learnings-label'), S7_LEARNINGS_LABEL, 's7-learnings-label verbatim (earnings.html precedent)');
    assert.equal(tpStaticCell(TRUST_HTML, 's7-unlocks-label'), S7_UNLOCKS_LABEL, 's7-unlocks-label verbatim (earnings.html precedent)');
  });

  it('no "any client" wording anywhere on the page (ship-rev header rider)', () => {
    assert.ok(!TRUST_HTML.includes('any client'), 'the phrase "any client" does not appear on the page');
  });

  it('§1b immediately follows §1 in DOM order (ship-rev header rider)', () => {
    const sectionIds = [...TRUST_HTML.matchAll(/<section aria-labelledby="([^"]+)">/g)].map((m) => m[1]);
    const s1Index = sectionIds.indexOf('what-auxilo-is-heading');
    assert.ok(s1Index >= 0, '§1 section present');
    assert.equal(sectionIds[s1Index + 1], 'earnings-heading', '§1b is the very next <section> after §1');
  });

  it('the cut adversarial sentence stays cut, and the §4 magnitude sentence never appears in the static file (ship-rev §9)', () => {
    // §9 item 1 was RULED YES 2026-09-06 (State B carries the magnitude
    // sentence) but the sentence is server-injected with SSR'd numbers
    // (renderTrustPagePartition) — it must never appear in the STATIC file,
    // which has no numbers to inject. See the TRUST-PAGE-SSR describe block
    // below for the live-rendered assertion.
    assert.ok(!TRUST_HTML.includes("Of the catalog's"), 'the State B magnitude sentence template never appears in the static file (it is server-injected only)');
    assert.ok(!TRUST_HTML.includes('adversarial submissions are expected'), 'the cut adversarial sentence (§9 item 3) stays cut');
  });
});

// ─── TRUST-PAGE-SSR fixtures (module scope — CH-7 guard: no assert-bearing
// helper may be defined or called inside a describe() body) ────────────────
//
// §4's conditional accountability block and §7's live catalog count, spec
// rev 3g findings 5/13, preconditions 3/6/7/8/11. Same fixture-catalog +
// controllable-ledger staged-server pattern as test/earnings-ssr-truth.test.js
// (whose withStagedServer is likewise module-scope, not describe-scope).

// The staged-server harness rewrites the WALLET const to this fixed
// test-derived address (helpers/staged-server.js WALLET_STAGED, matching
// the boot's WALLET_PRIVATE_KEY) — NOT the literal in server.js source.
// Using the source literal here would make a legitimately-platform row
// read as external under test.
const TP_PLATFORM_WALLET = '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A';
const TP_EXTERNAL_WALLET = '0xAbCdEf0123456789aBcDeF0123456789AbCdEf02';
const TP_EXTERNAL_ACCOUNT = 'acc_trust_ext_1';

function tpSeedBase() {
  const seed = JSON.parse(fs.readFileSync(path.join(REPO, 'seed-knowledge.json'), 'utf-8'));
  const base = Array.isArray(seed) ? seed[0] : seed.learnings[0];
  assert.ok(base, 'seed-knowledge.json must contain at least one learning');
  return base;
}

function tpRow(overrides) {
  const l = JSON.parse(JSON.stringify(tpSeedBase()));
  l.status = 'approved';
  delete l.visibility;
  l.contributor_account_id = null;
  l.contributor_wallet = null;
  l.quality = { ...(l.quality || {}), unlocks: 0, ratings: 0, avg_helpfulness: 0 };
  return Object.assign(l, overrides);
}

// ALL-INTERNAL catalog: one null/null (platform default) row plus one row
// explicitly on the platform wallet — both must resolve internal, so §4's
// partition state is "a" (no outside builder has published).
function tpAllInternalCatalog() {
  return [
    tpRow({ id: 'tp_int_a', title: 'internal a', category: 'code-execution' }),
    tpRow({ id: 'tp_int_b', title: 'internal b', category: 'code-execution', contributor_wallet: TP_PLATFORM_WALLET }),
  ];
}

// Adds one row with an unregistered external account id and an unregistered
// external wallet — neither isPlatformContributor nor the (empty, this
// build) operator register recognizes it, so it must resolve external and
// flip §4 to state "b".
function tpWithExternalCatalog() {
  return [
    ...tpAllInternalCatalog(),
    tpRow({ id: 'tp_ext_1', title: 'external', category: 'web-interaction',
      contributor_account_id: TP_EXTERNAL_ACCOUNT, contributor_wallet: TP_EXTERNAL_WALLET }),
  ];
}

// TRUST-P0 (2026-09-06 P0 fix): the live-bug shape. config/internal-identities.json
// (linked into the staged server via linkDirs, so this is the REAL tracked
// register, not a synthetic one) registers only the operator WALLET, never
// an account id. The live catalog's rows mostly carry the operator's real
// account id with NO wallet on that particular row — only one sibling row
// carries both the account id and the registered wallet. Pre-fix, the
// no-wallet rows read as external (data-partition-state="b", "An outside
// builder has published here") on a catalog with zero outside builders.
const TP_OPERATOR_WALLET = '0xA19Cf92cc1daCf742f0E50b4128cAD3A86A81EC4'; // config/internal-identities.json
const TP_OPERATOR_ACCOUNT = 'acc_trust_operator_real';

function tpOperatorLinkedCatalog() {
  return [
    tpRow({ id: 'tp_op_link', title: 'operator linking row', category: 'code-execution',
      contributor_account_id: TP_OPERATOR_ACCOUNT, contributor_wallet: TP_OPERATOR_WALLET }),
    tpRow({ id: 'tp_op_no_wallet_1', title: 'operator, no wallet on this row', category: 'code-execution',
      contributor_account_id: TP_OPERATOR_ACCOUNT }),
    tpRow({ id: 'tp_op_no_wallet_2', title: 'operator, no wallet on this row either', category: 'web-interaction',
      contributor_account_id: TP_OPERATOR_ACCOUNT }),
  ];
}

// Same operator account id, but the register never sees the wallet at all
// (no linking row anywhere in the catalog) — the documented residual: state
// stays 'b' until INTERNAL_IDENTITIES_EXTRA_ACCOUNT_IDS names it.
function tpOperatorUnlinkedCatalog() {
  return [
    tpRow({ id: 'tp_op_orphan_1', title: 'operator, never linked', category: 'code-execution',
      contributor_account_id: TP_OPERATOR_ACCOUNT }),
  ];
}

function tpLedgerLine(id, learning_id) {
  return JSON.stringify({
    id, ts: '2026-09-06T00:00:00.000Z', learning_id, amount_paid_usd: 0.05,
    funding_source: 'credit_pack', contributor_account_id: null, contributor_wallet: null, settled_onchain: false,
  });
}

function tpPartitionState(html) {
  const m = html.match(/id="s4-partition-state" data-partition-state="([^"]*)"/);
  assert.ok(m, 's4-partition-state marker present in the served HTML');
  return m[1];
}
// TRUST-PAGE-3 content pass: the text server-injected between the
// SSR:PARTITION-STATE markers (renderTrustPagePartition), distinct from the
// data-partition-state attribute tpPartitionState reads. TRUST-P0 (comment
// stripping, item 4): the served body no longer carries the
// <!-- SSR:PARTITION-STATE --> marker comments at all (they are stripped
// along with every other HTML comment) — read the text from the
// s4-partition-state element's own content instead of the now-absent
// markers. A dedicated test below (comment stripping) still asserts the
// markers are gone from the wire.
function tpPartitionStateText(html) {
  const m = html.match(/<([a-z]+) id="s4-partition-state" data-partition-state="[^"]*"[^>]*>([^<]*)<\/\1>/);
  assert.ok(m, 's4-partition-state element content present in the served HTML');
  return m[2];
}
function tpCell(html, id) {
  const m = html.match(new RegExp(`id="${id}"[^>]*>([^<]*)<`));
  assert.ok(m, `${id} cell present`);
  return m[1];
}

async function withTrustPageStagedServer(t, { catalog, ledger, env: envOverrides }, body) {
  let nodeModulesDir;
  try {
    const honoEntry = require.resolve('hono', { paths: [REPO] });
    nodeModulesDir = honoEntry.slice(0, honoEntry.lastIndexOf(`${path.sep}node_modules${path.sep}`) + '/node_modules'.length);
  } catch {
    t.skip('hono not resolvable from repo root — skipping real boot');
    return;
  }
  const reservation = await reservePort();
  if (reservation.skipReason) { t.skip(reservation.skipReason); return; }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auxilo-trust-page-ssr-'));
  let child = null;
  try {
    stageServer({
      repoRoot: REPO,
      tmpDir,
      nodeModulesDir,
      port: reservation.port,
      rootFiles: ['server.js', 'seed-knowledge.json', 'skills.json', 'openapi.json', 'package.json', 'model_config.json'],
      linkDirs: ['lib', 'public', 'prompts', 'config'],
      replacements: [],
    });
    const dataDir = path.join(tmpDir, 'data');
    fs.writeFileSync(path.join(dataDir, 'learnings.json'), JSON.stringify(catalog, null, 2));
    fs.writeFileSync(path.join(dataDir, 'earnings.json'), JSON.stringify({}, null, 2));
    fs.writeFileSync(path.join(dataDir, 'accounts.json'), JSON.stringify({}, null, 2));
    const ledgerPath = path.join(dataDir, 'unlock-events.jsonl');
    if (ledger === 'unreadable') fs.mkdirSync(ledgerPath); // EISDIR on read — not ENOENT
    else fs.writeFileSync(ledgerPath, ledger || '');

    const boot = await bootServer({
      tmpDir,
      port: reservation.port,
      env: {
        NODE_ENV: 'test',
        WALLET_PRIVATE_KEY: '0x' + '11'.repeat(32),
        LLM_SENSITIVITY_ENABLED: 'false',
        AUXILO_DATA_DIR: dataDir,
        AUXILO_ACCOUNTS_FILE: path.join(dataDir, 'accounts.json'),
        ...(envOverrides || {}),
      },
      timeoutMs: 60_000,
      maxAttempts: 4,
    });
    if (boot.skipReason) { t.skip(boot.skipReason); return; }
    child = boot.child;
    const pageRes = await fetch(`${boot.baseUrl}/how-submissions-work`);
    assert.equal(pageRes.status, 200);
    assert.match(pageRes.headers.get('content-type') || '', /text\/html/);
    const html = await pageRes.text();
    const statsRes = await fetch(`${boot.baseUrl}/knowledge/stats`);
    assert.equal(statsRes.status, 200);
    await body(html, pageRes, await statsRes.json(), boot);
  } finally {
    if (child) await stopServer(child);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

describe('TRUST-PAGE-SSR: §4 partition render + §7 live counts + no-store', { timeout: 300_000 }, () => {
  it('§4: all-internal catalog (null/null row + platform-wallet row) → data-partition-state="a"', { timeout: 240_000 }, async (t) => {
    await withTrustPageStagedServer(t, { catalog: tpAllInternalCatalog(), ledger: '' }, async (html) => {
      assert.equal(tpPartitionState(html), 'a', 'state a when the external count is zero');
    });
  });

  it('§4: catalog with one unregistered external row → data-partition-state="b"', { timeout: 240_000 }, async (t) => {
    await withTrustPageStagedServer(t, { catalog: tpWithExternalCatalog(), ledger: '' }, async (html) => {
      assert.equal(tpPartitionState(html), 'b', 'state b once an external contributor is present');
    });
  });

  it('§4: state A text is server-injected between the SSR:PARTITION-STATE markers, byte-equal to the ship-rev string', { timeout: 240_000 }, async (t) => {
    await withTrustPageStagedServer(t, { catalog: tpAllInternalCatalog(), ledger: '' }, async (html) => {
      assert.equal(tpPartitionStateText(html), S4_STATE_A, 'state A text verbatim');
    });
  });

  it('§4: state B renders the base sentence plus the magnitude sentence, SSR\'d numbers equal to computePartition (ship-rev §9 item 1, RULED YES 2026-09-06)', { timeout: 240_000 }, async (t) => {
    // tpWithExternalCatalog() = tpAllInternalCatalog()'s 2 internal rows
    // (tp_int_a, tp_int_b) plus 1 unregistered external row (tp_ext_1):
    // total_n = 3, external_n = 1 — the same computePartition() the state
    // marker itself is derived from, not a second/independent count.
    await withTrustPageStagedServer(t, { catalog: tpWithExternalCatalog(), ledger: '' }, async (html) => {
      const expected = `${S4_STATE_B_BASE} Of the catalog's 3 learnings, Auxilo published all but 1.`;
      assert.equal(tpPartitionStateText(html), expected, 'state B base + magnitude sentence verbatim, numbers = computePartition(total_n=3, external_n=1)');
    });
  });

  it('§4: the served page never carries both branch states — the marker is a single attribute value', { timeout: 240_000 }, async (t) => {
    await withTrustPageStagedServer(t, { catalog: tpWithExternalCatalog(), ledger: '' }, async (html) => {
      const matches = html.match(/data-partition-state="[^"]*"/g) || [];
      assert.equal(matches.length, 1, 'exactly one data-partition-state marker on the page');
    });
  });

  it('§7: counts are SSR\'d and equal GET /knowledge/stats (catalogStatsTruth)', { timeout: 240_000 }, async (t) => {
    const twoRowLedger = [tpLedgerLine('wal_tp_1', 'tp_int_a'), tpLedgerLine('wal_tp_2', 'tp_int_b')].join('\n') + '\n';
    await withTrustPageStagedServer(t, { catalog: tpAllInternalCatalog(), ledger: twoRowLedger }, async (html, _res, stats) => {
      assert.equal(tpCell(html, 's7-learnings-count'), String(stats.learnings_count), 'learnings count matches /knowledge/stats');
      assert.equal(tpCell(html, 's7-unlocks-count'), String(stats.total_unlocks), 'unlocks count matches /knowledge/stats (catalogStatsTruth)');
      assert.equal(stats.total_unlocks, 2);
    });
  });

  it('§7: unreadable ledger → unlocks cell keeps the static "…" placeholder (fail-closed), learnings count still renders', { timeout: 240_000 }, async (t) => {
    await withTrustPageStagedServer(t, { catalog: tpAllInternalCatalog(), ledger: 'unreadable' }, async (html, _res, stats) => {
      assert.equal(tpCell(html, 's7-unlocks-count'), '…', 'fail-closed placeholder, never a digit');
      assert.equal(Object.hasOwn(stats, 'total_unlocks'), false, 'stats also omits total_unlocks — one derivation, one failure mode');
      assert.equal(tpCell(html, 's7-learnings-count'), String(stats.learnings_count), 'learnings count is unaffected by the ledger failure');
    });
  });

  it('GET /how-submissions-work sends Cache-Control: no-store', { timeout: 240_000 }, async (t) => {
    await withTrustPageStagedServer(t, { catalog: tpAllInternalCatalog(), ledger: '' }, async (_html, res) => {
      assert.equal(res.headers.get('cache-control'), 'no-store');
    });
  });

  // TRUST-P0 (2026-09-06): the live-bug regression, end to end through the
  // real route and the REAL tracked config/internal-identities.json (linked
  // into the staged server, not a synthetic register). Pre-fix this served
  // data-partition-state="b" ("An outside builder has published here") on a
  // catalog with zero outside builders — root cause: operator rows carrying
  // the operator's account id with no wallet on that row read as external
  // because the register held only the operator's wallet, never the account
  // id, and nothing linked the two.
  it('TRUST-P0: operator account id + no wallet, linked via a sibling row through the REAL register → state a (was falsely state b)', { timeout: 240_000 }, async (t) => {
    await withTrustPageStagedServer(t, { catalog: tpOperatorLinkedCatalog(), ledger: '' }, async (html, _res, stats) => {
      assert.equal(tpPartitionState(html), 'a', 'linked operator rows must never fabricate State B');
      assert.equal(tpPartitionStateText(html), S4_STATE_A, 'state A text verbatim — no magnitude sentence rendered');
      assert.equal(stats.total_contributors, 1, 'sanity: /knowledge/stats agrees — one contributor (the operator account), matching computePartition state a');
    });
  });

  it('TRUST-P0: operator account id with NO wallet anywhere in the catalog (unlinkable) → state b (documented residual)', { timeout: 240_000 }, async (t) => {
    await withTrustPageStagedServer(t, { catalog: tpOperatorUnlinkedCatalog(), ledger: '' }, async (html) => {
      assert.equal(tpPartitionState(html), 'b', 'an account id the register never saw next to a registered wallet cannot be discovered by linking');
    });
  });

  it('TRUST-P0: the same unlinkable catalog resolves state a once INTERNAL_IDENTITIES_EXTRA_ACCOUNT_IDS names the account id (the documented mitigation)', { timeout: 240_000 }, async (t) => {
    await withTrustPageStagedServer(t, {
      catalog: tpOperatorUnlinkedCatalog(),
      ledger: '',
      env: { INTERNAL_IDENTITIES_EXTRA_ACCOUNT_IDS: TP_OPERATOR_ACCOUNT },
    }, async (html) => {
      assert.equal(tpPartitionState(html), 'a', 'env-extra mitigation resolves the residual without a code change');
    });
  });

  // TRUST-P0 item 4: serve-time comment stripping on this route only.
  it('TRUST-P0: the served page carries zero HTML comments (build-reference markers stripped at serve time)', { timeout: 240_000 }, async (t) => {
    assert.ok(TRUST_HTML.includes('<!--'), 'sanity: the SOURCE file does carry HTML comments (so this test is not vacuous)');
    assert.ok(TRUST_HTML.includes('SITE-PM'), 'sanity: the source carries the "SITE-PM" build-reference marker, and only inside comments');
    await withTrustPageStagedServer(t, { catalog: tpWithExternalCatalog(), ledger: '' }, async (html) => {
      assert.equal(html.includes('<!--'), false, 'zero "<!--" anywhere in the served body');
      assert.equal(html.includes('-->'), false, 'zero "-->" anywhere in the served body');
      assert.equal(html.includes('SSR:PARTITION-STATE'), false, 'the SSR marker comments themselves are stripped, not just their content');
      assert.equal(html.includes('SITE-PM'), false, 'the build-reference comment content itself is gone, not just its delimiters');
      // The content the markers wrapped must still be present and correct —
      // stripping removes the <!-- --> delimiters, never the substituted text.
      assert.ok(html.includes(S4_STATE_B_BASE), 'the state text survives comment-stripping');
    });
  });

  it('TRUST-P0: comment stripping does not remove ordinary visible text that merely contains the substrings "SSR:" or a build-rev token', { timeout: 240_000 }, async (t) => {
    await withTrustPageStagedServer(t, { catalog: tpAllInternalCatalog(), ledger: '' }, async (html) => {
      // The stripped page must still be well-formed enough to carry the
      // spec's required head tags and h1 — a regex-based stripper that ate
      // too much (e.g. matched greedily past the first "-->") would corrupt
      // the rest of the document; this is the corruption tripwire.
      assert.ok(html.includes(`<title>${TITLE}</title>`), 'title tag intact after stripping');
      assert.ok(html.includes(`<h1>${H1}</h1>`) || new RegExp(`<h1[^>]*>${H1.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</h1>`).test(html), 'h1 intact after stripping');
    });
  });
});

// ─── config/internal-identities.json: operator wallet registration ────────
// TRUST-PAGE-3 content pass: populates the register (was UNPOPULATED) with
// the operator wallet cited from this repo's own CLAUDE.md
// (`contributor_wallet` line — already public). Unit-level: exercises
// lib/partition-guard.js directly, no server boot needed.
describe('config/internal-identities.json: operator wallet register', () => {
  const { loadInternalIdentitiesRegister, computePartition, isOperatorIdentity } = require('../lib/partition-guard.js');
  const INTERNAL_IDENTITIES_FILE = path.join(REPO, 'config', 'internal-identities.json');
  const OPERATOR_WALLET = '0xA19Cf92cc1daCf742f0E50b4128cAD3A86A81EC4';

  it('the register loads with the operator wallet present, lowercased', () => {
    const register = loadInternalIdentitiesRegister(INTERNAL_IDENTITIES_FILE, {});
    assert.ok(register.wallets.has(OPERATOR_WALLET.toLowerCase()), 'operator wallet present in the loaded register, lowercased');
    assert.equal(register.accountIds.size, 0, 'account_ids stays empty per this build');
  });

  it('computePartition classes a row on the operator wallet as internal (state stays "a")', () => {
    const register = loadInternalIdentitiesRegister(INTERNAL_IDENTITIES_FILE, {});
    const neverPlatform = () => false; // isolate the operator-register path from isPlatformContributor
    const row = { contributor_account_id: null, contributor_wallet: OPERATOR_WALLET };
    assert.equal(
      isOperatorIdentity(row, register),
      true,
      'the operator wallet resolves as an operator identity regardless of case'
    );
    const partition = computePartition([row], {
      platformWallets: [],
      register,
      isPlatformContributorFn: neverPlatform,
    });
    assert.equal(partition.state, 'a', 'a catalog with only an operator-wallet row is internal-only (state a), not external');
    assert.equal(partition.external_n, 0, 'the operator-wallet row is not counted external');
  });

  it('a mixed-case operator wallet on a row still matches (register load lowercases, row lookup lowercases)', () => {
    const register = loadInternalIdentitiesRegister(INTERNAL_IDENTITIES_FILE, {});
    const mixedCaseRow = { contributor_account_id: null, contributor_wallet: OPERATOR_WALLET.toUpperCase() };
    assert.equal(isOperatorIdentity(mixedCaseRow, register), true, 'case-insensitive match on the operator wallet');
  });
});
