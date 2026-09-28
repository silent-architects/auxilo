'use strict';

/**
 * test/launch-wave-for-builders.test.js — LAUNCH-WAVE /for-builders
 * (2026-09-26), builder verification for REGISTER-B-REV2.md's /for-builders
 * section (rows B-01..B-24 + the restated M rows), REGISTER-F-FAQ-
 * DISCLOSURE.md rows F-02/F-03, the coordinator's first GOV-4 mid-build
 * ruling (B-24 scoped to what extraction produces; the sensitive-data FAQ
 * answer scoped the same way), and REGISTER-B-REV3-FOR-BUILDERS.md (second
 * pass, commit a7e6c86 -> shorter steps): rows R3-01..R3-05 plus Option C
 * from section 2 (the two-path paragraph above the untouched math block).
 * The R3 pass moved the drafting boundary pair back OUT of step 02 and
 * into the note under the steps (step 02 no longer claims a draft is
 * produced, so it owes no condition) — the reverse of the first pass's
 * placement. Sections 2-4 below reflect the R3 (current) placement.
 *
 * Static (source-level) checks only — no server boot, no browser.
 *
 * Runner: node --test test/launch-wave-for-builders.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const STATIC_HTML = fs.readFileSync(path.join(REPO, 'public', 'for-builders.html'), 'utf8');

// ─── Normalization helpers (per BUILDER-RULES: strip tags, decode entities,
// collapse whitespace, collapse space before punctuation) ──────────────────

function normalize(str) {
  return str
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s+([.,;:!?])/g, '$1')
    .trim();
}

function visibleText(html) {
  return normalize(
    html
      .replace(/<script[\s\S]*?<\/script>/g, ' ')
      .replace(/<style[\s\S]*?<\/style>/g, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
  );
}

function countOccurrences(haystack, needle) {
  if (needle === '') return 0;
  return haystack.split(needle).length - 1;
}

function renderedFaqAnswer(html, question) {
  const questionIndex = html.indexOf(`<span>${question}</span>`);
  assert.ok(questionIndex >= 0, `rendered FAQ question present: ${question}`);
  const answerMatch = html.slice(questionIndex).match(/<div class="faq-answer-inner">([\s\S]*?)<\/div>/);
  assert.ok(answerMatch, `rendered FAQ answer present: ${question}`);
  return answerMatch[1];
}

// CH-7: non-asserting core. Used directly in a describe() body (block 8
// below) purely to generate that block's per-entry dynamic it()s — describe
// scope must never assert (a failure there is silently swallowed under the
// npm-test flags), so this variant returns [] on any parse problem instead
// of throwing/asserting. The REAL, asserting validation of this same parse
// runs via faqJsonLdEntries() below, always from inside an it() body.
function faqJsonLdEntriesCore(html) {
  try {
    const scriptMatch = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
    if (!scriptMatch) return [];
    const data = JSON.parse(scriptMatch[1]);
    const graph = data['@graph'] || [];
    const faqNode = graph.find((n) => n['@type'] === 'FAQPage');
    return (faqNode && faqNode.mainEntity) || [];
  } catch {
    return [];
  }
}

function faqJsonLdEntries(html) {
  const scriptMatch = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  assert.ok(scriptMatch, 'FAQPage JSON-LD script present');
  const data = JSON.parse(scriptMatch[1]);
  const graph = data['@graph'] || [];
  const faqNode = graph.find((n) => n['@type'] === 'FAQPage');
  assert.ok(faqNode, 'FAQPage node present in JSON-LD');
  return faqNode.mainEntity;
}

function step(html, num) {
  const re = new RegExp(
    `<div class="step">\\s*<div class="step-header">\\s*<span class="step-number">${num}</span>\\s*</div>\\s*<h3>([^<]*)</h3>\\s*<p>([\\s\\S]*?)</p>\\s*</div>`
  );
  const m = html.match(re);
  assert.ok(m, `step ${num} located`);
  return { heading: m[1], body: m[2] };
}

function wordCount(str) {
  return normalize(str).split(/\s+/).filter(Boolean).length;
}

// CH-7: module scope, not describe scope (an assert-bearing helper declared
// inside a describe() body is the same silent-failure class as a literal
// describe-body assert — see test/ch7-describe-body-guard.test.js).
function mathBlock(html) {
  const start = html.indexOf('<h3>The Math (per Unlock)</h3>');
  assert.ok(start > -1, 'math block heading found');
  const footnoteStart = html.indexOf('<p id="math-footnote"', start);
  assert.ok(footnoteStart > start, 'math footnote found');
  const footnoteEnd = html.indexOf('</p>', footnoteStart);
  assert.ok(footnoteEnd > footnoteStart, 'math footnote close tag found');
  return html.slice(start, footnoteEnd + '</p>'.length);
}

// ─── Register text (verbatim, from REGISTER-B-REV2.md / REGISTER-F /
// REGISTER-B-REV3-FOR-BUILDERS.md) ──────────────────────────────────────────

const B01_TEXT = 'Your agent already works out fixes as it goes, so you write nothing new. Publish those fixes and they come back free when your agent asks Auxilo, signed in to your account. When another agent unlocks one, you earn.';
const R3_STEP01_BODY = 'One command does it. npx auxilo setup detects your client, registers Auxilo, and signs you in. Extraction stays off until you turn it on.';
const R3_STEP02_HEADING = 'Keep Working';
const R3_STEP02_BODY = 'Once extraction is on, it runs in the background while you work. Nothing your agent extracts goes live without your approval, which you give one learning at a time or in advance in your dashboard.';
const DRAFTING_BOUNDARY = 'Drafting runs through Claude Code, when you are signed in to it, or a provider key you set yourself. Without either, captured sessions are held and nothing is submitted.';
// credits-as-cash (register C, row C-06, revision 3) rewrites the rate
// sentence on the new one-balance basis. See test/launch-wave-for-builders.test.js
// section 3 below.
const R3_STEP03_TEXT_NORMALIZED = 'When another agent unlocks your learning, you earn 70% of the listed price, or 60% when Auxilo search surfaced it. Earnings depend on whether other agents unlock your learnings and are not guaranteed. Earnings accrue now. Withdrawals open soon.';
const TWO_PATH_STATEMENT = 'An agent paying with x402 pays the listed price. An agent paying with credits pays one credit, currently $0.125 on the Starter pack and $0.10 on the Growth and Pro packs, whatever the listed price.';
const NOT_GUARANTEED = 'Earnings depend on whether other agents unlock your learnings and are not guaranteed.';
// VISION PASS (BUILD-BRIEF-VISION.md, REGISTER-V-VISION.md rows V-02/V-03):
// the "Live Numbers" heading and its B-10 callout are retired. V-02 is the
// new heading, V-03 the new callout body.
const B09_HEADING = "Your Agent's Fixes Keep Working for You";
const B10_TEXT = 'Your agent gets a fix you publish back free when it asks Auxilo, signed in to your account. Other agents can unlock it again and again. You earn money when another agent unlocks it.';

const FEATURE_LIST_ITEMS = [
  'Automatic extraction from agent conversations and memory files',
  'Quality scoring with four-dimension assessment (specificity, actionability, novelty, completeness)',
  'You decide what publishes. Every learning waits for your approval, which you give one at a time in your private queue or in advance in your dashboard, and your first publication always passes an Auxilo review',
  '70% direct / 60% discovery contributor share on every unlock',
  'Withdraw to your bank via Stripe or in USDC on Base (both opening soon)',
];

const FORBIDDEN_STRINGS = [
  'every unlock',
  'every direct unlock',
  'every time another agent unlocks',
  'gets credited to your account',
  'captured automatically',
  'let it publish',
  'Sign + verify to start earning',
  'This is what sells.',
];

describe('LAUNCH-WAVE /for-builders: new tests (write-first, per BUILDER-RULES)', () => {
  describe('1. Hero sub equals B-01, no "open soon" in the hero', () => {
    it('the hero carries exactly one .builders-hero-sub paragraph, equal to B-01 verbatim', () => {
      const subs = [...STATIC_HTML.matchAll(/<p class="builders-hero-sub">([\s\S]*?)<\/p>/g)];
      assert.equal(subs.length, 1, 'exactly one .builders-hero-sub paragraph remains (the paused-rail second one is cut, B-02)');
      assert.equal(normalize(subs[0][1]), B01_TEXT, 'hero sub text equals B-01 verbatim');
    });

    it('the hero section contains no "open soon" (B-02 cut the paused-rail line)', () => {
      const heroMatch = STATIC_HTML.match(/<section id="builders-hero"[\s\S]*?<\/section>/);
      assert.ok(heroMatch, '#builders-hero section found');
      assert.doesNotMatch(heroMatch[0], /open soon/i, 'no "open soon" text survives in the hero');
    });
  });

  describe('2. Step 02 heading/body (R3: no draft claim, no boundary sentence, no word "draft"/"Drafts")', () => {
    it("step 02's heading is the R3-02 text (\"Keep Working\")", () => {
      const { heading } = step(STATIC_HTML, '02');
      assert.equal(heading, R3_STEP02_HEADING);
    });

    it("step 02's body equals the R3-03 text verbatim, carries no boundary sentence", () => {
      const { body } = step(STATIC_HTML, '02');
      assert.equal(normalize(body), R3_STEP02_BODY, "step 02's paragraph is the R3-03 text, nothing more");
      assert.doesNotMatch(body, /Drafting runs through/, 'no boundary sentence in step 02 (R3 moved it back to the note)');
    });

    it('step 02 contains no word "draft" or "Drafts" (R3: no claim that a draft is produced)', () => {
      const { heading, body } = step(STATIC_HTML, '02');
      assert.doesNotMatch(`${heading} ${body}`, /draft/i);
    });

    it('"Your Agent Drafts, You Approve" and "Knowledge Gets Scored" (earlier headings) are absent', () => {
      assert.doesNotMatch(STATIC_HTML, /Your Agent Drafts, You Approve/);
      assert.doesNotMatch(STATIC_HTML, /Knowledge Gets Scored/);
    });
  });

  describe("3. Step 03's body (credits-as-cash C-06: rate condensed to the one-balance sentence, two-path statement moved out)", () => {
    it('equals the C-06 text (normalized), contains "of the listed price", the not-guaranteed sentence, ends on "Withdrawals open soon.", and does not carry the two-path statement', () => {
      const { body } = step(STATIC_HTML, '03');
      const norm = normalize(body);
      assert.equal(norm, R3_STEP03_TEXT_NORMALIZED, "step 03's body equals the C-06 text verbatim");
      assert.match(norm, /of the listed price/);
      assert.ok(norm.includes(NOT_GUARANTEED), 'contains the not-guaranteed disclaimer');
      const sentences = norm.split(/(?<=[.!?])\s+/).filter(Boolean);
      assert.equal(sentences[sentences.length - 1], 'Withdrawals open soon.', 'last sentence is "Withdrawals open soon."');
      assert.ok(!body.includes(TWO_PATH_STATEMENT), 'step 03 no longer carries the two-path statement (R3 moves it to the money block section)');
    });
  });

  describe('4. The drafting boundary pair (R3: back in the note, exactly once; step 02 carries none; FIX-UNIT-2B Part A adds a second served location, in both its visible and JSON-LD forms; VISION PASS row V-12 prepends a new first sentence to the note)', () => {
    const V12_SENTENCE = 'To turn captured sessions into learnings, sign in to Claude Code or set your own model API key with <code style="font-family:var(--mono);font-size:12px;color:var(--aurum);">npx auxilo provider set</code>.';

    it('the boundary pair appears exactly three times in the raw served file: the JSON-LD mirror of the new FAQ answer (head), the note under the steps (body), and the new FAQ answer\'s visible text (body) — FIX-UNIT-2B Part A, Q-01 REV 2 requires it verbatim in both the visible answer and its JSON-LD twin', () => {
      assert.equal(countOccurrences(STATIC_HTML, DRAFTING_BOUNDARY), 3, 'boundary pair appears exactly three times: new-FAQ JSON-LD + the note + new-FAQ visible answer');
      const noteIdx = STATIC_HTML.indexOf('<p class="drafting-note">');
      assert.ok(noteIdx > -1, 'note located');
      const noteOccurrenceIdx = noteIdx + '<p class="drafting-note">'.length + V12_SENTENCE.length + 1;
      assert.equal(STATIC_HTML.slice(noteOccurrenceIdx, noteOccurrenceIdx + DRAFTING_BOUNDARY.length), DRAFTING_BOUNDARY, 'the boundary pair is the first text inside the note after V-12\'s new sentence');
    });

    it('V-12: the note opens on the new sentence, with the command rendered as code, verbatim', () => {
      assert.equal(countOccurrences(STATIC_HTML, V12_SENTENCE), 1, 'V-12 sentence appears exactly once');
      const noteIdx = STATIC_HTML.indexOf('<p class="drafting-note">');
      const openIdx = noteIdx + '<p class="drafting-note">'.length;
      assert.equal(STATIC_HTML.slice(openIdx, openIdx + V12_SENTENCE.length), V12_SENTENCE, 'V-12 sentence is the very first text inside the note');
    });

    it('the note under the three steps reads V-12\'s sentence, then the boundary pair, then the /works-with link sentence', () => {
      const noteMatch = STATIC_HTML.match(/<p class="drafting-note">([\s\S]*?)<\/p>/);
      assert.ok(noteMatch, '.drafting-note paragraph present');
      assert.equal(countOccurrences(STATIC_HTML, 'class="drafting-note"'), 1, 'exactly one drafting-note paragraph');
      const expected = `${V12_SENTENCE} ${DRAFTING_BOUNDARY} <a href="/works-with">See what Auxilo captures on each client</a>.`;
      assert.equal(noteMatch[1], expected, 'the note is V-12\'s sentence, then the boundary pair, then the linked sentence, period outside the link');
    });

    it('the note sits directly after .steps closes, inside #how-it-earns .container', () => {
      const sectionMatch = STATIC_HTML.match(/<section id="how-it-earns"[\s\S]*?<\/section>/);
      assert.ok(sectionMatch, '#how-it-earns section found');
      const stepsCloseThenNote = /<\/div>\s*<p class="drafting-note">/.test(sectionMatch[0]);
      assert.ok(stepsCloseThenNote, 'the note is the next sibling after .steps closes');
    });
  });

  describe('4b. The two-path statement and its Option C paragraph are CUT (VISION PASS row V-06): the credit-path arithmetic now lives inside the math block itself (V-08-T/V-09-T)', () => {
    it('the two-path statement is gone from the page entirely, not relocated', () => {
      assert.equal(countOccurrences(STATIC_HTML, TWO_PATH_STATEMENT), 0, 'two-path statement must not survive anywhere on the page');
      const bodyCopyParas = [...STATIC_HTML.matchAll(/<p class="body-copy">([\s\S]*?)<\/p>/g)];
      assert.ok(!bodyCopyParas.some((m) => normalize(m[1]).startsWith('What the buyer paid depends on how they pay')), 'the Option C paragraph itself is gone, not just reworded');
      // Positive control: the connect paragraph right before it (untouched by
      // this row) is still there, proving the extraction still finds real text.
      assert.ok(bodyCopyParas.some((m) => normalize(m[1]).startsWith('Set it up once with')), 'positive control: the connect paragraph is still present');
    });

    it('the math block sits directly after the connect paragraph, with nothing in between', () => {
      const scenarioIdx = STATIC_HTML.indexOf('<div class="earnings-scenario">');
      const connectParaIdx = STATIC_HTML.indexOf('Set it up once with');
      assert.ok(connectParaIdx > -1 && scenarioIdx > -1, 'connect paragraph and math block located');
      const between = STATIC_HTML.slice(STATIC_HTML.indexOf('</p>', connectParaIdx) + 4, scenarioIdx);
      assert.equal(normalize(between), '', 'no paragraph text sits between the connect paragraph and the math block now that V-06 cut the Option C paragraph');
    });
  });

  describe('4c. Each of the three step bodies is at most 45 words (R3 structure goal: lighter steps)', () => {
    for (const num of ['01', '02', '03']) {
      it(`step ${num}'s paragraph is <= 45 words`, () => {
        const { body } = step(STATIC_HTML, num);
        const count = wordCount(body);
        assert.ok(count <= 45, `step ${num} body is ${count} words, expected <= 45`);
      });
    }

    it("step 01's body equals the R3-01 text verbatim", () => {
      const { body } = step(STATIC_HTML, '01');
      assert.equal(normalize(body), R3_STEP01_BODY);
    });
  });

  describe('5. "Honest numbers" heading and "hockey-stick" absent; B-09/B-10 present', () => {
    it('the old heading and the "hockey-stick" line are gone', () => {
      assert.doesNotMatch(STATIC_HTML, /Honest numbers, from day one\./);
      assert.doesNotMatch(STATIC_HTML, /hockey-stick/);
    });

    it('B-09 heading ("Live Numbers") and the B-10 callout are present, verbatim', () => {
      assert.equal(countOccurrences(STATIC_HTML, `<h2 id="earnings-heading" >${B09_HEADING}</h2>`), 1);
      const calloutMatch = STATIC_HTML.match(/<div class="value-callout">([\s\S]*?)<\/div>/);
      assert.ok(calloutMatch, '.value-callout present');
      assert.equal(normalize(calloutMatch[1]), B10_TEXT);
    });
  });

  describe('6. The five-item feature list is gone', () => {
    for (const item of FEATURE_LIST_ITEMS) {
      it(`absent: "${item.slice(0, 50)}..."`, () => {
        assert.doesNotMatch(STATIC_HTML, new RegExp(item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').slice(0, 200)));
      });
    }
    it('the <ul class="feature-list"> element itself is gone', () => {
      assert.doesNotMatch(STATIC_HTML, /class="feature-list"/);
    });
  });

  describe('7. Forbidden strings absent from visible text and JSON-LD; no arrow between the accrual/withdrawal sentences', () => {
    for (const s of FORBIDDEN_STRINGS) {
      it(`absent: "${s}"`, () => {
        assert.equal(countOccurrences(STATIC_HTML, s), 0, `"${s}" must not appear anywhere on the page (visible or JSON-LD)`);
      });
    }
    it('no arrow character (→) survives on the page (the old "Earnings accrue now → withdrawals open soon" strip-pair form is retired)', () => {
      assert.doesNotMatch(STATIC_HTML, /→/, 'no U+2192 RIGHTWARDS ARROW anywhere on the page');
    });
  });

  describe('8. Every FAQPage answer stating 70%/60% carries the disclaimer + rail, never ends on the disclaimer, and matches its visible twin', () => {
    // CH-7: the tolerant core (never asserts/throws) is used here purely to
    // generate this block's per-entry dynamic it()s at describe time. The
    // real, asserting parse (faqJsonLdEntries, which can genuinely fail
    // loud) is exercised below inside an it() body.
    const entries = faqJsonLdEntriesCore(STATIC_HTML);
    const rateEntries = entries.filter((e) => /70%|60%/.test(e.acceptedAnswer.text));

    it('the FAQPage JSON-LD is present and parses to a mainEntity array (faqJsonLdEntries succeeds)', () => {
      assert.equal(faqJsonLdEntries(STATIC_HTML).length, entries.length, 'the asserting parse agrees with the tolerant describe-scope parse used to generate this block\'s tests');
    });

    it('at least one FAQ answer states a rate (sanity: the test has something to check)', () => {
      assert.ok(rateEntries.length >= 2, `expected >=2 rate-stating FAQ answers, found ${rateEntries.length}`);
    });

    for (const entry of entries) {
      const text = entry.acceptedAnswer.text;
      if (!/70%|60%/.test(text)) continue;
      it(`"${entry.name}": disclaimer present, "open soon" present, does not end on the disclaimer, JSON-LD equals visible twin`, () => {
        assert.ok(text.includes(NOT_GUARANTEED), 'JSON-LD answer contains the not-guaranteed disclaimer verbatim');
        assert.match(text, /open soon/i, 'JSON-LD answer contains "open soon"');
        assert.ok(!text.trim().endsWith(NOT_GUARANTEED), 'the disclaimer is never the last sentence of the answer');
        const visible = renderedFaqAnswer(STATIC_HTML, entry.name);
        assert.equal(normalize(visible), normalize(text), 'visible answer equals its JSON-LD twin after normalization');
      });
    }
  });

  describe('9. The math block (VISION PASS rows V-07/V-08-T/V-09-T, REV 3, TRUE TODAY): heading unchanged, body and footnote rewritten to the register\'s exact strings', () => {
    // REV 2/REV 3 correction (charter V7): the math block STAYS — the owner
    // ruled this twice on 2026-09-06 and the register says do not
    // re-litigate. credits-as-cash (register C, rows C-07/C-08, revision 3)
    // replaces this block again: credits are the same as cash now, so the
    // body's second (credit-path) dollar figure is cut — one balance, one
    // price, one highlighted figure — and the footnote drops the credit-pack
    // cost/repeat-cap caveats a dollar balance no longer has (build ruling
    // L3). This block replaces the prior V-08-T/V-09-T pin.
    const MATH_BODY = 'A learning listed at $1.00* earns you $0.70 (70%) when another agent pays to unlock it. You earn again* on the same learning when another agent unlocks it, and nothing you publish expires while it stays in the catalog.';
    const MATH_FOOTNOTE = '*Example price. You earn 60% when Auxilo search surfaced it. Some unlocks are issued as $0.00 promotional grants and earn nothing. Earnings accrue now. Withdrawals open soon.';

    it('the heading "The Math (per Unlock)" is unchanged (V-07: no change)', () => {
      assert.equal(countOccurrences(STATIC_HTML, '<h3>The Math (per Unlock)</h3>'), 1);
    });

    it('the body paragraph equals the C-07 text verbatim (normalized), exactly one dollar figure highlighted, on $0.70', () => {
      const block = mathBlock(STATIC_HTML);
      const bodyMatch = block.match(/<p>([\s\S]*?)<\/p>/);
      assert.ok(bodyMatch, 'body paragraph found');
      assert.equal(normalize(bodyMatch[1]), MATH_BODY, 'body paragraph equals C-07 verbatim');
      assert.equal((bodyMatch[1].match(/<span class="earnings-highlight">/g) || []).length, 1, 'exactly one earnings-highlight span');
      assert.match(bodyMatch[1], /<span class="earnings-highlight">\$0\.70<\/span>/, '$0.70 is the one highlighted figure');
      assert.doesNotMatch(bodyMatch[1], /\$0\.07 to \$0\.0875/, 'the credit-path second dollar figure is cut (credits-as-cash)');
      assert.equal((bodyMatch[1].match(/<sup aria-describedby="math-footnote">\*<\/sup>/g) || []).length, 2, 'both sup asterisks are present');
    });

    it('the footnote equals the C-08 text verbatim (normalized), sits directly beneath the body in the same parent, and links "Withdrawals open soon" to /status', () => {
      const block = mathBlock(STATIC_HTML);
      const footnoteMatch = block.match(/<p id="math-footnote"[^>]*>([\s\S]*?)<\/p>/);
      assert.ok(footnoteMatch, 'footnote paragraph found');
      assert.equal(normalize(footnoteMatch[1]), MATH_FOOTNOTE, 'footnote equals C-08 verbatim');
      assert.match(footnoteMatch[1], /<a href="\/status">Withdrawals open soon<\/a>/, '"Withdrawals open soon" links to /status');
    });

    it('the block carries none of the retired footnote strings (illustrative-at-a-common-price-point, auxilo.io/status inline, Auxilo is early)', () => {
      const block = mathBlock(STATIC_HTML);
      assert.doesNotMatch(block, /illustrative, at a common price point/);
      assert.doesNotMatch(block, /auxilo\.io\/status shows where things stand/);
      assert.doesNotMatch(block, /Auxilo is early/);
    });
  });

  describe('10. No em dash, no en dash in the visible text', () => {
    it('visible text (tags/style/script/comments stripped) contains no U+2014 or U+2013', () => {
      const text = visibleText(STATIC_HTML);
      assert.doesNotMatch(text, /—/, 'no em dash in visible text');
      assert.doesNotMatch(text, /–/, 'no en dash in visible text');
    });
  });

  describe('Coordinator mid-build ruling: B-24 footer note, FAQ sensitive-data scoping, GOV-4 "You Control What Publishes" untouched', () => {
    it('B-24: the footer CTA note reads the GOV-4-scoped final text, exactly once', () => {
      const text = 'Detects your client, registers you, and signs you in. Nothing your agent extracts goes live without your approval, which you give one learning at a time or in advance in your dashboard.';
      assert.equal(countOccurrences(STATIC_HTML, text), 1);
      assert.equal(countOccurrences(STATIC_HTML, '<p class="footer-cta-note">'), 1);
    });

    it('FAQ "What happens to sensitive data?": the scoped sentence lands in both the visible answer and its JSON-LD mirror, exactly once each', () => {
      const scoped = 'Second, nothing your agent extracts publishes without your approval.';
      const visible = renderedFaqAnswer(STATIC_HTML, 'What happens to sensitive data?');
      assert.equal(countOccurrences(normalize(visible), scoped), 1, 'visible answer carries the scoped sentence exactly once');
      const entries = faqJsonLdEntries(STATIC_HTML);
      const entry = entries.find((e) => e.name === 'What happens to sensitive data?');
      assert.ok(entry, 'JSON-LD entry present');
      assert.equal(countOccurrences(entry.acceptedAnswer.text, scoped), 1, 'JSON-LD answer carries the scoped sentence exactly once');
      assert.equal(countOccurrences(STATIC_HTML, 'Second, nothing publishes without your approval.'), 0, 'the old unscoped sentence is gone');
    });

    it('the "You Control What Publishes" block is untouched (owner-approved text, waits for his word)', () => {
      assert.equal(countOccurrences(STATIC_HTML, '<h2 id="why-builders-heading" >You Control What Publishes</h2>'), 1);
      const body = 'Raw transcripts never leave your machine. A local filter scans for credentials, secrets, and private data. It fails closed. How each screen works, and what it can miss, is on <a href="/how-submissions-work">the submissions page</a>. Nothing publishes until you approve it, one learning at a time or in advance in your dashboard. You can retract anything for 7 days.';
      assert.equal(countOccurrences(STATIC_HTML, body), 1);
    });

    it('"Codex" no longer appears anywhere on /for-builders (B-03 cut the only sentence naming it); /works-with carries the per-client detail instead', () => {
      assert.doesNotMatch(STATIC_HTML, /Codex/);
      assert.equal(countOccurrences(STATIC_HTML, 'href="/works-with"'), 2, 'nav link + the drafting-note link');
    });
  });

  describe('R3 round 3 (GOV-4, R3-06/07/08): "draft"/"write-up" survive ONLY inside the note (the boundary pair), nowhere else — visible text and JSON-LD', () => {
    const DRAFT_WORDS = /\b(drafts?|drafted|drafting)\b/gi;
    const WRITE_UP = /write-up/gi;

    it('positive control: the note under the steps DOES contain the word "Drafting" (the boundary pair itself uses it)', () => {
      const noteMatch = STATIC_HTML.match(/<p class="drafting-note">([\s\S]*?)<\/p>/);
      assert.ok(noteMatch, 'note present');
      assert.match(noteMatch[1], DRAFT_WORDS, 'sanity: the matcher finds the word where it is known to be present');
    });

    it('R3-06: the connect paragraph carries no "write-up" or draft word', () => {
      const bodyCopyParas = [...STATIC_HTML.matchAll(/<p class="body-copy">([\s\S]*?)<\/p>/g)];
      const connectPara = bodyCopyParas.find((m) => normalize(m[1]).startsWith('Set it up once with'));
      assert.ok(connectPara, 'connect paragraph found');
      assert.doesNotMatch(connectPara[1], DRAFT_WORDS);
      assert.doesNotMatch(connectPara[1], WRITE_UP);
      assert.match(normalize(connectPara[1]), /You keep working, you approve what your agent extracts/);
    });

    it('R3-07/R3-08: neither FAQ answer (visible or JSON-LD) carries a draft word any more', () => {
      const entries = faqJsonLdEntries(STATIC_HTML);
      for (const name of ['How do I monetize what my AI agent learns?', "What's the difference between an Auxilo learning and a hand-authored agent skill?"]) {
        const entry = entries.find((e) => e.name === name);
        assert.ok(entry, `JSON-LD entry present: ${name}`);
        assert.doesNotMatch(entry.acceptedAnswer.text, DRAFT_WORDS, `${name}: JSON-LD answer carries no draft word`);
        const visible = renderedFaqAnswer(STATIC_HTML, name);
        assert.doesNotMatch(visible, DRAFT_WORDS, `${name}: visible answer carries no draft word`);
      }
    });

    // FIX-UNIT-2B Part A (Q-01 REV 2): the new FAQ item "Does Auxilo work if
    // I do not use Claude Code?" is REQUIRED to carry the canonical boundary
    // sentence verbatim, in both its visible answer and its JSON-LD mirror —
    // a second approved location, alongside the drafting-note. The three
    // tests below are updated to exclude that one named question (by name,
    // same pattern R3-07/R3-08 above already uses for its own exceptions),
    // not to accept "draft" anywhere unnamed.
    const NEW_FAQ_QUESTION = 'Does Auxilo work if I do not use Claude Code?';

    it('outside the note and the new FAQ answer, the visible page text (tags/style/script/comments stripped) carries no draft or write-up word', () => {
      const noteMatch = STATIC_HTML.match(/<p class="drafting-note">[\s\S]*?<\/p>/);
      assert.ok(noteMatch, 'note present');
      const newFaqAnswerMatch = STATIC_HTML.match(/<span>Does Auxilo work if I do not use Claude Code\?<\/span>[\s\S]*?<div class="faq-answer-inner">([\s\S]*?)<\/div>/);
      assert.ok(newFaqAnswerMatch, 'new FAQ answer present');
      const withoutNote = STATIC_HTML.replace(noteMatch[0], '').replace(newFaqAnswerMatch[1], '');
      const text = visibleText(withoutNote);
      assert.doesNotMatch(text, DRAFT_WORDS, 'no draft/drafts/drafted/Drafting word survives outside the note and the new FAQ answer');
      assert.doesNotMatch(text, WRITE_UP, 'no "write-up" survives outside the note');
    });

    it('outside the new FAQ question, every FAQPage JSON-LD answer text carries no draft or write-up word (machine-readable surface, separate from visible text)', () => {
      const entries = faqJsonLdEntries(STATIC_HTML);
      assert.ok(entries.length > 0, 'sanity: at least one FAQ entry to check (an empty list would make the loop below vacuous)');
      for (const entry of entries) {
        if (entry.name === NEW_FAQ_QUESTION) continue;
        assert.doesNotMatch(entry.acceptedAnswer.text, DRAFT_WORDS, `${entry.name}: no draft word in JSON-LD`);
        assert.doesNotMatch(entry.acceptedAnswer.text, WRITE_UP, `${entry.name}: no write-up in JSON-LD`);
      }
    });

    it('every "draft" occurrence in the served (non-comment, non-style) surfaces is inside the note\'s boundary sentence or the new FAQ answer/its JSON-LD mirror', () => {
      // Stricter cross-check than the visible-text/JSON-LD tests above: scan
      // the raw file for every whole-word "draft" occurrence, exclude the
      // ones inside <style>...</style> and inside HTML/CSS comments (dev
      // documentation, never served as page content), and confirm every
      // remaining occurrence falls inside one of the two approved spans:
      // the note's own <p>, or the new FAQ item (its visible answer div and
      // its JSON-LD entry, both required to carry the boundary sentence).
      const withoutStyle = STATIC_HTML.replace(/<style[\s\S]*?<\/style>/g, ' ');
      const withoutComments = withoutStyle.replace(/<!--[\s\S]*?-->/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ');
      const allMatches = [...withoutComments.matchAll(/\b(drafts?|drafted|drafting)\b/gi)];
      const noteMatch = withoutComments.match(/<p class="drafting-note">[\s\S]*?<\/p>/);
      assert.ok(noteMatch, 'note present after stripping style/comments');
      const spans = [[withoutComments.indexOf(noteMatch[0]), withoutComments.indexOf(noteMatch[0]) + noteMatch[0].length]];

      const newFaqVisibleMatch = withoutComments.match(/<span>Does Auxilo work if I do not use Claude Code\?<\/span>[\s\S]*?<div class="faq-answer-inner">[\s\S]*?<\/div>/);
      assert.ok(newFaqVisibleMatch, 'new FAQ visible answer present after stripping style/comments');
      const visStart = withoutComments.indexOf(newFaqVisibleMatch[0]);
      spans.push([visStart, visStart + newFaqVisibleMatch[0].length]);

      const newFaqJsonMatch = withoutComments.match(/"name":\s*"Does Auxilo work if I do not use Claude Code\?"[\s\S]*?"text":\s*"[^"]*"/);
      assert.ok(newFaqJsonMatch, 'new FAQ JSON-LD entry present after stripping style/comments');
      const jsonStart = withoutComments.indexOf(newFaqJsonMatch[0]);
      spans.push([jsonStart, jsonStart + newFaqJsonMatch[0].length]);

      assert.ok(allMatches.length > 0, 'sanity: at least one match (the note itself)');
      for (const m of allMatches) {
        const inApprovedSpan = spans.some(([s, e]) => m.index >= s && m.index < e);
        assert.ok(inApprovedSpan, `unexpected "draft" occurrence outside every approved span, at index ${m.index}: ${JSON.stringify(withoutComments.slice(Math.max(0, m.index - 40), m.index + 40))}`);
      }
    });
  });

  describe('Sanity: meta description/og/twitter carry the M-48 text, 116 characters', () => {
    const M48_TEXT = 'Connect your agent and earn when other agents unlock what it learned. Earnings accrue now and withdrawals open soon.';
    it('all three head descriptions equal the M-48 text, 116 characters, no colon', () => {
      assert.equal(M48_TEXT.length, 116);
      assert.ok(!M48_TEXT.includes(':'));
      assert.equal(countOccurrences(STATIC_HTML, M48_TEXT), 3, 'description + og:description + twitter:description');
    });
  });
});
