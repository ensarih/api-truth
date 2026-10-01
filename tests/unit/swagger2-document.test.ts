import { expect, test } from "vitest";
import { parseSwagger2Document } from "../../analyzers/nodejs/src/swagger2-document.js";

const base = {
  swagger: "2.0",
  info: { title: "Orders", version: "1" },
  paths: {
    "/orders/{id}": {
      parameters: [{ name: "id", in: "path", required: true, type: "string" }],
      get: {
        operationId: "getOrder",
        parameters: [{ name: "id", in: "path", required: true, type: "integer" }],
        responses: { "200": { description: "ok", schema: { $ref: "#/definitions/Order" } } },
      },
    },
  },
  definitions: { Order: { type: "object", properties: { id: { type: "string" } } } },
};

test("discovers operations and applies operation parameter overrides", () => {
  const parsed = parseSwagger2Document(base);
  expect(parsed.status).toBe("success");
  expect(parsed.operations).toHaveLength(1);
  expect(parsed.operations[0]).toMatchObject({ method: "get", path: "/orders/{id}", operationId: "getOrder" });
  expect(parsed.operations[0]?.parameters[0]).toMatchObject({ name: "id", in: "path", type: "integer" });
  expect(parsed.operations[0]?.responses[0]).toMatchObject({ selector: { kind: "exact", code: 200 } });
  expect(parsed.definitions).toHaveProperty("Order");
});

test("keeps absent media and security explicitly unknown; empty security is anonymous", () => {
  const parsed = parseSwagger2Document(base);
  expect(parsed.operations[0]?.consumes).toEqual({ state: "unknown" });
  expect(parsed.operations[0]?.produces).toEqual({ state: "unknown" });
  expect(parsed.operations[0]?.security).toEqual({ state: "unknown" });

  const anonymous = parseSwagger2Document({ ...base, security: [] });
  expect(anonymous.operations[0]?.security).toEqual({ state: "anonymous" });
});

test("does not report absent operation parameters as unsupported", () => {
  const document = structuredClone(base) as any;
  delete document.paths["/orders/{id}"].get.parameters;
  expect(parseSwagger2Document(document).status).toBe("success");
});

test("honors operation media and security overrides including explicit empty security", () => {
  const document = structuredClone(base) as any;
  document.consumes = ["application/json"];
  document.produces = ["application/json"];
  document.security = [{ bearer: [] }];
  document.securityDefinitions = { bearer: { type: "apiKey", name: "Authorization", in: "header" } };
  document.paths["/orders/{id}"].get.consumes = ["application/xml"];
  document.paths["/orders/{id}"].get.security = [];
  const operation = parseSwagger2Document(document).operations[0];
  expect(operation?.consumes).toEqual({ state: "known", values: ["application/xml"] });
  expect(operation?.produces).toEqual({ state: "known", values: ["application/json"] });
  expect(operation?.security).toEqual({ state: "anonymous" });
});

test("rejects malformed documents and external or missing local references safely", () => {
  expect(parseSwagger2Document({ swagger: "3.0", paths: {} }).status).toBe("failed");
  const external = structuredClone(base) as any;
  external.paths["/orders/{id}"].get.responses["200"].schema.$ref = "https://example.test/order.json";
  expect(parseSwagger2Document(external)).toMatchObject({ status: "failed", operations: [] });
  const missing = structuredClone(base) as any;
  missing.paths["/orders/{id}"].get.responses["200"].schema.$ref = "#/definitions/Missing";
  expect(parseSwagger2Document(missing).diagnostics.map((item) => item.code)).toContain("missing_local_ref");
});

test("reports unsupported constructs and rejects prototype-pollution keys", () => {
  const unsupported = structuredClone(base) as any;
  unsupported.paths["/orders/{id}"].get["x-vendor-mode"] = true;
  const parsed = parseSwagger2Document(unsupported);
  expect(parsed.status).toBe("partial");
  expect(parsed.diagnostics).toContainEqual(expect.objectContaining({ code: "unsupported_field", pointer: "/paths/~1orders~1{id}/get/x-vendor-mode" }));

  const polluted = JSON.parse('{"swagger":"2.0","info":{"title":"x","version":"1"},"paths":{},"__proto__":{"polluted":true}}');
  expect(parseSwagger2Document(polluted).status).toBe("failed");
});

test("diagnoses unhandled base paths and malformed security", () => {
  const document = structuredClone(base) as any;
  document.basePath = "/v1";
  document.security = "not-an-array";
  const parsed = parseSwagger2Document(document);
  expect(parsed.status).toBe("partial");
  expect(parsed.operations[0]?.security).toEqual({ state: "unknown" });
  expect(parsed.diagnostics.map((item) => item.code)).toContain("unsupported_construct");
});
