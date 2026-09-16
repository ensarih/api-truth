import { describe, expect, test } from "vitest";

import {
  FIXED_TEST_DATABASE_URL,
  assertSafeTestDatabaseUrl,
  createTestEnvironmentController,
  runTestEnvironmentCommand,
  type ProcessInvocation,
  type ProcessResult,
  type ProcessTransport,
  type TestEnvironmentController,
} from "../../scripts/test-environment-lib.js";

class RecordingTransport implements ProcessTransport {
  readonly invocations: ProcessInvocation[] = [];
  private readonly results: ProcessResult[];

  constructor(results: ProcessResult[]) {
    this.results = [...results];
  }

  async run(invocation: ProcessInvocation): Promise<ProcessResult> {
    this.invocations.push(invocation);
    const result = this.results.shift();
    if (result === undefined) throw new Error("test transport ran out of results");
    return result;
  }
}

const ok = (stdout = ""): ProcessResult => ({ exitCode: 0, stdout, stderr: "" });
const failed = (stderr: string): ProcessResult => ({ exitCode: 1, stdout: "", stderr });

describe("test database target safety", () => {
  test("accepts only the fixed loopback test database", () => {
    expect(assertSafeTestDatabaseUrl(FIXED_TEST_DATABASE_URL)).toEqual({
      hostname: "127.0.0.1",
      port: 55432,
      database: "api_truth_test",
      username: "api_truth_test",
    });
  });

  test.each([
    "postgresql://api_truth_test:synthetic-only@db.internal:55432/api_truth_test",
    "postgresql://api_truth_test:synthetic-only@127.0.0.1:5432/api_truth_test",
    "postgresql://api_truth_test:synthetic-only@127.0.0.1:55432/production",
    "postgresql://postgres:synthetic-only@127.0.0.1:55432/api_truth_test",
    "postgresql://api_truth_test:real-secret@127.0.0.1:55432/api_truth_test",
    "postgresql://api_truth_test:synthetic-only@127.0.0.1:55432/api_truth_test?sslmode=require",
    "not-a-database-url",
  ])("rejects unsafe target %s before running a process", async (databaseUrl) => {
    const transport = new RecordingTransport([]);
    const controller = createTestEnvironmentController(transport);

    await expect(controller.ready(databaseUrl)).rejects.toMatchObject({
      name: "TestEnvironmentError",
      code: "unsafe-database-target",
    });
    expect(transport.invocations).toEqual([]);
  });
});

describe("test environment lifecycle failures", () => {
  test("reports a missing Docker engine separately", async () => {
    const transport = new RecordingTransport([failed("Cannot connect to the Docker daemon")]);

    await expect(createTestEnvironmentController(transport).up()).rejects.toEqual(
      expect.objectContaining({
        name: "TestEnvironmentError",
        code: "engine-unavailable",
      }),
    );
    expect(transport.invocations).toEqual([
      { command: "docker", args: ["info", "--format", "{{.ServerVersion}}"] },
    ]);
  });

  test("reports database startup failure after Docker is available", async () => {
    const transport = new RecordingTransport([ok("29.3.1"), failed("postgres did not become healthy")]);

    await expect(createTestEnvironmentController(transport).up()).rejects.toMatchObject({
      code: "database-startup-failed",
      detail: "postgres did not become healthy",
    });
  });

  test("reports an unavailable database before the SQL probe", async () => {
    const transport = new RecordingTransport([ok("29.3.1"), failed("no response")]);

    await expect(createTestEnvironmentController(transport).ready()).rejects.toMatchObject({
      code: "database-unavailable",
      detail: "no response",
    });
    expect(transport.invocations).toHaveLength(2);
  });

  test("reports a failed SQL probe separately", async () => {
    const transport = new RecordingTransport([ok("29.3.1"), ok("accepting connections"), failed("role rejected")]);

    await expect(createTestEnvironmentController(transport).ready()).rejects.toMatchObject({
      code: "sql-probe-failed",
      detail: "role rejected",
    });
    expect(transport.invocations).toHaveLength(3);
  });
});

describe("fixed Compose resource boundary", () => {
  test("starts only the fixed project and waits at most sixty seconds", async () => {
    const transport = new RecordingTransport([ok("29.3.1"), ok()]);

    await createTestEnvironmentController(transport).up();

    expect(transport.invocations[1]).toEqual({
      command: "docker",
      args: [
        "compose",
        "--project-name",
        "api-truth-test",
        "--file",
        "deploy/compose.test.yml",
        "up",
        "--detach",
        "--wait",
        "--wait-timeout",
        "60",
      ],
    });
  });

  test("tears down only the fixed project resources", async () => {
    const transport = new RecordingTransport([ok("29.3.1"), ok()]);

    await createTestEnvironmentController(transport).down();

    expect(transport.invocations[1]).toEqual({
      command: "docker",
      args: [
        "compose",
        "--project-name",
        "api-truth-test",
        "--file",
        "deploy/compose.test.yml",
        "down",
        "--volumes",
        "--remove-orphans",
        "--timeout",
        "5",
      ],
    });
  });
});

describe("test environment command dispatch", () => {
  test.each(["up", "ready", "down"] as const)("dispatches %s to the matching operation", async (command) => {
    const calls: string[] = [];
    const controller: TestEnvironmentController = {
      up: async () => { calls.push("up"); },
      ready: async () => { calls.push("ready"); },
      down: async () => { calls.push("down"); },
    };

    await expect(runTestEnvironmentCommand(command, controller)).resolves.toBe(
      `api-truth test environment ${command} complete`,
    );
    expect(calls).toEqual([command]);
  });

  test("rejects an unknown command without touching the environment", async () => {
    const calls: string[] = [];
    const controller: TestEnvironmentController = {
      up: async () => { calls.push("up"); },
      ready: async () => { calls.push("ready"); },
      down: async () => { calls.push("down"); },
    };

    await expect(runTestEnvironmentCommand("reset", controller)).rejects.toMatchObject({
      code: "invalid-command",
    });
    expect(calls).toEqual([]);
  });
});
