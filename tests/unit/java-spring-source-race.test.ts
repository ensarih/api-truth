import {mkdir,mkdtemp,rm,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname,join} from "node:path";
import {afterEach,expect,test,vi} from "vitest";
import {readJavaSources} from "../../analyzers/java-spring/src/source.js";

const race=vi.hoisted(()=>({mode:"" as ""|"leaf"|"ancestor",outside:"",hits:0}));
vi.mock("node:fs/promises",async(importOriginal)=>{
  const actual=await importOriginal<typeof import("node:fs/promises")>();
  return {...actual,open:async(path:Parameters<typeof actual.open>[0],flags:Parameters<typeof actual.open>[1])=>{
    if(race.mode&&String(path).endsWith("Victim.java")){
      const mode=race.mode;
      race.mode="";
      race.hits++;
      if(mode==="leaf"){
        await actual.rm(path);
        await actual.symlink(race.outside,path);
      }else{
        const parent=dirname(String(path));
        await actual.rename(parent,`${parent}-renamed`);
        await actual.symlink(race.outside,parent);
      }
    }
    return actual.open(path,flags);
  }};
});

const roots:string[]=[];
const scratch=async()=>{const root=await mkdtemp(join(tmpdir(),"api-truth-java-race-"));roots.push(root);return root;};
afterEach(async()=>{
  race.mode="";race.outside="";race.hits=0;
  for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});
});

test("a leaf replaced by an outside symlink before open is rejected without reading it",async()=>{
  const root=await scratch(),outside=await scratch();
  await writeFile(join(root,"Victim.java"),"class Victim {}");
  const secret=join(outside,"secret.java");
  await writeFile(secret,"PRIVATE_SOURCE_CANARY");
  race.mode="leaf";race.outside=secret;
  await expect(readJavaSources(root,".",5,Date.now()+1000)).rejects.toThrow("JAVA_SOURCE_BOUNDARY_OR_LIMIT");
  expect(race.hits).toBe(1);
});

test("a parent replaced by an outside symlink before open is rejected",async()=>{
  const root=await scratch(),outside=await scratch();
  await mkdir(join(root,"src"));
  await writeFile(join(root,"src","Victim.java"),"class Victim {}");
  await writeFile(join(outside,"Victim.java"),"PRIVATE_SOURCE_CANARY");
  race.mode="ancestor";race.outside=outside;
  await expect(readJavaSources(root,".",5,Date.now()+1000)).rejects.toThrow("JAVA_SOURCE_BOUNDARY_OR_LIMIT");
  expect(race.hits).toBe(1);
});
