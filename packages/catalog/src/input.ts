import { CatalogError } from "./errors.js";

export const invalidCatalogInput = (): never => {
  throw new CatalogError("INVALID_CATALOG_INPUT");
};

export const withCatalogInputBoundary = <Value>(operation: () => Value): Value => {
  try {
    return operation();
  } catch (error) {
    try {
      if (error instanceof CatalogError) throw error;
    } catch (classificationError) {
      if (classificationError instanceof CatalogError) throw classificationError;
    }
    throw new CatalogError("INVALID_CATALOG_INPUT");
  }
};

export const nonEmptyString = (value: unknown): string => {
  if (typeof value !== "string" || value.length === 0) return invalidCatalogInput();
  return value;
};

export const booleanValue = (value: unknown): boolean => {
  if (typeof value !== "boolean") return invalidCatalogInput();
  return value;
};
