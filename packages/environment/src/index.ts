export { applyEnvironmentMigrations } from "./migrations.js";
export { createEnvironmentRepository } from "./repository.js";
export type { EnvironmentRepository } from "./repository.js";

type RevisionReference =
  | Readonly<{ state: "known"; revision: string }>
  | Readonly<{ state: "unknown"; reason: string }>;

type ServingObservation = Readonly<{
  completeness: "complete" | "incomplete" | "transitional";
  serving_state:
    | Readonly<{ status: "known"; inventory: readonly Readonly<{
      artifact_id: string; revision: RevisionReference;
    }>[] }>
    | Readonly<{ status: "unknown"; reason: string; observed_artifact_ids?: readonly string[] }>;
}>;

type Attempt = Readonly<{
  deploymentId: string;
  state: "pending" | "succeeded" | "failed" | "rollback_requested" | "rolled_back";
}>;

export type EnvironmentResolutionInput = Readonly<{
  // The caller supplies facts already authenticated and scoped to one tenant, service, and environment.
  observation?: ServingObservation;
  latestAttempt?: Attempt;
  artifactBindings: readonly Readonly<{ artifactId: string; revision: string }>[];
  revisionSnapshots: readonly Readonly<{ revision: string; snapshotId: string }>[];
}>;

export type EnvironmentResolution = Readonly<{
  deployment: "unknown" | "confirmed_not_deployed" | "deployed" | "transitional";
  contract: "unavailable" | "pending_binding" | "pending_analysis" | "resolved" | "ambiguous";
  active: readonly Readonly<{ artifactId: string; revision?: string; snapshotId?: string }>[];
  latestAttempt?: Attempt;
  snapshotId?: string;
}>;

const stable = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

export const resolveEnvironment = (input: EnvironmentResolutionInput): EnvironmentResolution => {
  const latestAttempt = input.latestAttempt === undefined ? {} : {
    latestAttempt: Object.freeze({ deploymentId: input.latestAttempt.deploymentId, state: input.latestAttempt.state }),
  };
  const unavailable = (deployment: EnvironmentResolution["deployment"]): EnvironmentResolution =>
    Object.freeze({ deployment, contract: "unavailable", active: Object.freeze([]), ...latestAttempt });
  const observation = input.observation;
  if (observation === undefined || observation.serving_state.status === "unknown") return unavailable("unknown");
  const inventory = observation.serving_state.inventory;
  if (inventory.length === 0) return unavailable(observation.completeness === "complete" ? "confirmed_not_deployed" : "unknown");

  let missingBinding = false;
  let missingAnalysis = false;
  const active: EnvironmentResolution["active"][number][] = inventory.map(({ artifact_id: artifactId, revision: reference }) => {
    const revision = reference.state === "known" ? reference.revision : undefined;
    const bindings = input.artifactBindings.filter((binding) => binding.artifactId === artifactId);
    if (revision === undefined || bindings.length !== 1 || bindings[0]?.revision !== revision) {
      missingBinding = true;
      return Object.freeze({ artifactId, ...(revision === undefined ? {} : { revision }) });
    }
    const snapshots = input.revisionSnapshots.filter((snapshot) => snapshot.revision === revision);
    if (snapshots.length !== 1) {
      missingAnalysis = true;
      return Object.freeze({ artifactId, revision });
    }
    return Object.freeze({ artifactId, revision, snapshotId: snapshots[0]!.snapshotId });
  }).sort((left, right) => stable(left.artifactId, right.artifactId));

  if (observation.completeness !== "complete" || active.length !== 1) {
    return Object.freeze({ deployment: "transitional", contract: "ambiguous",
      active: Object.freeze(active), ...latestAttempt });
  }
  const only = active[0]!;
  const contract = missingBinding ? "pending_binding" : missingAnalysis ? "pending_analysis" : "resolved";
  return Object.freeze({ deployment: "deployed", contract, active: Object.freeze(active), ...latestAttempt,
    ...(contract === "resolved" && only.snapshotId !== undefined ? { snapshotId: only.snapshotId } : {}) });
};
