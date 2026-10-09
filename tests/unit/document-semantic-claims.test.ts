import {expect,test} from "vitest";
import {ANALYZER as SWAGGER_ANALYZER,extractSwagger2Document} from "../../analyzers/nodejs/src/index.js";
import {ANALYZER as OPENAPI_ANALYZER,extractOpenApi3Document} from "../../analyzers/openapi3/src/index.js";
import {parseAnalyzerResult,type AnalyzerRequest,type AnalyzerResult} from "../../packages/ir/src/index.js";

const revision="a".repeat(40);
const request=(analyzer:AnalyzerRequest["analyzer"]):AnalyzerRequest=>({exchange_version:"1.0.0",ir_version:"1.1.0",
  request_id:"doc-semantic-claims",analyzer,source:{repository_id:"repo",service_id:"orders",service_root:"api",
    immutable_revision:revision,source_digest:`sha256:${"b".repeat(64)}`,access_label:"docs"},
  resolution_inputs:[{kind:"type_manifest",path:"api/openapi.json",digest:`sha256:${"b".repeat(64)}`}],
  prior_dependencies:[],changed_paths:[],extraction_mode:"baseline",
  limits:{timeout_ms:30_000,max_files:10,max_output_bytes:1_000_000},
  execution_policy:{network_access:false,side_effects:"none"}});

const claims=(result:AnalyzerResult)=>result.claims.filter(item=>
  item.predicate==="operation.summary"||item.predicate==="operation.description");
const expectDeclaredDocumentClaim=(result:AnalyzerResult,predicate:string,value:string,pointer:string)=>{
  const claim=claims(result).find(item=>item.predicate===predicate);
  expect(claim).toMatchObject({subject:{service_id:"orders",endpoint_id:result.endpoints[0]!.endpoint_id},
    predicate,value,verification:"declared",evidence_ids:[expect.any(String)]});
  const evidence=result.evidence.find(item=>item.evidence_id===claim!.evidence_ids[0]);
  expect(evidence).toMatchObject({source:{kind:"api_document",source_id:"repo"},source_version:revision,
    location:{path:"api/openapi.json",pointer},method:"type_declaration",
    scope:{service_id:"orders",snapshot_id:result.snapshot_id,endpoint_id:result.endpoints[0]!.endpoint_id,
      revision},access_label:"docs"});
};

const swaggerDoc=(operation:Record<string,unknown>)=>({swagger:"2.0",info:{title:"Orders",version:"1"},paths:{"/orders":{
  get:{...operation,responses:{"200":{description:"ok"}}}}}});
const openapiDoc=(operation:Record<string,unknown>)=>({openapi:"3.0.3",info:{title:"Orders",version:"1"},paths:{"/orders":{
  get:{...operation,responses:{"200":{description:"ok"}}}}}});

test.each([
  ["Swagger 2",SWAGGER_ANALYZER,swaggerDoc({summary:"List orders",description:"Returns orders visible to the caller."}),
    extractSwagger2Document,"/paths/~1orders/get/summary","/paths/~1orders/get/description"],
  ["OpenAPI 3",OPENAPI_ANALYZER,openapiDoc({summary:"List orders",description:"Returns orders visible to the caller."}),
    extractOpenApi3Document,"/paths/~1orders/get/summary","/paths/~1orders/get/description"],
] as const)("emits exact declared summary and description claims for standalone %s documents",(_label,analyzer,document,extract,summaryPointer,descriptionPointer)=>{
  const result=extract(request(analyzer),"api/openapi.json",JSON.stringify(document));
  expect(parseAnalyzerResult(result).ok).toBe(true);
  expectDeclaredDocumentClaim(result,"operation.summary","List orders",summaryPointer);
  expectDeclaredDocumentClaim(result,"operation.description","Returns orders visible to the caller.",descriptionPointer);
});

test("does not change middleware-profile handling of operation summary or description text",()=>{
  const document=swaggerDoc({summary:"s".repeat(2_049),description:12});
  const result=extractSwagger2Document(request(SWAGGER_ANALYZER),"api/openapi.json",JSON.stringify(document),
    {kind:"verified",binding:{path:"api/index.js",line:1,span:"span:1-10"}});
  expect(claims(result)).toEqual([]);
  expect(result.diagnostics.flatMap(item=>item.evidence_ids).map(id=>result.evidence.find(e=>e.evidence_id===id)?.location.pointer))
    .not.toEqual(expect.arrayContaining(["/paths/~1orders/get/summary","/paths/~1orders/get/description"]));
});

test.each([
  ["Swagger 2",SWAGGER_ANALYZER,swaggerDoc({summary:"s".repeat(2_049),description:12}),extractSwagger2Document],
  ["OpenAPI 3",OPENAPI_ANALYZER,openapiDoc({summary:"s".repeat(2_049),description:12}),extractOpenApi3Document],
] as const)("omits malformed or oversized operation text for %s and reports exact source pointers",(_label,analyzer,document,extract)=>{
  const result=extract(request(analyzer),"api/openapi.json",JSON.stringify(document));
  expect(claims(result)).toEqual([]);
  expect(result.diagnostics.map(item=>item.evidence_ids.flatMap(id=>result.evidence
    .filter(evidence=>evidence.evidence_id===id).map(evidence=>evidence.location.pointer)))).toEqual(
      expect.arrayContaining([expect.arrayContaining(["/paths/~1orders/get/summary"]),
        expect.arrayContaining(["/paths/~1orders/get/description"])]));
});
