import { Buffer } from "node:buffer";
import { McpServer, type CallToolResult, type ServerContext } from "@modelcontextprotocol/server";
import type { QueryReader, QueryObservationReader, QueryOperationReader, QuerySelection, QuerySelector } from "@api-truth/query";
import {isSemanticIntentQuerySafe} from "../../../packages/semantics/src/egress.js";
import type { createSemanticService } from "../../../packages/semantics/src/service.js";
import * as z from "zod/v4";

export type ApiTruthMcpPrincipal = Readonly<{ tenantId: string; principalId: string }>;

export type ApiTruthMcpOptions = Readonly<{
  query: Pick<QueryReader, "searchServices" | "readContract" | "readEndpoint" | "readSchema" | "compareContracts">
    & Partial<QueryObservationReader & QueryOperationReader>;
  authenticate(context: ServerContext): Promise<ApiTruthMcpPrincipal | undefined>;
  maxOutputBytes?: number;
  semantic?: Pick<ReturnType<typeof createSemanticService>, "discover">;
}>;

const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
const MIN_MAX_OUTPUT_BYTES = 1024;
const MAX_MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_IDENTIFIER_LENGTH = 512;

const publicErrors = [
  "NOT_AUTHORIZED",
  "NOT_FOUND_OR_DENIED",
  "STALE_SELECTION",
  "RESULT_LIMIT_EXCEEDED",
  "RESULT_TOO_LARGE",
  "QUERY_UNAVAILABLE",
  "INVALID_REQUEST",
] as const;
type PublicError = typeof publicErrors[number];

const boundedIdentifier = z.string().min(1).max(MAX_IDENTIFIER_LENGTH)
  .regex(/^[^\u0000-\u001f\u007f]+$/);
const boundedSearch = z.string().max(128).regex(/^[^\u0000-\u001f\u007f]*$/);
const databaseVersion = z.string().regex(/^[1-9][0-9]{0,18}$/)
  .refine((value) => BigInt(value) <= 9223372036854775807n);

const revisionView = z.object({
  kind: z.literal("revision"),
  revision: boundedIdentifier,
}).strict();
const branchView = z.object({
  kind: z.literal("branch"),
  branch: boundedIdentifier,
  expectedPointerVersion: databaseVersion.optional(),
}).strict();
const environmentView = z.object({
  kind: z.literal("environment"),
  environment: boundedIdentifier,
  expectedCheckpointVersion: databaseVersion.optional(),
}).strict();
const discoveryBranchView = branchView.extend({ expectedPointerVersion: databaseVersion });
const discoveryEnvironmentView = environmentView.extend({ expectedCheckpointVersion: databaseVersion });
const discoveryViewSchema = z.discriminatedUnion("kind", [revisionView, discoveryBranchView, discoveryEnvironmentView]);
const viewSchema = z.discriminatedUnion("kind", [revisionView, branchView, environmentView]);

const selectionSchema = z.object({
  repositoryId: boundedIdentifier,
  serviceId: boundedIdentifier,
  view: viewSchema,
}).strict();
const endpointSchema = selectionSchema.extend({ endpointId: boundedIdentifier }).strict();
const schemaSchema = selectionSchema.extend({ schemaId: boundedIdentifier }).strict();
const comparisonSchema = z.object({
  repositoryId: boundedIdentifier,
  serviceId: boundedIdentifier,
  before: viewSchema,
  after: viewSchema,
}).strict();
const searchSchema = z.object({
  query: boundedSearch,
  maxResults: z.number().int().min(1).max(50).default(20),
  environment: boundedIdentifier.optional(),
}).strict();
const discoverySchema = z.object({repositoryId: boundedIdentifier, serviceId: boundedIdentifier,
  view: discoveryViewSchema, endpointIds: z.array(boundedIdentifier).min(1).max(16)
    .refine((ids) => new Set(ids).size === ids.length), intentQuery: z.string().min(1).max(512)
      .regex(/^[^\u0000-\u001f\u007f]+$/).refine(isSemanticIntentQuerySafe)}).strict();
const observationSchema = z.object({repositoryId: boundedIdentifier, serviceId: boundedIdentifier,
  environment: boundedIdentifier, expectedCheckpointVersion: databaseVersion.optional(),
  endpointId: boundedIdentifier.optional(), maxResults: z.number().int().min(1).max(100).default(20)}).strict();
const candidateSchema = z.object({repositoryId: boundedIdentifier, serviceId: boundedIdentifier,
  view: discoveryEnvironmentView, intentQuery: z.string().min(1).max(512)
    .regex(/^[^\u0000-\u001f\u007f]+$/), maxResults: z.number().int().min(1).max(20).default(20)}).strict();

const successSchema = z.object({ ok: z.literal(true), data: z.unknown() }).strict();
const failureSchema = z.object({ ok: z.literal(false), error: z.enum(publicErrors) }).strict();
const outputSchema = z.discriminatedUnion("ok", [successSchema, failureSchema]);

const readOnlyAnnotations = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
});

const isBoundedIdentifier = (value: unknown): value is string => typeof value === "string"
  && value.length >= 1 && value.length <= MAX_IDENTIFIER_LENGTH
  && !/[\u0000-\u001f\u007f]/.test(value);

const parsePrincipal = (input: unknown): ApiTruthMcpPrincipal | undefined => {
  try {
    if (input === null || typeof input !== "object" || Array.isArray(input)
      || Object.getPrototypeOf(input) !== Object.prototype) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(input);
    if (Reflect.ownKeys(descriptors).length !== 2
      || descriptors.tenantId === undefined || !("value" in descriptors.tenantId)
      || descriptors.principalId === undefined || !("value" in descriptors.principalId)
      || !isBoundedIdentifier(descriptors.tenantId.value)
      || !isBoundedIdentifier(descriptors.principalId.value)) return undefined;
    return Object.freeze({
      tenantId: descriptors.tenantId.value,
      principalId: descriptors.principalId.value,
    });
  } catch {
    return undefined;
  }
};

const mapQueryError = (error: unknown): PublicError => {
  if (error === null || typeof error !== "object") return "QUERY_UNAVAILABLE";
  const descriptor = Object.getOwnPropertyDescriptor(error, "code");
  if (descriptor === undefined || !("value" in descriptor)) return "QUERY_UNAVAILABLE";
  switch (descriptor.value) {
    case "QUERY_NOT_FOUND_OR_DENIED": return "NOT_FOUND_OR_DENIED";
    case "QUERY_STALE_SELECTION": return "STALE_SELECTION";
    case "QUERY_RESULT_LIMIT_EXCEEDED": return "RESULT_LIMIT_EXCEEDED";
    case "INVALID_QUERY_SEARCH": return "INVALID_REQUEST";
    case "SEMANTIC_NOT_FOUND_OR_DENIED": return "NOT_FOUND_OR_DENIED";
    case "SEMANTIC_STALE_CONTEXT": return "STALE_SELECTION";
    case "SEMANTIC_INVALID_REQUEST": return "INVALID_REQUEST";
    default: return "QUERY_UNAVAILABLE";
  }
};

const failure = (error: PublicError): CallToolResult => {
  const structuredContent = { ok: false as const, error };
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(structuredContent) }],
    structuredContent,
  };
};

const result = (data: unknown, maxOutputBytes: number): CallToolResult => {
  try {
    const serialized = JSON.stringify({ ok: true as const, data });
    if (Buffer.byteLength(serialized, "utf8") > maxOutputBytes) return failure("RESULT_TOO_LARGE");
    const structuredContent = JSON.parse(serialized) as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(structuredContent, "data")) return failure("QUERY_UNAVAILABLE");
    return { content: [{ type: "text", text: serialized }], structuredContent };
  } catch {
    return failure("QUERY_UNAVAILABLE");
  }
};

const authorize = async (options: ApiTruthMcpOptions, context: ServerContext): Promise<ApiTruthMcpPrincipal | undefined> => {
  try {
    return parsePrincipal(await options.authenticate(context));
  } catch {
    return undefined;
  }
};

const selection = (principal: ApiTruthMcpPrincipal, repositoryId: string,
  serviceId: string, view: z.output<typeof viewSchema>): QuerySelection => ({
  version: "1",
  tenantId: principal.tenantId,
  repositoryId,
  serviceId,
  selector: view as QuerySelector,
});

const execute = async (options: ApiTruthMcpOptions, maxOutputBytes: number, context: ServerContext,
  operation: (principal: ApiTruthMcpPrincipal) => Promise<unknown>): Promise<CallToolResult> => {
  const principal = await authorize(options, context);
  if (principal === undefined) return failure("NOT_AUTHORIZED");
  try {
    return result(await operation(principal), maxOutputBytes);
  } catch (error) {
    return failure(mapQueryError(error));
  }
};

const parseOutputLimit = (value: number | undefined): number => {
  const candidate = value ?? DEFAULT_MAX_OUTPUT_BYTES;
  if (!Number.isSafeInteger(candidate) || candidate < MIN_MAX_OUTPUT_BYTES || candidate > MAX_MAX_OUTPUT_BYTES)
    throw new TypeError("INVALID_MCP_OUTPUT_LIMIT");
  return candidate;
};

export const createApiTruthMcpServer = (options: ApiTruthMcpOptions): McpServer => {
  if (options === null || typeof options !== "object" || typeof options.authenticate !== "function"
    || options.query === null || typeof options.query !== "object") throw new TypeError("INVALID_MCP_OPTIONS");
  const maxOutputBytes = parseOutputLimit(options.maxOutputBytes);
  const server = new McpServer({ name: "api-truth", version: "0.0.0" }, {
    instructions: "Read-only API Truth catalog. Every contract read uses an explicit revision, branch, or environment view and returns immutable pins when resolved.",
  });

  server.registerTool("api_truth_search_services", {
    title: "Search API services",
    description: "Search authorized API services, optionally with status and immutable pins for one environment.",
    inputSchema: searchSchema,
    outputSchema,
    annotations: readOnlyAnnotations,
  }, async (args, context) => execute(options, maxOutputBytes, context, async (principal) =>
    options.query.searchServices(principal, {
      tenantId: principal.tenantId,
      query: args.query,
      limit: args.maxResults,
      ...(args.environment === undefined ? {} : { environment: args.environment }),
    })));

  server.registerTool("api_truth_get_contract", {
    title: "Get API contract",
    description: "Read an authorized contract from an explicit view. Returns status when unavailable and immutable catalog/publication pins when resolved.",
    inputSchema: selectionSchema,
    outputSchema,
    annotations: readOnlyAnnotations,
  }, async (args, context) => execute(options, maxOutputBytes, context, async (principal) =>
    options.query.readContract(principal, selection(principal, args.repositoryId, args.serviceId, args.view))));

  server.registerTool("api_truth_get_endpoint", {
    title: "Get API endpoint",
    description: "Read one endpoint from an explicit view, with immutable catalog and publication pins.",
    inputSchema: endpointSchema,
    outputSchema,
    annotations: readOnlyAnnotations,
  }, async (args, context) => execute(options, maxOutputBytes, context, async (principal) =>
    options.query.readEndpoint(principal,
      selection(principal, args.repositoryId, args.serviceId, args.view), args.endpointId)));

  server.registerTool("api_truth_get_schema", {
    title: "Get API schema",
    description: "Read one request or response schema from an explicit view, with immutable catalog and publication pins.",
    inputSchema: schemaSchema,
    outputSchema,
    annotations: readOnlyAnnotations,
  }, async (args, context) => execute(options, maxOutputBytes, context, async (principal) =>
    options.query.readSchema(principal,
      selection(principal, args.repositoryId, args.serviceId, args.view), args.schemaId)));

  server.registerTool("api_truth_compare_contracts", {
    title: "Compare API contracts",
    description: "Compare two explicit views of one authorized service and return both immutable catalog and publication pins.",
    inputSchema: comparisonSchema,
    outputSchema,
    annotations: readOnlyAnnotations,
  }, async (args, context) => execute(options, maxOutputBytes, context, async (principal) =>
    options.query.compareContracts(principal,
      selection(principal, args.repositoryId, args.serviceId, args.before),
      selection(principal, args.repositoryId, args.serviceId, args.after))));

  const discoverSemantic = typeof options.semantic?.discover === "function"
    ? options.semantic.discover.bind(options.semantic) : undefined;
  if (discoverSemantic) {
    server.registerTool("api_truth_discover_api", {
      title: "Find an API for an intent",
      description: "Sends selected endpoint documentation, eligible source route and handler identifiers, and task text to the host-configured inference provider. It suggests matching endpoints with evidence citations; results are inferred, unreviewed, and non-normative, and contextCoverage reports selected operations that lacked usable context.",
      inputSchema: discoverySchema, outputSchema, annotations: {...readOnlyAnnotations, idempotentHint: false, openWorldHint: true},
    }, async (args, context) => execute(options, maxOutputBytes, context, async (principal) =>
      discoverSemantic(principal,
        selection(principal, args.repositoryId, args.serviceId, args.view),
        args.endpointIds, args.intentQuery)));
  }

  if (typeof options.query.readOperationCandidates === "function") {
    const readCandidates = options.query.readOperationCandidates.bind(options.query);
    server.registerTool("api_truth_search_api_candidates", {
      title: "Find API candidates by keywords",
      description: "Search only the current authorized environment snapshot for keyword-overlapping operations. Results are deterministic candidates with citations and completeness flags; no inference provider is called.",
      inputSchema: candidateSchema, outputSchema, annotations: readOnlyAnnotations,
    }, async (args, context) => execute(options, maxOutputBytes, context, async principal =>
      readCandidates(principal, selection(principal, args.repositoryId, args.serviceId, args.view),
        {intentQuery: args.intentQuery, limit: args.maxResults})));
  }

  if (typeof options.query.readMetadataObservations === "function") {
    const readObservations = options.query.readMetadataObservations.bind(options.query);
    server.registerTool("api_truth_get_observations", {
      title: "Get API runtime metadata",
      description: "Read sanitized runtime metadata for the current authorized environment pin. Samples do not establish schemas, required fields or authentication.",
      inputSchema: observationSchema, outputSchema, annotations: readOnlyAnnotations,
    }, async (args, context) => execute(options, maxOutputBytes, context, async principal =>
      readObservations(principal, selection(principal, args.repositoryId, args.serviceId,
        {kind: "environment", environment: args.environment,
          ...(args.expectedCheckpointVersion === undefined ? {} : {expectedCheckpointVersion: args.expectedCheckpointVersion})}),
      {limit: args.maxResults, ...(args.endpointId === undefined ? {} : {endpointId: args.endpointId})})));
  }
  return server;
};
