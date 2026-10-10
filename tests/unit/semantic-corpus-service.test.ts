import {readFile} from "node:fs/promises";
import {expect,test,vi} from "vitest";
import {deriveEndpointIdentity,parseContractSnapshot,type ContractSnapshot} from "../../packages/ir/src/index.js";
import {createSemanticCorpusService} from "../../packages/semantics/src/corpus-service.js";
import type {CorpusOperationCandidate,CorpusOperationSearchResult,QueryContractResult,QueryPin} from "../../packages/query/src/index.js";
import type {SemanticAnalysisResult} from "../../packages/semantics/src/types.js";

const baseSnapshot=JSON.parse(await readFile(new URL("../fixtures/ir/express-snapshot.json",import.meta.url),"utf8")) as ContractSnapshot;
const endpoint=baseSnapshot.endpoints.find(item=>item.endpoint_id==="ep-create")!;
const evidenceId="ev-corpus-summary";
const makeSnapshot=(serviceId:string):ContractSnapshot=>{
  const snapshot=structuredClone(baseSnapshot);snapshot.service.service_id=serviceId;
  snapshot.config.config_fingerprint="sha256:"+"a".repeat(64);
  for(const item of snapshot.endpoints)item.identity=deriveEndpointIdentity({identity_version:item.identity.identity_version,
    service_id:serviceId,method:item.identity.method,application_path:item.application_path,selectors:item.identity.selectors});
  snapshot.export_eligibility=[];
  for(const evidence of snapshot.evidence)if(evidence.scope.service_id===baseSnapshot.service.service_id)evidence.scope.service_id=serviceId;
  for(const claim of snapshot.claims)if(claim.subject.service_id===baseSnapshot.service.service_id)claim.subject.service_id=serviceId;
  const documentEvidence=structuredClone(snapshot.evidence[0]!);documentEvidence.evidence_id=evidenceId;
  documentEvidence.source={kind:"api_document",source_id:snapshot.source.repository_id};documentEvidence.source_version=snapshot.source.immutable_revision;
  documentEvidence.method="type_declaration";documentEvidence.location={path:"openapi.yaml",pointer:"#/paths/~1orders/get/summary"};
  documentEvidence.scope={service_id:serviceId,snapshot_id:snapshot.snapshot_id,endpoint_id:endpoint.endpoint_id,revision:snapshot.source.immutable_revision};
  snapshot.evidence.push(documentEvidence);
  const parsed=parseContractSnapshot(snapshot);if(!parsed.ok)throw new Error(JSON.stringify(parsed.error));return parsed.value;
};
const pinFor=(snapshot:ContractSnapshot,checkpoint:string):QueryPin=>({snapshotId:snapshot.snapshot_id,
  revision:snapshot.source.immutable_revision,configFingerprint:snapshot.config.config_fingerprint,checkpointVersion:checkpoint});
const selection=(repositoryId:string,serviceId:string,checkpoint:string)=>({version:"1" as const,tenantId:"tenant-a",repositoryId,serviceId,
  selector:{kind:"environment" as const,environment:"uat",expectedCheckpointVersion:checkpoint}});
const candidate=(repositoryId:string,serviceId:string,checkpoint:string,snapshot=makeSnapshot(serviceId)):CorpusOperationCandidate=>({
  endpointId:endpoint.endpoint_id,method:endpoint.identity.method,path:endpoint.application_path,label:"Read order",
  evidenceIds:[evidenceId],score:5,repositoryId,serviceId,selector:selection(repositoryId,serviceId,checkpoint),pin:pinFor(snapshot,checkpoint)});
const candidatesResult=(items:readonly CorpusOperationCandidate[],extra:Partial<Extract<CorpusOperationSearchResult,{status:"candidates"}>>={})=>({
  status:"candidates" as const,matchMode:"keyword" as const,scope:"visible_authorized_services" as const,environment:"uat",
  candidates:items,complete:true,truncated:false,...extra});
const context={tenantId:"tenant-a",principalId:"reader-a"};
const options={environment:"uat",intentQuery:"look up an order",limit:16};
const contractResult=(serviceId:string,checkpoint:string):QueryContractResult=>{
  const snapshot=makeSnapshot(serviceId),selected=selection(snapshot.source.repository_id,serviceId,checkpoint);
  return {status:"resolved",selector:selected,pin:pinFor(snapshot,checkpoint),snapshot,publication:{status:"absent"}};
};
const semanticResult=(serviceId:string,checkpoint:string):Extract<SemanticAnalysisResult,{status:"suggestions"}>=>{
  const selectedSnapshot=makeSnapshot(serviceId),selected=selection(selectedSnapshot.source.repository_id,serviceId,checkpoint);
  return {status:"suggestions",suggestions:[{endpointId:endpoint.endpoint_id,intent:"Read order",summary:"Candidate API",evidenceIds:[evidenceId]}],
    verification:"inferred",review:"unreviewed",normative:false,
    contextCoverage:{status:"complete",requestedEndpointIds:[endpoint.endpoint_id],analyzedEndpointIds:[endpoint.endpoint_id],omittedEndpointIds:[]},
    provenance:{provider:"openai",model:"model-test",promptVersion:"semantic-discovery-1",selector:selected.selector,
      pin:pinFor(selectedSnapshot,checkpoint)}};
};
const setup=(initial:CorpusOperationSearchResult,final=initial)=>{
  let searches=0;
  const search=vi.fn(async()=>searches++===0?initial:final);
  const readContract=vi.fn(async(_ctx:unknown,selected:unknown)=>{
    const value=selected as ReturnType<typeof selection>;return contractResult(value.serviceId,value.selector.expectedCheckpointVersion!);
  });
  const discover=vi.fn(async(_ctx:unknown,selected:unknown):Promise<SemanticAnalysisResult>=>{
    const value=selected as ReturnType<typeof selection>;return semanticResult(value.serviceId,value.selector.expectedCheckpointVersion!);
  });
  return {service:createSemanticCorpusService({corpusReader:{searchOperationCandidatesAcrossServices:search,readContract},semanticService:{discover}}),search,readContract,discover};
};

test("keeps same endpoint IDs namespaced by service and retains each exact pin and inferred result",async()=>{
  const items=[candidate("commerce","orders","7"),candidate("commerce","billing","8")];
  const ports=setup(candidatesResult(items));
  await expect(ports.service.discoverAcrossServices(context,options)).resolves.toMatchObject({status:"groups",
    scope:"keyword_candidates",verification:"inferred",review:"unreviewed",normative:false,
    shortlistCoverage:{complete:true,truncated:false},groups:[
      {repositoryId:"commerce",serviceId:"orders",pin:{checkpointVersion:"7"},result:{status:"suggestions",normative:false}},
      {repositoryId:"commerce",serviceId:"billing",pin:{checkpointVersion:"8"},result:{status:"suggestions",normative:false}}]});
  expect(ports.discover).toHaveBeenCalledTimes(2);expect(ports.search).toHaveBeenCalledTimes(2);
  expect(ports.readContract).toHaveBeenCalledTimes(2);
});

test("does not call a model when keyword shortlist is a complete no-match",async()=>{
  const noMatch:CorpusOperationSearchResult={status:"no_match",matchMode:"keyword",scope:"visible_authorized_services",
    environment:"uat",complete:true,truncated:false};const ports=setup(noMatch);
  await expect(ports.service.discoverAcrossServices(context,options)).resolves.toMatchObject({status:"shortlist_no_match",
    scope:"keyword_candidates",matchMode:"keyword",complete:true,normative:false});
  expect(ports.discover).not.toHaveBeenCalled();expect(ports.search).toHaveBeenCalledOnce();
});

test("preserves partial and truncated corpus coverage alongside per-service semantic output",async()=>{
  const items=[candidate("commerce","orders","7")],ports=setup(candidatesResult(items,{complete:false,truncated:true,incompleteReason:"incomplete_scan"}));
  await expect(ports.service.discoverAcrossServices(context,options)).resolves.toMatchObject({status:"groups",
    shortlistCoverage:{complete:false,truncated:true,incompleteReason:"incomplete_scan"},groups:[{result:{status:"suggestions"}}]});
});

test("withholds before any model call when shortlist exceeds the service-group budget",async()=>{
  const items=["one","two","three","four","five"].map((service,index)=>candidate("commerce",service,String(index+1)));
  const ports=setup(candidatesResult(items));
  await expect(ports.service.discoverAcrossServices(context,options)).resolves.toMatchObject({status:"unknown",reason:"group_limit"});
  expect(ports.discover).not.toHaveBeenCalled();expect(ports.readContract).not.toHaveBeenCalled();
});

test("checks every group pin before any contract or provider call",async()=>{
  const first=candidate("commerce","orders","7");
  const second={...candidate("commerce","billing","8"),pin:{...candidate("commerce","billing","8").pin,selectedRevision:"9"}};
  const ports=setup(candidatesResult([first,second]));
  await expect(ports.service.discoverAcrossServices(context,options)).resolves.toMatchObject({status:"unknown",reason:"unsupported_pin"});
  expect(ports.readContract).not.toHaveBeenCalled();expect(ports.discover).not.toHaveBeenCalled();
});

test("discards all group results if the authorized corpus changes during provider work",async()=>{
  const initial=candidatesResult([candidate("commerce","orders","7")]);
  const changed=candidatesResult([candidate("commerce","orders","8")]);const ports=setup(initial,changed);
  await expect(ports.service.discoverAcrossServices(context,options)).rejects.toMatchObject({code:"SEMANTIC_CORPUS_STALE_CONTEXT"});
  expect(ports.discover).toHaveBeenCalledOnce();expect(ports.search).toHaveBeenCalledTimes(2);
});

test("rejects malformed requests, hostile port results and suggestions with ungrounded IDs",async()=>{
  const items=[candidate("commerce","orders","7")],result=candidatesResult(items),ports=setup(result);
  const accessor=Object.defineProperty({...context},"principalId",{enumerable:true,get(){throw Error("TRAP");}});
  await expect(ports.service.discoverAcrossServices(accessor,options)).rejects.toMatchObject({code:"SEMANTIC_CORPUS_INVALID_REQUEST"});
  const malformed=setup({...result,candidates:[{...items[0]!,serviceId:"other"}]});
  await expect(malformed.service.discoverAcrossServices(context,options)).rejects.toMatchObject({code:"SEMANTIC_CORPUS_UNAVAILABLE"});
  const invalid=setup(result);invalid.discover.mockResolvedValue({...semanticResult("orders","7"),status:"suggestions",
    suggestions:[{endpointId:"foreign-endpoint",intent:"Read order",summary:"Wrong",evidenceIds:[evidenceId]}]} as SemanticAnalysisResult);
  await expect(invalid.service.discoverAcrossServices(context,options)).rejects.toMatchObject({code:"SEMANTIC_CORPUS_UNAVAILABLE"});
});

test("accepts a current publication only when its selector exactly matches the selected environment pin",async()=>{
  const item=candidate("commerce","orders","7"),search=vi.fn(async()=>candidatesResult([item]));
  const snapshot=makeSnapshot("orders"),selected=selection(snapshot.source.repository_id,"orders","7");
  const readContract=vi.fn(async()=>({status:"resolved",selector:selected,pin:pinFor(snapshot,"7"),snapshot,
    publication:{status:"current",publicationId:"pub-1",contentSha256:"sha256:"+"b".repeat(64),selector:{kind:"environment",
      repositoryId:snapshot.source.repository_id,serviceId:"orders",snapshotId:snapshot.snapshot_id,
      revision:snapshot.source.immutable_revision,configFingerprint:snapshot.config.config_fingerprint,
      environment:"uat",checkpointVersion:"7",resolvedSnapshotIds:[snapshot.snapshot_id]}}} as unknown as QueryContractResult));
  const discover=vi.fn(async()=>semanticResult("orders","7"));
  const service=createSemanticCorpusService({corpusReader:{searchOperationCandidatesAcrossServices:search,readContract},semanticService:{discover}});
  await expect(service.discoverAcrossServices(context,options)).resolves.toMatchObject({status:"groups",groups:[{serviceId:"orders"}]});
  expect(discover).toHaveBeenCalledOnce();
});

test("maps malformed provider values and provider exceptions to a fixed error",async()=>{
  const ports=setup(candidatesResult([candidate("commerce","orders","7")]));
  ports.discover.mockRejectedValue(new Error("private provider response"));
  await expect(ports.service.discoverAcrossServices(context,options)).rejects.toMatchObject({code:"SEMANTIC_CORPUS_UNAVAILABLE"});
  const malformed=setup(candidatesResult([candidate("commerce","orders","7")]));
  malformed.discover.mockResolvedValue({status:"suggestions",suggestions:[],verification:"inferred",review:"unreviewed",normative:false,
    contextCoverage:{status:"complete",requestedEndpointIds:[endpoint.endpoint_id],analyzedEndpointIds:[endpoint.endpoint_id],omittedEndpointIds:[]},
    provenance:{provider:"openai",model:"model-test",promptVersion:"semantic-discovery-1",
      selector:{kind:"environment",environment:"uat"},pin:pinFor(makeSnapshot("orders"),"7")}} as SemanticAnalysisResult);
  await expect(malformed.service.discoverAcrossServices(context,options)).rejects.toMatchObject({code:"SEMANTIC_CORPUS_UNAVAILABLE"});
});


test("rejects extra caller authority, absent limits and inert getter/proxy ports before querying",async()=>{
  const ports=setup(candidatesResult([candidate("commerce","orders","7")]));
  for(const request of [{...options,provider:"claude"},{...options,tenantId:"other"},
    {...options,limit:undefined},{...options,limit:17}]){
    await expect(ports.service.discoverAcrossServices(context,request)).rejects.toMatchObject({code:"SEMANTIC_CORPUS_INVALID_REQUEST"});
  }
  expect(ports.search).not.toHaveBeenCalled();
  const getter=vi.fn(()=>ports.search);
  const corpusReader=Object.defineProperty({readContract:ports.readContract},"searchOperationCandidatesAcrossServices",{get:getter});
  expect(()=>createSemanticCorpusService({corpusReader:corpusReader as never,semanticService:{discover:ports.discover}}))
    .toThrow("SEMANTIC_CORPUS_INVALID_REQUEST");
  expect(getter).not.toHaveBeenCalled();
  const revoked=Proxy.revocable({},{});revoked.revoke();
  await expect(ports.service.discoverAcrossServices(context,revoked.proxy)).rejects.toMatchObject({code:"SEMANTIC_CORPUS_INVALID_REQUEST"});
});

test("rejects cross-endpoint citations and incomplete coverage before returning a result",async()=>{
  for(const change of [
    {suggestions:[{endpointId:endpoint.endpoint_id,intent:"Read order",summary:"Candidate API",evidenceIds:["foreign-evidence"]}]},
    {contextCoverage:{status:"complete",requestedEndpointIds:[endpoint.endpoint_id],analyzedEndpointIds:[],omittedEndpointIds:[]}},
    {provenance:{...semanticResult("orders","7").provenance,secret:"private-canary"}},
  ]){
    const ports=setup(candidatesResult([candidate("commerce","orders","7")]));
    ports.discover.mockResolvedValue({...semanticResult("orders","7"),...change} as SemanticAnalysisResult);
    await expect(ports.service.discoverAcrossServices(context,options)).rejects.toMatchObject({code:"SEMANTIC_CORPUS_UNAVAILABLE"});
  }
});


test("withholds results that omit semantic context coverage or incomplete shortlist reason",async()=>{
  const ports=setup(candidatesResult([candidate("commerce","orders","7")]));
  const {contextCoverage: omitted,...result}=semanticResult("orders","7");
  ports.discover.mockResolvedValue(result);
  await expect(ports.service.discoverAcrossServices(context,options)).rejects.toMatchObject({code:"SEMANTIC_CORPUS_UNAVAILABLE"});
});

test("rejects an incomplete keyword shortlist without a reason before inference",async()=>{
  const incomplete=setup(candidatesResult([candidate("commerce","orders","7")],{complete:false}));
  await expect(incomplete.service.discoverAcrossServices(context,options)).rejects.toMatchObject({code:"SEMANTIC_CORPUS_UNAVAILABLE"});
  expect(incomplete.discover).not.toHaveBeenCalled();
});

test.each(["suggestions","no_match","no_context"] as const)("rejects %s inconsistent with analyzed context",async status=>{
  const ports=setup(candidatesResult([candidate("commerce","orders","7")]));
  const grounded=semanticResult("orders","7");
  const coverage={status:"partial" as const,requestedEndpointIds:[endpoint.endpoint_id],analyzedEndpointIds:[],omittedEndpointIds:[endpoint.endpoint_id]};
  ports.discover.mockResolvedValue(status==="suggestions"?{...grounded,contextCoverage:coverage}:
    status==="no_context"?{status,contextCoverage:grounded.contextCoverage!}:
    {status,reason:"No candidate",verification:"inferred",review:"unreviewed",normative:false,provenance:grounded.provenance,contextCoverage:coverage});
  await expect(ports.service.discoverAcrossServices(context,options)).rejects.toMatchObject({code:"SEMANTIC_CORPUS_UNAVAILABLE"});
});

test.each(["suggestions","ambiguous"] as const)("rejects %s naming an omitted operation while another operation was analyzed",async status=>{
  const first=candidate("commerce","orders","7"),snapshot=makeSnapshot("orders");
  const other=snapshot.endpoints.find(item=>item.endpoint_id!==endpoint.endpoint_id)!;
  const evidence=structuredClone(snapshot.evidence.find(item=>item.evidence_id===evidenceId)!);
  evidence.evidence_id="ev-other-document";evidence.scope.endpoint_id=other.endpoint_id;snapshot.evidence.push(evidence);
  const second={...first,endpointId:other.endpoint_id,method:other.identity.method,path:other.application_path,evidenceIds:[evidence.evidence_id]};
  const ports=setup(candidatesResult([first,second]));
  ports.readContract.mockResolvedValue({...contractResult("orders","7"),snapshot} as QueryContractResult);
  const grounded=semanticResult("orders","7"),contextCoverage={status:"partial" as const,
    requestedEndpointIds:[endpoint.endpoint_id,other.endpoint_id],analyzedEndpointIds:[other.endpoint_id],omittedEndpointIds:[endpoint.endpoint_id]};
  const {suggestions: omitted,...common}=grounded;
  ports.discover.mockResolvedValue(status==="suggestions"?{...grounded,contextCoverage}:
    {...common,status,candidateEndpointIds:[endpoint.endpoint_id,other.endpoint_id],reason:"Clarify candidates",contextCoverage});
  await expect(ports.service.discoverAcrossServices(context,options)).rejects.toMatchObject({code:"SEMANTIC_CORPUS_UNAVAILABLE"});
  if(status==="suggestions"){
    ports.discover.mockResolvedValue({...grounded,contextCoverage,suggestions:[{endpointId:other.endpoint_id,intent:"Read operation",
      summary:"Candidate operation",evidenceIds:[evidence.evidence_id]}]});
    await expect(ports.service.discoverAcrossServices(context,options)).resolves.toMatchObject({status:"groups",
      groups:[{result:{status:"suggestions",contextCoverage:{status:"partial",omittedEndpointIds:[endpoint.endpoint_id]}}}]});
  }
});

for(const stuckAt of ['initial search','contract','provider','final search'] as const)test(`whole-operation deadline withholds a stalled ${stuckAt} and releases its timer`,async()=>{
 vi.useFakeTimers({toFake:['setTimeout','clearTimeout','performance']});
 try{
  const initial=candidatesResult([candidate('commerce','orders','7')]);let searches=0;
  const hanging=new Promise<never>(()=>{}),discover=vi.fn(async()=>stuckAt==='provider'?hanging:semanticResult('orders','7'));
  const search=vi.fn(async()=>{searches++;return stuckAt==='initial search'||stuckAt==='final search'&&searches===2?hanging:initial;});
  const readContract=vi.fn(async()=>stuckAt==='contract'?hanging:contractResult('orders','7'));
  const service=createSemanticCorpusService({corpusReader:{searchOperationCandidatesAcrossServices:search,readContract},semanticService:{discover},deadlineMs:1000});
  const result=service.discoverAcrossServices(context,options);const rejected=expect(result).rejects.toMatchObject({code:'SEMANTIC_CORPUS_UNAVAILABLE'});
  await vi.advanceTimersByTimeAsync(1000);await rejected;expect(vi.getTimerCount()).toBe(0);
  if(stuckAt==='initial search'||stuckAt==='contract')expect(discover).not.toHaveBeenCalled();
 }finally{vi.useRealTimers();}
});

test('late inference cannot start another group and the budget is shared across all phases',async()=>{
 vi.useFakeTimers({toFake:['setTimeout','clearTimeout','performance']});
 try{
  const initial=candidatesResult([candidate('commerce','orders','7'),candidate('commerce','billing','8')]);
  let release:((value:SemanticAnalysisResult)=>void)|undefined;
  const discover=vi.fn(async()=>new Promise<SemanticAnalysisResult>(resolve=>{release=resolve;}));
  const search=vi.fn(async()=>{await new Promise(resolve=>setTimeout(resolve,700));return initial;});
  const readContract=vi.fn(async()=>contractResult('orders','7'));
  const service=createSemanticCorpusService({corpusReader:{searchOperationCandidatesAcrossServices:search,readContract},semanticService:{discover},deadlineMs:1000});
  const result=service.discoverAcrossServices(context,options);const rejected=expect(result).rejects.toMatchObject({code:'SEMANTIC_CORPUS_UNAVAILABLE'});
  await vi.advanceTimersByTimeAsync(700);expect(discover).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(300);await rejected;release?.(semanticResult('orders','7'));await vi.advanceTimersByTimeAsync(0);
  expect(discover).toHaveBeenCalledOnce();expect(readContract).toHaveBeenCalledOnce();expect(search).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);
 }finally{vi.useRealTimers();}
});

test('deadline configuration is host-only, validated without getter execution, and successful calls release timers',async()=>{
 const ports=setup(candidatesResult([candidate('commerce','orders','7')]));
 for(const deadlineMs of [0,-1,60001,1.5,NaN,Infinity,'1000'])expect(()=>createSemanticCorpusService({corpusReader:{searchOperationCandidatesAcrossServices:ports.search,readContract:ports.readContract},semanticService:{discover:ports.discover},deadlineMs} as never)).toThrow('SEMANTIC_CORPUS_INVALID_REQUEST');
 const getter=vi.fn(()=>1000),input=Object.defineProperty({corpusReader:{searchOperationCandidatesAcrossServices:ports.search,readContract:ports.readContract},semanticService:{discover:ports.discover}},'deadlineMs',{get:getter,enumerable:true});
 expect(()=>createSemanticCorpusService(input as never)).toThrow('SEMANTIC_CORPUS_INVALID_REQUEST');expect(getter).not.toHaveBeenCalled();
 vi.useFakeTimers({toFake:['setTimeout','clearTimeout','performance']});try{
  await expect(ports.service.discoverAcrossServices(context,options)).resolves.toMatchObject({status:'groups'});expect(vi.getTimerCount()).toBe(0);
 }finally{vi.useRealTimers();}
});

for(const finalSearch of [false,true])test(`maps hostile ${finalSearch?'final':'initial'} search rejections without proxy trap execution`,async()=>{
 const initial=candidatesResult([candidate('commerce','orders','7')]),ports=setup(initial);
 const trap=vi.fn(()=>{throw Error('private-error-trap');}),revoked=Proxy.revocable({},{});revoked.revoke();
 for(const rejected of [revoked.proxy,new Proxy({},{getPrototypeOf:trap})]){
  ports.search.mockReset();if(finalSearch)ports.search.mockResolvedValueOnce(initial);ports.search.mockRejectedValueOnce(rejected);
  await expect(ports.service.discoverAcrossServices(context,options)).rejects.toMatchObject({code:'SEMANTIC_CORPUS_UNAVAILABLE',message:'SEMANTIC_CORPUS_UNAVAILABLE'});
 }
 expect(trap).not.toHaveBeenCalled();
});
