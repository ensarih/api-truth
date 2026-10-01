import { expect, test } from "vitest";
import { parseStrictJson, StrictJsonError } from "../../analyzers/nodejs/src/strict-json.js";

test("accepts valid JSON and rejects duplicate decoded property names at any depth", () => {
  expect(parseStrictJson('{"a":1,"nested":{"b":[true,null,"x"]}}')).toEqual({ a: 1, nested: { b: [true, null, "x"] } });
  for (const text of ['{"a":1,"a":2}', '{"x":{"key":1,"key":2}}', '{"a":1,"\\u0061":2}']) {
    expect(() => parseStrictJson(text)).toThrow(StrictJsonError);
    try { parseStrictJson(text); } catch (error) { expect((error as StrictJsonError).code).toBe("duplicate_json_key"); }
  }
});

test("rejects malformed, overdeep, and oversized-node JSON safely", () => {
  expect(() => parseStrictJson('{"a":')).toThrow(StrictJsonError);
  const deep = `${'['.repeat(130)}0${']'.repeat(130)}`;
  try { parseStrictJson(deep); } catch (error) { expect((error as StrictJsonError).code).toBe("document_structure_limit_exceeded"); }
  const broad = `[${Array.from({ length: 1001 }, () => "0").join(",")}]`;
  try { parseStrictJson(broad, { maxNodes: 1000 }); } catch (error) { expect((error as StrictJsonError).code).toBe("document_structure_limit_exceeded"); }
});
