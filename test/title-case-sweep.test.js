'use strict';

/**
 * test/title-case-sweep.test.js — TITLE-CASE-SWEEP (2026-09-06).
 *
 * Tyler's ruling, verbatim: "Yes title case for nav menus and headlines that
 * do not end in a period." Source of truth for this sweep:
 * ~/.auxilo/handoffs/TITLE-CASE-HEADINGS-SWEEP-2026-09-06.md — its mechanical
 * 8-row inventory (taken at origin/main 7d2ce8f) plus its "Exceptions and
 * touches for the builder" section, which overrides three of those rows.
 *
 * public/index.html is excluded from this whole sweep (a parallel hero
 * builder owns it) and from every check below.
 *
 * This file has three parts:
 *   A. Per-row assertions — each applied inventory row now reads its NEW
 *      string verbatim, and the OLD string is gone from that page.
 *   B. A mechanical convention guard across every h1-h3 on every tracked
 *      page except index.html: any heading NOT ending in . ? or ! must
 *      either satisfy the small-word Title Case rule (capitalize first and
 *      last word and every other word except a/an/the/and/but/or/for/nor/
 *      at/by/in/of/on/to/up/as/vs/via/per when they fall mid-heading; a
 *      token that contains a digit, is a hyphenated compound, is all-caps,
 *      or opens with a non-letter passes through as a product token/
 *      command/price) OR be one of the documented, named exceptions this
 *      sweep found and deliberately left untouched (the STOP row, the
 *      phrasal-verb override, and the not-inventoried pages) — so a NEW,
 *      undocumented violation introduced later fails the build instead of
 *      silently shipping.
 *   C. The pricing.html feat-sub /status link (SITE-PM ruling).
 *
 * Runner: node --test test/title-case-sweep.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..');

function read(relPath) {
  return fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8');
}

// ─── A. Applied inventory rows (OLD -> NEW) ────────────────────────────────
//
// The source table has 8 rows. Two (earnings.html:149/155) are STOP rows —
// earnings.html does not exist anywhere in the current tree, so neither the
// OLD nor a NEW string can be positive-controlled; TECH-PM reported this,
// nothing was applied. One (writing-agents-message-board.html:60) is an
// explicit "stays as written" exception per the doc's own text. One
// (api.html:574, "Available Tools 17 tools total") is a STOP: the OLD
// string does not exist as plain text — it is two headings jammed into one
// h3 around a nested <span>, exactly as the doc's own exception note
// anticipated — so it was left unchanged pending a markup decision. The
// remaining four rows (three of them using the doc's exception-section
// override string instead of the raw table column) were applied.
const APPLIED_ROWS = [
  {
    file: 'public/api.html',
    old: 'Agent Card: a machine-readable capability declaration',
    // Exception override (doc line 24): hyphenated compound capitalizes
    // both halves; the colon is a label colon and stays.
    now: 'Agent Card: a Machine-Readable Capability Declaration',
  },
  {
    file: 'public/dashboard.html',
    old: 'Sign in to your account',
    // Exception override (doc line 23): phrasal verb, both words capitalized.
    now: 'Sign In to Your Account',
  },
  {
    file: 'public/for-agents.html',
    old: 'Recent discoveries',
    now: 'Recent Discoveries',
  },
  {
    file: 'public/for-builders.html',
    old: 'The math (per unlock)',
    now: 'The Math (per Unlock)',
  },
];

describe('TITLE-CASE-SWEEP part A: applied inventory rows read their NEW string', () => {
  for (const row of APPLIED_ROWS) {
    it(`${row.file} reads "${row.now}" and not the old string`, () => {
      const content = read(row.file);
      assert.equal(
        (content.match(new RegExp(row.now.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length,
        1,
        `expected exactly one occurrence of the NEW heading text in ${row.file}`
      );
      const headingTagsWithOld = extractHeadings(content).filter((h) => h.text === row.old);
      assert.deepEqual(
        headingTagsWithOld,
        [],
        `${row.file} still has an h1-h3 reading the pre-sweep OLD heading text`
      );
    });
  }

  it('api.html STOP row: the jammed "Available Tools" h3 is untouched (markup decision pending)', () => {
    const content = read('public/api.html');
    assert.match(
      content,
      /<h3[^>]*>Available Tools <span[^>]*>17 tools total<\/span><\/h3>/,
      'api.html Available Tools h3 markup changed — re-verify the STOP-row disposition'
    );
  });

  it('writing-agents-message-board.html h1 stays as written (explicit doc exception, not Title Case)', () => {
    const content = read('public/writing-agents-message-board.html');
    assert.match(
      content,
      /<h1>The first post on the agents' Artifactory message board was a help-wanted ad<\/h1>/
    );
  });

  it('earnings.html does not exist in the tracked tree (both earnings.html STOP rows are unreachable)', () => {
    const tracked = execFileSync('git', ['ls-files', 'public/'], { cwd: REPO_ROOT, encoding: 'utf8' });
    assert.ok(
      !tracked.split('\n').some((f) => f.endsWith('earnings.html')),
      'earnings.html reappeared in the tree — the two earnings.html inventory rows need re-review, not this unreachable guard'
    );
  });
});

// ─── B. Mechanical small-word Title Case convention guard ─────────────────

const SMALL_WORDS = new Set([
  'a', 'an', 'the', 'and', 'but', 'or', 'for', 'nor', 'at', 'by', 'in',
  'of', 'on', 'to', 'up', 'as', 'vs', 'via', 'per',
]);

// Tracked public/ pages except index.html (parallel hero builder owns it).
const SWEPT_FILES = execFileSync('git', ['ls-files', 'public/'], { cwd: REPO_ROOT, encoding: 'utf8' })
  .split('\n')
  .filter((f) => f.endsWith('.html'))
  .filter((f) => f !== 'public/index.html');

// Headings this sweep found and deliberately left untouched, with why.
// Keyed by "file|||exact heading text". A text change here means the
// underlying heading changed too — re-review before touching this list.
const DOCUMENTED_EXCEPTIONS = new Set([
  // STOP row: OLD string is split across a nested <span>, not plain text;
  // left unchanged pending a markup decision (doc's own exception note).
  'public/api.html|||Available Tools 17 tools total',
  // Applied exception override (doc line 23): phrasal verb, both words
  // capitalized ("In" is normally a mid-heading small word, "Sign In" isn't).
  'public/dashboard.html|||Sign In to Your Account',
  // Explicit "stays as written" exception (full sentence headline, GTM surface).
  "public/writing-agents-message-board.html|||The first post on the agents' Artifactory message board was a help-wanted ad",
  // Not-inventoried: this whole page predates/postdates the 7d2ce8f
  // inventory snapshot and was never enumerated in it. Left untouched per
  // this sweep's "not in the inventory -> list, leave" rule.
  'public/how-submissions-work.html|||What stands between a submission and the public catalog',
  'public/how-submissions-work.html|||If you run agents that will consume this catalog',
  'public/how-submissions-work.html|||What Auxilo is',
  'public/how-submissions-work.html|||Earnings and withdrawals, for builders',
  'public/how-submissions-work.html|||Where learnings come from',
  'public/how-submissions-work.html|||What leaves your machine',
  'public/how-submissions-work.html|||The submission path',
  'public/how-submissions-work.html|||Who reviews what',
  'public/how-submissions-work.html|||The live catalog count',
  'public/how-submissions-work.html|||Who runs this',
  // Not-inventoried: new page (works-with.html), never enumerated in the
  // 7d2ce8f snapshot; doc prose names a Title Case target for it but this
  // sweep's formal inventory table has no row for it, so it was left as-is.
  'public/works-with.html|||Works with the client you already run',
]);

function stripTags(html) {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .trim();
}

function stripPunct(word) {
  return word.replace(/^[^A-Za-z0-9$]+/, '').replace(/[^A-Za-z0-9]+$/, '');
}

function isCompliantWord(rawWord, isEdge) {
  const core = stripPunct(rawWord);
  if (!core) return true; // pure punctuation token
  const lower = core.toLowerCase();
  if (!isEdge && SMALL_WORDS.has(lower)) {
    return core === lower; // small word mid-heading must stay lowercase
  }
  if (/\d/.test(core)) return true; // price/token/number, e.g. $0.05, 17
  if (core.length > 1 && core === core.toUpperCase()) return true; // acronym, e.g. MCP, API, A2A
  if (!/^[A-Za-z]/.test(core)) return true; // opens with a symbol
  if (core.includes('-')) {
    // hyphenated compounds capitalize both halves
    return core.split('-').every((part) => {
      if (!part) return true;
      if (/\d/.test(part)) return true;
      if (part.length > 1 && part === part.toUpperCase()) return true;
      return /^[A-Z]/.test(part);
    });
  }
  return /^[A-Z]/.test(core);
}

function headingViolations(text) {
  const words = text.split(/\s+/).filter(Boolean);
  const bad = [];
  words.forEach((w, i) => {
    const isEdge = i === 0 || i === words.length - 1;
    if (!isCompliantWord(w, isEdge)) bad.push(w);
  });
  return bad;
}

function extractHeadings(content) {
  const re = /<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1>/gi;
  const out = [];
  let m;
  while ((m = re.exec(content))) {
    const tag = `h${m[1]}`;
    const text = stripTags(m[2]).replace(/\s+/g, ' ').trim();
    if (!text) continue;
    out.push({ tag, text });
  }
  return out;
}

describe('TITLE-CASE-SWEEP part B: no undocumented small-word-convention violation among swept headings (index.html excluded)', () => {
  for (const file of SWEPT_FILES) {
    it(`${file}: every non-period h1-h3 is Title Case or a documented exception`, () => {
      const content = read(file);
      const headings = extractHeadings(content);
      for (const h of headings) {
        if (/[.?!]$/.test(h.text)) continue; // sentence-case headlines stay as-is
        const key = `${file}|||${h.text}`;
        if (DOCUMENTED_EXCEPTIONS.has(key)) continue;
        const bad = headingViolations(h.text);
        assert.deepEqual(
          bad,
          [],
          `${file} <${h.tag}> "${h.text}" is not Title Case (offending words: ${bad.join(', ')}) and is not a documented exception — either fix the casing or add it to DOCUMENTED_EXCEPTIONS with a reason`
        );
      }
    });
  }
});

// ─── C. pricing.html feat-sub /status link (SITE-PM ruling) ───────────────

describe('TITLE-CASE-SWEEP part C: pricing.html Withdrawals feat-sub links "open soon" to /status', () => {
  it('wraps "open soon" in an <a href="/status"> without changing the surrounding text', () => {
    const content = read('public/pricing.html');
    assert.match(
      content,
      /<span class="feat-sub">Withdrawals <a href="\/status">open soon<\/a> as we finish the non-custodial migration\.<\/span>/,
      'pricing.html Withdrawals feat-sub did not match the expected wrapped form'
    );
  });
});
