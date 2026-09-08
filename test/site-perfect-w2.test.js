'use strict';

/**
 * test/site-perfect-w2.test.js — SITE-PERFECT-W2 items B + E1
 * (~/.auxilo/handoffs/SITE-PERFECT-STRINGS-PACKET-W2-2026-09-06.md,
 * Tyler-approved "approved" 2026-09-06).
 *
 * Item B: /how-it-works, pure deletion. The Base FAQ answer repeated a
 * wallet fact the USDC FAQ answer already states completely. The
 * duplicate sentence ("If you choose the optional crypto withdrawal
 * path, you will need a Base-compatible wallet to receive USDC.") comes
 * out of BOTH the rendered FAQ markup and the matching FAQPage JSON-LD
 * block so the two stay in sync. The USDC answer's fuller sentence and
 * the Base answer's "skip crypto entirely" alternative-rail sentence are
 * kept verbatim, unchanged.
 *
 * SUPERSEDED (SITE-RESTRUCTURE-W3 item A, 2026-09-07): /how-it-works lost
 * its entire FAQ section, including "What is Base?" and "What is USDC?",
 * as part of the 31->18 FAQ consolidation (Tyler-approved "one canonical
 * FAQ per topic domain"). The per-question dedup assertions below are moot
 * now that the section they targeted no longer exists; they are kept as
 * "gone entirely" checks instead of being deleted outright, per the
 * project's "mark superseded, never delete" convention. See
 * test/faq-consolidation.test.js for the current per-page FAQ contract.
 *
 * Item E1: /pricing, structural only. `Dynamic, Not Fixed.` stays an h2.
 * `Value Tiers` is demoted from its own h2/section-heading to the tier
 * table's label — reusing this same page's existing sub-block label
 * pattern (the `Payment Methods` h3 under For Builders,
 * `font-size:16px;font-weight:600;color:var(--ivory);margin-bottom:16px;
 * letter-spacing:-0.01em;`). The heading's `id="tiers-heading"` is kept
 * so the section's existing `aria-labelledby="tiers-heading"` and any
 * external anchor keep resolving. No copy changed — only the heading tag
 * and level. The page drops from eight h2s to seven.
 *
 * Runner: node --test test/site-perfect-w2.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const HIW_PATH = path.join(REPO, 'public', 'how-it-works.html');
const PRICING_PATH = path.join(REPO, 'public', 'pricing.html');

const hiw = fs.readFileSync(HIW_PATH, 'utf8');
const pricing = fs.readFileSync(PRICING_PATH, 'utf8');

const DELETED_SENTENCE =
  'If you choose the optional crypto withdrawal path, you will need a Base-compatible wallet to receive USDC.';
const USDC_KEPT_SENTENCE =
  'When USDC withdrawals open you will need a Base-compatible wallet like Coinbase Wallet or MetaMask, though a wallet is optional and not required to start earning.';
const SKIP_CRYPTO_KEPT_SENTENCE =
  'If you prefer, you can skip crypto entirely and take Stripe-to-bank withdrawals instead.';

describe('SITE-PERFECT-W2 item B — /how-it-works wallet-sentence dedup (SUPERSEDED, see header)', () => {
  it('the duplicate Base-answer wallet sentence is gone from the page entirely (rendered + JSON-LD)', () => {
    const count = hiw.split(DELETED_SENTENCE).length - 1;
    assert.equal(count, 0, 'deleted sentence must not appear anywhere on the page');
  });

  it('SUPERSEDED: /how-it-works no longer carries a FAQPage JSON-LD block at all ("What is Base?" included)', () => {
    assert.ok(!hiw.includes('FAQPage'), 'how-it-works.html must not carry a FAQPage JSON-LD block (FAQ section removed, W3 item A)');
    assert.ok(!hiw.includes('"name": "What is Base?"'), '"What is Base?" no longer exists anywhere on the page');
  });

  it('SUPERSEDED: /how-it-works no longer carries a rendered "What is Base?" FAQ item', () => {
    assert.ok(!/<span>What is Base\?<\/span>/.test(hiw), 'rendered "What is Base?" FAQ item must not exist (FAQ section removed, W3 item A)');
  });

  it('SUPERSEDED: the USDC answer sentence no longer appears anywhere (its FAQ item was removed with the section)', () => {
    const count = hiw.split(USDC_KEPT_SENTENCE).length - 1;
    assert.equal(count, 0, 'USDC wallet sentence lived only in the now-removed FAQ section');
  });

  it('SUPERSEDED: the skip-crypto sentence no longer appears anywhere (its FAQ item was removed with the section)', () => {
    const count = hiw.split(SKIP_CRYPTO_KEPT_SENTENCE).length - 1;
    assert.equal(count, 0, 'skip-crypto sentence lived only in the now-removed FAQ section');
  });
});

describe('SITE-PERFECT-W2 item E1 — /pricing Value Tiers demotion', () => {
  // SITE-RESTRUCTURE-W3 item C (2026-09-07) later folded Credit Packs (h2)
  // into For Agents (h3) and cut The Numbers (h2) entirely, taking the page
  // from seven h2s down to five. See test/site-restructure-w3-c.test.js for
  // that wave's own guards; this count is updated here so the two files
  // don't disagree about the current page.
  it('the page has exactly five h2 elements', () => {
    const h2Count = (pricing.match(/<h2\b/g) || []).length;
    assert.equal(h2Count, 5, 'pricing.html should have 5 h2s after SITE-RESTRUCTURE-W3 item C');
  });

  it('"Dynamic, Not Fixed." remains an h2', () => {
    assert.match(pricing, /<h2[^>]*id="how-pricing-heading"[^>]*>Dynamic, Not Fixed\.<\/h2>/);
  });

  it('"Value Tiers" appears exactly once as a heading, and it is not an h2', () => {
    const h2WithValueTiers = pricing.match(/<h2[^>]*>Value Tiers<\/h2>/);
    assert.equal(h2WithValueTiers, null, '"Value Tiers" must not be an h2 any more');

    const nonH2Heading = pricing.match(/<h3[^>]*id="tiers-heading"[^>]*>Value Tiers<\/h3>/);
    assert.ok(nonH2Heading, 'expected "Value Tiers" as an h3 labelled tiers-heading');
  });

  it('the demoted heading keeps id="tiers-heading" (SITE-RESTRUCTURE-W3 item C folded the standalone #value-tiers section into #how-pricing-works, so the heading no longer needs its own section landmark — same precedent as this page\'s "Payment Methods" h3)', () => {
    assert.match(pricing, /id="tiers-heading"/, 'tiers-heading id must exist on the page');
    // Match the actual <section id="value-tiers"> element, not a build
    // comment that names the retired id in prose (this page's own C1 merge
    // comment does exactly that).
    assert.equal(pricing.match(/<section id="value-tiers"/), null, 'the standalone value-tiers section container is gone (folded into how-pricing-works)');
    const howPricingSection = pricing.match(/<section id="how-pricing-works"[\s\S]*?<\/section>/);
    assert.ok(howPricingSection, 'expected #how-pricing-works section');
    assert.match(howPricingSection[0], /<h3[^>]*id="tiers-heading"[^>]*>Value Tiers<\/h3>/, 'Value Tiers heading now lives inside #how-pricing-works');
  });

  it('the tier table and its body content are unchanged (byte-identical rows)', () => {
    assert.match(pricing, /<table class="value-tiers-table">/);
    assert.match(pricing, /<td class="tier-name">Micro<\/td>/);
    assert.match(pricing, /<td class="price-range">\$10\.00 to \$50\.00<\/td>/);
  });
});
