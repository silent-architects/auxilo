#!/usr/bin/env node
"use strict";
const fs = require('fs'), path = require('path'), cp = require('../lib/money-checkpoint'), lock = require('../lib/money-writer-lock');
async function main(argv) {
  const[file] = argv;
  if (! file) throw Error('Explicit restore input JSON required');
  const input = JSON.parse(fs.readFileSync(file));
  if (!path.isAbsolute(input.targetRoot||'') || !input.execution_approval_ref) throw Error('Explicit approved offline restore required');
  if(input.mode==='capacity') {
    const writer=lock.acquireMoneyWriter({root:input.targetRoot});
    try{return await cp.restoreCheckpointCapacity({targetRoot:input.targetRoot,writer,checkpointDir:input.checkpointDir,expectedCheckpointDigest:input.expected_checkpoint_digest,expectedBarrierDigest:input.expected_barrier_digest,authoritativeLifecycle:input.authoritativeLifecycle,executionApprovalRef:input.execution_approval_ref,restoreAllowance:input.restore_allowance});}finally{writer.close();}
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
