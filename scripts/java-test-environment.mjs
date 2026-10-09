import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkPinnedJava, installPinnedJava } from "./java-test-environment-lib.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const command = process.argv[2];

try {
  if (command === "up") {
    const result = await installPinnedJava({ repoRoot });
    process.stdout.write(`Temurin ${result.version} ready for ${result.platform} in the project cache.\n`);
  } else if (command === "ready") {
    const result = await checkPinnedJava({ repoRoot });
    process.stdout.write(`Temurin ${result.version} is ready for ${result.platform} (offline check).\n`);
  } else {
    process.stderr.write("Usage: node scripts/java-test-environment.mjs <up|ready>\n");
    process.exitCode = 2;
  }
} catch (error) {
  const message = error?.message === "unsupported_platform"
    ? "This project-local Java test environment supports macOS and Linux x64/arm64 only."
    : error?.message === "runtime_unavailable"
      ? "Pinned Java runtime is not installed. Run the up command while online."
      : error?.message === "runtime_integrity_failed" || error?.message === "archive_integrity_failed"
        ? "Pinned Java runtime integrity check failed. Remove its project cache directory and run the up command again."
        : error?.message === "runtime_version_mismatch"
          ? "Cached Java runtime version does not match the pinned release. Remove its project cache directory and run the up command again."
          : error?.message === "cache_exists_remove_manually"
            ? "Java cache is incomplete. Remove its project cache directory and run the up command again."
            : error?.message === "symlink_path_rejected" || error?.message === "path_outside_cache"
              ? "Project Java cache path failed containment checks."
              : "Pinned Java setup failed; no project code was run.";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
