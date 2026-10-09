import {lstat, open, realpath} from "node:fs/promises";
import {dirname, isAbsolute, join, relative, resolve, sep} from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";

const MAX_LOCK_BYTES=16*1024*1024;
const MAX_MANIFEST_BYTES=1024*1024;
const MAX_TOTAL_MANIFEST_BYTES=64*1024*1024;
const MAX_PACKAGES=10_000;
const SEMVER=/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-((?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const KNOWN_SPDX_IDS=new Set(["0BSD","Apache-2.0","BSD-2-Clause","BSD-3-Clause","BlueOak-1.0.0",
  "CC0-1.0","ISC","MIT","MPL-2.0","Unlicense","WTFPL","Zlib"]);

const fail=()=>{throw new Error("DEPENDENCY_INVENTORY_INVALID_INPUT");};
const compare=(a,b)=>a<b?-1:a>b?1:0;
const within=(root,target)=>{const rel=relative(root,target);return rel===""||(!rel.startsWith(`..${sep}`)&&rel!==".."&&!isAbsolute(rel));};
const boundedJson=async(path,limit)=>{
  const handle=await open(path,"r").catch(fail);
  try{
    const info=await handle.stat();
    if(!info.isFile()||info.size>limit)fail();
    const bytes=Buffer.alloc(limit+1);let bytesRead=0;
    while(bytesRead<bytes.length){
      const next=await handle.read(bytes,bytesRead,bytes.length-bytesRead,bytesRead);
      if(next.bytesRead===0)break;
      bytesRead+=next.bytesRead;
    }
    if(bytesRead>limit)fail();
    try{return {value:JSON.parse(new TextDecoder("utf-8",{fatal:true})
      .decode(bytes.subarray(0,bytesRead))),bytes:bytesRead};}catch{fail();}
  }finally{await handle.close().catch(()=>undefined);}
};
const safeLicenseExpression=(input)=>{
  if(typeof input!=="string"||input.length<1||input.length>256
    ||!/^[A-Za-z0-9.+()\-\s]+$/.test(input))return "non_spdx";
  const tokens=input.match(/[A-Za-z0-9.+-]+|[()]/g);
  if(!tokens||tokens.join("").replaceAll(" ","")!==input.replaceAll(/\s/g,""))return "non_spdx";
  let index=0,valid=true;
  const atom=()=>{
    if(tokens[index]==="("){index++;expression();if(tokens[index]!==")")valid=false;else index++;return;}
    const token=tokens[index++];
    if(!token||token==="AND"||token==="OR"||token==="WITH"||!KNOWN_SPDX_IDS.has(token)){valid=false;return;}
    if(tokens[index]==="WITH"){index++;const exception=tokens[index++];if(!exception||!KNOWN_SPDX_IDS.has(exception))valid=false;}
  };
  const expression=()=>{atom();while(tokens[index]==="AND"||tokens[index]==="OR"){index++;atom();}};
  expression();
  return valid&&index===tokens.length?"spdx_expression_candidate":"non_spdx";
};
const packageIdentity=(key)=>{
  if(typeof key!=="string"||!key.startsWith("node_modules/"))fail();
  const parts=key.split("/");
  let i=1,lastName;
  while(i<parts.length){
    const part=parts[i++];
    if(part==="node_modules"||part==="."||part===".."||!part)fail();
    if(part.startsWith("@")){
      const name=parts[i++];
      if(!/^@[A-Za-z0-9._-]+$/.test(part)||part==="@."||part==="@.."||!name
        ||name==="."||name===".."||!/^[@A-Za-z0-9._-]+$/.test(name))fail();
      lastName=`${part}/${name}`;
    }else{
      if(!/^[A-Za-z0-9._-]+$/.test(part))fail();
      lastName=part;
    }
    if(i<parts.length){if(parts[i]!=="node_modules")fail();i++;}
  }
  if(!lastName)fail();
  return lastName;
};
const resolvedDomain=(value)=>{
  if(typeof value!=="string"||value.length>2048)return null;
  try{const url=new URL(value);if(!url.hostname||!(url.protocol==="https:"||url.protocol==="http:"))return null;
    return url.hostname.toLowerCase();}catch{return null;}
};
const readManifestInside=async(root,path,totalRemaining)=>{
  let real;
  try{real=await realpath(path);}catch(error){if(error?.code==="ENOENT")return undefined;fail();}
  if(!within(root,real))fail();
  const info=await lstat(path).catch(fail);
  if(!info.isFile()&&!info.isSymbolicLink())fail();
  return await boundedJson(real,Math.min(MAX_MANIFEST_BYTES,totalRemaining));
};

/** Builds a lockfile-scoped inventory without importing or executing package code. */
export const buildDependencyInventory=async({projectRoot="."}={})=>{
  if(typeof projectRoot!=="string"||projectRoot.length===0)fail();
  const root=await realpath(resolve(projectRoot)).catch(fail);
  const lockPath=join(root,"package-lock.json");
  const lockReal=await realpath(lockPath).catch(fail);
  if(!within(root,lockReal))fail();
  const lockRecord=await boundedJson(lockReal,MAX_LOCK_BYTES);
  const lock=lockRecord.value;
  if(!lock||typeof lock!=="object"||lock.lockfileVersion!==3||!lock.packages
    ||typeof lock.packages!=="object"||Array.isArray(lock.packages))fail();
  const packageEntries=Object.entries(lock.packages).filter(([key])=>key.startsWith("node_modules/"));
  if(packageEntries.length>MAX_PACKAGES)fail();
  const packages=[],workspaces=[],diagnostics=[];
  let totalManifestBytes=0;
  for(const [key,entry] of packageEntries.sort(([a],[b])=>compare(a,b))){
    if(!entry||typeof entry!=="object"||Array.isArray(entry))fail();
    const name=packageIdentity(key);
    if(entry.link===true){
      const target=entry.resolved;
      if(typeof target!=="string"||target.length>512||target.startsWith("/")
        ||target.split(/[\\/]/).some(part=>part===".."||part==="."||part===""))fail();
      const workspacePath=resolve(root,target);
      if(!within(root,workspacePath))fail();
      const workspaceReal=await realpath(workspacePath).catch(fail);
      if(!within(root,workspaceReal))fail();
      const workspaceManifest=await readManifestInside(root,join(workspaceReal,"package.json"),
        MAX_TOTAL_MANIFEST_BYTES-totalManifestBytes);
      const workspaceLockEntry=lock.packages[target];
      if(!workspaceManifest||!workspaceManifest.value||workspaceManifest.value.name!==name
        ||typeof workspaceManifest.value.version!=="string"
        ||!SEMVER.test(workspaceManifest.value.version)
        ||!workspaceLockEntry||workspaceLockEntry.version!==workspaceManifest.value.version
        ||typeof entry.version==="string"&&entry.version!==workspaceManifest.value.version)fail();
      totalManifestBytes+=workspaceManifest.bytes;
      workspaces.push({name,version:workspaceManifest.value.version});
      continue;
    }
    if(typeof entry.version!=="string"||entry.version.length>128||!SEMVER.test(entry.version))fail();
    const optional=entry.optional===true||entry.devOptional===true;
    const record={name,version:entry.version,
      dependencyKind:optional?(entry.dev===true||entry.devOptional===true?"optional_development":"optional_production")
        :(entry.dev===true?"development":"production"),
      optional,resolvedDomain:resolvedDomain(entry.resolved),
      installed:false,license:null,diagnostics:[]};
    const manifestPath=join(root,...key.split("/"),"package.json");
    const manifestRecord=await readManifestInside(root,manifestPath,MAX_TOTAL_MANIFEST_BYTES-totalManifestBytes);
    const manifest=manifestRecord?.value;
    if(manifest===undefined){
      const code=record.optional?"optional_package_not_installed":"package_not_installed";
      record.diagnostics.push(code);diagnostics.push({code,package:name,severity:record.optional?"informational":"gap"});
    }else{
      totalManifestBytes+=manifestRecord.bytes;
      if(!manifest||typeof manifest!=="object"||Array.isArray(manifest))fail();
      if(manifest.version!==entry.version){
        record.diagnostics.push("installed_version_mismatch");diagnostics.push({code:"installed_version_mismatch",package:name,severity:"gap"});
      }else if(manifest.name!==name){
        record.diagnostics.push("installed_name_mismatch");diagnostics.push({code:"installed_name_mismatch",package:name,severity:"gap"});
      }else{
        record.installed=true;
      }
    }
    const lockHasLicense=Object.hasOwn(entry,"license");
    const license=lockHasLicense?entry.license
      :manifest?.version===entry.version&&manifest.name===name?manifest.license:undefined;
    if(license===undefined)record.diagnostics.push("license_metadata_missing");
    else if(typeof license!=="string")record.diagnostics.push("license_metadata_not_string");
    else{
      const assessment=safeLicenseExpression(license);
      record.license={value:assessment==="spdx_expression_candidate"?license:null,
        source:lockHasLicense?"package_lock":"installed_package_manifest",assessment};
      if(assessment!=="spdx_expression_candidate")record.diagnostics.push("license_expression_unrecognized");
    }
    for(const code of record.diagnostics){
      const severity=code==="optional_package_not_installed"?"informational":"gap";
      if(!diagnostics.some(diagnostic=>diagnostic.code===code&&diagnostic.package===name))
        diagnostics.push({code,package:name,severity});
    }
    packages.push(record);
  }
  packages.sort((a,b)=>compare(a.name,b.name)||compare(a.version,b.version));
  workspaces.sort((a,b)=>compare(a.name,b.name));
  diagnostics.sort((a,b)=>compare(a.code,b.code)||compare(a.package,b.package));
  const unresolved=packages.filter(pkg=>pkg.license?.assessment!=="spdx_expression_candidate").length;
  const hasGaps=diagnostics.some(diagnostic=>diagnostic.severity==="gap");
  return {schemaVersion:1,scope:{lockfile:"package-lock.json",lockfileVersion:3,
    dependencyCount:packages.length,workspaceCount:workspaces.length,
    isolatedFixturesIncluded:false,javaRuntimeIncluded:false,
    note:"Root npm lockfile dependencies only; isolated fixture lockfiles and JDK/toolchain licenses are outside this inventory."},
    rootLockMetadataComplete:unresolved===0&&!hasGaps,unresolvedLicenseCount:unresolved,diagnostics,packages,workspaces};
};

const main=async()=>{
  try{
    const args=process.argv.slice(2);
    if(args.length>2||args.length===1&&args[0]!=="--root"
      ||args.length===2&&args[0]!=="--root")fail();
    const projectRoot=args.length===2?args[1]:dirname(dirname(fileURLToPath(import.meta.url)));
    const result=await buildDependencyInventory({projectRoot});process.stdout.write(`${JSON.stringify(result,null,2)}\n`);
  }
  catch{process.stderr.write("DEPENDENCY_INVENTORY_INVALID_INPUT\n");process.exitCode=2;}
};
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)await main();
