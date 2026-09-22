import type { ValidationError } from "@api-truth/ir";
import type { CatalogErrorCode } from "./types.js";

export type CatalogIssue = Readonly<{ path: string; code: string }>;

const messages: Record<CatalogErrorCode, string> = {
  INVALID_CATALOG_INPUT: "Catalog input is invalid",
  INVALID_SNAPSHOT: "Snapshot is invalid",
  SNAPSHOT_INELIGIBLE: "Snapshot is not eligible for catalog storage",
  UNKNOWN_ACCESS_SCOPE: "A required access scope is unavailable",
  SNAPSHOT_IDENTITY_CONFLICT: "Snapshot identity conflicts with stored content",
  BRANCH_TARGET_INELIGIBLE: "Branch target is not eligible",
  BRANCH_POINTER_STALE: "Branch pointer update is stale",
  BRANCH_POINTER_CONFLICT: "Branch pointer update conflicts with current state",
  CATALOG_NOT_FOUND_OR_DENIED: "Catalog resource was not found or access was denied",
  CATALOG_STORAGE_ERROR: "Catalog storage operation failed",
};

type CatalogErrorOptions = {
  issues?: ReadonlyArray<CatalogIssue>;
  retryable?: boolean;
};

export class CatalogError extends Error {
  readonly code: CatalogErrorCode;
  readonly issues?: ReadonlyArray<CatalogIssue>;
  readonly retryable: boolean;

  constructor(code: CatalogErrorCode, options: CatalogErrorOptions = {}) {
    super(messages[code]);
    this.name = "CatalogError";
    this.code = code;
    this.retryable = options.retryable ?? code === "CATALOG_STORAGE_ERROR";
    if (options.issues !== undefined) {
      this.issues = Object.freeze(options.issues.map(({ path, code: issueCode }) => Object.freeze({
        path,
        code: issueCode,
      })));
    }
  }
}

export const catalogError = (
  code: CatalogErrorCode,
  options?: CatalogErrorOptions,
): CatalogError => new CatalogError(code, options);

export const catalogValidationError = (
  code: "INVALID_CATALOG_INPUT" | "INVALID_SNAPSHOT",
  validation: ValidationError,
): CatalogError => new CatalogError(code, {
  issues: validation.issues.map(({ path, code: issueCode }) => ({ path, code: issueCode })),
});

export const catalogStorageError = (_cause?: unknown): CatalogError =>
  Object.defineProperty(
    new CatalogError("CATALOG_STORAGE_ERROR", { retryable: true }),
    "cause",
    { value: _cause, enumerable: false, configurable: true },
  );

export const asCatalogError = (error: unknown): CatalogError =>
  error instanceof CatalogError ? error : catalogStorageError(error);
