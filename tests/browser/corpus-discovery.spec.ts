import {once} from "node:events";
import {readFile} from "node:fs/promises";
import {expect,test} from "@playwright/test";
import {createPortalServer,type PortalOptions} from "../../apps/portal/src/server.js";
import type {ContractSnapshot} from "../../packages/ir/src/index.js";
import type {SemanticCorpusDiscoveryResult} from "../../packages/semantics/src/index.js";

const context={tenantId:"tenant-browser",principalId:"reader"};
const groups=():Extract<SemanticCorpusDiscoveryResult,{status:"groups"}>=>({status:"groups",environment:"uat",scope:"keyword_candidates",
  verification:"inferred",review:"unreviewed",normative:false,shortlistCoverage:{complete:false,truncated:true,incompleteReason:"incomplete_scan"},
  groups:["orders","billing"].map((serviceId,index)=>{
    const selector={version:"1" as const,tenantId:context.tenantId,repositoryId:"commerce",serviceId,
      selector:{kind:"environment" as const,environment:"uat",expectedCheckpointVersion:String(7+index)}};
    const pin={snapshotId:`snapshot-${serviceId}`,revision:`revision-${serviceId}`,configFingerprint:"sha256:config-a",checkpointVersion:String(7+index)};
    return {repositoryId:"commerce",serviceId,selector,pin,candidates:[{repositoryId:"commerce",serviceId,selector,pin,
      endpointId:"endpoint-shared",method:"GET",path:`/${serviceId}`,label:"Read records",evidenceIds:[`ev-${serviceId}`],score:3}],
      result:{status:"suggestions" as const,verification:"inferred" as const,review:"unreviewed" as const,normative:false as const,
        suggestions:[{endpointId:"endpoint-shared",intent:"Read records",summary:"Candidate <script>unsafe()</script>",evidenceIds:[`ev-${serviceId}`]}],
        provenance:{provider:"openai" as const,model:"synthetic",promptVersion:"semantic-discovery-1" as const,selector:selector.selector,pin},
        contextCoverage:{status:"complete" as const,requestedEndpointIds:["endpoint-shared"],analyzedEndpointIds:["endpoint-shared"],omittedEndpointIds:[]}}};
  })});

test("cross-service inference is explicit, namespaced, pin checked and ignores late answers",async({page})=>{
  const snapshot=JSON.parse(await readFile(new URL("../fixtures/ir/express-snapshot.json",import.meta.url),"utf8")) as ContractSnapshot;
  snapshot.endpoints=[snapshot.endpoints[0]!];snapshot.endpoints[0]!.endpoint_id="endpoint-shared";
  let result:SemanticCorpusDiscoveryResult=groups(),delayed=false,wrongPin=false;
  let release:((value:SemanticCorpusDiscoveryResult)=>void)|undefined;
  const calls:unknown[]=[];const selections:unknown[]=[];
  const query:PortalOptions["query"]={searchServices:async()=>({services:[],truncated:false}),
    readContract:async(_context,selection)=>{selections.push(selection);const group=groups().groups[0]!;
      return {status:"resolved",selector:selection as typeof group.selector,pin:wrongPin?{...group.pin,revision:"changed"}:group.pin,snapshot,publication:{status:"absent"}};},
    compareContracts:async()=>({status:"unavailable",beforeStatus:"unknown",afterStatus:"unknown"}),readPublication:async()=>{throw Error("unused");}};
  const server=createPortalServer({environments:async()=>["uat","staging"],query,authenticate:async()=>context,corpusSemantic:{discoverAcrossServices:async(principal,request)=>{
    expect(principal).toEqual(context);calls.push(request);return delayed?new Promise(resolve=>{release=resolve;}):result;}}});
  server.listen(0,"127.0.0.1");await once(server,"listening");const address=server.address();if(!address||typeof address==="string")throw Error();
  try{
    await page.goto(`http://127.0.0.1:${address.port}/`);const form=page.locator('#corpus-discovery');
    await expect(form).toBeVisible();expect(calls).toHaveLength(0);
    await form.locator('[name="environment"]').selectOption("uat");await form.locator('[name="intentQuery"]').fill("read records");
    await page.getByRole('button',{name:'Compare candidates with inference'}).click();
    await expect(page.locator('#corpus-discovery-status')).toContainText('inferred, unreviewed and non-normative');
    await expect(page.locator('#corpus-discovery-status')).toContainText('incomplete');
    await expect(page.locator('#corpus-discovery-status')).toContainText('omitted');
    await expect(page.locator('#corpus-discovery-results')).toContainText('commerce / orders (checkpoint 7)');
    await expect(page.locator('#corpus-discovery-results')).toContainText('commerce / billing (checkpoint 8)');
    await expect(page.locator('#corpus-discovery-results script')).toHaveCount(0);
    expect(calls).toEqual([{environment:"uat",intentQuery:"read records",limit:16}]);expect(selections).toHaveLength(0);
    await page.getByRole('button',{name:'Load suggested pinned contract'}).first().click();
    await expect(page.locator('#contract-status')).toContainText('Contract available');
    expect(selections[0]).toMatchObject({repositoryId:"commerce",serviceId:"orders",selector:{environment:"uat",expectedCheckpointVersion:"7"}});
    wrongPin=true;await page.getByRole('button',{name:'Load suggested pinned contract'}).first().click();
    await expect(page.locator('#contract-status')).toContainText('stale');
    delayed=true;await page.getByRole('button',{name:'Compare candidates with inference'}).click();
    await expect(page.locator('#corpus-discovery-status')).toContainText('Comparing');
    await form.locator('[name="environment"]').selectOption('staging');release?.(groups());
    await expect(page.locator('#corpus-discovery-results')).toBeEmpty();await expect(page.locator('#corpus-discovery-status')).toContainText('Inputs changed');
    delayed=false;result={status:"shortlist_no_match",environment:"uat",scope:"keyword_candidates",matchMode:"keyword",complete:true,verification:"inferred",review:"unreviewed",normative:false};
    await form.locator('[name="environment"]').selectOption('uat');await page.getByRole('button',{name:'Compare candidates with inference'}).click();
    await expect(page.locator('#corpus-discovery-status')).toContainText('may still exist outside this shortlist');
    const wrong=groups();result={...wrong,groups:wrong.groups.map((group,index)=>index?group:{...group,selector:{...group.selector,selector:{kind:"environment",environment:"staging",expectedCheckpointVersion:"7"}}})};
    await page.getByRole('button',{name:'Compare candidates with inference'}).click();
    await expect(page.locator('#corpus-discovery-status')).toContainText('unavailable');await expect(page.locator('#corpus-discovery-results')).toBeEmpty();
    const wrongCandidate=groups();result={...wrongCandidate,groups:wrongCandidate.groups.map((group,index)=>index?group:{...group,candidates:group.candidates.map(item=>({...item,selector:{...item.selector,serviceId:'foreign-service'}}))})};
    await page.getByRole('button',{name:'Compare candidates with inference'}).click();
    await expect(page.locator('#corpus-discovery-status')).toContainText('unavailable');await expect(page.locator('#corpus-discovery-results')).toBeEmpty();
  }finally{server.closeAllConnections();server.close();await once(server,'close');}
});
