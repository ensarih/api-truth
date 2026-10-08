import {expect,test} from "vitest";
import {selectResponseForStatus as select} from "../../analyzers/nodejs/src/response-schema-resolution.js";
test("exact response wins over default even when unresolved or malformed",()=>{
  const exact={$ref:"#/responses/Missing"},fallback={description:"Default",schema:{type:"object"}};
  expect(select({"201":exact,default:fallback},201)).toEqual({key:"201",response:exact});
  expect(select({"201":null,default:fallback},201)).toEqual({key:"201",response:null});
});
test("default is selected only when the exact code is absent",()=>{
  const response={description:"Default"};
  expect(select({"200":{description:"OK"},default:response},201)).toEqual({key:"default",response});
  expect(select({"2XX":response},201)).toBeUndefined();
});
test.each([0,99,600,201.5,NaN])("invalid source status %s cannot select a response",code=>{
  expect(select({default:{description:"Default"}},code)).toBeUndefined();
});
test("inherited selectors and invalid containers are ignored",()=>{
  expect(select(Object.create({"201":{description:"Inherited"},default:{description:"Inherited default"}}),201)).toBeUndefined();
  for(const input of [undefined,null,[],"invalid"])expect(select(input,201)).toBeUndefined();
});
