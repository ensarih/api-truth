import {mkdtemp,mkdir,readFile,rm,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach,expect,test,vi} from "vitest";
import {ANALYZER,createAnalyzer} from "../../../analyzers/java-spring/src/index.js";
import {contractSnapshotFromAnalyzerResult} from "../../../packages/catalog/src/index.js";
import type {AnalyzerRequest,Claim,ContractSnapshot} from "../../../packages/ir/src/index.js";
import {searchOperationCandidates} from "../../../packages/query/src/operation-search.js";
import {runGroundedSemanticDiscovery,SEMANTIC_DISCOVERY_SOURCE_PROMPT_VERSION}
  from "../../../packages/semantics/src/index.js";
import type {SemanticProviderRequest} from "../../../packages/semantics/src/types.js";

const roots:string[]=[];
afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
const source=new URL("../../../fixtures/java/orders/src/OrdersController.java",import.meta.url);
const build=async():Promise<ContractSnapshot>=>{
  const root=await mkdtemp(join(tmpdir(),"api-truth-java-discovery-"));roots.push(root);
  await mkdir(join(root,"src"));
  const fixture=(await readFile(source,"utf8"))
    .replace("X-Channel=partner","X-Channel=PRIVATE_HEADER_VALUE_CANARY")
    .replace('new OrderResponse(orderId, "partner")','new OrderResponse(orderId, "PRIVATE_BODY_CANARY")');
  await writeFile(join(root,"src","OrdersController.java"),fixture);
  const request:AnalyzerRequest={exchange_version:"1.0.0",ir_version:"1.0.0",request_id:"java-discovery",
    analyzer:ANALYZER,source:{repository_id:"repo",service_id:"orders",service_root:"src",
      immutable_revision:"a".repeat(40),source_digest:"pending",access_label:"java-source"},
    resolution_inputs:[{kind:"source_tree",path:"src",digest:"pending"}],prior_dependencies:[],changed_paths:[],
    extraction_mode:"baseline",limits:{timeout_ms:30_000,max_files:10,max_output_bytes:1_000_000},
    execution_policy:{network_access:false,side_effects:"none"}};
  const result=await createAnalyzer({projectRoot:root}).analyze(request);
  return contractSnapshotFromAnalyzerResult(result,"sha256:config-java").snapshot;
};
const matcherInput=(snapshot:ContractSnapshot)=>({status:"resolved" as const,
  selector:{version:"1" as const,tenantId:"tenant",repositoryId:snapshot.source.repository_id,
    serviceId:snapshot.service.service_id,selector:{kind:"environment" as const,environment:"test",
      expectedCheckpointVersion:"1"}},
  pin:{snapshotId:snapshot.snapshot_id,revision:snapshot.source.immutable_revision,
    configFingerprint:snapshot.config.config_fingerprint,checkpointVersion:"1"},snapshot,
  publication:{status:"absent" as const}});
const semanticInput=(snapshot:ContractSnapshot,endpointIds:string[])=>({snapshot,
  pin:{snapshotId:snapshot.snapshot_id,revision:snapshot.source.immutable_revision,
    configFingerprint:snapshot.config.config_fingerprint},
  selection:{version:"1" as const,tenantId:"tenant",repositoryId:snapshot.source.repository_id,
    serviceId:snapshot.service.service_id,selector:{kind:"revision" as const,revision:snapshot.source.immutable_revision}},
  inference:{enabled:true as const,provider:"openai" as const,model:"synthetic"},endpointIds,
  intentQuery:"find order"});

test("actual Java declarations become distinct tentative candidates without selector or body egress",async()=>{
  const snapshot=await build();
  const gets=snapshot.endpoints.filter(endpoint=>endpoint.identity.method==="GET");
  expect(gets).toHaveLength(2);
  const matched=searchOperationCandidates(matcherInput(snapshot),{intentQuery:"find order",limit:20});
  expect(matched).toMatchObject({status:"candidates",complete:false});
  if(matched.status!=="candidates")throw new Error("expected candidates");
  expect(new Set(matched.candidates.filter(item=>item.method==="GET").map(item=>item.endpointId)).size).toBe(2);
  expect(matched.candidates.every(item=>item.evidenceIds.length>0)).toBe(true);
  expect(JSON.stringify(matched)).not.toMatch(/PRIVATE_HEADER_VALUE_CANARY|PRIVATE_BODY_CANARY|X-Channel/);
  expect(searchOperationCandidates(matcherInput(snapshot),{intentQuery:"unrelated widget",limit:20}))
    .toMatchObject({status:"unknown",reason:"incomplete_snapshot"});

  const provider=vi.fn(async(request:SemanticProviderRequest)=>{
    expect(request.promptVersion).toBe(SEMANTIC_DISCOVERY_SOURCE_PROMPT_VERSION);
    expect(request.endpoints).toHaveLength(2);
    expect(new Set(request.endpoints.map(item=>item.endpointId)).size).toBe(2);
    expect(request.endpoints.every(item=>item.documents.map(doc=>doc.kind).join(",")==="code_route,code_handler"))
      .toBe(true);
    expect(JSON.stringify(request)).not.toMatch(/PRIVATE_HEADER_VALUE_CANARY|PRIVATE_BODY_CANARY|X-Channel|CreateOrderRequest|security|status/);
    return {status:"suggestions",suggestions:[{endpointId:request.endpoints[0]!.endpointId,
      intent:"Find an order",summary:"Tentative route identifier match",
      evidenceIds:[request.endpoints[0]!.documents[0]!.evidenceIds[0]!]}]};
  });
  await expect(runGroundedSemanticDiscovery(semanticInput(snapshot,gets.map(item=>item.endpoint_id)),provider))
    .resolves.toMatchObject({status:"suggestions",verification:"inferred",review:"unreviewed",normative:false,
      contextCoverage:{status:"complete",analyzedEndpointIds:gets.map(item=>item.endpoint_id)}});
  expect(provider).toHaveBeenCalledOnce();
});

test.each([
  ["wrong analyzer version",(snapshot:ContractSnapshot,_claim:Claim)=>{snapshot.analyzer.analyzer_version="0.1.1";}],
  ["wrong selector",(_snapshot:ContractSnapshot,claim:Claim)=>{
    (claim.value as {selectors:unknown}).selectors={};}],
  ["wrong method",(_snapshot:ContractSnapshot,claim:Claim)=>{
    (claim.value as {method:string}).method="OPTIONS";}],
  ["extra route field",(_snapshot:ContractSnapshot,claim:Claim)=>{
    (claim.value as Record<string,unknown>).security="api-key";}],
  ["wrong evidence version",(snapshot:ContractSnapshot,claim:Claim)=>{
    snapshot.evidence.find(item=>item.evidence_id===claim.evidence_ids[0])!.source_version="b".repeat(40);}],
  ["wrong evidence kind",(snapshot:ContractSnapshot,claim:Claim)=>{
    snapshot.evidence.find(item=>item.evidence_id===claim.evidence_ids[0])!.source.kind="api_document";}],
  ["wrong evidence method",(snapshot:ContractSnapshot,claim:Claim)=>{
    snapshot.evidence.find(item=>item.evidence_id===claim.evidence_ids[0])!.method="deterministic_analysis";}],
  ["owner asserted",(_snapshot:ContractSnapshot,claim:Claim)=>{claim.verification="owner_asserted";}],
  ["duplicate route claim",(snapshot:ContractSnapshot,claim:Claim)=>{
    snapshot.claims.push({...structuredClone(claim),claim_id:"duplicate-java-route"});}],
] as const)("%s Java route is withheld",async(_name,mutate)=>{
  const snapshot=await build();
  const claim=snapshot.claims.find(item=>item.predicate==="route.declaration")!;
  const endpointId=claim.subject.endpoint_id!;
  mutate(snapshot,claim);
  const matched=searchOperationCandidates(matcherInput(snapshot),{intentQuery:"find order",limit:20});
  expect(matched.status).not.toBe("no_match");
  if(matched.status==="candidates")expect(matched.candidates.some(item=>item.endpointId===endpointId)).toBe(false);
  const provider=vi.fn(async(_request:SemanticProviderRequest)=>({status:"no_match",reason:"no context"}));
  const semantic=await runGroundedSemanticDiscovery(semanticInput(snapshot,[endpointId]),provider);
  expect(semantic).toMatchObject({status:"no_context"});
  expect(provider).not.toHaveBeenCalled();
});

test("evidence linked to another endpoint is rejected before semantic egress",async()=>{
  const snapshot=await build();
  const claim=snapshot.claims.find(item=>item.predicate==="route.declaration")!;
  snapshot.evidence.find(item=>item.evidence_id===claim.evidence_ids[0])!.scope.endpoint_id=
    snapshot.endpoints.find(item=>item.endpoint_id!==claim.subject.endpoint_id)!.endpoint_id;
  const matched=searchOperationCandidates(matcherInput(snapshot),{intentQuery:"find order"});
  expect(matched.status).not.toBe("no_match");
  if(matched.status==="candidates")expect(matched.candidates.some(item=>item.endpointId===claim.subject.endpoint_id)).toBe(false);
  const provider=vi.fn(async(_request:SemanticProviderRequest)=>({status:"no_match",reason:"no context"}));
  await expect(runGroundedSemanticDiscovery(semanticInput(snapshot,[claim.subject.endpoint_id!]),provider))
    .resolves.toMatchObject({status:"no_context"});
  expect(provider).not.toHaveBeenCalled();
});
