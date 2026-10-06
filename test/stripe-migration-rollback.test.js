 'use strict';const{test}=require('node:test');const assert=require('node:assert/strict');const{assertRollbackSafe}=require('../lib/stripe-migration-reconcile');
test('intake-only rollback retains current additive schema and both histories',()=>assert.equal(assertRollbackSafe({targetSchema:1,currentSchema:1,restoreSnapshot:false,preserveHistories:true}),true));
test('old binary rollback rejected once migration schema exists',()=>assert.throws(()=>assertRollbackSafe({targetSchema:0,currentSchema:1,preserveHistories:true}),/schema/));
test('snapshot rollback cannot overwrite new platform writes',()=>assert.throws(()=>assertRollbackSafe({targetSchema:1,currentSchema:1,restoreSnapshot:true,preserveHistories:true}),/snapshot/));
test('rollback cannot discard either history',()=>assert.throws(()=>assertRollbackSafe({targetSchema:1,currentSchema:1,preserveHistories:false}),/histor/));
