import { parseConfig, parseEvent, type EventEnvelope, type InstallationConfig } from "@api-truth/ir";
import type { Pool, PoolClient } from "pg";

import { authorizeNormalizedEvent, requireControlCapability } from "./authorization.js";
import { isConfiguredBranch, selectPullRequestScope, selectReconciliationBranches } from "./branch-selection.js";
import { canonicalOrchestrationHash, canonicalOrchestrationJson, canonicalStringSet, detachedFrozen } from "./canonical.js";
import { calculateConfigurationImpact } from "./configuration.js";
import { withOrchestrationTransaction } from "./database.js";
import { OrchestrationError, orchestrationValidationError } from "./errors.js";
import { eventSha256, semanticOrchestrationId } from "./hashing.js";
import { classifyProviderUpdate } from "./ordering.js";
import {
  parseAuthenticatedEventContext,
  parseActiveConfigurationSummary,
  parseEventReceipt,
  parseProviderEvidence,
  type ActiveConfigurationSummarySchema,
  type ProviderEvidence,
} from "./schemas.js";
import type { Static } from "@sinclair/typebox";

type ConfigurationRow = {
  config_fingerprint: unknown;
  config_version: unknown;
  document_sha256: unknown;
  document: unknown;
  registered_at: unknown;
};

type ActiveRow = ConfigurationRow & {
  checkpoint_version: unknown;
  activated_at: unknown;
  provider: unknown;
  provider_reference: unknown;
  order_kind: unknown;
  order_value: unknown;
  activation_document: unknown;
};

export type ConfigurationRegistration = Readonly<{
  outcome: "inserted" | "existing";
  fingerprint: string;
  configVersion: string;
  documentSha256: `sha256:${string}`;
}>;

export type ConfigurationActivation = Readonly<{
  outcome: "activated" | "existing";
  fingerprint: string;
  checkpointVersion: string;
  affectedServiceIds: readonly string[];
}>;

export type EventDisposition =
  | "scheduled" | "ignored_unconfigured_branch" | "ignored_stale"
  | "reconciliation_required" | "deferred_handler" | "no_work";

const EVENT_DISPOSITIONS = Object.freeze([
  "scheduled", "ignored_unconfigured_branch", "ignored_stale",
  "reconciliation_required", "deferred_handler", "no_work",
] as const satisfies readonly EventDisposition[]);
const EVENT_DISPOSITION_SET = new Set<string>(EVENT_DISPOSITIONS);

export type EventReceipt = Readonly<{
  outcome: "accepted" | "duplicate";
  disposition: EventDisposition | "mixed";
  dispositionCounts: Readonly<Partial<Record<EventDisposition, number>>>;
}>;

export type TrustedConfiguration = Readonly<{
  fingerprint: string;
  configVersion: string;
  documentSha256: `sha256:${string}`;
  checkpointVersion: string;
  document: InstallationConfig;
}>;

export type OrchestrationRepository = Readonly<{
  registerConfiguration(context: unknown, input: unknown): Promise<ConfigurationRegistration>;
  activateInitialConfiguration(context: unknown, input: unknown): Promise<ConfigurationActivation>;
  activateConfigurationByCas(context: unknown, input: unknown): Promise<ConfigurationActivation>;
  getActiveConfigurationSummary(context: unknown): Promise<Static<typeof ActiveConfigurationSummarySchema>>;
  getTrustedActiveConfiguration(tenantId: unknown): Promise<TrustedConfiguration>;
  ingestEvent(context: unknown, event: unknown): Promise<EventReceipt>;
}>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const safeObject = (input: unknown, keys: readonly string[]): Record<string, unknown> => {
  let detached: unknown;
  try { detached = JSON.parse(canonicalOrchestrationJson(input)); } catch { throw new OrchestrationError("INVALID_ORCHESTRATION_INPUT"); }
  if (!isRecord(detached) || Object.keys(detached).some((key) => !keys.includes(key))) {
    throw new OrchestrationError("INVALID_ORCHESTRATION_INPUT");
  }
  return detached;
};

const requiredString = (object: Record<string, unknown>, key: string): string => {
  const value = object[key];
  if (typeof value !== "string" || value.length === 0) throw new OrchestrationError("INVALID_ORCHESTRATION_INPUT");
  return value;
};

const configurationDocument = (input: unknown): InstallationConfig => {
  const parsed = parseConfig(input);
  if (!parsed.ok) throw orchestrationValidationError(parsed.error);
  return detachedFrozen(parsed.value);
};

const configDigest = (document: InstallationConfig): `sha256:${string}` => canonicalOrchestrationHash(document);

const storedPositiveDecimal = (value: unknown): string => {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) {
    throw new OrchestrationError("ORCHESTRATION_STORAGE_ERROR", { retryable: false });
  }
  return value;
};

const configurationFromRow = (row: ConfigurationRow | undefined): TrustedConfiguration["document"] => {
  if (row === undefined) throw new OrchestrationError("CONFIGURATION_NOT_FOUND");
  try {
    const parsed = parseConfig(JSON.parse(canonicalOrchestrationJson(row.document)) as unknown);
    if (!parsed.ok) throw new Error("invalid stored configuration");
    const document = detachedFrozen(parsed.value);
    if (typeof row.document_sha256 !== "string" || !/^sha256:[0-9a-f]{64}$/.test(row.document_sha256)
      || configDigest(document) !== row.document_sha256
      || typeof row.config_version !== "string" || document.config_version !== row.config_version
      || typeof row.config_fingerprint !== "string" || row.config_fingerprint.length === 0) {
      throw new Error("invalid stored configuration metadata");
    }
    return document;
  } catch {
    throw new OrchestrationError("ORCHESTRATION_STORAGE_ERROR", { retryable: false });
  }
};

const readConfiguration = async (client: PoolClient, tenantId: string, fingerprint: string): Promise<ConfigurationRow> => {
  const selected = await client.query<ConfigurationRow>(
    `SELECT config_fingerprint, config_version, document_sha256, document, registered_at
     FROM orchestration_configurations WHERE tenant_id = $1 AND config_fingerprint = $2`,
    [tenantId, fingerprint],
  );
  if (selected.rows[0] === undefined) throw new OrchestrationError("CONFIGURATION_NOT_FOUND");
  configurationFromRow(selected.rows[0]);
  return selected.rows[0];
};

const readActive = async (client: PoolClient, tenantId: string, forUpdate = false): Promise<ActiveRow> => {
  const selected = await client.query<ActiveRow>(
    `SELECT configuration.config_fingerprint, configuration.config_version, configuration.document_sha256,
            configuration.document, configuration.registered_at, active.checkpoint_version::text,
            active.activated_at::text, active.provider, active.provider_reference, active.order_kind, active.order_value,
            activation_event.document AS activation_document
     FROM orchestration_active_configurations active
     JOIN orchestration_configurations configuration
       ON configuration.tenant_id = active.tenant_id AND configuration.config_fingerprint = active.config_fingerprint
     LEFT JOIN orchestration_events activation_event
       ON activation_event.tenant_id = active.tenant_id
      AND activation_event.producer_id = active.activation_producer_id
      AND activation_event.event_id = active.activation_event_id
     WHERE active.tenant_id = $1${forUpdate ? " FOR UPDATE OF active" : ""}`,
    [tenantId],
  );
  if (selected.rows[0] === undefined) throw new OrchestrationError("CONFIGURATION_NOT_FOUND");
  configurationFromRow(selected.rows[0]);
  return selected.rows[0];
};

const activeSummary = (row: ActiveRow): Static<typeof ActiveConfigurationSummarySchema> => {
  storedPositiveDecimal(row.checkpoint_version);
  const parsed = parseActiveConfigurationSummary({
    fingerprint: row.config_fingerprint,
    configVersion: row.config_version,
    checkpointVersion: row.checkpoint_version,
    activatedAt: row.activated_at,
  });
  if (!parsed.ok) throw new OrchestrationError("ORCHESTRATION_STORAGE_ERROR", { retryable: false });
  return parsed.value;
};

const activationInput = (input: unknown, cas: boolean): {
  fingerprint: string;
  expectedCheckpointVersion?: string;
  providerEvidence?: { provider: string; provider_reference: string; order?: { kind: "sequence" | "cursor" | "effective_version"; value: string } };
} => {
  const candidate = safeObject(input, cas ? ["fingerprint", "expectedCheckpointVersion", "providerEvidence"] : ["fingerprint"]);
  const fingerprint = requiredString(candidate, "fingerprint");
  if (!cas) {
    if (Object.keys(candidate).length !== 1) throw new OrchestrationError("INVALID_ORCHESTRATION_INPUT");
    return { fingerprint };
  }
  const expectedCheckpointVersion = requiredString(candidate, "expectedCheckpointVersion");
  if (!/^[1-9][0-9]*$/.test(expectedCheckpointVersion)) throw new OrchestrationError("INVALID_ORCHESTRATION_INPUT");
  const parsedEvidence = parseProviderEvidence(candidate.providerEvidence);
  if (!parsedEvidence.ok) throw new OrchestrationError("INVALID_ORCHESTRATION_INPUT");
  return { fingerprint, expectedCheckpointVersion, providerEvidence: parsedEvidence.value };
};

const allTargets = (document: InstallationConfig): Array<{ repositoryId: string; serviceId: string }> =>
  document.repositories.flatMap((repository) => repository.services.map((service) => ({
    repositoryId: repository.repository_id, serviceId: service.service_id,
  }))).sort((left, right) => Buffer.compare(
    Buffer.from(`${left.repositoryId}\u0000${left.serviceId}`), Buffer.from(`${right.repositoryId}\u0000${right.serviceId}`),
  ));

const targetForService = (document: InstallationConfig, serviceId: string): { repositoryId: string; serviceId: string } => {
  for (const repository of document.repositories) {
    if (repository.services.some((service) => service.service_id === serviceId)) return { repositoryId: repository.repository_id, serviceId };
  }
  throw new OrchestrationError("EVENT_SUBJECT_MISMATCH");
};

const insertOutbox = async (
  client: PoolClient,
  tenantId: string,
  identity: unknown,
  messageKind: string,
  payload: Record<string, string>,
  eventProducerId?: string,
  eventId?: string,
): Promise<void> => {
  const dedupeKey = canonicalOrchestrationHash(identity);
  const outboxId = semanticOrchestrationId("outbox", identity);
  await client.query(
    `INSERT INTO orchestration_outbox
       (tenant_id, outbox_id, dedupe_key, message_kind, event_producer_id, event_id, payload, state, max_attempts)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', 8)
     ON CONFLICT (tenant_id, dedupe_key) DO NOTHING`,
    [tenantId, outboxId, dedupeKey, messageKind, eventProducerId ?? null, eventId ?? null, payload],
  );
};

const activate = async (
  client: PoolClient,
  tenantId: string,
  candidate: ConfigurationRow,
  current: ActiveRow,
  evidence: ProviderEvidence,
): Promise<ConfigurationActivation> => {
  activeSummary(current);
  const activeDocument = configurationFromRow(current);
  const candidateDocument = configurationFromRow(candidate);
  const affectedServiceIds = calculateConfigurationImpact(
    { fingerprint: current.config_fingerprint, document: activeDocument },
    { fingerprint: candidate.config_fingerprint, document: candidateDocument },
  );
  if (candidate.config_fingerprint === current.config_fingerprint) {
    return detachedFrozen({
      outcome: "existing",
      fingerprint: String(candidate.config_fingerprint),
      checkpointVersion: String(current.checkpoint_version),
      affectedServiceIds,
    });
  }
  const updated = await client.query<{ checkpoint_version: string }>(
    `UPDATE orchestration_active_configurations
     SET config_fingerprint = $2, checkpoint_version = checkpoint_version + 1,
         provider = $3, provider_reference = $4, order_kind = $5, order_value = $6,
         activation_producer_id = NULL, activation_event_id = NULL, activated_at = clock_timestamp()
     WHERE tenant_id = $1 RETURNING checkpoint_version::text`,
    [tenantId, candidate.config_fingerprint, evidence.provider, evidence.provider_reference,
      evidence.order?.kind ?? null, evidence.order?.value ?? null],
  );
  for (const serviceId of affectedServiceIds) {
    const target = targetForService(candidateDocument.repositories.some((repository) =>
      repository.services.some((service) => service.service_id === serviceId)) ? candidateDocument : activeDocument, serviceId);
    await insertOutbox(client, tenantId,
      { kind: "configuration.activated", fingerprint: candidate.config_fingerprint, repositoryId: target.repositoryId, serviceId },
      "configuration.activated", { fingerprint: String(candidate.config_fingerprint), serviceId });
  }
  return detachedFrozen({
    outcome: candidate.config_fingerprint === current.config_fingerprint ? "existing" : "activated",
    fingerprint: String(candidate.config_fingerprint),
    checkpointVersion: storedPositiveDecimal(updated.rows[0]?.checkpoint_version),
    affectedServiceIds,
  });
};

type TargetOutcome = { repositoryId: string; serviceId: string; scopeKey: string; disposition: EventDisposition; safeReason?: string };

const outcomesForEvent = (event: EventEnvelope, document: InstallationConfig): TargetOutcome[] => {
  const targets = canonicalStringSet(event.subjects.service_ids).map((serviceId) => targetForService(document, serviceId));
  return targets.flatMap((target): TargetOutcome[] => {
    const repository = document.repositories.find((entry) => entry.repository_id === target.repositoryId)!;
    const service = repository.services.find((entry) => entry.service_id === target.serviceId)!;
    if (event.event_type === "deployment.changed" || event.event_type === "source_document.changed") {
      return [{ ...target, scopeKey: "deferred", disposition: "deferred_handler" }];
    }
    if (event.event_type === "branch.updated") {
      const branch = (event.payload as { branch: string }).branch;
      return [{ ...target, scopeKey: `branch:${branch}`, disposition: isConfiguredBranch(service, branch)
        ? "scheduled" : "ignored_unconfigured_branch" }];
    }
    if (event.event_type === "pull_request.updated") {
      const payload = event.payload as { base_branch: string; head_branch: string; state: string };
      const selected = selectPullRequestScope(service, payload.base_branch, payload.head_branch);
      const terminal = payload.state === "closed" || payload.state === "merged";
      return [{ ...target, scopeKey: `pr:${(event.payload as { pull_request_id: string }).pull_request_id}`,
        disposition: selected === undefined ? "ignored_unconfigured_branch" : terminal ? "no_work" : "scheduled" }];
    }
    if (event.event_type === "reconciliation.requested") {
      const environments = (event.payload as { scope: { environments: string[] } }).scope.environments;
      const branches = selectReconciliationBranches(service, environments);
      return branches.length === 0
        ? [{ ...target, scopeKey: "reconciliation", disposition: "ignored_unconfigured_branch" }]
        : branches.map((branch) => ({ ...target, scopeKey: `reconciliation:${branch}`, disposition: "scheduled" }));
    }
    return [{ ...target, scopeKey: event.event_type === "repository.baseline_requested" ? "baseline" : "configuration",
      disposition: "scheduled" }];
  }).sort((left, right) => Buffer.compare(
    Buffer.from(`${left.repositoryId}\u0000${left.serviceId}\u0000${left.scopeKey}`),
    Buffer.from(`${right.repositoryId}\u0000${right.serviceId}\u0000${right.scopeKey}`),
  ));
};

const receiptFor = (outcome: "accepted" | "duplicate", dispositions: readonly unknown[]): EventReceipt => {
  const counts = new Map<EventDisposition, number>();
  for (const disposition of dispositions) {
    if (typeof disposition !== "string" || !EVENT_DISPOSITION_SET.has(disposition)) {
      throw new OrchestrationError("ORCHESTRATION_STORAGE_ERROR", { retryable: false });
    }
    const validDisposition = disposition as EventDisposition;
    counts.set(validDisposition, (counts.get(validDisposition) ?? 0) + 1);
  }
  const dispositionCounts: Partial<Record<EventDisposition, number>> = {};
  for (const disposition of EVENT_DISPOSITIONS) {
    const count = counts.get(disposition);
    if (count !== undefined) dispositionCounts[disposition] = count;
  }
  const distinct = EVENT_DISPOSITIONS.filter((disposition) => counts.has(disposition));
  const parsed = parseEventReceipt({
    outcome,
    disposition: distinct.length === 1 ? distinct[0]! : "mixed",
    dispositionCounts,
  });
  if (!parsed.ok) throw new OrchestrationError("ORCHESTRATION_STORAGE_ERROR", { retryable: false });
  return parsed.value;
};

export const createOrchestrationRepository = (pool: Pool, options: { schema: string }): OrchestrationRepository => ({
  async registerConfiguration(contextInput, input) {
    const context = requireControlCapability(contextInput, "configuration.admin");
    const candidate = safeObject(input, ["fingerprint", "document"]);
    if (Object.keys(candidate).length !== 2) throw new OrchestrationError("INVALID_ORCHESTRATION_INPUT");
    const fingerprint = requiredString(candidate, "fingerprint");
    const document = configurationDocument(candidate.document);
    const digest = configDigest(document);
    return withOrchestrationTransaction(pool, options, async (client) => {
      const inserted = await client.query(
        `INSERT INTO orchestration_configurations
           (tenant_id, config_fingerprint, config_version, document_sha256, document, registrar_principal_id)
         VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
        [context.tenantId, fingerprint, document.config_version, digest, document, context.principalId],
      );
      const stored = await readConfiguration(client, context.tenantId, fingerprint);
      if (stored.document_sha256 !== digest) throw new OrchestrationError("CONFIGURATION_CONFLICT");
      return detachedFrozen({ outcome: inserted.rowCount === 1 ? "inserted" : "existing", fingerprint,
        configVersion: document.config_version, documentSha256: digest });
    });
  },

  async activateInitialConfiguration(contextInput, input) {
    const context = requireControlCapability(contextInput, "configuration.admin");
    const activation = activationInput(input, false);
    return withOrchestrationTransaction(pool, options, async (client) => {
      const candidate = await readConfiguration(client, context.tenantId, activation.fingerprint);
      const inserted = await client.query<{ checkpoint_version: string }>(
        `INSERT INTO orchestration_active_configurations (tenant_id, config_fingerprint, checkpoint_version)
         VALUES ($1, $2, 1) ON CONFLICT DO NOTHING RETURNING checkpoint_version::text`,
        [context.tenantId, activation.fingerprint],
      );
      if (inserted.rows[0] === undefined) throw new OrchestrationError("CONFIGURATION_CONFLICT");
      return detachedFrozen({ outcome: "activated", fingerprint: activation.fingerprint,
        checkpointVersion: storedPositiveDecimal(inserted.rows[0].checkpoint_version),
        affectedServiceIds: canonicalStringSet(allTargets(configurationFromRow(candidate)).map((target) => target.serviceId)) });
    });
  },

  async activateConfigurationByCas(contextInput, input) {
    const context = requireControlCapability(contextInput, "configuration.admin");
    const activation = activationInput(input, true);
    return withOrchestrationTransaction(pool, options, async (client) => {
      const current = await readActive(client, context.tenantId, true);
      if (current.checkpoint_version !== activation.expectedCheckpointVersion) throw new OrchestrationError("CONFIGURATION_CONFLICT");
      const candidate = await readConfiguration(client, context.tenantId, activation.fingerprint);
      return activate(client, context.tenantId, candidate, current, activation.providerEvidence!);
    });
  },

  async getActiveConfigurationSummary(contextInput) {
    const context = requireControlCapability(contextInput, "orchestration.status.read");
    return withOrchestrationTransaction(pool, options, async (client) => activeSummary(await readActive(client, context.tenantId)));
  },

  async getTrustedActiveConfiguration(tenantIdInput) {
    if (typeof tenantIdInput !== "string" || tenantIdInput.length === 0) throw new OrchestrationError("INVALID_ORCHESTRATION_INPUT");
    return withOrchestrationTransaction(pool, options, async (client) => {
      const row = await readActive(client, tenantIdInput);
      const summary = activeSummary(row);
      return detachedFrozen({ fingerprint: String(row.config_fingerprint), configVersion: String(row.config_version),
        documentSha256: row.document_sha256 as `sha256:${string}`, checkpointVersion: summary.checkpointVersion,
        document: configurationFromRow(row) });
    });
  },

  async ingestEvent(contextInput, eventInput) {
    const parsedContext = parseAuthenticatedEventContext(contextInput);
    if (!parsedContext.ok || !parsedContext.value.capabilities.includes("event.ingest")) {
      throw new OrchestrationError("EVENT_UNAUTHORIZED");
    }
    const context = parsedContext.value;
    const detachedEvent = (() => {
      let value: unknown;
      try { value = JSON.parse(canonicalOrchestrationJson(eventInput)); } catch { throw new OrchestrationError("INVALID_ORCHESTRATION_INPUT"); }
      const parsed = parseEvent(value);
      if (!parsed.ok) throw orchestrationValidationError(parsed.error);
      return parsed.value;
    })();
    if (detachedEvent.event_type === "configuration.changed"
      && !context.capabilities.includes("configuration.admin")) {
      throw new OrchestrationError("EVENT_UNAUTHORIZED");
    }
    if (context.producerId !== detachedEvent.producer.producer_id
      || !context.allowedEventTypes.includes(detachedEvent.event_type as never)
      || detachedEvent.subjects.repository_id !== undefined
        && !context.allowedRepositories.includes(detachedEvent.subjects.repository_id)
      || detachedEvent.subjects.service_ids.some((serviceId) => !context.allowedServices.includes(serviceId))) {
      throw new OrchestrationError("EVENT_UNAUTHORIZED");
    }
    return withOrchestrationTransaction(pool, options, async (client) => {
      await client.query("SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))", [
        canonicalOrchestrationJson({ tenantId: context.tenantId, producerId: context.producerId, eventId: detachedEvent.event_id }),
      ]);
      const existing = await client.query<{ event_sha256: unknown; active_config_fingerprint: unknown }>(
        `SELECT event_sha256, active_config_fingerprint
         FROM orchestration_events WHERE tenant_id = $1 AND producer_id = $2 AND event_id = $3`,
        [context.tenantId, detachedEvent.producer.producer_id, detachedEvent.event_id],
      );
      if (existing.rows[0] !== undefined) {
        const stored = existing.rows[0];
        const hash = eventSha256(detachedEvent);
        if (typeof stored.event_sha256 !== "string" || stored.event_sha256 !== hash) {
          throw new OrchestrationError("EVENT_ID_CONFLICT");
        }
        if (typeof stored.active_config_fingerprint !== "string" || stored.active_config_fingerprint.length === 0) {
          throw new OrchestrationError("ORCHESTRATION_STORAGE_ERROR", { retryable: false });
        }
        const historical = await readConfiguration(client, context.tenantId, stored.active_config_fingerprint);
        const historicalDocument = configurationFromRow(historical);
        let replayCandidate: ConfigurationRow | undefined;
        if (detachedEvent.event_type === "configuration.changed") {
          replayCandidate = await readConfiguration(client, context.tenantId,
            (detachedEvent.payload as { config_fingerprint: string }).config_fingerprint);
        }
        authorizeNormalizedEvent(context, detachedEvent, historicalDocument,
          replayCandidate === undefined ? {} : {
            activeConfiguration: { fingerprint: historical.config_fingerprint, document: historicalDocument },
            candidateConfiguration: {
              fingerprint: replayCandidate.config_fingerprint,
              document: configurationFromRow(replayCandidate),
            },
          });
        await client.query(
          `INSERT INTO orchestration_event_deliveries
             (tenant_id, producer_id, event_id, declared_received_at) VALUES ($1,$2,$3,$4)`,
          [context.tenantId, detachedEvent.producer.producer_id, detachedEvent.event_id, detachedEvent.received_at],
        );
        const targetRows = await client.query<{ disposition: EventDisposition }>(
          `SELECT disposition FROM orchestration_event_targets
           WHERE tenant_id = $1 AND producer_id = $2 AND event_id = $3
           ORDER BY repository_id COLLATE "C", service_id COLLATE "C", scope_key COLLATE "C"`,
          [context.tenantId, detachedEvent.producer.producer_id, detachedEvent.event_id],
        );
        return receiptFor("duplicate", targetRows.rows.map((row) => row.disposition));
      }

      const active = await readActive(client, context.tenantId, true);
      const activeDocument = configurationFromRow(active);
      let candidate: ConfigurationRow | undefined;
      if (detachedEvent.event_type === "configuration.changed") {
        candidate = await readConfiguration(client, context.tenantId,
          (detachedEvent.payload as { config_fingerprint: string }).config_fingerprint);
      }
      const authorized = authorizeNormalizedEvent(context, detachedEvent, activeDocument,
        candidate === undefined ? {} : {
          activeConfiguration: { fingerprint: active.config_fingerprint, document: activeDocument },
          candidateConfiguration: { fingerprint: candidate.config_fingerprint, document: configurationFromRow(candidate) },
        });
      const hash = eventSha256(authorized.event);
      const inserted = await client.query(
        `INSERT INTO orchestration_events
           (tenant_id, producer_id, event_id, event_sha256, event_type, repository_id, service_ids, document,
            adapter_version, provider, provider_reference, order_kind, order_value, active_config_fingerprint)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT DO NOTHING`,
        [context.tenantId, authorized.event.producer.producer_id, authorized.event.event_id, hash, authorized.event.event_type,
          authorized.event.subjects.repository_id ?? null, canonicalStringSet(authorized.event.subjects.service_ids), authorized.event,
          authorized.event.producer.adapter_version, authorized.event.provider_evidence.provider,
          authorized.event.provider_evidence.provider_reference, authorized.event.provider_evidence.order?.kind ?? null,
          authorized.event.provider_evidence.order?.value ?? null, active.config_fingerprint],
      );
      const stored = await client.query<{ event_sha256: string }>(
        `SELECT event_sha256 FROM orchestration_events
         WHERE tenant_id = $1 AND producer_id = $2 AND event_id = $3`,
        [context.tenantId, authorized.event.producer.producer_id, authorized.event.event_id],
      );
      if (stored.rows[0]?.event_sha256 !== hash) throw new OrchestrationError("EVENT_ID_CONFLICT");
      await client.query(
        `INSERT INTO orchestration_event_deliveries
           (tenant_id, producer_id, event_id, declared_received_at) VALUES ($1,$2,$3,$4)`,
        [context.tenantId, authorized.event.producer.producer_id, authorized.event.event_id, authorized.event.received_at],
      );
      if (inserted.rowCount !== 1) throw new OrchestrationError("ORCHESTRATION_STORAGE_ERROR", { retryable: false });

      let outcomes: TargetOutcome[] = authorized.event.event_type === "configuration.changed"
        ? authorized.targets.map((target) => ({ ...target, scopeKey: "configuration", disposition: "scheduled" as const }))
        : outcomesForEvent(authorized.event, activeDocument);
      if (authorized.event.event_type === "configuration.changed") {
        const nextCheckpoint = { evidence: authorized.event.provider_evidence, relevantPayload: authorized.event.payload };
        const currentPayload = isRecord(active.activation_document) && Object.hasOwn(active.activation_document, "payload")
          ? active.activation_document.payload
          : { config_fingerprint: active.config_fingerprint, config_version: active.config_version };
        const currentCheckpoint = typeof active.provider === "string" && typeof active.provider_reference === "string"
          ? { evidence: { provider: active.provider, provider_reference: active.provider_reference,
            ...(typeof active.order_kind === "string" && typeof active.order_value === "string"
              ? { order: { kind: active.order_kind as "sequence" | "cursor" | "effective_version", value: active.order_value } } : {}) },
            relevantPayload: currentPayload }
          : undefined;
        const classification = classifyProviderUpdate(currentCheckpoint, nextCheckpoint);
        if (classification === "conflict") throw new OrchestrationError("EVENT_ORDER_CONFLICT");
        const disposition: EventDisposition = classification === "stale" ? "ignored_stale"
          : classification === "incomparable" ? "reconciliation_required"
          : classification === "exact_replay" ? "no_work" : "scheduled";
        outcomes = outcomes.map((outcome) => ({ ...outcome, disposition }));
        if (disposition === "scheduled") {
          const affectedServiceIds = calculateConfigurationImpact(
            { fingerprint: active.config_fingerprint, document: activeDocument },
            { fingerprint: candidate!.config_fingerprint, document: configurationFromRow(candidate) },
          );
          await client.query(
            `UPDATE orchestration_active_configurations
             SET config_fingerprint = $2, checkpoint_version = checkpoint_version + 1,
                 provider = $3, provider_reference = $4, order_kind = $5, order_value = $6,
                 activation_producer_id = $7, activation_event_id = $8, activated_at = clock_timestamp()
             WHERE tenant_id = $1`,
            [context.tenantId, candidate!.config_fingerprint, authorized.event.provider_evidence.provider,
              authorized.event.provider_evidence.provider_reference, authorized.event.provider_evidence.order?.kind ?? null,
              authorized.event.provider_evidence.order?.value ?? null, authorized.event.producer.producer_id, authorized.event.event_id],
          );
          if (canonicalOrchestrationJson(affectedServiceIds) !== canonicalOrchestrationJson(authorized.event.subjects.service_ids)) {
            throw new OrchestrationError("EVENT_SUBJECT_MISMATCH");
          }
        }
      }
      for (const outcome of outcomes) {
        await client.query(
          `INSERT INTO orchestration_event_targets
             (tenant_id, producer_id, event_id, repository_id, service_id, scope_key, disposition, safe_reason)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [context.tenantId, authorized.event.producer.producer_id, authorized.event.event_id,
            outcome.repositoryId, outcome.serviceId, outcome.scopeKey, outcome.disposition, outcome.safeReason ?? null],
        );
        await insertOutbox(client, context.tenantId,
          { kind: "event.disposition", producerId: authorized.event.producer.producer_id,
            eventId: authorized.event.event_id, repositoryId: outcome.repositoryId,
            serviceId: outcome.serviceId, scopeKey: outcome.scopeKey, disposition: outcome.disposition },
          "event.disposition", { eventId: authorized.event.event_id, disposition: outcome.disposition },
          authorized.event.producer.producer_id, authorized.event.event_id);
      }
      return receiptFor("accepted", outcomes.map((outcome) => outcome.disposition));
    });
  },
});
