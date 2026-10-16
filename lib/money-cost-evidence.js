'use strict';

// Provider observations are inputs to the money journal, never balance authority.
// All values cross this boundary as exact cents/micros; absence is not zero.
const crypto = require('crypto');
function unavailable(reason) { const e = new Error(reason); e.code = 'COST_EVIDENCE_UNAVAILABLE'; return e; }
function validInt(n) { return Number.isSafeInteger(n) && n >= 0; }
function centsToMicros(n) { if (!validInt(n) || !Number.isSafeInteger(n * 10000)) throw unavailable('Invalid provider money'); return n * 10000; }
function objectId(value) { return typeof value === 'string' ? value : value?.id; }
function digest(value) { return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function assertCostContext(source, context) {
 if (!source || source.platform !== 'auxilo_llc' || context?.stripe_platform !== source.platform || context.stripe_platform_account_id !== source.platform_account_id || typeof source.livemode !== 'boolean' || context.livemode !== source.livemode || source.currency !== 'usd' || !/^ch_\w+$/.test(source.charge_id || '') || !validInt(source.amountMicros) || !source.amountMicros) throw unavailable('Source/provider identity mismatch');
}
function validateOriginalCostContract({source,context,contract,now}){
 assertCostContext(source,context);
 if(!contract||contract.sourceId!==source.id||contract.provider!=='stripe'||contract.platform_account_id!==source.platform_account_id||contract.livemode!==source.livemode||contract.currency!=='usd'||contract.pricing_model!=='blended'||contract.all_components_in_balance_transaction!==true||contract.approved!==true||contract.complete!==true||contract.final!==true||!contract.id||!contract.evidence_ref||contract.tariff||!Number.isSafeInteger(contract.valid_from)||!Number.isSafeInteger(contract.valid_until)||now<contract.valid_from||now>=contract.valid_until)throw unavailable('Original-cost completeness requires approved source/account evidence; IC+ is unsupported');
 return contract;
}
function validateChargeCost({ source, context, charge, contract, observedAt = Date.now() }) {
 assertCostContext(source, context);
 validateOriginalCostContract({source,context,contract,now:observedAt});
 const b = charge?.balance_transaction;
 if (!charge || charge.object !== 'charge' || charge.id !== source.charge_id || charge.livemode !== source.livemode || charge.currency !== 'usd' || charge.paid !== true || charge.captured !== true || charge.status !== 'succeeded' || centsToMicros(charge.amount) !== source.amountMicros || !b || typeof b !== 'object' || b.object !== 'balance_transaction' || !/^txn_\w+$/.test(b.id || '') || objectId(b.source) !== charge.id || b.currency !== 'usd' || b.amount !== charge.amount || !validInt(b.fee) || !Number.isSafeInteger(b.net) || b.amount - b.fee !== b.net || !Array.isArray(b.fee_details) || !Number.isSafeInteger(observedAt)) throw unavailable('Incomplete original charge cost');
 let total = 0;
 const components = b.fee_details.map((part, index) => {
  if (!part || !validInt(part.amount) || part.currency !== 'usd' || typeof part.type !== 'string' || !part.type || !Number.isSafeInteger(total + part.amount)) throw unavailable('Incomplete charge fee component');
  total += part.amount;
  return { id: `${b.id}:${index}`, type: part.type, amountMicros: centsToMicros(part.amount) };
 });
 if (total !== b.fee || (b.fee > 0 && components.length === 0)) throw unavailable('Fee components do not reconcile');
 // The immutable identity excludes observation time; re-reading the same fee
 // must not manufacture a new cost. Corrections get a new content-bound ID.
 const facts = { sourceId: source.id, kind: 'original', amountMicros: centsToMicros(b.fee), provider: 'stripe', platform_account_id: source.platform_account_id, livemode: source.livemode, currency: 'usd', complete: true, final: true, evidence_ref: `stripe:${source.platform_account_id}:${source.livemode}:${b.id}`, contract_ref:contract.id,completeness_evidence_ref:contract.evidence_ref,charge_id: charge.id, balance_transaction_id: b.id, components };
 return Object.freeze({ ...facts, id: `cost_${digest(facts)}`, observed_at: observedAt });
}
function validateRefundCostContract({ source, context, contract, now = Date.now() }) {
 assertCostContext(source, context);
 if (!contract || contract.provider !== 'stripe' || !contract.id || contract.sourceId !== source.id || contract.platform_account_id !== source.platform_account_id || contract.livemode !== source.livemode || contract.currency !== 'usd' || contract.approved !== true || contract.complete !== true || contract.final !== true || contract.tariff || !validInt(contract.amountMicros) || typeof contract.evidence_ref !== 'string' || !contract.evidence_ref || !Number.isSafeInteger(contract.valid_from) || !Number.isSafeInteger(contract.valid_until) || now < contract.valid_from || now >= contract.valid_until) throw unavailable('An exact approved source/account refund-cost contract is required');
 const facts = {sourceId:source.id,kind:'incremental',amountMicros:contract.amountMicros,provider:'stripe',platform_account_id:source.platform_account_id,livemode:source.livemode,currency:'usd',complete:true,final:true,evidence_ref:contract.evidence_ref,contract_ref:contract.id};
 return Object.freeze({...facts,id:`cost_${digest(facts)}`,observed_at:now,valid_until:contract.valid_until});
}
async function collectChargeCost({ registry, context, source, contract, clock = Date.now }) {
 assertCostContext(source, context);
 const client = registry.assertVerifiedContext(context);
 const charge = await client.charges.retrieve(source.charge_id, { expand: ['balance_transaction'] });
 if (registry.assertVerifiedContext(context) !== client) throw unavailable('Provider context changed');
 return validateChargeCost({ source, context, charge, contract, observedAt: clock() });
}
module.exports = { collectChargeCost, validateChargeCost, validateRefundCostContract, validateOriginalCostContract, centsToMicros };
