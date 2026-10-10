import {expect, test} from "vitest";
import * as query from "../../packages/query/src/index.js";

test("the query package exposes the reviewed read and selection boundaries", () => {
  expect(Object.keys(query).sort()).toEqual([
    "LoadedDocumentVerificationReadError", "QueryReadError", "QuerySelectionError",
    "createLoadedDocumentVerificationReadStore", "createQueryReader", "parseQuerySelection",
    "projectEnvironmentSelection", "readQueryContractWithClient", "searchOperationCandidates",
    "validateOperationSearchOptions",
  ]);
});
