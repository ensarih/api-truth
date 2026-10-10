import {once} from 'node:events';
import {expect,test} from 'vitest';
import {createPortalServer,type PortalOptions} from '../../apps/portal/src/server.js';
const query:PortalOptions['query']={searchServices:async()=>({services:[],truncated:false}),readContract:async()=>{throw Error('unused');},compareContracts:async()=>{throw Error('unused');},readPublication:async()=>{throw Error('unused');}};
test('environment names require authentication and reject forged scope and malformed host output',async()=>{
  let calls=0;let names:readonly string[]=['uat','staging','uat'];
  const server=createPortalServer({query,authenticate:async request=>request.headers.authorization==='Bearer fixture'?{tenantId:'tenant',principalId:'reader'}:undefined,
    environments:async principal=>{calls++;expect(principal).toEqual({tenantId:'tenant',principalId:'reader'});return names;}});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  try{const address=server.address();if(!address||typeof address==='string')throw Error('port');const url=`http://127.0.0.1:${address.port}/api/environments`,headers={authorization:'Bearer fixture'};
    expect((await fetch(url)).status).toBe(401);expect(calls).toBe(0);
    expect((await fetch(url+'?tenantId=other',{headers})).status).toBe(400);expect(calls).toBe(0);
    const response=await fetch(url,{headers});expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toBe('no-store');expect(await response.json()).toEqual({environments:['staging','uat']});
    names=['uat','\nprivate'];const invalid=await fetch(url,{headers});expect(invalid.status).toBe(503);expect(await invalid.text()).not.toContain('private');
    names=Array.from({length:129},(_,i)=>String(i));expect((await fetch(url,{headers})).status).toBe(503);
  }finally{server.closeAllConnections();server.close();await once(server,'close');}
});
