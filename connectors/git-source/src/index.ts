import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, stat, writeFile, chmod } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { dirname, isAbsolute, join, posix, relative, resolve } from "node:path";

const MAX_FILES = 20_000;
const MAX_BYTES = 100_000_000;
const MAX_BRANCHES = 128;
const COMMAND_TIMEOUT_MS = 15_000;
const OPERATION_TIMEOUT_MS = 120_000;
const execFile = (command: string, args: string[], options: { cwd: string; maxBuffer: number; timeout?: number }) =>
  new Promise<Buffer>((resolveOutput, reject) => {
    execFileCallback(command, args, {
      cwd: options.cwd,
      env: {
        PATH: process.env.PATH ?? "",
        ...(process.env.SYSTEMROOT ? { SYSTEMROOT: process.env.SYSTEMROOT } : {}),
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: devNull,
        GIT_NO_REPLACE_OBJECTS: "1",
        GIT_NO_LAZY_FETCH: "1",
        GIT_ALLOW_PROTOCOL: "",
        GIT_OPTIONAL_LOCKS: "0",
        GIT_TERMINAL_PROMPT: "0",
        GIT_PAGER: "cat",
        GIT_ATTR_NOSYSTEM: "1",
      },
      encoding: "buffer",
      windowsHide: true,
      maxBuffer: options.maxBuffer,
      timeout: options.timeout ?? COMMAND_TIMEOUT_MS,
      killSignal: "SIGKILL",
    }, (error, stdout) => error ? reject(error) : resolveOutput(stdout));
  });

async function git(repoPath: string, args: string[], maxBuffer = 1024 * 1024,
  deadline = Date.now() + OPERATION_TIMEOUT_MS): Promise<Buffer> {
  const timeout = Math.min(COMMAND_TIMEOUT_MS, deadline - Date.now());
  if (timeout <= 0) throw new Error("Git command timed out");
  return execFile("git", ["-C", repoPath, "--no-pager", "-c", "core.hooksPath=/dev/null",
    "-c", "protocol.allow=never", "-c", "protocol.file.allow=never", "-c", "protocol.http.allow=never",
    "-c", "protocol.https.allow=never", "-c", "protocol.ssh.allow=never", "-c", "protocol.ext.allow=never", ...args], {
    cwd: repoPath, maxBuffer, timeout,
  });
}

function fail(): never { throw new Error("Git source materialization rejected"); }
function failBranches(): never { throw new Error("Git branch selection rejected"); }
const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};
const sha256 = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const utf8 = new TextDecoder("utf-8", { fatal: true });

function validLimits(limits: { maxFiles: number; maxBytes: number }): boolean {
  return Number.isSafeInteger(limits.maxFiles) && limits.maxFiles >= 1 && limits.maxFiles <= MAX_FILES
    && Number.isSafeInteger(limits.maxBytes) && limits.maxBytes >= 1 && limits.maxBytes <= MAX_BYTES;
}

function normalizeServiceRoot(value: string): string | undefined {
  if (value === ".") return value;
  if (!value || value.startsWith("/") || value.includes("\\") || posix.normalize(value) !== value) return undefined;
  const segments = value.split("/");
  if (segments.some(segment => !segment || segment === "." || segment === ".." || segment.toLowerCase() === ".git"
    || /[\u0000-\u001f\u007f:*?\[\]]/.test(segment))) return undefined;
  return value;
}

async function repositoryRoot(repoPath: string, deadline = Date.now() + OPERATION_TIMEOUT_MS): Promise<string> {
  if (!isAbsolute(repoPath)) fail();
  const canonical = await realpath(repoPath);
  if (!(await stat(canonical)).isDirectory()) fail();
  const discovered = utf8.decode(await git(canonical, ["rev-parse", "--show-toplevel"], 1024 * 1024, deadline)).trim();
  if (await realpath(discovered) !== canonical) fail();
  return canonical;
}

function parseTreeEntries(output: Buffer, maxFiles: number): Array<{ path: string; mode: string; type: string; object: string }> {
  const entries: Array<{ path: string; mode: string; type: string; object: string }> = [];
  const seen = new Set<string>();
  let offset = 0;
  while (offset < output.length) {
    const end = output.indexOf(0, offset);
    if (end < 0) fail();
    const record = output.subarray(offset, end);
    offset = end + 1;
    if (record.length === 0) continue;
    const tab = record.indexOf(9);
    if (tab < 0) fail();
    const metadata = record.subarray(0, tab).toString("ascii").split(" ");
    if (metadata.length !== 3) fail();
    const [mode, type, object] = metadata;
    const path = utf8.decode(record.subarray(tab + 1));
    if (!mode || !type || !object || !/^[a-f0-9]{40}$/i.test(object)) fail();
    if (!path || path.startsWith("/") || path.includes("\\") || path.includes(":") || posix.normalize(path) !== path
      || path.split("/").some(part => !part || part === "." || part === ".." || part.toLowerCase() === ".git"
        || /[\u0000-\u001f\u007f]/.test(part))) fail();
    if (seen.has(path)) fail();
    seen.add(path);
    if (entries.length >= maxFiles) fail();
    entries.push({ path, mode, type, object });
  }
  const paths = new Set(entries.map(entry => entry.path));
  for (const entry of entries) {
    const segments = entry.path.split("/");
    for (let index = 1; index < segments.length; index++) {
      if (paths.has(segments.slice(0, index).join("/"))) fail();
    }
  }
  return entries.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

export type MaterializedGitFile = { path: string; mode: 0o644 | 0o755; byte_length: number; sha256: string };
export type MaterializedGitSource = {
  revision: string;
  tree_digest: string;
  projectRoot: string;
  serviceRoot: string;
  servicePath: string;
  files: MaterializedGitFile[];
  dispose(): Promise<void>;
};

/** Materialize committed blobs only; this function never checks out or executes repository code. */
export async function materializeGitSource(input: {
  repoPath: string;
  revision: string;
  serviceRoot: string;
  limits: { maxFiles: number; maxBytes: number };
}): Promise<MaterializedGitSource> {
  let temporaryProject: string | undefined;
  try {
    const deadline = Date.now() + OPERATION_TIMEOUT_MS;
    if (!/^[a-f0-9]{40}$/i.test(input.revision) || !validLimits(input.limits)) fail();
    const serviceRoot = normalizeServiceRoot(input.serviceRoot);
    if (!serviceRoot) fail();
    const repo = await repositoryRoot(input.repoPath, deadline);
    const revision = input.revision.toLowerCase();
    const commitType = utf8.decode(await git(repo, ["cat-file", "-t", revision], 1024, deadline)).trim();
    if (commitType !== "commit") fail();
    const treeExpression = serviceRoot === "." ? `${revision}^{tree}` : `${revision}:${serviceRoot}`;
    const tree = utf8.decode(await git(repo, ["rev-parse", "--verify", "--end-of-options", treeExpression], 1024, deadline)).trim();
    if (!/^[a-f0-9]{40}$/i.test(tree)
      || utf8.decode(await git(repo, ["cat-file", "-t", tree], 1024, deadline)).trim() !== "tree") fail();
    const listingLimit = Math.min(128 * 1024 * 1024, input.limits.maxFiles * 4096 + 4096);
    const listing = await git(repo, ["ls-tree", "-r", "-z", tree], listingLimit, deadline);
    const entries = parseTreeEntries(listing, input.limits.maxFiles);
    if (entries.some(entry => entry.type !== "blob" || (entry.mode !== "100644" && entry.mode !== "100755"))) fail();

    temporaryProject = await mkdtemp(join(tmpdir(), "api-truth-git-source-"));
    const servicePath = serviceRoot === "." ? temporaryProject : resolve(temporaryProject, ...serviceRoot.split("/"));
    if (!inside(temporaryProject, servicePath)) fail();
    await mkdir(servicePath, { recursive: true, mode: 0o700 });
    const materializedFiles: MaterializedGitFile[] = [];
    const sourceDigest = createHash("sha256");
    let writtenBytes = 0;
    for (const entry of entries) {
      const remaining = input.limits.maxBytes - writtenBytes;
      const bytes = await git(repo, ["cat-file", "blob", entry.object], Math.max(1, remaining + 1), deadline);
      if (writtenBytes + bytes.byteLength > input.limits.maxBytes) fail();
      if (/\.(?:[cm]?[jt]s|tsx|jsx|json|ya?ml)$/i.test(entry.path)) utf8.decode(bytes);
      writtenBytes += bytes.byteLength;
      const destination = resolve(servicePath, ...entry.path.split("/"));
      if (!inside(servicePath, destination)) fail();
      await mkdir(dirname(destination), { recursive: true, mode: 0o755 });
      const mode = entry.mode === "100755" ? 0o755 : 0o644;
      await writeFile(destination, bytes, { flag: "wx", mode });
      await chmod(destination, mode);
      const digest = sha256(bytes);
      materializedFiles.push({ path: entry.path, mode, byte_length: bytes.byteLength, sha256: digest });
      sourceDigest.update(`${entry.path}\0${entry.mode}\0${digest}\0`);
    }
    let disposed = false;
    let disposePending: Promise<void> | undefined;
    const projectRoot = temporaryProject;
    return {
      revision,
      tree_digest: `sha256:${sourceDigest.digest("hex")}`,
      projectRoot,
      serviceRoot,
      servicePath,
      files: materializedFiles,
      async dispose() {
        if (disposed) return;
        if (!disposePending) disposePending = rm(projectRoot, { recursive: true, force: true }).then(() => {
          disposed = true;
        }).catch(error => {
          disposePending = undefined;
          throw error;
        });
        await disposePending;
      },
    };
  } catch {
    if (temporaryProject) await rm(temporaryProject, { recursive: true, force: true }).catch(() => undefined);
    return fail();
  }
}

/** Read only the explicitly configured branch refs; this never enumerates branch names. */
export async function readConfiguredBranches(repoPath: string, branchNames: string[]): Promise<Array<{ name: string; commit: string | null }>> {
  try {
    const deadline = Date.now() + OPERATION_TIMEOUT_MS;
    if (!Array.isArray(branchNames) || branchNames.length > MAX_BRANCHES
      || new Set(branchNames).size !== branchNames.length) failBranches();
    const repo = await repositoryRoot(repoPath, deadline);
    const results: Array<{ name: string; commit: string | null }> = [];
    for (const name of branchNames) {
      if (typeof name !== "string" || !name || name.startsWith("-") || /[\u0000-\u001f\u007f]/.test(name)) failBranches();
      if (name.includes("@{")) failBranches();
      await git(repo, ["check-ref-format", "--branch", name], 1024, deadline);
      const ref = `refs/heads/${name}`;
      try {
        const output = utf8.decode(await git(repo, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`], 1024, deadline)).trim();
        if (!/^[a-f0-9]{40}$/i.test(output)) failBranches();
        results.push({ name, commit: output.toLowerCase() });
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === 1) {
          results.push({ name, commit: null });
        } else failBranches();
      }
    }
    return results;
  } catch {
    return failBranches();
  }
}
