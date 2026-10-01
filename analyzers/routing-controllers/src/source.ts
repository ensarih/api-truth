import { createHash } from "node:crypto";
import { readdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

export const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};
export { inside };

export async function readSources(projectRoot: string, serviceRoot: string, maxFiles: number, budget: () => void) {
  try {
    const project = await realpath(projectRoot);
    const root = resolve(project, serviceRoot);
    if (!inside(project, root) || await realpath(root) !== root) throw new Error("boundary");
    const files = new Map<string, string>();
    let bytes = 0;
    const visit = async (dir: string) => {
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

export const digestSources = (files: Map<string, string>, root: string) =>
  `sha256:${hash([...files].map(([path, text]) => `${relative(root, path).replaceAll("\\", "/")}\0${text}`).join("\0"))}`;
