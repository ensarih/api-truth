import type {ApiSchema} from "../../../packages/ir/src/index.js";
import { dirname, relative, resolve } from "node:path";
import ts from "typescript";
import { resolveSwaggerRoutingConfiguration, type RoutingConfiguration } from "./routing-config.js";
import { parseStrictJson } from "./strict-json.js";

export type HandlerCandidate = {
  kind: "candidate"; path: string; line: number; span: string; export_name: string; controller_directory: string; package_scope?: string;
  initialization_sources?: Array<{path: string; package_scope?: string}>;
};
type UnresolvedCandidate = { kind: "unresolved"; code: string };
export type HandlerCandidateResolution = HandlerCandidate | UnresolvedCandidate;
export type HandlerCandidateResolver = (controller: string, operationId: string) => HandlerCandidateResolution;
const unresolved = (code: string): UnresolvedCandidate => ({ kind: "unresolved", code });
const reserved = new Set(["__proto__", "prototype", "constructor"]);
const propertyName = (node: ts.PropertyName): string | undefined =>
  ts.isIdentifier(node) || ts.isStringLiteral(node) ? node.text : undefined;
const functionValue = (node: ts.Node): node is ts.FunctionExpression | ts.ArrowFunction | ts.MethodDeclaration =>
  ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node);

/** Source candidates under a static declared directory profile; no module loading or runtime binding. */
export function createHandlerCandidateResolver(files: Map<string, string>, root: string,
  configuration: RoutingConfiguration = resolveSwaggerRoutingConfiguration(files, root),
  budget: () => void = () => {}): HandlerCandidateResolver {
  const packageScopes = new Map<string, string | UnresolvedCandidate>();
  return (controller, operationId) => {
    if (!/^[A-Za-z0-9_-]+(?:\.(?:js|cjs))?$/.test(controller) || reserved.has(controller)
      || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(operationId) || reserved.has(operationId))
      return unresolved("handler_mapping_unsupported");
    if (configuration.kind === "unresolved") return unresolved(configuration.code);
    const explicitExtension = /\.(?:js|cjs)$/.test(controller);
    const matches = configuration.controller_dirs.map(directory => ({
      directory, path: resolve(root, directory, explicitExtension ? controller : `${controller}.js`),
    })).filter(item => files.has(item.path));
    if (matches.length > 1) return unresolved("handler_source_ambiguous");
    if (!explicitExtension && configuration.controller_dirs.some(directory =>
      [`${controller}.json`, `${controller}/package.json`, `${controller}/index.js`,
        `${controller}/index.json`].some(name => files.has(resolve(root, directory, name)))))
      return unresolved("handler_module_resolution_unverified");
    const match = matches[0];
    if (!match) return unresolved("handler_source_unresolved");
    const {path, directory} = match;
    const text = files.get(path);
    if (text === undefined) return unresolved("handler_source_unresolved");
    let packageScope: string | undefined;
    if (path.endsWith(".js")) {
      const directory = dirname(path);
      let scope = packageScopes.get(directory);
      if (scope === undefined) {
        scope = findCommonJsScope(files, root, directory);
        packageScopes.set(directory, scope);
      }
      if (typeof scope !== "string") return scope;
      packageScope = scope;
    }
    const loaded = new Map<string, {module: ReturnType<typeof inspectModule>; package_scope?: string}>();
    const visiting = new Set<string>();
    let bytes = 0;
    const inspectGraph = (absolute: string, depth: number): ReturnType<typeof inspectModule> => {
      budget();
      if (visiting.has(absolute)) return unresolved("handler_initialization_unverified");
      const cached = loaded.get(absolute);
      if (cached) return cached.module;
      if (depth > 8 || loaded.size + visiting.size >= 32) return unresolved("handler_source_limit_exceeded");
      const source = files.get(absolute);
      if (source === undefined) return unresolved("handler_initialization_unverified");
      bytes += Buffer.byteLength(source);
      if (bytes > 1_000_000) return unresolved("handler_source_limit_exceeded");
      let scope: string | undefined;
      if (absolute.endsWith(".js")) {
        const resolvedScope = findCommonJsScope(files, root, dirname(absolute));
        if (typeof resolvedScope !== "string") return resolvedScope;
        scope = resolvedScope;
      }
      visiting.add(absolute);
      let failure: UnresolvedCandidate | undefined;
      const module = inspectModule(absolute, source, node => {
        if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression) || node.expression.text !== "require"
          || node.arguments.length !== 1 || !ts.isStringLiteral(node.arguments[0]!)) return false;
        const spec = node.arguments[0]!.text;
        if (!/^(?:\.\.?\/)(?:[A-Za-z0-9_$-]+\/)*[A-Za-z0-9_$-]+(?:\.(?:js|cjs))?$/.test(spec)) return false;
        const extension = /\.(?:js|cjs)$/.test(spec);
        const base = resolve(dirname(absolute), spec);
        const relativeBase = relative(root, base);
        if (relativeBase === ".." || relativeBase.startsWith("../") || relativeBase.startsWith("..\\")) return false;
        if (!extension && [`${base}.json`, `${base}/package.json`, `${base}/index.js`, `${base}/index.json`]
          .some(alternative => files.has(alternative))) return false;
        const child = inspectGraph(extension ? base : `${base}.js`, depth + 1);
        if (child.kind === "unresolved") { failure = child; return false; }
        return true;
      }, budget);
      visiting.delete(absolute);
      const result = failure ?? module;
      loaded.set(absolute, {module: result, ...(scope ? {package_scope: scope} : {})});
      return result;
    };
    const inspected = inspectGraph(path, 0);
    if (inspected.kind === "unresolved") return inspected;
    const node = inspected.exports.get(operationId);
    if (!node) return unresolved("handler_export_unresolved");
    return { kind: "candidate", path: relative(root, path).replaceAll("\\", "/"),
      line: inspected.source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
      span: `span:${node.getStart()}:${node.getEnd()}`, export_name: operationId, controller_directory: directory,
      ...(packageScope ? { package_scope: packageScope } : {}),
      ...(loaded.size > 1 ? {initialization_sources: [...loaded].filter(([absolute]) => absolute !== path)
        .map(([absolute, item]) => ({path: relative(root, absolute).replaceAll("\\", "/"),
          ...(item.package_scope ? {package_scope: item.package_scope} : {})}))
        .sort((a, b) => a.path.localeCompare(b.path))} : {}) };
  };
}

function findCommonJsScope(files: Map<string, string>, root: string, directory: string): string | UnresolvedCandidate {
  // Node uses the nearest package scope; an unscanned ancestor cannot establish it.
  for (let current = directory; ; current = dirname(current)) {
    const packagePath = resolve(current, "package.json");
    const text = files.get(packagePath);
    if (text !== undefined) {
      if (Buffer.byteLength(text) > 1_000_000) return unresolved("handler_source_limit_exceeded");
      try {
        const value = parseStrictJson(text);
        if (!value || typeof value !== "object" || Array.isArray(value)
          || (value as Record<string, unknown>).type !== undefined
          && (value as Record<string, unknown>).type !== "commonjs") return unresolved("handler_module_format_unverified");
      } catch { return unresolved("handler_module_format_unverified"); }
      return relative(root, packagePath).replaceAll("\\", "/");
    }
    if (current === root || dirname(current) === current) break;
  }
  return unresolved("handler_module_format_unverified");
}

function inspectModule(path: string, text: string, localRequire: (node: ts.Expression) => boolean = () => false,
  budget: () => void = () => {}):
  | { kind: "module"; source: ts.SourceFile; exports: Map<string, ts.Node> }
  | { kind: "unresolved"; code: string } {
  if (Buffer.byteLength(text) > 1_000_000) return { kind: "unresolved", code: "handler_source_limit_exceeded" };
  try {
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    if (((source as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? []).length)
      return { kind: "unresolved", code: "handler_source_unresolved" };
    if (source.statements.some(statement => ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)
      || ts.isExportAssignment(statement) || ts.canHaveModifiers(statement)
      && ts.getModifiers(statement)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)))
      return { kind: "unresolved", code: "handler_module_format_unverified" };
    const symbols = new Map<string, ts.Node[]>();
    const addSymbol = (name: string, value: ts.Node) => symbols.set(name, [...(symbols.get(name) ?? []), value]);
    for (const statement of source.statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name && statement.body) addSymbol(statement.name.text, statement);
      if (ts.isVariableStatement(statement))
        for (const declaration of statement.declarationList.declarations)
          if (ts.isIdentifier(declaration.name)) addSymbol(declaration.name.text,
            statement.declarationList.flags & ts.NodeFlags.Const && declaration.initializer
              && functionValue(declaration.initializer) ? declaration.initializer : declaration);
    }
    const allowedExportIdentifiers = new Set<ts.Node>();
    const mark = (node: ts.Node) => {
      if (ts.isIdentifier(node) && (node.text === "module" || node.text === "exports")) allowedExportIdentifiers.add(node);
    };
    const exportsObject = (node: ts.Expression): boolean => {
      if (!ts.isPropertyAccessExpression(node) || node.name.text !== "exports"
        || !ts.isIdentifier(node.expression) || node.expression.text !== "module") return false;
      mark(node.expression); mark(node.name);
      return true;
    };
    const exportMember = (node: ts.Expression): string | undefined => {
      if (!(ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))) return undefined;
      const base = node.expression;
      if (ts.isIdentifier(base) && base.text === "exports") mark(base);
      else if (!exportsObject(base)) return undefined;
      return ts.isPropertyAccessExpression(node) ? node.name.text
        : node.argumentExpression && ts.isStringLiteral(node.argumentExpression) ? node.argumentExpression.text : undefined;
    };
    const exportStatements = new Set<ts.Statement>();
    const exportedValues = new Map<string, ts.Node>();
    let replacements = 0;
    let members = 0;
    let ambiguous = false;
    const addExport = (name: string | undefined, value: ts.Node): void => {
      if (!name || reserved.has(name) || exportedValues.has(name)) { ambiguous = true; return; }
      exportedValues.set(name, value);
    };
    for (const statement of source.statements) {
      if (!ts.isExpressionStatement(statement) || !ts.isBinaryExpression(statement.expression)
        || statement.expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken) continue;
      const { left, right } = statement.expression;
      if (exportsObject(left)) {
        exportStatements.add(statement);
        replacements++;
        if (!ts.isObjectLiteralExpression(right)) { ambiguous = true; continue; }
        for (const property of right.properties) {
          if (ts.isShorthandPropertyAssignment(property) && !property.objectAssignmentInitializer)
            addExport(property.name.text, property.name);
          else if (ts.isPropertyAssignment(property)) addExport(propertyName(property.name), property.initializer);
          else if (ts.isMethodDeclaration(property)) addExport(propertyName(property.name), property);
          else ambiguous = true;
        }
      } else {
        const name = exportMember(left);
        if (name !== undefined) { exportStatements.add(statement); members++; addExport(name, right); }
      }
    }
    if (replacements > 1 || replacements && members || ambiguous)
      return { kind: "unresolved", code: "handler_export_ambiguous" };
    const written = new Set<string>();
    const stack: ts.Node[] = [source];
    let nodes = 0;
    while (stack.length) {
      const node = stack.pop()!;
      if (nodes % 512 === 0) budget();
      if (++nodes > 50_000) return { kind: "unresolved", code: "handler_source_limit_exceeded" };
      if (ts.isIdentifier(node) && (node.text === "module" || node.text === "exports")
        && !allowedExportIdentifiers.has(node)) return { kind: "unresolved", code: "handler_export_unresolved" };
      if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
        && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
        const leftStack: ts.Node[] = [node.left];
        while (leftStack.length) {
          const left = leftStack.pop()!;
          if (ts.isIdentifier(left)) written.add(left.text);
          if (ts.isPropertyAccessExpression(left) || ts.isElementAccessExpression(left)) continue;
          ts.forEachChild(left, child => { leftStack.push(child); });
        }
      }
      if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
        && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
        && ts.isIdentifier(node.operand)) written.add(node.operand.text);
      ts.forEachChild(node, child => { stack.push(child); });
    }
    // Syntactic initialization subset only. Never execute a controller or import its dependencies.
    const inert = (node: ts.Node, depth = 0): boolean => {
      if (depth > 100) return false;
      if (ts.isFunctionExpression(node) || ts.isArrowFunction(node)
        || ts.isMethodDeclaration(node) && propertyName(node.name) !== undefined) return true;
      if (ts.isStringLiteral(node) || ts.isNumericLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
        || [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(node.kind)) return true;
      if (ts.isParenthesizedExpression(node)) return inert(node.expression, depth + 1);
      if (ts.isPrefixUnaryExpression(node) && [ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken].includes(node.operator))
        return ts.isNumericLiteral(node.operand);
      if (ts.isArrayLiteralExpression(node)) return node.elements.every(item => inert(item, depth + 1));
      if (ts.isObjectLiteralExpression(node)) return node.properties.every(property =>
        ts.isPropertyAssignment(property) && propertyName(property.name) !== undefined && inert(property.initializer, depth + 1)
        || ts.isMethodDeclaration(property) && propertyName(property.name) !== undefined);
      return false;
    };
    const referenceInitialized = (value: ts.Node): boolean => {
      if (!ts.isIdentifier(value)) return inert(value);
      const definitions = symbols.get(value.text);
      if (definitions?.length !== 1) return false;
      const definition = definitions[0]!;
      return ts.isFunctionDeclaration(definition) || functionValue(definition) && definition.getStart() < value.getStart();
    };
    if ([...symbols.values()].some(definitions => definitions.length > 1))
      return unresolved("handler_initialization_unverified");
    for (const statement of source.statements) {
      if (ts.isEmptyStatement(statement) || ts.isFunctionDeclaration(statement) && statement.body) continue;
      if (ts.isExpressionStatement(statement) && ts.isStringLiteral(statement.expression)) continue;
      if (exportStatements.has(statement)) continue;
      if (ts.isVariableStatement(statement) && statement.declarationList.flags & ts.NodeFlags.Const
        && statement.declarationList.declarations.every(declaration => ts.isIdentifier(declaration.name)
          && declaration.initializer && (inert(declaration.initializer)
            || !symbols.has("require") && !written.has("require") && localRequire(declaration.initializer)))) continue;
      return unresolved("handler_initialization_unverified");
    }
    if ([...exportedValues.values()].some(value => !referenceInitialized(value)))
      return unresolved("handler_initialization_unverified");
    const exports = new Map<string, ts.Node>();
    for (const [name, value] of exportedValues) {
      if (functionValue(value)) exports.set(name, value);
      else if (ts.isIdentifier(value) && !written.has(value.text)) {
        const definitions = symbols.get(value.text);
        if (definitions?.length === 1 && (functionValue(definitions[0]!)
          || ts.isFunctionDeclaration(definitions[0]!) && definitions[0]!.body)) exports.set(name, definitions[0]!);
      }
    }
    return { kind: "module", source, exports };
  } catch { return { kind: "unresolved", code: "handler_source_unresolved" }; }
}

export type HandlerResponseStatus = {kind: "declared"; code: number; line: number; span: string; body?: {schema: ApiSchema; line: number; span: string}} | {kind: "unresolved"};
/** Bounded source declaration only; runtime binding does not prove a response contract. */
export function inspectBoundResponseStatus(path: string, text: string, exportName: string,
  budget: () => void = () => {}): HandlerResponseStatus {
  const unknown: HandlerResponseStatus = {kind: "unresolved"};
  const module = inspectModule(path, text, () => false, budget);
  if (module.kind === "unresolved") return unknown;
  const handler = module.exports.get(exportName);
  if (!handler || !(ts.isFunctionDeclaration(handler) || functionValue(handler)) || !handler.body
    || handler.parameters.length < 2 || handler.parameters.length > 3) return unknown;
  const names = handler.parameters.map(parameter => ts.isIdentifier(parameter.name) && !parameter.initializer
    && !parameter.dotDotDotToken ? parameter.name.text : undefined);
  if (names.some(name => name === undefined) || new Set(names).size !== names.length) return unknown;
  const responseName = names[1]!;
  let expression: ts.Expression | undefined;
  if (ts.isBlock(handler.body)) {
    if (handler.body.statements.length !== 1) return unknown;
    const statement = handler.body.statements[0]!;
    if (!ts.isReturnStatement(statement)) return unknown;
    expression = statement.expression;
  } else expression = handler.body;
  if (!expression || !ts.isCallExpression(expression) || !ts.isPropertyAccessExpression(expression.expression)) return unknown;
  const terminal = expression.expression;
  const directResponse = (node: ts.Expression) => ts.isIdentifier(node) && node.text === responseName;
  let status: ts.Expression | undefined;
  let body: {schema: ApiSchema; line: number; span: string} | undefined;
  if (terminal.name.text === "sendStatus" && directResponse(terminal.expression) && expression.arguments.length === 1)
    status = expression.arguments[0];
  else {
    if (!["json", "send", "end"].includes(terminal.name.text)) return unknown;
    const expectedArguments = terminal.name.text === "end" ? 0 : 1;
    if (expression.arguments.length !== expectedArguments) return unknown;
    let nodes = 0;
    const literal = (node: ts.Node, depth = 0): ApiSchema | undefined => {
      if (++nodes % 512 === 0) budget();
      if (nodes > 10000 || depth > 64) return undefined;
      if (ts.isStringLiteral(node)) return {type: "string"};
      if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) return {type: "boolean"};
      if (node.kind === ts.SyntaxKind.NullKeyword) return {type: "null"};
      if (ts.isNumericLiteral(node) || ts.isPrefixUnaryExpression(node)
        && node.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(node.operand)) {
        const number = Number(ts.isNumericLiteral(node) ? node.text : node.operand.getText(module.source));
        return Number.isFinite(number) ? {type: Number.isInteger(number) ? "integer" : "number"} : undefined;
      }
      if (ts.isArrayLiteralExpression(node)) {
        const shapes = new Map<string, ApiSchema>();
        for (const item of node.elements) {
          const shape = literal(item, depth + 1);
          if (!shape) return undefined;
          shapes.set(JSON.stringify(shape), shape);
          if (shapes.size > 32) return undefined;
        }
        const values = [...shapes.values()];
        return {type: "array", ...(values.length ? {items: values.length === 1 ? values[0]! : {anyOf: values}} : {})};
      }
      if (ts.isObjectLiteralExpression(node)) {
        const properties: Record<string, ApiSchema> = {};
        for (const property of node.properties) {
          if (!ts.isPropertyAssignment(property)) return undefined;
          const name = propertyName(property.name);
          if (name === undefined || reserved.has(name) || Object.hasOwn(properties, name)) return undefined;
          const shape = literal(property.initializer, depth + 1);
          if (!shape) return undefined;
          properties[name] = shape;
        }
        return {type: "object", properties};
      }
      return undefined;
    };
    for (const argument of expression.arguments) {
      const schema = literal(argument);
      if (!schema) return unknown;
      if (terminal.name.text === "json") body = {schema,
        line: module.source.getLineAndCharacterOfPosition(argument.getStart()).line + 1,
        span: `span:${argument.getStart()}:${argument.getEnd()}`};
    }
    const chain = terminal.expression;
    if (!ts.isCallExpression(chain) || !ts.isPropertyAccessExpression(chain.expression)
      || chain.expression.name.text !== "status" || !directResponse(chain.expression.expression)
      || chain.arguments.length !== 1) return unknown;
    status = chain.arguments[0];
  }
  if (!status || !ts.isNumericLiteral(status) || !/^[1-5][0-9]{2}$/.test(status.getText(module.source))) return unknown;
  return {kind: "declared", code: Number(status.text),
    line: module.source.getLineAndCharacterOfPosition(status.getStart()).line + 1,
    span: `span:${status.getStart()}:${status.getEnd()}`, ...(body ? {body} : {})};
}
