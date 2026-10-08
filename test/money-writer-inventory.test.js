'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const proxyquire=require('proxyquire').noCallThru().noPreserveCache();
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'emfr-writer-inventory-'));
test.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
const inventory=[['credits','credits'],['stripe','purchases'],['purchase-ledger','purchase_ledger'],['account-holds','account_holds'],['checkout-sessions','checkout_sessions'],['wal','wal'],['identity-vault','identity'],['earning-notifications','earning_notifications'],['tos-acceptance-log','tos_acceptance'],['extraction-audit-writer','extraction_audit']];
for(const [moduleName,participant]of inventory)test(`${moduleName} resolves its active participant through epoch confinement`,()=>{
 const calls=[];
 const target=participant==='wal'||participant==='extraction_audit'?directory:path.join(directory,participant+'.json');
 const resolved=proxyquire('../lib/'+moduleName,{'./financial-epoch':{resolveParticipantPath(name,options){calls.push({name,options});return target;},getRuntimeEpoch(){return null;}}});
 assert.ok(calls.some(x=>x.name===participant),`${moduleName} must not resolve directly into historical storage`);
 const call=calls.find(x=>x.name===participant);assert.equal(typeof call.options.legacyPath,'string');
 assert.ok(resolved);
});
for(const [moduleName,method,args]of [['credits','saveCredits',[{}]],['accounts','saveAccounts',[{}]],['purchase-ledger','saveLedger',[{}]]])test(`${moduleName} raw write refuses initialized money without coordinator ownership`,()=>{
 let writes=0;
 const stubFs={...fs,writeFileSync(){writes++;},renameSync(){writes++;},mkdirSync(){}};
 const money={'./money-control':{getMoneyRuntime(){return {};},assertParticipantWrite(){throw Object.assign(new Error('MONEY_CONTEXT_REQUIRED'),{code:'MONEY_CONTEXT_REQUIRED'});},assertMoneyContext(){throw Object.assign(new Error('MONEY_CONTEXT_REQUIRED'),{code:'MONEY_CONTEXT_REQUIRED'});}}};
 const module=proxyquire('../lib/'+moduleName,{fs:stubFs,...money,'./financial-epoch':{resolveParticipantPath(){return path.join(directory,moduleName+'.json');},getRuntimeEpoch(){return null;}},'./stripe-transfer-persistence':{writeJSONAtomic(){writes++;}}});
 assert.throws(()=>module[method](...args),{code:'MONEY_CONTEXT_REQUIRED'});assert.equal(writes,0);
});
