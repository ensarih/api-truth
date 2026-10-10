import {readFile,readdir} from "node:fs/promises";
import {resolve} from "node:path";
import {expect,test} from "vitest";

type Manifest={name:string;version:string;workspaces?:string[];dependencies?:Record<string,string>;
 devDependencies?:Record<string,string>;optionalDependencies?:Record<string,string>};
const root=resolve(import.meta.dirname,"../..");
const json=async(path:string)=>JSON.parse(await readFile(resolve(root,path),"utf8"));

test("internal workspace dependencies and lock metadata resolve to the checked-in private package versions",async()=>{
 const manifest=await json("package.json") as Manifest;
 const lock=await json("package-lock.json") as {packages:Record<string,Record<string,unknown>>};
 const workspaces=new Map<string,{path:string;manifest:Manifest}>();
 for(const pattern of manifest.workspaces!){
  expect(pattern).toMatch(/^[a-z-]+\/\*$/);
  const parent=pattern.slice(0,-2);
  for(const entry of await readdir(resolve(root,parent),{withFileTypes:true})){
   if(!entry.isDirectory())continue;
   const path=`${parent}/${entry.name}`;
   let current:Manifest;
   try{current=await json(`${path}/package.json`) as Manifest;}
   catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")continue;throw error;}
   expect(workspaces.has(current.name),`duplicate workspace ${current.name}`).toBe(false);
   workspaces.set(current.name,{path,manifest:current});
  }
 }
 expect(workspaces.size).toBeGreaterThan(0);
 const mismatches:string[]=[];
 for(const {path,manifest:current} of workspaces.values()){
  expect(lock.packages[path],`missing lock workspace ${path}`).toMatchObject({name:current.name,version:current.version});
  expect(lock.packages[`node_modules/${current.name}`],`missing workspace link ${current.name}`).toEqual({resolved:path,link:true});
  for(const group of ["dependencies","devDependencies","optionalDependencies"] as const){
   expect(lock.packages[path]![group]??{}).toEqual(current[group]??{});
   for(const [name,version] of Object.entries(current[group]??{})){
    const target=workspaces.get(name);
    if(target&&version!==target.manifest.version)mismatches.push(`${path}: ${name}@${version} != checked-in ${target.manifest.version}`);
   }
  }
 }
 expect(mismatches,"a mismatched internal version makes npm fetch an unpublished package instead of linking the workspace").toEqual([]);
});
