import {generateKeyPairSync, sign} from "node:crypto";
import {mkdtemp, rm, symlink, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, beforeEach, expect, test} from "vitest";
import {canonicalJsonStringify} from "../../packages/ir/src/index.js";
import {createSignedObservationFileReader} from "../../connectors/observation-file/src/index.js";

const importId = "550e8400-e29b-4d4a-a716-446655440000";
const recordId = "550e8400-e29b-4d4a-a716-446655440001";
const otherImportId = "550e8400-e29b-4d4a-a716-446655440002";
const expectedPin = {tenantId: "tenant-a", repositoryId: "commerce", serviceId: "orders",
  environment: "uat", snapshotId: "snapshot-a", revision: "rev-a",
  configFingerprint: "sha256:config-a", checkpointVersion: "7"};
const mappings = [{mappingId: "gateway-orders", ...expectedPin,
  publicOrigin: "https://api.example.test", publicPathTemplate: "/public/orders/{id}",
  applicationPathTemplate: "/api/orders/:id", method: "GET", routingEvidenceIds: ["routing-7"]}];
const identity = {tenantId: expectedPin.tenantId, principalId: "reader", capabilities: ["observations.import"]};
const ref = {importId, expectedPin};
const keys = generateKeyPairSync("ed25519");
const publicKeyPem = keys.publicKey.export({type: "spki", format: "pem"}).toString();
let root: string;

const payload = () => ({importId, expectedPin: {...expectedPin},
  attestation: {revision: expectedPin.revision, sourceId: "gateway-log", sourceVersion: "artifact-7",
    windowStart: "2026-10-09T00:00:00Z", windowEnd: "2026-10-09T01:00:00Z"},
  records: [{recordId, raw: {url: "https://api.example.test/public/orders/123?secret=CANARY_SECRET_123",
    method: "GET", statusCode: 200, revision: expectedPin.revision,
    headers: {authorization: "CANARY_SECRET_123"}, body: {email: "CANARY_SECRET_123@example.test"}}}]});
const envelope = (value: unknown) => ({payload: value,
  signature: sign(null, Buffer.from(canonicalJsonStringify(value), "utf8"), keys.privateKey).toString("base64")});
const pathFor = (id = importId) => join(root, `${id}.json`);
const reader = (key = publicKeyPem) => createSignedObservationFileReader({root, publicKeyPem: key,
  sourceId: "gateway-log", mappings});

beforeEach(async () => {root = await mkdtemp(join(tmpdir(), "observation-file-test-"));});
afterEach(async () => {await rm(root, {recursive: true, force: true});});

test("a known Ed25519 signer binds the selected file, pin, attestation, and records", async () => {
  await writeFile(pathFor(), JSON.stringify(envelope(payload())));
  const readBatch = await reader();
  const result = await readBatch(identity, ref);
  expect(result).toMatchObject({attestation: {sourceId: "gateway-log", revision: expectedPin.revision},
    records: [{recordId, raw: {method: "GET", statusCode: 200}}], mappings});
  expect(result.mappings).toEqual(mappings);
  expect(result).not.toHaveProperty("signature");
});

test("tampering, wrong key, and unsigned content fail with fixed errors", async () => {
  const signed = envelope(payload());
  await writeFile(pathFor(), JSON.stringify({...signed,
    payload: {...payload(), records: [{recordId, raw: {url: "https://attacker.test/CANARY_SECRET_123",
      method: "GET", statusCode: 200, revision: expectedPin.revision}}]}}));
  await expect((await reader())(identity, ref)).rejects.toMatchObject({code: "OBSERVATION_FILE_REJECTED"});
  await writeFile(pathFor(), JSON.stringify(signed));
  const other = generateKeyPairSync("ed25519").publicKey.export({type: "spki", format: "pem"}).toString();
  await expect((await reader(other))(identity, ref)).rejects.toMatchObject({code: "OBSERVATION_FILE_REJECTED"});
  await writeFile(pathFor(), JSON.stringify(payload()));
  await expect((await reader())(identity, ref)).rejects.toMatchObject({code: "OBSERVATION_FILE_REJECTED"});
});

test("signed wrong import, pin, or source cannot become the selected batch", async () => {
  const readBatch = await reader();
  for (const wrong of [
    {...payload(), importId: otherImportId},
    {...payload(), expectedPin: {...expectedPin, revision: "other-revision"}},
    {...payload(), attestation: {...payload().attestation, sourceId: "other-source"}},
  ]) {
    await writeFile(pathFor(), JSON.stringify(envelope(wrong)));
    await expect(readBatch(identity, ref)).rejects.toMatchObject({code: "OBSERVATION_FILE_REJECTED"});
  }
});

test("bounded strict JSON rejects oversize, duplicate keys, and deep records", async () => {
  const readBatch = await reader();
  await writeFile(pathFor(), "x".repeat(1_048_577));
  await expect(readBatch(identity, ref)).rejects.toMatchObject({code: "OBSERVATION_FILE_REJECTED"});
  const signed = envelope(payload());
  const duplicate = JSON.stringify(signed).replace('"signature":', '"signature":"invalid","signature":');
  await writeFile(pathFor(), duplicate);
  await expect(readBatch(identity, ref)).rejects.toMatchObject({code: "OBSERVATION_FILE_REJECTED"});
  let deep: unknown = "CANARY_SECRET_123";
  for (let index = 0; index < 24; index += 1) deep = {nested: deep};
  const value = {...payload(), records: [{recordId, raw: deep}]};
  await writeFile(pathFor(), JSON.stringify(envelope(value)));
  await expect(readBatch(identity, ref)).rejects.toMatchObject({code: "OBSERVATION_FILE_REJECTED"});
  const many = {...payload(), records: Array.from({length: 101}, (_item, index) => ({
    recordId: `550e8400-e29b-4d4a-a716-${String(index).padStart(12, "0")}`,
    raw: {url: "https://api.example.test/public/orders/1", method: "GET", statusCode: 200,
      revision: expectedPin.revision}}))};
  await writeFile(pathFor(), JSON.stringify(envelope(many)));
  await expect(readBatch(identity, ref)).rejects.toMatchObject({code: "OBSERVATION_FILE_REJECTED"});
  await writeFile(pathFor(), Buffer.from([0xff, 0xfe, 0xfd]));
  await expect(readBatch(identity, ref)).rejects.toMatchObject({code: "OBSERVATION_FILE_REJECTED"});
});

test("only the explicit UUID file is opened; symlink and escape attempts fail", async () => {
  const readBatch = await reader();
  await writeFile(pathFor(otherImportId), JSON.stringify(envelope(payload())));
  await expect(readBatch(identity, ref)).rejects.toMatchObject({code: "OBSERVATION_FILE_UNAVAILABLE"});
  await symlink(pathFor(otherImportId), pathFor());
  await expect(readBatch(identity, ref)).rejects.toMatchObject({code: "OBSERVATION_FILE_REJECTED"});
  await expect(readBatch(identity, {...ref, importId: "../outside"}))
    .rejects.toMatchObject({code: "OBSERVATION_FILE_REJECTED"});
  await expect(readBatch(identity, {...ref, expectedPin: {...expectedPin,
    checkpointVersion: "9223372036854775808"}}))
    .rejects.toMatchObject({code: "OBSERVATION_FILE_REJECTED"});
});

test("errors never disclose raw URLs, secrets, filesystem paths, or exception text", async () => {
  await writeFile(pathFor(), JSON.stringify({...envelope(payload()), signature: "CANARY_SECRET_123"}));
  try {await (await reader())(identity, ref); throw new Error("expected rejection");}
  catch (error) {
    expect(error).toMatchObject({code: "OBSERVATION_FILE_REJECTED", message: "OBSERVATION_FILE_REJECTED"});
    expect(JSON.stringify(error)).not.toMatch(/CANARY_SECRET_123|api\.example\.test|observation-file-test-/);
  }
  const hostile = Object.defineProperty({...ref}, "importId", {get() {throw new Error("CANARY_SECRET_123");}});
  await expect((await reader())(identity, hostile))
    .rejects.toMatchObject({code: "OBSERVATION_FILE_REJECTED", message: "OBSERVATION_FILE_REJECTED"});
});
