import {expect,test} from "vitest";
import {resolveResponseObject as resolve} from "../../analyzers/nodejs/src/response-schema-resolution.js";
test("inline responses retain their schema without inventing references",()=>{
  const response={description:"OK",schema:{$ref:"#/definitions/Body"}};
  expect(resolve(response,{})).toEqual({kind:"resolved",response,pointers:[]});
});
test("escaped reusable response chains retain source and terminal provenance",()=>{
  const response={description:"OK",schema:{$ref:"#/definitions/Body"}};
  expect(resolve({$ref:"#/responses/A"},{A:{$ref:"#/responses/a~1b~0c"},"a/b~c":response}))
    .toEqual({kind:"resolved",response,pointers:["/responses/A","/responses/a~1b~0c"],terminalPointer:"/responses/a~1b~0c"});
});
test.each([
  [{$ref:"https://private.invalid/response"},{}],
  [{$ref:"other.yaml#/responses/A"},{}],
  [{$ref:"#/definitions/A"},{A:{description:"OK"}}],
  [{$ref:"#/responses/Missing"},{}],
  [{$ref:"#/responses/a~2b"},{"a~2b":{description:"OK"}}],
  [{$ref:"#/responses/A",description:"sibling"},{A:{description:"OK"}}],
  [{$ref:"#/responses/A"},{A:{$ref:"#/responses/A"}}],
  [{schema:{type:"string"}},{}],
  [{description:"OK",headers:[]},{}],
])("unsupported response objects remain unresolved: %j",(response,responses)=>{
  expect(resolve(response,responses).kind).toBe("unresolved");
});
test("response chain depth is bounded",()=>{
  const responses:Record<string,unknown>={};
  for(let i=0;i<66;i++)responses[`R${i}`]=i===65?{description:"OK"}:{$ref:`#/responses/R${i+1}`};
  expect(resolve({$ref:"#/responses/R0"},responses).kind).toBe("unresolved");
});
