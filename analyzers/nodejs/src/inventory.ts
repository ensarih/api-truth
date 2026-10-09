import { createHash } from "node:crypto";
import { relative, resolve, sep } from "node:path";
import ts from "typescript";
import { digestServiceTree, readSelectedDocument, readServiceTree } from "./source.js";
import { parseStrictJson } from "./strict-json.js";
import { parseStrictYaml } from "./strict-yaml.js";

export type InventoryClassification = "supported" | "unsupported" | "mixed" | "unresolved";
export type InventoryFamily = "express" | "swagger-express-mw" | "routing-controllers" | "swagger2" | "openapi3" | "api-document";
export type InventoryEvidence = {path: string; pointer: string; digest: string; kind: "source_registration" | "selected_api_document"};
export type InventorySignal = {family: InventoryFamily; classification: Exclude<InventoryClassification, "mixed">;
  evidence: InventoryEvidence[]; limitations: string[]};
export type NodeServiceInventory = {classification: InventoryClassification; signals: InventorySignal[];
  diagnostics: string[]; fingerprint: string; source_digest: string; scanned_source_files: number; scanned_documents: number};

export type InventoryOptions = {projectRoot: string; serviceRoot: string; entrypoints: string[];
  authoritativeDocumentPaths?: string[]; limits?: {maxFiles?: number; maxEntrypoints?: number; maxDocuments?: number;
    maxGraphFiles?: number; maxImportEdges?: number}};

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const normalizedPath = (path: string): boolean => path === "."
  || /^[A-Za-z0-9_@+.-]+(?:\/[A-Za-z0-9_@+.-]+)*$/.test(path)
    && !path.split("/").some(part => part === "." || part === "..");
const sourceFile = (path: string) => /\.[cm]?[jt]sx?$/.test(path) && !/\.d\.[cm]?tsx?$/.test(path);
const nonProductionEntrypoint = (path: string) => path.toLowerCase().split("/")
  .some(part => ["test", "tests", "fixture", "fixtures", "__tests__", "__fixtures__"].includes(part))
  || /\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(path);
const textLiteral = (node: ts.Node | undefined): string | undefined => node
  && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined;
const relativePath = (root: string, path: string) => relative(root, path).split(sep).join("/");
const diagnostic = (items: Set<string>, code: string) => { items.add(code); };
const plainObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const validApiDocument = (record: Record<string, unknown>): boolean => plainObject(record.info)
  && typeof record.info.title === "string" && !!record.info.title.trim()
  && typeof record.info.version === "string" && !!record.info.version.trim()
  && plainObject(record.paths);

function importedBindings(source: ts.SourceFile, pkg: string): Map<string, string> {
  const bindings = new Map<string, string>();
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && textLiteral(statement.moduleSpecifier) === pkg) {
      const clause = statement.importClause;
      if (clause?.name) bindings.set(clause.name.text, "default");
      if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) bindings.set(clause.namedBindings.name.text, "*");
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings))
        for (const item of clause.namedBindings.elements) bindings.set(item.name.text, item.propertyName?.text ?? item.name.text);
    }
    if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) {
      if (!(statement.declarationList.flags & ts.NodeFlags.Const) || !ts.isIdentifier(declaration.name)
        || !declaration.initializer || !ts.isCallExpression(declaration.initializer)
        || !ts.isIdentifier(declaration.initializer.expression) || declaration.initializer.expression.text !== "require"
        || declaration.initializer.arguments.length !== 1 || textLiteral(declaration.initializer.arguments[0]) !== pkg) continue;
      bindings.set(declaration.name.text, "*");
    }
  }
  return bindings;
}

function runtimeRelativeModule(statement: ts.ImportDeclaration | ts.ExportDeclaration): string | undefined {
  if (!statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier) || !statement.moduleSpecifier.text.startsWith(".")) return;
  if (ts.isExportDeclaration(statement)) return statement.isTypeOnly ? undefined : statement.moduleSpecifier.text;
  const clause = statement.importClause;
  if (!clause) return statement.moduleSpecifier.text;
  if (clause.isTypeOnly) return;
  if (clause.name) return statement.moduleSpecifier.text;
  if (!clause.namedBindings) return statement.moduleSpecifier.text;
  if (ts.isNamespaceImport(clause.namedBindings)) return statement.moduleSpecifier.text;
  return clause.namedBindings.elements.some(element => !element.isTypeOnly) ? statement.moduleSpecifier.text : undefined;
}

function isFunctionLike(node: ts.Node): boolean {
  return ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)
    || ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)
    || ts.isConstructorDeclaration(node);
}

/** Visit only module-scope executable syntax; function bodies and nested blocks are not proof of production use. */
function visitTopLevel(source: ts.SourceFile, visit: (node: ts.Node) => void): void {
  const walk = (node: ts.Node): void => {
    if (isFunctionLike(node) || ts.isBlock(node) || ts.isIfStatement(node) || ts.isForStatement(node)
      || ts.isForInStatement(node) || ts.isForOfStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node)
      || ts.isSwitchStatement(node) || ts.isTryStatement(node) || ts.isConditionalExpression(node)) return;
    visit(node);
    ts.forEachChild(node, walk);
  };
  for (const statement of source.statements) walk(statement);
}

function localImports(source: ts.SourceFile, diagnostics: Set<string>): string[] {
  const imports: string[] = [];
  const topLevelCalls = new Set<ts.Node>();
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) {
      const specifier = runtimeRelativeModule(statement);
      if (specifier) imports.push(specifier);
    }
  }
  visitTopLevel(source, node => {
    if (ts.isCallExpression(node)) topLevelCalls.add(node);
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) diagnostic(diagnostics, "dynamic_import_unresolved");
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "require") {
      const specifier = node.arguments.length === 1 ? textLiteral(node.arguments[0]) : undefined;
      if (specifier?.startsWith(".")) imports.push(specifier);
      else if (!specifier) diagnostic(diagnostics, "dynamic_import_unresolved");
    }
  });
  const inspectNestedResolution = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword)
      diagnostic(diagnostics, "dynamic_import_unresolved");
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "require") {
      const specifier = node.arguments.length === 1 ? textLiteral(node.arguments[0]) : undefined;
      if (specifier?.startsWith(".") && !topLevelCalls.has(node)) diagnostic(diagnostics, "dynamic_import_unresolved");
      else if (!specifier) diagnostic(diagnostics, "dynamic_import_unresolved");
    }
    ts.forEachChild(node, inspectNestedResolution);
  };
  inspectNestedResolution(source);
  return imports;
}

function hasRegistration(source: ts.SourceFile, family: "express" | "swagger-express-mw"): boolean {
  const pkg = family === "express" ? "express" : "swagger-express-mw";
  const bindings = importedBindings(source, pkg);
  if (!bindings.size) return false;
  const appNames = new Set<string>();
  const registerNames = new Set<string>();
  const isFrameworkFactory = (expression: ts.Expression): boolean => ts.isIdentifier(expression)
    && ["default", "*", "Router"].includes(bindings.get(expression.text) ?? "")
    || ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)
      && ["default", "*"].includes(bindings.get(expression.expression.text) ?? "") && expression.name.text === "Router";
  const scan = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isCallExpression(node.initializer)
      && ts.isVariableDeclarationList(node.parent) && (node.parent.flags & ts.NodeFlags.Const)) {
      if (family === "express" && isFrameworkFactory(node.initializer.expression)) appNames.add(node.name.text);
      if (family === "swagger-express-mw" && ts.isPropertyAccessExpression(node.initializer.expression)
        && node.initializer.expression.name.text === "create" && ts.isIdentifier(node.initializer.expression.expression)
        && ["default", "*"].includes(bindings.get(node.initializer.expression.expression.text) ?? "")) registerNames.add(node.name.text);
    }
    if (family === "swagger-express-mw" && ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === "create" && ts.isIdentifier(node.expression.expression)
      && ["default", "*"].includes(bindings.get(node.expression.expression.text) ?? "")) registerNames.add("__direct_create__");
    if (family === "express" && ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && ["use", "get", "post", "put", "patch", "delete", "options", "head", "all", "route"].includes(node.expression.name.text)
      && ts.isIdentifier(node.expression.expression) && appNames.has(node.expression.expression.text)) registerNames.add(node.expression.expression.text);
  };
  visitTopLevel(source, scan);
  return registerNames.size > 0;
}

function hasNestedFrameworkRegistration(source: ts.SourceFile, family: "express" | "swagger-express-mw" | "routing-controllers"): boolean {
  const pkg = family;
  const bindings = importedBindings(source, pkg);
  if (!bindings.size) return false;
  const topLevel = new Set<ts.Node>();
  visitTopLevel(source, node => { topLevel.add(node); });
  const expressApps = new Set<string>();
  if (family === "express") {
    const collect = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isCallExpression(node.initializer)) {
        const expression = node.initializer.expression;
        if (ts.isIdentifier(expression) && ["default", "*", "Router"].includes(bindings.get(expression.text) ?? "")
          || ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)
            && ["default", "*"].includes(bindings.get(expression.expression.text) ?? "") && expression.name.text === "Router")
          expressApps.add(node.name.text);
      }
      ts.forEachChild(node, collect);
    };
    collect(source);
  }
  let found = false;
  const inspect = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && !topLevel.has(node)) {
      if (family === "swagger-express-mw" && ts.isPropertyAccessExpression(node.expression)
        && node.expression.name.text === "create" && ts.isIdentifier(node.expression.expression)
        && ["default", "*"].includes(bindings.get(node.expression.expression.text) ?? "")) found = true;
      if (family === "express") {
        const expression = node.expression;
        if (ts.isIdentifier(expression) && ["default", "*", "Router"].includes(bindings.get(expression.text) ?? "")) found = true;
        if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)
          && ["default", "*"].includes(bindings.get(expression.expression.text) ?? "") && expression.name.text === "Router") found = true;
        if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression) && expressApps.has(expression.expression.text)
          && ["use", "get", "post", "put", "patch", "delete", "options", "head", "all", "route"].includes(expression.name.text)) found = true;
      }
      if (family === "routing-controllers" && ts.isIdentifier(node.expression)
        && importedCanonical(bindings, node.expression.text, ["useExpressServer", "createExpressServer", "useKoaServer", "createKoaServer"])) found = true;
    }
    if (family === "routing-controllers" && ts.isClassDeclaration(node) && !topLevel.has(node))
      for (const decorator of ts.getDecorators(node) ?? []) {
        let expression = decorator.expression; if (ts.isCallExpression(expression)) expression = expression.expression;
        if (ts.isIdentifier(expression) && importedCanonical(bindings, expression.text, ["Controller", "JsonController"])) found = true;
      }
    ts.forEachChild(node, inspect);
  };
  inspect(source);
  return found;
}

function importedCanonical(bindings: Map<string, string>, local: string, allowed: string[]): boolean {
  return allowed.includes(bindings.get(local) ?? "");
}

function controllerRegistration(source: ts.SourceFile): {registrations: Array<{references: ts.Identifier[]; unresolved: boolean; node: ts.Node}>} {
  const bindings = importedBindings(source, "routing-controllers");
  const registrations: Array<{references: ts.Identifier[]; unresolved: boolean; node: ts.Node}> = [];
  if (!bindings.size) return {registrations};
  visitTopLevel(source, node => {
    if (!ts.isCallExpression(node)) return;
    let registration = ts.isIdentifier(node.expression)
      && importedCanonical(bindings, node.expression.text, ["useExpressServer", "createExpressServer", "useKoaServer", "createKoaServer"]);
    if (ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression)
      && ["default", "*"].includes(bindings.get(node.expression.expression.text) ?? ""))
      registration = ["useExpressServer", "createExpressServer", "useKoaServer", "createKoaServer"].includes(node.expression.name.text);
    if (!registration) return;
    let selected: ts.Expression | undefined;
    let controllerPropertyCount = 0;
    for (const argument of node.arguments) if (ts.isObjectLiteralExpression(argument)) {
      for (const property of argument.properties) if (ts.isPropertyAssignment(property)
        && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) && property.name.text === "controllers") {
        controllerPropertyCount++;
        selected = property.initializer;
      }
    }
    const references: ts.Identifier[] = [];
    let unresolved = controllerPropertyCount !== 1 || !selected || !ts.isArrayLiteralExpression(selected);
    if (selected && ts.isArrayLiteralExpression(selected)) for (const item of selected.elements) {
      if (ts.isIdentifier(item)) references.push(item);
      else unresolved = true;
    }
    registrations.push({references, unresolved, node});
  });
  return {registrations};
}

type ControllerIdentity = {path: string; decorator: ts.Decorator};
const isControllerClass = (statement: ts.ClassDeclaration, bindings: Map<string, string>): ts.Decorator | undefined =>
  (ts.getDecorators(statement) ?? []).find(decorator => {
    let expression = decorator.expression;
    if (ts.isCallExpression(expression)) expression = expression.expression;
    return ts.isIdentifier(expression) && importedCanonical(bindings, expression.text, ["Controller", "JsonController"]);
  });

function resolveControllerReference(path: string, localName: string, parsed: Map<string, ts.SourceFile>,
  files: Map<string, string>): ControllerIdentity[] {
  const visited = new Set<string>();
  const importedTarget = (sourcePath: string, local: string): {path: string; name: string} | undefined => {
    const source = parsed.get(sourcePath);
    if (!source) return;
    for (const statement of source.statements) if (ts.isImportDeclaration(statement) && statement.importClause
      && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text.startsWith(".")) {
      const clause = statement.importClause;
      if (clause.isTypeOnly) continue;
      if (clause.name?.text === local) {
        const target = resolveLocal(sourcePath, statement.moduleSpecifier.text, files);
        if (target) return {path: target, name: "default"};
      }
      if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) for (const item of clause.namedBindings.elements)
        if (!item.isTypeOnly && item.name.text === local) {
          const target = resolveLocal(sourcePath, statement.moduleSpecifier.text, files);
          if (target) return {path: target, name: item.propertyName?.text ?? item.name.text};
        }
    }
    return;
  };
  const exported = (targetPath: string, exportName: string): ControllerIdentity[] => {
    const key = `${targetPath}:${exportName}`;
    if (visited.has(key)) return [];
    visited.add(key);
    const source = parsed.get(targetPath);
    if (!source) return [];
    const results: ControllerIdentity[] = [];
    for (const statement of source.statements) {
      if (ts.isClassDeclaration(statement)) {
        const modifiers = ts.getModifiers(statement) ?? [];
        const isDefault = modifiers.some(item => item.kind === ts.SyntaxKind.DefaultKeyword);
        const isExported = modifiers.some(item => item.kind === ts.SyntaxKind.ExportKeyword);
        if ((statement.name?.text === exportName && isExported || isDefault && exportName === "default")) {
          const bindings = importedBindings(source, "routing-controllers");
          const decorator = isControllerClass(statement, bindings);
          if (decorator) results.push({path: targetPath, decorator});
        }
      }
      if (!ts.isExportDeclaration(statement) || !statement.exportClause || !ts.isNamedExports(statement.exportClause)) continue;
      for (const element of statement.exportClause.elements) {
        if (element.name.text !== exportName) continue;
        const local = element.propertyName?.text ?? element.name.text;
        if (statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text.startsWith(".")) {
          const next = resolveLocal(targetPath, statement.moduleSpecifier.text, files);
          if (next) results.push(...exported(next, local));
        } else if (!statement.moduleSpecifier) {
          const direct = source.statements.find(item => ts.isClassDeclaration(item) && item.name?.text === local);
          if (direct && ts.isClassDeclaration(direct)) {
            const decorator = isControllerClass(direct, importedBindings(source, "routing-controllers"));
            if (decorator) results.push({path: targetPath, decorator});
          } else {
            const next = importedTarget(targetPath, local);
            if (next) results.push(...exported(next.path, next.name));
          }
        }
      }
    }
    return results;
  };
  const source = parsed.get(path);
  if (!source) return [];
  const localClass = source.statements.find(item => ts.isClassDeclaration(item) && item.name?.text === localName);
  if (localClass && ts.isClassDeclaration(localClass)) {
    const decorator = isControllerClass(localClass, importedBindings(source, "routing-controllers"));
    if (decorator) return [{path, decorator}];
    return [];
  }
  const target = importedTarget(path, localName);
  return target ? exported(target.path, target.name) : [];
}

function resolveLocal(fromPath: string, specifier: string, files: Map<string, string>): string | undefined {
  const base = resolve(fromPath, "..");
  const candidates = [resolve(base, specifier), ...[".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"]
    .map(extension => resolve(base, `${specifier}${extension}`)),
    ...["index.ts", "index.tsx", "index.js", "index.jsx"].map(name => resolve(base, specifier, name))];
  return candidates.find(path => files.has(path));
}

/** Bounded advisory inventory. It reads no package tree, executes no service code, and emits no routes/profile selection. */
export async function inventoryNodeService(options: InventoryOptions): Promise<NodeServiceInventory> {
  const maxFiles = options.limits?.maxFiles ?? 2_000;
  const maxEntrypoints = options.limits?.maxEntrypoints ?? 16;
  const maxDocuments = options.limits?.maxDocuments ?? 16;
  const maxGraphFiles = options.limits?.maxGraphFiles ?? 1_000;
  const maxImportEdges = options.limits?.maxImportEdges ?? 4_000;
  const entrypoints = [...new Set(options.entrypoints)].sort();
  const documents = [...new Set(options.authoritativeDocumentPaths ?? [])].sort();
  const limits = {maxFiles, maxEntrypoints, maxDocuments, maxGraphFiles, maxImportEdges};
  const ceilings = {maxFiles: 2_000, maxEntrypoints: 16, maxDocuments: 16, maxGraphFiles: 1_000, maxImportEdges: 4_000};
  if (!normalizedPath(options.serviceRoot) || (!entrypoints.length && !documents.length) || entrypoints.length > maxEntrypoints
    || Object.entries(limits).some(([key, value]) => !Number.isSafeInteger(value) || value < 1
      || value > ceilings[key as keyof typeof ceilings])
    || entrypoints.some(path => !normalizedPath(path) || !sourceFile(path) || nonProductionEntrypoint(path))
    || documents.length > maxDocuments || documents.some(path => !normalizedPath(path) || !/\.(?:json|ya?ml)$/.test(path)))
    throw new Error("Inventory selection rejected");
  let directoryCount = 0;
  const budget = () => { if (++directoryCount > 10_000) throw new Error("directory limit"); };
  const tree = await readServiceTree(resolve(options.projectRoot), options.serviceRoot, maxFiles, budget);
  const root = tree.root;
  const diagnostics = new Set<string>();
  const visited = new Set<string>();
  const queue = entrypoints.map(path => resolve(root, path));
  const parsedSources = new Map<string, ts.SourceFile>();
  let importEdges = 0;
  let astNodes = 0;
  let stopGraph = false;
  const sourceEvidence = new Map<InventoryFamily, InventoryEvidence[]>();
  const evidenceFor = (family: InventoryFamily, path: string, node: ts.Node): void => {
    const text = tree.files.get(path)!;
    const items = sourceEvidence.get(family) ?? [];
    const pointer = `span:${node.getStart()}:${node.getEnd()}`;
    if (!items.some(item => item.path === relativePath(root, path) && item.pointer === pointer)) items.push({
      path: relativePath(root, path), pointer, digest: `sha256:${hash(text)}`, kind: "source_registration"});
    sourceEvidence.set(family, items);
  };
  while (queue.length && !stopGraph) {
    const path = queue.shift()!;
    if (visited.has(path)) continue;
    if (visited.size >= maxGraphFiles) {
      diagnostic(diagnostics, "production_import_graph_limit_exceeded");
      stopGraph = true;
      queue.length = 0;
      break;
    }
    visited.add(path);
    const text = tree.files.get(path);
    if (!text || !sourceFile(path)) { diagnostic(diagnostics, "entrypoint_or_import_unresolved"); continue; }
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
    parsedSources.set(path, source);
    if (((source as ts.SourceFile & {parseDiagnostics?: readonly ts.Diagnostic[]}).parseDiagnostics ?? []).length) {
      diagnostic(diagnostics, "production_source_parse_unresolved"); continue;
    }
    const visitNodes = (node: ts.Node): void => { if (++astNodes > 100_000) throw new Error("node limit"); ts.forEachChild(node, visitNodes); };
    try { visitNodes(source); } catch { diagnostic(diagnostics, "production_source_node_limit_exceeded"); break; }
    for (const specifier of localImports(source, diagnostics)) {
      if (++importEdges > maxImportEdges) {
        diagnostic(diagnostics, "production_import_edge_limit_exceeded");
        stopGraph = true;
        queue.length = 0;
        break;
      }
      const imported = resolveLocal(path, specifier, tree.files);
      if (imported) queue.push(imported);
      else diagnostic(diagnostics, "production_import_unresolved");
    }
    for (const family of ["express", "swagger-express-mw"] as const) if (hasRegistration(source, family)) {
      const evidenceNodes: ts.Node[] = [];
      const pkg = family === "express" ? "express" : "swagger-express-mw";
      const bindings = importedBindings(source, pkg);
      const registeredApps = new Set<string>();
      if (family === "express") {
        const collectApps = (node: ts.Node): void => {
          if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
            && ts.isVariableDeclarationList(node.parent) && (node.parent.flags & ts.NodeFlags.Const)
            && ts.isCallExpression(node.initializer) && (ts.isIdentifier(node.initializer.expression)
              && ["default", "*", "Router"].includes(bindings.get(node.initializer.expression.text) ?? "")
              || ts.isPropertyAccessExpression(node.initializer.expression) && ts.isIdentifier(node.initializer.expression.expression)
                && ["default", "*"].includes(bindings.get(node.initializer.expression.expression.text) ?? "")
                && node.initializer.expression.name.text === "Router"))
            registeredApps.add(node.name.text);
          ts.forEachChild(node, collectApps);
        };
        collectApps(source);
      }
      const find = (node: ts.Node): void => {
        if (ts.isCallExpression(node)) {
          if (family === "express" && bindings.size && (ts.isIdentifier(node.expression)
            && ["default", "*", "Router"].includes(bindings.get(node.expression.text) ?? "")
            || ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression)
              && ["default", "*"].includes(bindings.get(node.expression.expression.text) ?? "")
              && node.expression.name.text === "Router")) evidenceNodes.push(node);
          if (family === "swagger-express-mw" && ts.isPropertyAccessExpression(node.expression)
            && node.expression.name.text === "create" && ts.isIdentifier(node.expression.expression)
            && ["default", "*"].includes(bindings.get(node.expression.expression.text) ?? "")) evidenceNodes.push(node);
          if (family === "express" && ts.isPropertyAccessExpression(node.expression)
            && ["use", "get", "post", "put", "patch", "delete", "options", "head", "all", "route"].includes(node.expression.name.text)
            && ts.isIdentifier(node.expression.expression) && registeredApps.has(node.expression.expression.text)) evidenceNodes.push(node);
        }
      };
      visitTopLevel(source, find);
      for (const node of evidenceNodes) evidenceFor(family, path, node);
    }
    if ((["express", "swagger-express-mw", "routing-controllers"] as const)
      .some(family => hasNestedFrameworkRegistration(source, family)))
      diagnostic(diagnostics, "non_top_level_framework_registration_unresolved");
  }

  const controllerRegistrations: Array<{path: string; registrations: Array<{references: ts.Identifier[]; unresolved: boolean; node: ts.Node}>}> = [];
  for (const [path, source] of parsedSources) {
    const registration = controllerRegistration(source);
    controllerRegistrations.push({path, registrations: registration.registrations});
  }
  for (const {path, registrations} of controllerRegistrations) for (const registration of registrations) {
    let resolvedAtLeastOne = false;
    if (registration.unresolved) diagnostic(diagnostics, "routing_controllers_selection_unresolved");
    for (const reference of registration.references) {
      const definitions = resolveControllerReference(path, reference.text, parsedSources, tree.files);
      if (definitions.length === 1) {
        resolvedAtLeastOne = true;
        evidenceFor("routing-controllers", definitions[0]!.path, definitions[0]!.decorator);
      } else diagnostic(diagnostics, "routing_controllers_selection_unresolved");
    }
    if (resolvedAtLeastOne) evidenceFor("routing-controllers", path, registration.node);
  }

  const signals: InventorySignal[] = [];
  const sourceFamilies: Array<["express" | "swagger-express-mw" | "routing-controllers", InventoryFamily]> = [
    ["express", "express"], ["swagger-express-mw", "swagger-express-mw"], ["routing-controllers", "routing-controllers"]];
  for (const [family, key] of sourceFamilies) {
    const evidence = sourceEvidence.get(key) ?? [];
    if (evidence.length) signals.push({family, classification: "supported", evidence: evidence.sort((a,b) => `${a.path}:${a.pointer}`.localeCompare(`${b.path}:${b.pointer}`)),
      limitations: ["advisory registration evidence only; startup reachability and effective runtime routing are unverified"]});
  }

  for (const documentPath of documents) {
    try {
      const selected = await readSelectedDocument(resolve(options.projectRoot), options.serviceRoot,
        options.serviceRoot === "." ? documentPath : `${options.serviceRoot}/${documentPath}`, 2_000_000);
      let value: unknown;
      try { value = documentPath.endsWith(".json") ? parseStrictJson(selected.text) : parseStrictYaml(selected.text); }
      catch { diagnostic(diagnostics, "selected_api_document_invalid"); signals.push({family: "api-document", classification: "unresolved",
        evidence: [{path: documentPath, pointer: "/", digest: selected.digest, kind: "selected_api_document"}], limitations: ["selected document could not be parsed"]}); continue; }
      const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
      if (record?.swagger === "2.0" && validApiDocument(record)) signals.push({family: "swagger2", classification: "supported",
        evidence: [{path: documentPath, pointer: "/swagger", digest: selected.digest, kind: "selected_api_document"}],
        limitations: ["document dialect is supported by a separate bounded analyzer; inventory does not analyze operations"]});
      else if (typeof record?.openapi === "string" && /^3\.0\.\d+$/.test(record.openapi) && validApiDocument(record)) signals.push({family: "openapi3", classification: "supported",
        evidence: [{path: documentPath, pointer: "/openapi", digest: selected.digest, kind: "selected_api_document"}],
        limitations: ["bounded OpenAPI 3.0 document adapter is available; application runtime binding remains unverified"]});
      else if (typeof record?.openapi === "string" && /^3\.\d+\.\d+$/.test(record.openapi) && validApiDocument(record)) signals.push({family: "openapi3", classification: "unsupported",
        evidence: [{path: documentPath, pointer: "/openapi", digest: selected.digest, kind: "selected_api_document"}],
        limitations: ["bounded document adapter supports OpenAPI 3.0.x; this OpenAPI version is outside its scope"]});
      else { diagnostic(diagnostics, "selected_api_document_dialect_unresolved"); signals.push({family: "api-document", classification: "unresolved",
        evidence: [{path: documentPath, pointer: "/", digest: selected.digest, kind: "selected_api_document"}], limitations: ["selected document dialect is unrecognized"]}); }
    } catch {
      diagnostic(diagnostics, "selected_api_document_unavailable");
      signals.push({family: "api-document", classification: "unresolved",
        evidence: [{path: documentPath, pointer: "/", digest: `sha256:${hash(documentPath)}`, kind: "selected_api_document"}],
        limitations: ["selected document is unavailable within the service boundary"]});
    }
  }
  if (diagnostics.size) signals.push({family: "api-document", classification: "unresolved", evidence: [], limitations: [...diagnostics].sort()});
  const families = new Set(signals.filter(signal => signal.classification !== "unresolved").map(signal => signal.family));
  const classification: InventoryClassification = families.size > 1 ? "mixed"
    : diagnostics.size || !signals.length ? "unresolved"
      : signals.some(signal => signal.classification === "unsupported") ? "unsupported" : "supported";
  const sourceDigest = digestServiceTree(tree.files, tree.root, tree.opaqueConfiguration);
  const fingerprint = `sha256:${hash(JSON.stringify({version: "nodejs-inventory-2", serviceRoot: options.serviceRoot,
    entrypoints, authoritativeDocumentPaths: documents, limits: {maxFiles, maxEntrypoints, maxDocuments, maxGraphFiles, maxImportEdges},
    sourceDigest, signals, diagnostics: [...diagnostics].sort()}))}`;
  return {classification, signals, diagnostics: [...diagnostics].sort(), fingerprint,
    source_digest: sourceDigest, scanned_source_files: visited.size, scanned_documents: documents.length};
}
