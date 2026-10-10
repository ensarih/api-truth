import {readFile} from "node:fs/promises";
import {registerHooks} from "node:module";

if(process.version!=="v24.6.0")throw Error("Pinned analyzer Node required");
const roots=[new URL("../../../packages/ir/src/",import.meta.url).href,
  new URL("../../../connectors/git-source/src/",import.meta.url).href];
registerHooks({resolve(specifier,context,nextResolve){
  if(specifier.startsWith(".")&&specifier.endsWith(".js")&&roots.some(root=>context.parentURL?.startsWith(root))){
    const target=new URL(specifier.replace(/\.js$/,".ts"),context.parentURL);
    if(roots.some(root=>target.href.startsWith(root)))return nextResolve(target.href,context);
  }return nextResolve(specifier,context);
}});
const {createProtectedDocumentLoadVerifier}=await import("../../../connectors/git-source/src/protected-document-load.ts");
const config=JSON.parse(await readFile(process.argv[2],"utf8"));
let authorizations=0;
const verifier=createProtectedDocumentLoadVerifier({binding:config.binding,
  authorize:async(scope)=>{authorizations++;return JSON.stringify(scope)===JSON.stringify(config.binding.scope);},
  readArtifact:async(ref)=>{if(ref!=="capture:document-load-fixture")throw Error("unexpected artifact");return readFile(config.artifactPath,"utf8");},
  readKey:async(ref)=>{if(ref!=="key:document-load-fixture")throw Error("unexpected key");return readFile(config.keyPath,"utf8");}});
const result=await verifier.verify();
if(authorizations!==2)throw Error("Authorization recheck missing");
process.stdout.write(JSON.stringify({result,authorizations}));
