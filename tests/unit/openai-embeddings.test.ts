import {expect,test,vi} from 'vitest';
import {createOpenAiEmbeddingPort} from '../../connectors/semantic-providers/src/openai-embeddings.js';
const response=(data:unknown,model='text-embedding-3-small')=>new Response(JSON.stringify({model,data}),{headers:{'content-type':'application/json'}});
test('native OpenAI embedding request uses a private key resolver, fixed endpoint and ordered vectors',async()=>{
 const fetch=vi.fn<typeof globalThis.fetch>(async()=>response([{index:1,embedding:[0,1]},{index:0,embedding:[1,0]}])),resolveApiKey=vi.fn(()=> 'fixture-key');
 const port=createOpenAiEmbeddingPort({resolveApiKey,dimensions:2,fetch:fetch as never});
 expect(await port.embed(['void a sale','abort a purchase'])).toEqual([[1,0],[0,1]]);
 expect(fetch).toHaveBeenCalledWith('https://api.openai.com/v1/embeddings',expect.objectContaining({redirect:'error',headers:{'content-type':'application/json',authorization:'Bearer fixture-key'}}));
 expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string)).toEqual({model:'text-embedding-3-small',input:['void a sale','abort a purchase'],dimensions:2,encoding_format:'float'});
 expect(port).toMatchObject({spaceId:'openai:text-embedding-3-small:2',dimensions:2});
});
test('unsafe input does not resolve a key or make a network request',async()=>{
 const resolveApiKey=vi.fn(()=> 'fixture-key'),fetch=vi.fn();const port=createOpenAiEmbeddingPort({resolveApiKey,fetch:fetch as never});
 await expect(port.embed(['password=secret'])).rejects.toMatchObject({code:'OPENAI_EMBEDDING_UNAVAILABLE'});expect(resolveApiKey).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled();
});
test.each([{data:[{index:0,embedding:[1]}]},{data:[{index:0,embedding:[1,0]},{index:0,embedding:[1,0]}]},{data:[{index:2,embedding:[1,0]}]},{data:[{index:0,embedding:[1,0]}],model:'other-space'}])('wrong dimension, index, count or model is rejected',async({data,model})=>{
 const port=createOpenAiEmbeddingPort({resolveApiKey:()=> 'fixture-key',dimensions:2,fetch:(async()=>response(data,model)) as never});
 await expect(port.embed(['context'])).rejects.toMatchObject({message:'OPENAI_EMBEDDING_UNAVAILABLE'});
});
test('key and HTTP failures stay fixed without leaking credentials or response text',async()=>{
 for(const fetch of [async()=>new Response('PRIVATE_ERROR',{status:401}),async()=>{throw Error('PRIVATE_ERROR');}]){
  const port=createOpenAiEmbeddingPort({resolveApiKey:()=> 'fixture-key',fetch:fetch as never});
  await expect(port.embed(['context'])).rejects.toMatchObject({message:'OPENAI_EMBEDDING_UNAVAILABLE'});
 }
});
test('stalled key resolver expires without later sending a request',async()=>{
 let release!:(key:string)=>void;const fetch=vi.fn();const port=createOpenAiEmbeddingPort({resolveApiKey:()=>new Promise(resolve=>{release=resolve;}),fetch:fetch as never,timeoutMs:5});
 await expect(port.embed(['context'])).rejects.toMatchObject({code:'OPENAI_EMBEDDING_UNAVAILABLE'});release('fixture-key');await Promise.resolve();expect(fetch).not.toHaveBeenCalled();
});
