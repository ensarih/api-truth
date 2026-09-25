import { describe, expect, test } from "vitest";

import { catalogBranchAdvisoryKey } from "../../packages/catalog/src/index.js";

describe("catalog orchestration advisory key", () => {
  test("is deterministic and keeps length-delimited branch scopes distinct", () => {
    const first = { tenantId: "ab", repositoryId: "c", serviceId: "d", branch: "ef" };
    const same = structuredClone(first);
    const differentPartition = { tenantId: "a", repositoryId: "bc", serviceId: "d", branch: "ef" };

    expect(catalogBranchAdvisoryKey(first)).toBe(catalogBranchAdvisoryKey(same));
    expect(catalogBranchAdvisoryKey(first)).not.toBe(catalogBranchAdvisoryKey(differentPartition));
  });

  test("rejects invalid and hostile values without leaking them", () => {
    const secret = "branch-key-secret";
    const hostile = new Proxy({}, { get: () => { throw new Error(secret); } });
    for (const input of [
      { tenantId: "", repositoryId: "repository", serviceId: "service", branch: secret },
      hostile,
    ]) {
      let error: unknown;
      try {
        catalogBranchAdvisoryKey(input as never);
      } catch (caught) {
        error = caught;
      }
      expect(error).toMatchObject({ code: "INVALID_CATALOG_INPUT" });
      expect(`${String(error)} ${JSON.stringify(error)}`).not.toContain(secret);
    }
  });
});
