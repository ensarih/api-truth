import {once} from "node:events";
import {afterEach,expect,test,vi} from "vitest";
import {Client,InMemoryTransport} from "@modelcontextprotocol/client";
import {createApiTruthMcpServer} from "../../apps/mcp/src/server.js";
import {createPortalServer,type PortalOptions} from "../../apps/portal/src/server.js";
import type {QueryReader,QuerySelection} from "../../packages/query/src/index.js";
import type {SyntheticExampleResult} from "../../packages/observations/src/examples.js";
import type {createSyntheticExampleService} from "../../packages/observations/src/example-service.js";

const principal={tenantId:"tenant-a",principalId:"reader-a"};
const input={repositoryId:"commerce",serviceId:"orders",environment:"uat",
  expectedCheckpointVersion:"7",policyId:"create-order"};
const selected:QuerySelection={version:"1",tenantId:"tenant-a",repositoryId:"commerce",serviceId:"orders",
  selector:{kind:"environment",environment:"uat",expectedCheckpointVersion:"7"}};
const generated={status:"generated",kind:"synthetic_example",nonNormative:true,
  policyVersion:"synthetic-examples-1",scope:{tenantId:"tenant-a",repositoryId:"commerce",
    serviceId:"orders",environment:"uat",checkpointVersion:"7",revision:"rev-a",snapshotId:"snapshot-a",
    sourceDigest:"sha256:source",configFingerprint:"config-a",endpointId:"ep-get",direction:"response",
    statusCode:200,mediaType:"application/json"},fingerprints:{schemaSha256:"sha256:schema",policySha256:"sha256:policy"},
    value:{id:"string"},diagnostics:[]} satisfies SyntheticExampleResult;
const query={readContract:vi.fn(),readEndpoint:vi.fn(),readSchema:vi.fn(),compareContracts:vi.fn(),
  searchServices:vi.fn(),readPublication:vi.fn()} as unknown as QueryReader;
const opened:Array<{client:Client;server:ReturnType<typeof createApiTruthMcpServer>}> = [];
afterEach(async()=>Promise.allSettled(opened.splice(0).flatMap(({client,server})=>[client.close(),server.close()])));
const connect=async(examples?:Pick<ReturnType<typeof createSyntheticExampleService>,"generate">)=>{
  const server=createApiTruthMcpServer({query,authenticate:async()=>principal,...(examples?{examples}:{})});
  const client=new Client({name:"example-test",version:"1.0"});
  const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);await client.connect(clientTransport);opened.push({client,server});return client;
};

test("MCP registers an optional closed-world, read-only synthetic example tool with authenticated scope",async()=>{
  const generate=vi.fn(async():Promise<SyntheticExampleResult>=>generated);
  const client=await connect({generate});
  const tool=(await client.listTools()).tools.find(item=>item.name==="api_truth_get_synthetic_example");
  expect(tool).toBeDefined();
  expect(tool!.annotations).toMatchObject({readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false});
  expect(JSON.stringify(tool!.inputSchema)).not.toMatch(/tenantId|principalId|propertyPaths/);
  const result=await client.callTool({name:"api_truth_get_synthetic_example",arguments:input});
  expect(result.structuredContent).toMatchObject({ok:true,data:{status:"generated",nonNormative:true,value:{id:"string"}}});
  expect(generate).toHaveBeenCalledWith(principal,{selection:selected,policyId:"create-order"});
  for(const bad of [{...input,propertyPaths:["/private"]},{...input,tenantId:"other"},
    {...input,expectedCheckpointVersion:undefined},{...input,policyId:"/private"},
    {...input,environment:"x".repeat(513)}]){
    const rejected=await client.callTool({name:"api_truth_get_synthetic_example",arguments:bad});
    expect(rejected.isError).toBe(true);
  }
  expect(generate).toHaveBeenCalledOnce();
  generate.mockRejectedValueOnce(Object.assign(new Error("CANARY_SECRET"),{code:"EXAMPLE_STALE_CONTEXT"}));
  expect((await client.callTool({name:"api_truth_get_synthetic_example",arguments:input})).structuredContent)
    .toEqual({ok:false,error:"STALE_SELECTION"});
  generate.mockResolvedValueOnce({...generated,value:{large:"x".repeat(70_000)}});
  expect((await client.callTool({name:"api_truth_get_synthetic_example",arguments:input})).structuredContent)
    .toEqual({ok:false,error:"RESULT_TOO_LARGE"});
});

test("MCP leaves the tool unregistered when examples are absent",async()=>{
  const client=await connect();
  expect((await client.listTools()).tools.map(tool=>tool.name)).not.toContain("api_truth_get_synthetic_example");
});

test("portal accepts only bounded, pinned environment example requests and maps fixed errors",async()=>{
  const generate=vi.fn(async():Promise<SyntheticExampleResult>=>generated);
  const portalQuery:PortalOptions["query"]={searchServices:async()=>({services:[],truncated:false}),
    readContract:async(_context,selection)=>({status:"unknown",selector:selection as QuerySelection}),
    compareContracts:async()=>({status:"unavailable",beforeStatus:"unknown",afterStatus:"unknown"}),
    readPublication:async()=>{throw Error("unused");}};
  const server=createPortalServer({query:portalQuery,authenticate:async request=>
    request.headers.authorization==="Bearer test"?principal:undefined,examples:{generate}});
  server.listen(0,"127.0.0.1");await once(server,"listening");
  const address=server.address();if(!address||typeof address==="string")throw Error("missing port");
  const base=`http://127.0.0.1:${address.port}`;
  const post=(body:string,type="application/json")=>fetch(`${base}/api/examples`,{method:"POST",
    headers:{authorization:"Bearer test","content-type":type},body});
  try{
    const response=await post(JSON.stringify(input));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({status:"generated",kind:"synthetic_example",nonNormative:true});
    expect(generate).toHaveBeenCalledWith(principal,{selection:selected,policyId:"create-order"});
    for(const body of [JSON.stringify({...input,propertyPaths:["/private"]}),
      JSON.stringify({...input,tenantId:"other"}),JSON.stringify({...input,expectedCheckpointVersion:null}),
      JSON.stringify({...input,policyId:"/private"}),"{"+"\"x\":".repeat(12)+"0"+"}",
      "x".repeat(8193)])expect((await post(body)).status).toBe(400);
    expect((await post(JSON.stringify(input),"text/plain")).status).toBe(400);
    expect((await fetch(`${base}/api/examples?policyId=private`,{headers:{authorization:"Bearer test"}})).status).toBe(400);
    expect((await fetch(`${base}/api/examples`,{method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify(input)})).status).toBe(401);
    expect(generate).toHaveBeenCalledOnce();
    generate.mockRejectedValueOnce(Object.assign(new Error("CANARY_SECRET"),{code:"EXAMPLE_STALE_CONTEXT"}));
    expect((await post(JSON.stringify(input))).status).toBe(409);
    generate.mockRejectedValueOnce(Object.assign(new Error("CANARY_SECRET"),{code:"EXAMPLE_NOT_FOUND_OR_DENIED"}));
    expect((await post(JSON.stringify(input))).status).toBe(404);
    generate.mockRejectedValueOnce(Object.assign(new Error("CANARY_SECRET"),{code:"EXAMPLE_STORAGE_ERROR"}));
    const unavailable=await post(JSON.stringify(input));
    expect(unavailable.status).toBe(503);
    expect(await unavailable.text()).not.toContain("CANARY_SECRET");
    generate.mockResolvedValueOnce({...generated,value:{large:"x".repeat(1_000_100)}});
    expect((await post(JSON.stringify(input))).status).toBe(422);
  }finally{server.closeAllConnections();server.close();await once(server,"close");}
});

test("portal returns 404 when the optional example service is absent",async()=>{
  const portalQuery:PortalOptions["query"]={searchServices:async()=>({services:[],truncated:false}),
    readContract:async(_context,selection)=>({status:"unknown",selector:selection as QuerySelection}),
    compareContracts:async()=>({status:"unavailable",beforeStatus:"unknown",afterStatus:"unknown"}),
    readPublication:async()=>{throw Error("unused");}};
  const server=createPortalServer({query:portalQuery,authenticate:async()=>principal});
  server.listen(0,"127.0.0.1");await once(server,"listening");
  const address=server.address();if(!address||typeof address==="string")throw Error("missing port");
  try{expect((await fetch(`http://127.0.0.1:${address.port}/api/examples`,{method:"POST",
    headers:{"content-type":"application/json"},body:JSON.stringify(input)})).status).toBe(404);}
  finally{server.closeAllConnections();server.close();await once(server,"close");}
});
