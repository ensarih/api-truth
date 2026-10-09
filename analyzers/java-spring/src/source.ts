import {createHash} from "node:crypto";
import {constants} from "node:fs";
import {lstat,open,opendir,realpath} from "node:fs/promises";
import {isAbsolute,join,relative,resolve,sep} from "node:path";

export const hash=(value:string)=>createHash("sha256").update(value).digest("hex");
export const inside=(root:string,path:string)=>{
  const rel=relative(root,path);
  return rel===""||rel!==".."&&!rel.startsWith(`..${sep}`)&&!isAbsolute(rel);
};
export const digestSources=(files:ReadonlyMap<string,string>)=>
  `sha256:${hash([...files].sort(([a],[b])=>a.localeCompare(b))
    .map(([path,text])=>`${path}\0${text}`).join("\0"))}`;

/** Copies only contained UTF-8 Java source; source symlinks and special files fail closed. */
export const readJavaSources=async(projectRoot:string,serviceRoot:string,maxFiles:number,
  deadline:number):Promise<Map<string,string>>=>{
  try{
    const project=await realpath(projectRoot),root=await realpath(resolve(projectRoot,serviceRoot));
    if(!inside(project,root)||root!==resolve(project,serviceRoot))throw new Error();
    const files=new Map<string,string>();
    let bytes=0,entriesSeen=0;
    const collect=async(dir:string,depth:number):Promise<void>=>{
      if(depth>32||Date.now()>deadline)throw new Error();
      for await(const entry of await opendir(dir)){
        entriesSeen++;
        if(entriesSeen>5000)throw new Error();
        if(Date.now()>deadline)throw new Error();
        if([".git",".worktrees","node_modules","target","build",".gradle"].includes(entry.name))continue;
        if(entry.isSymbolicLink())throw new Error();
        const path=join(dir,entry.name);
        if(entry.isDirectory())await collect(path,depth+1);
        else if(entry.isFile()&&entry.name.endsWith(".java")){
          if(files.size>=maxFiles)throw new Error();
          const chunks:Buffer[]=[];
          let fileBytes=0;
          const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
          try{
            const opened=await handle.stat();
            const canonical=await realpath(path);
            const named=await lstat(path);
            if(!opened.isFile()||!named.isFile()||
              canonical!==resolve(root,relative(root,path))||!inside(root,canonical)||
              opened.dev!==named.dev||opened.ino!==named.ino)throw new Error();
            const buffer=Buffer.allocUnsafe(64*1024);
            let offset=0;
            for(;;){
              if(Date.now()>deadline)throw new Error();
              const {bytesRead}=await handle.read(buffer,0,buffer.length,offset);
              if(!bytesRead)break;
              offset+=bytesRead;
              fileBytes+=bytesRead;bytes+=bytesRead;
              if(fileBytes>2_000_000||bytes>10_000_000)throw new Error();
              chunks.push(Buffer.from(buffer.subarray(0,bytesRead)));
            }
          }finally{await handle.close();}
          const content=Buffer.concat(chunks);
          files.set(relative(root,path).split(sep).join("/"),
            new TextDecoder("utf-8",{fatal:true}).decode(content));
        }else if(!entry.isFile())throw new Error();
      }
    };
    await collect(root,0);
    if(!files.size)throw new Error();
    return files;
  }catch{throw new Error("JAVA_SOURCE_BOUNDARY_OR_LIMIT");}
};
