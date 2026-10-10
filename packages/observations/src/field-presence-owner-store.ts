import {isProxy} from "node:util/types";
import type {Pool} from "pg";
import {quoteEnvironmentSchema} from "../../environment/src/migrations.js";
import {projectObservedFieldPresence} from "./field-presence.js";
import {compileFieldPresenceStoragePolicy,type CompiledFieldPresenceStoragePolicy,type FieldPresenceStoragePolicy}
  from "./field-presence-storage-policy.js";
import {ObservationImportError,withAuthorizedObservationPin,type ExpectedObservationPin}
  from "./store.js";

export type FieldPresenceOwnerBinding=Readonly<{tenantId:string;repositoryId:string;serviceId:string;environment:string;
  policyId:string;ownerAccessScopeId:string}>;
export type FieldPresenceOwnerManager=(credential:unknown,binding:FieldPresenceOwnerBinding,signal:AbortSignal)=>Promise<unknown>;
export type FieldPresenceOwnerStoreOptions=Readonly<{schema:string;bindings:readonly FieldPresenceOwnerBinding[];
  authorizeManager:FieldPresenceOwnerManager}>;
export type FieldPresenceOwnerStoreErrorCode="FIELD_PRESENCE_POLICY_INVALID_CONFIGURATION"|"FIELD_PRESENCE_POLICY_INVALID_REQUEST"
  |"FIELD_PRESENCE_POLICY_UNAUTHORIZED"|"FIELD_PRESENCE_POLICY_STALE"|"FIELD_PRESENCE_POLICY_CONFLICT"
  |"FIELD_PRESENCE_POLICY_UNSUPPORTED"|"FIELD_PRESENCE_POLICY_STORAGE_ERROR";

export class FieldPresenceOwnerStoreError extends Error {
  readonly code:FieldPresenceOwnerStoreErrorCode;
  constructor(code:FieldPresenceOwnerStoreErrorCode){super(code);this.name="FieldPresenceOwnerStoreError";this.code=code;}
}
const fail=(code:FieldPresenceOwnerStoreErrorCode):never=>{throw new FieldPresenceOwnerStoreError(code);};
const plain=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==="object"&&!isProxy(value)
  &&!Array.isArray(value)&&(Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null);
const fields=(input:unknown,keys:readonly string[]):Record<string,unknown>|undefined=>{
  try{if(!plain(input))return undefined;const own=Reflect.ownKeys(input);
    if(own.length!==keys.length||own.some(key=>typeof key!=="string"||!keys.includes(key)))return undefined;
    const output:Record<string,unknown>={};for(const key of keys){const descriptor=Object.getOwnPropertyDescriptor(input,key);
      if(!descriptor||!descriptor.enumerable||!("value" in descriptor))return undefined;
      Object.defineProperty(output,key,{value:descriptor.value,enumerable:true,writable:true,configurable:true});}
    return output;}catch{return undefined;}
};
const arrayValues=(input:unknown,max:number):unknown[]|undefined=>{
  try{if(isProxy(input)||!Array.isArray(input)||Object.getPrototypeOf(input)!==Array.prototype||input.length>max
    ||Reflect.ownKeys(input).length!==input.length+1)return undefined;
    const output:unknown[]=[];for(let i=0;i<input.length;i++){const descriptor=Object.getOwnPropertyDescriptor(input,String(i));
      if(!descriptor||!descriptor.enumerable||!("value" in descriptor))return undefined;output.push(descriptor.value);}
    return output;}catch{return undefined;}
};
const name=(value:unknown):value is string=>typeof value==="string"&&value.length>0&&value.length<=128
  &&/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
const revision=(value:unknown):value is string=>typeof value==="string"&&/^(?:0|[1-9][0-9]{0,18})$/.test(value)
  &&BigInt(value)<=9223372036854775807n;
const digest=/^sha256:[0-9a-f]{64}$/;
const bindingKeys=["tenantId","repositoryId","serviceId","environment","policyId","ownerAccessScopeId"] as const;
const bindingValue=(input:unknown):FieldPresenceOwnerBinding|undefined=>{
  const raw=fields(input,bindingKeys);
  if(!raw||!bindingKeys.every(key=>name(raw[key])))return undefined;
  return Object.freeze({tenantId:raw.tenantId as string,repositoryId:raw.repositoryId as string,serviceId:raw.serviceId as string,
    environment:raw.environment as string,policyId:raw.policyId as string,ownerAccessScopeId:raw.ownerAccessScopeId as string});
};
const bindingKey=(binding:FieldPresenceOwnerBinding)=>JSON.stringify([binding.tenantId,binding.repositoryId,binding.serviceId,
  binding.environment,binding.policyId]);

const withDeadline=async<T>(callback:(signal:AbortSignal)=>Promise<T>):Promise<T>=>{
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
  const timedOut=Symbol("owner_authorization_timeout");
  const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(timedOut);},10_000);});
  try{return await Promise.race([Promise.resolve().then(()=>callback(controller.signal)),timeout]);}
  finally{if(timer!==undefined)clearTimeout(timer);}
};

type ManagerIdentity=Readonly<{tenantId:string;principalId:string;capabilities:readonly string[]}>;
const managerIdentity=(input:unknown,tenantId:string):ManagerIdentity|undefined=>{
  const raw=fields(input,["tenantId","principalId","capabilities"]),capabilities=arrayValues(raw?.capabilities,16);
  if(!raw||raw.tenantId!==tenantId||!name(raw.principalId)||!capabilities||!capabilities.includes("observations.policy.manage")
    ||capabilities.length===0||capabilities.some(value=>!name(value))||new Set(capabilities).size!==capabilities.length)return undefined;
  return Object.freeze({tenantId,principalId:raw.principalId as string,capabilities:Object.freeze(capabilities as string[])});
};
class TransactionFailure extends ObservationImportError {
  readonly ownerCode:FieldPresenceOwnerStoreErrorCode;
  constructor(code:FieldPresenceOwnerStoreErrorCode){super("OBSERVATION_STORAGE_ERROR");this.ownerCode=code;}
}
const mapTransactionError=(error:unknown):never=>{
  if(error instanceof TransactionFailure)return fail(error.ownerCode);
  if(error instanceof ObservationImportError){
    if(error.code==="OBSERVATION_NOT_AUTHORIZED")return fail("FIELD_PRESENCE_POLICY_UNAUTHORIZED");
    if(error.code==="OBSERVATION_STALE_PIN")return fail("FIELD_PRESENCE_POLICY_STALE");
  }
  return fail("FIELD_PRESENCE_POLICY_STORAGE_ERROR");
};
const transactionFail=(code:FieldPresenceOwnerStoreErrorCode):never=>{throw new TransactionFailure(code);};

type PolicyRow={owner_policy_revision:string;policy_fingerprint:string;config_fingerprint:string;config_activation_checkpoint:string;
  endpoint_id:string;direction:"request"|"response";media_type:string;status_code:number|null;property_paths:string[];
  ttl_seconds:number;max_live_records:number;owner_access_scope_id:string};
type HeadRow=PolicyRow&{current_owner_policy_revision:string;current_policy_fingerprint:string;enabled:boolean};
const policyMatchesRow=(compiled:CompiledFieldPresenceStoragePolicy,row:PolicyRow,binding:FieldPresenceOwnerBinding):boolean=>{
  const policy=compiled.policy;
  return row.owner_policy_revision===policy.ownerPolicyRevision&&row.policy_fingerprint===compiled.fingerprint
    &&row.config_fingerprint===policy.configFingerprint&&row.config_activation_checkpoint===policy.configActivationCheckpoint
    &&row.endpoint_id===policy.endpointId&&row.direction===policy.direction&&row.media_type===policy.mediaType
    &&row.status_code===(policy.statusCode??null)&&JSON.stringify(row.property_paths)===JSON.stringify(policy.propertyPaths)
    &&row.ttl_seconds===policy.ttlSeconds&&row.max_live_records===policy.maxLiveRecords
    &&row.owner_access_scope_id===binding.ownerAccessScopeId;
};
const expectedPin=(binding:FieldPresenceOwnerBinding,policy:FieldPresenceStoragePolicy,input:unknown):ExpectedObservationPin|undefined=>{
  const raw=fields(input,["snapshotId","revision","checkpointVersion"]);
  if(!raw||![raw.snapshotId,raw.revision].every(name)||!revision(raw.checkpointVersion)||BigInt(raw.checkpointVersion as string)===0n)return undefined;
  return Object.freeze({tenantId:binding.tenantId,repositoryId:binding.repositoryId,serviceId:binding.serviceId,
    environment:binding.environment,snapshotId:raw.snapshotId as string,revision:raw.revision as string,
    configFingerprint:policy.configFingerprint,checkpointVersion:raw.checkpointVersion});
};
const parseExpectedOwnerRevision=(input:unknown):string|undefined=>revision(input)?input:undefined;

export const createFieldPresenceOwnerPolicyStore=(pool:Pool,optionsInput:FieldPresenceOwnerStoreOptions)=>{
  const raw=fields(optionsInput,["schema","bindings","authorizeManager"]);
  let schemaSql:string;
  try{schemaSql=quoteEnvironmentSchema(raw?.schema as string);}catch{return fail("FIELD_PRESENCE_POLICY_INVALID_CONFIGURATION");}
  const rawBindings=arrayValues(raw?.bindings,128);
  if(!raw||!rawBindings||typeof raw.authorizeManager!=="function"||isProxy(raw.authorizeManager))
    return fail("FIELD_PRESENCE_POLICY_INVALID_CONFIGURATION");
  const bindings=rawBindings.map(bindingValue);
  if(bindings.some(binding=>binding===undefined))return fail("FIELD_PRESENCE_POLICY_INVALID_CONFIGURATION");
  const configured=bindings as FieldPresenceOwnerBinding[];
  const byKey=new Map(configured.map(binding=>[bindingKey(binding),binding]));
  if(byKey.size!==configured.length)return fail("FIELD_PRESENCE_POLICY_INVALID_CONFIGURATION");
  const fixedAuthorize=raw.authorizeManager as FieldPresenceOwnerManager;
  const authorize=async(credential:unknown,binding:FieldPresenceOwnerBinding):Promise<ManagerIdentity>=>{
    let result:unknown;
    try{result=await withDeadline(signal=>fixedAuthorize(credential,binding,signal));}catch{return fail("FIELD_PRESENCE_POLICY_UNAUTHORIZED");}
    const identity=managerIdentity(result,binding.tenantId);
    if(!identity)return fail("FIELD_PRESENCE_POLICY_UNAUTHORIZED");
    return identity;
  };
  const findRequestBinding=(input:unknown,keys:readonly string[]):{raw:Record<string,unknown>;binding:FieldPresenceOwnerBinding}=>{
    const request=fields(input,keys);
    if(!request||!["tenantId","repositoryId","serviceId","environment","policyId"].every(key=>name(request[key])))
      return fail("FIELD_PRESENCE_POLICY_INVALID_REQUEST");
    const binding=byKey.get(bindingKey({tenantId:request.tenantId as string,repositoryId:request.repositoryId as string,
      serviceId:request.serviceId as string,environment:request.environment as string,policyId:request.policyId as string,
      ownerAccessScopeId:"unused"}));
    if(!binding)return fail("FIELD_PRESENCE_POLICY_UNAUTHORIZED");
    return {raw:request,binding};
  };

  return Object.freeze({
    async approve(credential:unknown,input:unknown):Promise<Readonly<{status:"approved"|"existing";policyId:string;
      ownerPolicyRevision:string;policyFingerprint:string;enabled:true}>>{
      const outer=fields(input,["policy","expectedOwnerRevision","expectedPin"]);
      if(!outer||!revision(outer.expectedOwnerRevision))return fail("FIELD_PRESENCE_POLICY_INVALID_REQUEST");
      let compiled:CompiledFieldPresenceStoragePolicy;
      try{compiled=compileFieldPresenceStoragePolicy(outer.policy);}catch{return fail("FIELD_PRESENCE_POLICY_INVALID_REQUEST");}
      const policy=compiled.policy;
      const binding=byKey.get(bindingKey({tenantId:policy.tenantId,repositoryId:policy.repositoryId,serviceId:policy.serviceId,
        environment:policy.environment,policyId:policy.policyId,ownerAccessScopeId:"unused"}));
      if(!binding)return fail("FIELD_PRESENCE_POLICY_UNAUTHORIZED");
      const pin=expectedPin(binding,policy,outer.expectedPin);
      if(!pin)return fail("FIELD_PRESENCE_POLICY_INVALID_REQUEST");
      const identity=await authorize(credential,binding);
      try{return await withAuthorizedObservationPin(pool,schemaSql,raw.schema as string,
        {...identity},pin,async(client,authorized)=>{
        const snapshot=authorized.snapshot;
        if(snapshot.snapshot_id!==pin.snapshotId||snapshot.source.immutable_revision!==pin.revision
          ||snapshot.config.config_fingerprint!==policy.configFingerprint)
          return transactionFail("FIELD_PRESENCE_POLICY_STALE");
        const preflight=projectObservedFieldPresence({pin:{state:"resolved_single_revision",tenantId:binding.tenantId,
          repositoryId:binding.repositoryId,serviceId:binding.serviceId,environment:binding.environment,snapshotId:pin.snapshotId,
          revision:pin.revision,configFingerprint:policy.configFingerprint,
          checkpointVersion:pin.checkpointVersion},snapshot,policy:{version:"observed-field-presence-1",policyId:policy.policyId,
          tenantId:policy.tenantId,repositoryId:policy.repositoryId,serviceId:policy.serviceId,environment:policy.environment,
          snapshotId:pin.snapshotId,revision:pin.revision,sourceDigest:snapshot.source.source_digest,
          configFingerprint:policy.configFingerprint,checkpointVersion:pin.checkpointVersion,endpointId:policy.endpointId,
          direction:policy.direction,mediaType:policy.mediaType,propertyPaths:policy.propertyPaths,
          ...(policy.statusCode===undefined?{}:{statusCode:policy.statusCode})},payloadText:"{}",payloadCompleteness:"complete_unredacted"});
        if(preflight.status!=="projected")return transactionFail("FIELD_PRESENCE_POLICY_UNSUPPORTED");
        const params=[binding.tenantId,binding.repositoryId,binding.serviceId,binding.environment,binding.policyId];
        const heads=await client.query<HeadRow>(`SELECT head.current_owner_policy_revision::text,head.current_policy_fingerprint,
          head.enabled,revision.owner_policy_revision::text,revision.policy_fingerprint,revision.config_fingerprint,
          revision.config_activation_checkpoint::text,revision.endpoint_id,revision.direction,revision.media_type,
          revision.status_code,revision.property_paths,revision.ttl_seconds,revision.max_live_records,revision.owner_access_scope_id
          FROM observation_field_presence_policy_heads head JOIN observation_field_presence_policy_revisions revision
            ON revision.tenant_id=head.tenant_id AND revision.repository_id=head.repository_id AND revision.service_id=head.service_id
            AND revision.environment=head.environment AND revision.policy_id=head.policy_id
            AND revision.owner_policy_revision=head.current_owner_policy_revision
            AND revision.policy_fingerprint=head.current_policy_fingerprint
          WHERE head.tenant_id=$1 AND head.repository_id=$2 AND head.service_id=$3 AND head.environment=$4 AND head.policy_id=$5
          FOR UPDATE OF head`,params);
        const current=heads.rows[0];
        const expected=BigInt(outer.expectedOwnerRevision as string),next=expected+1n;
        if(current){
          if(current.owner_access_scope_id!==binding.ownerAccessScopeId)return transactionFail("FIELD_PRESENCE_POLICY_CONFLICT");
          if(current.current_owner_policy_revision===policy.ownerPolicyRevision&&current.current_policy_fingerprint===compiled.fingerprint
            &&current.enabled&&expected+1n===BigInt(policy.ownerPolicyRevision)&&policyMatchesRow(compiled,current,binding))
            return Object.freeze({status:"existing",policyId:binding.policyId,ownerPolicyRevision:policy.ownerPolicyRevision,
              policyFingerprint:compiled.fingerprint,enabled:true as const});
          if(BigInt(current.current_owner_policy_revision)!==expected||BigInt(policy.ownerPolicyRevision)!==next)
            return transactionFail("FIELD_PRESENCE_POLICY_CONFLICT");
        }else{
          const prior=await client.query(`SELECT 1 FROM observation_field_presence_policy_revisions WHERE tenant_id=$1
            AND repository_id=$2 AND service_id=$3 AND environment=$4 AND policy_id=$5 LIMIT 1`,params);
          if(prior.rows.length||expected!==0n||BigInt(policy.ownerPolicyRevision)!==1n)
            return transactionFail("FIELD_PRESENCE_POLICY_CONFLICT");
        }
        await client.query(`INSERT INTO observation_field_presence_policy_revisions
          (tenant_id,repository_id,service_id,environment,policy_id,owner_policy_revision,policy_fingerprint,
           config_fingerprint,config_activation_checkpoint,endpoint_id,direction,media_type,status_code,property_paths,
           ttl_seconds,max_live_records,owner_access_scope_id)
          VALUES($1,$2,$3,$4,$5,$6::bigint,$7,$8,$9::bigint,$10,$11,$12,$13,$14::text[],$15,$16,$17)`,
        [binding.tenantId,binding.repositoryId,binding.serviceId,binding.environment,binding.policyId,policy.ownerPolicyRevision,
          compiled.fingerprint,policy.configFingerprint,policy.configActivationCheckpoint,policy.endpointId,policy.direction,
          policy.mediaType,policy.statusCode??null,policy.propertyPaths,policy.ttlSeconds,policy.maxLiveRecords,binding.ownerAccessScopeId]);
        if(current){
          await client.query(`UPDATE observation_field_presence_policy_heads SET current_owner_policy_revision=$6::bigint,
            current_policy_fingerprint=$7,enabled=true WHERE tenant_id=$1 AND repository_id=$2 AND service_id=$3
            AND environment=$4 AND policy_id=$5`,[...params,policy.ownerPolicyRevision,compiled.fingerprint]);
        }else{
          await client.query(`INSERT INTO observation_field_presence_policy_heads
            (tenant_id,repository_id,service_id,environment,policy_id,current_owner_policy_revision,current_policy_fingerprint,enabled)
            VALUES($1,$2,$3,$4,$5,$6::bigint,$7,true)`,[...params,policy.ownerPolicyRevision,compiled.fingerprint]);
        }
        return Object.freeze({status:"approved",policyId:binding.policyId,ownerPolicyRevision:policy.ownerPolicyRevision,
          policyFingerprint:compiled.fingerprint,enabled:true as const});
      },{configActivationCheckpoint:policy.configActivationCheckpoint,additionalScopeIds:[binding.ownerAccessScopeId]});}
      catch(error){return mapTransactionError(error);}
    },
    async disable(credential:unknown,input:unknown):Promise<Readonly<{status:"disabled";policyId:string;ownerPolicyRevision:string;enabled:false}>>{
      const parsed=findRequestBinding(input,["tenantId","repositoryId","serviceId","environment","policyId","expectedOwnerRevision"]);
      const expected=parseExpectedOwnerRevision(parsed.raw.expectedOwnerRevision);
      if(expected===undefined)return fail("FIELD_PRESENCE_POLICY_INVALID_REQUEST");
      const identity=await authorize(credential,parsed.binding);
      let client;
      try{client=await pool.connect();}catch{return fail("FIELD_PRESENCE_POLICY_STORAGE_ERROR");}
      try{
        await client.query("BEGIN");await client.query(`SET LOCAL search_path TO ${schemaSql}, pg_catalog`);
        await client.query("SET LOCAL statement_timeout='10000ms'");await client.query("SET LOCAL lock_timeout='10000ms'");
        await client.query("SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1,0))",
          [JSON.stringify(["api-truth:environment-serving",parsed.binding.tenantId,parsed.binding.repositoryId,
            parsed.binding.serviceId,parsed.binding.environment])]);
        const scopes=await client.query(`SELECT access_scope_id,active FROM access_scopes WHERE tenant_id=$1
          AND access_scope_id=$2 FOR SHARE`,[parsed.binding.tenantId,parsed.binding.ownerAccessScopeId]);
        const grants=await client.query(`SELECT access_scope_id,active FROM principal_scope_grants WHERE tenant_id=$1
          AND principal_id=$2 AND access_scope_id=$3 FOR SHARE`,[parsed.binding.tenantId,identity.principalId,parsed.binding.ownerAccessScopeId]);
        if(scopes.rows.length!==1||scopes.rows[0]?.active!==true||grants.rows.length!==1||grants.rows[0]?.active!==true)
          return transactionFail("FIELD_PRESENCE_POLICY_UNAUTHORIZED");
        const heads=await client.query<Pick<HeadRow,"current_owner_policy_revision"|"current_policy_fingerprint"|"enabled"|"owner_access_scope_id">>(
          `SELECT head.current_owner_policy_revision::text,head.current_policy_fingerprint,head.enabled,revision.owner_access_scope_id
           FROM observation_field_presence_policy_heads head JOIN observation_field_presence_policy_revisions revision
             ON revision.tenant_id=head.tenant_id AND revision.repository_id=head.repository_id AND revision.service_id=head.service_id
             AND revision.environment=head.environment AND revision.policy_id=head.policy_id
             AND revision.owner_policy_revision=head.current_owner_policy_revision
             AND revision.policy_fingerprint=head.current_policy_fingerprint
           WHERE head.tenant_id=$1 AND head.repository_id=$2 AND head.service_id=$3 AND head.environment=$4 AND head.policy_id=$5
           FOR UPDATE OF head`,[parsed.binding.tenantId,parsed.binding.repositoryId,parsed.binding.serviceId,
            parsed.binding.environment,parsed.binding.policyId]);
        const current=heads.rows[0];
        if(!current||current.owner_access_scope_id!==parsed.binding.ownerAccessScopeId
          ||current.current_owner_policy_revision!==expected)return transactionFail("FIELD_PRESENCE_POLICY_CONFLICT");
        if(current.enabled){
          const updated=await client.query(`UPDATE observation_field_presence_policy_heads SET enabled=false
            WHERE tenant_id=$1 AND repository_id=$2 AND service_id=$3 AND environment=$4 AND policy_id=$5
              AND current_owner_policy_revision=$6::bigint AND current_policy_fingerprint=$7`,
          [parsed.binding.tenantId,parsed.binding.repositoryId,parsed.binding.serviceId,parsed.binding.environment,
            parsed.binding.policyId,current.current_owner_policy_revision,current.current_policy_fingerprint]);
          if(updated.rowCount!==1)return transactionFail("FIELD_PRESENCE_POLICY_CONFLICT");
        }
        await client.query("COMMIT");
        return Object.freeze({status:"disabled",policyId:parsed.binding.policyId,
          ownerPolicyRevision:current.current_owner_policy_revision,enabled:false as const});
      }catch(error){await client.query("ROLLBACK").catch(()=>undefined);return mapTransactionError(error);}
      finally{client.release();}
    },
  });
};
