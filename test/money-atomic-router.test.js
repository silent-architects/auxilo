'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const atomic=require('../lib/money-atomic-router');
test('unbound router data cannot become an atomic repository capability',()=>{assert.equal(atomic.isAtomicRouter({execute(){}}),false);});
test('atomic router constructor refuses missing retained writer before access',()=>{assert.throws(()=>atomic.createAtomicCapacityRouter({}),{code:'MONEY_WRITER_REQUIRED'});});
