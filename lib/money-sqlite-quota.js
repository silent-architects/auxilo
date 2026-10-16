'use strict';
const {fail,safe}=require('./money-database');
function uint(value,{positive=false}={}){const result=safe(value);if(!Number.isSafeInteger(result)||result<(positive?1:0))throw fail('CAPACITY_SQLITE_METRIC_INVALID');return result;}
function validateQuota(q){
 if(!q||q.schema!==1||!Number.isSafeInteger(q.maxDatabasePages)||q.maxDatabasePages<1||!Number.isSafeInteger(q.maxGrowthPages)||q.maxGrowthPages<0||!Number.isSafeInteger(q.maxNetOccupiedPages)||q.maxNetOccupiedPages<0||!Number.isSafeInteger(q.maxRollbackBytes)||q.maxRollbackBytes<=0||!/^([0-9a-f]{64})$/.test(q.rollbackProofDigest||''))throw fail('CAPACITY_SQLITE_QUOTA_REQUIRED');
 return q;
}
// This is a fail-closed quota, not a proof that an owed operation will complete.
// Scratch must already be physically released under the same write authority.
function runGuardedTransaction({db,quota,physicalProof,workspaceLimitBytes,workspaceProfile,precommit},fn){
 const q=validateQuota(quota);
 if(workspaceProfile!==undefined)require('./money-workspace-layout').validateWorkspaceProfile(workspaceProfile);
 if(!physicalProof||!Number.isSafeInteger(physicalProof.releasedScratchBytes)||physicalProof.releasedScratchBytes<0||physicalProof.releasedScratchBytes<q.maxRollbackBytes||physicalProof.rollbackProofDigest!==q.rollbackProofDigest)throw fail('CAPACITY_ROLLBACK_BACKING_REQUIRED');
 if(db.inTransaction)throw fail('MONEY_SQL_TRANSACTION_ACTIVE');
 const priorCap=uint(db.pragma('max_page_count',{simple:true}),{positive:true});
 let result;
 try{
  db.exec('BEGIN IMMEDIATE');
  const n0=uint(db.pragma('page_count',{simple:true})),f0=uint(db.pragma('freelist_count',{simple:true})),pageSize=uint(db.pragma('page_size',{simple:true}),{positive:true});
  const cap=Math.min(q.maxDatabasePages,safe(BigInt(n0)+BigInt(q.maxGrowthPages)));
  if(n0>q.maxDatabasePages||uint(db.pragma('max_page_count = '+cap,{simple:true}),{positive:true})!==cap)throw fail('CAPACITY_SQLITE_PAGE_LIMIT');
  result=fn();
  if(result?.then)throw fail('ASYNC_SQL_TRANSACTION_FORBIDDEN');
  const n1=uint(db.pragma('page_count',{simple:true})),f1=uint(db.pragma('freelist_count',{simple:true}));
  if(n1>cap||n1-n0>q.maxGrowthPages)throw fail('CAPACITY_SQLITE_PAGE_LIMIT');
  if((n1-f1)-(n0-f0)>q.maxNetOccupiedPages)throw fail('CAPACITY_SQLITE_NET_PAGE_LIMIT');
  let workspaceAllocatedBytes=0,layout;
  if(workspaceProfile!==undefined){
   const helper=require('./money-workspace-layout');layout=helper.readWorkspaceLayout(db,{layoutVersion:workspaceProfile.schema===2?2:1});
   workspaceAllocatedBytes=layout.workspaceAllocatedBytes;helper.validateWorkspacePartitions(workspaceProfile,{...layout,pageSize});
   if(workspaceAllocatedBytes>workspaceProfile.workspaceRetainedBytes)throw fail('WORKSPACE_RETAINED_LIMIT');
  }else if(workspaceLimitBytes!==undefined){
   if(!Number.isSafeInteger(workspaceLimitBytes)||workspaceLimitBytes<0)throw fail('WORKSPACE_PROFILE_REQUIRED');
   workspaceAllocatedBytes=uint(require('./money-database').workspaceTreeBytes(db,db.prepare("SELECT name FROM sqlite_schema WHERE tbl_name IN ('provider_scan_controls','provider_scan_members')").all().map(row=>row.name)));
   if(workspaceAllocatedBytes>workspaceLimitBytes)throw fail('WORKSPACE_RETAINED_LIMIT');
  }
  const checked=precommit?.({...layout,pageSize,beforePages:n0,beforeFreePages:f0,pageCount:n1,freelistCount:f1,workspaceAllocatedBytes,occupiedPageDelta:(n1-f1)-(n0-f0)});
  if(checked?.then)throw fail('ASYNC_SQL_TRANSACTION_FORBIDDEN');
  db.exec('COMMIT');
 }catch(error){if(db.inTransaction)db.exec('ROLLBACK');throw error;}
 finally{if(!db.inTransaction&&uint(db.pragma('max_page_count = '+priorCap,{simple:true}),{positive:true})!==priorCap)throw fail('CAPACITY_SQLITE_CAP_RESTORE_FAILED');}
 return result;
}
module.exports={validateQuota,runGuardedTransaction};
