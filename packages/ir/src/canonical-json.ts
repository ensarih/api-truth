/** Stable JSON key ordering. Array order and native JSON value semantics are preserved. */
export function canonicalJsonStringify(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("NON_SERIALIZABLE_JSON");
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize);
    if (item !== null && typeof item === "object")
      return Object.fromEntries(Object.entries(item).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, child]) => [key, normalize(child)]));
    return item;
  };
  return JSON.stringify(normalize(JSON.parse(serialized)));
}
