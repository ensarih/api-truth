import type {ContractSnapshot} from "../../ir/src/index.js";

/** The caller has already authorized this exact catalog snapshot and resolved its serving revision. */
export interface TrustedResolvedEnvironmentPin {
  readonly state: "resolved_single_revision" | string;
  readonly tenantId: string;
  readonly serviceId: string;
  readonly repositoryId: string;
  readonly environment: string;
  readonly snapshotId: string;
  readonly revision: string;
  readonly configFingerprint: string;
  readonly checkpointVersion: string;
}

/** Routing evidence is supplied by a trusted host, never by the raw log record. */
export interface TrustedRouteMapping extends Omit<TrustedResolvedEnvironmentPin, "state"> {
  readonly mappingId: string;
  readonly publicOrigin: string;
  readonly publicPathTemplate: string;
  readonly applicationPathTemplate: string;
  readonly method: string;
  readonly routingEvidenceIds: readonly string[];
}

export interface ObservationContext {
  readonly pin: TrustedResolvedEnvironmentPin;
  /** Host/source-adapter verified provenance, independent of fields in the raw log. */
  readonly attestation: {
    readonly revision: string;
    readonly sourceId: string;
    readonly sourceVersion: string;
    readonly windowStart: string;
    readonly windowEnd: string;
  };
  readonly snapshot: ContractSnapshot;
  readonly mappings: readonly TrustedRouteMapping[];
}

export type UnresolvedObservationReason =
  | "environment_unresolved" | "revision_unknown" | "revision_mismatch"
  | "invalid_url" | "no_mapping" | "ambiguous_mapping" | "no_endpoint"
  | "ambiguous_endpoint" | "unsupported_route_selectors";

export type SanitizedObservationResult =
  | {readonly status: "confirmed"; readonly endpointId: string; readonly mappingId: string;
      readonly method: string; readonly statusCode: number; readonly completeness: "metadata_only";
      readonly policyVersion: "metadata-only-1"}
  | {readonly status: "unresolved"; readonly reason: UnresolvedObservationReason;
      readonly method?: string; readonly statusCode?: number; readonly completeness: "metadata_only";
      readonly policyVersion: "metadata-only-1"}
  | {readonly status: "rejected"; readonly reason: "invalid_observation" | "invalid_context" | "invalid_mapping";
      readonly policyVersion: "metadata-only-1"};
