import { parseConfig, parseEvent, type EventEnvelope, type InstallationConfig } from "@api-truth/ir";
import { canonicalOrchestrationJson, canonicalStringSet, detachedFrozen } from "./canonical.js";
import { calculateConfigurationImpact } from "./configuration.js";
import { OrchestrationError, orchestrationValidationError } from "./errors.js";
import {
  parseAuthenticatedEventContext, parseControlContext, parseWorkerIdentity,
  type AuthenticatedEventContext, type ControlContext, type WorkerIdentity,
} from "./schemas.js";
import type { ControlCapability, WorkerCapability } from "./types.js";

type Target = Readonly<{ repositoryId: string; serviceId: string }>;
type AuthorizationOptions = {
  activeConfiguration?: { fingerprint: string; document: unknown };
  candidateConfiguration?: { fingerprint: string; document: unknown };
};

const authorizationOptions = (input: unknown): AuthorizationOptions => {
  let detached: unknown;
  try { detached = JSON.parse(canonicalOrchestrationJson(input)); } catch { throw new OrchestrationError("INVALID_ORCHESTRATION_INPUT"); }
  if (detached === null || typeof detached !== "object" || Array.isArray(detached)
    || Object.keys(detached).some((key) => key !== "activeConfiguration" && key !== "candidateConfiguration")) {
    throw new OrchestrationError("INVALID_ORCHESTRATION_INPUT");
  }
  for (const pair of Object.values(detached)) {
    if (pair === null || typeof pair !== "object" || Array.isArray(pair)
      || Object.keys(pair).length !== 2 || !Object.hasOwn(pair, "fingerprint") || !Object.hasOwn(pair, "document")
      || typeof (pair as Record<string, unknown>).fingerprint !== "string"
      || ((pair as Record<string, unknown>).fingerprint as string).length === 0) {
      throw new OrchestrationError("INVALID_ORCHESTRATION_INPUT");
    }
  }
  return detached as AuthorizationOptions;
};

const equalSets = (left: readonly string[], right: readonly string[]): boolean =>
  canonicalOrchestrationJson(canonicalStringSet(left)) === canonicalOrchestrationJson(canonicalStringSet(right));

const configuration = (value: unknown): InstallationConfig => {
  let detached: unknown;
  try { detached = JSON.parse(canonicalOrchestrationJson(value)); } catch { throw new OrchestrationError("INVALID_ORCHESTRATION_INPUT"); }
  const parsed = parseConfig(detached);
  if (!parsed.ok) throw orchestrationValidationError(parsed.error);
  return detachedFrozen(parsed.value);
};

const normalizedEvent = (value: unknown): EventEnvelope => {
  let detached: unknown;
  try { detached = JSON.parse(canonicalOrchestrationJson(value)); } catch { throw new OrchestrationError("INVALID_ORCHESTRATION_INPUT"); }
  const parsed = parseEvent(detached);
  if (!parsed.ok) throw orchestrationValidationError(parsed.error);
  return detachedFrozen(parsed.value);
};

const resolveTargets = (
  event: EventEnvelope,
  document: InstallationConfig,
  candidateDocument?: InstallationConfig,
): Target[] => {
  const ownership = new Map<string, Target>();
  for (const source of candidateDocument === undefined ? [document] : [document, candidateDocument]) {
    for (const repository of source.repositories) {
      for (const service of repository.services) {
        const target = { repositoryId: repository.repository_id, serviceId: service.service_id };
        const prior = ownership.get(service.service_id);
        if (prior !== undefined && prior.repositoryId !== target.repositoryId) throw new OrchestrationError("EVENT_SUBJECT_MISMATCH");
        ownership.set(service.service_id, target);
      }
    }
  }
  if (["repository.baseline_requested", "branch.updated", "pull_request.updated"].includes(event.event_type)
    && event.subjects.repository_id === undefined) throw new OrchestrationError("EVENT_SUBJECT_MISMATCH");
  return canonicalStringSet(event.subjects.service_ids).map((serviceId) => {
    const target = ownership.get(serviceId);
    if (target === undefined || event.subjects.repository_id !== undefined && target.repositoryId !== event.subjects.repository_id) {
      throw new OrchestrationError("EVENT_SUBJECT_MISMATCH");
    }
    return Object.freeze(target);
  });
};

const authorizeDeployment = (
  context: AuthenticatedEventContext,
  event: EventEnvelope,
  document: InstallationConfig,
  targets: Target[],
): void => {
  const payload = event.payload as {
    change_kind: "attempt" | "serving_observation";
    environment: string;
    source?: { authority_id: string };
  };
  if (targets.length !== 1 || event.subjects.environment !== undefined && event.subjects.environment !== payload.environment) {
    throw new OrchestrationError("EVENT_SUBJECT_MISMATCH");
  }
  const target = targets[0]!;
  const repository = document.repositories.find((entry) => entry.repository_id === target.repositoryId)!;
  const service = repository.services.find((entry) => entry.service_id === target.serviceId)!;
  const environment = service.environments.find((entry) => entry.name === payload.environment);
  if (environment === undefined) throw new OrchestrationError("EVENT_SUBJECT_MISMATCH");
  const adapterId = environment.deployment_authority.adapter_id;
  const grant = context.deploymentAuthorityGrants.find((entry) =>
    entry.repositoryId === target.repositoryId && entry.serviceId === target.serviceId
    && entry.environment === environment.name && entry.adapterId === adapterId);
  if (context.producerId !== adapterId || grant === undefined) throw new OrchestrationError("EVENT_UNAUTHORIZED");
  if (payload.change_kind === "serving_observation"
    && (payload.source === undefined || !grant.sourceAuthorityIds.includes(payload.source.authority_id))) throw new OrchestrationError("EVENT_UNAUTHORIZED");
};

export const authorizeNormalizedEvent = (
  contextInput: unknown,
  eventInput: unknown,
  activeConfigurationInput: unknown,
  optionsInput: unknown = {},
): Readonly<{ context: AuthenticatedEventContext; event: EventEnvelope; targets: readonly Target[] }> => {
  const parsedContext = parseAuthenticatedEventContext(contextInput);
  if (!parsedContext.ok || !parsedContext.value.capabilities.includes("event.ingest")) throw new OrchestrationError("EVENT_UNAUTHORIZED");
  const context = parsedContext.value;

  // This is intentionally the first operation that observes eventInput.
  const event = normalizedEvent(eventInput);
  if (event.event_type === "configuration.changed" && !context.capabilities.includes("configuration.admin")) {
    throw new OrchestrationError("EVENT_UNAUTHORIZED");
  }
  if (context.producerId !== event.producer.producer_id || !context.allowedEventTypes.includes(event.event_type as never)) {
    throw new OrchestrationError("EVENT_UNAUTHORIZED");
  }
  const options = authorizationOptions(optionsInput);

  const document = configuration(activeConfigurationInput);
  if (options.activeConfiguration !== undefined
    && canonicalOrchestrationJson(document) !== canonicalOrchestrationJson(configuration(options.activeConfiguration.document))) {
    throw new OrchestrationError("EVENT_SUBJECT_MISMATCH");
  }
  const candidateDocument = event.event_type === "configuration.changed" && options.candidateConfiguration !== undefined
    ? configuration(options.candidateConfiguration.document) : undefined;
  const targets = resolveTargets(event, document, candidateDocument);
  if (targets.some((target) => !context.allowedRepositories.includes(target.repositoryId)
    || !context.allowedServices.includes(target.serviceId))) throw new OrchestrationError("EVENT_UNAUTHORIZED");

  if (event.event_type === "repository.baseline_requested"
    && !equalSets(event.subjects.service_ids, (event.payload as { service_ids: string[] }).service_ids)) {
    throw new OrchestrationError("EVENT_SUBJECT_MISMATCH");
  }
  if (event.event_type === "reconciliation.requested") {
    const payload = event.payload as { scope: { service_ids: string[]; environments: string[] } };
    if (!equalSets(event.subjects.service_ids, payload.scope.service_ids)
      || event.subjects.environment !== undefined && !equalSets(payload.scope.environments, [event.subjects.environment])) {
      throw new OrchestrationError("EVENT_SUBJECT_MISMATCH");
    }
    for (const target of targets) {
      const repository = document.repositories.find((entry) => entry.repository_id === target.repositoryId)!;
      const service = repository.services.find((entry) => entry.service_id === target.serviceId)!;
      if (payload.scope.environments.some((name) => !service.environments.some((entry) => entry.name === name))) {
        throw new OrchestrationError("EVENT_SUBJECT_MISMATCH");
      }
    }
  }
  if (event.event_type === "configuration.changed") {
    const payload = event.payload as { affected_service_ids: string[]; config_version: string; config_fingerprint: string };
    if (!equalSets(event.subjects.service_ids, payload.affected_service_ids)) throw new OrchestrationError("EVENT_SUBJECT_MISMATCH");
    if (options.activeConfiguration !== undefined && options.candidateConfiguration !== undefined) {
      const impact = calculateConfigurationImpact(options.activeConfiguration, options.candidateConfiguration);
      if (!equalSets(impact, event.subjects.service_ids)
        || payload.config_version !== candidateDocument?.config_version
        || payload.config_fingerprint !== options.candidateConfiguration.fingerprint) {
        throw new OrchestrationError("EVENT_SUBJECT_MISMATCH");
      }
    }
  }
  if (event.event_type === "deployment.changed") authorizeDeployment(context, event, document, targets);
  return Object.freeze({ context, event, targets: Object.freeze(targets) });
};

export const requireControlCapability = (input: unknown, capability: ControlCapability): ControlContext => {
  const parsed = parseControlContext(input);
  if (!parsed.ok || !parsed.value.capabilities.includes(capability)) {
    throw new OrchestrationError(capability === "configuration.admin" ? "CONFIGURATION_UNAUTHORIZED" : "JOB_NOT_FOUND_OR_DENIED");
  }
  return parsed.value;
};

export const requireWorkerCapability = (input: unknown, capability: WorkerCapability): WorkerIdentity => {
  const parsed = parseWorkerIdentity(input);
  if (!parsed.ok || !parsed.value.capabilities.includes(capability)) throw new OrchestrationError("WORKER_UNAUTHORIZED");
  return parsed.value;
};
