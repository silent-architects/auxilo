'use strict';
// Cold-only abort of one proven unpublished compensation image. Never promotes
// data, changes a balance, clears the recovery marker, or imports participants.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const database=require('./money-database');
const {digest,fail}=require('./money-control-store');
const {canonicalJSON}=require('./stripe-transfer-persistence');
const {inspectFailureControl}=require('./money-failure-control');
const proofs=new WeakMap();
const STAGE=/^credits\.json\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/;
const bad=()=>{throw fail('COMPENSATION_STAGE_INVALID');};
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const round=v=>Math.round((v+Number.EPSILON)*1e6)/1e6;
function dollars(v){if(typeof v!=='number'||!Number.isFinite(v)||v<0||!Number.isSafeInteger(Math.round(v*1e6)))bad();return v;}
function validateCompensationStageImage({primary,candidateBytes,spend}) {
 try {
  const candidate=JSON.parse(candidateBytes.toString('utf8')),expected=structuredClone(primary),record=expected[spend.accountId],next=candidate[spend.accountId],draws=spend.intent.participantDraws;
  if(!record||!next||!Array.isArray(record.dollar_lots)||!Array.isArray(next.dollar_lots)||!Array.isArray(draws)||!draws.length||digest(spend.intent)!==spend.digest||spend.intent.participantDrawsDigest!==digest(draws))bad();
  const seen=new Set();let timestamp;
  for(const d of draws){
   if(seen.has(d.lotId)||!Number.isSafeInteger(d.amountMicros)||d.amountMicros<=0)bad();seen.add(d.lotId);
   const matches=record.dollar_lots.filter(x=>x.lot_id===d.lotId),after=next.dollar_lots.filter(x=>x.lot_id===d.lotId);
   if(matches.length!==1||after.length!==1||matches[0].kind!==d.kind)bad();
   const lot=matches[0],now=after[0].last_activity_at;
   if(typeof now!=='string'||!Number.isFinite(Date.parse(now))||new Date(now).toISOString()!==now||timestamp!==undefined&&timestamp!==now)bad();timestamp=now;
   if(round(dollars(lot.uncovered_usd||0))!==0)bad();
   const amount=d.amountMicros/1e6;
   if(lot.inflight_usd)lot.inflight_usd=round(Math.max(0,dollars(lot.inflight_usd)-amount));
   else if(lot.inflight_usd!==undefined)dollars(lot.inflight_usd);
   lot.remaining_usd=round(dollars(lot.remaining_usd||0)+amount);dollars(lot.remaining_usd);lot.last_activity_at=now;
  }
  const end=Date.parse(record.period_end);if(!Number.isFinite(end))bad();
  if(Date.parse(timestamp)>=end){const date=new Date(timestamp);record.queries_used=0;record.unlocks_used=0;record.period_start=new Date(Date.UTC(date.getUTCFullYear(),date.getUTCMonth(),1)).toISOString();record.period_end=new Date(Date.UTC(date.getUTCFullYear(),date.getUTCMonth()+1,1)).toISOString();}
  record.money_receipts=record.money_receipts||{};
  if(record.money_receipts[spend.id+':restore'])bad();
  record.money_receipts[spend.id+':restore']={projection_id:spend.id+':restore',digest:spend.digest};
  if(!Buffer.from(canonicalJSON(expected)+'\n').equals(candidateBytes))bad();
  return true;
 } catch(error){if(error.code==='COMPENSATION_STAGE_INVALID')throw error;bad();}
}
function identity(st){return{dev:st.dev,ino:st.ino,size:st.size,mtimeMs:st.mtimeMs,ctimeMs:st.ctimeMs};}
function regular(st,device){if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||(st.mode&0o777)!==0o600||st.uid!==process.getuid()||device!==undefined&&st.dev!==device)bad();}
function readBound(file,maximum,device){
 const before=fs.lstatSync(file);regular(before,device);if(!Number.isSafeInteger(maximum)||maximum<0||before.size>maximum)bad();
 const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
 try {const opened=fs.fstatSync(fd);regular(opened,device);if(digest(identity(opened))!==digest(identity(before)))bad();
  const bytes=Buffer.alloc(opened.size);let offset=0;while(offset<bytes.length){const n=fs.readSync(fd,bytes,offset,bytes.length-offset,offset);if(!n)bad();offset+=n;}
  const item={file,fd,identity:identity(opened),bytes,sha256:hash(bytes),maximum,device:opened.dev};recheckFile(item);return item;
 } catch(error){fs.closeSync(fd);throw error;}
}
function recheckFile(item){
 const opened=fs.fstatSync(item.fd),named=fs.lstatSync(item.file);regular(opened,item.device);regular(named,item.device);
 if(digest(identity(opened))!==digest(item.identity)||digest(identity(named))!==digest(item.identity))bad();
 const bytes=Buffer.alloc(opened.size);let offset=0;while(offset<bytes.length){const n=fs.readSync(item.fd,bytes,offset,bytes.length-offset,offset);if(!n)bad();offset+=n;}if(hash(bytes)!==item.sha256)bad();
 if(digest(identity(fs.fstatSync(item.fd)))!==digest(item.identity)||digest(identity(fs.lstatSync(item.file)))!==digest(item.identity))bad();
}
function closeFiles(items){for(const item of items)try{fs.closeSync(item.fd);}catch{}}
function stages(dir){return fs.readdirSync(dir).filter(n=>n.endsWith('.tmp')||n.includes('.stage-'));}
function assertReceipt(value,id,spend){if(!value||value.projection_id!==id||value.digest!==spend.digest)bad();}
function inspectCreditsCompensationStage({epochIdentity:epoch,writer,reader,stageName}) {
 const files=[];
 try {
  database.assertValidatedReader(reader,epoch);require('./money-writer-lock').assertMoneyWriter(writer,{root:epoch.legacy_root});
  if(!STAGE.test(stageName)||digest(stages(epoch.financial_dir))!==digest([stageName]))bad();
  const metadata=reader.readCurrentMetadata(),root=reader.getCapacityRecord('capacity:root');
  if(!root?.failureControl||!Number.isSafeInteger(root.profile?.maxRowBytes)||root.profile.maxRowBytes<=0)bad();
  const marker=inspectFailureControl({epoch,writer,databaseId:metadata.database_id,role:root.restoreBinding?require('./money-atomic-restore').resolveRestoredRole({epoch,writer,root,role:'first_failure_control',original:root.failureControl}):root.failureControl});
  if(marker.body.state!=='compensation_requested'||marker.body.cutStatus!=='verified')bad();
  const c=marker.body.compensation,spend=reader.state.spends[c.spendId];
  if(!spend||spend.state!=='acknowledged'||spend.id!==c.spendId||spend.intent.id!==spend.id||spend.intent.accountId!==spend.accountId||spend.digest!==digest(spend.intent)||spend.digest!==c.spendDigest||digest(spend.draws)!==digest(spend.intent.draws))bad();
  const store={descriptor:{database_id:metadata.database_id},getSpend:id=>reader.state.spends[id],getSource:id=>reader.state.sources[id]};
  require('./money-recovery-anchor').createRecoveryAnchors({epoch,writer,store}).restore(marker.body.anchor);
  const vector=spend.intent.participantDraws;
  require('./money-control').validateParticipantDraws({participantDraws:vector,draws:spend.draws,accountId:spend.accountId,getSource:id=>reader.state.sources[id],getProjection:id=>reader.state.projections[id]});
  if(spend.intent.participantDrawsDigest!==digest(vector)||c.drawVectorDigest!==digest({accountId:spend.accountId,spendId:spend.id,participantDraws:vector}))bad();
  const {noAccrualProofDigest,spendId,spendDigest,...noAccrual}=c;
  if(digest({...noAccrual,spendDigest})!==noAccrualProofDigest)bad();
  const dirStat=fs.lstatSync(epoch.financial_dir);if(!dirStat.isDirectory()||dirStat.isSymbolicLink())bad();
  function open(name,max=Number.MAX_SAFE_INTEGER){const item=readBound(path.join(epoch.financial_dir,name),max,dirStat.dev);files.push(item);return item;}
  const primary=open('credits.json'),credits=JSON.parse(primary.bytes),owner=credits[spend.accountId];
  if(!owner)bad();
  const central=reader.getAppliedEffect({participant:'credits',owner:spend.accountId,id:spend.id});
  if(central&&(central.epoch_id!==epoch.epoch_id||central.binding_digest!==epoch.binding_digest||central.participant!=='credits'||central.owner!==spend.accountId||central.id!==spend.id||central.effect_digest!==spend.digest))bad();
  if(owner.money_receipts?.[spend.id])assertReceipt(owner.money_receipts[spend.id],spend.id,spend);
  if(central)assertReceipt(central.receipt,spend.id,spend);
  assertReceipt(owner.money_receipts?.[spend.id]||central?.receipt,spend.id,spend);
  assertReceipt(spend.receipt,spend.id,spend);
  if(owner.money_receipts?.[spend.id+':restore']||reader.getAppliedEffect({participant:'credits',owner:spend.accountId,id:spend.id+':restore'}))bad();
  for(const d of vector){const lot=owner.dollar_lots?.find(l=>l.lot_id===d.lotId);if(!lot||lot.kind!==d.kind)bad();if(d.kind==='dollar_paid'){const source=reader.state.sources[d.sourceId];if(lot.account_id!==undefined&&lot.account_id!==spend.accountId||lot.epoch_id!==epoch.epoch_id||lot.binding_digest!==epoch.binding_digest||lot.stripe_payment_intent!==source.payment_intent_id||lot.checkout_intent_id!==source.provenance.intent_id||lot.purchase_id!==source.provenance.purchase_id)bad();}else if(lot.promo_receipt_id!==d.promoReceiptId)bad();}
  const earnings=open('earnings.json');
  require('./money-atomic-restore').assertRestoredEarningsIdentity({epoch,writer,root,compensation:c,actual:{...earnings.identity,bytes:earnings.identity.size,sha256:earnings.sha256}});
  if(c.walId!==null){
   if(!/^[a-zA-Z0-9_-]+$/.test(c.walId)||reader.state.pools['unlock:'+c.walId])bad();
   const walDir=path.join(epoch.financial_dir,'wal'),st=fs.lstatSync(walDir);if(!st.isDirectory()||st.isSymbolicLink()||st.dev!==dirStat.dev)bad();
   const names=[c.walId+'.wal.json',c.walId+'.compensation.json'].filter(n=>fs.existsSync(path.join(walDir,n)));if(names.length!==1)bad();
   const wal=open('wal/'+names[0]),entry=JSON.parse(wal.bytes),fence=entry.accrualFence;
   if(entry.id!==c.walId||entry.operation!=='unlock'||entry.payload?.funding_source!=='credit_pack'||entry.payload.purchaser_account_id!==spend.accountId||digest(entry.payload)!==c.walPayloadDigest||!Array.isArray(entry.steps_completed)||entry.steps_completed.includes('update_earnings')||fence?.state!=='not_started'||fence.spendId!==spend.id||fence.spendDigest!==spend.digest||fence.earningsBeforeDigest!==c.earningsBeforeDigest||digest(fence.earningsFileIdentity)!==digest(c.earningsFileIdentity))bad();
   const actual=entry.payload.dollar_draws;if(!Array.isArray(actual)||actual.length!==vector.length)bad();
   for(let i=0;i<vector.length;i++){const d=vector[i],a=actual[i];if(a.lot_id!==d.lotId||a.kind!==d.kind||a.amount!==d.amountMicros/1e6||a.spend_id!==spend.id||a.inflight_marked!==true)bad();}
  } else if(c.walPayloadDigest!==null)bad();
  const maximum=primary.identity.size+root.profile.maxRowBytes;if(!Number.isSafeInteger(maximum))bad();
  const candidate=open(stageName,maximum);validateCompensationStageImage({primary:credits,candidateBytes:candidate.bytes,spend});
  const proof=Object.freeze({});proofs.set(proof,{epoch,writer,reader,metadata:structuredClone(metadata),rootDigest:digest(root),marker,files,candidate,stageName,dirIdentity:{dev:dirStat.dev,ino:dirStat.ino}});return proof;
 } catch(error){closeFiles(files);throw error;}
}
function abortCreditsCompensationStage(proof){
 const p=proofs.get(proof);if(!p)bad();proofs.delete(proof);
 try {
  const {epoch,writer,reader,metadata,marker,files,candidate,stageName}=p;
  require('./money-writer-lock').assertMoneyWriter(writer,{root:epoch.legacy_root});database.assertValidatedReader(reader,epoch);
  if(digest(reader.readCurrentMetadata())!==digest(metadata)||digest(reader.getCapacityRecord('capacity:root'))!==p.rootDigest||digest(stages(epoch.financial_dir))!==digest([stageName]))bad();
  const now=inspectFailureControl({epoch,writer,databaseId:metadata.database_id,role:require('./money-atomic-restore').resolveRestoredRole({epoch,writer,root:reader.getCapacityRecord('capacity:root'),role:'first_failure_control',original:reader.getCapacityRecord('capacity:root').failureControl})});
  if(now.slotDigest!==marker.slotDigest||now.body.sequence!==marker.body.sequence)bad();
  for(const item of files)recheckFile(item);
  const dir=fs.openSync(epoch.financial_dir,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);
  try {const st=fs.fstatSync(dir),named=fs.lstatSync(epoch.financial_dir);if(!st.isDirectory()||st.dev!==p.dirIdentity.dev||st.ino!==p.dirIdentity.ino||named.dev!==st.dev||named.ino!==st.ino)bad();
   recheckFile(candidate);fs.unlinkSync(candidate.file);fs.fsyncSync(dir);
  } finally {fs.closeSync(dir);}
  return true;
 } finally {closeFiles(p.files);}
}
function discardCreditsCompensationStage(proof){
 const p=proofs.get(proof);if(!p)bad();proofs.delete(proof);
 try{require('./money-writer-lock').assertMoneyWriter(p.writer,{root:p.epoch.legacy_root});database.assertValidatedReader(p.reader,p.epoch);if(digest(p.reader.readCurrentMetadata())!==digest(p.metadata)||digest(p.reader.getCapacityRecord('capacity:root'))!==p.rootDigest||digest(stages(p.epoch.financial_dir))!==digest([p.stageName]))bad();for(const item of p.files)recheckFile(item);const root=p.reader.getCapacityRecord('capacity:root'),role=require('./money-atomic-restore').resolveRestoredRole({epoch:p.epoch,writer:p.writer,root,role:'first_failure_control',original:root.failureControl}),marker=inspectFailureControl({epoch:p.epoch,writer:p.writer,databaseId:p.metadata.database_id,role});if(marker.slotDigest!==p.marker.slotDigest)bad();return Object.freeze({relativePath:path.relative(p.epoch.legacy_root,p.candidate.file),sha256:p.candidate.sha256,bytes:p.candidate.bytes.length,dev:p.candidate.identity.dev,ino:p.candidate.identity.ino});}finally{closeFiles(p.files);}
}
module.exports={discardCreditsCompensationStage,validateCompensationStageImage,inspectCreditsCompensationStage,abortCreditsCompensationStage};
