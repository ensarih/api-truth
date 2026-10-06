import { dirname, relative, resolve } from "node:path";
import ts from "typescript";
import { resolveSwaggerRoutingConfiguration, type RoutingConfiguration } from "./routing-config.js";
import { parseStrictJson } from "./strict-json.js";

export type HandlerCandidate = {
  kind: "candidate"; path: string; line: number; span: string; export_name: string; controller_directory: string; package_scope?: string;
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
  configuration: RoutingConfiguration = resolveSwaggerRoutingConfiguration(files, root)): HandlerCandidateResolver {
  const cache = new Map<string, ReturnType<typeof inspectModule>>();
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
    let inspected = cache.get(path);
    if (!inspected) {
      inspected = inspectModule(path, text);
      cache.set(path, inspected);
    }
    if (inspected.kind === "unresolved") return inspected;
    const node = inspected.exports.get(operationId);
    if (!node) return unresolved("handler_export_unresolved");
    return { kind: "candidate", path: relative(root, path).replaceAll("\\", "/"),
      line: inspected.source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
      span: `span:${node.getStart()}:${node.getEnd()}`, export_name: operationId, controller_directory: directory,
      ...(packageScope ? { package_scope: packageScope } : {}) };
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

function inspectModule(path: string, text: string):
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
        if (name !== undefined) { members++; addExport(name, right); }
      }
    }
    if (replacements > 1 || replacements && members || ambiguous)
      return { kind: "unresolved", code: "handler_export_ambiguous" };
    const written = new Set<string>();
    const stack: ts.Node[] = [source];
    let nodes = 0;
    while (stack.length) {
      const node = stack.pop()!;
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
