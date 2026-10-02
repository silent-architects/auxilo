'use strict';

/**
 * test/api-page-design.test.js
 *
 * Guards the design pass on public/api.html (the /api documentation page):
 *   - a dark hero, then light sections that alternate paper and tint, then a dark close;
 *   - every documentation section is laid heading-left (.aside-list) with the material right;
 *   - no inline colour or layout styles in the body, no raw brand-constant colours in the
 *     page's own style block, no weight above 500 on a heading;
 *   - the documentation content survives the re-layout (17 tool rows, 10 code panels, the
 *     two expandable envelopes, the two tables).
 * Strings, ids and scripts are pinned by the older suites (wave-e3, faq-consolidation,
 * launch-wave-fixes-frontend, title-case-sweep); this file only pins the structure.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'api.html'), 'utf8');
const STYLE = (HTML.match(/<style>([\s\S]*?)<\/style>/) || [, ''])[1];
const MAIN = (HTML.match(/<main id="main">([\s\S]*?)<\/main>/) || [, ''])[1];

// the top-level <section> opening tags inside <main>, in document order
function sectionClasses() {
  const out = [];
  const re = /<section\b([^>]*)>/g;
  let m;
  while ((m = re.exec(MAIN))) {
    const cls = (m[1].match(/class="([^"]*)"/) || [, ''])[1].split(/\s+/).filter(Boolean);
    out.push(cls);
  }
  return out;
}

describe('api.html design pass: grounds', () => {
  it('positive control: the page has eight sections inside main', () => {
    assert.equal(sectionClasses().length, 8);
  });

  it('opens dark, closes dark, and alternates paper and tint between', () => {
    const grounds = sectionClasses().map((cls) => (cls.includes('on-dark') ? 'dark' : cls.includes('on-tint') ? 'tint' : 'paper'));
    assert.deepEqual(grounds, ['dark', 'paper', 'tint', 'paper', 'tint', 'paper', 'tint', 'dark']);
  });

  it('the hero is one column (hero-one) with the serif h1 and a lede', () => {
    const hero = MAIN.match(/<section id="api-hero"[\s\S]*?<\/section>/)[0];
    assert.match(hero, /<div class="container hero-one">/);
    assert.match(hero, /<h1 id="api-hero-heading">API &amp; Integration<\/h1>/);
    assert.match(hero, /<p class="lede">/);
  });

  it('the five documentation sections and the FAQ are laid heading-left (.aside-list)', () => {
    const asides = MAIN.match(/<div class="container aside-list( doc-split)?">/g) || [];
    assert.equal(asides.length, 6);
    assert.equal(asides.filter((a) => /doc-split/.test(a)).length, 5, 'five sections carry heading plus intro; the FAQ is heading only');
  });
});

describe('api.html design pass: no decoration carried over from the dark era', () => {
  it('main carries no inline style attribute (a script-toggled display:none would be allowed; none exists on this page)', () => {
    assert.doesNotMatch(MAIN, /\sstyle="/);
    // positive control: the footer mark keeps its own sizing attribute, which sits outside main
    assert.match(HTML, /<svg style="width:20px;height:20px"/);
  });

  it('the page style block uses no raw brand-constant colour tokens and no dark-era section classes', () => {
    assert.doesNotMatch(STYLE, /var\(--(ivory|slate|slate-text|ash|obsidian|aurum|aurum-dim|aurum-border|code-bg)\)/);
    assert.doesNotMatch(STYLE, /\.api-section|\.alt-bg|section-raised/);
    // positive control: the ground-aware tokens are what it does use
    assert.match(STYLE, /var\(--fg-1\)/);
    assert.match(STYLE, /var\(--line\)/);
  });

  it('no heading or mono rule asks for a weight above 500', () => {
    assert.doesNotMatch(STYLE, /font-weight:\s*(6|7|8|9)00/);
    assert.doesNotMatch(STYLE, /font-weight:\s*bold/);
  });

  it('no uppercase or letter-spaced label style survives in the page block, and no transition', () => {
    assert.doesNotMatch(STYLE, /text-transform:\s*uppercase/);
    assert.doesNotMatch(STYLE, /transition:/);
  });

  it('the method chips are neutral (no gold-tinted box) and the tables are cards', () => {
    assert.match(STYLE, /\.doc-table \.ep-method\.post/);
    assert.doesNotMatch(STYLE, /rgba\(201,\s*168,\s*76/);
    assert.equal((MAIN.match(/class="doc-card"/g) || []).length, 2, 'the two tables sit in cards');
    assert.match(MAIN, /class="a2a-block doc-card"/);
  });
});

describe('api.html design pass: the documentation content survives the re-layout', () => {
  it('17 tool rows, in the ruled list', () => {
    assert.equal((MAIN.match(/<div class="mcp-tool-card">/g) || []).length, 17);
    assert.equal((MAIN.match(/<span class="mcp-tool-name">/g) || []).length, 17);
  });

  it('three step rows with their labels as written', () => {
    assert.deepEqual(
      [...MAIN.matchAll(/<span class="qs-num">([^<]*)<\/span>/g)].map((m) => m[1]),
      ['STEP 01', 'STEP 02', 'STEP 03'],
    );
  });

  it('ten dark code panels, each with its own copy button, and the two expandable envelopes', () => {
    assert.equal((MAIN.match(/<div class="code-block[ "]/g) || []).length, 10);
    assert.equal((MAIN.match(/class="copy-btn"/g) || []).length, 10);
    assert.equal((MAIN.match(/code-block--envelope" id="/g) || []).length, 2);
    assert.equal((MAIN.match(/<button type="button" class="code-block-expand"/g) || []).length, 2);
  });

  it('both tables keep their accessible names and the endpoint table keeps its seven rows', () => {
    // Round 3: each table also carries its explicit table roles, so assistive technology keeps the
    // table when the narrow layout turns its rows into blocks.
    assert.match(MAIN, /<table class="endpoint-table doc-table" aria-label="Core API endpoints" role="table">/);
    assert.match(MAIN, /<table class="endpoint-table doc-table pay-table" aria-label="Payment paths" role="table">/);
    const endpoints = MAIN.match(/<table class="endpoint-table doc-table" aria-label="Core API endpoints" role="table">[\s\S]*?<\/table>/)[0];
    assert.equal((endpoints.match(/<tr role="row">/g) || []).length, 8, 'a header row plus seven endpoints');
  });

  it('the stacked rows draw their labels from data-label, whose values are the existing column heading texts', () => {
    const tables = [...MAIN.matchAll(/<table class="endpoint-table doc-table[^"]*" aria-label="[^"]*" role="table">[\s\S]*?<\/table>/g)].map((m) => m[0]);
    assert.equal(tables.length, 2, 'positive control: both tables found');
    for (const table of tables) {
      const heads = [...table.matchAll(/<th role="columnheader">([^<]*)<\/th>/g)].map((m) => m[1]);
      assert.ok(heads.length >= 3, 'positive control: the column headings were read');
      const rows = [...table.matchAll(/<tbody role="rowgroup">([\s\S]*?)<\/tbody>/g)][0][1].split('</tr>').filter((r) => r.includes('<td'));
      assert.ok(rows.length >= 7, 'positive control: the body rows were read');
      for (const row of rows) {
        [...row.matchAll(/<td([^>]*)>/g)].forEach((cell, i) => {
          const label = (cell[1].match(/data-label="([^"]*)"/) || [])[1];
          if (heads[i] === '') {
            assert.equal(label, undefined, 'the unnamed first column of the payment table carries no label (its cell is the row title)');
          } else {
            assert.equal(label, heads[i], `cell ${i + 1} is labelled with its column heading "${heads[i]}"`);
          }
        });
      }
    }
    assert.match(STYLE, /content:\s*attr\(data-label\)/, 'the label is drawn by CSS from the attribute');
    assert.doesNotMatch(STYLE, /\.doc-table\s*\{[^}]*min-width/, 'no table keeps a minimum width, so none scrolls sideways at 375');
  });

  it('the code panels that can scroll sideways are reachable by keyboard and named from the panel label already on the page; the lists that drop their markers keep their role', () => {
    const pres = [...MAIN.matchAll(/<pre id="([a-z0-9-]+)"([^>]*)>/g)];
    assert.equal(pres.length, 10, 'positive control: ten code panels');
    const scrollers = pres.filter((m) => /tabindex="0"/.test(m[2]));
    assert.equal(scrollers.length, 9, 'nine scrollers take the keyboard; the one-line install command does not scroll');
    for (const [, id, attrs] of scrollers) {
      const named = (attrs.match(/aria-labelledby="([^"]+)"/) || [])[1];
      assert.ok(named, `${id}: named by an existing element`);
      assert.match(attrs, /role="region"/, `${id}: a region, so its name is announced`);
      assert.match(MAIN, new RegExp(`<span class="code-block-lang" id="${named}">[^<]+</span>`), `${id}: the name is the panel's own label text`);
    }
    assert.match(STYLE, /\.code-block pre:focus-visible\s*\{[^}]*outline-offset:\s*-4px/, 'the ring sits inside the clipping box');
    assert.match(MAIN, /<ul class="annotation-list" role="list">/);
  });

  it('the closing is dark and centred and its main action keeps the shared primary button', () => {
    const close = MAIN.match(/<section class="on-dark api-cta-section"[\s\S]*?<\/section>/)[0];
    assert.match(close, /<a href="\/dashboard" class="btn-primary">Start Building<\/a>/);
    assert.match(close, /<a href="https:\/\/auxilo\.io\/openapi\.json" class="btn-secondary"/);
  });
});
