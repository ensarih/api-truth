import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import {
  JAVA_VERSION, MAX_ARCHIVE_ENTRIES, MAX_METADATA_BYTES, RELEASES, checkPinnedJava, createTreeManifest,
  downloadPinnedAsset, installPinnedJava, isExpectedJavaVersion, javaHomePath, javaProbeEnvironment, matchesTreeManifest, runtimePaths,
  selectPlatform, validateArchiveEntries, validateSha256,
} from "../../scripts/java-test-environment-lib.mjs";

describe("pinned project-local Java test runtime", () => {
  test("selects only the four pinned macOS/Linux architectures", () => {
    expect(selectPlatform("darwin", "arm64")).toBe("macos-arm64");
    expect(selectPlatform("darwin", "x64")).toBe("macos-x64");
    expect(selectPlatform("linux", "x64")).toBe("linux-x64");
    expect(selectPlatform("linux", "arm64")).toBe("linux-arm64");
    expect(() => selectPlatform("win32", "x64")).toThrow("unsupported_platform");
    expect(() => selectPlatform("linux", "ia32")).toThrow("unsupported_platform");
  });

  test("uses immutable release URLs and valid official digests for every target", () => {
    expect(JAVA_VERSION).toBe("21.0.12.1+1");
    expect(Object.keys(RELEASES).sort()).toEqual(["linux-arm64", "linux-x64", "macos-arm64", "macos-x64"]);
    for (const release of Object.values(RELEASES)) {
      expect(release.url).toMatch(/^https:\/\/github\.com\/adoptium\/temurin21-binaries\/releases\/download\/jdk-21\.0\.12\.1%2B1\//);
      expect(validateSha256(release.sha256)).toBe(release.sha256);
      expect(release.name).toContain("21.0.12.1_1.tar.gz");
    }
    expect(() => validateSha256("latest")).toThrow("invalid_digest");
    expect(() => validateSha256("0".repeat(63))).toThrow("invalid_digest");
  });

  test("keeps install paths inside the repository-local cache", () => {
    const paths = runtimePaths("/tmp/project", "linux-x64");
    expect(paths.root).toBe("/tmp/project/.cache/java-test/21.0.12.1+1-linux-x64/runtime");
    expect(paths.archive.startsWith("/tmp/project/.cache/java-test/")).toBe(true);
    expect(() => runtimePaths("/tmp/project", "__proto__")).toThrow("unsupported_platform");
  });

  test("locates the macOS app-bundle JDK and checks the reported base version and exact build", () => {
    expect(javaHomePath("/cache/runtime", "macos-arm64")).toBe("/cache/runtime/Contents/Home");
    expect(javaHomePath("/cache/runtime", "macos-x64")).toBe("/cache/runtime/Contents/Home");
    expect(javaHomePath("/cache/runtime", "linux-x64")).toBe("/cache/runtime");
    const expected = 'openjdk version "21.0.12.1" 2026-08-19 LTS\nOpenJDK Runtime Environment Temurin-21.0.12.1+1 (build 21.0.12.1+1-LTS)';
    expect(isExpectedJavaVersion(expected)).toBe(true);
    expect(isExpectedJavaVersion(expected.replace("+1-LTS", "+10-LTS"))).toBe(false);
    expect(isExpectedJavaVersion(expected.replace('version "21.0.12.1"', 'version "21.0.12"'))).toBe(false);
  });

  test("the Java version probe strips inherited agents, options, and classpaths", () => {
    const names = ["JAVA_TOOL_OPTIONS", "JDK_JAVA_OPTIONS", "_JAVA_OPTIONS", "CLASSPATH"];
    const previous = new Map(names.map(name => [name, process.env[name]]));
    try {
      for (const name of names) process.env[name] = `-javaagent:/tmp/${name}-CANARY`;
      expect(javaProbeEnvironment()).toEqual({});
      expect(Object.isFrozen(javaProbeEnvironment())).toBe(true);
    } finally {
      for (const name of names) {
        const value = previous.get(name);
        if (value === undefined) delete process.env[name]; else process.env[name] = value;
      }
    }
  });

  test("offline checks reject symlinked archive files before reading cache metadata", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "java-env-links-"));
    const paths = runtimePaths(scratch, "linux-x64");
    await mkdir(paths.cache, {recursive: true});
    const outside = join(scratch, "private-file");
    await writeFile(outside, "CANARY_PRIVATE_FILE");
    await symlink(outside, paths.archive);
    try {
      await expect(checkPinnedJava({repoRoot: scratch, platform: "linux", arch: "x64"}))
        .rejects.toThrow("symlink_path_rejected");
      expect(await readFile(outside, "utf8")).toBe("CANARY_PRIVATE_FILE");
    } finally {await rm(scratch, {recursive: true, force: true});}
  });

  test("rejects archive path traversal, absolute paths, and multiple roots", () => {
    expect(validateArchiveEntries(["jdk/bin/java", "jdk/lib/modules"])).toBe("jdk");
    for (const entries of [
      ["../escape", "jdk/bin/java"], ["jdk/../../escape"], ["/absolute/file"],
      ["jdk\\escape"], ["jdk/bin/java", "other/lib/modules"], ["./"],
    ]) expect(() => validateArchiveEntries(entries)).toThrow("invalid_archive");
    expect(() => validateArchiveEntries(Array(MAX_ARCHIVE_ENTRIES + 1).fill("jdk/file"))).toThrow("invalid_archive");
  });

  test("does not fetch over a disallowed manual redirect", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "java-redirect-test-"));
    const destination = join(scratch, "archive.tgz");
    const fetcher = vi.fn(async (_url:string|URL|Request, _init?:RequestInit) => new Response(null, {status: 302,
      headers: {location: "https://not-adoptium.example/asset"}}));
    try {
      await expect(downloadPinnedAsset(RELEASES["linux-x64"]!, destination, fetcher))
        .rejects.toThrow("download_failed");
      expect(fetcher).toHaveBeenCalledOnce();
      expect(fetcher.mock.calls[0]?.[1]).toMatchObject({redirect: "manual"});
      await expect(readFile(destination)).rejects.toMatchObject({code: "ENOENT"});
    } finally { await rm(scratch, {recursive:true,force:true}); }
  });

  test("rejects a partial cache before fetch and preserves existing bytes", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "java-partial-cache-test-"));
    const paths = runtimePaths(scratch, "linux-x64");
    await mkdir(paths.cache, {recursive:true});
    await writeFile(paths.archive, "preserve partial archive");
    const fetcher = vi.fn(async () => new Response("unexpected"));
    try {
      await expect(installPinnedJava({repoRoot:scratch,platform:"linux",arch:"x64",fetch:fetcher}))
        .rejects.toThrow("cache_exists_remove_manually");
      expect(fetcher).not.toHaveBeenCalled();
      expect(await readFile(paths.archive,"utf8")).toBe("preserve partial archive");
    } finally { await rm(scratch, {recursive:true,force:true}); }
  });

  test("bounds metadata streaming before archive extraction or java execution", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "java-metadata-bound-test-"));
    const paths = runtimePaths(scratch, "linux-x64");
    const marker = join(scratch, "java-ran");
    await mkdir(join(paths.root,"bin"), {recursive:true});
    await writeFile(join(paths.root,"bin","java"), `#!/bin/sh\ntouch '${marker}'\n`);
    await chmod(join(paths.root,"bin","java"), 0o755);
    await writeFile(paths.archive,"not a tar archive");
    await writeFile(paths.metadata,Buffer.alloc(MAX_METADATA_BYTES+1));
    try {
      await expect(checkPinnedJava({repoRoot:scratch,platform:"linux",arch:"x64"}))
        .rejects.toThrow("runtime_integrity_failed");
      await expect(readFile(marker)).rejects.toMatchObject({code:"ENOENT"});
    } finally { await rm(scratch, {recursive:true,force:true}); }
  });

  test("creates an offline file-tree integrity manifest and detects tampering or escaping links", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "java-env-test-"));
    const root = join(scratch, "runtime");
    await mkdir(join(root, "bin"), { recursive: true });
    await writeFile(join(root, "bin", "java"), "trusted binary");
    await writeFile(join(root, "release"), "JAVA_VERSION=21.0.12.1\n");
    try {
      const manifest = await createTreeManifest(root);
      expect(await matchesTreeManifest(root, manifest)).toBe(true);
      expect(await readFile(join(root, "release"), "utf8")).toContain("21.0.12.1");
      await writeFile(join(root, "bin", "java"), "changed binary");
      expect(await matchesTreeManifest(root, manifest)).toBe(false);
      await symlink(scratch, join(root, "outside"));
      expect(await matchesTreeManifest(root, manifest)).toBe(false);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
});
