import type { Readable, Writable } from "node:stream";
import { normalizeLocalFact, ReferenceAdapterError } from "./adapter.js";

/** Formats one local fixture fact. Policy comes from the host, never from fact stdin. No event is ingested. */
export const runLocalAdapterCli = async (input: Readable, output: Writable, errors: Writable,
  policy: Parameters<typeof normalizeLocalFact>[1]): Promise<number> => {
  let body = "";
  let bytes = 0;
  try {
    for await (const chunk of input) {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 64 * 1024) throw new ReferenceAdapterError("INVALID_INPUT");
      body += String(chunk);
    }
    const fact: unknown = JSON.parse(body);
    const event = normalizeLocalFact(fact, policy);
    output.write(`${JSON.stringify(event)}\n`);
    return 0;
  } catch (error) {
    errors.write(`${error instanceof ReferenceAdapterError ? error.code : "INVALID_INPUT"}\n`);
    return 1;
  }
};

