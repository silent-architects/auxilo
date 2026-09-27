'use strict';

/**
 * test/launch-wave-for-builders.test.js — LAUNCH-WAVE /for-builders
 * (2026-09-26), builder verification for REGISTER-B-REV2.md's /for-builders
 * section (rows B-01..B-24 + the restated M rows), REGISTER-F-FAQ-
 * DISCLOSURE.md rows F-02/F-03, and the coordinator's GOV-4 mid-build
 * ruling (drafting boundary moves from the note into step 02; B-24 scoped
 * to what extraction produces; the sensitive-data FAQ answer scoped the
 * same way).
 *
 * Static (source-level) checks only — no server boot, no browser. Written
 * before the corresponding markup edits landed, per the builder rules
 * ("write new tests first, watch them fail, then build").
 *
 * Runner: node --test test/launch-wave-for-builders.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO = path.join(__dirname, '..');
const STATIC_HTML = fs.readFileSync(path.join(REPO, 'public', 'for-builders.html'), 'utf8');

let ORIGIN_MAIN_HTML = null;
try {
  ORIGIN_MAIN_HTML = execFileSync('git', ['show', 'origin/main:public/for-builders.html'], { cwd: REPO, encoding: 'utf8' });
} catch {
  ORIGIN_MAIN_HTML = null;
}

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

function faqJsonLdEntries(html) {
  const scriptMatch = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  assert.ok(scriptMatch, 'FAQPage JSON-LD script present');
  const data = JSON.parse(scriptMatch[1]);
  const graph = data['@graph'] || [];
  const faqNode = graph.find((n) => n['@type'] === 'FAQPage');
  assert.ok(faqNode, 'FAQPage node present in JSON-LD');
  return faqNode.mainEntity;
}

// ─── Register text (verbatim, from REGISTER-B-REV2.md / REGISTER-F) ───────

const B01_TEXT = 'Your agent already works out fixes as it goes, so you write nothing new. Publish those fixes and they come back free when your agent asks Auxilo, signed in to your account. When another agent unlocks one, you earn.';
const B04_HEADING = 'Your Agent Drafts, You Approve';
const B05_TEXT = 'Once extraction is on, this part happens for you. After a session ends, your agent writes up what it worked out and scores it for how specific, actionable, new, and complete it is. The score helps set the price and never publishes anything on its own. Auxilo refuses exact duplicates. What passes waits in your private review queue until you approve it, one learning at a time or in advance in your dashboard.';
const DRAFTING_BOUNDARY = 'Drafting runs through Claude Code, when you are signed in to it, or a provider key you set yourself. Without either, captured sessions are held and nothing is submitted.';
const STEP02_FULL_BODY = `${B05_TEXT} ${DRAFTING_BOUNDARY}`;
const B06_STEP03_TEXT_NORMALIZED = 'When another agent unlocks your learning, 70% of what they paid (60% when Auxilo search surfaced the learning to the buyer) accrues to your Auxilo account and remains payable to you under the Terms. What they paid depends on how they pay. An agent paying with x402 pays the listed price. An agent paying with credits pays one credit, currently $0.125 on the Starter pack and $0.10 on the Growth and Pro packs, whatever the listed price. Earnings depend on whether other agents unlock your learnings and are not guaranteed. Earnings accrue now. Withdrawals open soon.';
const NOT_GUARANTEED = 'Earnings depend on whether other agents unlock your learnings and are not guaranteed.';
const B09_HEADING = 'Live Numbers';
const B10_TEXT = "Auxilo launched on September 5, 2026. What you published comes back free when your agent asks Auxilo, signed in to your account. That works today and needs no buyers.";

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

  describe('2. Step 02 heading/body (GOV-4 override: boundary pair lives in step 02, not the note)', () => {
    function step(html, num) {
      const re = new RegExp(
        `<div class="step">\\s*<div class="step-header">\\s*<span class="step-number">${num}</span>\\s*</div>\\s*<h3>([^<]*)</h3>\\s*<p>([\\s\\S]*?)</p>\\s*</div>`
      );
      const m = html.match(re);
      assert.ok(m, `step ${num} located`);
      return { heading: m[1], body: m[2] };
    }

    it("step 02's heading is the B-04 text", () => {
      const { heading } = step(STATIC_HTML, '02');
      assert.equal(heading, B04_HEADING);
    });

    it("step 02's body is the B-05 text followed by the drafting boundary pair, in the same <p>", () => {
      const { body } = step(STATIC_HTML, '02');
      assert.equal(normalize(body), STEP02_FULL_BODY, "step 02's paragraph is B-05 + the boundary pair, verbatim");
    });

    it('"Knowledge Gets Scored" (the old step 02 heading) is absent', () => {
      assert.doesNotMatch(STATIC_HTML, /Knowledge Gets Scored/);
    });
  });

  describe("3. Step 03's body", () => {
    function step03Body(html) {
      const m = html.match(
        /<div class="step">\s*<div class="step-header">\s*<span class="step-number">03<\/span>\s*<\/div>\s*<h3>[^<]*<\/h3>\s*<p>([\s\S]*?)<\/p>\s*<\/div>/
      );
      assert.ok(m, 'step 03 located');
      return m[1];
    }

    it('equals the B-06 text (normalized), contains "of what they paid", the not-guaranteed sentence, and ends on "Withdrawals open soon."', () => {
      const body = step03Body(STATIC_HTML);
      const norm = normalize(body);
      assert.equal(norm, B06_STEP03_TEXT_NORMALIZED, "step 03's body equals the B-06 text verbatim");
      assert.match(norm, /of what they paid/);
      assert.ok(norm.includes(NOT_GUARANTEED), 'contains the not-guaranteed disclaimer');
      const sentences = norm.split(/(?<=[.!?])\s+/).filter(Boolean);
      assert.equal(sentences[sentences.length - 1], 'Withdrawals open soon.', 'last sentence is "Withdrawals open soon."');
    });
  });

  describe('4. The drafting boundary pair (GOV-4 override: exactly once, inside step 02; the note holds only the /works-with link)', () => {
    it('the boundary pair appears exactly once on the page, inside step 02\'s paragraph', () => {
      assert.equal(countOccurrences(STATIC_HTML, DRAFTING_BOUNDARY), 1, 'boundary pair appears exactly once');
      const idx = STATIC_HTML.indexOf(DRAFTING_BOUNDARY);
      const step02HeadingIdx = STATIC_HTML.indexOf('Your Agent Drafts, You Approve');
      const step03HeadingIdx = STATIC_HTML.indexOf('You Earn When Agents Unlock');
      assert.ok(step02HeadingIdx > -1 && step03HeadingIdx > -1, 'step 02/03 headings located');
      assert.ok(idx > step02HeadingIdx && idx < step03HeadingIdx, 'the boundary pair sits inside step 02, before step 03 begins');
    });

    it('the note under the three steps contains only the /works-with link sentence, no boundary sentence', () => {
      const noteMatch = STATIC_HTML.match(/<p class="drafting-note">([\s\S]*?)<\/p>/);
      assert.ok(noteMatch, '.drafting-note paragraph present');
      assert.equal(countOccurrences(STATIC_HTML, 'class="drafting-note"'), 1, 'exactly one drafting-note paragraph');
      assert.doesNotMatch(noteMatch[1], /Drafting runs through/, 'the note carries no boundary sentence (moved to step 02)');
      assert.match(noteMatch[1], /^<a href="\/works-with">See what Auxilo captures on each client<\/a>\.$/, 'the note is only the linked sentence, period outside the link');
    });

    it('the note sits directly after .steps closes, inside #how-it-earns .container', () => {
      const sectionMatch = STATIC_HTML.match(/<section id="how-it-earns"[\s\S]*?<\/section>/);
      assert.ok(sectionMatch, '#how-it-earns section found');
      const stepsCloseThenNote = /<\/div>\s*<p class="drafting-note">/.test(sectionMatch[0]);
      assert.ok(stepsCloseThenNote, 'the note is the next sibling after .steps closes');
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
    const entries = faqJsonLdEntries(STATIC_HTML);
    const rateEntries = entries.filter((e) => /70%|60%/.test(e.acceptedAnswer.text));

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

  describe("9. The math block's visible text is byte-for-byte unchanged from origin/main", () => {
    it('the block from "The Math (per Unlock)" through the end of its footnote is untouched', { skip: !ORIGIN_MAIN_HTML }, () => {
      function mathBlock(html) {
        const start = html.indexOf('<h3>The Math (per Unlock)</h3>');
        assert.ok(start > -1, 'math block heading found');
        const footnoteStart = html.indexOf('<p id="math-footnote"', start);
        assert.ok(footnoteStart > start, 'math footnote found');
        const footnoteEnd = html.indexOf('</p>', footnoteStart);
        assert.ok(footnoteEnd > footnoteStart, 'math footnote close tag found');
        return html.slice(start, footnoteEnd + '</p>'.length);
      }
      const currentBlock = mathBlock(STATIC_HTML);
      const originBlock = mathBlock(ORIGIN_MAIN_HTML);
      assert.equal(normalize(currentBlock), normalize(originBlock), 'math block visible text matches origin/main exactly');
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

  describe('Sanity: meta description/og/twitter carry the M-48 text, 116 characters', () => {
    const M48_TEXT = 'Connect your agent and earn when other agents unlock what it learned. Earnings accrue now and withdrawals open soon.';
    it('all three head descriptions equal the M-48 text, 116 characters, no colon', () => {
      assert.equal(M48_TEXT.length, 116);
      assert.ok(!M48_TEXT.includes(':'));
      assert.equal(countOccurrences(STATIC_HTML, M48_TEXT), 3, 'description + og:description + twitter:description');
    });
  });
});
