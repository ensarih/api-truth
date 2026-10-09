import {once} from "node:events";
import {readFile} from "node:fs/promises";
import {expect,test} from "@playwright/test";
import {createPortalServer,type PortalOptions} from "../../apps/portal/src/server.js";
import type {ContractSnapshot} from "../../packages/ir/src/index.js";
import type {QuerySelection} from "../../packages/query/src/index.js";
import type {SyntheticExampleResult} from "../../packages/observations/src/examples.js";

test("synthetic examples use the displayed environment pin, show actual scope as text, and discard stale replies",async({page})=>{
  const principal={tenantId:"tenant-browser",principalId:"reader-browser"};
  const pin={snapshotId:"snapshot-browser",revision:"rev-browser",configFingerprint:"config-browser",checkpointVersion:"7"};
  const snapshot=JSON.parse(await readFile(new URL("../fixtures/ir/express-snapshot.json",import.meta.url),"utf8")) as ContractSnapshot;
  snapshot.snapshot_id=pin.snapshotId;snapshot.source.immutable_revision=pin.revision;
  snapshot.config.config_fingerprint=pin.configFingerprint;
  const calls:unknown[]=[];
  let delayed=false;
  let release:((value:SyntheticExampleResult)=>void)|undefined;
  let denied=false;
  let nextResult:unknown;
  const sample=():SyntheticExampleResult=>({status:"generated",kind:"synthetic_example",nonNormative:true,
    policyVersion:"synthetic-examples-1",scope:{tenantId:principal.tenantId,repositoryId:"commerce",
      serviceId:"orders",environment:"uat",revision:pin.revision,snapshotId:pin.snapshotId,
      sourceDigest:snapshot.source.source_digest,configFingerprint:pin.configFingerprint,
      checkpointVersion:pin.checkpointVersion,endpointId:"ep-get",direction:"response",statusCode:200,
      mediaType:"application/json"},fingerprints:{schemaSha256:"sha256:schema",policySha256:"sha256:policy"},
      value:{id:"<img src=x onerror=window.exampleInjected=true>"},diagnostics:[]});
  const query:PortalOptions["query"]={searchServices:async()=>({services:[],truncated:false}),
    readContract:async(_context,selection)=>({status:"resolved" as const,selector:selection as QuerySelection,
      pin,publication:{status:"absent" as const},snapshot}),
    compareContracts:async()=>({status:"unavailable" as const,beforeStatus:"unknown" as const,
      afterStatus:"unknown" as const}),readPublication:async()=>{throw Error("unused");}};
  const server=createPortalServer({query,authenticate:async request=>
    request.headers.authorization==="Bearer browser-fixture"?principal:undefined,
    examples:{generate:async(context,request)=>{
      calls.push({context,request});
      if(denied)throw Object.assign(new Error("private"),{code:"EXAMPLE_NOT_FOUND_OR_DENIED"});
      if(delayed)return new Promise<SyntheticExampleResult>(resolve=>{release=resolve;});
      if(nextResult!==undefined){const result=nextResult;nextResult=undefined;return result as SyntheticExampleResult;}
      return sample();}}});
  server.listen(0,"127.0.0.1");await once(server,"listening");
  const address=server.address();if(!address||typeof address==="string")throw Error("missing port");
  await page.setExtraHTTPHeaders({authorization:"Bearer browser-fixture"});
  try{
    await page.goto(`http://127.0.0.1:${address.port}/`);
    const section=page.locator("#examples"),button=page.getByRole("button",{name:"Generate synthetic example"});
    await expect(section).toBeVisible();await expect(button).toBeDisabled();
    await page.locator("#contract input[name=repositoryId]").fill("commerce");
    await page.locator("#contract input[name=serviceId]").fill("orders");
    await page.locator("#contract input[name=value]").fill("uat");
    await page.getByRole("button",{name:"View contract"}).click();
    await expect(page.locator("#contract-status")).toContainText("Contract available");
    await expect(button).toBeEnabled();
    await page.locator("#examples input[name=policyId]").fill("create-order");
    await button.click();
    await expect(page.locator("#example-status")).toContainText("synthetic");
    await expect(page.locator("#example-result")).toContainText("ep-get");
    await expect(page.locator("#example-result")).toContainText("<img src=x");
    expect(await page.locator("#example-result img").count()).toBe(0);
    expect(await page.evaluate(()=>Reflect.get(globalThis,"exampleInjected"))).toBeUndefined();
    expect(calls[0]).toMatchObject({context:principal,request:{policyId:"create-order",
      selection:{tenantId:principal.tenantId,repositoryId:"commerce",serviceId:"orders",
        selector:{kind:"environment",environment:"uat",expectedCheckpointVersion:"7"}}}});
    const base=sample();if(base.status!=="generated")throw Error("sample not generated");
    for(const malformed of [
      {...base,scope:{...base.scope,endpointId:"outside-contract"}},
      {...base,scope:{...base.scope,tenantId:"other-tenant"}},
      {...base,scope:{...base.scope,sourceDigest:"other-source"}},
      {status:"withheld",diagnostics:[],value:{private:"CANARY_SECRET"}},
      {status:"withheld"},
    ]){
      nextResult=malformed;await button.click();
      await expect(page.locator("#example-result")).toBeEmpty();
      await expect(page.locator("#example-status")).toContainText("unavailable");
      expect(await page.locator("#example-result").textContent()).not.toContain("CANARY_SECRET");
    }
    nextResult={status:"withheld",diagnostics:[{ruleId:"no_properties_opted_in",count:1}]};
    await button.click();
    await expect(page.locator("#example-status")).toContainText("No synthetic example");
    denied=true;await button.click();
    await expect(page.locator("#example-result")).toBeEmpty();
    await expect(page.locator("#example-status")).toContainText("unavailable");
    denied=false;delayed=true;await button.click();
    await expect(page.locator("#example-status")).toContainText("Generating");
    await page.locator("#contract input[name=value]").fill("other");
    await expect(button).toBeDisabled();
    release?.(sample());
    await expect(page.locator("#example-result")).toBeEmpty();
    await page.locator("#contract input[name=value]").fill("uat");
    await page.locator("#contract select[name=kind]").selectOption("branch");
    await page.getByRole("button",{name:"View contract"}).click();
    await expect(page.locator("#contract-status")).toContainText("Contract available");
    await expect(button).toBeDisabled();
    await expect(page.locator("#example-status")).toContainText("environment");
  }finally{server.closeAllConnections();server.close();await once(server,"close");}
});

test("example form stays hidden without a configured example service",async({page})=>{
  const query:PortalOptions["query"]={searchServices:async()=>({services:[],truncated:false}),
    readContract:async(_context,selection)=>({status:"unknown",selector:selection as QuerySelection}),
    compareContracts:async()=>({status:"unavailable",beforeStatus:"unknown",afterStatus:"unknown"}),
    readPublication:async()=>{throw Error("unused");}};
  const server=createPortalServer({query,authenticate:async()=>({tenantId:"tenant",principalId:"reader"})});
  server.listen(0,"127.0.0.1");await once(server,"listening");
  const address=server.address();if(!address||typeof address==="string")throw Error("missing port");
  try{await page.goto(`http://127.0.0.1:${address.port}/`);
    await expect(page.locator("#examples")).toBeHidden();
  }finally{server.closeAllConnections();server.close();await once(server,"close");}
});
