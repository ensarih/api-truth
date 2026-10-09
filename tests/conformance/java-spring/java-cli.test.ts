import {spawn} from "node:child_process";
import {resolve} from "node:path";
import {expect,test} from "vitest";
import {parseAnalyzerResult,type AnalyzerRequest} from "../../../packages/ir/src/index.js";

const run=(input:string,args:string[]=[])=>new Promise<{code:number|null;stdout:string;stderr:string}>((done,reject)=>{
  const child=spawn(process.execPath,["scripts/extract-java.mjs",...args],{timeout:60_000});
  let stdout="",stderr="";
  child.stdout.on("data",chunk=>{stdout+=String(chunk);});
  child.stderr.on("data",chunk=>{stderr+=String(chunk);});
  child.on("error",reject);
  child.stdin.on("error",()=>{});
  child.on("close",code=>done({code,stdout,stderr}));
  child.stdin.end(input);
});

test("Java CLI uses the shared request/result exchange with exact fixture revision",async()=>{
  const request:AnalyzerRequest={exchange_version:"1.0.0",ir_version:"1.0.0",request_id:"java-cli",
    analyzer:{analyzer_id:"java-spring-mvc",analyzer_version:"0.1.0"},
    source:{repository_id:"synthetic",service_id:"orders",service_root:".",immutable_revision:"a".repeat(40),
      source_digest:"pending",access_label:"source"},
    resolution_inputs:[{kind:"source_tree",path:".",digest:"pending"}],prior_dependencies:[],changed_paths:[],
    extraction_mode:"baseline",limits:{timeout_ms:30_000,max_files:100,max_output_bytes:1_000_000},
    execution_policy:{network_access:false,side_effects:"none"}};
  const result=await run(JSON.stringify(request),[resolve("fixtures/java/orders/src")]);
  expect(result.code).toBe(0);
  const value=JSON.parse(result.stdout);
  expect(parseAnalyzerResult(value).ok).toBe(true);
  expect(value.request_id).toBe("java-cli");
  expect(value.source.immutable_revision).toBe(request.source.immutable_revision);
  expect(value.endpoints).toHaveLength(3);
  expect(value.coverage.status).toBe("incomplete");
});

test("Java CLI malformed private input fails with a fixed error and no result",async()=>{
  const result=await run('{"PRIVATE_CANARY_SECRET": invalid}');
  expect(result.code).toBe(1);expect(result.stdout).toBe("");
  expect(result.stderr).toBe("JAVA_ANALYZER_FAILED\n");
});
