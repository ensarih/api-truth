import {readFile} from "node:fs/promises";
import {expect,test,vi} from "vitest";
import type {ContractSnapshot} from "../../packages/ir/src/index.js";
import type {QueryReader} from "../../packages/query/src/index.js";
import {createFieldPresenceService,type FieldPresencePolicyBinding,type FieldPresenceSourcePin,
  type FieldPresenceAuthorization,type FieldPresenceReadPort} from "../../packages/observations/src/index.js";

const template=JSON.parse(await readFile(new URL("../fixtures/ir/express-snapshot.json",import.meta.url),"utf8")) as ContractSnapshot;
const selection={version:"1" as const,tenantId:"tenant-a",repositoryId:"commerce",serviceId:"orders",
  selector:{kind:"environment" as const,environment:"uat",expectedCheckpointVersion:"7"}};
const context={tenantId:"tenant-a",principalId:"reader"};
const snapshot=()=>{
  const value=structuredClone(template);
  value.endpoints.find(endpoint=>endpoint.endpoint_id==="ep-create")!.request_bodies[0]!.schema={
    type:"object",properties:{customer:{type:"object",properties:{id:{type:"string"}}},count:{type:"integer"}}};
  return value;
};
const view=(doc=snapshot())=>({status:"resolved" as const,selector:selection,
  pin:{snapshotId:doc.snapshot_id,revision:doc.source.immutable_revision,configFingerprint:doc.config.config_fingerprint,
    checkpointVersion:"7"},snapshot:doc,publication:{status:"absent" as const}});
const binding=():FieldPresencePolicyBinding=>({policyId:"owner-policy",tenantId:"tenant-a",repositoryId:"commerce",
  serviceId:"orders",environment:"uat",policy:{version:"observed-field-presence-1",endpointId:"ep-create",
    direction:"request",mediaType:"application/json",propertyPaths:["/customer/id","/count"]}});
const reader=(fn:ReturnType<typeof vi.fn>)=>({readContract:fn}) as unknown as Pick<QueryReader,"readContract">;
const id="d9428888-122b-4b1c-8f1c-8075d0a71c34";
const make=(overrides:Partial<{read:ReturnType<typeof vi.fn>;authorize:ReturnType<typeof vi.fn>;
  body:ReturnType<typeof vi.fn>;policy:FieldPresencePolicyBinding}>={})=>{
  const read=overrides.read??vi.fn(async()=>view());
  const authorize=overrides.authorize??vi.fn(async()=>true);
  const body=overrides.body??vi.fn(async(_context:unknown,pin:FieldPresenceSourcePin,observationId:string,b:FieldPresencePolicyBinding)=>({
    attestation:{...pin,observationId,endpointId:b.policy.endpointId,direction:b.policy.direction,mediaType:b.policy.mediaType},
    payloadText:'{"customer":{"id":"PRIVATE_CANARY"}}',payloadCompleteness:"complete_unredacted" as const}));
  return {read,authorize,body,service:createFieldPresenceService({queryReader:reader(read),policies:[overrides.policy??binding()],
    authorize:authorize as unknown as FieldPresenceAuthorization,readObservation:body as unknown as FieldPresenceReadPort})};
};

test("reads only an authorized observation and returns value-free presence after full pin recheck",async()=>{
  const {read,authorize,body,service}=make();
  const result=await service.read(context,{selection,policyId:"owner-policy",observationId:id});
  expect(result).toMatchObject({status:"projected",nonNormative:true,fields:[
    {path:"/customer/id",state:"present"},{path:"/count",state:"absent"}]});
  expect(JSON.stringify(result)).not.toContain("PRIVATE_CANARY");
  expect(read).toHaveBeenCalledTimes(2);expect(authorize).toHaveBeenCalledTimes(2);expect(body).toHaveBeenCalledOnce();
  expect(body.mock.calls[0]![2]).toBe(id);
});

test("authorization denial prevents the body read",async()=>{
  const {body,service}=make({authorize:vi.fn(async()=>false)});
  await expect(service.read(context,{selection,policyId:"owner-policy",observationId:id}))
    .rejects.toMatchObject({code:"FIELD_PRESENCE_NOT_FOUND_OR_DENIED"});
  expect(body).not.toHaveBeenCalled();
});

test("preflight withholds unsupported schema paths before authorization or body access",async()=>{
  const invalid={...binding(),policy:{...binding().policy,propertyPaths:["/missing"]}};
  const {authorize,body,service}=make({policy:invalid});
  await expect(service.read(context,{selection,policyId:"owner-policy",observationId:id}))
    .resolves.toMatchObject({status:"withheld"});
  expect(authorize).toHaveBeenCalledOnce();expect(body).not.toHaveBeenCalled();
  const denied=make({policy:invalid,authorize:vi.fn(async()=>false)});
  await expect(denied.service.read(context,{selection,policyId:"owner-policy",observationId:id}))
    .rejects.toMatchObject({code:"FIELD_PRESENCE_NOT_FOUND_OR_DENIED"});
  expect(denied.body).not.toHaveBeenCalled();
});

test("attestation binds endpoint, direction, media, pin and caller-selected observation ID",async()=>{
  const changes=[
    (value:Record<string,unknown>)=>{value.endpointId="ep-other";},
    (value:Record<string,unknown>)=>{value.direction="response";},
    (value:Record<string,unknown>)=>{value.mediaType="text/plain";},
    (value:Record<string,unknown>)=>{value.revision="f".repeat(40);},
    (value:Record<string,unknown>)=>{value.observationId="00000000-0000-4000-8000-000000000000";},
    (value:Record<string,unknown>)=>{value.statusCode=200;},
  ];
  for(const change of changes){
    const wrong=vi.fn(async(_context:unknown,pin:FieldPresenceSourcePin,observationId:string,b:FieldPresencePolicyBinding)=>{
      const attestation:Record<string,unknown>={...pin,observationId,endpointId:b.policy.endpointId,
        direction:b.policy.direction,mediaType:b.policy.mediaType};change(attestation);
      return {attestation,payloadText:"{\"customer\":{\"id\":\"SECRET_CANARY\"}}",payloadCompleteness:"complete_unredacted"};
    });
    const {service}=make({body:wrong});
    await expect(service.read(context,{selection,policyId:"owner-policy",observationId:id}))
      .rejects.toMatchObject({code:"FIELD_PRESENCE_STORAGE_ERROR"});
  }
});

test("response attestation must match selected exact status",async()=>{
  const responsePolicy:FieldPresencePolicyBinding={...binding(),policy:{version:"observed-field-presence-1",
    endpointId:"ep-create",direction:"response",mediaType:"application/json",statusCode:200,propertyPaths:["/id"]}};
  const doc=snapshot(),endpoint=doc.endpoints.find(item=>item.endpoint_id==="ep-create")!;
  endpoint.responses=[{status:{kind:"exact",code:200},content:[{media_type:"application/json",
    schema:{type:"object",properties:{id:{type:"string"}}},serialization:{format:"json"}}]}];
  const read=vi.fn(async()=>view(doc));
  const body=vi.fn(async(_context:unknown,pin:FieldPresenceSourcePin,observationId:string,b:FieldPresencePolicyBinding)=>({
    attestation:{...pin,observationId,endpointId:b.policy.endpointId,direction:b.policy.direction,
      mediaType:b.policy.mediaType,statusCode:201},payloadText:"{\"id\":\"value\"}",
    payloadCompleteness:"complete_unredacted" as const}));
  const service=createFieldPresenceService({queryReader:reader(read),policies:[responsePolicy],
    authorize:vi.fn(async()=>true) as unknown as FieldPresenceAuthorization,readObservation:body as unknown as FieldPresenceReadPort});
  await expect(service.read(context,{selection,policyId:"owner-policy",observationId:id}))
    .rejects.toMatchObject({code:"FIELD_PRESENCE_STORAGE_ERROR"});
  const correct=vi.fn(async(_context:unknown,pin:FieldPresenceSourcePin,observationId:string,b:FieldPresencePolicyBinding)=>({
    attestation:{...pin,observationId,endpointId:b.policy.endpointId,direction:b.policy.direction,
      mediaType:b.policy.mediaType,statusCode:200},payloadText:"{\"id\":\"value\"}",
    payloadCompleteness:"complete_unredacted" as const}));
  const valid=createFieldPresenceService({queryReader:reader(read),policies:[responsePolicy],
    authorize:vi.fn(async()=>true) as unknown as FieldPresenceAuthorization,readObservation:correct as unknown as FieldPresenceReadPort});
  await expect(valid.read(context,{selection,policyId:"owner-policy",observationId:id}))
    .resolves.toMatchObject({status:"projected",fields:[{path:"/id",state:"present"}]});
});

test("revocation on final authorization and source-pin changes discard the candidate",async()=>{
  const auth=vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  const revoked=make({authorize:auth});
  await expect(revoked.service.read(context,{selection,policyId:"owner-policy",observationId:id}))
    .rejects.toMatchObject({code:"FIELD_PRESENCE_NOT_FOUND_OR_DENIED"});
  const changed=snapshot();changed.source.source_digest=`sha256:${"a".repeat(64)}`;
  const read=vi.fn().mockResolvedValueOnce(view()).mockResolvedValueOnce(view(changed));
  const stale=make({read});
  await expect(stale.service.read(context,{selection,policyId:"owner-policy",observationId:id}))
    .rejects.toMatchObject({code:"FIELD_PRESENCE_STALE_CONTEXT"});
});

test("qualified source revisions are withheld before body read, including on the final read",async()=>{
  const qualified={...view(),pin:{...view().pin,selectedRevision:"b".repeat(40)}};
  const before=make({read:vi.fn(async()=>qualified)});
  await expect(before.service.read(context,{selection,policyId:"owner-policy",observationId:id}))
    .rejects.toMatchObject({code:"FIELD_PRESENCE_NOT_FOUND_OR_DENIED"});
  expect(before.body).not.toHaveBeenCalled();
  const after=make({read:vi.fn().mockResolvedValueOnce(view()).mockResolvedValueOnce(qualified)});
  await expect(after.service.read(context,{selection,policyId:"owner-policy",observationId:id}))
    .rejects.toMatchObject({code:"FIELD_PRESENCE_NOT_FOUND_OR_DENIED"});
});

test("pointer version is attested and a changed final pointer discards the candidate",async()=>{
  const pointed=()=>{const result=view();return {...result,pin:{...result.pin,pointerVersion:"9"}};};
  const body=vi.fn(async(_context:unknown,pin:FieldPresenceSourcePin,observationId:string,b:FieldPresencePolicyBinding)=>({
    attestation:{...pin,observationId,endpointId:b.policy.endpointId,direction:b.policy.direction,mediaType:b.policy.mediaType},
    payloadText:"{\"customer\":{\"id\":\"value\"}}",payloadCompleteness:"complete_unredacted" as const}));
  const stable=make({read:vi.fn(async()=>pointed()),body});
  await expect(stable.service.read(context,{selection,policyId:"owner-policy",observationId:id}))
    .resolves.toMatchObject({status:"projected"});
  expect(body.mock.calls[0]![1].pointerVersion).toBe("9");
  const changed=vi.fn().mockResolvedValueOnce(pointed()).mockResolvedValueOnce({...pointed(),pin:{...pointed().pin,pointerVersion:"10"}});
  const stale=make({read:changed});
  await expect(stale.service.read(context,{selection,policyId:"owner-policy",observationId:id}))
    .rejects.toMatchObject({code:"FIELD_PRESENCE_STALE_CONTEXT"});
});

test("policy config is detached and successful callback timers are cleared",async()=>{
  vi.useFakeTimers();
  try{
    const configured=binding(),service=make({policy:configured});
    (configured.policy.propertyPaths as string[]).push("/missing");
    const result=await service.service.read(context,{selection,policyId:"owner-policy",observationId:id});
    expect(result).toMatchObject({status:"projected",fields:[{path:"/customer/id",state:"present"},{path:"/count",state:"absent"}]});
    expect(vi.getTimerCount()).toBe(0);
  }finally{vi.useRealTimers();}
});

test("callback and raw payload failures use fixed errors without echoing secrets",async()=>{
  const authorize=vi.fn(async()=>{throw new Error("PRIVATE_CANARY");});
  const denied=make({authorize});
  await expect(denied.service.read(context,{selection,policyId:"owner-policy",observationId:id}))
    .rejects.toThrow("FIELD_PRESENCE_STORAGE_ERROR");
  const bad=make({body:vi.fn(async()=>{throw new Error("BODY_SECRET");})});
  await expect(bad.service.read(context,{selection,policyId:"owner-policy",observationId:id}))
    .rejects.toThrow("FIELD_PRESENCE_STORAGE_ERROR");
});

test("hostile request and query-reader return accessors are not evaluated",async()=>{
  let calls=0;const read=vi.fn(async()=>{const result=view();Object.defineProperty(result,"snapshot",{get(){calls++;throw Error();}});return result;});
  const service=make({read}).service;
  const hostile={selection,policyId:"owner-policy",observationId:id,get extra(){calls++;throw Error();}};
  await expect(service.read(context,hostile as never)).rejects.toMatchObject({code:"FIELD_PRESENCE_INVALID_REQUEST"});
  await expect(service.read(context,{selection,policyId:"owner-policy",observationId:id}))
    .rejects.toMatchObject({code:"FIELD_PRESENCE_NOT_FOUND_OR_DENIED"});
  const proxy=make();await expect(proxy.service.read(new Proxy(context,{}),{selection,policyId:"owner-policy",observationId:id}))
    .rejects.toMatchObject({code:"FIELD_PRESENCE_INVALID_REQUEST"});
  expect(calls).toBe(0);
});

test("external port deadline aborts and returns a fixed storage error",async()=>{
  vi.useFakeTimers();
  try{
    let signal:AbortSignal|undefined;
    const authorize=vi.fn(async(_context:unknown,_pin:unknown,_binding:unknown,_id:string,received:AbortSignal)=>{
      signal=received;return new Promise<boolean>(()=>{});
    });
    const {service}=make({authorize});
    const pending=service.read(context,{selection,policyId:"owner-policy",observationId:id});
    const assertion=expect(pending).rejects.toMatchObject({code:"FIELD_PRESENCE_STORAGE_ERROR"});
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
    expect(signal?.aborted).toBe(true);
  }finally{vi.useRealTimers();}
});

test("revocation during the final query is observed by the last authority check",async()=>{
  let revoked=false,reads=0;const events:string[]=[];
  const read=vi.fn(async()=>{events.push("query");if(++reads===2)revoked=true;return view();});
  const authorize=vi.fn(async()=>{events.push("authorize");return !revoked;});
  const {service}=make({read,authorize});
  await expect(service.read(context,{selection,policyId:"owner-policy",observationId:id}))
    .rejects.toMatchObject({code:"FIELD_PRESENCE_NOT_FOUND_OR_DENIED"});
  expect(events).toEqual(["query","authorize","query","authorize"]);
});
test("a timed-out source result cannot trigger projection or final authority calls",async()=>{
  vi.useFakeTimers();
  try{
    let sourceSignal:AbortSignal|undefined,complete:(value:unknown)=>void=()=>{};
    const body=vi.fn(async(_context:unknown,_pin:unknown,_id:unknown,_binding:unknown,signal:AbortSignal)=>{
      sourceSignal=signal;return new Promise<unknown>(resolve=>{complete=resolve;});
    });
    const {service,authorize,read}=make({body});
    const pending=service.read(context,{selection,policyId:"owner-policy",observationId:id});
    const assertion=expect(pending).rejects.toMatchObject({code:"FIELD_PRESENCE_STORAGE_ERROR"});
    await vi.advanceTimersByTimeAsync(10_000);await assertion;
    expect(sourceSignal?.aborted).toBe(true);
    complete({payloadText:"PRIVATE_CANARY"});await vi.advanceTimersByTimeAsync(1);
    expect(authorize).toHaveBeenCalledOnce();expect(read).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  }finally{vi.useRealTimers();}
});

test("revoked source attestation proxies produce fixed service errors",async()=>{
  const {proxy,revoke}=Proxy.revocable({},{});revoke();
  const body=vi.fn(async()=>({attestation:proxy,payloadText:"{}",payloadCompleteness:"complete_unredacted"}));
  const {service}=make({body});
  await expect(service.read(context,{selection,policyId:"owner-policy",observationId:id}))
    .rejects.toMatchObject({code:"FIELD_PRESENCE_STORAGE_ERROR"});
});
test("revoked configured reader proxies produce fixed configuration errors",()=>{
  const {proxy,revoke}=Proxy.revocable({},{});revoke();
  expect(()=>createFieldPresenceService({queryReader:proxy as never,policies:[],
    authorize:async()=>true,readObservation:async()=>({})})).toThrow("FIELD_PRESENCE_INVALID_CONFIGURATION");
});
