import {afterEach,expect,test,vi} from "vitest";
import {Client,InMemoryTransport} from "@modelcontextprotocol/client";
import {createApiTruthMcpServer} from "../../apps/mcp/src/server.js";
import type {QueryReader} from "../../packages/query/src/index.js";

const principal={tenantId:"tenant-a",principalId:"reader-a"};
const args={repositoryId:"commerce",serviceId:"orders",environment:"uat",snapshotId:"snapshot-a",revision:"revision-a",
  configFingerprint:"sha256:"+"c".repeat(64),checkpointVersion:"7",policyId:"order-fields",ownerPolicyRevision:"2",limit:20};
const envelope={status:"resolved",kind:"observed_field_presence",nonNormative:true,
  pin:{tenantId:principal.tenantId,repositoryId:args.repositoryId,serviceId:args.serviceId,environment:args.environment,
    snapshotId:args.snapshotId,revision:args.revision,configFingerprint:args.configFingerprint,
    checkpointVersion:args.checkpointVersion,sourceDigest:"sha256:"+"d".repeat(64)},
  policy:{policyId:args.policyId,ownerPolicyRevision:args.ownerPolicyRevision,policyFingerprint:"sha256:"+"e".repeat(64),
    configActivationCheckpoint:"3",endpointId:"endpoint-a",direction:"request",mediaType:"application/json",propertyPaths:["/id"]},
  records:[],truncated:false};
const opened:Array<{client:Client;server:ReturnType<typeof createApiTruthMcpServer>}>=[];
afterEach(async()=>{await Promise.allSettled(opened.splice(0).flatMap(({client,server})=>[client.close(),server.close()]));});
const open=async(readForPrincipal:(...args:unknown[])=>Promise<unknown>=async()=>envelope,
  authenticate:(context:unknown)=>Promise<typeof principal|undefined>=async()=>principal,enabled=true)=>{
  const authenticateMock=vi.fn(authenticate),readMock=vi.fn(readForPrincipal);
  const query=Object.fromEntries(["searchServices","readContract","readEndpoint","readSchema","compareContracts"]
    .map(key=>[key,vi.fn()])) as unknown as QueryReader;
  const server=createApiTruthMcpServer({query,authenticate:authenticateMock,...(enabled?{presence:{readForPrincipal:readMock} as never}:{})});
  const client=new Client({name:"presence-test",version:"1.0.0"});
  const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);await client.connect(clientTransport);opened.push({client,server});
  return {client,readForPrincipal:readMock,authenticate:authenticateMock};
};

test("advertises optional bounded read-only presence with no credentials or identities in arguments",async()=>{
  const connection=await open(),listed=await connection.client.listTools();
  const tool=listed.tools.find(item=>item.name==="api_truth_get_field_presence");
  expect(tool).toBeDefined();expect(tool?.annotations).toMatchObject({readOnlyHint:true,destructiveHint:false,openWorldHint:false});
  expect(tool?.inputSchema).toMatchObject({additionalProperties:false});
  expect(JSON.stringify(tool?.inputSchema)).not.toMatch(/tenantId|principalId|credential|capabilities|accessScope/);
  const absent=await open(undefined,undefined,false);
  expect((await absent.client.listTools()).tools.some(item=>item.name==="api_truth_get_field_presence")).toBe(false);
});

test("binds opaque transport context and authenticated principal to the exact requested environment pin",async()=>{
  const {client,readForPrincipal,authenticate}=await open();
  const result=await client.callTool({name:"api_truth_get_field_presence",arguments:args});
  expect(result.isError).not.toBe(true);expect(result.structuredContent).toEqual({ok:true,data:envelope});
  expect(readForPrincipal).toHaveBeenCalledWith(authenticate.mock.calls[0]?.[0],principal,{policyId:args.policyId,
    ownerPolicyRevision:args.ownerPolicyRevision,limit:args.limit,expectedPin:{tenantId:principal.tenantId,
      repositoryId:args.repositoryId,serviceId:args.serviceId,environment:args.environment,snapshotId:args.snapshotId,
      revision:args.revision,configFingerprint:args.configFingerprint,checkpointVersion:args.checkpointVersion}});
});

test("denied transport authentication never invokes presence authorization or storage",async()=>{
  const {client,readForPrincipal}=await open(undefined,vi.fn(async()=>undefined));
  expect((await client.callTool({name:"api_truth_get_field_presence",arguments:args})).structuredContent)
    .toEqual({ok:false,error:"NOT_AUTHORIZED"});
  expect(readForPrincipal).not.toHaveBeenCalled();
});

test("rejects caller identities, qualification, missing pins and out-of-range limits before invoking the reader",async()=>{
  const {client,readForPrincipal}=await open();
  for(const input of [{...args,tenantId:"foreign"},{...args,credential:"secret"},{...args,selectedRevision:"other"},
    {...args,pointerVersion:"3"},{...args,checkpointVersion:undefined},{...args,limit:101},{...args,configFingerprint:"invalid"}]){
    const result=await client.callTool({name:"api_truth_get_field_presence",arguments:input});
    expect(result.isError).toBe(true);
  }
  expect(readForPrincipal).not.toHaveBeenCalled();
});

test.each([["FIELD_PRESENCE_QUERY_UNAUTHORIZED","NOT_FOUND_OR_DENIED"],
  ["FIELD_PRESENCE_QUERY_STALE","STALE_SELECTION"],["FIELD_PRESENCE_QUERY_INVALID_REQUEST","INVALID_REQUEST"],
  ["FIELD_PRESENCE_QUERY_STORAGE_ERROR","QUERY_UNAVAILABLE"]])("sanitizes presence failure %s",async(code,error)=>{
  const read=vi.fn(async()=>{throw Object.assign(new Error("PRIVATE_DATABASE_CANARY"),{code});});
  const {client}=await open(read);
  const result=await client.callTool({name:"api_truth_get_field_presence",arguments:args});
  expect(result.structuredContent).toEqual({ok:false,error});expect(JSON.stringify(result)).not.toContain("PRIVATE_DATABASE_CANARY");
});

test("oversized presence output returns a fixed limit error without partial data",async()=>{
  const {client}=await open(async()=>({...envelope,records:[{marker:"PRIVATE_CANARY".repeat(10_000)}]}));
  const result=await client.callTool({name:"api_truth_get_field_presence",arguments:args});
  expect(result.structuredContent).toEqual({ok:false,error:"RESULT_TOO_LARGE"});
  expect(JSON.stringify(result)).not.toContain("PRIVATE_CANARY");
});
