import {isProxy} from "node:util/types";
import type {Pool, PoolClient} from "pg";
import {parseConfig} from "@api-truth/ir";
import {canonicalOrchestrationHash} from "@api-truth/orchestration";
import {quoteEnvironmentSchema} from "../../environment/src/migrations.js";
import {QueryReadError,readQueryContractWithClient} from "./reader.js";
import {parseQuerySelection} from "./selector.js";

const CAPABILITY="swagger.document.verify.read" as const;
const CAPTURE_PROFILE="protected-handler-bytes-1" as const;
const LOAD_PROFILE="swagger-loaded-document-1" as const;
const NAME=/^[A-Za-z0-9_.-]{1,128}$/;
const PRINCIPAL=/^[A-Za-z0-9_.:@-]{1,128}$/;
const REVISION=/^[A-Fa-f0-9]{12,128}$/;
const DIGEST=/^sha256:[a-f0-9]{64}$/;
const POSITIVE=/^[1-9][0-9]{0,18}$/;
const MAX_CONFIG_BYTES=1_000_000;
const SCOPE_KEYS=["tenantId","repositoryId","serviceId","immutableRevision","sourceDigest","environment"] as const;
const PIN_KEYS=["tenantId","repositoryId","serviceId","environment","snapshotId","revision","configFingerprint","checkpointVersion"] as const;
const BINDING_KEYS=["scope","serviceRoot","captureIdentityDigest","loadIdentityDigest"] as const;
const OPTIONS_KEYS=["schema","tenantId","bindings","authorizeManager","authorizeRead"] as const;
const REQUEST_KEYS=["loadIdentityDigest","expectedPin","configActivationCheckpoint"] as const;
const LIMITATIONS=Object.freeze([
  "This is a controlled signed-load observation associated with source bytes.",
  "This result does not assert deployment, runtime request handling, or normative API behavior.",
]);

export type LoadedDocumentReadScope=Readonly<{tenantId:string;repositoryId:string;serviceId:string;
  immutableRevision:string;sourceDigest:string;environment:string}>;
export type LoadedDocumentReadBinding=Readonly<{scope:LoadedDocumentReadScope;serviceRoot:string;
  captureIdentityDigest:string;loadIdentityDigest:string}>;
export type LoadedDocumentReadPrincipal=Readonly<{tenantId:string;principalId:string}>;
export type LoadedDocumentReadIdentity=Readonly<{tenantId:string;principalId:string;capabilities:readonly string[]}>;
export type LoadedDocumentReadAuthorization=Readonly<LoadedDocumentReadBinding & {principalId:string;
  configFingerprint:string;configDocumentSha256:string;configActivationCheckpoint:string;
  snapshotId:string;servingRevision:string;servingCheckpointVersion:string;sourceAccessLabel:string}>;
export type LoadedDocumentReadManager=(credential:unknown,binding:LoadedDocumentReadBinding,signal:AbortSignal)=>Promise<unknown>;
export type LoadedDocumentReadAuthorizer=(client:PoolClient,authorization:LoadedDocumentReadAuthorization)=>Promise<unknown>;
export type LoadedDocumentVerificationReadOptions=Readonly<{schema:string;tenantId:string;
  bindings:readonly LoadedDocumentReadBinding[];authorizeManager:LoadedDocumentReadManager;authorizeRead:LoadedDocumentReadAuthorizer}>;
export type LoadedDocumentVerificationReadRequest=Readonly<{loadIdentityDigest:string;expectedPin:Readonly<{
  tenantId:string;repositoryId:string;serviceId:string;environment:string;snapshotId:string;revision:string;
  configFingerprint:string;checkpointVersion:string}>;configActivationCheckpoint:string}>;
export type LoadedDocumentVerificationReadResult=Readonly<{status:"resolved";kind:"controlled_loaded_swagger_document_verification";
  nonNormative:true;pin:Readonly<{tenantId:string;repositoryId:string;serviceId:string;environment:string;
    snapshotId:string;revision:string;configFingerprint:string;checkpointVersion:string;sourceDigest:string;
    configActivationCheckpoint:string}>;
  verification:Readonly<{profileVersion:typeof LOAD_PROFILE;loadIdentityDigest:string;captureIdentityDigest:string;
    resultDigest:string;verifiedAt:string;handlerCount:number;matchCount:number;unobservedDiagnosticCount:number}>;
  document:Readonly<{path:"api/swagger/swagger.yaml";rawSha256:string;canonicalValueSha256:string;documentDigest:string}>;
  serviceRoot:string;limitations:readonly string[]}>;

export type LoadedDocumentVerificationReadErrorCode="INVALID_LOADED_DOCUMENT_READ_CONFIGURATION"
  |"INVALID_LOADED_DOCUMENT_READ_REQUEST"|"LOADED_DOCUMENT_READ_UNAUTHORIZED"|"LOADED_DOCUMENT_READ_STALE"
  |"LOADED_DOCUMENT_READ_UNAVAILABLE"|"LOADED_DOCUMENT_READ_STORAGE_ERROR";
const MESSAGES:Record<LoadedDocumentVerificationReadErrorCode,string>={
  INVALID_LOADED_DOCUMENT_READ_CONFIGURATION:"Invalid loaded-document read configuration",
  INVALID_LOADED_DOCUMENT_READ_REQUEST:"Invalid loaded-document read request",
  LOADED_DOCUMENT_READ_UNAUTHORIZED:"Loaded-document read denied",
  LOADED_DOCUMENT_READ_STALE:"Loaded-document selection is stale",
  LOADED_DOCUMENT_READ_UNAVAILABLE:"Loaded-document verification is unavailable",
  LOADED_DOCUMENT_READ_STORAGE_ERROR:"Loaded-document read storage error",
};
export class LoadedDocumentVerificationReadError extends Error{
  readonly code:LoadedDocumentVerificationReadErrorCode;
  constructor(code:LoadedDocumentVerificationReadErrorCode){super(MESSAGES[code]);this.name="LoadedDocumentVerificationReadError";this.code=code;}
}
const fail=(code:LoadedDocumentVerificationReadErrorCode):never=>{throw new LoadedDocumentVerificationReadError(code);};

function ownData(input:unknown,required:readonly string[],optional:readonly string[]=[]):Record<string,unknown>|undefined{
  try{
    if(!input||typeof input!=="object"||isProxy(input)||Array.isArray(input))return undefined;
    const proto=Object.getPrototypeOf(input);if(proto!==Object.prototype&&proto!==null)return undefined;
    const descriptors=Object.getOwnPropertyDescriptors(input),keys=Reflect.ownKeys(descriptors);
    if(required.some(key=>!Object.hasOwn(descriptors,key))||keys.some(key=>typeof key!=="string"
      ||!required.includes(key)&&!optional.includes(key)))return undefined;
    const out:Record<string,unknown>=Object.create(null);
    for(const key of [...required,...optional]){const d=descriptors[key];if(!d&&optional.includes(key))continue;
      if(!d||!Object.hasOwn(d,"value")||!d.enumerable)return undefined;out[key]=d.value;}
    return out;
  }catch{return undefined;}
}
function safeArray(input:unknown,max:number):unknown[]|undefined{
  try{
    if(!Array.isArray(input)||isProxy(input)||Object.getPrototypeOf(input)!==Array.prototype)return undefined;
    const length=Object.getOwnPropertyDescriptor(input,"length")?.value;
    if(!Number.isSafeInteger(length)||length<1||length>max)return undefined;
    const descriptors=Object.getOwnPropertyDescriptors(input);
    if(Reflect.ownKeys(descriptors).length!==length+1)return undefined;
    const out:unknown[]=[];for(let i=0;i<length;i++){const d=descriptors[String(i)];
      if(!d||!Object.hasOwn(d,"value")||!d.enumerable)return undefined;out.push(d.value);}return out;
  }catch{return undefined;}
}
const str=(input:unknown,pattern:RegExp):input is string=>typeof input==="string"&&pattern.test(input);
const safeAccessLabel=(input:unknown):input is string=>typeof input==="string"&&input.length>0&&input.length<=512
  &&!/^[\u0000-\u001f\u007f]|[\u0000-\u001f\u007f]$/.test(input)&&!/[\u0000-\u001f\u007f]/.test(input);
function safeScope(input:unknown):LoadedDocumentReadScope|undefined{
  const raw=ownData(input,SCOPE_KEYS);if(!raw||!str(raw.tenantId,NAME)||!str(raw.repositoryId,NAME)
    ||!str(raw.serviceId,NAME)||!str(raw.immutableRevision,REVISION)||!str(raw.sourceDigest,DIGEST)
    ||!str(raw.environment,NAME))return undefined;
  return Object.freeze({tenantId:raw.tenantId,repositoryId:raw.repositoryId,serviceId:raw.serviceId,
    immutableRevision:raw.immutableRevision,sourceDigest:raw.sourceDigest,environment:raw.environment});
}
function validRoot(value:unknown):value is string{return typeof value==="string"&&value.length<=1024
  &&/^(?:\.|[A-Za-z0-9_@+.-]+(?:\/[A-Za-z0-9_@+.-]+)*)$/.test(value)
  &&(value==="."||value.split("/").every(segment=>segment!=="."&&segment!==".."));}
function safeBinding(input:unknown,tenantId:string):LoadedDocumentReadBinding|undefined{
  const raw=ownData(input,BINDING_KEYS),scope=safeScope(raw?.scope);
  if(!raw||!scope||scope.tenantId!==tenantId||!validRoot(raw.serviceRoot)
    ||!str(raw.captureIdentityDigest,DIGEST)||!str(raw.loadIdentityDigest,DIGEST))return undefined;
  return Object.freeze({scope,serviceRoot:raw.serviceRoot,captureIdentityDigest:raw.captureIdentityDigest,
    loadIdentityDigest:raw.loadIdentityDigest});
}
function safePin(input:unknown,scope:LoadedDocumentReadScope):LoadedDocumentVerificationReadRequest["expectedPin"]|undefined{
  const raw=ownData(input,PIN_KEYS);if(!raw||raw.tenantId!==scope.tenantId||raw.repositoryId!==scope.repositoryId
    ||raw.serviceId!==scope.serviceId||raw.environment!==scope.environment||!str(raw.snapshotId,NAME)
    ||raw.revision!==scope.immutableRevision||!str(raw.configFingerprint,DIGEST)||!str(raw.checkpointVersion,POSITIVE)
    ||BigInt(raw.checkpointVersion)>9223372036854775807n)return undefined;
  return Object.freeze({tenantId:scope.tenantId,repositoryId:scope.repositoryId,serviceId:scope.serviceId,
    environment:scope.environment,snapshotId:raw.snapshotId,revision:scope.immutableRevision,
    configFingerprint:raw.configFingerprint,checkpointVersion:raw.checkpointVersion});
}
function safeRequest(input:unknown,bindings:ReadonlyMap<string,LoadedDocumentReadBinding>,tenantId:string){
  const raw=ownData(input,REQUEST_KEYS);if(!raw||!str(raw.loadIdentityDigest,DIGEST)||!str(raw.configActivationCheckpoint,POSITIVE)
    ||BigInt(raw.configActivationCheckpoint)>9223372036854775807n)return fail("INVALID_LOADED_DOCUMENT_READ_REQUEST");
  const binding=bindings.get(raw.loadIdentityDigest as string);
  if(!binding||binding.scope.tenantId!==tenantId)return fail("LOADED_DOCUMENT_READ_UNAUTHORIZED");
  const pin=safePin(raw.expectedPin,binding.scope);if(!pin)return fail("INVALID_LOADED_DOCUMENT_READ_REQUEST");
  return Object.freeze({binding,pin,configActivationCheckpoint:raw.configActivationCheckpoint as string});
}
function parsePrincipal(input:unknown):LoadedDocumentReadPrincipal|undefined{
  const raw=ownData(input,["tenantId","principalId"]);if(!raw||!str(raw.tenantId,NAME)||!str(raw.principalId,PRINCIPAL))return undefined;
  return Object.freeze({tenantId:raw.tenantId,principalId:raw.principalId});
}
function parseIdentity(input:unknown,tenantId:string):LoadedDocumentReadIdentity|undefined{
  const raw=ownData(input,["tenantId","principalId","capabilities"]),caps=safeArray(raw?.capabilities,32);
  if(!raw||raw.tenantId!==tenantId||!str(raw.principalId,PRINCIPAL)||!caps||caps.length===0
    ||caps.some(cap=>!str(cap,NAME))||new Set(caps).size!==caps.length||!caps.includes(CAPABILITY))return undefined;
  return Object.freeze({tenantId,principalId:raw.principalId,capabilities:Object.freeze(caps as string[])});
}
const deadline=async<T>(callback:(signal:AbortSignal)=>Promise<T>):Promise<T>=>{
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
  const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error("deadline"));},10_000);});
  try{return await Promise.race([Promise.resolve().then(()=>callback(controller.signal)),timeout]);}
  finally{if(timer!==undefined)clearTimeout(timer);}
};
type ActiveRow={config_fingerprint:string;config_version:string;document_sha256:string;checkpoint_version:string;document:unknown};
type CaptureRow={tenant_id:string;capture_identity_digest:string;repository_id:string;service_id:string;immutable_revision:string;
  source_digest:string;environment:string;policy_version:string};
type ByteRow={tenant_id:string;capture_identity_digest:string;verifier_profile_version:string;service_root:string;
  source_digest:string;result_digest:string;handler_count:number};
type SummaryRow={tenant_id:string;load_identity_digest:string;capture_identity_digest:string;parent_verifier_profile_version:string;
  verifier_profile_version:string;repository_id:string;service_id:string;immutable_revision:string;source_digest:string;
  environment:string;service_root:string;document_raw_sha256:string;document_canonical_value_sha256:string;
  document_digest:string;result_digest:string;handler_count:number;match_count:number;unobserved_diagnostic_count:number;verified_at:string};
type JobRow={tenant_id:string;job_id:string;load_identity_digest:string;capture_identity_digest:string;parent_verifier_profile_version:string;
  verifier_profile_version:string;repository_id:string;service_id:string;environment:string;immutable_revision:string;
  source_digest:string;service_root:string;config_fingerprint:string;config_document_sha256:string;
  config_checkpoint_version:string;state:string;attempt_count:number;verification_result_digest:string|null;
  verification_attempt_no:number|null;completed_at:string|null;result_digest:string|null;result_attempt_no:number|null;
  result_handler_count:number|null;result_match_count:number|null;result_unobserved_diagnostic_count:number|null;
  result_completed_at:string|null;session_id:string;document_raw_sha256:string;document_canonical_value_sha256:string;
  document_digest:string;verified_at:string;summary_result_digest:string;summary_handler_count:number;
  summary_match_count:number;summary_unobserved_diagnostic_count:number};
type JoinedRow={s_tenant_id:string;s_load_identity_digest:string;s_capture_identity_digest:string;s_parent_profile:string;
  s_profile:string;s_repository_id:string;s_service_id:string;s_immutable_revision:string;s_source_digest:string;s_environment:string;
  s_service_root:string;s_document_raw_sha256:string;s_document_canonical_value_sha256:string;s_document_digest:string;
  s_result_digest:string;s_handler_count:number;s_match_count:number;s_unobserved_diagnostic_count:number;s_verified_at:string;
  s_session_id:string;j_tenant_id:string;j_job_id:string;j_load_identity_digest:string;j_capture_identity_digest:string;
  j_parent_profile:string;j_profile:string;j_repository_id:string;j_service_id:string;j_environment:string;j_immutable_revision:string;
  j_source_digest:string;j_service_root:string;j_config_fingerprint:string;j_config_document_sha256:string;
  j_config_checkpoint_version:string;state_value:string;state_attempt_count:number;state_result_digest:string|null;
  state_attempt_no:number|null;state_completed_at:string|null;r_result_digest:string;r_attempt_no:number;r_handler_count:number;
  r_match_count:number;r_unobserved_count:number;r_completed_at:string;attempt_no:number};
const validTimestamp=(value:unknown):value is string=>typeof value==="string"
  &&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(value);
function asSafeCount(value:unknown):value is number{return Number.isSafeInteger(value)&&Number(value)>0&&Number(value)<=1024;}
function fixedResult(binding:LoadedDocumentReadBinding,pin:LoadedDocumentVerificationReadRequest["expectedPin"],
  configActivationCheckpoint:string,snapshotId:string,summary:SummaryRow,job:JobRow):LoadedDocumentVerificationReadResult|undefined{
  if(summary.verifier_profile_version!==LOAD_PROFILE||summary.parent_verifier_profile_version!==CAPTURE_PROFILE
    ||summary.tenant_id!==binding.scope.tenantId||summary.load_identity_digest!==binding.loadIdentityDigest
    ||summary.capture_identity_digest!==binding.captureIdentityDigest||summary.repository_id!==binding.scope.repositoryId
    ||summary.service_id!==binding.scope.serviceId||summary.environment!==binding.scope.environment
    ||summary.immutable_revision!==binding.scope.immutableRevision||summary.source_digest!==binding.scope.sourceDigest
    ||summary.service_root!==binding.serviceRoot||!DIGEST.test(summary.document_raw_sha256)
    ||!DIGEST.test(summary.document_canonical_value_sha256)||!DIGEST.test(summary.document_digest)
    ||!DIGEST.test(summary.result_digest)||!asSafeCount(summary.handler_count)||summary.match_count!==summary.handler_count
    ||!Number.isInteger(summary.unobserved_diagnostic_count)||summary.unobserved_diagnostic_count<0
    ||summary.match_count+summary.unobserved_diagnostic_count>1024||!validTimestamp(summary.verified_at))return undefined;
  if(job.tenant_id!==binding.scope.tenantId||job.load_identity_digest!==binding.loadIdentityDigest
    ||job.capture_identity_digest!==binding.captureIdentityDigest||job.parent_verifier_profile_version!==CAPTURE_PROFILE
    ||job.verifier_profile_version!==LOAD_PROFILE||job.repository_id!==binding.scope.repositoryId
    ||job.service_id!==binding.scope.serviceId||job.environment!==binding.scope.environment
    ||job.immutable_revision!==binding.scope.immutableRevision||job.source_digest!==binding.scope.sourceDigest
    ||job.service_root!==binding.serviceRoot||job.config_fingerprint!==pin.configFingerprint
    ||job.config_checkpoint_version!==configActivationCheckpoint||job.state!=="succeeded"
    ||!Number.isInteger(job.attempt_count)||job.attempt_count<1||job.attempt_count>3
    ||job.verification_attempt_no!==job.attempt_count||job.verification_result_digest!==summary.result_digest
    ||job.result_digest!==summary.result_digest||job.result_attempt_no!==job.attempt_count
    ||job.result_handler_count!==summary.handler_count||job.result_match_count!==summary.match_count
    ||job.result_unobserved_diagnostic_count!==summary.unobserved_diagnostic_count
    ||!validTimestamp(job.completed_at)||!validTimestamp(job.result_completed_at)
    ||job.completed_at!==job.result_completed_at
    ||job.summary_result_digest!==summary.result_digest||job.summary_handler_count!==summary.handler_count
    ||job.summary_match_count!==summary.match_count
    ||job.summary_unobserved_diagnostic_count!==summary.unobserved_diagnostic_count
    ||job.session_id.length<1||job.session_id.length>128||!NAME.test(job.session_id)
    ||job.document_raw_sha256!==summary.document_raw_sha256
    ||job.document_canonical_value_sha256!==summary.document_canonical_value_sha256
    ||job.document_digest!==summary.document_digest||job.verified_at!==summary.verified_at)return undefined;
  return Object.freeze({status:"resolved",kind:"controlled_loaded_swagger_document_verification",nonNormative:true,
    pin:Object.freeze({tenantId:binding.scope.tenantId,repositoryId:binding.scope.repositoryId,serviceId:binding.scope.serviceId,
      environment:binding.scope.environment,snapshotId,revision:binding.scope.immutableRevision,
      configFingerprint:pin.configFingerprint,checkpointVersion:pin.checkpointVersion,sourceDigest:binding.scope.sourceDigest,
      configActivationCheckpoint}),
    verification:Object.freeze({profileVersion:LOAD_PROFILE,loadIdentityDigest:binding.loadIdentityDigest,
      captureIdentityDigest:binding.captureIdentityDigest,resultDigest:summary.result_digest,verifiedAt:summary.verified_at,
      handlerCount:summary.handler_count,matchCount:summary.match_count,
      unobservedDiagnosticCount:summary.unobserved_diagnostic_count}),
    document:Object.freeze({path:"api/swagger/swagger.yaml",rawSha256:summary.document_raw_sha256,
      canonicalValueSha256:summary.document_canonical_value_sha256,documentDigest:summary.document_digest}),
    serviceRoot:binding.serviceRoot,limitations:LIMITATIONS});
}

/** Reads current authorized metadata only; this does not fetch the configured document or assert deployment. */
export function createLoadedDocumentVerificationReadStore(pool:Pool,optionsInput:LoadedDocumentVerificationReadOptions){
  const raw=ownData(optionsInput,OPTIONS_KEYS);let schemaSql:string;
  try{schemaSql=quoteEnvironmentSchema(raw?.schema as string);}catch{return fail("INVALID_LOADED_DOCUMENT_READ_CONFIGURATION");}
  const bindingsRaw=safeArray(raw?.bindings,128);
  if(!raw||!str(raw.tenantId,NAME)||!bindingsRaw||typeof raw.authorizeManager!=="function"||isProxy(raw.authorizeManager)
    ||typeof raw.authorizeRead!=="function"||isProxy(raw.authorizeRead))return fail("INVALID_LOADED_DOCUMENT_READ_CONFIGURATION");
  const fixedTenant=raw.tenantId;
  const bindings=bindingsRaw.map(item=>safeBinding(item,fixedTenant));
  if(bindings.some(item=>!item))return fail("INVALID_LOADED_DOCUMENT_READ_CONFIGURATION");
  const fixedBindings=bindings as LoadedDocumentReadBinding[],byIdentity=new Map(fixedBindings.map(item=>[item.loadIdentityDigest,item]));
  if(byIdentity.size!==fixedBindings.length)
    return fail("INVALID_LOADED_DOCUMENT_READ_CONFIGURATION");
  const authorizeManager=raw.authorizeManager as LoadedDocumentReadManager;
  const authorizeRead=raw.authorizeRead as LoadedDocumentReadAuthorizer;
  const authorize=async(credential:unknown,binding:LoadedDocumentReadBinding):Promise<LoadedDocumentReadIdentity>=>{
    let value:unknown;try{value=await deadline(signal=>authorizeManager(credential,binding,signal));}
    catch{return fail("LOADED_DOCUMENT_READ_UNAUTHORIZED");}
    const identity=parseIdentity(value,fixedTenant);if(!identity)return fail("LOADED_DOCUMENT_READ_UNAUTHORIZED");return identity;
  };
  const readForPrincipal=async(credential:unknown,principalInput:unknown,requestInput:unknown):Promise<LoadedDocumentVerificationReadResult>=>{
    const principal=parsePrincipal(principalInput);
    if(!principal||principal.tenantId!==fixedTenant)
      return fail("LOADED_DOCUMENT_READ_UNAUTHORIZED");
    const request=safeRequest(requestInput,byIdentity,fixedTenant),binding=request.binding;
    const identity=await authorize(credential,binding);
    if(identity.tenantId!==principal.tenantId||identity.principalId!==principal.principalId)
      return fail("LOADED_DOCUMENT_READ_UNAUTHORIZED");
    let client:PoolClient;try{client=await pool.connect();}catch{return fail("LOADED_DOCUMENT_READ_STORAGE_ERROR");}
    try{
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      await client.query(`SET LOCAL search_path TO ${schemaSql}, pg_catalog`);
      await client.query("SET LOCAL lock_timeout='2000ms'");await client.query("SET LOCAL statement_timeout='10000ms'");
      await client.query("SELECT pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtextextended($1,0))",
        [JSON.stringify(["api-truth:environment-serving",binding.scope.tenantId,binding.scope.repositoryId,
          binding.scope.serviceId,binding.scope.environment])]);
      const activeRows=await client.query<ActiveRow>(`SELECT active.config_fingerprint,configuration.document_sha256,
        configuration.config_version,active.checkpoint_version::text,CASE WHEN octet_length(configuration.document::text)<=$2
          THEN configuration.document ELSE NULL END AS document
        FROM orchestration_active_configurations active JOIN orchestration_configurations configuration
          ON configuration.tenant_id=active.tenant_id AND configuration.config_fingerprint=active.config_fingerprint
        WHERE active.tenant_id=$1 FOR SHARE OF active`,[fixedTenant,MAX_CONFIG_BYTES]);
      const active=activeRows.rows[0];if(activeRows.rows.length!==1||!active||!POSITIVE.test(active.checkpoint_version)
        ||active.checkpoint_version!==request.configActivationCheckpoint||active.config_fingerprint!==request.pin.configFingerprint)
        return fail("LOADED_DOCUMENT_READ_STALE");
      const parsed=parseConfig(active.document);
      if(!parsed.ok||parsed.value.config_version!==active.config_version
        ||canonicalOrchestrationHash(parsed.value)!==active.document_sha256)
        return fail("LOADED_DOCUMENT_READ_STORAGE_ERROR");
      const config=parsed.value;
      const repository=config.repositories.find(item=>item.repository_id===binding.scope.repositoryId);
      const service=repository?.services.find(item=>item.service_id===binding.scope.serviceId);
      const environment=service?.environments.find(item=>item.name===binding.scope.environment);
      if(!repository||!service||!environment||service.root!==binding.serviceRoot)
        return fail("LOADED_DOCUMENT_READ_UNAUTHORIZED");
      const selector=parseQuerySelection({version:"1",tenantId:fixedTenant,repositoryId:binding.scope.repositoryId,
        serviceId:binding.scope.serviceId,selector:{kind:"environment",environment:binding.scope.environment,
          expectedCheckpointVersion:request.pin.checkpointVersion}});
      const selected=await readQueryContractWithClient(client,{schema:raw.schema as string},
        {tenantId:fixedTenant,principalId:identity.principalId},selector);
      if(selected.status!=="resolved")return fail("LOADED_DOCUMENT_READ_UNAVAILABLE");
      if(selected.pin.selectedRevision!==undefined||selected.pin.pointerVersion!==undefined
        ||selected.pin.snapshotId!==request.pin.snapshotId||selected.pin.revision!==binding.scope.immutableRevision
        ||selected.pin.configFingerprint!==active.config_fingerprint
        ||selected.pin.checkpointVersion!==request.pin.checkpointVersion
        ||selected.snapshot.source.source_digest!==binding.scope.sourceDigest)
        return fail("LOADED_DOCUMENT_READ_STALE");
      const checkpointRows=await client.query<{version:string;reconciliation_required:boolean;source_access_label:string|null}>(
        `SELECT checkpoint.version::text,checkpoint.reconciliation_required,observation.source_access_label
         FROM environment_serving_checkpoints checkpoint LEFT JOIN environment_serving_observations observation
           ON observation.tenant_id=checkpoint.tenant_id AND observation.repository_id=checkpoint.repository_id
           AND observation.service_id=checkpoint.service_id AND observation.environment=checkpoint.environment
           AND observation.producer_id=checkpoint.current_producer_id AND observation.event_id=checkpoint.current_event_id
         WHERE checkpoint.tenant_id=$1 AND checkpoint.repository_id=$2 AND checkpoint.service_id=$3 AND checkpoint.environment=$4
         FOR SHARE OF checkpoint`,[fixedTenant,binding.scope.repositoryId,binding.scope.serviceId,binding.scope.environment]);
      const checkpoint=checkpointRows.rows[0];if(checkpointRows.rows.length!==1||!checkpoint
        ||checkpoint.reconciliation_required||checkpoint.version!==request.pin.checkpointVersion)
        return fail("LOADED_DOCUMENT_READ_STALE");
      const snapshotRows=await client.query<{required_scope_ids:string[]}>(`SELECT required_scope_ids FROM catalog_snapshots
        WHERE tenant_id=$1 AND repository_id=$2 AND service_id=$3 AND snapshot_id=$4 AND immutable_revision=$5
          AND config_fingerprint=$6 FOR SHARE`,[fixedTenant,binding.scope.repositoryId,binding.scope.serviceId,
        request.pin.snapshotId,binding.scope.immutableRevision,request.pin.configFingerprint]);
      const required=snapshotRows.rows[0]?.required_scope_ids;
      if(snapshotRows.rows.length!==1||!Array.isArray(required)||required.length<1||required.length>1024
        ||required.some(item=>!safeAccessLabel(item))||new Set(required).size!==required.length)
        return fail("LOADED_DOCUMENT_READ_STORAGE_ERROR");
      if(checkpoint.source_access_label!==null&&!safeAccessLabel(checkpoint.source_access_label))
        return fail("LOADED_DOCUMENT_READ_STORAGE_ERROR");
      const scopeIds=[...new Set([repository.access_scope_id,environment.deployment_authority.access_scope_id,
        ...required,...(checkpoint.source_access_label?[checkpoint.source_access_label]:[])])].sort((a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b)));
      if(scopeIds.length>1024||scopeIds.some(label=>!safeAccessLabel(label)))return fail("LOADED_DOCUMENT_READ_STORAGE_ERROR");
      const scopeRows=await client.query<{access_scope_id:string;active:boolean}>(`SELECT access_scope_id,active FROM access_scopes
        WHERE tenant_id=$1 AND access_scope_id=ANY($2::text[]) ORDER BY access_scope_id COLLATE "C" FOR SHARE`,[fixedTenant,scopeIds]);
      const grantRows=await client.query<{access_scope_id:string;active:boolean}>(`SELECT access_scope_id,active FROM principal_scope_grants
        WHERE tenant_id=$1 AND principal_id=$2 AND access_scope_id=ANY($3::text[])
        ORDER BY access_scope_id COLLATE "C" FOR SHARE`,[fixedTenant,identity.principalId,scopeIds]);
      if(scopeRows.rows.length!==scopeIds.length||grantRows.rows.length!==scopeIds.length
        ||scopeIds.some((id,index)=>scopeRows.rows[index]?.access_scope_id!==id||scopeRows.rows[index]?.active!==true
          ||grantRows.rows[index]?.access_scope_id!==id||grantRows.rows[index]?.active!==true))
        return fail("LOADED_DOCUMENT_READ_UNAUTHORIZED");
      const authorization:LoadedDocumentReadAuthorization=Object.freeze({...binding,principalId:identity.principalId,
        configFingerprint:active.config_fingerprint,configDocumentSha256:active.document_sha256,
        configActivationCheckpoint:active.checkpoint_version,snapshotId:request.pin.snapshotId,
        servingRevision:selected.pin.revision,servingCheckpointVersion:selected.pin.checkpointVersion!,
        sourceAccessLabel:checkpoint.source_access_label??""});
      let allowed=false;try{allowed=await authorizeRead(client,authorization)===true;}catch{return fail("LOADED_DOCUMENT_READ_UNAUTHORIZED");}
      if(!allowed)return fail("LOADED_DOCUMENT_READ_UNAUTHORIZED");
      const captures=await client.query<CaptureRow>(`SELECT tenant_id,capture_identity_digest,repository_id,service_id,
        immutable_revision,source_digest,environment,policy_version FROM orchestration_observed_capture_associations
        WHERE tenant_id=$1 AND capture_identity_digest=$2 FOR SHARE`,[fixedTenant,binding.captureIdentityDigest]);
      const capture=captures.rows[0];if(captures.rows.length!==1||!capture||capture.repository_id!==binding.scope.repositoryId
        ||capture.service_id!==binding.scope.serviceId||capture.immutable_revision!==binding.scope.immutableRevision
        ||capture.source_digest!==binding.scope.sourceDigest||capture.environment!==binding.scope.environment
        ||capture.policy_version!=="runtime-capture-pin-1")return fail("LOADED_DOCUMENT_READ_UNAVAILABLE");
      const bytes=await client.query<ByteRow>(`SELECT tenant_id,capture_identity_digest,verifier_profile_version,
        service_root,source_digest,result_digest,handler_count FROM orchestration_observed_capture_verifications
        WHERE tenant_id=$1 AND capture_identity_digest=$2 AND verifier_profile_version=$3 FOR SHARE`,
      [fixedTenant,binding.captureIdentityDigest,CAPTURE_PROFILE]);
      const byteParent=bytes.rows[0];if(bytes.rows.length!==1||!byteParent||byteParent.service_root!==binding.serviceRoot
        ||byteParent.source_digest!==binding.scope.sourceDigest||!DIGEST.test(byteParent.result_digest)||!asSafeCount(byteParent.handler_count))
        return fail("LOADED_DOCUMENT_READ_UNAVAILABLE");
      const rows=await client.query<JoinedRow>(`SELECT
        summary.tenant_id AS s_tenant_id,summary.load_identity_digest AS s_load_identity_digest,
        summary.capture_identity_digest AS s_capture_identity_digest,summary.parent_verifier_profile_version AS s_parent_profile,
        summary.verifier_profile_version AS s_profile,summary.repository_id AS s_repository_id,summary.service_id AS s_service_id,
        summary.immutable_revision AS s_immutable_revision,summary.source_digest AS s_source_digest,
        summary.environment AS s_environment,summary.service_root AS s_service_root,
        summary.document_raw_sha256 AS s_document_raw_sha256,
        summary.document_canonical_value_sha256 AS s_document_canonical_value_sha256,
        summary.document_digest AS s_document_digest,summary.result_digest AS s_result_digest,
        summary.handler_count AS s_handler_count,summary.match_count AS s_match_count,
        summary.unobserved_diagnostic_count AS s_unobserved_diagnostic_count,
        to_char(summary.verified_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS s_verified_at,
        summary.session_id AS s_session_id,
        job.tenant_id AS j_tenant_id,job.job_id AS j_job_id,job.load_identity_digest AS j_load_identity_digest,
        job.capture_identity_digest AS j_capture_identity_digest,job.parent_verifier_profile_version AS j_parent_profile,
        job.verifier_profile_version AS j_profile,job.repository_id AS j_repository_id,job.service_id AS j_service_id,
        job.environment AS j_environment,job.immutable_revision AS j_immutable_revision,job.source_digest AS j_source_digest,
        job.service_root AS j_service_root,job.config_fingerprint AS j_config_fingerprint,
        job.config_document_sha256 AS j_config_document_sha256,job.config_checkpoint_version::text AS j_config_checkpoint_version,
        state.state AS state_value,state.attempt_count AS state_attempt_count,
        state.verification_result_digest AS state_result_digest,state.verification_attempt_no AS state_attempt_no,
        to_char(state.completed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS state_completed_at,
        result.result_digest AS r_result_digest,result.attempt_no AS r_attempt_no,
        result.handler_count AS r_handler_count,result.match_count AS r_match_count,
        result.unobserved_diagnostic_count AS r_unobserved_count,
        to_char(result.completed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS r_completed_at,
        attempt.attempt_no AS attempt_no
        FROM orchestration_observed_loaded_document_verifications summary
        JOIN orchestration_loaded_document_verification_jobs job ON job.tenant_id=summary.tenant_id
          AND job.load_identity_digest=summary.load_identity_digest AND job.capture_identity_digest=summary.capture_identity_digest
        JOIN orchestration_loaded_document_verification_job_state state ON state.tenant_id=job.tenant_id AND state.job_id=job.job_id
        JOIN orchestration_loaded_document_verification_results result ON result.tenant_id=job.tenant_id AND result.job_id=job.job_id
        JOIN orchestration_loaded_document_verification_lease_attempts attempt ON attempt.tenant_id=job.tenant_id
          AND attempt.job_id=job.job_id AND attempt.attempt_no=result.attempt_no
        WHERE summary.tenant_id=$1 AND summary.load_identity_digest=$2 AND summary.capture_identity_digest=$3
          AND summary.verifier_profile_version=$4 AND job.config_fingerprint=$5 AND job.config_document_sha256=$6
          AND job.config_checkpoint_version=$7::bigint AND state.state='succeeded'
        FOR SHARE OF summary,job,state,result,attempt`,
      [fixedTenant,binding.loadIdentityDigest,binding.captureIdentityDigest,LOAD_PROFILE,active.config_fingerprint,
        active.document_sha256,active.checkpoint_version]);
      if(rows.rows.length!==1)return fail("LOADED_DOCUMENT_READ_UNAVAILABLE");
      const rawRow=rows.rows[0]!;
      const summary:SummaryRow={tenant_id:rawRow.s_tenant_id,load_identity_digest:rawRow.s_load_identity_digest,
        capture_identity_digest:rawRow.s_capture_identity_digest,parent_verifier_profile_version:rawRow.s_parent_profile,
        verifier_profile_version:rawRow.s_profile,repository_id:rawRow.s_repository_id,service_id:rawRow.s_service_id,
        immutable_revision:rawRow.s_immutable_revision,source_digest:rawRow.s_source_digest,environment:rawRow.s_environment,
        service_root:rawRow.s_service_root,document_raw_sha256:rawRow.s_document_raw_sha256,
        document_canonical_value_sha256:rawRow.s_document_canonical_value_sha256,document_digest:rawRow.s_document_digest,
        result_digest:rawRow.s_result_digest,handler_count:rawRow.s_handler_count,match_count:rawRow.s_match_count,
        unobserved_diagnostic_count:rawRow.s_unobserved_diagnostic_count,verified_at:rawRow.s_verified_at};
      const job:JobRow={tenant_id:rawRow.j_tenant_id,job_id:rawRow.j_job_id,load_identity_digest:rawRow.j_load_identity_digest,
        capture_identity_digest:rawRow.j_capture_identity_digest,parent_verifier_profile_version:rawRow.j_parent_profile,
        verifier_profile_version:rawRow.j_profile,repository_id:rawRow.j_repository_id,service_id:rawRow.j_service_id,
        environment:rawRow.j_environment,immutable_revision:rawRow.j_immutable_revision,source_digest:rawRow.j_source_digest,
        service_root:rawRow.j_service_root,config_fingerprint:rawRow.j_config_fingerprint,
        config_document_sha256:rawRow.j_config_document_sha256,config_checkpoint_version:rawRow.j_config_checkpoint_version,
        state:rawRow.state_value,attempt_count:rawRow.state_attempt_count,verification_result_digest:rawRow.state_result_digest,
        verification_attempt_no:rawRow.state_attempt_no,completed_at:rawRow.state_completed_at,result_digest:rawRow.r_result_digest,
        result_attempt_no:rawRow.r_attempt_no,result_handler_count:rawRow.r_handler_count,result_match_count:rawRow.r_match_count,
        result_unobserved_diagnostic_count:rawRow.r_unobserved_count,result_completed_at:rawRow.r_completed_at,
        session_id:rawRow.s_session_id,document_raw_sha256:rawRow.s_document_raw_sha256,
        document_canonical_value_sha256:rawRow.s_document_canonical_value_sha256,document_digest:rawRow.s_document_digest,
        verified_at:rawRow.s_verified_at,summary_result_digest:rawRow.s_result_digest,summary_handler_count:rawRow.s_handler_count,
        summary_match_count:rawRow.s_match_count,summary_unobserved_diagnostic_count:rawRow.s_unobserved_diagnostic_count};
      if(rawRow.attempt_no!==job.attempt_count||byteParent.handler_count!==summary.handler_count)
        return fail("LOADED_DOCUMENT_READ_UNAVAILABLE");
      const final=fixedResult(binding,request.pin,request.configActivationCheckpoint,selected.pin.snapshotId,summary,job);
      if(!final)return fail("LOADED_DOCUMENT_READ_UNAVAILABLE");
      await client.query("COMMIT");return final;
    }catch(error){
      await client.query("ROLLBACK").catch(()=>undefined);
      if(!isProxy(error)&&error instanceof LoadedDocumentVerificationReadError)throw error;
      if(!isProxy(error)&&error instanceof QueryReadError){
        if(error.code==="QUERY_NOT_FOUND_OR_DENIED")return fail("LOADED_DOCUMENT_READ_UNAUTHORIZED");
        if(error.code==="QUERY_STALE_SELECTION")return fail("LOADED_DOCUMENT_READ_STALE");
      }
      return fail("LOADED_DOCUMENT_READ_STORAGE_ERROR");
    }finally{client.release();}
  };
  return Object.freeze({readForPrincipal});
}
