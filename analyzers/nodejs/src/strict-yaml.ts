import { isAlias, isMap, isScalar, isSeq, parseDocument } from "yaml";

export class StrictYamlError extends Error {
  readonly code: "invalid_yaml_document" | "document_structure_limit_exceeded" | "yaml_alias_unsupported";
  constructor(code: StrictYamlError["code"]) {
    super("Selected YAML document rejected");
    this.code = code;
  }
}

/** Parse one bounded YAML 1.2 document into JSON-compatible values. */
export function parseStrictYaml(text: string, options: { maxDepth?: number; maxNodes?: number } = {}): unknown {
  const maxDepth = options.maxDepth ?? 128;
  const maxNodes = options.maxNodes ?? 50_000;
  let document: ReturnType<typeof parseDocument>;
  try {
    document = parseDocument(text, {
      version: "1.2", strict: true, uniqueKeys: true, stringKeys: true, merge: false,
    });
  } catch { throw new StrictYamlError("invalid_yaml_document"); }
  if (document.errors.length || document.warnings.length || !document.contents)
    throw new StrictYamlError("invalid_yaml_document");

  let count = 0;
  const stack: Array<{ node: unknown; depth: number }> = [{ node: document.contents, depth: 0 }];
  while (stack.length) {
    const { node, depth } = stack.pop()!;
    if (++count > maxNodes || depth > maxDepth) throw new StrictYamlError("document_structure_limit_exceeded");
    if (isAlias(node)) throw new StrictYamlError("yaml_alias_unsupported");
    if (isMap(node)) {
      for (const pair of node.items) {
        if (!isScalar(pair.key) || typeof pair.key.value !== "string")
          throw new StrictYamlError("invalid_yaml_document");
        if (["__proto__", "prototype", "constructor"].includes(pair.key.value))
          throw new StrictYamlError("invalid_yaml_document");
        stack.push({ node: pair.value, depth: depth + 1 });
      }
    } else if (isSeq(node)) {
      for (const item of node.items) stack.push({ node: item, depth: depth + 1 });
    } else if (isScalar(node)) {
      const value = node.value;
      if (value !== null && typeof value !== "string" && typeof value !== "boolean"
        && !(typeof value === "number" && Number.isFinite(value)))
        throw new StrictYamlError("invalid_yaml_document");
    } else throw new StrictYamlError("invalid_yaml_document");
  }
  try { return document.toJS({ maxAliasCount: 0 }); }
  catch { throw new StrictYamlError("invalid_yaml_document"); }
}
