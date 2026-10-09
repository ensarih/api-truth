import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {resolve} from "node:path";
import {expect,test} from "vitest";
import {parseAnalyzerResult} from "../../packages/ir/src/index.js";
const run=promisify(execFile);
test("OpenAPI3 CLI preserves routes and media without applying server URLs",async()=>{
 const {stdout}=await run(process.execPath,["scripts/extract-openapi3.mjs","--source",resolve("fixtures/openapi3/orders"),"--document","openapi.yaml","--service","orders","--revision","a".repeat(40)]);
 const result=JSON.parse(stdout);
 expect(parseAnalyzerResult(result).ok).toBe(true);
 expect(result.analyzer).toEqual({analyzer_id:"openapi3-document",analyzer_version:"0.2.0"});
 expect(result.endpoints[0].application_path).toBe("/orders/{id}");
 expect(result.endpoints[0].responses[0].content.map((item:{media_type:string})=>item.media_type)).toEqual(["application/json","application/xml"]);
 expect(result.claims.some((item:{predicate:string})=>item.predicate==="exposure.servers.declaration")).toBe(true);
});
test("invalid CLI arguments fail without returning private values",async()=>{
 try{await run(process.execPath,["scripts/extract-openapi3.mjs","--secret","private-marker"]);expect.fail("must reject");}
 catch(error){const failure=error as {stderr:string;stdout:string;code:number};expect(failure.code).toBe(1);expect(failure.stdout).toBe("");expect(failure.stderr).not.toContain("private-marker");expect(failure.stderr).toContain("OpenAPI 3 extraction failed");}
});
