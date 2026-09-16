import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  TestEnvironmentError,
  createTestEnvironmentController,
  runTestEnvironmentCommand,
  type ProcessInvocation,
  type ProcessResult,
  type ProcessTransport,
} from "./test-environment-lib.ts";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

const processTransport: ProcessTransport = {
  run: (invocation: ProcessInvocation): Promise<ProcessResult> => new Promise((resolve) => {
    execFile(
      invocation.command,
      invocation.args,
      { cwd: repositoryRoot, encoding: "utf8" },
      (error, stdout, stderr) => {
        const systemCode = error !== null && "code" in error && error.code === "ENOENT" ? 127 : 1;
        resolve({
          exitCode: error === null ? 0 : systemCode,
          stdout,
          stderr: stderr || (error?.message ?? ""),
        });
      },
    );
  }),
};

const command = process.argv[2] ?? "";

try {
  const message = await runTestEnvironmentCommand(
    command,
    createTestEnvironmentController(processTransport),
  );
  process.stdout.write(`${message}\n`);
} catch (error) {
  if (error instanceof TestEnvironmentError) {
    process.stderr.write(`api-truth test environment error [${error.code}]: ${error.detail}\n`);
  } else {
    process.stderr.write(`api-truth test environment error: ${String(error)}\n`);
  }
  process.exitCode = 1;
}
