import {expect,test,vi} from "vitest";
import type {Pool} from "pg";
import {createFieldPresenceQueryStore,type FieldPresenceQueryManager} from "../../packages/observations/src/field-presence-query-store.js";

const binding=()=>({tenantId:"tenant-a",repositoryId:"commerce",serviceId:"orders",environment:"uat",
  policyId:"order-fields",ownerAccessScopeId:"owner-read",readAccessScopeId:"presence-read"});
const request=()=>({policyId:"order-fields",ownerPolicyRevision:"1",limit:20,expectedPin:{tenantId:"tenant-a",
  repositoryId:"commerce",serviceId:"orders",environment:"uat",snapshotId:"snapshot-a",revision:"revision-a",
  configFingerprint:"sha256:"+"c".repeat(64),checkpointVersion:"7"}});
const expected={tenantId:"tenant-a",principalId:"reader-a"};
const identity=(tenantId=expected.tenantId,principalId=expected.principalId)=>({tenantId,principalId,
  capabilities:["observations.presence.read"]});
const make=(authorizeManager:FieldPresenceQueryManager)=>{
  const connect=vi.fn(async()=>{throw Error("PRIVATE_DATABASE_CANARY");});
  const store=createFieldPresenceQueryStore({connect} as unknown as Pool,
    {schema:"presence_principal",bindings:[binding()],authorizeManager});
  return {store,connect};
};

test("a supplied principal anchor alone cannot authorize a presence read",async()=>{
  const {store,connect}=make(async()=>undefined);
  await expect(store.readForPrincipal(undefined,expected,request()))
    .rejects.toMatchObject({code:"FIELD_PRESENCE_QUERY_UNAUTHORIZED"});
  expect(connect).not.toHaveBeenCalled();
});

test("anchor tenant mismatch is denied before authentication or storage",async()=>{
  const authorize=vi.fn(async()=>identity()),{store,connect}=make(authorize);
  await expect(store.readForPrincipal(undefined,{...expected,tenantId:"tenant-other"},request()))
    .rejects.toMatchObject({code:"FIELD_PRESENCE_QUERY_UNAUTHORIZED"});
  expect(authorize).not.toHaveBeenCalled();expect(connect).not.toHaveBeenCalled();
});

test("manager authentication must match both anchored tenant and principal before storage",async()=>{
  for(const authenticated of [identity("tenant-other",expected.principalId),identity(expected.tenantId,"other-reader")]){
    const authorize=vi.fn(async()=>authenticated),{store,connect}=make(authorize);
    await expect(store.readForPrincipal({opaque:"host"},expected,request()))
      .rejects.toMatchObject({code:"FIELD_PRESENCE_QUERY_UNAUTHORIZED"});
    expect(authorize).toHaveBeenCalledOnce();expect(connect).not.toHaveBeenCalled();
  }
});

test("malformed principal anchors with accessors or proxies are rejected without traps",async()=>{
  const getter=vi.fn(()=>expected.principalId),trap=vi.fn(()=>{throw new Error("PRIVATE_TRAP_CANARY");});
  const accessor={tenantId:expected.tenantId};Object.defineProperty(accessor,"principalId",{enumerable:true,get:getter});
  const revoked=Proxy.revocable({...expected},{});revoked.revoke();
  const authorize=vi.fn(async()=>identity()),{store,connect}=make(authorize);
  for(const anchor of [accessor,new Proxy({...expected},{ownKeys:trap}),revoked.proxy,
    {...expected,capabilities:["observations.presence.read"]}])
    await expect(store.readForPrincipal(undefined,anchor,request())).rejects.toMatchObject({code:"FIELD_PRESENCE_QUERY_UNAUTHORIZED"});
  expect(getter).not.toHaveBeenCalled();expect(trap).not.toHaveBeenCalled();
  expect(authorize).not.toHaveBeenCalled();expect(connect).not.toHaveBeenCalled();
});

test("anchor is detached before awaiting authentication",async()=>{
  let complete!:(value:unknown)=>void;
  const authorize=vi.fn(()=>new Promise<unknown>(resolve=>{complete=resolve;})),{store,connect}=make(authorize);
  const anchor={...expected};
  const pending=store.readForPrincipal({opaque:"host"},anchor,request());
  anchor.principalId="attacker";
  await vi.waitFor(()=>expect(complete).toBeTypeOf("function"));
  complete(identity());
  await expect(pending).rejects.toMatchObject({code:"FIELD_PRESENCE_QUERY_STORAGE_ERROR"});
  expect(authorize).toHaveBeenCalledOnce();expect(connect).toHaveBeenCalledOnce();
});
