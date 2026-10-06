'use strict';
// Production admission observes the actual process and installed source. Rehearsal
// has its own new-directory authority and never impersonates production runtime.
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const {canonicalJSON,digestJSON,plainObject,readJSONStrict,syncDirectory}=require('./stripe-transfer-persistence');
const engine=require('./stripe-migration-journal');
const {validateControl}=require('./stripe-migration-controls');
const ROOT=path.resolve(__dirname,'..');
const INSTALLED_FILES=Object.freeze(['scripts/stripe-production-operator.js','lib/stripe-production-operator.js','lib/stripe-migration-journal.js','lib/stripe-migration-controls.js','lib/stripe-checkout-intents.js','lib/stripe-event-receipts.js','lib/stripe-connect-intents.js','lib/stripe-object-origins.js','lib/stripe-transfer-attempts.js','lib/stripe-transfer-persistence.js']);
const JOURNAL='stripe-migration-journal.json',CONTROL='stripe-migration-control.json',ARMED='stripe-migration-armed.json',LOCK='.stripe-production-maintenance.lock',REHEARSAL='.stripe-operator-rehearsal.json';
const reserved=new Set([JOURNAL,CONTROL,ARMED,LOCK,REHEARSAL]);
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function fail(code){const e=new Error(code);e.code=code;throw e;}
function seal(value){const body={...value};delete body.checksum;return{...body,checksum:digestJSON(body)};}
function same(a,b){return canonicalJSON(a)===canonicalJSON(b);}
function confined(file,{directory=false,missing=false}={}){
 if(typeof file!=='string'||!path.isAbsolute(file)||path.normalize(file)!==file)fail('ABSOLUTE_CANONICAL_PATH_REQUIRED');
 let current=path.parse(file).root;const parts=file.slice(current.length).split(path.sep).filter(Boolean);
 for(let i=0;i<parts.length;i++){current=path.join(current,parts[i]);let s;try{s=fs.lstatSync(current);}catch(e){if(missing&&e.code==='ENOENT'&&i===parts.length-1)return file;throw e;}if(s.isSymbolicLink())fail('SYMLINK_REFUSED');if(i<parts.length-1&&!s.isDirectory())fail('INVALID_PATH_COMPONENT');if(i===parts.length-1&&(directory?!s.isDirectory():!s.isFile()))fail('INVALID_FILE_TYPE');}
 return file;
}
function knownBytes(dir,name){if(typeof name!=='string'||!name||name.includes('..')||path.isAbsolute(name)||name.includes('\\'))fail('INVALID_INVENTORY_PATH');return fs.readFileSync(confined(path.join(dir,name)));}
function inspectCheckpoint(inputDir){
 confined(inputDir,{directory:true});const missing=[],malformed=[];
 for(const name of fs.readdirSync(inputDir)){const full=path.join(inputDir,name),stat=fs.lstatSync(full);if(stat.isSymbolicLink())fail('SYMLINK_REFUSED');if(name==='wal'){confined(full,{directory:true});for(const child of fs.readdirSync(full))confined(path.join(full,child));}}
 for(const name of engine.REQUIRED){try{const bytes=knownBytes(inputDir,name),raw=bytes.toString();if(name.endsWith('.jsonl')){if(raw&&!raw.endsWith('\n'))throw Error();for(const row of raw.trimEnd()?raw.trimEnd().split('\n'):[])if(!plainObject(JSON.parse(row)))throw Error();}else{const value=JSON.parse(raw);if(!plainObject(value))throw Error();if(name==='stripe-transfer-attempts.json')require('./stripe-transfer-attempts').validateState(value);}}catch(e){if(e.code==='ENOENT')missing.push(name);else if(e.code==='SYMLINK_REFUSED')throw e;else malformed.push(name);}}
 if(!fs.existsSync(path.join(inputDir,'wal')))missing.push('wal');
 return{state:'inspected',sources_readable:missing.length===0&&malformed.length===0,inventory_complete:false,evidence_status:'manifest_not_validated',missing,malformed,totals:null};
}
function installedHashes(){return Object.fromEntries(INSTALLED_FILES.map(name=>[name,sha(fs.readFileSync(confined(path.join(ROOT,name))))]));}
function snapshotBody(snapshot,manifest){return{present_names:[...snapshot.presentNames].sort(),wal_names:[...snapshot.walNames].sort(),absent_names:Object.keys(manifest.initialization).sort(),files:Object.fromEntries(Object.entries(snapshot.bytesByName).sort(([a],[b])=>a.localeCompare(b)).map(([name,bytes])=>[name,{sha256:sha(bytes),bytes_base64:bytes.toString('base64')}]))};}
function snapshotFrom(body){return{presentNames:body.present_names,walNames:body.wal_names,bytesByName:Object.fromEntries(Object.entries(body.files).map(([name,row])=>{const bytes=Buffer.from(row.bytes_base64,'base64');if(sha(bytes)!==row.sha256)fail('PLAN_SOURCE_CHECKSUM_MISMATCH');return[name,bytes];}))};}
function validateOperatorPlan(plan){
 if(!plainObject(plan)||plan.schema_version!==1||!/^([a-f0-9]{40})$/.test(plan.candidate_sha||'')||plan.checksum!==seal(plan).checksum||!plainObject(plan.source)||!plainObject(plan.installed_hashes)||!same(Object.keys(plan.installed_hashes).sort(),[...INSTALLED_FILES].sort())||Object.values(plan.installed_hashes).some(h=>!/^([a-f0-9]{64})$/.test(h)))fail('INVALID_OPERATOR_PLAN');
 if(plan.source.present_names.some(name=>reserved.has(name)))fail('EXISTING_MIGRATION_STATE');
 const expected=engine.buildMigrationPlan({snapshot:snapshotFrom(plan.source),manifest:plan.manifest});
 if(!same(expected,plan.migration)||!same(plan.source.absent_names,Object.keys(plan.manifest.initialization).sort())||plan.source_fingerprint!==digestJSON(plan.source))fail('PLAN_PAYLOAD_MISMATCH');
 return plan;
}
function createOperatorPlan({inputDir,manifest,candidateSha}){
 confined(inputDir,{directory:true});const snapshot=engine.readMigrationCheckpoint(inputDir,manifest);
 if(snapshot.presentNames.some(n=>reserved.has(n)))fail('EXISTING_MIGRATION_STATE');
 const migration=engine.buildMigrationPlan({snapshot,manifest}),source=snapshotBody(snapshot,manifest);
 return validateOperatorPlan(seal({schema_version:1,candidate_sha:candidateSha,installed_hashes:installedHashes(),manifest,source,source_fingerprint:digestJSON(source),migration}));
}
function validateSourceSnapshot(snapshot,plan,maintenanceLock){
 const actual=snapshotBody(snapshot,plan.manifest);
 if(maintenanceLock){if(maintenanceLock.pid!==process.pid)fail('FOREIGN_MAINTENANCE_LOCK');actual.present_names=actual.present_names.filter(name=>name!==LOCK);}
 if(!same(actual,plan.source))fail('SOURCE_CHECKPOINT_CHANGED');return true;
}
function verifySource(inputDir,plan,ownLock=false){
 const lock=ownLock?readJSONStrict(confined(path.join(inputDir,LOCK))):null;
 return validateSourceSnapshot(engine.readMigrationCheckpoint(inputDir,plan.manifest),plan,lock);
}
function expectedArtifacts(plan){
 const journalId='operator-'+plan.checksum.slice(0,32),m=JSON.parse(canonicalJSON(plan.migration)),binding={checkpoint_id:m.checkpoint_id,manifest_sha256:m.manifest_sha256,approval_ref:m.approval_ref,journal_id:journalId};
 const control=seal({schema_version:1,...binding,generation:1,phase:'paused',intake_platform:null,allow_checkout:false,allow_connect_creation:false,allow_builder_transfer:false});validateControl(control);
 return{journal:seal({...m,journal_id:journalId,operator_plan_checksum:plan.checksum,state:'applying'}),control,marker:{schema_version:1,...binding}};
}
function validateRuntimeAttestation(observation,approval,plan){
 validateOperatorPlan(plan);const o=observation,a=approval;
 if(!plainObject(a)||a.schema_version!==1||!a.execution_approval_ref||a.writer_stopped!==true||a.plan_checksum!==plan.checksum||a.candidate_sha!==plan.candidate_sha||a.target_dir!=='/app/data'||!a.app_name||!a.machine_id||!same(a.installed_hashes,plan.installed_hashes))fail('EXECUTION_APPROVAL_MISMATCH');
 const start=Date.parse(a.window_start),end=Date.parse(a.window_end),now=Date.parse(o.observed_at);
 if(!Number.isFinite(start)||!Number.isFinite(end)||!Number.isFinite(now)||start>=end||end-start>3600000||now<start||now>end)fail('EXECUTION_WINDOW_INVALID');
 if(o.operator_entrypoint!==true||o.platform!=='linux'||o.uid!==0||o.target_uid!==1000||o.target_gid!==1000||o.target_dir!==a.target_dir||o.app_name!==a.app_name||o.machine_id!==a.machine_id||o.candidate_sha!==a.candidate_sha||!same(o.installed_hashes,a.installed_hashes))fail('RUNTIME_IDENTITY_MISMATCH');
 if(o.process_scan_complete!==true||o.socket_scan_complete!==true||!Array.isArray(o.other_node_processes)||o.other_node_processes.length||!Array.isArray(o.listening_sockets)||o.listening_sockets.length)fail('WRITER_NOT_STOPPED');
 return true;
}
function classifyListeningSockets(listeners,owners,ownershipComplete){
 if(ownershipComplete!==true||!Array.isArray(listeners)||!plainObject(owners))fail('SOCKET_EVIDENCE_UNREADABLE');
 const forbidden=[];
 for(const socket of listeners){const processes=owners[socket.inode];if(!Array.isArray(processes)||!processes.length||processes.some(p=>!Number.isSafeInteger(p.pid)||!p.executable))fail('SOCKET_OWNER_UNVERIFIED');
  const allowed=(socket.kind==='tcp'&&socket.port===22&&processes.every(p=>path.basename(p.executable)==='hallpass'))||(socket.kind==='unix'&&processes.every(p=>path.basename(p.executable)==='init'));
  if(!allowed)forbidden.push(socket.kind+':'+(socket.port||socket.inode));
 }
 return forbidden;
}
function observeRuntime(targetDir){
 if(process.platform!=='linux'||process.geteuid()!==0||targetDir!=='/app/data'||ROOT!=='/app'||path.resolve(process.argv[1]||'')!=='/app/scripts/stripe-production-operator.js'||(process.env.PORT!==undefined&&process.env.PORT!=='3000'))fail('MAINTENANCE_RUNTIME_REQUIRED');
 confined(targetDir,{directory:true});const stat=fs.statSync(targetDir),nodes=[],listeners=[],owners={};
 for(const pid of fs.readdirSync('/proc').filter(n=>/^\d+$/.test(n))){const base='/proc/'+pid;try{
  const comm=fs.readFileSync(base+'/comm','utf8').trim();let exe;
  try{exe=fs.readlinkSync(base+'/exe');}catch(e){if(e.code==='ENOENT'&&fs.existsSync(base)){const cmd=fs.readFileSync(base+'/cmdline');if(cmd.length)throw e;exe='';}else throw e;}
  if(Number(pid)!==process.pid&&(/^node(js)?$/.test(comm)||/^node(js)?(?: \(deleted\))?$/.test(path.basename(exe))))nodes.push(Number(pid));
  for(const fd of fs.readdirSync(base+'/fd')){let link;try{link=fs.readlinkSync(base+'/fd/'+fd);}catch(e){if(e.code==='ENOENT')continue;throw e;}const match=/^socket:\[(\d+)\]$/.exec(link);if(match){const list=owners[match[1]]||(owners[match[1]]=[]);if(!list.some(p=>p.pid===Number(pid)))list.push({pid:Number(pid),executable:exe});}}
 }catch(e){if(e.code==='ENOENT'&&!fs.existsSync(base))continue;fail('PROCESS_EVIDENCE_UNREADABLE');}}
 for(const name of ['tcp','tcp6']){const rows=fs.readFileSync('/proc/net/'+name,'utf8').trim().split('\n');if(!rows[0].includes('local_address'))fail('SOCKET_EVIDENCE_UNREADABLE');for(const row of rows.slice(1)){const cols=row.trim().split(/\s+/);if(cols.length<10)fail('SOCKET_EVIDENCE_UNREADABLE');if(cols[3]==='0A'){const port=parseInt(cols[1].split(':').pop(),16);if(!Number.isSafeInteger(port))fail('SOCKET_EVIDENCE_UNREADABLE');listeners.push({kind:'tcp',port,inode:cols[9]});}}}
 const unix=fs.readFileSync('/proc/net/unix','utf8').trim().split('\n');if(!unix[0].includes('Flags'))fail('SOCKET_EVIDENCE_UNREADABLE');for(const row of unix.slice(1)){const cols=row.trim().split(/\s+/);if(cols.length<7)fail('SOCKET_EVIDENCE_UNREADABLE');if(cols[3]==='00010000')listeners.push({kind:'unix',inode:cols[6]});}
 return{operator_entrypoint:true,platform:process.platform,uid:process.geteuid(),target_uid:stat.uid,target_gid:stat.gid,target_dir:targetDir,app_name:process.env.FLY_APP_NAME,machine_id:process.env.FLY_MACHINE_ID,candidate_sha:process.env.GIT_SHA,installed_hashes:installedHashes(),observed_at:new Date().toISOString(),other_node_processes:nodes,listening_sockets:classifyListeningSockets(listeners,owners,true),process_scan_complete:true,socket_scan_complete:true};
}
function selectOutputOwner(directoryStat,existingStat){if(directoryStat.uid!==1000||directoryStat.gid!==1000)fail('TARGET_OWNERSHIP_MISMATCH');const stat=existingStat||directoryStat;if(!Number.isSafeInteger(stat.uid)||!Number.isSafeInteger(stat.gid)||stat.uid<0||stat.gid<0)fail('TARGET_OWNERSHIP_MISMATCH');return{uid:stat.uid,gid:stat.gid};}
function ownerFor(file,dir,production){if(!production)return null;return selectOutputOwner(fs.statSync(dir),fs.existsSync(file)?fs.statSync(confined(file)):null);}
function writePrivate(file,bytes,dir,production,planChecksum){
 confined(path.dirname(file),{directory:true});confined(file,{missing:true});const owner=ownerFor(file,dir,production),tmp=planChecksum?stageName(file,planChecksum):file+'.'+crypto.randomUUID()+'.tmp';let fd;
 try{fd=fs.openSync(tmp,'wx',0o600);fs.writeFileSync(fd,bytes);if(owner)fs.fchownSync(fd,owner.uid,owner.gid);fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;fs.renameSync(tmp,file);syncDirectory(path.dirname(file));}catch(e){if(fd!==undefined)fs.closeSync(fd);try{fs.unlinkSync(tmp);}catch{}throw e;}
}
function jsonBytes(value){return Buffer.from(canonicalJSON(value)+'\n');}
function withLock(dir,production,fn){
 const file=path.join(dir,LOCK);if(fs.existsSync(file)){const lock=readJSONStrict(confined(file));if(!Number.isSafeInteger(lock.pid)||lock.pid<=0)fail('INVALID_MAINTENANCE_LOCK');try{process.kill(lock.pid,0);fail('MAINTENANCE_WRITER_ACTIVE');}catch(e){if(e.code!=='ESRCH')throw e;}fs.unlinkSync(file);syncDirectory(dir);}
 let fd;try{fd=fs.openSync(file,'wx',0o600);const owner=production?selectOutputOwner(fs.statSync(dir),null):null;fs.writeFileSync(fd,canonicalJSON({pid:process.pid}));if(owner)fs.fchownSync(fd,owner.uid,owner.gid);fs.fsyncSync(fd);syncDirectory(dir);return fn();}finally{if(fd!==undefined){fs.closeSync(fd);fs.unlinkSync(file);syncDirectory(dir);}}
}
function validateJournalBinding(journal,plan){
 const expected=expectedArtifacts(plan).journal;
 if(!plainObject(journal)||journal.checksum!==seal(journal).checksum||!['applying','completed'].includes(journal.state)||!Array.isArray(journal.entries)||journal.entries.length!==expected.entries.length)fail('OPERATOR_JOURNAL_INVALID');
 const a={...journal},b={...expected};delete a.checksum;delete b.checksum;delete a.state;delete b.state;a.entries=a.entries.map(({state,...row})=>row);b.entries=b.entries.map(({state,...row})=>row);
 if(!same(a,b)||journal.entries.some(e=>!['pending','applied'].includes(e.state))||(journal.state==='completed'&&journal.entries.some(e=>e.state!=='applied')))fail('OPERATOR_JOURNAL_BINDING_MISMATCH');
 return journal;
}
function stageName(target,checksum){if(!/^[a-f0-9]{64}$/.test(checksum))fail('INVALID_STAGING_BINDING');return target+'.operator-'+checksum+'.tmp';}
function permittedStages(dir,plan){return [...new Set([...plan.migration.entries.map(entry=>entry.name),JOURNAL,CONTROL,ARMED])].map(name=>({name:stageName(name,plan.checksum),target:path.join(dir,name)}));}
function validateStagingOwnership(stat,expected,operator){
 const finalOwner=stat.uid===expected.uid&&stat.gid===expected.gid;
 const interruptedRoot=operator.uid===0&&stat.uid===0&&stat.gid===operator.gid;
 if((stat.mode&0o7777)!==0o600||(!finalOwner&&!interruptedRoot))fail('STAGING_OWNERSHIP_MISMATCH');return true;
}
function validateStage(file,target,dir,production){
 const stat=fs.lstatSync(confined(file)),owner=production?ownerFor(target,dir,true):{uid:process.getuid(),gid:process.getgid()};
 validateStagingOwnership(stat,owner,{uid:process.geteuid(),gid:process.getegid()});
}
function discardStages(files){for(const file of files){fs.unlinkSync(file);syncDirectory(path.dirname(file));}}
function restartInitialJournal(dir,plan,production){
 const stage=stageName(path.join(dir,JOURNAL),plan.checksum);confined(stage);validateStage(stage,path.join(dir,JOURNAL),dir,production);
 const original=production?plan.source.present_names:[...new Set(['wal',...Object.keys(plan.source.files).map(name=>name.split('/')[0])])];
 const allowed=new Set([...original,LOCK,...(production?[]:[REHEARSAL]),path.basename(stage)]),actual=fs.readdirSync(dir);
 if(original.some(name=>!actual.includes(name))||actual.some(name=>!allowed.has(name)))fail('INITIAL_JOURNAL_SOURCE_DRIFT');
 const snapshot=engine.readMigrationCheckpoint(dir,plan.manifest),source=snapshotBody(snapshot,plan.manifest);
 source.present_names=plan.source.present_names;
 if(!same(source,plan.source))fail('INITIAL_JOURNAL_SOURCE_DRIFT');
 discardStages([stage]);
}
function checkCurrentFiles(dir,plan,journal,production){
 const original=production?plan.source.present_names:[...new Set(['wal',...Object.keys(plan.source.files).map(name=>name.split('/')[0])])];
 const stages=permittedStages(dir,plan),presentStages=[];
 const allowed=new Set([...original,...journal.entries.map(entry=>entry.name.split('/')[0]),JOURNAL,CONTROL,ARMED,LOCK,...(production?[]:[REHEARSAL]),...stages.filter(stage=>!stage.name.includes('/')).map(stage=>stage.name)]);
 const currentNames=fs.readdirSync(dir);
 if(original.some(name=>!currentNames.includes(name))||currentNames.some(name=>!allowed.has(name)))fail('UNRELATED_ROOT_DRIFT');
 for(const name of currentNames)if(fs.lstatSync(path.join(dir,name)).isSymbolicLink())fail('SYMLINK_REFUSED');
 for(const stage of stages){const file=path.join(dir,stage.name);if(fs.existsSync(file)){validateStage(file,stage.target,dir,production);presentStages.push(file);}}
 const expectedWal=plan.source.wal_names,walStages=new Set(stages.filter(stage=>stage.name.startsWith('wal/')).map(stage=>stage.name.slice(4)));if(!same(fs.readdirSync(confined(path.join(dir,'wal'),{directory:true})).filter(name=>!walStages.has(name)).sort(),expectedWal))fail('WAL_LISTING_CHANGED');
 for(const entry of journal.entries){const file=path.join(dir,entry.name);let current=null;try{current=sha(fs.readFileSync(confined(file)));}catch(e){if(e.code!=='ENOENT')throw e;}
  if(current===null&&entry.before_sha256!==null)fail('HISTORICAL_SOURCE_DISAPPEARED');
  if(current!==entry.before_sha256&&current!==entry.after_sha256)fail('UNRELATED_TARGET_DRIFT');
  if(entry.state==='applied'&&current!==entry.after_sha256)fail('APPLIED_TARGET_DRIFT');
 }
 const expected=expectedArtifacts(plan);for(const[name,value]of [[CONTROL,expected.control],[ARMED,expected.marker]])if(fs.existsSync(path.join(dir,name))&&!fs.readFileSync(confined(path.join(dir,name))).equals(jsonBytes(value)))fail('CONTROL_RECOVERY_CONFLICT');
 if(journal.state!=='completed'&&(fs.existsSync(path.join(dir,CONTROL))||fs.existsSync(path.join(dir,ARMED))))fail('PREMATURE_CONTROL_STATE');
 return presentStages;
}
function executeUnderLock({dir,plan,production,fresh,afterWrite}){
 const jf=path.join(dir,JOURNAL),expected=expectedArtifacts(plan);let counter=0;
 const notify=name=>{if(afterWrite)afterWrite(name,++counter);};
 if(!fresh&&!fs.existsSync(jf)){restartInitialJournal(dir,plan,production);fresh=true;}
 let journal;if(fresh){for(const n of [JOURNAL,CONTROL,ARMED])if(fs.existsSync(path.join(dir,n)))fail('EXISTING_MIGRATION_STATE');journal=expected.journal;writePrivate(jf,jsonBytes(journal),dir,production,plan.checksum);notify(JOURNAL);}else journal=validateJournalBinding(readJSONStrict(confined(jf)),plan);
 discardStages(checkCurrentFiles(dir,plan,journal,production));
 for(let i=0;i<journal.entries.length;i++){const entry=journal.entries[i],file=path.join(dir,entry.name);if(sha(fs.existsSync(file)?fs.readFileSync(confined(file)):Buffer.alloc(0))!==entry.after_sha256){writePrivate(file,Buffer.from(entry.bytes_base64,'base64'),dir,production,plan.checksum);}notify(entry.name);entry.state='applied';journal=seal(journal);writePrivate(jf,jsonBytes(journal),dir,production,plan.checksum);}
 journal=seal({...journal,state:'completed'});writePrivate(jf,jsonBytes(journal),dir,production,plan.checksum);notify('journal-completed');
 writePrivate(path.join(dir,CONTROL),jsonBytes(expected.control),dir,production,plan.checksum);notify(CONTROL);
 writePrivate(path.join(dir,ARMED),jsonBytes(expected.marker),dir,production,plan.checksum);notify(ARMED);
 return{state:'completed',plan_checksum:plan.checksum,files:journal.entries.length,phase:'paused',payouts_enabled:false};
}
function validateRehearsalPaths(inputDir,outputDir){confined(inputDir,{directory:true});confined(path.dirname(outputDir),{directory:true});if(!path.isAbsolute(outputDir)||outputDir==='/app/data'||outputDir===inputDir||outputDir.startsWith(inputDir+path.sep)||inputDir.startsWith(outputDir+path.sep))fail('SEPARATE_REHEARSAL_DIRECTORY_REQUIRED');}
function rehearse({inputDir,outputDir,plan,afterWrite}){
 validateOperatorPlan(plan);validateRehearsalPaths(inputDir,outputDir);if(fs.existsSync(outputDir))fail('REHEARSAL_OUTPUT_EXISTS');verifySource(inputDir,plan);
 fs.mkdirSync(outputDir,{mode:0o700});fs.mkdirSync(path.join(outputDir,'wal'),{mode:0o700});
 writePrivate(path.join(outputDir,REHEARSAL),jsonBytes({schema_version:1,plan_checksum:plan.checksum,source_path:inputDir}),outputDir,false);
 for(const[name,row]of Object.entries(plan.source.files))writePrivate(path.join(outputDir,name),Buffer.from(row.bytes_base64,'base64'),outputDir,false);
 return withLock(outputDir,false,()=>executeUnderLock({dir:outputDir,plan,production:false,fresh:true,afterWrite}));
}
function recoverRehearsal({inputDir,outputDir,plan,afterWrite}){
 validateOperatorPlan(plan);validateRehearsalPaths(inputDir,outputDir);confined(outputDir,{directory:true});const marker=readJSONStrict(confined(path.join(outputDir,REHEARSAL)));
 if(marker.plan_checksum!==plan.checksum||marker.source_path!==inputDir||fs.statSync(outputDir).uid!==process.getuid())fail('REHEARSAL_OWNERSHIP_MISMATCH');verifySource(inputDir,plan);
 return withLock(outputDir,false,()=>executeUnderLock({dir:outputDir,plan,production:false,fresh:false,afterWrite}));
}
function production(options,recovery){
 if(Object.keys(options).some(k=>!['targetDir','plan','approval'].includes(k)))fail('UNSUPPORTED_EXECUTION_INPUT');
 const{targetDir,plan,approval}=options;validateOperatorPlan(plan);validateRuntimeAttestation(observeRuntime(targetDir),approval,plan);
 return withLock(targetDir,true,()=>{validateRuntimeAttestation(observeRuntime(targetDir),approval,plan);if(!recovery)verifySource(targetDir,plan,true);return executeUnderLock({dir:targetDir,plan,production:true,fresh:!recovery});});
}
function writePrivateArtifact(file,value){confined(path.dirname(file),{directory:true});if(fs.existsSync(file))fail('ARTIFACT_ALREADY_EXISTS');writePrivate(file,jsonBytes(value),path.dirname(file),false);}
module.exports={INSTALLED_FILES,validateStagingOwnership,classifyListeningSockets,selectOutputOwner,validateSourceSnapshot,inspectCheckpoint,createOperatorPlan,validateOperatorPlan,installedHashes,validateRuntimeAttestation,rehearse,recoverRehearsal,maintain:options=>production(options,false),recover:options=>production(options,true),writePrivateArtifact};
