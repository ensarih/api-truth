import {once} from "node:events";
import {readFile} from "node:fs/promises";
import {expect,test} from "@playwright/test";
import {createPortalServer,type PortalOptions} from "../../apps/portal/src/server.js";
import type {ContractSnapshot} from "../../packages/ir/src/index.js";
import type {CorpusOperationSearchResult,QuerySelection} from "../../packages/query/src/index.js";

for(const qualified of [false,true])test(`cross-service candidates require an explicit pinned contract load before inference (${qualified?"qualified reuse":"original revision"})`,async({page})=>{
  const principal={tenantId:"tenant-browser-corpus",principalId:"reader"};
  const pin={snapshotId:"snapshot-browser-corpus",revision:"revision-browser-corpus",
    configFingerprint:"sha256:config-a",checkpointVersion:"7",
    ...(qualified?{selectedRevision:"b".repeat(40)}:{})};
  const {selectedRevision: omittedSelectedRevision,...evidenceOnlyPin}=pin;
  const selector:QuerySelection={version:"1",tenantId:principal.tenantId,repositoryId:"commerce",
    serviceId:"orders",selector:{kind:"environment",environment:"uat",expectedCheckpointVersion:"7"}};
  const snapshot=JSON.parse(await readFile(new URL("../fixtures/ir/express-snapshot.json",import.meta.url),
    "utf8")) as ContractSnapshot;
  snapshot.endpoints=[snapshot.endpoints[0]!];
  const endpointId=snapshot.endpoints[0]!.endpoint_id;
  const candidate:CorpusOperationSearchResult={status:"candidates",matchMode:"keyword",
    scope:"visible_authorized_services",environment:"uat",complete:false,truncated:false,
    incompleteReason:"incomplete_scan",candidates:[{repositoryId:"commerce",serviceId:"orders",
      endpointId,method:"GET",path:"/orders",label:"Read stored orders",score:8,
      evidenceIds:["ev-route"],selector,pin}]};
  const selections:unknown[]=[];
  let searchCalls=0,discoverCalls=0,releaseSearch:((value:CorpusOperationSearchResult)=>void)|undefined;
  let delaySearch=false,wrongPin=false,delayContractLoad=false;
  let releaseContractLoad:((value:Awaited<ReturnType<NonNullable<PortalOptions["query"]["readContract"]>>>)=>void)|undefined;
  const query:PortalOptions["query"]={
    searchServices:async()=>({services:[],truncated:false}),
    readContract:async(_principal,selection)=>{selections.push(selection);
      const resolved={status:"resolved" as const,selector:selection as QuerySelection,
        pin:wrongPin?(qualified?evidenceOnlyPin:{...pin,revision:"stale"}):pin,publication:{status:"absent" as const},snapshot};
      return delayContractLoad?new Promise(resolve=>{releaseContractLoad=resolve;}):resolved;},
    compareContracts:async()=>({status:"unavailable" as const,beforeStatus:"unknown" as const,
      afterStatus:"unknown" as const}),
    readPublication:async()=>{throw new Error("unused");},
    searchOperationCandidatesAcrossServices:async()=>{searchCalls++;
      return delaySearch?new Promise<CorpusOperationSearchResult>(resolve=>{releaseSearch=resolve;}):candidate;},
  };
  const server=createPortalServer({authenticate:async request=>
    request.headers.authorization==="Bearer corpus-browser"?principal:undefined,
  query,semantic:{discover:async()=>{discoverCalls++;return {status:"no_match" as const,
    reason:"none",verification:"inferred" as const,review:"unreviewed" as const,
    normative:false as const,provenance:{provider:"openai" as const,model:"synthetic",
      promptVersion:"semantic-discovery-source-1" as const,selector:selector.selector,pin}};}}});
  server.listen(0,"127.0.0.1");await once(server,"listening");
  const address=server.address();if(!address||typeof address==="string")throw new Error();
  await page.setExtraHTTPHeaders({authorization:"Bearer corpus-browser"});
  try{
    await page.goto(`http://127.0.0.1:${address.port}/`);
    await page.locator('#corpus input[name="environment"]').fill("uat");
    await page.locator('#corpus textarea[name="intentQuery"]').fill("read stored orders");
    await page.getByRole("button",{name:"Search across services"}).click();
    await expect(page.locator("#corpus-status")).toContainText("incomplete");
    await expect(page.locator("#corpus-results")).toContainText("commerce / orders");
    await expect(page.locator("#corpus-results")).toContainText("checkpoint 7");
    expect(searchCalls).toBe(1);expect(discoverCalls).toBe(0);expect(selections).toHaveLength(0);
    await page.getByRole("button",{name:"Load pinned contract"}).click();
    await expect(page.locator("#contract-status")).toContainText("Contract available");
    expect(selections[0]).toMatchObject({repositoryId:"commerce",serviceId:"orders",
      selector:{kind:"environment",environment:"uat",expectedCheckpointVersion:"7"}});
    expect(discoverCalls).toBe(0);
    if(qualified){
      await expect(page.locator("#contract-summary")).toContainText("Selected revision: "+"b".repeat(40));
      await expect(page.locator("#contract-summary")).toContainText("Evidence from revision: revision-browser-corpus");
    }
    await expect(page.locator('#discovery input[name="endpointId"]:checked')).toHaveCount(0);
    delaySearch=true;
    await page.getByRole("button",{name:"Search across services"}).click();
    await expect(page.locator("#corpus-status")).toContainText("Searching");
    await page.locator('#corpus textarea[name="intentQuery"]').fill("other intent");
    releaseSearch?.(candidate);
    await expect(page.locator("#corpus-results")).toBeEmpty();
    await expect(page.locator("#corpus-status")).toContainText("changed");
    delaySearch=false;wrongPin=true;
    await page.getByRole("button",{name:"Search across services"}).click();
    await expect(page.locator("#corpus-results")).toContainText("commerce / orders");
    await page.getByRole("button",{name:"Load pinned contract"}).click();
    await expect(page.locator("#contract-status")).toContainText("stale");
    expect(discoverCalls).toBe(0);
    wrongPin=false;delayContractLoad=true;
    await page.getByRole("button",{name:"Search across services"}).click();
    await expect(page.locator("#corpus-results")).toContainText("commerce / orders");
    await page.getByRole("button",{name:"Load pinned contract"}).click();
    await expect(page.locator("#contract-status")).toContainText("Loading");
    await page.locator('#corpus textarea[name="intentQuery"]').fill("newer search intent");
    releaseContractLoad?.({status:"resolved",selector,pin,publication:{status:"absent"},snapshot});
    await expect(page.locator("#contract-status")).toContainText("Pinned candidate is stale");
    await expect(page.locator("#contract-summary")).toBeEmpty();
    expect(discoverCalls).toBe(0);
  }finally{server.closeAllConnections();server.close();await once(server,"close");}
});
