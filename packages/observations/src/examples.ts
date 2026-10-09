import {createHash} from "node:crypto";
import {isProxy} from "node:util/types";
import {canonicalJsonStringify, type ContractSnapshot} from "../../ir/src/index.js";

export type SyntheticExamplePolicy = Readonly<{
  version: "synthetic-examples-1";
  endpointId: string;
  direction: "request" | "response";
  mediaType: string;
  propertyPaths: readonly string[];
  statusCode?: number;
}>;
export type SyntheticExampleDiagnostic = Readonly<{ruleId:string;count:number}>;
export type SyntheticExampleResult =
  | Readonly<{status:"generated";kind:"synthetic_example";nonNormative:true;policyVersion:"synthetic-examples-1";
      scope:Readonly<{tenantId:string;repositoryId:string;serviceId:string;environment:string;revision:string;
        snapshotId:string;sourceDigest:string;configFingerprint:string;checkpointVersion:string;endpointId:string;
        direction:"request"|"response";statusCode?:number;mediaType:string}>;
      fingerprints:Readonly<{schemaSha256:string;policySha256:string}>;value:unknown;
      diagnostics:readonly SyntheticExampleDiagnostic[]}>
  | Readonly<{status:"withheld";diagnostics:readonly SyntheticExampleDiagnostic[]}>;

export class SyntheticExampleError extends Error {
  readonly code = "INVALID_SYNTHETIC_EXAMPLE_INPUT" as const;
  constructor(){super("Invalid synthetic example input");this.name="SyntheticExampleError";}
}

const fail=():never=>{throw new SyntheticExampleError();};
const digest=(value:unknown):string=>`sha256:${createHash("sha256").update(canonicalJsonStringify(value)).digest("hex")}`;
const freezeJson=<T>(value:T):T=>{
  if(value&&typeof value==="object"&&!Object.isFrozen(value)){
    Object.values(value as Record<string,unknown>).forEach(freezeJson);
    Object.freeze(value);
  }
  return value;
};
const plain=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==="object"&&!Array.isArray(value)
  &&!isProxy(value)&&(Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null);
const boundedText=(value:unknown,max=512):value is string=>typeof value==="string"&&value.length>0&&value.length<=max
  &&!/[\u0000-\u001f\u007f]/.test(value);

/** Clone JSON-shaped input without invoking accessors; this validates shape, not host authorization. */
const cloneBounded=(root:unknown):unknown=>{
  let nodes=0,bytes=0;
  const visit=(value:unknown,depth:number):unknown=>{
    if(++nodes>12000||depth>64)fail();
    if(value===null||typeof value==="boolean")return value;
    if(typeof value==="string"){
      bytes+=Buffer.byteLength(value,"utf8");if(value.length>16384||bytes>512*1024)fail();return value;
    }
    if(typeof value==="number"){if(!Number.isFinite(value))fail();return value;}
    if(typeof value!=="object"||isProxy(value))fail();
    if(Array.isArray(value)){
      if(Object.getPrototypeOf(value)!==Array.prototype||value.length>12000)fail();
      const descriptors=Object.getOwnPropertyDescriptors(value);
      if(Reflect.ownKeys(descriptors).some(key=>typeof key==="symbol"))fail();
      const out:unknown[]=[];
      for(let i=0;i<value.length;i++){
        const descriptor=descriptors[String(i)];if(!descriptor||!("value" in descriptor))fail();
        out.push(visit(descriptor!.value,depth+1));
      }
      if(Object.keys(descriptors).some(key=>key!=="length"&&!/^(0|[1-9][0-9]*)$/.test(key)))fail();
      return out;
    }
    if(!plain(value))fail();
    const descriptors=Object.getOwnPropertyDescriptors(value),keys=Reflect.ownKeys(descriptors);
    if(keys.length>12000||keys.some(key=>typeof key!=="string"))fail();
    const out:Record<string,unknown>={};
    for(const key of keys as string[]){
      bytes+=Buffer.byteLength(key,"utf8");if(key.length>1024||bytes>512*1024)fail();
      const descriptor=descriptors[key]!;if(!("value" in descriptor))fail();
      Object.defineProperty(out,key,{value:visit(descriptor.value,depth+1),enumerable:true,writable:true,configurable:true});
    }
    return out;
  };
  return visit(root,0);
};

const getPolicy=(input:unknown):SyntheticExamplePolicy=>{
  const value=cloneBounded(input);if(!plain(value))return fail();
  const keys=Object.keys(value),hasStatus=Object.hasOwn(value,"statusCode");
  const expected=["version","endpointId","direction","mediaType","propertyPaths",...(hasStatus?["statusCode"]:[])].sort();
  if(keys.length!==expected.length||keys.slice().sort().some((key,index)=>key!==expected[index]))return fail();
  if(value.version!=="synthetic-examples-1"||!boundedText(value.endpointId)||!boundedText(value.mediaType,128)
    ||!/^application\/(?:[a-z0-9.+-]+\+)?json$/i.test(value.mediaType)
    ||(value.direction!=="request"&&value.direction!=="response")
    ||!Array.isArray(value.propertyPaths)||value.propertyPaths.length>64
    ||(value.direction==="response"?typeof value.statusCode!=="number"||!Number.isInteger(value.statusCode)
      ||value.statusCode<100||value.statusCode>599:hasStatus))return fail();
  const paths=value.propertyPaths as unknown[];
  const decoded=paths.map(decodePropertyPath);
  if(new Set(paths as string[]).size!==paths.length||decoded.some(path=>path.length>16))return fail();
  return Object.freeze({version:"synthetic-examples-1",endpointId:value.endpointId,direction:value.direction,
    mediaType:value.mediaType,propertyPaths:Object.freeze(paths as string[]),
    ...(hasStatus?{statusCode:value.statusCode as number}:{})});
};

const decodePropertyPath=(path:unknown):string[]=>{
  if(typeof path!=="string"||path.length<2||path.length>1024||!path.startsWith("/"))return fail();
  const segments=path.slice(1).split("/").map(segment=>{
    if(/~(?![01])/.test(segment))return fail();
    const decoded=segment.replaceAll("~1","/").replaceAll("~0","~");
    if(!decoded||decoded.length>256||/[\u0000-\u001f\u007f]/.test(decoded))return fail();
    return decoded;
  });
  return segments;
};

type Trie={terminal:boolean;children:Map<string,Trie>};
const trie=():Trie=>({terminal:false,children:new Map()});
const buildTrie=(paths:readonly string[]):Trie=>{
  const root=trie();
  for(const path of paths){let node=root;for(const segment of decodePropertyPath(path)){
    let child=node.children.get(segment);if(!child){child=trie();node.children.set(segment,child);}node=child;
  }node.terminal=true;}
  return root;
};
const sensitiveKey=(key:string):boolean=>{
  const normalized=key.replace(/([a-z0-9])([A-Z])/g,"$1 $2").toLowerCase().replace(/[^a-z0-9]/g,"");
  return /(?:password|passwd|secret|token|authorization|cookie|credential|apikey|accesskey|privatekey|bearer|jwt|sessionid|email|phone|mobile|ssn|socialsecurity|creditcard|cardnumber|dateofbirth|birthdate|firstname|lastname|givenname|familyname|postalcode|streetaddress)/.test(normalized);
};

type MutableCount=Map<string,number>;
const count=(counts:MutableCount,rule:string,n=1)=>counts.set(rule,(counts.get(rule)??0)+n);
const resultDiagnostics=(counts:MutableCount):readonly SyntheticExampleDiagnostic[]=>Object.freeze(
  [...counts].sort(([a],[b])=>a.localeCompare(b)).map(([ruleId,n])=>Object.freeze({ruleId,count:n})));
const withheld=(counts:MutableCount,rule?:string):SyntheticExampleResult=>{
  if(rule)count(counts,rule);
  return Object.freeze({status:"withheld",diagnostics:resultDiagnostics(counts)});
};

const schemaKeys=new Set(["$ref","type","properties","required","items","minItems","maxItems",
  "minLength","maxLength","minimum","maximum"]);
const schemaFingerprintMaterial=(root:unknown,snapshot:ContractSnapshot):unknown=>{
  const found=new Map<string,unknown>(),seen=new Set<string>();let visits=0;
  const walk=(schema:unknown):void=>{
    if(++visits>2048||!plain(schema))return;
    if(typeof schema.$ref==="string"&&schema.$ref.startsWith("#/schemas/")){
      const id=schema.$ref.slice("#/schemas/".length);
      if(id.length>0&&!seen.has(id)&&Object.hasOwn(snapshot.schemas,id)){
        seen.add(id);const component=snapshot.schemas[id];if(component){found.set(id,component.schema);walk(component.schema);}
      }
    }
    if(plain(schema.properties))Object.values(schema.properties).forEach(walk);
    for(const key of ["items","additionalProperties","not"])if(plain(schema[key]))walk(schema[key]);
    for(const key of ["allOf","anyOf","oneOf","prefixItems"])if(Array.isArray(schema[key]))schema[key].forEach(walk);
  };
  walk(root);
  return {schema:root,components:Object.fromEntries([...found].sort(([a],[b])=>a.localeCompare(b)))};
};
const resolveSchema=(schema:Record<string,unknown>):Record<string,unknown>|undefined=>{
  if(Object.keys(schema).some(key=>!schemaKeys.has(key)))return undefined;
  if(Object.hasOwn(schema,"$ref"))return undefined;
  return schema;
};

const validInteger=(value:unknown,min=0,max=256):value is number=>typeof value==="number"&&Number.isInteger(value)&&value>=min&&value<=max;
const hasAny=(schema:Record<string,unknown>,keys:readonly string[]):boolean=>keys.some(key=>schema[key]!==undefined);
const safeNumberBounds=(schema:Record<string,unknown>):boolean=>{
  for(const key of ["minimum","maximum"]){const value=schema[key];if(value!==undefined&&typeof value!=="number")return false;}
  return schema.minimum===undefined||schema.maximum===undefined||(schema.minimum as number)<=(schema.maximum as number);
};

const generateValue=(raw:unknown,snapshot:ContractSnapshot,node:Trie,stack:Set<string>,counts:MutableCount,depth:number):unknown|undefined=>{
  if(depth>16){count(counts,"schema_depth_limit");return undefined;}
  if(!plain(raw)){count(counts,"schema_shape_unsupported");return undefined;}
  if(Object.hasOwn(raw,"$ref")){
    if(Object.keys(raw).length!==1||typeof raw.$ref!=="string"||!raw.$ref.startsWith("#/schemas/")){
      count(counts,"schema_reference_unsupported");return undefined;
    }
    const id=raw.$ref.slice("#/schemas/".length);
    if(!id||stack.has(id)||!Object.hasOwn(snapshot.schemas,id)){
      count(counts,"schema_reference_cycle_or_missing");return undefined;
    }
    const component=snapshot.schemas[id];if(!component){count(counts,"schema_reference_cycle_or_missing");return undefined;}
    stack.add(id);
    const value=generateValue(component.schema,snapshot,node,stack,counts,depth+1);
    stack.delete(id);
    return value;
  }
  const schema=resolveSchema(raw);if(!schema){count(counts,"schema_unsupported");return undefined;}
  const type=schema.type;
  if(typeof type!=="string"){count(counts,"schema_type_unsupported");return undefined;}
  if(type==="object"){
    if(hasAny(schema,["items","minItems","maxItems","minimum","maximum","minLength","maxLength"])){
      count(counts,"schema_type_constraint_mismatch");return undefined;
    }
    if(schema.properties!==undefined&&!plain(schema.properties)){count(counts,"schema_shape_unsupported");return undefined;}
    const properties=(schema.properties??{}) as Record<string,unknown>;
    const required=schema.required??[];
    if(!Array.isArray(required)||required.length>128||required.some(k=>typeof k!=="string")
      ||new Set(required).size!==required.length){count(counts,"schema_shape_unsupported");return undefined;}
    const minProperties=new Set(required as string[]);
    const keys=new Set([...node.children.keys(),...minProperties]);
    for(const key of keys)if(sensitiveKey(key)){count(counts,"sensitive_property_name");return undefined;}
    const out:Record<string,unknown>={};
    for(const key of keys){
      const childNode=node.children.get(key);
      if(!childNode){count(counts,"required_property_not_opted_in");return undefined;}
      const childSchema=properties[key];
      if(childSchema===undefined){count(counts,"required_property_schema_missing");return undefined;}
      const value=generateValue(childSchema,snapshot,childNode,stack,counts,depth+1);
      if(value===undefined)return undefined;
      Object.defineProperty(out,key,{value,enumerable:true,writable:true,configurable:true});
    }
    return out;
  }
  if(type==="array"){
    if(hasAny(schema,["properties","required","minLength","maxLength"])){
      count(counts,"schema_type_constraint_mismatch");return undefined;
    }
    if(schema.minimum!==undefined||schema.maximum!==undefined){count(counts,"schema_constraint_unsupported");return undefined;}
    const min=schema.minItems===undefined?0:schema.minItems,max=schema.maxItems===undefined?32:schema.maxItems;
    if(!validInteger(min,0,32)||!validInteger(max,0,32)||min>max){count(counts,"schema_constraint_unsupported");return undefined;}
    const hasItemSelection=node.children.size>0;
    const length=Math.max(min,hasItemSelection?1:0);
    if(length>max){count(counts,"schema_constraint_unsupported");return undefined;}
    if(length===0)return [];
    if(schema.items===undefined){count(counts,"schema_items_missing");return undefined;}
    const values:unknown[]=[];
    for(let i=0;i<length;i++){
      const item=generateValue(schema.items,snapshot,node,stack,counts,depth+1);
      if(item===undefined)return undefined;values.push(item);
    }
    return values;
  }
  if(node.children.size>0){count(counts,"policy_path_type_mismatch");return undefined;}
  if(!node.terminal){count(counts,"property_not_opted_in");return undefined;}
  if(type==="string"){
    if(hasAny(schema,["minimum","maximum","properties","required","items","minItems","maxItems"])){
      count(counts,"schema_type_constraint_mismatch");return undefined;
    }
    const min=schema.minLength===undefined?0:schema.minLength,max=schema.maxLength===undefined?128:schema.maxLength;
    if(!validInteger(min,0,128)||!validInteger(max,0,128)||min>max){count(counts,"schema_constraint_unsupported");return undefined;}
    const base="string",value=base.length>=min?base:"x".repeat(min);
    if(value.length>max){count(counts,"schema_constraint_unsupported");return undefined;}return value;
  }
  if(type==="integer"||type==="number"){
    if(hasAny(schema,["minLength","maxLength","properties","required","items","minItems","maxItems"])
      ||!safeNumberBounds(schema)){count(counts,"schema_constraint_unsupported");return undefined;}
    const low:number=schema.minimum===undefined?Number.NEGATIVE_INFINITY:schema.minimum as number;
    const high:number=schema.maximum===undefined?Number.POSITIVE_INFINITY:schema.maximum as number;
    const value:number=type==="integer"?(low>0?Math.ceil(low):high<0?Math.floor(high):0)
      :low>0?low:high<0?high:0;
    if(!Number.isFinite(value)||value>high||type==="integer"&&!Number.isSafeInteger(value)){count(counts,"schema_constraint_unsupported");return undefined;}
    return value;
  }
  if(type==="boolean"){
    if(Object.keys(schema).some(key=>key!=="type")){count(counts,"schema_type_constraint_mismatch");return undefined;}
    return false;
  }
  if(type==="null"){
    if(Object.keys(schema).some(key=>key!=="type")){count(counts,"schema_constraint_unsupported");return undefined;}return null;
  }
  count(counts,"schema_type_unsupported");return undefined;
};

/**
 * Builds a deterministic placeholder only. The resolved view must come from a fresh, authorized
 * QueryReader read by the host; this pure shape validator cannot prove authorization or freshness.
 */
export const buildSyntheticExample=(resolvedView:unknown,selectedEndpointId:unknown,policyInput:unknown):SyntheticExampleResult=>{
  const view=cloneBounded(resolvedView);if(!plain(view)||view.status!=="resolved")return fail();
  const selection=view.selector,snapshotValue=view.snapshot,pin=view.pin;
  if(!plain(selection)||!plain(selection.selector)||!plain(pin)||!plain(snapshotValue))return fail();
  if(!boundedText(selectedEndpointId)||!boundedText(selection.tenantId)||!boundedText(selection.repositoryId)
    ||!boundedText(selection.serviceId)||!boundedText(selection.selector.environment)
    ||selection.version!=="1"||selection.selector.kind!=="environment"||!boundedText(pin.snapshotId)||!boundedText(pin.revision)
    ||!boundedText(pin.configFingerprint)||!boundedText(pin.checkpointVersion)
    ||selection.selector.expectedCheckpointVersion!==undefined&&selection.selector.expectedCheckpointVersion!==pin.checkpointVersion)
    return fail();
  if(!Array.isArray(snapshotValue.endpoints)||!plain(snapshotValue.schemas)
    ||!plain(snapshotValue.service)||!plain(snapshotValue.source)||!plain(snapshotValue.config))return fail();
  const snapshot=snapshotValue as unknown as ContractSnapshot;
  if(snapshot.snapshot_id!==pin.snapshotId||snapshot.source.immutable_revision!==pin.revision
    ||snapshot.source.repository_id!==selection.repositoryId
    ||!boundedText(snapshot.source.source_digest)
    ||snapshot.config.config_fingerprint!==pin.configFingerprint||snapshot.service.service_id!==selection.serviceId
    ||snapshot.service.repository_id!==selection.repositoryId)return fail();
  const policy=getPolicy(policyInput);
  if(policy.endpointId!==selectedEndpointId)return fail();
  if(policy.propertyPaths.length===0)return withheld(new Map(),"no_properties_opted_in");
  if(snapshot.endpoints.some(item=>!plain(item)||!boundedText(item.endpoint_id)))return fail();
  const endpointMatches=snapshot.endpoints.filter(item=>item.endpoint_id===selectedEndpointId);
  if(endpointMatches.length!==1)return withheld(new Map(),endpointMatches.length===0?"endpoint_not_found":"endpoint_ambiguous");
  const rawEndpoint=endpointMatches[0];if(!plain(rawEndpoint))return fail();
  if(!Array.isArray(rawEndpoint.request_bodies)||!Array.isArray(rawEndpoint.responses))return fail();
  for(const body of rawEndpoint.request_bodies){
    if(!plain(body)||!boundedText(body.media_type)||!plain(body.presence)
      ||!(["required","optional","unknown"] as unknown[]).includes(body.presence.state))return fail();
  }
  for(const response of rawEndpoint.responses){
    if(!plain(response)||!plain(response.status)||!Array.isArray(response.content))return fail();
    for(const content of response.content)if(!plain(content)||!boundedText(content.media_type))return fail();
  }
  const endpoint=rawEndpoint as unknown as ContractSnapshot["endpoints"][number];
  let schema:unknown;
  if(policy.direction==="request"){
    const matches=endpoint.request_bodies.filter(body=>body.media_type===policy.mediaType);
    if(matches.length!==1||!(matches[0]!.presence.state==="required"||matches[0]!.presence.state==="optional"))
      return withheld(new Map(),"request_body_not_unambiguous");
    schema=matches[0]!.schema;
  }else{
    const response=endpoint.responses.filter(item=>item.status.kind==="exact"&&item.status.code===policy.statusCode);
    if(response.length!==1)return withheld(new Map(),"response_not_unambiguous");
    const matches=response[0]!.content.filter(item=>item.media_type===policy.mediaType);
    if(matches.length!==1)return withheld(new Map(),"response_media_not_unambiguous");
    schema=matches[0]!.schema;
  }
  const counts:MutableCount=new Map();
  const value=generateValue(schema,snapshot,buildTrie(policy.propertyPaths),new Set(),counts,0);
  if(value===undefined)return withheld(counts);
  const scope={tenantId:selection.tenantId,repositoryId:selection.repositoryId,serviceId:selection.serviceId,
    environment:selection.selector.environment,revision:pin.revision,snapshotId:pin.snapshotId,sourceDigest:snapshot.source.source_digest,
    configFingerprint:pin.configFingerprint,checkpointVersion:pin.checkpointVersion,endpointId:selectedEndpointId,
    direction:policy.direction,...(policy.direction==="response"?{statusCode:policy.statusCode}:{}),mediaType:policy.mediaType};
  return Object.freeze({status:"generated",kind:"synthetic_example",nonNormative:true,policyVersion:policy.version,
    scope:Object.freeze(scope),fingerprints:Object.freeze({schemaSha256:digest(schemaFingerprintMaterial(schema,snapshot)),
      policySha256:digest(policy)}),
    value:freezeJson(value),diagnostics:resultDiagnostics(counts)});
};
