#!/usr/bin/env node
"use strict";
const cp = require('../lib/money-checkpoint');
// A2: explicit, one-way retirement of a STOPPED source. The checkpoint socket is unchanged and can never retire.
// Input JSON: {approval_ref, source_sha, lifecycleControl}. The tool holds the source writer and a maintenance-only coordinator.
async function retire(root, file) {
  if (! file) throw Error('Explicit retire input JSON required');
  const input = JSON.parse(require('fs').readFileSync(file));
  if (! input.approval_ref) throw Error('Explicit retirement approval required');
  const lock = require('../lib/money-writer-lock'), e = require('../lib/financial-epoch'), writer = lock.acquireMoneyWriter( {
    root
  });
  try {
    const epoch = e.resolveRuntimeEpoch( {
      root, writer
    }), store = require('../lib/money-control-store').openMoneyStore( {
      epoch, writer
    });
    try {
      const cut = await cp.createRetiringCheckpoint( {
        epoch, writer, coordinator: {
          maintenanceLease: fn => store.maintenanceLease(fn)
        }, sourceSha: input.source_sha, lifecycleControl: input.lifecycleControl, approvalRef: input.approval_ref
      });
      return {
        checkpoint_id: cut.checkpoint_id, revision: cut.revision, digest: cut.digest, directory: cp.checkpointDirectory(root, cut.checkpoint_id), unresolved_obligations: cut.unresolved_obligations, completion_guaranteed: cut.completion_guaranteed, retirement: cut.retirement
      };
    } finally {
      store.close();
    }
  } finally {
    writer.close();
  }
}
async function main(argv) {
  const[root, mode = 'request', file] = argv;
  if (! root || ! require('path').isAbsolute(root)) throw Error('Explicit absolute root required');
  if (mode === 'validate') return cp.validateCheckpoint(root);
  if (mode === 'retire') return retire(root, file);
  if (mode !== 'request') throw Error('Expected request, validate or retire');
  const cut = await cp.requestMoneyCheckpoint( {
    root
  });
  return {
    checkpoint_id: cut.checkpoint_id, revision: cut.revision, digest: cut.digest, directory: cut.directory, expires_at: cut.manifest.expires_at
  };
}
if (require.main === module) main(process.argv.slice(2)).then(x => console.log(JSON.stringify(x)), e => {
  console.error(JSON.stringify( {
    error: e.code || e.message
  }));
  process.exitCode = 1;
});
module.exports = {
  main
};
