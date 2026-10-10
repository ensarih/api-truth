import {mkdtemp,mkdir,rm,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname,join} from "node:path";
import {afterEach,expect,test,vi} from "vitest";
import {ANALYZER as EXPRESS_ANALYZER,createAnalyzer as createExpressAnalyzer} from "../../analyzers/typescript/src/index.js";
import {ANALYZER as ROUTING_ANALYZER,createAnalyzer as createRoutingAnalyzer} from "../../analyzers/routing-controllers/src/index.js";
import {ANALYZER as SWAGGER_ANALYZER,createAnalyzer as createSwaggerAnalyzer} from "../../analyzers/nodejs/src/index.js";
import {contractSnapshotFromAnalyzerResult} from "../../packages/catalog/src/index.js";
import type {AnalyzerRequest,ContractSnapshot} from "../../packages/ir/src/index.js";
import {runGroundedSemanticDiscovery} from "../../packages/semantics/src/index.js";
import type {SemanticProviderRequest} from "../../packages/semantics/src/types.js";
import {searchOperationCandidates} from "../../packages/query/src/operation-search.js";
import {createSemanticCorpusService} from "../../packages/semantics/src/corpus-service.js";

type Question={id:string;profile:"express"|"routing"|"swagger2";intentQuery:string;
  context?:"partial_empty"|"closed_contract";
  matcher:{status:"candidates";routes:string[];complete:boolean;scores?:number[]}|{status:"no_match";scope:"selected_contract"}
    |{status:"unknown";reason:string};discovery:"suggestions"|"ambiguous"|"no_match"|"no_context"};
const questions=JSON.parse(await (await import("node:fs/promises")).readFile(
  new URL("../fixtures/semantics/questions.json",import.meta.url),"utf8")) as Question[];
const roots:string[]=[];
const snapshots=new Map<Question["profile"],ContractSnapshot>();
afterEach(async()=>Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true}))));
const revision="a".repeat(40);
const definitions={
  express:{analyzer:EXPRESS_ANALYZER,create:createExpressAnalyzer,serviceRoot:"service",sourceFiles:{
    "app.ts":`import express from "express"; const app=express();
      function readOrder(req,res){return res.json({ok:true});}
      function createInvoice(req,res){return res.json({ok:true});}
      app.get("/orders/:orderId",readOrder); app.post("/invoices",createInvoice);`}},
  routing:{analyzer:ROUTING_ANALYZER,create:createRoutingAnalyzer,serviceRoot:"service",sourceFiles:{
    "app.ts":`import { createExpressServer } from "routing-controllers"; import { OrdersController } from "./orders";
      import { InvoiceController } from "./invoices"; createExpressServer({controllers:[OrdersController,InvoiceController]});`,
    "orders.ts":`import { JsonController, Get } from "routing-controllers";
      @JsonController("/orders") export class OrdersController { @Get("/:id") readOrder(){return "ok";} }`,
    "invoices.ts":`import { JsonController, Post } from "routing-controllers";
      @JsonController("/invoices") export class InvoiceController { @Post() createInvoice(){return "ok";} }`}},
  swagger2:{analyzer:SWAGGER_ANALYZER,create:createSwaggerAnalyzer,serviceRoot:".",sourceFiles:{
    "api/document.json":JSON.stringify({swagger:"2.0",info:{title:"Synthetic invoice API",version:"1"},paths:{
      "/invoices/{invoiceId}":{get:{summary:"Look up an invoice by identifier",operationId:"getInvoice",
        responses:{"200":{description:"Invoice found"}}}},
      "/invoices":{post:{summary:"Create a new invoice",operationId:"createInvoice",
        responses:{"201":{description:"Invoice created"}}}}}})}}};
const makeSnapshot=async(profile:Question["profile"]):Promise<ContractSnapshot>=>{
  const cached=snapshots.get(profile);if(cached)return structuredClone(cached);
  const definition=definitions[profile];const root=await mkdtemp(join(tmpdir(),`semantic-corpus-${profile}-`));roots.push(root);
  for(const [path,text] of Object.entries(definition.sourceFiles)){const absolute=join(root,definition.serviceRoot,path);
    await mkdir(dirname(absolute),{recursive:true});await writeFile(absolute,text);}
  const request:AnalyzerRequest={exchange_version:"1.0.0",ir_version:profile==="swagger2"?"1.1.0":"1.0.0",
    request_id:`semantic-corpus-${profile}`,analyzer:{...definition.analyzer},source:{repository_id:"synthetic-public",
      service_id:"sample-api",service_root:definition.serviceRoot,immutable_revision:revision,source_digest:"pending",
      access_label:"sample-read"},resolution_inputs:profile==="swagger2"?
      [{kind:"type_manifest",path:"api/document.json",digest:"pending"}]:
      [{kind:"source_tree",path:"service",digest:"pending"}],prior_dependencies:[],changed_paths:[],extraction_mode:"baseline",
    limits:{timeout_ms:30_000,max_files:20,max_output_bytes:1_000_000},execution_policy:{network_access:false,side_effects:"none"}};
  const result=await definition.create({projectRoot:root}).analyze(request);
  const snapshot=contractSnapshotFromAnalyzerResult(result,"sha256:semantic-corpus").snapshot;
  snapshots.set(profile,structuredClone(snapshot));return snapshot;
};
const route=(snapshot:ContractSnapshot,id:string)=>{const endpoint=snapshot.endpoints.find(item=>item.endpoint_id===id)!;
  return `${endpoint.identity.method} ${endpoint.application_path}`;};
const selection=(snapshot:ContractSnapshot,checkpoint="7")=>({version:"1" as const,tenantId:"tenant-a",
  repositoryId:snapshot.source.repository_id,serviceId:snapshot.service.service_id,
  selector:{kind:"environment" as const,environment:"staging",expectedCheckpointVersion:checkpoint}});
const pin=(snapshot:ContractSnapshot,checkpoint="7")=>({snapshotId:snapshot.snapshot_id,
  revision:snapshot.source.immutable_revision,configFingerprint:snapshot.config.config_fingerprint,checkpointVersion:checkpoint});
const matcherInput=(snapshot:ContractSnapshot)=>({status:"resolved" as const,selector:selection(snapshot),pin:pin(snapshot),snapshot,
  publication:{status:"absent" as const}});
const discoveryInput=(snapshot:ContractSnapshot,intentQuery:string)=>({snapshot,pin:pin(snapshot),selection:selection(snapshot),
  inference:{enabled:true as const,provider:"openai" as const,model:"synthetic-evaluation"},
  endpointIds:snapshot.endpoints.map(endpoint=>endpoint.endpoint_id),intentQuery});

test("curated manifest uses distinct questions and executes every discovery outcome",()=>{
  expect(questions.length).toBeGreaterThanOrEqual(30);
  expect(new Set(questions.map(question=>question.id)).size).toBe(questions.length);
  for(const question of questions)expect(["suggestions","ambiguous","no_match","no_context"]).toContain(question.discovery);
});

// Provider outcomes below are deterministic contract fixtures; they validate grounding and status handling,
// not live-model semantic accuracy.
test.each(questions)("question corpus: $id",async question=>{
  const snapshot=await makeSnapshot(question.profile);
  if(question.context==="partial_empty"){
    snapshot.claims=[];
  }else if(question.context==="closed_contract"){
    // This is a deliberately closed test projection of real parsed route declarations, not an analyzer completeness claim.
    snapshot.coverage={status:"complete",analyzed_roots:["selected-contract"],diagnostic_ids:[]};
  }
  const match=searchOperationCandidates(matcherInput(snapshot),{intentQuery:question.intentQuery,limit:20});
  const intentQuery=question.intentQuery;
  expect(match.status).toBe(question.matcher.status);
  if(question.matcher.status==="candidates"){
    expect(match).toMatchObject({status:"candidates",complete:question.matcher.complete});
    if(match.status==="candidates"){
      expect(match.candidates.map(item=>route(snapshot,item.endpointId))).toEqual(question.matcher.routes);
      if(question.matcher.scores)expect(match.candidates.map(item=>item.score)).toEqual(question.matcher.scores);
    }
  }else expect(match).toMatchObject(question.matcher);
  const provider=vi.fn(async(request:SemanticProviderRequest)=>{
    if("intentQuery" in request)expect(request.intentQuery).toBe(intentQuery);
    if(question.discovery==="no_context")throw new Error("provider must not be called without usable context");
    if(question.discovery==="ambiguous"){
      const candidateEndpointIds=snapshot.endpoints.filter(endpoint=>question.matcher.status==="candidates"
        &&question.matcher.routes.includes(route(snapshot,endpoint.endpoint_id))).map(endpoint=>endpoint.endpoint_id);
      expect(candidateEndpointIds).toHaveLength(2);
      return {status:"ambiguous",candidateEndpointIds,reason:"Multiple selected operations are candidates; clarify the action and entity."};
    }
    if(question.discovery==="no_match")return {status:"no_match",reason:"No selected operation matches this wording."};
    const selectedRoute=question.matcher.status==="candidates"?question.matcher.routes[0]:undefined;
    const endpoint=request.endpoints.find(item=>`${item.method} ${item.applicationPath}`===selectedRoute)!;
    const citation=endpoint.documents.find(document=>document.kind==="operation_summary"
      ||document.kind==="code_route")?.evidenceIds[0];
    expect(citation).toBeTruthy();
    return {status:"suggestions",suggestions:[{endpointId:endpoint.endpointId,intent:"Tentative endpoint name",
      summary:"A possible match from the selected contract.",evidenceIds:[citation]}]};
  });
  if(question.discovery==="no_context"){
    const unknown=searchOperationCandidates(matcherInput(snapshot),{intentQuery:question.intentQuery});
    expect(unknown).toMatchObject({status:"unknown"});
    await expect(runGroundedSemanticDiscovery(discoveryInput(snapshot,question.intentQuery),provider))
      .resolves.toMatchObject({status:"no_context",contextCoverage:{status:"partial"}});
    expect(provider).not.toHaveBeenCalled();
  }else{
    const result=await runGroundedSemanticDiscovery(discoveryInput(snapshot,question.intentQuery),provider);
    expect(result).toMatchObject({status:question.discovery,normative:false,verification:"inferred",review:"unreviewed"});
    if(question.discovery==="suggestions"){
      expect(result.status).toBe("suggestions");
      if(result.status==="suggestions")for(const suggestion of result.suggestions){
        expect(snapshot.endpoints.some(endpoint=>endpoint.endpoint_id===suggestion.endpointId)).toBe(true);
        expect(suggestion.evidenceIds.every(id=>snapshot.evidence.some(evidence=>evidence.evidence_id===id
          &&evidence.scope.endpoint_id===suggestion.endpointId))).toBe(true);
      }
    }
  }
});

test("rejects stale checkpoint pins and credential or URI questions before provider egress",async()=>{
  const snapshot=await makeSnapshot("swagger2");const provider=vi.fn(async()=>({status:"no_match",reason:"No match."}));
  const stale={...discoveryInput(snapshot,"create invoice"),selection:selection(snapshot,"8")};
  await expect(runGroundedSemanticDiscovery(stale,provider)).rejects.toMatchObject({code:"SEMANTIC_INVALID_CONTEXT"});
  const resolved=matcherInput(snapshot);
  expect(searchOperationCandidates(resolved,{intentQuery:"create invoice",limit:20})).toMatchObject({status:"candidates"});
  for(const intentQuery of ["Bearer CANARY_SECRET_123","https://private.example/path"]){
    expect(searchOperationCandidates(resolved,{intentQuery,limit:20})).toMatchObject({status:"unknown",reason:"invalid_input"});
    await expect(runGroundedSemanticDiscovery(discoveryInput(snapshot,intentQuery),provider))
      .rejects.toMatchObject({code:"SEMANTIC_INVALID_CONTEXT"});
  }
  expect(provider).not.toHaveBeenCalled();
});

test("returns keyword no_match only for a deliberately closed selected-contract fixture",async()=>{
  const snapshot=await makeSnapshot("swagger2");
  // This test projection closes the selected contract around the real parsed operations; it is not an analyzer coverage claim.
  snapshot.coverage={status:"complete",analyzed_roots:["selected-contract"],diagnostic_ids:[]};
  const result=searchOperationCandidates(matcherInput(snapshot),{intentQuery:"archive shipment",limit:20});
  expect(result).toMatchObject({status:"no_match",matchMode:"keyword",scope:"selected_contract",truncated:false});
});

test("rejects provider citations outside the selected endpoint's documents",async()=>{
  const snapshot=await makeSnapshot("swagger2");const endpoint=snapshot.endpoints[0]!;
  const other=snapshot.endpoints[1]!;const foreign=other.evidence_ids[0]!;
  const input={...discoveryInput(snapshot,"look up invoice"),endpointIds:[endpoint.endpoint_id]};
  await expect(runGroundedSemanticDiscovery(input,async()=>({status:"suggestions",suggestions:[{
    endpointId:endpoint.endpoint_id,intent:"Invoice lookup",summary:"Possible match",evidenceIds:[foreign]}]})))
    .rejects.toMatchObject({code:"SEMANTIC_OUTPUT_REJECTED"});
});

test("does not send analyzer candidates from another environment to a provider",async()=>{
  const snapshot=await makeSnapshot("swagger2"),matcher=searchOperationCandidates(matcherInput(snapshot),
    {intentQuery:"look up invoice",limit:16});
  expect(matcher.status).toBe("candidates");if(matcher.status!=="candidates")return;
  const candidate={...matcher.candidates[0]!,repositoryId:snapshot.source.repository_id,
    serviceId:snapshot.service.service_id,selector:selection(snapshot,"7"),pin:pin(snapshot,"7")};
  const search=vi.fn(async()=>({status:"candidates" as const,matchMode:"keyword" as const,
    scope:"visible_authorized_services" as const,environment:"uat",candidates:[candidate],complete:false,
    truncated:false,incompleteReason:"incomplete_scan" as const}));
  const discover=vi.fn(async()=>{throw new Error("wrong environment must stop before provider call");});
  const service=createSemanticCorpusService({corpusReader:{searchOperationCandidatesAcrossServices:search,
    readContract:vi.fn(async()=>{throw new Error("wrong environment must stop before contract read");})},
    semanticService:{discover}});
  await expect(service.discoverAcrossServices({tenantId:"tenant-a",principalId:"reader"},
    {environment:"uat",intentQuery:"look up invoice",limit:16}))
    .rejects.toMatchObject({code:"SEMANTIC_CORPUS_UNAVAILABLE"});
  expect(discover).not.toHaveBeenCalled();
});
