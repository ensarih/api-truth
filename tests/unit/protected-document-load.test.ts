import {createHash,generateKeyPairSync,sign} from "node:crypto";
import {afterEach,expect,test,vi} from "vitest";
import {createProtectedDocumentLoadVerifier,ProtectedDocumentLoadError,
  type ProtectedDocumentLoadObservation,type ProtectedDocumentLoadScope,type ProtectedDocumentLoadVerifierOptions} from "../../connectors/git-source/src/protected-document-load.js";
import {canonicalJsonStringify} from "../../packages/ir/src/index.js";

const sha=(value:string|Buffer)=>`sha256:${createHash("sha256").update(value).digest("hex")}`;
const {publicKey,privateKey}=generateKeyPairSync("ed25519");
const scope:ProtectedDocumentLoadScope={tenantId:"tenant-a",repositoryId:"repo-a",serviceId:"orders",
  immutableRevision:"a".repeat(40),sourceDigest:sha("source tree"),environment:"staging"};
const observation=():ProtectedDocumentLoadObservation=>({kind:"unsigned_runtime_document_load",profileVersion:"swagger-document-load-capture-1",
  source:{repositoryId:scope.repositoryId,serviceId:scope.serviceId,immutableRevision:scope.immutableRevision,
    sourceDigest:scope.sourceDigest,environment:scope.environment,sessionId:"session-a"},
  framework:{nodeVersion:"22.19.0",routerDigest:sha("router"),runnerDigest:sha("runner"),swayDigest:sha("sway"),
    jsonRefsDigest:sha("json refs"),pathLoaderDigest:sha("path loader")},
  document:{path:"api/swagger/swagger.yaml",rawSha256:sha("raw document"),canonicalValueSha256:sha("canonical document")},
  bindings:[{method:"GET",application_path:"/orders/{id}",controller:"orders",operation_id:"getOrder",export_name:"getOrder",
    handler_path:"api/controllers/orders.js",handler_digest:sha("handler bytes"),mock_mode:false}]});
const envelopeFor=(value:unknown,key=privateKey)=>{
  const signed={scope,observation:value};
  const payload=Buffer.from(canonicalJsonStringify(signed),"utf8");
  const signature=sign(null,Buffer.concat([Buffer.from("api-truth:swagger-document-load-observation-1\n"),payload]),key);
  return JSON.stringify({purpose:"api-truth:swagger-document-load-observation-1",payload:payload.toString("base64"),signature:signature.toString("base64")});
};
const optionsFor=(text:string,authorize=vi.fn(async(_scope:Readonly<ProtectedDocumentLoadScope>,_signal:AbortSignal)=>true),expected=observation(),key=publicKey.export({type:"spki",format:"pem"}).toString()):ProtectedDocumentLoadVerifierOptions=>({
  binding:{scope,artifactRef:"capture:load-a",configuredKeyRef:"key:load-a",expectedEnvelopeDigest:sha(text),
    expectedSignerSpkiDigest:sha(publicKey.export({type:"spki",format:"der"})),expectedObservation:expected},
  authorize,readArtifact:vi.fn(async(_ref:string,_signal:AbortSignal)=>text),readKey:vi.fn(async(_ref:string,_signal:AbortSignal)=>key),timeoutMs:1_000});
afterEach(()=>vi.useRealTimers());

test("verifies a purpose-bound canonical Ed25519 observation against exact host expectations",async()=>{
  const expected=observation(),text=envelopeFor(expected),options=optionsFor(text);
  const verifier=createProtectedDocumentLoadVerifier(options);
  await expect(verifier.verify()).resolves.toMatchObject({kind:"verified_signed_document_load_observation",
    profileVersion:"swagger-document-load-capture-1",purpose:"api-truth:swagger-document-load-observation-1",
    scope,artifactRef:"capture:load-a",configuredKeyRef:"key:load-a",envelopeDigest:sha(text),observation:expected,
    limitations:[expect.stringContaining("does not prove production deployment")]});
  expect(options.authorize).toHaveBeenCalledTimes(2);
  expect(options.readArtifact).toHaveBeenCalledWith("capture:load-a",expect.any(AbortSignal));
  expect(options.readKey).toHaveBeenCalledWith("key:load-a",expect.any(AbortSignal));
});

test.each(["tenant","repository","service","revision","source_digest","environment","session","framework","document","handler"] as const)(
  "rejects a signed observation with a mismatched %s identity",async field=>{
    const changed=structuredClone(observation());
    const changedScope=structuredClone(scope);
    if(field==="tenant")changedScope.tenantId="other-tenant";
    if(field==="repository")changed.source.repositoryId="other-repo";
    if(field==="service")changed.source.serviceId="other-service";
    if(field==="revision")changed.source.immutableRevision="b".repeat(40);
    if(field==="source_digest")changed.source.sourceDigest=sha("other tree");
    if(field==="environment")changed.source.environment="production";
    if(field==="session")changed.source.sessionId="other-session";
    if(field==="framework")changed.framework.runnerDigest=sha("other runner");
    if(field==="document")changed.document.rawSha256=sha("other raw document");
    if(field==="handler")changed.bindings[0]!.handler_digest=sha("other handler");
    const text=envelopeFor(changed),options=optionsFor(text);
    if(field==="tenant") {
      const payload=Buffer.from(canonicalJsonStringify({scope:changedScope,observation:observation()}));
      const signature=sign(null,Buffer.concat([Buffer.from("api-truth:swagger-document-load-observation-1\n"),payload]),privateKey);
      const replacement=JSON.stringify({purpose:"api-truth:swagger-document-load-observation-1",payload:payload.toString("base64"),signature:signature.toString("base64")});
      options.readArtifact=vi.fn(async()=>replacement);options.binding.expectedEnvelopeDigest=sha(replacement);
    }
    await expect(createProtectedDocumentLoadVerifier(options).verify()).rejects.toMatchObject({code:"DOCUMENT_LOAD_UNVERIFIED"});
    expect(options.authorize).toHaveBeenCalledTimes(1);
  });

test("rejects wrong signature, purpose, key, payload digest, and noncanonical payload",async()=>{
  const valid=observation(),other=generateKeyPairSync("ed25519");
  const wrongKeyText=envelopeFor(valid,other.privateKey);
  const wrongKeyOptions=optionsFor(wrongKeyText);
  await expect(createProtectedDocumentLoadVerifier(wrongKeyOptions).verify()).rejects.toMatchObject({code:"DOCUMENT_LOAD_UNVERIFIED"});
  const wrongPurpose=JSON.stringify({...JSON.parse(envelopeFor(valid)),purpose:"other-purpose"});
  const purposeOptions=optionsFor(wrongPurpose);
  await expect(createProtectedDocumentLoadVerifier(purposeOptions).verify()).rejects.toMatchObject({code:"DOCUMENT_LOAD_UNVERIFIED"});
  const wrongKeyDigest=optionsFor(envelopeFor(valid));wrongKeyDigest.binding.expectedSignerSpkiDigest=sha("different key");
  await expect(createProtectedDocumentLoadVerifier(wrongKeyDigest).verify()).rejects.toMatchObject({code:"DOCUMENT_LOAD_UNVERIFIED"});
  const wrongPayloadDigest=optionsFor(envelopeFor(valid));wrongPayloadDigest.binding.expectedEnvelopeDigest=sha("wrong envelope");
  await expect(createProtectedDocumentLoadVerifier(wrongPayloadDigest).verify()).rejects.toMatchObject({code:"DOCUMENT_LOAD_UNVERIFIED"});
  const noncanonicalPayload=Buffer.from(` ${canonicalJsonStringify({scope,observation:valid})}`),signature=sign(null,
    Buffer.concat([Buffer.from("api-truth:swagger-document-load-observation-1\n"),noncanonicalPayload]),privateKey);
  const noncanonical=JSON.stringify({purpose:"api-truth:swagger-document-load-observation-1",payload:noncanonicalPayload.toString("base64"),signature:signature.toString("base64")});
  await expect(createProtectedDocumentLoadVerifier(optionsFor(noncanonical)).verify()).rejects.toMatchObject({code:"DOCUMENT_LOAD_UNVERIFIED"});
});

test("authorizes before reads and rechecks after verification",async()=>{
  const text=envelopeFor(observation()),denied=optionsFor(text,vi.fn(async()=>false));
  await expect(createProtectedDocumentLoadVerifier(denied).verify()).rejects.toMatchObject({code:"DOCUMENT_LOAD_UNAUTHORIZED"});
  expect(denied.readArtifact).not.toHaveBeenCalled();expect(denied.readKey).not.toHaveBeenCalled();
  const revoked=optionsFor(text,vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false));
  await expect(createProtectedDocumentLoadVerifier(revoked).verify()).rejects.toMatchObject({code:"DOCUMENT_LOAD_UNAUTHORIZED"});
  expect(revoked.authorize).toHaveBeenCalledTimes(2);
});

test("rejects accessor, proxy, mutated binding, and invalid external signal inputs without running traps",async()=>{
  const text=envelopeFor(observation()),options=optionsFor(text);
  let getterCalled=false;const accessor={...options,binding:{...options.binding}};
  Object.defineProperty(accessor.binding,"artifactRef",{get(){getterCalled=true;return "capture:load-a";}});
  expect(()=>createProtectedDocumentLoadVerifier(accessor as never)).toThrowError(ProtectedDocumentLoadError);
  expect(getterCalled).toBe(false);
  let proxyTraps=0;const proxy=new Proxy(options,{getPrototypeOf(){proxyTraps++;throw Error();}});
  expect(()=>createProtectedDocumentLoadVerifier(proxy as never)).toThrowError(ProtectedDocumentLoadError);
  expect(proxyTraps).toBe(0);
  const controller=new AbortController(),valid=optionsFor(text);valid.signal=controller.signal;
  const verifier=createProtectedDocumentLoadVerifier(valid);
  valid.binding.expectedObservation.source.sessionId="mutated-after-construction";
  await expect(verifier.verify()).resolves.toMatchObject({observation:{source:{sessionId:"session-a"}}});
  let signalTrap=0;const badSignal=new Proxy(controller.signal,{getPrototypeOf(){signalTrap++;throw Error();}});
  expect(()=>createProtectedDocumentLoadVerifier({...optionsFor(text),signal:badSignal} as never))
    .toThrowError(ProtectedDocumentLoadError);
  expect(signalTrap).toBe(0);
  let bindingArrayGetter=false;const withArrayAccessor=observation();
  Object.defineProperty(withArrayAccessor.bindings, "0", {get(){bindingArrayGetter=true;return observation().bindings[0];}});
  expect(()=>createProtectedDocumentLoadVerifier(optionsFor(text,undefined,withArrayAccessor)))
    .toThrowError(ProtectedDocumentLoadError);
  expect(bindingArrayGetter).toBe(false);
  const alreadyAborted=new AbortController();alreadyAborted.abort();
  const aborted=optionsFor(text);aborted.signal=alreadyAborted.signal;
  await expect(createProtectedDocumentLoadVerifier(aborted).verify()).rejects.toMatchObject({code:"DOCUMENT_LOAD_UNAUTHORIZED"});
  expect(aborted.authorize).not.toHaveBeenCalled();
});

test("uses one abortable deadline and ignores a late artifact result",async()=>{
  vi.useFakeTimers();
  let lateResolve:(value:string)=>void=()=>undefined;let seenSignal:AbortSignal|undefined;
  const options=optionsFor(envelopeFor(observation()));
  options.binding.expectedEnvelopeDigest=sha("late");
  options.readArtifact=vi.fn((_ref,signal)=>{seenSignal=signal;return new Promise<string>(resolve=>{lateResolve=resolve;});});
  const promise=createProtectedDocumentLoadVerifier({...options,timeoutMs:20}).verify();
  const rejected=expect(promise).rejects.toMatchObject({code:"DOCUMENT_LOAD_UNAVAILABLE"});
  await vi.advanceTimersByTimeAsync(20);
  await rejected;
  expect(seenSignal?.aborted).toBe(true);
  lateResolve("late");await Promise.resolve();
  expect(options.readKey).not.toHaveBeenCalled();
});

test("rejects oversized evidence and malformed observation fields with fixed errors",async()=>{
  const huge="x".repeat(1_400_001),options=optionsFor(huge);
  await expect(createProtectedDocumentLoadVerifier(options).verify()).rejects.toMatchObject({code:"DOCUMENT_LOAD_UNVERIFIED"});
  const malformed=observation() as unknown as Record<string,unknown>;
  malformed.extra="no";
  await expect(createProtectedDocumentLoadVerifier(optionsFor(envelopeFor(malformed))).verify())
    .rejects.toMatchObject({code:"DOCUMENT_LOAD_UNVERIFIED"});
});

test("rejects oversized configured handler paths and aggregate expected payload before callbacks",async()=>{
  const text=envelopeFor(observation()),oversizedPath=observation();
  oversizedPath.bindings[0]!.handler_path=`${"a".repeat(1025)}.js`;
  const pathOptions=optionsFor(text,undefined,oversizedPath);
  expect(()=>createProtectedDocumentLoadVerifier(pathOptions)).toThrowError(ProtectedDocumentLoadError);
  expect(pathOptions.authorize).not.toHaveBeenCalled();expect(pathOptions.readArtifact).not.toHaveBeenCalled();
  const large={...observation(),bindings:[] as Array<ProtectedDocumentLoadObservation["bindings"][number]>};
  for(let index=0;index<1024;index++)large.bindings.push({...observation().bindings[0]!,
    application_path:`/${String(index).padStart(4,"0")}${"x".repeat(1000)}`});
  const aggregateOptions=optionsFor(text,undefined,large);
  expect(()=>createProtectedDocumentLoadVerifier(aggregateOptions)).toThrowError(ProtectedDocumentLoadError);
  expect(aggregateOptions.authorize).not.toHaveBeenCalled();expect(aggregateOptions.readArtifact).not.toHaveBeenCalled();
  const makeBoundary=(commonLength:number,tailLength:number)=>{
    const candidate={...observation(),bindings:[] as Array<ProtectedDocumentLoadObservation["bindings"][number]>};
    for(let index=0;index<1023;index++)candidate.bindings.push({...observation().bindings[0]!,
      application_path:`/${String(index).padStart(4,"0")}${"x".repeat(commonLength)}`});
    candidate.bindings.push({...observation().bindings[0]!,application_path:`/tail${"y".repeat(tailLength)}`});
    return candidate;
  };
  let low=0,high=1500;
  while(low<high){
    const mid=Math.ceil((low+high)/2),bytes=Buffer.byteLength(canonicalJsonStringify(makeBoundary(mid,0)));
    if(bytes<=1_000_000)low=mid;else high=mid-1;
  }
  const base=makeBoundary(low,0),baseSize=Buffer.byteLength(canonicalJsonStringify(base));
  const wrapperOverhead=Buffer.byteLength(canonicalJsonStringify({scope,observation:base}))-baseSize;
  const target=1_000_000-wrapperOverhead+1;
  const boundary=makeBoundary(low,Math.max(0,target-baseSize));
  expect(Buffer.byteLength(canonicalJsonStringify(boundary))).toBeLessThanOrEqual(1_000_000);
  expect(Buffer.byteLength(canonicalJsonStringify({scope,observation:boundary}))).toBeGreaterThan(1_000_000);
  const wrapperOnlyOptions=optionsFor(text,undefined,boundary);
  expect(()=>createProtectedDocumentLoadVerifier(wrapperOnlyOptions)).toThrowError(ProtectedDocumentLoadError);
  expect(wrapperOnlyOptions.authorize).not.toHaveBeenCalled();expect(wrapperOnlyOptions.readArtifact).not.toHaveBeenCalled();
});
