import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { materializeGitSource, readConfiguredBranches } from "../../connectors/git-source/src/index.js";

const execFile = promisify(execFileCallback);
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

async function repository() {
  const root = await mkdtemp(join(tmpdir(), "api-truth-git-source-test-")); roots.push(root);
  await execFile("git", ["init", "-q", "-b", "main"], { cwd: root });
  await writeFile(join(root, ".gitignore"), "ignored.txt\n");
  await mkdir(join(root, "services/api"), { recursive: true });
  await writeFile(join(root, "services/api/index.ts"), "export const version = 1;\n");
  const commit = async () => {
    await execFile("git", ["add", "-A"], { cwd: root });
    await execFile("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture"], { cwd: root });
    return (await execFile("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
  };
  const first = await commit();
  await writeFile(join(root, "services/api/index.ts"), "export const version = 2;\n");
  const second = await commit();
  return { root, first, second, commit };
}

const limits = { maxFiles: 20, maxBytes: 100_000 };

test("materializes only a pinned commit tree and returns an idempotent disposer", async () => {
  const repo = await repository();
  await writeFile(join(repo.root, "services/api/index.ts"), "working tree must not be read\n");
  await writeFile(join(repo.root, "services/api/ignored.txt"), "ignored and untracked\n");
  const v1 = await materializeGitSource({ repoPath: repo.root, revision: repo.first, serviceRoot: "services/api", limits });
  try {
    expect(await readFile(join(v1.servicePath, "index.ts"), "utf8")).toBe("export const version = 1;\n");
    expect(v1.files.map(file => file.path)).toEqual(["index.ts"]);
    expect(v1.revision).toBe(repo.first);
    const mode = (await (await import("node:fs/promises")).stat(join(v1.servicePath, "index.ts"))).mode & 0o777;
    expect(mode).toBe(0o644);
    expect(await readdir(v1.servicePath)).toEqual(["index.ts"]);
    const v2 = await materializeGitSource({ repoPath: repo.root, revision: repo.second, serviceRoot: "services/api", limits });
    try { expect(await readFile(join(v2.servicePath, "index.ts"), "utf8")).toBe("export const version = 2;\n"); }
    finally { await v2.dispose(); }
  } finally {
    await v1.dispose();
    await v1.dispose();
    await expect(readFile(join(v1.projectRoot, "services/api/index.ts"))).rejects.toThrow();
  }
});

test("validates immutable revisions and normalized contained service roots", async () => {
  const repo = await repository();
  for (const revision of ["HEAD", "main", "../" + repo.first, "a".repeat(39), "g".repeat(40)]) {
    await expect(materializeGitSource({ repoPath: repo.root, revision, serviceRoot: "services/api", limits }))
      .rejects.toThrow("Git source materialization rejected");
  }
  for (const serviceRoot of ["../api", "/services/api", "services/../api", "services//api", "services\\api", "missing"]) {
    await expect(materializeGitSource({ repoPath: repo.root, revision: repo.first, serviceRoot, limits }))
      .rejects.toThrow("Git source materialization rejected");
  }
  for (const serviceRoot of [".git", "services/.GiT/config"]) {
    await expect(materializeGitSource({ repoPath: repo.root, revision: repo.first, serviceRoot, limits }))
      .rejects.toThrow("Git source materialization rejected");
  }
});

test("enforces file and byte budgets and cleans partial materializations", async () => {
  const repo = await repository();
  await writeFile(join(repo.root, "services/api/extra.ts"), "export const extra = true;\n");
  const revision = await repo.commit();
  const before = new Set(await readdir(tmpdir()));
  await expect(materializeGitSource({ repoPath: repo.root, revision, serviceRoot: "services/api", limits: { maxFiles: 1, maxBytes: 100_000 } }))
    .rejects.toThrow("Git source materialization rejected");
  await expect(materializeGitSource({ repoPath: repo.root, revision, serviceRoot: "services/api", limits: { maxFiles: 20, maxBytes: 4 } }))
    .rejects.toThrow("Git source materialization rejected");
  const after = await readdir(tmpdir());
  expect(after.filter(name => name.startsWith("api-truth-git-source-") && !before.has(name))).toEqual([]);
});

test("rejects committed symbolic links, submodules, and invalid UTF-8 blobs", async () => {
  const repo = await repository();
  await symlink("index.ts", join(repo.root, "services/api/link.ts"));
  const symlinkCommit = await repo.commit();
  await expect(materializeGitSource({ repoPath: repo.root, revision: symlinkCommit, serviceRoot: "services/api", limits }))
    .rejects.toThrow("Git source materialization rejected");
  await rm(join(repo.root, "services/api/link.ts"));
  await execFile("git", ["update-index", "--add", "--cacheinfo", `160000,${repo.first},services/api/submodule`], { cwd: repo.root });
  await execFile("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture submodule"], { cwd: repo.root });
  const submoduleCommit = (await execFile("git", ["rev-parse", "HEAD"], { cwd: repo.root })).stdout.trim();
  await expect(materializeGitSource({ repoPath: repo.root, revision: submoduleCommit, serviceRoot: "services/api", limits }))
    .rejects.toThrow("Git source materialization rejected");
  await execFile("git", ["update-index", "--force-remove", "services/api/submodule"], { cwd: repo.root });
  await writeFile(join(repo.root, "services/api/binary.ts"), Buffer.from([0x66, 0x80, 0x6f]));
  const invalidTextCommit = await repo.commit();
  await expect(materializeGitSource({ repoPath: repo.root, revision: invalidTextCommit, serviceRoot: "services/api", limits }))
    .rejects.toThrow("Git source materialization rejected");
});

test("preserves the executable bit without running files", async () => {
  const repo = await repository();
  await writeFile(join(repo.root, "services/api/tool.sh"), "#!/bin/sh\nexit 99\n", { mode: 0o755 });
  await execFile("git", ["add", "-A"], { cwd: repo.root });
  await execFile("git", ["update-index", "--chmod=+x", "services/api/tool.sh"], { cwd: repo.root });
  const revision = await repo.commit();
  const tree = await materializeGitSource({ repoPath: repo.root, revision, serviceRoot: "services/api", limits });
  try {
    const mode = (await (await import("node:fs/promises")).stat(join(tree.servicePath, "tool.sh"))).mode & 0o777;
    expect(mode).toBe(0o755);
  } finally { await tree.dispose(); }
});

test("preserves opaque binary assets while keeping analyzer-readable sources strict UTF-8", async () => {
  const repo = await repository();
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
  await writeFile(join(repo.root, "services/api/asset.png"), bytes);
  const revision = await repo.commit();
  const tree = await materializeGitSource({ repoPath: repo.root, revision, serviceRoot: "services/api", limits });
  try {
    expect(await readFile(join(tree.servicePath, "asset.png"))).toEqual(bytes);
    expect(tree.tree_digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect("source_digest" in tree).toBe(false);
  } finally { await tree.dispose(); }
  await writeFile(join(repo.root, "services/api/binary.ts"), Buffer.from([0x66, 0x80, 0x6f]));
  const invalidTextRevision = await repo.commit();
  await expect(materializeGitSource({ repoPath: repo.root, revision: invalidTextRevision,
    serviceRoot: "services/api", limits })).rejects.toThrow("Git source materialization rejected");
});

test("repository promisor configuration cannot run a remote helper", async () => {
  const repo = await repository();
  const marker = join(repo.root, "helper-ran");
  const blob = (await execFile("git", ["rev-parse", `${repo.second}:services/api/index.ts`], { cwd: repo.root })).stdout.trim();
  await rm(join(repo.root, ".git", "objects", blob.slice(0, 2), blob.slice(2)));
  await execFile("git", ["config", "extensions.partialClone", "origin"], { cwd: repo.root });
  await execFile("git", ["config", "remote.origin.promisor", "true"], { cwd: repo.root });
  await execFile("git", ["config", "remote.origin.partialclonefilter", "blob:none"], { cwd: repo.root });
  await execFile("git", ["config", "remote.origin.url", `ext::sh -c 'touch ${marker}'`], { cwd: repo.root });
  await execFile("git", ["config", "protocol.ext.allow", "always"], { cwd: repo.root });
  await expect(materializeGitSource({ repoPath: repo.root, revision: repo.second, serviceRoot: "services/api", limits }))
    .rejects.toThrow("Git source materialization rejected");
  await expect(readFile(marker)).rejects.toThrow();
});

test("probes only explicitly configured branch refs", async () => {
  const repo = await repository();
  await execFile("git", ["branch", "release/v1"], { cwd: repo.root });
  await execFile("git", ["branch", "secret-unselected"], { cwd: repo.root });
  const branches = await readConfiguredBranches(repo.root, ["main", "release/v1", "missing"]);
  expect(branches).toEqual([
    { name: "main", commit: repo.second },
    { name: "release/v1", commit: repo.second },
    { name: "missing", commit: null },
  ]);
  await expect(readConfiguredBranches(repo.root, ["main", "main"])).rejects.toThrow("Git branch selection rejected");
  await expect(readConfiguredBranches(repo.root, ["--help"])).rejects.toThrow("Git branch selection rejected");
});
