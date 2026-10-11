#!/usr/bin/env node
"use strict";
const fs = require('fs'), path = require('path'), cp = require('../lib/money-checkpoint'), lock = require('../lib/money-writer-lock');
async function main(argv) {
  const[file] = argv;
  if (! file) throw Error('Explicit restore input JSON required');
  const input = JSON.parse(fs.readFileSync(file));
  if (!path.isAbsolute(input.targetRoot||'') || !input.execution_approval_ref) throw Error('Explicit approved offline restore required');
  if(input.mode==='capacity') {
    // A2: an explicit successor_claim names the retired source; the operator tool, not the archive, holds the source writer.
    const claim=input.successor_claim;
    if(claim!==undefined&&(Object.keys(claim||{}).sort().join()!=='sourceRoot'||!path.isAbsolute(claim.sourceRoot||'')||path.resolve(claim.sourceRoot)!==claim.sourceRoot||claim.sourceRoot===input.targetRoot))throw Error('Explicit absolute successor_claim.sourceRoot required');
    const writer=lock.acquireMoneyWriter({root:input.targetRoot});let sourceWriter;
    try{
      if(claim)sourceWriter=lock.acquireMoneyWriter({root:claim.sourceRoot});
      return await cp.restoreCheckpointCapacity({targetRoot:input.targetRoot,writer,checkpointDir:input.checkpointDir,expectedCheckpointDigest:input.expected_checkpoint_digest,expectedBarrierDigest:input.expected_barrier_digest,authoritativeLifecycle:input.authoritativeLifecycle,executionApprovalRef:input.execution_approval_ref,restoreAllowance:input.restore_allowance,...(claim?{successorClaim:{sourceRoot:claim.sourceRoot,sourceWriter}}:{})});
    }finally{try{sourceWriter?.close();}finally{writer.close();}}
  }
  if(input.mode && input.mode!=='restore')throw Error('Unknown restore mode');
  if(!path.isAbsolute(input.checkpointDir||''))throw Error('Explicit checkpoint directory required');
  cp.validateCheckpoint(input.checkpointDir, {
    authoritativeLifecycle: input.authoritativeLifecycle
  });
  if (!input.resume && fs.existsSync(input.targetRoot) && fs.readdirSync(input.targetRoot).length) throw Error('RESTORE_EMPTY_TARGET_REQUIRED');
  if (! fs.existsSync(input.targetRoot)) fs.mkdirSync(input.targetRoot, {
    mode: 0o700
  });
  const writer = lock.acquireMoneyWriter( {
    root: input.targetRoot
  });
  try {
    return cp.restoreCheckpoint( {
      ... input, writer
    });
  } finally {
    writer.close();
  }
}
if(require.main===module)main(process.argv.slice(2)).then(result=>console.log(JSON.stringify(result)),error=>{console.error(JSON.stringify({error:error.code||error.message}));process.exitCode=1;});
module.exports = {
  main
};
