import {expect, test} from "vitest";
import {compareResponseBodyPresence as compare} from "../../analyzers/nodejs/src/response-body-comparison.js";

test("reports missing documented required fields without inventing source requiredness", () => {
  expect(compare({type:"object",properties:{id:{type:"integer"}}}, {type:"object",required:["id","name"],properties:{id:{type:"integer"},name:{type:"string"},optional:{type:"string"}}}))
    .toEqual({kind:"compared",missing:["/name"]});
  expect(compare({type:"object",properties:{id:{type:"integer"}}}, {type:"object",required:["id"],properties:{optional:{type:"string"}}}))
    .toEqual({kind:"compared",missing:[]});
});

test("nested fields, escaped names and array variants preserve missing paths", () => {
  expect(compare({type:"object",properties:{detail:{type:"object",properties:{}}}}, {type:"object",properties:{detail:{type:"object",required:["a/b~c"]}}}))
    .toEqual({kind:"compared",missing:["/detail/a~1b~0c"]});
  expect(compare({type:"array",items:{anyOf:[{type:"object",properties:{id:{type:"integer"}}},{type:"object",properties:{}}]}}, {type:"array",items:{type:"object",required:["id"]}}))
    .toEqual({kind:"compared",missing:["/*/id"]});
});

test("null fields are present and empty arrays do not invent missing items", () => {
  expect(compare({type:"object",properties:{name:{type:"null"}}}, {type:"object",required:["name"]})).toEqual({kind:"compared",missing:[]});
  expect(compare({type:"array"}, {type:"array",items:{type:"object",required:["id"]}})).toEqual({kind:"compared",missing:[]});
  expect(compare({type:"null"}, {type:"object",required:["id"]})).toEqual({kind:"compared",missing:[]});
});

test.each([{$ref:"#/definitions/Body"}, {allOf:[{required:["id"]}]}, {required:"id"}, {required:["id","id"]}, {required:[""]}, {required:[2]}, {properties:null}])
("unsupported required-field schemas remain unresolved: %j", schema => {
  expect(compare({type:"object",properties:{}}, schema)).toEqual({kind:"unresolved",missing:[]});
});

test("unsupported nested schemas suppress partial absence findings", () => {
  expect(compare({type:"object",properties:{child:{type:"object",properties:{}}}}, {required:["missing"],properties:{child:{$ref:"#/definitions/Child"}}}))
    .toEqual({kind:"unresolved",missing:[]});
});

test("comparison depth and output bounds are enforced", () => {
  expect(compare({type:"object",properties:{}}, {required:Array.from({length:33}, (_,i)=>`field${i}`)})).toEqual({kind:"unresolved",missing:[]});
  let actual: any = {type:"object",properties:{}}; let schema: any = {required:["missing"]};
  for(let i=0;i<65;i++){ actual={type:"object",properties:{child:actual}}; schema={properties:{child:schema}}; }
  expect(compare(actual,schema)).toEqual({kind:"unresolved",missing:[]});
});
