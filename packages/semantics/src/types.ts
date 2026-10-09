import type {ContractSnapshot} from "../../ir/src/index.js";
import type {QueryPin} from "../../query/src/reader.js";
import type {QuerySelection} from "../../query/src/selector.js";

export type SemanticProviderId = "openai" | "gemini" | "claude";
export type SemanticDocumentKind = "operation_summary" | "operation_description"
  | "response_description" | "operation_id";
type SemanticProviderContext = Readonly<{
  provider: SemanticProviderId;
  model: string;
  source: Readonly<{repositoryId: string; serviceId: string; selector: QuerySelection["selector"];
    pin: QueryPin}>;
  endpoints: readonly Readonly<{endpointId: string; method: string; applicationPath: string;
    documents: readonly Readonly<{kind: SemanticDocumentKind; text: string;
      evidenceIds: readonly string[]}>[]}>[];
}>;
export type SemanticProviderRequest =
  | Readonly<SemanticProviderContext & {promptVersion: "semantic-grounding-1"}>
  | Readonly<SemanticProviderContext & {promptVersion: "semantic-discovery-1"; intentQuery: string}>;
export type SemanticProviderPort = (request: SemanticProviderRequest) => Promise<unknown>;
export type SemanticAnalysisInput = Readonly<{
  snapshot: ContractSnapshot;
  pin: QueryPin;
  selection: QuerySelection;
  inference: Readonly<{enabled: boolean; provider?: SemanticProviderId; model?: string}>;
  endpointIds: readonly string[];
}>;
export type SemanticDiscoveryInput = Readonly<SemanticAnalysisInput & {intentQuery: string}>;
export type SemanticSuggestion = Readonly<{endpointId: string; intent: string; summary: string;
  evidenceIds: readonly string[]}>;
export type SemanticProvenance = Readonly<{provider: SemanticProviderId; model: string;
  promptVersion: SemanticProviderRequest["promptVersion"]; selector: QuerySelection["selector"]; pin: QueryPin}>;
export type SemanticAnalysisResult =
  | Readonly<{status: "disabled" | "no_context"}>
  | Readonly<{status: "suggestions"; suggestions: readonly SemanticSuggestion[];
    verification: "inferred"; review: "unreviewed"; normative: false; provenance: SemanticProvenance}>
  | Readonly<{status: "ambiguous"; candidateEndpointIds: readonly string[]; reason: string;
    verification: "inferred"; review: "unreviewed"; normative: false; provenance: SemanticProvenance}>
  | Readonly<{status: "no_match"; reason: string;
    verification: "inferred"; review: "unreviewed"; normative: false; provenance: SemanticProvenance}>;
