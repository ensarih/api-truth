import {once} from "node:events";
import {readFile} from "node:fs/promises";
import {expect,test} from "@playwright/test";
import {createPortalServer,type PortalOptions} from "../../apps/portal/src/server.js";
import type {ContractSnapshot} from "../../packages/ir/src/index.js";

test("presence uses the displayed unqualified pin and clears malformed or stale replies",async({page})=>{
  const principal={tenantId:"tenant-browser",principalId:"reader-browser"};
  const pin={snapshotId:"snapshot-browser",revision:"rev-browser",configFingerprint:"sha256:"+"c".repeat(64),checkpointVersion:"7"};
  const snapshot=JSON.parse(await readFile(new URL("../fixtures/ir/express-snapshot.json",import.meta.url),"utf8")) as ContractSnapshot;
  snapshot.snapshot_id=pin.snapshotId;snapshot.source.immutable_revision=pin.revision;snapshot.config.config_fingerprint=pin.configFingerprint;
  const sample=()=>({status:"resolved",kind:"observed_field_presence",nonNormative:true,
    pin:{tenantId:principal.tenantId,repositoryId:"commerce",serviceId:"orders",environment:"uat",...pin,
      sourceDigest:snapshot.source.source_digest},
    policy:{policyId:"order-fields",ownerPolicyRevision:"1",policyFingerprint:"sha256:"+"e".repeat(64),
      configActivationCheckpoint:"3",endpointId:"ep-get",direction:"response",mediaType:"application/problem+json",statusCode:200,propertyPaths:["/id"]},
    records:[{importId:"550e8400-e29b-4d4a-a716-446655440000",recordId:"550e8400-e29b-4d4a-a716-446655440001",
      source:{sourceId:"gateway-log",sourceVersion:"source-1",windowStart:"2026-10-09T00:00:00.000Z",
        windowEnd:"2026-10-09T00:01:00.000Z",importedAt:"2026-10-09T00:02:00.123456Z",expiresAt:"2026-10-11T00:01:00.000Z"},
      scope:{sourceDigest:snapshot.source.source_digest,endpointId:"ep-get",direction:"response",mediaType:"application/problem+json",statusCode:200},
      fields:[{path:"/id",state:"present"}]}],truncated:true});
  const calls:unknown[]=[];let next:unknown,delayed=false,release:((value:unknown)=>void)|undefined,qualified=false;
  const query:PortalOptions["query"]={searchServices:async()=>({services:[],truncated:false}),
    readContract:async(_context,selection)=>({status:"resolved",selector:selection as never,
      pin:{...pin,...(qualified?{selectedRevision:"selected-browser"}:{})},snapshot,publication:{status:"absent"}}),
    compareContracts:async()=>({status:"unavailable",beforeStatus:"unknown",afterStatus:"unknown"}),
    readPublication:async()=>{throw Error("unused");}};
  const server=createPortalServer({query,authenticate:async request=>request.headers.authorization==="Bearer fixture"?principal:undefined,
    presence:{readForPrincipal:async(_credential:unknown,context:unknown,request:unknown)=>{
      calls.push({context,request});if(delayed)return new Promise(resolve=>{release=resolve;});
      const result=next??sample();next=undefined;return result;
    }} as never});
  server.listen(0,"127.0.0.1");await once(server,"listening");
  const address=server.address();if(!address||typeof address==="string")throw Error("missing port");
  await page.setExtraHTTPHeaders({authorization:"Bearer fixture"});
  try{
    await page.goto(`http://127.0.0.1:${address.port}/`);
    const button=page.getByRole("button",{name:"Read observed fields"}),output=page.locator("#presence-result");
    await expect(page.locator("#presence")).toBeVisible();await expect(button).toBeDisabled();
    await page.locator("#contract input[name=repositoryId]").fill("commerce");
    await page.locator("#contract input[name=serviceId]").fill("orders");
    await page.locator("#contract input[name=value]").fill("uat");
    await page.getByRole("button",{name:"View contract"}).click();await expect(button).toBeEnabled();
    await page.locator("#presence input[name=policyId]").fill("order-fields");await button.click();
    await expect(output).toContainText('"state": "present"');await expect(output).toContainText(".123456Z");
    await expect(page.locator("#presence-status")).toContainText("non-normative");
    await expect(page.locator("#presence-status")).toContainText("More records");
    expect(calls[0]).toMatchObject({context:principal,request:{policyId:"order-fields",ownerPolicyRevision:"1",limit:20,
      expectedPin:{tenantId:principal.tenantId,repositoryId:"commerce",serviceId:"orders",environment:"uat",...pin}}});
    for(const malformed of [{...sample(),pin:{...sample().pin,environment:"prod"}},
      {...sample(),nonNormative:false},{...sample(),value:"PRIVATE_VALUE_CANARY"},
      {...sample(),records:[{...sample().records[0],fields:[{path:"/id",state:"present",value:"PRIVATE_VALUE_CANARY"}]}]}]){
      next=malformed;await button.click();await expect(page.locator("#presence-status")).toContainText("unavailable");
      await expect(output).toBeEmpty();expect(await page.locator("body").textContent()).not.toContain("PRIVATE_VALUE_CANARY");
    }
    delayed=true;await button.click();await expect.poll(()=>release!==undefined).toBe(true);
    await page.locator("#presence input[name=policyId]").fill("other-policy");release!(sample());
    await expect(output).toBeEmpty();await expect(page.locator("#presence-status")).toContainText("Policy changed");
    delayed=false;release=undefined;
    await page.locator("#presence input[name=policyId]").fill("order-fields");
    qualified=true;await page.getByRole("button",{name:"View contract"}).click();
    await expect(button).toBeDisabled();await expect(output).toBeEmpty();
    qualified=false;await page.getByRole("button",{name:"View contract"}).click();await expect(button).toBeEnabled();
    delayed=true;await button.click();await expect.poll(()=>release!==undefined).toBe(true);
    await page.locator("#contract input[name=value]").fill("prod");release!(sample());
    await expect(button).toBeDisabled();await expect(output).toBeEmpty();
  }finally{release?.(sample());server.closeAllConnections();server.close();await once(server,"close");}
});
