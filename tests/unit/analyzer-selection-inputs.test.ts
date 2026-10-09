import {expect,test} from "vitest";
import {parseAnalyzerSelection} from "../../packages/ir/src/index.js";
const base={adapter_id:"nodejs-swagger-express-mw",adapter_version:"0.33.0",ir_version:"1.1.0"};
test("accepts explicit bounded source manifest selection",()=>{
 expect(parseAnalyzerSelection({...base,resolution_inputs:[{kind:"type_manifest",path:"api/swagger/swagger.yaml"}]})).toMatchObject({ok:true});
});
test.each(["../swagger.yaml","api/../swagger.yaml","/swagger.yaml","api//swagger.yaml","api\\swagger.yaml",".","api/./swagger.yaml"])("rejects unnormalized configured manifest %s",path=>{
 expect(parseAnalyzerSelection({...base,resolution_inputs:[{kind:"type_manifest",path}]})).toMatchObject({ok:false});
});
test("rejects duplicate, runtime, unknown and unbounded input configuration",()=>{
 const input={kind:"type_manifest",path:"api/swagger.yaml"};
 for(const resolution_inputs of [[input,input],[{...input,kind:"runtime_observation"}],[{...input,digest:"private"}],Array.from({length:17},(_,i)=>({...input,path:`api/${i}.yaml`}))])
  expect(parseAnalyzerSelection({...base,resolution_inputs})).toMatchObject({ok:false});
});

test("production entrypoint selection is explicit and normalized",()=>{
 expect(parseAnalyzerSelection({adapter_id:"nodejs-routing-controllers",adapter_version:"0.9.0",production_entrypoint:"src/app.ts"})).toMatchObject({ok:true});
 for(const production_entrypoint of ["../app.ts","/app.ts","src/./app.ts","src\\app.ts",""])
  expect(parseAnalyzerSelection({...base,production_entrypoint})).toMatchObject({ok:false});
});
