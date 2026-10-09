import {afterEach,describe,expect,test} from "vitest";
import {mkdtemp,mkdir,readFile,rm,symlink,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {buildDependencyInventory} from "../../scripts/dependency-inventory.mjs";

const roots:string[]=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(path=>rm(path,{recursive:true,force:true})));});
const fixture=async(packages:Record<string,unknown>)=>{
  const root=await mkdtemp(join(tmpdir(),"api-truth-dependency-inventory-"));roots.push(root);
  await writeFile(join(root,"package-lock.json"),JSON.stringify({name:"fixture",lockfileVersion:3,packages}));
  return root;
};
const install=async(root:string,name:string,manifest:unknown)=>{
  const path=join(root,"node_modules",...name.split("/"));await mkdir(path,{recursive:true});
  await writeFile(join(path,"package.json"),JSON.stringify(manifest));return path;
};

describe("locked dependency inventory",()=>{
  test("uses lock identity, cross-checks installed versions, and emits only a resolved domain",async()=>{
    const root=await fixture({"":{},"node_modules/@scope/pkg":{
      version:"1.2.3",dev:true,resolved:"https://user:secret@registry.example.test/@scope/pkg.tgz"}});
    await install(root,"@scope/pkg",{name:"@scope/pkg",version:"1.2.3",license:"MIT",main:"index.js"});
    await writeFile(join(root,"node_modules/@scope/pkg/index.js"),`throw new Error("must not execute");`);
    const output=await buildDependencyInventory({projectRoot:root});
    expect(output.packages).toEqual([expect.objectContaining({name:"@scope/pkg",version:"1.2.3",
      dependencyKind:"development",installed:true,resolvedDomain:"registry.example.test",
      license:{value:"MIT",source:"installed_package_manifest",assessment:"spdx_expression_candidate"}})]);
    expect(JSON.stringify(output)).not.toContain("secret");
    expect(JSON.stringify(output)).not.toContain(root);
    expect(output.rootLockMetadataComplete).toBe(true);
  });

  test("prefers locked license metadata and distinguishes absent optional/workspace packages",async()=>{
    const root=await fixture({
      "node_modules/optional-pkg":{version:"2.0.0",optional:true,license:"Apache-2.0"},
      "node_modules/@local/workspace":{link:true,resolved:"packages/workspace"},
      "packages/workspace":{name:"@local/workspace",version:"3.0.0"},
    });
    await mkdir(join(root,"packages/workspace"),{recursive:true});
    await writeFile(join(root,"packages/workspace/package.json"),JSON.stringify({name:"@local/workspace",version:"3.0.0"}));
    const output=await buildDependencyInventory({projectRoot:root});
    expect(output.packages[0]).toMatchObject({name:"optional-pkg",installed:false,optional:true,
      license:{value:"Apache-2.0",source:"package_lock",assessment:"spdx_expression_candidate"}});
    expect(output.workspaces).toEqual([{name:"@local/workspace",version:"3.0.0"}]);
    expect(output.diagnostics).toContainEqual({code:"optional_package_not_installed",package:"optional-pkg",severity:"informational"});
    expect(output.rootLockMetadataComplete).toBe(true);
  });

  test("marks unrecognized and object license metadata as unresolved without echoing it",async()=>{
    const root=await fixture({"node_modules/object-license":{version:"1.0.0"},"node_modules/custom-license":{version:"1.0.0"}});
    await install(root,"object-license",{name:"object-license",version:"1.0.0",license:{type:"MIT",url:"https://secret.invalid"}});
    await install(root,"custom-license",{name:"custom-license",version:"1.0.0",license:"SEE LICENSE IN private.txt"});
    const output=await buildDependencyInventory({projectRoot:root});
    expect(output.rootLockMetadataComplete).toBe(false);
    expect(output.unresolvedLicenseCount).toBe(2);
    expect(output.diagnostics.map(item=>item.code)).toContain("license_metadata_not_string");
    expect(output.diagnostics.map(item=>item.code)).toContain("license_expression_unrecognized");
    expect(JSON.stringify(output)).not.toContain("secret.invalid");
    expect(JSON.stringify(output)).not.toContain("private.txt");
  });

  test("rejects installed version mismatch and path traversal in lock package keys",async()=>{
    const root=await fixture({"node_modules/pkg":{version:"1.0.0"}});
    await install(root,"pkg",{name:"pkg",version:"2.0.0",license:"MIT"});
    const output=await buildDependencyInventory({projectRoot:root});
    expect(output.rootLockMetadataComplete).toBe(false);
    expect(output.diagnostics).toContainEqual({code:"installed_version_mismatch",package:"pkg",severity:"gap"});
    const wrongName=await fixture({"node_modules/pkg":{version:"1.0.0"}});
    await install(wrongName,"pkg",{name:"other-pkg",version:"1.0.0",license:"MIT"});
    const mismatched=await buildDependencyInventory({projectRoot:wrongName});
    expect(mismatched.diagnostics).toContainEqual({code:"installed_name_mismatch",package:"pkg",severity:"gap"});
    for(const key of ["node_modules/../../outside","node_modules/..","node_modules/@scope/..",
      "node_modules/@../pkg","node_modules/@./pkg"]){
      const hostile=await fixture({[key]:{version:"1.0.0"}});
      await expect(buildDependencyInventory({projectRoot:hostile})).rejects.toThrow("DEPENDENCY_INVENTORY_INVALID_INPUT");
    }
    const malformedVersion=await fixture({"node_modules/pkg":{version:"1.x"}});
    await expect(buildDependencyInventory({projectRoot:malformedVersion})).rejects.toThrow("DEPENDENCY_INVENTORY_INVALID_INPUT");
  });

  test("rejects package manifests that resolve outside the selected project",async()=>{
    const root=await fixture({"node_modules/pkg":{version:"1.0.0"}});
    const outside=await mkdtemp(join(tmpdir(),"api-truth-inventory-outside-"));roots.push(outside);
    await writeFile(join(outside,"package.json"),JSON.stringify({name:"pkg",version:"1.0.0",license:"MIT"}));
    await mkdir(join(root,"node_modules"),{recursive:true});
    await symlink(outside,join(root,"node_modules/pkg"),"dir");
    await expect(buildDependencyInventory({projectRoot:root})).rejects.toThrow("DEPENDENCY_INVENTORY_INVALID_INPUT");
  });

  test("rejects oversized/invalid locks and never imports a package entrypoint",async()=>{
    const root=await fixture({"node_modules/pkg":{version:"1.0.0"}});
    await install(root,"pkg",{name:"pkg",version:"1.0.0",license:"MIT",main:"index.js"});
    const marker=join(root,"executed");
    await writeFile(join(root,"node_modules/pkg/index.js"),`require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran")`);
    expect((await buildDependencyInventory({projectRoot:root})).packages[0]?.installed).toBe(true);
    await expect(readFile(marker)).rejects.toMatchObject({code:"ENOENT"});
    await writeFile(join(root,"node_modules/pkg/package.json"),JSON.stringify({name:"pkg",version:"1.0.0",
      license:"MIT",padding:"x".repeat(1024*1024)}));
    await expect(buildDependencyInventory({projectRoot:root})).rejects.toThrow("DEPENDENCY_INVENTORY_INVALID_INPUT");
    await writeFile(join(root,"node_modules/pkg/package.json"),JSON.stringify({name:"pkg",version:"1.0.0",license:"MIT"}));
    await writeFile(join(root,"package-lock.json"),"{".repeat(16*1024*1024+1));
    await expect(buildDependencyInventory({projectRoot:root})).rejects.toThrow("DEPENDENCY_INVENTORY_INVALID_INPUT");
  });

  test("rejects invalid UTF-8 metadata and enforces the aggregate read budget",async()=>{
    const invalid=await fixture({"node_modules/pkg":{version:"1.0.0"}});
    const invalidManifest=await install(invalid,"pkg",{name:"pkg",version:"1.0.0",license:"MIT"});
    await writeFile(join(invalidManifest,"package.json"),Buffer.from([0x7b,0x22,0x6e,0x61,0x6d,0x65,0x22,0x3a,0xc3,0x7d]));
    await expect(buildDependencyInventory({projectRoot:invalid})).rejects.toThrow("DEPENDENCY_INVENTORY_INVALID_INPUT");

    const count=68,packages:Record<string,unknown>={};
    for(let index=0;index<count;index++)packages[`node_modules/p-${index}`]={version:"1.0.0",license:"MIT"};
    const root=await fixture(packages);
    for(let index=0;index<count;index++){
      const name=`p-${index}`;const directory=join(root,"node_modules",name);
      await mkdir(directory,{recursive:true});
      const base=JSON.stringify({name,version:"1.0.0",license:"MIT",padding:""});
      await writeFile(join(directory,"package.json"),JSON.stringify({name,version:"1.0.0",license:"MIT",
        padding:"x".repeat(1_000_000-Buffer.byteLength(base))}));
    }
    await expect(buildDependencyInventory({projectRoot:root})).rejects.toThrow("DEPENDENCY_INVENTORY_INVALID_INPUT");
  });

  test("inventories the current root lock without implying fixture/JDK completeness",async()=>{
    const projectRoot=resolve(import.meta.dirname,"../..");
    const output=await buildDependencyInventory({projectRoot});
    expect(output.scope).toMatchObject({lockfileVersion:3,isolatedFixturesIncluded:false,javaRuntimeIncluded:false});
    expect(output.scope.dependencyCount).toBeGreaterThan(50);
    expect(output.scope.workspaceCount).toBeGreaterThan(0);
    expect(output.packages.every(item=>item.name.length>0&&item.version.length>0)).toBe(true);
    expect(output.rootLockMetadataComplete).toBe(output.unresolvedLicenseCount===0
      &&!output.diagnostics.some(item=>item.severity==="gap"));
    expect(JSON.stringify(output)).not.toContain("/Users/");
    expect(JSON.stringify(output)).not.toContain("https://");
  });

  test("produces stable output independent of lockfile insertion order",async()=>{
    const root=await fixture({
      "node_modules/zeta":{version:"1.0.0",dev:true,license:"MIT"},
      "node_modules/alpha":{version:"2.0.0",dev:true,license:"Apache-2.0"},
    });
    await install(root,"zeta",{name:"zeta",version:"1.0.0",license:"ISC"});
    await install(root,"alpha",{name:"alpha",version:"2.0.0",license:"MIT"});
    const first=await buildDependencyInventory({projectRoot:root});
    await writeFile(join(root,"package-lock.json"),JSON.stringify({lockfileVersion:3,
      packages:{"node_modules/alpha":{version:"2.0.0",dev:true,license:"Apache-2.0"},
        "node_modules/zeta":{version:"1.0.0",dev:true,license:"MIT"}}}));
    const second=await buildDependencyInventory({projectRoot:root});
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });
});
