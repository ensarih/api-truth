import type {
  ApiSchema,
  ContractSnapshot,
  Endpoint,
  Evidence,
  SchemaComponent,
} from "@api-truth/ir";
import { canonicalJson, canonicalSha256Hex, compareUtf8 } from "./canonical.js";
import { UpdateError } from "./errors.js";
import { validateUpdatePlanningInput } from "./input.js";
import {
  parseUpdatePlan,
  type UpdatePlan,
  type UpdatePlanningInput,
} from "./schema.js";
import { UPDATE_PLAN_VERSION, type UpdateFallbackReason } from "./types.js";

type OwnershipRoute =
  | "endpoint"
  | "parameter-presence"
  | "request-body-presence"
  | "claim"
  | "eligibility"
  | "schema"
  | "evidence-scope"
  | "dependency-evidence"
  | "dependency-schema"
  | "dependency-endpoint";

type MutableEndpointOwnership = {
  evidenceIds: Set<string>;
  schemaIds: Set<string>;
};

export type EndpointOwnershipIndex = {
  endpointIds: readonly string[];
  evidenceOwners: ReadonlyMap<string, ReadonlySet<string>>;
  schemaOwners: ReadonlyMap<string, ReadonlySet<string>>;
  evidenceOwnerRoutes: ReadonlyMap<string, ReadonlyMap<string, ReadonlySet<OwnershipRoute>>>;
  endpointOwnership: ReadonlyMap<string, {
    evidenceIds: ReadonlySet<string>;
    schemaIds: ReadonlySet<string>;
  }>;
};

const normalizedRelativePath = /^[A-Za-z0-9_@+.-]+(?:\/[A-Za-z0-9_@+.-]+)*$/;

const isNormalizedServicePath = (candidate: string): boolean =>
  candidate === "." || (
    normalizedRelativePath.test(candidate)
    && candidate.split("/").every((segment) => segment !== "." && segment !== "..")
  );

const localComponentId = (reference: string): string | undefined => {
  const prefix = "#/schemas/";
  if (!reference.startsWith(prefix)) return undefined;
  const encoded = reference.slice(prefix.length);
  if (encoded.length === 0 || /~(?![01])/u.test(encoded)) return undefined;
  return encoded.replaceAll("~1", "/").replaceAll("~0", "~");
};

const collectSchemaReferences = (value: ApiSchema, output: Set<string>): void => {
  if (value.$ref !== undefined) {
    const componentId = localComponentId(value.$ref);
    if (componentId !== undefined) output.add(componentId);
  }
  if (value.properties !== undefined) {
    for (const property of Object.values(value.properties)) collectSchemaReferences(property, output);
  }
  if (value.items !== undefined) collectSchemaReferences(value.items, output);
  for (const item of value.prefixItems ?? []) collectSchemaReferences(item, output);
  if (typeof value.additionalProperties === "object") collectSchemaReferences(value.additionalProperties, output);
  for (const item of value.oneOf ?? []) collectSchemaReferences(item, output);
  for (const item of value.anyOf ?? []) collectSchemaReferences(item, output);
  for (const item of value.allOf ?? []) collectSchemaReferences(item, output);
  if (value.not !== undefined) collectSchemaReferences(value.not, output);
};

const endpointSchemaReferences = (endpoint: Endpoint): Set<string> => {
  const references = new Set<string>();
  for (const parameter of endpoint.parameters) collectSchemaReferences(parameter.schema, references);
  for (const body of endpoint.request_bodies) collectSchemaReferences(body.schema, references);
  for (const response of endpoint.responses) {
    for (const content of response.content) collectSchemaReferences(content.schema, references);
    for (const header of response.headers ?? []) collectSchemaReferences(header.schema, references);
  }
  return references;
};

const componentClosure = (
  initialIds: Iterable<string>,
  schemas: ReadonlyMap<string, SchemaComponent>,
): Set<string> => {
  const reached = new Set<string>();
  const pending = [...initialIds];
  while (pending.length > 0) {
    const componentId = pending.pop()!;
    if (reached.has(componentId)) continue;
    const component = schemas.get(componentId);
    if (component === undefined) continue;
    reached.add(componentId);
    const references = new Set<string>();
    collectSchemaReferences(component.schema, references);
    for (const reference of references) {
      if (!reached.has(reference)) pending.push(reference);
    }
  }
  return reached;
};

const addRoute = (
  routeMap: Map<string, Map<string, Set<OwnershipRoute>>>,
  evidenceId: string,
  endpointId: string,
  route: OwnershipRoute,
): void => {
  const endpointRoutes = routeMap.get(evidenceId) ?? new Map<string, Set<OwnershipRoute>>();
  routeMap.set(evidenceId, endpointRoutes);
  const routes = endpointRoutes.get(endpointId) ?? new Set<OwnershipRoute>();
  endpointRoutes.set(endpointId, routes);
  routes.add(route);
};

const addEvidence = (
  ownership: MutableEndpointOwnership,
  routes: Map<string, Map<string, Set<OwnershipRoute>>>,
  endpointId: string,
  evidenceId: string,
  route: OwnershipRoute,
): boolean => {
  addRoute(routes, evidenceId, endpointId, route);
  const size = ownership.evidenceIds.size;
  ownership.evidenceIds.add(evidenceId);
  return ownership.evidenceIds.size !== size;
};

const addSchemas = (
  ownership: MutableEndpointOwnership,
  endpointId: string,
  schemaIds: Iterable<string>,
  schemas: ReadonlyMap<string, SchemaComponent>,
  routes: Map<string, Map<string, Set<OwnershipRoute>>>,
  route: "schema" | "dependency-schema",
): boolean => {
  let changed = false;
  for (const schemaId of componentClosure(schemaIds, schemas)) {
    const previousSize = ownership.schemaIds.size;
    ownership.schemaIds.add(schemaId);
    changed ||= ownership.schemaIds.size !== previousSize;
    const component = schemas.get(schemaId)!;
    for (const evidenceId of component.evidence_ids) {
      changed = addEvidence(ownership, routes, endpointId, evidenceId, route) || changed;
    }
  }
  return changed;
};

export const buildEndpointOwnershipIndex = (snapshot: ContractSnapshot): EndpointOwnershipIndex => {
  const schemas = new Map(Object.entries(snapshot.schemas));
  const endpointOwnership = new Map<string, MutableEndpointOwnership>();
  const evidenceOwnerRoutes = new Map<string, Map<string, Set<OwnershipRoute>>>();

  for (const endpoint of snapshot.endpoints) {
    const ownership: MutableEndpointOwnership = { evidenceIds: new Set(), schemaIds: new Set() };
    endpointOwnership.set(endpoint.endpoint_id, ownership);
    for (const evidenceId of endpoint.evidence_ids) {
      addEvidence(ownership, evidenceOwnerRoutes, endpoint.endpoint_id, evidenceId, "endpoint");
    }
    for (const parameter of endpoint.parameters) {
      for (const evidenceId of parameter.presence.evidence_ids) {
        addEvidence(ownership, evidenceOwnerRoutes, endpoint.endpoint_id, evidenceId, "parameter-presence");
      }
    }
    for (const body of endpoint.request_bodies) {
      for (const evidenceId of body.presence.evidence_ids) {
        addEvidence(ownership, evidenceOwnerRoutes, endpoint.endpoint_id, evidenceId, "request-body-presence");
      }
    }
    addSchemas(
      ownership,
      endpoint.endpoint_id,
      endpointSchemaReferences(endpoint),
      schemas,
      evidenceOwnerRoutes,
      "schema",
    );
  }

  for (const claim of snapshot.claims) {
    const endpointId = claim.subject.endpoint_id;
    if (endpointId === undefined) continue;
    const ownership = endpointOwnership.get(endpointId)!;
    for (const evidenceId of claim.evidence_ids) {
      addEvidence(ownership, evidenceOwnerRoutes, endpointId, evidenceId, "claim");
    }
    for (const eligibility of snapshot.export_eligibility) {
      if (eligibility.claim_id !== claim.claim_id || eligibility.status !== "eligible") continue;
      for (const evidenceId of eligibility.basis.evidence_ids) {
        addEvidence(ownership, evidenceOwnerRoutes, endpointId, evidenceId, "eligibility");
      }
    }
  }

  for (const candidate of snapshot.evidence) {
    const endpointId = candidate.scope.endpoint_id;
    if (endpointId === undefined) continue;
    addEvidence(
      endpointOwnership.get(endpointId)!,
      evidenceOwnerRoutes,
      endpointId,
      candidate.evidence_id,
      "evidence-scope",
    );
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const dependency of snapshot.dependencies) {
      const ownership = endpointOwnership.get(dependency.from_endpoint_id)!;
      for (const evidenceId of dependency.evidence_ids) {
        changed = addEvidence(
          ownership,
          evidenceOwnerRoutes,
          dependency.from_endpoint_id,
          evidenceId,
          "dependency-evidence",
        ) || changed;
      }
      if (dependency.to.kind === "evidence") {
        changed = addEvidence(
          ownership,
          evidenceOwnerRoutes,
          dependency.from_endpoint_id,
          dependency.to.id,
          "dependency-evidence",
        ) || changed;
      } else if (dependency.to.kind === "schema") {
        changed = addSchemas(
          ownership,
          dependency.from_endpoint_id,
          [dependency.to.id],
          schemas,
          evidenceOwnerRoutes,
          "dependency-schema",
        ) || changed;
      } else {
        const target = endpointOwnership.get(dependency.to.id)!;
        for (const evidenceId of target.evidenceIds) {
          changed = addEvidence(
            ownership,
            evidenceOwnerRoutes,
            dependency.from_endpoint_id,
            evidenceId,
            "dependency-endpoint",
          ) || changed;
        }
        for (const schemaId of target.schemaIds) {
          const size = ownership.schemaIds.size;
          ownership.schemaIds.add(schemaId);
          changed ||= size !== ownership.schemaIds.size;
        }
      }
    }
  }

  const evidenceOwners = new Map<string, Set<string>>();
  const schemaOwners = new Map<string, Set<string>>();
  for (const [endpointId, ownership] of endpointOwnership) {
    for (const evidenceId of ownership.evidenceIds) {
      const owners = evidenceOwners.get(evidenceId) ?? new Set<string>();
      evidenceOwners.set(evidenceId, owners);
      owners.add(endpointId);
    }
    for (const schemaId of ownership.schemaIds) {
      const owners = schemaOwners.get(schemaId) ?? new Set<string>();
      schemaOwners.set(schemaId, owners);
      owners.add(endpointId);
    }
  }

  return {
    endpointIds: [...endpointOwnership.keys()].sort(compareUtf8),
    evidenceOwners,
    schemaOwners,
    evidenceOwnerRoutes,
    endpointOwnership,
  };
};

const canonicalPlanningInput = (value: unknown): UpdatePlanningInput => {
  return validateUpdatePlanningInput(value);
};

const serviceRelativePath = (projectPath: string, serviceRoot: string): string => {
  if (serviceRoot === ".") return projectPath;
  if (projectPath === serviceRoot) return ".";
  return projectPath.slice(serviceRoot.length + 1);
};

const changedRecords = (
  snapshot: ContractSnapshot,
  ownership: EndpointOwnershipIndex,
  servicePath: string,
): {
  affectedEndpointIds: Set<string>;
  indexed: boolean;
  incomplete: boolean;
} => {
  if (servicePath === ".") {
    const hasOrphanEvidence = snapshot.evidence.some((candidate) =>
      candidate.location.path !== undefined
      && isNormalizedServicePath(candidate.location.path)
      && (ownership.evidenceOwners.get(candidate.evidence_id)?.size ?? 0) === 0);
    const hasOrphanSchema = Object.values(snapshot.schemas).some((component) =>
      component.evidence_ids.some((evidenceId) => {
        const record = snapshot.evidence.find((candidate) => candidate.evidence_id === evidenceId);
        return record?.location.path !== undefined && isNormalizedServicePath(record.location.path);
      }) && (ownership.schemaOwners.get(component.schema_id)?.size ?? 0) === 0);
    return {
      affectedEndpointIds: new Set(ownership.endpointIds),
      indexed: true,
      incomplete: hasOrphanEvidence || hasOrphanSchema,
    };
  }

  const evidenceOnPath = snapshot.evidence.filter((candidate) =>
    candidate.location.path === servicePath && isNormalizedServicePath(candidate.location.path));
  const evidenceIds = new Set(evidenceOnPath.map((candidate) => candidate.evidence_id));
  const schemasOnPath = Object.values(snapshot.schemas).filter((component) =>
    component.evidence_ids.some((evidenceId) => evidenceIds.has(evidenceId)));
  const affectedEndpointIds = new Set<string>();
  let incomplete = false;

  for (const candidate of evidenceOnPath) {
    const owners = ownership.evidenceOwners.get(candidate.evidence_id) ?? new Set<string>();
    if (owners.size === 0) incomplete = true;
    for (const endpointId of owners) affectedEndpointIds.add(endpointId);

    const scopedEndpointId = candidate.scope.endpoint_id;
    if (scopedEndpointId !== undefined) {
      const ownerRoutes = ownership.evidenceOwnerRoutes.get(candidate.evidence_id);
      for (const [endpointId, routes] of ownerRoutes ?? []) {
        if (endpointId !== scopedEndpointId
          && [...routes].some((route) => route !== "dependency-endpoint")) {
          incomplete = true;
        }
      }
    }
  }
  for (const component of schemasOnPath) {
    const owners = ownership.schemaOwners.get(component.schema_id) ?? new Set<string>();
    if (owners.size === 0) incomplete = true;
    for (const endpointId of owners) affectedEndpointIds.add(endpointId);
  }

  return {
    affectedEndpointIds,
    indexed: evidenceOnPath.length > 0 || schemasOnPath.length > 0,
    incomplete,
  };
};

const endpointWithoutSourceClosure = (
  snapshot: ContractSnapshot,
  ownership: EndpointOwnershipIndex,
): boolean => {
  const evidenceById = new Map(snapshot.evidence.map((candidate) => [candidate.evidence_id, candidate]));
  return ownership.endpointIds.some((endpointId) => {
    const endpoint = ownership.endpointOwnership.get(endpointId)!;
    return ![...endpoint.evidenceIds].some((evidenceId) => {
      const path = evidenceById.get(evidenceId)?.location.path;
      return path !== undefined && isNormalizedServicePath(path);
    });
  });
};

const ownedSourcePathIsInvalid = (
  snapshot: ContractSnapshot,
  ownership: EndpointOwnershipIndex,
): boolean => snapshot.evidence.some((candidate) =>
  candidate.location.path !== undefined
  && !isNormalizedServicePath(candidate.location.path)
  && (ownership.evidenceOwners.get(candidate.evidence_id)?.size ?? 0) > 0);

const fallbackReasonRank = new Map<UpdateFallbackReason, number>([
  ["adapter_incremental_targets_unsupported", 0],
  ["prior_coverage_incomplete", 1],
  ["changed_paths_incomplete", 2],
  ["changed_paths_digest_mismatch", 3],
  ["changed_path_unindexed", 4],
  ["dependency_index_incomplete", 5],
  ["analyzer_changed", 6],
  ["config_changed", 7],
  ["ir_changed", 8],
  ["identity_changed", 9],
]);

type OwnershipBuilder = (snapshot: ContractSnapshot) => EndpointOwnershipIndex;

// Kept internal to the package export map; focused tests inject a builder to
// verify trust-boundary rejection happens before dependency-index work.
export const createUpdatePlanner = (ownershipBuilder: OwnershipBuilder) => (value: unknown): UpdatePlan => {
  const input = canonicalPlanningInput(value);
  const baseAnalysis = input.base_analysis_key;
  const targetAnalysis = input.target.analysis_key;
  const analyzerChanged = canonicalJson({
    analyzer: baseAnalysis.analyzer,
    analyzer_exchange_version: baseAnalysis.analyzer_exchange_version,
  }) !== canonicalJson({
    analyzer: targetAnalysis.analyzer,
    analyzer_exchange_version: targetAnalysis.analyzer_exchange_version,
  });
  const configChanged = baseAnalysis.config_version !== targetAnalysis.config_version
    || baseAnalysis.config_fingerprint !== targetAnalysis.config_fingerprint;
  const irChanged = baseAnalysis.ir_version !== targetAnalysis.ir_version;
  const identityChanged = baseAnalysis.identity_version !== targetAnalysis.identity_version;
  const analysisBoundaryChanged = analyzerChanged || configChanged || irChanged || identityChanged;
  const sourceDigestMatches = input.base_snapshot.source.source_digest === input.target.source_digest;
  const priorCoverageIncomplete = input.base_snapshot.coverage.status !== "complete";
  const mayReuse = sourceDigestMatches
    && !analysisBoundaryChanged
    && !priorCoverageIncomplete
    && input.changed_paths_complete
    && input.changed_paths.length === 0;

  if (mayReuse) {
    const content = {
      update_plan_version: UPDATE_PLAN_VERSION,
      service: {
        repository_id: input.target.repository_id,
        service_id: input.target.service_id,
        service_root: input.target.service_root,
        base_snapshot_id: input.base_snapshot.snapshot_id,
        base_revision: input.base_snapshot.source.immutable_revision,
        target_revision: input.target.immutable_revision,
        base_source_digest: input.base_snapshot.source.source_digest,
        target_source_digest: input.target.source_digest,
      },
      analysis: { base: baseAnalysis, target: targetAnalysis },
      changed_paths: input.changed_paths,
      dependency_coverage: "complete" as const,
      affected_endpoint_ids: [],
      action: "reuse_base_snapshot" as const,
      fallback_reasons: [],
    };
    const plan: UpdatePlan = {
      ...content,
      plan_id: `update-plan-${canonicalSha256Hex(content)}`,
    };
    const parsed = parseUpdatePlan(plan);
    if (!parsed.ok) throw new UpdateError("INVALID_UPDATE_INPUT");
    return parsed.value;
  }

  const ownership = ownershipBuilder(input.base_snapshot);
  const affectedEndpointIds = new Set<string>();
  let dependencyIndexIncomplete = endpointWithoutSourceClosure(input.base_snapshot, ownership)
    || ownedSourcePathIsInvalid(input.base_snapshot, ownership);
  let changedPathUnindexed = false;

  for (const projectPath of input.changed_paths) {
    const records = changedRecords(
      input.base_snapshot,
      ownership,
      serviceRelativePath(projectPath, input.target.service_root),
    );
    for (const endpointId of records.affectedEndpointIds) affectedEndpointIds.add(endpointId);
    changedPathUnindexed ||= !records.indexed;
    dependencyIndexIncomplete ||= records.incomplete;
  }

  if (analysisBoundaryChanged) {
    for (const endpointId of ownership.endpointIds) affectedEndpointIds.add(endpointId);
  }

  const fallbackReasons = new Set<UpdateFallbackReason>([
    "adapter_incremental_targets_unsupported",
  ]);
  if (priorCoverageIncomplete) fallbackReasons.add("prior_coverage_incomplete");
  if (!input.changed_paths_complete) {
    fallbackReasons.add("changed_paths_incomplete");
  } else if (!sourceDigestMatches && input.changed_paths.length === 0) {
    fallbackReasons.add("changed_paths_digest_mismatch");
  }
  if (changedPathUnindexed) fallbackReasons.add("changed_path_unindexed");
  if (dependencyIndexIncomplete) fallbackReasons.add("dependency_index_incomplete");
  if (analyzerChanged) fallbackReasons.add("analyzer_changed");
  if (configChanged) fallbackReasons.add("config_changed");
  if (irChanged) fallbackReasons.add("ir_changed");
  if (identityChanged) fallbackReasons.add("identity_changed");

  const dependencyCoverageIncomplete = priorCoverageIncomplete
    || !input.changed_paths_complete
    || (!sourceDigestMatches && input.changed_paths.length === 0)
    || changedPathUnindexed
    || dependencyIndexIncomplete
    || analysisBoundaryChanged;

  const content = {
    update_plan_version: UPDATE_PLAN_VERSION,
    service: {
      repository_id: input.target.repository_id,
      service_id: input.target.service_id,
      service_root: input.target.service_root,
      base_snapshot_id: input.base_snapshot.snapshot_id,
      base_revision: input.base_snapshot.source.immutable_revision,
      target_revision: input.target.immutable_revision,
      base_source_digest: input.base_snapshot.source.source_digest,
      target_source_digest: input.target.source_digest,
    },
    analysis: {
      base: input.base_analysis_key,
      target: input.target.analysis_key,
    },
    changed_paths: input.changed_paths,
    dependency_coverage: dependencyCoverageIncomplete ? "incomplete" as const : "complete" as const,
    affected_endpoint_ids: [...affectedEndpointIds].sort(compareUtf8),
    action: "analyze_full_service" as const,
    extraction_mode: "fallback_full_service" as const,
    fallback_reasons: [...fallbackReasons].sort(
      (left, right) => fallbackReasonRank.get(left)! - fallbackReasonRank.get(right)!,
    ),
  };
  const plan: UpdatePlan = {
    ...content,
    plan_id: `update-plan-${canonicalSha256Hex(content)}`,
  };
  const parsed = parseUpdatePlan(plan);
  if (!parsed.ok) throw new UpdateError("INVALID_UPDATE_INPUT");
  return parsed.value;
};

export const planUpdate = createUpdatePlanner(buildEndpointOwnershipIndex);
