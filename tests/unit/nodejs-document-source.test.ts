import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { readSelectedDocument } from "../../analyzers/nodejs/src/source.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

test("reads only the selected contained JSON document and hashes its path and bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "api-truth-nodejs-source-")); roots.push(root);
  await mkdir(join(root, "service", "api", "swagger"), { recursive: true });
  await writeFile(join(root, "service", "api", "swagger", "swagger.json"), '{"swagger":"2.0"}');
  await writeFile(join(root, "service", "ignored.json"), "other");
  const selected = await readSelectedDocument(root, "service", "service/api/swagger/swagger.json", 1000);
  expect(selected.text).toBe('{"swagger":"2.0"}');
  expect(selected.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
  expect(selected.path).toBe("service/api/swagger/swagger.json");
  await writeFile(join(root, "service", "ignored.json"), "changed");
  expect((await readSelectedDocument(root, "service", "service/api/swagger/swagger.json", 1000)).digest).toBe(selected.digest);
});

test("rejects traversal, symlinks, excess bytes, and invalid UTF-8 without reading other files", async () => {
  const root = await mkdtemp(join(tmpdir(), "api-truth-nodejs-source-")); roots.push(root);
  await mkdir(join(root, "service"));
  await writeFile(join(root, "service", "swagger.json"), "a".repeat(100));
  await symlink(join(root, "service", "swagger.json"), join(root, "service", "linked.json"));
  await writeFile(join(root, "service", "invalid.json"), Buffer.from([0xff]));
  for (const path of ["../private.json", "service/../private.json", "service/linked.json", "service/swagger.json"]) {
    await expect(readSelectedDocument(root, "service", path, 10)).rejects.toThrow("Document source rejected");
  }
  await expect(readSelectedDocument(root, "service", "service/invalid.json", 100)).rejects.toThrow("Document source rejected");
});
