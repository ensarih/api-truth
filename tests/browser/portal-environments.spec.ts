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
    await select.selectOption('uat');await page.locator('#search input[name=query]').fill('orders');
    await page.getByRole('button',{name:'Search',exact:true}).click();
    await expect(page.locator('#search-status')).toHaveText('No matching services in this scope.');
    expect(searches).toEqual([{tenantId:'tenant',query:'orders',environment:'uat',limit:20}]);
    await select.selectOption('');await page.getByRole('button',{name:'Search',exact:true}).click();
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
