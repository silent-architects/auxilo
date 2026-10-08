"use strict";
const fs = require('fs'), path = require('path'), crypto = require('crypto'), net = require('net');
const e = require('./financial-epoch'), p = require('./stripe-transfer-persistence'), l = require('./money-lifecycle');
const {
  assertMoneyWriter
}
= require('./money-writer-lock'), {
  validateSnapshot
}
= require('./money-control-store');
const MANIFEST = 'money-checkpoint-manifest.json', RESTORE = 'money-restore-barrier.json';
const EXCLUDE = new Set(['backups', 'lost+found', '.money-checkpoints', '.money-control.sock', '.money-writer.lock',
'.money-checkpoint-pending.json']);
const LIMITS = Object.freeze( {
  bytes: 128 * 1024 * 1024, files: 20000
});
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function fail(code) {
  throw Object.assign(new Error(code), {
    code
  });
}
function checkpointDirectory(root, id) {
  if (! /^[a-f0-9-]{36}$/.test(id || '')) fail('CHECKPOINT_ID_INVALID');
  return path.join(root, '.money-checkpoints', id);
}
function hashFile(file, buffer = Buffer.allocUnsafe(256*1024)) {
  const fd=fs.openSync(e.confined(file,'file'),fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW),digest=crypto.createHash('sha256');
  try {let n;while((n=fs.readSync(fd,buffer,0,buffer.length,null)))digest.update(buffer.subarray(0,n));return digest.digest('hex');}finally{fs.closeSync(fd);}
}
const checkpointStageAuthorities=new WeakMap();
const inventoryIdentities=new WeakMap(),HASH_FROM_SOURCE=Symbol('checkpoint-held-cut');
function listTree(root, {
  exclude = true, verifiedPadding = new Map(), hashFiles = true, stageAuthority
}
= {
}) {
  const rows =[], dirs =[], hashBuffer=Buffer.allocUnsafe(256*1024);
  let total = 0;const identities=new Map();
  function visit(dir, relative = '') {
    for (const entry of fs.readdirSync(dir, {
      withFileTypes: true
    })) {
      if (! relative && exclude && EXCLUDE.has(entry.name)) continue;
      if (! relative && entry.name === MANIFEST) continue;
      if (entry.name.endsWith('.tmp') || entry.name.includes('.stage-')) {const proof=checkpointStageAuthorities.get(stageAuthority),rel=relative?relative+'/'+entry.name:entry.name;if(!proof||proof.relativePath!==rel||hashFile(path.join(root,rel))!==proof.sha256)fail('CHECKPOINT_UNCERTAIN_STAGE');}
      const rel = relative ? relative + '/' + entry.name: entry.name, file = path.join(root, rel), stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) fail('CHECKPOINT_SYMLINK');
      if (verifiedPadding.has(rel)) {
        const proof=verifiedPadding.get(rel);
        if (!stat.isFile() || stat.nlink!==1 || stat.dev!==proof.dev || stat.ino!==proof.ino || stat.size!==proof.bytes || stat.blocks*512<proof.bytes) fail('CAPACITY_PHYSICAL_MISMATCH');
        continue;
      }
      if (stat.isDirectory()) {
        if(dirs.length>=LIMITS.files)fail('CHECKPOINT_CAPACITY_EXCEEDED');
        dirs.push(rel);
        visit(file, rel);
      } else if (stat.isFile()) {
        if (stat.nlink !== 1) fail('CHECKPOINT_HARDLINK');
        total += stat.size;
        if (total > LIMITS.bytes || rows.length >= LIMITS.files) fail('CHECKPOINT_CAPACITY_EXCEEDED');
        if (rel.endsWith('.json')) JSON.parse(fs.readFileSync(file));
        if (rel.endsWith('.jsonl')) p.readJSONLStrict(file);
        rows.push({path:rel,bytes:stat.size,sha256:hashFiles?hashFile(file,hashBuffer):null});
        identities.set(rel,{dev:stat.dev,ino:stat.ino,size:stat.size,mtimeMs:stat.mtimeMs,ctimeMs:stat.ctimeMs});
      } else fail('CHECKPOINT_SPECIAL_FILE');
    }
  }
  visit(e.confined(root, 'directory'));
  const tree={files:rows.sort((a,b)=>a.path.localeCompare(b.path)),directories:dirs.sort(),total_bytes:total};
  inventoryIdentities.set(tree,identities);return tree;
}
const ARCHIVE = 'money-checkpoint.pack';
const ARCHIVE_MAGIC = Buffer.from('AUXILO-MONEY-CUT\0v2\n');
const STREAM_BYTES = 256 * 1024;
function archiveInventory(tree,{allowUnhashed=false}={}) {
  if (!tree || !Array.isArray(tree.files) || !Array.isArray(tree.directories) || tree.files.length > LIMITS.files || tree.directories.length > LIMITS.files) fail('CHECKPOINT_ARCHIVE_INVENTORY');
  const names = new Set();
  function name(value) {
    if (typeof value !== 'string' || Buffer.byteLength(value) > 4096 || value.includes('\\') || value.includes('\0') || value.startsWith('/') || value.split('/').some(x => !x || x === '.' || x === '..') || names.has(value)) fail('CHECKPOINT_ARCHIVE_INVENTORY');
    names.add(value);
  }
  for (const dir of tree.directories) name(dir);
  let total = 0;
  for (const row of tree.files) {
    name(row.path);
    if (!Number.isSafeInteger(row.bytes) || row.bytes < 0 || (!(allowUnhashed&&row.sha256===null)&&!/^[a-f0-9]{64}$/.test(row.sha256 || ''))) fail('CHECKPOINT_ARCHIVE_INVENTORY');
    total += row.bytes;
  }
  if (!Number.isSafeInteger(total) || total > LIMITS.bytes || tree.total_bytes !== total) fail('CHECKPOINT_ARCHIVE_INVENTORY');
  const directories = new Set(tree.directories);
  for (const item of names) { const parent = path.posix.dirname(item); if (parent !== '.' && !directories.has(parent)) fail('CHECKPOINT_ARCHIVE_INVENTORY'); }
  return [...tree.directories.map(relative => ({path:relative,type:'directory',bytes:0,sha256:hash(Buffer.alloc(0))})), ...tree.files.map(row => ({...row,type:'file'}))];
}
function packCheckpointTree(root, archive, tree, options = {}) {
  const {onStage}=options,hashDuringPack=options[HASH_FROM_SOURCE]===true;
  const entries=archiveInventory(tree,{allowUnhashed:hashDuringPack}),identities=inventoryIdentities.get(tree);
  if(hashDuringPack&&!identities)fail('CHECKPOINT_INVENTORY_IDENTITY');
  const fileRows=new Map(tree.files.map(row=>[row.path,row])),out=fs.openSync(archive,'wx',0o600),whole=crypto.createHash('sha256');
  let archiveBytes=0,buffered=0;
  const outputBuffer=Buffer.allocUnsafe(STREAM_BYTES),inputBuffer=Buffer.allocUnsafe(STREAM_BYTES);
  const flush=()=>{let offset=0;while(offset<buffered){const n=fs.writeSync(out,outputBuffer,offset,buffered-offset);if(!n)fail('CHECKPOINT_ARCHIVE_SHORT_WRITE');offset+=n;}buffered=0;};
  const write=raw=>{whole.update(raw);archiveBytes+=raw.length;let offset=0;while(offset<raw.length){const size=Math.min(outputBuffer.length-buffered,raw.length-offset);raw.copy(outputBuffer,buffered,offset,offset+size);buffered+=size;offset+=size;if(buffered===outputBuffer.length)flush();}};
  const header=entry=>{const raw=Buffer.from(p.canonicalJSON(entry)),length=Buffer.alloc(4);length.writeUInt32BE(raw.length);write(length);write(raw);};
  const same=(before,after)=>['dev','ino','size','mtimeMs','ctimeMs'].every(k=>before[k]===after[k]);
  try {
    write(ARCHIVE_MAGIC);
    for(const entry of entries){
      const file=e.confined(path.join(root,entry.path),entry.type==='directory'?'directory':'file');
      if(entry.type==='directory'){header(entry);continue;}
      const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW),before=fs.fstatSync(fd);
      try {
        if(!before.isFile()||before.nlink!==1||before.size!==entry.bytes||(hashDuringPack&&!same(identities.get(entry.path)||{},before)))fail('CHECKPOINT_SOURCE_CHANGED');
        let bufferedInput=false;
        if(hashDuringPack){
          const digest=crypto.createHash('sha256');let position=0;bufferedInput=entry.bytes<=inputBuffer.length;
          while(position<entry.bytes){const offset=bufferedInput?position:0,n=fs.readSync(fd,inputBuffer,offset,Math.min(inputBuffer.length-offset,entry.bytes-position),position);if(!n)fail('CHECKPOINT_SOURCE_CHANGED');digest.update(inputBuffer.subarray(offset,offset+n));position+=n;}
          entry.sha256=digest.digest('hex');
          if(!same(before,fs.fstatSync(fd)))fail('CHECKPOINT_SOURCE_CHANGED');
        }
        header(entry);
        if(bufferedInput){write(inputBuffer.subarray(0,entry.bytes));}
        else {
          const digest=crypto.createHash('sha256');let position=0;
          while(position<entry.bytes){const n=fs.readSync(fd,inputBuffer,0,Math.min(inputBuffer.length,entry.bytes-position),position);if(!n)fail('CHECKPOINT_SOURCE_CHANGED');const raw=inputBuffer.subarray(0,n);digest.update(raw);write(raw);position+=n;}
          if(digest.digest('hex')!==entry.sha256)fail('CHECKPOINT_SOURCE_CHANGED');
        }
        if(!same(before,fs.fstatSync(fd)))fail('CHECKPOINT_SOURCE_CHANGED');
        if(hashDuringPack)fileRows.get(entry.path).sha256=entry.sha256;
      }finally{fs.closeSync(fd);}
    }
    flush();onStage?.('pack');fs.fsyncSync(out);onStage?.('archive_fsync');
  }finally{fs.closeSync(out);}
  return{file:ARCHIVE,format:'auxilo-money-cut-v2',sha256:whole.digest('hex'),archive_bytes:archiveBytes,files:tree.files.length,bytes:tree.total_bytes};
}
function scanCheckpointArchive(archive, tree, visitor) {
  const entries=archiveInventory(tree), fd=fs.openSync(e.confined(archive,'file'),fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW), whole=crypto.createHash('sha256');
  let position=0;
  function read(size) {const raw=Buffer.allocUnsafe(size);let offset=0;while(offset<size){const n=fs.readSync(fd,raw,offset,size-offset,position);if(!n)fail('CHECKPOINT_ARCHIVE_TRUNCATED');offset+=n;position+=n;}whole.update(raw);return raw;}
  try {
    if(fs.fstatSync(fd).nlink!==1)fail('CHECKPOINT_HARDLINK');
    if(!read(ARCHIVE_MAGIC.length).equals(ARCHIVE_MAGIC))fail('CHECKPOINT_ARCHIVE_HEADER');
    for(const entry of entries){const size=read(4).readUInt32BE();if(!size||size>8192)fail('CHECKPOINT_ARCHIVE_HEADER');let header;try{header=JSON.parse(read(size));}catch{fail('CHECKPOINT_ARCHIVE_HEADER');}if(p.canonicalJSON(header)!==p.canonicalJSON(entry))fail('CHECKPOINT_ARCHIVE_INVENTORY');
      const digest=crypto.createHash('sha256');let remaining=entry.bytes;visitor?.start?.(entry);
      while(remaining){const raw=read(Math.min(STREAM_BYTES,remaining));digest.update(raw);visitor?.chunk?.(entry,raw);remaining-=raw.length;}
      if(digest.digest('hex')!==entry.sha256)fail('CHECKPOINT_ARCHIVE_HASH');visitor?.end?.(entry);
    }
    if(position!==fs.fstatSync(fd).size)fail('CHECKPOINT_ARCHIVE_TRAILING');
    return {sha256:whole.digest('hex'),archive_bytes:position};
  }finally{fs.closeSync(fd);}
}
function extractCheckpointArchive(archive,destination,tree,{durable=true}={}) {
  e.confined(destination,'directory');if(fs.readdirSync(destination).length)fail('CHECKPOINT_EXTRACT_EMPTY');
  let output;
  try {scanCheckpointArchive(archive,tree,{
    start(entry){const target=path.join(destination,entry.path);if(entry.type==='directory')fs.mkdirSync(target,{mode:0o700});else output=fs.openSync(target,'wx',0o600);},
    chunk(entry,raw){fs.writeFileSync(output,raw);},
    end(entry){if(entry.type==='file'){if(durable)fs.fsyncSync(output);fs.closeSync(output);output=undefined;}}
  });if(durable){for(const dir of [...tree.directories].reverse())p.syncDirectory(path.join(destination,dir));p.syncDirectory(destination);}
  }finally{if(output!==undefined)fs.closeSync(output);}
  return destination;
}

const BACKUP_MAGIC=Buffer.from('AUXILO-FINANCIAL-BACKUP\0v2\n'),MAX_MANIFEST_BYTES=8*1024*1024;
const MAX_BACKUP_BYTES=LIMITS.bytes+2*LIMITS.files*8196+MAX_MANIFEST_BYTES+BACKUP_MAGIC.length+4;
async function* checkpointBackupStream(directory) {
  const manifest=validateCheckpoint(directory),raw=fs.readFileSync(path.join(directory,MANIFEST));
  if(raw.length>MAX_MANIFEST_BYTES||raw.toString()!==p.canonicalJSON(manifest)+'\n')fail('CHECKPOINT_ENVELOPE_MANIFEST');
  const length=Buffer.alloc(4);length.writeUInt32BE(raw.length);yield BACKUP_MAGIC;yield length;yield raw;
  let bytes=0;const digest=crypto.createHash('sha256');
  for await(const chunk of fs.createReadStream(e.confined(path.join(directory,ARCHIVE),'file'),{highWaterMark:STREAM_BYTES})){bytes+=chunk.length;digest.update(chunk);yield chunk;}
  if(bytes!==manifest.archive.archive_bytes||digest.digest('hex')!==manifest.archive.sha256)fail('CHECKPOINT_ENVELOPE_CHANGED');
}
function unpackCheckpointEnvelope(file,destination) {
  e.confined(destination,'directory');if(fs.readdirSync(destination).length)fail('CHECKPOINT_EXTRACT_EMPTY');
  const fd=fs.openSync(e.confined(file,'file'),'r');let position=0,output;
  function read(size){const raw=Buffer.allocUnsafe(size);let offset=0;while(offset<size){const n=fs.readSync(fd,raw,offset,size-offset,position);if(!n)fail('CHECKPOINT_ENVELOPE_TRUNCATED');offset+=n;position+=n;}return raw;}
  try {
    const stat=fs.fstatSync(fd);if(stat.size>MAX_BACKUP_BYTES)fail('CHECKPOINT_ENVELOPE_SIZE');
    if(!read(BACKUP_MAGIC.length).equals(BACKUP_MAGIC))fail('CHECKPOINT_ENVELOPE_HEADER');
    const length=read(4).readUInt32BE();if(!length||length>MAX_MANIFEST_BYTES)fail('CHECKPOINT_ENVELOPE_MANIFEST');
    const raw=read(length);let manifest;try{manifest=JSON.parse(raw);}catch{fail('CHECKPOINT_ENVELOPE_MANIFEST');}
    if(raw.toString()!==p.canonicalJSON(manifest)+'\n'||manifest.schema_version!==2||manifest.checksum!==e.seal(manifest).checksum||manifest.archive?.file!==ARCHIVE||manifest.archive?.format!=='auxilo-money-cut-v2')fail('CHECKPOINT_ENVELOPE_MANIFEST');
    archiveInventory(manifest);
    if(!Number.isSafeInteger(manifest.archive.archive_bytes)||manifest.archive.archive_bytes<ARCHIVE_MAGIC.length||stat.size-position!==manifest.archive.archive_bytes)fail('CHECKPOINT_ENVELOPE_SIZE');
    output=fs.openSync(path.join(destination,ARCHIVE),'wx',0o600);let remaining=manifest.archive.archive_bytes;const digest=crypto.createHash('sha256');
    while(remaining){const chunk=read(Math.min(STREAM_BYTES,remaining));digest.update(chunk);fs.writeFileSync(output,chunk);remaining-=chunk.length;}
    if(digest.digest('hex')!==manifest.archive.sha256)fail('CHECKPOINT_ENVELOPE_HASH');fs.fsyncSync(output);fs.closeSync(output);output=undefined;
    writeFile(path.join(destination,MANIFEST),raw);validateCheckpoint(destination);return destination;
  }finally{if(output!==undefined)fs.closeSync(output);fs.closeSync(fd);}
}

function semanticSnapshot(root, store, {writer,manifest}={}) {
  if(manifest||store&&writer){return require('./money-atomic-restore').inspectCheckpointEpoch({root,sourceEpoch:store?.epoch,writer,manifest,inspect(epoch,reader,candidate){const result=validateParticipantCut(epoch,reader);if(candidate){const token=Object.freeze({});checkpointStageAuthorities.set(token,candidate);result.stageAuthority=token;result.compensationStage=candidate;}return result;}});}

  let result;
  const epoch=e.resolveRuntimeEpoch({root,inspectValidatedDatabase(current,reader){
    if(store && (store.epoch.binding_digest!==current.binding_digest || store.epoch.legacy_root!==current.legacy_root || store.file!==e.pathFor('money_database',current)))fail('CHECKPOINT_STORE_IDENTITY');
    result=validateParticipantCut(current,reader);
  }});
  if(!epoch || !result)fail('CHECKPOINT_EPOCH_REQUIRED');
  return result;
}
function validateParticipantCut(epoch,reader) {
  const snapshot=reader.state;
  const credits = p.readJSONStrict(e.pathFor('credits', epoch)), earnings = p.readJSONStrict(e.pathFor('earnings', epoch));
  for (const projection of reader.values(snapshot.projections)) {
    if (! projection.intent || ! snapshot.operations[projection.operationId]) fail('CHECKPOINT_PROJECTION_INTENT_MISSING');
    const store = projection.participant === 'credits' ? credits: projection.participant === 'earnings' ? earnings: null;
    if (! store) fail('CHECKPOINT_PROJECTION_PARTICIPANT_UNKNOWN');
    const receipt = store[projection.owner]?.money_receipts?.[projection.id];
    if (receipt &&(receipt.projection_id !== projection.id || receipt.digest !== projection.digest)) fail('CHECKPOINT_PROJECTION_RECEIPT_CONFLICT');
    if (projection.state === 'acknowledged' && ! receipt) fail('CHECKPOINT_PROJECTION_RECEIPT_MISSING');
  }
  for (const spend of reader.values(snapshot.spends)) {
    const receipts = credits[spend.accountId]?.money_receipts || {};
    const debit = receipts[spend.id], restore = receipts[spend.id + ':restore'];
    const valid = (receipt,id) => receipt && receipt.projection_id === id && receipt.digest === spend.digest;
    if (debit && !valid(debit,spend.id)) fail('CHECKPOINT_SPEND_RECEIPT_CONFLICT');
    if (restore && (!valid(restore,spend.id + ':restore') || !['acknowledged','returned'].includes(spend.state) || !debit)) fail('CHECKPOINT_SPEND_RESTORE_CONFLICT');
    if (spend.state !== 'prepared' && !debit) fail('CHECKPOINT_SPEND_RECEIPT_MISSING');
    if (spend.state === 'returned' && !restore) fail('CHECKPOINT_SPEND_RESTORE_MISSING');
    if (spend.receipt && p.digestJSON(spend.receipt) !== p.digestJSON(debit)) fail('CHECKPOINT_SPEND_RECEIPT_CONFLICT');
    if (spend.restoreReceipt && p.digestJSON(spend.restoreReceipt) !== p.digestJSON(restore)) fail('CHECKPOINT_SPEND_RESTORE_CONFLICT');
  }
  for (const [participant, store] of [['credits', credits], ['earnings', earnings]]) {
    for (const [owner, record] of Object.entries(store)) for (const [id, receipt] of Object.entries(record?.money_receipts || {})) {
      if (!receipt || receipt.projection_id !== id) fail('CHECKPOINT_RECEIPT_WITHOUT_INTENT');
      const projection = snapshot.projections[id];
      if (projection) {
        if (projection.digest !== receipt.digest || projection.owner !== owner || projection.participant !== participant) fail('CHECKPOINT_PROJECTION_RECEIPT_CONFLICT');
        if (projection.effect === 'restore_principal') {
          const original = snapshot.projections[projection.payload.originalProjectionId];
          const originalReceipt = credits[owner]?.money_receipts?.[original?.id];
          if (!original || original.state !== 'superseded' || original.supersededBy !== id || original.owner !== owner || original.sourceId !== projection.sourceId || original.digest !== projection.payload.originalDigest || typeof receipt.applied !== 'boolean' || receipt.applied !== !!originalReceipt) fail('CHECKPOINT_PROJECTION_RECEIPT_CONFLICT');
        }
        if (projection.receipt && p.digestJSON(projection.receipt) !== p.digestJSON(receipt)) fail('CHECKPOINT_PROJECTION_RECEIPT_CONFLICT');
        continue;
      }
      const spend = snapshot.spends[id] || (id.endsWith(':restore') ? snapshot.spends[id.slice(0,-8)] : null);
      if (participant !== 'credits' || !spend || spend.accountId !== owner || spend.digest !== receipt.digest || ![spend.id,spend.id+':restore'].includes(id)) fail('CHECKPOINT_RECEIPT_WITHOUT_INTENT');
    }
  }
  const unresolved=[];
  for(const operation of reader.values(snapshot.operations))if(!['settled','failed','canceled','requote_required'].includes(operation.state))unresolved.push({id:operation.id,digest:p.digestJSON(operation)});
  const receiptHighwater=[],pendingSpends=[],pendingProjections=[];for(const [id,row]of reader.entries(snapshot.projections)){receiptHighwater.push(id);if(row.state==='pending')pendingProjections.push({id,digest:row.digest});}for(const spend of reader.values(snapshot.spends))if(spend.state==='prepared')pendingSpends.push({id:spend.id,digest:spend.digest});
  return {epoch,snapshot:{schema:1,revision:snapshot.revision,sequence:snapshot.sequence,lifecycle:{compaction_epoch:snapshot.lifecycle.compaction_epoch||0}},unresolved,receiptHighwater,pendingSpends,pendingProjections};
}
function writeFile(file, raw) {
  const fd = fs.openSync(file, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, raw);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  p.syncDirectory(path.dirname(file));
}
function copyTree(source, destination, tree, {
  resume = false, afterStep
}
= {
}) {
  for (const rel of tree.directories) {
    if (resume && fs.existsSync(path.join(destination, rel))) e.confined(path.join(destination, rel), 'directory');
    else fs.mkdirSync(path.join(destination, rel), {
      mode: 0o700
    });
    p.syncDirectory(path.dirname(path.join(destination, rel)));
  }
  for (const row of tree.files) {
    const sourceFile = e.confined(path.join(source, row.path), 'file'), raw = fs.readFileSync(sourceFile);
    if (raw.length !== row.bytes || hash(raw) !== row.sha256) fail('CHECKPOINT_SOURCE_CHANGED');
    const target = path.join(destination, row.path);
    if (resume && fs.existsSync(target)) {
      e.confined(target, 'file');
      if (fs.lstatSync(target).nlink !== 1) fail('RESTORE_TARGET_HARDLINK');
      if (hash(fs.readFileSync(target)) !== row.sha256) {
        fs.unlinkSync(target);
        writeFile(target, raw);
      }
    } else writeFile(target, raw);
    afterStep?.(row.path);
  }
  for (const rel of[... tree.directories].reverse()) p.syncDirectory(path.join(destination, rel));
  p.syncDirectory(destination);
}
function withCheckpointContents(directory, manifest, fn) {
  const temporary=fs.realpathSync(fs.mkdtempSync(path.join(require('os').tmpdir(),'auxilo-checkpoint-read-')));
  try {extractCheckpointArchive(path.join(directory,ARCHIVE),temporary,manifest,{durable:false});return fn(temporary);}
  finally {fs.rmSync(temporary,{recursive:true,force:true});}
}
// Validate descriptive physical equivalence without granting participant authority.
function validateCheckpointCompensationEarnings(manifest) {
  if (!Object.hasOwn(manifest, 'atomic_capacity_cut')) return true;
  const cut=manifest.atomic_capacity_cut, proof=manifest.first_failure_control;
  const bad=()=>fail('CHECKPOINT_COMPENSATION_EARNINGS_INVALID');
  const exact=(v,keys)=>v&&Object.getPrototypeOf(v)===Object.prototype&&Reflect.ownKeys(v).length===keys.length&&keys.every(k=>{const d=Object.getOwnPropertyDescriptor(v,k);return d?.enumerable&&Object.hasOwn(d,'value');});
  const hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v), integer=v=>Number.isSafeInteger(v)&&v>=0, key=v=>typeof v==='string'&&v.length>0&&!v.includes('\0')&&Buffer.byteLength(v)<=256;
  if (!cut || !Object.hasOwn(cut,'compensationEarnings')) bad();
  const entry=cut.compensationEarnings;
  if (entry===null) {if(proof?.state==='compensation_requested')bad();return true;}
  if(!exact(entry,['schema','participant','relativePath','compensationDigest','spendId','spendDigest','walId','walPayloadDigest','originalIdentity','sha256','bytes','sourceIdentity','predecessorEquivalenceDigest'])||entry.schema!==1||entry.participant!=='earnings'||typeof manifest.financial_epoch!=='string'||entry.relativePath!=='financial-epochs/'+manifest.financial_epoch+'/earnings.json'||!['compensationDigest','spendDigest','sha256'].every(k=>hex(entry[k]))||!key(entry.spendId)||!integer(entry.bytes))bad();
  if(entry.walId===null?entry.walPayloadDigest!==null:!key(entry.walId)||!hex(entry.walPayloadDigest))bad();
  const original=entry.originalIdentity, source=entry.sourceIdentity;
  if(!exact(original,['dev','ino'])||!integer(original.dev)||!integer(original.ino)||!exact(source,['dev','ino','uid','mode','nlink'])||!['dev','ino','uid'].every(k=>integer(source[k]))||source.mode!==0o600||source.nlink!==1)bad();
  if(entry.predecessorEquivalenceDigest===null?(source.dev!==original.dev||source.ino!==original.ino):!hex(entry.predecessorEquivalenceDigest))bad();
  const c=proof?.compensation;
  if(proof?.state!=='compensation_requested'||!c||entry.compensationDigest!==p.digestJSON(c)||entry.spendId!==c.spendId||entry.spendDigest!==c.spendDigest||entry.walId!==c.walId||entry.walPayloadDigest!==c.walPayloadDigest||entry.sha256!==c.earningsBeforeDigest||p.digestJSON(original)!==p.digestJSON(c.earningsFileIdentity))bad();
  const rows=Array.isArray(manifest.files)?manifest.files.filter(row=>row.path===entry.relativePath):[];
  if(rows.length!==1||rows[0].sha256!==entry.sha256||rows[0].bytes!==entry.bytes)bad();
  return true;
}
function validateCheckpointEnvelope(directory,{now=Date.now(),authoritativeLifecycle,allowExpired=false}={}) {
  directory=e.confined(directory,'directory');
  const manifest=p.readJSONStrict(e.confined(path.join(directory,MANIFEST),'file'));
  if(manifest.schema_version!==2 || manifest.checksum!==e.seal(manifest).checksum || !Array.isArray(manifest.files) || !Array.isArray(manifest.directories) || !/^[a-f0-9]{40}$/.test(manifest.source_sha||'') || manifest.archive?.file!==ARCHIVE || manifest.archive?.format!=='auxilo-money-cut-v2')fail('CHECKPOINT_MANIFEST_INVALID');
  if((!allowExpired && Date.parse(manifest.expires_at)<=now) || !Number.isFinite(Date.parse(manifest.expires_at)) || Date.parse(manifest.expires_at)>Date.parse(manifest.cut_at)+7*l.DAY)fail('CHECKPOINT_EXPIRED');
  if(fs.readdirSync(directory).sort().join()!==[ARCHIVE,MANIFEST].sort().join())fail('CHECKPOINT_HASH_MISMATCH');
  if(manifest.first_failure_control){const proof=manifest.first_failure_control,row=manifest.files.find(r=>r.path==='financial-epochs/'+manifest.financial_epoch+'/'+require('./money-failure-control').FILE);if(!row||row.bytes!==8192||row.sha256!==proof.fileDigest||!Number.isSafeInteger(proof.sequence)||!/^[a-f0-9]{64}$/.test(proof.slotDigest||''))fail('CHECKPOINT_FAILURE_CONTROL_CHANGED');}
  validateCheckpointCompensationEarnings(manifest);
  const archive=scanCheckpointArchive(path.join(directory,ARCHIVE),manifest);
  if(archive.sha256!==manifest.archive.sha256 || archive.archive_bytes!==manifest.archive.archive_bytes)fail('CHECKPOINT_HASH_MISMATCH');

  if(authoritativeLifecycle)validateRestoreAuthority(manifest,authoritativeLifecycle);
  return manifest;
}
function validateCheckpoint(directory,options={}){
 const manifest=validateCheckpointEnvelope(directory,options);
 withCheckpointContents(directory,manifest,root=>{const {epoch,snapshot}=semanticSnapshot(root,undefined,{manifest});if(epoch.epoch_id!==manifest.financial_epoch||epoch.binding_digest!==manifest.binding_digest||snapshot.revision!==manifest.journal_revision||snapshot.sequence!==manifest.journal_sequence)fail('CHECKPOINT_SEMANTIC_MISMATCH');});return manifest;
}
// Acknowledge the existing durable local debit receipt. This
// never performs a participant write, calls a provider, or replays a debit.
function checkpointFailureControl({epoch,writer,store}) {
  const control=require('./money-failure-control'),file=path.join(epoch.financial_dir,control.FILE),root=store.getCapacityRecord('capacity:root');
  if(!root?.failureControl){if(root?.profile?.grouped?.commitProtocol==='single_sql_v1'||fs.existsSync(file))fail('CHECKPOINT_FAILURE_CONTROL_UNBOUND');return null;}
  const proof=control.openFailureControl({epoch,writer,store}).checkpointProof();
  if(proof.compensation?.walId){
    const id=proof.compensation.walId;if(typeof id!=='string'||!/^[-A-Za-z0-9_]+$/.test(id))fail('CHECKPOINT_COMPENSATION_WAL_REQUIRED');
    const files=['.wal.json','.compensation.json'].map(suffix=>path.join(e.pathFor('wal',epoch),id+suffix)).filter(file=>fs.existsSync(file));
    if(files.length!==1)fail('CHECKPOINT_COMPENSATION_WAL_REQUIRED');
    const file=files[0],st=fs.lstatSync(file);if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1)fail('CHECKPOINT_COMPENSATION_WAL_REQUIRED');
    const entry=p.readJSONStrict(file);if(entry.id!==id||p.digestJSON(entry.payload)!==proof.compensation.walPayloadDigest)fail('CHECKPOINT_COMPENSATION_WAL_REQUIRED');
  }
  return proof;
}
async function acknowledgeAppliedCheckpointSpends({epoch,writer,coordinator}) {
  const matchesIntent=spend=>spend?.intent&&spend.id===spend.intent.id&&spend.accountId===spend.intent.accountId&&p.digestJSON(spend.draws)===p.digestJSON(spend.intent.draws)&&spend.digest===p.digestJSON(spend.intent);
  const candidates=await coordinator.maintenanceLease(({store})=>{
    writer.assertOwned();
    if(store.epoch.binding_digest!==epoch.binding_digest||store.epoch.legacy_root!==epoch.legacy_root)fail('CHECKPOINT_STORE_IDENTITY');
    const failureProof=checkpointFailureControl({epoch,writer,store});
    if(failureProof&&failureProof.state!=='idle')return []; // Preserve pending recovery before any ACK.
    let page=store.listSpends({state:'prepared',limit:100}),credits;
    const found=[];
    while(page.items.length){
      if(!credits)credits=p.readJSONStrict(e.pathFor('credits',epoch));
      for(const spend of page.items){
        const receipt=credits[spend.accountId]?.money_receipts?.[spend.id];
        if(!receipt)continue;
        if(!matchesIntent(spend)||receipt.projection_id!==spend.id||receipt.digest!==spend.digest||credits[spend.accountId].money_receipts[spend.id+':restore'])fail('CHECKPOINT_SPEND_RECEIPT_CONFLICT');
        found.push({id:spend.id,accountId:spend.accountId,digest:spend.digest,receiptDigest:p.digestJSON(receipt)});
      }
      if(!page.nextCursor)break;
      page=store.listSpends({state:'prepared',after:page.nextCursor,limit:100});
    }
    // Before any mutation, retain the full existing semantic/owner/receipt proof.
    // The no-pending-receipt path does not add a second history validation.
    if(found.length)semanticSnapshot(epoch.legacy_root,store);
    return found;
  });
  if(!candidates.length)return;
  if(typeof coordinator.withMoneyControl!=='function')fail('CHECKPOINT_LOCAL_ACK_CONTEXT_REQUIRED');
  const accounts=[...new Set(candidates.map(row=>row.accountId))].sort();
  await coordinator.withMoneyControl({kind:'checkpoint-local-receipt-ack',accounts,credits:accounts},ctx=>{
    writer.assertOwned();
    if(ctx.epoch.binding_digest!==epoch.binding_digest||ctx.epoch.legacy_root!==epoch.legacy_root)fail('CHECKPOINT_STORE_IDENTITY');
    const credits=p.readJSONStrict(e.pathFor('credits',epoch));
    for(const candidate of candidates){
      const spend=ctx.getSpend(candidate.id),receipt=credits[candidate.accountId]?.money_receipts?.[candidate.id];
      if(!spend||spend.accountId!==candidate.accountId||spend.digest!==candidate.digest||!matchesIntent(spend)||receipt?.projection_id!==candidate.id||receipt?.digest!==candidate.digest||p.digestJSON(receipt)!==candidate.receiptDigest)fail('CHECKPOINT_SPEND_RECEIPT_CONFLICT');
      // A concurrent legitimate acknowledgement/return wins; never replay it.
      if(spend.state!=='prepared')continue;
      if(credits[candidate.accountId].money_receipts[candidate.id+':restore'])fail('CHECKPOINT_SPEND_RESTORE_CONFLICT');
      ctx.ackSpend({id:spend.id,digest:spend.digest,receipt});
    }
  });
}
async function createMoneyCheckpoint( {
  epoch, writer, coordinator, sourceSha, lifecycleControl, clock = Date.now, afterStep, onStage
}
= {
}) {
  assertMoneyWriter(writer, {
    root: epoch.legacy_root
  });
  if (! /^[a-f0-9]{40}$/.test(sourceSha || '')) fail('CHECKPOINT_SOURCE_SHA_REQUIRED');
  if (! coordinator?.maintenanceLease) fail('CHECKPOINT_MAINTENANCE_LEASE_REQUIRED');
  l.assertLifecycleForCheckpoint(lifecycleControl,clock());
  await acknowledgeAppliedCheckpointSpends({epoch,writer,coordinator});
  return coordinator.maintenanceLease(async ({store}) => {
    const timings={},started=performance.now();let previous=started;
    const mark=name=>{const now=performance.now();timings[name]=now-previous;previous=now;onStage?.({stage:name,ms:timings[name]});};
    writer.assertOwned();
    const now = clock();
    l.assertLifecycleForCheckpoint(lifecycleControl, now);
    const {
      epoch: current, snapshot, unresolved, receiptHighwater, pendingSpends, pendingProjections,stageAuthority,compensationStage
    }
    = semanticSnapshot(epoch.legacy_root,store,{writer});
    mark('semantic');
    const verifiedPadding=new Map();
    if (store.getCapacityRecord('capacity:root')) {
      const capacity=require('./money-capacity'),profile=e.requireEpoch(current).control.financial_evidence?.capacity_profile;
      const proof=capacity.verifyCapacityReserve({epoch:current,writer,store,profile});
      for (const [name,identity,bytes] of [[capacity.RESERVE_FILE,proof.root.completion,proof.availableBytes],[capacity.PUBLICATION_FILE,proof.root.publication,profile.publicationBytes]]) {
        verifiedPadding.set(path.relative(epoch.legacy_root,path.join(current.financial_dir,name)),{dev:identity.dev,ino:identity.ino,bytes});
      }
    }
    const atomicProof=require('./money-atomic-restore').checkpointAtomicCut({epoch:current,writer,store});
    if(atomicProof)for(const row of atomicProof.padding)verifiedPadding.set(path.relative(epoch.legacy_root,path.join(current.financial_dir,row.relativePath)),{dev:row.dev,ino:row.ino,bytes:row.bytes});
    const failureProof=checkpointFailureControl({epoch:current,writer,store});
    mark('capacity');
    store.closeForMaintenance();
    mark('database_close');
    try {
    const database=e.pathFor('money_database',current);
    if(['-journal','-wal','-shm'].some(suffix=>fs.existsSync(database+suffix)))fail('CHECKPOINT_DATABASE_NOT_CLEAN');
    const tree = listTree(epoch.legacy_root,{verifiedPadding,hashFiles:false,stageAuthority});
    mark('tree');
    const id = crypto.randomUUID(), parent = path.join(epoch.legacy_root, '.money-checkpoints'), stage = checkpointDirectory(epoch.legacy_root,
    id) + '.tmp', final = checkpointDirectory(epoch.legacy_root, id);
    if (! fs.existsSync(parent)) {
      fs.mkdirSync(parent, {
        mode: 0o700
      });
      p.syncDirectory(epoch.legacy_root);
    }
    e.confined(parent, 'directory');
    if (fs.readdirSync(parent).some(n => n.endsWith('.tmp'))) fail('CHECKPOINT_UNCERTAIN_STAGE');
    fs.mkdirSync(stage, {
      mode: 0o700
    });
    p.syncDirectory(parent);
    mark('stage_durability');
    const archive = packCheckpointTree(epoch.legacy_root,path.join(stage,ARCHIVE),tree,{onStage:mark,[HASH_FROM_SOURCE]:true});
    if(failureProof){const row=tree.files.find(r=>r.path===path.relative(epoch.legacy_root,path.join(current.financial_dir,require('./money-failure-control').FILE)));if(!row||row.bytes!==8192||row.sha256!==failureProof.fileDigest)fail('CHECKPOINT_FAILURE_CONTROL_CHANGED');}
    afterStep?.('files:durable');
    if(compensationStage){const fresh=require('./money-atomic-restore').inspectCheckpointEpoch({root:epoch.legacy_root,sourceEpoch:current,writer,inspect:(_e,_r,candidate)=>candidate});if(p.digestJSON(fresh)!==p.digestJSON(compensationStage)||!tree.files.some(r=>r.path===fresh.relativePath&&r.sha256===fresh.sha256&&r.bytes===fresh.bytes))fail('CHECKPOINT_STAGE_CHANGED');}
    const manifest = e.seal( {
      schema_version: 2, archive, checkpoint_id: id, cut_at: new Date(now).toISOString(), expires_at: l.copyExpiry( {
        cut_at: now, inherited_expiry: lifecycleControl.inherited_copy_expiry
      }), rule_version: lifecycleControl.rule_version, deletion_barrier: lifecycleControl.deletion_barrier, seals: lifecycleControl.seals,
      compaction_epoch: snapshot.lifecycle.compaction_epoch || 0, source_sha: sourceSha, financial_epoch: current.epoch_id,
      binding_digest: current.binding_digest, boot_generation: current.activation_revision, journal_schema: 2, database_sha256: tree.files.find(row=>row.path===path.relative(epoch.legacy_root,database)).sha256,
      journal_revision: snapshot.revision, journal_sequence: snapshot.sequence, required_participants: Object.keys(e.PARTICIPANTS),
      ...(failureProof?{first_failure_control:failureProof}:{}),...(compensationStage?{compensation_stage:{relativePath:compensationStage.relativePath,sha256:compensationStage.sha256,bytes:compensationStage.bytes}}:{}),...(atomicProof?{atomic_capacity_cut:atomicProof.cut}:{}),
      unresolved_operations: unresolved, pending_spends:pendingSpends, pending_projections:pendingProjections, receipt_highwater: receiptHighwater.sort(), ... tree
    });
    const manifestBytes=Buffer.from(p.canonicalJSON(manifest) + '\n');
    mark('manifest');
    writeFile(path.join(stage, MANIFEST), manifestBytes);
    mark('manifest_durability');
    afterStep?.('manifest:durable');
    fs.renameSync(stage, final);
    p.syncDirectory(parent);
    afterStep?.('checkpoint:published');
    mark('publish_durability');
    return {
      checkpoint_id: id, revision: snapshot.revision, digest: manifest.checksum, timings
    };
    } finally {store.reopenAfterMaintenance();mark('database_reopen');timings.total=performance.now()-started;}
  });
}
function validateRestoreAuthority(manifest, control) {
  l.validateLifecycleControl(control);
  if (control.deletion_barrier.sequence < manifest.deletion_barrier.sequence) fail('RESTORE_DELETION_BARRIER_REGRESSION');
  if (control.deletion_barrier.sequence === manifest.deletion_barrier.sequence && control.deletion_barrier.hash !== manifest.deletion_barrier.hash) fail('RESTORE_DELETION_BARRIER_CONFLICT');
  for (const seal of manifest.seals) {
    const current = control.seals.find(s => s.namespace === seal.namespace);
    if (! current || current.closed_epoch < seal.closed_epoch || Date.parse(current.source_created_through) < Date.parse(seal.source_created_through)) fail('RESTORE_SOURCE_SEAL_REGRESSION');
  }
  return true;
}
function restoreCheckpoint( {
  checkpointDir, targetRoot, writer, authoritativeLifecycle, expectedCheckpointDigest, now = Date.now(), resume = false, afterStep
}
= {
}) {
  l.validateLifecycleControl(authoritativeLifecycle);
  const manifest = validateCheckpoint(checkpointDir, {
    now, authoritativeLifecycle
  });
  if(manifest.atomic_capacity_cut&&expectedCheckpointDigest!==manifest.checksum)fail('RESTORE_TRUSTED_CHECKPOINT_REQUIRED');
  targetRoot = path.resolve(targetRoot);
  if (targetRoot === path.resolve(checkpointDir) || targetRoot.startsWith(path.resolve(checkpointDir) + path.sep)) fail('RESTORE_TARGET_OVERLAP');
  const priorBarrier = resume && fs.existsSync(path.join(targetRoot, RESTORE)) ? p.readJSONStrict(e.confined(path.join(targetRoot,
  RESTORE), 'file')): null;
  if (resume &&(! priorBarrier || priorBarrier.checksum !== e.seal(priorBarrier).checksum || priorBarrier.state !== 'installing' || priorBarrier.checkpoint_digest !== manifest.checksum || p.digestJSON(priorBarrier.deletion_barrier) !== p.digestJSON(authoritativeLifecycle.deletion_barrier))) fail('RESTORE_RESUME_BINDING_REQUIRED');
  if (! resume && fs.existsSync(targetRoot) && fs.readdirSync(targetRoot).some(n => n !== '.money-writer.lock')) fail('RESTORE_EMPTY_TARGET_REQUIRED');
  if (resume) {
    const allowed = new Set([... manifest.files.map(r => r.path), ... manifest.directories, RESTORE, '.money-writer.lock']);
    const inspect =(dir, prefix = '') => {
      for (const name of fs.readdirSync(dir)) {
        const relative = prefix ? prefix + '/' + name: name;
        if (! allowed.has(relative)) fail('RESTORE_UNEXPECTED_TARGET');
        const file = path.join(dir, name), st = fs.lstatSync(file);
        if (st.isSymbolicLink() ||(! st.isDirectory() && ! st.isFile())) fail('RESTORE_TARGET_SPECIAL_FILE');
        if (st.isDirectory()) inspect(file, relative);
      }
    };
    inspect(targetRoot);
  }
  if (! fs.existsSync(targetRoot)) {
    fs.mkdirSync(targetRoot, {
      mode: 0o700
    });
    p.syncDirectory(path.dirname(targetRoot));
  }
  assertMoneyWriter(writer, {
    root: targetRoot
  });
  const barrier = e.seal( {
    schema_version: 1, state: 'installing', checkpoint_id: manifest.checkpoint_id, checkpoint_digest: manifest.checksum,
    cut_at: manifest.cut_at, inherited_expiry: manifest.expires_at, deletion_barrier: authoritativeLifecycle.deletion_barrier,
    seals: authoritativeLifecycle.seals, capacity_recreation_required: true, provider_reconciliation_complete: false, unresolved_operations: manifest.unresolved_operations
  });
  p.writeJSONAtomic(path.join(targetRoot, RESTORE), barrier);
  withCheckpointContents(checkpointDir,manifest,contents=>copyTree(contents, targetRoot, {
    files: manifest.files.filter(r => r.path !== RESTORE), directories: manifest.directories
  }, {resume,afterStep}));
  const binding = e.validateBinding(p.readJSONStrict(path.join(targetRoot, e.BINDING_FILE))), financialDir = e.confined(path.join(targetRoot,
  'financial-epochs', binding.identity.epoch_id), 'directory'), control = e.validateControl(p.readJSONStrict(path.join(financialDir,
  e.CONTROL_FILE)), binding);
  const next = {
    ... control, generation: control.generation + 1, state: 'reconcile_only', capabilities: Object.fromEntries(e.CAPABILITIES.map(k =>[k,
    k === 'reconcile'])), evidence: {
      ... control.evidence, reconcile: manifest.checksum
    }
  };
  p.writeJSONAtomic(path.join(financialDir, e.CONTROL_FILE), e.seal(next));
  const changed = authoritativeLifecycle.deletion_barrier.sequence > manifest.deletion_barrier.sequence;
  const lifecyclePlan = l.planLifecycle( {
    records: authoritativeLifecycle.records, holds: authoritativeLifecycle.holds, rules: authoritativeLifecycle.rules, now,
    ruleVersion: authoritativeLifecycle.rule_version
  });
  const needsLifecycle = changed || ! lifecyclePlan.ready || Object.values(lifecyclePlan.decisions).some(x => x.action === 'purge');
  const final = e.seal( {
    ... barrier, state: 'reconcile_only', lifecycle_reapplication_required: needsLifecycle, provider_reconciliation_complete: false
  });
  p.writeJSONAtomic(path.join(targetRoot, RESTORE), final);
  if(manifest.atomic_capacity_cut)require('./money-atomic-restore').inspectCheckpointEpoch({root:targetRoot,manifest,inspect:()=>true});
  else e.resolveRuntimeEpoch({root:targetRoot});
  return {
    state: 'reconcile_only', checkpoint_id: manifest.checkpoint_id, capacity_recreation_required: true, lifecycle_reapplication_required: needsLifecycle
  };
}
// Explicit stopped-writer stage. Financial/provider/deletion admission barriers
// remain intact; this only records verified recreation of physical padding.
async function restoreCheckpointCapacity({targetRoot,writer,expectedBarrierDigest,executionApprovalRef,afterStep,...atomicOptions}={}) {
  if(atomicOptions.checkpointDir||atomicOptions.restoreAllowance)return require('./money-atomic-restore').restoreAtomicCheckpointCapacity({targetRoot,writer,expectedBarrierDigest,executionApprovalRef,afterStep,...atomicOptions});
  if(typeof executionApprovalRef!=='string'||!executionApprovalRef.trim()||executionApprovalRef.length>512)fail('RESTORE_CAPACITY_APPROVAL_REQUIRED');
  if(!path.isAbsolute(targetRoot||''))fail('RESTORE_CAPACITY_ROOT_REQUIRED');
  assertMoneyWriter(writer,{root:targetRoot});
  const file=e.confined(path.join(targetRoot,RESTORE),'file'),barrier=p.readJSONStrict(file);
  if(!/^[a-f0-9]{64}$/.test(expectedBarrierDigest||'')||barrier.checksum!==e.seal(barrier).checksum||barrier.checksum!==expectedBarrierDigest||barrier.state!=='reconcile_only'||barrier.capacity_recreation_required!==true)fail('RESTORE_CAPACITY_BARRIER_CONFLICT');
  const epoch=e.resolveRuntimeEpoch({root:targetRoot,writer}),{control}=e.requireEpoch(epoch);
  if(control.state!=='reconcile_only'||Object.entries(control.capabilities).some(([key,value])=>key!=='reconcile'&&value))fail('RESTORE_CAPACITY_RECONCILE_ONLY_REQUIRED');
  const capacity=require('./money-capacity'),profile=control.financial_evidence?.capacity_profile;
  capacity.validateCapacityProfile(profile,epoch);
  const store=require('./money-control-store').openMoneyStore({epoch,writer});
  try {
    const result=await capacity.recreateCapacityReserve({epoch,writer,store,profile});
    if(result?.verified!==true||result.requiresRebind===true||result.admissionState!=='reconcile_only')fail('RESTORE_CAPACITY_REBIND_REQUIRED');
    const proof=capacity.verifyCapacityReserve({epoch,writer,store,profile});
    afterStep?.('capacity:verified');writer.assertOwned();
    if(p.readJSONStrict(file).checksum!==expectedBarrierDigest)fail('RESTORE_CAPACITY_BARRIER_CONFLICT');
    const next=e.seal({...barrier,capacity_recreation_required:false,capacity_recreation:{profile_sha256:p.digestJSON(profile),generation:proof.generation,restore_generation:proof.root.restoreGeneration,sql_revision:store.readMetadata().revision,execution_approval_ref:executionApprovalRef}});
    p.writeJSONAtomic(file,next);e.invalidateEpochRuntime(targetRoot);
    return{state:next.state,checkpoint_id:barrier.checkpoint_id,capacity_recreation_required:false,barrier_digest:next.checksum};
  } finally {store.close();}
}
function startMoneyCheckpointServer(options) {
  const {
    epoch, writer
  }
  = options;
  assertMoneyWriter(writer, {
    root: epoch.legacy_root
  });
  const socket = path.join(epoch.legacy_root, '.money-control.sock');
  if (fs.existsSync(socket)) {
    const st = fs.lstatSync(socket);
    if (! st.isSocket() || st.uid !== process.getuid()) fail('CHECKPOINT_SOCKET_CONFLICT');
    fs.unlinkSync(socket);
    p.syncDirectory(epoch.legacy_root);
  }
  let busy = false;
  const server = net.createServer(connection => {
    let raw = Buffer.alloc(0), handled = false;
    connection.setTimeout(10000, () => connection.destroy());
    connection.on('error', () => {
    });
    connection.on('data', chunk => {
      if (handled) return;
      raw = Buffer.concat([raw, chunk]);
      if (raw.length > 1024) {
        handled = true;
        connection.end(JSON.stringify( {
          error: 'CHECKPOINT_REQUEST_TOO_LARGE'
        }) + '\n');
        return;
      }
      if (! raw.includes(10)) return;
      handled = true;
      let request;
      try {
        request = JSON.parse(raw.toString().trim());
        if (Object.keys(request).sort().join() !== 'op,request_id' || request.op !== 'checkpoint' || ! /^[-a-zA-Z0-9_]{1,80}$/.test(request.request_id)) fail('CHECKPOINT_REQUEST_INVALID');
        if (busy) fail('CHECKPOINT_BUSY');
        busy = true;
      } catch (error) {
        connection.end(JSON.stringify( {
          error: error.code || 'CHECKPOINT_REQUEST_INVALID'
        }) + '\n');
        return;
      }
      createMoneyCheckpoint( {
        ... options, lifecycleControl: typeof options.lifecycleControl === 'function' ? options.lifecycleControl(): options.lifecycleControl
      }).then(result => connection.end(JSON.stringify(result) + '\n'), error => connection.end(JSON.stringify( {
        error: error.code || 'CHECKPOINT_FAILED'
      }) + '\n')).finally(() => {
        busy = false;
      });
    });
  });
  server.listen(socket, () => fs.chmodSync(socket, 0o600));
  return server;
}
function requestMoneyCheckpoint( {
  root, requestId = crypto.randomUUID(), timeout = 10000
}
= {
}) {
  return new Promise((resolve, reject) => {
    const socket = path.join(root, '.money-control.sock'), st = fs.lstatSync(socket);
    if (! st.isSocket() ||(st.mode & 0o777) !== 0o600 || st.uid !== process.getuid()) fail('CHECKPOINT_SOCKET_INVALID');
    const connection = net.createConnection(socket);
    let raw = '';
    connection.setTimeout(timeout, () => connection.destroy(Object.assign(Error('CHECKPOINT_TIMEOUT'), {
      code: 'CHECKPOINT_TIMEOUT'
    })));
    connection.on('error', reject);
    connection.on('connect', () => connection.write(JSON.stringify( {
      op: 'checkpoint', request_id: requestId
    }) + '\n'));
    connection.on('data', chunk => {
      raw += chunk;
      if (raw.length > 4096) connection.destroy(Error('CHECKPOINT_RESPONSE_INVALID'));
    });
    connection.on('end', () => {
      try {
        const result = JSON.parse(raw);
        if (result.error) fail(result.error);
        const dir = checkpointDirectory(root, result.checkpoint_id), manifest = validateCheckpoint(dir);
        if (manifest.checksum !== result.digest || manifest.journal_revision !== result.revision) fail('CHECKPOINT_RESPONSE_MISMATCH');
        resolve( {
          ... result, directory: dir, manifest
        });
      } catch (error) {
        reject(error);
      }
    });
  });
}
module.exports = {
  checkpointFailureControl, MAX_BACKUP_BYTES, checkpointBackupStream, unpackCheckpointEnvelope, ARCHIVE, withCheckpointContents, packCheckpointTree, scanCheckpointArchive, extractCheckpointArchive, MANIFEST, RESTORE, LIMITS, checkpointDirectory, listTree, semanticSnapshot, validateCheckpoint, createMoneyCheckpoint,
  restoreCheckpoint, restoreCheckpointCapacity, startMoneyCheckpointServer, requestMoneyCheckpoint, validateRestoreAuthority
};

module.exports.validateCheckpointEnvelope=validateCheckpointEnvelope;

module.exports.validateCheckpointCompensationEarnings=validateCheckpointCompensationEarnings;
