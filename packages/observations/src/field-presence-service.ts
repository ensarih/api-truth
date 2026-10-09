import {isProxy} from "node:util/types";
import {parseContractSnapshot, type ContractSnapshot} from "../../ir/src/index.js";
import {parseQuerySelection, type QueryReader, type QuerySelection} from "../../query/src/index.js";
import {projectObservedFieldPresence, type FieldPresenceResult} from "./field-presence.js";

export type FieldPresenceSelectorPolicy=Readonly<{version:"observed-field-presence-1";endpointId:string;
  direction:"request"|"response";mediaType:string;propertyPaths:readonly string[];statusCode?:number}>;
export type FieldPresencePolicyBinding=Readonly<{policyId:string;tenantId:string;repositoryId:string;serviceId:string;
  environment:string;policy:FieldPresenceSelectorPolicy}>;
export type FieldPresenceSourcePin=Readonly<{tenantId:string;repositoryId:string;serviceId:string;environment:string;
  snapshotId:string;revision:string;sourceDigest:string;configFingerprint:string;checkpointVersion:string;pointerVersion?:string}>;
export type FieldPresenceAttestation=Readonly<{observationId:string;endpointId:string;direction:"request"|"response";
  mediaType:string;statusCode?:number}&FieldPresenceSourcePin>;
export type FieldPresenceRead=Readonly<{attestation:FieldPresenceAttestation;payloadText:string;
  payloadCompleteness:"complete_unredacted"|"truncated"|"redacted"|"unknown"}>;
export type FieldPresenceContext=Readonly<{tenantId:string;principalId:string}>;
/** Trusted host transaction: atomically verify the expected current pin and catalog/source/record/policy grants.
 * The final invocation is the result's authority boundary; a source-only permission check is insufficient.
 */
export type FieldPresenceAuthorization=(context:FieldPresenceContext,pin:FieldPresenceSourcePin,binding:FieldPresencePolicyBinding,
  observationId:string,signal:AbortSignal)=>Promise<boolean>;
export type FieldPresenceReadPort=(context:FieldPresenceContext,pin:FieldPresenceSourcePin,observationId:string,
  binding:FieldPresencePolicyBinding,signal:AbortSignal)=>Promise<unknown>;

export class FieldPresenceServiceError extends Error {
  readonly code:"FIELD_PRESENCE_INVALID_CONFIGURATION"|"FIELD_PRESENCE_INVALID_REQUEST"|
    "FIELD_PRESENCE_NOT_FOUND_OR_DENIED"|"FIELD_PRESENCE_STALE_CONTEXT"|"FIELD_PRESENCE_STORAGE_ERROR";
  constructor(code:FieldPresenceServiceError["code"]){super(code);this.name="FieldPresenceServiceError";this.code=code;}
}
const error=(code:FieldPresenceServiceError["code"]):never=>{throw new FieldPresenceServiceError(code);};
const safeText=(value:unknown,max=512):value is string=>typeof value==="string"&&value.length>0&&value.length<=max
  &&!/[\u0000-\u001f\u007f]/.test(value);
const plain=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==="object"&&!Array.isArray(value)
  &&!isProxy(value)&&(Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null);
const fields=(value:unknown,names:readonly string[]):Record<string,unknown>|undefined=>{
  try{
    if(!plain(value))return undefined;
    const keys=Reflect.ownKeys(value);
    if(keys.length!==names.length||keys.some(key=>typeof key!=="string"||!names.includes(key)))return undefined;
    const result:Record<string,unknown>={};
    for(const name of names){const descriptor=Object.getOwnPropertyDescriptor(value,name);
      if(!descriptor||!descriptor.enumerable||!("value" in descriptor))return undefined;
      Object.defineProperty(result,name,{value:descriptor.value,enumerable:true,writable:true,configurable:true});}
    return result;
  }catch{return undefined;}
};
const safeArray=(value:unknown,max:number):unknown[]|undefined=>{
  try{
    if(!Array.isArray(value)||isProxy(value)||Object.getPrototypeOf(value)!==Array.prototype||value.length>max
      ||Reflect.ownKeys(value).length!==value.length+1)return undefined;
    const result:unknown[]=[];
    for(let i=0;i<value.length;i++){const descriptor=Object.getOwnPropertyDescriptor(value,String(i));
      if(!descriptor||!descriptor.enumerable||!("value" in descriptor))return undefined;result.push(descriptor.value);}
    return result;
  }catch{return undefined;}
};
const cloneInert=(root:unknown):unknown=>{
  let nodes=0,bytes=0;const seen=new Set<object>();
  const visit=(value:unknown,depth:number):unknown=>{
    if(++nodes>100_000||depth>64)return error("FIELD_PRESENCE_STORAGE_ERROR");
    if(value===null||typeof value==="boolean")return value;
    if(typeof value==="string"){bytes+=Buffer.byteLength(value,"utf8");if(bytes>4*1024*1024)return error("FIELD_PRESENCE_STORAGE_ERROR");return value;}
    if(typeof value==="number"){if(!Number.isFinite(value))return error("FIELD_PRESENCE_STORAGE_ERROR");return value;}
    if(typeof value!=="object"||isProxy(value)||seen.has(value))return error("FIELD_PRESENCE_STORAGE_ERROR");
    seen.add(value);
    if(Array.isArray(value)){
      if(Object.getPrototypeOf(value)!==Array.prototype||value.length>20_000)return error("FIELD_PRESENCE_STORAGE_ERROR");
      const descriptors=Object.getOwnPropertyDescriptors(value);
      if(Reflect.ownKeys(descriptors).length!==value.length+1)return error("FIELD_PRESENCE_STORAGE_ERROR");
      const output:unknown[]=[];
      for(let i=0;i<value.length;i++){const descriptor=descriptors[String(i)];
        if(!descriptor||!("value" in descriptor))return error("FIELD_PRESENCE_STORAGE_ERROR");
        output.push(visit(descriptor.value,depth+1));}
      seen.delete(value);return output;
    }
    if(!plain(value))return error("FIELD_PRESENCE_STORAGE_ERROR");
    const descriptors=Object.getOwnPropertyDescriptors(value),keys=Reflect.ownKeys(descriptors);
    if(keys.length>20_000||keys.some(key=>typeof key!=="string"))return error("FIELD_PRESENCE_STORAGE_ERROR");
    const output:Record<string,unknown>={};
    for(const key of keys as string[]){bytes+=Buffer.byteLength(key,"utf8");if(bytes>4*1024*1024)return error("FIELD_PRESENCE_STORAGE_ERROR");
      const descriptor=descriptors[key]!;if(!("value" in descriptor))return error("FIELD_PRESENCE_STORAGE_ERROR");
      Object.defineProperty(output,key,{value:visit(descriptor.value,depth+1),enumerable:true,writable:true,configurable:true});}
    seen.delete(value);return output;
  };
  return visit(root,0);
};
const pointer=(value:unknown):value is string=>typeof value==="string"&&value.length>=2&&value.length<=512
  &&value.startsWith("/")&&value.slice(1).split("/").length<=12
  &&value.slice(1).split("/").every(segment=>segment.length>0&&segment.length<=128&&!/~(?![01])/.test(segment));
const parseBinding=(input:unknown):FieldPresencePolicyBinding=>{
  const binding=fields(input,["policyId","tenantId","repositoryId","serviceId","environment","policy"]);
  if(!binding||!safeText(binding.policyId,128)||! /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(binding.policyId)
    ||![binding.tenantId,binding.repositoryId,binding.serviceId,binding.environment].every(value=>safeText(value)))
    return error("FIELD_PRESENCE_INVALID_CONFIGURATION");
  const raw=binding.policy;
  if(!plain(raw))return error("FIELD_PRESENCE_INVALID_CONFIGURATION");
  const hasStatus=Object.hasOwn(raw,"statusCode");
  const policy=fields(raw,["version","endpointId","direction","mediaType","propertyPaths",...(hasStatus?["statusCode"]:[])]);
  if(!policy||policy.version!=="observed-field-presence-1"||!safeText(policy.endpointId)
    ||(policy.direction!=="request"&&policy.direction!=="response")||!safeText(policy.mediaType,128)
    ||!/^application\/(?:[a-z0-9.+-]+\+)?json$/i.test(policy.mediaType)
    ||policy.direction==="request"&&hasStatus||policy.direction==="response"&&(!Number.isInteger(policy.statusCode)
      ||Number(policy.statusCode)<100||Number(policy.statusCode)>599))
    return error("FIELD_PRESENCE_INVALID_CONFIGURATION");
  const paths=safeArray(policy.propertyPaths,32);
  if(!paths||paths.length===0||paths.some(path=>!pointer(path))||new Set(paths).size!==paths.length)
    return error("FIELD_PRESENCE_INVALID_CONFIGURATION");
  const detachedPolicy=Object.freeze({version:"observed-field-presence-1" as const,endpointId:policy.endpointId as string,
    direction:policy.direction as "request"|"response",mediaType:policy.mediaType as string,
    propertyPaths:Object.freeze(paths as string[]),...(hasStatus?{statusCode:policy.statusCode as number}:{})});
  return Object.freeze({policyId:binding.policyId,tenantId:binding.tenantId as string,repositoryId:binding.repositoryId as string,
    serviceId:binding.serviceId as string,environment:binding.environment as string,policy:detachedPolicy});
};

type Context=FieldPresenceContext;
const parseContext=(input:unknown):Context=>{
  const context=fields(input,["tenantId","principalId"]);
  if(!context||!safeText(context.tenantId)||!safeText(context.principalId))return error("FIELD_PRESENCE_INVALID_REQUEST");
  return Object.freeze({tenantId:context.tenantId,principalId:context.principalId});
};
type EnvironmentSelection=QuerySelection&Readonly<{selector:Extract<QuerySelection["selector"],{kind:"environment"}>}>;
const parseSelection=(input:unknown):EnvironmentSelection=>{
  const outer=fields(input,["version","tenantId","repositoryId","serviceId","selector"]);
  const selector=outer&&plain(outer.selector)?outer.selector:undefined;
  const hasCheckpoint=selector?Object.hasOwn(selector,"expectedCheckpointVersion"):false;
  const selected=selector&&fields(selector,["kind","environment",...(hasCheckpoint?["expectedCheckpointVersion"]:[])]);
  if(!outer||!selected||selected.kind!=="environment"||!hasCheckpoint)
    return error("FIELD_PRESENCE_INVALID_REQUEST");
  try{
    const parsed=parseQuerySelection({...outer,selector:selected});
    if(parsed.selector.kind!=="environment"||!parsed.selector.expectedCheckpointVersion)
      return error("FIELD_PRESENCE_INVALID_REQUEST");
    return parsed as EnvironmentSelection;
  }catch{return error("FIELD_PRESENCE_INVALID_REQUEST");}
};
const parseRequest=(contextInput:unknown,requestInput:unknown):{context:Context;selection:EnvironmentSelection;policyId:string;observationId:string}=>{
  const context=parseContext(contextInput),request=fields(requestInput,["selection","policyId","observationId"]);
  if(!request||!safeText(request.policyId,128)||! /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(request.policyId)
    ||typeof request.observationId!=="string"||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(request.observationId))
    return error("FIELD_PRESENCE_INVALID_REQUEST");
  const selection=parseSelection(request.selection);
  if(selection.tenantId!==context.tenantId)return error("FIELD_PRESENCE_INVALID_REQUEST");
  return {context,selection,policyId:request.policyId,observationId:request.observationId};
};

const parseResolved=(input:unknown,selection:EnvironmentSelection):{snapshot:ContractSnapshot;
  pin:FieldPresenceSourcePin}|undefined=>{
  const result=fields(input,["status","selector","pin","snapshot","publication"]);
  const rawPin=result&&plain(result.pin)?result.pin:undefined;
  if(!result||result.status!=="resolved"||!rawPin||Object.hasOwn(rawPin,"selectedRevision"))return undefined;
  const pinHasPointer=Object.hasOwn(rawPin,"pointerVersion");
  const pin=fields(rawPin,["snapshotId","revision","configFingerprint",...(pinHasPointer?["pointerVersion"]:[]),"checkpointVersion"]);
  if(!pin||!["snapshotId","revision","configFingerprint","checkpointVersion"].every(key=>safeText(pin[key]))
    ||pinHasPointer&&!safeText(pin.pointerVersion))return undefined;
  const selector=(()=>{try{return parseSelection(result.selector);}catch{return undefined;}})();
  if(!selector||selector.tenantId!==selection.tenantId||selector.repositoryId!==selection.repositoryId
    ||selector.serviceId!==selection.serviceId||selector.selector.kind!=="environment"
    ||selector.selector.environment!==selection.selector.environment
    ||selector.selector.expectedCheckpointVersion!==selection.selector.expectedCheckpointVersion)return undefined;
  const parsed=parseContractSnapshot(cloneInert(result.snapshot));
  if(!parsed.ok)return undefined;
  const snapshot=parsed.value;
  if(snapshot.snapshot_id!==pin.snapshotId||snapshot.source.immutable_revision!==pin.revision
    ||snapshot.config.config_fingerprint!==pin.configFingerprint
    ||pin.checkpointVersion!==selection.selector.expectedCheckpointVersion
    ||snapshot.service.service_id!==selection.serviceId||snapshot.service.repository_id!==selection.repositoryId
    ||snapshot.source.repository_id!==selection.repositoryId)return undefined;
  const sourcePin=Object.freeze({tenantId:selection.tenantId,repositoryId:selection.repositoryId,
    serviceId:selection.serviceId,environment:selection.selector.environment,snapshotId:pin.snapshotId as string,
    revision:pin.revision as string,sourceDigest:snapshot.source.source_digest,configFingerprint:pin.configFingerprint as string,
    checkpointVersion:pin.checkpointVersion as string,...(pinHasPointer?{pointerVersion:pin.pointerVersion as string}:{})});
  return {snapshot,pin:sourcePin};
};
const samePin=(a:FieldPresenceSourcePin,b:FieldPresenceSourcePin):boolean=>a.tenantId===b.tenantId
  &&a.repositoryId===b.repositoryId&&a.serviceId===b.serviceId&&a.environment===b.environment
  &&a.snapshotId===b.snapshotId&&a.revision===b.revision&&a.sourceDigest===b.sourceDigest
  &&a.configFingerprint===b.configFingerprint&&a.checkpointVersion===b.checkpointVersion
  &&a.pointerVersion===b.pointerVersion;
const timeoutError=Symbol("timeout");
const withDeadline=async<T>(callback:(signal:AbortSignal)=>Promise<T>):Promise<T>=>{
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
  const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{
    controller.abort();reject(timeoutError);
  },10_000);});
  try{return await Promise.race([Promise.resolve().then(()=>callback(controller.signal)),timeout]);}
  finally{if(timer!==undefined)clearTimeout(timer);}
};
const freezePin=(pin:FieldPresenceSourcePin):FieldPresenceSourcePin=>Object.freeze({...pin});
const expectedAttestation=(raw:unknown,observationId:string,pin:FieldPresenceSourcePin,binding:FieldPresencePolicyBinding):boolean=>{
  const input=plain(raw)?raw:undefined;
  const hasPointer=input?Object.hasOwn(input,"pointerVersion"):false,hasStatus=input?Object.hasOwn(input,"statusCode"):false;
  const value=input&&fields(input,["observationId","tenantId","repositoryId","serviceId","environment","snapshotId",
    "revision","sourceDigest","configFingerprint","checkpointVersion","endpointId","direction","mediaType",
    ...(hasPointer?["pointerVersion"]:[]),...(hasStatus?["statusCode"]:[])]);
  if(!value||hasPointer!==Object.hasOwn(pin,"pointerVersion")
    ||hasStatus!==(binding.policy.direction==="response"))return false;
  const actual={observationId:value.observationId,tenantId:value.tenantId,repositoryId:value.repositoryId,serviceId:value.serviceId,
    environment:value.environment,snapshotId:value.snapshotId,revision:value.revision,sourceDigest:value.sourceDigest,
    configFingerprint:value.configFingerprint,checkpointVersion:value.checkpointVersion,
    ...(hasPointer?{pointerVersion:value.pointerVersion}:{})};
  return value.observationId===observationId&&samePin(actual as FieldPresenceSourcePin,pin)
    &&value.endpointId===binding.policy.endpointId&&value.direction===binding.policy.direction
    &&value.mediaType===binding.policy.mediaType
    &&(binding.policy.direction==="request"||value.statusCode===binding.policy.statusCode);
};
const payloadFrom=(input:unknown,observationId:string,pin:FieldPresenceSourcePin,binding:FieldPresencePolicyBinding):{payloadText:string;payloadCompleteness:"complete_unredacted"|"truncated"|"redacted"|"unknown"}|undefined=>{
  const value=fields(input,["attestation","payloadText","payloadCompleteness"]);
  if(!value||!expectedAttestation(value.attestation,observationId,pin,binding)||typeof value.payloadText!=="string"
    ||Buffer.byteLength(value.payloadText,"utf8")>256*1024
    ||!(["complete_unredacted","truncated","redacted","unknown"] as unknown[]).includes(value.payloadCompleteness))return undefined;
  return {payloadText:value.payloadText,payloadCompleteness:value.payloadCompleteness as "complete_unredacted"|"truncated"|"redacted"|"unknown"};
};

/** Reads only host-authorized raw observations and projects value-free presence after a fresh pin recheck. */
export const createFieldPresenceService=(optionsInput:{queryReader:Pick<QueryReader,"readContract">;
  policies:readonly FieldPresencePolicyBinding[];authorize:FieldPresenceAuthorization;readObservation:FieldPresenceReadPort})=>{
  const options=fields(optionsInput,["queryReader","policies","authorize","readObservation"]);
  const reader=options?.queryReader;
  const readDescriptor=reader&&plain(reader)?Object.getOwnPropertyDescriptor(reader,"readContract"):undefined;
  const read=readDescriptor&&"value" in readDescriptor&&typeof readDescriptor.value==="function"?readDescriptor.value as QueryReader["readContract"]:undefined;
  const authorize=options?.authorize,readObservation=options?.readObservation;
  const configured=safeArray(options?.policies,256);
  if(!read||typeof authorize!=="function"||typeof readObservation!=="function"||!configured)
    return error("FIELD_PRESENCE_INVALID_CONFIGURATION");
  const bindings=configured.map(parseBinding);
  const keys=bindings.map(item=>JSON.stringify([item.tenantId,item.repositoryId,item.serviceId,item.environment,item.policyId]));
  if(new Set(keys).size!==keys.length)return error("FIELD_PRESENCE_INVALID_CONFIGURATION");
  const fixedRead=read,fixedAuthorize=authorize,fixedObservation=readObservation;
  const query=async(context:Context,selection:EnvironmentSelection)=>{
    try{return parseResolved(await fixedRead(context,selection),selection);}catch{return undefined;}
  };
  return Object.freeze({async read(contextInput:unknown,requestInput:unknown):Promise<FieldPresenceResult>{
    const {context,selection,policyId,observationId}=parseRequest(contextInput,requestInput);
    const binding=bindings.find(item=>item.policyId===policyId&&item.tenantId===selection.tenantId
      &&item.repositoryId===selection.repositoryId&&item.serviceId===selection.serviceId
      &&item.environment===selection.selector.environment);
    if(!binding)return error("FIELD_PRESENCE_NOT_FOUND_OR_DENIED");
    const before=await query(context,selection);
    if(!before)return error("FIELD_PRESENCE_NOT_FOUND_OR_DENIED");
    const pin=freezePin(before.pin);
    let allowed=false;
    try{allowed=await withDeadline(signal=>fixedAuthorize(context,freezePin(pin),binding,observationId,signal));}
    catch{return error("FIELD_PRESENCE_STORAGE_ERROR");}
    if(allowed!==true)return error("FIELD_PRESENCE_NOT_FOUND_OR_DENIED");
    const projectorPolicy=Object.freeze({version:"observed-field-presence-1" as const,policyId:binding.policyId,
      tenantId:pin.tenantId,repositoryId:pin.repositoryId,serviceId:pin.serviceId,environment:pin.environment,
      snapshotId:pin.snapshotId,revision:pin.revision,sourceDigest:pin.sourceDigest,configFingerprint:pin.configFingerprint,
      checkpointVersion:pin.checkpointVersion,endpointId:binding.policy.endpointId,direction:binding.policy.direction,
      mediaType:binding.policy.mediaType,propertyPaths:binding.policy.propertyPaths,
      ...(binding.policy.statusCode===undefined?{}:{statusCode:binding.policy.statusCode})});
    const projectorPin={state:"resolved_single_revision" as const,tenantId:pin.tenantId,repositoryId:pin.repositoryId,
      serviceId:pin.serviceId,environment:pin.environment,snapshotId:pin.snapshotId,revision:pin.revision,
      configFingerprint:pin.configFingerprint,checkpointVersion:pin.checkpointVersion};
    let preflight:FieldPresenceResult;
    try{preflight=projectObservedFieldPresence({pin:projectorPin,snapshot:before.snapshot,
      policy:projectorPolicy,payloadText:"{}",payloadCompleteness:"complete_unredacted"});}
    catch{return error("FIELD_PRESENCE_STORAGE_ERROR");}
    if(preflight.status!=="projected")return preflight;
    let raw:unknown;
    try{raw=await withDeadline(signal=>fixedObservation(context,freezePin(pin),observationId,binding,signal));}
    catch{return error("FIELD_PRESENCE_STORAGE_ERROR");}
    const payload=payloadFrom(raw,observationId,pin,binding);
    if(!payload)return error("FIELD_PRESENCE_STORAGE_ERROR");
    let projected:FieldPresenceResult;
    try{projected=projectObservedFieldPresence({pin:projectorPin,snapshot:before.snapshot,
      policy:projectorPolicy,payloadText:payload.payloadText,payloadCompleteness:payload.payloadCompleteness});}
    catch{return error("FIELD_PRESENCE_STORAGE_ERROR");}
    const after=await query(context,selection);
    if(!after)return error("FIELD_PRESENCE_NOT_FOUND_OR_DENIED");
    if(!samePin(pin,after.pin))return error("FIELD_PRESENCE_STALE_CONTEXT");
    let reauthorized=false;
    try{reauthorized=await withDeadline(signal=>fixedAuthorize(context,freezePin(pin),binding,observationId,signal));}
    catch{return error("FIELD_PRESENCE_STORAGE_ERROR");}
    if(reauthorized!==true)return error("FIELD_PRESENCE_NOT_FOUND_OR_DENIED");
    return projected;
  }});
};
