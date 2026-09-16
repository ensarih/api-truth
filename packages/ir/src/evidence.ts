import { type Static, Type } from "@sinclair/typebox";
import { JsonValueSchema } from "./json-value.js";

const NonEmptyString = () => Type.String({ minLength: 1 });

export const EvidenceMethodSchema = Type.Union([
  Type.Literal("type_declaration"),
  Type.Literal("runtime_validator"),
  Type.Literal("observation"),
  Type.Literal("behavioral_verification"),
  Type.Literal("deterministic_analysis"),
  Type.Literal("inference"),
  Type.Literal("owner_assertion"),
]);

export const EvidenceSchema = Type.Object({
  evidence_id: NonEmptyString(),
  source: Type.Object({ kind: NonEmptyString(), source_id: NonEmptyString() }, { additionalProperties: false }),
  source_version: NonEmptyString(),
  location: Type.Object({
    path: Type.Optional(NonEmptyString()),
    symbol: Type.Optional(NonEmptyString()),
    pointer: Type.Optional(NonEmptyString()),
    line: Type.Optional(Type.Integer({ minimum: 1 })),
  }, { additionalProperties: false, minProperties: 1 }),
  method: EvidenceMethodSchema,
  scope: Type.Object({
    service_id: NonEmptyString(),
    snapshot_id: Type.Optional(NonEmptyString()),
    endpoint_id: Type.Optional(NonEmptyString()),
    revision: Type.Optional(NonEmptyString()),
  }, { additionalProperties: false }),
  limitations: Type.Array(Type.String()),
  access_label: NonEmptyString(),
}, { $id: "https://api-truth.dev/schemas/evidence-1.0.0.json", additionalProperties: false });

export type Evidence = Static<typeof EvidenceSchema>;

export const ConditionSchema = Type.Recursive((This) => Type.Union([
  Type.Object({
    kind: Type.Literal("predicate"),
    operator: Type.Union([Type.Literal("and"), Type.Literal("or"), Type.Literal("not"), Type.Literal("equals"), Type.Literal("present")]),
    field: Type.Optional(NonEmptyString()),
    value: Type.Optional(Type.Ref(JsonValueSchema)),
    operands: Type.Optional(Type.Array(This, { minItems: 1 })),
    affected_schema_paths: Type.Array(NonEmptyString(), { minItems: 1 }),
  }, { additionalProperties: false }),
  Type.Object({
    kind: Type.Literal("business_expression"),
    expression: NonEmptyString(),
    scope: NonEmptyString(),
    affected_schema_paths: Type.Array(NonEmptyString(), { minItems: 1 }),
  }, { additionalProperties: false }),
]), { $id: "https://api-truth.dev/schemas/condition-1.0.0.json" });

export const PresenceFactSchema = Type.Union([
  Type.Object({
    state: Type.Literal("conditional"),
    condition: Type.Ref(ConditionSchema),
    evidence_ids: Type.Array(NonEmptyString(), { minItems: 1, uniqueItems: true }),
  }, { additionalProperties: false }),
  Type.Object({
    state: Type.Union([Type.Literal("required"), Type.Literal("optional"), Type.Literal("unknown")]),
    evidence_ids: Type.Array(NonEmptyString(), { minItems: 1, uniqueItems: true }),
  }, { additionalProperties: false }),
], { $id: "https://api-truth.dev/schemas/presence-fact-1.0.0.json" });

export const ClaimSchema = Type.Object({
  claim_id: NonEmptyString(),
  subject: Type.Object({
    service_id: NonEmptyString(),
    endpoint_id: Type.Optional(NonEmptyString()),
    schema_pointer: Type.Optional(NonEmptyString()),
  }, { additionalProperties: false }),
  predicate: NonEmptyString(),
  value: Type.Ref(JsonValueSchema),
  verification: Type.Union([
    Type.Literal("declared"), Type.Literal("established_by_analysis"), Type.Literal("observed"),
    Type.Literal("inferred"), Type.Literal("owner_asserted"),
  ]),
  condition: Type.Optional(Type.Ref(ConditionSchema)),
  evidence_ids: Type.Array(NonEmptyString(), { minItems: 1, uniqueItems: true }),
}, { $id: "https://api-truth.dev/schemas/claim-1.0.0.json", additionalProperties: false });

export const EditorialReviewSchema = Type.Object({
  review_id: NonEmptyString(),
  claim_id: NonEmptyString(),
  state: Type.Union([Type.Literal("accepted"), Type.Literal("rejected"), Type.Literal("needs_review")]),
  reviewer_id: NonEmptyString(),
  reviewed_at: Type.String({ format: "date-time" }),
  explanation: NonEmptyString(),
}, { $id: "https://api-truth.dev/schemas/editorial-review-1.0.0.json", additionalProperties: false });

const EligibilityScopeSchema = Type.Object({
  service_id: NonEmptyString(),
  snapshot_id: NonEmptyString(),
  endpoint_ids: Type.Array(NonEmptyString(), { uniqueItems: true }),
}, { additionalProperties: false });

export const ExportEligibilitySchema = Type.Union([
  Type.Object({
    eligibility_id: NonEmptyString(), claim_id: NonEmptyString(), status: Type.Literal("eligible"),
    scope: EligibilityScopeSchema, policy_version: NonEmptyString(), evidence_fingerprint: NonEmptyString(),
    basis: Type.Object({
      kind: Type.Union([Type.Literal("supported_runtime_validator"), Type.Literal("deterministic_analysis"), Type.Literal("behavioral_verification")]),
      evidence_ids: Type.Array(NonEmptyString(), { minItems: 1, uniqueItems: true }),
    }, { additionalProperties: false }),
  }, { additionalProperties: false }),
  Type.Object({
    eligibility_id: NonEmptyString(), claim_id: NonEmptyString(), status: Type.Literal("ineligible"),
    scope: EligibilityScopeSchema, policy_version: NonEmptyString(), evidence_fingerprint: NonEmptyString(), reason: NonEmptyString(),
  }, { additionalProperties: false }),
], { $id: "https://api-truth.dev/schemas/export-eligibility-1.0.0.json" });

export type Claim = Static<typeof ClaimSchema>;
export type EditorialReview = Static<typeof EditorialReviewSchema>;
export type ExportEligibility = Static<typeof ExportEligibilitySchema>;
