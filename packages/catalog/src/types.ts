import type { AnalyzerResult, ContractSnapshot } from "@api-truth/ir";

export type TenantContext = { tenantId: string };
export type PrincipalContext = TenantContext & { principalId: string };

export type ProviderOrder = {
  kind: "sequence" | "cursor" | "effective_version";
  value: string;
};

export type ProviderReference = {
  provider: string;
  provider_reference: string;
  order?: ProviderOrder;
};

export type BranchKey = {
  tenantId: string;
  repositoryId: string;
  serviceId: string;
  branch: string;
};

export type ExpectedPointer =
  | { state: "absent" }
  | { state: "present"; pointerVersion: string };

export type IngestAnalyzerResultInput = TenantContext & {
  result: AnalyzerResult;
  configFingerprint: string;
};

export type SnapshotWriteResult = {
  outcome: "inserted" | "existing";
  snapshotId: string;
  contentSha256: `sha256:${string}`;
  requiredScopeIds: string[];
};

export type StoredSnapshot = {
  tenantId: string;
  snapshotId: string;
  analyzerStatus: "success" | "partial";
  contentSha256: `sha256:${string}`;
  requiredScopeIds: string[];
  snapshot: ContractSnapshot;
};

export type PromoteBranchInput = BranchKey & {
  snapshotId: string;
  provider: ProviderReference;
  expected?: ExpectedPointer;
};

export type BranchPointer = BranchKey & {
  snapshotId: string;
  pointerVersion: string;
  provider: ProviderReference;
  promotedAt: string;
};

export type BranchPromotionResult = {
  outcome: "promoted" | "existing";
  pointer: BranchPointer;
};

export type BranchResolution = {
  pointer: BranchPointer;
  stored: StoredSnapshot;
};

export type CatalogErrorCode =
  | "INVALID_CATALOG_INPUT"
  | "INVALID_SNAPSHOT"
  | "SNAPSHOT_INELIGIBLE"
  | "UNKNOWN_ACCESS_SCOPE"
  | "SNAPSHOT_IDENTITY_CONFLICT"
  | "BRANCH_TARGET_INELIGIBLE"
  | "BRANCH_POINTER_STALE"
  | "BRANCH_POINTER_CONFLICT"
  | "CATALOG_NOT_FOUND_OR_DENIED"
  | "CATALOG_STORAGE_ERROR";

export interface CatalogStore {
  ingestAnalyzerResult(input: IngestAnalyzerResultInput): Promise<SnapshotWriteResult>;
  getSnapshot(context: PrincipalContext, snapshotId: string): Promise<StoredSnapshot>;
  promoteBranch(input: PromoteBranchInput): Promise<BranchPromotionResult>;
  resolveBranch(context: PrincipalContext, key: Omit<BranchKey, "tenantId">): Promise<BranchResolution>;
}

export interface AccessPolicyStore {
  putScope(context: TenantContext, input: { scopeId: string; active: boolean }): Promise<void>;
  putGrant(
    context: TenantContext,
    input: { principalId: string; scopeId: string; active: boolean },
  ): Promise<void>;
}
