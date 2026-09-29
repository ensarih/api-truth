import { parseConfig, type InstallationConfig } from "@api-truth/ir";
import { canonicalOrchestrationJson, canonicalStringSet, detachedFrozen } from "./canonical.js";
import { orchestrationValidationError } from "./errors.js";
import type { ConfigurationPair } from "./types.js";

const validatePair = (input: unknown): ConfigurationPair => {
  let detached: unknown;
  try {
    detached = JSON.parse(canonicalOrchestrationJson(input)) as unknown;
  } catch {
    throw orchestrationValidationError({ kind: "validation_error", issues: [{ path: "/", code: "shape.invalid_json_value", message: "invalid" }] });
  }
  if (detached === null || typeof detached !== "object" || Array.isArray(detached)) {
    throw orchestrationValidationError({ kind: "validation_error", issues: [{ path: "/", code: "shape.type", message: "invalid" }] });
  }
  const candidate = detached as Record<string, unknown>;
  if (Object.keys(candidate).length !== 2
    || !Object.hasOwn(candidate, "fingerprint") || !Object.hasOwn(candidate, "document")) {
    throw orchestrationValidationError({ kind: "validation_error", issues: [{ path: "/", code: "shape.required", message: "invalid" }] });
  }
  if (typeof candidate.fingerprint !== "string" || candidate.fingerprint.length === 0) {
    throw orchestrationValidationError({ kind: "validation_error", issues: [{ path: "/fingerprint", code: "shape.minLength", message: "invalid" }] });
  }
  const parsed = parseConfig(candidate.document);
  if (!parsed.ok) throw orchestrationValidationError(parsed.error);
  return detachedFrozen({ fingerprint: candidate.fingerprint, document: parsed.value });
};

const allServices = (...documents: InstallationConfig[]): string[] => canonicalStringSet(
  documents.flatMap((document) => document.repositories.flatMap((repository) =>
    repository.services.map((service) => service.service_id))),
);

const byId = <Value>(values: readonly Value[], project: (value: Value) => string): Map<string, Value> =>
  new Map(values.map((value) => [project(value), value]));

export const calculateConfigurationImpact = (
  activeInput: unknown,
  candidateInput: unknown,
): string[] => {
  const active = validatePair(activeInput);
  const candidate = validatePair(candidateInput);
  const oldDocument = active.document;
  const newDocument = candidate.document;
  if (active.fingerprint !== candidate.fingerprint || oldDocument.config_version !== newDocument.config_version) {
    return allServices(oldDocument, newDocument);
  }
  if (canonicalOrchestrationJson(oldDocument.access_scopes) !== canonicalOrchestrationJson(newDocument.access_scopes)
    || canonicalOrchestrationJson(oldDocument.inference ?? null) !== canonicalOrchestrationJson(newDocument.inference ?? null)
    || canonicalOrchestrationJson(oldDocument.logs ?? null) !== canonicalOrchestrationJson(newDocument.logs ?? null)) {
    return allServices(oldDocument, newDocument);
  }

  const affected = new Set<string>();
  const oldRepositories = byId(oldDocument.repositories, (repository) => repository.repository_id);
  const newRepositories = byId(newDocument.repositories, (repository) => repository.repository_id);
  for (const repositoryId of new Set([...oldRepositories.keys(), ...newRepositories.keys()])) {
    const previous = oldRepositories.get(repositoryId);
    const next = newRepositories.get(repositoryId);
    if (previous === undefined || next === undefined) {
      for (const service of previous?.services ?? next?.services ?? []) affected.add(service.service_id);
      continue;
    }
    const previousMetadata = { provider: previous.provider, locator: previous.locator, access_scope_id: previous.access_scope_id };
    const nextMetadata = { provider: next.provider, locator: next.locator, access_scope_id: next.access_scope_id };
    if (canonicalOrchestrationJson(previousMetadata) !== canonicalOrchestrationJson(nextMetadata)) {
      for (const service of [...previous.services, ...next.services]) affected.add(service.service_id);
      continue;
    }
    const oldServices = byId(previous.services, (service) => service.service_id);
    const newServices = byId(next.services, (service) => service.service_id);
    for (const serviceId of new Set([...oldServices.keys(), ...newServices.keys()])) {
      if (canonicalOrchestrationJson(oldServices.get(serviceId) ?? null)
        !== canonicalOrchestrationJson(newServices.get(serviceId) ?? null)) affected.add(serviceId);
    }
  }
  return canonicalStringSet([...affected]);
};
