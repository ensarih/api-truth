import {createHash} from "node:crypto";
import {types} from "node:util";
import type {PoolClient} from "pg";
import {canonicalJsonStringify} from "../../ir/src/index.js";
import type {SemanticHistoryRecord,SemanticHistoryScope} from "./history.js";

const MAX_BIGINT=9223372036854775807n;
export type SemanticHistoryReviewDecision="acknowledged"|"follow_up"|"dismissed";
/** INVALID is inert input rejection; CONFLICT is stale/changed intent; STORAGE includes corruption. */
export type SemanticHistoryReviewErrorCode="SEMANTIC_HISTORY_REVIEW_INVALID"
  |"SEMANTIC_HISTORY_REVIEW_CONFLICT"|"SEMANTIC_HISTORY_REVIEW_STORAGE";
const reviewErrors=new WeakSet<object>();
const reviewErrorCodes:readonly SemanticHistoryReviewErrorCode[]=["SEMANTIC_HISTORY_REVIEW_INVALID",
  "SEMANTIC_HISTORY_REVIEW_CONFLICT","SEMANTIC_HISTORY_REVIEW_STORAGE"];
export class SemanticHistoryReviewError extends Error {
  constructor(readonly code:SemanticHistoryReviewErrorCode){
    super(code);this.name="SemanticHistoryReviewError";reviewErrors.add(this);
  }
}
const fail=(kind:"INVALID"|"CONFLICT"|"STORAGE"):never=>{
  throw new SemanticHistoryReviewError(`SEMANTIC_HISTORY_REVIEW_${kind}`);
};
/** Never traverse an arbitrary rejection's prototype or read an accessor-backed error code. */
const normalizeError=(error:unknown,fallback:SemanticHistoryReviewErrorCode):SemanticHistoryReviewError=>{
  if(error!==null&&typeof error==="object"&&!types.isProxy(error)&&reviewErrors.has(error)){
    const descriptor=Object.getOwnPropertyDescriptor(error,"code");
    if(descriptor&&"value" in descriptor&&reviewErrorCodes.includes(descriptor.value))
      return new SemanticHistoryReviewError(descriptor.value);
  }
  return new SemanticHistoryReviewError(fallback);
};
const bigintString=(value:unknown,positive:boolean,max=MAX_BIGINT):value is string=>typeof value==="string"
  &&(positive?/^[1-9][0-9]{0,18}$/:/^(0|[1-9][0-9]{0,18})$/).test(value)&&BigInt(value)<=max;
const decision=(value:unknown):value is SemanticHistoryReviewDecision=>value==="acknowledged"
  ||value==="follow_up"||value==="dismissed";
export type SemanticHistoryReviewRequest=Readonly<{historyId:string;decision:SemanticHistoryReviewDecision;expectedVersion:string}>;
export type SemanticHistoryReviewRecord=Readonly<{historyId:string;reviewVersion:string;expectedVersion:string;
  decision:SemanticHistoryReviewDecision;createdAt:string;metadataOnly:true;nonNormative:true;verification:"inferred"}>;
export type SemanticHistoryReviewReceipt=Readonly<SemanticHistoryReviewRecord&{replayed:boolean}>;
export type SemanticHistoryReviewReadResult=Readonly<{historyId:string;records:readonly SemanticHistoryReviewRecord[];
  truncated:boolean;metadataOnly:true;nonNormative:true;verification:"inferred"}>;
const disclaimers={metadataOnly:true,nonNormative:true,verification:"inferred"} as const;

/** Inspects only own data descriptors; rejects proxies without invoking any trap or getter. */
export const parseSemanticHistoryReview=(input:unknown):SemanticHistoryReviewRequest=>{
  try{
    if(!input||typeof input!=="object"||types.isProxy(input)||Array.isArray(input))return fail("INVALID");
    const prototype=Object.getPrototypeOf(input);
    if(prototype!==Object.prototype&&prototype!==null)return fail("INVALID");
    const keys=Reflect.ownKeys(input);
    if(keys.length!==3||keys.some(key=>typeof key!=="string"||!["historyId","decision","expectedVersion"].includes(key)))
      return fail("INVALID");
    const descriptors=Object.getOwnPropertyDescriptors(input);
    for(const key of ["historyId","decision","expectedVersion"]){
      const descriptor=descriptors[key];
      if(!descriptor||!("value" in descriptor)||!descriptor.enumerable)return fail("INVALID");
    }
    const historyId=descriptors.historyId!.value,selectedDecision=descriptors.decision!.value,
      expectedVersion=descriptors.expectedVersion!.value;
    // Leave room for expectedVersion+1 in PostgreSQL's signed bigint review_version.
    if(!bigintString(historyId,true)||!bigintString(expectedVersion,false,MAX_BIGINT-1n)||!decision(selectedDecision))
      return fail("INVALID");
    return Object.freeze({historyId,decision:selectedDecision,expectedVersion});
  }catch(error){throw normalizeError(error,"SEMANTIC_HISTORY_REVIEW_INVALID");}
};

const validateHistory=(scope:SemanticHistoryScope,history:SemanticHistoryRecord)=>{
  if(!bigintString(history.historyId,true)||history.verification!=="inferred"||history.normative!==false
    ||history.provenance.provider!==scope.provider||history.provenance.model!==scope.model
    ||canonicalJsonStringify(history.provenance.pin)!==canonicalJsonStringify(scope.pin)
    ||canonicalJsonStringify(history.provenance.selector)!==canonicalJsonStringify(scope.selection.selector)
    ||!Array.isArray(history.requestedEndpointIds)||history.requestedEndpointIds.length<1
    ||history.requestedEndpointIds.length>16||new Set(history.requestedEndpointIds).size!==history.requestedEndpointIds.length
    ||history.requestedEndpointIds.some(id=>!scope.endpointIds.includes(id)))fail("STORAGE");
};
/** Binds the private source record as well as the annotation; no free-form text is persisted. */
const digest=(scope:SemanticHistoryScope,history:SemanticHistoryRecord,version:string,expectedVersion:string,
  selectedDecision:SemanticHistoryReviewDecision)=>`sha256:${createHash("sha256").update(canonicalJsonStringify({
    tenantId:scope.tenantId,principalId:scope.principalId,historyId:history.historyId,
    repositoryId:scope.selection.repositoryId,serviceId:scope.selection.serviceId,
    selector:scope.selection.selector,pin:scope.pin,configurationHash:scope.configurationHash,
    provider:scope.provider,model:scope.model,promptVersion:history.provenance.promptVersion,
    requestedEndpointIds:[...history.requestedEndpointIds].sort(),safeResult:history.result,
    decision:selectedDecision,reviewVersion:version,expectedVersion})).digest("hex")}`;

type ReviewRow={review_version:string;expected_version:string;decision:string;record_sha256:string;created_at:string};
const projection=`review_version::text,expected_version::text,decision,record_sha256,
  to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at`;
const verify=(row:ReviewRow,scope:SemanticHistoryScope,history:SemanticHistoryRecord):SemanticHistoryReviewRecord=>{
  if(!bigintString(row.review_version,true)||!bigintString(row.expected_version,false,MAX_BIGINT-1n)
    ||BigInt(row.review_version)!==BigInt(row.expected_version)+1n||!decision(row.decision)
    ||typeof row.created_at!=="string"||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(row.created_at)
    ||digest(scope,history,row.review_version,row.expected_version,row.decision)!==row.record_sha256)fail("STORAGE");
  return Object.freeze({historyId:history.historyId,reviewVersion:row.review_version,
    expectedVersion:row.expected_version,decision:row.decision as SemanticHistoryReviewDecision,
    createdAt:row.created_at,...disclaimers});
};

/** Caller must already hold read and owner authorization for this exact private source in this transaction. */
export const recordSemanticHistoryReview=async(client:PoolClient,scope:SemanticHistoryScope,
  validatedHistory:SemanticHistoryRecord,request:SemanticHistoryReviewRequest):Promise<SemanticHistoryReviewReceipt>=>{
  try{
    const parsed=parseSemanticHistoryReview(request);
    if(parsed.historyId!==validatedHistory.historyId)fail("INVALID");
    validateHistory(scope,validatedHistory);
    const identity=[scope.tenantId,scope.principalId,validatedHistory.historyId];
    await client.query("SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1,0))",
      [`api-truth:semantic-history-review:${canonicalJsonStringify(identity)}`]);
    const previous=(await client.query<ReviewRow>(`SELECT ${projection} FROM semantic_history_reviews
      WHERE tenant_id=$1 AND principal_id=$2 AND history_id=$3::bigint AND expected_version=$4::bigint`,
    [...identity,parsed.expectedVersion])).rows;
    if(previous.length>1)fail("STORAGE");
    if(previous[0]){
      const prior=verify(previous[0],scope,validatedHistory);
      if(prior.decision!==parsed.decision)fail("CONFLICT");
      return Object.freeze({...prior,replayed:true});
    }
    const latest=(await client.query<ReviewRow>(`SELECT ${projection} FROM semantic_history_reviews
      WHERE tenant_id=$1 AND principal_id=$2 AND history_id=$3::bigint ORDER BY review_version DESC LIMIT 1`,identity)).rows;
    const current=latest[0]?verify(latest[0],scope,validatedHistory).reviewVersion:"0";
    if(current!==parsed.expectedVersion)fail("CONFLICT");
    const version=(BigInt(current)+1n).toString();
    const inserted=(await client.query<ReviewRow>(`INSERT INTO semantic_history_reviews
      (tenant_id,principal_id,history_id,review_version,expected_version,decision,record_sha256)
      VALUES($1,$2,$3::bigint,$4::bigint,$5::bigint,$6,$7) RETURNING ${projection}`,
    [...identity,version,parsed.expectedVersion,parsed.decision,
      digest(scope,validatedHistory,version,parsed.expectedVersion,parsed.decision)])).rows;
    if(inserted.length!==1||!inserted[0])fail("STORAGE");
    const receipt=verify(inserted[0]!,scope,validatedHistory);
    if(receipt.reviewVersion!==version||receipt.decision!==parsed.decision)fail("STORAGE");
    return Object.freeze({...receipt,replayed:false});
  }catch(error){throw normalizeError(error,"SEMANTIC_HISTORY_REVIEW_STORAGE");}
};

export const readSemanticHistoryReviews=async(client:PoolClient,scope:SemanticHistoryScope,
  validatedHistory:SemanticHistoryRecord,limit:number):Promise<SemanticHistoryReviewReadResult>=>{
  try{
    if(!Number.isInteger(limit)||limit<1||limit>20)fail("INVALID");
    validateHistory(scope,validatedHistory);
    const rows=(await client.query<ReviewRow>(`SELECT ${projection} FROM semantic_history_reviews
      WHERE tenant_id=$1 AND principal_id=$2 AND history_id=$3::bigint ORDER BY review_version DESC LIMIT $4`,
    [scope.tenantId,scope.principalId,validatedHistory.historyId,limit+1])).rows;
    // Validate the extra row too, so truncation never hides a corrupt selected record.
    const records=rows.map(row=>verify(row,scope,validatedHistory));
    for(let i=1;i<records.length;i++)if(BigInt(records[i-1]!.reviewVersion)!==BigInt(records[i]!.reviewVersion)+1n)fail("STORAGE");
    return Object.freeze({historyId:validatedHistory.historyId,records:Object.freeze(records.slice(0,limit)),
      truncated:rows.length>limit,...disclaimers});
  }catch(error){throw normalizeError(error,"SEMANTIC_HISTORY_REVIEW_STORAGE");}
};
