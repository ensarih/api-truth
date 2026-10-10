import {createPublicKey,verify,type KeyObject} from "node:crypto";
import {constants} from "node:fs";
import {lstat,open,realpath} from "node:fs/promises";
import {isAbsolute,join,resolve} from "node:path";
import {isProxy} from "node:util/types";
import {canonicalJsonStringify} from "../../../packages/ir/src/index.js";
import {parseStrictJson} from "../../../packages/ir/src/strict-json.js";
import type {FieldPresenceImportReadPort} from "../../../packages/observations/src/field-presence-import-store.js";

const MAX_FILE_BYTES=1_048_576,MAX_PAYLOAD_BYTES=262_144,MAX_BINDINGS=128;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const IDENTIFIER=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CAPABILITY=/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const POSITIVE=/^[1-9][0-9]{0,18}$/;
const PIN_KEYS=["tenantId","repositoryId","serviceId","environment","snapshotId","revision","configFingerprint","checkpointVersion"] as const;
const BINDING_KEYS=["tenantId","repositoryId","serviceId","environment"] as const;
const REQUEST_KEYS=["binding","importId","recordId","expectedPin","selector","source"] as const;
const SELECTOR_BASE_KEYS=["endpointId","direction","mediaType"] as const;
const SOURCE_KEYS=["sourceId","sourceVersion","windowStart","windowEnd"] as const;
const encoder=new TextEncoder(),decoder=new TextDecoder("utf-8",{fatal:true});

export type SignedFieldPresenceFileBinding=Readonly<{tenantId:string;repositoryId:string;serviceId:string;environment:string}>;
export type SignedFieldPresenceFileReaderOptions=Readonly<{root:string;publicKeyPem:string;sourceId:string;
  bindings:readonly SignedFieldPresenceFileBinding[]}>;

export type SignedFieldPresenceFileErrorCode="FIELD_PRESENCE_FILE_INVALID_CONFIG"|"FIELD_PRESENCE_FILE_UNAVAILABLE"|"FIELD_PRESENCE_FILE_REJECTED";
export class SignedFieldPresenceFileError extends Error{
  readonly code:SignedFieldPresenceFileErrorCode;
  constructor(code:SignedFieldPresenceFileErrorCode){super(code);this.name="SignedFieldPresenceFileError";this.code=code;}
}
const fail=(code:SignedFieldPresenceFileErrorCode):never=>{throw new SignedFieldPresenceFileError(code);};
const plain=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==="object"&&!isProxy(value)
  &&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const fields=(input:unknown,keys:readonly string[]):Record<string,unknown>|undefined=>{
  try{
    if(!plain(input))return undefined;const own=Reflect.ownKeys(input);
    if(own.length!==keys.length||own.some(key=>typeof key!=="string"||!keys.includes(key)))return undefined;
    const out:Record<string,unknown>={};for(const key of keys){const descriptor=Object.getOwnPropertyDescriptor(input,key);
      if(!descriptor||!descriptor.enumerable||!("value" in descriptor))return undefined;
      Object.defineProperty(out,key,{value:descriptor.value,enumerable:true,writable:true,configurable:true});}
    return out;
  }catch{return undefined;}
};
const allowedFields=(input:unknown,required:readonly string[],optional:readonly string[]=[]):Record<string,unknown>|undefined=>{
  try{
    if(!plain(input))return undefined;const own=Reflect.ownKeys(input);
    if(required.some(key=>!own.includes(key))||own.some(key=>typeof key!=="string"||![...required,...optional].includes(key)))return undefined;
    const out:Record<string,unknown>={};for(const key of own as string[]){const descriptor=Object.getOwnPropertyDescriptor(input,key);
      if(!descriptor||!descriptor.enumerable||!("value" in descriptor))return undefined;
      Object.defineProperty(out,key,{value:descriptor.value,enumerable:true,writable:true,configurable:true});}
    return out;
  }catch{return undefined;}
};
const arrayValues=(input:unknown,maximum:number):unknown[]|undefined=>{
  try{
    if(isProxy(input)||!Array.isArray(input)||Object.getPrototypeOf(input)!==Array.prototype
      ||input.length>maximum||Reflect.ownKeys(input).length!==input.length+1)return undefined;
    const out:unknown[]=[];for(let i=0;i<input.length;i++){const descriptor=Object.getOwnPropertyDescriptor(input,String(i));
      if(!descriptor||!descriptor.enumerable||!("value" in descriptor))return undefined;out.push(descriptor.value);}
    return out;
  }catch{return undefined;}
};
const identifier=(value:unknown):value is string=>typeof value==="string"&&IDENTIFIER.test(value);
const mediaType=(value:unknown):value is string=>typeof value==="string"&&value.length<=128
  &&/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(value);
const digest=(value:unknown):value is string=>typeof value==="string"&&/^sha256:[0-9a-f]{64}$/.test(value);
const positive=(value:unknown):value is string=>typeof value==="string"&&POSITIVE.test(value)&&BigInt(value)<=9223372036854775807n;
const same=(left:Record<string,unknown>,right:Record<string,unknown>,keys:readonly string[])=>keys.every(key=>left[key]===right[key]);
const bindingKey=(value:Record<string,unknown>)=>JSON.stringify(BINDING_KEYS.map(key=>value[key]));
const abortState=(signal:unknown):boolean|undefined=>{
  try{if(!signal||typeof signal!=="object"||isProxy(signal))return undefined;
    const getter=Object.getOwnPropertyDescriptor(AbortSignal.prototype,"aborted")?.get;
    return getter?.call(signal) as boolean|undefined;
  }catch{return undefined;}
};
const sourceTime=(value:unknown):value is string=>typeof value==="string"
  &&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
  &&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
const utf8Text=(value:unknown,maxBytes:number):value is string=>{
  if(typeof value!=="string")return false;
  try{const bytes=encoder.encode(value);return bytes.byteLength<=maxBytes&&decoder.decode(bytes)===value;}catch{return false;}
};
const canonicalBinding=(input:unknown):Record<string,string>|undefined=>{
  const parsed=fields(input,BINDING_KEYS);if(!parsed||BINDING_KEYS.some(key=>!identifier(parsed[key])))return undefined;
  return Object.freeze(Object.fromEntries(BINDING_KEYS.map(key=>[key,parsed[key]]))) as Record<string,string>;
};
const parsePin=(input:unknown):Record<string,string>|undefined=>{
  const pin=fields(input,PIN_KEYS);
  if(!pin||PIN_KEYS.slice(0,-2).some(key=>!identifier(pin[key]))||!digest(pin.configFingerprint)||!positive(pin.checkpointVersion))return undefined;
  return Object.freeze(Object.fromEntries(PIN_KEYS.map(key=>[key,pin[key]]))) as Record<string,string>;
};
const selected=(identityInput:unknown,requestInput:unknown,bindings:ReadonlyMap<string,Record<string,string>>)=>{
  const identity=fields(identityInput,["tenantId","principalId","capabilities"]),caps=arrayValues(identity?.capabilities,16);
  const request=fields(requestInput,REQUEST_KEYS),rawBinding=allowedFields(request?.binding,BINDING_KEYS,
    ["policyId","ownerAccessScopeId","importAccessScopeId"]),binding=rawBinding&&canonicalBinding(
      Object.fromEntries(BINDING_KEYS.map(key=>[key,rawBinding[key]]))),pin=parsePin(request?.expectedPin);
  const importId=request?.importId,recordId=request?.recordId;
  const selector=allowedFields(request?.selector,SELECTOR_BASE_KEYS,["statusCode"]);
  const source=fields(request?.source,SOURCE_KEYS);
  if(!identity||!identifier(identity.tenantId)||!identifier(identity.principalId)||!caps||!caps.includes("observations.presence.import")
    ||caps.some(value=>typeof value!=="string"||!CAPABILITY.test(value))||new Set(caps).size!==caps.length||!binding||identity.tenantId!==binding.tenantId||!pin||!same(binding,pin,BINDING_KEYS)
    ||typeof importId!=="string"||!UUID.test(importId)||typeof recordId!=="string"||!UUID.test(recordId)
    ||!selector||!identifier(selector.endpointId)||!mediaType(selector.mediaType)
    ||!(["request","response"] as unknown[]).includes(selector.direction)
    ||selector.direction==="request"&&Object.hasOwn(selector,"statusCode")
    ||selector.direction==="response"&&(!Number.isInteger(selector.statusCode)||Number(selector.statusCode)<100||Number(selector.statusCode)>599)
    ||!source||!identifier(source.sourceId)||!identifier(source.sourceVersion)||!sourceTime(source.windowStart)||!sourceTime(source.windowEnd)
    ||source.windowStart>source.windowEnd)return undefined;
  const configured=bindings.get(bindingKey(binding));if(!configured)return undefined;
  const importBinding=rawBinding;
  if(!importBinding||!identifier(importBinding.policyId)||!identifier(importBinding.ownerAccessScopeId)
    ||!identifier(importBinding.importAccessScopeId))return undefined;
  return Object.freeze({identity:Object.freeze(identity),binding,importId,recordId,pin,selector:Object.freeze(selector),
    source:Object.freeze(source),policyId:importBinding.policyId});
};

const publicKey=(pem:string):KeyObject=>{
  try{if(Buffer.byteLength(pem,"utf8")>10_000||!pem.startsWith("-----BEGIN PUBLIC KEY-----"))return fail("FIELD_PRESENCE_FILE_INVALID_CONFIG");
    const key=createPublicKey(pem);if(key.asymmetricKeyType!=="ed25519")return fail("FIELD_PRESENCE_FILE_INVALID_CONFIG");return key;
  }catch{return fail("FIELD_PRESENCE_FILE_INVALID_CONFIG");}
};
const readFileBounded=async(root:string,importId:string,recordId:string,signal:AbortSignal):Promise<string>=>{
  let handle:Awaited<ReturnType<typeof open>>|undefined;
  try{
    if(abortState(signal)!==false)return fail("FIELD_PRESENCE_FILE_REJECTED");
    const rootStat=await lstat(root);if(!rootStat.isDirectory()||rootStat.isSymbolicLink()||await realpath(root)!==root)
      return fail("FIELD_PRESENCE_FILE_REJECTED");
    const path=join(root,`${importId}.${recordId}.presence.json`),before=await lstat(path);
    if(before.isSymbolicLink()||!before.isFile()||before.size>MAX_FILE_BYTES)return fail("FIELD_PRESENCE_FILE_REJECTED");
    handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    const initial=await handle.stat();
    if(!initial.isFile()||initial.size>MAX_FILE_BYTES||initial.dev!==before.dev||initial.ino!==before.ino)
      return fail("FIELD_PRESENCE_FILE_REJECTED");
    const buffer=Buffer.alloc(MAX_FILE_BYTES+1);let length=0;
    while(length<buffer.length){if(abortState(signal)!==false)return fail("FIELD_PRESENCE_FILE_REJECTED");
      const {bytesRead}=await handle.read(buffer,length,buffer.length-length,length);if(bytesRead===0)break;length+=bytesRead;}
    const final=await handle.stat();
    if(abortState(signal)!==false||length>MAX_FILE_BYTES||length!==initial.size
      ||final.size!==initial.size||final.dev!==initial.dev||final.ino!==initial.ino)
      return fail("FIELD_PRESENCE_FILE_REJECTED");
    return decoder.decode(buffer.subarray(0,length));
  }catch(error){
    if(error instanceof SignedFieldPresenceFileError)throw error;
    if(error&&typeof error==="object"&&Object.getOwnPropertyDescriptor(error,"code")?.value==="ENOENT")
      return fail("FIELD_PRESENCE_FILE_UNAVAILABLE");
    return fail("FIELD_PRESENCE_FILE_REJECTED");
  }finally{await handle?.close().catch(()=>undefined);}
};

const parseSignedFile=(text:string,key:KeyObject,selectedRequest:NonNullable<ReturnType<typeof selected>>,sourceId:string)=>{
  try{
    const envelope=fields(parseStrictJson(text,{maxDepth:20,maxNodes:10_000}),["payload","signature"]);
    const payload=fields(envelope?.payload,["version","attestation","payloadText","payloadCompleteness"]);
    if(!envelope||!payload||typeof envelope.signature!=="string"||!/^[A-Za-z0-9+/]{86}==$/.test(envelope.signature))
      return fail("FIELD_PRESENCE_FILE_REJECTED");
    const signature=Buffer.from(envelope.signature,"base64");
    if(signature.length!==64||signature.toString("base64")!==envelope.signature
      ||!verify(null,Buffer.from(`api-truth:field-presence-source-1\n${canonicalJsonStringify(payload)}`,"utf8"),key,signature))
      return fail("FIELD_PRESENCE_FILE_REJECTED");
    const attestation=payload.attestation;
    const attestationKeys=[...PIN_KEYS,"sourceDigest","importId","recordId","endpointId","direction","mediaType",
      ...(selectedRequest.selector.direction==="response"?["statusCode"]:[]),...SOURCE_KEYS];
    const signed=fields(attestation,attestationKeys);
    if(payload.version!=="field-presence-source-1"||!signed||!digest(signed.sourceDigest)
      ||!same(signed,selectedRequest.pin,PIN_KEYS)||signed.tenantId!==selectedRequest.binding.tenantId
      ||signed.importId!==selectedRequest.importId||signed.recordId!==selectedRequest.recordId
      ||signed.endpointId!==selectedRequest.selector.endpointId||signed.direction!==selectedRequest.selector.direction
      ||signed.mediaType!==selectedRequest.selector.mediaType
      ||Object.hasOwn(signed,"statusCode")!==Object.hasOwn(selectedRequest.selector,"statusCode")
      ||signed.statusCode!==selectedRequest.selector.statusCode
      ||signed.sourceId!==sourceId||signed.sourceId!==selectedRequest.source.sourceId
      ||!same(signed,selectedRequest.source,SOURCE_KEYS)
      ||payload.payloadCompleteness!=="complete_unredacted"||!utf8Text(payload.payloadText,MAX_PAYLOAD_BYTES))
      return fail("FIELD_PRESENCE_FILE_REJECTED");
    return Object.freeze({attestation:Object.freeze(signed),payloadText:payload.payloadText as string,
      payloadCompleteness:"complete_unredacted" as const});
  }catch(error){if(error instanceof SignedFieldPresenceFileError)throw error;return fail("FIELD_PRESENCE_FILE_REJECTED");}
};

/** Reads one explicitly selected signed payload from a trusted local directory. */
export const createSignedFieldPresenceFileReader=async(input:SignedFieldPresenceFileReaderOptions):Promise<FieldPresenceImportReadPort>=>{
  const options=fields(input,["root","publicKeyPem","sourceId","bindings"]);
  if(!options||typeof options.root!=="string"||!isAbsolute(options.root)||typeof options.publicKeyPem!=="string"
    ||!identifier(options.sourceId))return fail("FIELD_PRESENCE_FILE_INVALID_CONFIG");
  const rawBindings=arrayValues(options.bindings,MAX_BINDINGS);if(!rawBindings)return fail("FIELD_PRESENCE_FILE_INVALID_CONFIG");
  const bindings=new Map<string,Record<string,string>>();
  for(const raw of rawBindings){const binding=canonicalBinding(raw);if(!binding||bindings.has(bindingKey(binding)))return fail("FIELD_PRESENCE_FILE_INVALID_CONFIG");
    bindings.set(bindingKey(binding),binding);}
  let canonicalRoot:string,key:KeyObject;
  try{
    const root=resolve(options.root),entry=await lstat(root);
    if(!entry.isDirectory()||entry.isSymbolicLink())return fail("FIELD_PRESENCE_FILE_INVALID_CONFIG");
    canonicalRoot=await realpath(root);
    key=publicKey(options.publicKeyPem);
  }catch(error){if(error instanceof SignedFieldPresenceFileError)throw error;return fail("FIELD_PRESENCE_FILE_INVALID_CONFIG");}
  const sourceId=options.sourceId;
  return async(identity:unknown,request:unknown,signal:AbortSignal):Promise<unknown>=>{
    const chosen=selected(identity,request,bindings);if(!chosen)return fail("FIELD_PRESENCE_FILE_REJECTED");
    const aborted=abortState(signal);if(aborted!==false)return fail("FIELD_PRESENCE_FILE_REJECTED");
    const text=await readFileBounded(canonicalRoot,chosen.importId,chosen.recordId,signal);
    if(abortState(signal)!==false)return fail("FIELD_PRESENCE_FILE_REJECTED");
    return parseSignedFile(text,key,chosen,sourceId);
  };
};
