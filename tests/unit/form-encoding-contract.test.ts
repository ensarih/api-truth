import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";
import { parseContractSnapshot } from "../../packages/ir/src/index.js";

async function fixture() {
  const snapshot = JSON.parse(await readFile(new URL("../fixtures/ir/express-snapshot.json", import.meta.url), "utf8"));
  snapshot.ir_version = "1.1.0";
  const endpoint = snapshot.endpoints[0];
  endpoint.request_bodies = [{media_type: "application/x-www-form-urlencoded",
    schema: {type: "object", properties: {tags: {type: "array", items: {type: "string"}}}},
    serialization: {format: "urlencoded"}, presence: {state: "optional", evidence_ids: [endpoint.evidence_ids[0]]},
    encoding: {tags: {style: "form", explode: false, evidence_ids: [endpoint.evidence_ids[0]]}}}];
  return snapshot;
}
test("form encoding is optional for existing snapshots and retains supported per-property facts", async () => {
  const snapshot = await fixture();
  expect(parseContractSnapshot(snapshot).ok).toBe(true);
  delete snapshot.endpoints[0].request_bodies[0].encoding;
  snapshot.ir_version = "1.0.0";
  expect(parseContractSnapshot(snapshot).ok).toBe(true);
});

test("encoding cannot reference missing evidence, absent fields or non-form media", async () => {
  for (const mutation of [
    (body: any) => {body.encoding.tags.evidence_ids = ["missing"];},
    (body: any) => {body.encoding.other = body.encoding.tags;},
    (body: any) => {body.media_type = "application/json";},
    (body: any) => {body.schema = {$ref: "#/schemas/Customer"};},
    (body: any) => {body.encoding.tags.explode = undefined;},
    (body: any) => {body.encoding.tags.style = "spaceDelimited"; body.encoding.tags.explode = true;},
    (body: any) => {body.encoding.tags.content_type = "text/plain";},
    (body: any) => {body.encoding.tags.style = "unknown";},
  ]) {
    const snapshot = await fixture(); mutation(snapshot.endpoints[0].request_bodies[0]);
    expect(parseContractSnapshot(snapshot).ok).toBe(false);
  }
});

test("part content type is an alternative to style encoding for multipart file properties", async () => {
  const snapshot = await fixture();
  const body = snapshot.endpoints[0].request_bodies[0];
  body.media_type = "multipart/form-data"; body.serialization = {format: "multipart"};
  body.schema.properties.tags = {type: "string", format: "binary"};
  body.encoding.tags = {content_type: "application/octet-stream", evidence_ids: body.presence.evidence_ids};
  expect(parseContractSnapshot(snapshot).ok).toBe(true);
});


test("legacy version cannot carry encoding while newer versions require an explicit supported version", async () => {
  const snapshot = await fixture(); snapshot.ir_version = "1.0.0";
  expect(parseContractSnapshot(snapshot).ok).toBe(false);
  snapshot.ir_version = "1.2.0";
  expect(parseContractSnapshot(snapshot).ok).toBe(false);
});

test("embedded schema validation accepts type unions and prefixItems but rejects unknown union members", async () => {
  const snapshot = await fixture();
  delete snapshot.endpoints[0].request_bodies[0].encoding;
  const component = snapshot.schemas[Object.keys(snapshot.schemas)[0]!];
  component.schema = {type: ["array", "null"], prefixItems: [{const: "order"}, {type: "integer"}]};
  expect(parseContractSnapshot(snapshot).ok).toBe(true);
  component.schema.type = ["array", "mystery"];
  expect(parseContractSnapshot(snapshot).ok).toBe(false);
});
