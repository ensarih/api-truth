import {execFile as execFileCallback} from "node:child_process";
import {mkdtemp,rm,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname,join,resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {promisify} from "node:util";
import {canonicalJsonStringify,deriveEndpointIdentity,parseAnalyzerRequest,parseAnalyzerResult,
  type AnalyzerRequest,type AnalyzerResult,type Endpoint,type Evidence} from "../../../packages/ir/src/index.js";
import {checkJavaParserToolchain,JAVAPARSER_SHA256,JAVAPARSER_VERSION}
  from "../../../scripts/java-parser-toolchain.mjs";
import {digestSources,hash,inside,readJavaSources} from "./source.js";

const execFile=promisify(execFileCallback);
export const ANALYZER={analyzer_id:"java-spring-mvc",analyzer_version:"0.1.0"};
const defaultToolchainRoot=resolve(dirname(fileURLToPath(import.meta.url)),"../../..");
const code=(value:unknown):value is string=>typeof value==="string"&&/^[a-z][a-z0-9_]{1,80}$/.test(value);
const bounded=(value:string,max=2048)=>value.length<=max&&!/[\u0000-\u001f\u007f]/.test(value);
type AstRecord=Readonly<{kind:"route";path:string;line:number;column:number;endLine:number;endColumn:number;
  classLine:number;methodLine:number;method:string;prefix:string;suffix:string;headers:string[];
  consumes:string[];produces:string[];handler:string}>
  |Readonly<{kind:"diagnostic";path:string;line:number;code:string}>;
const decode=(value:string):string=>{
  if(!/^[A-Za-z0-9_-]*$/.test(value))throw new Error();
  const decoded=Buffer.from(value,"base64url");
  if(decoded.toString("base64url")!==value)throw new Error();
  return new TextDecoder("utf-8",{fatal:true}).decode(decoded);
};
const index=(value:string,length:number):number=>{
  if(!/^(0|[1-9][0-9]{0,2})$/.test(value))throw new Error();
  const parsed=Number(value);
  if(parsed>=length)throw new Error();
  return parsed;
};
const positive=(value:string):number=>{
  if(!/^[1-9][0-9]{0,6}$/.test(value))throw new Error();
  return Number(value);
};
const parseProtocol=(output:string,paths:readonly string[]):AstRecord[]=>{
  if(output.length>1_000_000)throw new Error();
  const records:AstRecord[]=[];
  for(const line of output.split("\n")){
    if(!line)continue;
    if(records.length>4000)throw new Error();
    const parts=line.replace(/\r$/,"").split("\t");
    if(parts[0]==="D"&&parts.length===4){
      const path=paths[index(parts[1]!,paths.length)]!;
      if(!code(parts[3]))throw new Error();
      records.push({kind:"diagnostic",path,line:positive(parts[2]!),code:parts[3]!});
      continue;
    }
    if(parts[0]!=="R"||parts.length!==15)throw new Error();
    const path=paths[index(parts[1]!,paths.length)]!;
    const [prefix,suffix,headers,consumes,produces,handler]=parts.slice(9).map(decode);
    if(suffix===undefined||!bounded(prefix!,1024)||!bounded(suffix,1024)
      ||!bounded(handler!,128)||!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(handler!)
      ||!parts[8]||!["GET","POST","PUT","PATCH","DELETE"].includes(parts[8]!))throw new Error();
    const split=(text:string)=>text===""?[]:text.split("\0");
    records.push({kind:"route",path,line:positive(parts[2]!),column:positive(parts[3]!),
      endLine:positive(parts[4]!),endColumn:positive(parts[5]!),classLine:positive(parts[6]!),
      methodLine:positive(parts[7]!),method:parts[8]!,prefix:prefix!,suffix,
      headers:split(headers!),consumes:split(consumes!),produces:split(produces!),handler:handler!});
  }
  return records;
};
const runHelper=async(files:ReadonlyMap<string,string>,toolchain:{java:string;jar:string;classes:string},
  timeoutMs:number,maxOutputBytes:number):Promise<AstRecord[]>=>{
  const scratch=await mkdtemp(join(tmpdir(),"api-truth-java-"));
  try{
    const paths=[...files.keys()].sort();
    const argumentsList=[];
    for(let i=0;i<paths.length;i++){
      const path=join(scratch,`source-${i}.java`);
      await writeFile(path,files.get(paths[i]!)!,{flag:"wx",mode:0o600});
      argumentsList.push(path);
    }
    const {stdout}=await execFile(toolchain.java,["-Xmx128m","-XX:ActiveProcessorCount=1",
      "-cp",`${toolchain.classes}:${toolchain.jar}`,"apitruth.AstExtract",...argumentsList],
    {cwd:scratch,timeout:Math.max(1,Math.min(timeoutMs,30_000)),maxBuffer:Math.min(maxOutputBytes,1_000_000),
      env:{PATH:"/usr/bin:/bin",LANG:"C"}});
    return parseProtocol(stdout,paths);
  }catch{throw new Error("JAVA_AST_HELPER_FAILED");}
  finally{await rm(scratch,{recursive:true,force:true}).catch(()=>{});}
};
const sourcePath=(serviceRoot:string,path:string)=>serviceRoot==="."?path:`${serviceRoot}/${path}`;
const validMedia=(value:string)=>bounded(value,128)&&/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(value);
const selectors=(record:Extract<AstRecord,{kind:"route"}>)=>{
  if(record.headers.length>16||record.consumes.length>16||record.produces.length>16
    ||record.consumes.some(value=>!validMedia(value))||record.produces.some(value=>!validMedia(value)))throw new Error();
  const headers=record.headers.map(value=>{
    const match=/^([A-Za-z0-9!#$%&'*+.^_`|~-]+)=([^\u0000-\u001f\u007f]*)$/.exec(value);
    if(!match||match[1]!.endsWith("!")||match[2]!.length>128)throw new Error();
    return {name:match[1]!,operator:"equals" as const,value:match[2]!};
  });
  return {...(headers.length?{headers}:{}),...(record.consumes.length?{consumes:record.consumes}:{}),
    ...(record.produces.length?{produces:record.produces}:{})};
};
const routePath=(record:Extract<AstRecord,{kind:"route"}>)=>{
  if(record.prefix!==""&&!record.prefix.startsWith("/")
    ||record.suffix!==""&&!record.suffix.startsWith("/"))throw new Error();
  for(const part of [record.prefix,record.suffix]){
    if(part.includes("//")||part.includes("${")||part.includes("#{")
      ||/[?#\\]/.test(part)||part.length>1&&part.endsWith("/"))throw new Error();
    if(/\{[^{}]*(?::|\*)[^{}]*\}/.test(part)||part.includes("**"))throw new Error();
  }
  const prefix=record.prefix==="/"?"":record.prefix;
  const suffix=record.suffix==="/"?"":record.suffix;
  return `${prefix}${suffix}`||"/";
};
const extract=(request:AnalyzerRequest,files:ReadonlyMap<string,string>,records:readonly AstRecord[]):AnalyzerResult=>{
  const fingerprint=hash(canonicalJsonStringify({sourceDigest:request.source.source_digest,
    request:{...request,extraction_mode:request.extraction_mode==="incremental"?"fallback_full_service":request.extraction_mode},
    analyzer:ANALYZER,parser:JAVAPARSER_VERSION,parserSha256:JAVAPARSER_SHA256,policy:"ast-only-1"}));
  const result:AnalyzerResult={exchange_version:"1.0.0",ir_version:"1.0.0",identity_version:"1.0.0",
    request_id:request.request_id,result_id:`result-${fingerprint}`,snapshot_id:`snapshot-${fingerprint}`,
    analyzer:ANALYZER,source:request.source,status:"partial",completed_at:new Date().toISOString(),
    coverage:{status:"incomplete",analyzed_roots:[request.source.service_root],
      unresolved_roots:[request.source.service_root],reason:"AST-only Spring declarations; runtime binding and classpath unresolved",
      diagnostic_ids:[]},evidence:[],schemas:{},endpoints:[],claims:[],dependencies:[],diagnostics:[],
    reproducibility_fingerprint:`sha256:${fingerprint}`};
  const evidence=(path:string,line:number,pointer:string,endpointId?:string,method:Evidence["method"]="deterministic_analysis")=>{
    const id=`ev-${hash(`${path}:${pointer}:${method}:${endpointId??""}`).slice(0,24)}`;
    if(!result.evidence.some(item=>item.evidence_id===id))result.evidence.push({evidence_id:id,
      source:{kind:"source_code",source_id:request.source.repository_id},
      source_version:request.source.immutable_revision,
      location:{path:sourcePath(request.source.service_root,path),line,pointer},method,
      scope:{service_id:request.source.service_id,snapshot_id:result.snapshot_id,
        revision:request.source.immutable_revision,...(endpointId?{endpoint_id:endpointId}:{})},
      limitations:["AST declaration only; classpath and startup binding unverified"],
      access_label:request.source.access_label});
    return id;
  };
  const diagnostic=(code:string,path:string,line:number,endpoint?:Endpoint,pointer=`line:${line}`)=>{
    const ev=evidence(path,line,pointer,endpoint?.endpoint_id);
    const id=`diag-${hash(`${code}:${ev}`).slice(0,24)}`;
    if(!result.diagnostics.some(item=>item.diagnostic_id===id))result.diagnostics.push({diagnostic_id:id,
      code,severity:"warning",message:code.replaceAll("_"," "),
      affected_endpoint_ids:endpoint?[endpoint.endpoint_id]:[],evidence_ids:[ev]});
  };
  const routeCounts=new Map<string,number>();
  for(const record of records){
    if(record.kind!=="route")continue;
    try{
      const identity=deriveEndpointIdentity({identity_version:"1.0.0",service_id:request.source.service_id,
        method:record.method,application_path:routePath(record),selectors:selectors(record)});
      routeCounts.set(identity.route_key,(routeCounts.get(identity.route_key)??0)+1);
    }catch{/* each unsupported route receives its own diagnostic below */}
  }
  for(const record of records){
    if(record.kind==="diagnostic"){diagnostic(record.code,record.path,record.line);continue;}
    let identity:Endpoint["identity"],path:string;
    try{path=routePath(record);
      identity=deriveEndpointIdentity({identity_version:"1.0.0",service_id:request.source.service_id,
        method:record.method,application_path:path,selectors:selectors(record)});}
    catch{diagnostic("route_shape_unsupported",record.path,record.line);continue;}
    const endpointId=`endpoint-${hash(identity.route_key).slice(0,24)}`;
    if((routeCounts.get(identity.route_key)??0)>1){
      diagnostic("route_collision_unresolved",record.path,record.line);continue;}
    const pointer=`span:${record.line}:${record.column}-${record.endLine}:${record.endColumn}`;
    const ev=evidence(record.path,record.line,pointer,endpointId,"type_declaration");
    const parameters=[...path.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map(match=>({
      name:match[1]!,in:"path" as const,presence:{state:"unknown" as const,evidence_ids:[ev]},
      schema:{},serialization:{style:"simple"}}));
    const endpoint:Endpoint={endpoint_id:endpointId,identity,application_path:path,parameters,
      request_bodies:[],responses:[{status:{kind:"unknown",reason:"No supported explicit status"},content:[]}],
      security:{state:"unknown",alternatives:[]},evidence_ids:[ev]};
    result.endpoints.push(endpoint);
    result.claims.push({claim_id:`claim-${hash(`${endpointId}:${ev}:route`).slice(0,24)}`,
      subject:{service_id:request.source.service_id,endpoint_id:endpointId},predicate:"route.declaration",
      value:{method:identity.method,path,selectors:identity.selectors,handler:record.handler},
      verification:"declared",evidence_ids:[ev]});
    result.dependencies.push({from_endpoint_id:endpointId,to:{kind:"evidence",id:ev},evidence_ids:[ev]});
    for(const reason of ["startup_binding_unverified","classpath_unresolved","dto_validation_unsupported",
      "response_status_unknown","security_unknown"])
      diagnostic(reason,record.path,record.line,endpoint,pointer);
    if(parameters.length)diagnostic("path_binding_unverified",record.path,record.line,endpoint,pointer);
  }
  if(result.endpoints.length===0&&result.diagnostics.length===0){
    const path=[...files.keys()][0]!;diagnostic("no_supported_spring_routes",path,1);
  }
  result.endpoints.sort((a,b)=>a.identity.route_key.localeCompare(b.identity.route_key));
  result.evidence.sort((a,b)=>a.evidence_id.localeCompare(b.evidence_id));
  result.claims.sort((a,b)=>a.claim_id.localeCompare(b.claim_id));
  result.dependencies.sort((a,b)=>a.from_endpoint_id.localeCompare(b.from_endpoint_id));
  result.diagnostics.sort((a,b)=>a.diagnostic_id.localeCompare(b.diagnostic_id));
  result.coverage={status:"incomplete",analyzed_roots:[request.source.service_root],
    unresolved_roots:[request.source.service_root],reason:"AST-only Spring declarations; runtime binding and classpath unresolved",
    diagnostic_ids:result.diagnostics.map(item=>item.diagnostic_id)};
  return result;
};

/** Exact-version, offline Spring AST profile. It never invokes source or a project build. */
export const createAnalyzer=(options:{projectRoot:string;toolchainRoot?:string})=>({
  analyze:async(input:unknown):Promise<AnalyzerResult>=>{
    const parsed=parseAnalyzerRequest(input);
    if(!parsed.ok)throw new Error("JAVA_ANALYZER_INVALID_REQUEST");
    let request=parsed.value;
    if(request.ir_version!=="1.0.0"||request.analyzer.analyzer_id!==ANALYZER.analyzer_id
      ||request.analyzer.analyzer_version!==ANALYZER.analyzer_version
      ||request.resolution_inputs.length!==1||request.resolution_inputs[0]?.kind!=="source_tree"
      ||request.resolution_inputs[0].path!==request.source.service_root)
      throw new Error("JAVA_ANALYZER_PROFILE_UNSUPPORTED");
    const selected=resolve(options.projectRoot,request.source.service_root);
    if(request.changed_paths.some(path=>!inside(selected,resolve(options.projectRoot,path))))
      throw new Error("JAVA_ANALYZER_SOURCE_BOUNDARY");
    const deadline=Date.now()+request.limits.timeout_ms;
    const files=await readJavaSources(options.projectRoot,request.source.service_root,
      Math.min(request.limits.max_files,200),deadline);
    const digest=digestSources(files);
    const expected=[request.source.source_digest,request.resolution_inputs[0].digest];
    if(expected.some(item=>item!=="pending"&&!/^sha256:[a-f0-9]{64}$/i.test(item)
      ||/^sha256:[a-f0-9]{64}$/i.test(item)&&item.toLowerCase()!==digest))
      throw new Error("JAVA_ANALYZER_SOURCE_DIGEST_MISMATCH");
    request={...request,source:{...request.source,source_digest:digest},
      resolution_inputs:[{kind:"source_tree",path:request.source.service_root,digest}]};
    let toolchain;
    try{toolchain=await checkJavaParserToolchain(options.toolchainRoot??defaultToolchainRoot,false);}
    catch{throw new Error("JAVA_ANALYZER_TOOLCHAIN_UNAVAILABLE");}
    if(Date.now()>=deadline)throw new Error("JAVA_ANALYZER_TIME_LIMIT");
    const records=await runHelper(files,toolchain,deadline-Date.now(),request.limits.max_output_bytes);
    const result=extract(request,files,records);
    if(Buffer.byteLength(JSON.stringify(result),"utf8")>request.limits.max_output_bytes)
      throw new Error("JAVA_ANALYZER_OUTPUT_LIMIT");
    const validated=parseAnalyzerResult(result);
    if(!validated.ok)throw new Error("JAVA_ANALYZER_RESULT_INVALID");
    return validated.value;
  },
});
export const analyze=(request:AnalyzerRequest)=>createAnalyzer({projectRoot:process.cwd()}).analyze(request);
