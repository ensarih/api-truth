import {generateKeyPairSync,sign} from "node:crypto";
import {mkdtemp,rm,symlink,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach,expect,test,vi} from "vitest";
import {canonicalJsonStringify} from "../../packages/ir/src/index.js";
import {createSignedFieldPresenceFileReader} from "../../connectors/observation-file/src/field-presence.js";

const importId="550e8400-e29b-4d4a-a716-446655440000",recordId="550e8400-e29b-4d4a-a716-446655440001";
const binding={tenantId:"tenant-a",repositoryId:"commerce",serviceId:"orders",environment:"uat"};
const expectedPin={...binding,snapshotId:"snapshot-a",revision:"revision-a",configFingerprint:"sha256:"+"c".repeat(64),checkpointVersion:"7"};
const request={binding:{...binding,policyId:"order-fields",ownerAccessScopeId:"owner",importAccessScopeId:"import"},importId,recordId,
  expectedPin,selector:{endpointId:"ep-get",direction:"response" as const,mediaType:"application/json",statusCode:200},
  source:{sourceId:"gateway-log",sourceVersion:"source-1",windowStart:"2026-10-09T00:00:00.000Z",windowEnd:"2026-10-09T00:01:00.000Z"}};
const identity={tenantId:binding.tenantId,principalId:"importer",capabilities:["observations.presence.import"]};
const attestation={...expectedPin,sourceDigest:"sha256:"+"d".repeat(64),importId,recordId,endpointId:"ep-get",direction:"response",
  mediaType:"application/json",statusCode:200,sourceId:"gateway-log",sourceVersion:"source-1",
  windowStart:request.source.windowStart,windowEnd:request.source.windowEnd};
const payload={version:"field-presence-source-1",attestation,payloadText:'{"id":"PRIVATE_VALUE_CANARY"}',payloadCompleteness:"complete_unredacted"};
const envelope=(privateKey:NonNullable<ReturnType<typeof generateKeyPairSync>["privateKey"]>,value:unknown=payload,
  purpose="api-truth:field-presence-source-1\n")=>{
  const bytes=Buffer.from(`${purpose}${canonicalJsonStringify(value)}`);
  return JSON.stringify({payload:value,signature:sign(null,bytes,privateKey).toString("base64")});
};
const keys=generateKeyPairSync("ed25519");
const dirs:string[]=[];
const directory=async()=>{const root=await mkdtemp(join(tmpdir(),"presence-file-"));dirs.push(root);return root;};
const filename=`${importId}.${recordId}.presence.json`;
const reader=async(root:string,overrides:Record<string,unknown>={})=>createSignedFieldPresenceFileReader({root,
  publicKeyPem:keys.publicKey.export({type:"spki",format:"pem"}).toString(),sourceId:"gateway-log",bindings:[binding],...overrides} as never);
afterEach(async()=>{await Promise.all(dirs.splice(0).map(root=>rm(root,{recursive:true,force:true})));});

test("returns only the exact signed payload facts for the selected pin, source and body selector",async()=>{
  const root=await directory();await writeFile(join(root,filename),envelope(keys.privateKey));
  const read=await reader(root),result=await read(identity,request,new AbortController().signal) as {attestation:unknown};
  expect(result).toEqual({attestation,payloadText:payload.payloadText,payloadCompleteness:"complete_unredacted"});
  expect(Object.isFrozen(result)).toBe(true);expect(Object.isFrozen(result.attestation)).toBe(true);
  expect(JSON.stringify(result)).not.toContain("signature");
});

test.each([
  ["tenant",{attestation:{...attestation,tenantId:"other"}}],
  ["revision",{attestation:{...attestation,revision:"revision-other"}}],
  ["config fingerprint",{attestation:{...attestation,configFingerprint:"sha256:"+"e".repeat(64)}}],
  ["checkpoint",{attestation:{...attestation,checkpointVersion:"8"}}],
  ["import",{attestation:{...attestation,importId:"550e8400-e29b-4d4a-a716-446655440002"}}],
  ["source ID",{attestation:{...attestation,sourceId:"other-source"}}],
  ["source version",{attestation:{...attestation,sourceVersion:"source-2"}}],
  ["media type",{attestation:{...attestation,mediaType:"text/plain"}}],
  ["direction",{attestation:{...attestation,direction:"request"}}],
  ["source digest format",{attestation:{...attestation,sourceDigest:"sha256:not-a-digest"}}],
  ["record",{attestation:{...attestation,recordId:"550e8400-e29b-4d4a-a716-446655440002"}}],
  ["selector",{attestation:{...attestation,endpointId:"ep-create"}}],
  ["status",{attestation:{...attestation,statusCode:201}}],
  ["source window",{attestation:{...attestation,windowEnd:"2026-10-09T00:02:00.000Z"}}],
])("rejects a correctly signed payload with mismatched %s facts",async(_name,change)=>{
  const root=await directory(),changed={...payload,...change};await writeFile(join(root,filename),envelope(keys.privateKey,changed));
  const read=await reader(root);await expect(read(identity,request,new AbortController().signal))
    .rejects.toMatchObject({code:"FIELD_PRESENCE_FILE_REJECTED"});
});

test("rejects wrong signatures, wrong keys, invalid identities and mismatched request selector",async()=>{
  const root=await directory();await writeFile(join(root,filename),envelope(keys.privateKey));
  const wrong=generateKeyPairSync("ed25519"),wrongReader=await reader(root,{publicKeyPem:wrong.publicKey.export({type:"spki",format:"pem"}).toString()});
  await expect(wrongReader(identity,request,new AbortController().signal)).rejects.toMatchObject({code:"FIELD_PRESENCE_FILE_REJECTED"});
  const read=await reader(root);
  await expect(read({...identity,tenantId:"other"},request,new AbortController().signal)).rejects.toMatchObject({code:"FIELD_PRESENCE_FILE_REJECTED"});
  const identityProxy=Proxy.revocable({...identity},{});identityProxy.revoke();
  await expect(read(identityProxy.proxy,request,new AbortController().signal)).rejects.toMatchObject({code:"FIELD_PRESENCE_FILE_REJECTED"});
  await expect(read(identity,{...request,selector:{...request.selector,statusCode:204}},new AbortController().signal))
    .rejects.toMatchObject({code:"FIELD_PRESENCE_FILE_REJECTED"});
  await expect(read(identity,{...request,source:{...request.source,sourceId:"other-source"}},new AbortController().signal))
    .rejects.toMatchObject({code:"FIELD_PRESENCE_FILE_REJECTED"});
});

test("accepts an exact request-body attestation without response status",async()=>{
  const root=await directory(),requestBody={...request,selector:{endpointId:"ep-create",direction:"request" as const,mediaType:"application/json"}};
  const bodyAttestation={...attestation,endpointId:"ep-create",direction:"request",statusCode:undefined};
  delete (bodyAttestation as Record<string,unknown>).statusCode;
  const bodyPayload={...payload,attestation:bodyAttestation};
  await writeFile(join(root,filename),envelope(keys.privateKey,bodyPayload));
  const read=await reader(root),result=await read(identity,requestBody,new AbortController().signal) as {attestation:Record<string,unknown>};
  expect(result.attestation).toEqual(bodyAttestation);
  expect(Object.hasOwn(result.attestation,"statusCode")).toBe(false);
});

test("rejects tampered payloads and signatures from another purpose",async()=>{
  const root=await directory(),read=await reader(root),tampered=JSON.parse(envelope(keys.privateKey)) as {payload:typeof payload;signature:string};
  tampered.payload.payloadText='{"id":"ALTERED"}';
  await writeFile(join(root,filename),JSON.stringify(tampered));
  await expect(read(identity,request,new AbortController().signal)).rejects.toMatchObject({code:"FIELD_PRESENCE_FILE_REJECTED"});
  await writeFile(join(root,filename),envelope(keys.privateKey,payload,"api-truth:other-purpose\n"));
  await expect(read(identity,request,new AbortController().signal)).rejects.toMatchObject({code:"FIELD_PRESENCE_FILE_REJECTED"});
});

test("rejects incomplete, redacted and over-limit payload declarations",async()=>{
  const root=await directory(),read=await reader(root);
  for(const completeness of ["partial","redacted"]){
    await writeFile(join(root,filename),envelope(keys.privateKey,{...payload,payloadCompleteness:completeness}));
    await expect(read(identity,request,new AbortController().signal)).rejects.toMatchObject({code:"FIELD_PRESENCE_FILE_REJECTED"});
  }
  await writeFile(join(root,filename),envelope(keys.privateKey,{...payload,payloadText:"x".repeat(262_145)}));
  await expect(read(identity,request,new AbortController().signal)).rejects.toMatchObject({code:"FIELD_PRESENCE_FILE_REJECTED"});
});

test("reports a missing selected file without scanning the directory",async()=>{
  const root=await directory(),read=await reader(root);
  await expect(read(identity,request,new AbortController().signal)).rejects.toMatchObject({code:"FIELD_PRESENCE_FILE_UNAVAILABLE"});
});

test("rejects duplicate JSON keys, malformed UTF-8, oversized files and symlinks",async()=>{
  const root=await directory(),read=await reader(root);
  await writeFile(join(root,filename),`{"payload":{"a":1,"\\u0061":2},"signature":"${"A".repeat(88)}"}`);
  await expect(read(identity,request,new AbortController().signal)).rejects.toMatchObject({code:"FIELD_PRESENCE_FILE_REJECTED"});
  await writeFile(join(root,filename),Buffer.from([0xff,0xfe]));
  await expect(read(identity,request,new AbortController().signal)).rejects.toMatchObject({code:"FIELD_PRESENCE_FILE_REJECTED"});
  await writeFile(join(root,filename),Buffer.alloc(1_048_577,0x20));
  await expect(read(identity,request,new AbortController().signal)).rejects.toMatchObject({code:"FIELD_PRESENCE_FILE_REJECTED"});
  const outside=join(root,"outside.json");await writeFile(outside,envelope(keys.privateKey));
  await rm(join(root,filename),{force:true});await symlink(outside,join(root,filename));
  await expect(read(identity,request,new AbortController().signal)).rejects.toMatchObject({code:"FIELD_PRESENCE_FILE_REJECTED"});
});

test("rejects aborted reads and malformed/accessor/proxy inputs without invoking traps",async()=>{
  const root=await directory();await writeFile(join(root,filename),envelope(keys.privateKey));
  const read=await reader(root),controller=new AbortController();controller.abort();
  await expect(read(identity,request,controller.signal)).rejects.toMatchObject({code:"FIELD_PRESENCE_FILE_REJECTED"});
  const trap=vi.fn(()=>{throw Error("PRIVATE_TRAP_CANARY");}),accessor={...request};
  Object.defineProperty(accessor,"recordId",{enumerable:true,get:trap});
  await expect(read(identity,accessor,new AbortController().signal)).rejects.toMatchObject({code:"FIELD_PRESENCE_FILE_REJECTED"});
  const revoked=Proxy.revocable({...request},{});revoked.revoke();
  await expect(read(identity,revoked.proxy,new AbortController().signal)).rejects.toMatchObject({code:"FIELD_PRESENCE_FILE_REJECTED"});
  await expect(read(identity,request,{aborted:false} as AbortSignal)).rejects.toMatchObject({code:"FIELD_PRESENCE_FILE_REJECTED"});
  expect(trap).not.toHaveBeenCalled();
});

test("rejects hostile options without traps and snapshots the configured allowlist",async()=>{
  const root=await directory(),trap=vi.fn(()=>{throw Error("PRIVATE_TRAP_CANARY");});
  const hostile=Proxy.revocable({}, {ownKeys:trap});hostile.revoke();
  await expect(createSignedFieldPresenceFileReader(hostile.proxy as never)).rejects.toMatchObject({code:"FIELD_PRESENCE_FILE_INVALID_CONFIG"});
  expect(trap).not.toHaveBeenCalled();
  const bindings=[{...binding}],options={root,publicKeyPem:keys.publicKey.export({type:"spki",format:"pem"}).toString(),
    sourceId:"gateway-log",bindings};
  const read=await createSignedFieldPresenceFileReader(options);
  bindings[0]!.tenantId="tenant-b";
  await writeFile(join(root,filename),envelope(keys.privateKey));
  await expect(read(identity,request,new AbortController().signal)).resolves.toMatchObject({attestation});
});

test("validates trusted root and immutable allowlists at construction",async()=>{
  const root=await directory();
  await expect(createSignedFieldPresenceFileReader({root:"relative",publicKeyPem:"",sourceId:"gateway-log",bindings:[binding]} as never))
    .rejects.toMatchObject({code:"FIELD_PRESENCE_FILE_INVALID_CONFIG"});
  await expect(reader(root,{bindings:[binding,{...binding,serviceId:"orders"}]}))
    .rejects.toMatchObject({code:"FIELD_PRESENCE_FILE_INVALID_CONFIG"});
  const accessor={...binding};Object.defineProperty(accessor,"tenantId",{enumerable:true,get(){throw Error("PRIVATE_CONFIG_CANARY");}});
  await expect(reader(root,{bindings:[accessor]})).rejects.toMatchObject({code:"FIELD_PRESENCE_FILE_INVALID_CONFIG"});
});


test("abort after invocation and hostile identity/signal inputs return only fixed failures",async()=>{
  const root=await directory();await writeFile(join(root,filename),envelope(keys.privateKey));
  const read=await reader(root),controller=new AbortController();
  const pending=read(identity,request,controller.signal);controller.abort("PRIVATE_ABORT_CANARY");
  await expect(pending).rejects.toMatchObject({code:"FIELD_PRESENCE_FILE_REJECTED",message:"FIELD_PRESENCE_FILE_REJECTED"});
  const trap=vi.fn(()=>{throw Error("PRIVATE_IDENTITY_CANARY");});
  const identityProxy=new Proxy(identity,{get:trap,ownKeys:trap,getPrototypeOf:trap});
  await expect(read(identityProxy,request,new AbortController().signal)).rejects.toMatchObject({code:"FIELD_PRESENCE_FILE_REJECTED"});
  const fakeSignal=new Proxy({},{get:trap,getPrototypeOf:trap});
  await expect(read(identity,request,fakeSignal as AbortSignal)).rejects.toMatchObject({code:"FIELD_PRESENCE_FILE_REJECTED"});
  await expect(read({...identity,capabilities:["observations.presence.import","observations.presence.import"]},request,new AbortController().signal))
    .rejects.toMatchObject({code:"FIELD_PRESENCE_FILE_REJECTED"});
  expect(trap).not.toHaveBeenCalled();
});
