import { type Static, Type } from "@sinclair/typebox";

const EvidenceIds = Type.Array(Type.String({ minLength: 1 }), { minItems: 1, uniqueItems: true });

export const SecuritySchemeDefinitionSchema = Type.Union([
  Type.Object({ type: Type.Literal("apiKey"), name: Type.String({ minLength: 1 }),
    in: Type.Union([Type.Literal("header"), Type.Literal("query"), Type.Literal("cookie")]) },
  { additionalProperties: false }),
  Type.Object({ type: Type.Literal("http"), scheme: Type.String({ minLength: 1 }),
    bearerFormat: Type.Optional(Type.String({ minLength: 1 })) }, { additionalProperties: false }),
], { $id: "https://api-truth.dev/schemas/security-scheme-definition-1.0.0.json" });

export const SecuritySchemeFactSchema = Type.Object({
  definition: Type.Ref(SecuritySchemeDefinitionSchema),
  evidence_ids: EvidenceIds,
}, { $id: "https://api-truth.dev/schemas/security-scheme-fact-1.0.0.json", additionalProperties: false });

export type SecuritySchemeFact = Static<typeof SecuritySchemeFactSchema>;
