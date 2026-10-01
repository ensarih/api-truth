import { dirname, isAbsolute, join, relative } from "node:path";
import ts from "typescript";

const literal = (node: ts.Node) => ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : undefined;
const propertyName = (node: ts.PropertyName) => ts.isIdentifier(node) || ts.isStringLiteral(node) ? node.text : undefined;

/** Follow only contained, static const/object declarations; never evaluate project code. */
export function resolveStaticExpression(input: ts.Expression, checker: ts.TypeChecker): ts.Expression | undefined {
  const seen = new Set<ts.Node>();
  const visit = (node: ts.Expression, depth: number): ts.Expression | undefined => {
    if (depth > 16 || seen.has(node)) return undefined;
    seen.add(node);
    if (ts.isParenthesizedExpression(node)) return visit(node.expression, depth + 1);
    if (ts.isIdentifier(node)) {
      let symbol = checker.getSymbolAtLocation(node);
      if (symbol?.flags && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
      const declarations = symbol?.declarations ?? [];
      const declaration = declarations.length === 1 ? declarations[0] : undefined;
      if (declaration && ts.isVariableDeclaration(declaration)
        && (declaration.parent.flags & ts.NodeFlags.Const) && declaration.initializer)
        return visit(declaration.initializer, depth + 1);
      return node;
    }
    if (ts.isPropertyAccessExpression(node)) {
      const base = visit(node.expression, depth + 1);
      if (!base || !ts.isObjectLiteralExpression(base)) return node;
      const properties = base.properties.filter(property => ts.isPropertyAssignment(property)
        && propertyName(property.name) === node.name.text);
      if (properties.length !== 1 || !ts.isPropertyAssignment(properties[0]!)) return undefined;
      return visit(properties[0]!.initializer, depth + 1);
    }
    return node;
  };
  return visit(input, 0);
}

const isPathJoin = (call: ts.CallExpression, checker: ts.TypeChecker): boolean => {
  if (!ts.isPropertyAccessExpression(call.expression) || call.expression.name.text !== "join"
    || !ts.isIdentifier(call.expression.expression)) return false;
  const symbol = checker.getSymbolAtLocation(call.expression.expression);
  if (symbol?.declarations?.length !== 1) return false;
  const declaration = symbol.declarations[0]!;
  const imported = ts.isImportClause(declaration) ? declaration.parent
    : ts.isNamespaceImport(declaration) ? declaration.parent.parent : undefined;
  return !!imported && ts.isImportDeclaration(imported)
    && (literal(imported.moduleSpecifier) === "path" || literal(imported.moduleSpecifier) === "node:path");
};

/** Resolve a literal or path.join(__dirname, ...) to a path string. */
export function resolveStaticPath(input: ts.Expression, checker: ts.TypeChecker): string | undefined {
  const visit = (node: ts.Expression, depth: number): string | undefined => {
    if (depth > 16) return undefined;
    const resolved = resolveStaticExpression(node, checker);
    if (!resolved) return undefined;
    const value = literal(resolved);
    if (value !== undefined) return value;
    if (ts.isIdentifier(resolved) && resolved.text === "__dirname") return dirname(resolved.getSourceFile().fileName);
    if (ts.isCallExpression(resolved) && isPathJoin(resolved, checker) && resolved.arguments.length > 0) {
      const parts = resolved.arguments.map(arg => visit(arg, depth + 1));
      return parts.every((part): part is string => part !== undefined) ? join(...parts) : undefined;
    }
    return undefined;
  };
  return visit(input, 0);
}

const escape = (value: string) => value.replace(/[\\^$+?.()|[\]{}]/g, "\\$&");
const globSegment = (value: string): string | undefined => {
  let result = "";
  for (let index = 0; index < value.length;) {
    const char = value[index]!;
    if (char === "*") { result += "[^/]*"; index += 1; continue; }
    if (char === "{") {
      const end = value.indexOf("}", index + 1);
      if (end < 0) return undefined;
      const options = value.slice(index + 1, end).split(",");
      if (options.length < 2 || options.length > 6 || options.some(option => !/^\.[cm]?[jt]sx?$/.test(option))) return undefined;
      result += `(?:${options.map(escape).join("|")})`;
      index = end + 1;
      continue;
    }
    if (!/[A-Za-z0-9_.-]/.test(char)) return undefined;
    result += escape(char);
    index += 1;
  }
  return result;
};

/** Match one bounded absolute glob only against files already collected under the service root. */
export function matchControllerGlob(pattern: string, root: string, sourcePaths: readonly string[]): string[] | undefined {
  if (!isAbsolute(pattern) || pattern.length > 512) return undefined;
  const relativePattern = relative(root, pattern).replaceAll("\\", "/");
  if (relativePattern.startsWith("../") || relativePattern === ".." || isAbsolute(relativePattern)) return undefined;
  const segments = relativePattern.split("/");
  if (segments.length > 32 || segments.filter(segment => segment === "**").length > 1) return undefined;
  let source = "^";
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index]!;
    if (segment === "**") { source += "(?:[^/]+/)*"; continue; }
    if (!segment || segment === "." || segment === ".." || segment.includes("**")) return undefined;
    const part = globSegment(segment);
    if (part === undefined) return undefined;
    source += part;
    if (index < segments.length - 1) source += "/";
  }
  const matcher = new RegExp(`${source}$`);
  return sourcePaths.filter(path => matcher.test(relative(root, path).replaceAll("\\", "/")));
}
