import { type Static, Type } from "@sinclair/typebox";
import { IDENTITY_VERSION, IdentityVersionSchema } from "./versions.js";

export const HeaderSelectorSchema = Type.Object({
  name: Type.String({ minLength: 1 }),
  operator: Type.Union([Type.Literal("equals"), Type.Literal("present"), Type.Literal("absent")]),
  value: Type.Optional(Type.String()),
}, { additionalProperties: false });

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
export type EndpointIdentityInput = {
  identity_version: typeof IDENTITY_VERSION;
  service_id: string;
  method: string;
  application_path: string;
  selectors?: RouteSelectors;
} & Record<string, unknown>;

export const normalizeApplicationPathShape = (path: string): string => path
  .replace(/\{[^}/]+\}/g, "{}")
  .replace(/:([A-Za-z_][A-Za-z0-9_]*)(\([^/]+\))?/g, (_match, _name: string, constraint: string | undefined) =>
    constraint ? `{${constraint}}` : "{}");

const stableSelectors = (selectors: RouteSelectors): string => JSON.stringify({
  headers: [...(selectors.headers ?? [])].map((value) => ({ ...value })).sort((a, b) =>
    `${a.name}\0${a.operator}\0${a.value ?? ""}`.localeCompare(`${b.name}\0${b.operator}\0${b.value ?? ""}`)),
  consumes: [...(selectors.consumes ?? [])].sort(),
  produces: [...(selectors.produces ?? [])].sort(),
  query: [...(selectors.query ?? [])].map((value) => ({ ...value })).sort((a, b) =>
    `${a.name}\0${a.operator}\0${a.value ?? ""}`.localeCompare(`${b.name}\0${b.operator}\0${b.value ?? ""}`)),
});

export const deriveEndpointIdentity = (input: EndpointIdentityInput): EndpointIdentity => {
  const method = input.method.toUpperCase();
  const normalizedPathShape = normalizeApplicationPathShape(input.application_path);
  const selectors = input.selectors ?? {};
  return {
    identity_version: input.identity_version,
    route_key: `${input.identity_version}|${input.service_id}|${method}|${normalizedPathShape}|${stableSelectors(selectors)}`,
    service_id: input.service_id,
    method,
    normalized_path_shape: normalizedPathShape,
    selectors,
  };
};
