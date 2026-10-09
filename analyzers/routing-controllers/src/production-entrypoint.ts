import { resolve, relative, isAbsolute, normalize } from "node:path";
import { builtinModules } from "node:module";
import ts from "typescript";
import { inside } from "./source.js";

export type ProductionGraphIssue = { code: string; node: ts.Node };
export type ProductionGraph = { entrypoint: string; paths: Set<string>; issues: ProductionGraphIssue[] };

const sourcePath = (path: string) => /\.(?:[cm]?[jt]s|tsx|jsx)$/.test(path);
const knownFrameworkModules = new Set(["routing-controllers", "express", "koa"]);
const knownNodeModules = new Set(builtinModules.flatMap(name => [name, name.replace(/^node:/, ""), `node:${name.replace(/^node:/, "")}`]));

function runtimeImport(statement: ts.Statement): string | undefined {
  if (ts.isImportEqualsDeclaration(statement) && !statement.isTypeOnly
    && ts.isExternalModuleReference(statement.moduleReference)
    && statement.moduleReference.expression && ts.isStringLiteral(statement.moduleReference.expression))
    return statement.moduleReference.expression.text;
  if (ts.isImportDeclaration(statement)) {
    const clause = statement.importClause;
    if (!clause || clause.isTypeOnly) return clause ? undefined : ts.isStringLiteral(statement.moduleSpecifier)
      ? statement.moduleSpecifier.text : undefined;
    const namedRuntime = clause.namedBindings && ts.isNamedImports(clause.namedBindings)
      && clause.namedBindings.elements.some(element => !element.isTypeOnly);
    if (!clause.name && !namedRuntime && !(clause.namedBindings && ts.isNamespaceImport(clause.namedBindings))) return undefined;
    return ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : undefined;
  }
  if (ts.isExportDeclaration(statement) && !statement.isTypeOnly && statement.moduleSpecifier
    && ts.isStringLiteral(statement.moduleSpecifier)) {
    if (!statement.exportClause || ts.isNamespaceExport(statement.exportClause)
      || (ts.isNamedExports(statement.exportClause) && statement.exportClause.elements.some(element => !element.isTypeOnly)))
      return statement.moduleSpecifier.text;
  }
  return undefined;
}

function resolveLocal(specifier: string, from: string, root: string, files: Map<string, string>): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const base = resolve(from, "..", specifier);
  if (!inside(root, base)) return undefined;
  const candidates = [base, ...[".ts", ".tsx", ".js", ".mts", ".cts", ".jsx", ".mjs", ".cjs", ".json"]
    .map(extension => `${base}${extension}`), ...["index.ts", "index.js", "index.json"].map(name => resolve(base, name)),
    base.replace(/\.js$/, ".ts"), base.replace(/\.mjs$/, ".mts"), base.replace(/\.cjs$/, ".cts")];
  const found = candidates.filter((path, index) => candidates.indexOf(path) === index && files.has(path));
  return found.length === 1 ? found[0] : undefined;
}

function functionOrControlFlowAncestor(node: ts.Node): boolean {
  for (let parent = node.parent; parent && !ts.isSourceFile(parent); parent = parent.parent) {
    if (ts.isFunctionLike(parent) || ts.isIfStatement(parent) || ts.isIterationStatement(parent, false)
      || ts.isSwitchStatement(parent) || ts.isTryStatement(parent) || ts.isCatchClause(parent)
      || ts.isConditionalExpression(parent)
      || (ts.isBinaryExpression(parent) && [ts.SyntaxKind.AmpersandAmpersandToken,
        ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(parent.operatorToken.kind))) return true;
  }
  return false;
}

function hasRequireName(name: ts.BindingName): boolean {
  if (ts.isIdentifier(name)) return name.text === "require";
  return name.elements.some(element => !ts.isOmittedExpression(element) && hasRequireName(element.name));
}

function assignmentTargetHasRequire(node: ts.Expression): boolean {
  if (ts.isIdentifier(node)) return node.text === "require";
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)
    || ts.isNonNullExpression(node)) return assignmentTargetHasRequire(node.expression);
  if (ts.isArrayLiteralExpression(node)) return node.elements.some(element => !ts.isOmittedExpression(element)
    && assignmentTargetHasRequire(ts.isSpreadElement(element) ? element.expression : element));
  if (ts.isObjectLiteralExpression(node)) return node.properties.some(property => {
    if (ts.isShorthandPropertyAssignment(property)) return property.name.text === "require";
    if (ts.isPropertyAssignment(property)) return assignmentTargetHasRequire(property.initializer);
    return ts.isSpreadAssignment(property) && assignmentTargetHasRequire(property.expression);
  });
  if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
    && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) return assignmentTargetHasRequire(node.left);
  return false;
}

function hasRequireBinding(source: ts.SourceFile): boolean {
  let shadowed = false;
  const visit = (node: ts.Node) => {
    if ((ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isFunctionDeclaration(node)
      || ts.isFunctionExpression(node) || ts.isClassDeclaration(node) || ts.isClassExpression(node)
      || ts.isImportClause(node) || ts.isImportSpecifier(node) || ts.isNamespaceImport(node))
      && node.name && hasRequireName(node.name)) shadowed = true;
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
      && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment && assignmentTargetHasRequire(node.left)) shadowed = true;
    if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
      && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator)
      && ts.isIdentifier(node.operand) && node.operand.text === "require") shadowed = true;
    ts.forEachChild(node, visit);
  };
  visit(source);
  return shadowed;
}

/** Build only the statically known runtime module graph from one selected source entrypoint. */
export function buildProductionGraph(files: Map<string, string>, root: string, entrypoint: string,
  projectRoot: string, budget: () => void): ProductionGraph {
  if (!entrypoint || isAbsolute(entrypoint) || entrypoint.includes("\\") || normalize(entrypoint) !== entrypoint)
    throw new Error("Production entrypoint rejected");
  const absolute = resolve(projectRoot, entrypoint);
  if (!inside(projectRoot, absolute) || relative(projectRoot, absolute).startsWith(".."))
    throw new Error("Production entrypoint rejected");
  if (!inside(root, absolute) || !sourcePath(absolute) || !files.has(absolute))
    throw new Error("Production entrypoint rejected");
  const paths = new Set<string>();
  const issues: ProductionGraphIssue[] = [];
  const queue = [absolute];
  let edges = 0;
  let edgeLimitExceeded = false;
  while (queue.length && !edgeLimitExceeded) {
    budget();
    const path = queue.shift()!;
    if (paths.has(path)) continue;
    paths.add(path);
    const source = ts.createSourceFile(path, files.get(path)!, ts.ScriptTarget.Latest, true,
      /\.[cm]?jsx?$/.test(path) ? ts.ScriptKind.JS : ts.ScriptKind.TS);
    if (path === absolute) issues.push({ code: "production_entrypoint_deployment_unverified", node: source });
    const shadowedRequire = hasRequireBinding(source);
    const follow = (specifier: string, node: ts.Node) => {
      if (!specifier.startsWith(".")) {
        if (knownFrameworkModules.has(specifier) || knownNodeModules.has(specifier)) return;
        issues.push({ code: "external_runtime_import_unresolved", node });
        return;
      }
      if (++edges > 4096) {
        issues.push({ code: "production_import_limit_exceeded", node }); edgeLimitExceeded = true; return;
      }
      const resolved = resolveLocal(specifier, path, root, files);
      if (!resolved) { issues.push({ code: "production_import_unresolved", node }); return; }
      if (sourcePath(resolved)) queue.push(resolved);
    };
    for (const statement of source.statements) {
      const specifier = runtimeImport(statement);
      if (specifier !== undefined) follow(specifier, statement);
      if (edgeLimitExceeded) break;
    }
    const visit = (node: ts.Node) => {
      if (edgeLimitExceeded) return;
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        issues.push({ code: "dynamic_import_unresolved", node });
      } else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "require") {
        if (shadowedRequire) {
          issues.push({ code: "production_import_unresolved", node });
        } else if (functionOrControlFlowAncestor(node)) {
          if (node.arguments.length !== 1 || !ts.isStringLiteral(node.arguments[0]!))
            issues.push({ code: "production_import_unresolved", node });
          else issues.push({ code: "conditional_import_unresolved", node });
        } else if (node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0]!)) {
          follow(node.arguments[0]!.text, node);
        } else issues.push({ code: "production_import_unresolved", node });
      } else if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === "module"
        && node.expression.name.text === "require") {
        issues.push({ code: "production_import_unresolved", node });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    for (const diagnostic of (source as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [])
      if (diagnostic) issues.push({ code: "source_syntax_unsupported", node: source });
  }
  return { entrypoint: relative(projectRoot, absolute).replaceAll("\\", "/"), paths, issues };
}
