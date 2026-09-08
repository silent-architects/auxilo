'use strict';

/**
 * test/ask-wave-b.test.js — ASK-WAVE builder B (2026-09-07)
 *
 * Source of truth: ~/.auxilo/handoffs/THE-ASK-PACKET-2026-09-06.md (verbatim
 * strings) + ~/.auxilo/handoffs/BUILD-SPEC-ASK-WAVE-2026-09-07.md Wave B.
 *
 * Static (source-level) checks only — no server boot, no browser.
 *
 * `/for-agents` (public/for-agents.html):
 *   - Final CTA pair `Get an API Key` / `Explore the API` (old lines
 *     875-876) is gone — both exact old anchor strings count 0.
 *   - Replaced with ONE `<a href="/connect" class="btn-primary">Install the
 *     MCP Server</a>`, mirroring the page's own hero (already-live line
 *     524). Sitewide on this page that string now counts 2 (hero + close)
 *     — same verb + same destination-type, one gold-event group per the
 *     AD's reusable-event test (packet, LAYOUT §item "The reusable
 *     gold-event test"), so both keeping `.btn-primary` is correct, not a
 *     second competing ask.
 *   - The closing-ask section (`#agent-cta`) carries exactly one
 *     `.btn-primary` element.
 *   - No stray gold: total `.btn-primary` count on the page is exactly 2
 *     (hero + close) — nothing else picked up the class.
 *   - Line 727's `Explore the API` (id="agents-cta", `.btn-secondary`,
 *     mid-page) is untouched — a different literal string (carries an id
 *     attribute) from the removed closing-pair instance, so it survives
 *     the count-0 assertion on the exact old string.
 *
 * `/for-builders` (public/for-builders.html):
 *   - Closing ask (hero `<a href="/connect" class="btn-primary">Connect
 *     Your Agent</a>`, line 460) is UNCHANGED — packet: "No copy change.
 *     Its ask is already `Connect Your Agent` and it is correct."
 *   - Mid-page `#builders-setup-cta` (was the page's only other
 *     `.btn-primary`, line 588) demoted to `.btn-secondary` — exact old
 *     string count 0, exact new string count 1.
 *   - Total `.btn-primary` count on the page is exactly 1 (the closing ask
 *     only) — gold appears once.
 *
 * `/pricing` (public/pricing.html) — out of scope for THIS wave, guarded
 *   untouched: byte-identical to origin/main (its three `Buy credits`
 *   buttons take real money and must never be touched by ASK-WAVE-B).
 *
 * SCOPE NOTE (SITE-RESTRUCTURE-W3 item A, 2026-09-07): the /pricing guard
 * below was narrowed from "byte-identical to origin/main in full" to
 * "byte-identical outside the FAQ section". ASK-WAVE-B shipped and is not
 * touching this file again; the blanket guard was this wave's own
 * self-check, not a promise that no *later*, separately-scoped wave would
 * ever touch pricing.html. SITE-RESTRUCTURE-W3 item A is a distinct,
 * Tyler-approved, spec'd wave (`~/.auxilo/handoffs/
 * SITE-RESTRUCTURE-W3-SPEC-2026-09-07.md` section A) that cuts 3 FAQ
 * questions from /pricing's `#faq` section (rendered + FAQPage JSON-LD)
 * as part of a site-wide "one canonical FAQ per topic" consolidation. It
 * never touches the pack cards, the Buy-credits buttons, or anything
 * money-shaped — the positive-control test below still enforces that
 * directly. The guard now proves the FAQ section is the *only* place the
 * file changed, which is a strictly narrower, still-real protection than
 * the original all-bytes check.
 *
 * Runner: node --test test/ask-wave-b.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO = path.join(__dirname, '..');

function readPublic(name) {
  return fs.readFileSync(path.join(REPO, 'public', name), 'utf-8');
}

// The sitewide `styles.css?v=<hash>` cache-bust query is rewritten by the
// PM's `asset-versions --write` after any styles.css change, by design —
// it is not a copy or markup change. Normalize every `?v=[0-9a-f]+`
// occurrence to a fixed token so a hash-only rewrite doesn't trip a
// byte-identity guard, while everything else still has to match exactly.
function normalizeCacheBust(buf) {
  const str = buf.toString('utf-8').replace(/\?v=[0-9a-f]+/g, '?v=CACHEBUST');
  return Buffer.from(str, 'utf-8');
}

// The guard means "this wave did not touch /pricing" — that has to be
// checked against the point this wave actually forked from main, not
// against origin/main's current tip, which may have moved on for reasons
// unrelated to this wave and would otherwise produce false failures (or
// false passes, if main happened to touch pricing.html the same way).
function resolveWaveBaseRef() {
  try {
    return execFileSync('git', ['merge-base', 'HEAD', 'origin/main'], {
      cwd: REPO,
    })
      .toString('utf-8')
      .trim();
  } catch (err) {
    // No merge-base available (e.g. origin/main not fetched here) — fall
    // back to comparing against origin/main directly.
    return 'origin/main';
  }
}

function countOccurrences(haystack, needle) {
  if (needle === '') return 0;
  let count = 0;
  let idx = 0;
  for (;;) {
    idx = haystack.indexOf(needle, idx);
    if (idx === -1) break;
    count += 1;
    idx += needle.length;
  }
  return count;
}

let forAgentsSrc;
let forBuildersSrc;

before(() => {
  forAgentsSrc = readPublic('for-agents.html');
  forBuildersSrc = readPublic('for-builders.html');
});

describe('ASK wave B — /for-agents closing ask', () => {
  it('old string: "Get an API Key" dashboard anchor is gone (count 0)', () => {
    const old = '<a href="/dashboard" class="btn-secondary">Get an API Key</a>';
    assert.equal(countOccurrences(forAgentsSrc, old), 0);
  });

  it('old string: the closing-pair "Explore the API" anchor is gone (count 0)', () => {
    // Exact old closing-pair markup (no id attribute) — distinct from the
    // untouched mid-page instance at line 727, which carries id="agents-cta".
    const old = '<a href="/api" class="btn-secondary">Explore the API</a>';
    assert.equal(countOccurrences(forAgentsSrc, old), 0);
  });

  it('mid-page "Explore the API" secondary (id="agents-cta") is untouched', () => {
    const untouched = '<a href="/api" id="agents-cta" class="btn-secondary">Explore the API</a>';
    assert.equal(countOccurrences(forAgentsSrc, untouched), 1);
  });

  it('new string: one primary "Install the MCP Server" -> /connect, count 2 sitewide on this page (hero + close)', () => {
    const fresh = '<a href="/connect" class="btn-primary">Install the MCP Server</a>';
    assert.equal(countOccurrences(forAgentsSrc, fresh), 2);
  });

  it('the closing-ask section (#agent-cta) carries exactly one .btn-primary', () => {
    const sectionMatch = forAgentsSrc.match(
      /<section class="agent-cta-section[\s\S]*?<\/section>/
    );
    assert.ok(sectionMatch, 'expected to find the #agent-cta Final CTA section');
    const section = sectionMatch[0];
    assert.equal(countOccurrences(section, 'class="btn-primary"'), 1);
    assert.equal(countOccurrences(section, 'class="btn-secondary"'), 0);
  });

  it('no stray gold: total .btn-primary class count on the page is exactly 2', () => {
    assert.equal(countOccurrences(forAgentsSrc, 'class="btn-primary"'), 2);
  });
});

describe('ASK wave B — /for-builders mid-page gold demotion', () => {
  it('closing ask (hero "Connect Your Agent" -> /connect) is unchanged', () => {
    const unchanged = '<a href="/connect" class="btn-primary">Connect Your Agent</a>';
    assert.equal(countOccurrences(forBuildersSrc, unchanged), 1);
  });

  it('old string: mid-page #builders-setup-cta as .btn-primary is gone (count 0)', () => {
    const old =
      '<a href="/connect" id="builders-setup-cta" class="btn-primary">Run <code style="font-family:var(--mono);font-size:0.9em;">npx auxilo setup</code></a>';
    assert.equal(countOccurrences(forBuildersSrc, old), 0);
  });

  it('new string: mid-page #builders-setup-cta demoted to .btn-secondary (count 1)', () => {
    const fresh =
      '<a href="/connect" id="builders-setup-cta" class="btn-secondary">Run <code style="font-family:var(--mono);font-size:0.9em;">npx auxilo setup</code></a>';
    assert.equal(countOccurrences(forBuildersSrc, fresh), 1);
  });

  it('the copy button targeting footer-setup-code reads "Copy the Setup Command" (SITE-PM label-follows-target ruling; micro-1)', () => {
    const relabelled =
      '<button class="copy-btn" id="copy-footer-setup" onclick="copyCode(\'footer-setup-code\', \'copy-footer-setup\')" aria-label="Copy command">Copy the Setup Command</button>';
    assert.equal(countOccurrences(forBuildersSrc, relabelled), 1);
  });

  it('the three documentation copy controls (not targeting npx auxilo setup) still read lowercase "copy"', () => {
    const openclaw =
      '<button class="copy-btn" id="copy-openclaw" onclick="copyCode(\'openclaw-code\', \'copy-openclaw\')" aria-label="Copy code">copy</button>';
    const learn =
      '<button class="copy-btn" id="copy-learn" onclick="copyCode(\'learn-code\', \'copy-learn\')" aria-label="Copy code">copy</button>';
    const wallet =
      '<button class="copy-btn" id="copy-wallet" onclick="copyCode(\'wallet-code\', \'copy-wallet\')" aria-label="Copy code">copy</button>';
    assert.equal(countOccurrences(forBuildersSrc, openclaw), 1);
    assert.equal(countOccurrences(forBuildersSrc, learn), 1);
    assert.equal(countOccurrences(forBuildersSrc, wallet), 1);
  });

  it('gold appears once: total .btn-primary class count on the page is exactly 1', () => {
    assert.equal(countOccurrences(forBuildersSrc, 'class="btn-primary"'), 1);
  });
});

// Strip the two FAQ-shaped regions SITE-RESTRUCTURE-W3 item A is
// authorized to touch: the rendered `<section id="faq">...</section>`
// block, and the FAQPage node's `mainEntity` array inside the page's
// JSON-LD script. Everything else in the returned string must still be
// byte-identical to the pre-W3-A baseline for the guard below to hold.
function stripAuthorizedFaqRegions(str) {
  let out = str.replace(/<section id="faq"[\s\S]*?<\/section>/, '<section id="faq"></section>');
  out = out.replace(/("mainEntity":\s*\[)[\s\S]*?(\]\s*\}\s*\]\s*\}\s*<\/script>)/, '$1$2');
  return out;
}

describe('ASK wave B — /pricing guard (out of scope, real money)', () => {
  it('public/pricing.html is byte-identical to origin/main outside the FAQ section (SITE-RESTRUCTURE-W3 item A scope note above)', () => {
    const baseRef = resolveWaveBaseRef();
    let baseBytes;
    try {
      baseBytes = execFileSync(
        'git',
        ['show', `${baseRef}:public/pricing.html`],
        { cwd: REPO, maxBuffer: 1024 * 1024 * 16 }
      );
    } catch (err) {
      assert.fail(
        `could not read ${baseRef}:public/pricing.html for comparison — ${err.message}`
      );
      return;
    }
    const localBytes = fs.readFileSync(path.join(REPO, 'public', 'pricing.html'));
    const localNormalized = normalizeCacheBust(localBytes).toString('utf-8');
    const baseNormalized = normalizeCacheBust(baseBytes).toString('utf-8');
    assert.equal(
      stripAuthorizedFaqRegions(localNormalized),
      stripAuthorizedFaqRegions(baseNormalized),
      'public/pricing.html has diverged from origin/main OUTSIDE its FAQ section — only the #faq DOM block and the FAQPage JSON-LD mainEntity may change (SITE-RESTRUCTURE-W3 item A); the three Buy-credits buttons and everything else must stay untouched'
    );
  });

  it('its three "Buy credits" pack buttons are present and untouched (positive control)', () => {
    const pricingSrc = readPublic('pricing.html');
    assert.equal(countOccurrences(pricingSrc, 'class="btn-primary pack-buy-btn"'), 3);
    assert.equal(countOccurrences(pricingSrc, '>Buy credits<'), 3);
  });

  it('normalizer catches a real content change (one mutated copy byte does not disappear into the ?v= normalization)', () => {
    const localBytes = fs.readFileSync(path.join(REPO, 'public', 'pricing.html'));
    const normalizedOriginal = normalizeCacheBust(localBytes);
    const marker = 'Buy credits';
    const markerIdx = normalizedOriginal.indexOf(marker);
    assert.notEqual(markerIdx, -1, 'expected to find "Buy credits" copy in pricing.html to mutate');
    const mutated = Buffer.from(normalizedOriginal); // independent copy
    const flipIdx = markerIdx + marker.indexOf('c'); // mutate one byte of real copy: 'c' -> 'C'
    mutated[flipIdx] = 'C'.charCodeAt(0);
    assert.notEqual(
      Buffer.compare(normalizeCacheBust(mutated), normalizedOriginal),
      0,
      'a one-byte copy mutation must still be detected after ?v= normalization'
    );
  });

  it('normalizer passes when the only difference is the ?v= cache-bust hash', () => {
    const localBytes = fs.readFileSync(path.join(REPO, 'public', 'pricing.html'));
    const localStr = localBytes.toString('utf-8');
    assert.match(localStr, /\?v=[0-9a-f]+/, 'expected a ?v=<hash> cache-bust query in pricing.html');
    const withHashA = Buffer.from(localStr.replace(/\?v=[0-9a-f]+/g, '?v=aaaaaaaa'), 'utf-8');
    const withHashB = Buffer.from(localStr.replace(/\?v=[0-9a-f]+/g, '?v=bbbbbbbb'), 'utf-8');
    assert.equal(
      Buffer.compare(normalizeCacheBust(withHashA), normalizeCacheBust(withHashB)),
      0,
      'two copies differing only by ?v= hash value must normalize to byte-identical'
    );
  });
});
