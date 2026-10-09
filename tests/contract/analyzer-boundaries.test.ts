import {mkdtemp,mkdir,rm,symlink,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname,join} from "node:path";
import {afterEach,expect,test,vi} from "vitest";
import {ANALYZER as EXPRESS,createAnalyzer as createExpress} from "../../analyzers/typescript/src/index.js";
import {ANALYZER as ROUTING,createAnalyzer as createRouting} from "../../analyzers/routing-controllers/src/index.js";
import {ANALYZER as SWAGGER,createAnalyzer as createSwagger} from "../../analyzers/nodejs/src/index.js";
import {ANALYZER as SWAGGER_MIDDLEWARE,createAnalyzer as createSwaggerMiddleware} from "../../analyzers/nodejs/src/middleware.js";
import {ANALYZER as OPENAPI,createAnalyzer as createOpenApi} from "../../analyzers/openapi3/src/index.js";
import {parseAnalyzerResult,type AnalyzerRequest,type AnalyzerResult} from "../../packages/ir/src/index.js";

type Profile=Readonly<{name:string;analyzer:AnalyzerRequest["analyzer"];irVersion:"1.0.0"|"1.1.0";kind:"source"|"document"|"middleware";
  serviceRoot:string;selectedPath:string;create:(projectRoot:string)=>{analyze(input:unknown):Promise<AnalyzerResult>};
  files:(route:string)=>Record<string,string>;changedPath:string;expectedPath:string}>;
const swaggerDoc=(route:string)=>JSON.stringify({swagger:"2.0",info:{title:"Synthetic",version:"1"},paths:{
  [route]:{get:{summary:"Read a sample record",operationId:"readSample",responses:{"200":{description:"Found"}}}}}});
const openApiDoc=(route:string)=>JSON.stringify({openapi:"3.0.3",info:{title:"Synthetic",version:"1"},paths:{
  [route]:{get:{summary:"Read a sample record",operationId:"readSample",responses:{"200":{description:"Found"}}}}}});
const profiles:Profile[]=[
  {name:"Express source",analyzer:EXPRESS,irVersion:"1.0.0",kind:"source",serviceRoot:"service",selectedPath:"service",
    create:root=>createExpress({projectRoot:root}),files:route=>({"service/app.ts":`import express from "express"; const app=express();
      function readSample(req,res){return res.json({ok:true});} app.get("${route}",readSample);`}),changedPath:"service/app.ts",expectedPath:"/sample"},
  {name:"Routing controllers source",analyzer:ROUTING,irVersion:"1.0.0",kind:"source",serviceRoot:"service",selectedPath:"service",
    create:root=>createRouting({projectRoot:root}),files:route=>({"service/app.ts":`import {createExpressServer} from "routing-controllers";
      import {SampleController} from "./sample"; createExpressServer({controllers:[SampleController]});`,
      "service/sample.ts":`import {JsonController,Get} from "routing-controllers";
        @JsonController("/sample") export class SampleController {@Get("/") readSample(){return "ok";}}`}),
    changedPath:"service/sample.ts",expectedPath:"/sample"},
  {name:"Swagger 2 document",analyzer:SWAGGER,irVersion:"1.1.0",kind:"document",serviceRoot:"service",selectedPath:"service/api.json",
    create:root=>createSwagger({projectRoot:root}),files:route=>({"service/api.json":swaggerDoc(route)}),
    changedPath:"service/api.json",expectedPath:"/sample"},
  {name:"Swagger 2 middleware",analyzer:SWAGGER_MIDDLEWARE,irVersion:"1.1.0",kind:"middleware",serviceRoot:"service",
    selectedPath:"service/api/swagger/swagger.yaml",create:root=>createSwaggerMiddleware({projectRoot:root}),
    files:route=>({"service/api/swagger/swagger.yaml":`swagger: '2.0'\ninfo: { title: Synthetic, version: '1' }\npaths:\n  ${route}:\n    get:\n      summary: Read a sample record\n      operationId: readSample\n      responses:\n        '200': { description: Found }\n`,
      "service/app.js":`const express = require("express"); const SwaggerExpress = require("swagger-express-mw");
        const app = express(); SwaggerExpress.create({ appRoot: __dirname }, function (error, middleware) {
          if (error) throw error; middleware.register(app);
        });`}),
    changedPath:"service/api/swagger/swagger.yaml",expectedPath:"/sample"},
  {name:"OpenAPI 3 document",analyzer:OPENAPI,irVersion:"1.1.0",kind:"document",serviceRoot:"service",selectedPath:"service/openapi.json",
    create:root=>createOpenApi({projectRoot:root}),files:route=>({"service/openapi.json":openApiDoc(route)}),
    changedPath:"service/openapi.json",expectedPath:"/sample"},
];
const roots:string[]=[];
afterEach(async()=>Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true}))));
const revision="a".repeat(40);
const makeRequest=(profile:Profile):AnalyzerRequest=>({exchange_version:"1.0.0",ir_version:profile.irVersion,
  request_id:`boundary-${profile.name.toLowerCase().replaceAll(" ","-")}`,analyzer:{...profile.analyzer},
  source:{repository_id:"synthetic-public",service_id:"sample-api",service_root:profile.serviceRoot,
    immutable_revision:revision,source_digest:"pending",access_label:"sample-read"},
  resolution_inputs:profile.kind==="source"?[{kind:"source_tree",path:profile.serviceRoot,digest:"pending"}]:
    profile.kind==="document"?[{kind:"type_manifest",path:profile.selectedPath,digest:"pending"}]:
      [{kind:"source_tree",path:profile.serviceRoot,digest:"pending"},{kind:"type_manifest",path:profile.selectedPath,digest:"pending"}],
  prior_dependencies:[],changed_paths:[],extraction_mode:"baseline",
  limits:{timeout_ms:30_000,max_files:30,max_output_bytes:1_000_000},
  execution_policy:{network_access:false,side_effects:"none"}});
const setup=async(profile:Profile,route="/sample")=>{
  const root=await mkdtemp(join(tmpdir(),"analyzer-boundary-"));roots.push(root);
  for(const [path,contents] of Object.entries(profile.files(route))){const absolute=join(root,path);
    await mkdir(dirname(absolute),{recursive:true});await writeFile(absolute,contents);}
  return {root,adapter:profile.create(root),request:makeRequest(profile)};
};
const tamperManifest=(request:AnalyzerRequest,path:string)=>{
  if(request.resolution_inputs[0]?.kind==="type_manifest")request.resolution_inputs[0].path=path;
  else request.resolution_inputs.push({kind:"type_manifest",path,digest:"pending"});
};
const validOutput=async(profile:Profile)=>{
  const fixture=await setup(profile);const result=await fixture.adapter.analyze(fixture.request);
  expect(parseAnalyzerResult(result).ok).toBe(true);
  expect(result.analyzer).toEqual(profile.analyzer);
  expect(result.source).toMatchObject({repository_id:"synthetic-public",service_id:"sample-api",
    immutable_revision:revision,source_digest:expect.stringMatching(/^sha256:[0-9a-f]{64}$/)});
  for(const evidence of result.evidence){
    expect(evidence.source_version).toBe(revision);
    expect(evidence.scope.service_id).toBe("sample-api");
    expect(evidence.scope.revision).toBe(revision);
  }
  expect(result.endpoints.some(endpoint=>endpoint.application_path===profile.expectedPath),
    `${profile.name}: ${JSON.stringify({endpoints:result.endpoints.map(endpoint=>endpoint.application_path),status:result.status,
      diagnostics:result.diagnostics.map(item=>item.code),coverage:result.coverage})}`).toBe(true);
  if(profile.kind==="document")expect(result.evidence.some(item=>item.source.kind==="api_document")).toBe(true);
  return fixture;
};

test.each(profiles)("$name accepts only its pinned current profile and emits scoped provenance",async profile=>{
  const fixture=await validOutput(profile);
  expect(fixture.request.execution_policy).toEqual({network_access:false,side_effects:"none"});
});

test.each(profiles)("$name rejects path escapes, wrong selection kinds, and mismatched SHA-256 inputs",async profile=>{
  const fixture=await setup(profile);
  const escaped=structuredClone(fixture.request);escaped.source.service_root="../outside";
  await expect(fixture.adapter.analyze(escaped)).rejects.toThrow();
  const changedEscape=structuredClone(fixture.request);changedEscape.changed_paths=["../outside.ts"];
  await expect(fixture.adapter.analyze(changedEscape)).rejects.toThrow();
  const wrong=structuredClone(fixture.request);
  if(profile.kind==="source")wrong.resolution_inputs=[{kind:"type_manifest",path:"service/api.json",digest:"pending"}];
  else tamperManifest(wrong,profile.kind==="middleware"?"service/wrong/swagger.yaml":"service/missing.json");
  await expect(fixture.adapter.analyze(wrong)).rejects.toThrow();
  for(let index=0;index<fixture.request.resolution_inputs.length;index++){
    const badDigest=structuredClone(fixture.request);
    badDigest.resolution_inputs[index]!.digest=`sha256:${"0".repeat(64)}`;
    await expect(fixture.adapter.analyze(badDigest)).rejects.toThrow();
  }
  const badSourceDigest=structuredClone(fixture.request);badSourceDigest.source.source_digest=`sha256:${"0".repeat(64)}`;
  await expect(fixture.adapter.analyze(badSourceDigest)).rejects.toThrow();
  const network=structuredClone(fixture.request);(network.execution_policy as {network_access:boolean}).network_access=true;
  await expect(fixture.adapter.analyze(network)).rejects.toThrow();
  const wrongVersion=structuredClone(fixture.request);
  (wrongVersion.analyzer as {analyzer_version:string}).analyzer_version="0.0.0";
  await expect(fixture.adapter.analyze(wrongVersion)).rejects.toThrow();
});

test.each(profiles)("$name does not follow selected paths through symlinks",async profile=>{
  const fixture=await setup(profile);const outside=join(fixture.root,"outside.json");await writeFile(outside,swaggerDoc("/outside"));
  if(profile.kind==="document"){
    const selected=join(fixture.root,profile.selectedPath);await rm(selected);await symlink(outside,selected);
  }else{
    const link=join(fixture.root,profile.serviceRoot,"escape.json");await symlink(outside,link);
  }
  await expect(fixture.adapter.analyze(fixture.request)).rejects.toThrow();
});

test.each(profiles)("$name represents malformed selected content as failed or incomplete",async profile=>{
  const fixture=await setup(profile);
  const malformed=profile.kind==="source"?"export const broken = ;":"{ invalid: [document";
  const target=join(fixture.root,profile.kind==="source"?"service/app.ts":profile.selectedPath);
  await writeFile(target,malformed);
  let result:AnalyzerResult|undefined;
  try{result=await fixture.adapter.analyze(fixture.request);}catch{return;}
  expect(parseAnalyzerResult(result).ok).toBe(true);
  expect(result.status==="failed"||result.status==="partial"||result.coverage.status==="incomplete").toBe(true);
  expect(result.coverage.status).not.toBe("complete");
});

test.each(profiles)("$name never executes source text and observes input/output bounds",async profile=>{
  const marker="__API_TRUTH_ANALYZER_BOUNDARY_CANARY__";
  Reflect.deleteProperty(globalThis,marker);
  const fixture=await setup(profile);
  const probe=`globalThis.${marker} = "CANARY_EXECUTED"; fetch("https://example.invalid");`;
  if(profile.kind==="document"){
    const target=join(fixture.root,profile.selectedPath);const doc=JSON.parse(await (await import("node:fs/promises")).readFile(target,"utf8"));
    doc.externalDocs={url:"https://example.invalid"};await writeFile(target,JSON.stringify(doc));
  }else await writeFile(join(fixture.root,profile.serviceRoot,"probe.ts"),probe);
  const fetch=vi.spyOn(globalThis,"fetch").mockResolvedValue(new Response("ok"));
  try{
    await fixture.adapter.analyze(fixture.request);
    expect(Reflect.get(globalThis,marker)).toBeUndefined();expect(fetch).not.toHaveBeenCalled();
    const bounded=structuredClone(fixture.request);bounded.limits.max_output_bytes=1;
    await expect(fixture.adapter.analyze(bounded)).rejects.toThrow();
    if(profile.kind!=="document"){
      const fileLimited=structuredClone(fixture.request);fileLimited.limits.max_files=1;
      await expect(fixture.adapter.analyze(fileLimited)).rejects.toThrow();
    }
  }finally{fetch.mockRestore();Reflect.deleteProperty(globalThis,marker);}
});

test.each(profiles)("$name invalidates its reproducibility fingerprint when selected bytes change",async profile=>{
  const fixture=await setup(profile);const first=await fixture.adapter.analyze(fixture.request);
  const selectedFile=join(fixture.root,profile.changedPath);
  const previous=await (await import("node:fs/promises")).readFile(selectedFile,"utf8");
  await writeFile(selectedFile,previous.replace("/sample","/changed"));
  const changed=await fixture.adapter.analyze(fixture.request);
  expect(changed.reproducibility_fingerprint).not.toBe(first.reproducibility_fingerprint);
});
