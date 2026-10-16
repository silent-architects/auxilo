'use strict';
// Startup selects one private directory before the native VFS is used. The VFS
// itself still refuses missing/invalid configuration and never selects fallback.
const fs=require('node:fs'),path=require('node:path');
function invalid(cause){return Object.assign(new Error('SQLITE_TEMP_ENVIRONMENT'),{code:'SQLITE_TEMP_ENVIRONMENT',...(cause?{cause}:{})});}
function ensureMoneySqliteTemp({epoch,writer,env=process.env}){
 require('./money-writer-lock').assertMoneyWriter(writer,{root:epoch?.legacy_root});writer.assertOwned();
 let fd;
 try{
  if(typeof epoch?.financial_dir!=='string'||!path.isAbsolute(epoch.financial_dir)||typeof process.getuid!=='function')throw invalid();
  const financial=fs.realpathSync(epoch.financial_dir),parent=fs.lstatSync(financial);
  if(financial!==path.resolve(epoch.financial_dir)||!parent.isDirectory())throw invalid();
  const configured=env.AUXILO_SQLITE_TMPDIR,selected=configured===undefined?path.join(financial,'sqlite-temp'):configured;
  if(typeof selected!=='string'||!selected||!path.isAbsolute(selected))throw invalid();
  if(configured===undefined){try{fs.mkdirSync(selected,{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;}}
  const before=fs.lstatSync(selected);
  if(!before.isDirectory()||before.isSymbolicLink()||fs.realpathSync(selected)!==selected||(before.mode&0o7777)!==0o700||before.uid!==process.getuid()||before.dev!==parent.dev)throw invalid();
  fd=fs.openSync(selected,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);
  const opened=fs.fstatSync(fd);if(opened.ino!==before.ino||opened.dev!==before.dev)throw invalid();
  fs.fsyncSync(fd);
  // A previous startup may have created this directory before interruption.
  // Sync its containing directory on every acceptance, including that retry.
  const parentFd=fs.openSync(path.dirname(selected),fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);try{fs.fsyncSync(parentFd);}finally{fs.closeSync(parentFd);}
  writer.assertOwned();const after=fs.lstatSync(selected);
  if(after.ino!==before.ino||after.dev!==before.dev||after.isSymbolicLink()||(after.mode&0o7777)!==0o700||after.uid!==process.getuid()||fs.realpathSync(selected)!==selected)throw invalid();
  env.AUXILO_SQLITE_TMPDIR=selected;return selected;
 }catch(error){if(error.code==='SQLITE_TEMP_ENVIRONMENT')throw error;throw invalid(error);}
 finally{if(fd!==undefined)fs.closeSync(fd);}
}
module.exports={ensureMoneySqliteTemp};
