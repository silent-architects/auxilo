#!/usr/bin/env node
'use strict';
// Offline inventory only. Import is restricted to explicitly approved temp
// fixtures; this command is not a production migration or financial correction.
const fs=require('fs');const path=require('path');const os=require('os');const crypto=require('crypto');
const {readJSONStrict,readJSONLStrict,loadEarningsPrimary,digestJSON,plainObject}=require('../lib/stripe-transfer-persistence');
const {initializeAttemptStore,createAttemptStore}=require('../lib/stripe-transfer-attempts');
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function safePath(root,relative,{directory=false}={}){
 if(typeof relative!=='string'||!relative||path.isAbsolute(relative)||relative.split(/[\\/]/).some(p=>p==='..'||p===''))throw new Error('Inventory path outside explicit data directory');
 const full=path.join(root,relative);let current=root;
 for(const piece of relative.split(path.sep)){current=path.join(current,piece);try{if(fs.lstatSync(current).isSymbolicLink())throw new Error('Inventory symlink rejected');}catch(e){if(e.code!=='ENOENT')throw e;}}
 if(fs.existsSync(full)){const real=fs.realpathSync(full),base=fs.realpathSync(root);if(!real.startsWith(base+path.sep))throw new Error('Inventory path outside explicit data directory');if(directory&&!fs.statSync(full).isDirectory())throw new Error('WAL inventory must be a directory');}
 return full;
}
function inspectHistory({dataDir,manifestPath}={}){
 if(!dataDir||!path.isAbsolute(dataDir)||!manifestPath||!path.isAbsolute(manifestPath))throw new Error('Explicit absolute data directory and manifest required');
 if(fs.lstatSync(dataDir).isSymbolicLink()||fs.lstatSync(manifestPath).isSymbolicLink())throw new Error('Inventory symlink rejected');
 const manifestBytes=fs.readFileSync(manifestPath);const m=JSON.parse(manifestBytes);
 if(m.schema_version!==1||m.inventory_complete!==true||m.full_provider_local_reconciliation!==true||m.positive_history_attestation!==true||!m.history_interval||!Number.isFinite(Date.parse(m.history_interval.start))||!Number.isFinite(Date.parse(m.history_interval.end))||Date.parse(m.history_interval.start)>Date.parse(m.history_interval.end))throw new Error('Incomplete provider/local history reconciliation manifest');
 if(!Array.isArray(m.platforms)||m.platforms.length!==2||!['legacy','auxilo_llc'].every(alias=>m.platforms.some(p=>p.stripe_platform===alias&&p.history_complete===true&&/^acct_[A-Za-z0-9_]+$/.test(p.stripe_platform_account_id||'')&&typeof p.livemode==='boolean'))||new Set(m.platforms.map(p=>p.stripe_platform_account_id)).size!==2)throw new Error('Incomplete platform ownership history');
 if(!plainObject(m.files)||!plainObject(m.wal)||!Array.isArray(m.wal.files))throw new Error('Incomplete file inventory');
 const content={},checksums={};
 for(const role of ['earnings','accounts','wallet_map','withdrawals','provider_evidence']){
  const entry=m.files[role];if(!plainObject(entry))throw new Error('Missing required inventory file '+role);
  const full=safePath(dataDir,entry.path);
  if(entry.absent===true){
   if(!['withdrawals','provider_evidence'].includes(role)||!entry.attestation||!m.platforms.every(p=>p.unused_history_attested===true)||fs.existsSync(full))throw new Error('Invalid expected absence inventory attestation');
   content[role]=[];checksums[role]='absent';continue;
  }
  const bytes=fs.readFileSync(full);if(!/^[a-f0-9]{64}$/.test(entry.sha256||'')||hash(bytes)!==entry.sha256)throw new Error('Inventory file checksum mismatch');checksums[role]=entry.sha256;
  content[role]=role==='earnings'?loadEarningsPrimary(full):role==='withdrawals'?readJSONLStrict(full):readJSONStrict(full);
 }
 if(!plainObject(content.accounts)||!plainObject(content.wallet_map)||!Array.isArray(content.provider_evidence))throw new Error('Invalid financial inventory schema');
 const walDir=safePath(dataDir,m.wal.path,{directory:true});
 if(!fs.existsSync(walDir))throw new Error('Missing WAL directory inventory');
 const listing=fs.readdirSync(walDir).sort();
 if(m.wal.files.some(x=>!plainObject(x)||typeof x.path!=='string'||x.path.includes(path.sep))||new Set(m.wal.files.map(x=>x.path)).size!==m.wal.files.length||digestJSON(listing)!==m.wal.listing_sha256||digestJSON(m.wal.files.map(x=>x.path).sort())!==digestJSON(listing))throw new Error('Incomplete WAL listing inventory');
 const sources=new Map();
 function add(id,kind,row,ref,platform){if(typeof id!=='string'||!id)throw new Error('Missing historical record identity');const prior=sources.get(id)||{id,origins:[]};if(prior[kind])throw new Error('Conflicting duplicate historical inventory');prior[kind]=row;prior.origins.push(ref);if(platform){if(prior.platform&&prior.platform!==platform)prior.conflict=true;prior.platform=platform;}sources.set(id,prior);}
 for(const entry of m.wal.files){const full=safePath(walDir,entry.path);const bytes=fs.readFileSync(full);if(hash(bytes)!==entry.sha256)throw new Error('WAL file checksum mismatch');const row=JSON.parse(bytes);if(!plainObject(row)||typeof row.operation!=='string'||!plainObject(row.payload)||typeof row.id!=='string'||entry.path!==row.id+'.wal.json')throw new Error('Invalid WAL file schema or filename');if(row.operation==='withdraw_stripe')add(row.payload.withdrawal_id||row.id,'wal',row,{sha256:entry.sha256,file:entry.path},entry.stripe_platform);}
 for(const row of content.withdrawals)if(row.rail!=='usdc')add(row.id,'receipt',row,{sha256:checksums.withdrawals,record_digest:digestJSON(row)},row.stripe_platform);
 for(const row of content.provider_evidence){if(!plainObject(row)||typeof row.evidence_ref!=='string'||!row.evidence_ref)throw new Error('Missing provider evidence reference');add(row.local_id||row.transfer_id,'provider',row,{sha256:checksums.provider_evidence,record_digest:digestJSON(row)},row.stripe_platform);}
 const transferCounts=new Map();for(const item of sources.values())if(item.provider?.transfer_id)transferCounts.set(item.provider.transfer_id,(transferCounts.get(item.provider.transfer_id)||0)+1);
 if(sources.size&&m.platforms.every(p=>p.unused_history_attested===true))throw new Error('Unused history attestation contradicts existing records');
 for(const item of sources.values())if(item.platform&&m.platforms.find(p=>p.stripe_platform===item.platform)?.unused_history_attested===true)throw new Error('Unused platform history attestation contradicts existing records');
 const counts={confirmed_sent_debited:0,confirmed_sent_not_debited:0,unknown_send:0,unknown_ledger:0,unmapped_owner_platform:0,conflicts:0};const totals=Object.fromEntries(Object.keys(counts).map(k=>[k,0]));const records=[],resolvedLegacyWal=[];
 function count(bucket,amount){counts[bucket]++;totals[bucket]+=Number.isFinite(amount)?amount:0;}
 for(const item of sources.values()){
  const local=item.wal&&item.wal.payload||item.receipt||{};const provider=item.provider||{};const account=local.account_id||provider.account_id||null;const platform=m.platforms.find(p=>p.stripe_platform===item.platform);const amount=local.amount_usd===undefined?provider.amount_usd:local.amount_usd;
  const ownerKnown=!!account&&Object.hasOwn(content.accounts,account),platformKnown=!!platform;
  const localRows=[item.wal&&item.wal.payload,item.receipt].filter(Boolean);
  const comparedFields=['account_id','amount_usd','net_amount_cents','stripe_connect_id'];
  let conflict=!!item.conflict;
  for(const row of localRows){
   for(const field of comparedFields)if(row[field]!==undefined&&provider[field]!==undefined&&row[field]!==provider[field])conflict=true;
   if(row.currency!==undefined&&row.currency!=='usd')conflict=true;
   if(row.stripe_platform&&provider.stripe_platform&&row.stripe_platform!==provider.stripe_platform)conflict=true;
   if(row.stripe_platform_account_id&&provider.stripe_platform_account_id&&row.stripe_platform_account_id!==provider.stripe_platform_account_id)conflict=true;
   if(row.stripe_transfer_id&&provider.transfer_id&&row.stripe_transfer_id!==provider.transfer_id)conflict=true;
  }
  if(localRows.length===2)for(const field of comparedFields)if(localRows[0][field]!==undefined&&localRows[1][field]!==undefined&&localRows[0][field]!==localRows[1][field])conflict=true;
  if(provider.currency!==undefined&&provider.currency!=='usd')conflict=true;
  if(provider.transfer_id&&transferCounts.get(provider.transfer_id)!==1)conflict=true;
  if(provider.stripe_platform_account_id&&provider.stripe_platform_account_id!==platform?.stripe_platform_account_id)conflict=true;
  const sent=!conflict&&provider.transfer_confirmed===true&&typeof provider.transfer_id==='string'&&/^tr_[A-Za-z0-9_]+$/.test(provider.transfer_id)&&provider.currency==='usd'&&provider.stripe_platform_account_id===platform?.stripe_platform_account_id&&provider.livemode===platform?.livemode&&provider.net_amount_cents===(local.net_amount_cents===undefined?provider.net_amount_cents:local.net_amount_cents)&&provider.stripe_connect_id===(local.stripe_connect_id||provider.stripe_connect_id)&&Number.isSafeInteger(provider.net_amount_cents)&&provider.net_amount_cents>0&&typeof provider.stripe_connect_id==='string'&&Number.isFinite(provider.amount_usd)&&provider.amount_usd>0;
  // WAL step names and receipts alone never establish historical ledger debit.
  const ledgerKnown=!conflict&&provider.ledger_reviewed===true&&typeof provider.ledger_evidence_ref==='string'&&provider.ledger_evidence_ref&&['debited','not_debited'].includes(provider.ledger_disposition);
  if(!ownerKnown||!platformKnown)count('unmapped_owner_platform',amount);
  if(conflict)count('conflicts',amount);
  if(!sent)count('unknown_send',amount);if(!ledgerKnown)count('unknown_ledger',amount);
  if(sent&&ledgerKnown)count(provider.ledger_disposition==='debited'?'confirmed_sent_debited':'confirmed_sent_not_debited',amount);
  if(sent&&ledgerKnown&&provider.ledger_disposition==='debited'&&ownerKnown&&platformKnown&&!conflict&&item.receipt){
   if(item.wal){const walOrigin=item.origins.find(origin=>origin.file);resolvedLegacyWal.push({id:item.wal.id,sha256:walOrigin.sha256,receipt_digest:digestJSON(item.receipt),evidence_ref:provider.evidence_ref});}
   continue;
  }
  const origin={sha256:digestJSON(item.origins),references:item.origins,history_interval:m.history_interval};const stable=digestJSON({id:item.id,origin});
  records.push({attempt_id:'history_'+stable.slice(0,32),account_id:ownerKnown?account:null,earnings_key_at_creation:local.earnings_key||account||null,wallet_at_creation:ownerKnown?content.accounts[account].wallet||null:null,client_request_key:null,stripe_platform:platformKnown?platform.stripe_platform:null,stripe_platform_account_id:platformKnown?platform.stripe_platform_account_id:null,livemode:platformKnown?platform.livemode:null,amount_usd:Number.isFinite(amount)?amount:null,prepared_at:new Date(m.history_interval.end).toISOString(),origin});
 }
 if(sources.size===0&&!m.platforms.every(p=>p.unused_history_attested===true))throw new Error('Empty history requires affirmative unused-history attestations');
 const manifestRef={resolved_legacy_wal:resolvedLegacyWal,sha256:hash(manifestBytes),inventory_complete:true,positive_history_attestation:true,history_interval:m.history_interval,platforms:m.platforms.map(({stripe_platform,stripe_platform_account_id,livemode})=>({stripe_platform,stripe_platform_account_id,livemode}))};
 return {ready:records.length===0&&counts.unmapped_owner_platform===0&&counts.conflicts===0,counts,totals_usd:totals,records,manifestRef};
}
function importHistory({dataDir,manifestPath,isolatedFixture=false,approved=false}={}){
 if(isolatedFixture!==true||approved!==true)throw new Error('Explicit isolated fixture approval required');
 const root=fs.realpathSync(dataDir),temporaryRoots=[fs.realpathSync(os.tmpdir()),fs.realpathSync('/tmp')];
 if(!temporaryRoots.some(tmp=>root.startsWith(tmp+path.sep)))throw new Error('Import only permitted in isolated temporary fixture directory');
 const report=inspectHistory({dataDir,manifestPath});const file=path.join(dataDir,'stripe-transfer-attempts.json');
 if(!fs.existsSync(file))initializeAttemptStore(file,report.manifestRef);
 const store=createAttemptStore({file});if(!store.ready||digestJSON(store.manifest)!==digestJSON(report.manifestRef))throw new Error('Existing attempt inventory conflict');
 const imported=store.importHistorical(report.records);return {imported,counts:report.counts,totals_usd:report.totals_usd,ready:report.ready&&report.records.length===0};
}
if(require.main===module){
 try{const argv=process.argv.slice(2),value=name=>argv[argv.indexOf(name)+1];if(!argv.includes('--data-dir')||!argv.includes('--manifest'))throw new Error('Use --data-dir and --manifest; default is dry-run');const options={dataDir:path.resolve(value('--data-dir')),manifestPath:path.resolve(value('--manifest'))};const result=argv.includes('--import-fixture')?importHistory({...options,isolatedFixture:argv.includes('--isolated-fixture'),approved:argv.includes('--approved')}):inspectHistory(options);console.log(JSON.stringify({ready:result.ready,counts:result.counts,totals_usd:result.totals_usd,...(result.imported===undefined?{}:{imported:result.imported})}));}
 catch{console.error('History inventory requires reconciliation; no financial data changed.');process.exitCode=1;}
}
module.exports={inspectHistory,importHistory};
