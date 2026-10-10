import {isProxy} from "node:util/types";
import type {Pool,PoolClient} from "pg";
import {quoteEnvironmentSchema} from "../../environment/src/migrations.js";
import {projectObservedFieldPresence} from "./field-presence.js";
import {buildFieldPresenceStorageProposal,compileFieldPresenceStoragePolicy,type FieldPresenceStoragePolicy}
  from "./field-presence-storage-policy.js";
import {ObservationImportError,withAuthorizedObservationPin,type ExpectedObservationPin} from "./store.js";

export type FieldPresenceImportBinding=Readonly<{tenantId:string;repositoryId:string;serviceId:string;environment:string;
  policyId:string;ownerAccessScopeId:string;importAccessScopeId:string}>;
export type FieldPresenceImportManager=(credential:unknown,binding:FieldPresenceImportBinding,signal:AbortSignal)=>Promise<unknown>;
export type FieldPresenceImportReadRequest=Readonly<{binding:FieldPresenceImportBinding;importId:string;recordId:string;
  expectedPin:ExpectedObservationPin;selector:Readonly<{endpointId:string;direction:"request"|"response";mediaType:string;statusCode?:number}>;
  source:Readonly<{sourceId:string;sourceVersion:string;windowStart:string;windowEnd:string}>}>;
export type FieldPresenceImportReadPort=(identity:Readonly<{tenantId:string;principalId:string;capabilities:readonly string[]}>,
  request:FieldPresenceImportReadRequest,signal:AbortSignal)=>Promise<unknown>;
export type FieldPresenceImportStoreOptions=Readonly<{schema:string;bindings:readonly FieldPresenceImportBinding[];
  authorizeManager:FieldPresenceImportManager;readObservation:FieldPresenceImportReadPort}>;
export type FieldPresenceImportErrorCode="FIELD_PRESENCE_IMPORT_INVALID_CONFIGURATION"|"FIELD_PRESENCE_IMPORT_INVALID_REQUEST"
  |"FIELD_PRESENCE_IMPORT_UNAUTHORIZED"|"FIELD_PRESENCE_IMPORT_STALE"|"FIELD_PRESENCE_IMPORT_PARENT_INVALID"
  |"FIELD_PRESENCE_IMPORT_POLICY_UNSUPPORTED"|"FIELD_PRESENCE_IMPORT_SOURCE_INVALID"|"FIELD_PRESENCE_IMPORT_PAYLOAD_INVALID"
  |"FIELD_PRESENCE_IMPORT_CONFLICT"|"FIELD_PRESENCE_IMPORT_STORAGE_ERROR";
export class FieldPresenceImportStoreError extends Error{
  readonly code:FieldPresenceImportErrorCode;
  constructor(code:FieldPresenceImportErrorCode){super(code);this.name="FieldPresenceImportStoreError";this.code=code;}
}
const fail=(code:FieldPresenceImportErrorCode):never=>{throw new FieldPresenceImportStoreError(code);};
const plain=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==="object"&&!isProxy(value)
  &&!Array.isArray(value)&&(Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null);
const fields=(input:unknown,keys:readonly string[]):Record<string,unknown>|undefined=>{
  try{if(!plain(input))return undefined;const own=Reflect.ownKeys(input);
    if(own.length!==keys.length||own.some(key=>typeof key!=="string"||!keys.includes(key)))return undefined;
    const output:Record<string,unknown>={};for(const key of keys){const descriptor=Object.getOwnPropertyDescriptor(input,key);
      if(!descriptor||!descriptor.enumerable||!("value" in descriptor))return undefined;
      Object.defineProperty(output,key,{value:descriptor.value,enumerable:true,writable:true,configurable:true});}return output;
  }catch{return undefined;}
};
const arrayValues=(input:unknown,max:number):unknown[]|undefined=>{
  try{if(isProxy(input)||!Array.isArray(input)||Object.getPrototypeOf(input)!==Array.prototype||input.length>max
      ||Reflect.ownKeys(input).length!==input.length+1)return undefined;
    const result:unknown[]=[];for(let i=0;i<input.length;i++){const descriptor=Object.getOwnPropertyDescriptor(input,String(i));
      if(!descriptor||!descriptor.enumerable||!("value" in descriptor))return undefined;result.push(descriptor.value);}return result;
  }catch{return undefined;}
};
const identifier=(value:unknown):value is string=>typeof value==="string"&&value.length>0&&value.length<=128
  &&/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const positiveRevision=(value:unknown):value is string=>typeof value==="string"&&/^[1-9][0-9]{0,18}$/.test(value)
  &&BigInt(value)<=9223372036854775807n;
const bindingKeys=["tenantId","repositoryId","serviceId","environment","policyId","ownerAccessScopeId","importAccessScopeId"] as const;
const bindingValue=(input:unknown):FieldPresenceImportBinding|undefined=>{
  const raw=fields(input,bindingKeys);if(!raw||!bindingKeys.every(key=>identifier(raw[key])))return undefined;
  return Object.freeze(Object.fromEntries(bindingKeys.map(key=>[key,raw[key]]))) as unknown as FieldPresenceImportBinding;
};
const bindingKey=(value:Pick<FieldPresenceImportBinding,"tenantId"|"repositoryId"|"serviceId"|"environment"|"policyId">)=>
  JSON.stringify([value.tenantId,value.repositoryId,value.serviceId,value.environment,value.policyId]);
const withDeadline=async<T>(callback:(signal:AbortSignal)=>Promise<T>):Promise<T>=>{
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
  const timeout=Symbol("field_presence_import_timeout");
  const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(timeout);},10_000);});
  try{return await Promise.race([Promise.resolve().then(()=>callback(controller.signal)),deadline]);}
  finally{if(timer!==undefined)clearTimeout(timer);}
};
type ImportIdentity=Readonly<{tenantId:string;principalId:string;capabilities:readonly string[]}>;
const parseIdentity=(input:unknown,tenantId:string):ImportIdentity|undefined=>{
  const raw=fields(input,["tenantId","principalId","capabilities"]),capabilities=arrayValues(raw?.capabilities,16);
  if(!raw||raw.tenantId!==tenantId||!identifier(raw.principalId)||!capabilities||capabilities.length===0
    ||!capabilities.includes("observations.presence.import")||capabilities.some(value=>!identifier(value))
    ||new Set(capabilities).size!==capabilities.length)return undefined;
  return Object.freeze({tenantId,principalId:raw.principalId as string,capabilities:Object.freeze(capabilities as string[])});
};
type Request=Readonly<{binding:FieldPresenceImportBinding;ownerPolicyRevision:string;importId:string;recordId:string;
  expectedPin:ExpectedObservationPin}>;
const parseRequest=(input:unknown,bindings:ReadonlyMap<string,FieldPresenceImportBinding>):Request=>{
  const raw=fields(input,["policyId","ownerPolicyRevision","importId","recordId","expectedPin"]);
  if(!raw||!identifier(raw.policyId)||!positiveRevision(raw.ownerPolicyRevision)||typeof raw.importId!=="string"||!uuid.test(raw.importId)
    ||typeof raw.recordId!=="string"||!uuid.test(raw.recordId))return fail("FIELD_PRESENCE_IMPORT_INVALID_REQUEST");
  const scope=fields(raw.expectedPin,["tenantId","repositoryId","serviceId","environment","snapshotId","revision","configFingerprint","checkpointVersion"]);
  if(!scope||![scope.tenantId,scope.repositoryId,scope.serviceId,scope.environment,scope.snapshotId,scope.revision].every(identifier)
    ||typeof scope.configFingerprint!=="string"
    ||!/^sha256:[0-9a-f]{64}$/.test(scope.configFingerprint)||!positiveRevision(scope.checkpointVersion))
    return fail("FIELD_PRESENCE_IMPORT_INVALID_REQUEST");
  const binding=bindings.get(bindingKey({tenantId:scope.tenantId as string,repositoryId:scope.repositoryId as string,
    serviceId:scope.serviceId as string,environment:scope.environment as string,policyId:raw.policyId as string}));
  if(!binding)return fail("FIELD_PRESENCE_IMPORT_UNAUTHORIZED");
  const expectedPin=Object.freeze({tenantId:binding.tenantId,repositoryId:binding.repositoryId,serviceId:binding.serviceId,
    environment:binding.environment,snapshotId:scope.snapshotId as string,revision:scope.revision as string,
    configFingerprint:scope.configFingerprint as string,checkpointVersion:scope.checkpointVersion as string});
  return Object.freeze({binding,ownerPolicyRevision:raw.ownerPolicyRevision as string,importId:raw.importId,
    recordId:raw.recordId,expectedPin});
};
type PolicyRow={owner_policy_revision:string;policy_fingerprint:string;config_fingerprint:string;config_activation_checkpoint:string;
  endpoint_id:string;direction:"request"|"response";media_type:string;status_code:number|null;property_paths:string[];
  ttl_seconds:number;max_live_records:number;owner_access_scope_id:string};
type Parent=Readonly<{sourceId:string;sourceVersion:string;windowStart:string;windowEnd:string;importedAt:string;
  sourceDigest:string;policyFingerprint:string;policy:FieldPresenceStoragePolicy;mappingId:string;method:string;statusCode?:number}>;
const policyFromRow=(row:PolicyRow,binding:FieldPresenceImportBinding):ReturnType<typeof compileFieldPresenceStoragePolicy>=>{
  const value={version:"field-presence-storage-1" as const,policyId:binding.policyId,ownerPolicyRevision:row.owner_policy_revision,optIn:true as const,
    tenantId:binding.tenantId,repositoryId:binding.repositoryId,serviceId:binding.serviceId,environment:binding.environment,
    configFingerprint:row.config_fingerprint,configActivationCheckpoint:row.config_activation_checkpoint,endpointId:row.endpoint_id,
    direction:row.direction,mediaType:row.media_type,propertyPaths:row.property_paths,
    ...(row.status_code===null?{}:{statusCode:row.status_code}),ttlSeconds:row.ttl_seconds,maxLiveRecords:row.max_live_records};
  return compileFieldPresenceStoragePolicy(value);
};
const iso=(value:unknown):string|undefined=>value instanceof Date&&Number.isFinite(value.getTime())?value.toISOString():undefined;
const loadState=async(client:PoolClient,binding:FieldPresenceImportBinding,revision:string,importId:string,recordId:string,
  pin:ExpectedObservationPin,snapshotSourceDigest:string,logAdapterId:string):Promise<Parent>=>{
  const policyResult=await client.query<PolicyRow>(`SELECT revision.owner_policy_revision::text,revision.policy_fingerprint,
    revision.config_fingerprint,revision.config_activation_checkpoint::text,revision.endpoint_id,revision.direction,
    revision.media_type,revision.status_code,revision.property_paths,revision.ttl_seconds,revision.max_live_records,
    revision.owner_access_scope_id FROM observation_field_presence_policy_heads head
    JOIN observation_field_presence_policy_revisions revision ON revision.tenant_id=head.tenant_id
      AND revision.repository_id=head.repository_id AND revision.service_id=head.service_id AND revision.environment=head.environment
      AND revision.policy_id=head.policy_id AND revision.owner_policy_revision=head.current_owner_policy_revision
      AND revision.policy_fingerprint=head.current_policy_fingerprint
    WHERE head.tenant_id=$1 AND head.repository_id=$2 AND head.service_id=$3 AND head.environment=$4 AND head.policy_id=$5
      AND head.enabled AND head.current_owner_policy_revision=$6::bigint FOR UPDATE OF head`,
    [binding.tenantId,binding.repositoryId,binding.serviceId,binding.environment,binding.policyId,revision]);
  const row=policyResult.rows[0];
  if(!row) return txFail("FIELD_PRESENCE_IMPORT_STALE");
  if(row.owner_access_scope_id!==binding.ownerAccessScopeId||row.config_fingerprint!==pin.configFingerprint)
    return txFail("FIELD_PRESENCE_IMPORT_STALE");
  let compiled:ReturnType<typeof compileFieldPresenceStoragePolicy>;
  try{compiled=policyFromRow(row,binding);}catch{return txFail("FIELD_PRESENCE_IMPORT_STORAGE_ERROR");}
  if(compiled.policy.ownerPolicyRevision!==revision||compiled.fingerprint!==row.policy_fingerprint)
    txFail("FIELD_PRESENCE_IMPORT_STALE");
  const parentResult=await client.query<{status:string;endpoint_id:string|null;mapping_id:string|null;method:string|null;
    status_code:number|null;completeness:string;policy_version:string;import_policy_version:string;
    source_id:string;source_version:string;window_start:Date;window_end:Date;imported_at:Date;
    snapshot_id:string;immutable_revision:string;config_fingerprint:string;checkpoint_version:string;source_digest:string|null;db_now:Date;
    window_start_millisecond_aligned:boolean;window_end_millisecond_aligned:boolean}>(
    `SELECT record.status,record.endpoint_id,record.mapping_id,record.method,record.status_code,record.completeness,record.policy_version,
      imported.source_id,imported.source_version,imported.window_start,imported.window_end,imported.imported_at,
      imported.policy_version AS import_policy_version,imported.snapshot_id,imported.revision AS immutable_revision,
      imported.config_fingerprint,imported.checkpoint_version::text,
      snapshot.document #>> '{source,source_digest}' AS source_digest,clock_timestamp() AS db_now,
      imported.window_start=date_trunc('milliseconds',imported.window_start) AS window_start_millisecond_aligned,
      imported.window_end=date_trunc('milliseconds',imported.window_end) AS window_end_millisecond_aligned
     FROM observation_records record JOIN observation_imports imported USING
      (tenant_id,repository_id,service_id,environment,import_id)
     JOIN catalog_snapshots snapshot ON snapshot.tenant_id=imported.tenant_id AND snapshot.repository_id=imported.repository_id
      AND snapshot.service_id=imported.service_id AND snapshot.snapshot_id=imported.snapshot_id
      AND snapshot.immutable_revision=imported.revision AND snapshot.config_fingerprint=imported.config_fingerprint
     WHERE record.tenant_id=$1 AND record.repository_id=$2 AND record.service_id=$3 AND record.environment=$4
      AND record.import_id=$5::uuid AND record.record_id=$6::uuid`,
    [binding.tenantId,binding.repositoryId,binding.serviceId,binding.environment,importId,recordId]);
  const p=parentResult.rows[0];if(!p)return txFail("FIELD_PRESENCE_IMPORT_PARENT_INVALID");
  if(p.status!=="confirmed"||p.completeness!=="metadata_only"||p.policy_version!=="metadata-only-1"
    ||p.endpoint_id!==compiled.policy.endpointId
    ||compiled.policy.direction==="response"&&p.status_code!==compiled.policy.statusCode)
    return txFail("FIELD_PRESENCE_IMPORT_PARENT_INVALID");
  if(!p.mapping_id||!p.method)return txFail("FIELD_PRESENCE_IMPORT_PARENT_INVALID");
  if(compiled.policy.direction==="response"&&p.status_code===null)return txFail("FIELD_PRESENCE_IMPORT_PARENT_INVALID");
  if(p.snapshot_id!==pin.snapshotId||p.immutable_revision!==pin.revision||p.config_fingerprint!==pin.configFingerprint
    ||p.checkpoint_version!==pin.checkpointVersion||p.import_policy_version!=="metadata-only-1"
    ||p.source_digest!==snapshotSourceDigest||p.source_id!==logAdapterId
    ||!identifier(p.source_id)||!identifier(p.source_version))return txFail("FIELD_PRESENCE_IMPORT_STALE");
  const duplicate=await client.query(`SELECT 1 FROM observation_records WHERE tenant_id=$1 AND repository_id=$2 AND service_id=$3
    AND environment=$4 AND record_id=$5::uuid AND import_id<>$6::uuid LIMIT 1`,
    [binding.tenantId,binding.repositoryId,binding.serviceId,binding.environment,recordId,importId]);
  if(duplicate.rows.length)return txFail("FIELD_PRESENCE_IMPORT_PARENT_INVALID");
  const windowStart=iso(p.window_start),windowEnd=iso(p.window_end),importedAt=iso(p.imported_at);
  if(!windowStart||!windowEnd||!importedAt||!p.window_start_millisecond_aligned||!p.window_end_millisecond_aligned)
    return txFail("FIELD_PRESENCE_IMPORT_PARENT_INVALID");
  if(windowStart>windowEnd||windowEnd>importedAt||importedAt>p.db_now.toISOString()||windowEnd>p.db_now.toISOString()
    ||Date.parse(windowEnd)+compiled.policy.ttlSeconds*1000<=p.db_now.getTime())
    return txFail("FIELD_PRESENCE_IMPORT_PARENT_INVALID");
  return Object.freeze({sourceId:p.source_id,sourceVersion:p.source_version,windowStart,windowEnd,importedAt,
    sourceDigest:snapshotSourceDigest,policyFingerprint:row.policy_fingerprint,policy:compiled.policy,
    mappingId:p.mapping_id,method:p.method,...(p.status_code===null?{}:{statusCode:p.status_code})});
};
type SafeRead=Readonly<{attestation:Readonly<Record<string,unknown>>;payloadText:string;payloadCompleteness:"complete_unredacted"}>;
const parseRead=(input:unknown):SafeRead|undefined=>{
  const outer=fields(input,["attestation","payloadText","payloadCompleteness"]);
  const attestationInput=plain(outer?.attestation)?outer.attestation:undefined;
  const directionDescriptor=attestationInput&&Object.getOwnPropertyDescriptor(attestationInput,"direction");
  const direction=directionDescriptor&&"value" in directionDescriptor?directionDescriptor.value:undefined;
  if(direction!=="request"&&direction!=="response")return undefined;
  const keys=["tenantId","repositoryId","serviceId","environment","snapshotId","revision","sourceDigest","configFingerprint",
    "checkpointVersion","importId","recordId","endpointId","direction","mediaType","sourceId","sourceVersion","windowStart","windowEnd",
    ...(direction==="response"?["statusCode"]:[])];
  if(!outer||typeof outer.payloadText!=="string"||Buffer.byteLength(outer.payloadText,"utf8")>256*1024
    ||outer.payloadCompleteness!=="complete_unredacted")return undefined;
  const attestation=fields(outer.attestation,keys);
  if(!attestation)return undefined;
  return Object.freeze({attestation:Object.freeze(attestation),payloadText:outer.payloadText,payloadCompleteness:"complete_unredacted"});
};
const expectedAttestation=(read:SafeRead,state:Parent,request:Request,pin:ExpectedObservationPin):boolean=>{
  const actual=read.attestation,policy=state.policy;
  return actual.tenantId===pin.tenantId&&actual.repositoryId===pin.repositoryId&&actual.serviceId===pin.serviceId
    &&actual.environment===pin.environment&&actual.snapshotId===pin.snapshotId&&actual.revision===pin.revision
    &&actual.sourceDigest===state.sourceDigest&&actual.configFingerprint===pin.configFingerprint
    &&actual.checkpointVersion===pin.checkpointVersion&&actual.importId===request.importId&&actual.recordId===request.recordId
    &&actual.endpointId===policy.endpointId&&actual.direction===policy.direction&&actual.mediaType===policy.mediaType
    &&(policy.direction==="request"?!Object.hasOwn(actual,"statusCode"):actual.statusCode===policy.statusCode)
    &&actual.sourceId===state.sourceId&&actual.sourceVersion===state.sourceVersion
    &&actual.windowStart===state.windowStart&&actual.windowEnd===state.windowEnd;
};
type ImporterTransaction=Readonly<{snapshot:import("../../ir/src/index.js").ContractSnapshot;logAdapterId:string;parent:Parent}>;
const transactionCode=(error:unknown):FieldPresenceImportErrorCode=>{
  if(error instanceof ImportFailure)return error.importCode;
  if(error instanceof ObservationImportError){
    if(error.code==="OBSERVATION_NOT_AUTHORIZED")return "FIELD_PRESENCE_IMPORT_UNAUTHORIZED";
    if(error.code==="OBSERVATION_STALE_PIN")return "FIELD_PRESENCE_IMPORT_STALE";
    return "FIELD_PRESENCE_IMPORT_STORAGE_ERROR";
  }
  return "FIELD_PRESENCE_IMPORT_STORAGE_ERROR";
};
class ImportFailure extends ObservationImportError{
  readonly importCode:FieldPresenceImportErrorCode;
  constructor(code:FieldPresenceImportErrorCode){super("OBSERVATION_STORAGE_ERROR");this.importCode=code;}
}
const txFail=(code:FieldPresenceImportErrorCode):never=>{throw new ImportFailure(code);};
const projectionInput=(request:Request,transaction:ImporterTransaction,payloadText:string)=>({
  pin:{state:"resolved_single_revision",tenantId:request.binding.tenantId,repositoryId:request.binding.repositoryId,
    serviceId:request.binding.serviceId,environment:request.binding.environment,snapshotId:request.expectedPin.snapshotId,
    revision:request.expectedPin.revision,configFingerprint:request.expectedPin.configFingerprint,
    checkpointVersion:request.expectedPin.checkpointVersion},snapshot:transaction.snapshot,
  policy:{version:"observed-field-presence-1",policyId:request.binding.policyId,tenantId:request.binding.tenantId,
    repositoryId:request.binding.repositoryId,serviceId:request.binding.serviceId,environment:request.binding.environment,
    snapshotId:request.expectedPin.snapshotId,revision:request.expectedPin.revision,sourceDigest:transaction.parent.sourceDigest,
    configFingerprint:request.expectedPin.configFingerprint,checkpointVersion:request.expectedPin.checkpointVersion,
    endpointId:transaction.parent.policy.endpointId,direction:transaction.parent.policy.direction,
    mediaType:transaction.parent.policy.mediaType,propertyPaths:transaction.parent.policy.propertyPaths,
    ...(transaction.parent.policy.statusCode===undefined?{}:{statusCode:transaction.parent.policy.statusCode})},
  payloadText,payloadCompleteness:"complete_unredacted"});
const queryEnvelope=(request:Request,transaction:ImporterTransaction)=>({status:"resolved",selector:{version:"1",tenantId:request.binding.tenantId,
  repositoryId:request.binding.repositoryId,serviceId:request.binding.serviceId,selector:{kind:"environment",environment:request.binding.environment,
    expectedCheckpointVersion:request.expectedPin.checkpointVersion}},pin:{snapshotId:request.expectedPin.snapshotId,
  revision:request.expectedPin.revision,configFingerprint:request.expectedPin.configFingerprint,checkpointVersion:request.expectedPin.checkpointVersion},
  truncated:false,records:[{importId:request.importId,recordId:request.recordId,sourceId:transaction.parent.sourceId,
    sourceVersion:transaction.parent.sourceVersion,windowStart:transaction.parent.windowStart,windowEnd:transaction.parent.windowEnd,
    importedAt:transaction.parent.importedAt,status:"confirmed",endpointId:transaction.parent.policy.endpointId,
    mappingId:transaction.parent.mappingId,method:transaction.parent.method,
    ...(transaction.parent.statusCode===undefined?{}:{statusCode:transaction.parent.statusCode}),
    completeness:"metadata_only",policyVersion:"metadata-only-1"}]});

export const createFieldPresenceImportStore=(pool:Pool,optionsInput:FieldPresenceImportStoreOptions)=>{
  const options=fields(optionsInput,["schema","bindings","authorizeManager","readObservation"]);let schemaSql:string;
  try{schemaSql=quoteEnvironmentSchema(options?.schema as string);}catch{return fail("FIELD_PRESENCE_IMPORT_INVALID_CONFIGURATION");}
  const rawBindings=arrayValues(options?.bindings,128);
  if(!options||!rawBindings||typeof options.authorizeManager!=="function"||isProxy(options.authorizeManager)
    ||typeof options.readObservation!=="function"||isProxy(options.readObservation))return fail("FIELD_PRESENCE_IMPORT_INVALID_CONFIGURATION");
  const parsedBindings=rawBindings.map(bindingValue);
  if(parsedBindings.some(item=>!item))return fail("FIELD_PRESENCE_IMPORT_INVALID_CONFIGURATION");
  const bindings=parsedBindings as FieldPresenceImportBinding[];
  const byKey=new Map(bindings.map(binding=>[bindingKey(binding),binding]));
  if(byKey.size!==bindings.length)
    return fail("FIELD_PRESENCE_IMPORT_INVALID_CONFIGURATION");
  const authorizeManager=options.authorizeManager,readObservation=options.readObservation;
  const authorize=async(credential:unknown,binding:FieldPresenceImportBinding):Promise<ImportIdentity>=>{
    let raw:unknown;try{raw=await withDeadline(signal=>authorizeManager(credential,binding,signal));}catch{return fail("FIELD_PRESENCE_IMPORT_UNAUTHORIZED");}
    const identity=parseIdentity(raw,binding.tenantId);if(!identity)return fail("FIELD_PRESENCE_IMPORT_UNAUTHORIZED");return identity;
  };
  const load=(client:PoolClient,request:Request,snapshot:ImporterTransaction["snapshot"],logAdapterId:string)=>
    loadState(client,request.binding,request.ownerPolicyRevision,request.importId,request.recordId,request.expectedPin,
      snapshot.source.source_digest,logAdapterId);
  const discoverConfigEpoch=async(binding:FieldPresenceImportBinding,revision:string):Promise<string>=>{
    let client:PoolClient;try{client=await pool.connect();}catch{return fail("FIELD_PRESENCE_IMPORT_STORAGE_ERROR");}
    try{
      await client.query("BEGIN");await client.query(`SET LOCAL search_path TO ${schemaSql}, pg_catalog`);
      await client.query("SET LOCAL statement_timeout='10000ms'");await client.query("SET LOCAL lock_timeout='10000ms'");
      const result=await client.query<{config_activation_checkpoint:string}>(`SELECT revision.config_activation_checkpoint::text
        FROM observation_field_presence_policy_heads head JOIN observation_field_presence_policy_revisions revision
          ON revision.tenant_id=head.tenant_id AND revision.repository_id=head.repository_id
          AND revision.service_id=head.service_id AND revision.environment=head.environment AND revision.policy_id=head.policy_id
          AND revision.owner_policy_revision=head.current_owner_policy_revision
          AND revision.policy_fingerprint=head.current_policy_fingerprint
        WHERE head.tenant_id=$1 AND head.repository_id=$2 AND head.service_id=$3 AND head.environment=$4
          AND head.policy_id=$5 AND head.enabled AND head.current_owner_policy_revision=$6::bigint`,
      [binding.tenantId,binding.repositoryId,binding.serviceId,binding.environment,binding.policyId,revision]);
      const epoch=result.rows[0]?.config_activation_checkpoint;
      if(!positiveRevision(epoch))return txFail("FIELD_PRESENCE_IMPORT_STALE");
      await client.query("COMMIT");return epoch;
    }catch(error){await client.query("ROLLBACK").catch(()=>undefined);return fail(transactionCode(error));}
    finally{client.release();}
  };
  return Object.freeze({async importObservation(credential:unknown,input:unknown):Promise<Readonly<{status:"inserted"|"existing";fieldCount:number}>>{
    const raw=fields(input,["policyId","ownerPolicyRevision","importId","recordId","expectedPin"]);
    if(!raw||!identifier(raw.policyId))return fail("FIELD_PRESENCE_IMPORT_INVALID_REQUEST");
    const request=parseRequest(input,byKey),binding=request.binding,pin=request.expectedPin;
    const identity=await authorize(credential,binding);
    const configEpoch=await discoverConfigEpoch(binding,request.ownerPolicyRevision);
    let first:ImporterTransaction;
    try{
      first=await withAuthorizedObservationPin(pool,schemaSql,options.schema as string,identity,pin,
        async(client,authorized)=>{
          const parent=await load(client,request,authorized.snapshot,authorized.logAdapterId);
          return {snapshot:authorized.snapshot,logAdapterId:authorized.logAdapterId,parent};
        },{configActivationCheckpoint:configEpoch,additionalScopeIds:[binding.ownerAccessScopeId,binding.importAccessScopeId],
          requireUnqualifiedPin:true,boundedTransaction:true});
    }catch(error){return fail(transactionCode(error));}
    // The helper pins the active fingerprint/checkpoint; require the policy's exact activation epoch before callback work.
    if(first.parent.policy.configFingerprint!==pin.configFingerprint||first.parent.policy.configActivationCheckpoint!==configEpoch)
      return fail("FIELD_PRESENCE_IMPORT_STALE");
    const preflight=projectObservedFieldPresence(projectionInput(request,first,"{}"));
    if(preflight.status!=="projected")return fail("FIELD_PRESENCE_IMPORT_POLICY_UNSUPPORTED");
    const sourceRequest=Object.freeze({binding:request.binding,importId:request.importId,recordId:request.recordId,
      expectedPin:request.expectedPin,selector:Object.freeze({endpointId:first.parent.policy.endpointId,direction:first.parent.policy.direction,
        mediaType:first.parent.policy.mediaType,...(first.parent.policy.statusCode===undefined?{}:{statusCode:first.parent.policy.statusCode})}),
      source:Object.freeze({sourceId:first.parent.sourceId,sourceVersion:first.parent.sourceVersion,
        windowStart:first.parent.windowStart,windowEnd:first.parent.windowEnd})});
    let readRaw:unknown;try{readRaw=await withDeadline(signal=>readObservation(identity,sourceRequest,signal));}
      catch{return fail("FIELD_PRESENCE_IMPORT_SOURCE_INVALID");}
    const body=parseRead(readRaw);if(!body||!expectedAttestation(body,first.parent,request,pin))return fail("FIELD_PRESENCE_IMPORT_SOURCE_INVALID");
    const projected=projectObservedFieldPresence(projectionInput(request,first,body.payloadText));
    if(projected.status!=="projected")return fail("FIELD_PRESENCE_IMPORT_PAYLOAD_INVALID");
    // Re-authenticate the independent capability after the external read; DB authority is rechecked inside the final transaction.
    const finalIdentity=await authorize(credential,binding);
    if(finalIdentity.principalId!==identity.principalId)return fail("FIELD_PRESENCE_IMPORT_UNAUTHORIZED");
    try{return await withAuthorizedObservationPin(pool,schemaSql,options.schema as string,finalIdentity,pin,
      async(client,authorized)=>{
        const current=await load(client,request,authorized.snapshot,authorized.logAdapterId);
        if(current.policyFingerprint!==first.parent.policyFingerprint||JSON.stringify(current.policy)!==JSON.stringify(first.parent.policy)
          ||current.sourceId!==first.parent.sourceId||current.sourceVersion!==first.parent.sourceVersion
          ||current.windowStart!==first.parent.windowStart||current.windowEnd!==first.parent.windowEnd
          ||current.importedAt!==first.parent.importedAt||current.sourceDigest!==first.parent.sourceDigest)
          return txFail("FIELD_PRESENCE_IMPORT_STALE");
        const proposal=buildFieldPresenceStorageProposal({queryResult:queryEnvelope(request,{...first,parent:current}),projected,
          policy:compileFieldPresenceStoragePolicy({
            version:"field-presence-storage-1",policyId:binding.policyId,ownerPolicyRevision:request.ownerPolicyRevision,optIn:true,
            tenantId:binding.tenantId,repositoryId:binding.repositoryId,serviceId:binding.serviceId,environment:binding.environment,
            configFingerprint:current.policy.configFingerprint,configActivationCheckpoint:current.policy.configActivationCheckpoint,
            endpointId:current.policy.endpointId,direction:current.policy.direction,mediaType:current.policy.mediaType,
            propertyPaths:current.policy.propertyPaths,...(current.policy.statusCode===undefined?{}:{statusCode:current.policy.statusCode}),
            ttlSeconds:current.policy.ttlSeconds,maxLiveRecords:current.policy.maxLiveRecords}),
          parent:{importId:request.importId,recordId:request.recordId},host:{activeConfigFingerprint:current.policy.configFingerprint,
            configActivationCheckpoint:current.policy.configActivationCheckpoint,expectedPolicyFingerprint:current.policyFingerprint,
            expectedSourceDigest:current.sourceDigest}});
        if(proposal.status!=="eligible")return txFail("FIELD_PRESENCE_IMPORT_POLICY_UNSUPPORTED");
        const insertValues=[binding.tenantId,binding.repositoryId,binding.serviceId,binding.environment,binding.policyId,
          request.ownerPolicyRevision,proposal.policyFingerprint,request.importId,request.recordId,proposal.scope.sourceDigest,
          JSON.stringify(proposal.fields)];
        await client.query("SAVEPOINT field_presence_insert");
        let inserted;
        try {
          inserted=await client.query(`INSERT INTO observation_field_presence_results
            (tenant_id,repository_id,service_id,environment,policy_id,owner_policy_revision,policy_fingerprint,import_id,record_id,
             source_digest,presence_fields,source_window_end,expires_at)
            VALUES($1,$2,$3,$4,$5,$6::bigint,$7,$8::uuid,$9::uuid,$10,$11::jsonb,NULL,NULL)
            ON CONFLICT DO NOTHING RETURNING 1`,insertValues);
          await client.query("RELEASE SAVEPOINT field_presence_insert");
        } catch(error) {
          await client.query("ROLLBACK TO SAVEPOINT field_presence_insert");
          await client.query("RELEASE SAVEPOINT field_presence_insert");
          const sqlState=error&&typeof error==="object"&&"code" in error?(error as {code?:unknown}).code:undefined;
          if(sqlState!=="55000")throw error;
          // The retention trigger rejects conflicting replays with SQLSTATE 55000.
          // Check only after rollback to the savepoint; never expose database text.
          const collided=await client.query<{same:boolean}>(`SELECT policy_fingerprint=$7 AND source_digest=$10
            AND presence_fields=$11::jsonb AS same FROM observation_field_presence_results WHERE tenant_id=$1 AND repository_id=$2
            AND service_id=$3 AND environment=$4 AND policy_id=$5 AND owner_policy_revision=$6::bigint
            AND import_id=$8::uuid AND record_id=$9::uuid`,insertValues);
          if(collided.rows[0])return txFail(collided.rows[0].same
            ?"FIELD_PRESENCE_IMPORT_STORAGE_ERROR":"FIELD_PRESENCE_IMPORT_CONFLICT");
          throw error;
        }
        if(inserted.rows.length)return Object.freeze({status:"inserted" as const,fieldCount:proposal.fields.length});
        const existing=await client.query<{same:boolean}>(`SELECT policy_fingerprint=$7 AND source_digest=$10
          AND presence_fields=$11::jsonb AS same FROM observation_field_presence_results WHERE tenant_id=$1 AND repository_id=$2
          AND service_id=$3 AND environment=$4 AND policy_id=$5 AND owner_policy_revision=$6::bigint
          AND import_id=$8::uuid AND record_id=$9::uuid`,[binding.tenantId,binding.repositoryId,binding.serviceId,binding.environment,
          binding.policyId,request.ownerPolicyRevision,proposal.policyFingerprint,request.importId,request.recordId,
          proposal.scope.sourceDigest,JSON.stringify(proposal.fields)]);
        if(existing.rows[0]?.same!==true)return txFail("FIELD_PRESENCE_IMPORT_CONFLICT");
        return Object.freeze({status:"existing" as const,fieldCount:proposal.fields.length});
      },{configActivationCheckpoint:configEpoch,additionalScopeIds:[binding.ownerAccessScopeId,binding.importAccessScopeId],
        requireUnqualifiedPin:true,boundedTransaction:true});}
      catch(error){return fail(transactionCode(error));}
  }});
};
