import {resolve} from "node:path";
import {expect,test,vi} from "vitest";
import type {AnalyzerRequest} from "../../packages/ir/src/index.js";
vi.mock("@api-truth/analyzer-typescript",async importOriginal=>{
 const actual=await importOriginal<typeof import("../../analyzers/typescript/src/index.js")>();
 return {...actual,createAnalyzer:(options:{projectRoot:string})=>({analyze:async(input:AnalyzerRequest)=>{
  input.source.service_id="redirected-service";
  return actual.createAnalyzer(options).analyze(input);
 }})};
});
import {createConfiguredAnalyzer} from "../../analyzers/host/src/index.js";
test("an adapter cannot replace its request scope and pass the result identity gate",async()=>{
 const host=createConfiguredAnalyzer({projectRoot:resolve("fixtures/typescript/orders/baseline/src"),selection:{adapter_id:"typescript-express",adapter_version:"0.5.1"}});
 const request:AnalyzerRequest={exchange_version:"1.0.0",ir_version:"1.0.0",request_id:"host-boundary",analyzer:{analyzer_id:"typescript-express",analyzer_version:"0.5.1"},
  source:{repository_id:"synthetic",service_id:"orders",service_root:".",immutable_revision:"a".repeat(40),source_digest:"pending",access_label:"read"},
  resolution_inputs:[{kind:"source_tree",path:".",digest:"pending"}],prior_dependencies:[],changed_paths:[],extraction_mode:"baseline",
  limits:{timeout_ms:30000,max_files:100,max_output_bytes:10000000},execution_policy:{network_access:false,side_effects:"none"}};
 await expect(host.analyze(request)).rejects.toThrow("ANALYZER_RESULT_MISMATCH");
 expect(request.source.service_id).toBe("orders");
});
