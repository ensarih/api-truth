import {readFile} from "node:fs/promises";
import {expect,test} from "vitest";
import type {ContractSnapshot} from "../../packages/ir/src/index.js";
import {runGroundedSemanticAnalysis} from "../../packages/semantics/src/index.js";

const base=JSON.parse(await readFile(new URL("../fixtures/ir/express-snapshot.json",import.meta.url),"utf8")) as ContractSnapshot;
const validInput=()=>{
  const snapshot=structuredClone(base);const endpoint=snapshot.endpoints.find(item=>item.endpoint_id==="ep-get")!;
  snapshot.evidence.push({evidence_id:"ev-safe-summary",source:{kind:"api_document",source_id:snapshot.source.repository_id},
    source_version:snapshot.source.immutable_revision,location:{pointer:"/paths/~1orders/get/summary"},method:"type_declaration",
    scope:{service_id:snapshot.service.service_id,snapshot_id:snapshot.snapshot_id,endpoint_id:endpoint.endpoint_id,
      revision:snapshot.source.immutable_revision},limitations:[],access_label:"orders-read"});
  snapshot.claims.push({claim_id:"claim-safe-summary",subject:{service_id:snapshot.service.service_id,endpoint_id:endpoint.endpoint_id},
    predicate:"operation.summary",value:"Read an order",verification:"declared",evidence_ids:["ev-safe-summary"]});
  return {snapshot,pin:{snapshotId:snapshot.snapshot_id,revision:snapshot.source.immutable_revision,
    configFingerprint:snapshot.config.config_fingerprint,checkpointVersion:"7"},
    selection:{version:"1" as const,tenantId:"tenant-a",repositoryId:snapshot.source.repository_id,
      serviceId:snapshot.service.service_id,selector:{kind:"environment" as const,environment:"prod",
        expectedCheckpointVersion:"7"}},inference:{enabled:true as const,provider:"openai" as const,model:"safe-test"},
    endpointIds:[endpoint.endpoint_id]};
};
const valid={status:"suggestions",suggestions:[{endpointId:"ep-get",intent:"read an order",summary:"Find the order",
  evidenceIds:["ev-safe-summary"]}]};

test.each([
  ["suggestion intent",(secret:string)=>({...valid,suggestions:[{...valid.suggestions[0],intent:secret}]})],
  ["suggestion summary",(secret:string)=>({...valid,suggestions:[{...valid.suggestions[0],summary:secret}]})],
  ["ambiguous reason",(secret:string)=>({status:"ambiguous",candidateEndpointIds:["ep-get","ep-create"],reason:secret})],
  ["no-match reason",(secret:string)=>({status:"no_match",reason:secret})],
] as const)("rejects credential-like provider output in %s with a fixed error",async(_field,createOutput)=>{
  for(const secret of ["Bearer CANARY_SECRET_123","api_key=CANARY_SECRET_123","-----BEGIN PRIVATE KEY-----"]){
    const raw=createOutput(secret);
    let caught:unknown;
    try{await runGroundedSemanticAnalysis(validInput(),async()=>raw);}catch(error){caught=error;}
    expect(caught).toMatchObject({code:"SEMANTIC_OUTPUT_REJECTED",message:"SEMANTIC_OUTPUT_REJECTED"});
    expect(JSON.stringify(caught)).not.toContain(secret);
  }
});

test("preserves ordinary credential-related endpoint language in provider output",async()=>{
  const output={status:"suggestions",suggestions:[{endpointId:"ep-get",intent:"reset password",summary:"Get access token metadata",
    evidenceIds:["ev-safe-summary"]}]};
  await expect(runGroundedSemanticAnalysis(validInput(),async()=>output)).resolves.toMatchObject({status:"suggestions",
    suggestions:[{intent:"reset password",summary:"Get access token metadata"}]});
});
