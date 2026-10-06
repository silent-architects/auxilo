'use strict';
// D0 financial persistence: no backup fallback, no torn-record tolerance.
const fs=require('fs'); const path=require('path'); const crypto=require('crypto');
function plainObject(v){if(!v||Object.prototype.toString.call(v)!=='[object Object]')return false;const p=Object.getPrototypeOf(v);return p===null||Object.getPrototypeOf(p)===null;}
function canonicalJSON(v){
 if(Array.isArray(v))return '['+v.map(canonicalJSON).join(',')+']';
 if(plainObject(v))return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonicalJSON(v[k])).join(',')+'}';
 if(v===undefined||typeof v==='function'||typeof v==='symbol'||(typeof v==='number'&&!Number.isFinite(v)))throw new Error('Invalid canonical JSON value');
 return JSON.stringify(v);
}
function digestJSON(v){return crypto.createHash('sha256').update(canonicalJSON(v)).digest('hex');}
function readJSONStrict(file,{fsImpl=fs}={}){const s=fsImpl.readFileSync(file,'utf8');if(!s.trim())throw new Error('Empty financial primary');return JSON.parse(s);}
function syncDirectory(dir,{fsImpl=fs}={}){const fd=fsImpl.openSync(dir,'r');try{fsImpl.fsyncSync(fd);}finally{fsImpl.closeSync(fd);}}
function writeJSONAtomic(file,value,{fsImpl=fs}={}){
 const bytes=canonicalJSON(value)+'\n';const tmp=file+'.'+crypto.randomUUID()+'.tmp';let fd,stage='open';
 try{fd=fsImpl.openSync(tmp,'wx',0o600);stage='write';fsImpl.writeFileSync(fd,bytes);stage='fsync';fsImpl.fsyncSync(fd);fsImpl.closeSync(fd);fd=undefined;stage='rename';fsImpl.renameSync(tmp,file);stage='directory-fsync';syncDirectory(path.dirname(file),{fsImpl});}
 catch(e){if(fd!==undefined){try{fsImpl.closeSync(fd);}catch{}}e.financialStorageFailure=true;e.stage=stage;throw e;}
}
function readJSONLStrict(file,{allowMissing=false,validateDuplicateIds=true,fsImpl=fs}={}){
 let raw;try{raw=fsImpl.readFileSync(file,'utf8');}catch(e){if(allowMissing&&e.code==='ENOENT')return [];throw e;}
 if(!raw.length)return [];if(!raw.endsWith('\n'))throw new Error('Torn JSONL final line');
 const rows=raw.slice(0,-1).split('\n').map((line,i)=>{if(!line.trim())throw new Error('Empty JSONL line '+(i+1));const r=JSON.parse(line);if(!plainObject(r))throw new Error('Invalid JSONL record');return r;});
 if(validateDuplicateIds)for(const key of ['id','attempt_id']){const seen=new Map();for(const row of rows){if(row[key]===undefined)continue;if(typeof row[key]!=='string'||!row[key])throw new Error('Invalid receipt identifier');if(seen.has(row[key])&&canonicalJSON(seen.get(row[key]))!==canonicalJSON(row))throw new Error('Conflicting receipt duplicate '+key);seen.set(row[key],row);}}
 return rows;
}
function appendJSONLOnce(file,record,{key='attempt_id',fsImpl=fs}={}){
 if(!plainObject(record)||typeof record[key]!=='string'||!record[key])throw new Error('Invalid receipt record');
 const bytes=canonicalJSON(record)+'\n';const rows=readJSONLStrict(file,{allowMissing:true,fsImpl});const matches=rows.filter(r=>r[key]===record[key]||(record.id&&r.id===record.id));
 if(matches.some(r=>canonicalJSON(r)!==canonicalJSON(record)))throw new Error('Conflicting receipt duplicate');
 let fd,stage='receipt-open';try{fd=fsImpl.openSync(file,'a',0o600);if(!matches.length){stage='receipt-write';fsImpl.writeFileSync(fd,bytes);}stage='receipt-fsync';fsImpl.fsyncSync(fd);fsImpl.closeSync(fd);fd=undefined;stage='receipt-directory-fsync';syncDirectory(path.dirname(file),{fsImpl});}
 catch(e){if(fd!==undefined){try{fsImpl.closeSync(fd);}catch{}}e.financialStorageFailure=true;e.stage=stage;throw e;}
 // Re-fsync exact replays too: a previous failed fsync may leave visible bytes.
 return {appended:matches.length===0,record:JSON.parse(bytes)};
}
function normalizeMarkers(v){if(v===undefined)return [];const a=Array.isArray(v)?v:plainObject(v)?Object.keys(v):null;if(!a||a.some(x=>typeof x!=='string'||!x))throw new Error('Invalid processed-settlement marker schema');return [...new Set(a)];}
function loadEarningsPrimary(file){const x=readJSONStrict(file);if(!plainObject(x))throw new Error('Invalid earnings primary schema');for(const [k,v]of Object.entries(x)){if(!plainObject(v))throw new Error('Invalid earnings primary entry');if(k==='__wallet_index'){if(Object.values(v).some(a=>typeof a!=='string'||!a))throw new Error('Invalid earnings wallet index');}else normalizeMarkers(v.processed_settlements);}return x;}
function markerFor(a){return 'stripe-transfer-attempt:'+(typeof a==='string'?a:a.attempt_id);}
function receiptMatchesAttempt(r,a){const fields={attempt_id:a.attempt_id,request_digest:a.request_digest,account_id:a.account_id,amount_usd:a.amount_usd,amount_cents:a.amount_cents,net_amount_cents:a.net_amount_cents,net_amount_usd:a.net_amount_usd,stripe_fee_cents:a.stripe_fee_cents,stripe_transfer_id:a.stripe_transfer_id,stripe_connect_id:a.stripe_connect_id,stripe_platform:a.stripe_platform,stripe_platform_account_id:a.stripe_platform_account_id};return plainObject(r)&&r.rail==='stripe'&&Object.entries(fields).every(([k,v])=>v===undefined||r[k]===v);}
function validatePrimaryHistory({earnings,attempts=[],receipts=[],resolveKeys}={}){
 if(!plainObject(earnings)||!Array.isArray(attempts)||!Array.isArray(receipts))throw new Error('Invalid financial inventory');
 for(const a of attempts){
  if(a.historical)continue;
  const matches=Object.entries(earnings).filter(([k,v])=>k!=='__wallet_index'&&normalizeMarkers(v.processed_settlements).includes(markerFor(a)));
  const known=new Set(resolveKeys?resolveKeys(a):[a.account_id,a.earnings_key_at_creation,a.wallet_at_creation].filter(Boolean));
  if(matches.length>1||(matches.length&&!known.has(matches[0][0])))throw new Error('Conflicting earnings marker ownership');
  if(['ledger_applied','completed'].includes(a.state)&&matches.length!==1)throw new Error('Missing authoritative earnings marker');
  const rs=receipts.filter(r=>r.attempt_id===a.attempt_id||(a.withdrawal_id&&r.id===a.withdrawal_id));
  if(rs.some(r=>!receiptMatchesAttempt(r,a)||!a.receipt_digest||digestJSON(r)!==a.receipt_digest))throw new Error('Conflicting durable withdrawal receipt');
  if(a.state==='completed'&&!rs.length)throw new Error('Missing completed withdrawal receipt');
  if(a.state==='confirmed_not_sent'&&(matches.length||rs.length))throw new Error('Not-sent evidence contradicts financial marker or receipt');
 }
 return true;
}
module.exports={plainObject,canonicalJSON,digestJSON,readJSONStrict,writeJSONAtomic,syncDirectory,readJSONLStrict,appendJSONLOnce,normalizeMarkers,loadEarningsPrimary,markerFor,receiptMatchesAttempt,validatePrimaryHistory};
