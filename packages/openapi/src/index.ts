import { parseContractSnapshot, type ContractSnapshot, type Endpoint } from "@api-truth/ir";
export * from "./compiler.js";
export * from "./preparation.js";

export type OpenApiProjectionDiagnostic = Readonly<{
  code: "UNREPRESENTABLE_ROUTE" | "UNSUPPORTED_METHOD" | "VARIANT_REQUIRES_REPRESENTATION";
  endpointIds: readonly string[];
}>;
export type OpenApiProjectionGroup = Readonly<{
  method: string;
  pathShape: string;
  endpointIds: readonly string[];
  kind: "single" | "selected_single" | "variant_set";
}>;
export type OpenApiProjectionPlan = Readonly<{
  snapshotId: string;
  groups: readonly OpenApiProjectionGroup[];
  diagnostics: readonly OpenApiProjectionDiagnostic[];
}>;

const methods = new Set(["GET", "PUT", "POST", "DELETE", "OPTIONS", "HEAD", "PATCH", "TRACE"]);
const literalSegment = /^[A-Za-z0-9._~-]+$/;
const parameterSegment = /^(?::([A-Za-z_][A-Za-z0-9_]*)|\{([A-Za-z_][A-Za-z0-9_]*)\})$/;
const ascii = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

const projectedShape = (path: string): string | undefined => {
  if (path === "/") return path;
  if (!path.startsWith("/")) return undefined;
  const segments = path.slice(1).split("/");
  const projected: string[] = [];
  for (const segment of segments) {
    if (parameterSegment.test(segment)) projected.push("{}");
    else if (literalSegment.test(segment)) projected.push(segment);
    else return undefined;
  }
  return `/${projected.join("/")}`;
};

const hasSelectors = (endpoint: Endpoint): boolean =>
  Object.values(endpoint.identity.selectors).some((items) => items !== undefined && items.length > 0);

const planValidated = (snapshot: ContractSnapshot): OpenApiProjectionPlan => {
  const candidates = new Map<string, { method: string; pathShape: string; endpoints: Endpoint[] }>();
  const diagnostics: OpenApiProjectionDiagnostic[] = [];
  for (const endpoint of snapshot.endpoints) {
    if (!methods.has(endpoint.identity.method)) {
      diagnostics.push({ code: "UNSUPPORTED_METHOD", endpointIds: [endpoint.endpoint_id] });
      continue;
    }
    const pathShape = projectedShape(endpoint.application_path);
    if (pathShape === undefined) {
      diagnostics.push({ code: "UNREPRESENTABLE_ROUTE", endpointIds: [endpoint.endpoint_id] });
      continue;
    }
    const key = `${endpoint.identity.method}\0${pathShape}`;
    const existing = candidates.get(key);
    if (existing === undefined) candidates.set(key, { method: endpoint.identity.method,
      pathShape, endpoints: [endpoint] });
    else existing.endpoints.push(endpoint);
  }
  const groups = [...candidates.values()].map(({ method, pathShape, endpoints }) => {
    const endpointIds = endpoints.map((endpoint) => endpoint.endpoint_id).sort(ascii);
    const kind = endpoints.length > 1 ? "variant_set" : hasSelectors(endpoints[0]!) ? "selected_single" : "single";
    if (kind === "variant_set") diagnostics.push({ code: "VARIANT_REQUIRES_REPRESENTATION", endpointIds });
    return Object.freeze({ method, pathShape, endpointIds: Object.freeze(endpointIds), kind });
  }).sort((left, right) => ascii(left.method, right.method) || ascii(left.pathShape, right.pathShape));
  diagnostics.sort((left, right) => ascii(left.code, right.code)
    || ascii(left.endpointIds.join("\0"), right.endpointIds.join("\0")));
  return Object.freeze({ snapshotId: snapshot.snapshot_id, groups: Object.freeze(groups),
    diagnostics: Object.freeze(diagnostics) });
};

/** Groups candidate operations without claiming that any route is exportable yet. */
export const planOpenApiProjection = (input: unknown): OpenApiProjectionPlan => {
  const parsed = parseContractSnapshot(input);
  if (!parsed.ok) throw new Error("Invalid contract snapshot");
  return planValidated(parsed.value);
};
