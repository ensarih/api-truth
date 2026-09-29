import type { PoolClient } from "pg";
import { catalogBranchAdvisoryKey } from "@api-truth/catalog";

import { canonicalOrchestrationJson } from "./canonical.js";
import { OrchestrationError } from "./errors.js";

export const LOCK_NAMESPACES = Object.freeze([
  "configuration.tenant",
  "capacity.global",
  "capacity.repository",
  "capacity.service",
  "subject.branch",
  "subject.pr",
  "reconciliation.branch",
  "reconciliation.pr",
  "analysis.checkpoint",
  "catalog.branch",
] as const);

export type LockNamespace = (typeof LOCK_NAMESPACES)[number];
export type AdvisoryLockKey = Readonly<{
  namespace: LockNamespace;
  parts: readonly string[];
  advisoryIdentity?: string;
}>;

const namespaceRank = new Map<LockNamespace, number>(
  LOCK_NAMESPACES.map((namespace, index) => [namespace, index]),
);

const validatedLock = (input: AdvisoryLockKey): AdvisoryLockKey => {
  if (!namespaceRank.has(input.namespace) || !Array.isArray(input.parts)
    || input.parts.length === 0 || input.parts.some((part) => typeof part !== "string" || part.length === 0)) {
    throw new OrchestrationError("INVALID_ORCHESTRATION_INPUT");
  }
  if (input.advisoryIdentity !== undefined
    && (input.namespace !== "catalog.branch" || typeof input.advisoryIdentity !== "string" || input.advisoryIdentity.length === 0)) {
    throw new OrchestrationError("INVALID_ORCHESTRATION_INPUT");
  }
  return Object.freeze({
    namespace: input.namespace,
    parts: Object.freeze([...input.parts]),
    ...(input.advisoryIdentity === undefined ? {} : { advisoryIdentity: input.advisoryIdentity }),
  });
};

export const advisoryLockIdentity = (input: AdvisoryLockKey): string => {
  const lock = validatedLock(input);
  return lock.namespace === "catalog.branch"
    ? lock.advisoryIdentity!
    : canonicalOrchestrationJson([lock.namespace, ...lock.parts]);
};

export const canonicalAdvisoryLocks = (inputs: readonly AdvisoryLockKey[]): AdvisoryLockKey[] => {
  const unique = new Map<string, AdvisoryLockKey>();
  for (const input of inputs) {
    const lock = validatedLock(input);
    unique.set(advisoryLockIdentity(lock), lock);
  }
  return [...unique.values()].sort((left, right) => {
    const rank = namespaceRank.get(left.namespace)! - namespaceRank.get(right.namespace)!;
    return rank !== 0 ? rank : Buffer.compare(
      Buffer.from(advisoryLockIdentity(left), "utf8"),
      Buffer.from(advisoryLockIdentity(right), "utf8"),
    );
  });
};

export const acquireAdvisoryLocks = async (
  client: PoolClient,
  inputs: readonly AdvisoryLockKey[],
): Promise<ReadonlySet<string>> => {
  const acquired = new Set<string>();
  for (const lock of canonicalAdvisoryLocks(inputs)) {
    const identity = advisoryLockIdentity(lock);
    await client.query(
      "SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))",
      [identity],
    );
    acquired.add(identity);
  }
  return acquired;
};

export class OrchestrationLockRestart extends Error {
  readonly missingLocks: readonly AdvisoryLockKey[];

  constructor(missingLocks: readonly AdvisoryLockKey[]) {
    super("orchestration transaction requires a canonical lock restart");
    this.name = "OrchestrationLockRestart";
    this.missingLocks = Object.freeze(canonicalAdvisoryLocks(missingLocks));
  }
}

export const requireDiscoveredLocks = (
  acquired: ReadonlySet<string>,
  required: readonly AdvisoryLockKey[],
): void => {
  const missing = canonicalAdvisoryLocks(required).filter((lock) => !acquired.has(advisoryLockIdentity(lock)));
  if (missing.length > 0) throw new OrchestrationLockRestart(missing);
};

export const configurationLock = (tenantId: string): AdvisoryLockKey => ({
  namespace: "configuration.tenant",
  parts: [tenantId],
});

export const capacityGlobalLock = (tenantId: string): AdvisoryLockKey => ({
  namespace: "capacity.global",
  parts: [tenantId],
});

export const capacityRepositoryLock = (tenantId: string, repositoryId: string): AdvisoryLockKey => ({
  namespace: "capacity.repository",
  parts: [tenantId, repositoryId],
});

export const capacityServiceLock = (tenantId: string, repositoryId: string, serviceId: string): AdvisoryLockKey => ({
  namespace: "capacity.service",
  parts: [tenantId, repositoryId, serviceId],
});

export const branchLock = (
  tenantId: string,
  repositoryId: string,
  serviceId: string,
  branch: string,
): AdvisoryLockKey => ({ namespace: "subject.branch", parts: [tenantId, repositoryId, serviceId, branch] });

export const pullRequestLock = (
  tenantId: string,
  repositoryId: string,
  serviceId: string,
  pullRequestId: string,
): AdvisoryLockKey => ({ namespace: "subject.pr", parts: [tenantId, repositoryId, serviceId, pullRequestId] });

export const reconciliationBranchLock = (
  tenantId: string,
  repositoryId: string,
  serviceId: string,
  branch: string,
): AdvisoryLockKey => ({ namespace: "reconciliation.branch", parts: [tenantId, repositoryId, serviceId, branch] });

export const reconciliationPullRequestLock = (
  tenantId: string,
  repositoryId: string,
  serviceId: string,
  pullRequestId: string,
): AdvisoryLockKey => ({ namespace: "reconciliation.pr", parts: [tenantId, repositoryId, serviceId, pullRequestId] });

export const analysisCheckpointLock = (
  tenantId: string,
  repositoryId: string,
  serviceId: string,
  identity: string,
): AdvisoryLockKey => ({ namespace: "analysis.checkpoint", parts: [tenantId, repositoryId, serviceId, identity] });

export const catalogBranchLock = (
  tenantId: string,
  repositoryId: string,
  serviceId: string,
  branch: string,
): AdvisoryLockKey => ({
  namespace: "catalog.branch",
  parts: [tenantId, repositoryId, serviceId, branch],
  advisoryIdentity: catalogBranchAdvisoryKey({ tenantId, repositoryId, serviceId, branch }),
});
