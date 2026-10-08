import {expect,test} from "vitest";
import {resolveResponseSchema as resolve} from "../../analyzers/nodejs/src/response-schema-resolution.js";
import {compareResponseBodyTypes,compareResponseBodyPresence} from "../../analyzers/nodejs/src/response-body-comparison.js";
test("resolves escaped definitions and nested properties/items with definition provenance",()=>{
  const result=resolve({$ref:"#/definitions/Root"},{Root:{type:"object",properties:{list:{type:"array",items:{$ref:"#/definitions/a~1b~0c"}}}},"a/b~c":{type:"object",required:["id"],properties:{id:{type:"string"}}}});
  expect(result).toEqual({kind:"resolved",schema:{type:"object",properties:{list:{type:"array",items:{type:"object",required:["id"],properties:{id:{type:"string"}}}}}},pointers:["/definitions/Root","/definitions/a~1b~0c"]});
});
test("resolved schemas feed both type and presence checks",()=>{
  const result=resolve({$ref:"#/definitions/Body"},{Body:{type:"object",required:["name"],properties:{id:{$ref:"#/definitions/Id"}}},Id:{type:"string"}});
  expect(result.kind).toBe("resolved");
  if(result.kind!=="resolved")return;
  const actual={type:"object" as const,properties:{id:{type:"integer" as const}}};
  expect(compareResponseBodyTypes(actual,result.schema).mismatches).toEqual(["/id"]);
  expect(compareResponseBodyPresence(actual,result.schema).missing).toEqual(["/name"]);
});
test("literal metadata references are not interpreted as schema references",()=>{
  const schema={type:"string",default:{$ref:"https://private.invalid/value"},example:{$ref:"#/definitions/Missing"}};
  expect(resolve(schema,{})).toEqual({kind:"resolved",schema,pointers:[]});
});
test.each([
  [{$ref:"https://private.invalid/schema"},{}],
  [{$ref:"other.yaml#/definitions/Body"},{}],
  [{$ref:"#/responses/Body"},{}],
  [{$ref:"#/definitions/Missing"},{}],
  [{$ref:"#/definitions/a~2b"},{"a~2b":{type:"string"}}],
  [{$ref:"#/definitions/Body",type:"string"},{Body:{type:"integer"}}],
  [{$ref:"#/definitions/Body"},{Body:{$ref:"#/definitions/Body"}}],
  [{$ref:"#/definitions/Body"},{Body:{type:"object",properties:{child:{$ref:"#/definitions/Body"}}}}],
  [{properties:null},{}]
])("unsafe or unsupported references stay unresolved: %j",(schema,definitions)=>{
  expect(resolve(schema,definitions).kind).toBe("unresolved");
});
test("repeated references preserve unique provenance without being treated as a cycle",()=>{
  expect(resolve({type:"object",properties:{a:{$ref:"#/definitions/Id"},b:{$ref:"#/definitions/Id"}}},{Id:{type:"string"}}))
    .toEqual({kind:"resolved",schema:{type:"object",properties:{a:{type:"string"},b:{type:"string"}}},pointers:["/definitions/Id"]});
});
test("reference expansion depth and node budgets are bounded",()=>{
  const defs:Record<string,unknown>={};
  for(let i=0;i<66;i++)defs[`D${i}`]=i===65?{type:"string"}:{$ref:`#/definitions/D${i+1}`};
  expect(resolve({$ref:"#/definitions/D0"},defs).kind).toBe("unresolved");
  expect(resolve({type:"object",properties:Object.fromEntries(Array.from({length:10001},(_,i)=>[`f${i}`,{type:"string"}]))},{}).kind).toBe("unresolved");
});
