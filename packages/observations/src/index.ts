export {correlateMetadataObservation, OBSERVATION_POLICY_VERSION} from "./matcher.js";
export {applyObservationMigrations, ObservationStorageError} from "./migrations.js";
export {createObservationStore, ObservationImportError} from "./store.js";
export {buildSyntheticExample, SyntheticExampleError} from "./examples.js";
export type {ObservationContext, SanitizedObservationResult, TrustedResolvedEnvironmentPin,
  TrustedRouteMapping, UnresolvedObservationReason} from "./types.js";
export type {SyntheticExampleDiagnostic, SyntheticExamplePolicy, SyntheticExampleResult} from "./examples.js";
