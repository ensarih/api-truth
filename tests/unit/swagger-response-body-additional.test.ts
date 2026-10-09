import {expect,test} from "vitest";
import {compareResponseBodyAdditionalProperties as compare} from "../../analyzers/nodejs/src/response-body-comparison.js";
const actual={type:"object" as const,properties:{id:{type:"integer" as const},extra:{type:"string" as const}}};
test("closed objects report only undeclared source fields",()=>{
 expect(compare(actual,{type:"object",properties:{id:{type:"integer"}},additionalProperties:false})).toEqual({kind:"compared",extra:["/extra"]});
});
test.each([{}, {additionalProperties:true}, {properties:{id:{},extra:{}},additionalProperties:false}])("open or matching objects have no extra-field finding",schema=>{
 expect(compare(actual,schema)).toEqual({kind:"compared",extra:[]});
});
test("nested array objects retain escaped field paths",()=>{
 expect(compare({type:"array",items:{type:"object",properties:{"a/b~":{type:"string"}}}},
  {type:"array",items:{type:"object",additionalProperties:false}})).toEqual({kind:"compared",extra:["/*/a~1b~0"]});
});
test("allOf closure applies to each branch independently",()=>{
 expect(compare(actual,{allOf:[{properties:{id:{},extra:{}}},{properties:{id:{}},additionalProperties:false}]})).toEqual({kind:"compared",extra:["/extra"]});
});
test.each([
 {additionalProperties:"false"}, {additionalProperties:{type:"string"}},
 {additionalProperties:false,properties:[]}, {additionalProperties:false,patternProperties:{".*":{}}},
 {allOf:[{additionalProperties:false},{$ref:"#/definitions/Missing"}]},
 {anyOf:[{additionalProperties:false}]}, {oneOf:[]}, {not:{}}, {type:"invalid"}
])("unsupported schemas suppress partial extra findings",schema=>{
 expect(compare(actual,schema)).toEqual({kind:"unresolved",extra:[]});
});
test("bounded findings suppress partial results",()=>{
 const properties=Object.fromEntries(Array.from({length:33},(_,i)=>[String(i),{type:"string" as const}]));
 expect(compare({type:"object",properties},{additionalProperties:false})).toEqual({kind:"unresolved",extra:[]});
});
