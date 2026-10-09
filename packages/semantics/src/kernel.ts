import {isProxy} from "node:util/types";
import {parseContractSnapshot, type Claim, type ContractSnapshot, type Evidence} from "../../ir/src/index.js";
import {parseQuerySelection} from "../../query/src/selector.js";
import {isSemanticDocumentTextSafe as documentTextSafe, isSemanticIntentQuerySafe,
  isSemanticSourceIdentifierSafe, isSemanticSourceRouteSafe} from "./egress.js";
import type {SemanticAnalysisInput, SemanticAnalysisResult, SemanticDiscoveryInput, SemanticDocumentKind,
  SemanticContextCoverage, SemanticProviderId, SemanticProviderPort, SemanticProviderRequest,
  SemanticProvenance} from "./types.js";

export const SEMANTIC_PROMPT_VERSION = "semantic-grounding-1" as const;
export const SEMANTIC_DISCOVERY_PROMPT_VERSION = "semantic-discovery-1" as const;
export const SEMANTIC_DISCOVERY_SOURCE_PROMPT_VERSION = "semantic-discovery-source-1" as const;

export class SemanticAnalysisError extends Error {
  readonly code: "SEMANTIC_INVALID_CONTEXT" | "SEMANTIC_PROVIDER_ERROR" | "SEMANTIC_OUTPUT_REJECTED";
  constructor(code: SemanticAnalysisError["code"]) {super(code); this.name = "SemanticAnalysisError"; this.code = code;}
}

const id = (value: unknown): value is string => typeof value === "string" && value.length <= 128
  && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
const text = (value: unknown, max: number): value is string => typeof value === "string"
  && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const plain = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value) && !isProxy(value)
  && Object.getPrototypeOf(value) === Object.prototype
  && Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));

/** Detached bounded JSON; reject proxies, accessors, cycles, functions, and oversized values. */
const detachedJson = (value: unknown, maxBytes: number, maxNodes: number, maxDepth: number): unknown => {
  const seen = new Set<object>();
  let nodes = 0;
  let bytes = 0;
  const add = (value: string): void => {
    if (value.length > 65_536) throw new Error();
    bytes += Buffer.byteLength(value, "utf8");
    if (bytes > maxBytes) throw new Error();
  };
  const walk = (item: unknown, depth: number): unknown => {
    if (++nodes > maxNodes || depth > maxDepth) throw new Error();
    if (typeof item === "string") {add(item); return item;}
    if (typeof item === "number") {if (!Number.isFinite(item)) throw new Error(); return item;}
    if (item === null || typeof item === "boolean") return item;
    if (typeof item !== "object" || isProxy(item) || seen.has(item)) throw new Error();
    seen.add(item);
    const array = Array.isArray(item);
    const prototype: unknown = Object.getPrototypeOf(item);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype) throw new Error();
    const keys = Reflect.ownKeys(item);
    if (keys.length > 4097) throw new Error();
    const entries: Array<[string, unknown]> = [];
    for (const key of keys) {
      if (typeof key !== "string") throw new Error();
      add(key);
      if (array && key === "length") continue;
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (!descriptor || !("value" in descriptor)) throw new Error();
      entries.push([key, walk(descriptor.value, depth + 1)]);
    }
    if (array && keys.length - 1 !== item.length) throw new Error();
    if (array) {
      const values: unknown[] = [];
      for (let index = 0; index < entries.length; index += 1) {
        if (entries[index]?.[0] !== String(index)) throw new Error();
        values.push(entries[index]![1]);
      }
      seen.delete(item);
      return values;
    }
    seen.delete(item);
    return Object.fromEntries(entries);
  };
  return walk(value, 0);
};

const freezeDeep = <T>(value: T): T => {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
};

const validateSelection = (input: SemanticAnalysisInput): void => {
  const {snapshot, pin, selection} = input;
  try {parseQuerySelection(selection);} catch {throw new SemanticAnalysisError("SEMANTIC_INVALID_CONTEXT");}
  const validVersion = (value: unknown): value is string => typeof value === "string"
    && /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n;
  const pinKeys = ["snapshotId", "revision", "configFingerprint",
    ...(Object.hasOwn(pin, "pointerVersion") ? ["pointerVersion"] : []),
    ...(Object.hasOwn(pin, "checkpointVersion") ? ["checkpointVersion"] : [])];
  if (!plain(selection, ["version", "tenantId", "repositoryId", "serviceId", "selector"])
    || selection.version !== "1" || !id(selection.tenantId) || !id(selection.repositoryId)
    || !id(selection.serviceId) || !plain(pin, pinKeys) || !id(pin.snapshotId)
    || !id(pin.revision) || !id(pin.configFingerprint)
    || selection.repositoryId !== snapshot.service.repository_id
    || selection.repositoryId !== snapshot.source.repository_id
    || selection.serviceId !== snapshot.service.service_id
    || pin.snapshotId !== snapshot.snapshot_id
    || pin.revision !== snapshot.source.immutable_revision
    || pin.configFingerprint !== snapshot.config.config_fingerprint)
    throw new SemanticAnalysisError("SEMANTIC_INVALID_CONTEXT");
  const selector = selection.selector;
  if (!selector || typeof selector !== "object" || Array.isArray(selector))
    throw new SemanticAnalysisError("SEMANTIC_INVALID_CONTEXT");
  if (selector.kind === "environment") {
    if (!plain(selector, ["kind", "environment", "expectedCheckpointVersion"])
      || pin.pointerVersion !== undefined || !text(selector.environment, 512) || !validVersion(pin.checkpointVersion)
      || selector.expectedCheckpointVersion !== pin.checkpointVersion) throw new SemanticAnalysisError("SEMANTIC_INVALID_CONTEXT");
  } else if (selector.kind === "branch") {
    if (!plain(selector, ["kind", "branch", "expectedPointerVersion"])
      || pin.checkpointVersion !== undefined || !text(selector.branch, 512) || !validVersion(pin.pointerVersion)
      || selector.expectedPointerVersion !== pin.pointerVersion) throw new SemanticAnalysisError("SEMANTIC_INVALID_CONTEXT");
  } else if (selector.kind === "revision") {
    if (!plain(selector, ["kind", "revision"]) || pin.pointerVersion !== undefined
      || pin.checkpointVersion !== undefined || selector.revision !== pin.revision)
      throw new SemanticAnalysisError("SEMANTIC_INVALID_CONTEXT");
  } else throw new SemanticAnalysisError("SEMANTIC_INVALID_CONTEXT");
};

const documentText = (claim: Claim): {kind: SemanticDocumentKind; text: string} | undefined => {
  if (claim.subject.schema_pointer !== undefined || claim.verification !== "declared") return undefined;
  if (claim.predicate === "operation.summary" && documentTextSafe(claim.value, 2_048))
    return {kind: "operation_summary", text: claim.value};
  if (claim.predicate === "operation.description" && documentTextSafe(claim.value, 2_048))
    return {kind: "operation_description", text: claim.value};
  if (claim.predicate === "response.description" && claim.value && typeof claim.value === "object"
    && !Array.isArray(claim.value) && documentTextSafe((claim.value as {description?: unknown}).description, 2_048))
    return {kind: "response_description", text: (claim.value as {description: string}).description};
  if (claim.predicate === "route.declaration" && claim.value && typeof claim.value === "object"
    && !Array.isArray(claim.value) && documentTextSafe((claim.value as {operationId?: unknown}).operationId, 128))
    return {kind: "operation_id", text: (claim.value as {operationId: string}).operationId};
  return undefined;
};

const evidenceFor = (evidence: Evidence | undefined, snapshot: ContractSnapshot,
  endpointId: string): boolean => !!evidence && evidence.source.kind === "api_document"
  && evidence.source.source_id === snapshot.source.repository_id
  && evidence.source_version === snapshot.source.immutable_revision
  && evidence.method === "type_declaration" && evidence.scope.service_id === snapshot.service.service_id
  && evidence.scope.snapshot_id === snapshot.snapshot_id
  && (evidence.scope.endpoint_id === undefined || evidence.scope.endpoint_id === endpointId)
  && evidence.scope.revision === snapshot.source.immutable_revision;

const sourceEvidenceFor = (evidence: Evidence | undefined, snapshot: ContractSnapshot,
  endpointId: string): boolean => !!evidence && evidence.source.kind === "source_code"
  && evidence.source.source_id === snapshot.source.repository_id
  && evidence.source_version === snapshot.source.immutable_revision
  && (evidence.method === "deterministic_analysis" || evidence.method === "type_declaration")
  && evidence.scope.service_id === snapshot.service.service_id
  && evidence.scope.snapshot_id === snapshot.snapshot_id
  && evidence.scope.endpoint_id === endpointId
  && evidence.scope.revision === snapshot.source.immutable_revision;

const sourceClaimEvidence = (claim: Claim, evidence: ReadonlyMap<string, Evidence>,
  snapshot: ContractSnapshot, endpointId: string): boolean => claim.evidence_ids.length > 0
  && claim.evidence_ids.length <= 8 && new Set(claim.evidence_ids).size === claim.evidence_ids.length
  && claim.evidence_ids.every(evidenceId => sourceEvidenceFor(evidence.get(evidenceId), snapshot, endpointId));

const exactObject = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value) && !isProxy(value)
  && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).length === keys.length
  && Object.keys(value).every(key => keys.includes(key));

const sourceProjection = (input: SemanticAnalysisInput): SemanticProviderRequest["endpoints"] => {
  const evidence = new Map(input.snapshot.evidence.map(item => [item.evidence_id, item]));
  const selected = new Set(input.endpointIds);
  const endpoints: SemanticProviderRequest["endpoints"][number][] = [];
  let totalText = 0;
  for (const endpoint of input.snapshot.endpoints) {
    if (!selected.has(endpoint.endpoint_id) || !isSemanticSourceRouteSafe(endpoint.identity.method, endpoint.application_path)) continue;
    const claims = input.snapshot.claims.filter(claim => claim.subject.endpoint_id === endpoint.endpoint_id
      && claim.subject.service_id === input.snapshot.service.service_id && claim.subject.schema_pointer === undefined);
    const routes = claims.filter(claim => claim.predicate === "route.registration" || claim.predicate === "route.declaration");
    if (routes.length !== 1) continue;
    const route = routes[0]!;
    if (!sourceClaimEvidence(route, evidence, input.snapshot, endpoint.endpoint_id)) continue;
    const documents: SemanticProviderRequest["endpoints"][number]["documents"][number][] = [];
    if (route.predicate === "route.registration" && route.verification === "established_by_analysis"
      && exactObject(route.value, ["method", "path"]) && route.value.method === endpoint.identity.method
      && route.value.path === endpoint.application_path
      && isSemanticSourceRouteSafe(route.value.method, route.value.path)) {
      documents.push({kind: "code_route", text: `${route.value.method} ${route.value.path}`,
        evidenceIds: [...route.evidence_ids]});
      const handlers = claims.filter(claim => claim.predicate === "handler.symbol");
      if (handlers.length === 1) {
        const handler = handlers[0]!;
        if (handler.verification === "established_by_analysis"
          && exactObject(handler.value, ["symbol"]) && isSemanticSourceIdentifierSafe(handler.value.symbol)
          && sourceClaimEvidence(handler, evidence, input.snapshot, endpoint.endpoint_id))
          documents.push({kind: "code_handler", text: handler.value.symbol, evidenceIds: [...handler.evidence_ids]});
      }
    } else if (route.predicate === "route.declaration" && route.verification === "declared"
      && exactObject(route.value, ["method", "path", "controller", "action"])
      && route.value.method === endpoint.identity.method && route.value.path === endpoint.application_path
      && isSemanticSourceRouteSafe(route.value.method, route.value.path)
      && isSemanticSourceIdentifierSafe(route.value.controller) && isSemanticSourceIdentifierSafe(route.value.action)) {
      documents.push({kind: "code_route", text: `${route.value.method} ${route.value.path}`,
        evidenceIds: [...route.evidence_ids]});
      documents.push({kind: "code_action", text: `${route.value.controller}.${route.value.action}`,
        evidenceIds: [...route.evidence_ids]});
    }
    if (!documents.length) continue;
    totalText += documents.reduce((sum, document) => sum + Buffer.byteLength(document.text, "utf8"), 0);
    if (documents.length > 3 || totalText > 16_384)
      throw new SemanticAnalysisError("SEMANTIC_INVALID_CONTEXT");
    endpoints.push({endpointId: endpoint.endpoint_id, method: endpoint.identity.method,
      applicationPath: endpoint.application_path, documents});
  }
  return endpoints;
};

const projection = (input: SemanticAnalysisInput): SemanticProviderRequest["endpoints"] => {
  const evidence = new Map(input.snapshot.evidence.map(item => [item.evidence_id, item]));
  const selected = new Set(input.endpointIds);
  const endpoints: SemanticProviderRequest["endpoints"][number][] = [];
  let totalText = 0;
  for (const endpoint of input.snapshot.endpoints) {
    if (!selected.has(endpoint.endpoint_id)) continue;
    const documents: SemanticProviderRequest["endpoints"][number]["documents"][number][] = [];
    for (const claim of input.snapshot.claims) {
      if (claim.subject.endpoint_id !== endpoint.endpoint_id
        || claim.subject.service_id !== input.snapshot.service.service_id) continue;
      const doc = documentText(claim);
      if (!doc || claim.evidence_ids.length < 1 || claim.evidence_ids.length > 8
        || !claim.evidence_ids.every(evidenceId => evidenceFor(evidence.get(evidenceId), input.snapshot,
          endpoint.endpoint_id))) continue;
      if (documents.length >= 16) throw new SemanticAnalysisError("SEMANTIC_INVALID_CONTEXT");
      totalText += Buffer.byteLength(doc.text, "utf8");
      if (totalText > 16_384) throw new SemanticAnalysisError("SEMANTIC_INVALID_CONTEXT");
      documents.push({kind: doc.kind, text: doc.text, evidenceIds: [...claim.evidence_ids]});
    }
    if (!documents.some(doc => doc.kind !== "operation_id")) continue;
    if (endpoint.application_path.length > 512) throw new SemanticAnalysisError("SEMANTIC_INVALID_CONTEXT");
    endpoints.push({endpointId: endpoint.endpoint_id, method: endpoint.identity.method,
      applicationPath: endpoint.application_path, documents});
  }
  return endpoints;
};

const mergeSourceAndDocumentContext = (sourceEndpoints: SemanticProviderRequest["endpoints"],
  documentEndpoints: SemanticProviderRequest["endpoints"]): SemanticProviderRequest["endpoints"] => {
  const documentsByEndpoint = new Map(documentEndpoints.filter(endpoint =>
    isSemanticSourceRouteSafe(endpoint.method, endpoint.applicationPath)).map(endpoint => [endpoint.endpointId, endpoint]));
  const merged: SemanticProviderRequest["endpoints"][number][] = [];
  let totalText = 0;
  for (const sourceEndpoint of sourceEndpoints) {
    const documentEndpoint = documentsByEndpoint.get(sourceEndpoint.endpointId);
    const allDocuments = [...(documentEndpoint?.documents ?? []), ...sourceEndpoint.documents];
    const byContent = new Map<string, {kind: SemanticDocumentKind; text: string; evidenceIds: string[]}>();
    for (const document of allDocuments) {
      const key = JSON.stringify([document.kind, document.text]);
      const existing = byContent.get(key);
      if (existing) {
        for (const evidenceId of document.evidenceIds) if (!existing.evidenceIds.includes(evidenceId))
          existing.evidenceIds.push(evidenceId);
        if (existing.evidenceIds.length > 8) throw new SemanticAnalysisError("SEMANTIC_INVALID_CONTEXT");
      } else byContent.set(key, {kind: document.kind, text: document.text, evidenceIds: [...document.evidenceIds]});
    }
    const documents = [...byContent.values()];
    if (documents.length > 16) throw new SemanticAnalysisError("SEMANTIC_INVALID_CONTEXT");
    totalText += documents.reduce((sum, document) => sum + Buffer.byteLength(document.text, "utf8"), 0);
    if (totalText > 16_384) throw new SemanticAnalysisError("SEMANTIC_INVALID_CONTEXT");
    merged.push({...sourceEndpoint, documents});
    documentsByEndpoint.delete(sourceEndpoint.endpointId);
  }
  // Source-profile requests contain source context by definition. Keep document-only endpoints
  // selected by the caller even when none of their siblings has eligible code identifiers.
  for (const endpoint of documentsByEndpoint.values()) {
    if (endpoint.documents.length > 16) throw new SemanticAnalysisError("SEMANTIC_INVALID_CONTEXT");
    totalText += endpoint.documents.reduce((sum, document) => sum + Buffer.byteLength(document.text, "utf8"), 0);
    if (totalText > 16_384) throw new SemanticAnalysisError("SEMANTIC_INVALID_CONTEXT");
    merged.push(endpoint);
  }
  return merged;
};

const contextCoverage = (requestedEndpointIds: readonly string[],
  analyzedEndpointIds: readonly string[]): SemanticContextCoverage => {
  const analyzed = new Set(analyzedEndpointIds);
  const omittedEndpointIds = requestedEndpointIds.filter(endpointId => !analyzed.has(endpointId));
  return freezeDeep({status: omittedEndpointIds.length === 0 ? "complete" : "partial",
    requestedEndpointIds: [...requestedEndpointIds], analyzedEndpointIds: [...analyzedEndpointIds], omittedEndpointIds});
};

const validateOutput = (raw: unknown, request: SemanticProviderRequest): Record<string, unknown> => {
  let value: unknown;
  try {value = detachedJson(raw, 16_384, 1_000, 8);} catch {throw new SemanticAnalysisError("SEMANTIC_OUTPUT_REJECTED");}
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new SemanticAnalysisError("SEMANTIC_OUTPUT_REJECTED");
  const output = value as Record<string, unknown>;
  const endpointMap = new Map(request.endpoints.map(endpoint => [endpoint.endpointId,
    new Set(endpoint.documents.flatMap(doc => doc.evidenceIds))]));
  if (output.status === "suggestions") {
    if (!plain(output, ["status", "suggestions"]) || !Array.isArray(output.suggestions)
      || output.suggestions.length < 1 || output.suggestions.length > request.endpoints.length)
      throw new SemanticAnalysisError("SEMANTIC_OUTPUT_REJECTED");
    const seen = new Set<string>();
    for (const item of output.suggestions) {
      if (!plain(item, ["endpointId", "intent", "summary", "evidenceIds"])
        || !id(item.endpointId) || seen.has(item.endpointId)
        || !text(item.intent, 120) || !text(item.summary, 600)
        || !Array.isArray(item.evidenceIds) || item.evidenceIds.length < 1 || item.evidenceIds.length > 8
        || new Set(item.evidenceIds).size !== item.evidenceIds.length
        || !item.evidenceIds.every((evidenceId: unknown) => typeof evidenceId === "string"
          && endpointMap.get(item.endpointId as string)?.has(evidenceId)))
        throw new SemanticAnalysisError("SEMANTIC_OUTPUT_REJECTED");
      seen.add(item.endpointId);
    }
  } else if (output.status === "ambiguous") {
    if (!plain(output, ["status", "candidateEndpointIds", "reason"])
      || !Array.isArray(output.candidateEndpointIds) || output.candidateEndpointIds.length < 2
      || output.candidateEndpointIds.length > request.endpoints.length
      || new Set(output.candidateEndpointIds).size !== output.candidateEndpointIds.length
      || !output.candidateEndpointIds.every((id: unknown) => typeof id === "string" && endpointMap.has(id))
      || !text(output.reason, 300)) throw new SemanticAnalysisError("SEMANTIC_OUTPUT_REJECTED");
  } else if (output.status === "no_match") {
    if (!plain(output, ["status", "reason"]) || !text(output.reason, 300))
      throw new SemanticAnalysisError("SEMANTIC_OUTPUT_REJECTED");
  } else throw new SemanticAnalysisError("SEMANTIC_OUTPUT_REJECTED");
  return output;
};

/** Pure, opt-in semantic suggestion boundary; no output mutates or authorizes a contract fact. */
const runSemantic = async (raw: SemanticAnalysisInput | SemanticDiscoveryInput,
  providerPort: SemanticProviderPort, discovery: boolean): Promise<SemanticAnalysisResult> => {
  let input: SemanticAnalysisInput | SemanticDiscoveryInput;
  try {input = detachedJson(raw, 2_097_152, 20_000, 64) as SemanticAnalysisInput | SemanticDiscoveryInput;}
  catch {throw new SemanticAnalysisError("SEMANTIC_INVALID_CONTEXT");}
  if (!plain(input, discovery
    ? ["snapshot", "pin", "selection", "inference", "endpointIds", "intentQuery"]
    : ["snapshot", "pin", "selection", "inference", "endpointIds"])
    || typeof input.inference?.enabled !== "boolean"
    || !plain(input.inference, input.inference.enabled === false ? ["enabled"]
      : ["enabled", "provider", "model"]))
    throw new SemanticAnalysisError("SEMANTIC_INVALID_CONTEXT");
  const intentQuery = discovery ? (input as SemanticDiscoveryInput).intentQuery : undefined;
  if (discovery && !isSemanticIntentQuerySafe(intentQuery))
    throw new SemanticAnalysisError("SEMANTIC_INVALID_CONTEXT");
  if (!input.inference.enabled) return Object.freeze({status: "disabled"});
  if (!["openai", "gemini", "claude"].includes(String(input.inference.provider))
    || !text(input.inference.model, 128)) throw new SemanticAnalysisError("SEMANTIC_INVALID_CONTEXT");
  const parsed = parseContractSnapshot(input.snapshot);
  if (!parsed.ok) throw new SemanticAnalysisError("SEMANTIC_INVALID_CONTEXT");
  input = {...input, snapshot: parsed.value};
  validateSelection(input);
  if (!Array.isArray(input.endpointIds) || input.endpointIds.length < 1 || input.endpointIds.length > 16
    || new Set(input.endpointIds).size !== input.endpointIds.length
    || input.endpointIds.some(endpointId => !id(endpointId)
      || !input.snapshot.endpoints.some(endpoint => endpoint.endpoint_id === endpointId)))
    throw new SemanticAnalysisError("SEMANTIC_INVALID_CONTEXT");
  const sourceEndpoints = discovery ? sourceProjection(input) : [];
  const sourceProfile = sourceEndpoints.length > 0;
  const documentEndpoints = discovery ? projection(input) : [];
  let endpoints = sourceProfile ? mergeSourceAndDocumentContext(sourceEndpoints, documentEndpoints) : projection(input);
  if (discovery) {
    const endpointOrder = new Map(input.endpointIds.map((endpointId, index) => [endpointId, index]));
    endpoints = endpoints.toSorted((left, right) => endpointOrder.get(left.endpointId)! - endpointOrder.get(right.endpointId)!);
  }
  const coverage = discovery ? contextCoverage(input.endpointIds, endpoints.map(endpoint => endpoint.endpointId)) : undefined;
  if (!endpoints.length) return Object.freeze({status: "no_context", ...(coverage ? {contextCoverage: coverage} : {})});
  const model = input.inference.model!;
  const provider = input.inference.provider as SemanticProviderId;
  const source = {repositoryId: input.selection.repositoryId, serviceId: input.selection.serviceId,
    selector: input.selection.selector, pin: input.pin};
  const request = freezeDeep({promptVersion: sourceProfile ? SEMANTIC_DISCOVERY_SOURCE_PROMPT_VERSION
    : discovery ? SEMANTIC_DISCOVERY_PROMPT_VERSION : SEMANTIC_PROMPT_VERSION,
    ...(discovery ? {intentQuery} : {}), provider, model, source, endpoints}) as SemanticProviderRequest;
  let rawOutput: unknown;
  try {rawOutput = await providerPort(request);} catch {throw new SemanticAnalysisError("SEMANTIC_PROVIDER_ERROR");}
  const output = validateOutput(rawOutput, request);
  const provenance: SemanticProvenance = freezeDeep({provider, model,
    promptVersion: request.promptVersion, selector: input.selection.selector, pin: input.pin});
  if (output.status === "suggestions") return freezeDeep({status: "suggestions",
    suggestions: output.suggestions, verification: "inferred", review: "unreviewed", normative: false,
    provenance, ...(coverage ? {contextCoverage: coverage} : {})}) as SemanticAnalysisResult;
  if (output.status === "ambiguous") return freezeDeep({status: "ambiguous",
    candidateEndpointIds: output.candidateEndpointIds, reason: output.reason,
    verification: "inferred", review: "unreviewed", normative: false, provenance,
    ...(coverage ? {contextCoverage: coverage} : {})}) as SemanticAnalysisResult;
  return freezeDeep({status: "no_match", reason: output.reason,
    verification: "inferred", review: "unreviewed", normative: false, provenance,
    ...(coverage ? {contextCoverage: coverage} : {})}) as SemanticAnalysisResult;
};

export const runGroundedSemanticAnalysis = (raw: SemanticAnalysisInput,
  providerPort: SemanticProviderPort): Promise<SemanticAnalysisResult> =>
  runSemantic(raw, providerPort, false);

/** Compares one bounded user intent with explicitly selected documented endpoints. */
export const runGroundedSemanticDiscovery = (raw: SemanticDiscoveryInput,
  providerPort: SemanticProviderPort): Promise<SemanticAnalysisResult> =>
  runSemantic(raw, providerPort, true);
