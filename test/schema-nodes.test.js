'use strict';

/**
 * test/schema-nodes.test.js — Wave D2 (SITE-PM schema build sheet, Step 6
 * items 14-15: ~/.auxilo/handoffs/SCHEMA-BUILD-SHEET-2026-09-06.md).
 *
 * Structural, file-level guards — no live server needed, every assertion is
 * checkable from the served bytes on disk (same convention as
 * test/site-system.test.js and test/pricing-live-range.test.js).
 *
 *   §1  Organization node carries founder (Person, Tyler Kelley, github
 *       sameAs) + contactPoint (security@, support@) on all 7 named pages,
 *       and is byte-identical (normalised: parse + canonical stringify)
 *       across all 7 — including status.html, which now ships it inside an
 *       @graph array instead of as a bare top-level object.
 *   §2  WebSite node ({@id}/#website, publisher -> {@id}/#organization, no
 *       potentialAction/SearchAction) present on the same 7 pages,
 *       immediately after the Organization node in @graph order.
 *   §3  Article + BreadcrumbList on the essay page: headline verbatim
 *       (straight apostrophe), no `description` field (gated pending
 *       SITE-PM sign-off), publisher inlined without `description` (no
 *       gated copy leaks to a new machine surface), breadcrumb final item
 *       omits `item` (current-page convention).
 *   §4  Person/AboutPage on /about: mainEntity is a Person with no
 *       jobTitle/legalName (page never uses either word), worksFor is an
 *       @id-only reference (no inline Organization, so no gated
 *       description sneaks onto this page either).
 *   §5  No Organization node anywhere in scope carries the retired dollar
 *       band or the 70/60 split clause (redundant with
 *       test/site-system.test.js item 5, kept here as an explicit
 *       Wave-D2-local guard since this suite owns the founder/contactPoint
 *       fields that test doesn't know about).
 *
 * Runner: node --test test/schema-nodes.test.js
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

function extractLdJsonNodes(html) {
  const scripts = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  const nodes = [];
  for (const [, jsonText] of scripts) {
    const data = JSON.parse(jsonText);
    if (data && Array.isArray(data['@graph'])) {
      nodes.push(...data['@graph']);
    } else {
      nodes.push(data);
    }
  }
  return nodes;
}

// The 7 pages the schema build sheet names for the Organization + WebSite
// nodes (sheet §1/§2). Deliberately excludes earnings.html and
// dashboard.html, which carry their own pre-existing Organization JSON-LD
// (test/site-system.test.js's ORG_JSONLD_PAGES) but are not named by this
// sheet — out of Wave D2's scope, untouched here.
const SCHEMA_SHEET_PAGES = [
  'index.html',
  'how-it-works.html',
  'for-agents.html',
  'for-builders.html',
  'pricing.html',
  'api.html',
  'status.html',
];

describe('Wave D2 §1: Organization node carries founder + contactPoint, byte-identical across the 7 named pages', () => {
  it('every named page has exactly one Organization node with founder + contactPoint', () => {
    for (const page of SCHEMA_SHEET_PAGES) {
      const nodes = extractLdJsonNodes(readPublic(page));
      const orgs = nodes.filter((n) => n['@type'] === 'Organization');
      assert.equal(orgs.length, 1, `${page} must carry exactly one Organization node`);
      const org = orgs[0];

      assert.deepEqual(org.founder, {
        '@type': 'Person',
        '@id': 'https://auxilo.io/#founder',
        name: 'Tyler Kelley',
        sameAs: ['https://github.com/silent-architects'],
      }, `${page} Organization.founder must match the sheet verbatim`);

      assert.deepEqual(org.contactPoint, [
        { '@type': 'ContactPoint', email: 'security@auxilo.io', contactType: 'security' },
        { '@type': 'ContactPoint', email: 'support@auxilo.io', contactType: 'customer support' },
      ], `${page} Organization.contactPoint must match the sheet verbatim`);
    }
  });

  it('the Organization node is byte-identical (normalised) across all 7 pages', () => {
    let canonical = null;
    let firstPage = null;
    for (const page of SCHEMA_SHEET_PAGES) {
      const nodes = extractLdJsonNodes(readPublic(page));
      const org = nodes.find((n) => n['@type'] === 'Organization');
      const normalised = JSON.stringify(org, Object.keys(org).sort());
      if (canonical === null) {
        canonical = normalised;
        firstPage = page;
      } else {
        assert.equal(normalised, canonical, `${page} Organization node differs from ${firstPage}`);
      }
    }
  });

  it('the founder sameAs slot holds only the GitHub URL (no fabricated LinkedIn)', () => {
    for (const page of SCHEMA_SHEET_PAGES) {
      const nodes = extractLdJsonNodes(readPublic(page));
      const org = nodes.find((n) => n['@type'] === 'Organization');
      assert.deepEqual(org.founder.sameAs, ['https://github.com/silent-architects']);
    }
  });
});

describe('Wave D2 §2: WebSite node present on the 7 named pages, no SearchAction', () => {
  it('every named page carries a WebSite node wired to the Organization via publisher', () => {
    for (const page of SCHEMA_SHEET_PAGES) {
      const nodes = extractLdJsonNodes(readPublic(page));
      const websites = nodes.filter((n) => n['@type'] === 'WebSite');
      assert.equal(websites.length, 1, `${page} must carry exactly one WebSite node`);
      const ws = websites[0];
      assert.equal(ws['@id'], 'https://auxilo.io/#website');
      assert.equal(ws.url, 'https://auxilo.io');
      assert.equal(ws.name, 'Auxilo');
      assert.deepEqual(ws.publisher, { '@id': 'https://auxilo.io/#organization' });
      assert.ok(!('potentialAction' in ws), `${page} WebSite must not carry a SearchAction (potentialAction)`);
    }
  });

  it('the WebSite node immediately follows the Organization node in @graph order', () => {
    for (const page of SCHEMA_SHEET_PAGES) {
      const nodes = extractLdJsonNodes(readPublic(page));
      const orgIndex = nodes.findIndex((n) => n['@type'] === 'Organization');
      const wsIndex = nodes.findIndex((n) => n['@type'] === 'WebSite');
      assert.equal(wsIndex, orgIndex + 1, `${page} WebSite must sit right after Organization in @graph`);
    }
  });
});

describe('Wave D2 §2b: status.html is now @graph-wrapped (no longer a bare top-level Organization object)', () => {
  it('status.html\'s single JSON-LD script is an @graph array, not a bare @type object', () => {
    const html = readPublic('status.html');
    const scripts = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
    assert.equal(scripts.length, 1, 'status.html must carry exactly one JSON-LD script block');
    const data = JSON.parse(scripts[0][1]);
    assert.ok(Array.isArray(data['@graph']), 'status.html JSON-LD must be @graph-wrapped');
    assert.ok(!('@type' in data), 'status.html JSON-LD root must not carry a bare @type any more');
  });
});

describe('Wave D2 §3: Article + BreadcrumbList on the writing/agents-message-board essay', () => {
  const PAGE = 'writing-agents-message-board.html';

  it('carries exactly one Article node with the verbatim headline and no description', () => {
    const nodes = extractLdJsonNodes(readPublic(PAGE));
    const articles = nodes.filter((n) => n['@type'] === 'Article');
    assert.equal(articles.length, 1);
    const a = articles[0];
    assert.equal(a['@id'], 'https://auxilo.io/writing/agents-message-board#article');
    assert.equal(
      a.headline,
      "The first post on the agents' Artifactory message board was a help-wanted ad",
      'headline must be byte-identical to the live <h1>, straight apostrophe'
    );
    assert.equal(a.datePublished, '2026-09-05');
    assert.equal(a.image, 'https://auxilo.io/og-image.png');
    assert.deepEqual(a.mainEntityOfPage, {
      '@type': 'WebPage',
      '@id': 'https://auxilo.io/writing/agents-message-board',
    });
    assert.ok(!('description' in a), 'Article must not carry description — gated pending SITE-PM sign-off');
  });

  it('the headline uses a straight apostrophe (U+0027), matching the live <h1> hex-check', () => {
    const html = readPublic(PAGE);
    const h1Match = html.match(/<h1>([\s\S]*?)<\/h1>/);
    assert.ok(h1Match, 'page must carry an <h1>');
    const straightApostrophe = String.fromCharCode(0x27);
    const curlyApostrophe = String.fromCharCode(0x2019);
    assert.ok(h1Match[1].includes(straightApostrophe), 'h1 must contain a straight apostrophe');
    assert.ok(!h1Match[1].includes(curlyApostrophe), 'h1 must not contain a curly apostrophe');

    const nodes = extractLdJsonNodes(html);
    const article = nodes.find((n) => n['@type'] === 'Article');
    assert.equal(article.headline, h1Match[1], 'JSON-LD headline must be byte-identical to the visible <h1>');
  });

  it('author is the founder Person, publisher is Organization inlined WITHOUT description', () => {
    const nodes = extractLdJsonNodes(readPublic(PAGE));
    const article = nodes.find((n) => n['@type'] === 'Article');
    assert.deepEqual(article.author, {
      '@type': 'Person',
      '@id': 'https://auxilo.io/#founder',
      name: 'Tyler Kelley',
      url: 'https://auxilo.io/about',
    });
    assert.equal(article.publisher['@type'], 'Organization');
    assert.equal(article.publisher['@id'], 'https://auxilo.io/#organization');
    assert.equal(article.publisher.name, 'Auxilo');
    assert.ok(article.publisher.logo, 'publisher must carry logo for validator completeness');
    assert.ok(!('description' in article.publisher),
      'Article publisher must NOT inline the gated Organization description — would ship gated copy to a new machine surface with no copy gate');
  });

  it('carries exactly one BreadcrumbList with 3 items, final item omitting `item`', () => {
    const nodes = extractLdJsonNodes(readPublic(PAGE));
    const breadcrumbs = nodes.filter((n) => n['@type'] === 'BreadcrumbList');
    assert.equal(breadcrumbs.length, 1);
    const items = breadcrumbs[0].itemListElement;
    assert.equal(items.length, 3);
    assert.equal(items[0].item, 'https://auxilo.io/');
    assert.equal(items[1].item, 'https://auxilo.io/writing');
    assert.ok(!('item' in items[2]), 'final breadcrumb item (current page) must omit `item` per Google convention');
    assert.equal(items[2].name, "The first post on the agents' Artifactory message board was a help-wanted ad");
  });
});

describe('Wave D2 §4: Person/AboutPage on /about', () => {
  it('carries exactly one AboutPage node with a Person mainEntity, no jobTitle/legalName', () => {
    const nodes = extractLdJsonNodes(readPublic('about.html'));
    assert.equal(nodes.length, 1, 'about.html must carry exactly one top-level JSON-LD node');
    const about = nodes[0];
    assert.equal(about['@type'], 'AboutPage');
    assert.equal(about['@id'], 'https://auxilo.io/about#aboutpage');
    assert.equal(about.url, 'https://auxilo.io/about');

    const person = about.mainEntity;
    assert.equal(person['@type'], 'Person');
    assert.equal(person['@id'], 'https://auxilo.io/#founder');
    assert.equal(person.name, 'Tyler Kelley');
    assert.deepEqual(person.sameAs, ['https://github.com/silent-architects']);
    assert.deepEqual(person.worksFor, { '@id': 'https://auxilo.io/#organization' },
      'worksFor must be an @id-only reference — no inline Organization, so no gated description leaks here');
    assert.ok(!('jobTitle' in person), 'no jobTitle — the page never uses the word "founder"');
    assert.ok(!('legalName' in about) && !('legalName' in person),
      'no legalName anywhere — the /about Company row is explicitly HELD pending a GOV-2 ruling');
  });

  it('the pre-existing no-JSON-LD-Organization guard comment is preserved', () => {
    const html = readPublic('about.html');
    assert.match(html, /a\s+template Organization block would carry its description to a new machine\s+surface without a copy gate/,
      'the guard comment naming the gated description must survive');
  });
});

describe('Wave D2 §5: no Organization node in scope carries the retired dollar band or 70/60 split', () => {
  it('Organization.description on all 7 named pages carries neither string', () => {
    for (const page of SCHEMA_SHEET_PAGES) {
      const nodes = extractLdJsonNodes(readPublic(page));
      const org = nodes.find((n) => n['@type'] === 'Organization');
      assert.ok(!org.description.includes('$0.05 to $50.00'),
        `${page} Organization description must not carry the retired dollar band`);
      assert.ok(!org.description.includes('70%'),
        `${page} Organization description must not carry the 70/60 split clause`);
    }
  });
});
