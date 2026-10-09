import {readFile} from "node:fs/promises";
import {expect, test} from "vitest";
import {deriveEndpointIdentity, type ContractSnapshot} from "../../packages/ir/src/index.js";
import {correlateMetadataObservation, OBSERVATION_POLICY_VERSION}
  from "../../packages/observations/src/index.js";

const snapshot = JSON.parse(await readFile(new URL("../fixtures/ir/express-snapshot.json", import.meta.url), "utf8")) as ContractSnapshot;
const pin = {state: "resolved_single_revision" as const, tenantId: "tenant-a", serviceId: "orders",
  repositoryId: "commerce", environment: "uat", snapshotId: snapshot.snapshot_id, revision: snapshot.source.immutable_revision,
  configFingerprint: snapshot.config.config_fingerprint, checkpointVersion: "7"};
const mapping = {mappingId: "gateway-orders", tenantId: pin.tenantId, serviceId: pin.serviceId,
  repositoryId: pin.repositoryId, environment: pin.environment, snapshotId: pin.snapshotId, revision: pin.revision,
  configFingerprint: pin.configFingerprint, checkpointVersion: pin.checkpointVersion,
  publicOrigin: "https://api.example.test", publicPathTemplate: "/public/v2/orders/{orderId}",
  applicationPathTemplate: "/api/orders/:orderId", method: "GET",
  routingEvidenceIds: ["gateway-config-7"]};
const observation = {url: "https://api.example.test/public/v2/orders/123?apiKey=CANARY_SECRET_123",
  method: "GET", statusCode: 200, revision: pin.revision,
  headers: {authorization: "Bearer CANARY_SECRET_123", cookie: "session=CANARY_SECRET_123"},
  body: {customer: {email: "CANARY_SECRET_123@example.test", note: "CANARY_SECRET_123"}},
  traceId: "CANARY_SECRET_123"};
const context = () => ({pin: {...pin}, attestation: {revision: pin.revision,
  sourceId: "gateway-log", sourceVersion: "artifact-7",
  windowStart: "2026-10-09T00:00:00Z", windowEnd: "2026-10-09T01:00:00Z"},
  snapshot: structuredClone(snapshot), mappings: [structuredClone(mapping)]});

test("matches an explicit rewritten public URL to one existing endpoint and emits metadata only", () => {
  expect(OBSERVATION_POLICY_VERSION).toBe("metadata-only-1");
  const result = correlateMetadataObservation(observation, context());
  expect(result).toEqual({status: "confirmed", endpointId: "ep-get", mappingId: "gateway-orders",
    method: "GET", statusCode: 200, completeness: "metadata_only", policyVersion: "metadata-only-1"});
  expect(JSON.stringify(result)).not.toMatch(/CANARY_SECRET_123|api\.example\.test|\/public\/|\/api\/orders/);
  expect(result).not.toHaveProperty("required");
  expect(result).not.toHaveProperty("url");
});

test("no payload logs still yield a metadata-only observation without field claims", () => {
  const result = correlateMetadataObservation({url: "https://api.example.test/public/v2/orders/123",
    method: "GET", statusCode: 204, revision: pin.revision}, context());
  expect(result).toMatchObject({status: "confirmed", endpointId: "ep-get", statusCode: 204,
    completeness: "metadata_only"});
  expect(result).not.toHaveProperty("schema");
  expect(result).not.toHaveProperty("example");
});

test("an encoded query value is discarded without affecting the trusted path match", () => {
  const result = correlateMetadataObservation({...observation,
    url: "https://api.example.test/public/v2/orders/123?email=CANARY_SECRET_123%40example.test"}, context());
  expect(result).toMatchObject({status: "confirmed", endpointId: "ep-get"});
  expect(JSON.stringify(result)).not.toContain("CANARY_SECRET_123");
});

test("ambiguous trusted mappings never choose a longest or first match", () => {
  const input = context();
  input.mappings.push({...mapping, mappingId: "gateway-orders-2"});
  const result = correlateMetadataObservation(observation, input);
  expect(result).toEqual({status: "unresolved", reason: "ambiguous_mapping", method: "GET",
    statusCode: 200, completeness: "metadata_only", policyVersion: "metadata-only-1"});
});

test("selector variants cannot be bound from method and path alone", () => {
  const input = context();
  const endpoint = structuredClone(input.snapshot.endpoints[0]!);
  endpoint.endpoint_id = "ep-get-variant";
  endpoint.identity = deriveEndpointIdentity({identity_version: "1.0.0", service_id: "orders",
    method: "GET", application_path: endpoint.application_path,
    selectors: {headers: [{name: "X-Variant", operator: "equals", value: "second"}]}});
  input.snapshot.endpoints.push(endpoint);
  expect(correlateMetadataObservation(observation, input)).toMatchObject({status: "unresolved",
    reason: "unsupported_route_selectors"});
  input.snapshot.endpoints.splice(0, 1);
  expect(correlateMetadataObservation(observation, input)).toMatchObject({status: "unresolved",
    reason: "unsupported_route_selectors"});
});

test("absence of a trusted mapping or discovered endpoint remains unresolved", () => {
  expect(correlateMetadataObservation(observation, {...context(), mappings: []}))
    .toMatchObject({status: "unresolved", reason: "no_mapping"});
  const input = context();
  input.mappings[0]!.applicationPathTemplate = "/unseen/:orderId";
  expect(correlateMetadataObservation(observation, input))
    .toMatchObject({status: "unresolved", reason: "no_endpoint"});
});

test("unknown or mismatched revision cannot be assigned to the current environment contract", () => {
  expect(correlateMetadataObservation({...observation, revision: "other-revision"}, context()))
    .toMatchObject({status: "unresolved", reason: "revision_mismatch"});
  const {revision: _revision, ...withoutRevision} = observation;
  expect(correlateMetadataObservation(withoutRevision, context()))
    .toMatchObject({status: "unresolved", reason: "revision_unknown"});
  expect(correlateMetadataObservation(observation,
    {...context(), pin: {...pin, state: "transitional"}}))
    .toMatchObject({status: "unresolved", reason: "environment_unresolved"});
});

test("snapshot and mapping pins must match the trusted repository and configuration", () => {
  const wrongSnapshot = context();
  wrongSnapshot.snapshot.config.config_fingerprint = "sha256:other";
  expect(correlateMetadataObservation(observation, wrongSnapshot))
    .toMatchObject({status: "rejected", reason: "invalid_context"});
  const wrongRepository = context();
  wrongRepository.snapshot.service.repository_id = "other";
  expect(correlateMetadataObservation(observation, wrongRepository))
    .toMatchObject({status: "rejected", reason: "invalid_context"});
  expect(correlateMetadataObservation(observation,
    {...context(), mappings: [{...mapping, configFingerprint: "sha256:other"}]}))
    .toMatchObject({status: "rejected", reason: "invalid_mapping"});
});

test("raw metadata cannot replace the trusted serving pin", () => {
  const injected = {...observation, pin: {...pin, revision: "other-revision"},
    environment: "prod", mapping: {...mapping, publicOrigin: "https://attacker.test"}};
  expect(correlateMetadataObservation(injected, context()))
    .toMatchObject({status: "confirmed", endpointId: "ep-get"});
  expect(correlateMetadataObservation(observation,
    {...context(), attestation: {...context().attestation, revision: "other-revision"}}))
    .toMatchObject({status: "rejected", reason: "invalid_context"});
  const noAttestation = context() as Partial<ReturnType<typeof context>>;
  delete noAttestation.attestation;
  expect(correlateMetadataObservation(observation, noAttestation as ReturnType<typeof context>))
    .toMatchObject({status: "rejected", reason: "invalid_context"});
  expect(correlateMetadataObservation({...observation, revision: "other-revision"}, context()))
    .toMatchObject({status: "unresolved", reason: "revision_mismatch"});
  expect(correlateMetadataObservation(observation,
    {...context(), attestation: {...context().attestation, sourceVersion: ""}}))
    .toMatchObject({status: "rejected", reason: "invalid_context"});
});

test("malformed method, status, proxy and non-JSON values are rejected with fixed output", () => {
  for (const raw of [
    {...observation, method: "get"}, {...observation, method: "TRACE"},
    {...observation, statusCode: Number.NaN}, {...observation, statusCode: 700},
    {...observation, body: new Date()},
    new Proxy({...observation}, {get() { throw new Error("CANARY_SECRET_123"); }}),
  ]) {
    expect(correlateMetadataObservation(raw, context())).toEqual({status: "rejected",
      reason: "invalid_observation", policyVersion: "metadata-only-1"});
  }
});

test.each([
  ["userinfo", "https://user:CANARY_SECRET_123@api.example.test/public/v2/orders/123"],
  ["fragment", "https://api.example.test/public/v2/orders/123#CANARY_SECRET_123"],
  ["encoded separator", "https://api.example.test/public/v2/orders/a%2Fb"],
  ["encoded dot segment", "https://api.example.test/public/v2/orders/%2e%2e"],
  ["raw dot segment", "https://api.example.test/public/v2/orders/../123"],
  ["backslash", "https://api.example.test/public/v2/orders\\123"],
  ["non-HTTP", "ftp://api.example.test/public/v2/orders/123"],
] as const)("rejects %s without disclosing the URL", (_name, url) => {
  const result = correlateMetadataObservation({...observation, url}, context());
  expect(result).toMatchObject({status: "unresolved", reason: "invalid_url"});
  expect(JSON.stringify(result)).not.toMatch(/CANARY_SECRET_123|api\.example\.test|\/public\//);
});

test("untrusted extras, hostile accessors and bounded size never escape the sanitizer", () => {
  const canary = "CANARY_SECRET_123";
  const suspicious = {...observation, body: {nested: {text: canary}},
    cookies: {session: canary}, requestHeaders: {authorization: canary}, responseBody: canary};
  expect(JSON.stringify(correlateMetadataObservation(suspicious, context()))).not.toContain(canary);
  const getter = Object.defineProperty({...observation}, "body", {enumerable: true,
    get() { throw new Error(canary); }});
  expect(correlateMetadataObservation(getter, context())).toEqual({status: "rejected",
    reason: "invalid_observation", policyVersion: "metadata-only-1"});
  expect(correlateMetadataObservation({...observation, body: "x".repeat(70_000)}, context()))
    .toMatchObject({status: "rejected", reason: "invalid_observation"});
  expect(correlateMetadataObservation({...observation, body: {nested: {a: {b: {c: {d: {e: {f: {g: "x"}}}}}}}}},
    context())).toMatchObject({status: "rejected", reason: "invalid_observation"});
});

test("untrusted mapping scope, origin path and missing routing proof fail closed", () => {
  expect(correlateMetadataObservation(observation,
    {...context(), mappings: [{...mapping, revision: "other-revision"}]}))
    .toMatchObject({status: "rejected", reason: "invalid_mapping"});
  expect(correlateMetadataObservation(observation,
    {...context(), mappings: [{...mapping, publicOrigin: "https://api.example.test/public"}]}))
    .toMatchObject({status: "rejected", reason: "invalid_mapping"});
  expect(correlateMetadataObservation(observation,
    {...context(), mappings: [{...mapping, routingEvidenceIds: []}]}))
    .toMatchObject({status: "rejected", reason: "invalid_mapping"});
});


test("duplicate mapping IDs cannot identify disjoint routing evidence",()=>{
 const input=context();
 input.mappings.push({...mapping,publicOrigin:"https://other.example.test"});
 expect(correlateMetadataObservation(observation,input)).toEqual({status:"rejected",reason:"invalid_mapping",policyVersion:"metadata-only-1"});
});
