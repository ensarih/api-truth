import { Buffer } from "node:buffer";
import {isProxy} from "node:util/types";
import { McpServer, type CallToolResult, type ServerContext } from "@modelcontextprotocol/server";
import type { QueryReader, QueryObservationReader, QueryOperationReader, QueryCorpusOperationReader,
  QuerySelection, QuerySelector } from "@api-truth/query";
import {isSemanticIntentQuerySafe} from "../../../packages/semantics/src/egress.js";
import type { createSemanticService } from "../../../packages/semantics/src/service.js";
import type { createSemanticCorpusService } from "../../../packages/semantics/src/corpus-service.js";
import type { createSyntheticExampleService } from "../../../packages/observations/src/example-service.js";
import type {createFieldPresenceQueryStore} from "../../../packages/observations/src/field-presence-query-store.js";
import type {createLoadedDocumentVerificationReadStore} from "@api-truth/query";
import * as z from "zod/v4";

export type ApiTruthMcpPrincipal = Readonly<{ tenantId: string; principalId: string }>;

export type ApiTruthMcpOptions = Readonly<{
  query: Pick<QueryReader, "searchServices" | "readContract" | "readEndpoint" | "readSchema" | "compareContracts">
    & Partial<QueryObservationReader & QueryOperationReader & QueryCorpusOperationReader>;
  authenticate(context: ServerContext): Promise<ApiTruthMcpPrincipal | undefined>;
  maxOutputBytes?: number;
  semantic?: Pick<ReturnType<typeof createSemanticService>, "discover">;
  semanticHistory?: Partial<Pick<ReturnType<typeof createSemanticService>, "readHistory" | "readHistoryReviews" | "recordHistoryReview">>;
  corpusSemantic?: Pick<ReturnType<typeof createSemanticCorpusService>, "discoverAcrossServices">;
  examples?: Pick<ReturnType<typeof createSyntheticExampleService>, "generate">;
  presence?: Pick<ReturnType<typeof createFieldPresenceQueryStore>, "readForPrincipal">;
  loadedDocumentVerification?: Pick<ReturnType<typeof createLoadedDocumentVerificationReadStore>, "readForPrincipal">;
}>;

const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
const MIN_MAX_OUTPUT_BYTES = 1024;
const MAX_MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_IDENTIFIER_LENGTH = 512;

const publicErrors = [
  "NOT_AUTHORIZED",
  "NOT_FOUND_OR_DENIED",
  "STALE_SELECTION",
  "REVIEW_CONFLICT",
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
const reviewVersion = z.string().regex(/^(?:0|[1-9][0-9]{0,18})$/)
  .refine((value) => BigInt(value) <= 9223372036854775806n);

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
const semanticHistorySelectionSchema = z.object({repositoryId: boundedIdentifier, serviceId: boundedIdentifier,
  view: discoveryViewSchema, endpointIds: z.array(boundedIdentifier).min(1).max(16)
    .refine((ids) => new Set(ids).size === ids.length)}).strict();
const semanticHistorySchema = semanticHistorySelectionSchema.extend({limit: z.number().int().min(1).max(20)}).strict();
const semanticHistoryReviewsSchema = semanticHistorySchema.extend({historyId: databaseVersion}).strict();
const semanticHistoryReviewSchema = semanticHistorySelectionSchema.extend({historyId: databaseVersion,
  decision: z.enum(["acknowledged", "follow_up", "dismissed"]), expectedVersion: reviewVersion}).strict();
const observationSchema = z.object({repositoryId: boundedIdentifier, serviceId: boundedIdentifier,
  environment: boundedIdentifier, expectedCheckpointVersion: databaseVersion.optional(),
  endpointId: boundedIdentifier.optional(), maxResults: z.number().int().min(1).max(100).default(20)}).strict();
const candidateSchema = z.object({repositoryId: boundedIdentifier, serviceId: boundedIdentifier,
  view: discoveryEnvironmentView, intentQuery: z.string().min(1).max(512)
    .regex(/^[^\u0000-\u001f\u007f]+$/), maxResults: z.number().int().min(1).max(20).default(20)}).strict();
const corpusCandidateSchema = z.object({environment: boundedIdentifier,
  intentQuery: z.string().min(1).max(512).regex(/^[^\u0000-\u001f\u007f]+$/)
    .refine(isSemanticIntentQuerySafe),
  maxResults: z.number().int().min(1).max(20).default(20)}).strict();
const corpusDiscoverySchema=z.object({environment:boundedIdentifier,
  intentQuery:z.string().min(1).max(512).regex(/^[^\u0000-\u001f\u007f]+$/)
    .refine(isSemanticIntentQuerySafe),limit:z.number().int().min(1).max(16)}).strict();
const syntheticExampleSchema = z.object({repositoryId: boundedIdentifier,serviceId: boundedIdentifier,
  environment: boundedIdentifier,expectedCheckpointVersion: databaseVersion,
  policyId: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)}).strict();
const presenceIdentifier=z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const loadedDocumentIdentifier=z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/);
const fieldPresenceSchema=z.object({repositoryId:presenceIdentifier,serviceId:presenceIdentifier,
  environment:presenceIdentifier,snapshotId:presenceIdentifier,revision:presenceIdentifier,
  configFingerprint:z.string().regex(/^sha256:[0-9a-f]{64}$/),checkpointVersion:databaseVersion,
  policyId:presenceIdentifier,ownerPolicyRevision:databaseVersion,limit:z.number().int().min(1).max(100)}).strict();
const loadedDocumentVerificationSchema=z.object({repositoryId:loadedDocumentIdentifier,serviceId:loadedDocumentIdentifier,
  environment:loadedDocumentIdentifier,snapshotId:loadedDocumentIdentifier,revision:z.string().regex(/^[A-Fa-f0-9]{12,128}$/),
  configFingerprint:z.string().regex(/^sha256:[0-9a-f]{64}$/),checkpointVersion:databaseVersion,
  configActivationCheckpoint:databaseVersion,loadIdentityDigest:z.string().regex(/^sha256:[0-9a-f]{64}$/)}).strict();

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
  if (error === null || typeof error !== "object" || isProxy(error)) return "QUERY_UNAVAILABLE";
  let descriptor:PropertyDescriptor|undefined;
  try{descriptor=Object.getOwnPropertyDescriptor(error,"code");}catch{return "QUERY_UNAVAILABLE";}
  if (descriptor === undefined || !("value" in descriptor)) return "QUERY_UNAVAILABLE";
  switch (descriptor.value) {
    case "QUERY_NOT_FOUND_OR_DENIED": return "NOT_FOUND_OR_DENIED";
    case "QUERY_STALE_SELECTION": return "STALE_SELECTION";
    case "QUERY_RESULT_LIMIT_EXCEEDED": return "RESULT_LIMIT_EXCEEDED";
    case "INVALID_QUERY_SEARCH": return "INVALID_REQUEST";
    case "SEMANTIC_NOT_FOUND_OR_DENIED": return "NOT_FOUND_OR_DENIED";
    case "SEMANTIC_STALE_CONTEXT": return "STALE_SELECTION";
    case "SEMANTIC_REVIEW_CONFLICT": return "REVIEW_CONFLICT";
    case "SEMANTIC_INVALID_REQUEST": return "INVALID_REQUEST";
    case "SEMANTIC_CORPUS_INVALID_REQUEST": return "INVALID_REQUEST";
    case "SEMANTIC_CORPUS_STALE_CONTEXT": return "STALE_SELECTION";
    case "SEMANTIC_CORPUS_UNAVAILABLE": return "QUERY_UNAVAILABLE";
    case "EXAMPLE_NOT_FOUND_OR_DENIED": return "NOT_FOUND_OR_DENIED";
    case "EXAMPLE_STALE_CONTEXT": return "STALE_SELECTION";
    case "EXAMPLE_INVALID_REQUEST": return "INVALID_REQUEST";
    case "FIELD_PRESENCE_QUERY_UNAUTHORIZED": return "NOT_FOUND_OR_DENIED";
    case "FIELD_PRESENCE_QUERY_STALE": return "STALE_SELECTION";
    case "FIELD_PRESENCE_QUERY_INVALID_REQUEST": return "INVALID_REQUEST";
    case "LOADED_DOCUMENT_READ_UNAUTHORIZED": return "NOT_FOUND_OR_DENIED";
    case "LOADED_DOCUMENT_READ_STALE": return "STALE_SELECTION";
    case "INVALID_LOADED_DOCUMENT_READ_REQUEST": return "INVALID_REQUEST";
    case "LOADED_DOCUMENT_READ_UNAVAILABLE": return "QUERY_UNAVAILABLE";
    case "LOADED_DOCUMENT_READ_STORAGE_ERROR": return "QUERY_UNAVAILABLE";
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
    instructions: "API Truth catalog. Every contract read uses an explicit revision, branch, or environment view and returns immutable pins when resolved. Hosts may enable private same-principal semantic review metadata annotations.",
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

  if (typeof options.semanticHistory?.readHistory === "function") {
    const readHistory = options.semanticHistory.readHistory.bind(options.semanticHistory);
    server.registerTool("api_truth_get_semantic_history", {
      title: "Get private semantic discovery history",
      description: "Read bounded private same-principal discovery metadata for selected endpoints at an explicit authorized pin. Results remain inferred and non-normative; review decisions are metadata annotations only, with no prose approval or model call.",
      inputSchema: semanticHistorySchema, outputSchema, annotations: readOnlyAnnotations,
    }, async (args, context) => execute(options, maxOutputBytes, context, async principal =>
      readHistory(principal, selection(principal, args.repositoryId, args.serviceId, args.view),
        args.endpointIds, args.limit)));
  }
  if (typeof options.semanticHistory?.readHistoryReviews === "function") {
    const readHistoryReviews = options.semanticHistory.readHistoryReviews.bind(options.semanticHistory);
    server.registerTool("api_truth_get_semantic_history_reviews", {
      title: "Get private semantic history review metadata",
      description: "Read bounded private same-principal review metadata annotations for one history ID and selected endpoints at an explicit authorized pin. Discovery remains inferred and non-normative, with no prose approval or model call.",
      inputSchema: semanticHistoryReviewsSchema, outputSchema, annotations: readOnlyAnnotations,
    }, async (args, context) => execute(options, maxOutputBytes, context, async principal =>
      readHistoryReviews(principal, selection(principal, args.repositoryId, args.serviceId, args.view),
        args.endpointIds, args.historyId, args.limit)));
  }
  if (typeof options.semanticHistory?.recordHistoryReview === "function") {
    const recordHistoryReview = options.semanticHistory.recordHistoryReview.bind(options.semanticHistory);
    server.registerTool("api_truth_record_semantic_history_review", {
      title: "Record private semantic history review metadata",
      description: "Record a private same-principal acknowledged, follow_up, or dismissed metadata annotation for one history ID and expected review version at an explicit authorized pin. Discovery remains inferred and non-normative, with no prose approval or model call.",
      inputSchema: semanticHistoryReviewSchema, outputSchema,
      annotations: {...readOnlyAnnotations, readOnlyHint: false},
    }, async (args, context) => execute(options, maxOutputBytes, context, async principal =>
      recordHistoryReview(principal, selection(principal, args.repositoryId, args.serviceId, args.view),
        args.endpointIds, {historyId: args.historyId, decision: args.decision, expectedVersion: args.expectedVersion})));
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

  if (typeof options.query.searchOperationCandidatesAcrossServices === "function") {
    const searchCorpus = options.query.searchOperationCandidatesAcrossServices.bind(options.query);
    server.registerTool("api_truth_search_api_corpus", {
      title: "Find API candidates across services",
      description: "Search keyword-overlapping operations in current authorized services for one explicit environment. Each candidate has its own exact serving pin and evidence; incomplete coverage is explicit. No inference provider is called.",
      inputSchema: corpusCandidateSchema, outputSchema, annotations: readOnlyAnnotations,
    }, async (args, context) => execute(options, maxOutputBytes, context, async principal =>
      searchCorpus(principal, {tenantId: principal.tenantId, environment: args.environment,
        intentQuery: args.intentQuery, limit: args.maxResults})));
  }

  if(typeof options.corpusSemantic?.discoverAcrossServices==="function"){
    const discoverCorpus=options.corpusSemantic.discoverAcrossServices.bind(options.corpusSemantic);
    server.registerTool("api_truth_discover_api_corpus",{
      title:"Find APIs across services for an intent",
      description:"Searches bounded keyword candidates in authorized services for one environment, then sends eligible selected context and the task text to the host-configured inference provider. Results are per-service inferred, unreviewed and non-normative; they do not establish API-wide absence.",
      inputSchema:corpusDiscoverySchema,outputSchema,
      annotations:{...readOnlyAnnotations,idempotentHint:false,openWorldHint:true},
    },async(args,context)=>execute(options,maxOutputBytes,context,async principal=>
      discoverCorpus(principal,{environment:args.environment,intentQuery:args.intentQuery,limit:args.limit})));
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
  if (typeof options.examples?.generate === "function") {
    const generate=options.examples.generate.bind(options.examples);
    server.registerTool("api_truth_get_synthetic_example", {
      title: "Get a synthetic schema example",
      description: "Generate a deterministic, non-normative placeholder from a host-configured property policy and the exact authorized serving pin. It is not observed traffic or runtime validation evidence.",
      inputSchema: syntheticExampleSchema,outputSchema,annotations: readOnlyAnnotations,
    },async(args,context)=>execute(options,maxOutputBytes,context,async principal=>
      generate(principal,{selection:selection(principal,args.repositoryId,args.serviceId,
        {kind:"environment",environment:args.environment,expectedCheckpointVersion:args.expectedCheckpointVersion}),
      policyId:args.policyId})));
  }
  if(typeof options.presence?.readForPrincipal==="function"){
    const readPresence=options.presence.readForPrincipal.bind(options.presence);
    server.registerTool("api_truth_get_field_presence",{
      title:"Get observed API field presence",
      description:"Read owner-selected, value-free present/absent states for one exact current environment pin and policy generation. These observations are non-normative and do not establish requiredness, schemas or runtime validation. A bounded page reports truncation.",
      inputSchema:fieldPresenceSchema,outputSchema,annotations:readOnlyAnnotations,
    },async(args,context)=>execute(options,maxOutputBytes,context,async principal=>
      readPresence(context,principal,{policyId:args.policyId,ownerPolicyRevision:args.ownerPolicyRevision,limit:args.limit,
        expectedPin:{tenantId:principal.tenantId,repositoryId:args.repositoryId,serviceId:args.serviceId,
          environment:args.environment,snapshotId:args.snapshotId,revision:args.revision,
          configFingerprint:args.configFingerprint,checkpointVersion:args.checkpointVersion}})));
  }
  if(typeof options.loadedDocumentVerification?.readForPrincipal==="function"){
    const readLoadedDocument=options.loadedDocumentVerification.readForPrincipal.bind(options.loadedDocumentVerification);
    server.registerTool("api_truth_get_loaded_document_verification",{
      title:"Get controlled Swagger document load metadata",
      description:"Read non-normative metadata for a signed, source-linked controlled Swagger document load at one exact authorized environment pin. This is controlled-load evidence only; it does not assert deployment, a registered runtime handler, or normative API behavior.",
      inputSchema:loadedDocumentVerificationSchema,outputSchema,annotations:readOnlyAnnotations,
    },async(args,context)=>execute(options,maxOutputBytes,context,async principal=>
      readLoadedDocument(context,principal,{loadIdentityDigest:args.loadIdentityDigest,
        expectedPin:{tenantId:principal.tenantId,repositoryId:args.repositoryId,serviceId:args.serviceId,
          environment:args.environment,snapshotId:args.snapshotId,revision:args.revision,
          configFingerprint:args.configFingerprint,checkpointVersion:args.checkpointVersion},
        configActivationCheckpoint:args.configActivationCheckpoint})));
  }
  return server;
};
