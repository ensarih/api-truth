import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

const normalizedPath = (path: string): boolean =>
  path === "." || /^[A-Za-z0-9_@+.-]+(?:\/[A-Za-z0-9_@+.-]+)*$/.test(path)
    && !path.split("/").some(segment => segment === "." || segment === "..");

const inside = (root: string, path: string): boolean => {
  const rel = relative(root, path);
  return rel === "" || !rel.startsWith("..") && !isAbsolute(rel);
};

export async function readSelectedDocument(projectRoot: string, serviceRoot: string, documentPath: string, maxBytes: number) {
  try {
    if (!normalizedPath(serviceRoot) || !normalizedPath(documentPath) || !documentPath.endsWith(".json")
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
