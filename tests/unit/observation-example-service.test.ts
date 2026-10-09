import {readFile} from "node:fs/promises";
import {expect,test,vi} from "vitest";
import type {ContractSnapshot} from "../../packages/ir/src/index.js";
import type {QueryReader} from "../../packages/query/src/index.js";
import {createSyntheticExampleService} from "../../packages/observations/src/example-service.js";

const snapshot=JSON.parse(await readFile(new URL("../fixtures/ir/express-snapshot.json",import.meta.url),"utf8")) as ContractSnapshot;
const selection={version:"1" as const,tenantId:"tenant-a",repositoryId:"commerce",serviceId:"orders",
  selector:{kind:"environment" as const,environment:"uat",expectedCheckpointVersion:"7"}};
const context={tenantId:"tenant-a",principalId:"reader"};
const view=()=>({status:"resolved" as const,selector:selection,
  pin:{snapshotId:snapshot.snapshot_id,revision:snapshot.source.immutable_revision,
    configFingerprint:snapshot.config.config_fingerprint,checkpointVersion:"7"},
  snapshot:structuredClone(snapshot),publication:{status:"absent" as const}});
const binding=()=>({policyId:"create-order",tenantId:"tenant-a",repositoryId:"commerce",serviceId:"orders",
  environment:"uat",policy:{version:"synthetic-examples-1" as const,endpointId:"ep-create",
    direction:"request" as const,mediaType:"application/json",propertyPaths:["/customer/id","/items/sku"]}});
const reader=(fn:ReturnType<typeof vi.fn>)=>({readContract:fn}) as unknown as Pick<QueryReader,"readContract">;

test("only an authorized, unchanged pin returns a static opted-in placeholder",async()=>{
  const read=vi.fn(async()=>view());
  const configured=binding();
  const service=createSyntheticExampleService({queryReader:reader(read),policies:[configured]});
  configured.policy.propertyPaths.push("/private");
  const result=await service.generate(context,{selection,policyId:"create-order"});
  expect(result).toMatchObject({status:"generated",kind:"synthetic_example",nonNormative:true,
    value:{customer:{id:"string"},items:[{sku:"string"}]},scope:{checkpointVersion:"7",endpointId:"ep-create"}});
  expect(read).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(result)).not.toMatch(/private|CANARY_SECRET/);
});

test("unknown policy withholds only after authorization and does not reveal policy configuration",async()=>{
  const read=vi.fn(async()=>view());
  const service=createSyntheticExampleService({queryReader:reader(read),policies:[]});
  await expect(service.generate(context,{selection,policyId:"unknown"}))
    .resolves.toEqual({status:"withheld",diagnostics:[{ruleId:"policy_not_configured",count:1}]});
  expect(read).toHaveBeenCalledOnce();
  const denied=vi.fn(async()=>({status:"unknown",selector:selection}));
  await expect(createSyntheticExampleService({queryReader:reader(denied),policies:[]})
    .generate(context,{selection,policyId:"unknown"})).rejects.toThrow("EXAMPLE_NOT_FOUND_OR_DENIED");
});

test("serving change and grant revocation during generation discard the candidate",async()=>{
  const stale=vi.fn().mockResolvedValueOnce(view()).mockResolvedValueOnce({...view(),
    pin:{...view().pin,checkpointVersion:"8"}});
  await expect(createSyntheticExampleService({queryReader:reader(stale),policies:[binding()]})
    .generate(context,{selection,policyId:"create-order"})).rejects.toThrow("EXAMPLE_STALE_CONTEXT");
  expect(stale).toHaveBeenCalledTimes(2);
  const revoked=vi.fn().mockResolvedValueOnce(view()).mockResolvedValueOnce({status:"unknown",selector:selection});
  await expect(createSyntheticExampleService({queryReader:reader(revoked),policies:[binding()]})
    .generate(context,{selection,policyId:"create-order"})).rejects.toThrow("EXAMPLE_NOT_FOUND_OR_DENIED");
  expect(revoked).toHaveBeenCalledTimes(2);
  const thrown=vi.fn().mockResolvedValueOnce(view()).mockRejectedValueOnce(
    Object.assign(new Error("PRIVATE_CANARY"),{code:"QUERY_NOT_FOUND_OR_DENIED"}));
  await expect(createSyntheticExampleService({queryReader:reader(thrown),policies:[binding()]})
    .generate(context,{selection,policyId:"create-order"})).rejects.toThrow("EXAMPLE_NOT_FOUND_OR_DENIED");
});

test("hostile request, cross-tenant context, and unpinned selectors reject before authorization read",async()=>{
  const read=vi.fn(async()=>view());
  const service=createSyntheticExampleService({queryReader:reader(read),policies:[binding()]});
  const hostile={selection,get policyId(){throw Error("CANARY_SECRET");}};
  for(const request of [hostile,new Proxy({selection,policyId:"create-order"},{}),
    {selection,policyId:"create-order",propertyPaths:["/private"]},
    {selection:{...selection,selector:{kind:"environment",environment:"uat"}},policyId:"create-order"}])
    await expect(service.generate(context,request as never)).rejects.toThrow("EXAMPLE_INVALID_REQUEST");
  await expect(service.generate({...context,tenantId:"other"},{selection,policyId:"create-order"}))
    .rejects.toThrow("EXAMPLE_INVALID_REQUEST");
  expect(read).not.toHaveBeenCalled();
});

test("policy configuration is copied without invoking accessors",()=>{
  const read=vi.fn(async()=>view());
  const hostile={...binding(),get policy(){throw Error("CANARY_SECRET");}};
  expect(()=>createSyntheticExampleService({queryReader:reader(read),policies:[hostile as never]}))
    .toThrow("EXAMPLE_INVALID_CONFIGURATION");
  expect(read).not.toHaveBeenCalled();
});

test("accepts an ordinary multi-method QueryReader without using unrelated methods",async()=>{
  const read=vi.fn(async()=>view()),unrelated=vi.fn();
  const service=createSyntheticExampleService({queryReader:{readContract:read,readEndpoint:unrelated} as never,
    policies:[binding()]});
  await expect(service.generate(context,{selection,policyId:"create-order"})).resolves.toMatchObject({status:"generated"});
  expect(read).toHaveBeenCalledTimes(2);expect(unrelated).not.toHaveBeenCalled();
});

test("malformed trusted property pointer rejects during configuration",()=>{
  const configured=binding();configured.policy.propertyPaths=["/bad~2pointer"];
  expect(()=>createSyntheticExampleService({queryReader:reader(vi.fn()),policies:[configured]}))
    .toThrow("EXAMPLE_INVALID_CONFIGURATION");
});
