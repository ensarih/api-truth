import {afterEach,expect,test,vi} from "vitest";
import {Client,InMemoryTransport} from "@modelcontextprotocol/client";
import {createApiTruthMcpServer} from "../../apps/mcp/src/server.js";
import type {QueryReader} from "../../packages/query/src/index.js";

const principal={tenantId:"tenant-a",principalId:"reader-a"};
const args={repositoryId:"commerce",serviceId:"orders",environment:"uat",snapshotId:"snapshot-a",revision:"a".repeat(40),
  configFingerprint:"sha256:"+"c".repeat(64),checkpointVersion:"7",configActivationCheckpoint:"3",
  loadIdentityDigest:"sha256:"+"d".repeat(64)};
const envelope={status:"resolved",kind:"controlled_loaded_swagger_document_verification",nonNormative:true,
  pin:{tenantId:principal.tenantId,repositoryId:args.repositoryId,serviceId:args.serviceId,environment:args.environment,
    snapshotId:args.snapshotId,revision:args.revision,configFingerprint:args.configFingerprint,
    checkpointVersion:args.checkpointVersion,sourceDigest:"sha256:"+"e".repeat(64),
    configActivationCheckpoint:args.configActivationCheckpoint},
  verification:{profileVersion:"swagger-loaded-document-1",loadIdentityDigest:args.loadIdentityDigest,
    captureIdentityDigest:"sha256:"+"f".repeat(64),resultDigest:"sha256:"+"1".repeat(64),verifiedAt:"2026-10-08T16:00:00.000000Z",
    handlerCount:1,matchCount:1,unobservedDiagnosticCount:0},
  document:{path:"api/swagger/swagger.yaml",rawSha256:"sha256:"+"2".repeat(64),
    canonicalValueSha256:"sha256:"+"3".repeat(64),documentDigest:"sha256:"+"4".repeat(64)},
  serviceRoot:"services/orders",limitations:["Controlled load metadata only.","Not deployment or normative behavior."]};
const opened:Array<{client:Client;server:ReturnType<typeof createApiTruthMcpServer>}> = [];
afterEach(async()=>{await Promise.allSettled(opened.splice(0).flatMap(({client,server})=>[client.close(),server.close()]));});
const open=async(readForPrincipal:(...args:unknown[])=>Promise<unknown>=async()=>envelope,
  authenticate:(context:unknown)=>Promise<typeof principal|undefined>=async()=>principal,enabled=true,maxOutputBytes?:number)=>{
  const authenticateMock=vi.fn(authenticate),readMock=vi.fn(readForPrincipal);
  const query=Object.fromEntries(["searchServices","readContract","readEndpoint","readSchema","compareContracts"]
    .map(key=>[key,vi.fn()])) as unknown as QueryReader;
  const server=createApiTruthMcpServer({query,authenticate:authenticateMock,...(enabled?
    {loadedDocumentVerification:{readForPrincipal:readMock} as never}:{}),...(maxOutputBytes===undefined?{}:{maxOutputBytes})});
  const client=new Client({name:"loaded-document-test",version:"1.0.0"});
  const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);await client.connect(clientTransport);opened.push({client,server});
  return {client,readForPrincipal:readMock,authenticate:authenticateMock};
};

test("advertises an optional bounded read-only metadata tool without caller identity fields",async()=>{
  const connection=await open(),listed=await connection.client.listTools();
  const tool=listed.tools.find(item=>item.name==="api_truth_get_loaded_document_verification");
  expect(tool).toBeDefined();expect(tool?.annotations).toMatchObject({readOnlyHint:true,destructiveHint:false,openWorldHint:false});
  expect(tool?.inputSchema).toMatchObject({additionalProperties:false});
  expect(JSON.stringify(tool?.inputSchema)).not.toMatch(/tenantId|principalId|credential|capabilities|artifactRef|keyRef/);
  expect(tool?.description).toMatch(/controlled/i);expect(tool?.description).toMatch(/non-normative/i);
  expect(tool?.description).toMatch(/does not assert deployment/i);
  const absent=await open(undefined,undefined,false);
  expect((await absent.client.listTools()).tools.some(item=>item.name==="api_truth_get_loaded_document_verification")).toBe(false);
});

test("anchors the exact current pin and opaque transport context to authenticated principal",async()=>{
  const {client,readForPrincipal,authenticate}=await open();
  const result=await client.callTool({name:"api_truth_get_loaded_document_verification",arguments:args});
  expect(result.isError).not.toBe(true);expect(result.structuredContent).toEqual({ok:true,data:envelope});
  expect(readForPrincipal).toHaveBeenCalledWith(authenticate.mock.calls[0]?.[0],principal,{loadIdentityDigest:args.loadIdentityDigest,
    expectedPin:{tenantId:principal.tenantId,repositoryId:args.repositoryId,serviceId:args.serviceId,
      environment:args.environment,snapshotId:args.snapshotId,revision:args.revision,
      configFingerprint:args.configFingerprint,checkpointVersion:args.checkpointVersion},
    configActivationCheckpoint:args.configActivationCheckpoint});
});

test("denied transport authentication never invokes the verifier reader",async()=>{
  const {client,readForPrincipal}=await open(undefined,vi.fn(async()=>undefined));
  expect((await client.callTool({name:"api_truth_get_loaded_document_verification",arguments:args})).structuredContent)
    .toEqual({ok:false,error:"NOT_AUTHORIZED"});
  expect(readForPrincipal).not.toHaveBeenCalled();
});

test("rejects missing, malformed, caller-injected, or qualified pins before invoking the reader",async()=>{
  const {client,readForPrincipal}=await open();
  for(const input of [{...args,tenantId:"foreign"},{...args,principalId:"foreign"},{...args,credential:"secret"},
    {...args,artifactRef:"private"},{...args,keyRef:"private"},{...args,selectedRevision:"b".repeat(40)},
    {...args,pointerVersion:"2"},{...args,configActivationCheckpoint:undefined},{...args,checkpointVersion:undefined},
    {...args,configFingerprint:"invalid"},{...args,revision:"short"},{...args,loadIdentityDigest:"invalid"},
    {...args,unexpected:true}]){
    expect((await client.callTool({name:"api_truth_get_loaded_document_verification",arguments:input})).isError).toBe(true);
  }
  expect(readForPrincipal).not.toHaveBeenCalled();
});

test("identifier grammar matches the reader and excludes unsupported punctuation",async()=>{
  const {client,readForPrincipal}=await open();
  const accepted={...args,repositoryId:"_repo",serviceId:".service",environment:"_test",snapshotId:".snapshot"};
  expect((await client.callTool({name:"api_truth_get_loaded_document_verification",arguments:accepted})).isError).not.toBe(true);
  expect(readForPrincipal).toHaveBeenCalledTimes(1);
  expect((await client.callTool({name:"api_truth_get_loaded_document_verification",arguments:{...accepted,serviceId:"service:bad"}})).isError)
    .toBe(true);
  expect(readForPrincipal).toHaveBeenCalledTimes(1);
});

test.each([["LOADED_DOCUMENT_READ_UNAUTHORIZED","NOT_FOUND_OR_DENIED"],
  ["LOADED_DOCUMENT_READ_STALE","STALE_SELECTION"],["INVALID_LOADED_DOCUMENT_READ_REQUEST","INVALID_REQUEST"],
  ["LOADED_DOCUMENT_READ_UNAVAILABLE","QUERY_UNAVAILABLE"],["LOADED_DOCUMENT_READ_STORAGE_ERROR","QUERY_UNAVAILABLE"]])
  ("maps and sanitizes loaded-document reader error %s",async(code,error)=>{
    const read=vi.fn(async()=>{throw Object.assign(new Error("PRIVATE_DB_OR_ARTIFACT_CANARY"),{code});});
    const {client}=await open(read);
    const result=await client.callTool({name:"api_truth_get_loaded_document_verification",arguments:args});
    expect(result.structuredContent).toEqual({ok:false,error});
    expect(JSON.stringify(result)).not.toContain("PRIVATE_DB_OR_ARTIFACT_CANARY");
  });

test("oversized metadata returns a fixed limit error without partial output",async()=>{
  const {client}=await open(async()=>({...envelope,limitations:Array.from({length:500},()=>"limited metadata ".repeat(40))}));
  const result=await client.callTool({name:"api_truth_get_loaded_document_verification",arguments:args});
  expect(result.structuredContent).toEqual({ok:false,error:"RESULT_TOO_LARGE"});
  expect(JSON.stringify(result)).not.toContain("limited metadata");
});

test("a hostile thrown proxy is not inspected for an error code",async()=>{
  let traps=0;const thrown=new Proxy({}, {getOwnPropertyDescriptor(){traps++;throw new Error("trap");}});
  const {client}=await open(async()=>{throw thrown;});
  const result=await client.callTool({name:"api_truth_get_loaded_document_verification",arguments:args});
  expect(result.structuredContent).toEqual({ok:false,error:"QUERY_UNAVAILABLE"});expect(traps).toBe(0);
});
