import {mkdtemp,rm,symlink,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach,expect,test} from "vitest";
import {ANALYZER,createAnalyzer} from "../../analyzers/java-spring/src/index.js";
import type {AnalyzerRequest} from "../../packages/ir/src/index.js";

const roots:string[]=[];
const scratch=async()=>{const root=await mkdtemp(join(tmpdir(),"api-truth-java-boundary-"));roots.push(root);return root;};
afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
const request=():AnalyzerRequest=>({exchange_version:"1.0.0",ir_version:"1.0.0",request_id:"boundary",
  analyzer:ANALYZER,source:{repository_id:"repo",service_id:"svc",service_root:".",
    immutable_revision:"a".repeat(40),source_digest:"pending",access_label:"source"},
  resolution_inputs:[{kind:"source_tree",path:".",digest:"pending"}],prior_dependencies:[],changed_paths:[],
  extraction_mode:"baseline",limits:{timeout_ms:1000,max_files:5,max_output_bytes:1_000_000},
  execution_policy:{network_access:false,side_effects:"none"}});

test("wrong profile and classpath fail before a Java toolchain is needed",async()=>{
  const root=await scratch();
  const analyzer=createAnalyzer({projectRoot:root,toolchainRoot:"/missing-toolchain"});
  const wrong=request();wrong.analyzer={analyzer_id:ANALYZER.analyzer_id,analyzer_version:"9.0.0"};
  await expect(analyzer.analyze(wrong)).rejects.toThrow("JAVA_ANALYZER_PROFILE_UNSUPPORTED");
  const classpath=request();classpath.resolution_inputs=[{kind:"classpath",
    locator:{scheme:"maven",coordinate:"org.example:project:1"},digest:"pending"}];
  await expect(analyzer.analyze(classpath)).rejects.toThrow("JAVA_ANALYZER_PROFILE_UNSUPPORTED");
});

test("source symlinks and claimed digest mismatches fail before a Java process",async()=>{
  const root=await scratch(),outside=await scratch();
  await writeFile(join(outside,"Other.java"),"class Other {}");
  await symlink(join(outside,"Other.java"),join(root,"Linked.java"));
  const analyzer=createAnalyzer({projectRoot:root,toolchainRoot:"/missing-toolchain"});
  await expect(analyzer.analyze(request())).rejects.toThrow("JAVA_SOURCE_BOUNDARY_OR_LIMIT");
  await rm(join(root,"Linked.java"));
  await writeFile(join(root,"Safe.java"),"class Safe {}");
  const altered=request();altered.source.source_digest=`sha256:${"0".repeat(64)}`;
  await expect(analyzer.analyze(altered)).rejects.toThrow("JAVA_ANALYZER_SOURCE_DIGEST_MISMATCH");
});
