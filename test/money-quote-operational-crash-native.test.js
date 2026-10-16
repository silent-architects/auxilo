"use strict";
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawnSync}=require('node:child_process');
const {createFixture}=require('./helpers/money-quote-operational-fixture');
const native=(name,fn)=>test(name,{skip:process.platform!=='linux'?'requires actual patched Linux SQLite runtime':false},fn);
const phases=['atomic-intent','atomic-publication-release','atomic-completion-release','workspace-prepared','after-financial-rows','after-metadata','sql-after-commit','workspace-finished','atomic-idle'];
const phase=process.env.QUOTE_CRASH_PHASE,mode=process.env.QUOTE_CRASH_MODE;
if(phase)native('abrupt quote child',async t=>{const f=await createFixture(t,{dir:process.env.QUOTE_CRASH_DIR,keep:true,phase,liquidity:mode==='mixed'}),quote=mode==='mixed'?await f.quote():null;fs.writeFileSync(path.join(f.dir,'before.json'),JSON.stringify({revision:f.store.readMetadata().revision,aux:f.store.exportDatabaseAuxiliary(),quote}));f.arm();if(mode==='mixed')await f.accept(quote);else await f.quote();throw Error('requested crash boundary was not reached');});
else for(const mode of ['pure','mixed'])for(const phase of phases)native(mode+' quote process exit and cold recovery at '+phase,async t=>{
 const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'quote-killed-')));let f;t.after(()=>{if(!f)fs.rmSync(dir,{recursive:true,force:true});});
 const child=spawnSync(process.execPath,[__filename],{env:{...process.env,QUOTE_CRASH_PHASE:phase,QUOTE_CRASH_MODE:mode,QUOTE_CRASH_DIR:dir},encoding:'utf8',timeout:30000});assert.equal(child.status,73,child.stdout+child.stderr);
 const before=JSON.parse(fs.readFileSync(path.join(dir,'before.json')));f=await createFixture(t,{dir,reopen:true});const committed=['sql-after-commit','workspace-finished','atomic-idle'].includes(phase);assert.equal(f.router.recover().state,'ready');
 assert.equal(f.store.readMetadata().revision,before.revision+Number(committed));const after=f.store.exportDatabaseAuxiliary();assert.equal(after.auditSeeds.length,before.aux.auditSeeds.length+Number(committed&&mode==='mixed'));
 if(!committed||mode==='pure')assert.deepEqual(after.capacitySeeds,before.aux.capacitySeeds);
 assert.equal(f.store.getOperationalControl('quotes').generation,(mode==='mixed'?1:0)+Number(committed));
 if(mode==='mixed'){assert.equal(!!f.store.getOperation('return'),committed);if(committed){assert.deepEqual(f.store.getOperation('return').acceptedQuote,before.quote);assert.equal(f.store.getQuote(before.quote.id),undefined);}else assert.equal(f.store.getQuote(before.quote.id).hash,before.quote.hash);}
 f.store.validateDatabase({full:true});assert.ok(f.manager.status());
});
