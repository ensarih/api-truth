import { types as utilTypes } from "node:util";
import { parseConfig, parseEvent, type EventEnvelope, type InstallationConfig } from "../../../packages/ir/src/index.js";
import { authorizeNormalizedEvent, classifyProviderUpdate, parseAuthenticatedEventContext } from "../../../packages/orchestration/src/index.js";

export class ReferenceAdapterError extends Error {
  readonly code: "INVALID_INPUT" | "UNAUTHORIZED" | "UNCONFIGURED_BRANCH" | "UNKNOWN_ARTIFACT" | "STALE_OR_DUPLICATE";
  constructor(code: ReferenceAdapterError["code"]) {
    super(code);
    this.code = code;
    this.name = "ReferenceAdapterError";
  }
}

type Policy = Readonly<{ configuration: unknown; context: unknown; knownArtifacts: unknown; previousEvent?: unknown }>;
const MAX_BYTES = 64 * 1024;
const MAX_ITEMS = 64;
const MAX_TEXT = 512;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const keys = (value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void => {
  if (required.some((key) => !Object.hasOwn(value, key))
    || Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))) throw new ReferenceAdapterError("INVALID_INPUT");
};
const text = (value: unknown): string => {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_TEXT || /[\u0000-\u001f]/.test(value))
    throw new ReferenceAdapterError("INVALID_INPUT");
  return value;
};
const strings = (value: unknown): string[] => {
  if (!Array.isArray(value) || value.length > MAX_ITEMS) throw new ReferenceAdapterError("INVALID_INPUT");
  const result = value.map(text);
  if (new Set(result).size !== result.length) throw new ReferenceAdapterError("INVALID_INPUT");
  return result;
};
const detached = (value: unknown): unknown => {
  const seen = new WeakSet<object>();
  const visit = (item: unknown, depth: number): unknown => {
    if (depth > 16) throw new ReferenceAdapterError("INVALID_INPUT");
    if (item === null || typeof item === "boolean") return item;
    if (typeof item === "string") { if (item.length > MAX_BYTES) throw new ReferenceAdapterError("INVALID_INPUT"); return item; }
    if (typeof item === "number") { if (!Number.isFinite(item)) throw new ReferenceAdapterError("INVALID_INPUT"); return item; }
    if (typeof item !== "object" || utilTypes.isProxy(item) || seen.has(item))
      throw new ReferenceAdapterError("INVALID_INPUT");
    seen.add(item);
    const array = Array.isArray(item);
    if (!array && Object.getPrototypeOf(item) !== Object.prototype) throw new ReferenceAdapterError("INVALID_INPUT");
    const descriptors = Object.getOwnPropertyDescriptors(item);
    const ownKeys = Reflect.ownKeys(item);
    if (ownKeys.length > MAX_ITEMS + (array ? 1 : 0) || ownKeys.some((key) => typeof key !== "string"))
      throw new ReferenceAdapterError("INVALID_INPUT");
    if (array) {
      if (item.length > MAX_ITEMS || ownKeys.length !== item.length + 1) throw new ReferenceAdapterError("INVALID_INPUT");
      const output: unknown[] = [];
      for (let index = 0; index < item.length; index++) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !Object.hasOwn(descriptor, "value")) throw new ReferenceAdapterError("INVALID_INPUT");
        output.push(visit(descriptor.value, depth + 1));
      }
      return output;
    } else {
      const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      for (const key of ownKeys as string[]) {
        const descriptor = descriptors[key];
        if (!descriptor || !Object.hasOwn(descriptor, "value")) throw new ReferenceAdapterError("INVALID_INPUT");
        output[key] = visit(descriptor.value, depth + 1);
      }
      return output;
    }
  };
  const clean = visit(value, 0);
  let serialized: string;
  try { serialized = JSON.stringify(clean); } catch { throw new ReferenceAdapterError("INVALID_INPUT"); }
  if (Buffer.byteLength(serialized) > MAX_BYTES) throw new ReferenceAdapterError("INVALID_INPUT");
  return JSON.parse(serialized) as unknown;
};
const date = (value: unknown): string => {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || value.length > 40)
    throw new ReferenceAdapterError("INVALID_INPUT");
  return value;
};
const sequence = (value: unknown): string => {
  const result = text(value);
  if (!/^(0|[1-9][0-9]*)$/.test(result) || result.length > 40) throw new ReferenceAdapterError("INVALID_INPUT");
  return result;
};
const revision = (value: unknown): string => text(value);
const stringValue = (value: unknown, options: readonly string[]): string => {
  const result = text(value);
  if (!options.includes(result)) throw new ReferenceAdapterError("INVALID_INPUT");
  return result;
};
const artifactMap = (value: unknown): Map<string, string> => {
  if (!Array.isArray(value) || value.length > MAX_ITEMS) throw new ReferenceAdapterError("INVALID_INPUT");
  const mapped = new Map<string, string>();
  for (const item of value) {
    if (!record(item)) throw new ReferenceAdapterError("INVALID_INPUT");
    keys(item, ["artifact_id", "revision"]);
    const id = text(item.artifact_id);
    if (mapped.has(id)) throw new ReferenceAdapterError("INVALID_INPUT");
    mapped.set(id, revision(item.revision));
  }
  return mapped;
};
const known = (artifacts: Map<string, string>, artifactId: unknown, artifactRevision: unknown) => {
  const id = text(artifactId);
  const rev = revision(artifactRevision);
  if (artifacts.get(id) !== rev) throw new ReferenceAdapterError("UNKNOWN_ARTIFACT");
  return { artifact_id: id, revision: { state: "known" as const, revision: rev } };
};

const sameStream = (previous: EventEnvelope, next: EventEnvelope): boolean => {
  if (previous.event_type !== next.event_type) return false;
  const left = previous.payload as unknown as Record<string, unknown>;
  const right = next.payload as unknown as Record<string, unknown>;
  if (next.event_type === "branch.updated") return left.branch === right.branch;
  if (next.event_type === "pull_request.updated") return left.pull_request_id === right.pull_request_id
    && left.base_branch === right.base_branch && left.head_branch === right.head_branch;
  if (next.event_type === "deployment.changed") {
    if (left.change_kind !== right.change_kind) return false;
    if (left.change_kind === "attempt") return left.deployment_id === right.deployment_id;
    const leftSource = left.source as Record<string, unknown>;
    const rightSource = right.source as Record<string, unknown>;
    return leftSource.authority_id === rightSource.authority_id;
  }
  if (next.event_type === "reconciliation.requested") {
    const leftScope = left.scope as { service_ids: string[]; environments: string[] };
    const rightScope = right.scope as { service_ids: string[]; environments: string[] };
    return JSON.stringify([...leftScope.service_ids].sort()) === JSON.stringify([...rightScope.service_ids].sort())
      && JSON.stringify([...leftScope.environments].sort()) === JSON.stringify([...rightScope.environments].sort());
  }
  return true;
};

/** Normalizes one bounded local fact using host-supplied policy and artifact facts. This does not ingest an event. */
export const normalizeLocalFact = (factInput: unknown, policyInput: Policy): EventEnvelope => {
  const fact = detached(factInput);
  const policy = detached(policyInput);
  if (!record(fact) || !record(policy)) throw new ReferenceAdapterError("INVALID_INPUT");
  keys(policy, ["configuration", "context", "knownArtifacts"], ["previousEvent"]);
  const parsedConfig = parseConfig(policy.configuration);
  const parsedContext = parseAuthenticatedEventContext(policy.context);
  if (!parsedConfig.ok || !parsedContext.ok) throw new ReferenceAdapterError("INVALID_INPUT");
  const config: InstallationConfig = parsedConfig.value;
  const context = parsedContext.value;
  const artifacts = artifactMap(policy.knownArtifacts);
  const common = ["adapter_version", "event_id", "occurred_at", "received_at", "provider_reference", "sequence",
    "repository_id", "service_id", "kind"];
  const kind = stringValue(fact.kind, ["baseline", "branch", "pull_request", "deployment_attempt", "serving_observation", "reconciliation"]);
  const specific: Record<string, string[]> = {
    baseline: ["immutable_revision"],
    branch: ["branch", "prior_revision", "new_revision", "reference_state"],
    pull_request: ["pull_request_id", "state", "base_branch", "base_revision", "head_branch", "head_revision"],
    deployment_attempt: ["environment", "deployment_id", "attempt_state", "effective_order", "artifact_id", "revision"],
    serving_observation: ["environment", "observation_id", "effective_order", "authority_id", "reference", "access_label", "completeness", "inventory"],
    reconciliation: ["environments", "provider_snapshot_reference"],
  };
  keys(fact, [...common, ...specific[kind]!], kind === "deployment_attempt" ? ["target_revision"] : []);
  if (fact.adapter_version !== "1.0.0") throw new ReferenceAdapterError("INVALID_INPUT");
  const repositoryId = text(fact.repository_id);
  const serviceId = text(fact.service_id);
  const repository = config.repositories.find((item) => item.repository_id === repositoryId);
  const service = repository?.services.find((item) => item.service_id === serviceId);
  if (!repository || !service || !context.allowedRepositories.includes(repositoryId)
    || !context.allowedServices.includes(serviceId)) throw new ReferenceAdapterError("UNAUTHORIZED");
  let eventType: EventEnvelope["event_type"];
  let payload: unknown;
  let environment: string | undefined;
  if (kind === "baseline") {
    eventType = "repository.baseline_requested";
    payload = { immutable_revision: revision(fact.immutable_revision), service_ids: [serviceId] };
  } else if (kind === "branch") {
    const branch = text(fact.branch);
    if (!service.intended_branches.includes(branch)) throw new ReferenceAdapterError("UNCONFIGURED_BRANCH");
    const prior = fact.prior_revision === null ? null : revision(fact.prior_revision);
    eventType = "branch.updated";
    payload = { branch, prior_revision: prior, new_revision: revision(fact.new_revision),
      reference_state: stringValue(fact.reference_state, ["created", "fast_forward", "rewritten", "deleted"]) };
  } else if (kind === "pull_request") {
    const base = text(fact.base_branch);
    if (!service.intended_branches.includes(base)) throw new ReferenceAdapterError("UNCONFIGURED_BRANCH");
    eventType = "pull_request.updated";
    payload = { pull_request_id: text(fact.pull_request_id), state: stringValue(fact.state, ["open", "updated", "closed", "merged"]),
      base_branch: base, base_revision: revision(fact.base_revision), head_branch: text(fact.head_branch), head_revision: revision(fact.head_revision) };
  } else if (kind === "reconciliation") {
    const environments = strings(fact.environments);
    if (environments.length === 0 || environments.some((name) => !service.environments.some((entry) => entry.name === name)))
      throw new ReferenceAdapterError("UNAUTHORIZED");
    eventType = "reconciliation.requested";
    payload = { scope: { service_ids: [serviceId], environments: environments.sort() },
      provider_snapshot_reference: text(fact.provider_snapshot_reference) };
  } else {
    environment = text(fact.environment);
    const configured = service.environments.find((entry) => entry.name === environment);
    if (!configured || context.producerId !== configured.deployment_authority.adapter_id)
      throw new ReferenceAdapterError("UNAUTHORIZED");
    eventType = "deployment.changed";
    if (kind === "deployment_attempt") {
      const artifact = known(artifacts, fact.artifact_id, fact.revision);
      const targetRevision = fact.target_revision === undefined ? undefined : revision(fact.target_revision);
      if (targetRevision !== undefined && ![...artifacts.values()].includes(targetRevision))
        throw new ReferenceAdapterError("UNKNOWN_ARTIFACT");
      payload = { change_kind: "attempt", deployment_id: text(fact.deployment_id), environment,
        ...(targetRevision === undefined ? {} : { target_revision: targetRevision }), attempt_state: stringValue(fact.attempt_state, ["pending", "succeeded", "failed", "rollback_requested", "rolled_back"]),
        effective_order: sequence(fact.effective_order), artifact_id: artifact.artifact_id, revision: artifact.revision };
    } else {
      if (!Array.isArray(fact.inventory) || fact.inventory.length > MAX_ITEMS) throw new ReferenceAdapterError("INVALID_INPUT");
      const inventory = fact.inventory.map((item: unknown) => {
        if (!record(item)) throw new ReferenceAdapterError("INVALID_INPUT");
        keys(item, ["artifact_id", "revision"]);
        return known(artifacts, item.artifact_id, item.revision);
      });
      payload = { change_kind: "serving_observation", observation_id: text(fact.observation_id), environment,
        source: { authority_id: text(fact.authority_id), reference: text(fact.reference), access_label: text(fact.access_label) },
        completeness: stringValue(fact.completeness, ["complete", "incomplete", "transitional"]),
        effective_order: sequence(fact.effective_order), serving_state: { status: "known", inventory } };
    }
  }
  const candidate = { event_version: "1.0.0", event_id: text(fact.event_id), event_type: eventType,
    producer: { producer_id: context.producerId, adapter_version: "1.0.0" },
    occurred_at: date(fact.occurred_at), received_at: date(fact.received_at),
    subjects: { repository_id: repositoryId, service_ids: [serviceId], ...(environment ? { environment } : {}) },
    provider_evidence: { provider: repository.provider, provider_reference: text(fact.provider_reference),
      order: { kind: "sequence", value: sequence(fact.sequence) } }, payload };
  const parsed = parseEvent(candidate);
  if (!parsed.ok) throw new ReferenceAdapterError("INVALID_INPUT");
  const event = parsed.value;
  try { authorizeNormalizedEvent(context, event, config); } catch { throw new ReferenceAdapterError("UNAUTHORIZED"); }
  if (policy.previousEvent !== undefined) {
    const previous = parseEvent(policy.previousEvent);
    if (!previous.ok || !sameStream(previous.value, event)
      || previous.value.subjects.repository_id !== repositoryId
      || previous.value.subjects.service_ids.length !== 1 || previous.value.subjects.service_ids[0] !== serviceId
      || previous.value.subjects.environment !== event.subjects.environment)
      throw new ReferenceAdapterError("INVALID_INPUT");
    if (previous.value.event_id === event.event_id) throw new ReferenceAdapterError("STALE_OR_DUPLICATE");
    const status = classifyProviderUpdate({ evidence: previous.value.provider_evidence, relevantPayload: previous.value.payload },
      { evidence: event.provider_evidence, relevantPayload: event.payload });
    if (status !== "newer") throw new ReferenceAdapterError("STALE_OR_DUPLICATE");
  }
  return Object.freeze(event);
};
