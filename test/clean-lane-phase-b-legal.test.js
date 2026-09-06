'use strict';

/**
 * test/clean-lane-phase-b-legal.test.js — CLEAN-LANE-FLIP Phase B (legal text +
 * counsel conditions; DRAFT pending Tyler's approval and licensed-counsel sign-off).
 *
 *   A. docs/TERMS-OF-SERVICE.md carries the new §5.9.3(g) paragraph appended AFTER
 *      the untouched (f) Audit log subsection, the ratchet sentence as its own
 *      paragraph immediately after (g), the §4.1 standing-consent clause (placed
 *      before the first-Learning semicolon), the 5.9.3 chapeau conforming edit,
 *      Last Updated = September 6, 2026, and an UNCHANGED acceptance version
 *      (`Current Amendment` id still equals lib/accounts.js CURRENT_TOS_VERSION).
 *   B. docs/PRIVACY-POLICY.md carries the §1.2 bullet directly after the
 *      Autonomous-extraction bullet and the §4 retention row directly after the
 *      audit-log row; Last Updated bumped; §7.6 untouched.
 *   C. Counsel condition (draft §5): the FULL (g) text renders ABOVE the affirmation
 *      on both enrollment surfaces — dashboard (<details open> block between the
 *      quality select and the checkbox, with a /terms link) and CLI (printed before
 *      the "type this sentence" prompt). The three copies (Terms, dashboard, CLI)
 *      are pinned byte-equal, so an edit to the Terms that is not mirrored fails here.
 *      (lib/clean-lane.js is not in the npm package's files[] and public/ is not
 *      shipped either, so the CLI copy has to be a literal — same reason as the
 *      affirmation sentence in test/clean-lane-phase-a.test.js.)
 *   D. server.js: the /learn response comment no longer promises a rollup email;
 *      it names the shipped channels only.
 *
 * Runner: node --test test/clean-lane-phase-b-legal.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(REPO, ...p), 'utf8');

const TOS = read('docs', 'TERMS-OF-SERVICE.md');
const PRIVACY = read('docs', 'PRIVACY-POLICY.md');
const DASHBOARD_HTML = read('public', 'dashboard.html');
const CLI_SRC = read('bin', 'auxilo-cli.js');
const SERVER_SRC = read('server.js');
const ACCOUNTS_SRC = read('lib', 'accounts.js');
const cli = require('../bin/auxilo-cli.js');

const G_LEAD = '**(g) Standing publication consent (optional).**';
const F_LEAD = '**(f) Audit log.**';
const G2_LEAD = 'The quality threshold in effect for a Builder is the one that Builder selected';
const S41_CLAUSE = 'is then either held in the Builder\'s review queue for the Builder\'s approval or published to the catalog on submission, depending on the screening result, the submission channel, and whether the Builder has activated standing publication consent under Section 5.9.3(g); a new account\'s first Learning is additionally held for operator review.';
const CHAPEAU_CLAUSE = 'until the Builder publishes them, except as provided in subsection (g).';
const LAST_UPDATED = '**Last Updated: September 6, 2026**';

/** The (g) paragraph and the ratchet paragraph, as markdown, sliced out of the Terms. */
function termsParagraphs() {
  const start = TOS.indexOf(G_LEAD);
  assert.ok(start > -1, 'Terms must carry the (g) lead-in');
  const rest = TOS.slice(start).split('\n\n');
  return { g: rest[0], g2: rest[1] };
}

const stripMd = (s) => s.replace(/\*\*(.+?)\*\*/g, '$1');
const stripHtml = (s) => s.replace(/<\/?strong>/g, '');

// ─────────────────────────────────────────────────────────────────────────────
// A. Terms of Service
// ─────────────────────────────────────────────────────────────────────────────
describe('Terms of Service: §5.9.3(g), ratchet paragraph, §4.1 clause, chapeau, header', () => {
  it('(g) is appended after (f) Audit log, which is untouched and still lettered (f), each exactly once', () => {
    assert.equal((TOS.match(/\*\*\(f\) Audit log\.\*\*/g) || []).length, 1, '(f) exactly once — never renumbered');
    assert.equal(TOS.split(G_LEAD).length - 1, 1, '(g) exactly once');
    const fIdx = TOS.indexOf(F_LEAD);
    const gIdx = TOS.indexOf(G_LEAD);
    assert.ok(fIdx < gIdx, '(g) comes after (f)');
    const between = TOS.slice(fIdx, gIdx);
    assert.equal((between.match(/\n\n/g) || []).length, 1, '(g) is the very next paragraph after (f)');
    assert.ok(gIdx < TOS.indexOf('#### 5.9.4 Retraction Right'), '(g) sits inside 5.9.3, before 5.9.4');
    // No (h) or later; nothing else got re-lettered.
    assert.doesNotMatch(TOS, /\*\*\(h\) /);
  });

  it('(g) is one paragraph with the nine operative statements the draft traces to code', () => {
    const { g } = termsParagraphs();
    assert.ok(!g.includes('\n'), 'single paragraph');
    for (const phrase of [
      'is off by default',
      'typing the affirmation sentence shown on that screen',
      'durable, hash-chained consent log, retained for the life of the account plus three (3) years under subsection (b)',
      'published without separate per-item approval only if it passes every Platform screen and the quality threshold the Builder chose at activation',
      "An account's first public Learning is never published this way; it is held for operator review under Section 4.1",
      "records each such publication in the Builder's dashboard and returns a notice in the response to the submission that produced it",
      'retractable for seven (7) days under Section 5.9.4',
      'more than five percent (5%)',
      'thirty (30) day period',
      'freezes the feature for that account until the Builder turns it on again',
      'turn it off at any time, effective immediately for later submissions',
      'Subsection (c) applies in full to every Learning so published.',
    ]) assert.ok(g.includes(phrase), `(g) must say: ${phrase}`);
    assert.ok(g.endsWith('Subsection (c) applies in full to every Learning so published.'));
    // Red-team #2 closure: the notice representation never promises receipt or an email.
    assert.ok(!/will notify/i.test(g) && !/e-?mail/i.test(g), '(g) must not say "will notify" or mention email');
  });

  it('the ratchet sentence is its own paragraph immediately after (g)', () => {
    const { g2 } = termsParagraphs();
    assert.ok(g2.startsWith(G2_LEAD), 'ratchet paragraph directly follows (g)');
    assert.ok(g2.endsWith('Auxilo may make those conditions stricter at any time.'));
    assert.ok(g2.includes('will not broaden the conditions under which a Learning qualifies for publication under this subsection without recording a new consent'));
    assert.equal(TOS.split(G2_LEAD).length - 1, 1, 'ratchet exactly once');
  });

  it('§4.1 carries the standing-consent clause BEFORE the first-Learning semicolon (dark-path-b2 Appendix B fix)', () => {
    const s41 = /### 4\.1 How It Works\n\n(.+)\n/.exec(TOS);
    assert.ok(s41, '§4.1 present');
    assert.ok(s41[1].includes(S41_CLAUSE),
      'clause sits between "review queue" and the semicolon so operator review governs both branches');
    assert.equal(TOS.split('standing publication consent under Section 5.9.3(g)').length - 1, 1);
  });

  it('5.9.3 chapeau is conformed ("except as provided in subsection (g)") exactly once', () => {
    assert.equal(TOS.split(CHAPEAU_CLAUSE).length - 1, 1);
    assert.ok(!TOS.includes('until the Builder publishes them. Session transcripts'), 'the unqualified promise is gone');
  });

  it('header: Last Updated bumped, the acceptance version (Current Amendment id) UNCHANGED and equal to CURRENT_TOS_VERSION', () => {
    assert.ok(TOS.includes(LAST_UPDATED));
    assert.ok(!TOS.includes('**Last Updated: September 5, 2026**'));
    const current = /Current Amendment: `([^`]+)`/.exec(TOS);
    assert.ok(current, 'Current Amendment banner still present');
    assert.equal(current[1], '2026-07-04-payee-agency-a1', 'acceptance version stays — Non-Material change (draft §4)');
    const server = /CURRENT_TOS_VERSION\s*=\s*'([^']+)'/.exec(ACCOUNTS_SRC);
    assert.ok(server);
    assert.equal(current[1], server[1], 'predeploy-check invariant: the first Current Amendment id equals the server version');
    assert.equal((TOS.match(/Current Amendment: `/g) || []).length, 1, 'only ONE "Current Amendment:" line — the new banner must not use that label');
    // The one added banner line follows the amendment banner and names the (g) addition.
    const banner = /\*\*Amendment `2026-09-06-clean-lane-b1`[^\n]*\n/.exec(TOS);
    assert.ok(banner, 'a dated banner line for the (g) addition follows the 2026-07-04 precedent');
    assert.ok(banner[0].includes('Section 5.9.3(g)') && banner[0].includes('unchanged'));
    assert.ok(TOS.indexOf('Current Amendment: `') < banner.index && banner.index < TOS.indexOf('\n---\n'));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B. Privacy Policy
// ─────────────────────────────────────────────────────────────────────────────
describe('Privacy Policy: §1.2 bullet, §4 retention row, header', () => {
  it('§1.2 bullet sits directly after the Autonomous-extraction drafts bullet, exactly once', () => {
    const lead = '- **Standing publication consent record.**';
    assert.equal(PRIVACY.split(lead).length - 1, 1);
    const lines = PRIVACY.split('\n');
    const i = lines.findIndex((l) => l.startsWith(lead));
    assert.ok(lines[i - 1].startsWith('- **Autonomous extraction Learning drafts.**'), 'placed after the autonomous-extraction bullet');
    const bullet = lines[i];
    for (const phrase of [
      '(ToS §5.9.3(g))',
      'the version of the consent text, the timestamp, a truncated IP address, the User-Agent string',
      'whether the choice was made on the website or through the command line',
      'the quality threshold selected and the Terms version in effect at the time',
      'same categories of information described in Section 1.4',
      'evidence of your consent (see Section 4)',
    ]) assert.ok(bullet.includes(phrase), `bullet must say: ${phrase}`);
    const s12 = PRIVACY.indexOf('### 1.2 Content and Submission Data');
    const s13 = PRIVACY.indexOf('### 1.3 ');
    assert.ok(s12 < PRIVACY.indexOf(lead) && PRIVACY.indexOf(lead) < s13, 'inside §1.2, not §7.6');
  });

  it('§4 retention row sits directly after the audit-log row, mirrors the §5.9.3(b) period', () => {
    const row = '| Standing publication consent record (consent version, timestamp, truncated IP address, User-Agent, accept path, selected quality threshold, Terms version at grant) | Life of account + 3 years | Evidentiary record of your standing publication consent per ToS §5.9.3(g) |';
    assert.equal(PRIVACY.split(row).length - 1, 1);
    const lines = PRIVACY.split('\n');
    const i = lines.indexOf(row);
    assert.equal(lines[i - 1], '| Autonomous extraction audit log | 3 years from event date | Audit trail per ToS §5.9.3(f) |');
    assert.ok(lines[i - 2].startsWith('| Autonomous extraction consent log | Life of account + 3 years |'), 'consent-class rows stay together');
  });

  it('Last Updated bumped; §7.6 (LLM providers) unchanged in scope', () => {
    assert.ok(PRIVACY.includes(LAST_UPDATED));
    assert.ok(!PRIVACY.includes('**Last Updated: September 5, 2026**'));
    const s76 = PRIVACY.slice(PRIVACY.indexOf('### 7.6 LLM Providers'), PRIVACY.indexOf('## 8. Your Rights'));
    assert.ok(!/standing publication consent/i.test(s76), 'no §7.6 change');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C. Counsel condition — full (g) text ABOVE the affirmation, byte-equal everywhere
// ─────────────────────────────────────────────────────────────────────────────
describe('enrollment surfaces render the full (g) text above the affirmation, byte-equal to the Terms', () => {
  it('Terms (markdown), dashboard (HTML) and CLI (literal) copies of (g) and the ratchet are byte-equal', () => {
    const { g, g2 } = termsParagraphs(); // asserts live inside the it() body (CH-7 sweep)
    const gPlain = stripMd(g);
    const dashG = /<p id="clean-lane-terms-g"[^>]*>(.*?)<\/p>/.exec(DASHBOARD_HTML);
    const dashG2 = /<p id="clean-lane-terms-g2"[^>]*>(.*?)<\/p>/.exec(DASHBOARD_HTML);
    assert.ok(dashG && dashG2, 'dashboard carries both paragraphs');
    // The dashboard keeps the bold lead-in as <strong>; nothing else differs.
    assert.equal(dashG[1], g.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>'));
    assert.equal(stripHtml(dashG[1]), gPlain);
    assert.equal(dashG2[1], g2);
    assert.equal(cli.CLEAN_LANE_TERMS_G, gPlain);
    assert.equal(cli.CLEAN_LANE_TERMS_G2, g2);
    assert.ok(!gPlain.includes('**') && !gPlain.includes('<'), 'plain text has no markup');
  });

  it('dashboard: the <details open> block sits between the quality select and the affirmation checkbox, links /terms', () => {
    const selEnd = DASHBOARD_HTML.indexOf('</select>', DASHBOARD_HTML.indexOf('<select id="clean-lane-min-quality"'));
    const details = DASHBOARD_HTML.indexOf('<details open id="clean-lane-terms"');
    const box = DASHBOARD_HTML.indexOf('<input type="checkbox" id="clean-lane-agree"');
    assert.ok(selEnd > -1 && details > selEnd && details < box, 'block directly above the checkbox');
    const block = DASHBOARD_HTML.slice(details, DASHBOARD_HTML.indexOf('</details>', details));
    assert.ok(block.indexOf('id="clean-lane-terms-g"') < block.indexOf('id="clean-lane-terms-g2"'));
    assert.match(block, /<a href="\/terms"[^>]*>Read the full Terms of Service<\/a>/);
    assert.ok(!/<details open[^>]*>[\s\S]*?<\/details>/.exec(DASHBOARD_HTML.slice(details))[0].includes('clean-lane-agree'),
      'the checkbox is not inside the block');
    assert.equal((DASHBOARD_HTML.match(/id="clean-lane-terms"/g) || []).length, 1);
    assert.ok(!/e-?mail/i.test(block), 'enrollment copy never mentions email (draft §6 read #2, move 2)');
  });

  it('CLI: grant prints the (g) text, then the ratchet, then the /terms pointer, BEFORE the typed-sentence prompt', () => {
    const fn = CLI_SRC.slice(CLI_SRC.indexOf('async function cmdCleanLane'));
    const printG = fn.indexOf('console.log(wrapForTerminal(CLEAN_LANE_TERMS_G))');
    const printG2 = fn.indexOf('console.log(wrapForTerminal(CLEAN_LANE_TERMS_G2))');
    const terms = fn.indexOf('/terms`');
    const prompt = fn.indexOf('type this sentence exactly as written');
    const typed = fn.indexOf("const typed = await ask('> ')");
    assert.ok(printG > -1 && printG2 > printG && terms > printG2 && prompt > terms && typed > prompt,
      'order: (g) → ratchet → Full Terms → prompt → ask');
    assert.ok(!CLI_SRC.includes("require('../lib/clean-lane.js')"), 'package boundary: never require the unshipped server module');
    assert.ok(!CLI_SRC.includes("require('../public/"), 'public/ is not shipped either');
  });

  it('wrapForTerminal changes whitespace only — the words of (g) survive verbatim', () => {
    const wrapped = cli.wrapForTerminal(cli.CLEAN_LANE_TERMS_G);
    assert.equal(wrapped.replace(/\n\s+/g, ' ').replace(/^\s+/, ''), cli.CLEAN_LANE_TERMS_G);
    for (const line of wrapped.split('\n')) assert.ok(line.length <= 80, `line ≤ 80 cols: ${line.length}`);
    assert.equal(cli.wrapForTerminal('one two', 3), '  one\n  two');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D. server.js comment: no email promise
// ─────────────────────────────────────────────────────────────────────────────
describe('server.js /learn standing-consent notice comment', () => {
  it('no longer promises a rollup email; names the shipped channels', () => {
    assert.ok(!SERVER_SRC.includes('rollup email rides the C1 activation'), 'stale design note withdrawn');
    const hit = SERVER_SRC.indexOf('per-publish notice for standing-consent publishes');
    assert.ok(hit > -1);
    const idx = SERVER_SRC.lastIndexOf('\n', hit) + 1; // start of the `// SPEC3 C1 (§4.3): ...` line
    const comment = SERVER_SRC.slice(idx, SERVER_SRC.indexOf('...(cleanLanePublish && {', idx));
    assert.ok(comment.includes('response field (in-band)'));
    assert.ok(comment.includes('Published under standing') && comment.includes('session notice'));
    assert.ok(comment.includes('No email'));
    assert.ok(comment.split('\n').every((l) => l.trim() === '' || l.trim().startsWith('//')), 'comment-only change');
  });
});
