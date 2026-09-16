import type { TSchema } from "@sinclair/typebox";
import { AnalyzerRequestSchema, AnalyzerResultSchema } from "./analyzer.js";
import { ApiSchemaSchema, SchemaComponentSchema } from "./api-schema.js";
import { InstallationConfigSchema } from "./config.js";
import {
  ClaimSchema, ConditionSchema, EditorialReviewSchema, EvidenceSchema, ExportEligibilitySchema, PresenceFactSchema,
} from "./evidence.js";
import { EndpointSchema } from "./endpoints.js";
import { EventSchema } from "./events.js";
import { EndpointIdentitySchema } from "./identity.js";
import { JsonValueSchema } from "./json-value.js";
import { ContractSnapshotSchema } from "./snapshot.js";
import { ViewSelectorSchema } from "./views.js";

export const jsonSchemas = {
  contractSnapshot: ContractSnapshotSchema,
  event: EventSchema,
  viewSelector: ViewSelectorSchema,
  config: InstallationConfigSchema,
  analyzerRequest: AnalyzerRequestSchema,
  analyzerResult: AnalyzerResultSchema,
} as const satisfies Record<string, TSchema>;

export const jsonSchemaCatalog: readonly TSchema[] = [
  JsonValueSchema,
  ApiSchemaSchema,
  SchemaComponentSchema,
  ConditionSchema,
  PresenceFactSchema,
  EvidenceSchema,
  ClaimSchema,
  EditorialReviewSchema,
  ExportEligibilitySchema,
  EndpointIdentitySchema,
  EndpointSchema,
  ContractSnapshotSchema,
  EventSchema,
  ViewSelectorSchema,
  InstallationConfigSchema,
  AnalyzerRequestSchema,
  AnalyzerResultSchema,
];
