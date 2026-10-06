'use strict';
const {test,after}=require('node:test'),assert=require('node:assert/strict');
const fs=require('fs'),os=require('os'),path=require('path'),vm=require('vm');
const {digestJSON}=require('../lib/stripe-transfer-persistence');
const control=require('../lib/stripe-migration-controls'),journal=require('../lib/stripe-migration-journal');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'migration-boot-'));after(()=>fs.rmSync(temp,{recursive:true,force:true}));
const source=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8');
const guard=source.slice(source.indexOf('// A partial offline migration'),source.indexOf('// D0: authoritative primary only.'));
assert.ok(guard.includes('bootMigrationControl'),'production boot guard extracted');
function fixture(){const dir=fs.mkdtempSync(path.join(temp,'case-'));return{file:path.join(dir,'control.json'),armedFile:path.join(dir,'armed.json'),journalFile:path.join(dir,'journal.json')};}
function run(options){const ctx={writes:0,require(name){if(name.includes('journal'))return{assertMigrationJournalComplete:()=>journal.assertMigrationJournalComplete({file:options.journalFile})};if(name.includes('controls'))return{getMigrationControl:()=>control.getMigrationControl(options)};throw Error(name);},fatalFinancialStorage(error){throw error;}};let error;try{vm.runInNewContext(guard+'\nwrites++;',ctx);}catch(e){error=e;}return{writes:ctx.writes,error};}
test('production boot guard preserves absent-marker legacy startup',()=>{const r=run(fixture());assert.equal(r.error,undefined);assert.equal(r.writes,1);});
test('corrupt armed state stops before financial boot writers',()=>{const f=fixture();fs.writeFileSync(f.armedFile,'{}');fs.writeFileSync(f.file,'{');const r=run(f);assert.ok(r.error);assert.equal(r.writes,0);});
for(const state of ['applying','completed'])test(state+' journal without matched arming stops financial boot writers',()=>{const f=fixture();const row={schema_version:1,journal_id:'fixture',checkpoint_id:'fixture',manifest_sha256:'a'.repeat(64),approval_ref:'fixture',state,entries:[]};fs.writeFileSync(f.journalFile,JSON.stringify({...row,checksum:digestJSON(row)}));const r=run(f);assert.ok(r.error);assert.equal(r.writes,0);});
