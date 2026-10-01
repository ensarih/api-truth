import { createHash } from "node:crypto";
import { lstat, readFile, realpath, readdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

const normalizedPath = (path: string): boolean =>
  path === "." || /^[A-Za-z0-9_@+.-]+(?:\/[A-Za-z0-9_@+.-]+)*$/.test(path)
    && !path.split("/").some(segment => segment === "." || segment === "..");

export const inside = (root: string, path: string): boolean => {
  const rel = relative(root, path);
  return rel === "" || !rel.startsWith("..") && !isAbsolute(rel);
};

export async function readServiceTree(projectRoot: string, serviceRoot: string, maxFiles: number,
  budget: () => void): Promise<{ files: Map<string, string>; root: string }> {
  try {
    if (!normalizedPath(serviceRoot) || !Number.isSafeInteger(maxFiles) || maxFiles < 1) throw new Error("invalid selection");
    const project = await realpath(projectRoot);
    const root = resolve(project, serviceRoot);
    if (!inside(project, root) || await realpath(root) !== root) throw new Error("outside boundary");
    const files = new Map<string, string>();
    let bytes = 0;
    const visit = async (dir: string): Promise<void> => {
      budget();
      for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        if (["node_modules", ".git", ".worktrees"].includes(entry.name)) continue;
        if (entry.isSymbolicLink()) throw new Error("symlink");
        const path = join(dir, entry.name);
        if (entry.isDirectory()) await visit(path);
        else if (entry.isFile() && /\.(?:[cm]?[jt]s|tsx|jsx|json|ya?ml)$/.test(entry.name)) {
          if (files.size >= maxFiles) throw new Error("file limit");
          const buffer = await readFile(path);
          bytes += buffer.byteLength;
          if (bytes > 10_000_000) throw new Error("byte limit");
          files.set(path, new TextDecoder("utf-8", { fatal: true }).decode(buffer));
        }
      }
    };
    await visit(root);
    return { files, root };
  } catch { throw new Error("Source boundary or input limit rejected"); }
}

export function digestServiceTree(files: Map<string, string>, root: string): string {
  const items = [...files].map(([path, text]) => `${relative(root, path).replaceAll("\\", "/")}\0${text}`);
  return `sha256:${createHash("sha256").update(items.join("\0")).digest("hex")}`;
}

export async function readSelectedDocument(projectRoot: string, serviceRoot: string, documentPath: string, maxBytes: number) {
  try {
    if (!normalizedPath(serviceRoot) || !normalizedPath(documentPath) || !/\.(?:json|ya?ml)$/.test(documentPath)
      || !Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("invalid selection");
    const project = await realpath(projectRoot);
    const service = resolve(project, serviceRoot);
    const document = resolve(project, documentPath);
    if (!inside(project, service) || !inside(service, document) || await realpath(service) !== service
      || await realpath(document) !== document || !(await lstat(document)).isFile()) throw new Error("outside boundary");
    const bytes = await readFile(document);
    if (bytes.byteLength > maxBytes) throw new Error("input limit");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const digest = `sha256:${createHash("sha256").update(documentPath).update("\0").update(bytes).digest("hex")}`;
    return { path: documentPath, text, digest };
  } catch {
    throw new Error("Document source rejected");
  }
}
