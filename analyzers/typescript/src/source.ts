import { createHash } from "node:crypto";
import { readdir, readFile, realpath } from "node:fs/promises";
import { resolve, relative, join, isAbsolute } from "node:path";

export const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};
export const digestSources = (files: Map<string, string>, root: string) =>
  `sha256:${hash([...files].map(([path, text]) => `${relative(root, path).replaceAll("\\", "/")}\0${text}`).join("\0"))}`;

export async function readSources(projectRoot: string, serviceRoot: string, maxFiles: number, budget: () => void) {
  const files = new Map<string, string>();
  try {
    const project = await realpath(projectRoot);
    const root = await realpath(resolve(projectRoot, serviceRoot));
    if (!inside(project, root) || root !== resolve(project, serviceRoot)) throw new Error("boundary");
    const collect = async (directory: string) => {
      budget();
      for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        if (["node_modules", ".git", ".worktrees"].includes(entry.name)) continue;
        if (entry.isSymbolicLink()) throw new Error("boundary");
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await collect(path);
        else if (/\.(?:[cm]?ts|[cm]?js|tsx|jsx)$/.test(entry.name)) {
          if (files.size >= maxFiles) throw new Error("limit");
          const text = await readFile(path, "utf8");
          if (text.length > 2_000_000) throw new Error("limit");
          files.set(path, text);
        }
      }
    };
    await collect(root);
    return { files, root };
  } catch { throw new Error("Source boundary or input limit rejected"); }
}
