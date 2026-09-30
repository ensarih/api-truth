import { ReferenceAdapterError } from "./adapter.js";

type JsonRecord = Record<string, unknown>;
export type SyntheticStep = Readonly<{ fact: JsonRecord; policy: JsonRecord }>;

/** Fixed public values only. The trigger branch is a gate, never a source of revision or deployment truth. */
export const buildSyntheticReferenceFixture = (triggerBranch: string): readonly SyntheticStep[] => {
  const config = { config_version: "1.0.0", access_scopes: [{ access_scope_id: "synthetic", label: "Synthetic" }],
    repositories: [{ repository_id: "synthetic-repo", provider: "github", locator: "synthetic/reference",
      access_scope_id: "synthetic", services: [{ service_id: "synthetic-orders", root: "services/orders",
        analyzer: { adapter_id: "typescript", adapter_version: "1" }, intended_branches: ["main"],
        environments: [{ name: "uat", intended_branch: "main",
          deployment_authority: { adapter_id: "synthetic-deploy", access_scope_id: "synthetic" } }] }] }] };
  if (!config.repositories[0]!.services[0]!.intended_branches.includes(triggerBranch))
    throw new ReferenceAdapterError("UNCONFIGURED_BRANCH");
  const sourceContext = { tenantId: "synthetic", principalId: "synthetic-fixture", producerId: "synthetic-source",
    allowedEventTypes: ["branch.updated", "pull_request.updated", "reconciliation.requested", "repository.baseline_requested"],
    allowedRepositories: ["synthetic-repo"], allowedServices: ["synthetic-orders"],
    deploymentAuthorityGrants: [], capabilities: ["event.ingest"] };
  const deploymentContext = { tenantId: "synthetic", principalId: "synthetic-fixture", producerId: "synthetic-deploy",
    allowedEventTypes: ["deployment.changed"], allowedRepositories: ["synthetic-repo"],
    allowedServices: ["synthetic-orders"], capabilities: ["event.ingest"],
    deploymentAuthorityGrants: [{ repositoryId: "synthetic-repo", serviceId: "synthetic-orders", environment: "uat",
      adapterId: "synthetic-deploy", sourceAuthorityIds: ["synthetic-inventory"] }] };
  const original = "a".repeat(40);
  const merged = "b".repeat(40);
  const artifacts = [{ artifact_id: "synthetic-artifact-b", revision: merged }];
  const common = (eventId: string, order: number) => ({ adapter_version: "1.0.0", event_id: eventId,
    occurred_at: `2026-01-01T00:00:${String(order).padStart(2, "0")}Z`,
    received_at: `2026-01-01T00:01:${String(order).padStart(2, "0")}Z`,
    provider_reference: `synthetic-delivery-${order}`, sequence: String(order),
    repository_id: "synthetic-repo", service_id: "synthetic-orders" });
  const sourcePolicy = { configuration: config, context: sourceContext, knownArtifacts: [] };
  const deploymentPolicy = { configuration: config, context: deploymentContext, knownArtifacts: artifacts };
  return Object.freeze([
    { fact: { ...common("synthetic-baseline", 1), kind: "baseline", immutable_revision: original }, policy: sourcePolicy },
    { fact: { ...common("synthetic-pr-open", 2), kind: "pull_request", pull_request_id: "synthetic-pr-1", state: "open",
      base_branch: "main", base_revision: original, head_branch: "synthetic/feature", head_revision: merged }, policy: sourcePolicy },
    { fact: { ...common("synthetic-pr-merged", 3), kind: "pull_request", pull_request_id: "synthetic-pr-1", state: "merged",
      base_branch: "main", base_revision: original, head_branch: "synthetic/feature", head_revision: merged }, policy: sourcePolicy },
    { fact: { ...common("synthetic-branch", 4), kind: "branch", branch: "main", prior_revision: original,
      new_revision: merged, reference_state: "fast_forward" }, policy: sourcePolicy },
    { fact: { ...common("synthetic-deploy-attempt", 5), kind: "deployment_attempt", environment: "uat",
      deployment_id: "synthetic-deploy-1", attempt_state: "succeeded", effective_order: "5",
      artifact_id: "synthetic-artifact-b", revision: merged }, policy: deploymentPolicy },
    { fact: { ...common("synthetic-serving", 6), kind: "serving_observation", environment: "uat",
      observation_id: "synthetic-observation-1", effective_order: "6", authority_id: "synthetic-inventory",
      reference: "synthetic-inventory-1", access_label: "synthetic", completeness: "complete",
      inventory: [{ artifact_id: "synthetic-artifact-b", revision: merged }] }, policy: deploymentPolicy },
    { fact: { ...common("synthetic-reconcile", 7), kind: "reconciliation", environments: ["uat"],
      provider_snapshot_reference: "synthetic-provider-snapshot-1" }, policy: sourcePolicy },
  ]);
};
