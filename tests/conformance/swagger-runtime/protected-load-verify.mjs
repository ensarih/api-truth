import {readFile,readdir} from "node:fs/promises";
import {registerHooks} from "node:module";
import {tmpdir} from "node:os";

if(process.version!=="v24.6.0")throw Error("Pinned analyzer Node required");
const roots=[new URL("../../../packages/ir/src/",import.meta.url).href,
  new URL("../../../analyzers/nodejs/src/",import.meta.url).href,
  new URL("../../../connectors/git-source/src/",import.meta.url).href];
registerHooks({resolve(specifier,context,nextResolve){
  if(specifier.startsWith(".")&&specifier.endsWith(".js")&&roots.some(root=>context.parentURL?.startsWith(root))){
    const target=new URL(specifier.replace(/\.js$/,".ts"),context.parentURL);
    if(roots.some(root=>target.href.startsWith(root)))return nextResolve(target.href,context);
  }return nextResolve(specifier,context);
}});
const {createProtectedDocumentLoadVerifier}=await import("../../../connectors/git-source/src/protected-document-load.ts");
const {createRuntimeCapturePinResolver}=await import("../../../connectors/git-source/src/runtime-capture-pin.ts");
const {createProtectedSwaggerLoadedDocumentPort}=await import("../../../connectors/git-source/src/protected-swagger-loaded-document.ts");
const config=JSON.parse(await readFile(process.argv[2],"utf8"));
const before=(await readdir(tmpdir())).filter(name=>name.startsWith("api-truth-git-source-")).sort();
let authorizations=0;
const loadOptions={binding:config.binding,
  authorize:async(scope)=>{authorizations++;return JSON.stringify(scope)===JSON.stringify(config.binding.scope);},
  readArtifact:async(ref)=>{if(ref!=="capture:document-load-fixture")throw Error("unexpected artifact");return readFile(config.artifactPath,"utf8");},
  readKey:async(ref)=>{if(ref!=="key:document-load-fixture")throw Error("unexpected key");return readFile(config.keyPath,"utf8");}};
const verifier=createProtectedDocumentLoadVerifier(loadOptions);
const result=await verifier.verify();
if(authorizations!==2)throw Error("Authorization recheck missing");
const capturePorts={authorize:loadOptions.authorize,
  readReceipt:async(ref)=>{if(ref!=="capture:document-binding-fixture")throw Error("Unexpected capture");return readFile(config.receiptPath,"utf8");},
  readKey:loadOptions.readKey};
const pinResolver=createRuntimeCapturePinResolver({binding:{scope:config.binding.scope,
  artifactRef:"capture:document-binding-fixture",configuredKeyRef:"key:document-load-fixture",
  expectedReceiptDigest:config.expectedReceiptDigest,expectedSignerSpkiDigest:config.binding.expectedSignerSpkiDigest,
  policyVersion:"runtime-capture-pin-1"},...capturePorts});
const loadedCorrespondence=await createProtectedSwaggerLoadedDocumentPort({documentLoad:loadOptions,
  correspondence:{repoPath:config.repoPath,serviceRoot:".",scope:config.binding.scope,
    expectedCaptureIdentityDigest:config.expectedCaptureIdentityDigest,pinResolver,...capturePorts,
    documentPath:"api/swagger/swagger.yaml",expectedRawDocumentSha256:config.binding.expectedObservation.document.rawSha256,
    limits:{maxFiles:100,maxBytes:2_000_000,timeoutMs:10_000}}}).verify();
const after=(await readdir(tmpdir())).filter(name=>name.startsWith("api-truth-git-source-")).sort();
if(JSON.stringify(before)!==JSON.stringify(after))throw Error("Owned Git trees not cleaned");
process.stdout.write(JSON.stringify({result,authorizations,loadedCorrespondence,ownedTempCleaned:true}));
