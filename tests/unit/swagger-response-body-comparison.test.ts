import {expect, test} from "vitest";
import {compareResponseBodyTypes as compare} from "../../analyzers/nodejs/src/response-body-comparison.js";
test("only explicit type conflicts are discrepancies; requiredness and extra properties are not inferred", () => {
  const actual = {type:"object" as const, properties:{id:{type:"integer" as const}, label:{type:"string" as const}, extra:{type:"boolean" as const}}};
  expect(compare(actual, {type:"object", properties:{id:{type:"number"}, label:{type:"string"}}, required:["missing"], additionalProperties:false})).toEqual({kind:"compared", mismatches:[]});
  expect(compare(actual, {type:"object", properties:{id:{type:"string"}, label:{type:"integer"}}})).toEqual({kind:"compared", mismatches:["/id", "/label"]});
});
test("array variants and escaped property paths retain type conflicts", () => {
  expect(compare({type:"array", items:{anyOf:[{type:"integer"},{type:"string"}]}}, {type:"array",items:{type:"number"}})).toEqual({kind:"compared",mismatches:["/*"]});
  expect(compare({type:"object",properties:{"a/b~c":{type:"integer"}}}, {properties:{"a/b~c":{type:"string"}}}).mismatches).toEqual(["/a~1b~0c"]);
});
test.each([{$ref:"#/definitions/Body"}, {allOf:[{type:"string"}]}, {type:["string","null"]}, {type:"invalid"}, null])("unsupported schemas do not invent compatibility or conflicts: %j", schema => {
  expect(compare({type:"integer"}, schema)).toEqual({kind:"unresolved",mismatches:[]});
});
