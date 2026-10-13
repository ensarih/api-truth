import {once} from 'node:events';
import {expect,test,vi} from 'vitest';
import {Client,InMemoryTransport} from '@modelcontextprotocol/client';
import {createApiTruthMcpServer} from '../../apps/mcp/src/server.js';
import {createPortalServer} from '../../apps/portal/src/server.js';
const principal={tenantId:'tenant',principalId:'reader'},input={environment:'uat',intentQuery:'abort a purchase',limit:8};
const query={searchServices:async()=>({services:[],truncated:false as const}),readContract:async()=>{throw Error('unused');},readEndpoint:async()=>{throw Error('unused');},readSchema:async()=>{throw Error('unused');},compareContracts:async()=>{throw Error('unused');},readPublication:async()=>{throw Error('unused');}};
const sample={status:'candidates' as const,matchMode:'semantic' as const,scope:'visible_authorized_context' as const,environment:'uat',verification:'inferred' as const,review:'unreviewed' as const,normative:false as const,complete:true,truncated:false,embeddingSpace:'fixture',candidates:[]};
test('MCP semantic retrieval is opt-in, strict and uses host identity',async()=>{
 const retrieve=vi.fn(async()=>sample),server=createApiTruthMcpServer({query,authenticate:async()=>principal,retrieval:{retrieve}});
 const client=new Client({name:'retrieval-test',version:'1'}),[ct,st]=InMemoryTransport.createLinkedPair();
 try{await server.connect(st);await client.connect(ct);
  const result=await client.callTool({name:'api_truth_search_semantic_api_corpus',arguments:input});expect(result.structuredContent).toEqual({ok:true,data:sample});expect(retrieve).toHaveBeenCalledWith(principal,input);
  const invalid=await client.callTool({name:'api_truth_search_semantic_api_corpus',arguments:{...input,tenantId:'other'}});expect(invalid.isError).toBe(true);expect(retrieve).toHaveBeenCalledOnce();
  retrieve.mockRejectedValueOnce(Object.assign(Error('PRIVATE_ERROR'),{code:'SEMANTIC_RETRIEVAL_STALE_CONTEXT'}));expect((await client.callTool({name:'api_truth_search_semantic_api_corpus',arguments:input})).structuredContent).toEqual({ok:false,error:'STALE_SELECTION'});
 }finally{await Promise.allSettled([client.close(),server.close()]);}
});
test('portal semantic retrieval has bounded authenticated POST inputs and fixed failures',async()=>{
 const retrieve=vi.fn(async()=>sample),server=createPortalServer({query,authenticate:async request=>request.headers.authorization==='Bearer fixture'?principal:undefined,retrieval:{retrieve}});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 try{const address=server.address();if(!address||typeof address==='string')throw Error('port');const host=`http://127.0.0.1:${address.port}`;
  const post=(body:unknown,auth=true)=>fetch(host+'/api/semantic-retrieval',{method:'POST',headers:{'content-type':'application/json',...(auth?{authorization:'Bearer fixture'}:{})},body:JSON.stringify(body)});
  const result=await post(input);expect(result.status).toBe(200);expect(result.headers.get('cache-control')).toBe('no-store');expect(await result.json()).toEqual(sample);expect(retrieve).toHaveBeenCalledWith(principal,input);
  expect((await post({...input,principalId:'other'})).status).toBe(400);expect((await post(input,false)).status).toBe(401);expect(retrieve).toHaveBeenCalledOnce();
  retrieve.mockRejectedValueOnce(Object.assign(Error('PRIVATE_ERROR'),{code:'SEMANTIC_RETRIEVAL_UNAVAILABLE'}));const failure=await post(input);expect(failure.status).toBe(503);expect(await failure.text()).toBe('{"error":"SEMANTIC_UNAVAILABLE"}');
 }finally{server.closeAllConnections();server.close();await once(server,'close');}
});
