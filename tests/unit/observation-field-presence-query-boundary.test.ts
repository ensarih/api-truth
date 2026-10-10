import {expect,test,vi} from "vitest";
import type {Pool} from "pg";
import {createFieldPresenceQueryStore,type FieldPresenceQueryManager} from "../../packages/observations/src/index.js";

const binding=()=>({tenantId:"tenant-a",repositoryId:"commerce",serviceId:"orders",environment:"uat",
  policyId:"order-fields",ownerAccessScopeId:"owner-read",readAccessScopeId:"presence-read"});
const request=()=>({policyId:"order-fields",ownerPolicyRevision:"1",limit:20,expectedPin:{tenantId:"tenant-a",
  repositoryId:"commerce",serviceId:"orders",environment:"uat",snapshotId:"snapshot-a",revision:"revision-a",
  configFingerprint:"sha256:"+"c".repeat(64),checkpointVersion:"7"}});
const identity=()=>({tenantId:"tenant-a",principalId:"reader",capabilities:["observations.presence.read"]});
const make=(authorizeManager:FieldPresenceQueryManager)=>{
  const connect=vi.fn(async()=>{throw Error("PRIVATE_DATABASE_CANARY");});
  const store=createFieldPresenceQueryStore({connect} as unknown as Pool,
    {schema:"presence_boundary",bindings:[binding()],authorizeManager});
  return {store,connect};
};

test("read authorization deadline aborts and ignores a late valid identity before connecting",async()=>{
  vi.useFakeTimers();
  try{
    let release!:(value:unknown)=>void;let signal:AbortSignal|undefined;
    const {store,connect}=make(async(_credential,_binding,received)=>{
      signal=received;return new Promise(resolve=>{release=resolve;});
    });
    const pending=store.read({opaque:"credential"},request());
    const denied=expect(pending).rejects.toMatchObject({code:"FIELD_PRESENCE_QUERY_UNAUTHORIZED"});
    await vi.advanceTimersByTimeAsync(10_000);await denied;
    expect(signal?.aborted).toBe(true);expect(connect).not.toHaveBeenCalled();
    release(identity());await Promise.resolve();
    expect(connect).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);
  }finally{vi.useRealTimers();}
});

test("host identities with accessors, proxies or foreign tenants cannot reach storage",async()=>{
  const getter=vi.fn(()=>"reader"),trap=vi.fn(()=>{throw Error("PRIVATE_TRAP_CANARY");});
  const accessor={tenantId:"tenant-a",capabilities:["observations.presence.read"]};
  Object.defineProperty(accessor,"principalId",{enumerable:true,get:getter});
  const revoked=Proxy.revocable(identity(),{});revoked.revoke();
  for(const value of [accessor,new Proxy(identity(),{ownKeys:trap}),revoked.proxy,
    {...identity(),tenantId:"foreign-tenant"},{...identity(),capabilities:["observations.policy.manage"]}]){
    const {store,connect}=make(async()=>value);
    await expect(store.read(undefined,request())).rejects.toMatchObject({code:"FIELD_PRESENCE_QUERY_UNAUTHORIZED"});
    expect(connect).not.toHaveBeenCalled();
  }
  expect(getter).not.toHaveBeenCalled();expect(trap).not.toHaveBeenCalled();
});

test("host binding mutation cannot replace the original owner or reader scope",async()=>{
  const configured=binding(),seen:unknown[]=[];
  const authorizeManager:FieldPresenceQueryManager=async(_credential,selected)=>{seen.push(selected);return undefined;};
  const connect=vi.fn();
  const store=createFieldPresenceQueryStore({connect} as unknown as Pool,
    {schema:"presence_boundary",bindings:[configured],authorizeManager});
  configured.ownerAccessScopeId="attacker-owner";configured.readAccessScopeId="attacker-read";
  await expect(store.read(undefined,request())).rejects.toMatchObject({code:"FIELD_PRESENCE_QUERY_UNAUTHORIZED"});
  expect(seen).toEqual([binding()]);expect(Object.isFrozen(seen[0])).toBe(true);expect(connect).not.toHaveBeenCalled();
});

test("storage failures expose a fixed code without database details",async()=>{
  const {store,connect}=make(async()=>identity());
  await expect(store.read(undefined,request())).rejects.toMatchObject({
    code:"FIELD_PRESENCE_QUERY_STORAGE_ERROR",message:"FIELD_PRESENCE_QUERY_STORAGE_ERROR"});
  expect(connect).toHaveBeenCalledOnce();
});
