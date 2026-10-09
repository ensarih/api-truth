import {once} from "node:events";
import {afterEach,expect,test,vi} from "vitest";
import {Client,InMemoryTransport} from "@modelcontextprotocol/client";
import {createApiTruthMcpServer} from "../../apps/mcp/src/server.js";
import {createPortalServer} from "../../apps/portal/src/server.js";
import type {CorpusOperationSearchResult,QueryReader,QueryCorpusOperationReader} from "../../packages/query/src/index.js";

const principal={tenantId:"tenant-corpus",principalId:"reader"};
const pin={snapshotId:"snapshot-orders",revision:"revision-orders",configFingerprint:"sha256:config-a",
  checkpointVersion:"7"};
const selector={version:"1" as const,tenantId:principal.tenantId,repositoryId:"commerce",serviceId:"orders",
  selector:{kind:"environment" as const,environment:"uat",expectedCheckpointVersion:"7"}};
const result:Extract<CorpusOperationSearchResult,{status:"candidates"}>={status:"candidates",matchMode:"keyword",
  scope:"visible_authorized_services",environment:"uat",complete:false,truncated:false,
  incompleteReason:"incomplete_scan",candidates:[{repositoryId:"commerce",serviceId:"orders",
    endpointId:"ep-get",method:"GET",path:"/orders",label:"Read orders",score:8,
    evidenceIds:["ev-route"],selector,pin}]};
const query=()=>{
  const searchOperationCandidatesAcrossServices=vi.fn(async(_context:unknown,_request:unknown)=>result);
  return {searchServices:vi.fn(async()=>({services:[],truncated:false})),
    readContract:vi.fn(),readEndpoint:vi.fn(),readSchema:vi.fn(),compareContracts:vi.fn(),readPublication:vi.fn(),
    searchOperationCandidatesAcrossServices} as unknown as QueryReader & QueryCorpusOperationReader
      &{searchOperationCandidatesAcrossServices:typeof searchOperationCandidatesAcrossServices};
};
const opened:Array<{client:Client;server:ReturnType<typeof createApiTruthMcpServer>}>=[];
afterEach(async()=>{await Promise.allSettled(opened.splice(0).flatMap(({client,server})=>[client.close(),server.close()]));});

test("MCP corpus tool is optional, authenticated, lexical and has no caller principal",async()=>{
  const reader=query();
  const server=createApiTruthMcpServer({query:reader,authenticate:async()=>principal});
  const client=new Client({name:"corpus-contract",version:"1"});
  const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(b);await client.connect(a);
  opened.push({client,server});
  const tool=(await client.listTools()).tools.find(item=>item.name==="api_truth_search_api_corpus")!;
  expect(tool).toBeDefined();
  expect(tool.annotations).toMatchObject({readOnlyHint:true,idempotentHint:true,openWorldHint:false});
  expect(JSON.stringify(tool.inputSchema)).not.toMatch(/tenantId|principalId|repositoryId|serviceId/);
  const args={environment:"uat",intentQuery:"read orders",maxResults:3};
  expect((await client.callTool({name:tool.name,arguments:args})).structuredContent)
    .toEqual({ok:true,data:result});
  expect(reader.searchOperationCandidatesAcrossServices).toHaveBeenCalledWith(principal,
    {tenantId:principal.tenantId,environment:"uat",intentQuery:"read orders",limit:3});
  for(const invalid of [{...args,tenantId:"other"},{...args,environment:""},
    {...args,maxResults:21},{...args,intentQuery:"Bearer CANARY_SECRET"}])
    expect((await client.callTool({name:tool.name,arguments:invalid})).isError).toBe(true);
  expect(reader.searchOperationCandidatesAcrossServices).toHaveBeenCalledTimes(1);
  vi.mocked(reader.searchOperationCandidatesAcrossServices).mockRejectedValueOnce(
    new Error("CANARY_PRIVATE_QUERY"));
  const failed=await client.callTool({name:tool.name,arguments:args});
  expect(failed.structuredContent).toEqual({ok:false,error:"QUERY_UNAVAILABLE"});
  expect(JSON.stringify(failed)).not.toContain("CANARY_PRIVATE_QUERY");
  const absent=createApiTruthMcpServer({query:{...reader,
    searchOperationCandidatesAcrossServices:undefined} as unknown as QueryReader,authenticate:async()=>principal});
  const absentClient=new Client({name:"corpus-absent",version:"1"});
  const [c,d]=InMemoryTransport.createLinkedPair();await absent.connect(d);await absentClient.connect(c);
  opened.push({client:absentClient,server:absent});
  expect((await absentClient.listTools()).tools.some(item=>item.name===tool.name)).toBe(false);
});

test("portal corpus POST is strict, bounded, private and optional",async()=>{
  const reader=query();
  const server=createPortalServer({query:reader,authenticate:async request=>
    request.headers.authorization==="Bearer test"?principal:undefined});
  server.listen(0,"127.0.0.1");await once(server,"listening");
  const address=server.address();if(!address||typeof address==="string")throw new Error();
  const base=`http://127.0.0.1:${address.port}`;
  const body={environment:"uat",intentQuery:"read orders",limit:3};
  const post=(value:string)=>fetch(`${base}/api/corpus-candidates`,{method:"POST",
    headers:{authorization:"Bearer test","content-type":"application/json"},body:value});
  try{
    const response=await post(JSON.stringify(body));expect(response.status).toBe(200);
    expect(await response.json()).toEqual(result);
    expect(reader.searchOperationCandidatesAcrossServices).toHaveBeenCalledWith(principal,
      {tenantId:principal.tenantId,...body});
    expect((await fetch(`${base}/api/corpus-candidates?intentQuery=secret`,
      {headers:{authorization:"Bearer test"}})).status).toBeGreaterThanOrEqual(400);
    for(const invalid of [{...body,tenantId:"other"},{...body,repositoryId:"commerce"},
      {...body,limit:21},{...body,intentQuery:"Bearer CANARY_SECRET"}])
      expect((await post(JSON.stringify(invalid))).status).toBe(400);
    expect((await post('{"environment":"uat","intentQuery":"a","intentQuery":"b"}')).status).toBe(400);
    const oversized=await post("x".repeat(8193));expect(oversized.status).toBe(400);
    expect(oversized.headers.get("connection")).toBe("close");
    expect(reader.searchOperationCandidatesAcrossServices).toHaveBeenCalledTimes(1);
    vi.mocked(reader.searchOperationCandidatesAcrossServices).mockResolvedValueOnce({...result,
      candidates:[{...result.candidates[0]!,pin:{...pin,checkpointVersion:"8"}}]});
    expect((await post(JSON.stringify(body))).status).toBe(409);
    vi.mocked(reader.searchOperationCandidatesAcrossServices).mockResolvedValueOnce({...result,
      candidates:[{...result.candidates[0]!,selector:{...selector,tenantId:"other"}}]});
    expect((await post(JSON.stringify(body))).status).toBe(409);
    const unauthorized=await fetch(`${base}/api/corpus-candidates`,{method:"POST",
      headers:{"content-type":"application/json"},body:JSON.stringify(body)});
    expect(unauthorized.status).toBe(401);
  }finally{server.closeAllConnections();server.close();await once(server,"close");}
});

test("portal hides corpus search when the host omits the capability",async()=>{
  const reader=query();
  const {searchOperationCandidatesAcrossServices:_unused,...withoutCorpus}=reader;
  const server=createPortalServer({query:withoutCorpus,authenticate:async()=>principal});
  server.listen(0,"127.0.0.1");await once(server,"listening");
  const address=server.address();if(!address||typeof address==="string")throw new Error();
  const base=`http://127.0.0.1:${address.port}`;
  try{
    expect(await(await fetch(`${base}/app.js`)).text()).toContain("corpusEnabled=false");
    const response=await fetch(`${base}/api/corpus-candidates`,{method:"POST",
      headers:{"content-type":"application/json"},body:"{}"});
    expect(response.status).toBe(404);
    expect(reader.searchOperationCandidatesAcrossServices).not.toHaveBeenCalled();
  }finally{server.closeAllConnections();server.close();await once(server,"close");}
});
