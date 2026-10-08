"use strict";
const fs = require('fs'), path = require('path');
const {
  readJSONStrict, readJSONLStrict
}
= require('./stripe-transfer-persistence');
const {
  requireEpoch, verifyLegacy
}
= require('./financial-epoch');
function fail(code) {
  throw Object.assign(new Error(code), {
    code
  });
}
function readLegacy(name, epoch) {
  const {
    binding
  }
  = requireEpoch(epoch);
  verifyLegacy(epoch.legacy_root, binding);
  const row =(binding.identity.additional_observed || binding.identity.observed)[name];
  if (! row || row.state !== 'present') return {
    known: false, value: null
  };
  const file = path.join(epoch.legacy_root, name);
  return {
    known: true, value: name.endsWith('.jsonl') ? readJSONLStrict(file): readJSONStrict(file)
  };
}
function legacyFinancialView(accountId, epoch, {
  now = Date.now()
}
= {
}) {
  if (typeof accountId !== 'string' || ! accountId) fail('LEGACY_ACCOUNT_REQUIRED');
  const accounts = readLegacy('accounts.json', epoch), credits = readLegacy('credits.json', epoch), purchases = readLegacy('purchases.jsonl',
  epoch), holds = readLegacy('account-holds.json', epoch), earnings = readLegacy('earnings.json', epoch), entitlements = readLegacy('purchase-ledger.json',
  epoch);
  const existing = accounts.known && Object.hasOwn(accounts.value, accountId);
  const record = credits.known ? credits.value[accountId]: null;
  let balance = 0, valid = credits.known;
  if (record) {
    if (! Array.isArray(record.dollar_lots)) valid = false;
    else for (const l of record.dollar_lots) {
      if (! Number.isFinite(l.remaining_usd) || l.remaining_usd < 0) valid = false;
      else balance += l.remaining_usd;
    }
  }
  let daily = 0;
  if (purchases.known) for (const p of purchases.value.filter(p => p.account_id === accountId)) {
    const when = Date.parse(p.timestamp);
    if (! Number.isFinite(p.amount_usd) || ! Number.isFinite(when)) valid = false;
    else if (when >= now - 86400000) daily += p.amount_usd;
  }
  const cap_known = ! existing ||(valid && purchases.known && holds.known);
  return Object.freeze( {
    account_id: accountId, existing_account: existing, cap_exposure_known: cap_known, restricted_balance_usd: balance, restricted_legacy_units: record?.balance ?? null,
    daily_purchase_usd: daily, hold: holds.known ? holds.value[accountId] || null: null, hold_evidence_known: ! existing || holds.known,
    restricted_earnings: earnings.known ? earnings.value[accountId] || null: null, entitlements: entitlements.known ? Object.fromEntries(Object.entries(entitlements.value).filter(([k]) => k.startsWith(accountId + ':'))): {
    }, payout_assignment_approved: false
  });
}
function assertLegacyAdmission(accountId, epoch) {
  const view = legacyFinancialView(accountId, epoch);
  if (! view.cap_exposure_known) fail('LEGACY_CAP_EXPOSURE_UNKNOWN');
  if (view.hold) fail('LEGACY_ACCOUNT_HOLD');
  return view;
}
module.exports = {
  readLegacy, legacyFinancialView, assertLegacyAdmission
};
