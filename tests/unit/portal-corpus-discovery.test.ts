import {once} from "node:events";
import {expect,test,vi} from "vitest";
import {createPortalServer} from "../../apps/portal/src/server.js";
import type {QueryReader} from "../../packages/query/src/index.js";

const baseQuery:Pick<QueryReader,"searchServices"|"readContract"|"compareContracts"|"readPublication">={
  searchServices:vi.fn(async()=>({services:[],truncated:false as const})),
  readContract:vi.fn(async()=>{throw new Error("unused");}),
  compareContracts:vi.fn(async()=>{throw new Error("unused");}),
  readPublication:vi.fn(async()=>{throw new Error("unused");}),
};
const request=(base:string,body:unknown)=>fetch(`${base}/api/corpus-discover`,{method:"POST",
  headers:{"content-type":"application/json",authorization:"Bearer fixture"},body:JSON.stringify(body)});

test("portal exposes bounded corpus inference only when configured and injects host principal",async()=>{
  const discoverAcrossServices=vi.fn(async()=>({status:"groups" as const,environment:"uat",scope:"keyword_candidates" as const,verification:"inferred" as const,
    review:"unreviewed" as const,normative:false as const,shortlistCoverage:{complete:true,truncated:false},groups:[]}));
  const server=createPortalServer({authenticate:async(request)=>request.headers.authorization==="Bearer fixture"
    ?{tenantId:"tenant-a",principalId:"reader-a"}:undefined,query:baseQuery,
    corpusSemantic:{discoverAcrossServices}});
  server.listen(0,"127.0.0.1");await once(server,"listening");
  try{const address=server.address();if(!address||typeof address==="string")throw new Error("no address");const base=`http://127.0.0.1:${address.port}`;
    const response=await request(base,{environment:"uat",intentQuery:"find an order",limit:8});
    expect(response.status).toBe(200);expect(await response.json()).toMatchObject({status:"groups",normative:false});
    expect(discoverAcrossServices).toHaveBeenCalledWith({tenantId:"tenant-a",principalId:"reader-a"},
      {environment:"uat",intentQuery:"find an order",limit:8});
    const bad=await request(base,{environment:"uat",intentQuery:"find an order",limit:17,tenantId:"other"});
    expect(bad.status).toBe(400);
    const missingLimit=await request(base,{environment:"uat",intentQuery:"find an order"});
    expect(missingLimit.status).toBe(400);expect(discoverAcrossServices).toHaveBeenCalledOnce();
    const denied=await fetch(`${base}/api/corpus-discover`,{method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify({environment:"uat",intentQuery:"find an order",limit:8})});
    expect(denied.status).toBe(401);expect(discoverAcrossServices).toHaveBeenCalledOnce();
  }finally{server.closeAllConnections();server.close();await once(server,"close");}
});

test("portal does not expose corpus inference when no host capability is configured",async()=>{
  const server=createPortalServer({authenticate:async()=>({tenantId:"tenant-a",principalId:"reader-a"}),query:baseQuery});
  server.listen(0,"127.0.0.1");await once(server,"listening");
  try{const address=server.address();if(!address||typeof address==="string")throw new Error("no address");
    const response=await request(`http://127.0.0.1:${address.port}`,{environment:"uat",intentQuery:"find an order",limit:8});
    expect(response.status).toBe(404);
  }finally{server.closeAllConnections();server.close();await once(server,"close");}
});

test("portal maps corpus provider failures to fixed responses",async()=>{
  const discoverAcrossServices=vi.fn(async()=>{throw Object.assign(new Error("private-provider-marker"),
    {code:"SEMANTIC_CORPUS_UNAVAILABLE"});});
  const server=createPortalServer({authenticate:async()=>({tenantId:"tenant-a",principalId:"reader-a"}),query:baseQuery,
    corpusSemantic:{discoverAcrossServices}});
  server.listen(0,"127.0.0.1");await once(server,"listening");
  try{const address=server.address();if(!address||typeof address==="string")throw new Error("no address");
    const response=await request(`http://127.0.0.1:${address.port}`,{environment:"uat",intentQuery:"find an order",limit:8});
    expect(response.status).toBe(503);const body=await response.text();expect(body).toBe('{"error":"SEMANTIC_UNAVAILABLE"}');
    expect(body).not.toContain("private-provider-marker");
  }finally{server.closeAllConnections();server.close();await once(server,"close");}
});
