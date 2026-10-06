 'use strict';
// Immutable attested ownership. No active-platform inference and no startup initialization.
const fs=require('fs');const path=require('path');const {readJSONStrict,writeJSONAtomic,digestJSON,canonicalJSON,plainObject}=require('./stripe-transfer-persistence');
const PLATFORMS=Object.freeze({legacy:'acct_1TCbMe0Jj0R41QQV',auxilo_llc:'acct_1UMsxYLVAUzbAOHI'});
function originsFile(){return process.env.AUXILO_STRIPE_OBJECT_ORIGINS_FILE||path.join(process.env.AUXILO_DATA_DIR||path.join(__dirname,'..','data'),'stripe-object-origins.json');}
function validateContext(c){if(!c||!PLATFORMS[c.stripe_platform]||PLATFORMS[c.stripe_platform]!==c.stripe_platform_account_id)throw Error('Invalid immutable Stripe platform identity');return c;}
function validateManifestRef(r){if(!r||!r.checkpoint_id||!/^[a-f0-9]{64}$/.test(r.manifest_sha256)||r.inventory_complete!==true||!r.approval_ref)throw Error('Complete approved manifest reference required');return r;}
function validateOrigin(r){validateContext(r);for(const k of['object_kind','provider_id','account_id','evidence_ref','first_observed_at'])if(typeof r[k]!=='string'||!r[k])throw Error('Missing origin '+k);if(r.provenance_version!==1||!Number.isFinite(Date.parse(r.first_observed_at)))throw Error('Invalid origin revision or timestamp');return r;}
function key(r){return JSON.stringify([r.stripe_platform,r.object_kind,r.provider_id]);}
function seal(value){return {...value,checksum:digestJSON(value)};}
function read(file){const s=readJSONStrict(file);const {checksum,...body}=s;if(checksum!==digestJSON(body)||s.schema_version!==1||!Array.isArray(s.records))throw Error('Corrupt Stripe origin store');validateManifestRef(s.manifest);const seen=new Set();for(const r of s.records){validateOrigin(r);if(seen.has(key(r)))throw Error('Duplicate Stripe origin');seen.add(key(r));}return s;}
function initializeOrigins(file,manifestRef){validateManifestRef(manifestRef);if(fs.existsSync(file))throw Error('Origin store already exists');writeJSONAtomic(file,seal({schema_version:1,manifest:manifestRef,records:[]}));return createOriginStore({file});}
function createOriginStore({file=originsFile()}={}){return{all(){return read(file).records;},find(context,kind,id){validateContext(context);return read(file).records.find(r=>r.stripe_platform===context.stripe_platform&&r.stripe_platform_account_id===context.stripe_platform_account_id&&r.object_kind===kind&&r.provider_id===id)||null;},record(record){validateOrigin(record);const s=read(file);const previous=s.records.find(r=>key(r)===key(record));if(previous){if(canonicalJSON(previous)!==canonicalJSON(record))throw Error('Conflicting immutable origin');return previous;}const{checksum,...body}=s;body.records.push(JSON.parse(canonicalJSON(record)));writeJSONAtomic(file,seal(body));return record;}};}
function findOrigin(c,k,id){return createOriginStore().find(c,k,id);}
function resolveOrigin(kind,id,accountId){const rows=createOriginStore().all().filter(r=>r.object_kind===kind&&r.provider_id===id&&(!accountId||r.account_id===accountId));return rows.length===1?rows[0]:null;}
function recordOrigin(r){return createOriginStore().record(r);}
module.exports={initializeOrigins,createOriginStore,findOrigin,resolveOrigin,recordOrigin,originsFile,validateContext,validateOrigin,validateManifestRef,PLATFORMS};
