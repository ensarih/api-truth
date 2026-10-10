import {isProxy} from "node:util/types";
import type {FieldPresenceOwnerBinding} from "./field-presence-owner-store.js";
import type {createFieldPresenceMaintenanceStore} from "./field-presence-maintenance-store.js";

export type FieldPresenceMaintenanceSummary=Readonly<{status:"completed"|"busy"|"stopped";attempted:number;succeeded:number;failed:number}>;
export type FieldPresenceMaintenanceRunnerOptions=Readonly<{
  maintenance:Pick<ReturnType<typeof createFieldPresenceMaintenanceStore>,"cleanup">;
  bindings:readonly FieldPresenceOwnerBinding[];
  credentialForBinding:(binding:FieldPresenceOwnerBinding,signal:AbortSignal)=>Promise<unknown>;
  intervalMs?:number;policiesPerTick?:number;batchLimit?:number;
  onSummary?:(summary:FieldPresenceMaintenanceSummary)=>void;
}>;
const configError=()=>{throw new TypeError("INVALID_FIELD_PRESENCE_MAINTENANCE_RUNNER_CONFIGURATION");};
const read=(input:unknown,keys:readonly string[]):Record<string,unknown>|undefined=>{
  try{
    if(!input||typeof input!=="object"||isProxy(input)||Array.isArray(input)
      ||![Object.prototype,null].includes(Object.getPrototypeOf(input)))return undefined;
    const own=Reflect.ownKeys(input);if(own.length!==keys.length||own.some(key=>typeof key!=="string"||!keys.includes(key)))return undefined;
    const result:Record<string,unknown>={};
    for(const key of keys){const descriptor=Object.getOwnPropertyDescriptor(input,key);
      if(!descriptor||!descriptor.enumerable||!("value" in descriptor))return undefined;
      Object.defineProperty(result,key,{value:descriptor.value,enumerable:true});}
    return result;
  }catch{return undefined;}
};
const readOptions=(input:unknown):Record<string,unknown>|undefined=>{
  try{
    const required=["maintenance","bindings","credentialForBinding"],optional=["intervalMs","policiesPerTick","batchLimit","onSummary"];
    if(!input||typeof input!=="object"||isProxy(input)||Array.isArray(input)
      ||![Object.prototype,null].includes(Object.getPrototypeOf(input)))return undefined;
    const own=Reflect.ownKeys(input);
    if(own.some(key=>typeof key!=="string"||![...required,...optional].includes(key))
      ||required.some(key=>!own.includes(key)))return undefined;
    const result:Record<string,unknown>={};
    for(const key of own as string[]){const descriptor=Object.getOwnPropertyDescriptor(input,key);
      if(!descriptor||!descriptor.enumerable||!("value" in descriptor))return undefined;
      Object.defineProperty(result,key,{value:descriptor.value,enumerable:true});}
    return result;
  }catch{return undefined;}
};
const readArray=(input:unknown,max:number):unknown[]|undefined=>{
  try{
    if(isProxy(input)||!Array.isArray(input)||Object.getPrototypeOf(input)!==Array.prototype||input.length>max
      ||Reflect.ownKeys(input).length!==input.length+1)return undefined;
    const output:unknown[]=[];
    for(let index=0;index<input.length;index++){const descriptor=Object.getOwnPropertyDescriptor(input,String(index));
      if(!descriptor||!descriptor.enumerable||!("value" in descriptor))return undefined;output.push(descriptor.value);}
    return output;
  }catch{return undefined;}
};
const validName=(value:unknown):value is string=>typeof value==="string"&&value.length>0&&value.length<=128
  &&/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
const scopeKeys=["tenantId","repositoryId","serviceId","environment","policyId","ownerAccessScopeId"] as const;
const identityKeys=["tenantId","repositoryId","serviceId","environment","policyId"] as const;
const bindingKey=(binding:Record<string,unknown>)=>JSON.stringify(identityKeys.map(key=>binding[key]));
const makeSummary=(status:FieldPresenceMaintenanceSummary["status"],attempted=0,succeeded=0,failed=0):FieldPresenceMaintenanceSummary=>
  Object.freeze({status,attempted,succeeded,failed});

/** Bounded in-process cleanup scheduler. The maintenance store remains the authority for every deletion. */
export const createFieldPresenceMaintenanceRunner=(input:FieldPresenceMaintenanceRunnerOptions)=>{
  const options=readOptions(input);
  if(!options)return configError();
  const maintenance=options.maintenance;
  if(!maintenance||typeof maintenance!=="object"||isProxy(maintenance))return configError();
  const cleanupDescriptor=Object.getOwnPropertyDescriptor(maintenance,"cleanup");
  if(!cleanupDescriptor||!("value" in cleanupDescriptor)||typeof cleanupDescriptor.value!=="function"
    ||isProxy(cleanupDescriptor.value))return configError();
  const cleanupMethod=cleanupDescriptor.value as (credential:unknown,request:unknown)=>Promise<unknown>;
  const cleanup=(credential:unknown,request:unknown)=>cleanupMethod.call(maintenance,credential,request);
  const credentialForBinding=options.credentialForBinding as FieldPresenceMaintenanceRunnerOptions["credentialForBinding"];
  if(typeof credentialForBinding!=="function"||isProxy(credentialForBinding))return configError();
  const onSummary=options.onSummary;
  if(onSummary!==undefined&&(typeof onSummary!=="function"||isProxy(onSummary)))return configError();
  const intervalMs=options.intervalMs===undefined?60_000:options.intervalMs as number,
    policiesPerTick=options.policiesPerTick===undefined?4:options.policiesPerTick as number,
    batchLimit=options.batchLimit===undefined?20:options.batchLimit as number;
  if(!Number.isSafeInteger(intervalMs)||intervalMs<60_000||intervalMs>86_400_000
    ||!Number.isInteger(policiesPerTick)||policiesPerTick<1||policiesPerTick>16
    ||!Number.isInteger(batchLimit)||batchLimit<1||batchLimit>100)return configError();
  const rawBindings=readArray(options.bindings,128);if(!rawBindings)return configError();
  const bindings:FieldPresenceOwnerBinding[]=[];const seen=new Set<string>();
  for(const raw of rawBindings){const binding=read(raw,scopeKeys);
    if(!binding||scopeKeys.some(key=>!validName(binding[key]))||seen.has(bindingKey(binding)))return configError();
    seen.add(bindingKey(binding));bindings.push(Object.freeze(binding) as unknown as FieldPresenceOwnerBinding);}
  const fixedBindings=Object.freeze(bindings.slice());

  let cursor=0,active=false,started=false,stopping=false,timer:ReturnType<typeof setTimeout>|undefined;
  let activeDone:Promise<void>|undefined,finishActive:(()=>void)|undefined;
  let stopPromise:Promise<void>|undefined;
  const cleanupDrain=new Set<Promise<unknown>>(),credentialControllers=new Set<AbortController>();
  const notify=(summary:FieldPresenceMaintenanceSummary)=>{
    try{void Promise.resolve(onSummary?.(summary)).catch(()=>undefined);}catch{/* Observer errors are isolated. */}
  };
  const obtainCredential=(binding:FieldPresenceOwnerBinding):Promise<{ok:true;credential:unknown}|{ok:false}>=>{
    const controller=new AbortController();credentialControllers.add(controller);let deadline:ReturnType<typeof setTimeout>|undefined;
    const timeout=new Promise<never>((_,reject)=>{deadline=setTimeout(()=>{controller.abort();reject(new Error("credential deadline"));},10_000);});
    let onAbort:(()=>void)|undefined;
    const aborted=new Promise<never>((_,reject)=>{onAbort=()=>reject(new Error("credential aborted"));
      controller.signal.addEventListener("abort",onAbort,{once:true});});
    return Promise.race([Promise.resolve().then(()=>controller.signal.aborted
      ?Promise.reject(new Error("credential aborted")):credentialForBinding(binding,controller.signal)),timeout,aborted])
      .then(credential=>controller.signal.aborted?{ok:false as const}:{ok:true as const,credential})
      .catch(()=>({ok:false as const})).finally(()=>{if(deadline!==undefined)clearTimeout(deadline);
        if(onAbort)controller.signal.removeEventListener("abort",onAbort);credentialControllers.delete(controller);});
  };
  const execute=async():Promise<FieldPresenceMaintenanceSummary>=>{
    if(active)return makeSummary("busy");
    if(stopping)return makeSummary("stopped");
    if(timer!==undefined){clearTimeout(timer);timer=undefined;}
    active=true;activeDone=new Promise(resolve=>{finishActive=resolve;});let attempted=0,succeeded=0,failed=0;
    try{
      const count=Math.min(policiesPerTick,fixedBindings.length);
      for(let offset=0;offset<count;offset++){
        if(stopping)break;
        const binding=fixedBindings[cursor%fixedBindings.length]!;cursor=(cursor+1)%fixedBindings.length;attempted++;
        const auth=await obtainCredential(binding);
        if(!auth.ok){failed++;continue;}
        if(stopping){failed++;continue;}
        let task:Promise<unknown>;
        try{task=Promise.resolve(cleanup(auth.credential,{tenantId:binding.tenantId,repositoryId:binding.repositoryId,
          serviceId:binding.serviceId,environment:binding.environment,policyId:binding.policyId,limit:batchLimit}));}
        catch{failed++;continue;}
        cleanupDrain.add(task);
        try{
          const result=await task,parsed=read(result,["removed"]);
          if(!parsed||!Number.isInteger(parsed.removed)||Number(parsed.removed)<0||Number(parsed.removed)>batchLimit)failed++;
          else succeeded++;
        }catch{failed++;}finally{cleanupDrain.delete(task);}
      }
      return makeSummary("completed",attempted,succeeded,failed);
    }finally{active=false;finishActive?.();finishActive=undefined;activeDone=undefined;schedule();}
  };
  const runOnce=async():Promise<FieldPresenceMaintenanceSummary>=>{
    if(active){const summary=makeSummary("busy");notify(summary);return summary;}
    if(stopping){const summary=makeSummary("stopped");notify(summary);return summary;}
    const summary=await execute();notify(summary);return summary;
  };
  const schedule=()=>{if(!started||stopping||timer!==undefined)return;
    if(active)return;
    timer=setTimeout(()=>{timer=undefined;void execute().then(notify,()=>notify(makeSummary("completed",0,0,1)));},intervalMs);};
  const start=():boolean=>{
    if(stopping||started)return false;started=true;schedule();return true;
  };
  const stop=():Promise<void>=>{
    if(stopPromise)return stopPromise;
    stopping=true;started=false;if(timer!==undefined){clearTimeout(timer);timer=undefined;}
    for(const controller of credentialControllers)controller.abort();
    stopPromise=(async()=>{
      const done=activeDone;if(done)await done;
      if(cleanupDrain.size)await Promise.allSettled([...cleanupDrain]);
    })().finally(()=>{stopping=false;stopPromise=undefined;});return stopPromise;
  };
  return Object.freeze({runOnce,start,stop});
};
