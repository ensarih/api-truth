import {isProxy} from "node:util/types";
import {canonicalJsonStringify,parseContractSnapshot,type ContractSnapshot} from "../../ir/src/index.js";
import {validateOperationSearchOptions,type CorpusOperationCandidate,type CorpusOperationSearchResult,
  type QueryCorpusOperationReader, type QueryContractResult, type QueryPin} from "../../query/src/index.js";
import {parseQuerySelection,type QuerySelection} from "../../query/src/selector.js";
import type {SemanticAnalysisResult} from "./types.js";

export class SemanticCorpusError extends Error {
  readonly code:"SEMANTIC_CORPUS_INVALID_REQUEST"|"SEMANTIC_CORPUS_STALE_CONTEXT"|"SEMANTIC_CORPUS_UNAVAILABLE";
  constructor(code:SemanticCorpusError["code"]){super(code);this.name="SemanticCorpusError";this.code=code;}
}
const fail=(code:SemanticCorpusError["code"]):never=>{throw new SemanticCorpusError(code);};
const plain=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==="object"&&!isProxy(value)
  &&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype;
const fields=(input:unknown,keys:readonly string[]):Record<string,unknown>|undefined=>{
  try{if(!plain(input))return undefined;const own=Reflect.ownKeys(input);
    if(own.length!==keys.length||own.some(key=>typeof key!=="string"||!keys.includes(key)))return undefined;
    const output:Record<string,unknown>={};for(const key of keys){const descriptor=Object.getOwnPropertyDescriptor(input,key);
      if(!descriptor||!descriptor.enumerable||!("value" in descriptor))return undefined;
      Object.defineProperty(output,key,{value:descriptor.value,enumerable:true,writable:true,configurable:true});}return output;
  }catch{return undefined;}
};
const dataMethod=(input:unknown,key:string):((...args:any[])=>unknown)|undefined=>{
  try{if(!plain(input))return undefined;const descriptor=Object.getOwnPropertyDescriptor(input,key);
    return descriptor&&"value" in descriptor&&typeof descriptor.value==="function"&&!isProxy(descriptor.value)
      ?descriptor.value as (...args:any[])=>unknown:undefined;}catch{return undefined;}
};
const copyJson=(input:unknown,maxBytes=4*1024*1024,maxNodes=50_000,maxDepth=64):unknown=>{
  let bytes=0,nodes=0;const active=new Set<object>();
  const walk=(value:unknown,depth:number):unknown=>{
    if(++nodes>maxNodes||depth>maxDepth)throw new Error();
    if(typeof value==="string"){bytes+=Buffer.byteLength(value,"utf8");if(bytes>maxBytes)throw new Error();return value;}
    if(typeof value==="number"){if(!Number.isFinite(value))throw new Error();return value;}
    if(value===null||typeof value==="boolean")return value;
    if(typeof value!=="object"||isProxy(value)||active.has(value))throw new Error();
    active.add(value);const array=Array.isArray(value),prototype=Object.getPrototypeOf(value);
    if(array?prototype!==Array.prototype:prototype!==Object.prototype)throw new Error();
    const keys=Reflect.ownKeys(value);if(keys.length>10_001)throw new Error();const entries:Array<[string,unknown]>=[];
    for(const key of keys){if(typeof key!=="string")throw new Error();bytes+=Buffer.byteLength(key,"utf8");if(bytes>maxBytes)throw new Error();
      if(array&&key==="length")continue;const descriptor=Object.getOwnPropertyDescriptor(value,key);
      if(!descriptor||!("value" in descriptor))throw new Error();entries.push([key,walk(descriptor.value,depth+1)]);}
    active.delete(value);
    if(array){if(keys.length!==value.length+1||entries.length!==value.length)throw new Error();
      const result:unknown[]=[];for(let i=0;i<entries.length;i++){if(entries[i]?.[0]!==String(i))throw new Error();result.push(entries[i]![1]);}return result;}
    return Object.fromEntries(entries);
  };
  return walk(input,0);
};
const id=(value:unknown):value is string=>typeof value==="string"&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const safeText=(value:unknown,max=512):value is string=>typeof value==="string"&&value.length>0&&value.length<=max
  &&!/[\u0000-\u001f\u007f]/.test(value)&&!/(?:https?:\/\/|\bBearer\s+|(?:api[_-]?key|secret|password|token|authorization)\s*[:=])/i.test(value);
const equal=(left:unknown,right:unknown):boolean=>{
  try{return canonicalJsonStringify(left)===canonicalJsonStringify(right);}catch{return false;}
};
type Context=Readonly<{tenantId:string;principalId:string}>;
type Options=Readonly<{environment:string;intentQuery:string;limit:number}>;
type Group=Readonly<{repositoryId:string;serviceId:string;selector:QuerySelection;pin:QueryPin;
  candidates:readonly CorpusOperationCandidate[]}>;
export type SemanticCorpusGroupResult=Readonly<Group & {result:SemanticAnalysisResult}>;
export type SemanticCorpusDiscoveryResult=
  | Readonly<{status:"groups";environment:string;scope:"keyword_candidates";verification:"inferred";review:"unreviewed";normative:false;
      shortlistCoverage:Readonly<{complete:boolean;truncated:boolean;incompleteReason?:"incomplete_scan"|"scan_limit"}>;
      groups:readonly SemanticCorpusGroupResult[]}>
  | Readonly<{status:"shortlist_no_match";environment:string;scope:"keyword_candidates";matchMode:"keyword";complete:true;
      verification:"inferred";review:"unreviewed";normative:false}>
  | Readonly<{status:"unknown";environment:string;reason:"no_visible_services"|"incomplete_scan"|"scan_limit"|"group_limit"|"unsupported_pin"}>;
type DiscoveryPort={discover(context:unknown,selection:unknown,endpointIds:unknown,intentQuery:unknown):Promise<SemanticAnalysisResult>};
type ContractReadPort={readContract(context:unknown,selection:unknown):Promise<QueryContractResult>};
type Ports=Readonly<{corpusReader:QueryCorpusOperationReader&ContractReadPort;semanticService:DiscoveryPort}>;
const parseContext=(input:unknown):Context=>{
  const value=fields(input,["tenantId","principalId"]);
  if(!value||!safeText(value.tenantId,512)||!safeText(value.principalId,512))return fail("SEMANTIC_CORPUS_INVALID_REQUEST");
  return Object.freeze({tenantId:value.tenantId,principalId:value.principalId});
};
const parseOptions=(input:unknown):Options=>{
  const value=fields(input,["environment","intentQuery","limit"]);
  if(!value||!safeText(value.environment,512)||!validateOperationSearchOptions({intentQuery:value.intentQuery,limit:value.limit}))
    return fail("SEMANTIC_CORPUS_INVALID_REQUEST");
  const validated=validateOperationSearchOptions({intentQuery:value.intentQuery,limit:value.limit})!;
  if(validated.limit!>16)return fail("SEMANTIC_CORPUS_INVALID_REQUEST");
  return Object.freeze({environment:value.environment,intentQuery:validated.intentQuery,limit:validated.limit??20});
};
const pinOf=(input:unknown):QueryPin|undefined=>{
  const outer=fields(input,["snapshotId","revision","configFingerprint",...(plain(input)&&Object.hasOwn(input,"checkpointVersion")?["checkpointVersion"]:[]),
    ...(plain(input)&&Object.hasOwn(input,"selectedRevision")?["selectedRevision"]:[])]);
  if(!outer||!id(outer.snapshotId)||!id(outer.revision)||!safeText(outer.configFingerprint,256)
    ||!Object.hasOwn(outer,"checkpointVersion")||!positiveVersion(outer.checkpointVersion))return undefined;
  for(const key of ["checkpointVersion","selectedRevision"]){if(Object.hasOwn(outer,key)&&!safeText(outer[key],128))return undefined;}
  return Object.freeze(outer) as QueryPin;
};
const positiveVersion=(value:unknown):value is string=>typeof value==="string"&&/^[1-9][0-9]{0,18}$/.test(value)
  &&BigInt(value)<=9_223_372_036_854_775_807n;
const groupKey=(candidate:CorpusOperationCandidate)=>canonicalJsonStringify([candidate.repositoryId,candidate.serviceId,candidate.selector,candidate.pin]);
const validCandidate=(value:unknown,context:Context,environment:string):CorpusOperationCandidate|undefined=>{
  const candidate=fields(value,["endpointId","method","path","label","evidenceIds","score","repositoryId","serviceId","selector","pin"]);
  if(!candidate||!id(candidate.endpointId)||!id(candidate.method)||!safeText(candidate.path,512)||candidate.path.startsWith("//")
    ||!safeText(candidate.label,160)||!id(candidate.repositoryId)||!id(candidate.serviceId)
    ||typeof candidate.score!=="number"||!Number.isSafeInteger(candidate.score)||candidate.score<1
    ||!Array.isArray(candidate.evidenceIds)||isProxy(candidate.evidenceIds)||candidate.evidenceIds.length<1
    ||candidate.evidenceIds.length>32||new Set(candidate.evidenceIds).size!==candidate.evidenceIds.length
    ||candidate.evidenceIds.some(item=>!id(item)))return undefined;
  let selector:QuerySelection;
  try{selector=parseQuerySelection(candidate.selector);}catch{return undefined;}
  const pin=pinOf(candidate.pin);
  if(!pin||selector.tenantId!==context.tenantId||selector.repositoryId!==candidate.repositoryId
    ||selector.serviceId!==candidate.serviceId||selector.selector.kind!=="environment"
    ||selector.selector.environment!==environment||!selector.selector.expectedCheckpointVersion
    ||pin.checkpointVersion!==selector.selector.expectedCheckpointVersion)return undefined;
  return Object.freeze({endpointId:candidate.endpointId,method:candidate.method,path:candidate.path,label:candidate.label,
    evidenceIds:Object.freeze([...candidate.evidenceIds] as string[]),score:candidate.score,repositoryId:candidate.repositoryId,
    serviceId:candidate.serviceId,selector,pin});
};
const parseSearch=(input:unknown,context:Context,options:Options):CorpusOperationSearchResult|undefined=>{
  if(!plain(input))return undefined;
  const status=Object.getOwnPropertyDescriptor(input,"status")?.value;
  if(status==="no_match"){
    const result=fields(input,["status","matchMode","scope","environment","complete","truncated"]);
    return result?.matchMode==="keyword"&&result.scope==="visible_authorized_services"&&result.environment===options.environment
      &&result.complete===true&&result.truncated===false?result as unknown as CorpusOperationSearchResult:undefined;
  }
  if(status==="unknown"){
    const result=fields(input,["status","matchMode","scope","environment","reason"]);
    return result?.matchMode==="keyword"&&result.scope==="visible_authorized_services"&&result.environment===options.environment
      &&["no_visible_services","incomplete_scan","scan_limit"].includes(String(result.reason))
      ?result as unknown as CorpusOperationSearchResult:undefined;
  }
  const result=fields(input,["status","matchMode","scope","environment","candidates","complete","truncated",...(plain(input)&&Object.hasOwn(input,"incompleteReason")?["incompleteReason"]:[])]);
  if(!result||result.status!=="candidates"||result.matchMode!=="keyword"||result.scope!=="visible_authorized_services"
    ||result.environment!==options.environment||typeof result.complete!=="boolean"||typeof result.truncated!=="boolean"
    ||!Array.isArray(result.candidates)||isProxy(result.candidates)||result.candidates.length<1||result.candidates.length>options.limit
    ||Object.hasOwn(result,"incompleteReason")&&!(["incomplete_scan","scan_limit"] as unknown[]).includes(result.incompleteReason)
    ||result.complete===true&&Object.hasOwn(result,"incompleteReason")
    ||result.complete===false&&!Object.hasOwn(result,"incompleteReason"))return undefined;
  const candidates:CorpusOperationCandidate[]=[];
  for(const item of result.candidates){const candidate=validCandidate(item,context,options.environment);if(!candidate)return undefined;candidates.push(candidate);}
  return Object.freeze({...result,candidates:Object.freeze(candidates)}) as CorpusOperationSearchResult;
};
const groupCandidates=(candidates:readonly CorpusOperationCandidate[]):Group[]=>{
  const byKey=new Map<string,CorpusOperationCandidate[]>(),servicePin=new Map<string,string>();
  for(const candidate of candidates){const serviceKey=JSON.stringify([candidate.repositoryId,candidate.serviceId]),key=groupKey(candidate),known=servicePin.get(serviceKey);
    if(known!==undefined&&known!==key)throw new SemanticCorpusError("SEMANTIC_CORPUS_STALE_CONTEXT");
    servicePin.set(serviceKey,key);const items=byKey.get(key)??[];
    if(items.some(item=>item.endpointId===candidate.endpointId))throw new SemanticCorpusError("SEMANTIC_CORPUS_UNAVAILABLE");
    items.push(candidate);byKey.set(key,items);}
  return [...byKey.values()].map(items=>Object.freeze({repositoryId:items[0]!.repositoryId,serviceId:items[0]!.serviceId,
    selector:items[0]!.selector,pin:items[0]!.pin,candidates:Object.freeze(items)}));
};
const validCoverage=(input:unknown,group:Group):boolean=>{
  if(input===undefined)return false;
  const value=fields(input,["status","requestedEndpointIds","analyzedEndpointIds","omittedEndpointIds"]);
  if(!value||!(value.status==="complete"||value.status==="partial"))return false;
  const requested=value.requestedEndpointIds,analyzed=value.analyzedEndpointIds,omitted=value.omittedEndpointIds;
  if(!Array.isArray(requested)||!Array.isArray(analyzed)||!Array.isArray(omitted)||isProxy(requested)||isProxy(analyzed)||isProxy(omitted))return false;
  const expected=group.candidates.map(item=>item.endpointId);
  if(!equal(requested,expected)||new Set(analyzed).size!==analyzed.length||new Set(omitted).size!==omitted.length
    ||analyzed.some(id=>typeof id!=="string"||!expected.includes(id))||omitted.some(id=>typeof id!=="string"||!expected.includes(id))
    ||analyzed.length+omitted.length!==expected.length||expected.some(id=>analyzed.includes(id)===omitted.includes(id)))return false;
  return value.status===(omitted.length===0?"complete":"partial");
};
const validDiscoveryResult=(input:unknown,group:Group,allowedEvidence:ReadonlyMap<string,ReadonlySet<string>>):SemanticAnalysisResult|undefined=>{
  const top=plain(input)?Object.getOwnPropertyDescriptor(input,"status")?.value:undefined;
  if(top==="disabled")return copyJson(fields(input,["status"])) as SemanticAnalysisResult|undefined;
  if(top==="no_context"){
    const value=fields(input,Object.hasOwn(input as object,"contextCoverage")?["status","contextCoverage"]:["status"]);
    return value&&validCoverage(value.contextCoverage,group)?copyJson(value) as SemanticAnalysisResult:undefined;
  }
  const candidates=new Set(group.candidates.map(item=>item.endpointId));
  const common=(value:Record<string,unknown>)=>{
    const provenance=fields(value.provenance,["provider","model","promptVersion","selector","pin"]);
    return value.verification==="inferred"&&value.review==="unreviewed"&&value.normative===false&&!!provenance
      &&["openai","gemini","claude"].includes(String(provenance.provider))&&safeText(provenance.model,128)
      &&["semantic-discovery-1","semantic-discovery-source-1"].includes(String(provenance.promptVersion))
      &&equal(provenance.pin,group.pin)&&equal(provenance.selector,group.selector.selector);
  };
  if(top==="suggestions"){
    const value=fields(input,["status","suggestions","verification","review","normative","provenance",...(Object.hasOwn(input as object,"contextCoverage")?["contextCoverage"]:[])]);
    if(!value||!Array.isArray(value.suggestions)||isProxy(value.suggestions)||value.suggestions.length<1||value.suggestions.length>16||!common(value))return undefined;
    for(const item of value.suggestions){const suggestion=fields(item,["endpointId","intent","summary","evidenceIds"]);
      const allowed=suggestion&&allowedEvidence.get(String(suggestion.endpointId));
      if(!suggestion||!candidates.has(String(suggestion.endpointId))||!safeText(suggestion.intent,120)||!safeText(suggestion.summary,300)
        ||!Array.isArray(suggestion.evidenceIds)||isProxy(suggestion.evidenceIds)||suggestion.evidenceIds.length<1
        ||suggestion.evidenceIds.length>8||new Set(suggestion.evidenceIds).size!==suggestion.evidenceIds.length
        ||suggestion.evidenceIds.some(id=>typeof id!=="string"||!allowed?.has(id)))return undefined;}
    if(new Set(value.suggestions.map(item=>plain(item)?Object.getOwnPropertyDescriptor(item,"endpointId")?.value:undefined)).size!==value.suggestions.length
      ||!validCoverage(value.contextCoverage,group))return undefined;
    return copyJson(value) as SemanticAnalysisResult;
  }
  if(top==="ambiguous"){
    const value=fields(input,["status","candidateEndpointIds","reason","verification","review","normative","provenance",...(Object.hasOwn(input as object,"contextCoverage")?["contextCoverage"]:[])]);
    if(!value||!Array.isArray(value.candidateEndpointIds)||isProxy(value.candidateEndpointIds)||value.candidateEndpointIds.length<2
      ||value.candidateEndpointIds.length>16||value.candidateEndpointIds.some(id=>typeof id!=="string"||!candidates.has(id))
      ||new Set(value.candidateEndpointIds).size!==value.candidateEndpointIds.length||!safeText(value.reason,300)||!common(value)
      ||!validCoverage(value.contextCoverage,group))return undefined;
    return copyJson(value) as SemanticAnalysisResult;
  }
  if(top==="no_match"){
    const value=fields(input,["status","reason","verification","review","normative","provenance",...(Object.hasOwn(input as object,"contextCoverage")?["contextCoverage"]:[])]);
    if(!value||!safeText(value.reason,300)||!common(value)||!validCoverage(value.contextCoverage,group))return undefined;
    return copyJson(value) as SemanticAnalysisResult;
  }
  return undefined;
};

const parsedContract=(input:unknown,group:Group,context:Context):Readonly<{snapshot:ContractSnapshot;pin:QueryPin}>|undefined=>{
  const value=fields(input,["status","selector","pin","snapshot","publication"]);
  if(!value||value.status!=="resolved")return undefined;
  let selector:QuerySelection;try{selector=parseQuerySelection(value.selector);}catch{return undefined;}
  const pin=pinOf(value.pin);if(!pin||!equal(selector,group.selector)||!equal(pin,group.pin))return undefined;
  const publication=value.publication;
  if(!plain(publication))return undefined;
  const publicationStatus=Object.getOwnPropertyDescriptor(publication,"status")?.value;
  if(publicationStatus==="absent"){if(!fields(publication,["status"]))return undefined;}
  else if(publicationStatus==="current"){
    const current=fields(publication,["status","publicationId","contentSha256",...(Object.hasOwn(publication,"pointerVersion")?["pointerVersion"]:[]),"selector"]);
    const published=current&&fields(current.selector,["kind","repositoryId","serviceId","snapshotId","revision","configFingerprint",
      "environment","checkpointVersion","resolvedSnapshotIds"]);
    if(!current||Object.hasOwn(current,"pointerVersion")||!id(current.publicationId)||!/^sha256:[a-f0-9]{64}$/.test(String(current.contentSha256))||!published
      ||published.kind!=="environment"||published.repositoryId!==group.repositoryId||published.serviceId!==group.serviceId
      ||published.snapshotId!==group.pin.snapshotId||published.revision!==group.pin.revision
      ||published.configFingerprint!==group.pin.configFingerprint||selector.selector.kind!=="environment"
      ||published.environment!==selector.selector.environment
      ||published.checkpointVersion!==group.pin.checkpointVersion||!Array.isArray(published.resolvedSnapshotIds)
      ||!equal(published.resolvedSnapshotIds,[group.pin.snapshotId]))return undefined;
  }else return undefined;
  let parsed:ReturnType<typeof parseContractSnapshot>;try{parsed=parseContractSnapshot(value.snapshot);}catch{return undefined;}
  if(!parsed.ok)return undefined;const snapshot=parsed.value;
  if(snapshot.service.repository_id!==group.repositoryId||snapshot.service.service_id!==group.serviceId
    ||snapshot.source.repository_id!==group.repositoryId||snapshot.snapshot_id!==pin.snapshotId
    ||snapshot.source.immutable_revision!==pin.revision||snapshot.config.config_fingerprint!==pin.configFingerprint
    ||selector.tenantId!==context.tenantId)return undefined;
  return Object.freeze({snapshot,pin});
};

/** Orchestrates bounded per-service discovery over an already authorized corpus search port. */
export const createSemanticCorpusService=(input:Ports)=>{
  const options=fields(input,["corpusReader","semanticService"]);
  if(!options||!plain(options.corpusReader)||!plain(options.semanticService))
    return fail("SEMANTIC_CORPUS_INVALID_REQUEST");
  const query=options.corpusReader as unknown as Ports["corpusReader"],semantic=options.semanticService as unknown as DiscoveryPort;
  const searchMethod=dataMethod(query,"searchOperationCandidatesAcrossServices"),readMethod=dataMethod(query,"readContract"),discoverMethod=dataMethod(semantic,"discover");
  if(!searchMethod||!readMethod||!discoverMethod)return fail("SEMANTIC_CORPUS_INVALID_REQUEST");
  const search=(...args:unknown[])=>searchMethod.apply(query,args),readContract=(...args:unknown[])=>readMethod.apply(query,args),
    discover=(...args:unknown[])=>discoverMethod.apply(semantic,args);
  const searchAgain=async(context:Context,options:Options):Promise<CorpusOperationSearchResult>=>{
    try{const raw=await search(context,{tenantId:context.tenantId,environment:options.environment,intentQuery:options.intentQuery,limit:options.limit});
      const parsed=parseSearch(copyJson(raw),context,options);if(!parsed)return fail("SEMANTIC_CORPUS_UNAVAILABLE");return parsed;
    }catch(error){if(error instanceof SemanticCorpusError)throw error;return fail("SEMANTIC_CORPUS_UNAVAILABLE");}
  };
  return Object.freeze({discoverAcrossServices:async(contextInput:unknown,requestInput:unknown):Promise<SemanticCorpusDiscoveryResult>=>{
    const context=parseContext(contextInput),request=parseOptions(requestInput),initial=await searchAgain(context,request);
    if(initial.status==="unknown")return Object.freeze({status:"unknown",environment:request.environment,reason:initial.reason});
    if(initial.status==="no_match")return Object.freeze({status:"shortlist_no_match",environment:request.environment,
      matchMode:"keyword",scope:"keyword_candidates",complete:true,verification:"inferred",review:"unreviewed",normative:false});
    const groups=groupCandidates(initial.candidates);
    if(groups.length>4)return Object.freeze({status:"unknown",environment:request.environment,reason:"group_limit"});
    if(groups.some(group=>Object.hasOwn(group.pin,"selectedRevision")||Object.hasOwn(group.pin,"pointerVersion")
      ||!group.pin.checkpointVersion))return Object.freeze({status:"unknown",environment:request.environment,reason:"unsupported_pin"});
    const results:SemanticCorpusGroupResult[]=[];
    for(const group of groups){
      let rawContract:unknown;
      try{rawContract=await readContract(context,group.selector);}catch{return fail("SEMANTIC_CORPUS_UNAVAILABLE");}
      let detachedContract:unknown;try{detachedContract=copyJson(rawContract);}catch{return fail("SEMANTIC_CORPUS_UNAVAILABLE");}
      const contract=parsedContract(detachedContract,group,context);if(!contract)return fail("SEMANTIC_CORPUS_STALE_CONTEXT");
      const snapshot=contract.snapshot;
      const endpointSet=new Set(group.candidates.map(item=>item.endpointId));
      if(group.candidates.some(candidate=>!snapshot.endpoints.some(endpoint=>endpoint.endpoint_id===candidate.endpointId
        &&endpoint.identity.method===candidate.method&&endpoint.application_path===candidate.path)))return fail("SEMANTIC_CORPUS_STALE_CONTEXT");
      const allowedEvidence=new Map<string,ReadonlySet<string>>();
      for(const endpointId of endpointSet){const scoped=snapshot.evidence.filter(evidence=>evidence.source.source_id===snapshot.source.repository_id
        &&evidence.source_version===snapshot.source.immutable_revision&&evidence.scope.service_id===group.serviceId
        &&evidence.scope.snapshot_id===snapshot.snapshot_id&&evidence.scope.revision===snapshot.source.immutable_revision
        &&(evidence.scope.endpoint_id===undefined||evidence.scope.endpoint_id===endpointId));
        const allCandidateEvidence=new Set(scoped.map(evidence=>evidence.evidence_id));
        const candidate=group.candidates.find(item=>item.endpointId===endpointId)!;
        if(candidate.evidenceIds.some(evidenceId=>!allCandidateEvidence.has(evidenceId)))return fail("SEMANTIC_CORPUS_STALE_CONTEXT");
        const ids=scoped.filter(evidence=>(evidence.source.kind==="api_document"&&evidence.method==="type_declaration"
          &&(evidence.scope.endpoint_id===undefined||evidence.scope.endpoint_id===endpointId)
          ||evidence.source.kind==="source_code"&&evidence.scope.endpoint_id===endpointId
            &&(evidence.method==="type_declaration"||evidence.method==="deterministic_analysis")))
          .map(evidence=>evidence.evidence_id);allowedEvidence.set(endpointId,new Set(ids));}
      let raw:unknown;
      try{raw=await discover(context,group.selector,group.candidates.map(item=>item.endpointId),request.intentQuery);}
      catch{return fail("SEMANTIC_CORPUS_UNAVAILABLE");}
      let result:SemanticAnalysisResult|undefined;
      try{result=validDiscoveryResult(copyJson(raw),group,allowedEvidence);}catch{return fail("SEMANTIC_CORPUS_UNAVAILABLE");}
      if(!result)return fail("SEMANTIC_CORPUS_UNAVAILABLE");
      results.push(Object.freeze({...group,result}));
    }
    const final=await searchAgain(context,request);
    if(!equal(initial,final))return fail("SEMANTIC_CORPUS_STALE_CONTEXT");
    return Object.freeze({status:"groups",environment:request.environment,scope:"keyword_candidates",
      verification:"inferred",review:"unreviewed",normative:false,
      shortlistCoverage:Object.freeze({complete:initial.complete,truncated:initial.truncated,
        ...("incompleteReason" in initial&&initial.incompleteReason?{incompleteReason:initial.incompleteReason}:{})}),
      groups:Object.freeze(results)});
  }});
};
