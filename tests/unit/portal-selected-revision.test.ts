import {once} from "node:events";
import {readFile} from "node:fs/promises";
import {afterEach, expect, test, vi} from "vitest";
import {createPortalServer, type PortalOptions} from "../../apps/portal/src/server.js";
import type {ContractSnapshot} from "../../packages/ir/src/index.js";
import type {QueryReader, QuerySelection, QueryOperationReader, OperationSearchResult,
  QueryCorpusOperationReader, CorpusOperationSearchResult, QueryPin} from "../../packages/query/src/index.js";
import type {SemanticAnalysisResult} from "../../packages/semantics/src/types.js";

const principal = {tenantId: "tenant-a", principalId: "reader-a"};
const selected: QuerySelection = {version: "1", tenantId: principal.tenantId, repositoryId: "commerce", serviceId: "orders",
  selector: {kind: "environment", environment: "uat", expectedCheckpointVersion: "7"}};
const evidenceRevision = "a".repeat(40);
const selectedRevision = "b".repeat(40);
const selectedPin = {snapshotId: "snapshot-a", revision: evidenceRevision, selectedRevision,
  configFingerprint: "sha256:" + "c".repeat(64), checkpointVersion: "7"};
const suggestion = (pin: QueryPin) => ({status: "suggestions" as const,
  suggestions: [{endpointId: "ep-get", intent: "Find orders", summary: "Returns orders", evidenceIds: ["ev-route"]}],
  verification: "inferred" as const, review: "unreviewed" as const, normative: false as const,
  contextCoverage: {status: "complete" as const, requestedEndpointIds: ["ep-get"], analyzedEndpointIds: ["ep-get"],
    omittedEndpointIds: []},
  provenance: {provider: "openai" as const, model: "test-model", promptVersion: "semantic-discovery-1",
    selector: selected.selector, pin}} satisfies SemanticAnalysisResult);
const searchResult = (pin: QueryPin): OperationSearchResult => ({status: "candidates", matchMode: "keyword",
  selector: selected, pin, candidates: [{endpointId: "ep-get", method: "GET", path: "/orders", label: "Find orders",
    evidenceIds: ["ev-route"], score: 3}], truncated: false, complete: true});
const searchBody = {repositoryId: "commerce", serviceId: "orders", view: {kind: "environment", environment: "uat",
  expectedCheckpointVersion: "7"}, intentQuery: "Find orders", limit: 4};
const discoverBody = {repositoryId: "commerce", serviceId: "orders", view: searchBody.view,
  intentQuery: searchBody.intentQuery, endpointIds: ["ep-get"]};

const opened: ReturnType<typeof createPortalServer>[] = [];
afterEach(async () => {await Promise.allSettled(opened.splice(0).map(async server => {
  server.closeAllConnections(); server.close(); await once(server, "close");
}));});

async function startPortal(query: PortalOptions["query"], semantic?: PortalOptions["semantic"]) {
  const baseOptions = {query,
    authenticate: async (request: Parameters<PortalOptions["authenticate"]>[0]) =>
      request.headers.authorization === "Bearer test" ? principal : undefined};
  const server = createPortalServer(semantic === undefined ? baseOptions : {...baseOptions, semantic});
  server.listen(0, "127.0.0.1"); await once(server, "listening"); opened.push(server);
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No test server address");
  const base = `http://127.0.0.1:${address.port}`;
  return (path: string, body: unknown) => fetch(`${base}${path}`, {method: "POST",
    headers: {authorization: "Bearer test", "content-type": "application/json"}, body: JSON.stringify(body)});
}

test.each([
  {surface: "candidate", mismatch: "missing"}, {surface: "candidate", mismatch: "swapped"},
  {surface: "discovery", mismatch: "missing"}, {surface: "discovery", mismatch: "swapped"},
] as const)("$surface response rejects $mismatch selectedRevision pin", async ({surface, mismatch}) => {
  const snapshot = JSON.parse(await readFile(new URL("../fixtures/ir/express-snapshot.json", import.meta.url), "utf8")) as ContractSnapshot;
  snapshot.source.immutable_revision = evidenceRevision;
  const {selectedRevision: _selectedRevision, ...withoutSelectedRevision} = selectedPin;
  const wrongPin: QueryPin = mismatch === "missing" ? withoutSelectedRevision
    : {...selectedPin, selectedRevision: "d".repeat(40)};
  const readOperationCandidates = vi.fn(async (): Promise<OperationSearchResult> => searchResult(wrongPin));
  const query = {searchServices: vi.fn(), readContract: vi.fn(async (_context: unknown, selection: unknown) => ({
    status: "resolved" as const, selector: selection as QuerySelection, pin: selectedPin, snapshot,
    publication: {status: "absent" as const},
  })), readEndpoint: vi.fn(), readSchema: vi.fn(), compareContracts: vi.fn(), readPublication: vi.fn(),
  readOperationCandidates} as unknown as QueryReader & QueryOperationReader
    & {readOperationCandidates: typeof readOperationCandidates};
  const discover = vi.fn(async (): Promise<SemanticAnalysisResult> => suggestion(wrongPin));
  const post = await startPortal(query, {discover});

  if (surface === "candidate") {
    const response = await post("/api/candidates", searchBody);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({error: "STALE_SELECTION"});
    expect(readOperationCandidates).toHaveBeenCalledTimes(1);
    expect(discover).not.toHaveBeenCalled();
  } else {
    const response = await post("/api/discover", discoverBody);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({error: "STALE_SELECTION"});
    expect(discover).toHaveBeenCalledTimes(1);
    expect(readOperationCandidates).not.toHaveBeenCalled();
  }
});

const corpusPin = {snapshotId: "snapshot-a", revision: evidenceRevision, configFingerprint: "sha256:" + "c".repeat(64),
  checkpointVersion: "7"};
const corpusCandidate = (pin: QueryPin) => ({repositoryId: "commerce", serviceId: "orders", endpointId: "ep-get",
  method: "GET", path: "/orders", label: "Find orders", score: 3, evidenceIds: ["ev-route"],
  selector: {version: "1" as const, tenantId: principal.tenantId, repositoryId: "commerce", serviceId: "orders",
    selector: {kind: "environment" as const, environment: "uat", expectedCheckpointVersion: "7"}}, pin});
const corpusResult = (pin: QueryPin): CorpusOperationSearchResult => ({status: "candidates", matchMode: "keyword",
  scope: "visible_authorized_services", environment: "uat", complete: false, truncated: false,
  incompleteReason: "incomplete_scan", candidates: [corpusCandidate(pin)]});

test("corpus result validates optional selectedRevision as a 40-hex revision and rejects extra pin fields", async () => {
  const searchOperationCandidatesAcrossServices = vi.fn(async (): Promise<CorpusOperationSearchResult> => corpusResult(corpusPin));
  const query = {searchServices: vi.fn(), readContract: vi.fn(), readEndpoint: vi.fn(), readSchema: vi.fn(),
    compareContracts: vi.fn(), readPublication: vi.fn(), searchOperationCandidatesAcrossServices} as unknown as QueryReader
      & QueryCorpusOperationReader & {searchOperationCandidatesAcrossServices: typeof searchOperationCandidatesAcrossServices};
  const post = await startPortal(query);
  const body = {environment: "uat", intentQuery: "Find orders", limit: 4};

  expect((await post("/api/corpus-candidates", body)).status).toBe(200);
  expect((await post("/api/corpus-candidates", {...body, selectedRevision})).status).toBe(400);
  const validSelected = {...corpusPin, selectedRevision};
  vi.mocked(searchOperationCandidatesAcrossServices).mockResolvedValueOnce(corpusResult(validSelected));
  expect((await post("/api/corpus-candidates", body)).status).toBe(200);

  const invalidResponses = [];
  for (const malformed of ["g".repeat(40), "a".repeat(11), "a".repeat(129)]) {
    vi.mocked(searchOperationCandidatesAcrossServices).mockResolvedValueOnce(
      corpusResult({...corpusPin, selectedRevision: malformed}));
    invalidResponses.push(await post("/api/corpus-candidates", body));
  }
  vi.mocked(searchOperationCandidatesAcrossServices).mockResolvedValueOnce(
    corpusResult({...validSelected, unexpected: "extra-pin-key"} as QueryPin));
  invalidResponses.push(await post("/api/corpus-candidates", body));
  expect(invalidResponses.map(response => response.status)).toEqual([409, 409, 409, 409]);
  expect(await Promise.all(invalidResponses.map(response => response.json())))
    .toEqual(Array.from({length: 4}, () => ({error: "STALE_SELECTION"})));
  expect(searchOperationCandidatesAcrossServices).toHaveBeenCalledTimes(6);
});
