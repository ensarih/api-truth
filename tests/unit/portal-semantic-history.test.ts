import {once} from "node:events";
import {afterEach,expect,test,vi} from "vitest";
import type {Server} from "node:http";
import {createPortalServer,type PortalOptions} from "../../apps/portal/src/server.js";

const principal={tenantId:"tenant-a",principalId:"reader-a"};
const selected={version:"1" as const,tenantId:principal.tenantId,repositoryId:"commerce",serviceId:"orders",
 selector:{kind:"environment" as const,environment:"uat",expectedCheckpointVersion:"7"}};
const base={repositoryId:"commerce",serviceId:"orders",view:selected.selector,endpointIds:["ep-get"]};
const receipt={historyId:"1",reviewVersion:"1",expectedVersion:"0",decision:"acknowledged" as const,
 createdAt:"2026-10-10T00:00:00.123456Z",metadataOnly:true as const,nonNormative:true as const,verification:"inferred" as const,replayed:false};
const query={searchServices:vi.fn(async()=>({services:[],truncated:false as const})),
 readContract:vi.fn(async()=>{throw Error("unused");}),compareContracts:vi.fn(async()=>{throw Error("unused");}),readPublication:vi.fn(async()=>{throw Error("unused");})};
const opened:Server[]=[];
afterEach(async()=>{for(const server of opened.splice(0)){server.closeAllConnections();server.close();await once(server,"close");}});
const start=async(history?:PortalOptions['semanticHistory'],authenticate:PortalOptions['authenticate']=async()=>principal)=>{
 const server=createPortalServer({query,authenticate,...(history?{semanticHistory:history}:{})});
 server.listen(0,'127.0.0.1');await once(server,'listening');opened.push(server);
 const address=server.address();if(!address||typeof address==='string')throw Error('no address');
 return `http://127.0.0.1:${address.port}`;
};
const ports=()=>({readHistory:vi.fn(async()=>({status:'resolved' as const,selector:selected,pin:{snapshotId:'snapshot',revision:'rev',configFingerprint:'fingerprint'},records:[],truncated:false})),
 readHistoryReviews:vi.fn(async()=>({historyId:'1',records:[],truncated:false,metadataOnly:true as const,nonNormative:true as const,verification:'inferred' as const})),
 recordHistoryReview:vi.fn(async()=>receipt)});
const post=(host:string,path:string,body:unknown,headers:Record<string,string>={})=>fetch(host+path,{method:'POST',headers:{'content-type':'application/json',...headers},body:typeof body==='string'?body:JSON.stringify(body)});

test('portal history ports are explicit, private, bounded and inject the host principal',async()=>{
 const history=ports(),host=await start(history);
 const response=await post(host,'/api/semantic-history',{...base,limit:20});
 expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toBe('no-store');
 expect(history.readHistory).toHaveBeenCalledWith(principal,selected,['ep-get'],20);
 const reviews=await post(host,'/api/semantic-history/reviews',{...base,historyId:'1',limit:10});
 expect(reviews.status).toBe(200);expect(history.readHistoryReviews).toHaveBeenCalledWith(principal,selected,['ep-get'],'1',10);
 const write=await post(host,'/api/semantic-history/review',{...base,historyId:'1',decision:'acknowledged',expectedVersion:'0'},{origin:host,'sec-fetch-site':'same-origin'});
 expect(write.status).toBe(200);expect(await write.json()).toEqual(receipt);
 expect(history.recordHistoryReview).toHaveBeenCalledWith(principal,selected,['ep-get'],{historyId:'1',decision:'acknowledged',expectedVersion:'0'});
 expect(query.readContract).not.toHaveBeenCalled();
});

test('unconfigured history ports and unauthenticated requests never invoke a history service',async()=>{
 const absent=await start();expect((await post(absent,'/api/semantic-history',{...base,limit:20})).status).toBe(404);
 const history=ports(),denied=await start(history,async()=>undefined);
 expect((await post(denied,'/api/semantic-history/review',{...base,historyId:'1',decision:'acknowledged',expectedVersion:'0'})).status).toBe(401);
 expect(history.recordHistoryReview).not.toHaveBeenCalled();
});

test('history requests reject extra identities, ambiguous JSON, unpinned selectors and invalid bounds',async()=>{
 const history=ports(),host=await start(history);
 for(const body of [{...base,limit:20,principalId:'other'},{...base,limit:20,tenantId:'other'},
  {...base,limit:21},{...base,limit:0},{...base,limit:20,endpointIds:['ep-get','ep-get']},
  {...base,limit:20,view:{kind:'environment',environment:'uat'}},
  {...base,limit:20,view:{kind:'branch',branch:'main'}},
  '{"limit":20,"limit":1}',{...base,limit:20,intentQuery:'secret'}]){
  expect((await post(host,'/api/semantic-history',body)).status).toBe(400);
 }
 for(const body of [{...base,historyId:'01',limit:20},{...base,historyId:'9223372036854775808',limit:20}])
  expect((await post(host,'/api/semantic-history/reviews',body)).status).toBe(400);
 for(const body of [{...base,historyId:'1',decision:'approved',expectedVersion:'0'},
  {...base,historyId:'1',decision:'acknowledged',expectedVersion:'9223372036854775807'},
  {...base,historyId:'1',decision:'acknowledged',expectedVersion:'0',reviewer:'other'}])
  expect((await post(host,'/api/semantic-history/review',body)).status).toBe(400);
 expect(history.readHistory).not.toHaveBeenCalled();expect(history.readHistoryReviews).not.toHaveBeenCalled();expect(history.recordHistoryReview).not.toHaveBeenCalled();
});

test('metadata writes reject cross-origin browser requests before reading or writing history',async()=>{
 const history=ports(),host=await start(history),body={...base,historyId:'1',decision:'acknowledged',expectedVersion:'0'};
 for(const headers of [{origin:'https://foreign.example'},{origin:host.replace('http:','https:')},{origin:'null'},{'sec-fetch-site':'cross-site'},{'sec-fetch-site':'same-site'}]){
  expect((await post(host,'/api/semantic-history/review',body,headers)).status).toBe(403);
 }
 expect(history.recordHistoryReview).not.toHaveBeenCalled();
});

test('review ports map fixed service failures and avoid hostile error getters and proxy traps',async()=>{
 const history=ports(),host=await start(history),body={...base,historyId:'1',decision:'acknowledged',expectedVersion:'0'};
 for(const [code,status,error] of [['SEMANTIC_NOT_FOUND_OR_DENIED',404,'NOT_FOUND'],['SEMANTIC_STALE_CONTEXT',409,'STALE_SELECTION'],
  ['SEMANTIC_REVIEW_CONFLICT',409,'REVIEW_CONFLICT'],['SEMANTIC_INVALID_REQUEST',400,'INVALID_REQUEST'],['SEMANTIC_STORAGE_ERROR',503,'SEMANTIC_UNAVAILABLE']]){
  history.recordHistoryReview.mockRejectedValueOnce(Object.assign(Error('CANARY_INTERNAL'),{code}));
  const response=await post(host,'/api/semantic-history/review',body);expect(response.status).toBe(status);expect(await response.text()).toBe(JSON.stringify({error}));
 }
 const trap=vi.fn(()=>{throw Error('CANARY_INTERNAL');}),hostile=new Proxy({}, {get:trap,getPrototypeOf:trap});
 const getter=Object.create(Error.prototype);Object.defineProperty(getter,'code',{get:trap});
 for(const failure of [hostile,getter]){
  history.recordHistoryReview.mockRejectedValueOnce(failure);
  const response=await post(host,'/api/semantic-history/review',body);expect(response.status).toBe(503);expect(await response.text()).toBe('{"error":"QUERY_UNAVAILABLE"}');
 }
 expect(trap).not.toHaveBeenCalled();
});

test('history endpoints reject query fields, GET, non-JSON and oversized bodies',async()=>{
 const history=ports(),host=await start(history);
 expect((await post(host,'/api/semantic-history?tenantId=other',{...base,limit:20})).status).toBe(400);
 expect((await fetch(host+'/api/semantic-history')).status).toBe(404);
 expect((await post(host,'/api/semantic-history',{...base,limit:20},{'content-type':'text/plain'})).status).toBe(400);
 expect((await post(host,'/api/semantic-history','x'.repeat(8193))).status).toBe(400);
 expect(history.readHistory).not.toHaveBeenCalled();
});

test('a trusted host HTTPS origin supports proxy deployment without accepting a caller origin override',async()=>{
 const history=ports();
 for(const origin of ['null','https://portal.example/','https://user:secret@portal.example','https://portal.example/path'])
  expect(()=>createPortalServer({query,authenticate:async()=>principal,semanticHistory:history,semanticHistoryWriteOrigin:origin})).toThrow('PORTAL_HOST_REQUIRED');
 const server=createPortalServer({query,authenticate:async()=>principal,semanticHistory:history,semanticHistoryWriteOrigin:'https://portal.example'});
 server.listen(0,'127.0.0.1');await once(server,'listening');opened.push(server);
 const address=server.address();if(!address||typeof address==='string')throw Error('no address');
 const host=`http://127.0.0.1:${address.port}`,body={...base,historyId:'1',decision:'acknowledged',expectedVersion:'0'};
 expect((await post(host,'/api/semantic-history/review',body,{origin:'https://portal.example','sec-fetch-site':'same-origin'})).status).toBe(200);
 expect((await post(host,'/api/semantic-history/review',body,{origin:host})).status).toBe(403);
 expect(history.recordHistoryReview).toHaveBeenCalledOnce();
});

test('history output uses the portal response bound and withholds oversized data',async()=>{
 const history=ports(),host=await start(history);
 history.readHistory.mockResolvedValueOnce({status:'resolved',private:'CANARY_OUTPUT'.repeat(100_000)} as never);
 const response=await post(host,'/api/semantic-history',{...base,limit:20});
 expect(response.status).toBe(422);expect(await response.text()).toBe('{"error":"RESULT_LIMIT_EXCEEDED"}');
});

test('a host can expose private history without registering either owner annotation port',async()=>{
 const history=ports(),host=await start({readHistory:history.readHistory});
 expect((await post(host,'/api/semantic-history',{...base,limit:20})).status).toBe(200);
 expect((await post(host,'/api/semantic-history/reviews',{...base,historyId:'1',limit:20})).status).toBe(404);
 expect((await post(host,'/api/semantic-history/review',{...base,historyId:'1',decision:'acknowledged',expectedVersion:'0'})).status).toBe(404);
 expect(history.readHistoryReviews).not.toHaveBeenCalled();expect(history.recordHistoryReview).not.toHaveBeenCalled();
});
