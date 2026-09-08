'use strict';

/**
 * test/faq-consolidation.test.js — SITE-RESTRUCTURE-W3 item A (2026-09-07,
 * Tyler-approved structural ruling: "one canonical FAQ per topic domain,
 * cut cross-page overlap").
 *
 * ~/.auxilo/handoffs/SITE-RESTRUCTURE-W3-SPEC-2026-09-07.md, section A.
 *
 * 31 questions across six pages collapse to 18. Every kept question/answer
 * is carried byte-identical (no new or transitional copy was composed for
 * this item). The moves/cuts:
 *
 *   - /how-it-works loses its entire FAQ section (all 9 questions cut —
 *     each one's fact is already covered elsewhere on the page or has a
 *     canonical home on another page).
 *   - /for-builders loses 1 question ("What kind of agents can connect?"),
 *     which MOVES verbatim to /for-agents (appended as its 3rd question).
 *   - /for-builders separately CUTS 1 question ("Is search free for my
 *     agents?") with no destination — it duplicated /for-agents/pricing
 *     content.
 *   - /pricing CUTS 3 questions ("Is searching the Auxilo catalog free?",
 *     "How much do builders earn on Auxilo?", "When can I withdraw my
 *     Auxilo earnings?") — each restated a fact already stated multiple
 *     times elsewhere on the same page.
 *   - / (homepage) and /api are unchanged.
 *
 * This file checks, per page: the exact kept-question set (text + count +
 * order), that JSON-LD FAQPage mainEntity matches the rendered FAQ
 * question set exactly (name + count + order — answer-text parity between
 * JSON-LD and DOM is a PRE-EXISTING, out-of-scope condition on some pages
 * or nowhere near a 1:1; see the "JSON-LD prose may paraphrase" note
 * below), a site-wide no-duplicate-question assertion, and positive
 * controls for every moved/cut question (1 occurrence pre-move location
 * verified absent, destination verified present exactly once).
 *
 * NOTE on JSON-LD/DOM "answer text": some pages (this predates this
 * change — e.g. the homepage's Q2, or /for-agents' Q2) carry a JSON-LD
 * answer that paraphrases the rendered answer rather than being byte-
 * identical to it. That drift is pre-existing and out of this item's
 * scope (COMPOSE NOTHING — this item moves/cuts, it does not rewrite).
 * What this item's own contract requires, and what these tests enforce,
 * is that the JSON-LD mainEntity's *question set* (name, count, order)
 * matches the rendered FAQ's question set exactly on every touched page.
 *
 * Runner: node --test test/faq-consolidation.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(REPO_ROOT, 'public');

function readPublic(relPath) {
  return fs.readFileSync(path.join(PUBLIC_DIR, relPath), 'utf8');
}

/** Parse every FAQPage JSON-LD node's mainEntity question names, in order. */
function jsonLdQuestionNames(html) {
  const scriptMatch = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  if (!scriptMatch) return [];
  const data = JSON.parse(scriptMatch[1]);
  const graph = data['@graph'] || [];
  const faqNode = graph.find((n) => n['@type'] === 'FAQPage');
  if (!faqNode) return [];
  return faqNode.mainEntity.map((q) => q.name);
}

/** Parse every rendered FAQ item's question text (the <span> inside .faq-question), in order. */
function renderedQuestionNames(html) {
  const faqSectionMatch = html.match(/<section id="faq"[\s\S]*?<\/section>/);
  if (!faqSectionMatch) return [];
  const section = faqSectionMatch[0];
  const spans = [...section.matchAll(/<button class="faq-question"[^>]*>\s*<span>([^<]+)<\/span>/g)];
  return spans.map((m) => m[1]);
}

// The full, exact expected question set per page after consolidation
// (SITE-RESTRUCTURE-W3-SPEC-2026-09-07.md section A, "What stays").
const EXPECTED = {
  'index.html': [
    'How do AI agents share knowledge with each other?',
    'What is a knowledge marketplace for AI agents?',
    'What makes a shared agent marketplace different from private agent memory?',
  ],
  'how-it-works.html': [],
  'for-agents.html': [
    'How do I stop my AI agent from making the same mistake twice?',
    'How do I connect my AI agent to Auxilo?',
    'What kind of agents can connect?',
  ],
  'for-builders.html': [
    "How does the revenue share work?",
    "What's the minimum to start earning?",
    'Who sets the price for my learnings?',
    'What happens to sensitive data?',
    'Do I need a crypto wallet?',
    'How do I monetize what my AI agent learns?',
    "What's the difference between an Auxilo learning and a hand-authored agent skill?",
  ],
  'pricing.html': [
    'How much does it cost to unlock a learning on Auxilo?',
    'Can one learning earn more than once?',
    'What are Auxilo credit packs?',
  ],
  'api.html': [
    'How do AI agents pay each other with x402?',
    'Does Auxilo have a real example of agents paying each other?',
  ],
};

const PAGES = Object.keys(EXPECTED);

describe('FAQ consolidation (SITE-RESTRUCTURE-W3 item A): per-page question sets', () => {
  for (const page of PAGES) {
    it(`${page} carries exactly the expected kept questions, in order (rendered FAQ)`, () => {
      const html = readPublic(page);
      const rendered = renderedQuestionNames(html);
      assert.deepEqual(rendered, EXPECTED[page], `${page} rendered FAQ question set/order must match the spec`);
    });

    it(`${page} carries exactly the expected kept questions, in order (FAQPage JSON-LD)`, () => {
      const html = readPublic(page);
      const jsonLd = jsonLdQuestionNames(html);
      assert.deepEqual(jsonLd, EXPECTED[page], `${page} FAQPage JSON-LD question set/order must match the spec`);
    });
  }

  it('the total kept-question count across all six pages is 18 (31 -> 18)', () => {
    const total = PAGES.reduce((sum, page) => sum + EXPECTED[page].length, 0);
    assert.equal(total, 18, 'net effect of the consolidation is 31 -> 18 questions');
  });
});

describe('FAQ consolidation: JSON-LD <-> DOM equality per page', () => {
  for (const page of PAGES) {
    it(`${page}: FAQPage JSON-LD mainEntity matches the rendered FAQ set exactly (name, count, order)`, () => {
      const html = readPublic(page);
      const jsonLd = jsonLdQuestionNames(html);
      const rendered = renderedQuestionNames(html);
      assert.deepEqual(jsonLd, rendered, `${page}: JSON-LD and DOM question sets must be identical in name, count, and order`);
    });
  }
});

describe('FAQ consolidation: site-wide no-duplicate-question assertion', () => {
  it('no question text appears on more than one page', () => {
    const seenOn = new Map(); // question text -> [pages]
    for (const page of PAGES) {
      for (const q of EXPECTED[page]) {
        if (!seenOn.has(q)) seenOn.set(q, []);
        seenOn.get(q).push(page);
      }
    }
    const dupes = [...seenOn.entries()].filter(([, pages]) => pages.length > 1);
    assert.deepEqual(dupes, [], `every kept question must appear on exactly one page; duplicates found: ${JSON.stringify(dupes)}`);
  });

  it('no question text is repeated within a single page\'s own FAQ (rendered)', () => {
    for (const page of PAGES) {
      const html = readPublic(page);
      const rendered = renderedQuestionNames(html);
      const unique = new Set(rendered);
      assert.equal(unique.size, rendered.length, `${page}: rendered FAQ must not repeat a question`);
    }
  });
});

describe('FAQ consolidation: positive controls for every cut question (0 occurrences anywhere)', () => {
  // Cut with no destination — must not exist as a FAQ question, rendered or
  // JSON-LD, on ANY of the six pages.
  const CUT_QUESTIONS_HOW_IT_WORKS = [
    'Do I need to be technical?',
    'What if my learning already exists?',
    'What kind of learnings does Auxilo accept?',
    'How much can I earn?',
    'Is my data safe?',
    'What is USDC?',
    'What is Base?',
    "Can one AI agent learn from another agent's mistakes?",
    'How is this different from my agent remembering its own history?',
  ];
  const CUT_QUESTIONS_FOR_BUILDERS = ['Is search free for my agents?'];
  const CUT_QUESTIONS_PRICING = [
    'Is searching the Auxilo catalog free?',
    'How much do builders earn on Auxilo?',
    'When can I withdraw my Auxilo earnings?',
  ];
  const ALL_CUT = [
    ...CUT_QUESTIONS_HOW_IT_WORKS,
    ...CUT_QUESTIONS_FOR_BUILDERS,
    ...CUT_QUESTIONS_PRICING,
  ];

  it('every cut question has zero remaining FAQ occurrences across all six pages', () => {
    for (const q of ALL_CUT) {
      let hits = 0;
      const pagesHit = [];
      for (const page of PAGES) {
        const html = readPublic(page);
        if (renderedQuestionNames(html).includes(q) || jsonLdQuestionNames(html).includes(q)) {
          hits += 1;
          pagesHit.push(page);
        }
      }
      assert.equal(hits, 0, `cut question "${q}" must not appear as a FAQ item anywhere; found on: ${pagesHit.join(', ')}`);
    }
  });

  it('/how-it-works.html carries no FAQPage JSON-LD node at all (entire FAQ section removed)', () => {
    const html = readPublic('how-it-works.html');
    const scriptMatch = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
    assert.ok(scriptMatch, 'how-it-works.html still carries its Organization/WebSite JSON-LD script');
    const data = JSON.parse(scriptMatch[1]);
    const graph = data['@graph'] || [];
    const faqNode = graph.find((n) => n['@type'] === 'FAQPage');
    assert.equal(faqNode, undefined, 'how-it-works.html JSON-LD @graph must not contain a FAQPage node');
  });

  it('/how-it-works.html carries no rendered FAQ section, heading, or accordion markup', () => {
    const html = readPublic('how-it-works.html');
    assert.ok(!/<section id="faq"/.test(html), 'no id="faq" section');
    assert.ok(!/<section class="hiw-faq-section/.test(html), 'no hiw-faq-section');
    assert.ok(!/id="faq-heading"/.test(html), 'no faq-heading id');
    assert.ok(!/Frequently Asked Questions/.test(html), 'no "Frequently Asked Questions" heading text');
    assert.ok(!/class="faq-item"/.test(html), 'no faq-item markup');
    assert.ok(!/function toggleFaq/.test(html), 'the now-unused toggleFaq() handler was removed, not left dead');
    assert.ok(!/\.hiw-faq-section\s*\{/.test(html), 'the page-scoped .hiw-faq-section CSS rule (dead once its only section was removed) is gone');
  });

  it('no page site-wide links to the retired /how-it-works#faq anchor (no dangling anchor)', () => {
    for (const page of PAGES) {
      const html = readPublic(page);
      assert.ok(!html.includes('how-it-works#faq'), `${page} must not reference the retired /how-it-works#faq anchor`);
    }
  });
});

describe('FAQ consolidation: positive control for the moved question', () => {
  const MOVED_QUESTION = 'What kind of agents can connect?';
  const MOVED_ANSWER_SUBSTRING = 'Background extraction, the hands-free contribution engine, runs on';

  it('is absent from /for-builders (its old home) — rendered and JSON-LD', () => {
    const html = readPublic('for-builders.html');
    assert.ok(!renderedQuestionNames(html).includes(MOVED_QUESTION), 'must not be rendered on /for-builders any more');
    assert.ok(!jsonLdQuestionNames(html).includes(MOVED_QUESTION), 'must not be in /for-builders JSON-LD any more');
  });

  it('appears exactly once on /for-agents (its new home), as the 3rd (last) question — rendered and JSON-LD', () => {
    const html = readPublic('for-agents.html');
    const rendered = renderedQuestionNames(html);
    const jsonLd = jsonLdQuestionNames(html);
    assert.equal(rendered.filter((q) => q === MOVED_QUESTION).length, 1, 'exactly one rendered occurrence');
    assert.equal(jsonLd.filter((q) => q === MOVED_QUESTION).length, 1, 'exactly one JSON-LD occurrence');
    assert.equal(rendered.indexOf(MOVED_QUESTION), rendered.length - 1, 'must be the last rendered question');
    assert.equal(jsonLd.indexOf(MOVED_QUESTION), jsonLd.length - 1, 'must be the last JSON-LD question');
  });

  it('carries byte-identical answer text on its new home, matching the pre-move source exactly', () => {
    const html = readPublic('for-agents.html');
    // Rendered answer (verbatim from the pre-move /for-builders markup, incl. inline <strong>/<a>).
    assert.ok(
      html.includes(
        '<div class="faq-answer-inner">Background extraction, the hands-free contribution engine, runs on <strong style="color:var(--ivory)">Claude Code</strong>, <strong style="color:var(--ivory)">Codex</strong>, and the other clients with a supported extraction hook, where a local runner reads finished sessions and submits learnings to your private review queue. Best-effort capture covers several more clients, and any other MCP-compatible client can connect manually to search, unlock, and contribute from inside the client. See <a href="/legal/supported-clients">supported clients</a> for the full tier map.</div>'
      ),
      'rendered answer on /for-agents must be byte-identical to the pre-move /for-builders answer'
    );
    // JSON-LD answer text (verbatim from the pre-move /for-builders JSON-LD).
    assert.ok(
      html.includes(
        '"text": "Background extraction, the hands-free contribution engine, runs on Claude Code, Codex, and the other clients with a supported extraction hook, where a local runner reads finished sessions and submits learnings to your private review queue. Best-effort capture covers several more clients, and any other MCP-compatible client can connect manually to search, unlock, and contribute from inside the client. See https://auxilo.io/legal/supported-clients for the full tier map."'
      ),
      'JSON-LD answer text on /for-agents must be byte-identical to the pre-move /for-builders JSON-LD answer'
    );
    assert.ok(html.includes(MOVED_ANSWER_SUBSTRING), 'sanity: answer substring present');
  });
});

describe('FAQ consolidation: unchanged pages stay byte-identical in their FAQ sections', () => {
  it('the homepage FAQ section (3 AEO query-mirror questions) is untouched', () => {
    const html = readPublic('index.html');
    assert.deepEqual(renderedQuestionNames(html), EXPECTED['index.html']);
    assert.deepEqual(jsonLdQuestionNames(html), EXPECTED['index.html']);
  });

  it('/api FAQ section (2 x402 questions) is untouched', () => {
    const html = readPublic('api.html');
    assert.deepEqual(renderedQuestionNames(html), EXPECTED['api.html']);
    assert.deepEqual(jsonLdQuestionNames(html), EXPECTED['api.html']);
  });
});
