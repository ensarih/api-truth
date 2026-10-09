import {readFile} from "node:fs/promises";
import {expect,test} from "vitest";
import type {ContractSnapshot} from "../../packages/ir/src/index.js";
import {compileFieldPresenceStoragePolicy,buildFieldPresenceStorageProposal,FieldPresenceStoragePolicyError}
  from "../../packages/observations/src/field-presence-storage-policy.js";
import type {FieldPresenceResult} from "../../packages/observations/src/field-presence.js";
import type {QueryObservationResult} from "../../packages/query/src/index.js";

const snapshot=JSON.parse(await readFile(new URL("../fixtures/ir/express-snapshot.json",import.meta.url),"utf8")) as ContractSnapshot;
const scope={tenantId:"tenant-a",repositoryId:"commerce",serviceId:"orders",environment:"uat",
  snapshotId:snapshot.snapshot_id,revision:snapshot.source.immutable_revision,sourceDigest:"sha256:"+"d".repeat(64),
  configFingerprint:"sha256:"+"c".repeat(64),checkpointVersion:"7",endpointId:"ep-create",
  direction:"request" as const,mediaType:"application/json"};
const policyInput=()=>({version:"field-presence-storage-1",policyId:"owner-fields",ownerPolicyRevision:"1",optIn:true,
  tenantId:scope.tenantId,repositoryId:scope.repositoryId,serviceId:scope.serviceId,environment:scope.environment,
  configFingerprint:scope.configFingerprint,configActivationCheckpoint:"3",endpointId:scope.endpointId,
  direction:"request",mediaType:"application/json",propertyPaths:["/customer/id","/count"],
  ttlSeconds:86400,maxLiveRecords:200});
const parent={importId:"d9428888-122b-4b1c-8f1c-8075d0a71c34",recordId:"51a61b2a-8f9a-4a89-b3e4-7f0fca9b70ca"};
const query=():QueryObservationResult=>({status:"resolved",selector:{version:"1",tenantId:scope.tenantId,
  repositoryId:scope.repositoryId,serviceId:scope.serviceId,selector:{kind:"environment",environment:scope.environment,
    expectedCheckpointVersion:scope.checkpointVersion}},pin:{snapshotId:scope.snapshotId,revision:scope.revision,
    configFingerprint:scope.configFingerprint,checkpointVersion:scope.checkpointVersion},truncated:false,records:[{
    importId:parent.importId,recordId:parent.recordId,sourceId:"fixture-source",sourceVersion:"3",windowStart:"2026-10-01T00:00:00.000Z",
    windowEnd:"2026-10-01T01:00:00.000Z",importedAt:"2026-10-01T01:05:00.000Z",status:"confirmed",
    endpointId:scope.endpointId,mappingId:"mapping-1",method:"POST",statusCode:201,completeness:"metadata_only",policyVersion:"metadata-only-1"}]});
const resolved=(value:QueryObservationResult)=>value as Extract<QueryObservationResult,{status:"resolved"}>;
const projected=():FieldPresenceResult=>({status:"projected",kind:"observed_field_presence",nonNormative:true,
  policyVersion:"observed-field-presence-1",scope,fields:[{path:"/customer/id",state:"present"},{path:"/count",state:"absent"}],
  diagnostics:[{ruleId:"selected_paths",count:2}]});
const context=()=>({activeConfigFingerprint:scope.configFingerprint,configActivationCheckpoint:"3",
  expectedPolicyFingerprint:compileFieldPresenceStoragePolicy(policyInput()).fingerprint,expectedSourceDigest:scope.sourceDigest});
const proposal=()=>buildFieldPresenceStorageProposal({queryResult:query(),projected:projected(),policy:compileFieldPresenceStoragePolicy(policyInput()),
  parent,host:context()});

test("builds only an explicitly opted-in value-free proposal linked to the exact metadata parent",()=>{
  const result=proposal();
  expect(result).toMatchObject({status:"eligible",policyVersion:"field-presence-storage-1",parent,scope:{...scope},
    ownerPolicyRevision:"1",fields:[{path:"/count",state:"absent"},{path:"/customer/id",state:"present"}],ttlSeconds:86400,maxLiveRecords:200,
    source:{sourceId:"fixture-source",sourceVersion:"3",windowStart:"2026-10-01T00:00:00.000Z",
      windowEnd:"2026-10-01T01:00:00.000Z",importedAt:"2026-10-01T01:05:00.000Z"}});
  expect(JSON.stringify(result)).not.toMatch(/payload|valueHash|PRIVATE_CANARY|SECRET_CANARY|expiresAt|liveBudget/);
});

test("rejects absent opt-in and out-of-range retention or budgets",()=>{
  for(const change of [
    (value:Record<string,unknown>)=>{value.optIn=false;},
    (value:Record<string,unknown>)=>{value.ttlSeconds=59;},
    (value:Record<string,unknown>)=>{value.ttlSeconds=2_592_001;},
    (value:Record<string,unknown>)=>{value.maxLiveRecords=0;},
    (value:Record<string,unknown>)=>{value.maxLiveRecords=10_001;},
    (value:Record<string,unknown>)=>{value.ownerPolicyRevision="0";},
  ]){
    const value=policyInput();change(value);
    expect(()=>compileFieldPresenceStoragePolicy(value)).toThrow(FieldPresenceStoragePolicyError);
  }
});

test("fingerprint changes with scope, config epoch, selector, or field paths",()=>{
  const base=compileFieldPresenceStoragePolicy(policyInput()).fingerprint;
  for(const change of [
    (value:Record<string,unknown>)=>{value.configFingerprint="sha256:"+"a".repeat(64);},
    (value:Record<string,unknown>)=>{value.configActivationCheckpoint="4";},
    (value:Record<string,unknown>)=>{value.ownerPolicyRevision="2";},
    (value:Record<string,unknown>)=>{value.endpointId="ep-other";},
    (value:Record<string,unknown>)=>{value.propertyPaths=["/customer/name"];},
  ]){const value=policyInput();change(value);expect(compileFieldPresenceStoragePolicy(value).fingerprint).not.toBe(base);}
  const reordered=policyInput();reordered.propertyPaths=["/count","/customer/id"];
  expect(compileFieldPresenceStoragePolicy(reordered).fingerprint).toBe(base);
});

test("policy paths reject decoded private/prototype/wildcard/control and malformed UTF-16 labels",()=>{
  for(const path of ["/customer/emailAddress","/customer/e~1mailAddress","/__proto__","/*","/bad\u0001","/bad\ud800"]){
    const value={...policyInput(),propertyPaths:[path]};
    expect(()=>compileFieldPresenceStoragePolicy(value)).toThrow(FieldPresenceStoragePolicyError);
  }
});

test("response status must match the confirmed metadata record and projection",()=>{
  const input={...policyInput(),direction:"response",statusCode:200};
  const policy=compileFieldPresenceStoragePolicy(input),queryResult=query();
  const projectedResult=projected() as unknown as Record<string,unknown>;
  projectedResult.scope={...scope,direction:"response",statusCode:200};
  projectedResult.fields=[{path:"/customer/id",state:"present"},{path:"/count",state:"absent"}];
  expect(buildFieldPresenceStorageProposal({queryResult,projected:projectedResult as unknown as FieldPresenceResult,
    policy,parent,host:context()})).toMatchObject({status:"withheld"});
  (resolved(queryResult).records[0] as unknown as Record<string,unknown>).statusCode=200;
  const goodScope={...scope,direction:"response" as const,statusCode:200};
  const goodProjection={...projected(),scope:goodScope};
  expect(buildFieldPresenceStorageProposal({queryResult,projected:goodProjection,policy,parent,
    host:{...context(),expectedPolicyFingerprint:policy.fingerprint}}))
    .toMatchObject({status:"eligible",scope:{direction:"response",statusCode:200}});
});

test("requires trusted active config epoch, source digest and policy fingerprint",()=>{
  for(const change of [
    (value:ReturnType<typeof context>)=>{value.activeConfigFingerprint="sha256:"+"a".repeat(64);},
    (value:ReturnType<typeof context>)=>{value.configActivationCheckpoint="4";},
    (value:ReturnType<typeof context>)=>{value.expectedPolicyFingerprint="sha256:"+"a".repeat(64);},
    (value:ReturnType<typeof context>)=>{value.expectedSourceDigest="sha256:"+"a".repeat(64);},
  ]){const host=context();change(host);expect(buildFieldPresenceStorageProposal({queryResult:query(),projected:projected(),
    policy:compileFieldPresenceStoragePolicy(policyInput()),parent,host})).toMatchObject({status:"withheld"});}
});

test("requires one exact confirmed metadata parent and refuses duplicate record UUIDs",()=>{
  const records=(value:QueryObservationResult)=>resolved(value).records as unknown as Array<Record<string,unknown>>;
  for(const change of [
    (value:QueryObservationResult)=>{records(value)[0]!.status="unresolved";},
    (value:QueryObservationResult)=>{records(value)[0]!.endpointId="ep-other";},
    (value:QueryObservationResult)=>{records(value).push({...records(value)[0]!,importId:"00000000-0000-4000-8000-000000000000"});},
    (value:QueryObservationResult)=>{records(value)[0]!.completeness="raw";},
    (value:QueryObservationResult)=>{records(value)[0]!.policyVersion="other";},
  ]){const result=query();change(result);expect(buildFieldPresenceStorageProposal({queryResult:result,projected:projected(),
    policy:compileFieldPresenceStoragePolicy(policyInput()),parent,host:context()})).toMatchObject({status:"withheld"});}
  const wrongParent=buildFieldPresenceStorageProposal({queryResult:query(),projected:projected(),
    policy:compileFieldPresenceStoragePolicy(policyInput()),parent:{...parent,recordId:"00000000-0000-4000-8000-000000000000"},host:context()});
  expect(wrongParent).toMatchObject({status:"withheld"});
});

test("permits well-formed unrelated unresolved metadata without treating it as the selected parent",()=>{
  const value=resolved(query());
  const records=value.records as unknown as Array<Record<string,unknown>>;
  records.push({importId:"00000000-0000-4000-8000-000000000001",recordId:"00000000-0000-4000-8000-000000000002",
    sourceId:"fixture-source",sourceVersion:"3",windowStart:"2026-10-01T00:00:00.000Z",windowEnd:"2026-10-01T01:00:00.000Z",
    importedAt:"2026-10-01T01:05:00.000Z",status:"unresolved",reason:"no_mapping",method:"POST",statusCode:201,
    completeness:"metadata_only",policyVersion:"metadata-only-1"});
  expect(buildFieldPresenceStorageProposal({queryResult:value,projected:projected(),
    policy:compileFieldPresenceStoragePolicy(policyInput()),parent,host:context()})).toMatchObject({status:"eligible"});
  records[1]!.endpointId="ep-create";
  expect(buildFieldPresenceStorageProposal({queryResult:value,projected:projected(),
    policy:compileFieldPresenceStoragePolicy(policyInput()),parent,host:context()})).toMatchObject({status:"withheld"});
});

test("withholds unknown, truncated, qualified and pin-mismatched query envelopes",()=>{
  const compiled=compileFieldPresenceStoragePolicy(policyInput());
  const base=resolved(query());
  const altered=[
    {status:"unknown",selector:base.selector} as QueryObservationResult,
    {...base,truncated:true} as QueryObservationResult,
    {...base,pin:{...base.pin,selectedRevision:"b".repeat(40)}} as QueryObservationResult,
    {...base,pin:{...base.pin,pointerVersion:"8"}} as QueryObservationResult,
    {...base,pin:{...base.pin,revision:"f".repeat(40)}} as QueryObservationResult,
    {...base,selector:{...base.selector,selector:{kind:"environment" as const,environment:"prod",expectedCheckpointVersion:"7"}}},
  ];
  for(const queryResult of altered)expect(buildFieldPresenceStorageProposal({queryResult,projected:projected(),
    policy:compiled,parent,host:context()})).toMatchObject({status:"withheld"});
});

test("projection must have the exact selected paths, matching scope and only presence states",()=>{
  const compiled=compileFieldPresenceStoragePolicy(policyInput());
  for(const change of [
    (value:Record<string,unknown>)=>{value.fields=[{path:"/other",state:"present"}];},
    (value:Record<string,unknown>)=>{value.fields=[{path:"/count",state:"present",value:"SECRET"},{path:"/customer/id",state:"present"}];},
    (value:Record<string,unknown>)=>{value.scope={...scope,sourceDigest:"sha256:"+"a".repeat(64)};},
    (value:Record<string,unknown>)=>{value.status="withheld";},
  ]){const value=projected() as unknown as Record<string,unknown>;change(value);
    expect(buildFieldPresenceStorageProposal({queryResult:query(),projected:value as unknown as FieldPresenceResult,
      policy:compiled,parent,host:context()})).toMatchObject({status:"withheld"});}
});

test("requires source window ordering and refuses client-supplied authority or values",()=>{
  const badWindow=resolved(query());(badWindow.records[0] as unknown as Record<string,unknown>).windowStart="2026-10-02T00:00:00.000Z";
  expect(buildFieldPresenceStorageProposal({queryResult:badWindow,projected:projected(),
    policy:compileFieldPresenceStoragePolicy(policyInput()),parent,host:context()})).toMatchObject({status:"withheld"});
  const invalidTime=resolved(query());
  (invalidTime.records[0] as unknown as Record<string,unknown>).windowStart="2026-02-30T00:00:00.000Z";
  expect(buildFieldPresenceStorageProposal({queryResult:invalidTime,projected:projected(),
    policy:compileFieldPresenceStoragePolicy(policyInput()),parent,host:context()})).toMatchObject({status:"withheld"});
  const futureWindow=resolved(query());
  (futureWindow.records[0] as unknown as Record<string,unknown>).windowEnd="2026-10-01T02:00:00.000Z";
  expect(buildFieldPresenceStorageProposal({queryResult:futureWindow,projected:projected(),
    policy:compileFieldPresenceStoragePolicy(policyInput()),parent,host:context()})).toMatchObject({status:"withheld"});
  const extra={...policyInput(),valueHash:"sha256:"+"f".repeat(64)};
  expect(()=>compileFieldPresenceStoragePolicy(extra)).toThrow(FieldPresenceStoragePolicyError);
  const proxy=new Proxy(policyInput(),{ownKeys(){throw Error("do not invoke");}});
  expect(()=>compileFieldPresenceStoragePolicy(proxy)).toThrow(FieldPresenceStoragePolicyError);
  const revocable=Proxy.revocable(policyInput(),{});revocable.revoke();
  expect(()=>compileFieldPresenceStoragePolicy(revocable.proxy)).toThrow(FieldPresenceStoragePolicyError);
});
