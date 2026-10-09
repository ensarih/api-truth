import {resolve} from "node:path";
import {expect,test} from "vitest";
import {createConfiguredAnalyzer,configuredAnalyzerProfiles} from "../../analyzers/host/src/index.js";
import {ANALYZER as expressIdentity} from "../../analyzers/typescript/src/index.js";
import type {AnalyzerRequest} from "../../packages/ir/src/index.js";
const profiles=[
 {id:"typescript-express",version:"0.4.0",ir:"1.0.0",root:"fixtures/typescript/orders/baseline/src",inputs:[{kind:"source_tree",path:".",digest:"pending"}]},
 {id:"nodejs-routing-controllers",version:"0.7.0",ir:"1.0.0",root:"fixtures/nodejs/routing-controllers/orders/src",inputs:[{kind:"source_tree",path:".",digest:"pending"}]},
 {id:"nodejs-swagger2-document",version:"0.13.0",ir:"1.1.0",root:"fixtures/nodejs/swagger2/orders",inputs:[{kind:"type_manifest",path:"api/swagger/swagger.yaml",digest:"pending"}]},
 {id:"nodejs-swagger-express-mw",version:"0.32.0",ir:"1.1.0",root:"fixtures/nodejs/swagger2/middleware/src",inputs:[{kind:"source_tree",path:".",digest:"pending"},{kind:"type_manifest",path:"api/swagger/swagger.yaml",digest:"pending"}]},
] as const;
const request=(profile:typeof profiles[number]):AnalyzerRequest=>({exchange_version:"1.0.0",ir_version:profile.ir,request_id:"host-test",
 analyzer:{analyzer_id:profile.id,analyzer_version:profile.version},
 source:{repository_id:"synthetic",service_id:"orders",service_root:".",immutable_revision:"a".repeat(40),source_digest:"pending",access_label:"read"},
 resolution_inputs:[...profile.inputs],prior_dependencies:[],changed_paths:[],extraction_mode:"baseline",
 limits:{timeout_ms:30000,max_files:100,max_output_bytes:10000000},execution_policy:{network_access:false,side_effects:"none"}});
test.each(profiles)("dispatches exact configured adapter $id",async profile=>{
 const analyzer=createConfiguredAnalyzer({projectRoot:resolve(profile.root),selection:{adapter_id:profile.id,adapter_version:profile.version,ir_version:profile.ir}});
 const result=await analyzer.analyze(request(profile));
 expect(result.analyzer).toEqual(request(profile).analyzer);
 expect(result.ir_version).toBe(profile.ir);
 expect(result.endpoints.length).toBeGreaterThan(0);
});
test.each([
 {adapter_id:"unknown",adapter_version:"private-marker"},
 {adapter_id:"typescript-express",adapter_version:"latest"},
 {adapter_id:"nodejs-swagger-express-mw",adapter_version:"0.32.0"},
 {adapter_id:"typescript-express",adapter_version:"0.4.0",ir_version:"1.1.0"},
 {adapter_id:"typescript-express",adapter_version:"0.4.0",secret:"private-marker"},
 null,new Proxy({},{ownKeys(){throw new Error("private-marker");}})
])("unsupported selections fail safely before reading source",selection=>{
 expect(()=>createConfiguredAnalyzer({projectRoot:"/does-not-exist",selection})).toThrow("UNSUPPORTED_ANALYZER_SELECTION");
});
test("configured identity is detached and rejects request substitution before source access",async()=>{
 const selection={adapter_id:"typescript-express",adapter_version:"0.4.0"};
 const analyzer=createConfiguredAnalyzer({projectRoot:"/does-not-exist",selection});
 selection.adapter_id="unknown";
 await expect(analyzer.analyze({...request(profiles[0]),ir_version:"1.1.0"})).rejects.toThrow("ANALYZER_REQUEST_MISMATCH");
 await expect(analyzer.analyze(request(profiles[3]))).rejects.toThrow("ANALYZER_REQUEST_MISMATCH");
});
test("profile inventory is immutable and describes exact bounded versions",()=>{
 expect(configuredAnalyzerProfiles).toHaveLength(4);
 expect(Object.isFrozen(configuredAnalyzerProfiles)).toBe(true);
 for(const profile of configuredAnalyzerProfiles)expect(Object.isFrozen(profile)).toBe(true);
});


test("caller mutations cannot change in-flight request scope",async()=>{
 const profile=profiles[0],input=request(profile);
 const analyzer=createConfiguredAnalyzer({projectRoot:resolve(profile.root),selection:{adapter_id:profile.id,adapter_version:profile.version}});
 const pending=analyzer.analyze(input);
 input.source.service_id="changed";
 input.analyzer.analyzer_id="unknown";
 const result=await pending;
 expect(result.source.service_id).toBe("orders");
 expect(result.analyzer.analyzer_id).toBe(profile.id);
});
test("hostile request errors do not expose source values",async()=>{
 const analyzer=createConfiguredAnalyzer({projectRoot:"/does-not-exist",selection:{adapter_id:profiles[0].id,adapter_version:profiles[0].version}});
 await expect(analyzer.analyze(new Proxy({},{ownKeys(){throw new Error("private-marker");}}))).rejects.toThrow("ANALYZER_REQUEST_MISMATCH");
});


test("mutating an adapter export cannot change the compiled host registry",()=>{
 const original=expressIdentity.analyzer_version;
 try{
  expressIdentity.analyzer_version="private-marker";
  expect(()=>createConfiguredAnalyzer({projectRoot:"/does-not-exist",selection:{adapter_id:expressIdentity.analyzer_id,adapter_version:expressIdentity.analyzer_version}})).toThrow("UNSUPPORTED_ANALYZER_SELECTION");
  expect(configuredAnalyzerProfiles[0]?.adapter_version).toBe(original);
 }finally{expressIdentity.analyzer_version=original;}
});
