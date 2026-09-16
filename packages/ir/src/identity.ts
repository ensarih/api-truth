import { type Static, Type } from "@sinclair/typebox";
import { issue, parserFor, type ValidationError } from "./validation.js";
import { IDENTITY_VERSION, IdentityVersionSchema } from "./versions.js";

export const HeaderSelectorSchema = Type.Union([
  Type.Object({
    name: Type.String({ minLength: 1 }),
    operator: Type.Literal("equals"),
    value: Type.String(),
  }, { additionalProperties: false }),
  Type.Object({
    name: Type.String({ minLength: 1 }),
    operator: Type.Union([Type.Literal("present"), Type.Literal("absent")]),
  }, { additionalProperties: false }),
]);

export const RouteSelectorsSchema = Type.Object({
  headers: Type.Optional(Type.Array(HeaderSelectorSchema)),
  consumes: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  produces: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  query: Type.Optional(Type.Array(HeaderSelectorSchema)),
}, { additionalProperties: false });

export type RouteSelectors = Static<typeof RouteSelectorsSchema>;

export const EndpointIdentitySchema = Type.Object({
  identity_version: IdentityVersionSchema,
  route_key: Type.String({ minLength: 1 }),
  service_id: Type.String({ minLength: 1 }),
  method: Type.String({ pattern: "^[A-Z]+$" }),
  normalized_path_shape: Type.String({ pattern: "^/" }),
  selectors: RouteSelectorsSchema,
}, { $id: "https://api-truth.dev/schemas/endpoint-identity-1.0.0.json", additionalProperties: false });

export type EndpointIdentity = Static<typeof EndpointIdentitySchema>;

export const EndpointIdentityInputSchema = Type.Object({
  identity_version: IdentityVersionSchema,
  service_id: Type.String({ minLength: 1 }),
  method: Type.String({ pattern: "^[A-Za-z]+$" }),
  application_path: Type.String({ pattern: "^/" }),
  selectors: Type.Optional(RouteSelectorsSchema),
}, { $id: "https://api-truth.dev/schemas/endpoint-identity-input-1.0.0.json", additionalProperties: true });

export type EndpointIdentityInput = Static<typeof EndpointIdentityInputSchema> & Record<string, unknown>;
export const parseEndpointIdentityInput = parserFor(EndpointIdentityInputSchema);

export class EndpointIdentityInputError extends Error {
  readonly validation: ValidationError;

  constructor(validation: ValidationError) {
    super("Endpoint identity input is invalid");
    this.name = "EndpointIdentityInputError";
    this.validation = validation;
  }
}

const pathSyntaxError = (): never => {
  throw new Error("application path contains malformed or unsupported placeholder syntax");
};

const pathName = /^[A-Za-z_][A-Za-z0-9_]*$/;

const validatePathConstraint = (constraint: string): string => {
  if (constraint.length === 0) pathSyntaxError();
  try {
    // Compile the bounded constraint so malformed regular expressions fail closed.
    new RegExp(`^(?:${constraint})$`);
  } catch {
    pathSyntaxError();
  }
  return constraint;
};

const delimitedPathExpression = (
  path: string,
  start: number,
  opening: "{" | "(",
  closing: "}" | ")",
): { body: string; end: number } => {
  let depth = 1;
  let inCharacterClass = false;
  let escaped = false;
  for (let index = start + 1; index < path.length; index += 1) {
    const character = path[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === "[" && !inCharacterClass) {
      inCharacterClass = true;
      continue;
    }
    if (character === "]" && inCharacterClass) {
      inCharacterClass = false;
      continue;
    }
    if (inCharacterClass) continue;
    if (character === opening) {
      if (opening === "{") pathSyntaxError();
      depth += 1;
    } else if (character === closing) {
      depth -= 1;
      if (depth === 0) return { body: path.slice(start + 1, index), end: index + 1 };
    }
  }
  return pathSyntaxError();
};

export const normalizeApplicationPathShape = (path: string): string => {
  let normalized = "";
  let index = 0;
  while (index < path.length) {
    const character = path[index];
    if (character === "{") {
      const expression = delimitedPathExpression(path, index, "{", "}");
      const separator = expression.body.indexOf(":");
      if (separator === -1) {
        if (!pathName.test(expression.body)) pathSyntaxError();
        normalized += "{}";
      } else {
        const name = expression.body.slice(0, separator);
        if (!pathName.test(name)) pathSyntaxError();
        normalized += `{:${validatePathConstraint(expression.body.slice(separator + 1))}}`;
      }
      index = expression.end;
      continue;
    }
    if (character === "}") pathSyntaxError();
    if (character === ":") {
      const nameMatch = path.slice(index + 1).match(/^[A-Za-z_][A-Za-z0-9_]*/);
      if (nameMatch) {
        const nameEnd = index + 1 + nameMatch[0].length;
        if (path[nameEnd] === "(") {
          const expression = delimitedPathExpression(path, nameEnd, "(", ")");
          normalized += `{:${validatePathConstraint(expression.body)}}`;
          index = expression.end;
        } else {
          normalized += "{}";
          index = nameEnd;
        }
        continue;
      }
    }
    normalized += character;
    index += 1;
  }
  return normalized;
};

const selectorValue = (selector: Static<typeof HeaderSelectorSchema>): string =>
  "value" in selector ? selector.value : "";

const canonicalSelectorList = (
  selectors: Static<typeof HeaderSelectorSchema>[],
  caseInsensitiveName: boolean,
): Static<typeof HeaderSelectorSchema>[] => {
  const canonical = selectors.map((selector) => ({
    ...selector,
    name: caseInsensitiveName ? selector.name.toLowerCase() : selector.name,
  }));
  const byKey = new Map(canonical.map((selector) => [
    `${selector.name}\0${selector.operator}\0${selectorValue(selector)}`,
    selector,
  ]));
  return [...byKey.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, selector]) => selector);
};

const canonicalStringSet = (values: string[]): string[] =>
  [...new Set(values.map((value) => value.toLowerCase()))].sort();

const canonicalSelectors = (selectors: RouteSelectors): RouteSelectors => ({
  ...(selectors.headers ? { headers: canonicalSelectorList(selectors.headers, true) } : {}),
  ...(selectors.consumes ? { consumes: canonicalStringSet(selectors.consumes) } : {}),
  ...(selectors.produces ? { produces: canonicalStringSet(selectors.produces) } : {}),
  ...(selectors.query ? { query: canonicalSelectorList(selectors.query, false) } : {}),
});

const stableSelectors = (selectors: RouteSelectors): string => JSON.stringify({
  headers: selectors.headers ?? [],
  consumes: selectors.consumes ?? [],
  produces: selectors.produces ?? [],
  query: selectors.query ?? [],
});

export const deriveEndpointIdentity = (input: EndpointIdentityInput): EndpointIdentity => {
  const parsed = parseEndpointIdentityInput(input);
  if (!parsed.ok) throw new EndpointIdentityInputError(parsed.error);
  const method = input.method.toUpperCase();
  let normalizedPathShape: string;
  try {
    normalizedPathShape = normalizeApplicationPathShape(input.application_path);
  } catch {
    throw new EndpointIdentityInputError({
      kind: "validation_error",
      issues: [issue("/application_path", "semantic.invalid_path_syntax", "application path contains malformed or unsupported placeholder syntax")],
    });
  }
  const selectors = canonicalSelectors(input.selectors ?? {});
  return {
    identity_version: input.identity_version,
    route_key: `${input.identity_version}|${input.service_id}|${method}|${normalizedPathShape}|${stableSelectors(selectors)}`,
    service_id: input.service_id,
    method,
    normalized_path_shape: normalizedPathShape,
    selectors,
  };
};
