import {readFile} from 'node:fs/promises';
import {expect,test,vi} from 'vitest';
import {createPortalDemoHistory} from '../../apps/portal/src/demo-history.js';
import type {ContractSnapshot} from '../../packages/ir/src/index.js';
const setup=async()=>{
 const snapshot=JSON.parse(await readFile(new URL('../fixtures/ir/express-snapshot.json',import.meta.url),'utf8')) as ContractSnapshot;
 const context={tenantId:'local-demo',principalId:'local-viewer'};
 const selection={version:'1',tenantId:context.tenantId,repositoryId:snapshot.service.repository_id,serviceId:snapshot.service.service_id,selector:{kind:'environment',environment:'uat',expectedCheckpointVersion:'1'}};
 return {context,selection,history:createPortalDemoHistory(snapshot,context),snapshot};
};
test('synthetic history has no provider prose and requires its exact demo context and pin',async()=>{
 const {context,selection,history}=await setup();
 const result=await history.readHistory(context,selection,['ep-get'],20);
 expect(result.records).toHaveLength(1);expect(result.records[0]).toMatchObject({historyId:'1',verification:'inferred',review:'unreviewed',normative:false});
 expect(JSON.stringify(result)).not.toMatch(/intent|summary|credential/);
 await expect(history.readHistory({...context,principalId:'other'},selection,['ep-get'],20)).rejects.toMatchObject({code:'SEMANTIC_NOT_FOUND_OR_DENIED'});
 await expect(history.readHistory(context,{...selection,selector:{...selection.selector,expectedCheckpointVersion:'2'}},['ep-get'],20)).rejects.toMatchObject({code:'SEMANTIC_STALE_CONTEXT'});
 await expect(history.readHistory(context,{...selection,selector:{...selection.selector,environment:'staging'}},['ep-get'],20)).rejects.toMatchObject({code:'SEMANTIC_NOT_FOUND_OR_DENIED'});
 expect((await history.readHistory(context,selection,['ep-create'],20)).records).toEqual([]);
});
test('synthetic decisions use version replay, conflict and private immutable receipts',async()=>{
 const {context,selection,history}=await setup();const request={historyId:'1',decision:'follow_up',expectedVersion:'0'};
 const first=await history.recordHistoryReview(context,selection,['ep-get'],request);
 expect(first).toMatchObject({reviewVersion:'1',metadataOnly:true,nonNormative:true,replayed:false});expect(Object.isFrozen(first)).toBe(true);expect(first.createdAt).toMatch(/\.\d{6}Z$/);
 expect(await history.recordHistoryReview(context,selection,['ep-get','ep-create'],request)).toEqual({...first,replayed:true});
 await expect(history.recordHistoryReview(context,selection,['ep-get'],{...request,decision:'dismissed'})).rejects.toMatchObject({code:'SEMANTIC_REVIEW_CONFLICT'});
 await history.recordHistoryReview(context,selection,['ep-get'],{...request,decision:'acknowledged',expectedVersion:'1'});
 expect(await history.readHistoryReviews(context,selection,['ep-get'],'1',1)).toMatchObject({records:[{reviewVersion:'2'}],truncated:true});
 await expect(history.readHistoryReviews(context,selection,['ep-get'],'2',20)).rejects.toMatchObject({code:'SEMANTIC_NOT_FOUND_OR_DENIED'});
 await expect(history.recordHistoryReview(context,selection,['ep-create'],request)).rejects.toMatchObject({code:'SEMANTIC_NOT_FOUND_OR_DENIED'});
 const another=(await setup()).history;expect((await another.readHistoryReviews(context,selection,['ep-get'],'1',20)).records).toEqual([]);
});
test('demo history rejects malformed selectors, endpoint lists, limits and arbitrary decision fields',async()=>{
 const {context,selection,history}=await setup();
 for(const endpoints of [[],['ep-get','ep-get'],['unknown']])await expect(history.readHistory(context,selection,endpoints,20)).rejects.toMatchObject({code:'SEMANTIC_INVALID_REQUEST'});
 for(const limit of [0,21,1.5])await expect(history.readHistory(context,selection,['ep-get'],limit)).rejects.toMatchObject({code:'SEMANTIC_INVALID_REQUEST'});
 await expect(history.recordHistoryReview(context,selection,['ep-get'],{historyId:'1',decision:'approved',expectedVersion:'0'})).rejects.toMatchObject({code:'SEMANTIC_INVALID_REQUEST'});
 await expect(history.recordHistoryReview(context,selection,['ep-get'],{historyId:'1',decision:'dismissed',expectedVersion:'0',principalId:'other'})).rejects.toMatchObject({code:'SEMANTIC_INVALID_REQUEST'});
});

test('synthetic decisions are separate for revision and environment contexts',async()=>{
 const {context,selection,history,snapshot}=await setup();
 await history.recordHistoryReview(context,selection,['ep-get'],{historyId:'1',decision:'dismissed',expectedVersion:'0'});
 const revision={...selection,selector:{kind:'revision',revision:snapshot.source.immutable_revision}};
 expect((await history.readHistoryReviews(context,revision,['ep-get'],'1',20)).records).toEqual([]);
 await history.recordHistoryReview(context,revision,['ep-get'],{historyId:'1',decision:'follow_up',expectedVersion:'0'});
 expect((await history.readHistoryReviews(context,selection,['ep-get'],'1',20)).records[0]?.decision).toBe('dismissed');
});

test('demo write capacity stays bounded and old requests remain replayable at capacity',async()=>{
 const {context,selection,history}=await setup();
 for(let i=0;i<20;i++)await history.recordHistoryReview(context,selection,['ep-get'],{historyId:'1',decision:'acknowledged',expectedVersion:String(i)});
 await expect(history.recordHistoryReview(context,selection,['ep-get'],{historyId:'1',decision:'follow_up',expectedVersion:'20'})).rejects.toMatchObject({code:'SEMANTIC_STORAGE_ERROR'});
 expect(await history.recordHistoryReview(context,selection,['ep-get'],{historyId:'1',decision:'acknowledged',expectedVersion:'0'})).toMatchObject({reviewVersion:'1',replayed:true});
 expect((await history.readHistoryReviews(context,selection,['ep-get'],'1',20)).records).toHaveLength(20);
});
test('demo rejects proxy selectors and executable input fields without invoking them',async()=>{
 const {context,selection,history}=await setup();const trap=vi.fn(()=>{throw Error('must not run');});
 const proxy=new Proxy({}, {get:trap,getPrototypeOf:trap,getOwnPropertyDescriptor:trap});
 await expect(history.readHistory(context,{...selection,selector:proxy},['ep-get'],20)).rejects.toMatchObject({code:'SEMANTIC_INVALID_REQUEST'});
 const revoked=Proxy.revocable([],{});revoked.revoke();
 await expect(history.readHistory(context,selection,revoked.proxy,20)).rejects.toMatchObject({code:'SEMANTIC_INVALID_REQUEST'});
 const endpoints=['ep-get'];Object.defineProperty(endpoints,'0',{get:trap});
 await expect(history.readHistory(context,selection,endpoints,20)).rejects.toMatchObject({code:'SEMANTIC_INVALID_REQUEST'});
 const request={historyId:'1',decision:'acknowledged',expectedVersion:'0'};Object.defineProperty(request,'decision',{get:trap});
 await expect(history.recordHistoryReview(context,selection,['ep-get'],request)).rejects.toMatchObject({code:'SEMANTIC_INVALID_REQUEST'});expect(trap).not.toHaveBeenCalled();
});
