import {once} from 'node:events';
import {readFile} from 'node:fs/promises';
import {expect,test} from '@playwright/test';
import {createPortalServer} from '../../apps/portal/src/server.js';
import {createPortalDemoQuery} from '../../apps/portal/src/demo-query.js';
import type {ContractSnapshot} from '../../packages/ir/src/index.js';
test('demo environment filter clears UAT results and details; workspace fits desktop and mobile',async({page})=>{
 const snapshot=JSON.parse(await readFile(new URL('../fixtures/ir/express-snapshot.json',import.meta.url),'utf8')) as ContractSnapshot;
 const principal={tenantId:'demo',principalId:'reader'};
 const server=createPortalServer({authenticate:async()=>principal,environments:async()=>['uat','staging'],query:createPortalDemoQuery(snapshot,principal)});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 try{const address=server.address();if(!address||typeof address==='string')throw Error('port');await page.setViewportSize({width:1440,height:1000});await page.goto(`http://127.0.0.1:${address.port}`);
  await page.locator('#search input[name=query]').fill('orders');await page.locator('#search select[name=environment]').selectOption('uat');
  await page.getByRole('button',{name:'commerce / orders — uat: resolved'}).click();await page.getByRole('button',{name:'GET /api/orders/:orderId'}).click();
  await expect(page.locator('#detail-view')).toContainText('includeItems');await expect(page.locator('#detail-view')).toContainText('unknown');await expect(page.locator('#detail-view')).toContainText('200');
  await expect(page.locator('#raw-detail')).not.toHaveAttribute('open');
  await page.screenshot({path:'/tmp/api-truth-portal-redesign-desktop.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});
  expect(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')).toBe(true);
  await page.screenshot({path:'/tmp/api-truth-portal-redesign-mobile.png',fullPage:true});
  await page.locator('#search select[name=environment]').selectOption('staging');
  await expect(page.locator('#search-status')).toHaveText('No matching services in this scope.');await expect(page.locator('#results')).toBeEmpty();await expect(page.locator('#endpoints')).toBeEmpty();await expect(page.locator('#detail')).toBeEmpty();await expect(page.locator('#selected-service')).toHaveText('No service selected');
  await page.locator('#search select[name=environment]').selectOption('uat');await expect(page.locator('#results')).toContainText('commerce / orders');
 }finally{server.closeAllConnections();server.close();await once(server,'close');}
});

test('configured local demo exposes clearly synthetic private history and ephemeral metadata decisions',async({page})=>{
 const {createPortalDemoHistory}=await import('../../apps/portal/src/demo-history.js');
 const snapshot=JSON.parse(await readFile(new URL('../fixtures/ir/express-snapshot.json',import.meta.url),'utf8')) as ContractSnapshot;
 const principal={tenantId:'local-demo',principalId:'local-viewer'};
 const server=createPortalServer({syntheticDemo:true,authenticate:async()=>principal,environments:async()=>['uat','staging'],
  query:createPortalDemoQuery(snapshot,principal),semanticHistory:createPortalDemoHistory(snapshot,principal)});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 try{
  const address=server.address();if(!address||typeof address==='string')throw Error('port');await page.goto(`http://127.0.0.1:${address.port}`);
  await expect(page.locator('#synthetic-demo-notice')).toContainText('No LLM is called');await expect(page.locator('#synthetic-demo-notice')).toContainText('reset');
  await page.locator('#search input[name=query]').fill('orders');await page.locator('#search select[name=environment]').selectOption('uat');
  await page.getByRole('button',{name:'commerce / orders — uat: resolved'}).click();await page.locator('#history-endpoints input[value=ep-get]').check();
  await page.getByRole('button',{name:'Read private history',exact:true}).click();await expect(page.locator('#history-results')).toContainText('History 1');
  await page.getByRole('button',{name:'View decisions',exact:true}).click();await expect(page.locator('#history-review-status')).toContainText('No decisions');
  await page.locator('#history-decision').selectOption('follow_up');await page.getByRole('button',{name:'Save decision',exact:true}).click();
  await expect(page.locator('#history-review-results')).toContainText('Follow up');await expect(page.locator('#history-review-results')).toContainText('version 1');
  await page.locator('#semantic-history').screenshot({path:'/tmp/api-truth-history-demo-panel.png'});
  await page.screenshot({path:'/tmp/api-truth-history-demo-desktop.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});expect(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')).toBe(true);
  await page.screenshot({path:'/tmp/api-truth-history-demo-mobile.png',fullPage:true});
  await page.locator('#search select[name=environment]').selectOption('staging');await expect(page.locator('#history-results')).toBeEmpty();await expect(page.locator('#history-review')).toBeHidden();
 }finally{server.closeAllConnections();server.close();await once(server,'close');}
});
