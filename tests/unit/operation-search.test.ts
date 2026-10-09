import {expect,test} from "vitest";
import {searchOperationCandidates,validateOperationSearchOptions} from "../../packages/query/src/operation-search.js";
import {deriveEndpointIdentity,parseContractSnapshot,type ContractSnapshot} from "../../packages/ir/src/index.js";
import type {QueryContractResult} from "../../packages/query/src/reader.js";
import {mkdtemp,mkdir,rm,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname,join} from "node:path";
import {afterEach} from "vitest";
import {ANALYZER as ROUTING_ANALYZER,createAnalyzer as createRoutingAnalyzer} from "../../analyzers/routing-controllers/src/index.js";
import type {AnalyzerRequest} from "../../packages/ir/src/index.js";
import {contractSnapshotFromAnalyzerResult} from "../../packages/catalog/src/index.js";

const temporaryRoots:string[]=[];
afterEach(async()=>Promise.all(temporaryRoots.splice(0).map(root=>rm(root,{recursive:true,force:true}))));

const revision="a".repeat(40);
const base=JSON.parse(await (await import("node:fs/promises")).readFile(
  new URL("../fixtures/ir/express-snapshot.json",import.meta.url),"utf8")) as ContractSnapshot;
type Resolved=Extract<QueryContractResult,{status:"resolved"}>;
const resolved=():Resolved=>{
  const snapshot=structuredClone(base);
  snapshot.coverage={status:"complete",analyzed_roots:["src"],diagnostic_ids:[]};
  const endpoint=snapshot.endpoints[0]!;
  const pointer="/paths/~1orders/get/summary";
  const evidence=(id:string,source:"api_document"|"source_code",method:"type_declaration"|"deterministic_analysis",locationPointer:string)=>({
    evidence_id:id,source:{kind:source,source_id:snapshot.source.repository_id},source_version:snapshot.source.immutable_revision,
    location:{path:"api/openapi.json",pointer:locationPointer},method,scope:{service_id:snapshot.service.service_id,
      snapshot_id:snapshot.snapshot_id,endpoint_id:endpoint.endpoint_id,revision:snapshot.source.immutable_revision},
    limitations:[],access_label:"docs"});
  snapshot.evidence.push(evidence("ev-summary","api_document","type_declaration",pointer),
    evidence("ev-description","api_document","type_declaration","/paths/~1orders/get/description"),
    evidence("ev-route","source_code","deterministic_analysis","span:10:20"),
    evidence("ev-symbol","source_code","deterministic_analysis","span:30:40"));
  const other=snapshot.endpoints[1]!;
  snapshot.evidence.push({...evidence("ev-other-summary","api_document","type_declaration","/paths/~1accounts/post/summary"),
    scope:{service_id:snapshot.service.service_id,snapshot_id:snapshot.snapshot_id,endpoint_id:other.endpoint_id,
      revision:snapshot.source.immutable_revision}},
    {...evidence("ev-other-route","source_code","deterministic_analysis","span:50:60"),
      scope:{service_id:snapshot.service.service_id,snapshot_id:snapshot.snapshot_id,endpoint_id:other.endpoint_id,
        revision:snapshot.source.immutable_revision}});
  other.evidence_ids.push("ev-other-summary","ev-other-route");
  snapshot.claims.push(
    {claim_id:"claim-summary",subject:{service_id:snapshot.service.service_id,endpoint_id:endpoint.endpoint_id},
      predicate:"operation.summary",value:"Find an order by identifier",verification:"declared",evidence_ids:["ev-summary"]},
    {claim_id:"claim-description",subject:{service_id:snapshot.service.service_id,endpoint_id:endpoint.endpoint_id},
      predicate:"operation.description",value:"Returns a stored order",verification:"declared",evidence_ids:["ev-description"]},
    {claim_id:"claim-route",subject:{service_id:snapshot.service.service_id,endpoint_id:endpoint.endpoint_id},
      predicate:"route.registration",value:{method:"GET",path:"/api/orders/:orderId"},verification:"established_by_analysis",evidence_ids:["ev-route"]},
    {claim_id:"claim-symbol",subject:{service_id:snapshot.service.service_id,endpoint_id:endpoint.endpoint_id},
      predicate:"handler.symbol",value:{symbol:"readOrder"},verification:"established_by_analysis",evidence_ids:["ev-symbol"]},
    {claim_id:"claim-other-summary",subject:{service_id:snapshot.service.service_id,endpoint_id:other.endpoint_id},
      predicate:"operation.summary",value:"Register a new customer account",verification:"declared",evidence_ids:["ev-other-summary"]},
    {claim_id:"claim-other-route",subject:{service_id:snapshot.service.service_id,endpoint_id:other.endpoint_id},
      predicate:"route.registration",value:{method:"POST",path:other.application_path},verification:"established_by_analysis",evidence_ids:["ev-other-route"]},
    {claim_id:"claim-security",subject:{service_id:snapshot.service.service_id,endpoint_id:endpoint.endpoint_id},
      predicate:"security.requirement",value:[{apiKey:[]}],verification:"established_by_analysis",evidence_ids:["ev-route"]});
  const parsed=parseContractSnapshot(snapshot);if(!parsed.ok)throw new Error(JSON.stringify(parsed));
  return {status:"resolved",selector:{version:"1",tenantId:"tenant-a",repositoryId:snapshot.source.repository_id,
    serviceId:snapshot.service.service_id,selector:{kind:"environment",environment:"prod",expectedCheckpointVersion:"4"}},
    pin:{snapshotId:snapshot.snapshot_id,revision:snapshot.source.immutable_revision,
      configFingerprint:snapshot.config.config_fingerprint,checkpointVersion:"4"},snapshot,
    publication:{status:"absent"}} as Resolved;
};

test("ranks only source-qualified docs and route identifiers, with stable pins and evidence",()=>{
  const input=resolved();
  const result=searchOperationCandidates(input,{intentQuery:"find order identifier",limit:10});
  expect(result).toMatchObject({status:"candidates",selector:input.selector,pin:input.pin,truncated:false,complete:true,
    candidates:[{endpointId:input.snapshot.endpoints[0]!.endpoint_id,method:"GET",path:"/api/orders/:orderId",
      label:"Find an order by identifier",evidenceIds:["ev-description","ev-route","ev-summary","ev-symbol"]}]});
  expect(JSON.stringify(result)).not.toMatch(/security|apiKey|secret|password/i);
});

test("returns complete no_match only for a complete resolved snapshot",()=>{
  expect(searchOperationCandidates(resolved(),{intentQuery:"delete shipment",limit:10})).toMatchObject({status:"no_match",truncated:false});
  const input=resolved();
  (input as unknown as {snapshot:{coverage:ContractSnapshot["coverage"]}}).snapshot.coverage={status:"incomplete",analyzed_roots:["src"],
    unresolved_roots:["src/legacy"],reason:"partial",diagnostic_ids:["diag-computed-route"]};
  expect(searchOperationCandidates(input,{intentQuery:"delete shipment",limit:10})).toMatchObject({status:"unknown",reason:"incomplete_snapshot"});
});

test("returns unknown for unresolved state and text with no searchable tokens",()=>{
  const unresolved={status:"transitional",selector:{version:"1",tenantId:"tenant-a",repositoryId:"repo",
    serviceId:"orders",selector:{kind:"environment",environment:"prod"}}} as QueryContractResult;
  expect(searchOperationCandidates(unresolved,{intentQuery:"find order",limit:10})).toMatchObject({status:"unknown",reason:"unresolved_selection"});
  expect(searchOperationCandidates(resolved(),{intentQuery:"!!!",limit:10})).toMatchObject({status:"unknown",reason:"no_usable_context"});
});

test("returns known partial candidates with the exact pin instead of claiming a complete search",()=>{
  const input=resolved();
  (input.snapshot as unknown as {coverage:ContractSnapshot["coverage"]}).coverage={status:"incomplete",
    analyzed_roots:["src"],unresolved_roots:["src/legacy"],reason:"partial",diagnostic_ids:["diag-computed-route"]};
  expect(searchOperationCandidates(input,{intentQuery:"find order",limit:20})).toMatchObject({
    status:"candidates",complete:false,selector:input.selector,pin:input.pin});
});

test("uses deterministic tie sorting and a separate candidate truncation flag",()=>{
  const input=resolved();
  const snapshot=input.snapshot;
  const first=snapshot.endpoints[0]!;
  const second={...structuredClone(first),endpoint_id:"ep-aaaa",application_path:"/api/orders/import",
    identity:deriveEndpointIdentity({identity_version:"1.0.0",service_id:snapshot.service.service_id,method:"GET",application_path:"/api/orders/import"}),
    evidence_ids:["ev-summary-2"]};
  snapshot.endpoints.push(second);
  snapshot.evidence.push({evidence_id:"ev-summary-2",source:{kind:"api_document",source_id:snapshot.source.repository_id},
    source_version:snapshot.source.immutable_revision,location:{path:"api/openapi.json",pointer:"/paths/~1api~1orders~1import/get/summary"},
    method:"type_declaration",scope:{service_id:snapshot.service.service_id,snapshot_id:snapshot.snapshot_id,
      endpoint_id:second.endpoint_id,revision:snapshot.source.immutable_revision},limitations:[],access_label:"docs"});
  snapshot.evidence.push({evidence_id:"ev-route-2",source:{kind:"source_code",source_id:snapshot.source.repository_id},
    source_version:snapshot.source.immutable_revision,location:{path:"src/app.ts",pointer:"span:60:70"},method:"deterministic_analysis",
    scope:{service_id:snapshot.service.service_id,snapshot_id:snapshot.snapshot_id,endpoint_id:second.endpoint_id,
      revision:snapshot.source.immutable_revision},limitations:[],access_label:"docs"});
  second.evidence_ids.push("ev-route-2");
  snapshot.claims.push({claim_id:"claim-summary-2",subject:{service_id:snapshot.service.service_id,endpoint_id:second.endpoint_id},
    predicate:"operation.summary",value:"Find an order import",verification:"declared",evidence_ids:["ev-summary-2"]},
    {claim_id:"claim-route-2",subject:{service_id:snapshot.service.service_id,endpoint_id:second.endpoint_id},
      predicate:"route.registration",value:{method:"GET",path:second.application_path},verification:"established_by_analysis",evidence_ids:["ev-route-2"]});
  const result=searchOperationCandidates(input,{intentQuery:"find",limit:1});
  expect(result).toMatchObject({status:"candidates",truncated:true,candidates:[{endpointId:"ep-aaaa"}]});
});

test("uses local handler symbols without summary text, but never treats that as semantic inference",()=>{
  const input=resolved();
  input.snapshot.claims=input.snapshot.claims.filter(claim=>claim.predicate!=="operation.summary"&&claim.predicate!=="operation.description");
  const result=searchOperationCandidates(input,{intentQuery:"read order",limit:20});
  expect(result).toMatchObject({status:"candidates",matchMode:"keyword",complete:true,
    candidates:[{endpointId:"ep-get",evidenceIds:expect.arrayContaining(["ev-route","ev-symbol"])}]});
});

test("withholds path candidates when method or route path claims conflict with endpoint identity",()=>{
  const input=resolved();
  input.snapshot.claims.push({claim_id:"claim-conflicting-route",subject:{service_id:input.snapshot.service.service_id,
    endpoint_id:input.snapshot.endpoints[0]!.endpoint_id},predicate:"route.registration",
    value:{method:"POST",path:input.snapshot.endpoints[0]!.application_path},verification:"established_by_analysis",
    evidence_ids:["ev-route"]});
  expect(searchOperationCandidates(input,{intentQuery:"find order",limit:20})).toMatchObject({status:"unknown",reason:"incomplete_snapshot"});
});

test("rejects unsafe text, hostile accessors, stale evidence, and source revisions",()=>{
  expect(searchOperationCandidates(resolved(),{intentQuery:"Bearer CANARY_SECRET_123",limit:10})).toMatchObject({status:"unknown",reason:"invalid_input"});
  const hostile=Object.defineProperty({},"status",{get(){throw new Error("CANARY_SECRET");}});
  expect(searchOperationCandidates(hostile as QueryContractResult,{intentQuery:"order",limit:10})).toMatchObject({status:"unknown",reason:"invalid_input"});
  const input=resolved();
  for(const item of input.snapshot.evidence)
    if(item.source.kind==="api_document")item.source_version="b".repeat(40);
  expect(searchOperationCandidates(input,{intentQuery:"identifier",limit:10})).toMatchObject({status:"no_match",matchMode:"keyword",scope:"selected_contract"});
});

test("rejects hostile query objects and invalid limit before inspecting contract",()=>{
  const hostile=Object.defineProperty({},"toString",{get(){throw new Error("CANARY");}});
  expect(validateOperationSearchOptions(hostile)).toBeUndefined();
  expect(searchOperationCandidates(resolved(),{intentQuery:"find order",limit:0})).toMatchObject({status:"unknown",reason:"invalid_input"});
  for(const intentQuery of ["ftp://host/path","mailto:private@example.test","find order\nthen archive"])
    expect(validateOperationSearchOptions({intentQuery})).toBeUndefined();
  expect(validateOperationSearchOptions({intentQuery:"order",extra:true})).toBeUndefined();
});

test("does not trust a summary claim whose evidence pointer names another operation field",()=>{
  const input=resolved();
  input.snapshot.evidence.find(item=>item.evidence_id==="ev-summary")!.location.pointer="/paths/~1orders/get/description";
  expect(searchOperationCandidates(input,{intentQuery:"identifier",limit:20})).toMatchObject({status:"no_match",scope:"selected_contract"});
});

test.each([["controller","orders controller"],["action","read order"]])("matches exact declared routing-controller %s identifiers only",(_field,term)=>{
  const input=resolved();const endpoint=input.snapshot.endpoints[0]!;
  const ev="ev-routing-declaration";
  input.snapshot.evidence.push({evidence_id:ev,source:{kind:"source_code",source_id:input.snapshot.source.repository_id},
    source_version:input.snapshot.source.immutable_revision,location:{path:"src/orders.ts",pointer:"span:1:2"},
    method:"type_declaration",scope:{service_id:input.snapshot.service.service_id,snapshot_id:input.snapshot.snapshot_id,
      endpoint_id:endpoint.endpoint_id,revision:input.snapshot.source.immutable_revision},limitations:[],access_label:"docs"});
  const binding="ev-routing-binding";
  input.snapshot.evidence.push({...structuredClone(input.snapshot.evidence.at(-1)!),evidence_id:binding,
    method:"deterministic_analysis",location:{path:"src/app.ts",pointer:"span:3:4"}});
  input.snapshot.claims.push({claim_id:"claim-routing-declaration",subject:{service_id:input.snapshot.service.service_id,
    endpoint_id:endpoint.endpoint_id},predicate:"route.declaration",value:{method:endpoint.identity.method,
      path:endpoint.application_path,controller:"OrdersController",action:"readOrder"},verification:"declared",
    evidence_ids:[ev,binding]});
  const result=searchOperationCandidates(input,{intentQuery:term});
  expect(result.status).toBe("candidates");
  if(result.status==="candidates")expect(result.candidates).toEqual(expect.arrayContaining([
    expect.objectContaining({endpointId:endpoint.endpoint_id,evidenceIds:expect.arrayContaining([ev,binding])})]));
});

test("rejects routing-controller identifiers without exact source declaration and binding proof",()=>{
  for(const mutation of [
    (input:Resolved)=>{input.snapshot.claims.find(claim=>claim.predicate==="route.declaration")!.verification="owner_asserted";},
    (input:Resolved)=>{input.snapshot.claims.find(claim=>claim.predicate==="route.declaration")!.verification="inferred";},
    (input:Resolved)=>{input.snapshot.claims.find(claim=>claim.predicate==="route.declaration")!.evidence_ids=["ev-route"];},
    (input:Resolved)=>{input.snapshot.evidence.find(item=>item.evidence_id==="ev-route")!.method="owner_assertion" as never;},
  ]){
    const input=resolved();const endpoint=input.snapshot.endpoints[0]!;
    input.snapshot.evidence.push({...structuredClone(input.snapshot.evidence.find(item=>item.evidence_id==="ev-route")!),
      evidence_id:"ev-controller",method:"type_declaration",location:{path:"src/orders.ts",pointer:"span:1:2"}});
    input.snapshot.claims.push({claim_id:"claim-controller",subject:{service_id:input.snapshot.service.service_id,
      endpoint_id:endpoint.endpoint_id},predicate:"route.declaration",value:{method:endpoint.identity.method,
        path:endpoint.application_path,controller:"OrdersController",action:"readOrder"},verification:"declared",
      evidence_ids:["ev-controller","ev-route"]});
    mutation(input);
    const output=searchOperationCandidates(input,{intentQuery:"orders controller"});
    expect(output.status==="candidates"&&output.candidates.some(candidate=>candidate.evidenceIds.includes("ev-controller"))).toBe(false);
  }
});

test("matches real routing-controller analyzer declarations with scoped declaration and binding evidence",async()=>{
  const root=await mkdtemp(join(tmpdir(),"operation-search-routing-"));temporaryRoots.push(root);
  for(const [path,text] of Object.entries({
    "app.ts":`import { createExpressServer } from "routing-controllers"; import { OrdersController } from "./orders";
      createExpressServer({ controllers: [OrdersController] });`,
    "orders.ts":`import { JsonController, Get } from "routing-controllers";
      @JsonController("/orders") export class OrdersController { @Get("/:id") readOrder(): string { return "ok"; } }`,
  })) {const absolute=join(root,"service",path);await mkdir(dirname(absolute),{recursive:true});await writeFile(absolute,text);}
  const request:AnalyzerRequest={exchange_version:"1.0.0",ir_version:"1.0.0",request_id:"operation-search-routing",
    analyzer:ROUTING_ANALYZER,source:{repository_id:"repo-a",service_id:"orders",service_root:"service",
      immutable_revision:revision,source_digest:"pending",access_label:"orders-read"},
    resolution_inputs:[{kind:"source_tree",path:"service",digest:"pending"}],prior_dependencies:[],changed_paths:[],
    extraction_mode:"baseline",limits:{timeout_ms:30_000,max_files:20,max_output_bytes:1_000_000},
    execution_policy:{network_access:false,side_effects:"none"}};
  const raw=await createRoutingAnalyzer({projectRoot:root}).analyze(request);
  const snapshot=contractSnapshotFromAnalyzerResult(raw,"sha256:config-a").snapshot;
  const endpoint=snapshot.endpoints.find(item=>item.application_path==="/orders/:id")!;
  const route=snapshot.claims.find(claim=>claim.subject.endpoint_id===endpoint.endpoint_id&&claim.predicate==="route.declaration")!;
  expect(route).toMatchObject({verification:"declared",value:{method:"GET",path:"/orders/:id",controller:"OrdersController",action:"readOrder"}});
  const evidence=new Map(snapshot.evidence.map(item=>[item.evidence_id,item]));
  expect(route.evidence_ids.map(id=>evidence.get(id)?.method)).toEqual(expect.arrayContaining(["type_declaration","deterministic_analysis"]));
  const query=resolved();
  // Replace the fixture contract with the actual pinned analyzer snapshot.
  const actual={...query,snapshot,selector:{...query.selector,repositoryId:snapshot.source.repository_id,serviceId:snapshot.service.service_id},
    pin:{...query.pin,snapshotId:snapshot.snapshot_id,revision:snapshot.source.immutable_revision,
      configFingerprint:snapshot.config.config_fingerprint}} as Resolved;
  expect(searchOperationCandidates(actual,{intentQuery:"orders controller read order"})).toMatchObject({status:"candidates",
    candidates:[{endpointId:endpoint.endpoint_id,method:"GET",path:"/orders/:id",evidenceIds:route.evidence_ids}]});
});


test("rejects explicit null or undefined limit rather than treating it as omitted", () => {
  expect(validateOperationSearchOptions({intentQuery: "Find an order", limit: null})).toBeUndefined();
  expect(validateOperationSearchOptions({intentQuery: "Find an order", limit: undefined})).toBeUndefined();
  expect(validateOperationSearchOptions({intentQuery: "Find an order"})).toEqual({intentQuery: "Find an order", limit: 20});
});

test("qualified source reuse keeps selected and evidence revisions in keyword results",()=>{
  const input=resolved();
  const selectedRevision="b".repeat(40);
  const qualified={...input,pin:{...input.pin,selectedRevision}};
  const result=searchOperationCandidates(qualified,{intentQuery:"find order identifier",limit:10});
  expect(result).toMatchObject({status:"candidates",pin:{...input.pin,selectedRevision},complete:true,
    candidates:[{evidenceIds:["ev-description","ev-route","ev-summary","ev-symbol"]}]});
  expect(qualified.snapshot).toEqual(input.snapshot);
  if(result.status!=="candidates")throw new Error("Expected qualified keyword candidates");
  const cited=new Set(result.candidates.flatMap(item=>item.evidenceIds));
  expect(qualified.snapshot.evidence.filter(item=>cited.has(item.evidence_id))
    .every(item=>item.source_version===input.pin.revision&&item.scope.revision===input.pin.revision)).toBe(true);
  const relabeled=structuredClone(qualified);
  relabeled.pin.revision=selectedRevision;
  expect(searchOperationCandidates(relabeled,{intentQuery:"find order identifier"})).toMatchObject({status:"unknown"});
});

test.each([undefined,"", "a\u0000b", "Bearer secret", "nonhex-revision", "a".repeat(11), "a".repeat(129), "x".repeat(2049)])("rejects malformed optional selected revision %s",selectedRevision=>{
  const input=resolved();
  expect(searchOperationCandidates({...input,pin:{...input.pin,selectedRevision}},
    {intentQuery:"find order identifier"})).toMatchObject({status:"unknown"});
});


test("a redundant selected revision cannot masquerade as qualified reuse",()=>{
  const input=resolved();
  expect(searchOperationCandidates({...input,pin:{...input.pin,selectedRevision:input.pin.revision}},
    {intentQuery:"find order identifier"})).toMatchObject({status:"unknown"});
});
