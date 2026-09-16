import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const sourceFixturesRoot = join(repositoryRoot, "fixtures");
const checkerPath = join(sourceFixturesRoot, "tests", "validate-fixtures.mjs");
const temporaryDirectories: string[] = [];

interface TypeScriptExpected {
  mounts: Array<{ source: string }>;
  routes: Array<{ id: string; application_path: string }>;
}

interface LifecycleExpected {
  cases: Array<{
    id: string;
    steps: Array<{
      event: string;
      environment?: string;
      expected: { contract_resolution: Record<string, string> };
    }>;
  }>;
}

async function copiedFixtures(): Promise<string> {
  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), "api-truth-fixtures-"),
  );
  temporaryDirectories.push(temporaryDirectory);
  const fixturesRoot = join(temporaryDirectory, "fixtures");
  await cp(sourceFixturesRoot, fixturesRoot, { recursive: true });
  return fixturesRoot;
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function validateFixtures(fixturesRoot: string = sourceFixturesRoot) {
  return spawnSync(process.execPath, [checkerPath], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: { ...process.env, FIXTURES_ROOT: fixturesRoot },
  });
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("D02 fixture integrity contract", () => {
  test("accepts the reviewed fixture catalog", () => {
    const result = validateFixtures();

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Fixture validation passed");
  });

  test("rejects malformed JSON anywhere in the fixture tree", async () => {
    const fixturesRoot = await copiedFixtures();
    await writeFile(join(fixturesRoot, "malformed.json"), "{", "utf8");

    const result = validateFixtures(fixturesRoot);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("malformed.json is not valid JSON");
  });

  test("rejects a catalog entry whose evidence source is missing", async () => {
    const fixturesRoot = await copiedFixtures();
    const expectedPath = join(
      fixturesRoot,
      "typescript/orders/baseline/expected.json",
    );
    const expected = await readJson<TypeScriptExpected>(expectedPath);
    expected.mounts[0]!.source =
      "typescript/orders/baseline/src/missing-app.ts";
    await writeJson(expectedPath, expected);

    const result = validateFixtures(fixturesRoot);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("baseline: mount evidence mismatch");
  });

  test("rejects a route expectation that disagrees with its mounted path", async () => {
    const fixturesRoot = await copiedFixtures();
    const expectedPath = join(
      fixturesRoot,
      "typescript/orders/baseline/expected.json",
    );
    const expected = await readJson<TypeScriptExpected>(expectedPath);
    const route = expected.routes.find((item) => item.id === "get-order");
    expect(route).toBeDefined();
    route!.application_path = "/wrong/orders/:orderId";
    await writeJson(expectedPath, expected);

    const result = validateFixtures(fixturesRoot);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "baseline: application path mismatch for get-order",
    );
  });

  test("rejects lifecycle resolution that contradicts serving evidence", async () => {
    const fixturesRoot = await copiedFixtures();
    const casesPath = join(fixturesRoot, "lifecycle/cases.json");
    const lifecycle = await readJson<LifecycleExpected>(casesPath);
    const lifecycleCase = lifecycle.cases.find(
      (item) => item.id === "uat-only-deployment",
    );
    const observation = lifecycleCase?.steps.find(
      (step) => step.event === "serving_observed",
    );
    expect(observation).toBeDefined();
    observation!.expected.contract_resolution.uat = "rev-wrong";
    await writeJson(casesPath, lifecycle);

    const result = validateFixtures(fixturesRoot);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "lifecycle: contract resolution mismatch for uat-only-deployment",
    );
  });
});
