import { relative, resolve } from "node:path";
import ts from "typescript";
import {
  deriveEndpointIdentity, parseAnalyzerRequest, parseAnalyzerResult,
  type AnalyzerRequest, type AnalyzerResult, type ApiSchema, type Endpoint, type Evidence,
} from "../../../packages/ir/src/index.js";
import { digestSources, hash, inside, readSources } from "./source.js";

/** Literal legacy TypeScript decorators from routing-controllers; registration remains unverified. */
export const ANALYZER = { analyzer_id: "nodejs-routing-controllers", analyzer_version: "0.1.0" };
const literal = (node: ts.Node | undefined) => node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined;
const decorators = (node: ts.Node) => ts.canHaveDecorators(node) ? ts.getDecorators(node) ?? [] : [];
const walk = (node: ts.Node, visit: (node: ts.Node) => void): void => { visit(node); ts.forEachChild(node, child => walk(child, visit)); };

export function createAnalyzer(options: { projectRoot: string }) {
  return { async analyze(input: unknown): Promise<AnalyzerResult> {
    const parsed = parseAnalyzerRequest(input);
    if (!parsed.ok) throw new Error("Invalid analyzer request");
    let request = parsed.value;
    if (request.analyzer.analyzer_id !== ANALYZER.analyzer_id || request.analyzer.analyzer_version !== ANALYZER.analyzer_version)
      throw new Error("Unsupported analyzer version");
    const selectedRoot = resolve(options.projectRoot, request.source.service_root);
    if (request.resolution_inputs.length !== 1 || request.resolution_inputs[0]?.kind !== "source_tree"
      || request.resolution_inputs[0].path !== request.source.service_root
      || request.changed_paths.some(path => !inside(selectedRoot, resolve(options.projectRoot, path))))
      throw new Error("Unsupported resolution inputs or changed paths");
    const started = Date.now();
    const budget = () => { if (Date.now() - started > request.limits.timeout_ms) throw new Error("Analysis time limit exceeded"); };
    const { files, root } = await readSources(options.projectRoot, request.source.service_root, request.limits.max_files, budget);
    const digest = digestSources(files, root);
    if ([request.source.source_digest, request.resolution_inputs[0].digest].some(value =>
      /^sha256:[a-f0-9]{64}$/i.test(value) && value.toLowerCase() !== digest)) throw new Error("Source digest mismatch");
    request = { ...request, source: { ...request.source, source_digest: digest },
      resolution_inputs: [{ kind: "source_tree", path: request.source.service_root, digest }] };
    const result = extract(files, root, request, budget);
    if (Buffer.byteLength(JSON.stringify(result)) > request.limits.max_output_bytes) throw new Error("Analysis output limit exceeded");
    const validated = parseAnalyzerResult(result);
    if (!validated.ok) throw new Error("Analyzer produced invalid result");
    return validated.value;
  } };
}

export async function analyze(request: AnalyzerRequest): Promise<AnalyzerResult> {
  return createAnalyzer({ projectRoot: process.cwd() }).analyze(request);
}

function extract(files: Map<string, string>, root: string, request: AnalyzerRequest, budget: () => void): AnalyzerResult {
  const effectiveMode = request.extraction_mode === "incremental" ? "fallback_full_service" : request.extraction_mode;
  const fingerprint = hash(JSON.stringify({ request: { ...request, extraction_mode: effectiveMode }, analyzer: ANALYZER,
    compiler: ts.version, profile: "literal-legacy-1" }));
  const result: AnalyzerResult = {
    exchange_version: "1.0.0", ir_version: "1.0.0", identity_version: "1.0.0", request_id: request.request_id,
    result_id: `result-${fingerprint}`, snapshot_id: `snapshot-${fingerprint}`, analyzer: ANALYZER, source: request.source,
    status: "success", completed_at: new Date().toISOString(),
    coverage: { status: "complete", analyzed_roots: [request.source.service_root], diagnostic_ids: [] },
    evidence: [], schemas: {}, endpoints: [], claims: [], dependencies: [], diagnostics: [],
    reproducibility_fingerprint: `sha256:${fingerprint}`,
  };
  const evidence = (node: ts.Node, method: Evidence["method"] = "deterministic_analysis", endpointId?: string): string => {
    const path = relative(root, node.getSourceFile().fileName).replaceAll("\\", "/");
    const span = `${node.getStart()}:${node.getEnd()}`;
    const id = `ev-${hash(`${path}:${span}:${method}:${endpointId ?? ""}`).slice(0, 24)}`;
    if (!result.evidence.some(item => item.evidence_id === id)) result.evidence.push({
      evidence_id: id, source: { kind: "source_code", source_id: request.source.repository_id },
      source_version: request.source.immutable_revision,
      location: { path, pointer: `span:${span}`, line: node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line + 1 },
      method, scope: { service_id: request.source.service_id, snapshot_id: result.snapshot_id,
        revision: request.source.immutable_revision, ...(endpointId ? { endpoint_id: endpointId } : {}) },
      limitations: method === "type_declaration" ? ["declaration does not establish runtime validation"] : [],
      access_label: request.source.access_label,
    });
    return id;
  };
  const diagnostic = (code: string, node: ts.Node, endpoint?: Endpoint) => {
    const ev = evidence(node, "deterministic_analysis", endpoint?.endpoint_id);
    const id = `diag-${hash(`${code}:${ev}`).slice(0, 24)}`;
    if (!result.diagnostics.some(item => item.diagnostic_id === id)) result.diagnostics.push({
      diagnostic_id: id, code, severity: "warning", message: code.replaceAll("_", " "),
      affected_endpoint_ids: endpoint ? [endpoint.endpoint_id] : [], evidence_ids: [ev],
    });
  };
  const claim = (endpoint: Endpoint, predicate: string, value: unknown, node: ts.Node,
    verification: "declared" | "established_by_analysis" = "declared") => {
    const ev = evidence(node, verification === "declared" ? "type_declaration" : "deterministic_analysis", endpoint.endpoint_id);
    result.claims.push({ claim_id: `claim-${hash(`${endpoint.endpoint_id}:${predicate}:${ev}:${JSON.stringify(value)}`).slice(0, 24)}`,
      subject: { service_id: request.source.service_id, endpoint_id: endpoint.endpoint_id }, predicate,
      value: value as any, verification, evidence_ids: [ev] });
  };
  const schema = (type: ts.TypeNode | undefined, owner: ts.Node, endpoint: Endpoint): ApiSchema => {
    if (!type) return {};
    if (ts.isParenthesizedTypeNode(type)) return schema(type.type, owner, endpoint);
    switch (type.kind) {
      case ts.SyntaxKind.StringKeyword: return { type: "string" };
      case ts.SyntaxKind.NumberKeyword: return { type: "number" };
      case ts.SyntaxKind.BooleanKeyword: return { type: "boolean" };
      case ts.SyntaxKind.NullKeyword: return { type: "null" };
      case ts.SyntaxKind.VoidKeyword: return { type: "null" };
    }
    if (ts.isArrayTypeNode(type)) return { type: "array", items: schema(type.elementType, owner, endpoint) };
    if (ts.isTypeLiteralNode(type)) {
      const properties: Record<string, ApiSchema> = {};
      for (const member of type.members) {
        if (!ts.isPropertySignature(member) || !member.name || !(ts.isIdentifier(member.name) || ts.isStringLiteral(member.name))) {
          diagnostic("dto_member_unsupported", member, endpoint); continue;
        }
        properties[member.name.text] = schema(member.type, member, endpoint);
      }
      return { type: "object", properties };
    }
    diagnostic("type_metadata_unresolved", owner, endpoint);
    return {};
  };
  const sourcePaths = [...files.keys()].filter(path => /\.(?:[cm]?[jt]s|tsx|jsx)$/.test(path));
  // The compiler host sees only collected files. Symbols still bind lexical imports,
  // but external modules and source code are never loaded or executed.
  const host: ts.CompilerHost = {
    getSourceFile: (path, languageVersion) => files.has(path)
      ? ts.createSourceFile(path, files.get(path)!, languageVersion, true,
        /\.[cm]?jsx?$/.test(path) ? ts.ScriptKind.JS : ts.ScriptKind.TS) : undefined,
    getDefaultLibFileName: () => "", writeFile: () => { throw new Error("Read-only analyzer"); },
    getCurrentDirectory: () => root, getDirectories: () => [], fileExists: path => files.has(path), readFile: path => files.get(path),
    getCanonicalFileName: path => path, useCaseSensitiveFileNames: () => true, getNewLine: () => "\n",
    resolveModuleNames: names => names.map(() => undefined),
  };
  const program = ts.createProgram(sourcePaths, { noLib: true, noResolve: true, allowJs: true, target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext, experimentalDecorators: true }, host);
  const checker = program.getTypeChecker();
  const sources = sourcePaths.map(path => program.getSourceFile(path)!).filter(Boolean);
  let controllerCount = 0;
  for (const source of sources) {
    budget();
    for (const statement of source.statements) if (ts.isImportDeclaration(statement)
      && literal(statement.moduleSpecifier) === "routing-controllers" && statement.importClause?.name)
      diagnostic("default_framework_import_unsupported", statement);
    const frameworkImport = (identifier: ts.Identifier): { kind: "named" | "namespace"; name: string } | undefined => {
      const symbol = checker.getSymbolAtLocation(identifier);
      // A merged/conflicting symbol cannot prove which runtime value the decorator uses.
      if (symbol?.declarations?.length !== 1) return undefined;
      const declaration = symbol.declarations[0]!;
      if (ts.isImportSpecifier(declaration) && ts.isImportDeclaration(declaration.parent.parent.parent)
        && literal(declaration.parent.parent.parent.moduleSpecifier) === "routing-controllers")
        return { kind: "named", name: (declaration.propertyName ?? declaration.name).text };
      if (ts.isNamespaceImport(declaration) && ts.isImportDeclaration(declaration.parent.parent)
        && literal(declaration.parent.parent.moduleSpecifier) === "routing-controllers")
        return { kind: "namespace", name: declaration.name.text };
      return undefined;
    };
    const frameworkCall = (decorator: ts.Decorator): { name: string; call?: ts.CallExpression } | undefined => {
      const expression = decorator.expression;
      const target = ts.isCallExpression(expression) ? expression.expression : expression;
      if (ts.isIdentifier(target)) {
        const imported = frameworkImport(target);
        if (imported?.kind === "named") return { name: imported.name, ...(ts.isCallExpression(expression) ? { call: expression } : {}) };
      }
      if (ts.isPropertyAccessExpression(target) && ts.isIdentifier(target.expression)
        && frameworkImport(target.expression)?.kind === "namespace")
        return { name: target.name.text, ...(ts.isCallExpression(expression) ? { call: expression } : {}) };
      return undefined;
    };
    const matches = (node: ts.Node) => decorators(node).map(decorator => ({ decorator, match: frameworkCall(decorator) }))
      .filter((entry): entry is { decorator: ts.Decorator; match: { name: string; call?: ts.CallExpression } } => !!entry.match);
    for (const statement of source.statements) {
      if (!ts.isClassDeclaration(statement)) continue;
      const classDecorators = matches(statement);
      const controllers = classDecorators.filter(entry => ["Controller", "JsonController"].includes(entry.match.name));
      if (!controllers.length) {
        if (statement.members.some(member => matches(member).some(entry =>
          ["Get", "Post", "Put", "Patch", "Delete", "Head", "Options", "All", "Method"].includes(entry.match.name))))
          diagnostic("controller_binding_unresolved", statement);
        continue;
      }
      controllerCount++;
      const controller = controllers[0]!;
      if (controllers.length > 1) { diagnostic("multiple_controller_decorators", statement); continue; }
      if (statement.heritageClauses?.length) diagnostic("controller_inheritance_unresolved", statement);
      let prefix = "";
      if (controller.match.call?.arguments.length) {
        const arg = controller.match.call.arguments[0];
        const path = literal(arg);
        if (path === undefined) { diagnostic("dynamic_controller_path_unresolved", controller.decorator); continue; }
        prefix = path;
      }
      const unsupportedControllerDecorators = classDecorators.some(entry => !["Controller", "JsonController"].includes(entry.match.name));
      if (unsupportedControllerDecorators) diagnostic("controller_decorator_unsupported", statement);
      for (const member of statement.members) {
        budget();
        if (!ts.isMethodDeclaration(member)) continue;
        const methodDecorators = matches(member);
        const routes = methodDecorators.filter(entry => ["Get", "Post", "Put", "Patch", "Delete", "Head", "Options"].includes(entry.match.name));
        if (!routes.length) {
          if (methodDecorators.some(entry => ["All", "Method"].includes(entry.match.name))) diagnostic("route_method_unsupported", member);
          continue;
        }
        if (routes.length > 1 || !member.name || !ts.isIdentifier(member.name)) { diagnostic("ambiguous_method_declaration", member); continue; }
        const route = routes[0]!;
        if (!route.match.call || route.match.call.arguments.length > 1) { diagnostic("route_decorator_unsupported", route.decorator); continue; }
        const routeArg = route.match.call.arguments[0];
        const suffix = routeArg === undefined ? "" : literal(routeArg);
        if (suffix === undefined) { diagnostic("dynamic_route_path_unresolved", route.decorator); continue; }
        if (prefix.includes("*") || suffix.includes("*") || /[?+()]/.test(`${prefix}${suffix}`)) {
          diagnostic("route_pattern_unsupported", route.decorator); continue;
        }
        const path = `/${prefix}/${suffix}`.replace(/\/+/g, "/").replace(/\/$/, "") || "/";
        let identity: Endpoint["identity"];
        try { identity = deriveEndpointIdentity({ identity_version: "1.0.0", service_id: request.source.service_id,
          method: route.match.name, application_path: path }); }
        catch { diagnostic("route_path_unsupported", route.decorator); continue; }
        const endpointId = `endpoint-${hash(identity.route_key).slice(0, 24)}`;
        if (result.endpoints.some(endpoint => endpoint.endpoint_id === endpointId)) { diagnostic("conflicting_route_declarations", route.decorator); continue; }
        const routeEv = evidence(route.decorator, "deterministic_analysis", endpointId);
        const controllerEv = evidence(controller.decorator, "deterministic_analysis", endpointId);
        const endpoint: Endpoint = { endpoint_id: endpointId, identity, application_path: path, parameters: [],
          request_bodies: [], responses: [{ status: { kind: "unknown", reason: "No supported status declaration" }, content: [] }],
          security: { state: "unknown", alternatives: [] }, evidence_ids: [controllerEv, routeEv] };
        result.endpoints.push(endpoint);
        result.dependencies.push({ from_endpoint_id: endpointId, to: { kind: "evidence", id: controllerEv }, evidence_ids: [controllerEv] });
        claim(endpoint, "route.declaration", { method: identity.method, path, controller: statement.name?.text ?? "anonymous", action: member.name.text }, route.decorator);
        claim(endpoint, "analyzer.toolchain", { compiler: "typescript", compiler_version: ts.version, profile: "literal-legacy-1", extraction_mode: effectiveMode }, route.decorator, "established_by_analysis");
        if (statement.heritageClauses?.length) diagnostic("inherited_actions_unresolved", statement, endpoint);
        if (member.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.StaticKeyword) || !member.body)
          diagnostic("action_implementation_unresolved", member, endpoint);
        const namedPath = new Set([...path.matchAll(/:([A-Za-z_][A-Za-z0-9_]*)/g)].map(match => match[1]!));
        let responseUnresolved = unsupportedControllerDecorators;
        for (const name of [...namedPath].sort()) endpoint.parameters.push({ name, in: "path",
          presence: { state: "required", evidence_ids: [routeEv] }, schema: {}, serialization: { style: "simple" } });
        for (const parameter of member.parameters) {
          const parameterDecorators = matches(parameter);
          for (const entry of parameterDecorators) {
            const { name, call } = entry.match;
            if (["Req", "Res", "Ctx", "Response"].includes(name)) {
              responseUnresolved = true;
              diagnostic("response_or_request_passthrough_unresolved", entry.decorator, endpoint); continue;
            }
            if (["Params", "QueryParams", "HeaderParams", "CookieParams", "BodyParam", "UploadedFile", "UploadedFiles", "CookieParam", "Session", "SessionParam", "State"].includes(name)) {
              diagnostic("parameter_binding_unsupported", entry.decorator, endpoint); continue;
            }
            if (name === "Body") {
              if (!call || call.arguments.length > 1) { diagnostic("body_binding_unsupported", entry.decorator, endpoint); continue; }
              if (call.arguments.length) diagnostic("body_options_unresolved", entry.decorator, endpoint);
              claim(endpoint, "request.body.declaration", schema(parameter.type, parameter, endpoint), parameter);
              if (controller.match.name === "JsonController") {
                const ev = evidence(entry.decorator, "type_declaration", endpointId);
                endpoint.request_bodies.push({ media_type: "application/json", schema: schema(parameter.type, parameter, endpoint),
                  serialization: { format: "application/json" }, presence: { state: "unknown", evidence_ids: [ev] } });
              } else diagnostic("request_media_type_unknown", entry.decorator, endpoint);
              continue;
            }
            if (!["Param", "QueryParam", "HeaderParam"].includes(name)) { diagnostic("parameter_decorator_unsupported", entry.decorator, endpoint); continue; }
            const arg = call?.arguments[0];
            const key = literal(arg);
            if (!key || !call || call.arguments.length > 2) { diagnostic("named_parameter_unresolved", entry.decorator, endpoint); continue; }
            const location = name === "Param" ? "path" : name === "QueryParam" ? "query" : "header";
            if (location === "path" && !namedPath.has(key)) { diagnostic("path_parameter_not_in_route", entry.decorator, endpoint); continue; }
            const option = call.arguments[1];
            let required: boolean | undefined;
            if (option !== undefined) {
              if (ts.isObjectLiteralExpression(option) && option.properties.length === 1 && ts.isPropertyAssignment(option.properties[0]!)
                && option.properties[0]!.name.getText() === "required" && [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword].includes(option.properties[0]!.initializer.kind))
                required = option.properties[0]!.initializer.kind === ts.SyntaxKind.TrueKeyword;
              else diagnostic("parameter_options_unresolved", option, endpoint);
            }
            const ev = evidence(entry.decorator, "type_declaration", endpointId);
            const parameterSchema = schema(parameter.type, parameter, endpoint);
            const existing = endpoint.parameters.find(item => item.in === location && item.name === key);
            if (existing) {
              existing.schema = parameterSchema;
              if (location === "path" && required === false) diagnostic("optional_path_parameter_unsupported", entry.decorator, endpoint);
            } else endpoint.parameters.push({ name: key, in: location,
              presence: { state: required === true ? "required" : required === false ? "optional" : "unknown", evidence_ids: [ev] },
              schema: parameterSchema, serialization: { style: location === "path" ? "simple" : "form" } });
            claim(endpoint, "parameter.presence", location === "path" ? "required" : required === true ? "required" : required === false ? "optional" : "unknown", entry.decorator);
          }
        }
        if (member.type) claim(endpoint, "response.declaration", schema(member.type, member, endpoint), member.type);
        else diagnostic("response_type_unresolved", member, endpoint);
        let status: number | undefined;
        let media: string | undefined = controller.match.name === "JsonController" ? "application/json" : undefined;
        for (const entry of methodDecorators) {
          if (routes.includes(entry)) continue;
          const { name, call } = entry.match;
          if (name === "HttpCode") {
            const arg = call?.arguments[0];
            if (arg && ts.isNumericLiteral(arg) && Number(arg.text) >= 100 && Number(arg.text) <= 599) status = Number(arg.text);
            else diagnostic("http_code_unresolved", entry.decorator, endpoint);
          } else if (name === "ContentType") {
            media = literal(call?.arguments[0]);
            if (!media) diagnostic("content_type_unresolved", entry.decorator, endpoint);
          } else { responseUnresolved = true; diagnostic("method_decorator_unsupported", entry.decorator, endpoint); }
        }
        if (status !== undefined) {
          if (!responseUnresolved) endpoint.responses[0]!.status = { kind: "exact", code: status };
          claim(endpoint, "response.status", status, member);
        }
        if (media && member.type && !responseUnresolved) endpoint.responses[0]!.content.push({ media_type: media,
          schema: schema(member.type, member, endpoint), serialization: { format: media } });
        if (media && !responseUnresolved) claim(endpoint, "response.media_type", media, member);
        if (!media && member.type) diagnostic("response_media_type_unknown", member, endpoint);
        if (!status && !responseUnresolved) diagnostic("response_status_unknown", member, endpoint);
        endpoint.parameters.sort((a, b) => `${a.in}:${a.name}`.localeCompare(`${b.in}:${b.name}`));
      }
    }
    for (const parseDiagnostic of (source as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? []) {
      if (parseDiagnostic) diagnostic("source_syntax_unsupported", source);
    }
    walk(source, node => {
      if (ts.isExportDeclaration(node) && node.moduleSpecifier && literal(node.moduleSpecifier)?.startsWith("."))
        diagnostic("relative_reexport_unresolved", node);
    });
  }
  if (controllerCount) diagnostic("controller_registration_unverified", sources[0]!);
  else if (sources.length) diagnostic("no_supported_controller", sources[0]!);
  result.endpoints.sort((a, b) => a.identity.route_key.localeCompare(b.identity.route_key));
  result.evidence.sort((a, b) => a.evidence_id.localeCompare(b.evidence_id));
  result.claims.sort((a, b) => a.claim_id.localeCompare(b.claim_id));
  result.dependencies.sort((a, b) => `${a.from_endpoint_id}:${a.to.id}`.localeCompare(`${b.from_endpoint_id}:${b.to.id}`));
  result.diagnostics.sort((a, b) => a.diagnostic_id.localeCompare(b.diagnostic_id));
  if (result.diagnostics.length) {
    result.status = "partial";
    result.coverage = { status: "incomplete", analyzed_roots: [request.source.service_root],
      unresolved_roots: [request.source.service_root], reason: "Unsupported or unverified routing-controllers scope",
      diagnostic_ids: result.diagnostics.map(item => item.diagnostic_id) };
  }
  return result;
}
