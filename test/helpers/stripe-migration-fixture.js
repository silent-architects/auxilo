'use strict';
// Positive synthetic provenance for pre-migration economic regression fixtures.
// Never used by production, and never reaches a Stripe API.
const fs=require('fs'),path=require('path');
const {initializeOrigins,createOriginStore}=require('../../lib/stripe-object-origins');
const {initializeEventReceipts}=require('../../lib/stripe-event-receipts');
const {initializeCheckoutIntents}=require('../../lib/stripe-checkout-intents');
const context={stripe_platform:'legacy',stripe_platform_account_id:'acct_1TCbMe0Jj0R41QQV',livemode:false};
const ref={checkpoint_id:'synthetic-economic-regression',manifest_sha256:'e'.repeat(64),inventory_complete:true,approval_ref:'synthetic-only'};
function attest(dir,kind,id,owner){const origins=createOriginStore({file:path.join(dir,'stripe-object-origins.json')});if(!origins.find(context,kind,id))origins.record({...context,object_kind:kind,provider_id:id,account_id:owner,evidence_ref:'synthetic-fixture',first_observed_at:'2026-10-05T00:00:00Z',provenance_version:1});}
function initialize(dir){initializeOrigins(path.join(dir,'stripe-object-origins.json'),ref);initializeEventReceipts(path.join(dir,'stripe-event-receipts.json'),ref);initializeCheckoutIntents(path.join(dir,'stripe-checkout-intents.json'),ref);fs.writeFileSync(path.join(dir,'purchases.jsonl'),'');const credits=JSON.parse(fs.readFileSync(path.join(dir,'credits.json')));for(const [owner,record]of Object.entries(credits))for(const lot of record.dollar_lots||[])if(lot.stripe_payment_intent)attest(dir,'payment_intent',lot.stripe_payment_intent,owner);}
function prepareEvent(dir,event){event.livemode=false;const o=event.data.object;o.id||=(event.type.startsWith('charge.dispute')?'du_':'ch_')+o.payment_intent;o.livemode=false;
if(event.type==='checkout.session.completed'){o.object='checkout.session';o.mode='payment';o.payment_status='paid';o.currency='usd';const pack=require('../../lib/stripe').PACKS[o.metadata.pack_id];o.amount_total=pack.price_cents;attest(dir,'checkout_session',o.id,o.metadata.account_id);}return event;}
module.exports={initialize,prepareEvent};
