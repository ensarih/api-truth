import {readFile, readdir} from "node:fs/promises";
import {registerHooks} from "node:module";
import {tmpdir} from "node:os";

if (process.version !== "v24.6.0") throw new Error("Pinned analyzer Node required");
const roots = [new URL("../../../packages/ir/src/", import.meta.url).href,
  new URL("../../../analyzers/nodejs/src/", import.meta.url).href,
  new URL("../../../connectors/git-source/src/", import.meta.url).href];
registerHooks({resolve(specifier, context, nextResolve) {
  if (specifier.startsWith(".") && specifier.endsWith(".js") && roots.some(root => context.parentURL?.startsWith(root))) {
    const target = new URL(specifier.replace(/\.js$/, ".ts"), context.parentURL);
    if (roots.some(root => target.href.startsWith(root))) return nextResolve(target.href, context);
  }
  return nextResolve(specifier, context);
}});

const [{createRuntimeCapturePinResolver}, {createProtectedCaptureVerificationPort},
  {createProtectedSwaggerDocumentCorrespondencePort}] = await Promise.all([
  import("../../../connectors/git-source/src/runtime-capture-pin.ts"),
  import("../../../connectors/git-source/src/protected-capture-verification.ts"),
  import("../../../connectors/git-source/src/protected-swagger-document-correspondence.ts"),
]);
const config = JSON.parse(await readFile(process.argv[2], "utf8"));
const before = (await readdir(tmpdir())).filter(name => name.startsWith("api-truth-git-source-")).sort();
const protectedPorts = {authorize: async () => true,
  readReceipt: async () => readFile(config.receiptPath, "utf8"),
  readKey: async () => readFile(config.keyPath, "utf8")};
const pinResolver = createRuntimeCapturePinResolver({binding: {scope: config.scope,
  artifactRef: "capture:verified-fixture", configuredKeyRef: "key:verified-fixture",
  expectedReceiptDigest: config.expectedReceiptDigest,
  expectedSignerSpkiDigest: config.expectedSignerSpkiDigest, policyVersion: "runtime-capture-pin-1"},
  ...protectedPorts});
const verifier = createProtectedCaptureVerificationPort({repoPath: config.repoPath,
  serviceRoot: ".", scope: config.scope, expectedCaptureIdentityDigest: config.expectedCaptureIdentityDigest,
  pinResolver, ...protectedPorts, limits: {maxFiles: 100, maxBytes: 2_000_000, timeoutMs: 10_000}});
const result = await verifier.verify();
const correspondence = await createProtectedSwaggerDocumentCorrespondencePort({repoPath: config.repoPath,
  serviceRoot: ".", scope: config.scope, expectedCaptureIdentityDigest: config.expectedCaptureIdentityDigest,
  pinResolver, ...protectedPorts, documentPath: "api/swagger/swagger.yaml",
  expectedRawDocumentSha256: config.expectedRawDocumentSha256,
  limits: {maxFiles: 100, maxBytes: 2_000_000, timeoutMs: 10_000}}).verify();
const after = (await readdir(tmpdir())).filter(name => name.startsWith("api-truth-git-source-")).sort();
if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error("Owned Git source tree was not cleaned");
if (result.handlers.length !== 1 || result.handlers[0].handlerDigest !== config.expectedHandlerDigest)
  throw new Error("Handler bytes did not match capture");
process.stdout.write(JSON.stringify({...result, correspondence, revision: config.scope.immutableRevision,
  expectedCaptureIdentityDigest: config.expectedCaptureIdentityDigest,
  expectedHandlerDigest: config.expectedHandlerDigest,
  expectedRawDocumentSha256: config.expectedRawDocumentSha256, ownedTempCleaned: true}));
