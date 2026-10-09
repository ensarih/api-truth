import {configuredAnalyzerIrVersion,parseAnalyzerSelection,parseAnalyzerRequest,parseAnalyzerResult,
  type AnalyzerResult} from "@api-truth/ir";
import {ANALYZER as express,createAnalyzer as createExpress} from "@api-truth/analyzer-typescript";
import {ANALYZER as routing,createAnalyzer as createRouting} from "@api-truth/analyzer-routing-controllers";
import {ANALYZER as document,createAnalyzer as createDocument} from "@api-truth/analyzer-nodejs-swagger2-document";
import {ANALYZER as openapi3,createAnalyzer as createOpenapi3} from "@api-truth/analyzer-openapi3-document";
import {ANALYZER as middleware,createAnalyzer as createMiddleware} from "@api-truth/analyzer-nodejs-swagger2-document/middleware";

/** Exact compiled-in profiles; no framework detection or source-selected plugins. */
const registrations = [
  {identity:Object.freeze({...express}),ir:"1.0.0",create:createExpress},
  {identity:Object.freeze({...routing}),ir:"1.0.0",create:createRouting},
  {identity:Object.freeze({...document}),ir:"1.1.0",create:createDocument},
  {identity:Object.freeze({...openapi3}),ir:"1.1.0",create:createOpenapi3},
  {identity:Object.freeze({...middleware}),ir:"1.1.0",create:createMiddleware},
] as const;
export const configuredAnalyzerProfiles = Object.freeze(registrations.map(profile=>Object.freeze({
  adapter_id:profile.identity.analyzer_id,adapter_version:profile.identity.analyzer_version,ir_version:profile.ir,
})));

export function createConfiguredAnalyzer(options:{projectRoot:string;selection:unknown;trustedRuntimePublicKey?:string}) {
  let parsed:ReturnType<typeof parseAnalyzerSelection>;
  try{parsed=parseAnalyzerSelection(structuredClone(options.selection));}catch{throw new Error("UNSUPPORTED_ANALYZER_SELECTION");}
  if(!parsed.ok)throw new Error("UNSUPPORTED_ANALYZER_SELECTION");
  const selection={...parsed.value};
  const ir=configuredAnalyzerIrVersion(selection);
  const profile=registrations.find(item=>item.identity.analyzer_id===selection.adapter_id
    && item.identity.analyzer_version===selection.adapter_version && item.ir===ir);
  if(!profile)throw new Error("UNSUPPORTED_ANALYZER_SELECTION");
  const identity={...profile.identity};
  const adapter=profile.create({projectRoot:options.projectRoot,
    ...(options.trustedRuntimePublicKey===undefined?{}:{trustedRuntimePublicKey:options.trustedRuntimePublicKey})});
  return {async analyze(input:unknown):Promise<AnalyzerResult>{
    let request:ReturnType<typeof parseAnalyzerRequest>;
    try{request=parseAnalyzerRequest(structuredClone(input));}catch{throw new Error("ANALYZER_REQUEST_MISMATCH");}
    if(!request.ok||request.value.ir_version!==ir||request.value.analyzer.analyzer_id!==identity.analyzer_id
      ||request.value.analyzer.analyzer_version!==identity.analyzer_version)throw new Error("ANALYZER_REQUEST_MISMATCH");
    let raw:unknown;
    try{raw=await adapter.analyze(structuredClone(request.value));}catch{throw new Error("ANALYZER_EXECUTION_FAILED");}
    let result:ReturnType<typeof parseAnalyzerResult>;
    try{result=parseAnalyzerResult(structuredClone(raw));}catch{throw new Error("ANALYZER_RESULT_MISMATCH");}
    if(!result.ok||result.value.ir_version!==ir||result.value.analyzer.analyzer_id!==identity.analyzer_id
      ||result.value.analyzer.analyzer_version!==identity.analyzer_version||result.value.request_id!==request.value.request_id
      ||result.value.exchange_version!==request.value.exchange_version
      ||["repository_id","service_id","service_root","immutable_revision","access_label"].some(key=>
        result.value.source[key as keyof typeof result.value.source]!==request.value.source[key as keyof typeof request.value.source]))
      throw new Error("ANALYZER_RESULT_MISMATCH");
    return result.value;
  }};
}
