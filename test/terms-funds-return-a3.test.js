'use strict';

/**
 * test/terms-funds-return-a3.test.js
 *
 * Terms amendment 2026-10-16-funds-return-a3 (return of unused paid funding),
 * the served-copy alignment, and the paused-state availability copy. Source of
 * wording: EMFR-ACTIVATION-PREP-TERMS-DISCLOSURE-CONTROLS-2026-10-14.md (v2),
 * sections 1 to 3, approved by counsel and Tyler. Section 4 (activation) is not
 * applied here and no capability is enabled by this change.
 *
 * Runner: node --test test/terms-funds-return-a3.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(REPO, ...p), 'utf8');

const NEW_VERSION = '2026-10-16-funds-return-a3';
const R2 = "Funds spent on an Unlock are final and non-refundable, as Section 7.3 provides. Unused Added Funds that were paid by card are not refundable except as the Return of Unused Paid Funding in Section 7.7 provides, as Sections 7.6 and 14 provide, and where applicable law requires a refund or cash payment of a remaining Paid Balance, which Auxilo will make on your written request to hello@auxilo.io.";
const R3 = "When Auxilo publishes that returns are available for your account's funding period, you may request the return of eligible unused paid funding. Eligible means: funds you paid by card through Auxilo's current payment account, in US dollars, that were never spent on an Unlock, are not promotional, are not restricted by a dispute, reversal or hold, and belong to the funding period for which returns are published. Funding from before the published period is not eligible under this Section; its treatment is governed by the terms that applied when it was purchased and by applicable law. A return is quoted before it is requested. The quote applies the eligible verified processing and return costs first, covered first from eligible realized net margin; where that margin does not cover them, the quote states the one permitted uncovered shortfall, without markup, and the exact amount that would reach the original payment method, and you may decline. Fractional balances are preserved exactly. Returns go only to the original payment method of the funding being returned, never to another card, account or wallet, and only up to the amount of that payment that remains unused. When you confirm a request, the quoted amount is reserved and is no longer spendable while the return is in progress. If the payment provider confirms the return, the reserved amount is settled as returned and leaves your balance. If the provider definitively fails the return, Auxilo restores to your balance exactly the entitlement its records and the provider's evidence support. While the provider's result is unresolved, the reserved amount stays held, is not spendable, and is shown to you as held; Auxilo does not treat it as returned or as restored until the result is verified. Auxilo may decline a request while a payment is disputed, while recovery of its records is in progress, or where the provider cannot accept the request.";
const R4 = "A withdrawal or return under Section 7.7 concerns unused paid funding only; it is not a refund of an Unlock and never reverses a completed Unlock.";
const PAUSED_LINE = 'Adding funds is paused during the migration; see the status page.';
const STATUS_SENTENCE = 'Adding funds, paid unlocks and contributor withdrawals are paused while Auxilo completes its financial-records migration. Discovery, free reads and account access remain available. Recorded balances are preserved.';

const TOS = read('docs', 'TERMS-OF-SERVICE.md');
const slice = (from, to) => TOS.slice(TOS.indexOf(from), TOS.indexOf(to));

describe('funds-return a3: version of record', () => {
  const { CURRENT_TOS_VERSION } = require('../lib/accounts.js');

  it('CURRENT_TOS_VERSION is the a3 amendment id', () => {
    assert.equal(CURRENT_TOS_VERSION, NEW_VERSION);
  });

  it('the Terms header, last-updated line and footer carry the same amendment id', () => {
    const current = /Current Amendment: `([^`]+)`/.exec(TOS);
    assert.ok(current, 'Current Amendment banner present');
    assert.equal(current[1], NEW_VERSION);
    assert.ok(TOS.includes('Current amendment: ' + NEW_VERSION + '.*'), 'footer carries the a3 id');
    assert.ok(!TOS.includes('2026-09-27-credit-balance-a2`, effective'), 'the a2 banner no longer claims to be current');
  });
});

describe('funds-return a3: R1 terminology (Credit Packs to Added Funds)', () => {
  it('Section 7.1 names Added Funds and keeps the bridge sentence', () => {
    const s71 = slice('### 7.1 Payment Methods', '### 7.2 Credit Terms');
    assert.ok(s71.includes('**Added Funds.** A registered user may add funds of $10, $25, or $100 through the card payment methods offered at checkout (previously described as a credit pack; the two terms mean the same balance).'));
    assert.ok(!/Credit Packs/.test(TOS), 'no "Credit Packs" heading survives');
  });

  it('the only remaining "credit pack" in the Terms is the bridge sentence (positive control: it is found once)', () => {
    const hits = TOS.match(/credit packs?/gi) || [];
    assert.equal(hits.length, 1, 'exactly the bridge sentence');
    assert.ok(TOS.includes('previously described as a credit pack'));
  });

  it('later references use Added Funds: definitions, 7.1 limits, 7.2, 7.6 and 5.10(c)', () => {
    assert.match(TOS, /"Added Funds" are Balance added under Section 7\.1/);
    assert.match(TOS, /The part of a Balance that was added by Added Funds paid for with money\./);
    assert.match(slice('**Limits.**', '### 7.2 Credit Terms'), /Added Funds/);
    assert.match(slice('### 7.6', '### 7.7'), /a payment for Added Funds/);
    assert.match(TOS, /Money a Consumer pays as Added Funds is received by Auxilo in its own right/);
  });
});

describe('funds-return a3: R2 non-refundable bullet', () => {
  it('Section 7.2 carries the two approved sentences verbatim and the old bullet is gone', () => {
    const s72 = slice('### 7.2 Credit Terms', '### 7.3 Transaction Finality');
    assert.ok(s72.includes(R2));
    assert.ok(!s72.includes('Credits are **non-refundable** except as these Terms provide.'));
  });

  it('the no-cash-value bullet no longer contradicts 7.7: it excepts Section 7.7 as well as applicable law (builder reconciliation, flagged for counsel)', () => {
    const s72 = slice('### 7.2 Credit Terms', '### 7.3 Transaction Finality');
    assert.ok(s72.includes('cannot be withdrawn or redeemed for currency, except as Section 7.7 provides or where applicable law requires it.'));
  });
});

describe('funds-return a3: R3 Section 7.7', () => {
  it('7.7 follows 7.6 and precedes Section 8, with no renumbering of Section 8 onward', () => {
    const i76 = TOS.indexOf('### 7.6 Refunds, Reversals, and Disputes');
    const i77 = TOS.indexOf('### 7.7 Withdrawal or Return of Unused Paid Funding');
    const i8 = TOS.indexOf('## 8. Intellectual Property');
    assert.ok(i76 !== -1 && i77 !== -1 && i8 !== -1);
    assert.ok(i76 < i77 && i77 < i8);
    assert.equal((TOS.match(/^### 7\.7 /gm) || []).length, 1);
  });

  it('7.7 body is the approved v2 text verbatim', () => {
    const body = slice('### 7.7 Withdrawal or Return of Unused Paid Funding', '## 8. Intellectual Property');
    assert.ok(body.includes(R3));
  });

  it('7.7 states no number and carries no brand-rule words (positive control: the check finds "Unlock" in the same body)', () => {
    const body = slice('### 7.7 Withdrawal or Return of Unused Paid Funding', '## 8. Intellectual Property');
    assert.ok(/Unlock/.test(body), 'positive control');
    assert.ok(!/\bshare\b/i.test(body));
    assert.ok(!/\bmarketplace\b/i.test(body));
    assert.ok(!/\$\d/.test(body), 'the quote is the number');
  });

  it('the horizontal-rule count of the Terms is unchanged (wave-e3 pins 21)', () => {
    assert.equal(TOS.split('\n').filter((l) => l.trim() === '---').length, 21);
  });
});

describe('funds-return a3: R4 and R5 cross-references', () => {
  it('7.3 carries the R4 sentence', () => {
    assert.ok(slice('### 7.3 Transaction Finality', '### 7.4 Blockchain Transactions').includes(R4));
  });

  it('7.6 and 14.3 cross-reference 7.7 without restricting existing rights', () => {
    const s76 = slice('### 7.6', '### 7.7');
    assert.match(s76, /Section 7\.7/);
    assert.match(s76, /does not limit this Section/);
    const s143 = slice('### 14.3 Effect of Termination', '### 14.4 Survival');
    assert.match(s143, /Section 7\.7/);
    assert.match(s143, /does not limit/);
  });
});

describe('funds-return a3: served copy', () => {
  for (const page of ['pricing', 'dashboard']) {
    it(page + '.html: the non-refundable sentence is aligned to R2/R3', () => {
      const html = read('public', page + '.html');
      assert.ok(!html.includes('Credits are non-refundable except as these Terms provide.'));
      assert.ok(!html.includes('including that credits are non-refundable and do not expire'));
      assert.match(html, /including that Unlock purchases are final and credits do not expire\./);
      assert.match(html, /Unused funds that were paid by card are not refundable except as the Terms provide, including the return of unused paid funding when returns are published for your funding period/);
      assert.match(html, /Unlock purchases are final and non-refundable\./);
      assert.ok(!html.includes('All transactions on the Platform are final.'));
      assert.ok(html.includes('cannot be withdrawn or redeemed for currency, except as the Terms provide or where applicable law requires it.'));
    });
  }

  it('llms.txt: returns are conditional on publication and a confirmed return is held, not spendable, until the provider result is verified', () => {
    const t = read('public', 'llms.txt');
    assert.ok(t.includes('when returns are published for your funding period'));
    assert.match(t, /A confirmed return is held, not spendable, until the provider result is verified\./);
    assert.ok(t.includes('Earned margin covers verified costs first; a quote shows any uncovered cost'), 'existing sentence kept');
  });
});
