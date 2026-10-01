import { expect, test } from "vitest";
import { parseStrictYaml, StrictYamlError } from "../../analyzers/nodejs/src/strict-yaml.js";

test("bounded YAML parser accepts a single JSON-compatible document", () => {
  expect(parseStrictYaml("swagger: '2.0'\npaths:\n  /ping: {get: {responses: {'200': {description: ok}}}}\n"))
    .toMatchObject({ swagger: "2.0", paths: { "/ping": { get: { responses: { "200": { description: "ok" } } } } } });
});

test.each([
  ["alias", "a: &anchor [1]\nb: *anchor\n"],
  ["non-scalar key", "? [one, two]\n: value\n"],
  ["duplicate key", "a: 1\na: 2\n"],
  ["coerced duplicate key", "200: first\n'200': second\n"],
  ["prototype key", "__proto__: {polluted: true}\n"],
  ["custom tag", "a: !custom value\n"],
  ["multiple documents", "a: 1\n---\nb: 2\n"],
])("rejects %s", (_case, source) => {
  expect(() => parseStrictYaml(source)).toThrow(StrictYamlError);
});

test("rejects node and depth limits before converting to JavaScript", () => {
  expect(() => parseStrictYaml("a: [1, 2, 3]", { maxNodes: 2 })).toThrow(StrictYamlError);
  expect(() => parseStrictYaml("a:\n  b:\n    c: value\n", { maxDepth: 1 })).toThrow(StrictYamlError);
});
