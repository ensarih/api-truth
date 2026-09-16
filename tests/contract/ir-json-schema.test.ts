import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import * as addFormatsModule from "ajv-formats";
import { beforeAll, describe, expect, test } from "vitest";
import {
  deriveEndpointIdentity,
  jsonSchemaCatalog,
  jsonSchemas,
  parseContractSnapshot,
} from "../../packages/ir/src/index.js";

let expressSnapshot: Record<string, any>;
let springDesign: Record<string, any>;
let springDeclarations: Record<string, any>;

beforeAll(async () => {
  const load = async (relative: string) => JSON.parse(await readFile(fileURLToPath(new URL(relative, import.meta.url)), "utf8"));
  [expressSnapshot, springDesign, springDeclarations] = await Promise.all([
    load("../fixtures/ir/express-snapshot.json"),
    load("../../fixtures/java/orders/expected.json"),
    load("../../fixtures/java/orders/declaration-schemas.json"),
  ]);
});

const springSnapshot = () => {
  const snapshot = structuredClone(expressSnapshot);
  snapshot.snapshot_id = "snapshot-orders-java-a";
  snapshot.source = { repository_id: "commerce", immutable_revision: "rev-java-a", source_digest: "sha256:java-a" };
  snapshot.analyzer = { analyzer_id: "java-spring-mvc", analyzer_version: "1.0.0" };
  snapshot.coverage = { status: "complete", analyzed_roots: [springDesign.source_root], diagnostic_ids: ["diag-status"] };
  snapshot.evidence = [
    {
      evidence_id: "ev-java-type", source: { kind: "source_code", source_id: "commerce" }, source_version: "rev-java-a",
      location: { path: springDesign.controller.source, symbol: springDesign.controller.symbol }, method: "type_declaration",
      scope: { service_id: "orders", snapshot_id: snapshot.snapshot_id }, limitations: ["response status is not declared"], access_label: "orders-read",
    },
    {
      evidence_id: "ev-java-validator", source: { kind: "source_code", source_id: "commerce" }, source_version: "rev-java-a",
      location: { path: springDeclarations.source, symbol: "CreateOrderRequest" }, method: "runtime_validator",
      scope: { service_id: "orders", snapshot_id: snapshot.snapshot_id }, limitations: ["nullable parents without @NotNull remain unknown"], access_label: "orders-read",
    },
  ];
  snapshot.schemas = {
    OrderResponse: { schema_id: "OrderResponse", schema: { type: "object", properties: { id: { type: "string" }, state: { type: "string" } } }, evidence_ids: ["ev-java-type"] },
    CreateOrderRequest: {
      schema_id: "CreateOrderRequest",
      schema: { type: "object", properties: { customer: { type: "object", properties: { id: { type: "string" }, address: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } }, required: ["id"] }, items: { type: "array", items: { type: "object", properties: { sku: { type: "string" }, quantity: { type: "integer", minimum: 1 } }, required: ["sku"] } } }, required: ["items"] },
      evidence_ids: ["ev-java-type", "ev-java-validator"],
    },
  };
  snapshot.endpoints = springDesign.routes.map((route: Record<string, any>) => {
    const selectors = {
      ...(route.selectors?.headers ? { headers: route.selectors.headers.map((header: string) => {
        const [name, value] = header.split("=");
        return { name, operator: "equals", value };
      }) } : {}),
      ...(route.selectors?.consumes ? { consumes: route.selectors.consumes } : {}),
      ...(route.selectors?.produces ? { produces: route.selectors.produces } : {}),
    };
    const identity = deriveEndpointIdentity({ identity_version: "1.0.0", service_id: "orders", method: route.method, application_path: route.application_path, selectors });
    return {
      endpoint_id: `ep-${route.id}`,
      identity,
      application_path: route.application_path,
      parameters: (route.request.path_parameters ?? []).map((name: string) => ({ name, in: "path", presence: { state: "required", evidence_ids: ["ev-java-type"] }, schema: { type: "string" }, serialization: { style: "simple" } })),
      request_bodies: route.id === "create-java-order" ? [{ media_type: "application/json", schema: { $ref: "#/schemas/CreateOrderRequest" }, serialization: { format: "json" }, presence: { state: "unknown", evidence_ids: ["ev-java-validator"] } }] : [],
      responses: [{ status: { kind: "unknown", reason: "not declared" }, content: [{ media_type: route.response.media_types[0], schema: { $ref: "#/schemas/OrderResponse" }, serialization: { format: "json" } }] }],
      security: { alternatives: [] },
      evidence_ids: ["ev-java-type"],
    };
  });
  snapshot.claims = [];
  snapshot.editorial_reviews = [];
  snapshot.export_eligibility = [];
  snapshot.dependencies = [];
  snapshot.diagnostics = [{ diagnostic_id: "diag-status", code: "response_status_unknown", severity: "warning", message: "Response status is not declared", affected_endpoint_ids: snapshot.endpoints.map((endpoint: Record<string, any>) => endpoint.endpoint_id), evidence_ids: ["ev-java-type"] }];
  return snapshot;
};

describe("canonical JSON Schema exports", () => {
  test("exports every public boundary as a versioned JSON Schema", () => {
    expect(Object.keys(jsonSchemas).sort()).toEqual([
      "analyzerRequest", "analyzerResult", "config", "contractSnapshot", "event", "viewSelector",
    ]);
    expect(jsonSchemaCatalog.length).toBeGreaterThan(6);
    for (const schema of jsonSchemaCatalog) {
      expect(schema.$id).toMatch(/^https:\/\/api-truth\.dev\/schemas\//);
    }
  });

  test("independent Ajv 2020 validates schema structure and representative wire data", () => {
    const ajv = new Ajv2020({ strict: true, allErrors: true });
    (addFormatsModule.default as unknown as (instance: Ajv2020) => void)(ajv);
    for (const schema of jsonSchemaCatalog) {
      expect(ajv.validateSchema(schema)).toBe(true);
      ajv.addSchema(schema);
    }
    const snapshotSchemaId = jsonSchemas.contractSnapshot.$id;
    expect(typeof snapshotSchemaId).toBe("string");
    expect(ajv.getSchema(snapshotSchemaId as string)?.(expressSnapshot)).toBe(true);
  });

  test("converts the D02 Spring design facts into a valid canonical snapshot with header variants", () => {
    const candidate = springSnapshot();
    const result = parseContractSnapshot(candidate);
    expect(result).toMatchObject({ ok: true });
    expect(candidate.endpoints[0].identity.route_key).not.toBe(candidate.endpoints[1].identity.route_key);
    expect(candidate.endpoints[2].request_bodies[0].presence.state).toBe("unknown");
  });
});
