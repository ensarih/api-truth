import { type Static, Type } from "@sinclair/typebox";
import { ApiSchemaSchema } from "./api-schema.js";
import { PresenceFactSchema } from "./evidence.js";
import { EndpointIdentitySchema } from "./identity.js";

const NonEmptyString = () => Type.String({ minLength: 1 });
const SerializationSchema = Type.Object({
  format: Type.Optional(NonEmptyString()),
  style: Type.Optional(NonEmptyString()),
  explode: Type.Optional(Type.Boolean()),
  content_encoding: Type.Optional(NonEmptyString()),
}, { additionalProperties: false, minProperties: 1 });

const ContentSchema = Type.Object({
  media_type: NonEmptyString(),
  schema: Type.Ref(ApiSchemaSchema),
  serialization: SerializationSchema,
}, { additionalProperties: false });

export const EndpointSchema = Type.Object({
  endpoint_id: NonEmptyString(),
  identity: Type.Ref(EndpointIdentitySchema),
  application_path: Type.String({ pattern: "^/" }),
  parameters: Type.Array(Type.Object({
    name: NonEmptyString(),
    in: Type.Union([Type.Literal("path"), Type.Literal("query"), Type.Literal("header"), Type.Literal("cookie")]),
    presence: Type.Ref(PresenceFactSchema),
    schema: Type.Ref(ApiSchemaSchema),
    serialization: SerializationSchema,
  }, { additionalProperties: false })),
  request_bodies: Type.Array(Type.Object({
    media_type: NonEmptyString(),
    schema: Type.Ref(ApiSchemaSchema),
    serialization: SerializationSchema,
    presence: Type.Ref(PresenceFactSchema),
  }, { additionalProperties: false })),
  responses: Type.Array(Type.Object({
    status: Type.Union([
      Type.Object({ kind: Type.Literal("exact"), code: Type.Integer({ minimum: 100, maximum: 599 }) }, { additionalProperties: false }),
      Type.Object({ kind: Type.Literal("range"), range: Type.String({ pattern: "^[1-5]XX$" }) }, { additionalProperties: false }),
      Type.Object({ kind: Type.Literal("default") }, { additionalProperties: false }),
      Type.Object({ kind: Type.Literal("unknown"), reason: NonEmptyString() }, { additionalProperties: false }),
    ]),
    content: Type.Array(ContentSchema),
    headers: Type.Optional(Type.Array(Type.Object({ name: NonEmptyString(), schema: Type.Ref(ApiSchemaSchema) }, { additionalProperties: false }))),
  }, { additionalProperties: false }), { minItems: 1 }),
  security: Type.Object({
    alternatives: Type.Array(Type.Object({
      requirements: Type.Array(Type.Object({
        scheme: NonEmptyString(), scopes: Type.Array(Type.String()),
      }, { additionalProperties: false }), { minItems: 1 }),
    }, { additionalProperties: false })),
  }, { additionalProperties: false }),
  evidence_ids: Type.Array(NonEmptyString(), { minItems: 1, uniqueItems: true }),
}, { $id: "https://api-truth.dev/schemas/endpoint-1.0.0.json", additionalProperties: false });

export type Endpoint = Static<typeof EndpointSchema>;
