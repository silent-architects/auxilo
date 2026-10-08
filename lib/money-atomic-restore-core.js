'use strict';
// Pure restore receipt/schema/geometry helpers. They grant no write authority.
const crypto=require('node:crypto');
function fail(code){throw Object.assign(new Error(code),{code});}
function canonical(v){if(Array.isArray(v))return '['+v.map(canonical).join(',')+']';if(v&&typeof v==='object')return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';return JSON.stringify(v);}
const digest=v=>crypto.createHash('sha256').update(canonical(v)).digest('hex');
const hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const keys=['schema','protocol','restoreId','planDigest','checkpointDigest','barrierDigest','previousBindingDigest','allowanceDigest','allowanceBoundBytes','consumedBytes','rolePlanDigest','priorRevision','finalRevision'];
function uint(v){return Number.isSafeInteger(v)&&v>=0;}
function safe(v){if(v<0n||v>BigInt(Number.MAX_SAFE_INTEGER))fail('ATOMIC_RESTORE_BOUND_INVALID');return Number(v);}
function encodeRestoreBytes(v){if(!uint(v)||v%4096)fail('ATOMIC_RESTORE_BINDING_INVALID');return String(v).padStart(20,'0');}
function decodeRestoreBytes(v){if(typeof v!=='string'||!/^\d{20}$/.test(v))fail('ATOMIC_RESTORE_BINDING_INVALID');const b=BigInt(v);if(b>BigInt(Number.MAX_SAFE_INTEGER)||b%4096n)fail('ATOMIC_RESTORE_BINDING_INVALID');return Number(b);}
function validateRestoreBinding(value){
 const invalid=()=>fail('ATOMIC_RESTORE_BINDING_INVALID');
 if(!value||Object.getPrototypeOf(value)!==Object.prototype)invalid();const ds=Object.getOwnPropertyDescriptors(value),actual=Reflect.ownKeys(ds);
 if(actual.length!==keys.length||actual.some(k=>typeof k!=='string'||!keys.includes(k)||!ds[k].enumerable||!Object.hasOwn(ds[k],'value')))invalid();
 if(value.schema!==1||value.protocol!=='atomic_restore_v1'||keys.filter(k=>k.endsWith('Digest')||k==='restoreId').some(k=>!hex(value[k]))||!uint(value.priorRevision)||!uint(value.finalRevision)||value.priorRevision===Number.MAX_SAFE_INTEGER||value.finalRevision!==value.priorRevision+1)invalid();
 const bound=decodeRestoreBytes(value.allowanceBoundBytes),consumed=decodeRestoreBytes(value.consumedBytes);if(!bound||consumed>bound||Buffer.byteLength(JSON.stringify(value))>2048)invalid();return value;
}
function rootEconomicProjection(root){const {completion,publication,publicationControl,restoreBinding,restoreGeneration,...economic}=structuredClone(root);return economic;}
function metadataIdentityProjection(metadata){const {revision,sequence,...identity}=structuredClone(metadata);return identity;}
function geometry(workspace,m){
 const W=workspace.workspaceRetainedBytes,A=m.workspaceAllocatedBytes,P=m.pageSize,Fpages=m.freelistCount;
 if(![W,A,P,Fpages].every(uint)||P!==4096||A>W)fail('ATOMIC_RESTORE_LAYOUT_INVALID');
 const F=Number(BigInt(W-A)<BigInt(Fpages)*BigInt(P)?BigInt(W-A):BigInt(Fpages)*BigInt(P));return{A,F,P:W-A-F,R:workspace.workspaceScratchBytes};
}
function requiredRestoreBytes(plan,metrics,workspace){
 if(!uint(plan.priorMetrics.pageCount)||!uint(metrics.pageCount)||metrics.pageCount<plan.priorMetrics.pageCount||!uint(plan.priorGeometry.P)||!uint(plan.retainedNonDatabaseOutputBytes))fail('ATOMIC_RESTORE_BOUND_INVALID');
 const g=geometry(workspace,metrics),growth=BigInt(metrics.pageCount-plan.priorMetrics.pageCount)*4096n,delta=growth+BigInt(g.P)-BigInt(plan.priorGeometry.P);
 return{requiredBytes:safe(((delta>0n?delta:0n)+BigInt(plan.retainedNonDatabaseOutputBytes)+4095n)/4096n*4096n),growthBytes:safe(growth),paddingAfterBytes:g.P,geometry:g};
}
function bindingFor(plan,consumedBytes){return validateRestoreBinding({schema:1,protocol:'atomic_restore_v1',restoreId:plan.restoreId,planDigest:plan.planDigest,checkpointDigest:plan.checkpointDigest,barrierDigest:plan.barrierDigest,previousBindingDigest:plan.previousBindingDigest,allowanceDigest:plan.allowanceDigest,allowanceBoundBytes:encodeRestoreBytes(plan.allowanceBoundBytes),consumedBytes:encodeRestoreBytes(consumedBytes),rolePlanDigest:plan.rolePlanDigest,priorRevision:plan.priorRevision,finalRevision:plan.priorRevision+1});}
function rootSuccessor(prior,plan,consumedBytes){
 const generation=Object.hasOwn(prior,'restoreGeneration')?prior.restoreGeneration:0;
 if(!uint(generation)||!uint(generation+1))fail('ATOMIC_RESTORE_GENERATION_OVERFLOW');
 const next=structuredClone(prior);for(const key of ['completion','publication','publicationControl']){const role=plan.roles[key];next[key]={dev:role.dev,ino:role.ino,bytes:role.bytes,allocatedBytes:role.allocatedBytes};}
 next.restoreGeneration=generation+1;next.restoreBinding=bindingFor(plan,consumedBytes);return next;
}
function receiptFor(plan,nextRoot){const receipt={schema:1,protocol:'atomic_restore_v1',restoreId:plan.restoreId,planDigest:plan.planDigest,priorRootDigest:plan.priorRootDigest,nextRootDigest:digest(nextRoot),revision:plan.priorRevision+1,bindingDigest:digest(nextRoot.restoreBinding)};return{receipt,receiptDigest:digest(receipt)};}
module.exports={validateRestoreBinding,encodeRestoreBytes,decodeRestoreBytes,rootEconomicProjection,metadataIdentityProjection,geometry,requiredRestoreBytes,bindingFor,rootSuccessor,receiptFor,digest,hex,uint};
