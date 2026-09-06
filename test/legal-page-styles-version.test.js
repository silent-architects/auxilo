'use strict';

/**
 * test/legal-page-styles-version.test.js — Wave C.2 item 5.
 *
 * `serveLegalPage` in server.js (the renderer behind /terms, /privacy,
 * /legal/subprocessors, /legal/supported-clients, /dmca) builds its own
 * standalone <head> rather than reusing a page template, and it used to
 * hardcode `/styles.css?v=2` there — years stale against the `?v=` the real
 * pages ship (site-system.test.js's item 7 already pins every page in
 * STYLESHEET_PAGES to one shared value). A legal page loading an old,
 * possibly-nonexistent cache-bust query means it can silently serve a stale
 * stylesheet forever (the route is `Cache-Control: public, max-age=31536000,
 * immutable`), or in the old case, the wrong body of CSS entirely once the
 * assets under a retired `?v=` are pruned.
 *
 * This is a purely structural, file-level guard (no server boot needed):
 * it reads server.js and one real shipped page directly off disk and
 * asserts the two `?v=` values are the identical string. It intentionally
 * does not hardcode either page's expected literal — a future CSS change
 * bumping the pages' shared version must (per AGENTS.md / the CI count
 * pin) travel through this same commit's discipline, and this test's job
 * is only to catch the wrapper drifting AWAY from whatever that shared
 * value is, not to pin a specific number.
 *
 * Runner: node --test test/legal-page-styles-version.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..');
const SERVER_SRC = fs.readFileSync(path.join(REPO_ROOT, 'server.js'), 'utf8');
// index.html is one of the pages test/site-system.test.js's STYLESHEET_PAGES
// item-7 test already asserts is byte-identical, on this point, to every
// other shipped page -- any one of them is an equally valid reference.
const INDEX_HTML = fs.readFileSync(path.join(REPO_ROOT, 'public', 'index.html'), 'utf8');

function serveLegalPageSource() {
  const start = SERVER_SRC.indexOf('function serveLegalPage(');
  assert.notEqual(start, -1, 'server.js must define serveLegalPage');
  const end = SERVER_SRC.indexOf('\napp.get(', start);
  assert.notEqual(end, -1, 'could not find the end of serveLegalPage (next app.get)');
  return SERVER_SRC.slice(start, end);
}

describe('LEGAL-PAGE-STYLES-VERSION: serveLegalPage\'s styles.css ?v= matches the shipped pages\'', () => {
  it('public/index.html carries exactly one /styles.css?v=N link', () => {
    const matches = [...INDEX_HTML.matchAll(/href="\/styles\.css\?v=([0-9a-f]+)"/g)];
    assert.equal(matches.length, 1,
      `expected exactly one /styles.css?v=N link in index.html, found ${matches.length}`);
  });

  it('serveLegalPage links /styles.css with the same ?v=N as the pages', () => {
    const fnSrc = serveLegalPageSource();
    const legalMatch = fnSrc.match(/href="\/styles\.css\?v=([0-9a-f]+)"/);
    assert.ok(legalMatch, 'serveLegalPage must link /styles.css?v=N in its <head>');

    const pageMatch = INDEX_HTML.match(/href="\/styles\.css\?v=([0-9a-f]+)"/);
    assert.ok(pageMatch, 'index.html must link /styles.css?v=N');

    assert.equal(legalMatch[1], pageMatch[1],
      `serveLegalPage ships styles.css?v=${legalMatch[1]} but the pages ship ?v=${pageMatch[1]} — bump serveLegalPage's literal (or its shared constant, if one exists) to match in the same commit as any CSS change`);
  });

  it('serveLegalPage does not carry the old stale ?v=2 literal', () => {
    const fnSrc = serveLegalPageSource();
    assert.ok(!/href="\/styles\.css\?v=2"/.test(fnSrc),
      'serveLegalPage must not regress to the old hardcoded ?v=2');
  });
});
