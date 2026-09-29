import { parseConfig, type InstallationConfig } from "@api-truth/ir";
import { canonicalOrchestrationJson, canonicalStringSet } from "./canonical.js";
import { OrchestrationError } from "./errors.js";

export type ServiceConfiguration = InstallationConfig["repositories"][number]["services"][number];

const validatedService = (input: unknown): ServiceConfiguration => {
  let candidate: unknown;
  try { candidate = JSON.parse(canonicalOrchestrationJson(input)); } catch { throw new OrchestrationError("INVALID_ORCHESTRATION_INPUT"); }
  const candidateRecord = candidate !== null && typeof candidate === "object" && !Array.isArray(candidate)
    ? candidate as Record<string, unknown> : {};
  const environments = Array.isArray(candidateRecord.environments) ? candidateRecord.environments : [];
  const environmentScopes = environments.flatMap((entry) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return [];
    const authority = (entry as Record<string, unknown>).deployment_authority;
    if (authority === null || typeof authority !== "object" || Array.isArray(authority)) return [];
    const scope = (authority as Record<string, unknown>).access_scope_id;
    return typeof scope === "string" && scope.length > 0 ? [scope] : [];
  });
  const scopeIds = canonicalStringSet(["orchestration-validation", ...environmentScopes]);
  const parsed = parseConfig({
    config_version: "1.0.0",
    access_scopes: scopeIds.map((access_scope_id) => ({ access_scope_id, label: access_scope_id })),
    repositories: [{
      repository_id: "orchestration-validation", provider: "validation", locator: "validation",
      access_scope_id: "orchestration-validation", services: [candidate],
    }],
  });
  if (!parsed.ok) throw new OrchestrationError("INVALID_ORCHESTRATION_INPUT");
  return parsed.value.repositories[0]!.services[0]!;
};

const nonempty = (input: unknown): string => {
  if (typeof input !== "string" || input.length === 0) throw new OrchestrationError("INVALID_ORCHESTRATION_INPUT");
  return input;
};

export const isConfiguredBranch = (serviceInput: unknown, branchInput: unknown): boolean => {
  const service = validatedService(serviceInput);
  const branch = nonempty(branchInput);
  return service.intended_branches.some((configured) => configured === branch);
};

export const selectPullRequestScope = (
  serviceInput: unknown,
  baseBranchInput: unknown,
  headBranchInput: unknown,
): { configuredBaseBranch: string; isolatedHeadBranch: string } | undefined => {
  const service = validatedService(serviceInput);
  const baseBranch = nonempty(baseBranchInput);
  const headBranch = nonempty(headBranchInput);
  return service.intended_branches.includes(baseBranch)
    ? Object.freeze({ configuredBaseBranch: baseBranch, isolatedHeadBranch: headBranch }) : undefined;
};

export const selectReconciliationBranches = (
  serviceInput: unknown,
  environmentsInput: unknown,
): string[] => {
  const service = validatedService(serviceInput);
  if (!Array.isArray(environmentsInput) || environmentsInput.some((value) => typeof value !== "string" || value.length === 0)) {
    throw new OrchestrationError("INVALID_ORCHESTRATION_INPUT");
  }
  const environments = environmentsInput as string[];
  if (service.intended_branches.length === 0) return [];
  if (environments.length === 0) return canonicalStringSet(service.intended_branches);
  const selected: string[] = [];
  for (const environmentName of environments) {
    const environment = service.environments.find((candidate) => candidate.name === environmentName);
    if (environment === undefined) throw new OrchestrationError("EVENT_SUBJECT_MISMATCH");
    if (environment.intended_branch !== undefined && service.intended_branches.includes(environment.intended_branch)) {
      selected.push(environment.intended_branch);
    }
  }
  return canonicalStringSet(selected);
};

export const selectBranchlessBaseline = (serviceInput: unknown, immutableRevisionInput: unknown): {
  serviceId: string; immutableRevision: string;
} => {
  const service = validatedService(serviceInput);
  const immutableRevision = nonempty(immutableRevisionInput);
  return Object.freeze({ serviceId: service.service_id, immutableRevision });
};
