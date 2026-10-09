import {readFile} from "node:fs/promises";
import {expect,test} from "vitest";
import {compileOpenApiSnapshot} from "../../packages/openapi/src/compiler.js";
import {parseContractSnapshot} from "../../packages/ir/src/index.js";

const snapshot=async()=>{
  const value=JSON.parse(await readFile(new URL("../fixtures/ir/express-snapshot.json",import.meta.url),"utf8"));
  value.endpoints=[value.endpoints[0]];
  value.coverage={status:"complete",analyzed_roots:["src"],diagnostic_ids:[]};
  value.claims=[];value.editorial_reviews=[];value.export_eligibility=[];value.dependencies=[];
  value.evidence=value.evidence.filter((item:{scope:{endpoint_id?:string}})=>item.scope.endpoint_id!=="ep-create");
  value.evidence.push({...value.evidence[0],evidence_id:"ev-proof",method:"deterministic_analysis",limitations:[],
    scope:{service_id:"orders",snapshot_id:value.snapshot_id,endpoint_id:"ep-get"}});
  const endpoint=value.endpoints[0];
  endpoint.evidence_ids=["ev-proof"];
  endpoint.parameters=endpoint.parameters.slice(0,1);
  endpoint.parameters[0].presence.evidence_ids=["ev-proof"];
  endpoint.security={state:"anonymous",evidence_ids:["ev-proof"],alternatives:[]};
  value.schemas={Customer:value.schemas.Customer};
  const parsed=parseContractSnapshot(value);
  if(!parsed.ok)throw new Error(JSON.stringify(parsed.error.issues));
  return value;
};
const component=(name:string,schema:unknown)=>({schema_id:name,schema,evidence_ids:["ev-type"]});

test("literal const and enum JSON objects never become schema references",async()=>{
  const value=await snapshot();
  value.schemas.Customer.schema.const={$ref:"#/schemas/NotAComponent"};
  value.schemas.Customer.schema.enum=[{$ref:"#/schemas/AlsoNotAComponent"}];
  expect(parseContractSnapshot(value).ok).toBe(true);
  const result=compileOpenApiSnapshot(value,"draft");
  expect(result.ok).toBe(true);
  const schemas=(result.document as any).components.schemas;
  expect(Object.keys(schemas)).toEqual(["Customer"]);
  expect(schemas.Customer.const).toBeUndefined();
  expect(schemas.Customer.enum).toBeUndefined();
  expect(result.diagnostics.some(item=>item.path.includes("NotAComponent"))).toBe(false);
});

test("properties named const, enum, and prefixItems retain real references and nested closure",async()=>{
  const value=await snapshot();
  value.schemas.Customer.schema.properties.const={$ref:"#/schemas/ConstProperty"};
  value.schemas.Customer.schema.properties.enum={$ref:"#/schemas/EnumProperty"};
  value.schemas.Customer.schema.properties.prefixItems={$ref:"#/schemas/PrefixProperty"};
  value.schemas.ConstProperty=component("ConstProperty",{type:"string"});
  value.schemas.EnumProperty=component("EnumProperty",{type:"string"});
  value.schemas.PrefixProperty=component("PrefixProperty",{oneOf:[{type:"array",items:{$ref:"#/schemas/Nested"}}]});
  value.schemas.Nested=component("Nested",{type:"string"});
  expect(parseContractSnapshot(value).ok).toBe(true);
  const schemas=(compileOpenApiSnapshot(value,"draft").document as any).components.schemas;
  expect(Object.keys(schemas).sort()).toEqual(["ConstProperty","Customer","EnumProperty","Nested","PrefixProperty"]);
  expect(schemas.Customer.properties.const.$ref).toBe("#/components/schemas/ConstProperty");
  expect(schemas.Customer.properties.enum.$ref).toBe("#/components/schemas/EnumProperty");
  expect(schemas.Customer.properties.prefixItems.$ref).toBe("#/components/schemas/PrefixProperty");
  expect(schemas.PrefixProperty.oneOf[0].items.$ref).toBe("#/components/schemas/Nested");
});

test("only supported nested schema positions contribute component references",async()=>{
  const value=await snapshot();
  Object.assign(value.schemas.Customer.schema.properties,{
    itemsNode:{type:"array",items:{$ref:"#/schemas/ItemsNode"}},
    prefixNode:{type:"array",prefixItems:[{$ref:"#/schemas/PrefixNode"}]},
    additionalNode:{type:"object",additionalProperties:{$ref:"#/schemas/AdditionalNode"}},
    notNode:{not:{$ref:"#/schemas/NotNode"}},
    oneNode:{oneOf:[{$ref:"#/schemas/OneNode"}]},
    anyNode:{anyOf:[{$ref:"#/schemas/AnyNode"}]},
    allNode:{allOf:[{$ref:"#/schemas/AllNode"}]},
  });
  const names=["ItemsNode","PrefixNode","AdditionalNode","NotNode","OneNode","AnyNode","AllNode"];
  for(const name of names)value.schemas[name]=component(name,{type:"string"});
  const parsed=parseContractSnapshot(value);
  if(!parsed.ok)throw new Error(JSON.stringify(parsed.error.issues));
  const schemas=(compileOpenApiSnapshot(value,"draft").document as any).components.schemas;
  expect(Object.keys(schemas).sort()).toEqual(["Customer",...names].sort());
});

test("parameters, request media, response media, and response headers each seed schema closure",async()=>{
  const value=await snapshot();
  const endpoint=value.endpoints[0];
  endpoint.parameters[0].schema={$ref:"#/schemas/Parameter"};
  endpoint.request_bodies=[{media_type:"application/json",schema:{$ref:"#/schemas/Request"},
    serialization:{format:"json"},presence:{state:"required",evidence_ids:["ev-proof"]}}];
  endpoint.responses[0].content[0].schema={$ref:"#/schemas/Response"};
  endpoint.responses[0].headers=[{name:"X-Result",schema:{$ref:"#/schemas/Header"}}];
  value.schemas={Parameter:component("Parameter",{type:"string"}),Request:component("Request",{type:"string"}),
    Response:component("Response",{type:"string"}),Header:component("Header",{type:"string"})};
  expect(parseContractSnapshot(value).ok).toBe(true);
  const schemas=(compileOpenApiSnapshot(value,"draft").document as any).components.schemas;
  expect(Object.keys(schemas).sort()).toEqual(["Header","Parameter","Request","Response"]);
});

test("a real dangling schema reference still fails snapshot validation",async()=>{
  const value=await snapshot();
  value.schemas.Customer.schema.properties.id={$ref:"#/schemas/Missing"};
  expect(parseContractSnapshot(value).ok).toBe(false);
  expect(()=>compileOpenApiSnapshot(value,"draft")).toThrow("Invalid contract snapshot");
});
