import {isProxy} from 'node:util/types';
import {parseStrictJson} from '../../../packages/ir/src/strict-json.js';
import {isSemanticDocumentTextSafe} from '../../../packages/semantics/src/egress.js';
import type {SemanticEmbeddingPort} from '../../../packages/semantics/src/retrieval.js';
export class OpenAiEmbeddingError extends Error{readonly code='OPENAI_EMBEDDING_UNAVAILABLE';constructor(){super('OPENAI_EMBEDDING_UNAVAILABLE');}}
const fail=():never=>{throw new OpenAiEmbeddingError();};
/** Native OpenAI embeddings endpoint. Resolve project keys server-side; never pass ChatGPT session tokens. */
export const createOpenAiEmbeddingPort=(options:{resolveApiKey:()=>string|Promise<string>;model?:'text-embedding-3-small'|'text-embedding-3-large';dimensions?:number;fetch?:typeof fetch;timeoutMs?:number}):SemanticEmbeddingPort=>{
 if(!options||typeof options!=='object'||isProxy(options))return fail();
 const properties=Object.getOwnPropertyDescriptors(options);
 if(Reflect.ownKeys(properties).some(key=>typeof key!=='string'||!['resolveApiKey','model','dimensions','fetch','timeoutMs'].includes(key)||!('value' in properties[key]!)))return fail();
 const resolve=properties.resolveApiKey?.value,model=properties.model?.value??'text-embedding-3-small',dimensions=properties.dimensions?.value??256,
  transport=properties.fetch?.value??globalThis.fetch,timeout=properties.timeoutMs?.value??30_000;
 if(typeof resolve!=='function'||isProxy(resolve)||typeof transport!=='function'||isProxy(transport)||!['text-embedding-3-small','text-embedding-3-large'].includes(model)
  ||!Number.isInteger(dimensions)||dimensions<1||dimensions>(model==='text-embedding-3-small'?1536:3072)||!Number.isInteger(timeout)||timeout<1||timeout>60_000)return fail();
 return Object.freeze({spaceId:'openai:'+model+':'+dimensions,dimensions,
  async embed(input:readonly string[]){
   if(isProxy(input)||!Array.isArray(input)||input.length<1||input.length>16)return fail();
   const texts:string[]=[];let bytes=0;
   for(let i=0;i<input.length;i++){
    const descriptor=Object.getOwnPropertyDescriptor(input,String(i)),value=descriptor&&'value' in descriptor?descriptor.value:undefined;
    if(!isSemanticDocumentTextSafe(value,8192))return fail();bytes+=Buffer.byteLength(value);if(bytes>64*1024)return fail();texts.push(value);
   }
   const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
   const operation=async()=>{
    const key=await resolve();if(controller.signal.aborted||typeof key!=='string'||key.length<1||key.length>4096||/[\u0000-\u0020\u007f]/.test(key))return fail();
    const response=await transport('https://api.openai.com/v1/embeddings',{method:'POST',redirect:'error',signal:controller.signal,
     headers:{'content-type':'application/json',authorization:'Bearer '+key},body:JSON.stringify({model,input:texts,dimensions,encoding_format:'float'})});
    if(controller.signal.aborted||!response.ok||!response.body){void response.body?.cancel().catch(()=>undefined);return fail();}
    const maximum=2*1024*1024,length=response.headers.get('content-length');
    if(length&&/^[0-9]+$/.test(length)&&Number(length)>maximum){await response.body.cancel().catch(()=>undefined);return fail();}
    const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
    const abort=()=>{void reader.cancel().catch(()=>undefined);};controller.signal.addEventListener('abort',abort,{once:true});
    try{while(true){if(controller.signal.aborted)return fail();const {done,value}=await reader.read();if(done)break;size+=value.byteLength;
     if(size>maximum){controller.abort();return fail();}chunks.push(value);}}
    finally{controller.signal.removeEventListener('abort',abort);reader.releaseLock();}
    if(controller.signal.aborted)return fail();
    const parsed=parseStrictJson(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)),{maxDepth:8,maxNodes:60_000}) as any;
    if(parsed.model!==model||!Array.isArray(parsed.data)||parsed.data.length!==texts.length)return fail();
    const result:readonly number[][]=[];const indices=new Set<number>();
    for(const item of parsed.data){if(!Number.isInteger(item.index)||item.index<0||item.index>=texts.length||indices.has(item.index)||!Array.isArray(item.embedding)
      ||item.embedding.length!==dimensions||item.embedding.some((value:unknown)=>typeof value!=='number'||!Number.isFinite(value)))return fail();
     indices.add(item.index);(result as number[][])[item.index]=Object.freeze([...item.embedding]) as unknown as number[];}
    return Object.freeze(result);
   };
   try{return await Promise.race([operation(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new OpenAiEmbeddingError());},timeout);timer.unref?.();})]);}
   catch{return fail();}finally{if(timer!==undefined)clearTimeout(timer);}
  },
 });
};
