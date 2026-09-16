import { type Static, type TSchema, Type } from "@sinclair/typebox";
import { issue, parserFor, type ValidationIssue } from "./validation.js";
import { ConfigVersionSchema, EventVersionSchema } from "./versions.js";

const NonEmptyString = () => Type.String({ minLength: 1 });
const SubjectsSchema = Type.Object({
  repository_id: Type.Optional(NonEmptyString()),
  service_ids: Type.Array(NonEmptyString(), { minItems: 1, uniqueItems: true }),
  environment: Type.Optional(NonEmptyString()),
}, { additionalProperties: false });

const ProviderEvidenceSchema = Type.Object({
  provider: NonEmptyString(),
  provider_reference: NonEmptyString(),
  order: Type.Optional(Type.Object({
    kind: Type.Union([Type.Literal("sequence"), Type.Literal("cursor"), Type.Literal("effective_version")]),
    value: NonEmptyString(),
  }, { additionalProperties: false })),
}, { additionalProperties: false });

const RevisionReferenceSchema = Type.Union([
  Type.Object({ state: Type.Literal("known"), revision: NonEmptyString() }, { additionalProperties: false }),
  Type.Object({ state: Type.Literal("unknown"), reason: NonEmptyString() }, { additionalProperties: false }),
]);

const DeploymentAttemptSchema = Type.Object({
  change_kind: Type.Literal("attempt"),
  deployment_id: NonEmptyString(),
  environment: NonEmptyString(),
  attempt_state: Type.Union([
    Type.Literal("pending"), Type.Literal("succeeded"), Type.Literal("failed"),
    Type.Literal("rollback_requested"), Type.Literal("rolled_back"),
  ]),
  effective_order: NonEmptyString(),
  artifact_id: Type.Optional(NonEmptyString()),
  revision: RevisionReferenceSchema,
  target_revision: Type.Optional(NonEmptyString()),
  configuration_digest: Type.Optional(NonEmptyString()),
}, { additionalProperties: false });

const ServingObservationSchema = Type.Object({
  change_kind: Type.Literal("serving_observation"),
  observation_id: NonEmptyString(),
  environment: NonEmptyString(),
  source: Type.Object({
    authority_id: NonEmptyString(), reference: NonEmptyString(), access_label: NonEmptyString(),
  }, { additionalProperties: false }),
  completeness: Type.Union([Type.Literal("complete"), Type.Literal("incomplete"), Type.Literal("transitional")]),
  effective_order: NonEmptyString(),
  rollback_request_id: Type.Optional(NonEmptyString()),
  serving_state: Type.Union([
    Type.Object({
      status: Type.Literal("known"),
      inventory: Type.Array(Type.Object({ artifact_id: NonEmptyString(), revision: RevisionReferenceSchema }, { additionalProperties: false })),
    }, { additionalProperties: false }),
    Type.Object({
      status: Type.Literal("unknown"), reason: NonEmptyString(), observed_artifact_ids: Type.Optional(Type.Array(NonEmptyString())),
    }, { additionalProperties: false }),
  ]),
}, { additionalProperties: false });

const eventEnvelope = <Payload extends TSchema>(eventType: string, payload: Payload) => Type.Object({
  event_version: EventVersionSchema,
  event_id: NonEmptyString(),
  event_type: Type.Literal(eventType),
  producer: Type.Object({ producer_id: NonEmptyString(), adapter_version: NonEmptyString() }, { additionalProperties: false }),
  occurred_at: Type.String({ format: "date-time" }),
  received_at: Type.String({ format: "date-time" }),
  subjects: SubjectsSchema,
  provider_evidence: ProviderEvidenceSchema,
  payload,
}, { additionalProperties: false });

export const EventSchema = Type.Union([
  eventEnvelope("repository.baseline_requested", Type.Object({
    immutable_revision: NonEmptyString(), service_ids: Type.Array(NonEmptyString(), { minItems: 1, uniqueItems: true }),
  }, { additionalProperties: false })),
  eventEnvelope("pull_request.updated", Type.Object({
    pull_request_id: NonEmptyString(), state: Type.Union([Type.Literal("open"), Type.Literal("updated"), Type.Literal("closed"), Type.Literal("merged")]),
    base_branch: NonEmptyString(), base_revision: NonEmptyString(), head_branch: NonEmptyString(), head_revision: NonEmptyString(),
  }, { additionalProperties: false })),
  eventEnvelope("branch.updated", Type.Object({
    branch: NonEmptyString(), prior_revision: Type.Union([NonEmptyString(), Type.Null()]), new_revision: NonEmptyString(),
    reference_state: Type.Union([Type.Literal("created"), Type.Literal("fast_forward"), Type.Literal("rewritten"), Type.Literal("deleted")]),
  }, { additionalProperties: false })),
  eventEnvelope("deployment.changed", Type.Union([DeploymentAttemptSchema, ServingObservationSchema])),
  eventEnvelope("configuration.changed", Type.Object({
    config_version: ConfigVersionSchema, config_fingerprint: NonEmptyString(),
    affected_service_ids: Type.Array(NonEmptyString(), { minItems: 1, uniqueItems: true }), affected_scope: NonEmptyString(),
  }, { additionalProperties: false })),
  eventEnvelope("source_document.changed", Type.Object({
    document_id: NonEmptyString(), source_version: NonEmptyString(),
    state: Type.Union([Type.Literal("updated"), Type.Literal("deleted"), Type.Literal("permissions_changed")]), access_label: NonEmptyString(),
  }, { additionalProperties: false })),
  eventEnvelope("reconciliation.requested", Type.Object({
    scope: Type.Object({
      service_ids: Type.Array(NonEmptyString(), { minItems: 1, uniqueItems: true }),
      environments: Type.Array(NonEmptyString(), { uniqueItems: true }),
    }, { additionalProperties: false }),
    provider_snapshot_reference: NonEmptyString(),
  }, { additionalProperties: false })),
], { $id: "https://api-truth.dev/schemas/event-1.0.0.json" });

export type EventEnvelope = Static<typeof EventSchema>;

const validateEventSemantics = (event: EventEnvelope): ValidationIssue[] => {
  const issues: ValidationIssue[] = [];
  const deploymentPayload = event.event_type === "deployment.changed"
    ? event.payload as Static<typeof DeploymentAttemptSchema> | Static<typeof ServingObservationSchema>
    : undefined;
  if (deploymentPayload !== undefined && event.subjects.environment !== undefined && event.subjects.environment !== deploymentPayload.environment) {
    issues.push(issue("/payload/environment", "semantic.environment_mismatch", "payload environment differs from the event subject"));
  }
  if (deploymentPayload?.change_kind === "serving_observation") {
    const { completeness, serving_state: servingState } = deploymentPayload;
    if (servingState.status === "known" && servingState.inventory.length === 0 && completeness !== "complete") {
      issues.push(issue("/payload/serving_state/inventory", "semantic.incomplete_absence", "only a complete inventory can establish absence"));
    }
    if (servingState.status === "unknown" && completeness === "complete") {
      issues.push(issue("/payload/completeness", "semantic.inconsistent_completeness", "a complete observation cannot have unknown serving state"));
    }
    if (servingState.status === "known") {
      const seenArtifacts = new Set<string>();
      servingState.inventory.forEach((mapping, index) => {
        if (seenArtifacts.has(mapping.artifact_id)) {
          issues.push(issue(
            `/payload/serving_state/inventory/${index}/artifact_id`,
            "semantic.conflicting_artifact_mapping",
            "an artifact may appear only once in an authoritative inventory",
          ));
        }
        seenArtifacts.add(mapping.artifact_id);
      });
    }
  }
  return issues;
};

export const parseEvent = parserFor(EventSchema, validateEventSemantics);
export const validateEvent = parseEvent;
