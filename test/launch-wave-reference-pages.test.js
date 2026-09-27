'use strict';

/**
 * test/launch-wave-reference-pages.test.js — LAUNCH-WAVE-0926, reference-pages
 * builder unit (public/how-it-works.html, public/pricing.html,
 * public/works-with.html, public/how-submissions-work.html, public/api.html).
 *
 * Pins the copy placed from REGISTER-B-REV2.md (/how-it-works, /pricing),
 * REGISTER-M-MECHANICAL.md (rows M-01, M-02 how-it-works instance, M-03,
 * M-14 to M-21, M-49 to M-53) and REGISTER-F-FAQ-DISCLOSURE.md (F-04
 * pricing, F-05 api) for these five pages only.
 *
 * Runner: node --test test/launch-wave-reference-pages.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');

const PAGE_FILES = [
  'how-it-works.html',
  'pricing.html',
  'works-with.html',
  'how-submissions-work.html',
  'api.html',
];

const RAW = {};
for (const page of PAGE_FILES) {
  RAW[page] = fs.readFileSync(path.join(REPO, 'public', page), 'utf8');
}

// ─── Shared helpers (per BUILDER-RULES.md: strip tags, decode entities,
// collapse whitespace, collapse space before punctuation) ──────────────────

function stripComments(html) {
  return html.replace(/<!--[\s\S]*?-->/g, '');
}

function decodeEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&middot;/g, '·');
}

function normalize(str) {
  return decodeEntities(str)
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .trim();
}

/** Visible body text only: head (title/meta/JSON-LD), script and style
 * blocks, and HTML comments are excluded, then tags are stripped. */
function bodyText(html) {
  let h = stripComments(html);
  h = h.replace(/<head[\s\S]*?<\/head>/i, '');
  h = h.replace(/<script[\s\S]*?<\/script>/gi, '');
  h = h.replace(/<style[\s\S]*?<\/style>/gi, '');
  h = h.replace(/<[^>]+>/g, ' ');
  return normalize(h);
}

/** FAQPage JSON-LD entries for a page: [{name, text}], in document order. */
function faqJsonLd(html) {
  const scriptMatch = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  if (!scriptMatch) return [];
  const data = JSON.parse(scriptMatch[1]);
  const graph = data['@graph'] || [];
  const faqNode = graph.find((n) => n['@type'] === 'FAQPage');
  if (!faqNode) return [];
  return faqNode.mainEntity.map((q) => ({ name: q.name, text: q.acceptedAnswer.text }));
}

/** Rendered (visible) FAQ answer text for a given question name, or null. */
function renderedFaqAnswer(html, questionName) {
  const qIdx = html.indexOf(`<span>${questionName}</span>`);
  if (qIdx === -1) return null;
  const rest = html.slice(qIdx);
  const answerMatch = rest.match(/<div class="faq-answer-inner">([\s\S]*?)<\/div>/);
  if (!answerMatch) return null;
  return normalize(answerMatch[1].replace(/<[^>]+>/g, ' '));
}

function count(haystack, needle) {
  return haystack.split(needle).length - 1;
}

// ─── Test 1: banned accrual phrases (body text + FAQ answers, title tags
// excluded — the /pricing <title> carries the one allowed "every unlock") ──

describe('LAUNCH-WAVE-0926 reference pages: banned accrual phrasing (test 1)', () => {
  const BANNED_LITERAL = [
    'turn it into income',
    'Earn every time',
    'every time another agent unlocks',
  ];

  for (const page of PAGE_FILES) {
    const html = RAW[page];
    const corpus = `${bodyText(html)} ${faqJsonLd(html).map((e) => e.text).join(' ')}`;

    it(`${page}: positive control — corpus extraction actually finds visible text`, () => {
      assert.ok(corpus.includes('Auxilo'), `${page} corpus helper must find known-present text`);
    });

    for (const phrase of BANNED_LITERAL) {
      it(`${page}: does not contain "${phrase}"`, () => {
        assert.equal(corpus.includes(phrase), false, `${page} must not contain "${phrase}"`);
      });
    }

    it(`${page}: "every unlock" is not used about earning (body text + FAQ answers, title tags excluded)`, () => {
      assert.equal(
        corpus.includes('every unlock'),
        false,
        `${page} body/FAQ text must not use "every unlock" (title tags are excluded from this corpus, so the /pricing <title> allowance is out of scope here)`
      );
    });

    it(`${page}: no arrow character joins "Earnings accrue now" to "withdrawals open soon"`, () => {
      const bad = /Earnings accrue now[^.]*(→|->)[^.]*withdrawals open soon/i.test(corpus);
      assert.equal(bad, false, `${page} must not join the accrual pair with an arrow`);
    });
  }

  it('sanity: pricing.html <title> keeps the one allowed "every unlock" use (control that the exclusion is real, not accidental)', () => {
    assert.match(RAW['pricing.html'], /<title>[^<]*every unlock[^<]*<\/title>/);
  });
});

// ─── Test 2: /how-submissions-work M-51 sentence ───────────────────────────

describe('LAUNCH-WAVE-0926: /how-submissions-work M-51 sentence (test 2)', () => {
  const html = RAW['how-submissions-work.html'];
  const NEW_SENTENCE =
    'The builder behind the contributing agent earns 70% of what the buyer paid on a direct unlock and 60% when Auxilo search surfaced it.';
  const NOT_GUARANTEED =
    'Earnings depend on whether other agents unlock your learnings and are not guaranteed.';

  it('new M-51 sentence appears exactly once', () => {
    assert.equal(count(html, NEW_SENTENCE), 1, 'expected exactly one occurrence of the new M-51 sentence');
  });

  it('old M-51 sentence is gone', () => {
    const OLD_SENTENCE =
      'The builder behind the contributing agent earns 70% of every direct unlock and 60% when Auxilo search surfaced it.';
    assert.equal(html.includes(OLD_SENTENCE), false, 'the old, un-conditioned M-51 sentence must not remain');
  });

  it('the not-guaranteed sentence follows the M-51 sentence in document order (the ruled pairing)', () => {
    const text = bodyText(html);
    const iSentence = text.indexOf('60% when Auxilo search surfaced it.');
    const iGuarantee = text.indexOf(NOT_GUARANTEED);
    const iNextSection = text.indexOf('Where Learnings Come From');
    assert.ok(iSentence > -1 && iGuarantee > -1 && iNextSection > -1, 'all three anchors must be present');
    assert.ok(iSentence < iGuarantee, 'the not-guaranteed sentence must follow the M-51 sentence');
    assert.ok(iGuarantee < iNextSection, 'the not-guaranteed sentence must precede the next section');
  });
});

// ─── Test 3: /pricing credits sentence + builder basis statement ───────────

describe('LAUNCH-WAVE-0926: /pricing credits + builder basis (test 3)', () => {
  const html = RAW['pricing.html'];

  it('Credit Packs intro contains the ratified credits sentence', () => {
    assert.match(
      html,
      /Fund your account once and unlock as you go\. One credit unlocks one learning, whatever its listed price\./
    );
  });

  it('the builder section states the earnings basis ("of what they paid" / "what the buyer paid")', () => {
    const buildersSection = html.slice(
      html.indexOf('id="for-builders-pricing"'),
      html.indexOf('</section>', html.indexOf('id="for-builders-pricing"'))
    );
    const hasBasis =
      buildersSection.includes('of what they paid') || buildersSection.includes('what the buyer paid');
    assert.ok(hasBasis, 'the /pricing builder section must state the earnings basis');
  });
});

// ─── Test 4: every FAQPage answer stating a 70%/60% rate on my pages ───────

describe('LAUNCH-WAVE-0926: FAQ rate-answer disclosure pairing (test 4)', () => {
  const DISCLAIMER = 'Earnings depend on whether other agents unlock your learnings and are not guaranteed.';

  for (const page of ['pricing.html', 'api.html']) {
    const html = RAW[page];
    const entries = faqJsonLd(html).filter((e) => e.text.includes('70%') || e.text.includes('60%'));

    it(`${page}: at least one FAQ answer states the rate (positive control)`, () => {
      assert.ok(entries.length > 0, `${page} must carry at least one 70%/60% FAQ answer to test`);
    });

    for (const entry of entries) {
      it(`${page}: FAQ "${entry.name}" carries the disclaimer, the pause pair, and is not disclaimer-terminal`, () => {
        const jsonText = normalize(entry.text);
        assert.ok(jsonText.includes(DISCLAIMER), 'JSON-LD answer must carry the disclaimer verbatim');
        assert.ok(/open soon/i.test(jsonText), 'JSON-LD answer must carry "open soon"');
        assert.ok(
          jsonText.includes('of what the buyer paid') || jsonText.includes('of what they paid'),
          'JSON-LD answer must state the earnings basis'
        );
        assert.equal(
          jsonText.endsWith(DISCLAIMER),
          false,
          'the disclaimer must not be the last sentence of the answer'
        );

        const rendered = renderedFaqAnswer(html, entry.name);
        assert.ok(rendered, `${page} must carry a rendered FAQ answer for "${entry.name}"`);
        assert.equal(rendered, jsonText, 'rendered answer must equal its JSON-LD twin after normalization');
      });
    }
  }
});

// ─── Test 4b: register P grant sentence + purchased-pack retirement ────────

describe('LAUNCH-WAVE-0926 register P: /pricing grant sentence + /api purchased-pack removal (test 4b)', () => {
  it('pricing.html contains the grant sentence exactly once', () => {
    const GRANT_SENTENCE = 'Some unlocks are issued as $0.00 promotional grants and earn nothing.';
    assert.equal(count(RAW['pricing.html'], GRANT_SENTENCE), 1, 'grant sentence must appear exactly once on /pricing');
  });

  it('api.html visible text and JSON-LD contain no "from a purchased pack"', () => {
    const html = RAW['api.html'];
    assert.equal(bodyText(html).includes('from a purchased pack'), false, '/api visible text must not say "from a purchased pack"');
    const ldText = faqJsonLd(html).map((e) => e.text).join(' ');
    assert.equal(ldText.includes('from a purchased pack'), false, '/api JSON-LD must not say "from a purchased pack"');
    // Positive control: the phrase detector itself works.
    assert.ok('as one credit from a purchased pack'.includes('from a purchased pack'), 'positive control: substring check works');
  });
});

// ─── Test 5: /works-with carries no em dash or en dash in visible text ─────

describe('LAUNCH-WAVE-0926: /works-with no em/en dash (test 5)', () => {
  const html = RAW['works-with.html'];
  const text = bodyText(html);

  it('positive control: visible text extraction actually finds the OpenClaw cell', () => {
    assert.ok(text.includes('OpenClaw'), 'bodyText helper must find known-present text');
  });

  it('contains no em dash (U+2014) or en dash (U+2013)', () => {
    assert.equal(/[–—]/.test(text), false, '/works-with visible text must contain no em dash or en dash');
  });
});

// ─── Test 6: colon rows applied (M-14 to M-20 on my pages) ─────────────────

describe('LAUNCH-WAVE-0926: colon rows applied, old form gone, new form present once (test 6)', () => {
  const COLON_ROWS = [
    {
      id: 'M-14',
      file: 'how-it-works.html',
      old: 'You have two options:',
      now: 'You have two options.',
    },
    {
      id: 'M-15',
      file: 'how-it-works.html',
      old: 'Think of it like plugging in a USB device: your agent immediately knows how to use Auxilo.',
      now: 'Think of it like plugging in a USB device. Your agent immediately knows how to use Auxilo.',
    },
    {
      id: 'M-16',
      file: 'how-it-works.html',
      old: 'Or use the REST API directly: POST to',
      now: 'Or use the REST API directly. POST to',
    },
    {
      id: 'M-17',
      file: 'how-it-works.html',
      old: 'Find what you need using whichever method fits your workflow:',
      now: 'Find what you need using whichever method fits your workflow.',
    },
    {
      id: 'M-18',
      file: 'how-it-works.html',
      old: 'Recent discoveries, straight from the live catalog:',
      now: 'Recent discoveries, straight from the live catalog.',
    },
    {
      id: 'M-19',
      file: 'how-it-works.html',
      old:
        'You only pay when you unlock the full details: the specific workaround, the exact code, the gotcha that saves you hours.',
      now:
        'You only pay when you unlock the full details. That means the specific workaround, the exact code, and the gotcha that saves you hours.',
    },
    {
      id: 'M-20',
      file: 'pricing.html',
      old:
        'The account and credits path is the one we recommend for most setups: fund once with a card, no wallet, no gas, no balance to babysit.',
      now:
        'The account and credits path is the one we recommend for most setups. You fund once with a card, with no wallet, no gas, and no balance to babysit.',
    },
  ];

  for (const row of COLON_ROWS) {
    const html = RAW[row.file];
    it(`${row.id} (${row.file}): old form is absent`, () => {
      assert.equal(html.includes(row.old), false, `${row.file} must not contain the old ${row.id} anchor`);
    });
    it(`${row.id} (${row.file}): new form is present exactly once`, () => {
      assert.equal(count(html, row.now), 1, `${row.file} must contain the new ${row.id} text exactly once`);
    });
  }
});
