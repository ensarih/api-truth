import { resolve, relative, dirname } from "node:path";
import ts from "typescript";
import { hash, inside, readSources, digestSources } from "./source.js";
import { parseAnalyzerRequest, parseAnalyzerResult, deriveEndpointIdentity,
  type AnalyzerRequest, type AnalyzerResult, type Endpoint, type Evidence, type ApiSchema, type Claim,
} from "../../../packages/ir/src/index.js";

export const ANALYZER = { analyzer_id: "typescript-express", analyzer_version: "0.1.0" };
const walk = (node: ts.Node, visit: (node: ts.Node) => void) => { visit(node); ts.forEachChild(node, child => walk(child, visit)); };
const literal = (node: ts.Node | undefined): string | undefined => node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined;

export function createAnalyzer(options: { projectRoot: string }) {
  return { async analyze(input: unknown): Promise<AnalyzerResult> {
    const parsed = parseAnalyzerRequest(input);
    if (!parsed.ok) throw new Error("Invalid analyzer request");
    let request = parsed.value;
    if (request.analyzer.analyzer_id !== ANALYZER.analyzer_id || request.analyzer.analyzer_version !== ANALYZER.analyzer_version) throw new Error("Unsupported analyzer version");
    const selectedRoot = resolve(options.projectRoot, request.source.service_root);
    if (request.resolution_inputs.some(item => item.kind === "classpath" || !inside(selectedRoot, resolve(options.projectRoot, item.path)))
      || request.changed_paths.some(path => !inside(selectedRoot, resolve(options.projectRoot, path)))) throw new Error("Source boundary rejected");
    if (request.resolution_inputs.length !== 1 || request.resolution_inputs[0]?.kind !== "source_tree" || request.resolution_inputs[0].path !== request.source.service_root) throw new Error("Unsupported resolution inputs");
    const started = Date.now();
    const budget = () => { if (Date.now() - started > request.limits.timeout_ms) throw new Error("Analysis time limit exceeded"); };
    const { files, root } = await readSources(options.projectRoot, request.source.service_root, request.limits.max_files, budget);
    const actualDigest = digestSources(files, root);
    const claimedDigests = [request.source.source_digest, ...request.resolution_inputs.map(input => input.digest)]
      .filter(digest => /^sha256:[a-f0-9]{64}$/i.test(digest));
    if (claimedDigests.some(digest => digest.toLowerCase() !== actualDigest)) throw new Error("Source digest mismatch");
    request = {
      ...request,
      source: { ...request.source, source_digest: actualDigest },
      resolution_inputs: request.resolution_inputs.map(input => ({ ...input, digest: actualDigest })),
    };
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
  const sourceDigest = digestSources(files, root);
  const effectiveExtractionMode = request.extraction_mode === "incremental" ? "fallback_full_service" : request.extraction_mode;
  const fingerprint = hash(JSON.stringify({
    request: { ...request, extraction_mode: effectiveExtractionMode },
    sourceDigest,
    analyzer: ANALYZER,
    compiler: ts.version,
    config: "1.0.0",
  }));
  const result: AnalyzerResult = {
    exchange_version: "1.0.0", ir_version: "1.0.0", identity_version: "1.0.0", request_id: request.request_id,
    result_id: `result-${fingerprint}`, snapshot_id: `snapshot-${fingerprint}`, analyzer: ANALYZER, source: request.source,
    status: "success", completed_at: new Date().toISOString(),
    coverage: { status: "complete", analyzed_roots: [request.source.service_root], diagnostic_ids: [] },
    evidence: [], schemas: {}, endpoints: [], claims: [], dependencies: [], diagnostics: [], reproducibility_fingerprint: `sha256:${fingerprint}`,
  };
  const sources = new Map([...files].map(([path, text]) => [path, ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)]));
  const compilerOptions: ts.CompilerOptions = { noLib: true, noResolve: false, allowJs: true, strictNullChecks: true, target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext };
  const host: ts.CompilerHost = {
    getSourceFile: path => sources.get(path), getDefaultLibFileName: () => "", writeFile: () => { throw new Error("Read-only analyzer"); },
    getCurrentDirectory: () => root, getDirectories: () => [], fileExists: path => files.has(path), readFile: path => files.get(path),
    getCanonicalFileName: path => path, useCaseSensitiveFileNames: () => true, getNewLine: () => "\n",
    resolveModuleNames: (names, containing) => names.map(name => {
      if (!name.startsWith(".")) return undefined;
      const base = resolve(dirname(containing), name);
      const candidate = [base, `${base}.ts`, `${base}.js`, `${base}/index.ts`, base.replace(/\.js$/, ".ts")].find(path => files.has(path));
      return candidate ? { resolvedFileName: candidate, extension: candidate.endsWith(".ts") ? ts.Extension.Ts : ts.Extension.Js } : undefined;
    }),
  };
  const program = ts.createProgram([...files.keys()], compilerOptions, host);
  const checker = program.getTypeChecker();
  const symbol = (node: ts.Node): ts.Symbol | undefined => {
    let sym = checker.getSymbolAtLocation(node);
    if (sym && (sym.flags & ts.SymbolFlags.Alias)) sym = checker.getAliasedSymbol(sym);
    return sym;
  };
  const evidence = (node: ts.Node, method: Evidence["method"] = "deterministic_analysis", limitations: string[] = []): string => {
    const path = relative(root, node.getSourceFile().fileName).replaceAll("\\", "/");
    const span = `${node.getStart()}:${node.getEnd()}`;
    const id = `ev-${hash(`${path}:${span}:${method}`).slice(0, 24)}`;
    if (!result.evidence.some(e => e.evidence_id === id)) result.evidence.push({
      evidence_id: id, source: { kind: "source_code", source_id: request.source.repository_id }, source_version: request.source.immutable_revision,
      location: { path, line: node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line + 1, pointer: `span:${span}` }, method,
      scope: { service_id: request.source.service_id, snapshot_id: result.snapshot_id, revision: request.source.immutable_revision }, limitations, access_label: request.source.access_label,
    });
    return id;
  };
  const diagnostic = (code: string, node?: ts.Node, endpoint?: Endpoint) => {
    const ids = node ? [evidence(node)] : [];
    const id = `diag-${hash(`${code}:${ids}:${endpoint?.endpoint_id ?? ""}`).slice(0, 24)}`;
    if (!result.diagnostics.some(d => d.diagnostic_id === id)) result.diagnostics.push({ diagnostic_id: id, code, severity: "warning", message: code.replaceAll("_", " "), affected_endpoint_ids: endpoint ? [endpoint.endpoint_id] : [], evidence_ids: ids });
  };
  const dependency = (endpoint: Endpoint, node: ts.Node) => {
    const id = evidence(node);
    if (!result.dependencies.some(d => d.from_endpoint_id === endpoint.endpoint_id && d.to.id === id)) result.dependencies.push({ from_endpoint_id: endpoint.endpoint_id, to: { kind: "evidence", id }, evidence_ids: [id] });
  };
  const importedExpress = (node: ts.Node): string | undefined => {
    const sym = checker.getSymbolAtLocation(node);
    for (const decl of sym?.declarations ?? []) {
      if (ts.isImportSpecifier(decl) && ts.isImportDeclaration(decl.parent.parent.parent) && literal(decl.parent.parent.parent.moduleSpecifier) === "express") return (decl.propertyName ?? decl.name).text;
      if (ts.isImportClause(decl) && literal(decl.parent.moduleSpecifier) === "express") return "default";
    }
    return undefined;
  };
  const expressReceiverKind = (expression: ts.Expression): "app" | "router" | undefined => {
    const imported = importedExpress(expression);
    if (imported === "default") return "app";
    if (imported === "Router") return "router";
    if (ts.isPropertyAccessExpression(expression) && expression.name.text === "Router" && importedExpress(expression.expression) === "default") return "router";
    return undefined;
  };
  type Receiver = { node: ts.VariableDeclaration; app: boolean; routes: ts.CallExpression[]; uses: ts.CallExpression[] };
  const receivers = new Map<ts.Symbol, Receiver>();
  for (const source of sources.values()) walk(source, node => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isCallExpression(node.initializer)) {
      const kind = expressReceiverKind(node.initializer.expression);
      const sym = symbol(node.name);
      if (sym && kind) receivers.set(sym, { node, app: kind === "app", routes: [], uses: [] });
    }
  });
  const enclosingFunction = (node: ts.Node): ts.FunctionLikeDeclaration | undefined => {
    for (let parent = node.parent; parent && !ts.isSourceFile(parent); parent = parent.parent) {
      if (ts.isFunctionDeclaration(parent) || ts.isFunctionExpression(parent) || ts.isArrowFunction(parent) || ts.isMethodDeclaration(parent)) return parent;
    }
    return undefined;
  };
  const factoryScopes = new Map<Receiver, ts.FunctionLikeDeclaration>();
  for (const [receiverSymbol, receiver] of receivers) {
    const scope = enclosingFunction(receiver.node);
    if (!scope?.body) continue;
    let returnsReceiver = false;
    walk(scope.body, node => {
      if (ts.isReturnStatement(node) && node.parent === scope.body && node.expression && symbol(node.expression) === receiverSymbol) returnsReceiver = true;
    });
    if (returnsReceiver) factoryScopes.set(receiver, scope);
  }
  const methods = new Set(["get", "post", "put", "patch", "delete", "options", "head", "all"]);
  const conditional = (node: ts.Node, staticScope?: ts.FunctionLikeDeclaration): boolean => {
    for (let parent = node.parent; parent && !ts.isSourceFile(parent); parent = parent.parent) {
      if (ts.isIfStatement(parent) || ts.isIterationStatement(parent, false) || ts.isSwitchStatement(parent) || ts.isConditionalExpression(parent)
        || (ts.isBinaryExpression(parent) && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken].includes(parent.operatorToken.kind))) return true;
      if (ts.isFunctionLike(parent) && parent !== staticScope) return true;
    }
    return false;
  };
  for (const source of sources.values()) walk(source, node => {
    if (ts.isImportDeclaration(node) && literal(node.moduleSpecifier) !== "express" && !symbol(node.moduleSpecifier)?.declarations?.some(d => ts.isSourceFile(d))) diagnostic("import_unresolved", node);
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) diagnostic("dynamic_import_unresolved", node);
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return;
    const receiver = receivers.get(symbol(node.expression.expression)!);
    if (!receiver) {
      if (methods.has(node.expression.name.text) || ["route", "use"].includes(node.expression.name.text)) diagnostic("route_receiver_unsupported", node);
      return;
    }
    const staticScope = factoryScopes.get(receiver);
    if (conditional(node, staticScope) || conditional(receiver.node, staticScope)) { diagnostic("routing_predicate_unsupported", node); return; }
    if (node.expression.name.text === "use") receiver.uses.push(node);
    else if (methods.has(node.expression.name.text) && node.expression.name.text !== "all") receiver.routes.push(node);
    else diagnostic("routing_construct_unsupported", node);
  });
  const functionFor = (node: ts.Node): ts.FunctionLikeDeclaration | undefined => {
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return node;
    const decl = symbol(node)?.valueDeclaration;
    if (decl && ts.isFunctionDeclaration(decl)) return decl;
    if (decl && ts.isVariableDeclaration(decl) && decl.initializer && (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))) return decl.initializer;
    return undefined;
  };
  const receiverFor = (node: ts.Expression): Receiver | undefined => {
    const direct = receivers.get(symbol(node)!);
    if (direct) return direct;
    if (!ts.isCallExpression(node)) return undefined;
    const factory = functionFor(node.expression);
    if (!factory) return undefined;
    return [...factoryScopes].find(([, scope]) => scope === factory)?.[0];
  };
  const claim = (endpoint: Endpoint, predicate: string, value: Claim["value"], node: ts.Node, method: Evidence["method"], pointer?: string) => {
    const ev = evidence(node, method);
    const id = `claim-${hash(`${endpoint.endpoint_id}:${predicate}:${pointer ?? ""}:${ev}:${JSON.stringify(value)}`).slice(0, 24)}`;
    if (!result.claims.some(c => c.claim_id === id)) result.claims.push({ claim_id: id,
      subject: { service_id: request.source.service_id, endpoint_id: endpoint.endpoint_id, ...(pointer ? { schema_pointer: pointer } : {}) },
      predicate, value, verification: method === "type_declaration" ? "declared" : "established_by_analysis", evidence_ids: [ev] });
  };
  const schemaFrom = (node: ts.TypeNode | undefined, endpoint: Endpoint): ApiSchema => {
    if (!node) return {};
    budget();
    const primitives: Partial<Record<ts.SyntaxKind, ApiSchema["type"]>> = { [ts.SyntaxKind.StringKeyword]: "string", [ts.SyntaxKind.NumberKeyword]: "number", [ts.SyntaxKind.BooleanKeyword]: "boolean" };
    const primitive = primitives[node.kind];
    if (primitive) return { type: primitive };
    if (ts.isParenthesizedTypeNode(node)) return schemaFrom(node.type, endpoint);
    if (ts.isLiteralTypeNode(node)) {
      if (node.literal.kind === ts.SyntaxKind.NullKeyword) return { const: null };
      if (ts.isStringLiteral(node.literal)) return { const: node.literal.text };
      if (ts.isNumericLiteral(node.literal)) return { const: Number(node.literal.text) };
      if (node.literal.kind === ts.SyntaxKind.TrueKeyword || node.literal.kind === ts.SyntaxKind.FalseKeyword) return { const: node.literal.kind === ts.SyntaxKind.TrueKeyword };
    }
    if (ts.isUnionTypeNode(node)) {
      const parts = node.types.map(type => schemaFrom(type, endpoint));
      if (parts.every(part => "const" in part)) return { enum: parts.map(part => part.const!) };
      return { anyOf: parts };
    }
    if (ts.isArrayTypeNode(node)) return { type: "array", items: schemaFrom(node.elementType, endpoint) };
    if (ts.isTypeLiteralNode(node)) return membersSchema(node.members, endpoint);
    if (ts.isTypeReferenceNode(node)) {
      if (["Array", "ReadonlyArray"].includes(node.typeName.getText()) && node.typeArguments?.[0]) return { type: "array", items: schemaFrom(node.typeArguments[0], endpoint) };
      const declaration = symbol(node.typeName)?.declarations?.find(d => ts.isInterfaceDeclaration(d) || ts.isTypeAliasDeclaration(d));
      if (declaration && (ts.isInterfaceDeclaration(declaration) || ts.isTypeAliasDeclaration(declaration))) {
        dependency(endpoint, declaration);
        const id = `schema-${hash(`${relative(root, declaration.getSourceFile().fileName)}:${declaration.name.text}`).slice(0, 24)}`;
        if (!result.schemas[id]) {
          result.schemas[id] = { schema_id: id, schema: {}, evidence_ids: [evidence(declaration, "type_declaration")] };
          result.schemas[id]!.schema = ts.isInterfaceDeclaration(declaration) ? membersSchema(declaration.members, endpoint) : schemaFrom(declaration.type, endpoint);
          if (ts.isInterfaceDeclaration(declaration) && declaration.heritageClauses?.length) diagnostic("type_inheritance_unsupported", declaration, endpoint);
        }
        if (!result.dependencies.some(d => d.from_endpoint_id === endpoint.endpoint_id && d.to.id === id)) result.dependencies.push({ from_endpoint_id: endpoint.endpoint_id, to: { kind: "schema", id }, evidence_ids: [evidence(declaration, "type_declaration")] });
        return { $ref: `#/schemas/${id}` };
      }
    }
    diagnostic("type_unknown", node, endpoint);
    return {};
  };
  const membersSchema = (members: ts.NodeArray<ts.TypeElement>, endpoint: Endpoint): ApiSchema => {
    const properties: Record<string, ApiSchema> = {}; const required: string[] = [];
    for (const member of members) {
      if (ts.isPropertySignature(member) && (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name))) {
        properties[member.name.text] = schemaFrom(member.type, endpoint);
        if (!member.questionToken) required.push(member.name.text);
      } else diagnostic("type_member_unsupported", member, endpoint);
    }
    return { type: "object", properties, required };
  };
  const declaredProperties = (node: ts.TypeNode): readonly ts.TypeElement[] => {
    if (ts.isTypeLiteralNode(node)) return node.members;
    if (!ts.isTypeReferenceNode(node)) return [];
    const declaration = symbol(node.typeName)?.declarations?.find(item => ts.isInterfaceDeclaration(item) || ts.isTypeAliasDeclaration(item));
    if (declaration && ts.isInterfaceDeclaration(declaration)) return declaration.members;
    if (declaration && ts.isTypeAliasDeclaration(declaration)) return declaredProperties(declaration.type);
    return [];
  };
  const expressionSchema = (node: ts.Expression | undefined, endpoint: Endpoint, seen = new Set<ts.Node>()): ApiSchema => {
    if (!node || seen.has(node)) return {};
    const next = new Set(seen).add(node);
    if (ts.isStringLiteral(node)) return { type: "string", const: node.text };
    if (ts.isNumericLiteral(node)) return { type: "number", const: Number(node.text) };
    if ([ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword].includes(node.kind)) return { type: "boolean", const: node.kind === ts.SyntaxKind.TrueKeyword };
    if (node.kind === ts.SyntaxKind.NullKeyword) return { type: "null" };
    if (ts.isArrayLiteralExpression(node)) return { type: "array", ...(node.elements.length ? { items: { anyOf: node.elements.map(item => expressionSchema(item, endpoint, next)) } } : {}) };
    if (ts.isObjectLiteralExpression(node)) {
      const properties: Record<string, ApiSchema> = {}; const required = new Set<string>();
      for (const property of node.properties) {
        if (ts.isSpreadAssignment(property)) {
          const spread = expressionSchema(property.expression, endpoint, next);
          if (spread.properties) { Object.assign(properties, spread.properties); for (const name of spread.required ?? []) required.add(name); }
          else diagnostic("response_spread_unknown", property, endpoint);
        } else if ((ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) {
          properties[property.name.text] = expressionSchema(ts.isPropertyAssignment(property) ? property.initializer : property.name, endpoint, next);
          // An unknown value may be undefined and omitted by JSON serialization.
          if (Object.keys(properties[property.name.text]!).length) required.add(property.name.text);
        } else diagnostic("response_property_unknown", property, endpoint);
      }
      return { type: "object", properties, required: [...required] };
    }
    if (ts.isIdentifier(node)) {
      let declaration = symbol(node)?.valueDeclaration;
      if (declaration && ts.isShorthandPropertyAssignment(declaration)) declaration = checker.getShorthandAssignmentValueSymbol(declaration)?.valueDeclaration;
      if (declaration && ts.isVariableDeclaration(declaration)) {
        dependency(endpoint, declaration);
        if (declaration.type) claim(endpoint, "response.declaration", schemaFrom(declaration.type, endpoint), declaration, "type_declaration");
        return expressionSchema(declaration.initializer, endpoint, next);
      }
    }
    diagnostic("response_value_unknown", node, endpoint);
    return {};
  };
  const responses = (fn: ts.FunctionLikeDeclaration, endpoint: Endpoint) => {
    const responseName = fn.parameters[1]?.name.getText();
    if (!responseName || !fn.body) return;
    const body = fn.body;
    type ResponseStatus = Endpoint["responses"][number]["status"];
    type ResponseState = { status: ResponseStatus; media: string | undefined };
    const responseChain = (expression: ts.Expression): { root: string | undefined; calls: ts.CallExpression[] } => {
      const calls: ts.CallExpression[] = [];
      let current = expression;
      while (ts.isCallExpression(current) && ts.isPropertyAccessExpression(current.expression)) {
        calls.unshift(current);
        current = current.expression.expression;
      }
      return { root: ts.isIdentifier(current) ? current.text : undefined, calls };
    };
    const applyStateCalls = (state: ResponseState, calls: ts.CallExpression[], uncertain: boolean) => {
      for (const call of calls) {
        if (!ts.isPropertyAccessExpression(call.expression)) continue;
        if (call.expression.name.text === "status") {
          const argument = call.arguments[0];
          const code = argument && ts.isNumericLiteral(argument) ? Number(argument.text) : undefined;
          state.status = !uncertain && code !== undefined && code >= 100 && code <= 599
            ? { kind: "exact", code }
            : { kind: "unknown", reason: code !== undefined ? "Invalid explicit response status" : "Unsupported explicit response status" };
        }
        if (call.expression.name.text === "type") state.media = uncertain ? undefined : literal(call.arguments[0]);
      }
    };
    const precedingState = (serialization: ts.CallExpression): ResponseState => {
      const state: ResponseState = { status: { kind: "unknown", reason: "No explicit response status" }, media: undefined };
      if (!ts.isBlock(body)) return state;
      let topLevel: ts.Node = serialization;
      while (topLevel.parent && topLevel.parent !== body) topLevel = topLevel.parent;
      if (!(ts.isExpressionStatement(topLevel) || ts.isReturnStatement(topLevel))) return state;
      const aliases = new Set<string>();
      for (const statement of body.statements) {
        if (statement === topLevel) break;
        if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name) && declaration.initializer && ts.isIdentifier(declaration.initializer)
            && (declaration.initializer.text === responseName || aliases.has(declaration.initializer.text))) aliases.add(declaration.name.text);
        }
        if (ts.isExpressionStatement(statement)) {
          const chain = responseChain(statement.expression);
          if (chain.root === responseName) applyStateCalls(state, chain.calls, false);
          else if (chain.root && aliases.has(chain.root)) applyStateCalls(state, chain.calls, true);
          continue;
        }
        walk(statement, candidate => {
          if (!ts.isCallExpression(candidate)) return;
          const chain = responseChain(candidate);
          if (chain.root === responseName || (chain.root && aliases.has(chain.root))) applyStateCalls(state, chain.calls, true);
        });
      }
      return state;
    };
    walk(fn.body, node => {
      if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression) || !["json", "send", "end"].includes(node.expression.name.text)) return;
      const chain = responseChain(node);
      if (chain.root !== responseName) return;
      const state = precedingState(node);
      applyStateCalls(state, chain.calls, false);
      const schema = expressionSchema(node.arguments[0], endpoint);
      const response = { status: state.status, content: state.media ? [{ media_type: state.media, schema, serialization: { format: node.expression.name.text } }] : [] };
      if (!endpoint.responses.some(item => JSON.stringify(item) === JSON.stringify(response))) endpoint.responses.push(response);
      claim(endpoint, "response.serialization", { status: state.status, media_type: state.media ?? null, schema }, node, "deterministic_analysis");
      if (!state.media) diagnostic("response_media_type_unknown", node, endpoint);
      if (state.status.kind === "unknown") diagnostic("response_status_unknown", node, endpoint);
    });
  };
  const analyzeFunction = (fn: ts.FunctionLikeDeclaration, endpoint: Endpoint, middleware: boolean, reference: ts.Node) => {
    dependency(endpoint, fn);
    const requestName = fn.parameters[0]?.name.getText();
    const requestType = fn.parameters[0]?.type;
    if (requestType && ts.isTypeReferenceNode(requestType) && importedExpress(requestType.typeName) === "Request") {
      if (requestType.typeArguments?.[1]) claim(endpoint, "response.declaration", schemaFrom(requestType.typeArguments[1], endpoint), requestType.typeArguments[1], "type_declaration");
      if (requestType.typeArguments?.[2]) claim(endpoint, "request.declaration", schemaFrom(requestType.typeArguments[2], endpoint), requestType.typeArguments[2], "type_declaration");
      const queryType = requestType.typeArguments?.[3];
      if (queryType) {
        claim(endpoint, "request.query.declaration", schemaFrom(queryType, endpoint), queryType, "type_declaration");
        for (const member of declaredProperties(queryType)) {
          if (!ts.isPropertySignature(member) || !(ts.isIdentifier(member.name) || ts.isStringLiteral(member.name))) continue;
          const name = member.name.text;
          if (!endpoint.parameters.some(parameter => parameter.in === "query" && parameter.name === name)) endpoint.parameters.push({
            name,
            in: "query",
            presence: { state: "unknown", evidence_ids: [evidence(member, "type_declaration")] },
            schema: schemaFrom(member.type, endpoint),
            serialization: { style: "form" },
          });
        }
      }
    }
    const responseType = fn.parameters[1]?.type;
    if (responseType && ts.isTypeReferenceNode(responseType) && importedExpress(responseType.typeName) === "Response" && responseType.typeArguments?.[0]) {
      claim(endpoint, "response.declaration", schemaFrom(responseType.typeArguments[0], endpoint), responseType.typeArguments[0], "type_declaration");
    }
    if (!fn.body) { diagnostic("handler_body_unknown", fn, endpoint); return; }
    const bodyAliases = new Set<string>([`${requestName}.body`]);
    walk(fn.body, node => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer?.getText() === `${requestName}.body`) bodyAliases.add(node.name.text);
      if (ts.isPropertyAccessExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "query" && node.expression.expression.getText() === requestName) {
        if (!endpoint.parameters.some(p => p.in === "query" && p.name === node.name.text)) endpoint.parameters.push({ name: node.name.text, in: "query", presence: { state: "unknown", evidence_ids: [evidence(node)] }, schema: {}, serialization: { style: "form" } });
      }
    });
    const field = (node: ts.Expression): string | undefined => {
      const parts: string[] = []; let current = node;
      while (ts.isPropertyAccessExpression(current)) { parts.unshift(current.name.text); current = current.expression; }
      if (bodyAliases.has(current.getText()) && parts.length) return `/request/body/${parts.join("/")}`;
      if (current.getText() === requestName && parts[0] === "body" && parts.length > 1) return `/request/body/${parts.slice(1).join("/")}`;
      return undefined;
    };
    const enumGuard = (node: ts.Expression): { path: string; values: string[] } | undefined => {
      if (!ts.isPrefixUnaryExpression(node) || node.operator !== ts.SyntaxKind.ExclamationToken || !ts.isCallExpression(node.operand)) return;
      const call = node.operand;
      if (!ts.isPropertyAccessExpression(call.expression) || call.expression.name.text !== "includes" || !ts.isArrayLiteralExpression(call.expression.expression) || !call.arguments[0]) return;
      const path = field(call.arguments[0]); const values = call.expression.expression.elements.map(literal);
      if (path && values.length && values.every(value => value !== undefined)) return { path, values: values as string[] };
    };
    type GuardFact = { path: string; presence?: "required" | "optional"; values?: string[] };
    const guardFacts = (node: ts.Expression): GuardFact[] | undefined => {
      if (ts.isParenthesizedExpression(node)) return guardFacts(node.expression);
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
        const left = guardFacts(node.left); const right = guardFacts(node.right);
        return left && right ? [...left, ...right] : undefined;
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && ts.isBinaryExpression(node.left)
        && node.left.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken && node.left.right.getText() === "undefined") {
        const path = field(node.left.left); const guard = enumGuard(node.right);
        if (path && guard?.path === path) return [{ path, presence: "optional", values: guard.values }];
      }
      const enumeration = enumGuard(node);
      if (enumeration) return [{ path: enumeration.path, values: enumeration.values }];
      if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) {
        const path = field(node.operand);
        if (path) return [{ path, presence: "required" }];
        if (ts.isCallExpression(node.operand) && node.operand.expression.getText() === "Array.isArray" && node.operand.arguments[0]) {
          const arrayPath = field(node.operand.arguments[0]);
          if (arrayPath) return [{ path: arrayPath, presence: "required" }];
        }
      }
      return undefined;
    };
    let hasValidator = false;
    if (ts.isBlock(fn.body)) for (const statement of fn.body.statements) {
      if (!ts.isIfStatement(statement)) continue;
      const statements = ts.isBlock(statement.thenStatement) ? statement.thenStatement.statements : [statement.thenStatement];
      const returns = statements.length > 0 && ts.isReturnStatement(statements[statements.length - 1]!);
      let rejects = false;
      for (const item of statements) {
        const expression = ts.isExpressionStatement(item) ? item.expression : ts.isReturnStatement(item) ? item.expression : undefined;
        if (expression) walk(expression, node => {
          if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "status"
            && node.expression.expression.getText() === fn.parameters[1]?.name.getText() && node.arguments[0] && ts.isNumericLiteral(node.arguments[0]) && Number(node.arguments[0].text) >= 400) rejects = true;
        });
      }
      const facts = returns && rejects && !statement.elseStatement ? guardFacts(statement.expression) : undefined;
      if (!facts) { diagnostic("validator_condition_unsupported", statement, endpoint); continue; }
      hasValidator = true;
      for (const fact of facts) {
        if (fact.presence) claim(endpoint, "request.field.presence", fact.presence, statement, "runtime_validator", fact.path);
        if (fact.values) claim(endpoint, "request.field.enum", fact.values, statement, "runtime_validator", fact.path);
      }
    }
    if (middleware) claim(endpoint, hasValidator ? "request.validator" : "security.middleware", { symbol: reference.getText(), guarantee: "unknown" }, fn, "deterministic_analysis");
    responses(fn, endpoint);
  };
  const cycleChecked = new Set<Receiver>();
  const checkCycles = (receiver: Receiver, ancestors: Set<Receiver>) => {
    if (ancestors.has(receiver)) { diagnostic("mount_cycle_unresolved", receiver.node); return; }
    if (cycleChecked.has(receiver)) return;
    cycleChecked.add(receiver);
    for (const use of receiver.uses) for (const arg of use.arguments) {
      const child = receiverFor(arg);
      if (child) checkCycles(child, new Set(ancestors).add(receiver));
    }
  };
  for (const receiver of receivers.values()) checkCycles(receiver, new Set());
  const visited = new Set<Receiver>();
  const middlewareArguments = (use: ts.CallExpression, before?: ts.Expression): ts.Expression[] => {
    const argumentsAfterPrefix = literal(use.arguments[0]) === undefined ? [...use.arguments] : [...use.arguments.slice(1)];
    const bounded = before ? argumentsAfterPrefix.slice(0, argumentsAfterPrefix.indexOf(before)) : argumentsAfterPrefix;
    return bounded.filter(argument => !receiverFor(argument) && functionFor(argument));
  };
  const uniqueExpressions = (expressions: ts.Expression[]) => [...new Map(expressions.map(expression => [`${expression.getSourceFile().fileName}:${expression.getStart()}`, expression])).values()];
  const scopedMiddleware = (receiver: Receiver, before: ts.CallExpression, path: string): ts.Expression[] => receiver.uses
    .filter(use => use.getStart() < before.getStart())
    .flatMap(use => {
      const scope = literal(use.arguments[0]);
      if (scope !== undefined && !(path === scope || path.startsWith(`${scope}/`))) return [];
      return middlewareArguments(use);
    });
  const traverse = (receiver: Receiver, prefix: string, ancestors: Set<Receiver>, context: ts.Node[], inherited: ts.Expression[] = []) => {
    budget();
    if (ancestors.has(receiver)) { diagnostic("mount_cycle_unresolved", receiver.node); return; }
    visited.add(receiver);
    const next = new Set(ancestors).add(receiver);
    for (const call of receiver.routes) {
      const path = literal(call.arguments[0]);
      if (path === undefined) { diagnostic("computed_route_path_unresolved", call); continue; }
      const applicationPath = `${prefix}/${path}`.replace(/\/+/g, "/");
      let identity: Endpoint["identity"];
      try { identity = deriveEndpointIdentity({ identity_version: "1.0.0", service_id: request.source.service_id, method: (call.expression as ts.PropertyAccessExpression).name.text, application_path: applicationPath }); }
      catch { diagnostic("route_syntax_unsupported", call); continue; }
      const id = `ep-${hash(identity.route_key).slice(0, 24)}`;
      if (result.endpoints.some(e => e.endpoint_id === id)) { diagnostic("conflicting_route_handlers", call, result.endpoints.find(e => e.endpoint_id === id)); continue; }
      const ev = evidence(call);
      const endpoint: Endpoint = { endpoint_id: id, identity, application_path: applicationPath,
        parameters: [...applicationPath.matchAll(/:([A-Za-z_][A-Za-z0-9_]*)/g)].map(match => ({ name: match[1]!, in: "path", presence: { state: "required", evidence_ids: [ev] }, schema: { type: "string" }, serialization: { style: "simple" } })),
        request_bodies: [], responses: [], security: { alternatives: [] }, evidence_ids: [ev] };
      result.endpoints.push(endpoint);
      claim(endpoint, "analyzer.toolchain", { compiler: "typescript", compiler_version: ts.version, config_version: "1.0.0", extraction_mode: effectiveExtractionMode }, receiver.node, "deterministic_analysis");
      for (const node of [...context, receiver.node, call]) dependency(endpoint, node);
      const shared = scopedMiddleware(receiver, call, path);
      const handlers = uniqueExpressions([...inherited, ...shared, ...call.arguments.slice(1)]);
      for (const [index, arg] of handlers.entries()) {
        const fn = functionFor(arg);
        if (fn) analyzeFunction(fn, endpoint, index < handlers.length - 1, arg);
        else if (!(ts.isCallExpression(arg) && ts.isPropertyAccessExpression(arg.expression) && importedExpress(arg.expression.expression) === "default" && arg.expression.name.text === "json")) diagnostic("handler_unresolved", arg, endpoint);
      }
      if (endpoint.responses.length === 0) endpoint.responses.push({ status: { kind: "unknown", reason: "No supported response serialization" }, content: [] });
    }
    for (const use of receiver.uses) {
      const prefixArg = literal(use.arguments[0]);
      const hasDynamicPrefix = prefixArg === undefined && use.arguments.length > 1 && !receiverFor(use.arguments[0]!) && !functionFor(use.arguments[0]!);
      if (hasDynamicPrefix) { diagnostic("computed_mount_path_unresolved", use); continue; }
      for (const arg of use.arguments) {
        const child = receiverFor(arg);
        const mountedPrefix = `${prefix}/${prefixArg ?? ""}`.replace(/\/+/g, "/").replace(/\/$/, "");
        const shared = scopedMiddleware(receiver, use, prefixArg ?? "");
        const local = middlewareArguments(use, arg);
        if (child) traverse(child, mountedPrefix, next, [...context, use], uniqueExpressions([...inherited, ...shared, ...local]));
      }
    }
  };
  for (const receiver of receivers.values()) if (receiver.app) traverse(receiver, "", new Set(), []);
  for (const receiver of receivers.values()) if (!visited.has(receiver)) diagnostic("router_exposure_unresolved", receiver.node);
  for (const source of sources.values()) {
    const parseDiagnostics = (source as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
    for (const parseDiagnostic of parseDiagnostics) diagnostic("source_syntax_unsupported", source);
  }
  // Materialize transitive schema dependencies for every consumer, including cached components.
  for (const endpoint of result.endpoints) {
    const seen = new Set<string>();
    const attach = (id: string) => {
      if (seen.has(id)) return;
      seen.add(id);
      const component = result.schemas[id];
      if (!component) return;
      for (const ev of component.evidence_ids) if (!result.dependencies.some(d => d.from_endpoint_id === endpoint.endpoint_id && d.to.id === ev)) result.dependencies.push({ from_endpoint_id: endpoint.endpoint_id, to: { kind: "evidence", id: ev }, evidence_ids: [ev] });
      const scan = (schema: ApiSchema) => {
        if (schema.$ref) attach(schema.$ref.slice("#/schemas/".length));
        for (const child of Object.values(schema.properties ?? {})) scan(child);
        if (schema.items) scan(schema.items);
        for (const child of [...(schema.anyOf ?? []), ...(schema.allOf ?? []), ...(schema.oneOf ?? [])]) scan(child);
      };
      scan(component.schema);
    };
    for (const dep of result.dependencies.filter(d => d.from_endpoint_id === endpoint.endpoint_id && d.to.kind === "schema")) attach(dep.to.id);
  }
  if (receivers.size === 0) diagnostic("no_supported_express_receiver", sources.values().next().value);
  if (result.diagnostics.length) {
    result.status = "partial";
    result.coverage = { status: "incomplete", analyzed_roots: [request.source.service_root], unresolved_roots: [request.source.service_root], reason: "Unsupported or unresolved analysis constructs", diagnostic_ids: result.diagnostics.map(d => d.diagnostic_id) };
  }
  return result;
}
