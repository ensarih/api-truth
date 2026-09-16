import type { Static, TSchema } from "@sinclair/typebox";
import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import * as addFormatsModule from "ajv-formats";

export type ValidationIssue = { path: string; code: string; message: string };
export type ValidationError = { kind: "validation_error"; issues: ValidationIssue[] };
export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ValidationError };

export const issue = (path: string, code: string, message: string): ValidationIssue => ({ path, code, message });
export const failure = <T>(issues: ValidationIssue[]): ValidationResult<T> => ({
  ok: false,
  error: { kind: "validation_error", issues },
});

const pathFor = (error: ErrorObject): string => {
  if (error.keyword === "required" && "missingProperty" in error.params) {
    return `${error.instancePath}/${String(error.params.missingProperty)}` || "/";
  }
  return error.instancePath || "/";
};

const cleanMessage = (error: ErrorObject): string => {
  switch (error.keyword) {
    case "required": return "required field is missing";
    case "additionalProperties": return "unknown field is not allowed";
    case "const": return "unsupported contract value";
    case "format": return "field has an invalid format";
    case "oneOf":
    case "anyOf": return "field does not match exactly one supported shape";
    default: return error.message ?? "field is invalid";
  }
};

export const createAjv = () => {
  const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
  (addFormatsModule.default as unknown as (instance: Ajv2020) => void)(ajv);
  return ajv;
};

export const validationIssues = (errors: ErrorObject[] | null | undefined): ValidationIssue[] =>
  (errors ?? []).map((error) => issue(pathFor(error), `shape.${error.keyword}`, cleanMessage(error)));

export const parserFor = <Schema extends TSchema>(
  schema: Schema,
  semantic?: (value: Static<Schema>) => ValidationIssue[],
  references: TSchema[] = [],
): ((value: unknown) => ValidationResult<Static<Schema>>) => {
  const ajv = createAjv();
  references.forEach((reference) => ajv.addSchema(reference));
  const validator: ValidateFunction<Static<Schema>> = ajv.compile(schema);
  return (value: unknown) => {
    if (!validator(value)) return failure(validationIssues(validator.errors));
    const semanticIssues = semantic?.(value) ?? [];
    return semanticIssues.length > 0 ? failure(semanticIssues) : { ok: true, value };
  };
};
