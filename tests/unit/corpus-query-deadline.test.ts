import {afterEach,expect,test,vi} from "vitest";
import {createQueryReader} from "../../packages/query/src/index.js";

afterEach(()=>vi.useRealTimers());

test("an in-flight corpus query hits the total deadline and destroys its transaction client",async()=>{
  vi.useFakeTimers({toFake:["setTimeout","clearTimeout","performance"]});
  let rejectPending:((error:Error)=>void)|undefined;
  const release=vi.fn();
  const query=vi.fn(async(sql:string)=>{
    if(sql==="SET LOCAL statement_timeout TO '10s'")
      return new Promise<never>((_resolve,reject)=>{rejectPending=reject;});
    return {rows:[]};
  });
  const reader=createQueryReader({connect:async()=>({query,release})} as never,
    {schema:"api_truth_test_deadline"});
  const pending=reader.searchOperationCandidatesAcrossServices(
    {tenantId:"tenant-a",principalId:"reader"},
    {tenantId:"tenant-a",environment:"uat",intentQuery:"read order"});
  await vi.advanceTimersByTimeAsync(0);
  expect(rejectPending).toBeTypeOf("function");
  await vi.advanceTimersByTimeAsync(10_000);
  await expect(pending).resolves.toEqual({status:"unknown",matchMode:"keyword",
    scope:"visible_authorized_services",environment:"uat",reason:"scan_limit"});
  expect(release).toHaveBeenCalledExactlyOnceWith(true);
  expect(query.mock.calls.some(([sql])=>sql==="ROLLBACK"||sql==="COMMIT")).toBe(false);
  // A late driver rejection remains handled after cancellation; its text never reaches the response.
  rejectPending!(new Error("CANARY_DRIVER_DETAIL"));
  await vi.advanceTimersByTimeAsync(0);
});
