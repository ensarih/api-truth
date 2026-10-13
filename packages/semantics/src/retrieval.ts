import {createHash} from 'node:crypto';
import {isProxy} from 'node:util/types';
import {canonicalJsonStringify} from '../../ir/src/index.js';
import type {QueryReader,QuerySelection,QueryPin} from '../../query/src/index.js';
import type {createSemanticService} from './service.js';
import {isSemanticIntentQuerySafe,isSemanticDocumentTextSafe,isSemanticSourceRouteSafe} from './egress.js';

export class SemanticRetrievalError extends Error {
 constructor(readonly code:'SEMANTIC_RETRIEVAL_INVALID_REQUEST'|'SEMANTIC_RETRIEVAL_UNAVAILABLE'|'SEMANTIC_RETRIEVAL_STALE_CONTEXT'){super(code);}
}
export type SemanticEmbeddingPort=Readonly<{spaceId:string;dimensions:number;embed(texts:readonly string[]):Promise<unknown>}>;
type Context={tenantId:string;principalId:string};
type Options={environment:string;intentQuery:string;limit:number};
type Document={repositoryId:string;serviceId:string;endpointId:string;method:string;path:string;selector:QuerySelection;pin:QueryPin;configurationHash:string;text:string;evidenceIds:string[]};
const invalid=():never=>{throw new SemanticRetrievalError('SEMANTIC_RETRIEVAL_INVALID_REQUEST');};
const unavailable=():never=>{throw new SemanticRetrievalError('SEMANTIC_RETRIEVAL_UNAVAILABLE');};
const hash=(value:unknown)=>createHash('sha256').update(canonicalJsonStringify(value)).digest('hex');
const fields=(value:unknown,names:readonly string[]):Record<string,unknown>=>{
 if(!value||typeof value!=='object'||isProxy(value)||Array.isArray(value)||Object.getPrototypeOf(value)!==Object.prototype)return invalid();
 const keys=Reflect.ownKeys(value);if(keys.length!==names.length||keys.some(key=>typeof key!=='string'||!names.includes(key)))return invalid();
 const out:Record<string,unknown>={};for(const name of names){const descriptor=Object.getOwnPropertyDescriptor(value,name);if(!descriptor||!descriptor.enumerable||!('value' in descriptor))return invalid();out[name]=descriptor.value;}return out;
};
/** Detaches bounded host-port data without invoking getters, proxy traps or JSON hooks. */
const copyBounded=(raw:unknown,budget:{bytes:number;nodes:number})=>{
 let nodes=0,bytes=0;const active=new Set<object>();
 const charge=(size:number)=>{bytes+=size;budget.bytes+=size;if(bytes>4*1024*1024||budget.bytes>16*1024*1024)throw Error();};
 const walk=(value:unknown,depth:number):any=>{
  if(++nodes>100_000||++budget.nodes>1_000_000||depth>64)throw Error();
  if(typeof value==='string'){charge(Buffer.byteLength(value));return value;}
  if(value===null||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value)){charge(8);return value;}
  if(!value||typeof value!=='object'||isProxy(value)||active.has(value))throw Error();
  const array=Array.isArray(value);if(Object.getPrototypeOf(value)!==(array?Array.prototype:Object.prototype))throw Error();
  active.add(value);const result:any=array?[]:{};const keys=Reflect.ownKeys(value);
  if(keys.length>10_001)throw Error();
  for(const key of keys){if(typeof key!=='string')throw Error();charge(Buffer.byteLength(key));if(array&&key==='length')continue;
   const descriptor=Object.getOwnPropertyDescriptor(value,key);if(!descriptor||!descriptor.enumerable||!('value' in descriptor))throw Error();
   if(array&&key!==String(result.length))throw Error();
   Object.defineProperty(result,key,{value:walk(descriptor.value,depth+1),enumerable:true,writable:true,configurable:true});
  }
  if(array&&keys.length!==result.length+1)throw Error();active.delete(value);return result;
 };
 return walk(raw,0);
};
const freeze=(value:any):any=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};
const vector=(value:unknown,dimensions:number):readonly number[]=>{
 if(!Array.isArray(value)||value.length!==dimensions||value.some(item=>typeof item!=='number'||!Number.isFinite(item)))return unavailable();
 const max=Math.max(...value.map(Math.abs));if(max===0)return unavailable();
 const scaled=value.map(item=>item/max),norm=Math.hypot(...scaled);
 return Object.freeze(scaled.map(item=>item/norm));
};
export type SemanticRetrievalResult=Readonly<{status:'candidates';matchMode:'semantic';scope:'visible_authorized_context';environment:string;
 verification:'inferred';review:'unreviewed';normative:false;complete:boolean;truncated:boolean;
 embeddingSpace:string;candidates:readonly Readonly<Omit<Document,'text'|'configurationHash'>&{score:number}>[]}>;

/** Host-configured exact-context vector cache. Authorized source context is always reread before ranking. */
export const createSemanticRetrievalService=(raw:{query:Pick<QueryReader,'searchServices'|'readContract'>;
 context:Pick<ReturnType<typeof createSemanticService>,'readRetrievalContext'>;embedding:SemanticEmbeddingPort;deadlineMs?:number;cacheEntries?:number})=>{
 if(!raw||typeof raw!=='object'||isProxy(raw))return invalid();
 let options:Record<string,unknown>;
 try{const keys=['query','context','embedding',...(Object.hasOwn(raw,'deadlineMs')?['deadlineMs']:[]),...(Object.hasOwn(raw,'cacheEntries')?['cacheEntries']:[])];options=fields(raw,keys);}catch{return invalid();}
 const methods=(input:unknown,names:string[])=>{if(!input||typeof input!=='object'||isProxy(input))return invalid();const out:Record<string,unknown>={};for(const name of names){const field=Object.getOwnPropertyDescriptor(input,name);if(!field||!('value' in field))return invalid();out[name]=field.value;}return out;};
 const query=methods(options.query,['searchServices','readContract']),context=methods(options.context,['readRetrievalContext']),embedding=fields(options.embedding,['spaceId','dimensions','embed']);
 for(const method of [query.searchServices,query.readContract,context.readRetrievalContext,embedding.embed])if(typeof method!=='function'||isProxy(method))return invalid();
 if(typeof embedding.spaceId!=='string'||!(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/).test(embedding.spaceId)||!Number.isInteger(embedding.dimensions)||Number(embedding.dimensions)<1||Number(embedding.dimensions)>4096)return invalid();
 const deadline=options.deadlineMs??30_000,capacity=options.cacheEntries??512;
 if(!Number.isInteger(deadline)||Number(deadline)<1||Number(deadline)>60_000||!Number.isInteger(capacity)||Number(capacity)<0||Number(capacity)>2048)return invalid();
 const cache=new Map<string,readonly number[]>();let cacheGeneration=0;
 const embed=(embedding.embed as SemanticEmbeddingPort['embed']).bind(options.embedding);
 const search=(query.searchServices as QueryReader['searchServices']).bind(options.query),read=(query.readContract as QueryReader['readContract']).bind(options.query);
 const project=(context.readRetrievalContext as ReturnType<typeof createSemanticService>['readRetrievalContext']).bind(options.context);
 const spaceId=embedding.spaceId,dimensions=Number(embedding.dimensions);
 return Object.freeze({
  async retrieve(rawContext:unknown,rawRequest:unknown):Promise<SemanticRetrievalResult>{
   const identity=fields(rawContext,['tenantId','principalId']),request=fields(rawRequest,['environment','intentQuery','limit']);
   for(const value of [identity.tenantId,identity.principalId,request.environment])if(typeof value!=='string'||value.length<1||value.length>512||/[\u0000-\u001f\u007f]/.test(value))return invalid();
   if(!isSemanticIntentQuerySafe(request.intentQuery)||typeof request.limit!=='number'||!Number.isInteger(request.limit)||request.limit<1||request.limit>16)return invalid();
   const caller=Object.freeze(identity) as Context,wanted=Object.freeze(request) as Options,started=performance.now();
   const pending=new Map<string,readonly number[]>(),cacheAtStart=cacheGeneration;
   const budget={bytes:0,nodes:0},copy=(value:unknown)=>copyBounded(value,budget);
   const call=async<T>(operation:()=>Promise<T>):Promise<T>=>{
    const remaining=Number(deadline)-(performance.now()-started);if(remaining<=0)return unavailable();
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{return await Promise.race([Promise.resolve().then(operation),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new SemanticRetrievalError('SEMANTIC_RETRIEVAL_UNAVAILABLE')),remaining);timer.unref?.();})]);}
    finally{if(timer!==undefined)clearTimeout(timer);}
   };
   const scan=async()=>{
    const listed=copy(await call(()=>search(caller,{tenantId:caller.tenantId,query:'',environment:wanted.environment,limit:50})));
    if(!Array.isArray(listed.services)||listed.services.length>50||listed.truncated!==false)throw Error();
    const documents:Document[]=[];let complete=true,inspected=0,textBytes=0;
    const namespaces=new Set<string>();
    serviceLoop: for(const service of listed.services){
     const priorDocumentCount=documents.length;
     if(typeof service.repositoryId!=='string'||typeof service.serviceId!=='string')throw Error();
     const namespace=JSON.stringify([service.repositoryId,service.serviceId]);if(namespaces.has(namespace))throw Error();namespaces.add(namespace);
     const environment=service.environment;if(environment?.name!==wanted.environment||environment.status!=='resolved'||typeof environment.pin?.checkpointVersion!=='string'){complete=false;continue;}
     const selection:QuerySelection={version:'1',tenantId:caller.tenantId,repositoryId:service.repositoryId,serviceId:service.serviceId,selector:{kind:'environment',environment:wanted.environment,expectedCheckpointVersion:environment.pin.checkpointVersion}};
     const selected=copy(await call(()=>read(caller,selection)));
     if(selected.status!=='resolved'||hash(selected.pin)!==hash(environment.pin))throw new SemanticRetrievalError('SEMANTIC_RETRIEVAL_STALE_CONTEXT');
     const endpoints=selected.snapshot?.endpoints;if(!Array.isArray(endpoints))throw Error();
     if(inspected+endpoints.length>256){complete=false;break;}inspected+=endpoints.length;
     for(let offset=0;offset<endpoints.length;offset+=16){
      const ids=endpoints.slice(offset,offset+16).map((item:any)=>item.endpoint_id);
      let projected:any;
      try{projected=copy(await call(()=>project(caller,selection,ids)));}
      catch(error){
       if(error&&typeof error==='object'&&!isProxy(error)&&Object.getOwnPropertyDescriptor(error,'code')?.value==='SEMANTIC_NOT_FOUND_OR_DENIED'){
        documents.splice(priorDocumentCount);complete=false;continue serviceLoop;
       }
       throw error;
      }
      if(projected.source?.repositoryId!==service.repositoryId||projected.source.serviceId!==service.serviceId||hash(projected.source.pin)!==hash(selected.pin)||hash(projected.source.selector)!==hash(selection.selector)||typeof projected.configurationHash!=='string'||!/^sha256:[a-f0-9]{64}$/.test(projected.configurationHash)||!Array.isArray(projected.endpoints)||projected.endpoints.length>ids.length)throw Error();
      if(projected.endpoints.length!==ids.length||selected.snapshot.coverage.status!=='complete')complete=false;
      for(const endpoint of projected.endpoints){
       if(!ids.includes(endpoint.endpointId)||!isSemanticSourceRouteSafe(endpoint.method,endpoint.applicationPath)||!Array.isArray(endpoint.documents)||endpoint.documents.length<1||endpoint.documents.length>16)throw Error();
       const text=endpoint.documents.map((item:any)=>{if(!['operation_summary','operation_description','response_description','operation_id','code_route','code_handler','code_action'].includes(item.kind)||!isSemanticDocumentTextSafe(item.text,2048)||!Array.isArray(item.evidenceIds)||item.evidenceIds.length<1||item.evidenceIds.length>8||item.evidenceIds.some((id:unknown)=>typeof id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)))throw Error();return item.kind+': '+item.text;}).join('\n');
       textBytes+=Buffer.byteLength(text);if(textBytes>64*1024)throw Error();
       documents.push({repositoryId:service.repositoryId,serviceId:service.serviceId,endpointId:endpoint.endpointId,method:endpoint.method,path:endpoint.applicationPath,selector:selection,pin:selected.pin,configurationHash:projected.configurationHash,text,evidenceIds:[...new Set<string>(endpoint.documents.flatMap((item:any)=>item.evidenceIds))].sort()});
      }
     }
    }
    documents.sort((a,b)=>Buffer.compare(Buffer.from(JSON.stringify([a.repositoryId,a.serviceId,a.endpointId])),Buffer.from(JSON.stringify([b.repositoryId,b.serviceId,b.endpointId]))));
    if(new Set(documents.map(item=>JSON.stringify([item.repositoryId,item.serviceId,item.endpointId]))).size!==documents.length)throw Error();
    return {documents,complete};
   };
   try{
    const initial=await scan();
    const fingerprint=hash(initial),vectors=new Map<string,readonly number[]>();
    const key=(document:Document)=>hash({caller,environment:wanted.environment,spaceId,dimensions,document});
    const missing=initial.documents.filter(document=>{const digest=key(document),cached=cache.get(digest);if(cached){vectors.set(digest,cached);return false;}return true;});
    for(let offset=0;offset<missing.length;offset+=16){const batch=missing.slice(offset,offset+16),result=copy(await call(()=>embed(Object.freeze(batch.map(item=>item.text)))));
     if(!Array.isArray(result)||result.length!==batch.length)throw Error();for(let i=0;i<batch.length;i++){const digest=key(batch[i]!),normalized=vector(result[i],dimensions);vectors.set(digest,normalized);pending.set(digest,normalized);}}
    const queryVector=initial.documents.length?copy(await call(()=>embed(Object.freeze([wanted.intentQuery])))):[];
    if(initial.documents.length&&(!Array.isArray(queryVector)||queryVector.length!==1))throw Error();
    const normalized=initial.documents.length?vector(queryVector[0],dimensions):[];
    const ranked=initial.documents.map(document=>{const {text:_,configurationHash:__,...safe}=document;return {...safe,score:Math.max(-1,Math.min(1,vectors.get(key(document))!.reduce((sum,value,index)=>sum+value*normalized[index]!,0)))};}).sort((a,b)=>b.score-a.score||Buffer.compare(Buffer.from(JSON.stringify([a.repositoryId,a.serviceId,a.endpointId])),Buffer.from(JSON.stringify([b.repositoryId,b.serviceId,b.endpointId]))));
    if(hash(await scan())!==fingerprint)throw new SemanticRetrievalError('SEMANTIC_RETRIEVAL_STALE_CONTEXT');
    if(performance.now()-started>=Number(deadline))return unavailable();
    if(cacheAtStart===cacheGeneration)for(const [digest,value] of pending){cache.set(digest,value);while(cache.size>Number(capacity))cache.delete(cache.keys().next().value!);}
    return freeze({status:'candidates',matchMode:'semantic',scope:'visible_authorized_context',environment:wanted.environment,verification:'inferred',review:'unreviewed',normative:false,embeddingSpace:spaceId,candidates:ranked.slice(0,wanted.limit),complete:initial.complete,truncated:ranked.length>wanted.limit});
   }catch(error){
    if(error&&typeof error==='object'&&!isProxy(error)&&Object.getPrototypeOf(error)===SemanticRetrievalError.prototype&&Object.getOwnPropertyDescriptor(error,'code')?.value==='SEMANTIC_RETRIEVAL_STALE_CONTEXT')throw new SemanticRetrievalError('SEMANTIC_RETRIEVAL_STALE_CONTEXT');
    return unavailable();
   }
  },
  clearCache(){cacheGeneration++;cache.clear();},
 });
};
