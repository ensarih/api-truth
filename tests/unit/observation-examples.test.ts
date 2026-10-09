import {readFile} from "node:fs/promises";
import {expect, test} from "vitest";
import {parseContractSnapshot, type ContractSnapshot} from "../../packages/ir/src/index.js";
import {buildSyntheticExample, SyntheticExampleError} from "../../packages/observations/src/index.js";

const snapshot = JSON.parse(await readFile(new URL("../fixtures/ir/express-snapshot.json", import.meta.url), "utf8")) as ContractSnapshot;
const view = () => ({status:"resolved" as const,
  selector:{version:"1" as const,tenantId:"tenant-a",repositoryId:"commerce",serviceId:"orders",
    selector:{kind:"environment" as const,environment:"uat",expectedCheckpointVersion:"7"}},
  pin:{snapshotId:snapshot.snapshot_id,revision:snapshot.source.immutable_revision,
    configFingerprint:snapshot.config.config_fingerprint,checkpointVersion:"7"},
  snapshot:structuredClone(snapshot),publication:{status:"absent" as const}});
const policy = (extra:Record<string,unknown>={}) => ({version:"synthetic-examples-1",endpointId:"ep-create",
  direction:"request",mediaType:"application/json",propertyPaths:["/customer/id","/items/sku"],...extra});

test("generates only deterministic typed placeholders from explicitly opted-in paths",()=>{
  const result=buildSyntheticExample(view(),"ep-create",policy());
  expect(result).toMatchObject({status:"generated",kind:"synthetic_example",nonNormative:true,
    policyVersion:"synthetic-examples-1",scope:{tenantId:"tenant-a",repositoryId:"commerce",serviceId:"orders",
      environment:"uat",revision:"rev-b",snapshotId:"snapshot-orders-rev-b",endpointId:"ep-create",
      direction:"request",mediaType:"application/json"},value:{customer:{id:"string"},items:[{sku:"string"}]}});
  expect(result).toHaveProperty("fingerprints.schemaSha256");
  expect(result).toHaveProperty("fingerprints.policySha256");
  expect(buildSyntheticExample(view(),"ep-create",policy())).toEqual(result);
  expect(JSON.stringify(result)).not.toMatch(/standard|expedited|CANARY_SECRET|priority/);
  expect(view().snapshot.endpoints[1]!.request_bodies[0]!.presence.state).toBe("required");
});

test("generates selected exact-status response data without copying schema values",()=>{
  const selected=buildSyntheticExample(view(),"ep-get",{version:"synthetic-examples-1",endpointId:"ep-get",
    direction:"response",statusCode:200,mediaType:"application/json",propertyPaths:["/id"]});
  expect(selected).toMatchObject({status:"generated",scope:{endpointId:"ep-get",direction:"response",statusCode:200},
    value:{id:"string"}});
  expect(JSON.stringify(selected)).not.toMatch(/customer@example|standard|expedited/);
  expect(buildSyntheticExample(view(),"ep-get",{version:"synthetic-examples-1",endpointId:"ep-get",
    direction:"response",statusCode:201,mediaType:"application/json",propertyPaths:["/id"]}))
    .toMatchObject({status:"withheld"});
});

test("default deny and missing required opt-in path withhold the whole example",()=>{
  expect(buildSyntheticExample(view(),"ep-create",policy({propertyPaths:[]}))).toMatchObject({status:"withheld"});
  expect(buildSyntheticExample(view(),"ep-create",policy({propertyPaths:["/customer/id"]}))).toMatchObject({status:"withheld"});
});

test("unsupported schema constraints, cycles, and ambiguous media never relax to an example",()=>{
  const unsupported=view();
  unsupported.snapshot.schemas.CreateOrder!.schema.properties!.priority={type:"string",pattern:".*"};
  expect(buildSyntheticExample(unsupported,"ep-create",policy({propertyPaths:["/customer/id","/items/sku","/priority"]})))
    .toMatchObject({status:"withheld"});
  const cyclic=view();
  (cyclic.snapshot.schemas.CreateOrder!.schema as Record<string,unknown>).properties={customer:{$ref:"#/schemas/CreateOrder"}};
  expect(buildSyntheticExample(cyclic,"ep-create",policy())).toMatchObject({status:"withheld"});
  expect(()=>buildSyntheticExample(view(),"ep-create",policy({mediaType:"application/*"}))).toThrowError(SyntheticExampleError);
});

test("prototype-like and sensitive names are safely withheld without echoing names",()=>{
  const unsafe=view();
  const properties:Record<string,unknown>={password:{type:"string"}};
  Object.defineProperty(properties,"__proto__",{value:{type:"string"},enumerable:true,writable:true,configurable:true});
  (unsafe.snapshot.schemas.CreateOrder!.schema as {properties?:Record<string,unknown>}).properties=properties;
  unsafe.snapshot.schemas.CreateOrder!.schema.required=["__proto__","password"];
  const result=buildSyntheticExample(unsafe,"ep-create",policy({propertyPaths:["/__proto__","/password"]}));
  expect(result).toMatchObject({status:"withheld"});
  expect(JSON.stringify(result)).not.toMatch(/password|__proto__/);
});

test("rejects untrusted accessors, proxies, stale pins, and non-environment views with fixed errors",()=>{
  const accessor=Object.defineProperty({},"status",{get(){throw new Error("CANARY_SECRET")}});
  expect(()=>buildSyntheticExample(accessor,"ep-create",policy())).toThrowError(SyntheticExampleError);
  expect(()=>buildSyntheticExample(new Proxy(view(),{}),"ep-create",policy())).toThrowError(SyntheticExampleError);
  expect(()=>buildSyntheticExample({...view(),pin:{...view().pin,checkpointVersion:"8"}},"ep-create",policy()))
    .toThrowError(SyntheticExampleError);
  expect(()=>buildSyntheticExample({...view(),selector:{...view().selector,selector:{kind:"branch",branch:"main"}}},"ep-create",policy()))
    .toThrowError(SyntheticExampleError);
});

test("bounds policy and snapshot traversal and rejects inherited/malformed policy fields",()=>{
  expect(()=>buildSyntheticExample(view(),"ep-create",policy({propertyPaths:Array.from({length:65},(_,i)=>`/x${i}`)})))
    .toThrowError(SyntheticExampleError);
  const inherited=Object.assign(Object.create({secret:"x"}),policy());
  expect(()=>buildSyntheticExample(view(),"ep-create",inherited)).toThrowError(SyntheticExampleError);
  const deep=view();
  let schema:Record<string,unknown>=deep.snapshot.schemas.CreateOrder!.schema as Record<string,unknown>;
  for(let i=0;i<18;i++){schema.type="object";schema.properties={x:{type:"object"}};schema=(schema.properties as Record<string,Record<string,unknown>>).x!;}
  expect(()=>buildSyntheticExample(deep,"ep-create",policy({propertyPaths:["/"+Array(18).fill("x").join("/")]})))
    .toThrowError(SyntheticExampleError);
});

test("respects supported scalar bounds and withholds unsupported schema semantics",()=>{
  const bounded=view();
  (bounded.snapshot.schemas.CreateOrder!.schema as Record<string,unknown>).properties={
    customer:{type:"object",properties:{id:{type:"string",minLength:7,maxLength:9}},required:["id"]},
    items:{type:"array",minItems:2,maxItems:3,items:{type:"object",properties:{sku:{type:"string"}},required:["sku"]}},
  };
  expect(buildSyntheticExample(bounded,"ep-create",policy())).toMatchObject({status:"generated",
    value:{customer:{id:"xxxxxxx"},items:[{sku:"string"},{sku:"string"}]}});
  const impossible=view();
  (impossible.snapshot.schemas.CreateOrder!.schema as Record<string,unknown>).properties={
    customer:{type:"object",properties:{id:{type:"string",minLength:8,maxLength:2}},required:["id"]},
    items:{type:"array",items:{type:"object",properties:{sku:{type:"string"}},required:["sku"]}},
  };
  expect(buildSyntheticExample(impossible,"ep-create",policy())).toMatchObject({status:"withheld"});
});

test("terminal container paths cannot bypass const, composition, enum, or container bounds",()=>{
  const make=(payload:Record<string,unknown>)=>{
    const input=view();
    (input.snapshot.schemas.CreateOrder!.schema as Record<string,unknown>).properties={payload};
    (input.snapshot.schemas.CreateOrder!.schema as Record<string,unknown>).required=["payload"];
    return input;
  };
  for(const payload of [
    {type:"object",required:[],const:{private:"CANARY_SECRET"}},
    {type:"object",required:[],oneOf:[{type:"object"}]},
    {type:"array",maxItems:-1,items:{type:"string"}},
    {type:"array",enum:[[]],items:{type:"string"}},
    {type:"array",minLength:1,items:{type:"string"}},
    {type:"object",minimum:1,required:[]},
  ]){
    const result=buildSyntheticExample(make(payload),"ep-create",policy({propertyPaths:["/payload"]}));
    expect(result).toMatchObject({status:"withheld"});
    expect(JSON.stringify(result)).not.toContain("CANARY_SECRET");
  }
});

test("malformed selected body and response container shapes return only fixed input errors",()=>{
  const request=view();
  (request.snapshot.endpoints[1] as unknown as {request_bodies:unknown}).request_bodies=[null];
  expect(()=>buildSyntheticExample(request,"ep-create",policy())).toThrowError(SyntheticExampleError);
  const response=view();
  (response.snapshot.endpoints[0] as unknown as {responses:unknown[]}).responses[0]={
    status:{kind:"exact",code:200},content:[null]};
  expect(()=>buildSyntheticExample(response,"ep-get",{version:"synthetic-examples-1",endpointId:"ep-get",
    direction:"response",statusCode:200,mediaType:"application/json",propertyPaths:["/id"]}))
    .toThrowError(SyntheticExampleError);
});

test("ambiguous exact body media and duplicate exact response status are withheld",()=>{
  const duplicateRequest=view();
  const bodies=duplicateRequest.snapshot.endpoints[1]!.request_bodies;
  bodies.push(structuredClone(bodies[0]!));
  expect(buildSyntheticExample(duplicateRequest,"ep-create",policy())).toMatchObject({status:"withheld"});
  const duplicateResponse=view();
  duplicateResponse.snapshot.endpoints[0]!.responses.push(structuredClone(duplicateResponse.snapshot.endpoints[0]!.responses[0]!));
  expect(buildSyntheticExample(duplicateResponse,"ep-get",{version:"synthetic-examples-1",endpointId:"ep-get",
    direction:"response",statusCode:200,mediaType:"application/json",propertyPaths:["/id"]}))
    .toMatchObject({status:"withheld"});
});

test("negative numeric bounds choose a valid placeholder and reject impossible integer ranges",()=>{
  const negative=view();
  (negative.snapshot.schemas.CreateOrder!.schema as Record<string,unknown>).properties={
    customer:{type:"object",properties:{id:{type:"integer",maximum:-1}},required:["id"]},
    items:{type:"array",items:{type:"object",properties:{sku:{type:"string"}},required:["sku"]}},
  };
  expect(buildSyntheticExample(negative,"ep-create",policy())).toMatchObject({status:"generated",value:{customer:{id:-1}}});
  (negative.snapshot.schemas.CreateOrder!.schema as Record<string,unknown>).properties={
    customer:{type:"object",properties:{id:{type:"integer",minimum:1,maximum:-1}},required:["id"]},
    items:{type:"array",items:{type:"object",properties:{sku:{type:"string"}},required:["sku"]}},
  };
  expect(buildSyntheticExample(negative,"ep-create",policy())).toMatchObject({status:"withheld"});
});

test("schema references use the literal IR component ID while policy paths use JSON Pointer decoding",()=>{
  const input=view();
  const schemas=input.snapshot.schemas as Record<string,{schema:Record<string,unknown>;schema_id:string;evidence_ids:string[]}>;
  schemas["Foo~1Bar"]={schema_id:"Foo~1Bar",evidence_ids:["ev-type"],schema:{type:"object",properties:{"selected/name":{type:"string"}},required:["selected/name"]}};
  schemas["Foo/Bar"]={schema_id:"Foo/Bar",evidence_ids:["ev-type"],schema:{type:"object",properties:{decoy:{type:"string"}},required:["decoy"]}};
  (input.snapshot.schemas.CreateOrder!.schema as Record<string,unknown>).properties={payload:{$ref:"#/schemas/Foo~1Bar"}};
  (input.snapshot.schemas.CreateOrder!.schema as Record<string,unknown>).required=["payload"];
  const parsed=parseContractSnapshot(input.snapshot);
  if(!parsed.ok)throw new Error(JSON.stringify(parsed.error.issues));
  expect(parsed.value.schemas["Foo~1Bar"]?.schema_id).toBe("Foo~1Bar");
  const parsedRoot=parsed.value.schemas.CreateOrder!.schema as {properties:Record<string,{$ref:string}>};
  expect(parsedRoot.properties.payload!.$ref).toBe("#/schemas/Foo~1Bar");
  input.snapshot=structuredClone(parsed.value);
  const policyValue=policy({propertyPaths:["/payload/selected~1name"]});
  const generated=buildSyntheticExample(input,"ep-create",policyValue);
  expect(generated).toMatchObject({status:"generated",value:{payload:{"selected/name":"string"}}});

  const changedDecoy=structuredClone(input);
  changedDecoy.snapshot.schemas["Foo/Bar"]!.schema={type:"object",properties:{changed:{type:"integer"}},required:["changed"]};
  const sameReferencedComponent=buildSyntheticExample(changedDecoy,"ep-create",policyValue);
  expect(sameReferencedComponent).toMatchObject({status:"generated",fingerprints:{schemaSha256:generated.status==="generated"
    ?generated.fingerprints.schemaSha256:""}});
});
