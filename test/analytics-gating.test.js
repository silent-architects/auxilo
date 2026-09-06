'use strict';

/**
 * test/analytics-gating.test.js: quiet-phase analytics readiness gating.
 *
 * The contract under test (mirrors the X402_ROUTER_ADDRESS flag pattern):
 *   UNSET (default): byte-identical current behavior. The CSP header string
 *   equals the exact pre-analytics policy, and served HTML is returned
 *   unchanged. This file PINS both.
 *   SET: served HTML gains exactly one Plausible script tag before </head>,
 *   and the CSP gains ONLY plausible.io in script-src and connect-src.
 *
 * Two layers, matching the repo's conventions:
 *   A) Behavioral unit tests of the pure helpers in lib/analytics.js.
 *   B) Structural tests that server.js wires the helpers at every HTML
 *      choke point (serveStatic, the /earnings server-render, the legal-page
 *      renderer) and builds the CSP through the same gate. Mirrors
 *      test/geo-embargo.test.js, which analyzes server.js source rather than
 *      booting the whole app.
 *
 * Runner: node --test test/analytics-gating.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  ANALYTICS_HOST,
  resolveAnalyticsDomain,
  analyticsScriptTag,
  injectAnalytics,
  buildContentSecurityPolicy,
} = require('../lib/analytics.js');

const SERVER_SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf-8');

function sliceAt(marker, span = 2000) {
  const i = SERVER_SRC.indexOf(marker);
  assert.notEqual(i, -1, `marker not found: ${marker}`);
  return SERVER_SRC.slice(i, i + span);
}

// The exact policy served before the analytics work landed. If this string
// changes, the unset-env byte-identity guarantee is broken: treat any edit
// here as a security-header change requiring Gate-A security review.
// Wave D1 fix pass (F4, 2026-09-06): style-src/font-src dropped their
// fonts.googleapis.com / fonts.gstatic.com allowances now that the site
// self-hosts Archivo + IBM Plex Mono (see public/fonts/, public/styles.css)
// and no longer requests fonts from Google — deliberate tightening, updated
// here alongside lib/analytics.js.
const BASELINE_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "base-uri 'self'",
].join('; ');

const SAMPLE_HTML = '<!DOCTYPE html>\n<html><head>\n  <title>t</title>\n</head>\n<body><p>hello</p></body></html>';

// ─────────────────────────────────────────────────────────────────────────────
// A. UNSET default: byte-identical behavior (the load-bearing guarantee)
// ─────────────────────────────────────────────────────────────────────────────
describe('ANALYTICS_DOMAIN unset: byte-identical current behavior', () => {
  it('the CSP equals the exact pre-analytics policy string', () => {
    assert.equal(buildContentSecurityPolicy(''), BASELINE_CSP);
  });

  it('resolveAnalyticsDomain maps unset/empty/whitespace to the inert value', () => {
    for (const raw of [undefined, null, '', '   ']) {
      assert.equal(resolveAnalyticsDomain(raw), '');
    }
  });

  it('injectAnalytics returns the HTML unchanged (identical string)', () => {
    assert.equal(injectAnalytics(SAMPLE_HTML, ''), SAMPLE_HTML);
  });

  it('analyticsScriptTag emits nothing', () => {
    assert.equal(analyticsScriptTag(''), '');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A. Malformed env values fail INERT, never open
// ─────────────────────────────────────────────────────────────────────────────
describe('resolveAnalyticsDomain: malformed values are refused (fail inert)', () => {
  for (const bad of [
    'auxilo.io"><script>alert(1)</script>',
    'https://auxilo.io',
    'auxilo.io/path',
    'auxilo.io:443',
    'has space.io',
    'no-dot-single-label',
    '-bad.io',
    'bad-.io',
    'auxilo.io.',
  ]) {
    it(`refuses ${JSON.stringify(bad)}`, () => {
      assert.equal(resolveAnalyticsDomain(bad), '');
    });
  }

  it('accepts a bare hostname and lowercases it', () => {
    assert.equal(resolveAnalyticsDomain('auxilo.io'), 'auxilo.io');
    assert.equal(resolveAnalyticsDomain(' Auxilo.IO '), 'auxilo.io');
    assert.equal(resolveAnalyticsDomain('sub.auxilo.io'), 'sub.auxilo.io');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A. SET: exactly the documented additions, nothing more
// ─────────────────────────────────────────────────────────────────────────────
describe('ANALYTICS_DOMAIN set: minimal exact additions', () => {
  const DOMAIN = 'auxilo.io';

  it('the script tag matches the documented Plausible snippet exactly', () => {
    assert.equal(
      analyticsScriptTag(DOMAIN),
      `<script defer data-domain="auxilo.io" src="${ANALYTICS_HOST}/js/script.js"></script>`
    );
    assert.equal(ANALYTICS_HOST, 'https://plausible.io');
  });

  it('injectAnalytics adds exactly one tag, before </head>, altering nothing else', () => {
    const out = injectAnalytics(SAMPLE_HTML, DOMAIN);
    const tag = analyticsScriptTag(DOMAIN);
    const occurrences = out.split(tag).length - 1;
    assert.equal(occurrences, 1);
    assert.ok(out.indexOf(tag) < out.indexOf('</head>'), 'tag must sit inside <head>');
    assert.equal(out.replace(`  ${tag}\n`, ''), SAMPLE_HTML, 'removing the injected line restores the original bytes');
  });

  it('injectAnalytics leaves head-less documents unchanged (fail inert)', () => {
    const fragment = '<p>no head here</p>';
    assert.equal(injectAnalytics(fragment, DOMAIN), fragment);
  });

  it('the CSP gains plausible.io in script-src and connect-src ONLY', () => {
    const base = buildContentSecurityPolicy('').split('; ');
    const withA = buildContentSecurityPolicy(DOMAIN).split('; ');
    assert.equal(base.length, withA.length, 'no directive may be added or removed');
    for (let i = 0; i < base.length; i++) {
      if (base[i].startsWith('script-src ')) {
        assert.equal(withA[i], `${base[i]} ${ANALYTICS_HOST}`);
      } else if (base[i].startsWith('connect-src ')) {
        assert.equal(withA[i], `${base[i]} ${ANALYTICS_HOST}`);
      } else {
        assert.equal(withA[i], base[i], `directive must be untouched: ${base[i]}`);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B. Structural: server.js wiring at every HTML choke point
// ─────────────────────────────────────────────────────────────────────────────
describe('server.js analytics wiring', () => {
  it('imports the helpers and resolves the domain from the env flag once', () => {
    assert.ok(SERVER_SRC.includes("require('./lib/analytics.js')"));
    assert.ok(SERVER_SRC.includes('const ANALYTICS_DOMAIN = resolveAnalyticsDomain(process.env.ANALYTICS_DOMAIN)'));
  });

  it('the served CSP header is built through the gate', () => {
    assert.ok(SERVER_SRC.includes('const CONTENT_SECURITY_POLICY = buildContentSecurityPolicy(ANALYTICS_DOMAIN)'));
    assert.ok(SERVER_SRC.includes("c.header('Content-Security-Policy', CONTENT_SECURITY_POLICY)"));
  });

  it('serveStatic injects ONLY for .html and ONLY when the flag is set', () => {
    const h = sliceAt('function serveStatic(');
    assert.ok(h.includes("ANALYTICS_DOMAIN && ext === '.html'"), 'the guard must require both the flag and an HTML file');
    assert.ok(h.includes('injectAnalytics('), 'injection must go through the shared helper');
  });

  it('the /earnings server-render path goes through the same helper', () => {
    const h = sliceAt("app.get('/earnings'", 2400);
    assert.ok(h.includes('injectAnalytics(html, ANALYTICS_DOMAIN)'));
  });

  it('the legal-page renderer goes through the same helper', () => {
    // Wave E3 item 3 added the shared #main-nav markup + hamburger toggle
    // script to serveLegalPage, pushing injectAnalytics() past the old
    // 8000-char window (then ~9600 chars in) -- widened, not narrowed.
    // Wave E fix (F7) added the GFM-lite table-extraction helper ahead of
    // that same call, pushing it to ~11721 chars in -- widened again.
    // CREDITS-CONTROL PART 1 (D8) added the ## heading id="section-N" rule
    // ahead of that same call, pushing it to ~12433 chars in -- widened again.
    const h = sliceAt('function serveLegalPage(', 12600);
    assert.ok(h.includes('injectAnalytics(html, ANALYTICS_DOMAIN)'));
  });
});
