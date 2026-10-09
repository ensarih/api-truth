import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { link, lstat, mkdir, readlink, readdir, realpath, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { execFile as execFileCallback } from "node:child_process";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

const execFile = promisify(execFileCallback);
export const JAVA_VERSION = "21.0.12.1+1";
export const RELEASE_TAG = "jdk-21.0.12.1+1";
export const MAX_ARCHIVE_BYTES = 300 * 1024 * 1024;
export const MAX_EXTRACTED_BYTES = 1024 * 1024 * 1024;
export const MAX_ARCHIVE_ENTRIES = 100_000;
export const MAX_METADATA_BYTES = 16 * 1024 * 1024;
export const DOWNLOAD_TIMEOUT_MS = 15 * 60 * 1000;
export const MAX_REDIRECTS = 5;
const ASSET_ROOT = `https://github.com/adoptium/temurin21-binaries/releases/download/${encodeURIComponent(RELEASE_TAG)}`;
const asset = (name, sha256) => Object.freeze({ name, url: `${ASSET_ROOT}/${name}`, sha256 });
export const RELEASES = Object.freeze({
  "macos-arm64": asset("OpenJDK21U-jdk_aarch64_mac_hotspot_21.0.12.1_1.tar.gz", "3623232f33a9c3baadf304480b2535f9a3cba8a58d42ecbb438ba267315d9998"),
  "macos-x64": asset("OpenJDK21U-jdk_x64_mac_hotspot_21.0.12.1_1.tar.gz", "44db0f08196daf19a47f90d13388b0c943b67663cb537f998fe29e836fa842ce"),
  "linux-x64": asset("OpenJDK21U-jdk_x64_linux_hotspot_21.0.12.1_1.tar.gz", "ce79869e1307ed8ee1e2baa86a412b1eb5b75d10a01006d788a6f968bcfaee94"),
  "linux-arm64": asset("OpenJDK21U-jdk_aarch64_linux_hotspot_21.0.12.1_1.tar.gz", "23e37e026f12f3e706f18938ff611db3032d075b09d0879a25d06718c773e223"),
});
const REDIRECT_HOSTS = new Set(["github.com", "release-assets.githubusercontent.com"]);

export function selectPlatform(platform = process.platform, arch = process.arch) {
  const os = platform === "darwin" ? "macos" : platform === "linux" ? "linux" : undefined;
  const cpu = arch === "arm64" ? "arm64" : arch === "x64" ? "x64" : undefined;
  if (!os || !cpu) throw new Error("unsupported_platform");
  return `${os}-${cpu}`;
}

export function javaHomePath(runtimeRoot, platformKey) {
  if (!RELEASES[platformKey]) throw new Error("unsupported_platform");
  return platformKey.startsWith("macos-") ? join(runtimeRoot, "Contents", "Home") : runtimeRoot;
}

export function isExpectedJavaVersion(output) {
  return typeof output === "string"
    && /version "21\.0\.12\.1"(?:\s|$)/.test(output)
    && /Temurin-21\.0\.12\.1\+1(?:\s|\))/.test(output)
    && /build 21\.0\.12\.1\+1(?:-LTS)?\)/.test(output);
}

/** Do not allow inherited Java agents, options, or classpaths into the version probe. */
export function javaProbeEnvironment() {
  return Object.freeze({});
}

export function validateArchiveEntries(entries) {
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > MAX_ARCHIVE_ENTRIES) throw new Error("invalid_archive");
  let archiveRoot;
  for (const entry of entries) {
    if (typeof entry !== "string" || entry.length === 0 || entry.includes("\\") || entry.includes("\0") || isAbsolute(entry)) {
      throw new Error("invalid_archive");
    }
    const normalized = entry.replace(/^\.\//, "").replace(/\/$/, "");
    const components = normalized.split("/");
    if (!normalized || components.some(part => part === "" || part === "." || part === "..")) throw new Error("invalid_archive");
    if (archiveRoot === undefined) archiveRoot = components[0];
    if (components[0] !== archiveRoot) throw new Error("invalid_archive");
  }
  return archiveRoot;
}

export function validateSha256(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error("invalid_digest");
  return value;
}

export async function digestFile(path, maxBytes = MAX_ARCHIVE_BYTES) {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw new Error("file_too_large");
    hash.update(chunk);
  }
  return { sha256: hash.digest("hex"), bytes };
}

async function assertNoSymlinkComponents(root, target) {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  const rel = relative(resolvedRoot, resolvedTarget);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("path_outside_cache");
  let current = resolvedRoot;
  for (const component of rel.split(sep)) {
    current = join(current, component);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new Error("symlink_path_rejected");
      if (!info.isDirectory() && current !== resolvedTarget) throw new Error("invalid_cache_path");
    } catch (error) {
      if (error?.code === "ENOENT") break;
      throw error;
    }
  }
}

const allowedAssetUrl = value => value instanceof URL && value.protocol === "https:"
  && REDIRECT_HOSTS.has(value.hostname) && !value.username && !value.password && !value.port;

export async function downloadPinnedAsset(release, destination, fetcher = globalThis.fetch) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  timeout.unref?.();
  try {
    let url = new URL(release.url);
    for (let redirects = 0; ; redirects += 1) {
      if (!allowedAssetUrl(url)) throw new Error("download_failed");
      let response;
      try { response = await fetcher(url, { signal: controller.signal, redirect: "manual" }); }
      catch { throw new Error("download_failed"); }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        await response.body?.cancel().catch(() => undefined);
        if (redirects >= MAX_REDIRECTS || !location) throw new Error("download_failed");
        try { url = new URL(location, url); } catch { throw new Error("download_failed"); }
        if (!allowedAssetUrl(url)) throw new Error("download_failed");
        continue;
      }
      if (!response.ok) throw new Error("download_failed");
      const declaredSize = Number(response.headers.get("content-length"));
      if (Number.isFinite(declaredSize) && declaredSize > MAX_ARCHIVE_BYTES) throw new Error("archive_too_large");
      if (!response.body) throw new Error("download_failed");
      let bytes = 0;
      const limiter = new Transform({ transform(chunk, _encoding, callback) {
        bytes += chunk.length;
        callback(bytes > MAX_ARCHIVE_BYTES ? new Error("archive_too_large") : null, chunk);
      }});
      await pipeline(Readable.fromWeb(response.body), limiter, createWriteStream(destination, { flags: "wx", mode: 0o600 }), { signal: controller.signal });
      if (bytes === 0) throw new Error("download_failed");
      return;
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function listArchiveEntries(archivePath) {
  const { stdout } = await execFile("tar", ["-tzf", archivePath], { timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
  return stdout.split(/\r?\n/).filter(Boolean);
}

async function extractArchive(archivePath, destination) {
  const entries = await listArchiveEntries(archivePath);
  validateArchiveEntries(entries);
  await mkdir(destination, { recursive: false, mode: 0o700 });
  await execFile("tar", ["-xzf", archivePath, "-C", destination, "--strip-components=1", "--no-same-owner", "--no-same-permissions"], {
    timeout: 5 * 60_000, maxBuffer: 1024 * 1024,
  });
  await assertExtractedTreeContained(destination);
}

async function assertExtractedTreeContained(root) {
  const canonicalRoot = await realpath(root);
  const visit = async path => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      if (entry.isSymbolicLink()) {
        const target = await realpath(full);
        const rel = relative(canonicalRoot, target);
        if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("archive_symlink_outside");
      } else if (entry.isDirectory()) await visit(full);
      else if (!entry.isFile()) throw new Error("archive_special_file");
    }
  };
  await visit(root);
}

export async function createTreeManifest(root) {
  const result = [];
  let totalBytes = 0;
  const canonicalRoot = await realpath(root);
  const visit = async dir => {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = join(dir, entry.name);
      const rel = relative(canonicalRoot, full).split(sep).join("/");
      if (entry.isSymbolicLink()) {
        const link = await readlink(full);
        const target = await realpath(full);
        const targetRel = relative(canonicalRoot, target);
        if (targetRel === ".." || targetRel.startsWith(`..${sep}`) || isAbsolute(targetRel)) throw new Error("archive_symlink_outside");
        result.push({ path: rel, kind: "symlink", target: link });
      } else if (entry.isDirectory()) await visit(full);
      else if (entry.isFile()) {
        const digest = await digestFile(full, MAX_ARCHIVE_BYTES);
        totalBytes += digest.bytes;
        if (totalBytes > MAX_EXTRACTED_BYTES) throw new Error("extracted_tree_too_large");
        result.push({ path: rel, kind: "file", sha256: digest.sha256, bytes: digest.bytes });
      } else throw new Error("archive_special_file");
      if (result.length > MAX_ARCHIVE_ENTRIES) throw new Error("extracted_tree_too_many_entries");
    }
  };
  await visit(root);
  return result;
}

export async function matchesTreeManifest(root, expected) {
  if (!Array.isArray(expected)) return false;
  try { return JSON.stringify(await createTreeManifest(root)) === JSON.stringify(expected); }
  catch { return false; }
}

async function writeRuntimeMetadata(metadataPath, root, platform, release) {
  const manifest = await createTreeManifest(root);
  await writeFile(metadataPath, JSON.stringify({ version: JAVA_VERSION, platform, asset: release.name, sha256: release.sha256, manifest }), { flag: "wx", mode: 0o600 });
}

const exactKeys = (value, expected) => value !== null && typeof value === "object" && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).length === expected.length
  && Object.keys(value).every(key => expected.includes(key));

export async function readBoundedRuntimeMetadata(path) {
  const chunks = [];
  let bytes = 0;
  try {
    for await (const chunk of createReadStream(path)) {
      bytes += chunk.length;
      if (bytes > MAX_METADATA_BYTES) throw new Error("metadata_too_large");
      chunks.push(chunk);
    }
    const text = new TextDecoder("utf-8", {fatal: true}).decode(Buffer.concat(chunks, bytes));
    const value = JSON.parse(text);
    if (!exactKeys(value, ["version", "platform", "asset", "sha256", "manifest"])
      || typeof value.version !== "string" || value.version.length > 64
      || typeof value.platform !== "string" || value.platform.length > 32
      || typeof value.asset !== "string" || value.asset.length > 256
      || typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256)
      || !Array.isArray(value.manifest) || value.manifest.length > MAX_ARCHIVE_ENTRIES) throw new Error("metadata_invalid");
    for (const item of value.manifest) {
      if (exactKeys(item, ["path", "kind", "sha256", "bytes"])) {
        if (typeof item.path !== "string" || item.path.length < 1 || item.path.length > 4096
          || item.path.startsWith("/") || item.path.includes("\\")
          || item.path.split("/").some(part => !part || part === "." || part === "..")
          || item.kind !== "file" || typeof item.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(item.sha256)
          || !Number.isSafeInteger(item.bytes) || item.bytes < 0 || item.bytes > MAX_ARCHIVE_BYTES) throw new Error("metadata_invalid");
      } else if (exactKeys(item, ["path", "kind", "target"])) {
        if (typeof item.path !== "string" || item.path.length < 1 || item.path.length > 4096
          || item.path.startsWith("/") || item.path.includes("\\")
          || item.path.split("/").some(part => !part || part === "." || part === "..")
          || item.kind !== "symlink" || typeof item.target !== "string" || item.target.length > 4096) throw new Error("metadata_invalid");
      } else throw new Error("metadata_invalid");
    }
    return value;
  } catch (error) {
    if (error?.message === "metadata_too_large") throw new Error("runtime_integrity_failed");
    throw new Error("runtime_integrity_failed");
  }
}

async function cacheObjects(paths, checkTemporaryArtifacts = true) {
  let entries;
  try { entries = await readdir(paths.cache); }
  catch (error) { if (error?.code === "ENOENT") entries = []; else throw new Error("cache_exists_remove_manually"); }
  if (checkTemporaryArtifacts && entries.some(entry => entry.startsWith(".download-") || entry.startsWith(".staging-") || entry.startsWith(".verify-")))
    throw new Error("cache_exists_remove_manually");
  const targets = [paths.root, paths.archive, paths.metadata];
  const states = await Promise.all(targets.map(async path => {
    try { return await lstat(path); }
    catch (error) { if (error?.code === "ENOENT") return undefined; throw new Error("cache_exists_remove_manually"); }
  }));
  const present = states.filter(Boolean).length;
  if (present !== 0 && present !== targets.length) throw new Error("cache_exists_remove_manually");
  if (present === targets.length && (states[0].isSymbolicLink() || !states[0].isDirectory()
    || states[1].isSymbolicLink() || !states[1].isFile()
    || states[2].isSymbolicLink() || !states[2].isFile())) throw new Error("cache_exists_remove_manually");
  return present === targets.length;
}

async function verifyRuntime(root, archivePath, metadataPath, platform, release) {
  let metadata;
  try { metadata = await readBoundedRuntimeMetadata(metadataPath); }
  catch { throw new Error("runtime_integrity_failed"); }
  if (metadata.version !== JAVA_VERSION || metadata.platform !== platform || metadata.asset !== release.name || metadata.sha256 !== release.sha256 || !Array.isArray(metadata.manifest)) {
    throw new Error("runtime_unavailable");
  }
  let archiveDigest;
  try { archiveDigest = await digestFile(archivePath); } catch { throw new Error("runtime_unavailable"); }
  if (archiveDigest.sha256 !== release.sha256) throw new Error("runtime_integrity_failed");
  const expectedRoot = join(dirname(root), `.verify-${randomUUID()}`);
  try {
    await extractArchive(archivePath, expectedRoot);
    const [expectedManifest, currentManifest] = await Promise.all([createTreeManifest(expectedRoot), createTreeManifest(root)]);
    if (JSON.stringify(expectedManifest) !== JSON.stringify(metadata.manifest)
      || JSON.stringify(currentManifest) !== JSON.stringify(expectedManifest)) throw new Error("runtime_integrity_failed");
    const finalArchiveDigest = await digestFile(archivePath);
    if (finalArchiveDigest.sha256 !== release.sha256) throw new Error("runtime_integrity_failed");
  } catch (error) {
    if (error?.message === "runtime_integrity_failed") throw error;
    throw new Error("runtime_integrity_failed");
  } finally {
    await rm(expectedRoot, { recursive: true, force: true }).catch(() => {});
  }
  const javaPath = join(javaHomePath(root, platform), "bin", "java");
  try { await stat(javaPath); } catch { throw new Error("runtime_unavailable"); }
  const { stdout, stderr } = await execFile(javaPath, ["-version"], {
    timeout: 10_000, maxBuffer: 16 * 1024, env: javaProbeEnvironment(),
  });
  if (!isExpectedJavaVersion(`${stdout}\n${stderr}`)) throw new Error("runtime_version_mismatch");
}

export function runtimePaths(repoRoot, platformKey) {
  if (typeof platformKey !== "string" || !Object.hasOwn(RELEASES, platformKey)) throw new Error("unsupported_platform");
  const release = RELEASES[platformKey];
  const root = resolve(repoRoot);
  const cache = join(root, ".cache", "java-test", `${JAVA_VERSION}-${platformKey}`);
  return Object.freeze({
    release,
    cache,
    root: join(cache, "runtime"),
    archive: join(cache, release.name),
    metadata: join(cache, "runtime-manifest.json"),
  });
}

export async function installPinnedJava({ repoRoot, platform = process.platform, arch = process.arch, fetch: fetcher = globalThis.fetch }) {
  const platformKey = selectPlatform(platform, arch);
  const repo = await realpath(resolve(repoRoot));
  const paths = runtimePaths(repo, platformKey);
  await assertNoSymlinkComponents(repo, paths.cache);
  await mkdir(paths.cache, { recursive: true, mode: 0o700 });
  await assertNoSymlinkComponents(repo, paths.cache);
  for (const target of [paths.root, paths.archive, paths.metadata]) await assertNoSymlinkComponents(repo, target);
  if (await cacheObjects(paths)) {
    try {
      await verifyRuntime(paths.root, paths.archive, paths.metadata, platformKey, paths.release);
      return { platform: platformKey, version: JAVA_VERSION, installed: true };
    } catch (error) {
      if (error?.message !== "runtime_unavailable") throw error;
      throw new Error("cache_exists_remove_manually");
    }
  }
  const archivePart = join(paths.cache, `.download-${randomUUID()}`);
  const stagingRoot = join(paths.cache, `.staging-${randomUUID()}`);
  let archiveInstalled = false;
  let metadataInstalled = false;
  let runtimeInstalled = false;
  try {
    await downloadPinnedAsset(paths.release, archivePart, fetcher);
    const digest = await digestFile(archivePart);
    if (digest.sha256 !== paths.release.sha256) throw new Error("archive_integrity_failed");
    await link(archivePart, paths.archive);
    archiveInstalled = true;
    await unlink(archivePart);
    await extractArchive(paths.archive, stagingRoot);
    await writeRuntimeMetadata(paths.metadata, stagingRoot, platformKey, paths.release);
    metadataInstalled = true;
    try { await lstat(paths.root); throw new Error("cache_exists_remove_manually"); }
    catch (error) { if (error?.code !== "ENOENT") throw error; }
    await rename(stagingRoot, paths.root);
    runtimeInstalled = true;
    await verifyRuntime(paths.root, paths.archive, paths.metadata, platformKey, paths.release);
    return { platform: platformKey, version: JAVA_VERSION, installed: true };
  } catch (error) {
    await rm(archivePart, { force: true }).catch(() => {});
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
    if (runtimeInstalled) await rm(paths.root, { recursive: true, force: true }).catch(() => {});
    if (metadataInstalled) await rm(paths.metadata, { force: true }).catch(() => {});
    if (archiveInstalled) await rm(paths.archive, { force: true }).catch(() => {});
    if (error?.message === "archive_integrity_failed") throw error;
    if (error?.message === "cache_exists_remove_manually") throw error;
    throw new Error("installation_failed");
  }
}

export async function checkPinnedJava({ repoRoot, platform = process.platform, arch = process.arch }) {
  const platformKey = selectPlatform(platform, arch);
  const repo = await realpath(resolve(repoRoot));
  const paths = runtimePaths(repo, platformKey);
  await assertNoSymlinkComponents(repo, paths.cache);
  for (const target of [paths.root, paths.archive, paths.metadata]) await assertNoSymlinkComponents(repo, target);
  if (!await cacheObjects(paths, false)) throw new Error("runtime_unavailable");
  await verifyRuntime(paths.root, paths.archive, paths.metadata, platformKey, paths.release);
  return { platform: platformKey, version: JAVA_VERSION, ready: true };
}
