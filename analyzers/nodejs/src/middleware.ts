import { createHash } from "node:crypto";
import { resolve } from "node:path";
import {
  parseAnalyzerRequest, parseAnalyzerResult, type AnalyzerRequest, type AnalyzerResult,
} from "../../../packages/ir/src/index.js";
import {verifyRuntimeBindings, runtimeBindingFilename, sha256} from "./runtime-binding.js";
import { resolveSwaggerStartup } from "./startup.js";
import { extractSwagger2Document } from "./index.js";
import { resolveSwaggerFrameworkLock } from "./framework-lock.js";
import { findSwaggerMiddlewareBinding } from "./middleware-binding.js";
import { resolveSwaggerRoutingConfiguration } from "./routing-config.js";
import { createHandlerCandidateResolver, inspectBoundResponseStatus } from "./handler-candidates.js";
import { digestServiceTree, inside, readServiceTree } from "./source.js";

/** Direct swagger-express-mw default-file registration; optional signed observations establish session-scoped handler binding. */
export const ANALYZER = { analyzer_id: "nodejs-swagger-express-mw", analyzer_version: "0.33.0" };
const defaultDocument = "api/swagger/swagger.yaml";
const digestDocument = (path: string, text: string): string =>
  `sha256:${createHash("sha256").update(path).update("\0").update(text).digest("hex")}`;

export function createAnalyzer(options: { projectRoot: string; trustedRuntimePublicKey?: string }) {
  return { async analyze(input: unknown): Promise<AnalyzerResult> {
    const parsed = parseAnalyzerRequest(input);
    if (!parsed.ok) throw new Error("Invalid analyzer request");
    let request = parsed.value;
    if (request.ir_version !== "1.1.0") throw new Error("Swagger profile requires IR 1.1.0");
    if (request.analyzer.analyzer_id !== ANALYZER.analyzer_id || request.analyzer.analyzer_version !== ANALYZER.analyzer_version)
      throw new Error("Unsupported analyzer version");
    const project = resolve(options.projectRoot);
    const root = resolve(project, request.source.service_root);
    const expectedDocument = request.source.service_root === "." ? defaultDocument
      : `${request.source.service_root}/${defaultDocument}`;
    const selected = request.resolution_inputs[1];
    const runtimeInput = request.resolution_inputs[2];
    const expectedReceipt = request.source.service_root === "." ? runtimeBindingFilename : `${request.source.service_root}/${runtimeBindingFilename}`;
    if (runtimeInput && (runtimeInput.kind !== "runtime_observation" || runtimeInput.path !== expectedReceipt
      || !options.trustedRuntimePublicKey || !/^sha256:[a-f0-9]{64}$/.test(runtimeInput.digest)))
      throw new Error("Unsupported runtime binding input");
    if (request.resolution_inputs.length !== (runtimeInput ? 3 : 2) || request.resolution_inputs[0]?.kind !== "source_tree"
      || request.resolution_inputs[0].path !== request.source.service_root
      || selected?.kind !== "type_manifest" || selected.path !== expectedDocument
      || request.changed_paths.some(path => !inside(root, resolve(project, path))))
      throw new Error("Unsupported middleware resolution inputs");
    const started = Date.now();
    const budget = () => { if (Date.now() - started > request.limits.timeout_ms) throw new Error("Analysis time limit exceeded"); };
    const tree = await readServiceTree(project, request.source.service_root, request.limits.max_files, budget);
    const documentPath = resolve(tree.root, defaultDocument);
    const text = tree.files.get(documentPath);
    if (text === undefined) throw new Error("Selected middleware document rejected");
    const receiptText = runtimeInput ? tree.files.get(resolve(tree.root, runtimeBindingFilename)) : undefined;
    if (runtimeInput) {
      if (receiptText === undefined || sha256(receiptText) !== runtimeInput.digest) throw new Error("Runtime receipt digest mismatch");
      tree.files.delete(resolve(tree.root, runtimeBindingFilename));
    }
    const treeDigest = digestServiceTree(tree.files, tree.root, tree.opaqueConfiguration);
    const documentDigest = digestDocument(expectedDocument, text);
    const claimed: Array<[string, string]> = [
      [request.source.source_digest, treeDigest], [request.resolution_inputs[0].digest, treeDigest],
      [selected.digest, documentDigest],
    ];
    if (claimed.some(([value, actual]) => /^sha256:[a-f0-9]{64}$/i.test(value)
      && value.toLowerCase() !== actual)) throw new Error("Source digest mismatch");
    request = {
      ...request,
      extraction_mode: request.extraction_mode === "incremental" ? "fallback_full_service" : request.extraction_mode,
      source: { ...request.source, source_digest: treeDigest },
      resolution_inputs: [{ kind: "source_tree", path: request.source.service_root, digest: treeDigest },
        { kind: "type_manifest", path: expectedDocument, digest: documentDigest }, ...(runtimeInput ? [runtimeInput] : [])],
    };
    const binding = findSwaggerMiddlewareBinding(tree.files, tree.root);
    budget();
    const startup = resolveSwaggerStartup(tree.files, tree.root, binding, budget);
    const routingConfiguration = resolveSwaggerRoutingConfiguration(tree.files, tree.root, tree.opaqueConfiguration,
      binding?.mock_mode ? {value: binding.mock_mode.value, location: {path: binding.path, pointer: binding.mock_mode.pointer}} : undefined,
      startup.kind === "declared" && startup.environment_name
        ? {name: startup.environment_name, location: {path: "package.json", pointer: "/scripts/start"}} : undefined);
    const result = extractSwagger2Document(request, expectedDocument, text,
      binding ? { kind: "verified", binding, routingConfiguration,
        frameworkLock: resolveSwaggerFrameworkLock(tree.files, tree.root, tree.opaqueConfiguration),
        startup,
        ...(runtimeInput && receiptText ? {runtimeBinding: verifyRuntimeBindings({text: receiptText,
          publicKey: options.trustedRuntimePublicKey!, path: runtimeBindingFilename, source: request.source,
          files: tree.files, root: tree.root})} : {}),
        responseStatusResolver: binding => inspectBoundResponseStatus(binding.handler_path,
          tree.files.get(resolve(tree.root, binding.handler_path))!, binding.export_name, budget),
        handlerResolver: createHandlerCandidateResolver(tree.files, tree.root, routingConfiguration, budget) }
        : { kind: "unverified" });
    budget();
    if (Buffer.byteLength(JSON.stringify(result)) > request.limits.max_output_bytes) throw new Error("Analysis output limit exceeded");
    const validated = parseAnalyzerResult(result);
    if (!validated.ok) throw new Error("Analyzer produced invalid result");
    return validated.value;
  } };
}

export async function analyze(request: AnalyzerRequest): Promise<AnalyzerResult> {
  return createAnalyzer({ projectRoot: process.cwd() }).analyze(request);
}
