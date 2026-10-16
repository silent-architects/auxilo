#!/usr/bin/env node
"use strict";
// Explicit offline operator. Never invoked automatically by server startup.
const fs = require('fs'), path = require('path');
const op = require('../lib/financial-epoch-operator'), e = require('../lib/financial-epoch'), {
  acquireMoneyWriter
}
= require('../lib/money-writer-lock');
function main(argv) {
  const[mode, inputFile, outputFile] = argv;
  if (!['plan', 'rehearse', 'bootstrap', 'recover', 'transition'].includes(mode) || ! inputFile) throw Error('Usage: financial-epoch.js plan|rehearse|bootstrap|recover|transition INPUT.json [OUTPUT.json]');
  const input = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
  if (! path.isAbsolute(input.root || '')) throw Error('Explicit absolute root required');
  if (mode === 'plan') {
    if (! outputFile) throw Error('Private plan output path required');
    const plan = op.createEpochPlan(input);
    const fd = fs.openSync(outputFile, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(plan) + '\n');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    require('../lib/stripe-transfer-persistence').syncDirectory(path.dirname(path.resolve(outputFile)));
    return {
      state: 'planned', checksum: plan.checksum, binding_digest: plan.binding.binding_digest
    };
  }
  if (mode === 'rehearse') {
    const plan = JSON.parse(fs.readFileSync(input.plan_file, 'utf8')), epoch = op.rehearseEpoch( {
      ... input, plan
    });
    return {
      state: 'rehearsed', epoch_id: epoch.epoch_id, binding_digest: epoch.binding_digest, capabilities: epoch.capabilities
    };
  }
  const writer = acquireMoneyWriter( {
    root: input.root
  });
  try {
    let epoch;
    if (mode === 'transition') epoch = op.transitionEpoch( {
      ... input, epoch: e.resolveRuntimeEpoch( {
        root: input.root
      }), writer
    });
    else {
      const plan = JSON.parse(fs.readFileSync(input.plan_file, 'utf8'));
      epoch = op[mode === 'recover' ? 'recoverEpoch': mode === 'rehearse' ? 'rehearseEpoch': 'bootstrapEpoch']( {
        ... input, plan, writer
      });
    }
    return {
      state: 'complete', epoch_id: epoch.epoch_id, binding_digest: epoch.binding_digest, activation_revision: epoch.activation_revision,
      capabilities: epoch.capabilities
    };
  } finally {
    writer.close();
  }
}
if (require.main === module) {
  try {
    console.log(JSON.stringify(main(process.argv.slice(2))));
  } catch (error) {
    console.error(JSON.stringify( {
      error: error.code || error.message
    }));
    process.exitCode = 1;
  }
}
module.exports = {
  main
};
