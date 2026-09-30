import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const execute = promisify(execFile);
const root = new URL("../../", import.meta.url).pathname;

test("the documented local OpenAPI walkthrough recovers from stale publication", async () => {
  const { stdout, stderr } = await execute(process.execPath,
    ["--disable-warning=ExperimentalWarning", "--experimental-transform-types",
      "scripts/openapi-roundtrip.ts"], { cwd: root });
  expect(stderr).toBe("");
  const result = JSON.parse(stdout) as Record<string, unknown>;
  expect(result).toMatchObject({ outcome: "passed", pointerVersion: "2",
    staleRejected: true, historicalReadable: true });
  expect(result.firstPublicationId).not.toBe(result.currentPublicationId);
  expect(result.currentContentSha256).toMatch(/^sha256:[0-9a-f]{64}$/);
});
