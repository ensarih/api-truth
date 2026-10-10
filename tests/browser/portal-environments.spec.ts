import {once} from 'node:events';
import {expect,test} from '@playwright/test';
import {createPortalServer,type PortalOptions} from '../../apps/portal/src/server.js';

test('environment dropdown loads authorized names and sends the exact selected scope',async({page})=>{
  const searches:unknown[]=[];
  const query:PortalOptions['query']={searchServices:async(_principal,request)=>{searches.push(request);return {services:[],truncated:false};},readContract:async()=>{throw Error('unused');},compareContracts:async()=>{throw Error('unused');},readPublication:async()=>{throw Error('unused');}};
  const server=createPortalServer({authenticate:async()=>({tenantId:'tenant',principalId:'reader'}),query,
    environments:async principal=>{expect(principal).toEqual({tenantId:'tenant',principalId:'reader'});return ['uat','staging','uat'];}});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  try{
    const address=server.address();if(!address||typeof address==='string')throw Error('port');
    await page.goto(`http://127.0.0.1:${address.port}`);
    const select=page.locator('#search select[name=environment]');
    await expect(select).toBeEnabled();
    await expect(select.locator('option')).toHaveText(['All environments','staging','uat']);
    await page.locator('#search input[name=query]').fill('orders');await select.selectOption('uat');
    await expect(page.locator('#search-status')).toHaveText('No matching services in this scope.');
    expect(searches).toEqual([{tenantId:'tenant',query:'orders',environment:'uat',limit:20}]);
    await select.selectOption('');
    await expect.poll(()=>searches.length).toBe(2);expect(searches[1]).toEqual({tenantId:'tenant',query:'orders',limit:20});
  }finally{server.closeAllConnections();server.close();await once(server,'close');}
});

test('failed environment listing keeps all-service search available and blocks scoped forms',async({page})=>{
  const query:PortalOptions['query']={searchServices:async()=>({services:[],truncated:false}),readContract:async()=>{throw Error('unused');},compareContracts:async()=>{throw Error('unused');},readPublication:async()=>{throw Error('unused');}};
  const server=createPortalServer({authenticate:async()=>({tenantId:'tenant',principalId:'reader'}),query,environments:async()=>{throw Error('private-marker');}});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  try{const address=server.address();if(!address||typeof address==='string')throw Error('port');await page.goto(`http://127.0.0.1:${address.port}`);
    await expect(page.locator('#environment-status')).toContainText('unavailable');
    await expect(page.locator('#search select[name=environment]')).toBeEnabled();
    await expect(page.locator('#corpus select[name=environment]')).toBeDisabled();
    await expect(page.locator('#corpus button[type=submit]')).toBeDisabled();
    await page.getByRole('button',{name:'Search',exact:true}).click();
    await expect(page.locator('#search-status')).toHaveText('No matching services in this scope.');
    await expect(page.locator('body')).not.toContainText('private-marker');
  }finally{server.closeAllConnections();server.close();await once(server,'close');}
});

test('changing environment refreshes search immediately and ignores the previous slow response',async({page})=>{
 let release: (()=>void)|undefined,slow=false;
 const query:PortalOptions['query']={searchServices:async(_principal,input)=>{
   const request=input as {environment?:string};if(slow&&request.environment==='uat')await new Promise<void>(resolve=>{release=resolve;});
   return {services:request.environment==='staging'?[]:[{repositoryId:'commerce',serviceId:'orders',environment:{name:'uat',status:'unknown'}}],truncated:false};
 },readContract:async()=>{throw Error('unused');},compareContracts:async()=>{throw Error('unused');},readPublication:async()=>{throw Error('unused');}};
 const server=createPortalServer({authenticate:async()=>({tenantId:'tenant',principalId:'reader'}),query,environments:async()=>['uat','staging']});server.listen(0,'127.0.0.1');await once(server,'listening');
 try{const address=server.address();if(!address||typeof address==='string')throw Error('port');await page.goto(`http://127.0.0.1:${address.port}`);
   const select=page.locator('#search select[name=environment]');await select.selectOption('uat');
   await expect(page.locator('#results')).toContainText('commerce / orders');slow=true;
   await page.getByRole('button',{name:'Search',exact:true}).click();await expect.poll(()=>Boolean(release)).toBe(true);
   await select.selectOption('staging');await expect(page.locator('#search-status')).toHaveText('No matching services in this scope.');
   release?.();await expect(page.locator('#results')).toBeEmpty();
 }finally{release?.();server.closeAllConnections();server.close();await once(server,'close');}
});
