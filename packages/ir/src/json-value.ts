import { type Static, Type } from "@sinclair/typebox";

export const JsonValueSchema = Type.Recursive((This) => Type.Union([
  Type.Null(),
  Type.Boolean(),
  Type.Number(),
  Type.String(),
  Type.Array(This),
  Type.Record(Type.String(), This),
]), { $id: "https://api-truth.dev/schemas/json-value-1.0.0.json" });

export type JsonValue = Static<typeof JsonValueSchema>;
