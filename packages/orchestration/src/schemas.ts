import { type Static, type TSchema, Type } from "@sinclair/typebox";
import { failure, issue, parserFor, type ValidationIssue, type ValidationResult } from "@api-truth/ir";
import { canonicalOrchestrationJson, detachedFrozen, isCanonicalStringSet } from "./canonical.js";

const NonEmpty = () => Type.String({ minLength: 1 });
const Decimal = () => Type.String({ pattern: "^(0|[1-9][0-9]*)$" });
const SafeErrorCodeSchema = Type.Union([
  Type.Literal("INVALID_ORCHESTRATION_INPUT"), Type.Literal("EVENT_UNAUTHORIZED"), Type.Literal("EVENT_ID_CONFLICT"),
  Type.Literal("EVENT_SUBJECT_MISMATCH"), Type.Literal("CONFIGURATION_NOT_FOUND"), Type.Literal("CONFIGURATION_CONFLICT"),
  Type.Literal("CONFIGURATION_UNAUTHORIZED"), Type.Literal("EVENT_ORDER_CONFLICT"), Type.Literal("REVISION_ASSOCIATION_CONFLICT"),
  Type.Literal("JOB_NOT_FOUND_OR_DENIED"), Type.Literal("WORKER_UNAUTHORIZED"), Type.Literal("JOB_LEASE_CONFLICT"),
  Type.Literal("JOB_CANCELLED"), Type.Literal("JOB_SUPERSEDED"), Type.Literal("JOB_DEPENDENCY_FAILED"),
  Type.Literal("JOB_EXECUTION_FAILED"), Type.Literal("RECONCILIATION_FAILED"), Type.Literal("OUTBOX_LEASE_CONFLICT"),
  Type.Literal("OUTBOX_DELIVERY_FAILED"), Type.Literal("PROMOTION_INELIGIBLE"), Type.Literal("ORCHESTRATION_STORAGE_ERROR"),
]);
const DispositionCountsSchema = Type.Object({
  scheduled: Type.Optional(Type.Integer({ minimum: 0 })),
  ignored_unconfigured_branch: Type.Optional(Type.Integer({ minimum: 0 })),
  ignored_stale: Type.Optional(Type.Integer({ minimum: 0 })),
  reconciliation_required: Type.Optional(Type.Integer({ minimum: 0 })),
  deferred_handler: Type.Optional(Type.Integer({ minimum: 0 })),
  no_work: Type.Optional(Type.Integer({ minimum: 0 })),
}, { additionalProperties: false });
const EventTypeSchema = Type.Union([
  Type.Literal("branch.updated"), Type.Literal("configuration.changed"), Type.Literal("deployment.changed"),
  Type.Literal("pull_request.updated"), Type.Literal("reconciliation.requested"),
  Type.Literal("repository.baseline_requested"), Type.Literal("source_document.changed"),
]);

const canonicalSetIssues = (entries: Array<[string, readonly string[]]>): ValidationIssue[] =>
  entries.flatMap(([path, values]) => isCanonicalStringSet(values)
    ? [] : [issue(path, "semantic.noncanonical_order", "set must be unique and UTF-8 byte sorted")]);

const safeParser = <Schema extends TSchema>(schema: Schema, semantic?: (value: Static<Schema>) => ValidationIssue[]) => {
  const parse = parserFor(schema, semantic);
  return (value: unknown): ValidationResult<Static<Schema>> => {
    try {
      const detached = JSON.parse(canonicalOrchestrationJson(value)) as unknown;
      const result = parse(detached);
      return result.ok ? { ok: true, value: detachedFrozen(result.value) } : result;
    } catch {
      return failure([issue("/", "shape.invalid_json_value", "input must contain only JSON values")]);
    }
  };
};

export const DeploymentAuthorityGrantSchema = Type.Object({
  repositoryId: NonEmpty(), serviceId: NonEmpty(), environment: NonEmpty(), adapterId: NonEmpty(),
  sourceAuthorityIds: Type.Array(NonEmpty(), { uniqueItems: true }),
}, { additionalProperties: false });

export const AuthenticatedEventContextSchema = Type.Object({
  tenantId: NonEmpty(), principalId: NonEmpty(), producerId: NonEmpty(),
  allowedEventTypes: Type.Array(EventTypeSchema, { uniqueItems: true }),
  allowedRepositories: Type.Array(NonEmpty(), { uniqueItems: true }),
  allowedServices: Type.Array(NonEmpty(), { uniqueItems: true }),
  deploymentAuthorityGrants: Type.Array(DeploymentAuthorityGrantSchema, { uniqueItems: true }),
  capabilities: Type.Array(Type.Union([Type.Literal("configuration.admin"), Type.Literal("event.ingest")]), { uniqueItems: true }),
}, { $id: "https://api-truth.dev/schemas/authenticated-event-context-1.0.0.json", additionalProperties: false });

export type AuthenticatedEventContext = Static<typeof AuthenticatedEventContextSchema>;

const contextSemantic = (value: AuthenticatedEventContext): ValidationIssue[] => [
  ...canonicalSetIssues([
    ["/allowedEventTypes", value.allowedEventTypes], ["/allowedRepositories", value.allowedRepositories],
    ["/allowedServices", value.allowedServices], ["/capabilities", value.capabilities],
  ]),
  ...value.deploymentAuthorityGrants.flatMap((grant, index) => canonicalSetIssues([
    [`/deploymentAuthorityGrants/${index}/sourceAuthorityIds`, grant.sourceAuthorityIds],
  ])),
  ...(value.deploymentAuthorityGrants.every((grant, index, grants) => index === 0 ||
    Buffer.compare(Buffer.from([
      grants[index - 1]!.repositoryId, grants[index - 1]!.serviceId, grants[index - 1]!.environment, grants[index - 1]!.adapterId,
    ].join("\u0000")), Buffer.from([grant.repositoryId, grant.serviceId, grant.environment, grant.adapterId].join("\u0000"))) < 0)
    ? [] : [issue("/deploymentAuthorityGrants", "semantic.noncanonical_order", "grants must be canonical")]),
];

export const parseAuthenticatedEventContext = safeParser(AuthenticatedEventContextSchema, contextSemantic);

export const ControlContextSchema = Type.Object({
  tenantId: NonEmpty(), principalId: NonEmpty(),
  capabilities: Type.Array(Type.Union([
    Type.Literal("configuration.admin"), Type.Literal("orchestration.cancel"), Type.Literal("orchestration.status.read"),
  ]), { uniqueItems: true }),
}, { additionalProperties: false });
export type ControlContext = Static<typeof ControlContextSchema>;
export const parseControlContext = safeParser(ControlContextSchema, (value) => canonicalSetIssues([["/capabilities", value.capabilities]]));

export const WorkerIdentitySchema = Type.Object({
  workerId: NonEmpty(), instanceId: NonEmpty(),
  capabilities: Type.Array(Type.Union([Type.Literal("jobs.execute"), Type.Literal("outbox.deliver")]), { uniqueItems: true }),
}, { additionalProperties: false });
export type WorkerIdentity = Static<typeof WorkerIdentitySchema>;
export const parseWorkerIdentity = safeParser(WorkerIdentitySchema, (value) => canonicalSetIssues([["/capabilities", value.capabilities]]));

export const ProviderEvidenceSchema = Type.Object({
  provider: NonEmpty(), provider_reference: NonEmpty(),
  order: Type.Optional(Type.Object({
    kind: Type.Union([Type.Literal("sequence"), Type.Literal("cursor"), Type.Literal("effective_version")]),
    value: NonEmpty(),
  }, { additionalProperties: false })),
}, { additionalProperties: false });
export type ProviderEvidence = Static<typeof ProviderEvidenceSchema>;
export const parseProviderEvidence = safeParser(ProviderEvidenceSchema);

export const EventReceiptSchema = Type.Object({
  outcome: Type.Union([Type.Literal("accepted"), Type.Literal("duplicate")]),
  disposition: Type.Union([
    Type.Literal("scheduled"), Type.Literal("ignored_unconfigured_branch"), Type.Literal("ignored_stale"),
    Type.Literal("reconciliation_required"), Type.Literal("deferred_handler"), Type.Literal("no_work"), Type.Literal("mixed"),
  ]),
  dispositionCounts: DispositionCountsSchema,
}, { additionalProperties: false });
export const parseEventReceipt = safeParser(EventReceiptSchema);

export const EventStatusSchema = Type.Object({
  eventId: NonEmpty(), outcome: Type.Union([Type.Literal("accepted"), Type.Literal("duplicate")]),
  disposition: Type.Union([
    Type.Literal("scheduled"), Type.Literal("ignored_unconfigured_branch"), Type.Literal("ignored_stale"),
    Type.Literal("reconciliation_required"), Type.Literal("deferred_handler"), Type.Literal("no_work"), Type.Literal("mixed"),
  ]),
  dispositionCounts: DispositionCountsSchema,
  receivedAt: Type.Optional(Type.String({ format: "date-time" })),
}, { additionalProperties: false });
export type EventStatus = Static<typeof EventStatusSchema>;
export const parseEventStatus = safeParser(EventStatusSchema);

const JobKindSchema = Type.Union([
  Type.Literal("baseline_analysis"), Type.Literal("branch_analysis"), Type.Literal("pr_preview_analysis"),
  Type.Literal("branch_reconciliation"), Type.Literal("pr_reconciliation"),
]);
const JobStateSchema = Type.Union([
  Type.Literal("queued"), Type.Literal("leased"), Type.Literal("retry_wait"), Type.Literal("succeeded"),
  Type.Literal("failed"), Type.Literal("cancelled"), Type.Literal("superseded"),
]);

export const JobStatusSchema = Type.Object({
  jobId: NonEmpty(), kind: JobKindSchema, state: JobStateSchema,
  attemptCount: Decimal(), maxAttempts: Decimal(),
  createdAt: Type.Optional(Type.String({ format: "date-time" })),
  startedAt: Type.Optional(Type.String({ format: "date-time" })),
  completedAt: Type.Optional(Type.String({ format: "date-time" })),
  coverageStatus: Type.Optional(Type.Union([Type.Literal("complete"), Type.Literal("incomplete"), Type.Literal("unknown")])),
  safeErrorCode: Type.Optional(SafeErrorCodeSchema),
}, { $id: "https://api-truth.dev/schemas/orchestration-job-status-1.0.0.json", additionalProperties: false });
export type JobStatus = Static<typeof JobStatusSchema>;
export const parseJobStatus = safeParser(JobStatusSchema);

export const ActiveConfigurationSummarySchema = Type.Object({
  fingerprint: NonEmpty(), configVersion: NonEmpty(), checkpointVersion: Decimal(), activatedAt: Type.String({ format: "date-time" }),
}, { additionalProperties: false });
export const parseActiveConfigurationSummary = safeParser(ActiveConfigurationSummarySchema);

export const OutboxStatusSchema = Type.Object({
  outboxId: NonEmpty(),
  state: Type.Union([
    Type.Literal("pending"), Type.Literal("leased"), Type.Literal("retry_wait"),
    Type.Literal("delivered"), Type.Literal("exhausted"),
  ]),
  attemptCount: Decimal(), maxAttempts: Decimal(), safeErrorCode: Type.Optional(SafeErrorCodeSchema),
}, { additionalProperties: false });
export type OutboxStatus = Static<typeof OutboxStatusSchema>;
export const parseOutboxStatus = safeParser(OutboxStatusSchema);
