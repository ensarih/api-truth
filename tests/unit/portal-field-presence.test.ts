import {once} from "node:events";
import type {IncomingMessage} from "node:http";
import {afterEach,expect,test,vi} from "vitest";
import {createPortalServer} from "../../apps/portal/src/server.js";

const principal={tenantId:"tenant-a",principalId:"reader-a"};
const args={repositoryId:"commerce",serviceId:"orders",environment:"uat",snapshotId:"snapshot-a",revision:"revision-a",
  configFingerprint:"sha256:"+"c".repeat(64),checkpointVersion:"7",policyId:"order-fields",ownerPolicyRevision:"2",limit:"20"};
const envelope={status:"resolved",kind:"observed_field_presence",nonNormative:true,pin:{tenantId:"tenant-a",...args},records:[],truncated:false};
const servers:Array<ReturnType<typeof createPortalServer>>=[];
afterEach(async()=>{for(const server of servers.splice(0)){server.closeAllConnections();server.close();await once(server,"close");}});
const open=async(read:(...args:unknown[])=>Promise<unknown>=async()=>envelope,enabled=true)=>{
  const authenticate=vi.fn(async(request:IncomingMessage)=>request.headers.authorization==="Bearer fixture"?principal:undefined);
  const readForPrincipal=vi.fn(read);
  const unavailable=async()=>{throw Error("Unexpected query access");};
  const server=createPortalServer({authenticate,query:{searchServices:unavailable,readContract:unavailable,
    compareContracts:unavailable,readPublication:unavailable},...(enabled?{presence:{readForPrincipal} as never}:{})});
  servers.push(server);server.listen(0,"127.0.0.1");await once(server,"listening");
  const address=server.address();if(!address||typeof address==="string")throw Error("Missing port");
  return {base:`http://127.0.0.1:${address.port}`,authenticate,readForPrincipal};
};
const headers={authorization:"Bearer fixture"};
const path=(values:Record<string,string>=args)=>"/api/field-presence?"+new URLSearchParams(values);

test("portal presence uses the authenticated request and principal with an exact environment pin",async()=>{
  const {base,authenticate,readForPrincipal}=await open();
  const response=await fetch(base+path(),{headers});
  expect(response.status).toBe(200);expect(await response.json()).toEqual(envelope);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(readForPrincipal).toHaveBeenCalledWith(authenticate.mock.calls[0]?.[0],principal,{policyId:args.policyId,
    ownerPolicyRevision:args.ownerPolicyRevision,limit:20,expectedPin:{tenantId:principal.tenantId,
      repositoryId:args.repositoryId,serviceId:args.serviceId,environment:args.environment,snapshotId:args.snapshotId,
      revision:args.revision,configFingerprint:args.configFingerprint,checkpointVersion:args.checkpointVersion}});
});

test("denied authentication and an unconfigured presence host cannot invoke the reader",async()=>{
  const denied=await open();
  expect((await fetch(denied.base+path())).status).toBe(401);expect(denied.readForPrincipal).not.toHaveBeenCalled();
  const absent=await open(undefined,false);
  expect((await fetch(absent.base+path(),{headers})).status).toBe(404);expect(absent.readForPrincipal).not.toHaveBeenCalled();
});

test("presence rejects forged identities, qualification, credentials, duplicate fields and missing pins",async()=>{
  const {base,readForPrincipal}=await open();
  const missing={...args};delete (missing as Partial<typeof args>).snapshotId;
  for(const query of [path({...args,tenantId:"foreign"}),path({...args,credential:"secret"}),
    path({...args,selectedRevision:"other"}),path({...args,pointerVersion:"3"}),path({...args,limit:"101"}),
    path({...args,configFingerprint:"invalid"}),path(missing),path()+"&limit=1"]){
    expect((await fetch(base+query,{headers})).status).toBe(400);
  }
  expect(readForPrincipal).not.toHaveBeenCalled();
});

test.each([["FIELD_PRESENCE_QUERY_UNAUTHORIZED",404,"NOT_FOUND"],
  ["FIELD_PRESENCE_QUERY_STALE",409,"STALE_SELECTION"],["FIELD_PRESENCE_QUERY_INVALID_REQUEST",400,"INVALID_REQUEST"],
  ["FIELD_PRESENCE_QUERY_STORAGE_ERROR",503,"QUERY_UNAVAILABLE"]])("sanitizes presence failure %s",async(code,status,error)=>{
  const {base}=await open(async()=>{throw Object.assign(new Error("PRIVATE_DATABASE_CANARY"),{code});});
  const response=await fetch(base+path(),{headers});
  expect(response.status).toBe(status);expect(await response.json()).toEqual({error});
});

test("bounds serialized presence output without disclosing oversized content",async()=>{
  const {base}=await open(async()=>({...envelope,records:[{marker:"PRIVATE_CANARY".repeat(100_000)}]}));
  const response=await fetch(base+path(),{headers});
  expect(response.status).toBe(422);expect(await response.json()).toEqual({error:"RESULT_LIMIT_EXCEEDED"});
});
