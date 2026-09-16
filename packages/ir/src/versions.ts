import { Type } from "@sinclair/typebox";

export const IR_VERSION = "1.0.0" as const;
export const EVENT_VERSION = "1.0.0" as const;
export const VIEW_VERSION = "1.0.0" as const;
export const CONFIG_VERSION = "1.0.0" as const;
export const IDENTITY_VERSION = "1.0.0" as const;
export const ANALYZER_EXCHANGE_VERSION = "1.0.0" as const;

export const IrVersionSchema = Type.Literal(IR_VERSION);
export const EventVersionSchema = Type.Literal(EVENT_VERSION);
export const ViewVersionSchema = Type.Literal(VIEW_VERSION);
export const ConfigVersionSchema = Type.Literal(CONFIG_VERSION);
export const IdentityVersionSchema = Type.Literal(IDENTITY_VERSION);
export const AnalyzerExchangeVersionSchema = Type.Literal(ANALYZER_EXCHANGE_VERSION);
