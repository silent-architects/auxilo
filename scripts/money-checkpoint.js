#!/usr/bin/env node
"use strict";
const cp = require('../lib/money-checkpoint');
async function main(argv) {
  const[root, mode = 'request'] = argv;
  if (! root || ! require('path').isAbsolute(root)) throw Error('Explicit absolute root required');
  if (mode === 'validate') return cp.validateCheckpoint(root);
  if (mode !== 'request') throw Error('Expected request or validate');
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
