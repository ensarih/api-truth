import {expect,test,vi} from "vitest";
import {createConfiguredSemanticProviderFactory}
  from "../../connectors/semantic-providers/src/index.js";
import type {SemanticProviderBinding,SemanticProviderId,SemanticProviderRequest}
  from "../../packages/semantics/src/index.js";

const binding=(tenantId:string,provider:SemanticProviderId,locator:string):SemanticProviderBinding=>({
  tenantId,provider,model:"model-test",secretRef:{scheme:"env",locator}});
const request=(provider:SemanticProviderId):SemanticProviderRequest=>({
  promptVersion:"semantic-grounding-1",provider,model:"model-test",
  source:{repositoryId:"repo",serviceId:"service",selector:{kind:"environment",environment:"uat"},
    pin:{snapshotId:"snap",revision:"rev",configFingerprint:"cfg",checkpointVersion:"4"}},
  endpoints:[{endpointId:"ep-one",method:"GET",applicationPath:"/orders",documents:[{
    kind:"operation_summary",text:"Read orders",evidenceIds:["ev-summary"]}]}]});
const result={result:{status:"suggestions",suggestions:[{endpointId:"ep-one",intent:"read orders",
  summary:"Reads orders.",evidenceIds:["ev-summary"]}]}};
const envelope=(provider:SemanticProviderId)=>{
  const text=JSON.stringify(result);
  return provider==="openai"?{status:"completed",output:[{type:"message",role:"assistant",
    status:"completed",content:[{type:"output_text",text}]}]}
    :{candidates:[{finishReason:"STOP",content:{parts:[{text}]}}]};
};

test("tenant-specific secret references resolve lazily without cross-tenant cache or body disclosure",async()=>{
  const contexts:string[]=[];
  const resolveSecret=vi.fn(async context=>{
    contexts.push(`${context.tenantId}:${context.secretRef.locator}`);
    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context.secretRef)).toBe(true);
    return `CANARY_KEY_${context.tenantId}`;
  });
  const calls:{url:string;headers:RequestInit["headers"];body:string}[]=[];
  const fetch=vi.fn(async(url:string|URL|Request,init?:RequestInit)=>{
    calls.push({url:String(url),headers:init?.headers,body:String(init?.body)});
    const provider=String(url).includes("openai")?"openai":"gemini";
    return new Response(JSON.stringify(envelope(provider)),{status:200,headers:{"content-type":"application/json"}});
  });
  const factory=createConfiguredSemanticProviderFactory({resolveSecret,fetch});
  const first=await factory(binding("tenant-a","openai","TENANT_A_KEY"));
  const second=await factory(binding("tenant-b","gemini","TENANT_B_KEY"));
  expect(resolveSecret).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled();
  expect(await first(request("openai"))).toEqual(result.result);
  expect(await second(request("gemini"))).toEqual(result.result);
  expect(await first(request("openai"))).toEqual(result.result);
  expect(contexts).toEqual(["tenant-a:TENANT_A_KEY","tenant-b:TENANT_B_KEY","tenant-a:TENANT_A_KEY"]);
  expect(calls.map(call=>call.url)).toEqual([
    "https://api.openai.com/v1/responses",
    "https://generativelanguage.googleapis.com/v1beta/models/model-test:generateContent",
    "https://api.openai.com/v1/responses"]);
  expect(calls[0]?.headers).toMatchObject({authorization:"Bearer CANARY_KEY_tenant-a"});
  expect(calls[1]?.headers).toMatchObject({"x-goog-api-key":"CANARY_KEY_tenant-b"});
  expect(JSON.stringify(calls.map(call=>call.body))).not.toMatch(/CANARY_KEY_|TENANT_[AB]_KEY/);
});

test("factory detaches host callbacks and rejects accessors, proxies, and invalid refs with fixed errors",async()=>{
  const original=vi.fn(()=>"original"),replacement=vi.fn(()=>"replacement");
  const options={resolveSecret:original,fetch:vi.fn(async()=>new Response(JSON.stringify(envelope("openai")),
    {status:200,headers:{"content-type":"application/json"}}))};
  const factory=createConfiguredSemanticProviderFactory(options);
  options.resolveSecret=replacement;
  await (await factory(binding("tenant-a","openai","TENANT_A_KEY")))(request("openai"));
  expect(original).toHaveBeenCalledOnce();expect(replacement).not.toHaveBeenCalled();
  const hostile=Object.defineProperty({resolveSecret:original},"timeoutMs",{
    enumerable:true,get(){throw new Error("CANARY_SECRET_VALUE");}});
  expect(()=>createConfiguredSemanticProviderFactory(hostile as never))
    .toThrowError("SEMANTIC_PROVIDER_INVALID_REQUEST");
  expect(()=>createConfiguredSemanticProviderFactory(new Proxy({resolveSecret:original},{}) as never))
    .toThrowError("SEMANTIC_PROVIDER_INVALID_REQUEST");
  const invalid={...binding("tenant-a","openai","TENANT_A_KEY"),
    secretRef:Object.defineProperty({},"locator",{enumerable:true,get(){throw new Error("CANARY_SECRET_VALUE");}})};
  expect(()=>factory(invalid as never)).toThrowError("SEMANTIC_PROVIDER_INVALID_REQUEST");
  expect(()=>createConfiguredSemanticProviderFactory({resolveSecret:original,timeoutMs:30_001}))
    .toThrowError("SEMANTIC_PROVIDER_INVALID_REQUEST");
});

test("binding rejects hostile provider coercion and a request for another model before secrets or network",async()=>{
  const toString=vi.fn(()=>"openai");
  const resolveSecret=vi.fn(()=>"CANARY_MODEL_SECRET");
  const fetch=vi.fn(async()=>new Response(JSON.stringify(envelope("openai")),{status:200}));
  const factory=createConfiguredSemanticProviderFactory({resolveSecret,fetch});
  expect(()=>factory({...binding("tenant-a","openai","TENANT_A_KEY"),
    provider:{toString}} as never)).toThrowError("SEMANTIC_PROVIDER_INVALID_REQUEST");
  expect(toString).not.toHaveBeenCalled();
  const port=await factory(binding("tenant-a","openai","TENANT_A_KEY"));
  await expect(port({...request("openai"),model:"other-model"}))
    .rejects.toMatchObject({code:"SEMANTIC_PROVIDER_INVALID_REQUEST",
      message:"SEMANTIC_PROVIDER_INVALID_REQUEST"});
  const hostile=Object.defineProperty({...request("openai")},"model",{
    enumerable:true,get(){throw new Error("CANARY_MODEL_SECRET");}});
  await expect(port(hostile as never)).rejects.toMatchObject({code:"SEMANTIC_PROVIDER_INVALID_REQUEST"});
  expect(resolveSecret).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled();
});
