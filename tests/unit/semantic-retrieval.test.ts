import {expect,test,vi} from 'vitest';
import {createSemanticRetrievalService} from '../../packages/semantics/src/retrieval.js';
const caller={tenantId:'tenant',principalId:'reader'},request={environment:'uat',intentQuery:'abort a purchase',limit:2};
const fixture=()=>{
 let revision='rev-one',revoked=false;const texts:string[][]=[];
 const pin=()=>({snapshotId:'snapshot',revision,configFingerprint:'fingerprint',checkpointVersion:'1'});
 const query={searchServices:vi.fn(async()=>({services:['orders','sales'].map(serviceId=>({repositoryId:'commerce',serviceId,environment:{name:'uat',status:'resolved',pin:pin()}})),truncated:false})),
 readContract:vi.fn(async(_caller:unknown,selection:any)=>({status:'resolved',selector:selection,pin:pin(),snapshot:{endpoints:[{endpoint_id:'same-id'}],coverage:{status:'complete'}}}))};
 const context={readRetrievalContext:vi.fn(async(_caller:unknown,selection:any)=>{if(revoked)throw Error('private denied');return {configurationHash:'sha256:'+'a'.repeat(64),source:{repositoryId:selection.repositoryId,serviceId:selection.serviceId,selector:selection.selector,pin:pin()},endpoints:[{endpointId:'same-id',method:'POST',applicationPath:'/action',documents:[{kind:'operation_summary',text:selection.serviceId==='orders'?'void a sale':'read shipment',evidenceIds:['ev']}]}]};})};
 const embedding={spaceId:'fixture-space-v1',dimensions:2,embed:vi.fn(async(batch:readonly string[])=>{texts.push([...batch]);return batch.map(text=>text.includes('shipment')?[0,1]:[1,0]);})};
 return {query,context,embedding,texts,setRevision:(value:string)=>{revision=value;},revoke:()=>{revoked=true;},create:(options={})=>createSemanticRetrievalService({query:query as never,context:context as never,embedding,...options})};
};
test('meaning retrieval ranks differently worded APIs without a keyword shortlist and preserves service namespaces',async()=>{
 const f=fixture(),result=await f.create().retrieve(caller,request);
 expect(result).toMatchObject({matchMode:'semantic',normative:false,complete:true,truncated:false,candidates:[{serviceId:'orders',endpointId:'same-id',score:1},{serviceId:'sales',endpointId:'same-id',score:0}]});
 expect(f.texts).toEqual([['operation_summary: void a sale','operation_summary: read shipment'],['abort a purchase']]);
 expect(JSON.stringify(result)).not.toContain('void a sale');expect(Object.isFrozen(result.candidates)).toBe(true);
 expect(f.query.searchServices).toHaveBeenCalledWith(caller,{tenantId:'tenant',query:'',environment:'uat',limit:50});
 expect(f.context.readRetrievalContext).toHaveBeenCalledTimes(4);
});
test('cache reuses vectors only after current context reads and replaces them after a source revision changes',async()=>{
 const f=fixture(),service=f.create();await service.retrieve(caller,request);await service.retrieve(caller,request);
 expect(f.embedding.embed).toHaveBeenCalledTimes(3);expect(f.context.readRetrievalContext).toHaveBeenCalledTimes(8);
 f.setRevision('rev-two');await service.retrieve(caller,request);expect(f.embedding.embed).toHaveBeenCalledTimes(5);
 service.clearCache();await service.retrieve(caller,request);expect(f.embedding.embed).toHaveBeenCalledTimes(7);
});
test('cache entries are private to the authenticated principal and bounded host capacity',async()=>{
 const f=fixture(),service=f.create({cacheEntries:1});await service.retrieve(caller,request);await service.retrieve({...caller,principalId:'another'},request);
 expect(f.embedding.embed).toHaveBeenCalledTimes(4);
 const disabled=f.create({cacheEntries:0});await disabled.retrieve(caller,request);await disabled.retrieve(caller,request);expect(f.embedding.embed).toHaveBeenCalledTimes(8);
});
test('authority or source changes during embedding withhold results and do not populate the vector cache',async()=>{
 for(const change of ['revision','revocation']){
  const f=fixture();f.embedding.embed.mockImplementationOnce(async(batch)=>{if(change==='revision')f.setRevision('rev-two');else f.revoke();return batch.map(()=>[1,0]);});
  await expect(f.create().retrieve(caller,request)).rejects.toMatchObject({code:change==='revision'?'SEMANTIC_RETRIEVAL_STALE_CONTEXT':'SEMANTIC_RETRIEVAL_UNAVAILABLE'});
 }
});
test.each([[],[[0,0],[0,0]],[[NaN,1],[1,0]],[[1],[1]],[[Infinity,0],[1,0]]].map(output=>({output})))('invalid embedding output is withheld: %j',async({output})=>{
 const f=fixture();f.embedding.embed.mockResolvedValueOnce(output as never);await expect(f.create().retrieve(caller,request)).rejects.toMatchObject({code:'SEMANTIC_RETRIEVAL_UNAVAILABLE'});
});
test('scaled finite vectors avoid overflow during cosine ranking',async()=>{
 const f=fixture();f.embedding.embed.mockImplementation(async(batch)=>batch.map(()=>[Number.MAX_VALUE,Number.MAX_VALUE]));
 expect((await f.create().retrieve(caller,request)).candidates[0]?.score).toBeCloseTo(1);
});
test('malformed caller requests reject before source or embedding ports',async()=>{
 const f=fixture(),service=f.create(),trap=vi.fn(()=>{throw Error('secret');});
 for(const value of [{...request,tenantId:'other'},{...request,limit:17},{...request,intentQuery:'password=secret'},new Proxy({},{ownKeys:trap})])
  await expect(service.retrieve(caller,value)).rejects.toMatchObject({code:'SEMANTIC_RETRIEVAL_INVALID_REQUEST'});
 expect(trap).not.toHaveBeenCalled();expect(f.query.searchServices).not.toHaveBeenCalled();expect(f.embedding.embed).not.toHaveBeenCalled();
});
test('secret-shaped or uncited context is never sent to embedding ports',async()=>{
 const f=fixture();f.context.readRetrievalContext.mockImplementation(async(_caller,selection)=>({configurationHash:'sha256:'+'a'.repeat(64),source:{repositoryId:selection.repositoryId,serviceId:selection.serviceId,selector:selection.selector,pin:{snapshotId:'snapshot',revision:'rev-one',configFingerprint:'fingerprint',checkpointVersion:'1'}},endpoints:[{endpointId:'same-id',method:'POST',applicationPath:'/action',documents:[{kind:'operation_summary',text:'password=secret',evidenceIds:['ev']}]}]}));
 await expect(f.create().retrieve(caller,request)).rejects.toMatchObject({code:'SEMANTIC_RETRIEVAL_UNAVAILABLE'});expect(f.embedding.embed).not.toHaveBeenCalled();
});
test('deadline withholds stalled work and does not start embedding after a late source response',async()=>{
 const f=fixture();let release!:()=>void;
 f.query.searchServices.mockImplementationOnce(()=>new Promise(resolve=>{release=()=>resolve({services:[],truncated:false});}));
 await expect(f.create({deadlineMs:5}).retrieve(caller,request)).rejects.toMatchObject({code:'SEMANTIC_RETRIEVAL_UNAVAILABLE'});release();await Promise.resolve();expect(f.embedding.embed).not.toHaveBeenCalled();
});
test('hostile port errors do not execute proxy traps or disclose their text',async()=>{
 const f=fixture(),trap=vi.fn(()=>{throw Error('SECRET_MARKER');});f.query.searchServices.mockRejectedValueOnce(new Proxy({}, {get:trap,getPrototypeOf:trap}));
 await expect(f.create().retrieve(caller,request)).rejects.toMatchObject({message:'SEMANTIC_RETRIEVAL_UNAVAILABLE'});expect(trap).not.toHaveBeenCalled();
});

test('aggregate port copying is capped across services before embedding egress',async()=>{
 const f=fixture();f.query.readContract.mockImplementation(async(_caller,selection)=>({status:'resolved',selector:selection,pin:{snapshotId:'snapshot',revision:'rev-one',configFingerprint:'fingerprint',checkpointVersion:'1'},snapshot:{endpoints:[{endpoint_id:'same-id'}],coverage:{status:'complete'},padding:Array.from({length:100},()=> 'a'.repeat(30_000))}}));
 f.query.searchServices.mockImplementation(async()=>({services:Array.from({length:10},(_,i)=>({repositoryId:'commerce',serviceId:'service'+i,environment:{name:'uat',status:'resolved',pin:{snapshotId:'snapshot',revision:'rev-one',configFingerprint:'fingerprint',checkpointVersion:'1'}}})),truncated:false}));
 await expect(f.create().retrieve(caller,request)).rejects.toMatchObject({code:'SEMANTIC_RETRIEVAL_UNAVAILABLE'});expect(f.query.readContract.mock.calls.length).toBeLessThan(10);expect(f.embedding.embed).not.toHaveBeenCalled();
});

test('host option getters and proxies are rejected without execution',()=>{
 const f=fixture(),trap=vi.fn(()=>{throw Error('must not execute');});
 expect(()=>createSemanticRetrievalService(new Proxy({},{getOwnPropertyDescriptor:trap}) as never)).toThrow('SEMANTIC_RETRIEVAL_INVALID_REQUEST');
 const options={query:f.query,context:f.context,embedding:f.embedding};Object.defineProperty(options,'embedding',{get:trap,enumerable:true});
 expect(()=>createSemanticRetrievalService(options as never)).toThrow('SEMANTIC_RETRIEVAL_INVALID_REQUEST');expect(trap).not.toHaveBeenCalled();
});
