import {createHash} from "node:crypto";
import type {PoolClient} from "pg";
import {canonicalJsonStringify} from "../../ir/src/index.js";
import type {QueryPin,QuerySelection} from "../../query/src/index.js";
import type {SemanticAnalysisResult,SemanticContextCoverage,SemanticProviderId,
  SemanticProviderRequest} from "./types.js";
import {isSemanticDocumentTextSafe} from "./egress.js";

const MAX_RESULT_BYTES=16*1024;
const safeId=(value:unknown):value is string=>typeof value==="string"&&value.length<=128
  &&/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
const safeText=(value:unknown):value is string=>typeof value==="string"&&value.length>0
  &&value.length<=512&&!/[\u0000-\u001f\u007f]/.test(value);
const sameKeys=(value:unknown,names:readonly string[]):value is Record<string,unknown>=>!!value
  &&typeof value==="object"&&!Array.isArray(value)
  &&Object.keys(value).sort().join(",")===[...names].sort().join(",");
const idList=(value:unknown,max=16):value is string[]=>Array.isArray(value)&&value.length<=max
  &&value.every(safeId)&&new Set(value).size===value.length;
const hash=(value:unknown)=>`sha256:${createHash("sha256").update(canonicalJsonStringify(value)).digest("hex")}`;

export class SemanticHistoryError extends Error {
  readonly code="SEMANTIC_HISTORY_ERROR";
  constructor(){super("SEMANTIC_HISTORY_ERROR");this.name="SemanticHistoryError";}
}
export type SemanticHistorySafeResult=
  | Readonly<{status:"suggestions";suggestions:readonly Readonly<{endpointId:string;evidenceIds:readonly string[]}>[];
      contextCoverage?:SemanticContextCoverage}>
  | Readonly<{status:"ambiguous";candidateEndpointIds:readonly string[];contextCoverage?:SemanticContextCoverage}>
  | Readonly<{status:"no_match";contextCoverage?:SemanticContextCoverage}>;
export type SemanticHistoryRecord=Readonly<{historyId:string;createdAt:string;
  verification:"inferred";review:"unreviewed";normative:false;
  result:SemanticHistorySafeResult;requestedEndpointIds:readonly string[];
  provenance:Readonly<{provider:SemanticProviderId;model:string;
    promptVersion:SemanticProviderRequest["promptVersion"];selector:QuerySelection["selector"];pin:QueryPin}>}>;
export type SemanticHistoryReadResult=Readonly<{status:"resolved";selector:QuerySelection;pin:QueryPin;
  records:readonly SemanticHistoryRecord[];truncated:boolean}>;
export type SemanticHistoryScope=Readonly<{tenantId:string;principalId:string;selection:QuerySelection;
  pin:QueryPin;configurationHash:string;provider:SemanticProviderId;model:string;
  endpointIds:readonly string[]}>;

const coverage=(value:unknown,requested:readonly string[]):SemanticContextCoverage|undefined=>{
  if(value===undefined)return undefined;
  if(!sameKeys(value,["status","requestedEndpointIds","analyzedEndpointIds","omittedEndpointIds"])
    ||(value.status!=="complete"&&value.status!=="partial")
    ||!idList(value.requestedEndpointIds)||!idList(value.analyzedEndpointIds)
    ||!idList(value.omittedEndpointIds))throw new SemanticHistoryError();
  const wanted=new Set(requested);
  const requestedIds=value.requestedEndpointIds as string[];
  const analyzed=value.analyzedEndpointIds as string[],omitted=value.omittedEndpointIds as string[];
  if(requestedIds.length!==requested.length||requestedIds.some(id=>!wanted.has(id))
    ||analyzed.some(id=>!wanted.has(id))||omitted.some(id=>!wanted.has(id))
    ||analyzed.length+omitted.length!==requested.length
    ||analyzed.some(id=>omitted.includes(id))
    ||value.status==="complete"&&omitted.length!==0
    ||value.status==="partial"&&omitted.length===0)throw new SemanticHistoryError();
  return {status:value.status,requestedEndpointIds:requestedIds,
    analyzedEndpointIds:analyzed,omittedEndpointIds:omitted};
};

/** Discards all free-form provider prose and the caller's intent query before persistence. */
export const projectSemanticHistory=(result:SemanticAnalysisResult,
  requestedEndpointIds:readonly string[]):SemanticHistorySafeResult=>{
  if(!idList(requestedEndpointIds)||requestedEndpointIds.length<1)throw new SemanticHistoryError();
  const contextCoverage=coverage("contextCoverage" in result?result.contextCoverage:undefined,requestedEndpointIds);
  const wanted=new Set(requestedEndpointIds);
  let safe:SemanticHistorySafeResult;
  if(result.status==="suggestions"){
    const suggestions=result.suggestions.map(item=>{
      if(!wanted.has(item.endpointId)||!idList(item.evidenceIds,8)||item.evidenceIds.length<1)
        throw new SemanticHistoryError();
      return {endpointId:item.endpointId,evidenceIds:[...item.evidenceIds]};
    });
    if(suggestions.length<1||suggestions.length>16||new Set(suggestions.map(item=>item.endpointId)).size!==suggestions.length)
      throw new SemanticHistoryError();
    safe={status:"suggestions",suggestions,...(contextCoverage?{contextCoverage}:{})};
  }else if(result.status==="ambiguous"){
    if(!idList(result.candidateEndpointIds)||result.candidateEndpointIds.length<2
      ||result.candidateEndpointIds.some(id=>!wanted.has(id)))throw new SemanticHistoryError();
    safe={status:"ambiguous",candidateEndpointIds:[...result.candidateEndpointIds],
      ...(contextCoverage?{contextCoverage}:{})};
  }else if(result.status==="no_match")safe={status:"no_match",...(contextCoverage?{contextCoverage}:{})};
  else throw new SemanticHistoryError();
  if(Buffer.byteLength(canonicalJsonStringify(safe),"utf8")>MAX_RESULT_BYTES)throw new SemanticHistoryError();
  return safe;
};

const selectorParts=(selection:QuerySelection,pin:QueryPin)=>{
  const selector=selection.selector;
  return selector.kind==="environment"?{kind:selector.kind,value:selector.environment,version:pin.checkpointVersion}
    :selector.kind==="branch"?{kind:selector.kind,value:selector.branch,version:pin.pointerVersion}
      :{kind:selector.kind,value:selector.revision,version:null};
};
const recordHash=(scope:SemanticHistoryScope,promptVersion:SemanticProviderRequest["promptVersion"],
  requestedEndpointIds:readonly string[],result:SemanticHistorySafeResult)=>hash({
    tenantId:scope.tenantId,principalId:scope.principalId,
    repositoryId:scope.selection.repositoryId,serviceId:scope.selection.serviceId,
    selector:selectorParts(scope.selection,scope.pin),pin:scope.pin,
    configurationHash:scope.configurationHash,provider:scope.provider,model:scope.model,
    promptVersion,requestedEndpointIds:[...requestedEndpointIds].sort(),result});

export const appendSemanticHistory=async(client:PoolClient,scope:SemanticHistoryScope,
  result:SemanticAnalysisResult):Promise<void>=>{
  if(result.status==="disabled"||result.status==="no_context")return;
  const provenance=result.provenance;
  if(provenance.provider!==scope.provider||provenance.model!==scope.model
    ||canonicalJsonStringify(provenance.selector)!==canonicalJsonStringify(scope.selection.selector)
    ||canonicalJsonStringify(provenance.pin)!==canonicalJsonStringify(scope.pin))throw new SemanticHistoryError();
  const promptVersion=provenance.promptVersion;
  if(!["semantic-grounding-1","semantic-discovery-1","semantic-discovery-source-1"].includes(promptVersion))
    throw new SemanticHistoryError();
  const safe=projectSemanticHistory(result,scope.endpointIds);
  const selected=selectorParts(scope.selection,scope.pin);
  if(!safeText(scope.model)||!isSemanticDocumentTextSafe(scope.model,512)
    ||!safeText(selected.value)||!safeText(scope.pin.snapshotId)
    ||!safeText(scope.pin.revision)||!safeText(scope.pin.configFingerprint))throw new SemanticHistoryError();
  await client.query(`INSERT INTO semantic_inference_history
    (tenant_id,principal_id,repository_id,service_id,selector_kind,selector_value,selector_version,
     snapshot_id,revision,config_fingerprint,configuration_hash,provider,model,prompt_version,
     requested_endpoint_ids,safe_result,record_sha256)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::text[],$16::jsonb,$17)`,
  [scope.tenantId,scope.principalId,scope.selection.repositoryId,scope.selection.serviceId,
    selected.kind,selected.value,selected.version,scope.pin.snapshotId,scope.pin.revision,
    scope.pin.configFingerprint,scope.configurationHash,scope.provider,scope.model,promptVersion,
    [...scope.endpointIds].sort(),JSON.stringify(safe),recordHash(scope,promptVersion,scope.endpointIds,safe)]);
};

type HistoryRow={history_id:string;created_at:Date|string;requested_endpoint_ids:string[];
  safe_result:unknown;record_sha256:string;prompt_version:string};
const validateStored=(input:unknown,requested:readonly string[]):SemanticHistorySafeResult=>{
  if(!input||typeof input!=="object"||Array.isArray(input))throw new SemanticHistoryError();
  const result=input as Record<string,unknown>;
  if(result.status==="suggestions"){
    if(!sameKeys(result,result.contextCoverage===undefined?["status","suggestions"]
      :["status","suggestions","contextCoverage"])||!Array.isArray(result.suggestions)
      ||result.suggestions.length<1||result.suggestions.length>16)throw new SemanticHistoryError();
    const wanted=new Set(requested);
    const suggestions=result.suggestions.map(item=>{
      if(!sameKeys(item,["endpointId","evidenceIds"])||!safeId(item.endpointId)
        ||!wanted.has(item.endpointId)||!idList(item.evidenceIds,8)
        ||item.evidenceIds.length<1)throw new SemanticHistoryError();
      return {endpointId:item.endpointId,evidenceIds:item.evidenceIds};
    });
    if(new Set(suggestions.map(item=>item.endpointId)).size!==suggestions.length)throw new SemanticHistoryError();
    const contextCoverage=coverage(result.contextCoverage,requested);
    return {status:"suggestions",suggestions,...(contextCoverage?{contextCoverage}:{})};
  }
  if(result.status==="ambiguous"){
    if(!sameKeys(result,result.contextCoverage===undefined?["status","candidateEndpointIds"]
      :["status","candidateEndpointIds","contextCoverage"])
      ||!idList(result.candidateEndpointIds)||result.candidateEndpointIds.length<2
      ||result.candidateEndpointIds.some(id=>!requested.includes(id)))throw new SemanticHistoryError();
    const contextCoverage=coverage(result.contextCoverage,requested);
    return {status:"ambiguous",candidateEndpointIds:result.candidateEndpointIds,
      ...(contextCoverage?{contextCoverage}:{})};
  }
  if(result.status==="no_match"){
    if(!sameKeys(result,result.contextCoverage===undefined?["status"]:["status","contextCoverage"]))
      throw new SemanticHistoryError();
    const contextCoverage=coverage(result.contextCoverage,requested);
    return {status:"no_match",...(contextCoverage?{contextCoverage}:{})};
  }
  throw new SemanticHistoryError();
};

export const readSemanticHistory=async(client:PoolClient,scope:SemanticHistoryScope,
  limit:number,historyId?:string):Promise<SemanticHistoryReadResult>=>{
  const selected=selectorParts(scope.selection,scope.pin);
  const rows=(await client.query<HistoryRow>(`SELECT history_id::text,created_at,requested_endpoint_ids,
      safe_result,record_sha256,prompt_version FROM semantic_inference_history
    WHERE tenant_id=$1 AND principal_id=$2 AND repository_id=$3 AND service_id=$4
      AND selector_kind=$5 AND selector_value=$6 AND selector_version IS NOT DISTINCT FROM $7::text
      AND snapshot_id=$8 AND revision=$9 AND config_fingerprint=$10 AND configuration_hash=$11
      AND provider=$12 AND model=$13 AND requested_endpoint_ids <@ $14::text[]
      AND ($16::bigint IS NULL OR history_id=$16::bigint)
    ORDER BY history_id DESC LIMIT $15`,
  [scope.tenantId,scope.principalId,scope.selection.repositoryId,scope.selection.serviceId,
    selected.kind,selected.value,selected.version,scope.pin.snapshotId,scope.pin.revision,
    scope.pin.configFingerprint,scope.configurationHash,scope.provider,scope.model,
    scope.endpointIds,limit+1,historyId??null])).rows;
  const records=rows.slice(0,limit).map(row=>{
    if(!/^[1-9][0-9]{0,18}$/.test(row.history_id)||!idList(row.requested_endpoint_ids)
      ||row.requested_endpoint_ids.length<1||row.requested_endpoint_ids.some(id=>!scope.endpointIds.includes(id))
      ||!["semantic-grounding-1","semantic-discovery-1","semantic-discovery-source-1"].includes(row.prompt_version))
      throw new SemanticHistoryError();
    const result=validateStored(row.safe_result,row.requested_endpoint_ids);
    const promptVersion=row.prompt_version as SemanticProviderRequest["promptVersion"];
    if(Buffer.byteLength(canonicalJsonStringify(result),"utf8")>MAX_RESULT_BYTES
      ||recordHash(scope,promptVersion,row.requested_endpoint_ids,result)!==row.record_sha256)
      throw new SemanticHistoryError();
    const createdAt=row.created_at instanceof Date?row.created_at.toISOString():new Date(row.created_at).toISOString();
    return Object.freeze({historyId:row.history_id,createdAt,
      verification:"inferred" as const,review:"unreviewed" as const,normative:false as const,result,
      requestedEndpointIds:row.requested_endpoint_ids,
      provenance:{provider:scope.provider,model:scope.model,
        promptVersion,
        selector:scope.selection.selector,pin:scope.pin}});
  });
  return Object.freeze({status:"resolved",selector:scope.selection,pin:scope.pin,
    records:Object.freeze(records),truncated:rows.length>limit});
};
