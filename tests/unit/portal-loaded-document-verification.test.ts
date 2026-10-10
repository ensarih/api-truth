import {once} from "node:events";
import type {IncomingMessage} from "node:http";
import {afterEach,expect,test,vi} from "vitest";
import {createPortalServer} from "../../apps/portal/src/server.js";

const principal={tenantId:"tenant-a",principalId:"reader-a"};
const args={repositoryId:"commerce",serviceId:"orders",environment:"uat",snapshotId:"snapshot-a",revision:"a".repeat(40),
  configFingerprint:"sha256:"+"c".repeat(64),checkpointVersion:"7",configActivationCheckpoint:"3",
  loadIdentityDigest:"sha256:"+"d".repeat(64)};
const envelope={status:"resolved",kind:"controlled_loaded_swagger_document_verification",nonNormative:true,
  pin:{tenantId:principal.tenantId,...args,sourceDigest:"sha256:"+"e".repeat(64)},limitations:["Not deployment."]};
const servers:Array<ReturnType<typeof createPortalServer>>=[];
afterEach(async()=>{for(const server of servers.splice(0)){server.closeAllConnections();server.close();await once(server,"close");}});
const open=async(read:(...args:unknown[])=>Promise<unknown>=async()=>envelope,enabled=true)=>{
  const authenticate=vi.fn(async(request:IncomingMessage)=>request.headers.authorization==="Bearer fixture"?principal:undefined);
  const readForPrincipal=vi.fn(read),unavailable=async()=>{throw Error("Unexpected query access");};
  const server=createPortalServer({authenticate,query:{searchServices:unavailable,readContract:unavailable,
    compareContracts:unavailable,readPublication:unavailable},...(enabled?{loadedDocumentVerification:{readForPrincipal} as never}:{})});
  servers.push(server);server.listen(0,"127.0.0.1");await once(server,"listening");
  const address=server.address();if(!address||typeof address==="string")throw Error("Missing port");
  return {base:`http://127.0.0.1:${address.port}`,authenticate,readForPrincipal};
};
const headers={authorization:"Bearer fixture"};
const path=(values:Record<string,string>=args)=>"/api/loaded-document-verification?"+new URLSearchParams(values);

test("portal reads an optional controlled-load result using the authenticated request and exact pin",async()=>{
  const {base,authenticate,readForPrincipal}=await open();
  const response=await fetch(base+path(),{headers});
  expect(response.status).toBe(200);expect(await response.json()).toEqual(envelope);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(readForPrincipal).toHaveBeenCalledWith(authenticate.mock.calls[0]?.[0],principal,
    {loadIdentityDigest:args.loadIdentityDigest,expectedPin:{tenantId:principal.tenantId,repositoryId:args.repositoryId,
      serviceId:args.serviceId,environment:args.environment,snapshotId:args.snapshotId,revision:args.revision,
      configFingerprint:args.configFingerprint,checkpointVersion:args.checkpointVersion},
      configActivationCheckpoint:args.configActivationCheckpoint});
});

test("denied authentication and an unconfigured host cannot invoke the reader",async()=>{
  const denied=await open();expect((await fetch(denied.base+path())).status).toBe(401);
  expect(denied.readForPrincipal).not.toHaveBeenCalled();
  const absent=await open(undefined,false);expect((await fetch(absent.base+path(),{headers})).status).toBe(404);
  expect(absent.readForPrincipal).not.toHaveBeenCalled();
});

test("rejects spoofed identity, unknown, duplicate, malformed and qualified fields before reader invocation",async()=>{
  const {base,readForPrincipal}=await open();
  const missing={...args};delete (missing as Partial<typeof args>).snapshotId;
  for(const query of [path({...args,tenantId:"foreign"}),path({...args,principalId:"foreign"}),path({...args,credential:"secret"}),
    path({...args,artifactRef:"private"}),path({...args,selectedRevision:"b".repeat(40)}),path({...args,pointerVersion:"2"}),
    path({...args,revision:"short"}),path({...args,configFingerprint:"invalid"}),path({...args,checkpointVersion:"0"}),
    path({...args,loadIdentityDigest:"invalid"}),path(missing),path()+"&loadIdentityDigest="+args.loadIdentityDigest]){
    expect((await fetch(base+query,{headers})).status).toBe(400);
  }
  expect(readForPrincipal).not.toHaveBeenCalled();
});

test("accepts underscore and dot-leading identifiers matching the reader contract",async()=>{
  const {base,readForPrincipal}=await open();
  const accepted={...args,repositoryId:"_repo",serviceId:".service",environment:"_test",snapshotId:".snapshot"};
  expect((await fetch(base+path(accepted),{headers})).status).toBe(200);
  expect(readForPrincipal).toHaveBeenCalledTimes(1);
  expect((await fetch(base+path({...accepted,serviceId:"service:bad"}),{headers})).status).toBe(400);
  expect(readForPrincipal).toHaveBeenCalledTimes(1);
});

  test.each([["LOADED_DOCUMENT_READ_UNAUTHORIZED",404,"NOT_FOUND"],
  ["LOADED_DOCUMENT_READ_STALE",409,"STALE_SELECTION"],["INVALID_LOADED_DOCUMENT_READ_REQUEST",400,"INVALID_REQUEST"],
  ["LOADED_DOCUMENT_READ_UNAVAILABLE",503,"QUERY_UNAVAILABLE"],["LOADED_DOCUMENT_READ_STORAGE_ERROR",503,"QUERY_UNAVAILABLE"]])
  ("sanitizes loaded-document failure %s",async(code,status,error)=>{
    const {base}=await open(async()=>{throw Object.assign(new Error("PRIVATE_ARTIFACT_CANARY"),{code});});
    const response=await fetch(base+path(),{headers});
    const text=await response.text();
    expect(response.status).toBe(status);expect(JSON.parse(text)).toEqual({error});
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(text).not.toContain("PRIVATE_ARTIFACT_CANARY");
  });

test("a hostile thrown proxy is not inspected for an error code",async()=>{
  let traps=0;const thrown=new Proxy({}, {getOwnPropertyDescriptor(){traps++;throw new Error("trap");}});
  const {base}=await open(async()=>{throw thrown;});
  const response=await fetch(base+path(),{headers});
  expect(response.status).toBe(503);expect(await response.json()).toEqual({error:"QUERY_UNAVAILABLE"});expect(traps).toBe(0);
});

test("bounds serialized output and withholds oversized content",async()=>{
  const {base}=await open(async()=>({...envelope,limitations:Array.from({length:500},()=>"private ".repeat(500))}));
  const response=await fetch(base+path(),{headers});
  const text=await response.text();expect(response.status).toBe(422);expect(JSON.parse(text)).toEqual({error:"RESULT_LIMIT_EXCEEDED"});
  expect(text).not.toContain("private");
});
