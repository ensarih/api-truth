import {isProxy} from "node:util/types";
import type {Pool} from "pg";
import {quoteEnvironmentSchema} from "../../environment/src/migrations.js";
import type {ContractSnapshot} from "../../ir/src/index.js";
import {projectObservedFieldPresence} from "./field-presence.js";
import {compileFieldPresenceStoragePolicy,type FieldPresenceStoragePolicy} from "./field-presence-storage-policy.js";
import {ObservationImportError,withAuthorizedObservationPin,type ExpectedObservationPin} from "./store.js";

export type FieldPresenceQueryBinding=Readonly<{tenantId:string;repositoryId:string;serviceId:string;environment:string;
  policyId:string;ownerAccessScopeId:string;readAccessScopeId:string}>;
export type FieldPresenceQueryManager=(credential:unknown,binding:FieldPresenceQueryBinding,signal:AbortSignal)=>Promise<unknown>;
export type FieldPresenceQueryStoreOptions=Readonly<{schema:string;bindings:readonly FieldPresenceQueryBinding[];
  authorizeManager:FieldPresenceQueryManager}>;
export type FieldPresenceQueryErrorCode="FIELD_PRESENCE_QUERY_INVALID_CONFIGURATION"|"FIELD_PRESENCE_QUERY_INVALID_REQUEST"
  |"FIELD_PRESENCE_QUERY_UNAUTHORIZED"|"FIELD_PRESENCE_QUERY_STALE"|"FIELD_PRESENCE_QUERY_POLICY_UNSUPPORTED"
  |"FIELD_PRESENCE_QUERY_PARENT_AMBIGUOUS"|"FIELD_PRESENCE_QUERY_STORAGE_ERROR";
export class FieldPresenceQueryError extends Error{
  readonly code:FieldPresenceQueryErrorCode;
  constructor(code:FieldPresenceQueryErrorCode){super(code);this.name="FieldPresenceQueryError";this.code=code;}
}
const fail=(code:FieldPresenceQueryErrorCode):never=>{throw new FieldPresenceQueryError(code);};
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
const values=(input:unknown,max:number):unknown[]|undefined=>{
  try{if(isProxy(input)||!Array.isArray(input)||Object.getPrototypeOf(input)!==Array.prototype||input.length>max
      ||Reflect.ownKeys(input).length!==input.length+1)return undefined;
    const output:unknown[]=[];for(let index=0;index<input.length;index++){const descriptor=Object.getOwnPropertyDescriptor(input,String(index));
      if(!descriptor||!descriptor.enumerable||!("value" in descriptor))return undefined;output.push(descriptor.value);}return output;
  }catch{return undefined;}
};
const identifier=(value:unknown):value is string=>typeof value==="string"&&value.length>0&&value.length<=128
  &&/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
const positive=(value:unknown):value is string=>typeof value==="string"&&/^[1-9][0-9]{0,18}$/.test(value)
  &&BigInt(value)<=9223372036854775807n;
const digest=/^sha256:[0-9a-f]{64}$/;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const bindingKeys=["tenantId","repositoryId","serviceId","environment","policyId","ownerAccessScopeId","readAccessScopeId"] as const;
type Request=Readonly<{binding:FieldPresenceQueryBinding;ownerPolicyRevision:string;expectedPin:ExpectedObservationPin;limit:number}>;
const bindingKey=(binding:Pick<FieldPresenceQueryBinding,"tenantId"|"repositoryId"|"serviceId"|"environment"|"policyId">)=>
  JSON.stringify([binding.tenantId,binding.repositoryId,binding.serviceId,binding.environment,binding.policyId]);
const bindingValue=(input:unknown):FieldPresenceQueryBinding|undefined=>{
  const raw=fields(input,bindingKeys);if(!raw||!bindingKeys.every(key=>identifier(raw[key])))return undefined;
  return Object.freeze(Object.fromEntries(bindingKeys.map(key=>[key,raw[key]]))) as unknown as FieldPresenceQueryBinding;
};
const parseRequest=(input:unknown,bindings:ReadonlyMap<string,FieldPresenceQueryBinding>):Request=>{
  const raw=fields(input,["policyId","ownerPolicyRevision","expectedPin","limit"]);
  if(!raw||!identifier(raw.policyId)||!positive(raw.ownerPolicyRevision)||!Number.isInteger(raw.limit)
    ||Number(raw.limit)<1||Number(raw.limit)>100)return fail("FIELD_PRESENCE_QUERY_INVALID_REQUEST");
  const scope=fields(raw.expectedPin,["tenantId","repositoryId","serviceId","environment","snapshotId","revision","configFingerprint","checkpointVersion"]);
  if(!scope||![scope.tenantId,scope.repositoryId,scope.serviceId,scope.environment,scope.snapshotId,scope.revision].every(identifier)
    ||typeof scope.configFingerprint!=="string"||!digest.test(scope.configFingerprint)||!positive(scope.checkpointVersion))
    return fail("FIELD_PRESENCE_QUERY_INVALID_REQUEST");
  const binding=bindings.get(bindingKey({tenantId:scope.tenantId as string,repositoryId:scope.repositoryId as string,
    serviceId:scope.serviceId as string,environment:scope.environment as string,policyId:raw.policyId as string}));
  if(!binding)return fail("FIELD_PRESENCE_QUERY_UNAUTHORIZED");
  const expectedPin=Object.freeze({tenantId:binding.tenantId,repositoryId:binding.repositoryId,serviceId:binding.serviceId,
    environment:binding.environment,snapshotId:scope.snapshotId as string,revision:scope.revision as string,
    configFingerprint:scope.configFingerprint as string,checkpointVersion:scope.checkpointVersion as string});
  return Object.freeze({binding,ownerPolicyRevision:raw.ownerPolicyRevision as string,expectedPin,limit:Number(raw.limit)});
};
type Identity=Readonly<{tenantId:string;principalId:string;capabilities:readonly string[]}>;
const identity=(input:unknown,tenantId:string):Identity|undefined=>{
  const raw=fields(input,["tenantId","principalId","capabilities"]),caps=values(raw?.capabilities,16);
  if(!raw||raw.tenantId!==tenantId||!identifier(raw.principalId)||!caps||!caps.length
    ||!caps.includes("observations.presence.read")||caps.some(cap=>!identifier(cap))||new Set(caps).size!==caps.length)return undefined;
  return Object.freeze({tenantId,principalId:raw.principalId as string,capabilities:Object.freeze(caps as string[])});
};
const deadline=async<T>(callback:(signal:AbortSignal)=>Promise<T>):Promise<T>=>{
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
  const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error("deadline"));},10_000);});
  try{return await Promise.race([Promise.resolve().then(()=>callback(controller.signal)),timeout]);}
  finally{if(timer!==undefined)clearTimeout(timer);}
};
type PolicyRow={owner_policy_revision:string;policy_fingerprint:string;config_fingerprint:string;config_activation_checkpoint:string;
  endpoint_id:string;direction:"request"|"response";media_type:string;status_code:number|null;property_paths:string[];
  ttl_seconds:number;max_live_records:number;owner_access_scope_id:string};
const compileRow=(row:PolicyRow,binding:FieldPresenceQueryBinding)=>compileFieldPresenceStoragePolicy({
  version:"field-presence-storage-1",policyId:binding.policyId,ownerPolicyRevision:row.owner_policy_revision,optIn:true,
  tenantId:binding.tenantId,repositoryId:binding.repositoryId,serviceId:binding.serviceId,environment:binding.environment,
  configFingerprint:row.config_fingerprint,configActivationCheckpoint:row.config_activation_checkpoint,endpointId:row.endpoint_id,
  direction:row.direction,mediaType:row.media_type,propertyPaths:row.property_paths,
  ...(row.status_code===null?{}:{statusCode:row.status_code}),ttlSeconds:row.ttl_seconds,maxLiveRecords:row.max_live_records});
const policyPreflight=(snapshot:ContractSnapshot,binding:FieldPresenceQueryBinding,pin:ExpectedObservationPin,policy:FieldPresenceStoragePolicy)=>
  projectObservedFieldPresence({pin:{state:"resolved_single_revision",tenantId:binding.tenantId,repositoryId:binding.repositoryId,
    serviceId:binding.serviceId,environment:binding.environment,snapshotId:pin.snapshotId,revision:pin.revision,
    configFingerprint:pin.configFingerprint,checkpointVersion:pin.checkpointVersion},snapshot,
    policy:{version:"observed-field-presence-1",policyId:binding.policyId,tenantId:binding.tenantId,repositoryId:binding.repositoryId,
      serviceId:binding.serviceId,environment:binding.environment,snapshotId:pin.snapshotId,revision:pin.revision,
      sourceDigest:snapshot.source.source_digest,configFingerprint:pin.configFingerprint,checkpointVersion:pin.checkpointVersion,
      endpointId:policy.endpointId,direction:policy.direction,mediaType:policy.mediaType,propertyPaths:policy.propertyPaths,
      ...(policy.statusCode===undefined?{}:{statusCode:policy.statusCode})},payloadText:"{}",payloadCompleteness:"complete_unredacted"});
const timestamp=(value:unknown):string|undefined=>value instanceof Date&&Number.isFinite(value.getTime())?value.toISOString():undefined;
const safeFields=(input:unknown,policy:FieldPresenceStoragePolicy):readonly Readonly<{path:string;state:"present"|"absent"}>[]|undefined=>{
  const raw=values(input,32);if(!raw||raw.length!==policy.propertyPaths.length)return undefined;
  const out:Array<Readonly<{path:string;state:"present"|"absent"}>>=[];
  for(const item of raw){const field=fields(item,["path","state"]);
    if(!field||typeof field.path!=="string"||!(field.state==="present"||field.state==="absent"))return undefined;
    out.push(Object.freeze({path:field.path,state:field.state}));}
  out.sort((a,b)=>Buffer.compare(Buffer.from(a.path),Buffer.from(b.path)));
  return out.every((field,index)=>field.path===policy.propertyPaths[index])?Object.freeze(out):undefined;
};
class TransactionFailure extends ObservationImportError{
  readonly queryCode:FieldPresenceQueryErrorCode;
  constructor(code:FieldPresenceQueryErrorCode){super("OBSERVATION_STORAGE_ERROR");this.queryCode=code;}
}
const txFail=(code:FieldPresenceQueryErrorCode):never=>{throw new TransactionFailure(code);};
const mapError=(error:unknown):never=>{
  if(error instanceof TransactionFailure)return fail(error.queryCode);
  if(error instanceof ObservationImportError){
    if(error.code==="OBSERVATION_NOT_AUTHORIZED")return fail("FIELD_PRESENCE_QUERY_UNAUTHORIZED");
    if(error.code==="OBSERVATION_STALE_PIN")return fail("FIELD_PRESENCE_QUERY_STALE");
  }
  return fail("FIELD_PRESENCE_QUERY_STORAGE_ERROR");
};
type ReadRow={import_id:string;record_id:string;source_id:string;source_version:string;window_start:Date;window_end:Date;imported_at:string;
  window_end_before_imported_at:boolean;imported_at_before_db_now:boolean;expires_at:Date;window_start_finite:boolean;window_end_finite:boolean;expires_at_finite:boolean;
  window_start_millisecond_aligned:boolean;window_end_millisecond_aligned:boolean;
  source_digest:string|null;status:string;endpoint_id:string|null;mapping_id:string|null;method:string|null;
  status_code:number|null;completeness:string;metadata_policy_version:string;import_policy_version:string;presence_fields:unknown;duplicate_record:boolean};

export const createFieldPresenceQueryStore=(pool:Pool,optionsInput:FieldPresenceQueryStoreOptions)=>{
  const options=fields(optionsInput,["schema","bindings","authorizeManager"]);let schemaSql:string;
  try{schemaSql=quoteEnvironmentSchema(options?.schema as string);}catch{return fail("FIELD_PRESENCE_QUERY_INVALID_CONFIGURATION");}
  const rawBindings=values(options?.bindings,128);
  if(!options||!rawBindings||typeof options.authorizeManager!=="function"||isProxy(options.authorizeManager))
    return fail("FIELD_PRESENCE_QUERY_INVALID_CONFIGURATION");
  const bindings=rawBindings.map(bindingValue);if(bindings.some(item=>!item))return fail("FIELD_PRESENCE_QUERY_INVALID_CONFIGURATION");
  const configured=bindings as FieldPresenceQueryBinding[],byKey=new Map(configured.map(binding=>[bindingKey(binding),binding]));
  if(byKey.size!==configured.length)return fail("FIELD_PRESENCE_QUERY_INVALID_CONFIGURATION");
  const authorizeManager=options.authorizeManager;
  const authorize=async(credential:unknown,binding:FieldPresenceQueryBinding):Promise<Identity>=>{
    let raw:unknown;try{raw=await deadline(signal=>authorizeManager(credential,binding,signal));}
    catch{return fail("FIELD_PRESENCE_QUERY_UNAUTHORIZED");}
    const parsed=identity(raw,binding.tenantId);if(!parsed)return fail("FIELD_PRESENCE_QUERY_UNAUTHORIZED");return parsed;
  };
  return Object.freeze({async read(credential:unknown,input:unknown):Promise<Readonly<{status:"resolved";kind:"observed_field_presence";
    nonNormative:true;pin:Readonly<{tenantId:string;repositoryId:string;serviceId:string;environment:string;
    snapshotId:string;revision:string;configFingerprint:string;checkpointVersion:string;sourceDigest:string}>;policy:Readonly<{policyId:string;
      ownerPolicyRevision:string;policyFingerprint:string;configActivationCheckpoint:string;endpointId:string;
      direction:"request"|"response";mediaType:string;statusCode?:number;propertyPaths:readonly string[]}>;
    records:readonly Readonly<{importId:string;recordId:string;source:Readonly<{sourceId:string;sourceVersion:string;
      windowStart:string;windowEnd:string;importedAt:string;expiresAt:string}>;scope:Readonly<{sourceDigest:string;
      endpointId:string;direction:"request"|"response";mediaType:string;statusCode?:number}>;
      fields:readonly Readonly<{path:string;state:"present"|"absent"}>[]} >[];truncated:boolean}>>{
    const request=parseRequest(input,byKey),binding=request.binding,pin=request.expectedPin;
    const caller=await authorize(credential,binding);
    try{return await withAuthorizedObservationPin(pool,schemaSql,options.schema as string,pinIdentity(caller),pin,
      async(client,authorized)=>{
        const active=await client.query<{config_fingerprint:string;checkpoint_version:string}>(`SELECT config_fingerprint,checkpoint_version::text
          FROM orchestration_active_configurations WHERE tenant_id=$1`,[binding.tenantId]);
        const epoch=active.rows[0];if(!epoch||epoch.config_fingerprint!==pin.configFingerprint)
          return txFail("FIELD_PRESENCE_QUERY_STALE");
        const policyResult=await client.query<PolicyRow>(`SELECT revision.owner_policy_revision::text,revision.policy_fingerprint,
          revision.config_fingerprint,revision.config_activation_checkpoint::text,revision.endpoint_id,revision.direction,
          revision.media_type,revision.status_code,revision.property_paths,revision.ttl_seconds,revision.max_live_records,
          revision.owner_access_scope_id FROM observation_field_presence_policy_heads head
          JOIN observation_field_presence_policy_revisions revision USING(tenant_id,repository_id,service_id,environment,policy_id)
          WHERE head.tenant_id=$1 AND head.repository_id=$2 AND head.service_id=$3 AND head.environment=$4 AND head.policy_id=$5
            AND head.enabled AND head.current_owner_policy_revision=$6::bigint
            AND revision.owner_policy_revision=head.current_owner_policy_revision
            AND revision.policy_fingerprint=head.current_policy_fingerprint
          FOR UPDATE OF head`,[binding.tenantId,binding.repositoryId,binding.serviceId,binding.environment,binding.policyId,request.ownerPolicyRevision]);
        const row=policyResult.rows[0];if(!row||row.owner_access_scope_id!==binding.ownerAccessScopeId
          ||row.config_fingerprint!==pin.configFingerprint||row.config_activation_checkpoint!==epoch.checkpoint_version)
          return txFail("FIELD_PRESENCE_QUERY_STALE");
        let compiled;try{compiled=compileRow(row,binding);}catch{return txFail("FIELD_PRESENCE_QUERY_STORAGE_ERROR");}
        if(compiled.policy.ownerPolicyRevision!==request.ownerPolicyRevision||compiled.fingerprint!==row.policy_fingerprint)
          return txFail("FIELD_PRESENCE_QUERY_STALE");
        if(policyPreflight(authorized.snapshot,binding,pin,compiled.policy).status!=="projected")
          return txFail("FIELD_PRESENCE_QUERY_POLICY_UNSUPPORTED");
        const result=await client.query<ReadRow>(`SELECT presence.import_id::text,presence.record_id::text,imported.source_id,
          imported.source_version,imported.window_start,imported.window_end,
          to_char(imported.imported_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS imported_at,
          imported.window_end<=imported.imported_at AS window_end_before_imported_at,
          imported.imported_at<=clock_timestamp() AS imported_at_before_db_now,presence.expires_at,
          isfinite(imported.window_start) AS window_start_finite,isfinite(imported.window_end) AS window_end_finite,
          isfinite(presence.expires_at) AS expires_at_finite,
          imported.window_start=date_trunc('milliseconds',imported.window_start) AS window_start_millisecond_aligned,
          imported.window_end=date_trunc('milliseconds',imported.window_end) AS window_end_millisecond_aligned,
          snapshot.document #>> '{source,source_digest}' AS source_digest,record.status,record.endpoint_id,record.mapping_id,
          record.method,record.status_code,record.completeness,record.policy_version AS metadata_policy_version,
          imported.policy_version AS import_policy_version,presence.presence_fields,
          EXISTS(SELECT 1 FROM observation_records duplicate WHERE duplicate.tenant_id=presence.tenant_id
            AND duplicate.repository_id=presence.repository_id AND duplicate.service_id=presence.service_id
            AND duplicate.environment=presence.environment AND duplicate.record_id=presence.record_id
            AND duplicate.import_id<>presence.import_id) AS duplicate_record
          FROM observation_field_presence_results presence
          JOIN observation_records record USING(tenant_id,repository_id,service_id,environment,import_id,record_id)
          JOIN observation_imports imported USING(tenant_id,repository_id,service_id,environment,import_id)
          JOIN catalog_snapshots snapshot ON snapshot.tenant_id=imported.tenant_id AND snapshot.repository_id=imported.repository_id
            AND snapshot.service_id=imported.service_id AND snapshot.snapshot_id=imported.snapshot_id
            AND snapshot.immutable_revision=imported.revision AND snapshot.config_fingerprint=imported.config_fingerprint
          WHERE presence.tenant_id=$1 AND presence.repository_id=$2 AND presence.service_id=$3 AND presence.environment=$4
            AND presence.policy_id=$5 AND presence.owner_policy_revision=$6::bigint AND presence.policy_fingerprint=$7
            AND presence.source_digest=$8 AND imported.snapshot_id=$9 AND imported.revision=$10
            AND imported.config_fingerprint=$11 AND imported.checkpoint_version=$12::bigint
            AND record.status='confirmed' AND record.completeness='metadata_only' AND record.policy_version='metadata-only-1'
            AND record.endpoint_id=$13 AND ($14::boolean=false OR record.status_code=$15)
            AND presence.expires_at>clock_timestamp()
          ORDER BY presence.created_at DESC,presence.import_id::text COLLATE "C" DESC,presence.record_id::text COLLATE "C" ASC
          LIMIT $16`,[binding.tenantId,binding.repositoryId,binding.serviceId,binding.environment,binding.policyId,
          request.ownerPolicyRevision,compiled.fingerprint,authorized.snapshot.source.source_digest,pin.snapshotId,pin.revision,
          pin.configFingerprint,pin.checkpointVersion,compiled.policy.endpointId,compiled.policy.direction==="response",
          compiled.policy.statusCode??null,request.limit+1]);
        if(result.rows.some(item=>item.duplicate_record))return txFail("FIELD_PRESENCE_QUERY_PARENT_AMBIGUOUS");
        const truncated=result.rows.length>request.limit;
        const records=result.rows.slice(0,request.limit).map(item=>{
          const windowStart=timestamp(item.window_start),windowEnd=timestamp(item.window_end),expiresAt=timestamp(item.expires_at);
          const importedAt=/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(item.imported_at)?item.imported_at:undefined;
          const fields=safeFields(item.presence_fields,compiled.policy);
          if(!windowStart||!windowEnd||!importedAt||!expiresAt||!fields||item.status!=="confirmed"
            ||item.endpoint_id!==compiled.policy.endpointId||item.completeness!=="metadata_only"
            ||item.metadata_policy_version!=="metadata-only-1"||item.import_policy_version!=="metadata-only-1"
            ||item.source_digest!==authorized.snapshot.source.source_digest||item.source_id!==authorized.logAdapterId
            ||!item.window_start_finite||!item.window_end_finite||!item.expires_at_finite
            ||!item.window_start_millisecond_aligned||!item.window_end_millisecond_aligned
            ||windowStart>windowEnd||!item.window_end_before_imported_at||!item.imported_at_before_db_now
            ||!uuid.test(item.import_id)||!uuid.test(item.record_id)
            ||!identifier(item.source_id)||!identifier(item.source_version)||!identifier(item.mapping_id)
            ||!(["GET","POST","PUT","PATCH","DELETE","HEAD","OPTIONS"] as unknown[]).includes(item.method)
            ||!Number.isInteger(item.status_code)||Number(item.status_code)<100||Number(item.status_code)>599
            ||compiled.policy.direction==="response"&&item.status_code!==compiled.policy.statusCode)
            return txFail("FIELD_PRESENCE_QUERY_STORAGE_ERROR");
          return Object.freeze({importId:item.import_id,recordId:item.record_id,source:Object.freeze({sourceId:item.source_id,
            sourceVersion:item.source_version,windowStart,windowEnd,importedAt,expiresAt}),
            scope:Object.freeze({sourceDigest:item.source_digest,endpointId:compiled.policy.endpointId,direction:compiled.policy.direction,
              mediaType:compiled.policy.mediaType,...(compiled.policy.statusCode===undefined?{}:{statusCode:compiled.policy.statusCode})}),fields});
        });
        return Object.freeze({status:"resolved" as const,kind:"observed_field_presence" as const,nonNormative:true as const,
          pin:Object.freeze({tenantId:pin.tenantId,repositoryId:pin.repositoryId,serviceId:pin.serviceId,environment:pin.environment,
          snapshotId:pin.snapshotId,revision:pin.revision,configFingerprint:pin.configFingerprint,
          checkpointVersion:pin.checkpointVersion,sourceDigest:authorized.snapshot.source.source_digest}),policy:Object.freeze({policyId:binding.policyId,
          ownerPolicyRevision:compiled.policy.ownerPolicyRevision,policyFingerprint:compiled.fingerprint,
          configActivationCheckpoint:compiled.policy.configActivationCheckpoint,endpointId:compiled.policy.endpointId,
          direction:compiled.policy.direction,mediaType:compiled.policy.mediaType,
          ...(compiled.policy.statusCode===undefined?{}:{statusCode:compiled.policy.statusCode}),propertyPaths:compiled.policy.propertyPaths}),
          records:Object.freeze(records),truncated});
      },{additionalScopeIds:[binding.ownerAccessScopeId,binding.readAccessScopeId],requireUnqualifiedPin:true,boundedTransaction:true});
    }catch(error){return mapError(error);}
  }});
};
const pinIdentity=(identity:Identity)=>Object.freeze({tenantId:identity.tenantId,principalId:identity.principalId,capabilities:identity.capabilities});
