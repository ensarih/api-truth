import { type Static, Type } from "@sinclair/typebox";
import { parserFor } from "./validation.js";
import { ViewVersionSchema } from "./versions.js";

const fields = {
  view_version: ViewVersionSchema,
  service_id: Type.String({ minLength: 1 }),
  publication_id: Type.Optional(Type.String({ minLength: 1 })),
};

export const ViewSelectorSchema = Type.Union([
  Type.Object({ ...fields, environment: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
  Type.Object({ ...fields, branch: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
  Type.Object({ ...fields, revision: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
], { $id: "https://api-truth.dev/schemas/view-selector-1.0.0.json" });

export type ViewSelector = Static<typeof ViewSelectorSchema>;
export const parseViewSelector = parserFor(ViewSelectorSchema);
export const validateViewSelector = parseViewSelector;
