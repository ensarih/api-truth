export class StrictJsonError extends Error {
  constructor(readonly code: "invalid_json_document" | "duplicate_json_key" | "document_structure_limit_exceeded") {
    super("Selected JSON document rejected");
  }
}

/** Validate syntax, duplicate decoded keys, and structural limits before using JSON values. */
export function parseStrictJson(text: string, options: { maxDepth?: number; maxNodes?: number } = {}): unknown {
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { throw new StrictJsonError("invalid_json_document"); }
  const maxDepth = options.maxDepth ?? 128;
  const maxNodes = options.maxNodes ?? 50_000;
  let index = 0;
  let nodes = 0;
  const whitespace = () => { while (/\s/.test(text[index] ?? "") && index < text.length) index += 1; };
  const string = (): string => {
    const start = index;
    index += 1;
    while (index < text.length) {
      if (text[index] === "\\") { index += 2; continue; }
      if (text[index] === '"') { index += 1; return JSON.parse(text.slice(start, index)) as string; }
      index += 1;
    }
    throw new StrictJsonError("invalid_json_document");
  };
  const scan = (depth: number): void => {
    if (++nodes > maxNodes || depth > maxDepth) throw new StrictJsonError("document_structure_limit_exceeded");
    whitespace();
    if (text[index] === "{") {
      index += 1; whitespace();
      const keys = new Set<string>();
      if (text[index] === "}") { index += 1; return; }
      while (index < text.length) {
        const key = string();
        if (keys.has(key)) throw new StrictJsonError("duplicate_json_key");
        keys.add(key); whitespace();
        index += 1; // Colon; syntax was already checked by JSON.parse.
        scan(depth + 1); whitespace();
        if (text[index] === "}") { index += 1; return; }
        index += 1; whitespace(); // Comma.
      }
    } else if (text[index] === "[") {
      index += 1; whitespace();
      if (text[index] === "]") { index += 1; return; }
      while (index < text.length) {
        scan(depth + 1); whitespace();
        if (text[index] === "]") { index += 1; return; }
        index += 1; whitespace(); // Comma.
      }
    } else if (text[index] === '"') string();
    else while (index < text.length && !/[\s,\]}]/.test(text[index]!)) index += 1;
  };
  scan(0);
  return value;
}
