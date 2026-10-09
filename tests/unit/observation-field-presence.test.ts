import {readFile} from "node:fs/promises";
import {expect, test} from "vitest";
import {projectObservedFieldPresence, FieldPresenceInputError} from "../../packages/observations/src/index.js";
const fixture = JSON.parse(await readFile(new URL("../fixtures/ir/express-snapshot.json", import.meta.url), "utf8"));
const input = () => {
  const snapshot = structuredClone(fixture);
  snapshot.endpoints.find((e: {endpoint_id:string}) => e.endpoint_id === "ep-create").request_bodies[0].schema = {
    type:"object", properties:{customer:{type:"object", properties:{id:{type:"string"}}},password:{type:"string"},count:{type:"integer"}}};
  const pin = {state:"resolved_single_revision",tenantId:"tenant-a",repositoryId:"commerce",serviceId:"orders",
    environment:"uat",snapshotId:snapshot.snapshot_id,revision:snapshot.source.immutable_revision,
    configFingerprint:snapshot.config.config_fingerprint,checkpointVersion:"7"};
  const policy = {version:"observed-field-presence-1",policyId:"owner-policy-1",...pin,
    sourceDigest:snapshot.source.source_digest,endpointId:"ep-create",direction:"request",mediaType:"application/json",
    propertyPaths:["/customer/id","/password","/count"]};
  delete (policy as {state?:string}).state;
  return {pin,snapshot,policy,payloadText:'{"customer":{"id":"PRIVATE_CANARY"},"password":"SECRET_CANARY"}',payloadCompleteness:"complete_unredacted"};
};
test("projects only declared owner-selected presence without retaining values or changing contracts", () => {
  const value=input(), before=JSON.stringify(value.snapshot);
  const result=projectObservedFieldPresence(value);
  expect(result).toMatchObject({status:"projected",nonNormative:true,fields:[
    {path:"/customer/id",state:"present"},{path:"/password",state:"present"},{path:"/count",state:"absent"}]});
  expect(JSON.stringify(result)).not.toMatch(/PRIVATE_CANARY|SECRET_CANARY/);
  expect(JSON.stringify(value.snapshot)).toBe(before);
});
for (const completeness of ["redacted","truncated","unknown"]) test(`withholds ${completeness} payload`,()=>{
  const value=input();value.payloadCompleteness=completeness;
  expect(projectObservedFieldPresence(value)).toMatchObject({status:"withheld"});
});
for (const payloadText of ['{"count":1,"count":2}', '{"count":1,"co\\u0075nt":2}', '{bad', '{"count":1e999}', '[]', '{"customer":null}', '{"count":"wrong"}']) {
  test(`withholds unsafe parse or shape ${payloadText.length}`,()=>{
    const value=input();value.payloadText=payloadText;
    expect(projectObservedFieldPresence(value)).toMatchObject({status:"withheld"});
  });
}
test("withholds scope mismatch and unsupported schema keywords or paths",()=>{
  const value=input();value.pin.environment="prod";
  expect(projectObservedFieldPresence(value)).toMatchObject({status:"withheld"});
  const unknown=input();unknown.policy.propertyPaths=["/undocumented"];
  expect(projectObservedFieldPresence(unknown)).toMatchObject({status:"withheld"});
  const constrained=input();constrained.snapshot.endpoints.find((e:{endpoint_id:string})=>e.endpoint_id==="ep-create").request_bodies[0].schema.properties.count.minimum=0;
  expect(projectObservedFieldPresence(constrained)).toMatchObject({status:"withheld"});
});
test("rejects proxies and accessors without evaluating them",()=>{
  let calls=0; const value=input();
  const proxy=new Proxy(value,{ownKeys(){calls++;return [];}});
  expect(()=>projectObservedFieldPresence(proxy)).toThrow(FieldPresenceInputError);
  Object.defineProperty(value,"payloadText",{get(){calls++;return "private";}});
  expect(()=>projectObservedFieldPresence(value)).toThrow(FieldPresenceInputError);
  expect(calls).toBe(0);
});
test("caps bytes and rejects prototype or wildcard policy paths",()=>{
  const value=input();value.payloadText="x".repeat(256*1024+1);
  expect(()=>projectObservedFieldPresence(value)).toThrow(FieldPresenceInputError);
  for(const path of ["/__proto__","/*","/constructor"]) {
    const unsafe=input();unsafe.policy.propertyPaths=[path];
    expect(()=>projectObservedFieldPresence(unsafe)).toThrow(FieldPresenceInputError);
  }
});

test("supports exact response status while withholding wrong status or ambiguous media",()=>{
  const value=input();
  const endpoint=value.snapshot.endpoints.find((e:{endpoint_id:string})=>e.endpoint_id==="ep-create");
  endpoint.responses[0].content[0].schema=endpoint.request_bodies[0].schema;
  Object.assign(value.policy,{direction:"response",statusCode:201});
  expect(projectObservedFieldPresence(value)).toMatchObject({status:"projected",scope:{direction:"response",statusCode:201}});
  Object.assign(value.policy,{statusCode:200});
  expect(projectObservedFieldPresence(value)).toMatchObject({status:"withheld"});
  const ambiguous=input();const body=ambiguous.snapshot.endpoints.find((e:{endpoint_id:string})=>e.endpoint_id==="ep-create").request_bodies;
  body.push(structuredClone(body[0]));
  expect(projectObservedFieldPresence(ambiguous)).toMatchObject({status:"withheld"});
});
test("withholds deep raw payloads with fixed diagnostics and no values",()=>{
  const value=input();value.payloadText='{"private":'.repeat(34)+'"SECRET_CANARY"'+'}'.repeat(34);
  const result=projectObservedFieldPresence(value);
  expect(result).toMatchObject({status:"withheld",diagnostics:[{ruleId:"payload_parse_unverified",count:1}]});
  expect(JSON.stringify(result)).not.toContain("SECRET_CANARY");
});

for (const numeric of ["1.0000000000000001","1e-999","9007199254740993"]) test(`withholds lossy numeric type evidence ${numeric}`,()=>{
  const value=input();value.payloadText=`{"count":${numeric}}`;
  expect(projectObservedFieldPresence(value)).toMatchObject({status:"withheld"});
});

for (const numeric of ["1.0000","1e3","1.200e1","0e-999"]) test(`retains exact integral numeric representations ${numeric}`,()=>{
  const value=input();value.payloadText=`{"count":${numeric}}`;
  expect(projectObservedFieldPresence(value)).toMatchObject({status:"projected",fields:[
    {path:"/customer/id",state:"absent"},{path:"/password",state:"absent"},{path:"/count",state:"present"}]});
});
