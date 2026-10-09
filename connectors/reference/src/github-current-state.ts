import {isProxy} from "node:util/types";
import {parseStrictJson} from "../../../packages/ir/src/strict-json.js";

const ORIGIN="https://api.github.com";
const API_VERSION="2026-03-10";
const SHA=/^[0-9a-f]{40}$/;
const BRANCH=/^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const REPOSITORY_PART=/^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

export class GitHubCurrentStateError extends Error {
  readonly code:"GITHUB_CURRENT_STATE_INVALID_CONFIGURATION"|"GITHUB_CURRENT_STATE_INVALID_REQUEST"|
    "GITHUB_CURRENT_STATE_UNAVAILABLE"|"GITHUB_CURRENT_STATE_INVALID_RESPONSE"|
    "GITHUB_CURRENT_STATE_RESPONSE_TOO_LARGE"|"GITHUB_CURRENT_STATE_TIMEOUT";
  constructor(code:GitHubCurrentStateError["code"]){super(code);this.name="GitHubCurrentStateError";this.code=code;}
}
const fail=(code:GitHubCurrentStateError["code"]):never=>{throw new GitHubCurrentStateError(code);};
const plain=(input:unknown):Record<string,PropertyDescriptor>|undefined=>{
  try{
    if(!input||typeof input!=="object"||Array.isArray(input)||isProxy(input)
      ||Object.getPrototypeOf(input)!==Object.prototype)return undefined;
    const fields=Object.getOwnPropertyDescriptors(input);
    if(Reflect.ownKeys(input).some(key=>typeof key!=="string")
      ||Object.values(fields).some(field=>!("value" in field)||!field.enumerable))return undefined;
    return fields;
  }catch{return undefined;}
};
const field=(fields:Record<string,PropertyDescriptor>,key:string):unknown=>fields[key]?.value;
const keys=(fields:Record<string,PropertyDescriptor>,required:readonly string[],optional:readonly string[]=[])=>
  required.every(key=>Object.hasOwn(fields,key))
  &&Object.keys(fields).every(key=>required.includes(key)||optional.includes(key));
const name=(value:unknown):value is string=>typeof value==="string"&&value.length>0&&value.length<=128
  &&/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
const branch=(value:unknown):value is string=>typeof value==="string"&&value.length<=255&&BRANCH.test(value)
  &&!value.includes("..")&&!value.includes("//")&&!value.endsWith("/")&&!value.endsWith(".lock")
  &&!value.includes("@{");
const branches=(input:unknown):string[]|undefined=>{
  if(!Array.isArray(input)||isProxy(input)||Object.getPrototypeOf(input)!==Array.prototype
    ||input.length<1||input.length>256||Reflect.ownKeys(input).length!==input.length+1)return undefined;
  const result:string[]=[];
  for(let index=0;index<input.length;index++){
    const item=Object.getOwnPropertyDescriptor(input,String(index));
    if(!item||!("value" in item)||!item.enumerable||!branch(item.value))return undefined;
    result.push(item.value);
  }
  return new Set(result).size===result.length?result:undefined;
};
const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==="object"&&!Array.isArray(value);
const boundedNumber=(value:unknown):value is number=>typeof value==="number"&&Number.isSafeInteger(value)&&value>=0;

export type GitHubCurrentStateBinding=Readonly<{
  tenantId:string;repositoryId:string;githubRepositoryId:number;fullName:string;intendedBranches:readonly string[];
  /** Trusted host resolver for a repository-bound, Contents-read installation token. */
  resolveToken:()=>Promise<string>;
  /** Injected transport for deterministic offline tests; defaults to global fetch. */
  fetch?:typeof fetch;timeoutMs?:number;maxResponseBytes?:number;
}>;
export type GitHubExactBranchRequest=Readonly<{tenantId:string;repositoryId:string;branch:string;
  compareWithRevision?:string}>;
export type GitHubCurrentBranchResult=
  |Readonly<{state:"present";immutableRevision:string;
    providerEvidence:Readonly<{provider:"github";provider_reference:string}>;
    ancestry?:Readonly<{baseRevision:string;headRevision:string;relation:"identical"|"ahead"|"behind"|"diverged"}>}>
  |Readonly<{state:"unknown";reason:"unconfirmed_absence"}>;

/** A fixed-origin current-state reader. A GitHub 404 never proves branch deletion here. */
export const createGitHubCurrentStateReader=(optionsInput:GitHubCurrentStateBinding)=>{
  const options=plain(optionsInput),required=["tenantId","repositoryId","githubRepositoryId","fullName",
    "intendedBranches","resolveToken"];
  if(!options||!keys(options,required,["fetch","timeoutMs","maxResponseBytes"]))
    throw new GitHubCurrentStateError("GITHUB_CURRENT_STATE_INVALID_CONFIGURATION");
  const tenantId=field(options,"tenantId"),repositoryId=field(options,"repositoryId");
  const githubRepositoryId=field(options,"githubRepositoryId"),fullName=field(options,"fullName");
  const intendedBranches=branches(field(options,"intendedBranches"));
  const resolveToken=field(options,"resolveToken"),transport=field(options,"fetch")??globalThis.fetch;
  const timeoutMs=field(options,"timeoutMs")??10_000,maxResponseBytes=field(options,"maxResponseBytes")??65_536;
  const names=typeof fullName==="string"?fullName.split("/"):[];
  if(!name(tenantId)||!name(repositoryId)||!Number.isSafeInteger(githubRepositoryId)||Number(githubRepositoryId)<1
    ||typeof fullName!=="string"||fullName.length>255||names.length!==2
    ||names.some(part=>!REPOSITORY_PART.test(part)||part.includes(".."))||!intendedBranches
    ||typeof resolveToken!=="function"||typeof transport!=="function"
    ||!Number.isSafeInteger(timeoutMs)||Number(timeoutMs)<1||Number(timeoutMs)>30_000
    ||!Number.isSafeInteger(maxResponseBytes)||Number(maxResponseBytes)<1||Number(maxResponseBytes)>131_072)
    throw new GitHubCurrentStateError("GITHUB_CURRENT_STATE_INVALID_CONFIGURATION");
  const fixed={tenantId,repositoryId,githubRepositoryId:githubRepositoryId as number,
    fullName:fullName as string,intendedBranches:Object.freeze(intendedBranches),
    resolveToken:resolveToken as GitHubCurrentStateBinding["resolveToken"],fetch:transport as typeof fetch,
    timeoutMs:timeoutMs as number,maxResponseBytes:maxResponseBytes as number};

  return Object.freeze({async readExactBranch(input:GitHubExactBranchRequest):Promise<GitHubCurrentBranchResult>{
    const fields=plain(input);
    if(!fields||!keys(fields,["tenantId","repositoryId","branch"],["compareWithRevision"]))
      throw new GitHubCurrentStateError("GITHUB_CURRENT_STATE_INVALID_REQUEST");
    const tenant=field(fields,"tenantId"),repository=field(fields,"repositoryId");
    const selected=field(fields,"branch"),prior=field(fields,"compareWithRevision");
    if(tenant!==fixed.tenantId||repository!==fixed.repositoryId||!branch(selected)
      ||!fixed.intendedBranches.includes(selected)||prior!==undefined&&(typeof prior!=="string"||!SHA.test(prior)))
      throw new GitHubCurrentStateError("GITHUB_CURRENT_STATE_INVALID_REQUEST");
    const controller=new AbortController();
    let timedOut=false;
    let rejectDeadline:(error:GitHubCurrentStateError)=>void=()=>{};
    const deadlinePromise=new Promise<never>((_resolve,reject)=>{rejectDeadline=reject;});
    const timer=setTimeout(()=>{timedOut=true;controller.abort();
      rejectDeadline(new GitHubCurrentStateError("GITHUB_CURRENT_STATE_TIMEOUT"));},fixed.timeoutMs);
    const bounded=<T>(promise:Promise<T>):Promise<T>=>Promise.race([promise,deadlinePromise]);
    const deadline=Date.now()+fixed.timeoutMs;
    try{
      let token:unknown;
      try{token=await bounded(fixed.resolveToken());}
      catch{throw new GitHubCurrentStateError(timedOut?"GITHUB_CURRENT_STATE_TIMEOUT":"GITHUB_CURRENT_STATE_UNAVAILABLE");}
      if(typeof token!=="string"||token.length<1||token.length>4096||!/^[A-Za-z0-9._-]+$/.test(token))
        fail("GITHUB_CURRENT_STATE_UNAVAILABLE");
      const request=async(path:string,allowNotFound=false):Promise<{status:"found";value:unknown}|{status:"not_found"}>=>{
        if(timedOut||Date.now()>=deadline)fail("GITHUB_CURRENT_STATE_TIMEOUT");
        let response:Response;
        try{response=await bounded(fixed.fetch(`${ORIGIN}${path}`,{method:"GET",redirect:"error",cache:"no-store",
          credentials:"omit",referrerPolicy:"no-referrer",signal:controller.signal,
          headers:{Accept:"application/vnd.github+json",Authorization:`Bearer ${token}`,
            "X-GitHub-Api-Version":API_VERSION}}));}
        catch{throw new GitHubCurrentStateError(timedOut?"GITHUB_CURRENT_STATE_TIMEOUT":"GITHUB_CURRENT_STATE_UNAVAILABLE");}
        const discard=()=>{try{if(response.body)void response.body.cancel().catch(()=>{});}catch{/* Fixed error below. */}};
        if(timedOut||Date.now()>=deadline){discard();fail("GITHUB_CURRENT_STATE_TIMEOUT");}
        if(response.status===404&&allowNotFound){discard();return {status:"not_found"};}
        if(response.status!==200){discard();fail("GITHUB_CURRENT_STATE_UNAVAILABLE");}
        if(!response.body)throw new GitHubCurrentStateError("GITHUB_CURRENT_STATE_INVALID_RESPONSE");
        let reader:ReadableStreamDefaultReader<Uint8Array>;
        try{reader=response.body.getReader();}
        catch{throw new GitHubCurrentStateError("GITHUB_CURRENT_STATE_INVALID_RESPONSE");}
        const chunks:Uint8Array[]=[];let bytes=0;
        try{
          for(;;){
            if(timedOut||Date.now()>=deadline)fail("GITHUB_CURRENT_STATE_TIMEOUT");
            const {done,value}=await bounded(reader.read());
            if(done)break;
            bytes+=value.byteLength;
            if(bytes>fixed.maxResponseBytes)fail("GITHUB_CURRENT_STATE_RESPONSE_TOO_LARGE");
            chunks.push(value);
          }
        }catch(error){
          if(error instanceof GitHubCurrentStateError)throw error;
          fail(timedOut?"GITHUB_CURRENT_STATE_TIMEOUT":"GITHUB_CURRENT_STATE_UNAVAILABLE");
        }finally{void reader.cancel().catch(()=>{});}
        const body=Buffer.concat(chunks.map(chunk=>Buffer.from(chunk)),bytes);
        let value:unknown;
        try{value=parseStrictJson(new TextDecoder("utf-8",{fatal:true}).decode(body),{maxDepth:32,maxNodes:5_000});}
        catch{fail("GITHUB_CURRENT_STATE_INVALID_RESPONSE");}
        return {status:"found",value};
      };
      const base=`/repos/${names.map(encodeURIComponent).join("/")}`;
      const repositoryResponse=await request(base);
      if(repositoryResponse.status!=="found"||!record(repositoryResponse.value)
        ||repositoryResponse.value.id!==fixed.githubRepositoryId
        ||repositoryResponse.value.full_name!==fixed.fullName)
        throw new GitHubCurrentStateError("GITHUB_CURRENT_STATE_INVALID_RESPONSE");
      const refName=`refs/heads/${selected}`;
      const refResponse=await request(`${base}/git/ref/heads/${selected.split("/").map(encodeURIComponent).join("/")}`,true);
      if(refResponse.status==="not_found")return Object.freeze({state:"unknown",reason:"unconfirmed_absence"});
      const ref=refResponse.value;
      if(!record(ref)||ref.ref!==refName||!record(ref.object)||ref.object.type!=="commit"
        ||typeof ref.object.sha!=="string"||!SHA.test(ref.object.sha))
        throw new GitHubCurrentStateError("GITHUB_CURRENT_STATE_INVALID_RESPONSE");
      const immutableRevision=ref.object.sha;
      const providerEvidence=Object.freeze({provider:"github" as const,
        provider_reference:`ref:${fixed.githubRepositoryId}:${selected}:${immutableRevision}`});
      if(prior===undefined)return Object.freeze({state:"present",immutableRevision,providerEvidence});
      const compare=await request(`${base}/compare/${prior}...${immutableRevision}?per_page=1`);
      if(compare.status!=="found"||!record(compare.value)||!record(compare.value.base_commit)
        ||compare.value.base_commit.sha!==prior
        ||Object.hasOwn(compare.value,"head_commit")&&(!record(compare.value.head_commit)
          ||compare.value.head_commit.sha!==immutableRevision)
        ||!boundedNumber(compare.value.ahead_by)||!boundedNumber(compare.value.behind_by))
        throw new GitHubCurrentStateError("GITHUB_CURRENT_STATE_INVALID_RESPONSE");
      const status=compare.value.status,ahead=compare.value.ahead_by,behind=compare.value.behind_by;
      const same=prior===immutableRevision;
      const relation=status==="identical"&&same&&ahead===0&&behind===0?"identical"
        :status==="ahead"&&!same&&ahead>0&&behind===0?"ahead"
          :status==="behind"&&!same&&ahead===0&&behind>0?"behind"
            :status==="diverged"&&!same&&ahead>0&&behind>0?"diverged":undefined;
      if(!relation)throw new GitHubCurrentStateError("GITHUB_CURRENT_STATE_INVALID_RESPONSE");
      return Object.freeze({state:"present",immutableRevision,providerEvidence,
        ancestry:Object.freeze({baseRevision:prior,headRevision:immutableRevision,relation})});
    }finally{clearTimeout(timer);}
  }});
};
