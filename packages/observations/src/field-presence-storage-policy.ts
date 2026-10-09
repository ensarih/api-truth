import {createHash} from "node:crypto";
import {isProxy} from "node:util/types";

export type FieldPresenceStoragePolicy=Readonly<{version:"field-presence-storage-1";policyId:string;ownerPolicyRevision:string;optIn:true;
  tenantId:string;repositoryId:string;serviceId:string;environment:string;configFingerprint:string;
  configActivationCheckpoint:string;endpointId:string;direction:"request"|"response";mediaType:string;
  propertyPaths:readonly string[];statusCode?:number;ttlSeconds:number;maxLiveRecords:number}>;
export type CompiledFieldPresenceStoragePolicy=Readonly<{policy:FieldPresenceStoragePolicy;fingerprint:string}>;
export type FieldPresenceStorageHostContext=Readonly<{activeConfigFingerprint:string;configActivationCheckpoint:string;
  expectedPolicyFingerprint:string;expectedSourceDigest:string}>;
export type FieldPresenceStorageProposal=Readonly<{status:"eligible";policyVersion:"field-presence-storage-1";
  policyId:string;ownerPolicyRevision:string;policyFingerprint:string;configActivationCheckpoint:string;scope:Readonly<{tenantId:string;repositoryId:string;
    serviceId:string;environment:string;snapshotId:string;revision:string;sourceDigest:string;configFingerprint:string;
    checkpointVersion:string;endpointId:string;direction:"request"|"response";mediaType:string;statusCode?:number}>;
  parent:Readonly<{importId:string;recordId:string}>;source:Readonly<{sourceId:string;sourceVersion:string;
    windowStart:string;windowEnd:string;importedAt:string}>;fields:readonly Readonly<{path:string;state:"present"|"absent"}>[];
  ttlSeconds:number;maxLiveRecords:number}>;
export type FieldPresenceStorageEligibility=FieldPresenceStorageProposal|Readonly<{status:"withheld";diagnostic:string}>;

export class FieldPresenceStoragePolicyError extends Error {
  readonly code="INVALID_FIELD_PRESENCE_STORAGE_POLICY" as const;
  constructor(){super("Invalid field-presence storage policy");this.name="FieldPresenceStoragePolicyError";}
}
const invalid=():never=>{throw new FieldPresenceStoragePolicyError();};
const plain=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==="object"&&!isProxy(value)
  &&!Array.isArray(value)&&(Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null);
const fields=(value:unknown,keys:readonly string[]):Record<string,unknown>|undefined=>{
  try{
    if(!plain(value))return undefined;
    const own=Reflect.ownKeys(value);
    if(own.length!==keys.length||own.some(key=>typeof key!=="string"||!keys.includes(key)))return undefined;
    const result:Record<string,unknown>={};
    for(const key of keys){const descriptor=Object.getOwnPropertyDescriptor(value,key);
      if(!descriptor||!descriptor.enumerable||!("value" in descriptor))return undefined;
      Object.defineProperty(result,key,{value:descriptor.value,enumerable:true,writable:true,configurable:true});}
    return result;
  }catch{return undefined;}
};
const arr=(value:unknown,max:number):unknown[]|undefined=>{
  try{
    if(isProxy(value)||!Array.isArray(value)||Object.getPrototypeOf(value)!==Array.prototype||value.length>max
      ||Reflect.ownKeys(value).length!==value.length+1)return undefined;
    const output:unknown[]=[];
    for(let i=0;i<value.length;i++){const descriptor=Object.getOwnPropertyDescriptor(value,String(i));
      if(!descriptor||!descriptor.enumerable||!("value" in descriptor))return undefined;output.push(descriptor.value);}
    return output;
  }catch{return undefined;}
};
const text=(value:unknown,max=128):value is string=>typeof value==="string"&&value.length>0&&value.length<=max
  &&/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const hash=/^sha256:[0-9a-f]{64}$/;
const version=(value:unknown):value is string=>typeof value==="string"&&/^[1-9][0-9]{0,18}$/.test(value)
  &&BigInt(value)<=9223372036854775807n;
const wellFormed=(value:string):boolean=>{
  for(let i=0;i<value.length;i++){const code=value.charCodeAt(i);
    if(code>=0xd800&&code<=0xdbff){const next=value.charCodeAt(++i);if(!(next>=0xdc00&&next<=0xdfff))return false;}
    else if(code>=0xdc00&&code<=0xdfff)return false;}
  return true;
};
const pointer=(value:unknown):value is string=>typeof value==="string"&&wellFormed(value)&&value.length>=2&&value.length<=512
  &&value.startsWith("/")&&value.slice(1).split("/").length<=12
  &&value.slice(1).split("/").every(segment=>{
    if(!segment||segment.length>128||/~(?![01])/.test(segment))return false;
    const decoded=segment.replaceAll("~1","/").replaceAll("~0","~");
    if(decoded.length>128||/[\u0000-\u001f\u007f]/.test(decoded))return false;
    const normalized=decoded.replace(/([a-z0-9])([A-Z])/g,"$1 $2").toLowerCase().replace(/[^a-z0-9]/g,"");
    return decoded!=="*"&&!/^(?:__proto__|prototype|constructor)$/i.test(decoded)
      &&!/email|phone|mobile|ssn|socialsecurity|creditcard|cardnumber|dateofbirth|birthdate|firstname|lastname|givenname|familyname|postalcode|streetaddress/.test(normalized);
  });
const time=(value:unknown):value is string=>typeof value==="string"&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
  &&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
const canonicalPolicy=(policy:FieldPresenceStoragePolicy):string=>JSON.stringify({version:policy.version,policyId:policy.policyId,
  ownerPolicyRevision:policy.ownerPolicyRevision,
  optIn:policy.optIn,tenantId:policy.tenantId,repositoryId:policy.repositoryId,serviceId:policy.serviceId,
  environment:policy.environment,configFingerprint:policy.configFingerprint,
  configActivationCheckpoint:policy.configActivationCheckpoint,endpointId:policy.endpointId,direction:policy.direction,
  mediaType:policy.mediaType,...(policy.statusCode===undefined?{}:{statusCode:policy.statusCode}),
  propertyPaths:[...policy.propertyPaths],ttlSeconds:policy.ttlSeconds,maxLiveRecords:policy.maxLiveRecords});
const digest=(value:string):string=>`sha256:${createHash("sha256").update(value).digest("hex")}`;

export const compileFieldPresenceStoragePolicy=(input:unknown):CompiledFieldPresenceStoragePolicy=>{
  if(!plain(input))return invalid();
  const hasStatus=Object.hasOwn(input,"statusCode");
  const raw=fields(input,["version","policyId","ownerPolicyRevision","optIn","tenantId","repositoryId","serviceId","environment",
    "configFingerprint","configActivationCheckpoint","endpointId","direction","mediaType","propertyPaths",
    "ttlSeconds","maxLiveRecords",...(hasStatus?["statusCode"]:[])]);
  if(!raw||raw.version!=="field-presence-storage-1"||raw.optIn!==true||!text(raw.policyId)
    ||!version(raw.ownerPolicyRevision)
    ||![raw.tenantId,raw.repositoryId,raw.serviceId,raw.environment,raw.endpointId].every(value=>text(value))
    ||typeof raw.configFingerprint!=="string"||!hash.test(raw.configFingerprint)
    ||!version(raw.configActivationCheckpoint)||typeof raw.direction!=="string"
    ||(raw.direction!=="request"&&raw.direction!=="response")||typeof raw.mediaType!=="string"
    ||raw.mediaType.length>128||!/^application\/(?:[a-z0-9.+-]+\+)?json$/i.test(raw.mediaType)
    ||raw.direction==="request"&&hasStatus||raw.direction==="response"&&(!Number.isInteger(raw.statusCode)
      ||Number(raw.statusCode)<100||Number(raw.statusCode)>599)
    ||!Number.isInteger(raw.ttlSeconds)||Number(raw.ttlSeconds)<60||Number(raw.ttlSeconds)>2_592_000
    ||!Number.isInteger(raw.maxLiveRecords)||Number(raw.maxLiveRecords)<1||Number(raw.maxLiveRecords)>10_000)
    return invalid();
  const paths=arr(raw.propertyPaths,32);
  if(!paths||paths.length===0||paths.some(path=>!pointer(path))||new Set(paths).size!==paths.length)return invalid();
  const normalizedPaths=[...(paths as string[])].sort((a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b)));
  const policy=Object.freeze({version:"field-presence-storage-1" as const,policyId:raw.policyId as string,
    ownerPolicyRevision:raw.ownerPolicyRevision,optIn:true as const,
    tenantId:raw.tenantId as string,repositoryId:raw.repositoryId as string,serviceId:raw.serviceId as string,
    environment:raw.environment as string,configFingerprint:raw.configFingerprint,configActivationCheckpoint:raw.configActivationCheckpoint,
    endpointId:raw.endpointId as string,direction:raw.direction as "request"|"response",mediaType:raw.mediaType as string,
    propertyPaths:Object.freeze(normalizedPaths),...(hasStatus?{statusCode:raw.statusCode as number}:{}),
    ttlSeconds:raw.ttlSeconds as number,maxLiveRecords:raw.maxLiveRecords as number});
  return Object.freeze({policy,fingerprint:digest(canonicalPolicy(policy))});
};

type SafeRecord=Readonly<{importId:string;recordId:string;sourceId:string;sourceVersion:string;windowStart:string;windowEnd:string;
  importedAt:string;status:string;reason?:string;endpointId?:string;mappingId?:string;method?:string;statusCode?:number;
  completeness:string;policyVersion:string}>;
const parseRecord=(input:unknown):SafeRecord|undefined=>{
  if(!plain(input))return undefined;
  const hasReason=Object.hasOwn(input,"reason"),hasEndpoint=Object.hasOwn(input,"endpointId"),hasMapping=Object.hasOwn(input,"mappingId");
  const hasMethod=Object.hasOwn(input,"method"),hasStatus=Object.hasOwn(input,"statusCode");
  const record=fields(input,["importId","recordId","sourceId","sourceVersion","windowStart","windowEnd","importedAt","status",
    ...(hasReason?["reason"]:[]),...(hasEndpoint?["endpointId"]:[]),...(hasMapping?["mappingId"]:[]),...(hasMethod?["method"]:[]),
    ...(hasStatus?["statusCode"]:[]),"completeness","policyVersion"]);
  if(!record||typeof record.importId!=="string"||!uuid.test(record.importId)||typeof record.recordId!=="string"||!uuid.test(record.recordId)
    ||!text(record.sourceId)||!text(record.sourceVersion)||!time(record.windowStart)||!time(record.windowEnd)||!time(record.importedAt)
    ||record.windowStart>record.windowEnd||!(["confirmed","unresolved"] as unknown[]).includes(record.status)
    ||!text(record.completeness)||!text(record.policyVersion))return undefined;
  if(record.status==="confirmed"){
    if(hasReason||!hasEndpoint||!hasMapping||!hasMethod||!hasStatus||!text(record.endpointId)||!text(record.mappingId)
      ||!(["GET","POST","PUT","PATCH","DELETE","HEAD","OPTIONS"] as unknown[]).includes(record.method)
      ||!Number.isInteger(record.statusCode)||Number(record.statusCode)<100||Number(record.statusCode)>599
      ||record.windowEnd>record.importedAt)return undefined;
  }else if(!hasReason||!text(record.reason)||hasEndpoint||hasMapping
    ||hasMethod&&!(["GET","POST","PUT","PATCH","DELETE","HEAD","OPTIONS"] as unknown[]).includes(record.method)
    ||hasStatus&&(!Number.isInteger(record.statusCode)||Number(record.statusCode)<100||Number(record.statusCode)>599)
    ||!(["environment_unresolved","revision_unknown","revision_mismatch","invalid_url","no_mapping","ambiguous_mapping",
      "no_endpoint","ambiguous_endpoint","unsupported_route_selectors"] as unknown[]).includes(record.reason))return undefined;
  return record as SafeRecord;
};
const withheld=(diagnostic:string):FieldPresenceStorageEligibility=>Object.freeze({status:"withheld",diagnostic});
const endpointScopeKeys=["tenantId","repositoryId","serviceId","environment","snapshotId","revision","sourceDigest",
  "configFingerprint","checkpointVersion","endpointId","direction","mediaType"] as const;

export const buildFieldPresenceStorageProposal=(input:unknown):FieldPresenceStorageEligibility=>{
  const outer=fields(input,["queryResult","projected","policy","parent","host"]);
  if(!outer)return withheld("invalid_input");
  let compiled:CompiledFieldPresenceStoragePolicy;
  try{
    const c=fields(outer.policy,["policy","fingerprint"]);
    if(!c||typeof c.fingerprint!=="string"||!hash.test(c.fingerprint))return withheld("invalid_policy");
    compiled=compileFieldPresenceStoragePolicy(c.policy);
    if(compiled.fingerprint!==c.fingerprint)return withheld("invalid_policy");
  }catch{return withheld("invalid_policy");}
  const policy=compiled.policy;
  const host=fields(outer.host,["activeConfigFingerprint","configActivationCheckpoint","expectedPolicyFingerprint","expectedSourceDigest"]);
  if(!host||host.activeConfigFingerprint!==policy.configFingerprint
    ||host.configActivationCheckpoint!==policy.configActivationCheckpoint||host.expectedPolicyFingerprint!==compiled.fingerprint
    ||typeof host.expectedSourceDigest!=="string"||!hash.test(host.expectedSourceDigest))return withheld("policy_epoch_mismatch");
  const parent=fields(outer.parent,["importId","recordId"]);
  if(!parent||typeof parent.importId!=="string"||!uuid.test(parent.importId)
    ||typeof parent.recordId!=="string"||!uuid.test(parent.recordId))return withheld("parent_invalid");
  const result=fields(outer.queryResult,["status","selector","pin","records","truncated"]);
  if(!result||result.status!=="resolved"||result.truncated!==false)return withheld("query_incomplete");
  const selectorRaw=fields(result.selector,["version","tenantId","repositoryId","serviceId","selector"]);
  const selector=selectorRaw&&fields(selectorRaw.selector,["kind","environment","expectedCheckpointVersion"]);
  const pinRaw=plain(result.pin)?result.pin:undefined;
  if(!selectorRaw||!selector||selectorRaw.version!=="1"||selector.kind!=="environment"
    ||selectorRaw.tenantId!==policy.tenantId||selectorRaw.repositoryId!==policy.repositoryId||selectorRaw.serviceId!==policy.serviceId
    ||selector.environment!==policy.environment||!version(selector.expectedCheckpointVersion))return withheld("query_scope_mismatch");
  if(!pinRaw||Object.hasOwn(pinRaw,"selectedRevision"))return withheld("qualified_revision_unsupported");
  if(Object.hasOwn(pinRaw,"pointerVersion"))return withheld("pointer_version_unsupported");
  const pin=fields(pinRaw,["snapshotId","revision","configFingerprint","checkpointVersion",
    ...(Object.hasOwn(pinRaw,"pointerVersion")?["pointerVersion"]:[])]);
  if(!pin||!text(pin.snapshotId)||!text(pin.revision)||pin.configFingerprint!==policy.configFingerprint
    ||pin.checkpointVersion!==selector.expectedCheckpointVersion||!version(pin.checkpointVersion)
    ||Object.hasOwn(pin,"pointerVersion")&&!text(pin.pointerVersion))return withheld("query_pin_mismatch");
  const recordsRaw=arr(result.records,100);
  if(!recordsRaw)return withheld("query_records_invalid");
  const records=recordsRaw.map(parseRecord);
  if(records.some(record=>record===undefined))return withheld("query_record_invalid");
  const recordIds=new Set<string>();
  for(const record of records as SafeRecord[]){if(recordIds.has(record.recordId))return withheld("parent_ambiguous");recordIds.add(record.recordId);}
  const selected=(records as SafeRecord[]).filter(record=>record.importId===parent.importId&&record.recordId===parent.recordId);
  if(selected.length!==1)return withheld("parent_not_selected");
  const record=selected[0]!;
  if(record.status!=="confirmed"||record.completeness!=="metadata_only"||record.policyVersion!=="metadata-only-1"
    ||record.endpointId!==policy.endpointId||policy.direction==="response"&&record.statusCode!==policy.statusCode)
    return withheld("parent_not_eligible");
  const projected=fields(outer.projected,["status","kind","nonNormative","policyVersion","scope","fields","diagnostics"]);
  const scope=projected&&fields(projected.scope,[...endpointScopeKeys,...(policy.direction==="response"?["statusCode"]:[])]);
  if(!projected||projected.status!=="projected"||projected.kind!=="observed_field_presence"||projected.nonNormative!==true
    ||projected.policyVersion!=="observed-field-presence-1"||!scope)return withheld("projection_invalid");
  const expectedScope={tenantId:policy.tenantId,repositoryId:policy.repositoryId,serviceId:policy.serviceId,environment:policy.environment,
    snapshotId:pin.snapshotId,revision:pin.revision,sourceDigest:host.expectedSourceDigest,configFingerprint:pin.configFingerprint,
    checkpointVersion:pin.checkpointVersion,endpointId:policy.endpointId,direction:policy.direction,mediaType:policy.mediaType,
    ...(policy.direction==="response"?{statusCode:policy.statusCode}:{})};
  for(const key of endpointScopeKeys)if(scope[key]!==expectedScope[key])return withheld("projection_scope_mismatch");
  if(policy.direction==="response"&&scope.statusCode!==policy.statusCode)return withheld("projection_scope_mismatch");
  const fieldValues=arr(projected.fields,32);
  if(!fieldValues||fieldValues.length!==policy.propertyPaths.length)return withheld("projection_fields_mismatch");
  const fieldsOut:{path:string;state:"present"|"absent"}[]=[];
  for(const item of fieldValues){const field=fields(item,["path","state"]);
    if(!field||typeof field.path!=="string"||!(field.state==="present"||field.state==="absent"))return withheld("projection_fields_mismatch");
    fieldsOut.push({path:field.path,state:field.state});}
  fieldsOut.sort((a,b)=>Buffer.compare(Buffer.from(a.path),Buffer.from(b.path)));
  const normalizedPolicyPaths=[...policy.propertyPaths];
  if(fieldsOut.some((field,index)=>field.path!==normalizedPolicyPaths[index]))return withheld("projection_fields_mismatch");
  const diagnostics=arr(projected.diagnostics,8);
  if(!diagnostics||diagnostics.length!==1){return withheld("projection_diagnostics_invalid");}
  const diagnostic=fields(diagnostics[0],["ruleId","count"]);
  if(!diagnostic||diagnostic.ruleId!=="selected_paths"||diagnostic.count!==fieldsOut.length)return withheld("projection_diagnostics_invalid");
  const scopeOut=Object.freeze({...expectedScope,sourceDigest:host.expectedSourceDigest});
  return Object.freeze({status:"eligible",policyVersion:policy.version,policyId:policy.policyId,
    ownerPolicyRevision:policy.ownerPolicyRevision,policyFingerprint:compiled.fingerprint,
    configActivationCheckpoint:policy.configActivationCheckpoint,scope:scopeOut,parent:Object.freeze({importId:record.importId,recordId:record.recordId}),
    source:Object.freeze({sourceId:record.sourceId,sourceVersion:record.sourceVersion,windowStart:record.windowStart,
      windowEnd:record.windowEnd,importedAt:record.importedAt}),fields: Object.freeze(fieldsOut.map(field=>Object.freeze(field))),
    ttlSeconds:policy.ttlSeconds,maxLiveRecords:policy.maxLiveRecords});
};
