import {createPublicKey, verify, type KeyObject} from "node:crypto";
import {constants} from "node:fs";
import {lstat, open, realpath} from "node:fs/promises";
import {isAbsolute, join, resolve} from "node:path";
import {isProxy} from "node:util/types";
import {canonicalJsonStringify} from "../../../packages/ir/src/index.js";
import {parseStrictJson} from "../../../packages/ir/src/strict-json.js";
import type {TrustedRouteMapping} from "../../../packages/observations/src/types.js";

const maxBytes = 1_048_576;
const maxRecords = 100;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const identifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const pinKeys = ["tenantId", "repositoryId", "serviceId", "environment", "snapshotId",
  "revision", "configFingerprint", "checkpointVersion"] as const;
const attestationKeys = ["revision", "sourceId", "sourceVersion", "windowStart", "windowEnd"] as const;
const utf8 = new TextDecoder("utf-8", {fatal: true});

export class ObservationFileError extends Error {
  readonly code: "OBSERVATION_FILE_INVALID_CONFIG" | "OBSERVATION_FILE_UNAVAILABLE" | "OBSERVATION_FILE_REJECTED";
  constructor(code: ObservationFileError["code"]) {super(code); this.name = "ObservationFileError"; this.code = code;}
}

type Pin = {[K in (typeof pinKeys)[number]]: string};
export type SignedObservationFileBatch = Readonly<{
  attestation: Readonly<{revision: string; sourceId: string; sourceVersion: string;
    windowStart: string; windowEnd: string}>;
  mappings: readonly TrustedRouteMapping[];
  records: readonly Readonly<{recordId: string; raw: unknown}>[];
}>;

const object = (value: unknown, names: readonly string[]): Record<string, unknown> | undefined => {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value) || isProxy(value)
      || Object.getPrototypeOf(value) !== Object.prototype) return undefined;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== names.length || keys.some(key => typeof key !== "string" || !names.includes(key)))
      return undefined;
    const output: Record<string, unknown> = {};
    for (const name of names) {
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      if (!descriptor || !("value" in descriptor)) return undefined;
      output[name] = descriptor.value;
    }
    return output;
  } catch {return undefined;}
};

const parsePin = (value: unknown): Pin | undefined => {
  const parsed = object(value, pinKeys);
  if (!parsed || pinKeys.some(key => typeof parsed[key] !== "string" || !identifier.test(parsed[key] as string)))
    return undefined;
  if (!/^[1-9][0-9]{0,18}$/.test(parsed.checkpointVersion as string)
    || BigInt(parsed.checkpointVersion as string) > 9223372036854775807n) return undefined;
  return parsed as Pin;
};

const samePin = (left: Pin, right: Pin): boolean => pinKeys.every(key => left[key] === right[key]);

const selectedRef = (identity: unknown, reference: unknown): {importId: string; expectedPin: Pin} => {
  const ref = object(reference, ["importId", "expectedPin"]);
  const pin = parsePin(ref?.expectedPin);
  const importer = object(identity, ["tenantId", "principalId", "capabilities"]);
  if (!ref || typeof ref.importId !== "string" || !uuid.test(ref.importId) || !pin
    || importer?.tenantId !== pin.tenantId) throw new ObservationFileError("OBSERVATION_FILE_REJECTED");
  return {importId: ref.importId, expectedPin: pin};
};

const keyFromPem = (pem: string): KeyObject => {
  if (Buffer.byteLength(pem, "utf8") > 10_000 || !pem.startsWith("-----BEGIN PUBLIC KEY-----"))
    throw new ObservationFileError("OBSERVATION_FILE_INVALID_CONFIG");
  const key = createPublicKey(pem);
  if (key.asymmetricKeyType !== "ed25519")
    throw new ObservationFileError("OBSERVATION_FILE_INVALID_CONFIG");
  return key;
};

const readSelectedFile = async (root: string, importId: string): Promise<string> => {
  const path = join(root, `${importId}.json`);
  let handle;
  try {
    const entry = await lstat(path);
    if (entry.isSymbolicLink() || !entry.isFile() || entry.size > maxBytes)
      throw new ObservationFileError("OBSERVATION_FILE_REJECTED");
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) throw new ObservationFileError("OBSERVATION_FILE_REJECTED");
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = await handle.read(buffer, length, buffer.length - length, length);
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
    }
    if (length > maxBytes) throw new ObservationFileError("OBSERVATION_FILE_REJECTED");
    return utf8.decode(buffer.subarray(0, length));
  } catch (error) {
    if (error instanceof ObservationFileError) throw error;
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
      throw new ObservationFileError("OBSERVATION_FILE_UNAVAILABLE");
    throw new ObservationFileError("OBSERVATION_FILE_REJECTED");
  } finally {await handle?.close().catch(() => undefined);}
};

const parseEnvelope = (text: string, key: KeyObject, importId: string,
  expectedPin: Pin, sourceId: string, mappings: readonly TrustedRouteMapping[]): SignedObservationFileBatch => {
  const envelope = object(parseStrictJson(text, {maxDepth: 16, maxNodes: 8_000}), ["payload", "signature"]);
  const payload = object(envelope?.payload, ["importId", "expectedPin", "attestation", "records"]);
  if (!envelope || !payload || typeof envelope.signature !== "string"
    || !/^[A-Za-z0-9+/]{86}==$/.test(envelope.signature))
    throw new ObservationFileError("OBSERVATION_FILE_REJECTED");
  const signature = Buffer.from(envelope.signature, "base64");
  if (signature.length !== 64 || signature.toString("base64") !== envelope.signature
    || !verify(null, Buffer.from(canonicalJsonStringify(payload), "utf8"), key, signature))
    throw new ObservationFileError("OBSERVATION_FILE_REJECTED");
  const signedPin = parsePin(payload.expectedPin);
  const attestation = object(payload.attestation, attestationKeys);
  if (payload.importId !== importId || !signedPin || !samePin(signedPin, expectedPin)
    || !attestation || attestationKeys.some(field => typeof attestation[field] !== "string"
      || (attestation[field] as string).length > 128)
    || attestation.sourceId !== sourceId || attestation.revision !== expectedPin.revision
    || !Array.isArray(payload.records) || payload.records.length < 1 || payload.records.length > maxRecords)
    throw new ObservationFileError("OBSERVATION_FILE_REJECTED");
  const seen = new Set<string>();
  const records = payload.records.map(value => {
    const record = object(value, ["recordId", "raw"]);
    if (!record || typeof record.recordId !== "string" || !uuid.test(record.recordId)
      || seen.has(record.recordId)) throw new ObservationFileError("OBSERVATION_FILE_REJECTED");
    seen.add(record.recordId);
    return Object.freeze({recordId: record.recordId, raw: record.raw});
  });
  return Object.freeze({attestation: Object.freeze(attestation) as SignedObservationFileBatch["attestation"],
    mappings, records: Object.freeze(records)});
};

/** Read one explicitly selected signed file. The caller supplies mappings outside the signed log envelope. */
export const createSignedObservationFileReader = async (options: {root: string; publicKeyPem: string;
  sourceId: string; mappings: readonly TrustedRouteMapping[]}) => {
  try {
    if (typeof options.root !== "string" || !isAbsolute(options.root)
      || typeof options.publicKeyPem !== "string" || typeof options.sourceId !== "string"
      || !identifier.test(options.sourceId) || !Array.isArray(options.mappings)
      || options.mappings.length > 32) throw new ObservationFileError("OBSERVATION_FILE_INVALID_CONFIG");
    const root = resolve(options.root);
    const entry = await lstat(root);
    if (!entry.isDirectory() || entry.isSymbolicLink())
      throw new ObservationFileError("OBSERVATION_FILE_INVALID_CONFIG");
    const canonicalRoot = await realpath(root);
    const key = keyFromPem(options.publicKeyPem);
    const sourceId = options.sourceId;
    const mappings = Object.freeze(structuredClone(options.mappings)) as readonly TrustedRouteMapping[];
    return async (identity: unknown, reference: unknown): Promise<SignedObservationFileBatch> => {
      try {
        const ref = selectedRef(identity, reference);
        const text = await readSelectedFile(canonicalRoot, ref.importId);
        return parseEnvelope(text, key, ref.importId, ref.expectedPin, sourceId, mappings);
      } catch (error) {
        if (error instanceof ObservationFileError) throw error;
        throw new ObservationFileError("OBSERVATION_FILE_REJECTED");
      }
    };
  } catch {
    throw new ObservationFileError("OBSERVATION_FILE_INVALID_CONFIG");
  }
};

export {createSignedFieldPresenceFileReader,SignedFieldPresenceFileError} from "./field-presence.js";
export type {SignedFieldPresenceFileErrorCode,SignedFieldPresenceFileBinding,SignedFieldPresenceFileReaderOptions} from "./field-presence.js";
