import {parseStrictJson} from "../../../packages/ir/src/strict-json.js";
import {createAnalyzer} from "./index.js";

const run=async()=>{
  let bytes=0;
  const chunks:Buffer[]=[];
  for await(const chunk of process.stdin){
    bytes+=chunk.length;
    if(bytes>1_000_000)throw new Error();
    chunks.push(chunk);
  }
  const raw=new TextDecoder("utf-8",{fatal:true}).decode(Buffer.concat(chunks));
  const request=parseStrictJson(raw,{maxDepth:32,maxNodes:10_000});
  const projectRoot=process.argv[2]??process.cwd();
  if(process.argv.length>3)throw new Error();
  const result=await createAnalyzer({projectRoot}).analyze(request);
  process.stdout.write(`${JSON.stringify(result)}\n`);
};
try{await run();}catch{process.stderr.write("JAVA_ANALYZER_FAILED\n");process.exitCode=1;}
