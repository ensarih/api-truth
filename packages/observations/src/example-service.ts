import {isProxy} from "node:util/types";
import {parseQuerySelection,type QueryReader,type QuerySelection,type QueryContractResult} from "../../query/src/index.js";
import {buildSyntheticExample,type SyntheticExamplePolicy,
  type SyntheticExampleResult} from "./examples.js";

export class SyntheticExampleServiceError extends Error {
  readonly code:"EXAMPLE_INVALID_CONFIGURATION"|"EXAMPLE_INVALID_REQUEST"|
    "EXAMPLE_NOT_FOUND_OR_DENIED"|"EXAMPLE_STALE_CONTEXT"|"EXAMPLE_STORAGE_ERROR";
  constructor(code:SyntheticExampleServiceError["code"]){super(code);this.name="SyntheticExampleServiceError";this.code=code;}
}
const error=(code:SyntheticExampleServiceError["code"]):never=>{throw new SyntheticExampleServiceError(code);};
const id=(value:unknown):value is string=>typeof value==="string"&&value.length>0&&value.length<=512
  &&!/[\u0000-\u001f\u007f]/.test(value);
const policyId=(value:unknown):value is string=>typeof value==="string"&&value.length<=128
  &&/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
const fields=(input:unknown,names:readonly string[]):Record<string,unknown>|undefined=>{
  try{
    if(!input||typeof input!=="object"||Array.isArray(input)||isProxy(input)
      ||Object.getPrototypeOf(input)!==Object.prototype)return undefined;
    const own=Reflect.ownKeys(input);
    if(own.length!==names.length||own.some(key=>typeof key!=="string"||!names.includes(key)))return undefined;
    const out:Record<string,unknown>={};
    for(const name of names){const descriptor=Object.getOwnPropertyDescriptor(input,name);
      if(!descriptor||!descriptor.enumerable||!("value" in descriptor))return undefined;
      Object.defineProperty(out,name,{value:descriptor.value,enumerable:true,writable:true,configurable:true});}
    return out;
  }catch{return undefined;}
};
const array=(input:unknown,max:number):unknown[]|undefined=>{
  try{
    if(!Array.isArray(input)||isProxy(input)||Object.getPrototypeOf(input)!==Array.prototype
      ||input.length>max||Reflect.ownKeys(input).length!==input.length+1)return undefined;
    const out:unknown[]=[];
    for(let index=0;index<input.length;index++){
      const descriptor=Object.getOwnPropertyDescriptor(input,String(index));
      if(!descriptor||!descriptor.enumerable||!("value" in descriptor))return undefined;
      out.push(descriptor.value);
    }
    return out;
  }catch{return undefined;}
};

export type SyntheticExamplePolicyBinding=Readonly<{policyId:string;tenantId:string;repositoryId:string;
  serviceId:string;environment:string;policy:SyntheticExamplePolicy}>;
type Request=Readonly<{selection:QuerySelection;policyId:string}>;
type Context=Readonly<{tenantId:string;principalId:string}>;
const parseSelection=(input:unknown):QuerySelection=>{
  const outer=fields(input,["version","tenantId","repositoryId","serviceId","selector"]);
  const selector=outer&&fields(outer.selector,["kind","environment","expectedCheckpointVersion"]);
  if(!outer||!selector)return error("EXAMPLE_INVALID_REQUEST");
  try{
    const parsed=parseQuerySelection({...outer,selector});
    if(parsed.selector.kind!=="environment"||!parsed.selector.expectedCheckpointVersion)
      return error("EXAMPLE_INVALID_REQUEST");
    return parsed;
  }catch{return error("EXAMPLE_INVALID_REQUEST");}
};
const parseRequest=(contextInput:unknown,requestInput:unknown):{context:Context;request:Request}=>{
  const context=fields(contextInput,["tenantId","principalId"]),request=fields(requestInput,["selection","policyId"]);
  if(!context||!id(context.tenantId)||!id(context.principalId)||!request||!policyId(request.policyId))
    return error("EXAMPLE_INVALID_REQUEST");
  const selection=parseSelection(request.selection);
  if(selection.tenantId!==context.tenantId)return error("EXAMPLE_INVALID_REQUEST");
  return {context:Object.freeze({tenantId:context.tenantId,principalId:context.principalId}),
    request:Object.freeze({selection,policyId:request.policyId})};
};
const parsePolicy=(input:unknown):SyntheticExamplePolicy=>{
  const hasStatus=!!input&&typeof input==="object"&&!isProxy(input)&&Object.hasOwn(input,"statusCode");
  const policy=fields(input,["version","endpointId","direction","mediaType","propertyPaths",
    ...(hasStatus?["statusCode"]:[])]);
  if(!policy||policy.version!=="synthetic-examples-1"||!id(policy.endpointId)
    ||(policy.direction!=="request"&&policy.direction!=="response")||!id(policy.mediaType)
    ||typeof policy.mediaType!=="string"||policy.mediaType.length>128
    ||!/^application\/(?:[a-z0-9.+-]+\+)?json$/i.test(policy.mediaType)
    ||policy.direction==="request"&&hasStatus
    ||policy.direction==="response"&&(!Number.isInteger(policy.statusCode)
      ||Number(policy.statusCode)<100||Number(policy.statusCode)>599))return error("EXAMPLE_INVALID_CONFIGURATION");
  const paths=array(policy.propertyPaths,64);
  if(!paths||paths.some(path=>typeof path!=="string"||path.length<2||path.length>1024
    ||!path.startsWith("/")||/[\u0000-\u001f\u007f]/.test(path)
    ||path.slice(1).split("/").length>16||path.slice(1).split("/").some(segment=>
      !segment||segment.length>256||/~(?![01])/.test(segment)))
    ||new Set(paths).size!==paths.length)return error("EXAMPLE_INVALID_CONFIGURATION");
  return Object.freeze({version:"synthetic-examples-1",endpointId:policy.endpointId,
    direction:policy.direction,mediaType:policy.mediaType,propertyPaths:Object.freeze(paths as string[]),
    ...(hasStatus?{statusCode:policy.statusCode as number}:{})});
};
const parseBinding=(input:unknown):SyntheticExamplePolicyBinding=>{
  const value=fields(input,["policyId","tenantId","repositoryId","serviceId","environment","policy"]);
  if(!value||!policyId(value.policyId)||!id(value.tenantId)||!id(value.repositoryId)
    ||!id(value.serviceId)||!id(value.environment))return error("EXAMPLE_INVALID_CONFIGURATION");
  return Object.freeze({policyId:value.policyId,tenantId:value.tenantId,repositoryId:value.repositoryId,
    serviceId:value.serviceId,environment:value.environment,policy:parsePolicy(value.policy)});
};
const samePin=(a:Extract<QueryContractResult,{status:"resolved"}>,
  b:Extract<QueryContractResult,{status:"resolved"}>):boolean=>
  a.pin.snapshotId===b.pin.snapshotId&&a.pin.revision===b.pin.revision
  &&a.pin.selectedRevision===b.pin.selectedRevision
  &&a.pin.configFingerprint===b.pin.configFingerprint
  &&a.pin.checkpointVersion===b.pin.checkpointVersion
  &&a.pin.pointerVersion===b.pin.pointerVersion
  &&a.snapshot.source.source_digest===b.snapshot.source.source_digest;
const withheld: SyntheticExampleResult=Object.freeze({status:"withheld",
  diagnostics:Object.freeze([Object.freeze({ruleId:"policy_not_configured",count:1})])});

/** Uses only an authorized reader result and a detached host policy; there is no traffic or model input. */
export const createSyntheticExampleService=(optionsInput:{queryReader:Pick<QueryReader,"readContract">;
  policies:readonly SyntheticExamplePolicyBinding[]})=>{
  const options=fields(optionsInput,["queryReader","policies"]);
  let read:QueryReader["readContract"]|undefined;
  try{
    const reader=options?.queryReader;
    if(reader&&typeof reader==="object"&&!Array.isArray(reader)&&!isProxy(reader)
      &&Object.getPrototypeOf(reader)===Object.prototype){
      const descriptor=Object.getOwnPropertyDescriptor(reader,"readContract");
      if(descriptor&&"value" in descriptor&&typeof descriptor.value==="function")read=descriptor.value;
    }
  }catch{/* Invalid host configuration below. */}
  const configured=options&&array(options.policies,256);
  if(!read||!configured)
    return error("EXAMPLE_INVALID_CONFIGURATION");
  const fixedRead=read;
  const bindings=configured.map(parseBinding);
  if(new Set(bindings.map(item=>JSON.stringify([item.tenantId,item.repositoryId,item.serviceId,
    item.environment,item.policyId]))).size!==bindings.length)return error("EXAMPLE_INVALID_CONFIGURATION");
  const readAuthorized=async(context:Context,selection:QuerySelection):Promise<QueryContractResult>=>{
    try{return await fixedRead(context,selection);}
    catch(error){
      const code=error&&typeof error==="object"&&!isProxy(error)
        ?Object.getOwnPropertyDescriptor(error,"code")?.value:undefined;
      if(code==="QUERY_NOT_FOUND_OR_DENIED")return errorService("EXAMPLE_NOT_FOUND_OR_DENIED");
      if(code==="QUERY_STALE_SELECTION")return errorService("EXAMPLE_STALE_CONTEXT");
      return errorService("EXAMPLE_STORAGE_ERROR");
    }
  };
  return Object.freeze({async generate(contextInput:unknown,requestInput:unknown):Promise<SyntheticExampleResult>{
    const {context,request}=parseRequest(contextInput,requestInput);
    const before=await readAuthorized(context,request.selection);
    if(before.status!=="resolved")return error("EXAMPLE_NOT_FOUND_OR_DENIED");
    const selector=request.selection.selector;
    if(selector.kind!=="environment"||before.pin.checkpointVersion!==selector.expectedCheckpointVersion)
      return error("EXAMPLE_STALE_CONTEXT");
    if(Object.hasOwn(before.pin,"selectedRevision"))return Object.freeze({status:"withheld",
      diagnostics:Object.freeze([Object.freeze({ruleId:"qualified_revision_unsupported",count:1})])});
    const policy=bindings.find(item=>item.policyId===request.policyId&&item.tenantId===request.selection.tenantId
      &&item.repositoryId===request.selection.repositoryId&&item.serviceId===request.selection.serviceId
      &&item.environment===selector.environment);
    if(!policy)return withheld;
    let candidate:SyntheticExampleResult;
    try{candidate=buildSyntheticExample(before,policy.policy.endpointId,policy.policy);}
    catch{ return error("EXAMPLE_STORAGE_ERROR"); }
    const after=await readAuthorized(context,request.selection);
    if(after.status!=="resolved")return error("EXAMPLE_NOT_FOUND_OR_DENIED");
    if(!samePin(before,after))return error("EXAMPLE_STALE_CONTEXT");
    return candidate;
  }});
};
const errorService=(code:SyntheticExampleServiceError["code"]):never=>{throw new SyntheticExampleServiceError(code);};
