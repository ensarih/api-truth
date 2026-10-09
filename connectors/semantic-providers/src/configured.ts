import {isProxy} from "node:util/types";
import type {SemanticProviderBinding,SemanticProviderFactory,SemanticSecretRef}
  from "../../../packages/semantics/src/index.js";
import {createSemanticProvider,SemanticProviderError} from "./index.js";

export type TrustedSemanticSecretResolver=(context:Readonly<{tenantId:string;
  secretRef:SemanticSecretRef}>)=>string|Promise<string>;
type Options=Readonly<{resolveSecret:TrustedSemanticSecretResolver;fetch?:typeof globalThis.fetch;
  timeoutMs?:number;maxRequestBytes?:number;maxResponseBytes?:number}>;

const data=(input:unknown,names:readonly string[]):Record<string,unknown>|undefined=>{
  try{
    if(!input||typeof input!=="object"||Array.isArray(input)||isProxy(input)
      ||Object.getPrototypeOf(input)!==Object.prototype)return undefined;
    const keys=Reflect.ownKeys(input);
    if(keys.some(key=>typeof key!=="string"||!names.includes(key)))return undefined;
    const output:Record<string,unknown>={};
    for(const key of keys){
      const descriptor=Object.getOwnPropertyDescriptor(input,key);
      if(!descriptor||!("value" in descriptor))return undefined;
      output[key as string]=descriptor.value;
    }
    return output;
  }catch{return undefined;}
};
const fail=():never=>{throw new SemanticProviderError("SEMANTIC_PROVIDER_INVALID_REQUEST");};
const validateRef=(input:unknown):SemanticSecretRef=>{
  const ref=data(input,["scheme","locator"]);
  if(!ref||Object.keys(ref).length!==2||typeof ref.locator!=="string"
    ||ref.locator.length>1024)return fail();
  if(ref.scheme==="env"&&!/^[A-Z][A-Z0-9_]{1,127}$/.test(ref.locator))return fail();
  if(ref.scheme==="vault"&&!/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+#[A-Za-z0-9_.-]+$/.test(ref.locator))return fail();
  if(ref.scheme!=="env"&&ref.scheme!=="vault")return fail();
  return Object.freeze({scheme:ref.scheme,locator:ref.locator});
};
const validateBinding=(input:unknown):SemanticProviderBinding=>{
  const binding=data(input,["tenantId","provider","model","secretRef"]);
  if(!binding||Object.keys(binding).length!==4
    ||typeof binding.tenantId!=="string"||!/^[^\u0000-\u001f\u007f]{1,512}$/.test(binding.tenantId)
    ||typeof binding.provider!=="string"||!["openai","gemini","claude"].includes(binding.provider)
    ||typeof binding.model!=="string"||binding.model.length<1||binding.model.length>128
    ||/[\u0000-\u001f\u007f]/.test(binding.model))return fail();
  return Object.freeze({tenantId:binding.tenantId,provider:binding.provider as SemanticProviderBinding["provider"],
    model:binding.model,secretRef:validateRef(binding.secretRef)});
};

/** Binds a provider to an authorized tenant configuration without caching keys across calls. */
export const createConfiguredSemanticProviderFactory=(input:Options):SemanticProviderFactory=>{
  const options=data(input,["resolveSecret","fetch","timeoutMs","maxRequestBytes","maxResponseBytes"]);
  if(!options||typeof options.resolveSecret!=="function"
    ||options.fetch!==undefined&&typeof options.fetch!=="function"
    ||options.timeoutMs!==undefined&&(!Number.isSafeInteger(options.timeoutMs)
      ||(options.timeoutMs as number)<1||(options.timeoutMs as number)>30_000)
    ||options.maxRequestBytes!==undefined&&(!Number.isSafeInteger(options.maxRequestBytes)
      ||(options.maxRequestBytes as number)<1||(options.maxRequestBytes as number)>128*1024)
    ||options.maxResponseBytes!==undefined&&(!Number.isSafeInteger(options.maxResponseBytes)
      ||(options.maxResponseBytes as number)<1||(options.maxResponseBytes as number)>128*1024))return fail();
  const resolveSecret=options.resolveSecret as TrustedSemanticSecretResolver;
  const fetcher=options.fetch as typeof globalThis.fetch|undefined;
  const timeoutMs=options.timeoutMs as number|undefined;
  const maxRequestBytes=options.maxRequestBytes as number|undefined;
  const maxResponseBytes=options.maxResponseBytes as number|undefined;
  return rawBinding=>{
    const binding=validateBinding(rawBinding);
    const secretContext=Object.freeze({tenantId:binding.tenantId,secretRef:binding.secretRef});
    const port=createSemanticProvider(binding.provider,{resolveApiKey:()=>resolveSecret(secretContext),
      ...(fetcher?{fetch:fetcher}:{}),
      ...(timeoutMs!==undefined?{timeoutMs}:{}),
      ...(maxRequestBytes!==undefined?{maxRequestBytes}:{}),
      ...(maxResponseBytes!==undefined?{maxResponseBytes}:{})});
    return async request=>{
      const selected=data(request,["promptVersion","intentQuery","provider","model","source","endpoints"]);
      if(!selected||selected.provider!==binding.provider||selected.model!==binding.model)return fail();
      return port(request);
    };
  };
};
