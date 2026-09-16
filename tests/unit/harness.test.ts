import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

describe("offline unit test harness", () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories.splice(0).map((directory) =>
        rm(directory, { recursive: true, force: true }),
      ),
    );
  });

  test("runs an isolated asynchronous filesystem assertion", async () => {
    const directory = await mkdtemp(join(tmpdir(), "api-truth-harness-"));
    temporaryDirectories.push(directory);
    const marker = join(directory, "runner.txt");

    await writeFile(marker, "runner-ready", "utf8");

    expect(await readFile(marker, "utf8")).toBe("runner-ready");
  });
});
