'use strict';

/**
 * test/legal-packet-2026-09-06-item-a-and-banners.test.js — Legal Packet 2026-09-06,
 * Item A (Privacy §7.5 self-hosted fonts) + the two template-driven Terms banner
 * lines (byo-provider-c1, credit-disclosure-c1) added alongside the pre-existing
 * clean-lane-b1 / dark-path-b2 banners.
 *
 * Positive control: the old §7.5 Google Fonts text must be fully gone (0 hits),
 * and every one of the four dated banner ids must appear exactly once in
 * docs/TERMS-OF-SERVICE.md.
 *
 * Runner: node --test test/legal-packet-2026-09-06-item-a-and-banners.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(REPO, ...p), 'utf8');

const TOS = read('docs', 'TERMS-OF-SERVICE.md');
const PRIVACY = read('docs', 'PRIVACY-POLICY.md');

describe('Legal Packet 2026-09-06: Item A (Privacy §7.5) + Terms banner lines c1', () => {
  it('Privacy §7.5 reads self-hosted, the old Google Fonts paragraph is gone, and fonts.googleapis has zero hits in the file', () => {
    assert.ok(PRIVACY.includes('### 7.5 Web Fonts (Self-Hosted)'), 'new heading present');
    assert.ok(!PRIVACY.includes('### 7.5 Web Fonts (Google Fonts)'), 'old heading gone');
    assert.equal(
      (PRIVACY.match(/loads its display fonts from Google Fonts/g) || []).length,
      0,
      'old first sentence must be gone (positive control: 1 before, 0 after)'
    );
    assert.equal((PRIVACY.match(/fonts\.googleapis/g) || []).length, 0, 'fonts.googleapis must be absent from the Privacy doc');
    assert.ok(PRIVACY.includes('served from auxilo.io itself'), 'Form A replacement text present');
  });

  it('the three surviving dated Terms amendment banner ids appear exactly once each; credit-disclosure-c1 is gone', () => {
    for (const id of [
      '2026-09-06-clean-lane-b1',
      '2026-09-06-dark-path-b2',
      '2026-09-06-byo-provider-c1',
    ]) {
      const needle = '`' + id + '`';
      assert.equal(TOS.split(needle).length - 1, 1, `banner id ${id} must appear exactly once`);
    }
    // credit-disclosure-c1 disclosed a mechanic (unlock credits) the product no
    // longer has, so revision 3 of the credits-as-cash register cut its banner
    // line entirely. Positive control: byo-provider-c1 above is still present.
    assert.equal(
      TOS.split('`2026-09-06-credit-disclosure-c1`').length - 1,
      0,
      'credit-disclosure-c1 banner line removed (positive control: byo-provider-c1 still present above)'
    );
    // Only one "Current Amendment:" line, and it is the current one.
    assert.equal((TOS.match(/Current Amendment: `/g) || []).length, 1, 'only one "Current Amendment:" line');
    const current = /Current Amendment: `([^`]+)`/.exec(TOS);
    assert.equal(current[1], '2026-09-27-credit-balance-a2', 'acceptance version is the credit-as-cash amendment (revision 3)');
  });

  it('the byo-provider-c1 banner line keeps the same four-sentence form as clean-lane-b1 / dark-path-b2', () => {
    const shape = /\*\*Amendment `[^`]+` — .+, Non-Material, posted September 6, 2026\.\*\* This amendment .+\. It is a Non-Material change under Section 17: .+\. The Current Amendment id above \(the acceptance version of record\) is unchanged\./;
    const re = new RegExp('\\*\\*Amendment `2026-09-06-byo-provider-c1`[^\\n]*\\n');
    const line = re.exec(TOS);
    assert.ok(line, 'banner line for byo-provider-c1 present on its own line');
    assert.match(line[0].trim(), shape, 'banner line for byo-provider-c1 follows the shared sentence form');
  });

  it('the footer "last updated" line reads September 27, 2026 (credits-as-cash, revision 3), the stale September 6 line is gone', () => {
    assert.equal(
      (TOS.match(/were last updated on September 6, 2026/g) || []).length,
      0,
      'old footer date must be gone (positive control: 1 before, 0 after)'
    );
    assert.equal(
      (TOS.match(/were last updated on September 27, 2026/g) || []).length,
      1,
      'new footer date must appear exactly once (positive control: 0 before, 1 after)'
    );
  });

  it('§7.3 dispute contact reads support@auxilo.io (GOV-2 confirmed), the old hello@ sentence is gone', () => {
    assert.equal(
      (TOS.match(/If you believe a transaction was made due to a Platform error or involved fraudulent activity on our end, contact us at hello@auxilo\.io\./g) || []).length,
      0,
      'old §7.3 hello@ sentence must be gone (positive control: 1 before, 0 after)'
    );
    assert.equal(
      (TOS.match(/If you believe a transaction was made due to a Platform error or involved fraudulent activity on our end, contact us at support@auxilo\.io\./g) || []).length,
      1,
      'new §7.3 sentence must carry support@auxilo.io exactly once'
    );
  });
});
