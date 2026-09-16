import { type Static, Type } from "@sinclair/typebox";
import { SchemaComponentSchema } from "./api-schema.js";
import { ClaimSchema, EvidenceSchema } from "./evidence.js";
import { EndpointSchema } from "./endpoints.js";
import {
  AnalyzerIdentitySchema, ContractSnapshotSchemaReferences, CoverageSchema, DependencySchema, DiagnosticSchema,
  validateContractSnapshotSemantics,
} from "./snapshot.js";
import { parserFor, type ValidationIssue } from "./validation.js";
import { AnalyzerExchangeVersionSchema, ConfigVersionSchema, IdentityVersionSchema, IrVersionSchema } from "./versions.js";

const NonEmptyString = () => Type.String({ minLength: 1 });

export const AnalyzerSourceSchema = Type.Object({
  repository_id: NonEmptyString(),
  service_id: NonEmptyString(),
  service_root: NonEmptyString(),
  immutable_revision: NonEmptyString(),
  source_digest: NonEmptyString(),
  access_label: NonEmptyString(),
}, { additionalProperties: false });

export const AnalyzerRequestSchema = Type.Object({
  exchange_version: AnalyzerExchangeVersionSchema,
  ir_version: IrVersionSchema,
  request_id: NonEmptyString(),
  analyzer: AnalyzerIdentitySchema,
  source: AnalyzerSourceSchema,
  resolution_inputs: Type.Array(Type.Object({
    kind: Type.Union([Type.Literal("source_tree"), Type.Literal("type_manifest"), Type.Literal("classpath"), Type.Literal("generated_sources")]),
    path: NonEmptyString(), digest: NonEmptyString(),
  }, { additionalProperties: false }), { minItems: 1 }),
  prior_dependencies: Type.Array(DependencySchema),
  changed_paths: Type.Array(NonEmptyString(), { uniqueItems: true }),
  extraction_mode: Type.Union([Type.Literal("baseline"), Type.Literal("incremental"), Type.Literal("fallback_full_service")]),
  limits: Type.Object({
    timeout_ms: Type.Integer({ minimum: 1 }), max_files: Type.Integer({ minimum: 1 }), max_output_bytes: Type.Integer({ minimum: 1 }),
  }, { additionalProperties: false }),
  execution_policy: Type.Object({ network_access: Type.Literal(false), side_effects: Type.Literal("none") }, { additionalProperties: false }),
}, { $id: "https://api-truth.dev/schemas/analyzer-request-1.0.0.json", additionalProperties: false });

export const AnalyzerResultSchema = Type.Object({
  exchange_version: AnalyzerExchangeVersionSchema,
  ir_version: IrVersionSchema,
  identity_version: IdentityVersionSchema,
  request_id: NonEmptyString(),
  result_id: NonEmptyString(),
  snapshot_id: NonEmptyString(),
  analyzer: AnalyzerIdentitySchema,
  source: AnalyzerSourceSchema,
  status: Type.Union([Type.Literal("success"), Type.Literal("partial"), Type.Literal("failed")]),
  completed_at: Type.String({ format: "date-time" }),
  coverage: CoverageSchema,
  evidence: Type.Array(Type.Ref(EvidenceSchema)),
  schemas: Type.Record(Type.String({ minLength: 1 }), Type.Ref(SchemaComponentSchema)),
  endpoints: Type.Array(Type.Ref(EndpointSchema)),
  claims: Type.Array(Type.Ref(ClaimSchema)),
  dependencies: Type.Array(DependencySchema),
  diagnostics: Type.Array(DiagnosticSchema),
  reproducibility_fingerprint: NonEmptyString(),
}, { $id: "https://api-truth.dev/schemas/analyzer-result-1.0.0.json", additionalProperties: false });

export type AnalyzerRequest = Static<typeof AnalyzerRequestSchema>;
export type AnalyzerResult = Static<typeof AnalyzerResultSchema>;

const validateAnalyzerResultSemantics = (result: AnalyzerResult): ValidationIssue[] => {
  const issues = validateContractSnapshotSemantics({
    ir_version: result.ir_version,
    identity_version: result.identity_version,
    snapshot_id: result.snapshot_id,
    service: {
      service_id: result.source.service_id,
      repository_id: result.source.repository_id,
      root: result.source.service_root,
    },
    source: {
      repository_id: result.source.repository_id,
      immutable_revision: result.source.immutable_revision,
      source_digest: result.source.source_digest,
    },
    analyzer: result.analyzer,
    config: { config_version: ConfigVersionSchema.const, config_fingerprint: result.reproducibility_fingerprint },
    created_at: result.completed_at,
    coverage: result.coverage,
    evidence: result.evidence,
    schemas: result.schemas,
    endpoints: result.endpoints,
    claims: result.claims,
    editorial_reviews: [],
    export_eligibility: [],
    dependencies: result.dependencies,
    diagnostics: result.diagnostics,
  });
  if (result.status === "success" && result.coverage.status !== "complete") {
    issues.push({ path: "/status", code: "semantic.inconsistent_coverage", message: "successful results require complete coverage" });
  }
  if (result.status === "partial" && result.coverage.status !== "incomplete") {
    issues.push({ path: "/status", code: "semantic.inconsistent_coverage", message: "partial results require incomplete coverage" });
  }
  return issues;
};

export const parseAnalyzerRequest = parserFor(AnalyzerRequestSchema);
export const validateAnalyzerRequest = parseAnalyzerRequest;
export const parseAnalyzerResult = parserFor(AnalyzerResultSchema, validateAnalyzerResultSemantics, ContractSnapshotSchemaReferences);
export const validateAnalyzerResult = parseAnalyzerResult;
