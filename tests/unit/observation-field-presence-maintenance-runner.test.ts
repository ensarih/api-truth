import {afterEach,expect,test,vi} from "vitest";
import {createFieldPresenceMaintenanceRunner} from "../../packages/observations/src/field-presence-maintenance-runner.js";
import type {FieldPresenceOwnerBinding} from "../../packages/observations/src/field-presence-owner-store.js";

const bindings=(count:number):FieldPresenceOwnerBinding[]=>Array.from({length:count},(_,index)=>Object.freeze({
  tenantId:"tenant-a",repositoryId:"repo-a",serviceId:"service-a",environment:"uat",policyId:`policy-${index}`,
  ownerAccessScopeId:`owner-${index}`}));
const maintenance=(cleanup:unknown)=>({cleanup});
const create=(overrides:Record<string,unknown>={})=>{
  const calls:unknown[]=[];const cleanup=vi.fn(async(_credential:unknown,request:unknown)=>{calls.push(request);return{removed:1};});
  const credentialForBinding=vi.fn(async(binding:FieldPresenceOwnerBinding)=>({for:binding.policyId}));
  const runner=createFieldPresenceMaintenanceRunner({maintenance:maintenance(cleanup) as never,bindings:bindings(3),
    credentialForBinding,...overrides} as never);
  return{runner,calls,cleanup,credentialForBinding};
};
afterEach(()=>vi.useRealTimers());

test("runs a bounded fair rotation with fixed, value-free summaries",async()=>{
  const onSummary=vi.fn(),calls:unknown[]=[],cleanup=vi.fn(async(_credential:unknown,request:unknown)=>{calls.push(request);return{removed:1};});
  const credentialForBinding=vi.fn(async(binding:FieldPresenceOwnerBinding)=>({for:binding.policyId}));
  const runner=createFieldPresenceMaintenanceRunner({maintenance:maintenance(cleanup) as never,bindings:bindings(5),
    credentialForBinding,policiesPerTick:2,batchLimit:7,onSummary});
  const first=await runner.runOnce(),second=await runner.runOnce(),third=await runner.runOnce();
  expect(first).toEqual({status:"completed",attempted:2,succeeded:2,failed:0});
  expect(second).toEqual({status:"completed",attempted:2,succeeded:2,failed:0});
  expect(third).toEqual({status:"completed",attempted:2,succeeded:2,failed:0});
  expect(calls).toEqual([{tenantId:"tenant-a",repositoryId:"repo-a",serviceId:"service-a",environment:"uat",policyId:"policy-0",limit:7},
    {tenantId:"tenant-a",repositoryId:"repo-a",serviceId:"service-a",environment:"uat",policyId:"policy-1",limit:7},
    {tenantId:"tenant-a",repositoryId:"repo-a",serviceId:"service-a",environment:"uat",policyId:"policy-2",limit:7},
    {tenantId:"tenant-a",repositoryId:"repo-a",serviceId:"service-a",environment:"uat",policyId:"policy-3",limit:7},
    {tenantId:"tenant-a",repositoryId:"repo-a",serviceId:"service-a",environment:"uat",policyId:"policy-4",limit:7},
    {tenantId:"tenant-a",repositoryId:"repo-a",serviceId:"service-a",environment:"uat",policyId:"policy-0",limit:7}]);
  expect(credentialForBinding.mock.calls.map(call=>call[0].policyId)).toEqual(["policy-0","policy-1","policy-2","policy-3","policy-4","policy-0"]);
  expect(onSummary).toHaveBeenCalledTimes(3);expect(JSON.stringify(first)).not.toMatch(/tenant|policy|credential|removed/);
  expect(Object.isFrozen(first)).toBe(true);expect(cleanup).toHaveBeenCalledTimes(6);
});

test("overlapping manual and scheduled passes never overlap; schedule is interval-after-settlement",async()=>{
  vi.useFakeTimers();let release!:(value:unknown)=>void;const gate=new Promise(resolve=>{release=resolve;});
  const cleanup=vi.fn(async()=>gate),onSummary=vi.fn();
  const runner=createFieldPresenceMaintenanceRunner({maintenance:maintenance(cleanup) as never,bindings:bindings(1),
    credentialForBinding:async()=>"opaque",intervalMs:60_000,onSummary});
  expect(runner.start()).toBe(true);await vi.advanceTimersByTimeAsync(60_000);
  await vi.waitFor(()=>expect(cleanup).toHaveBeenCalledTimes(1));
  expect(await runner.runOnce()).toEqual({status:"busy",attempted:0,succeeded:0,failed:0});
  await vi.advanceTimersByTimeAsync(180_000);expect(cleanup).toHaveBeenCalledTimes(1);
  release({removed:0});await vi.waitFor(()=>expect(onSummary).toHaveBeenCalledTimes(1));
  await vi.advanceTimersByTimeAsync(59_999);expect(cleanup).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);await vi.waitFor(()=>expect(cleanup).toHaveBeenCalledTimes(2));
  await runner.stop();
});

test("stop aborts credential resolution, ignores late credentials, and permits restart after draining",async()=>{
  vi.useFakeTimers();let complete!:(value:unknown)=>void;let observedSignal:AbortSignal|undefined;
  const cleanup=vi.fn();const runner=createFieldPresenceMaintenanceRunner({maintenance:maintenance(cleanup) as never,
    bindings:bindings(1),credentialForBinding:(_binding,signal)=>{observedSignal=signal;return new Promise(resolve=>{complete=resolve;});}});
  const pass=runner.runOnce();await vi.waitFor(()=>expect(complete).toBeTypeOf("function"));
  const stopping=runner.stop();await expect(pass).resolves.toEqual({status:"completed",attempted:1,succeeded:0,failed:1});
  await stopping;expect(observedSignal?.aborted).toBe(true);complete("LATE_SECRET");
  expect(cleanup).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);expect(runner.start()).toBe(true);await runner.stop();
});

test("stop drains cleanup already started before returning",async()=>{
  let release!:(value:unknown)=>void;const gate=new Promise(resolve=>{release=resolve;});
  const cleanup=vi.fn(()=>gate);const runner=createFieldPresenceMaintenanceRunner({maintenance:maintenance(cleanup) as never,
    bindings:bindings(1),credentialForBinding:async()=>"opaque"});
  const pass=runner.runOnce();await vi.waitFor(()=>expect(cleanup).toHaveBeenCalledOnce());let stopped=false;
  const stopping=runner.stop().then(()=>{stopped=true;});await Promise.resolve();expect(stopped).toBe(false);
  release({removed:1});await pass;await stopping;expect(stopped).toBe(true);
});

test("manual pass resets an automatic deadline and start during stop cannot overlap",async()=>{
  vi.useFakeTimers();let release!:(value:unknown)=>void,finish!:(value:unknown)=>void;
  const gate=new Promise(resolve=>{release=resolve;}),inFlight=new Promise(resolve=>{finish=resolve;});
  const cleanup=vi.fn().mockImplementationOnce(()=>gate).mockImplementationOnce(()=>inFlight).mockResolvedValue({removed:0});
  const runner=createFieldPresenceMaintenanceRunner({maintenance:maintenance(cleanup) as never,bindings:bindings(1),
    credentialForBinding:async()=>"opaque",intervalMs:60_000});
  const manual=runner.runOnce();await vi.waitFor(()=>expect(cleanup).toHaveBeenCalledOnce());runner.start();
  await vi.advanceTimersByTimeAsync(60_000);expect(cleanup).toHaveBeenCalledOnce();
  release({removed:0});await manual;await vi.advanceTimersByTimeAsync(59_999);expect(cleanup).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1);await vi.waitFor(()=>expect(cleanup).toHaveBeenCalledTimes(2));
  const stopping=runner.stop();expect(runner.start()).toBe(false);finish({removed:0});await stopping;
  expect(runner.start()).toBe(true);await runner.stop();
});

test("credential failures and cleanup failures become counts only; observer errors do not disrupt scheduling",async()=>{
  const cleanup=vi.fn(async()=>{throw Error("PRIVATE_DATABASE_CANARY");}),onSummary=vi.fn(()=>{throw Error("PRIVATE_OBSERVER_CANARY");});
  const credentialForBinding=vi.fn(async(binding:FieldPresenceOwnerBinding)=>{if(binding.policyId==="policy-0")throw Error("PRIVATE_CREDENTIAL_CANARY");return "opaque";});
  const runner=createFieldPresenceMaintenanceRunner({maintenance:maintenance(cleanup) as never,bindings:bindings(2),
    credentialForBinding,policiesPerTick:2,onSummary});
  const summary=await runner.runOnce();expect(summary).toEqual({status:"completed",attempted:2,succeeded:0,failed:2});
  expect(onSummary).toHaveBeenCalledOnce();expect(cleanup).toHaveBeenCalledOnce();
  expect(JSON.stringify(summary)).not.toMatch(/PRIVATE|policy|credential|tenant/);
});

test("asynchronous observer failures and malformed cleanup results are isolated",async()=>{
  const onSummary=vi.fn(async()=>{throw Error("PRIVATE_OBSERVER_CANARY");});
  const runner=createFieldPresenceMaintenanceRunner({maintenance:maintenance(async()=>({removed:1,private:"CANARY"})) as never,
    bindings:bindings(1),credentialForBinding:async()=>"opaque",onSummary});
  expect(await runner.runOnce()).toEqual({status:"completed",attempted:1,succeeded:0,failed:1});
  await Promise.resolve();expect(onSummary).toHaveBeenCalledOnce();
});

test("rejects invalid, duplicate, accessor and proxy configuration without invoking traps",()=>{
  const trap=vi.fn(()=>{throw Error("PRIVATE_TRAP_CANARY");});const proxy=new Proxy({}, {ownKeys:trap});
  const accessor={maintenance:maintenance(async()=>({})),bindings:bindings(1),credentialForBinding:async()=>"opaque"};
  Object.defineProperty(accessor,"intervalMs",{enumerable:true,get:trap});
  for(const input of [proxy,accessor,{maintenance:maintenance(async()=>({})),bindings:[...bindings(1),...bindings(1)],credentialForBinding:async()=>"x"},
    {maintenance:maintenance(async()=>({})),bindings:[bindings(1)[0],{...bindings(1)[0],ownerAccessScopeId:"other-owner"}],credentialForBinding:async()=>"x"},
    {maintenance:maintenance(async()=>({})),bindings:bindings(1),credentialForBinding:async()=>"x",intervalMs:1},
    {maintenance:maintenance(async()=>({})),bindings:bindings(1),credentialForBinding:async()=>"x",policiesPerTick:17}])
    expect(()=>createFieldPresenceMaintenanceRunner(input as never)).toThrow("INVALID_FIELD_PRESENCE_MAINTENANCE_RUNNER_CONFIGURATION");
  expect(trap).not.toHaveBeenCalled();
});

test("credential deadline aborts and ignores a late credential",async()=>{
  vi.useFakeTimers();let complete!:(value:unknown)=>void,signal:AbortSignal|undefined;
  const cleanup=vi.fn();const runner=createFieldPresenceMaintenanceRunner({maintenance:maintenance(cleanup) as never,
    bindings:bindings(1),credentialForBinding:(_binding,received)=>{signal=received;return new Promise(resolve=>{complete=resolve;});}});
  const pending=runner.runOnce();await vi.waitFor(()=>expect(complete).toBeTypeOf("function"));
  await vi.advanceTimersByTimeAsync(10_000);await expect(pending).resolves.toEqual({status:"completed",attempted:1,succeeded:0,failed:1});
  expect(signal?.aborted).toBe(true);complete("LATE_SECRET");expect(cleanup).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);
});

test("callback bindings are detached and frozen",async()=>{
  let received:FieldPresenceOwnerBinding|undefined;const source=[{...bindings(1)[0]!}];
  const runner=createFieldPresenceMaintenanceRunner({maintenance:maintenance(async()=>({} )) as never,bindings:source,
    credentialForBinding:async(binding)=>{received=binding;expect(Object.isFrozen(binding)).toBe(true);return"opaque";}});
  source[0]!.policyId="mutated";await runner.runOnce();expect(received?.policyId).toBe("policy-0");
});


test("explicit null numeric options reject rather than selecting defaults",()=>{
  for(const key of ["intervalMs","policiesPerTick","batchLimit"]){
    expect(()=>createFieldPresenceMaintenanceRunner({maintenance:maintenance(async()=>({removed:0})),
      bindings:bindings(1),credentialForBinding:async()=>"opaque",[key]:null} as never))
      .toThrow("INVALID_FIELD_PRESENCE_MAINTENANCE_RUNNER_CONFIGURATION");
  }
});
