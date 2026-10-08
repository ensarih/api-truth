import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
if (process.version !== "v24.6.0") throw new Error("Run the harness with the repository's pinned Node 24.6.0");
const child = spawn(process.execPath, ["--test", "--test-concurrency=1", fileURLToPath(new URL("./runtime.test.mjs", import.meta.url))],
  {stdio: "inherit", cwd: fileURLToPath(new URL("../../../", import.meta.url))});
child.on("error", () => { process.exitCode = 1; });
child.on("exit", (code, signal) => { process.exitCode = signal ? 1 : code ?? 1; });
