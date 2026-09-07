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

describe('SITE-PERFECT-W2 item B — /how-it-works wallet-sentence dedup', () => {
  it('the duplicate Base-answer wallet sentence is gone from the page entirely (rendered + JSON-LD)', () => {
    const count = hiw.split(DELETED_SENTENCE).length - 1;
    assert.equal(count, 0, 'deleted sentence must not appear anywhere on the page');
  });

  it('the FAQPage JSON-LD "What is Base?" answer no longer carries the deleted sentence', () => {
    const jsonLdMatch = hiw.match(
      /"name":\s*"What is Base\?"[\s\S]*?"text":\s*"([^"]*)"/
    );
    assert.ok(jsonLdMatch, 'expected a "What is Base?" JSON-LD answer');
    assert.ok(
      !jsonLdMatch[1].includes(DELETED_SENTENCE),
      'JSON-LD Base answer must not include the deleted sentence'
    );
  });

  it('the rendered FAQ "What is Base?" answer no longer carries the deleted sentence', () => {
    const renderedMatch = hiw.match(
      /<span>What is Base\?<\/span>[\s\S]*?<div class="faq-answer-inner">([^<]*)<\/div>/
    );
    assert.ok(renderedMatch, 'expected a rendered "What is Base?" FAQ answer');
    assert.ok(
      !renderedMatch[1].includes(DELETED_SENTENCE),
      'rendered Base answer must not include the deleted sentence'
    );
  });

  it('the USDC answer keeps its fuller wallet sentence exactly once, unchanged', () => {
    const count = hiw.split(USDC_KEPT_SENTENCE).length - 1;
    assert.equal(count, 2, 'expected the USDC wallet sentence once in JSON-LD and once in rendered markup');
  });

  it('the Base answer keeps the skip-crypto alternative-rail sentence exactly once per occurrence, unchanged', () => {
    const count = hiw.split(SKIP_CRYPTO_KEPT_SENTENCE).length - 1;
    assert.equal(count, 2, 'expected the skip-crypto sentence once in JSON-LD and once in rendered markup (kept, not a repeat)');
  });
});

describe('SITE-PERFECT-W2 item E1 — /pricing Value Tiers demotion', () => {
  it('the page has exactly seven h2 elements', () => {
    const h2Count = (pricing.match(/<h2\b/g) || []).length;
    assert.equal(h2Count, 7, 'pricing.html should have 7 h2s after the Value Tiers demotion');
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

  it('the demoted heading keeps id="tiers-heading" so the section aria-labelledby still resolves', () => {
    assert.match(
      pricing,
      /<section id="value-tiers"[^>]*aria-labelledby="tiers-heading"[^>]*>/,
      'value-tiers section must still reference tiers-heading'
    );
    assert.match(pricing, /id="tiers-heading"/, 'tiers-heading id must exist on the page');
  });

  it('the tier table and its body content are unchanged (byte-identical rows)', () => {
    assert.match(pricing, /<table class="value-tiers-table">/);
    assert.match(pricing, /<td class="tier-name">Micro<\/td>/);
    assert.match(pricing, /<td class="price-range">\$10\.00 to \$50\.00<\/td>/);
  });
});
