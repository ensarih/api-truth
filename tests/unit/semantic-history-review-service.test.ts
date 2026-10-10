import {expect,test,vi} from "vitest";
import type {Pool} from "pg";
import {createSemanticService} from "../../packages/semantics/src/index.js";

const context={tenantId:"tenant",principalId:"reader"};
const selection={version:"1",tenantId:"tenant",repositoryId:"repo",serviceId:"service",
 selector:{kind:"revision",revision:"revision"}};
const request={historyId:"1",decision:"acknowledged",expectedVersion:"0"};
const fixture=()=>{
 const connect=vi.fn();const provider=vi.fn();const policy=vi.fn(async()=>true);
 const pool={connect} as unknown as Pool;
 const options={schema:"semantic_test",archiveHistory:true,providerPort:provider,historyReviewPolicy:policy};
 return {connect,provider,policy,pool,options,service:createSemanticService(pool,options)};
};

test("review host configuration requires explicit archive and an inert policy function",()=>{
 const {pool,options,connect}=fixture();const getter=vi.fn(()=>{throw new Error("secret");});
 const proxy=new Proxy(async()=>true,{getPrototypeOf:getter,get:getter});
 for(const value of [undefined,null,true,proxy]){
  expect(()=>createSemanticService(pool,{...options,historyReviewPolicy:value} as never)).toThrow("SEMANTIC_INVALID_REQUEST");
 }
 expect(()=>createSemanticService(pool,{...options,archiveHistory:false})).toThrow("SEMANTIC_INVALID_REQUEST");
 const accessor={...options};Object.defineProperty(accessor,"historyReviewPolicy",{get:getter});
 expect(()=>createSemanticService(pool,accessor)).toThrow("SEMANTIC_INVALID_REQUEST");
 expect(getter).not.toHaveBeenCalled();expect(connect).not.toHaveBeenCalled();
});

test("review methods are disabled without separate host policy",async()=>{
 const {pool,options,connect}=fixture();const {historyReviewPolicy:_,...disabled}=options;
 const service=createSemanticService(pool,disabled);
 await expect(service.recordHistoryReview(context,selection,["endpoint"],request)).rejects.toMatchObject({code:"SEMANTIC_INVALID_REQUEST"});
 await expect(service.readHistoryReviews(context,selection,["endpoint"],"1",20)).rejects.toMatchObject({code:"SEMANTIC_INVALID_REQUEST"});
 expect(connect).not.toHaveBeenCalled();
});

test("review requests reject spoofed identities, invalid versions and executable objects before storage",async()=>{
 const {service,connect,provider,policy}=fixture();const getter=vi.fn(()=>{throw new Error("secret");});
 const accessor={...request};Object.defineProperty(accessor,"decision",{get:getter,enumerable:true});
 const revoked=Proxy.revocable({},{});revoked.revoke();
 const invalids=[{...request,tenantId:"other"},{...request,reviewer:"other"},{...request,expectedVersion:"9223372036854775807"},
  {...request,historyId:"0"},{...request,decision:"approved"},accessor,revoked.proxy];
 for(const value of invalids)await expect(service.recordHistoryReview(context,selection,["endpoint"],value)).rejects.toMatchObject({code:"SEMANTIC_INVALID_REQUEST"});
 for(const [id,limit] of [["01",20],["1",0],["1",21],["1",1.5],[revoked.proxy,20]])
  await expect(service.readHistoryReviews(context,selection,["endpoint"],id,limit)).rejects.toMatchObject({code:"SEMANTIC_INVALID_REQUEST"});
 expect(getter).not.toHaveBeenCalled();expect(connect).not.toHaveBeenCalled();expect(provider).not.toHaveBeenCalled();expect(policy).not.toHaveBeenCalled();
});
