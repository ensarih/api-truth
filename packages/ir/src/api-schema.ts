import { type Static, Type } from "@sinclair/typebox";
import { JsonValueSchema } from "./json-value.js";

const ApiTypeNameSchema = Type.Union([
  Type.Literal("null"), Type.Literal("boolean"), Type.Literal("object"), Type.Literal("array"),
  Type.Literal("number"), Type.Literal("integer"), Type.Literal("string"),
]);

export const ApiSchemaSchema = Type.Recursive((This) => Type.Object({
  $ref: Type.Optional(Type.String({ minLength: 1 })),
  type: Type.Optional(Type.Union([ApiTypeNameSchema, Type.Array(ApiTypeNameSchema, { minItems: 1, uniqueItems: true })])),
  title: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
  properties: Type.Optional(Type.Record(Type.String(), This)),
  required: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true })),
  items: Type.Optional(This),
  prefixItems: Type.Optional(Type.Array(This)),
  additionalProperties: Type.Optional(Type.Union([Type.Boolean(), This])),
  enum: Type.Optional(Type.Array(Type.Ref(JsonValueSchema), { minItems: 1 })),
  const: Type.Optional(Type.Ref(JsonValueSchema)),
  oneOf: Type.Optional(Type.Array(This, { minItems: 1 })),
  anyOf: Type.Optional(Type.Array(This, { minItems: 1 })),
  allOf: Type.Optional(Type.Array(This, { minItems: 1 })),
  not: Type.Optional(This),
  format: Type.Optional(Type.String({ minLength: 1 })),
  pattern: Type.Optional(Type.String()),
  minimum: Type.Optional(Type.Number()),
  maximum: Type.Optional(Type.Number()),
  minLength: Type.Optional(Type.Integer({ minimum: 0 })),
  maxLength: Type.Optional(Type.Integer({ minimum: 0 })),
  minItems: Type.Optional(Type.Integer({ minimum: 0 })),
  maxItems: Type.Optional(Type.Integer({ minimum: 0 })),
}, { additionalProperties: false }), {
  $id: "https://api-truth.dev/schemas/api-schema-node-1.0.0.json",
});

export type ApiSchema = Static<typeof ApiSchemaSchema>;

export const SchemaComponentSchema = Type.Object({
  schema_id: Type.String({ minLength: 1 }),
  schema: Type.Ref(ApiSchemaSchema),
  evidence_ids: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, uniqueItems: true }),
}, { $id: "https://api-truth.dev/schemas/schema-component-1.0.0.json", additionalProperties: false });

export type SchemaComponent = Static<typeof SchemaComponentSchema>;
