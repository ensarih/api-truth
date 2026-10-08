import {createHash, createPublicKey, verify} from "node:crypto";
import {resolve} from "node:path";
import {Type, type Static} from "@sinclair/typebox";
import {Value} from "@sinclair/typebox/value";
import {parseStrictJson} from "./strict-json.js";

export const runtimeBindingFilename = "api-truth.runtime-binding.json";
export const supportedRouterDigest = "sha256:d716c923ac7868402a98a47740e95ee83b0be5c9201daf4e11e0b13fe626f416";
const digest = Type.String({pattern: "^sha256:[a-f0-9]{64}$"});
const name = Type.String({minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9_.-]+$"});
const identifier = Type.String({minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9_$.-]+$"});
const Binding = Type.Object({
  method: Type.Union(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].map(value => Type.Literal(value))),
  application_path: Type.String({minLength: 1, maxLength: 2048, pattern: "^/"}),
  controller: Type.String({minLength: 1, maxLength: 128}), operation_id: identifier, export_name: identifier,
  handler_path: Type.String({minLength: 1, maxLength: 1024, pattern: "^[A-Za-z0-9_@+.-]+(?:/[A-Za-z0-9_@+.-]+)*$"}),
  handler_digest: digest, mock_mode: Type.Literal(false),
}, {additionalProperties: false});
export const RuntimeBindingReceiptSchema = Type.Object({version: Type.Literal("1.0.0"), repository_id: name, service_id: name,
  immutable_revision: Type.String({pattern: "^[a-fA-F0-9]{12,128}$"}), source_digest: digest,
  environment: name, session_id: name, captured_at: Type.String({maxLength: 30}),
  node_version: Type.Literal("22.19.0"), router_digest: Type.Literal(supportedRouterDigest), runtime_fingerprint: digest,
  bindings: Type.Array(Binding, {maxItems: 1024}),
}, {additionalProperties: false});
export type RuntimeBinding = Static<typeof Binding>;
export type RuntimeBindingResolution = {kind: "unresolved"; path: string; receipt_digest: string; signer_digest: string} |
  {kind: "verified"; path: string; receipt_digest: string; signer_digest: string; environment: string;
    session_id: string; captured_at: string; runtime_fingerprint: string; bindings: RuntimeBinding[]};
export const sha256 = (text: string | Buffer): string => `sha256:${createHash("sha256").update(text).digest("hex")}`;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** Trusted signer attests the runtime context; receipt bytes alone never establish trust. */
export function verifyRuntimeBindings(input: {text: string; publicKey: string; path: string;
  source: {repository_id: string; service_id: string; immutable_revision: string; source_digest: string};
  files: Map<string, string>; root: string}): RuntimeBindingResolution {
  let signer_digest = sha256(input.publicKey);
  const receipt_digest = sha256(input.text);
  const unresolved = (): RuntimeBindingResolution => ({kind: "unresolved", path: input.path, receipt_digest, signer_digest});
  try {
    if (Buffer.byteLength(input.text) > 1_000_000 || Buffer.byteLength(input.publicKey) > 10000) return unresolved();
    if (!input.publicKey.startsWith("-----BEGIN PUBLIC KEY-----")) return unresolved();
    const key = createPublicKey(input.publicKey);
    if (key.asymmetricKeyType !== "ed25519") return unresolved();
    signer_digest = sha256(key.export({type: "spki", format: "der"}));
    const envelope = parseStrictJson(input.text);
    if (!object(envelope) || Object.keys(envelope).length !== 2 || typeof envelope.payload !== "string"
      || typeof envelope.signature !== "string") return unresolved();
    const bytes = Buffer.from(envelope.payload, "base64"), signature = Buffer.from(envelope.signature, "base64");
    if (bytes.toString("base64") !== envelope.payload || signature.toString("base64") !== envelope.signature
      || signature.length !== 64 || !verify(null, bytes, key, signature)) return unresolved();
    const receipt = parseStrictJson(bytes.toString("utf8"));
    if (!Value.Check(RuntimeBindingReceiptSchema, receipt)) return unresolved();
    if (new Date(receipt.captured_at).toISOString() !== receipt.captured_at) return unresolved();
    for (const field of ["repository_id", "service_id", "immutable_revision", "source_digest"] as const)
      if (receipt[field] !== input.source[field]) return unresolved();
    const seen = new Set<string>();
    for (const binding of receipt.bindings) {
      const identity = `${binding.method}:${binding.application_path}`;
      if (seen.has(identity) || binding.export_name !== binding.operation_id
        || binding.handler_path.split("/").some(part => part === "." || part === "..")) return unresolved();
      seen.add(identity);
      const source = input.files.get(resolve(input.root, binding.handler_path));
      if (source === undefined || sha256(source) !== binding.handler_digest) return unresolved();
    }
    return {kind: "verified", path: input.path, receipt_digest, signer_digest,
      environment: receipt.environment, session_id: receipt.session_id, captured_at: receipt.captured_at,
      runtime_fingerprint: receipt.runtime_fingerprint, bindings: receipt.bindings};
  } catch { return unresolved(); }
}
