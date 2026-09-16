export const FIXED_TEST_DATABASE_URL =
  "postgresql://api_truth_test:synthetic-only@127.0.0.1:55432/api_truth_test";

export type ProcessInvocation = {
  command: string;
  args: string[];
};

export type ProcessResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export interface ProcessTransport {
  run(invocation: ProcessInvocation): Promise<ProcessResult>;
}

export interface TestEnvironmentController {
  up(): Promise<void>;
  ready(databaseUrl?: string): Promise<void>;
  down(): Promise<void>;
}

export class TestEnvironmentError extends Error {
  readonly code: string;
  readonly detail: string;

  constructor(code: string, detail: string) {
    super(detail);
    this.name = "TestEnvironmentError";
    this.code = code;
    this.detail = detail;
  }
}

export type SafeTestDatabaseTarget = {
  hostname: "127.0.0.1";
  port: 55432;
  database: "api_truth_test";
  username: "api_truth_test";
};

const unsafeTarget = (): TestEnvironmentError => new TestEnvironmentError(
  "unsafe-database-target",
  "only the fixed loopback api-truth test database is allowed",
);

export const assertSafeTestDatabaseUrl = (databaseUrl: string): SafeTestDatabaseTarget => {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw unsafeTarget();
  }

  if (
    parsed.protocol !== "postgresql:"
    || parsed.hostname !== "127.0.0.1"
    || parsed.port !== "55432"
    || parsed.pathname !== "/api_truth_test"
    || parsed.username !== "api_truth_test"
    || parsed.password !== "synthetic-only"
    || parsed.search !== ""
    || parsed.hash !== ""
  ) {
    throw unsafeTarget();
  }

  return {
    hostname: "127.0.0.1",
    port: 55432,
    database: "api_truth_test",
    username: "api_truth_test",
  };
};

const engineInvocation: ProcessInvocation = {
  command: "docker",
  args: ["info", "--format", "{{.ServerVersion}}"],
};

const composePrefix = [
  "compose",
  "--project-name",
  "api-truth-test",
  "--file",
  "deploy/compose.test.yml",
];

const detailFor = (result: ProcessResult, fallback: string): string =>
  result.stderr.trim() || result.stdout.trim() || fallback;

const requireSuccess = (
  result: ProcessResult,
  code: string,
  fallback: string,
): void => {
  if (result.exitCode !== 0) {
    throw new TestEnvironmentError(code, detailFor(result, fallback));
  }
};

export const createTestEnvironmentController = (transport: ProcessTransport): TestEnvironmentController => {
  const requireEngine = async (): Promise<void> => {
    const result = await transport.run(engineInvocation);
    requireSuccess(result, "engine-unavailable", "Docker engine is unavailable");
  };

  return {
    up: async (): Promise<void> => {
      await requireEngine();
      const result = await transport.run({
        command: "docker",
        args: [...composePrefix, "up", "--detach", "--wait", "--wait-timeout", "60"],
      });
      requireSuccess(result, "database-startup-failed", "PostgreSQL did not become healthy");
    },

    ready: async (databaseUrl = FIXED_TEST_DATABASE_URL): Promise<void> => {
      assertSafeTestDatabaseUrl(databaseUrl);
      await requireEngine();

      const readiness = await transport.run({
        command: "docker",
        args: [
          ...composePrefix,
          "exec",
          "--no-TTY",
          "postgres",
          "pg_isready",
          "--username",
          "api_truth_test",
          "--dbname",
          "api_truth_test",
        ],
      });
      requireSuccess(readiness, "database-unavailable", "PostgreSQL is unavailable");

      const sqlProbe = await transport.run({
        command: "docker",
        args: [
          ...composePrefix,
          "exec",
          "--no-TTY",
          "postgres",
          "psql",
          "--username",
          "api_truth_test",
          "--dbname",
          "api_truth_test",
          "--set",
          "ON_ERROR_STOP=1",
          "--tuples-only",
          "--command",
          "SELECT 1;",
        ],
      });
      requireSuccess(sqlProbe, "sql-probe-failed", "PostgreSQL SQL probe failed");
    },

    down: async (): Promise<void> => {
      await requireEngine();
      const result = await transport.run({
        command: "docker",
        args: [...composePrefix, "down", "--volumes", "--remove-orphans", "--timeout", "5"],
      });
      requireSuccess(result, "database-teardown-failed", "PostgreSQL teardown failed");
    },
  };
};

export const runTestEnvironmentCommand = async (
  command: string,
  controller: TestEnvironmentController,
): Promise<string> => {
  if (command !== "up" && command !== "ready" && command !== "down") {
    throw new TestEnvironmentError("invalid-command", "expected one of: up, ready, down");
  }
  await controller[command]();
  return `api-truth test environment ${command} complete`;
};
