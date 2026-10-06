'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { plainObject, digestJSON, readJSONStrict, writeJSONAtomic, markerFor, receiptMatchesAttempt } = require('./stripe-transfer-persistence');
const TERMINAL = new Set(['completed', 'confirmed_not_sent']);
const STATES = new Set(['prepared', 'submitted', 'unknown', 'confirmed', 'ledger_applied', ...TERMINAL]);
const TRANSITIONS = { prepared: ['submitted','confirmed_not_sent'], submitted: ['unknown','confirmed'], unknown: ['unknown','confirmed','confirmed_not_sent'], confirmed: ['confirmed','ledger_applied'], ledger_applied: ['completed'], completed: [], confirmed_not_sent: [] };
const IMMUTABLE = ['attempt_id','withdrawal_id','account_id','earnings_key_at_creation','wallet_at_creation','client_request_key','idempotency_key','stripe_platform','stripe_platform_account_id','configuration_generation','stripe_connect_id','amount_usd','gross_amount_usd','amount_cents','net_amount_usd','net_amount_cents','fee_usd','stripe_fee_cents','currency','livemode','request_digest','prepared_at','historical','origin'];
const MUTABLE = new Set(['submitted_at','stripe_transfer_id','provider_evidence','receipt_digest','receipt_record','receipt','last_error_code','reconciliation_reason','resolution_history','not_sent_evidence']);
const clone = value => JSON.parse(JSON.stringify(value));
function fault(code) { const error = new Error(code); error.code = code; return error; }
function normalizeRequestKey(key) { if (typeof key !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(key)) throw fault('WITHDRAWAL_REQUEST_ID_REQUIRED'); return key.toLowerCase(); }
function requestDigest(amount) { if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) throw fault('INVALID_WITHDRAWAL_AMOUNT'); return digestJSON({ route: '/withdraw/stripe', contract_version: 2, amount_usd: amount }); }
function requestIndex(account, key) { return digestJSON([account, normalizeRequestKey(key)]); }
function immutableDigest(a) { return digestJSON(Object.fromEntries(IMMUTABLE.filter(k => a[k] !== undefined).map(k => [k,a[k]]))); }
function validateManifest(ref) {
    if (!plainObject(ref) || !/^[a-f0-9]{64}$/.test(ref.sha256 || '') || ref.inventory_complete !== true || ref.positive_history_attestation !== true || !ref.history_interval || !ref.history_interval.start || !ref.history_interval.end || !Array.isArray(ref.platforms)) throw fault('Invalid initialized inventory manifest');
    if (new Date(ref.history_interval.start).getTime() > new Date(ref.history_interval.end).getTime() || !Number.isFinite(new Date(ref.history_interval.start).getTime()) || !Number.isFinite(new Date(ref.history_interval.end).getTime())) throw fault('Invalid inventory history interval');
    const aliases = new Set(), ids = new Set();
    for (const p of ref.platforms) {
        if (!['legacy','auxilo_llc'].includes(p.stripe_platform) || !/^acct_[A-Za-z0-9_]+$/.test(p.stripe_platform_account_id || '') || typeof p.livemode !== 'boolean' || aliases.has(p.stripe_platform) || ids.has(p.stripe_platform_account_id)) throw fault('Invalid inventory platform');
        aliases.add(p.stripe_platform); ids.add(p.stripe_platform_account_id);
    }
    if (aliases.size !== 2) throw fault('Incomplete platform inventory');
    if (ref.resolved_legacy_wal !== undefined) {
        if (!Array.isArray(ref.resolved_legacy_wal)) throw fault('Invalid resolved legacy WAL inventory');
        const seen = new Set();
        for (const row of ref.resolved_legacy_wal) {
            if (!plainObject(row) || typeof row.id !== 'string' || !row.id || seen.has(row.id) || !/^[a-f0-9]{64}$/.test(row.sha256 || '') || !/^[a-f0-9]{64}$/.test(row.receipt_digest || '') || typeof row.evidence_ref !== 'string' || !row.evidence_ref) throw fault('Invalid resolved legacy WAL disposition');
            seen.add(row.id);
        }
    }
}
function validateEvidence(a, e) {
    const fields = { amount_cents:a.net_amount_cents,currency:a.currency,destination:a.stripe_connect_id,livemode:a.livemode,stripe_platform:a.stripe_platform,stripe_platform_account_id:a.stripe_platform_account_id,configuration_generation:a.configuration_generation,attempt_id:a.attempt_id,request_digest:a.request_digest };
    if (!plainObject(e) || typeof e.stripe_transfer_id !== 'string' || !/^tr_[A-Za-z0-9_]+$/.test(e.stripe_transfer_id) || typeof e.evidence_ref !== 'string' || !e.evidence_ref || Object.entries(fields).some(([k,v]) => e[k] !== v)) throw fault('Invalid confirmed provider evidence');
    if (a.stripe_transfer_id !== e.stripe_transfer_id) throw fault('Transfer evidence ID mismatch');
}
function validateAttempt(a) {
    if (!plainObject(a) || !STATES.has(a.state) || !Number.isSafeInteger(a.generation) || a.generation < 1 || typeof a.attempt_id !== 'string' || !a.attempt_id || a.immutable_digest !== immutableDigest(a)) throw fault('Invalid attempt schema or immutable checksum');
    if (a.historical) {
        if (a.state !== 'unknown' || !plainObject(a.origin) || !a.origin.sha256 || a.sendable !== false) throw fault('Invalid non-sendable historical attempt');
        return;
    }
    normalizeRequestKey(a.attempt_id); normalizeRequestKey(a.client_request_key);
    for (const key of ['account_id','earnings_key_at_creation','idempotency_key','withdrawal_id','stripe_connect_id']) if (typeof a[key] !== 'string' || !a[key]) throw fault('Invalid immutable attempt field');
    if (!['legacy','auxilo_llc'].includes(a.stripe_platform) || typeof a.stripe_platform_account_id !== 'string' || !a.stripe_platform_account_id || typeof a.livemode !== 'boolean' || a.configuration_generation === undefined || a.configuration_generation === null || a.currency !== 'usd' || a.request_digest !== requestDigest(a.amount_usd)) throw fault('Invalid immutable attempt context');
    if (!Number.isSafeInteger(a.net_amount_cents) || a.net_amount_cents <= 0 || a.amount_cents !== Math.round(a.amount_usd * 100) || a.net_amount_cents > a.amount_cents || a.stripe_fee_cents !== a.amount_cents-a.net_amount_cents || a.fee_usd !== a.stripe_fee_cents/100 || a.net_amount_usd !== a.net_amount_cents/100 || a.gross_amount_usd !== a.amount_usd) throw fault('Invalid immutable attempt amounts');
    if (!Number.isFinite(Date.parse(a.prepared_at)) || (a.submitted_at !== undefined && !Number.isFinite(Date.parse(a.submitted_at)))) throw fault('Invalid attempt time');
    if (['submitted','unknown','confirmed','ledger_applied','completed'].includes(a.state) && !a.submitted_at) throw fault('Missing submitted timestamp');
    if (['confirmed','ledger_applied','completed'].includes(a.state)) validateEvidence(a,a.provider_evidence);
    if (a.receipt_record !== undefined && (!receiptMatchesAttempt(a.receipt_record,a) || a.receipt_digest !== digestJSON(a.receipt_record))) throw fault('Invalid stored receipt digest');
    if (['ledger_applied','completed'].includes(a.state) && (!a.receipt_record || !plainObject(a.receipt))) throw fault('Missing original completion receipt');
    if (a.state === 'confirmed_not_sent' && (!plainObject(a.not_sent_evidence) || a.not_sent_evidence.attempt_id !== a.attempt_id || a.not_sent_evidence.request_digest !== a.request_digest || a.not_sent_evidence.reviewed !== true || a.not_sent_evidence.authoritative !== true || a.stripe_transfer_id || a.provider_evidence || a.receipt_record)) throw fault('Invalid authoritative not-sent evidence');
}
function seal(value) { const next=clone(value); delete next.checksum; next.checksum=digestJSON(next); return next; }
function validateState(state) {
    if (!plainObject(state) || state.schema_version !== 1 || !Number.isSafeInteger(state.generation) || state.generation < 0 || !plainObject(state.attempts) || !plainObject(state.request_index) || !plainObject(state.owner_generations)) throw fault('Invalid attempt-store schema');
    const value=clone(state);delete value.checksum;if(state.checksum!==digestJSON(value))throw fault('Attempt-store checksum mismatch');
    validateManifest(state.initialization_manifest);
    const index={},owners={};
    for(const [id,a] of Object.entries(state.attempts)) {
        validateAttempt(a);if(id!==a.attempt_id)throw fault('Attempt ID mismatch');
        if(a.client_request_key&&a.account_id){const key=requestIndex(a.account_id,a.client_request_key);if(index[key])throw fault('Duplicate request binding');index[key]=id;}
        if(a.account_id)owners[a.account_id]=(owners[a.account_id]||0)+a.generation;
    }
    if(digestJSON(index)!==digestJSON(state.request_index)||digestJSON(owners)!==digestJSON(state.owner_generations))throw fault('Attempt index/generation mismatch');
    return state;
}
function initializeAttemptStore(file, manifestRef) {
    validateManifest(manifestRef);
    if(fs.existsSync(file))throw fault('Attempt store already initialized');
    const state=seal({schema_version:1,generation:0,initialization_manifest:clone(manifestRef),attempts:{},request_index:{},owner_generations:{}});
    writeJSONAtomic(file,state);return clone(state);
}
function publicStatus(a) {
    if(!a)return null;
    return {attempt_id:a.attempt_id,status:a.state,client_request_key:a.client_request_key||null,request_id:a.client_request_key||null,amount_usd:a.amount_usd,status_url:'/account/stripe-transfer-attempts/'+a.attempt_id,...(a.state==='completed'?{receipt:clone(a.receipt)}:{})};
}
function createAttemptStore({file=process.env.AUXILO_STRIPE_TRANSFER_ATTEMPTS_FILE||path.join(process.env.AUXILO_DATA_DIR||path.join(__dirname,'..','data'),'stripe-transfer-attempts.json'),onFatalStorage}={}) {
    let state=null,ready=true,reason=null,loadError=null,cachedAccounts={},cachedEarnings={};
    try{state=validateState(readJSONStrict(file));}catch(error){ready=false;reason=error.code==='ENOENT'?'attempt_store_uninitialized':'attempt_store_corrupt';loadError=error;}
    function latch(why){ready=false;reason=why;}
    function requireReady(){if(!ready||!state)throw fault('WITHDRAWAL_RECONCILIATION_REQUIRED');}
    function save(next){requireReady();const sealed=seal(next);validateState(sealed);try{writeJSONAtomic(file,sealed);}catch(error){latch('financial_storage_failure');if(onFatalStorage)onFatalStorage(error);throw error;}state=sealed;}
    function all(){return state?Object.values(state.attempts).map(clone):[];}
    function get(id,owner){const a=state&&state.attempts[id];return a&&(!owner||a.account_id===owner)?clone(a):null;}
    function current(owner){const list=all().filter(a=>a.account_id===owner);return list.find(a=>!TERMINAL.has(a.state))||list.sort((a,b)=>b.sequence-a.sequence)[0]||null;}
    function findByRequest(owner,key){if(!state)return null;return get(state.request_index[requestIndex(owner,key)]);}
    function ownerGeneration(owner){return state&&state.owner_generations[owner]||0;}
    function identities(a,accounts,earnings){const wallets=[a.wallet_at_creation,accounts[a.account_id]&&accounts[a.account_id].wallet].filter(Boolean).map(w=>w.toLowerCase());return new Set([a.account_id,a.earnings_key_at_creation,...wallets,...wallets.map(w=>earnings.__wallet_index&&earnings.__wallet_index[w])].filter(Boolean));}
    function blocking(identity={},accounts=cachedAccounts,earnings=cachedEarnings){
        const keys=new Set([identity.accountId,identity.account_id,identity.earningsKey,identity.earnings_key,identity.wallet&&identity.wallet.toLowerCase()].filter(Boolean));
        if(identity.wallet&&earnings.__wallet_index)keys.add(earnings.__wallet_index[identity.wallet.toLowerCase()]);
        for(const a of all())if(!TERMINAL.has(a.state)){
            const aliases=identities(a,accounts,earnings);
            if(identity.resolveEarningsKey&&a.account_id)aliases.add(identity.resolveEarningsKey(a.account_id));
            if(!a.account_id||!a.stripe_platform||[...keys].some(key=>aliases.has(key)))return a;
        }
        return null;
    }
    function prepare(input,{expectedOwnerGeneration}={}) {
        requireReady();const key=normalizeRequestKey(input.client_request_key);
        if(findByRequest(input.account_id,key))throw fault('WITHDRAWAL_REQUEST_BINDING_EXISTS');
        if(expectedOwnerGeneration!==undefined&&expectedOwnerGeneration!==ownerGeneration(input.account_id))throw fault('WITHDRAWAL_STATE_CHANGED');
        if(blocking({accountId:input.account_id,earningsKey:input.earnings_key_at_creation,wallet:input.wallet_at_creation}))throw fault('WITHDRAWAL_IN_FLIGHT');
        const id=crypto.randomUUID(),amountCents=Math.round(input.amount_usd*100),feeCents=amountCents-input.net_amount_cents;
        const a={attempt_id:id,withdrawal_id:'wd_'+id.replace(/-/g,'').slice(0,12),account_id:input.account_id,earnings_key_at_creation:input.earnings_key_at_creation,wallet_at_creation:input.wallet_at_creation||null,client_request_key:key,idempotency_key:'auxilo-stripe-transfer:'+id,stripe_platform:input.stripe_platform,stripe_platform_account_id:input.stripe_platform_account_id,configuration_generation:input.configuration_generation,stripe_connect_id:input.stripe_connect_id,amount_usd:input.amount_usd,gross_amount_usd:input.amount_usd,amount_cents:amountCents,net_amount_cents:input.net_amount_cents,net_amount_usd:input.net_amount_cents/100,stripe_fee_cents:feeCents,fee_usd:feeCents/100,currency:input.currency||'usd',livemode:input.livemode,request_digest:requestDigest(input.amount_usd),prepared_at:new Date().toISOString(),state:'prepared',generation:1,sequence:state.generation+1,historical:false,resolution_history:[]};
        for(const field of ['gross_amount_usd','amount_cents','net_amount_usd','stripe_fee_cents','fee_usd'])if(input[field]!==undefined&&input[field]!==a[field])throw fault('Conflicting immutable amount');
        const platform=state.initialization_manifest.platforms.find(p=>p.stripe_platform===a.stripe_platform);
        if(!platform||platform.stripe_platform_account_id!==a.stripe_platform_account_id||platform.livemode!==a.livemode)throw fault('Attempt platform differs from inventory');
        a.immutable_digest=immutableDigest(a);validateAttempt(a);
        const next=clone(state);next.generation++;next.attempts[id]=a;next.request_index[requestIndex(a.account_id,key)]=id;next.owner_generations[a.account_id]=ownerGeneration(a.account_id)+1;save(next);return clone(a);
    }
    function transition(id,generation,to,patch={}) {
        requireReady();const before=get(id);if(!before)throw fault('Unknown attempt');
        if(before.generation!==generation)throw fault('Attempt generation conflict');
        if(before.historical||!TRANSITIONS[before.state].includes(to))throw fault('Invalid attempt transition');
        for(const key of Object.keys(patch))if(!MUTABLE.has(key))throw fault('Immutable or unknown attempt field');
        if(before.receipt_digest&&patch.receipt_digest&&before.receipt_digest!==patch.receipt_digest)throw fault('Immutable receipt digest conflict');
        for(const key of ['stripe_transfer_id','provider_evidence','receipt_record','receipt'])if(before[key]!==undefined&&patch[key]!==undefined&&digestJSON(before[key])!==digestJSON(patch[key]))throw fault('Immutable evidence/receipt conflict');
        for(const key of ['last_error_code','reconciliation_reason'])if(patch[key]!==undefined&&!/^[A-Za-z0-9_:-]{1,120}$/.test(patch[key]))throw fault('Unsanitized outcome code');
        const a={...before,...clone(patch),state:to,generation:generation+1};
        if(to==='submitted'){if(before.submitted_at)throw fault('Existing attempt cannot be submitted again');a.submitted_at=new Date().toISOString();}
        a.resolution_history=[...before.resolution_history,{from:before.state,to,at:new Date().toISOString(),evidence_ref:a.provider_evidence&&a.provider_evidence.evidence_ref||null}];
        validateAttempt(a);const next=clone(state);next.generation++;next.attempts[id]=a;next.owner_generations[a.account_id]=ownerGeneration(a.account_id)+1;save(next);return clone(a);
    }
    function checkIdentities(accounts,earnings){cachedAccounts=accounts;cachedEarnings=earnings;if(!ready)return false;for(const a of all())if(!TERMINAL.has(a.state)&&(!a.account_id||!accounts[a.account_id]||!a.stripe_platform||!a.stripe_platform_account_id)){latch('unresolved_owner_or_platform');return false;}return true;}
    function importHistorical(records){
        requireReady();let imported=0;const next=clone(state);
        for(const record of records){const a=clone(record);a.historical=true;a.sendable=false;a.state='unknown';a.generation=1;a.resolution_history=[];a.sequence=next.generation+1;a.immutable_digest=immutableDigest(a);validateAttempt(a);const prior=next.attempts[a.attempt_id];if(prior){if(prior.immutable_digest!==a.immutable_digest)throw fault('Conflicting historical import');continue;}next.attempts[a.attempt_id]=a;next.generation++;if(a.account_id)next.owner_generations[a.account_id]=(next.owner_generations[a.account_id]||0)+1;imported++;}
        if(imported)save(next);return imported;
    }
    return {get ready(){return ready;},get reason(){return reason;},get loadError(){return loadError;},get manifest(){return state?clone(state.initialization_manifest):null;},get generation(){return state?state.generation:null;},all,get,current,findByRequest,ownerGeneration,prepare,transition,blocking,checkIdentities,latch,importHistorical};
}
module.exports={createAttemptStore,initializeAttemptStore,normalizeRequestKey,requestDigest,publicStatus,markerFor,validateAttempt,validateState,validateEvidence};
