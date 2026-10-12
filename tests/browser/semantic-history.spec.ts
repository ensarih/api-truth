import {once} from 'node:events';
import {readFile} from 'node:fs/promises';
import {test,expect,type Page} from '@playwright/test';
import {createPortalServer,type PortalOptions} from '../../apps/portal/src/server.js';
import type {QuerySelection} from '../../packages/query/src/index.js';
import type {ContractSnapshot} from '../../packages/ir/src/index.js';

const principal={tenantId:'history-browser',principalId:'reader'};
const pin={snapshotId:'history-snapshot',revision:'revision-one',configFingerprint:'fingerprint',checkpointVersion:'7'};
const start=async(page:Page,ports?:PortalOptions['semanticHistory'])=>{
 const snapshot=JSON.parse(await readFile(new URL('../fixtures/ir/express-snapshot.json',import.meta.url),'utf8')) as ContractSnapshot;
 const query:PortalOptions['query']={searchServices:async()=>({services:[],truncated:false}),
  readContract:async(_context,selection)=>({status:'resolved',selector:selection as QuerySelection,pin,snapshot,publication:{status:'absent'}}),
  compareContracts:async()=>({status:'unavailable',beforeStatus:'unknown',afterStatus:'unknown'}),readPublication:async()=>{throw Error('unused');}};
 const server=createPortalServer({query,authenticate:async()=>principal,...(ports?{semanticHistory:ports}:{})});
 server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();if(!address||typeof address==='string')throw Error('no port');
 await page.goto(`http://127.0.0.1:${address.port}/`);
 return {close:async()=>{server.closeAllConnections();server.close();await once(server,'close');}};
};
const select=async(page:Page)=>{
 await page.locator('#contract input[name=repositoryId]').fill('commerce');await page.locator('#contract input[name=serviceId]').fill('orders');
 await page.locator('#contract input[name=value]').fill('uat');await page.getByRole('button',{name:'View contract',exact:true}).click();
 await expect(page.locator('#contract-status')).toContainText('Contract available');
};
const selector={version:'1',tenantId:principal.tenantId,repositoryId:'commerce',serviceId:'orders',selector:{kind:'environment',environment:'uat',expectedCheckpointVersion:'7'}};
const history=()=>({status:'resolved',selector,pin,records:[{historyId:'1',createdAt:'2026-10-10T00:00:00.000Z',verification:'inferred',review:'unreviewed',normative:false,result:{status:'no_match'},requestedEndpointIds:['ep-get'],provenance:{provider:'openai',model:'fixture',promptVersion:'semantic-discovery-1',selector:selector.selector,pin}}],truncated:false});
const flags={metadataOnly:true,nonNormative:true,verification:'inferred'};
const record=(decision='acknowledged')=>({historyId:'1',reviewVersion:'1',expectedVersion:'0',decision,createdAt:'2026-10-10T00:00:00.123456Z',...flags});
const reviews=(records:unknown[]=[])=>({historyId:'1',records,truncated:false,...flags});

test('private history panel uses displayed pin, independent operation selection and versioned metadata decisions',async({page})=>{
 const calls:unknown[]=[];let rows:unknown[]=[];
 const ports={readHistory:async(...args:unknown[])=>{calls.push(args);return history();},readHistoryReviews:async()=>reviews(rows),
  recordHistoryReview:async(...args:unknown[])=>{calls.push(args);const request=args[3] as {decision:string};rows=[record(request.decision)];return {...record(request.decision),replayed:false};}} as never;
 const app=await start(page,ports);
 try{
  await expect(page.locator('#semantic-history')).toBeVisible();await expect(page.getByRole('button',{name:'Read private history',exact:true})).toBeDisabled();
  await select(page);await page.locator('#history-endpoints input[value=ep-get]').check();
  await page.getByRole('button',{name:'Read private history',exact:true}).click();await expect(page.locator('#history-results')).toContainText('History 1');
  expect(calls[0]).toEqual([principal,selector,['ep-get'],20]);
  await page.getByRole('button',{name:'View decisions',exact:true}).click();await expect(page.locator('#history-review-status')).toContainText('No decisions');
  await page.locator('#history-decision').selectOption('follow_up');await page.getByRole('button',{name:'Save decision',exact:true}).click();
  await expect(page.locator('#history-review-results')).toContainText('Follow up');
  expect(calls[1]).toEqual([principal,selector,['ep-get'],{historyId:'1',decision:'follow_up',expectedVersion:'0'}]);
  await expect(page.locator('#semantic-history')).toContainText('does not approve');
  await page.locator('#history-endpoints input[value=ep-get]').uncheck();await expect(page.locator('#history-results')).toBeEmpty();
  await expect(page.locator('#history-review-form button')).toBeDisabled();
 }finally{await app.close();}
});

test('history panel rejects mismatched pin and normative history, and clears delayed replies on selection changes',async({page})=>{
 let next:unknown=history(),release:((value:unknown)=>void)|undefined;
 const app=await start(page,{readHistory:async()=>next==='delay'?new Promise(resolve=>{release=resolve;}):next} as never);
 try{
  await select(page);await page.locator('#history-endpoints input[value=ep-get]').check();
  next={...history(),pin:{...pin,checkpointVersion:'8'}};await page.getByRole('button',{name:'Read private history',exact:true}).click();
  await expect(page.locator('#history-status')).toContainText('unavailable');await expect(page.locator('#history-results')).toBeEmpty();
  next=history();(next as ReturnType<typeof history>).records[0]!.normative=true;
  await page.getByRole('button',{name:'Read private history',exact:true}).click();await expect(page.locator('#history-status')).toContainText('unavailable');
  next='delay';await page.getByRole('button',{name:'Read private history',exact:true}).click();await expect.poll(()=>!!release).toBe(true);
  await page.locator('#contract input[name=serviceId]').fill('another');release!(history());
  await expect(page.locator('#history-results')).toBeEmpty();await expect(page.locator('#history-status')).toContainText('Selection changed');
 }finally{await app.close();}
});

test('history panel is hidden without host capability and disables metadata writes after conflict',async({page})=>{
 let app=await start(page);try{await expect(page.locator('#semantic-history')).toBeHidden();}finally{await app.close();}
 app=await start(page,{readHistory:async()=>history(),readHistoryReviews:async()=>reviews(),recordHistoryReview:async()=>{throw Object.assign(Error('private'),{code:'SEMANTIC_REVIEW_CONFLICT'});}} as never);
 try{
  await select(page);await page.locator('#history-endpoints input[value=ep-get]').check();await page.getByRole('button',{name:'Read private history',exact:true}).click();
  await page.getByRole('button',{name:'View decisions',exact:true}).click();await page.getByRole('button',{name:'Save decision',exact:true}).click();
  await expect(page.locator('#history-review-status')).toContainText('Reload decisions');await expect(page.locator('#history-review-form button')).toBeDisabled();
 }finally{await app.close();}
});

for(const phase of ['reviews','write'] as const)test(`late ${phase} replies cannot restore decisions after scope changes`,async({page})=>{
 let delayed=false,release:((value:unknown)=>void)|undefined,readCount=0;
 const ports={readHistory:async()=>history(),readHistoryReviews:async()=>{readCount++;return delayed&&phase==='reviews'?new Promise(resolve=>{release=resolve;}):reviews();},
  recordHistoryReview:async()=>new Promise(resolve=>{release=resolve;})} as never;
 const app=await start(page,ports);
 try{
  await select(page);await page.locator('#history-endpoints input[value=ep-get]').check();await page.getByRole('button',{name:'Read private history',exact:true}).click();
  if(phase==='reviews')delayed=true;
  const response=page.waitForResponse(reply=>reply.url().endsWith(phase==='reviews'?'/api/semantic-history/reviews':'/api/semantic-history/review'));
  await page.getByRole('button',{name:'View decisions',exact:true}).click();
  if(phase==='write'){await expect(page.locator('#history-review-status')).toContainText('No decisions');await page.getByRole('button',{name:'Save decision',exact:true}).click();}
  await expect.poll(()=>!!release).toBe(true);
  if(phase==='reviews')await page.locator('#contract input[name=value]').fill('staging');else await page.locator('#history-endpoints input[value=ep-get]').uncheck();
  release!(phase==='reviews'?reviews([record()]):{...record(),replayed:false});await response;
  await page.evaluate(()=>new Promise<void>(resolve=>(globalThis as unknown as {requestAnimationFrame:(callback:()=>void)=>void}).requestAnimationFrame(()=>resolve())));
  await expect(page.locator('#history-results')).toBeEmpty();await expect(page.locator('#history-review-results')).toBeEmpty();
  await expect(page.locator('#history-review')).toBeHidden();await expect(page.locator('#history-review-form button')).toBeDisabled();expect(readCount).toBe(1);
 }finally{await app.close();}
});

for(const failure of ['malformed','revoked'] as const)test(`${failure} save outcomes require a fresh authorized decision read`,async({page})=>{
 let writes=0,reads=0;
 const app=await start(page,{readHistory:async()=>history(),readHistoryReviews:async()=>{reads++;if(reads>1)throw Object.assign(Error('PRIVATE_OWNER'),{code:'SEMANTIC_NOT_FOUND_OR_DENIED'});return reviews();},
  recordHistoryReview:async()=>{writes++;if(failure==='revoked')throw Object.assign(Error('PRIVATE_OWNER'),{code:'SEMANTIC_NOT_FOUND_OR_DENIED'});return {...record(),nonNormative:false,replayed:false};}} as never);
 try{
  await select(page);await page.locator('#history-endpoints input[value=ep-get]').check();await page.getByRole('button',{name:'Read private history',exact:true}).click();
  await page.getByRole('button',{name:'View decisions',exact:true}).click();await expect(page.locator('#history-review-status')).toContainText('No decisions');
  await page.getByRole('button',{name:'Save decision',exact:true}).click();await expect(page.locator('#history-review-status')).toContainText('Could not confirm');
  await expect(page.locator('#history-review-form button')).toBeDisabled();await expect(page.locator('#history-review-results')).toBeEmpty();expect(writes).toBe(1);expect(reads).toBe(1);
  await page.getByRole('button',{name:'View decisions',exact:true}).click();await expect(page.locator('#history-review-status')).toContainText('owner access denied');
  await expect(page.locator('#history-review-form button')).toBeDisabled();expect(writes).toBe(1);await expect(page.locator('#semantic-history')).not.toContainText('PRIVATE_OWNER');
 }finally{await app.close();}
});
