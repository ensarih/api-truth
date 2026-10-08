import {expect, test} from "vitest";
import {declaredEnum, declaredSchemaConstraints} from "../../analyzers/nodejs/src/schema-constraints.js";

test("enum resource limits and non-JSON members fail closed", () => {
  let deep: unknown = "leaf";
  for (let i = 0; i < 34; i++) deep = [deep];
  for (const enumeration of [[deep], [Array.from({length: 10001}, (_, i) => i)],
    [undefined], [NaN], [Infinity], [new Date()], [() => true]])
    expect(declaredEnum(enumeration)).toEqual({error: "schema_enum_unsupported"});
});

test("enum equality retains primitive types and detects equivalent zero values", () => {
  expect(declaredEnum([0, -0])).toEqual({error: "schema_enum_duplicate"});
  expect(declaredEnum([0, false, "0", null]).value).toEqual([0, false, "0", null]);
});

test("Unicode-invalid patterns are diagnosed without retaining compiler messages", () => {
  const diagnostics: Array<[string, string]> = [];
  const output = declaredSchemaConstraints({type: "string", pattern: "\\a"}, "/schema",
    (code, pointer) => diagnostics.push([code, pointer]));
  expect(output).toEqual({});
  expect(diagnostics).toEqual([["schema_pattern_unsupported", "/schema/pattern"]]);
});
