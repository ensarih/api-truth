import { type Static, Type } from "@sinclair/typebox";
import { parserFor, type ValidationError } from "./validation.js";
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

const normalizeSpringSegment = (segment: string): string => {
  if (!segment.startsWith("{") || !segment.endsWith("}")) return segment;
  const content = segment.slice(1, -1);
  const separator = content.indexOf(":");
  return separator === -1 ? "{}" : `{:${content.slice(separator + 1)}}`;
};

export const normalizeApplicationPathShape = (path: string): string => path
  .split("/")
  .map(normalizeSpringSegment)
  .join("/")
  .replace(/:([A-Za-z_][A-Za-z0-9_]*)(\([^/]+\))?/g, (_match, _name: string, constraint: string | undefined) =>
    constraint ? `{:${constraint}}` : "{}");

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
  const normalizedPathShape = normalizeApplicationPathShape(input.application_path);
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
