import {copyFile,mkdtemp,readFile,realpath,rm,symlink,writeFile,mkdir} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {afterEach,expect,test} from "vitest";
import {ANALYZER,createAnalyzer} from "../../../analyzers/java-spring/src/index.js";
import {parseAnalyzerResult,type AnalyzerRequest} from "../../../packages/ir/src/index.js";
import {verifyPinnedParserArtifacts} from "../../../scripts/java-parser-toolchain.mjs";

const fixtures=new URL("../../../fixtures/java/orders/src/OrdersController.java",import.meta.url);
const repositoryRoot=fileURLToPath(new URL("../../../",import.meta.url));
const roots:string[]=[];
const scratch=async()=>{const root=await mkdtemp(join(tmpdir(),"api-truth-java-test-"));roots.push(root);return root;};
afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
const request=(root="."):AnalyzerRequest=>({exchange_version:"1.0.0",ir_version:"1.0.0",
  request_id:"java-first",analyzer:ANALYZER,
  source:{repository_id:"synthetic-repo",service_id:"orders",service_root:root,
    immutable_revision:"a".repeat(40),source_digest:"pending",access_label:"java-source"},
  resolution_inputs:[{kind:"source_tree",path:root,digest:"pending"}],prior_dependencies:[],changed_paths:[],
  extraction_mode:"baseline",limits:{timeout_ms:30_000,max_files:20,max_output_bytes:1_000_000},
  execution_policy:{network_access:false,side_effects:"none"}});

test("pinned JavaParser projects same-path Spring selectors with precise source evidence and unknown runtime facts",async()=>{
  const root=await scratch();await mkdir(join(root,"src"));
  await writeFile(join(root,"src","OrdersController.java"),await readFile(fixtures));
  const analyzer=createAnalyzer({projectRoot:root});
  const first=await analyzer.analyze(request());
  const second=await analyzer.analyze(request());
  expect(first.status).toBe("partial");expect(first.coverage.status).toBe("incomplete");
  expect(first.endpoints).toHaveLength(3);
  const get=first.endpoints.filter(item=>item.identity.method==="GET");
  expect(get).toHaveLength(2);
  expect(get.map(item=>item.application_path)).toEqual(["/api/orders/{orderId}","/api/orders/{orderId}"]);
  expect(new Set(get.map(item=>item.identity.route_key)).size).toBe(2);
  expect(get.map(item=>{
    const header=item.identity.selectors.headers?.[0];
    return header&&"value" in header?header.value:undefined;
  }).sort()).toEqual(["internal","partner"]);
  expect(first.endpoints.find(item=>item.identity.method==="POST")?.identity.selectors.consumes)
    .toEqual(["application/json"]);
  expect(first.endpoints.every(item=>item.responses[0]?.status.kind==="unknown"
    &&item.request_bodies.length===0&&item.security.state==="unknown")).toBe(true);
  expect(first.claims.filter(item=>item.predicate==="route.declaration"))
    .toHaveLength(3);
  expect(first.claims.every(item=>item.verification==="declared")).toBe(true);
  expect(first.evidence.filter(item=>item.method==="type_declaration").every(item=>
    item.source.kind==="source_code"&&item.source_version==="a".repeat(40)
      &&item.location.pointer?.startsWith("span:")&&item.scope.endpoint_id)).toBe(true);
  expect(first.diagnostics.map(item=>item.code)).toEqual(expect.arrayContaining([
    "startup_binding_unverified","classpath_unresolved","dto_validation_unsupported",
    "response_status_unknown","security_unknown"]));
  expect(first.reproducibility_fingerprint).toBe(second.reproducibility_fingerprint);
  expect(first.endpoints).toEqual(second.endpoints);
  expect(parseAnalyzerResult(first).ok).toBe(true);
});

test("dynamic mappings and unresolved framework imports withhold route facts",async()=>{
  const root=await scratch();
  await writeFile(join(root,"Dynamic.java"),`
    import org.springframework.web.bind.annotation.RestController;
    import org.springframework.web.bind.annotation.GetMapping;
    @RestController class Dynamic {
      static final String ROUTE = "/dynamic";
      @GetMapping(ROUTE) public String dynamic(){return "x";}
    }
  `);
  const result=await createAnalyzer({projectRoot:root}).analyze(request());
  expect(result.endpoints).toHaveLength(0);
  expect(result.diagnostics.map(item=>item.code)).toContain("route_path_dynamic");
  const missing=await scratch();
  await writeFile(join(missing,"Missing.java"),`@RestController class Missing {
    @GetMapping("/false") public String falseRoute(){return "x";}
  }`);
  const unresolved=await createAnalyzer({projectRoot:missing}).analyze(request());
  expect(unresolved.endpoints).toHaveLength(0);
  expect(unresolved.diagnostics.map(item=>item.code)).toContain("controller_import_unresolved");
});

test("source symlinks and mismatched digests fail before helper execution",async()=>{
  const root=await scratch(),outside=await scratch();
  await writeFile(join(outside,"Other.java"),"class Other {}");
  await symlink(join(outside,"Other.java"),join(root,"Linked.java"));
  await expect(createAnalyzer({projectRoot:root}).analyze(request()))
    .rejects.toThrow("JAVA_SOURCE_BOUNDARY_OR_LIMIT");
  await rm(join(root,"Linked.java"));
  await writeFile(join(root,"Safe.java"),"class Safe {}");
  const altered=request();altered.source.source_digest=`sha256:${"0".repeat(64)}`;
  await expect(createAnalyzer({projectRoot:root}).analyze(altered))
    .rejects.toThrow("JAVA_ANALYZER_SOURCE_DIGEST_MISMATCH");
  const classpath=request();classpath.resolution_inputs=[{kind:"classpath",
    locator:{scheme:"maven",coordinate:"org.example:unsafe:1"},digest:"pending"}];
  await expect(createAnalyzer({projectRoot:root}).analyze(classpath))
    .rejects.toThrow("JAVA_ANALYZER_PROFILE_UNSUPPORTED");
});

test("same-name local annotations and non-equality header conditions never become declared routes",async()=>{
  const shadow=await scratch();
  await writeFile(join(shadow,"Shadow.java"),`import org.springframework.web.bind.annotation.RestController;
    import org.springframework.web.bind.annotation.GetMapping;
    @interface GetMapping { String value(); }
    @RestController class Orders { @GetMapping("/orders") public String read(){return "x";} }
  `);
  const hidden=await createAnalyzer({projectRoot:shadow}).analyze(request());
  expect(hidden.endpoints).toHaveLength(0);
  expect(hidden.diagnostics.map(item=>item.code)).toContain("annotation_shadowing_unsupported");
  const conditional=await scratch();
  await writeFile(join(conditional,"Conditional.java"),`import org.springframework.web.bind.annotation.RestController;
    import org.springframework.web.bind.annotation.GetMapping;
    @RestController class Orders { @GetMapping(value="/orders", headers="X-Channel!=partner")
      public String read(){return "x";} }
  `);
  const unresolved=await createAnalyzer({projectRoot:conditional}).analyze(request());
  expect(unresolved.endpoints).toHaveLength(0);
  expect(unresolved.diagnostics.map(item=>item.code)).toContain("route_shape_unsupported");
});

test("Spring property placeholders, SpEL, repeated slashes and mixed mapping annotations stay unresolved",async()=>{
  const root=await scratch();
  await writeFile(join(root,"Shapes.java"),`import org.springframework.web.bind.annotation.RestController;
    import org.springframework.web.bind.annotation.GetMapping;
    import org.springframework.web.bind.annotation.RequestMapping;
    @RestController class Shapes {
      @GetMapping("/orders/" + "unused") public String computed(){return "x";}
      @GetMapping("/orders/#{tenant}") public String expression(){return "x";}
      @GetMapping("/orders/\${tenant}") public String placeholder(){return "x";}
      @GetMapping("/orders//items") public String doubled(){return "x";}
      @GetMapping("/orders/") public String trailing(){return "x";}
      @GetMapping("/orders") @RequestMapping("/alternate") public String mixed(){return "x";}
    }`);
  const result=await createAnalyzer({projectRoot:root}).analyze(request());
  expect(result.endpoints).toHaveLength(0);
  expect(result.diagnostics.map(item=>item.code)).toEqual(expect.arrayContaining([
    "route_path_dynamic","route_shape_unsupported","method_mapping_combination_unsupported"]));
});

test("duplicate identical Spring routes withhold every colliding endpoint",async()=>{
  const root=await scratch();
  await writeFile(join(root,"Duplicates.java"),`import org.springframework.web.bind.annotation.RestController;
    import org.springframework.web.bind.annotation.GetMapping;
    @RestController class Duplicates {
      @GetMapping("/same") public String first(){return "x";}
      @GetMapping("/same") public String second(){return "y";}
    }`);
  const result=await createAnalyzer({projectRoot:root}).analyze(request());
  expect(result.endpoints).toHaveLength(0);
  expect(result.claims).toHaveLength(0);
  expect(result.diagnostics.filter(item=>item.code==="route_collision_unresolved")).toHaveLength(2);
});

test("toolchain check rejects tampered class and jar even when mutable cache metadata claims otherwise",async()=>{
  const root=await scratch();
  const cache=join(root,".cache","java-spring","parser-3.28.2");
  const actual=join(repositoryRoot,".cache","java-spring","parser-3.28.2");
  const classPath=join(cache,"classes","apitruth","AstExtract.class");
  const jarPath=join(cache,"javaparser-core-3.28.2.jar");
  await mkdir(join(cache,"classes","apitruth"),{recursive:true});
  await copyFile(join(actual,"classes","apitruth","AstExtract.class"),classPath);
  await copyFile(join(actual,"javaparser-core-3.28.2.jar"),jarPath);
  const classBytes=await readFile(classPath),jarBytes=await readFile(jarPath);
  const canonicalCache=join(await realpath(root),".cache","java-spring","parser-3.28.2");
  await expect(verifyPinnedParserArtifacts(root)).resolves.toMatchObject({
    jar:join(canonicalCache,"javaparser-core-3.28.2.jar"),classes:join(canonicalCache,"classes")});
  try{
    await writeFile(classPath,Buffer.from("CANARY_MUTATED_CLASS"));
    await writeFile(join(cache,"manifest.json"),JSON.stringify({classes:"trusted"}));
    await expect(verifyPinnedParserArtifacts(root)).rejects.toThrow("java_toolchain_unavailable");
    await writeFile(classPath,classBytes);
    await writeFile(jarPath,Buffer.from("CANARY_MUTATED_JAR"));
    await expect(verifyPinnedParserArtifacts(root)).rejects.toThrow("java_toolchain_unavailable");
  }finally{
    await writeFile(classPath,classBytes);await writeFile(jarPath,jarBytes);
  }
  await expect(verifyPinnedParserArtifacts(root)).resolves.toMatchObject({
    jar:join(canonicalCache,"javaparser-core-3.28.2.jar")});
});

test("inherited JVM option and classpath variables do not alter the fixed helper process",async()=>{
  const root=await scratch();await writeFile(join(root,"Simple.java"),`import org.springframework.web.bind.annotation.RestController;
    import org.springframework.web.bind.annotation.GetMapping;
    @RestController class Simple { @GetMapping("/simple") public String read(){return "x";} }`);
  const names=["JAVA_TOOL_OPTIONS","JDK_JAVA_OPTIONS","_JAVA_OPTIONS","CLASSPATH"] as const;
  const prior=Object.fromEntries(names.map(name=>[name,process.env[name]]));
  try{
    for(const name of names)process.env[name]="-javaagent:/definitely-missing-agent.jar";
    await expect(createAnalyzer({projectRoot:root}).analyze(request()))
      .resolves.toMatchObject({status:"partial",endpoints:[{application_path:"/simple"}]});
  }finally{for(const name of names){const value=prior[name];
    if(value===undefined)delete process.env[name];else process.env[name]=value;}}
});

test("service static initializer and executable build wrapper remain inert during AST extraction",async()=>{
  const root=await scratch(),marker=join(root,"execution-marker"),wrapperMarker=join(root,"wrapper-marker");
  await writeFile(join(root,"gradlew"),`#!/bin/sh\nprintf executed > ${wrapperMarker}\n`,{mode:0o755});
  await writeFile(join(root,"Inert.java"),`import org.springframework.web.bind.annotation.RestController;
    import org.springframework.web.bind.annotation.GetMapping;
    @RestController class Inert {
      static { try { java.nio.file.Files.writeString(java.nio.file.Path.of(${JSON.stringify(marker)}), "executed"); }
        catch (Exception ignored) {} }
      @GetMapping("/safe") public String read(){return "x";}
    }`);
  await expect(createAnalyzer({projectRoot:root}).analyze(request()))
    .resolves.toMatchObject({status:"partial",endpoints:[{application_path:"/safe"}]});
  await expect(readFile(marker)).rejects.toMatchObject({code:"ENOENT"});
  await expect(readFile(wrapperMarker)).rejects.toMatchObject({code:"ENOENT"});
});
