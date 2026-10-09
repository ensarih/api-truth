import {createHash,randomUUID} from "node:crypto";
import {execFile as execFileCallback} from "node:child_process";
import {createReadStream,createWriteStream} from "node:fs";
import {lstat,mkdir,opendir,realpath,rename,rm,stat} from "node:fs/promises";
import {dirname,join,relative,resolve,sep} from "node:path";
import {fileURLToPath} from "node:url";
import {promisify} from "node:util";
import {Readable,Transform} from "node:stream";
import {pipeline} from "node:stream/promises";
import {checkPinnedJava,javaHomePath,runtimePaths,selectPlatform} from "./java-test-environment-lib.mjs";

const execFile=promisify(execFileCallback);
export const JAVAPARSER_VERSION="3.28.2";
export const JAVAPARSER_SHA256="b5499a3b1c40b16c0671fabe478c9aafeab38160c6fde74a6c13f42d86716ecd";
export const HELPER_SHA256="a1047f9e589e5b04b43ca60d04004f04bf992d68863600eae8652104466f08b2";
export const HELPER_CLASSES=Object.freeze([Object.freeze({name:"apitruth/AstExtract.class",
  sha256:"c6a73564798dfbdbcaa128cac732b58218aa76ccf2db56f497544f56514ffcd4"})]);
const ARTIFACT=`javaparser-core-${JAVAPARSER_VERSION}.jar`;
const URL=`https://repo.maven.apache.org/maven2/com/github/javaparser/javaparser-core/${JAVAPARSER_VERSION}/${ARTIFACT}`;
const repoRoot=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const helperSource=join(repoRoot,"analyzers","java-spring","java","AstExtract.java");
const hash=value=>createHash("sha256").update(value).digest("hex");
const fail=()=>{throw new Error("java_toolchain_unavailable");};
const paths=root=>{const cache=join(root,".cache","java-spring","parser-3.28.2");
  return {cache,jar:join(cache,ARTIFACT),classes:join(cache,"classes")};};
const noLinks=async(root,target)=>{
  const rel=relative(root,target);
  if(rel===".."||rel.startsWith(`..${sep}`)||rel===""||rel.startsWith(sep))fail();
  let current=root;
  for(const component of rel.split(sep)){
    current=join(current,component);
    try{if((await lstat(current)).isSymbolicLink())fail();}
    catch(error){if(error?.code==="ENOENT")break;throw error;}
  }
};
const fileDigest=async(path,max)=>{
  const info=await stat(path);
  if(!info.isFile()||info.size>max||info.size<1)fail();
  const digest=createHash("sha256");let bytes=0;
  for await(const chunk of createReadStream(path)){
    bytes+=chunk.length;if(bytes>max)fail();digest.update(chunk);
  }
  if(bytes<1)fail();
  return digest.digest("hex");
};
const manifest=async(classes)=>{
  const files=[];let entriesSeen=0;
  const visit=async(dir,depth)=>{
    if(depth>16)fail();
    for await(const entry of await opendir(dir)){
      entriesSeen++;if(entriesSeen>200)fail();
      const path=join(dir,entry.name),name=relative(classes,path).split(sep).join("/");
      if(entry.isDirectory())await visit(path,depth+1);
      else if(entry.isFile()&&name.endsWith(".class"))files.push({name,sha256:await fileDigest(path,2*1024*1024)});
      else fail();
    }
  };
  await visit(classes,0);
  if(!files.length)fail();
  return files.sort((a,b)=>a.name.localeCompare(b.name));
};
const javaBins=async(root)=>{
  const platform=selectPlatform();
  await checkPinnedJava({repoRoot:root});
  const home=javaHomePath(runtimePaths(root,platform).root,platform);
  return {java:join(home,"bin","java"),javac:join(home,"bin","javac")};
};
const compile=async(javac,jar,output)=>{
  await mkdir(output,{recursive:false,mode:0o700});
  await execFile(javac,["-proc:none","--release","21","-cp",jar,"-d",output,helperSource],
    {timeout:60_000,maxBuffer:128*1024,env:{PATH:"/usr/bin:/bin",LANG:"C"}});
};
const download=async(path)=>{
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),30_000);
  try{
    const response=await fetch(URL,{redirect:"error",signal:controller.signal});
    if(!response.ok||!response.body||response.url!==URL)fail();
    let bytes=0;
    const bound=new Transform({transform(chunk,_encoding,callback){
      bytes+=chunk.length;callback(bytes>5*1024*1024?new Error("large"):null,chunk);
    }});
    await pipeline(Readable.fromWeb(response.body),bound,createWriteStream(path,{flags:"wx",mode:0o600}),
      {signal:controller.signal});
    if(await fileDigest(path,5*1024*1024)!==JAVAPARSER_SHA256)fail();
  }finally{clearTimeout(timer);}
};
export async function upJavaParserToolchain(root=repoRoot){
  const repo=await realpath(root),target=paths(repo);
  const {javac}=await javaBins(repo);
  await noLinks(repo,target.cache);
  await mkdir(dirname(target.cache),{recursive:true,mode:0o700});
  await noLinks(repo,target.cache);
  try{await lstat(target.cache);fail();}catch(error){if(error?.code!=="ENOENT")throw error;}
  const staging=join(dirname(target.cache),`.parser-${randomUUID()}`);
  try{
    await mkdir(staging,{mode:0o700});
    const staged=paths(repo);
    await download(join(staging,ARTIFACT));
    await compile(javac,join(staging,ARTIFACT),join(staging,"classes"));
    if(await fileDigest(helperSource,128*1024)!==HELPER_SHA256
      ||JSON.stringify(await manifest(join(staging,"classes")))!==JSON.stringify(HELPER_CLASSES))fail();
    await rename(staging,staged.cache);
    return await checkJavaParserToolchain(repo,false);
  }catch{await rm(staging,{recursive:true,force:true}).catch(()=>{});fail();}
}
export async function verifyPinnedParserArtifacts(root=repoRoot){
  const repo=await realpath(root),target=paths(repo);
  await noLinks(repo,target.cache);
  for(const item of [target.jar,target.classes])await noLinks(repo,item);
  try{
    if(await fileDigest(helperSource,128*1024)!==HELPER_SHA256
      ||await fileDigest(target.jar,5*1024*1024)!==JAVAPARSER_SHA256
      ||JSON.stringify(await manifest(target.classes))!==JSON.stringify(HELPER_CLASSES))fail();
    return {jar:target.jar,classes:target.classes};
  }catch{fail();}
}
export async function checkJavaParserToolchain(root=repoRoot,rebuild=true){
  const repo=await realpath(root),{jar,classes}=await verifyPinnedParserArtifacts(repo);
  const {java,javac}=await javaBins(repo);
  try{
    if(rebuild){
      const temporary=join(dirname(classes),`.verify-${randomUUID()}`);
      try{await compile(javac,jar,temporary);
        if(JSON.stringify(await manifest(temporary))!==JSON.stringify(HELPER_CLASSES))fail();}
      finally{await rm(temporary,{recursive:true,force:true}).catch(()=>{});}
    }
    return {java,jar,classes,version:JAVAPARSER_VERSION};
  }catch{fail();}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    const command=process.argv[2];
    if(command==="up")await upJavaParserToolchain();
    else if(command==="ready")await checkJavaParserToolchain();
    else throw new Error();
    process.stdout.write(`JavaParser ${JAVAPARSER_VERSION} ready in the project cache.\n`);
  }catch{process.stderr.write("Pinned Java parser toolchain is unavailable or invalid.\n");process.exitCode=1;}
}
