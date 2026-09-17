import {
  CONFIG_VERSION,
  parseAnalyzerResult,
  parseContractSnapshot,
  type AnalyzerResult,
  type ContractSnapshot,
} from "@api-truth/ir";
import { canonicalScopeIds } from "./canonical.js";
import { CatalogError, catalogValidationError } from "./errors.js";

export type ConvertedAnalyzerSnapshot = {
  snapshot: ContractSnapshot;
  requiredScopeIds: string[];
  analyzerStatus: "success" | "partial";
};

const withSnapshotInputBoundary = <Value>(operation: () => Value): Value => {
  try {
    return operation();
  } catch (error) {
    let isCatalogError = false;
    try {
      isCatalogError = error instanceof CatalogError;
    } catch {
      // A thrown Proxy can itself have hostile prototype traps.
    }
    if (isCatalogError) throw error;
    throw new CatalogError("INVALID_SNAPSHOT");
  }
};

export const contractSnapshotFromAnalyzerResult = (
  result: AnalyzerResult,
  configFingerprint: string,
): ConvertedAnalyzerSnapshot => {
  const parsedResult = withSnapshotInputBoundary(() => parseAnalyzerResult(result));
  if (!parsedResult.ok) throw catalogValidationError("INVALID_SNAPSHOT", parsedResult.error);
  const validatedResult = withSnapshotInputBoundary(() => structuredClone(parsedResult.value));

  if (validatedResult.status === "failed") throw new CatalogError("SNAPSHOT_INELIGIBLE");

  const requiredScopeIds = canonicalScopeIds([
    validatedResult.source.access_label,
    ...validatedResult.evidence.map((evidence) => evidence.access_label),
  ]);
  const snapshot: ContractSnapshot = {
    ir_version: validatedResult.ir_version,
    identity_version: validatedResult.identity_version,
    snapshot_id: validatedResult.snapshot_id,
    service: {
      service_id: validatedResult.source.service_id,
      repository_id: validatedResult.source.repository_id,
      root: validatedResult.source.service_root,
    },
    source: {
      repository_id: validatedResult.source.repository_id,
      immutable_revision: validatedResult.source.immutable_revision,
      source_digest: validatedResult.source.source_digest,
    },
    analyzer: validatedResult.analyzer,
    config: { config_version: CONFIG_VERSION, config_fingerprint: configFingerprint },
    created_at: validatedResult.completed_at,
    coverage: validatedResult.coverage,
    evidence: validatedResult.evidence,
    schemas: validatedResult.schemas,
    endpoints: validatedResult.endpoints,
    claims: validatedResult.claims,
    editorial_reviews: [],
    export_eligibility: [],
    dependencies: validatedResult.dependencies,
    diagnostics: validatedResult.diagnostics,
  };

  const parsedSnapshot = withSnapshotInputBoundary(() => parseContractSnapshot(snapshot));
  if (!parsedSnapshot.ok) throw catalogValidationError("INVALID_SNAPSHOT", parsedSnapshot.error);
  return {
    snapshot: withSnapshotInputBoundary(() => structuredClone(parsedSnapshot.value)),
    requiredScopeIds,
    analyzerStatus: validatedResult.status,
  };
};
