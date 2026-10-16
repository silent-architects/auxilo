#!/usr/bin/env node
"use strict";
const fs = require('fs'), l = require('../lib/money-lifecycle');
function main(argv) {
  const[file, mode = 'plan'] = argv;
  if (! file) throw Error('money-lifecycle.js INPUT.json [plan|plan-compaction|apply|recover]');
  const input = JSON.parse(fs.readFileSync(file));
  if (mode === 'plan') return l.planLifecycle(input);
  if (!['plan-compaction', 'apply', 'recover'].includes(mode) || ! input.root) throw Error('INVALID_LIFECYCLE_OPERATOR_REQUEST');
  const writer = require('../lib/money-writer-lock').acquireMoneyWriter( {
    root: input.root
  });
  try {
    if (mode === 'recover') return l.recoverLifecycleSuccessor( {
      ... input, writer
    });
    const epoch = require('../lib/financial-epoch').resolveRuntimeEpoch( {
      root: input.root
    });
    const store = require('../lib/money-control-store').openMoneyStore( {
      epoch, writer
    });
    if (mode === 'apply') return l.applyLifecycleSuccessor( {
      ... input, epoch, writer, store, plan: JSON.parse(fs.readFileSync(input.plan_file))
    });
    if (! input.output_file) throw Error('PRIVATE_PLAN_OUTPUT_REQUIRED');
    const plan = store.planCompaction( {
      approval: input.approval
    });
    const fd = fs.openSync(input.output_file, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(plan, null, 2) + '\n');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return {
      planned: true, plan_digest: require('../lib/money-control-store').digest(plan), prior_digest: plan.prior_digest, output_file: input.output_file
    };
  } finally {
    writer.close();
  }
}
if (require.main === module) {
  try {
    console.log(JSON.stringify(main(process.argv.slice(2))));
  } catch (e) {
    console.error(JSON.stringify( {
      error: e.code || e.message
    }));
    process.exitCode = 1;
  }
}
module.exports = {
  main
};
