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
