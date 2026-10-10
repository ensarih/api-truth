import {isProxy} from "node:util/types";
import type {Pool} from "pg";
import {quoteEnvironmentSchema} from "../../environment/src/migrations.js";
import type {FieldPresenceOwnerBinding} from "./field-presence-owner-store.js";

export type FieldPresenceMaintenanceManager=(credential:unknown,binding:FieldPresenceOwnerBinding,signal:AbortSignal)=>Promise<unknown>;
export type FieldPresenceMaintenanceOptions=Readonly<{schema:string;bindings:readonly FieldPresenceOwnerBinding[];
  authorizeManager:FieldPresenceMaintenanceManager}>;
export type FieldPresenceMaintenanceErrorCode="FIELD_PRESENCE_MAINTENANCE_INVALID_CONFIGURATION"
  |"FIELD_PRESENCE_MAINTENANCE_INVALID_REQUEST"|"FIELD_PRESENCE_MAINTENANCE_UNAUTHORIZED"
  |"FIELD_PRESENCE_MAINTENANCE_STORAGE_ERROR";
export class FieldPresenceMaintenanceError extends Error {
  readonly code:FieldPresenceMaintenanceErrorCode;
  constructor(code:FieldPresenceMaintenanceErrorCode){super(code);this.name="FieldPresenceMaintenanceError";this.code=code;}
}
const fail=(code:FieldPresenceMaintenanceErrorCode):never=>{throw new FieldPresenceMaintenanceError(code);};
const fields=(input:unknown,keys:readonly string[]):Record<string,unknown>|undefined=>{
  try{
    if(!input||typeof input!=="object"||isProxy(input)||Array.isArray(input)
      ||![Object.prototype,null].includes(Object.getPrototypeOf(input)))return undefined;
    const own=Reflect.ownKeys(input);
    if(own.length!==keys.length||own.some(key=>typeof key!=="string"||!keys.includes(key)))return undefined;
    const result:Record<string,unknown>={};
    for(const key of keys){const descriptor=Object.getOwnPropertyDescriptor(input,key);
      if(!descriptor||!descriptor.enumerable||!("value" in descriptor))return undefined;
      Object.defineProperty(result,key,{value:descriptor.value,enumerable:true});}
    return result;
  }catch{return undefined;}
};
const array=(input:unknown,max:number):unknown[]|undefined=>{
  try{
    if(isProxy(input)||!Array.isArray(input)||Object.getPrototypeOf(input)!==Array.prototype||input.length>max
      ||Reflect.ownKeys(input).length!==input.length+1)return undefined;
    const result:unknown[]=[];
    for(let i=0;i<input.length;i++){const descriptor=Object.getOwnPropertyDescriptor(input,String(i));
      if(!descriptor||!descriptor.enumerable||!("value" in descriptor))return undefined;result.push(descriptor.value);}
    return result;
  }catch{return undefined;}
};
const name=(value:unknown):value is string=>typeof value==="string"&&value.length>0&&value.length<=128
  &&/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
const scopeKeys=["tenantId","repositoryId","serviceId","environment","policyId"] as const;
const bindingKeys=[...scopeKeys,"ownerAccessScopeId"] as const;
const key=(value:Record<string,unknown>)=>JSON.stringify(scopeKeys.map(part=>value[part]));
const authorize=async(callback:FieldPresenceMaintenanceManager,credential:unknown,binding:FieldPresenceOwnerBinding)=>{
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
  try{
    const result=await Promise.race([Promise.resolve().then(()=>callback(credential,binding,controller.signal)),
      new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error("deadline"));},10_000);})]);
    const identity=fields(result,["tenantId","principalId","capabilities"]),capabilities=array(identity?.capabilities,16);
    if(!identity||identity.tenantId!==binding.tenantId||!name(identity.principalId)||!capabilities
      ||!capabilities.includes("observations.presence.cleanup")||capabilities.some(value=>!name(value))
      ||new Set(capabilities).size!==capabilities.length)return fail("FIELD_PRESENCE_MAINTENANCE_UNAUTHORIZED");
    return Object.freeze({tenantId:binding.tenantId,principalId:identity.principalId});
  }catch{return fail("FIELD_PRESENCE_MAINTENANCE_UNAUTHORIZED");}
  finally{if(timer!==undefined)clearTimeout(timer);}
};

/** Authorized, bounded physical deletion; no source or traffic read and no tombstone pruning. */
export const createFieldPresenceMaintenanceStore=(pool:Pool,input:FieldPresenceMaintenanceOptions)=>{
  const options=fields(input,["schema","bindings","authorizeManager"]);let schemaSql:string;
  try{schemaSql=quoteEnvironmentSchema(options?.schema as string);}catch{return fail("FIELD_PRESENCE_MAINTENANCE_INVALID_CONFIGURATION");}
  const rawBindings=array(options?.bindings,128);
  if(!options||!rawBindings||typeof options.authorizeManager!=="function"||isProxy(options.authorizeManager))
    return fail("FIELD_PRESENCE_MAINTENANCE_INVALID_CONFIGURATION");
  const bindings=new Map<string,FieldPresenceOwnerBinding>();
  for(const raw of rawBindings){const parsed=fields(raw,bindingKeys);
    if(!parsed||bindingKeys.some(part=>!name(parsed[part]))||bindings.has(key(parsed)))
      return fail("FIELD_PRESENCE_MAINTENANCE_INVALID_CONFIGURATION");
    bindings.set(key(parsed),Object.freeze(parsed) as unknown as FieldPresenceOwnerBinding);}
  const fixedAuthorize=options.authorizeManager as FieldPresenceMaintenanceManager;
  return Object.freeze({async cleanup(credential:unknown,requestInput:unknown):Promise<Readonly<{removed:number}>>{
    const request=fields(requestInput,[...scopeKeys,"limit"]);
    if(!request||scopeKeys.some(part=>!name(request[part]))||!Number.isInteger(request.limit)
      ||Number(request.limit)<1||Number(request.limit)>100)return fail("FIELD_PRESENCE_MAINTENANCE_INVALID_REQUEST");
    const binding=bindings.get(key(request));
    if(!binding)return fail("FIELD_PRESENCE_MAINTENANCE_UNAUTHORIZED");
    const limit=Number(request.limit),identity=await authorize(fixedAuthorize,credential,binding);
    const client=await pool.connect().catch(()=>fail("FIELD_PRESENCE_MAINTENANCE_STORAGE_ERROR"));
    try{
      await client.query("BEGIN");await client.query(`SET LOCAL search_path TO ${schemaSql}, pg_catalog`);
      await client.query("SET LOCAL statement_timeout='10000ms'");await client.query("SET LOCAL lock_timeout='10000ms'");
      await client.query("SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1,0))",
        [JSON.stringify(["api-truth:environment-serving",binding.tenantId,binding.repositoryId,binding.serviceId,binding.environment])]);
      const scopes=await client.query(`SELECT active FROM access_scopes WHERE tenant_id=$1 AND access_scope_id=$2 FOR SHARE`,
        [binding.tenantId,binding.ownerAccessScopeId]);
      const grants=await client.query(`SELECT active FROM principal_scope_grants WHERE tenant_id=$1 AND principal_id=$2
        AND access_scope_id=$3 FOR SHARE`,[binding.tenantId,identity.principalId,binding.ownerAccessScopeId]);
      if(scopes.rows.length!==1||scopes.rows[0].active!==true||grants.rows.length!==1||grants.rows[0].active!==true)
        return fail("FIELD_PRESENCE_MAINTENANCE_UNAUTHORIZED");
      const params=[binding.tenantId,binding.repositoryId,binding.serviceId,binding.environment,binding.policyId];
      const head=await client.query(`SELECT head.current_owner_policy_revision::text,head.current_policy_fingerprint,head.enabled,
        revision.owner_access_scope_id FROM observation_field_presence_policy_heads head
        JOIN observation_field_presence_policy_revisions revision USING(tenant_id,repository_id,service_id,environment,policy_id)
        WHERE head.tenant_id=$1 AND head.repository_id=$2 AND head.service_id=$3 AND head.environment=$4 AND head.policy_id=$5
          AND revision.owner_policy_revision=head.current_owner_policy_revision
          AND revision.policy_fingerprint=head.current_policy_fingerprint FOR UPDATE OF head`,params);
      if(head.rows.length!==1||head.rows[0].owner_access_scope_id!==binding.ownerAccessScopeId)
        return fail("FIELD_PRESENCE_MAINTENANCE_UNAUTHORIZED");
      // Head first, then result rows: matches import, opt-out and deletion lock ordering.
      const candidates=await client.query<{owner_policy_revision:string;import_id:string;record_id:string}>(
        `SELECT result.owner_policy_revision::text,result.import_id::text,result.record_id::text
         FROM observation_field_presence_results result JOIN observation_field_presence_policy_revisions revision
           USING(tenant_id,repository_id,service_id,environment,policy_id,owner_policy_revision,policy_fingerprint)
         WHERE result.tenant_id=$1 AND result.repository_id=$2 AND result.service_id=$3 AND result.environment=$4 AND result.policy_id=$5
           AND revision.owner_access_scope_id=$6 AND (result.expires_at<=clock_timestamp() OR $7::boolean=false
             OR result.owner_policy_revision<>$8::bigint OR result.policy_fingerprint<>$9)
         ORDER BY result.expires_at,result.owner_policy_revision,result.import_id,result.record_id LIMIT $10 FOR UPDATE OF result`,
        [...params,binding.ownerAccessScopeId,head.rows[0].enabled,head.rows[0].current_owner_policy_revision,
          head.rows[0].current_policy_fingerprint,limit]);
      let removed=0;
      for(const candidate of candidates.rows){const deletion=await client.query<{removed:boolean}>(
        `SELECT observation_field_presence_delete($1,$2,$3,$4,$5,$6::bigint,$7::uuid,$8::uuid) AS removed`,
        [...params,candidate.owner_policy_revision,candidate.import_id,candidate.record_id]);
        if(deletion.rows[0]?.removed===true)removed+=1;}
      await client.query("COMMIT");return Object.freeze({removed});
    }catch(error){await client.query("ROLLBACK").catch(()=>undefined);
      if(error instanceof FieldPresenceMaintenanceError)throw error;
      return fail("FIELD_PRESENCE_MAINTENANCE_STORAGE_ERROR");}
    finally{client.release();}
  }});
};
