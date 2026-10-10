import {afterEach,expect,test,vi} from "vitest";
import {Client,InMemoryTransport} from "@modelcontextprotocol/client";
import type {QueryReader} from "../../packages/query/src/index.js";
import {createApiTruthMcpServer} from "../../apps/mcp/src/server.js";

const query:QueryReader={searchServices:vi.fn(async()=>({services:[],truncated:false as const})),
  readContract:vi.fn(async()=>({status:"unavailable" as const,selector:{version:"1" as const,tenantId:"tenant-a",repositoryId:"r",serviceId:"s",selector:{kind:"revision" as const,revision:"rev"}}})),
  readEndpoint:vi.fn(async()=>{throw new Error("unused");}),readSchema:vi.fn(async()=>{throw new Error("unused");}),
  compareContracts:vi.fn(async()=>{throw new Error("unused");}),readPublication:vi.fn(async()=>{throw new Error("unused");})};
const discoverAcrossServices=vi.fn(async()=>({status:"groups" as const,environment:"uat",scope:"keyword_candidates" as const,verification:"inferred" as const,
  review:"unreviewed" as const,normative:false as const,shortlistCoverage:{complete:true,truncated:false},groups:[]}));
const opened:Array<{client:Client;server:ReturnType<typeof createApiTruthMcpServer>}>=[];
afterEach(async()=>{await Promise.allSettled(opened.splice(0).flatMap(({client,server})=>[client.close(),server.close()]));});

const connect=async(enabled:boolean)=>{const server=createApiTruthMcpServer({query,
  authenticate:vi.fn(async()=>({tenantId:"tenant-a",principalId:"reader-a"})),
  ...(enabled?{corpusSemantic:{discoverAcrossServices}}:{})});
  const client=new Client({name:"corpus-test",version:"1"});const [ct,st]=InMemoryTransport.createLinkedPair();
  await server.connect(st);await client.connect(ct);opened.push({client,server});return client;};

test("MCP registers optional cross-service discovery with external inference annotations",async()=>{
  const client=await connect(true),listed=await client.listTools(),tool=listed.tools.find(item=>item.name==="api_truth_discover_api_corpus");
  expect(tool).toBeDefined();expect(tool?.annotations).toMatchObject({readOnlyHint:true,idempotentHint:false,openWorldHint:true});
  expect(tool?.inputSchema).toMatchObject({additionalProperties:false});
  const result=await client.callTool({name:"api_truth_discover_api_corpus",arguments:{environment:"uat",intentQuery:"find an order",limit:8}});
  expect(result.isError).not.toBe(true);expect(result.structuredContent).toMatchObject({ok:true,data:{status:"groups",normative:false}});
  expect(discoverAcrossServices).toHaveBeenCalledWith({tenantId:"tenant-a",principalId:"reader-a"},
    {environment:"uat",intentQuery:"find an order",limit:8});
  const invalid=await client.callTool({name:"api_truth_discover_api_corpus",arguments:{environment:"uat",intentQuery:"x",limit:17}});
  expect(invalid.isError).toBe(true);expect(discoverAcrossServices).toHaveBeenCalledOnce();
  discoverAcrossServices.mockRejectedValue(new Error("private-provider-marker"));
  const failed=await client.callTool({name:"api_truth_discover_api_corpus",arguments:{environment:"uat",intentQuery:"find an order",limit:8}});
  expect(failed).toMatchObject({isError:true,structuredContent:{ok:false,error:"QUERY_UNAVAILABLE"}});
  expect(JSON.stringify(failed)).not.toContain("private-provider-marker");
});

test("MCP does not register cross-service inference without the optional host capability",async()=>{
  const client=await connect(false);expect((await client.listTools()).tools.map(tool=>tool.name)).not.toContain("api_truth_discover_api_corpus");
});
