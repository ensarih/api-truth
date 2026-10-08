import {spawnSync} from "node:child_process";
import {mkdtemp, writeFile, readFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {expect, test} from "vitest";

// The signer must not publish a partial receipt or disclose rejected capture/key bytes.
test("signing failures preserve the existing output and redact private inputs", async () => {
  const root = await mkdtemp(join(tmpdir(), "api-truth-signer-"));
  try {
    const capture = join(root, "capture.json"), key = join(root, "private.pem"), output = join(root, "receipt.json");
    await writeFile(capture, '{"private":"capture-secret-marker"}');
    await writeFile(key, "key-secret-marker");
    await writeFile(output, "existing-receipt");
    const args = ["--capture", capture, "--private-key", key, "--output", output];
    for (const values of [args, [...args, "--unknown", "argument-secret-marker"], [...args, "--capture", capture]]) {
      const result = spawnSync(process.execPath, [resolve("scripts/sign-runtime-binding.mjs"), ...values], {encoding: "utf8", timeout: 15000});
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("Runtime binding signing failed");
      for (const marker of [root, "capture-secret-marker", "key-secret-marker", "argument-secret-marker"]) expect(result.stderr).not.toContain(marker);
      expect(await readFile(output, "utf8")).toBe("existing-receipt");
    }
  } finally { await rm(root, {recursive: true, force: true}); }
}, 30000);
