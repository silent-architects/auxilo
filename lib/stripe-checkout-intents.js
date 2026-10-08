'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { plainObject, digestJSON, readJSONStrict, writeJSONAtomic } = require('./stripe-transfer-persistence');
const PLATFORMS = { legacy: 'acct_1TCbMe0Jj0R41QQV', auxilo_llc: 'acct_1UMsxYLVAUzbAOHI' };
const clone = value => JSON.parse(JSON.stringify(value));
function fault(message = 'CHECKOUT_RECONCILIATION_REQUIRED') { const error = new Error(message); error.code = message; return error; }
function validateManifest(ref) {
    if (!plainObject(ref) || !ref.checkpoint_id || !ref.approval_ref || ref.inventory_complete !== true || !/^[a-f0-9]{64}$/.test(ref.manifest_sha256 || '')) throw fault('MIGRATION_INVENTORY_REQUIRED');
    if (ref.scope !== undefined && (ref.scope !== 'prospective_epoch' || ref.inventory_scope !== 'fresh_epoch_only' || !/^[a-zA-Z0-9_-]{1,64}$/.test(ref.epoch_id || '') || !/^[a-f0-9]{64}$/.test(ref.binding_digest || '') || ref.manifest_sha256 !== ref.binding_digest || !ref.interval_evidence_ref || ref.platform !== 'auxilo_llc' || ref.platform_account_id !== PLATFORMS.auxilo_llc || typeof ref.livemode !== 'boolean')) throw fault('EPOCH_MANIFEST_REQUIRED');
    if(ref.lifecycle_successor!==undefined){
        const x=ref.lifecycle_successor,hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
        const exact=(v,keys)=>plainObject(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
        const bad=()=>{throw fault('EPOCH_LIFECYCLE_SUCCESSOR_INVALID');};
        if(ref.scope!=='prospective_epoch'||!exact(x,['schema_version','binding_digest','prior_participant_checksum','source_created_through','seal','conserved_totals','receipt_digest'])||x.schema_version!==1||x.binding_digest!==ref.binding_digest||!hex(x.prior_participant_checksum)||typeof x.source_created_through!=='string'||!Number.isFinite(Date.parse(x.source_created_through)))bad();
        const micros=['source_amount','spent','retired','cost','cost_covered','cost_recovered','platform_share','reversed','recovered','backing','obligation','subsidy'].map(k=>k+'_micros'),totals=x.conserved_totals;
        if(!exact(totals,['currency','period','count','nonspendable',...micros])||totals.currency!=='usd'||!/^\d{4}(?:-Q[1-4])?$/.test(totals.period)||totals.nonspendable!==true||!Number.isSafeInteger(totals.count)||totals.count<5||micros.some(k=>!Number.isSafeInteger(totals[k])||totals[k]<0))bad();
        const seal=x.seal;
        if(!exact(seal,['namespace','source_created_through','closed_epoch','aggregate_checkpoint_hash','rule_version'])||typeof seal.namespace!=='string'||!seal.namespace||!Number.isSafeInteger(seal.closed_epoch)||seal.closed_epoch<1||typeof seal.rule_version!=='string'||!seal.rule_version||seal.source_created_through!==x.source_created_through||seal.aggregate_checkpoint_hash!==digestJSON(totals))bad();
        const {receipt_digest,...body}=x;if(!hex(receipt_digest)||receipt_digest!==digestJSON(body))bad();
    }
}
function runtimeStorePath(participant, file, legacyPath, envOverride) {
    const epochs=require('./financial-epoch'),epoch=epochs.getRuntimeEpoch();
    if(!epoch)return file||envOverride||legacyPath;
    const expected=epochs.pathFor(participant,epoch);
    if((file&&path.resolve(file)!==expected)||(envOverride&&path.resolve(envOverride)!==expected))throw fault('EPOCH_ENV_OVERRIDE_CONFLICT');
    return expected;
}
function assertStoreWrite(file,participant,manifest) {
    const epochs=require('./financial-epoch'),epoch=epochs.getRuntimeEpoch();
    if(!epoch){if(manifest?.scope==='prospective_epoch')throw fault('EPOCH_RUNTIME_REQUIRED');return;}
    if(path.resolve(file)!==epochs.pathFor(participant,epoch)||manifest?.scope!=='prospective_epoch'||manifest.epoch_id!==epoch.epoch_id||manifest.binding_digest!==epoch.binding_digest)throw fault('EPOCH_STORE_BINDING_CONFLICT');
    const ctx=require('./money-control').assertMoneyContext({epoch});epochs.assertEpochWritePath(file,ctx.writer);
}
function validateEpochRow(row,manifest){
    if(manifest?.scope!=='prospective_epoch'){if(row.epoch_id||row.binding_digest)throw fault('EPOCH_MANIFEST_REQUIRED');return;}
    if(row.epoch_id!==manifest.epoch_id||row.binding_digest!==manifest.binding_digest||row.stripe_platform!==manifest.platform||row.stripe_platform_account_id!==manifest.platform_account_id||row.livemode!==manifest.livemode)throw fault('EPOCH_STORE_BINDING_CONFLICT');
}
function seal(value) { const next = clone(value); delete next.checksum; next.checksum = digestJSON(next); return next; }
function validateContext(row) {
    if (!plainObject(row) || PLATFORMS[row.stripe_platform] !== row.stripe_platform_account_id || typeof row.livemode !== 'boolean') throw fault('INVALID_STRIPE_CONTEXT');
}
function checkoutFingerprint(input) {
    if (typeof input.account_id !== 'string' || !input.account_id || typeof input.pack_id !== 'string' || !input.pack_id || input.currency !== 'usd' || !Number.isSafeInteger(input.amount_cents) || input.amount_cents <= 0) throw fault('INVALID_CHECKOUT_REQUEST');
    let base; try { base = new URL(input.base_url); } catch { throw fault('INVALID_CHECKOUT_REQUEST'); }
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) throw fault('INVALID_CHECKOUT_REQUEST');
    return digestJSON({ account_id: input.account_id, pack_id: input.pack_id, currency: input.currency, amount_cents: input.amount_cents, base_url: input.base_url, stripe_platform: input.stripe_platform, stripe_platform_account_id: input.stripe_platform_account_id, livemode: input.livemode,...(input.epoch_id?{epoch_id:input.epoch_id,binding_digest:input.binding_digest,policy_version:input.policy_version,policy_consent_id:input.policy_consent_id}:{}) });
}
const TRANSITIONS = {
    prepared: ['submitted', 'confirmed_not_created'], submitted: ['unknown', 'confirmed_open', 'paid_pending_credit', 'confirmed_expired_unpaid'],
    unknown: ['unknown', 'confirmed_open', 'paid_pending_credit', 'confirmed_expired_unpaid', 'confirmed_not_created'],
    confirmed_open: ['paid_pending_credit', 'confirmed_expired_unpaid'], paid_pending_credit: ['paid_credited'], paid_credited: [], confirmed_expired_unpaid: [], confirmed_not_created: []
};
const PATCH = new Set(['session_id', 'payment_intent_id', 'session_url', 'expires_at', 'evidence', 'cap_state_durable', 'credit_state_durable', 'purchase_id', 'last_error_code']);
function validateIntent(row) {
    validateContext(row);
    if (!TRANSITIONS[row.state] || !Number.isSafeInteger(row.generation) || row.generation < 1 || !row.intent_id || !row.idempotency_key || !Number.isFinite(Date.parse(row.prepared_at)) || row.configuration_generation === undefined || row.fingerprint !== checkoutFingerprint(row)) throw fault('INVALID_CHECKOUT_INTENT');
    if (['confirmed_open', 'paid_pending_credit', 'paid_credited', 'confirmed_expired_unpaid', 'confirmed_not_created'].includes(row.state)) {
        const e = row.evidence;
        if (!plainObject(e) || e.verified !== true || e.authoritative !== true || !e.evidence_ref || e.stripe_platform !== row.stripe_platform || e.stripe_platform_account_id !== row.stripe_platform_account_id || e.livemode !== row.livemode) throw fault('AUTHORITATIVE_CHECKOUT_EVIDENCE_REQUIRED');
        if (e.intent_id !== row.intent_id || e.account_id !== row.account_id || e.amount_cents !== row.amount_cents || e.currency !== row.currency || (row.state !== 'confirmed_not_created' && e.session_id !== row.session_id)) throw fault('CHECKOUT_EVIDENCE_BINDING_CONFLICT');
        if (row.state === 'confirmed_not_created' && (e.definitive_not_created !== true || row.cap_state_durable !== true)) throw fault('AUTHORITATIVE_CHECKOUT_EVIDENCE_REQUIRED');
        if (row.state !== 'confirmed_not_created' && !/^cs_[A-Za-z0-9_]+$/.test(row.session_id || '')) throw fault('INVALID_CHECKOUT_SESSION');
    }
    if (row.state === 'confirmed_open' && (row.cap_state_durable !== true || !Number.isFinite(row.expires_at) || !/^https:\/\//.test(row.session_url || ''))) throw fault('CHECKOUT_CAP_RECEIPT_REQUIRED');
    if (row.state === 'confirmed_expired_unpaid' && (row.evidence.expired_unpaid !== true || row.cap_state_durable !== true)) throw fault('CHECKOUT_TERMINAL_EVIDENCE_REQUIRED');
    if (row.state === 'paid_credited' && (row.credit_state_durable !== true || !row.purchase_id)) throw fault('CHECKOUT_CREDIT_RECEIPT_REQUIRED');
}
function validateState(state) {
    if (!plainObject(state) || state.schema_version !== 1 || !Number.isSafeInteger(state.generation) || state.generation < 0 || !plainObject(state.intents) || seal(state).checksum !== state.checksum) throw fault('INVALID_CHECKOUT_STORE');
    validateManifest(state.initialization_manifest);
    const sessions = new Set();
    for (const [id, row] of Object.entries(state.intents)) {
        validateIntent(row); validateEpochRow(row,state.initialization_manifest); if (id !== row.intent_id) throw fault('INVALID_CHECKOUT_STORE');
        if (row.session_id) { const key = row.stripe_platform + ':' + row.session_id; if (sessions.has(key)) throw fault('DUPLICATE_CHECKOUT_SESSION'); sessions.add(key); }
    }
    return state;
}
function buildCheckoutIntentState(manifestRef) {
    validateManifest(manifestRef);
    return validateState(seal({ schema_version: 1, generation: 0, initialization_manifest: clone(manifestRef), intents: {} }));
}
function initializeCheckoutIntents(file, manifestRef) {
    validateManifest(manifestRef); if (fs.existsSync(file)) throw fault('CHECKOUT_STORE_ALREADY_INITIALIZED');
    const state = buildCheckoutIntentState(manifestRef); writeJSONAtomic(file, state); return state;
}
// Prospective provenance shares the money transaction and its staged overlay.
function indexedEvidenceStore(options={}) {
    const money=require('./money-control'),runtime=money.getMoneyRuntime();
    const store=options.store||runtime?.store,epoch=options.epoch||runtime?.epoch;
    if(!store||store.descriptor?.schema!==2)return null;
    if(!epoch||store.epoch?.binding_digest!==epoch.binding_digest)throw fault('EPOCH_STORE_BINDING_CONFLICT');
    const current=()=>{const ctx=money.getActiveMoneyContext();return ctx&&ctx.epoch.binding_digest===epoch.binding_digest?ctx:store;};
    const context=()=>money.assertMoneyContext({epoch});
    function get(namespace,id){return current().getEvidence(namespace,id);}
    function list(namespace,options={}){return current().listEvidence({...options,namespace});}
    function put(namespace,id,payload,indexes,previous){
        if(payload.epoch_id!==epoch.epoch_id||payload.binding_digest!==epoch.binding_digest||payload.stripe_platform!==epoch.platform||payload.stripe_platform_account_id!==epoch.platform_account_id||payload.livemode!==epoch.livemode)throw fault('EPOCH_STORE_BINDING_CONFLICT');
        let checkoutIntentId=namespace==='checkout_intents'&&payload.state!=='prepared'?payload.intent_id:null;
        if(namespace==='object_origins'&&payload.evidence_ref?.startsWith('checkout-intent:')){const candidate=payload.evidence_ref.slice('checkout-intent:'.length),intent=get('checkout_intents',candidate)?.payload;if(intent&&intent.account_id===payload.account_id)checkoutIntentId=candidate;}
        let capturedSource, capturedFinancial=false;
        if(namespace==='event_receipts'){
            // The webhook capture committed before dispatch is the ownership authority.
            const captured=store.getEvidence('verified_capture',require('./stripe-history-coverage').captureIdentity(payload,payload.event_id,payload.payload_digest))?.payload;
            const strict=store.getCapacityRecord?.('capacity:root')?.profile?.grouped?.commitProtocol==='single_sql_v1';
            if(!captured){if(strict)throw fault('CAPACITY_EVENT_RECEIPT_BINDING_REQUIRED');}
            else {
                const refuse=()=>{throw fault('CAPACITY_EVENT_RECEIPT_BINDING_REQUIRED');};
                if(captured.conflict||captured.epoch_id!==epoch.epoch_id||captured.binding_digest!==epoch.binding_digest||captured.stripe_platform!==epoch.platform||captured.stripe_platform_account_id!==epoch.platform_account_id||captured.livemode!==epoch.livemode||captured.event_id!==payload.event_id||captured.event_type!==payload.event_type||captured.object_id!==payload.object_id||captured.raw_digest!==payload.payload_digest||typeof captured.raw_body!=='string'||crypto.createHash('sha256').update(captured.raw_body).digest('hex')!==captured.raw_digest)refuse();
                let event;try{event=JSON.parse(captured.raw_body);}catch{refuse();}
                const object=event.data?.object;
                if(event.id!==payload.event_id||event.type!==payload.event_type||event.livemode!==epoch.livemode||event.account||object?.id!==payload.object_id||object.livemode!==undefined&&object.livemode!==epoch.livemode)refuse();
                const candidate=object.metadata?.auxilo_checkout_intent_id,intent=candidate&&get('checkout_intents',candidate)?.payload;
                if(intent&&intent.account_id===object.metadata.account_id&&intent.amount_cents===object.amount_total&&intent.currency===object.currency&&(!intent.session_id||intent.session_id===object.id))checkoutIntentId=candidate;
                if(['refund','dispute','charge'].includes(object.object)){
                    capturedFinancial=true;
                    const id=value=>typeof value==='string'&&value?value:value&&typeof value.id==='string'&&value.id?value.id:null;
                    const chargeId=object.object==='charge'?object.id:id(object.charge),paymentIntentId=id(object.payment_intent);
                    if(object.charge!=null&&!chargeId||object.payment_intent!=null&&!paymentIntentId)refuse();
                    const scoped={platform_account_id:epoch.platform_account_id,livemode:epoch.livemode};
                    const byCharge=chargeId&&store.findSourceByProviderIdentity({...scoped,chargeId});
                    const byIntent=paymentIntentId&&store.findSourceByProviderIdentity({...scoped,paymentIntentId});
                    if(byCharge&&byIntent&&byCharge.id!==byIntent.id)refuse();
                    for(const source of [byCharge,byIntent].filter(Boolean))if(!source.id||!source.accountId||source.epoch_id!==epoch.epoch_id||source.binding_digest!==epoch.binding_digest||source.platform!==epoch.platform||source.platform_account_id!==epoch.platform_account_id||source.livemode!==epoch.livemode||chargeId&&source.charge_id&&source.charge_id!==chargeId||paymentIntentId&&source.payment_intent_id!==paymentIntentId||!((chargeId&&source.charge_id===chargeId)||(paymentIntentId&&source.payment_intent_id===paymentIntentId)))refuse();
                    capturedSource=byCharge||byIntent;
                    if(!capturedSource&&strict)refuse();
                }
            }
        }
        const providerId=payload.provider_id||payload.object_id;
        const source=capturedFinancial?capturedSource:providerId&&store.findSourceByProviderIdentity({platform_account_id:epoch.platform_account_id,livemode:epoch.livemode,chargeId:providerId,paymentIntentId:providerId});
        const operation=!capturedFinancial&&!source&&providerId&&store.findOperationByRefund({platform_account_id:epoch.platform_account_id,livemode:epoch.livemode,refundId:providerId});
        const capacity={purpose:namespace,mandatory:!!(checkoutIntentId||source||operation),rawBytes:Buffer.byteLength(JSON.stringify(payload)),...(checkoutIntentId?{checkoutIntentId}:{}),...(source?{sourceId:source.id}:{}),...(operation?{operationId:operation.id}:{})};
        return context().recordEvidence({namespace,id,payload,indexes:{...indexes,platform_account_id:epoch.platform_account_id,livemode:epoch.livemode},expectedRevision:previous?.revision??0,capacity});
    }
    return {store,epoch,get,list,put};
}
function createIndexedCheckoutStore(db){
    const ns='checkout_intents';
    const get=id=>db.get(ns,id)?.payload||null;
    const list=options=>{const page=db.list(ns,options);return {...page,items:page.items.map(r=>r.payload)};};
    function findSession(context,id){validateContext(context);const rows=list({providerId:id,platform_account_id:context.stripe_platform_account_id,livemode:context.livemode,limit:2}).items;if(rows.length>1)throw fault('DUPLICATE_CHECKOUT_SESSION');return rows[0]||null;}
    function blocking(accountId,now=Date.now()){
        for(const state of ['prepared','submitted','unknown','paid_pending_credit']){const row=list({accountId,state,limit:1}).items[0];if(row)return row;}
        let after;do{const page=list({accountId,state:'confirmed_open',after,limit:100});const row=page.items.find(r=>r.expires_at<=now);if(row)return row;after=page.nextCursor;}while(after);return null;
    }
    function findOpen(accountId,fingerprint,now=Date.now()){let after;do{const page=list({accountId,state:'confirmed_open',after,limit:100});const row=page.items.find(r=>r.fingerprint===fingerprint&&r.expires_at>now);if(row)return row;after=page.nextCursor;}while(after);return null;}
    function save(row,before){validateIntent(row);if(row.session_id){const prior=findSession(row,row.session_id);if(prior&&prior.intent_id!==row.intent_id)throw fault('DUPLICATE_CHECKOUT_SESSION');}db.put(ns,row.intent_id,row,{accountId:row.account_id,providerId:row.session_id,state:row.state},before);return clone(row);}
    function prepare(input){validateContext(input);if(blocking(input.account_id))throw fault();const id=crypto.randomUUID();const row={intent_id:id,idempotency_key:'auxilo-checkout:'+id,account_id:input.account_id,stripe_platform:input.stripe_platform,stripe_platform_account_id:input.stripe_platform_account_id,configuration_generation:input.configuration_generation,livemode:input.livemode,pack_id:input.pack_id,currency:input.currency,amount_cents:input.amount_cents,base_url:input.base_url,fingerprint:checkoutFingerprint(input),prepared_at:new Date().toISOString(),state:'prepared',generation:1,epoch_id:input.epoch_id,binding_digest:input.binding_digest,policy_version:input.policy_version,policy_consent_id:input.policy_consent_id};return save(row,null);}
    function transition(id,generation,to,patch={}){const previous=db.get(ns,id),before=previous?.payload;if(!before||before.generation!==generation||!TRANSITIONS[before.state].includes(to))throw fault('CHECKOUT_STATE_CONFLICT');for(const k of Object.keys(patch))if(!PATCH.has(k))throw fault('IMMUTABLE_CHECKOUT_FIELD');for(const k of ['session_id','payment_intent_id','purchase_id'])if(before[k]&&patch[k]&&before[k]!==patch[k])throw fault('CHECKOUT_IDENTITY_CONFLICT');if(patch.last_error_code!==undefined&&!/^[a-zA-Z0-9_:-]{1,120}$/.test(patch.last_error_code))throw fault('INVALID_OUTCOME_CODE');return save({...before,...clone(patch),state:to,generation:generation+1,updated_at:new Date().toISOString()},previous);}
    function recordPaid(context,sessionId,purchaseId){const before=findSession(context,sessionId);if(!before||!purchaseId)throw fault('UNKNOWN_CHECKOUT_ORIGIN');if(before.state==='paid_credited'){if(before.purchase_id!==purchaseId)throw fault('CHECKOUT_IDENTITY_CONFLICT');return before;}let pending=before;if(pending.state!=='paid_pending_credit')pending=transition(before.intent_id,before.generation,'paid_pending_credit',{purchase_id:purchaseId,evidence:{verified:true,authoritative:true,evidence_ref:'verified-paid:'+sessionId,intent_id:before.intent_id,account_id:before.account_id,amount_cents:before.amount_cents,currency:before.currency,session_id:sessionId,stripe_platform:context.stripe_platform,stripe_platform_account_id:context.stripe_platform_account_id,livemode:context.livemode}});return transition(pending.intent_id,pending.generation,'paid_credited',{credit_state_durable:true,purchase_id:purchaseId});}
    return {ready:true,reason:null,get,list,findSession,blocking,findOpen,prepare,transition,recordPaid,all(){throw fault('BOUNDED_PROVENANCE_QUERY_REQUIRED');}};
}
function createCheckoutIntentStore(options = {}) {
    const indexed=indexedEvidenceStore(options);if(indexed){runtimeStorePath('stripe_checkout_intents',options.file,null,process.env.AUXILO_STRIPE_CHECKOUT_INTENTS_FILE);return createIndexedCheckoutStore(indexed);}
    let {file}=options;
    file=runtimeStorePath('stripe_checkout_intents',file,path.join(process.env.AUXILO_DATA_DIR || path.join(__dirname,'..','data'),'stripe-checkout-intents.json'),process.env.AUXILO_STRIPE_CHECKOUT_INTENTS_FILE);
    let state, ready = true, reason = null;
    try { state = validateState(readJSONStrict(file)); } catch (error) { ready = false; reason = error.code === 'ENOENT' ? 'checkout_store_uninitialized' : 'checkout_store_corrupt'; }
    function requireReady() {
        if (!ready) throw fault();
        if(state.initialization_manifest.scope==='prospective_epoch')try{
            const fresh=validateState(readJSONStrict(file));
            if(fresh.initialization_manifest.binding_digest!==state.initialization_manifest.binding_digest||fresh.initialization_manifest.epoch_id!==state.initialization_manifest.epoch_id)throw fault('EPOCH_STORE_BINDING_CONFLICT');
            state=fresh;
        }catch(error){ready=false;reason='checkout_store_corrupt';throw error;}
    }
    function save(next) { requireReady(); assertStoreWrite(file,'stripe_checkout_intents',state.initialization_manifest); const sealed = seal(next); validateState(sealed); try { writeJSONAtomic(file, sealed); } catch (error) { ready = false; reason = 'financial_storage_failure'; throw error; } state = sealed; }
    function all() { if(ready||state?.initialization_manifest.scope==='prospective_epoch')requireReady();return state ? Object.values(state.intents).map(clone) : []; }
    function get(id) { if(ready||state?.initialization_manifest.scope==='prospective_epoch')requireReady();return state && state.intents[id] ? clone(state.intents[id]) : null; }
    function blocking(accountId, nowMs = Date.now()) { requireReady(); return all().find(row => row.account_id === accountId && (['prepared', 'submitted', 'unknown', 'paid_pending_credit'].includes(row.state) || (row.state === 'confirmed_open' && row.expires_at <= nowMs))) || null; }
    function findOpen(accountId, fingerprint, nowMs = Date.now()) { requireReady(); return all().find(row => row.account_id === accountId && row.fingerprint === fingerprint && row.state === 'confirmed_open' && row.expires_at > nowMs) || null; }
    function prepare(input) {
        requireReady(); validateContext(input); if (blocking(input.account_id)) throw fault();
        const id = crypto.randomUUID();
        const row = { intent_id: id, idempotency_key: 'auxilo-checkout:' + id, account_id: input.account_id, stripe_platform: input.stripe_platform, stripe_platform_account_id: input.stripe_platform_account_id, configuration_generation: input.configuration_generation, livemode: input.livemode, pack_id: input.pack_id, currency: input.currency, amount_cents: input.amount_cents, base_url: input.base_url, fingerprint: checkoutFingerprint(input), prepared_at: new Date().toISOString(), state: 'prepared', generation: 1,...(input.epoch_id?{epoch_id:input.epoch_id,binding_digest:input.binding_digest,policy_version:input.policy_version,policy_consent_id:input.policy_consent_id}:{}) };
        validateIntent(row); const next = clone(state); next.generation++; next.intents[id] = row; save(next); return clone(row);
    }
    function transition(id, generation, to, patch = {}) {
        requireReady(); const before = get(id);
        if (!before || before.generation !== generation || !TRANSITIONS[before.state].includes(to)) throw fault('CHECKOUT_STATE_CONFLICT');
        for (const key of Object.keys(patch)) if (!PATCH.has(key)) throw fault('IMMUTABLE_CHECKOUT_FIELD');
        for (const key of ['session_id', 'payment_intent_id', 'purchase_id']) if (before[key] && patch[key] && before[key] !== patch[key]) throw fault('CHECKOUT_IDENTITY_CONFLICT');
        if (patch.last_error_code !== undefined && !/^[a-zA-Z0-9_:-]{1,120}$/.test(patch.last_error_code)) throw fault('INVALID_OUTCOME_CODE');
        const row = { ...before, ...clone(patch), state: to, generation: generation + 1, updated_at: new Date().toISOString() };
        validateIntent(row); const next = clone(state); next.generation++; next.intents[id] = row; save(next); return clone(row);
    }
    function recordPaid(context, sessionId, purchaseId) {
        requireReady(); validateContext(context);
        const before = all().find(row => row.stripe_platform === context.stripe_platform && row.stripe_platform_account_id === context.stripe_platform_account_id && row.livemode === context.livemode && row.session_id === sessionId);
        if (!before || !purchaseId) throw fault('UNKNOWN_CHECKOUT_ORIGIN');
        if (before.state === 'paid_credited') { if (before.purchase_id !== purchaseId) throw fault('CHECKOUT_IDENTITY_CONFLICT'); return before; }
        let pending = before;
        if (pending.state !== 'paid_pending_credit') pending = transition(before.intent_id, before.generation, 'paid_pending_credit', { purchase_id: purchaseId, evidence: { verified: true, authoritative: true, evidence_ref: 'verified-paid:' + sessionId, intent_id: before.intent_id, account_id: before.account_id, amount_cents: before.amount_cents, currency: before.currency, session_id: sessionId, stripe_platform: context.stripe_platform, stripe_platform_account_id: context.stripe_platform_account_id, livemode: context.livemode } });
        return transition(pending.intent_id, pending.generation, 'paid_credited', { credit_state_durable: true, purchase_id: purchaseId });
    }
    return { get ready() { return ready; }, get reason() { return reason; }, all, get, findSession:(context,id)=>all().find(r=>r.stripe_platform_account_id===context.stripe_platform_account_id&&r.livemode===context.livemode&&r.session_id===id)||null, blocking, findOpen, prepare, transition, recordPaid };
}
module.exports = { indexedEvidenceStore, buildCheckoutIntentState, validateCheckoutIntentState: validateState, initializeCheckoutIntents, createCheckoutIntentStore, checkoutFingerprint, validateManifest, validateContext, seal, PLATFORMS,runtimeStorePath,assertStoreWrite,validateEpochRow };
