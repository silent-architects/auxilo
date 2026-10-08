'use strict';
const test=require('node:test'), assert=require('node:assert/strict'), fs=require('node:fs'),path=require('node:path');
const root=path.join(__dirname,'..');
test('funding presets retain IDs and exact prices, with accurate prospective disclosure and session-only API',()=>{
 const {PACKS}=require('../lib/stripe');
 assert.deepEqual(Object.values(PACKS).map(p=>[p.id,p.price_cents,p.name]),[['starter',1000,'Add funds $10'],['growth',2500,'Add funds $25'],['pro',10000,'Add funds $100']]);
 for(const page of ['dashboard','pricing']){
  const html=fs.readFileSync(path.join(root,'public',page+'.html'),'utf8');
  assert.match(html,/id="prospective-purchase-disclosures"[^>]*hidden/);
  assert.match(html,/Available earned margin covers verified costs first; any uncovered cost and the amount returned are shown before you confirm\./);
  assert.match(html,/financial_epoch\?\.funding_available/);
 }
 const api=JSON.parse(fs.readFileSync(path.join(root,'openapi.json')));
 for(const route of ['/account/funds-return/sources','/account/funds-return/quote','/account/funds-return/confirm','/account/funds-return/{operationId}']){
  const operation=api.paths[route]?.get||api.paths[route]?.post;
  assert.deepEqual(operation?.security,[{bearerAuth:[]}]);
 }
});
test('browser return quote, repeated click, refresh and uncertain response keep one identity at mobile and desktop',async()=>{
 const {chromium}=require('playwright');
 const browser=await chromium.launch({headless:true});
 try{
  for(const width of [375,1280]){
   const context=await browser.newContext({viewport:{width,height:900}});const page=await context.newPage();
   const script=fs.readFileSync(path.join(root,'public/dashboard-funds-return.js'),'utf8');
   const quote={id:'quote_fixture',hash:'hash',expiresAt:Date.now()+300000,G:10000000,D:10000000,N:9800000,C:200000,r:0,coverageMicros:100000};
   const operation={...quote,id:'return_fixture',sourceId:'source',quoteId:quote.id,state:'submission_unknown'};let calls=[],status=operation;
   await page.route('https://auxilo.test/**',async route=>{
    const request=route.request(),url=new URL(request.url());let data;
    if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:'<!doctype html><meta name="viewport" content="width=device-width"><section id="funds-return-panel" hidden></section><script>'+script+'</script><script>AuxiloFundsReturn.init({api:fetch});</script>'});
    if(url.pathname==='/health')data={financial_epoch:{buyer_return_available:true}};
    else if(url.pathname.endsWith('/sources'))data={accountId:'owner',sources:[{id:'source',available:true,availableMicros:10000000,heldMicros:0}]};
    else if(url.pathname.endsWith('/quote'))data=quote;
    else if(url.pathname.endsWith('/confirm')){calls.push({key:request.headers()['idempotency-key'],body:request.postDataJSON()});if(calls.length===1)return route.abort();data=operation;}
    else data=status;
    await route.fulfill({contentType:'application/json',body:JSON.stringify(data)});
   });
   await page.goto('https://auxilo.test/');
   await page.getByLabel('Maximum balance to use (USD)').fill('10');
   await page.getByRole('button',{name:'Review return quote'}).click();
   await page.getByRole('button',{name:'Confirm return of $9.80',exact:true}).focus();
   await page.keyboard.press('Enter');
   await page.getByRole('button',{name:'Check same request'}).waitFor();
   await page.reload();
   await page.getByRole('button',{name:'Check same request'}).click();
   await page.getByRole('button',{name:'Check status',exact:true}).waitFor();
   assert.equal(calls.length,2);assert.equal(calls[0].key,calls[1].key);assert.deepEqual(calls[0].body,calls[1].body);
   assert.match(await page.locator('[role="status"]').innerText(),/not yet confirmed/);
   assert.equal(await page.getByRole('button',{name:/Confirm return/}).count(),0);
   status={...operation,state:'settled'};
   await page.getByRole('button',{name:'Check status',exact:true}).click();
   await page.getByText('Return confirmed.',{exact:false}).waitFor();
   assert.match(await page.locator('[role="status"]').innerText(),/Return confirmed/);
   await context.close();
  }
 }finally{await browser.close();}
});

test('browser funding pagination reaches later eligible sources and returns without accumulating history',async()=>{
 const {chromium}=require('playwright'),browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage(),script=fs.readFileSync(path.join(root,'public/dashboard-funds-return.js'),'utf8');const queries=[];
  await page.route('https://auxilo.test/**',async route=>{
   const url=new URL(route.request().url());let data;
   if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:'<!doctype html><section id="funds-return-panel" hidden></section><script>'+script+'</script><script>AuxiloFundsReturn.init({api:fetch});</script>'});
   if(url.pathname==='/health')data={financial_epoch:{buyer_return_available:true}};
   else if(url.pathname.endsWith('/sources')){queries.push(url.search);const later=url.searchParams.has('after');data={accountId:'owner',sources:[{id:later?'later-source':'first-source',available:later,availableMicros:10000000,heldMicros:0}],nextCursor:later?null:'cursor2'};}
   else throw Error('Unexpected request '+url.pathname);
   await route.fulfill({contentType:'application/json',body:JSON.stringify(data)});
  });
  await page.goto('https://auxilo.test/');
  await page.getByRole('button',{name:'More funding',exact:true}).click();
  await page.getByLabel('Funding source',{exact:true}).waitFor();
  assert.equal(await page.locator('#return-source option').count(),1);
  assert.equal(await page.locator('#return-source').inputValue(),'later-source');
  await page.getByRole('button',{name:'Previous funding',exact:true}).click();
  await page.getByRole('button',{name:'More funding',exact:true}).waitFor();
  assert.equal(await page.locator('#return-source').count(),0);
  assert.deepEqual(queries,['','?after=cursor2','']);
 }finally{await browser.close();}
});
