export type QuerySelector =
  | Readonly<{ kind: "environment"; environment: string }>
  | Readonly<{ kind: "branch"; branch: string }>
  | Readonly<{ kind: "revision"; revision: string }>;

export type QuerySelection = Readonly<{
  version: "1";
  tenantId: string;
  repositoryId: string;
  serviceId: string;
  selector: QuerySelector;
}>;

export class QuerySelectionError extends Error {
  readonly code: "INVALID_QUERY_SELECTION" | "INVALID_ENVIRONMENT_VIEW"
    | "QUERY_SELECTOR_KIND_MISMATCH" | "QUERY_SELECTION_MISMATCH";
  constructor(code: QuerySelectionError["code"]) {
    super(code);
    this.name = "QuerySelectionError";
    this.code = code;
  }
}

const identifier = (value: unknown): value is string =>
  typeof value === "string" && /^[^\u0000-\u001f\u007f]{1,512}$/.test(value);

const plainRecord = (input: unknown, fields: readonly string[]): Record<string, unknown> => {
  try {
    if (input === null || typeof input !== "object" || Array.isArray(input)
      || Object.getPrototypeOf(input) !== Object.prototype) throw new Error();
    const descriptors = Object.getOwnPropertyDescriptors(input);
    if (Reflect.ownKeys(descriptors).length !== fields.length
      || fields.some((field) => descriptors[field] === undefined || !("value" in descriptors[field]!)))
      throw new Error();
    return Object.fromEntries(fields.map((field) => [field, descriptors[field]!.value]));
  } catch { throw new QuerySelectionError("INVALID_QUERY_SELECTION"); }
};

/** Parses an explicit, bounded selection. This does not authorize access or resolve a snapshot. */
export const parseQuerySelection = (input: unknown): QuerySelection => {
  const record = plainRecord(input, ["version", "tenantId", "repositoryId", "serviceId", "selector"]);
  if (record.version !== "1" || !identifier(record.tenantId)
    || !identifier(record.repositoryId) || !identifier(record.serviceId))
    throw new QuerySelectionError("INVALID_QUERY_SELECTION");
  let selector: QuerySelector;
  const raw = record.selector;
  try {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)
      || Object.getPrototypeOf(raw) !== Object.prototype)
      throw new QuerySelectionError("INVALID_QUERY_SELECTION");
    const kind = Object.getOwnPropertyDescriptor(raw, "kind");
    if (kind === undefined || !("value" in kind)) throw new QuerySelectionError("INVALID_QUERY_SELECTION");
    if (kind.value === "environment") {
      const value = plainRecord(raw, ["kind", "environment"]);
      if (!identifier(value.environment)) throw new QuerySelectionError("INVALID_QUERY_SELECTION");
      selector = Object.freeze({ kind: "environment", environment: value.environment });
    } else if (kind.value === "branch") {
      const value = plainRecord(raw, ["kind", "branch"]);
      if (!identifier(value.branch)) throw new QuerySelectionError("INVALID_QUERY_SELECTION");
      selector = Object.freeze({ kind: "branch", branch: value.branch });
    } else if (kind.value === "revision") {
      const value = plainRecord(raw, ["kind", "revision"]);
      if (!identifier(value.revision)) throw new QuerySelectionError("INVALID_QUERY_SELECTION");
      selector = Object.freeze({ kind: "revision", revision: value.revision });
    } else throw new QuerySelectionError("INVALID_QUERY_SELECTION");
  } catch { throw new QuerySelectionError("INVALID_QUERY_SELECTION"); }
  return Object.freeze({ version: "1", tenantId: record.tenantId,
    repositoryId: record.repositoryId, serviceId: record.serviceId, selector });
};
