'use strict';
// Scratch backing only: never allocates financial records or changes quotas.
const fs=require('node:fs'),process=require('node:process'),{spawnSync}=require('node:child_process');
const {fail}=require('./money-database');
function assertAllocationMode(mode){if(mode==='zero-fill')return;if(mode!=='linux-fallocate'||process.platform!=='linux')throw fail('WORKSPACE_ALLOCATION_MODE_INVALID');}
function allocateScratch({file,bytes,identity,minimum=0,maximum=bytes}){
 assertAllocationMode('linux-fallocate');
 if(!Number.isSafeInteger(bytes)||bytes<0||!Number.isSafeInteger(minimum)||minimum<0||!Number.isSafeInteger(maximum)||maximum<minimum||bytes>maximum||!identity)throw fail('WORKSPACE_BOUND_INVALID');
 const matches=s=>s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&s.dev===identity.dev&&s.ino===identity.ino;
 const before=fs.lstatSync(file);if(!matches(before)||before.size<minimum||before.size>maximum)throw fail('WORKSPACE_PHYSICAL_MISMATCH');
 const fd=fs.openSync(file,fs.constants.O_RDWR|fs.constants.O_NOFOLLOW);
 try{
  const opened=fs.fstatSync(fd);if(!matches(opened)||opened.size<minimum||opened.size>maximum)throw fail('WORKSPACE_PHYSICAL_MISMATCH');
  if(bytes===0)fs.ftruncateSync(fd,0);
  else{
   // Reallocate the entire authorized range, including a same-size partial
   // prior attempt. Logical size alone never proves physically backed extents.
   const result=spawnSync('/usr/bin/fallocate',['-l',String(bytes),'/proc/self/fd/3'],{shell:false,stdio:['ignore','ignore','pipe',fd],timeout:10000,killSignal:'SIGKILL',maxBuffer:4096});
   if(!result||result.error||result.signal||result.status!==0)throw Object.assign(fail('WORKSPACE_ALLOCATION_FAILED'),{cause:result?.error,exitStatus:result?.status,signal:result?.signal});
  }
  fs.fsyncSync(fd);
  const actual=fs.fstatSync(fd),named=fs.lstatSync(file);
  for(const s of [actual,named])if(!matches(s)||s.size!==bytes||s.blocks*512<bytes)throw fail('WORKSPACE_PHYSICAL_MISMATCH');
  return{dev:actual.dev,ino:actual.ino,bytes:actual.size,allocatedBytes:actual.blocks*512,nlink:actual.nlink};
 }finally{fs.closeSync(fd);}
}
module.exports={assertAllocationMode,allocateScratch};
