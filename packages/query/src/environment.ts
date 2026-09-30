import type { EnvironmentView } from "@api-truth/environment";
import { parseQuerySelection, QuerySelectionError, type QuerySelection } from "./selector.js";

export type EnvironmentSelection =
  | Readonly<{ status: "resolved"; selector: QuerySelection; pin: Readonly<{
      snapshotId: string; revision: string; configFingerprint: string; checkpointVersion: string;
    }> }>
  | Readonly<{ status: "unavailable" | "transitional" | "unknown"; selector: QuerySelection }>;

const bounded = (value: unknown): value is string =>
  typeof value === "string" && /^[^\u0000-\u001f\u007f]{1,512}$/.test(value);

const readView = (input: unknown): Partial<EnvironmentView> => {
  try {
    if (input === null || typeof input !== "object" || Array.isArray(input)
      || Object.getPrototypeOf(input) !== Object.prototype) throw new Error();
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const allowed = ["repositoryId", "serviceId", "environment", "configFingerprint",
      "checkpointVersion", "reconciliationRequired", "deployment", "contract", "active",
      "latestAttempt", "snapshotId"];
    if (Reflect.ownKeys(descriptors).length > allowed.length
      || Reflect.ownKeys(descriptors).some((key) => typeof key !== "string" || !allowed.includes(key)
        || !("value" in descriptors[key]!))) throw new Error();
    return Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]));
  } catch { throw new QuerySelectionError("INVALID_ENVIRONMENT_VIEW"); }
};

const readOnlyActive = (input: unknown): { artifactId: string; revision: string; snapshotId: string } | undefined => {
  try {
    if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype || input.length !== 1)
      return undefined;
    const entries = Object.getOwnPropertyDescriptors(input);
    if (Reflect.ownKeys(entries).length !== 2 || !("value" in entries["0"]!)) return undefined;
    const item = entries["0"]!.value as unknown;
    if (item === null || typeof item !== "object" || Array.isArray(item)
      || Object.getPrototypeOf(item) !== Object.prototype) return undefined;
    const fields = Object.getOwnPropertyDescriptors(item);
    if (Reflect.ownKeys(fields).length !== 3 || ["artifactId", "revision", "snapshotId"].some((key) =>
      fields[key] === undefined || !("value" in fields[key]!))) return undefined;
    const artifactId = fields.artifactId!.value as unknown;
    const revision = fields.revision!.value as unknown;
    const snapshotId = fields.snapshotId!.value as unknown;
    return bounded(artifactId) && bounded(revision) && bounded(snapshotId)
      ? { artifactId, revision, snapshotId } : undefined;
  } catch { return undefined; }
};

/** A display/preflight projection; S1 must recheck the pin and authorization in its database read. */
export const projectEnvironmentSelection = (
  selectionInput: unknown, viewInput: unknown,
): EnvironmentSelection => {
  const selector = parseQuerySelection(selectionInput);
  if (selector.selector.kind !== "environment") throw new QuerySelectionError("QUERY_SELECTOR_KIND_MISMATCH");
  const view = readView(viewInput);
  if (view.repositoryId !== selector.repositoryId || view.serviceId !== selector.serviceId
    || view.environment !== selector.selector.environment)
    throw new QuerySelectionError("QUERY_SELECTION_MISMATCH");
  const state = (status: "unavailable" | "transitional" | "unknown"): EnvironmentSelection =>
    Object.freeze({ status, selector });
  if (view.reconciliationRequired !== false || view.deployment === "unknown"
    || !bounded(view.checkpointVersion)
    || selector.selector.expectedCheckpointVersion !== undefined
      && selector.selector.expectedCheckpointVersion !== view.checkpointVersion) return state("unknown");
  if (view.deployment === "transitional") return state("transitional");
  if (view.deployment !== "deployed" || view.contract !== "resolved") return state("unavailable");
  const only = readOnlyActive(view.active);
  if (only === undefined || only.snapshotId !== view.snapshotId
    || !bounded(view.configFingerprint)) return state("unavailable");
  return Object.freeze({ status: "resolved", selector, pin: Object.freeze({
    snapshotId: only.snapshotId, revision: only.revision,
    configFingerprint: view.configFingerprint, checkpointVersion: view.checkpointVersion,
  }) });
};
