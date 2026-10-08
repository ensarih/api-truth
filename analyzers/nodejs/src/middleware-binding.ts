import { dirname, relative } from "node:path";
import ts from "typescript";

export type MiddlewareBinding = { path: string; line: number; span: string; mock_mode?: {value: boolean; pointer: string} };
const literal = (node: ts.Node | undefined): string | undefined =>
  node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined;
const topLevelRequire = (node: ts.Node | undefined, packageName: string): boolean =>
  !!node && ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "require"
  && node.arguments.length === 1 && literal(node.arguments[0]) === packageName;
const key = (property: ts.ObjectLiteralElementLike): string | undefined => property.name
  && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) ? property.name.text : undefined;

/** The first profile proves only a direct root entrypoint and default-file registration. */
export function findSwaggerMiddlewareBinding(files: Map<string, string>, root: string): MiddlewareBinding | undefined {
  const matches: MiddlewareBinding[] = [];
  let createSites = 0;
  for (const [path, text] of files) {
    if (dirname(path) !== root || !/\.[cm]?[jt]s$/.test(path)) continue;
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
    if (((source as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? []).length) continue;
    const swaggerNames = new Set<string>();
    const expressNames = new Set<string>();
    let shadowsRequire = false;
    for (const statement of source.statements) {
      if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) continue;
        if (declaration.name.text === "require") shadowsRequire = true;
        if (!(statement.declarationList.flags & ts.NodeFlags.Const)) continue;
        if (topLevelRequire(declaration.initializer, "swagger-express-mw")) swaggerNames.add(declaration.name.text);
        if (topLevelRequire(declaration.initializer, "express")) expressNames.add(declaration.name.text);
      }
      if (ts.isImportDeclaration(statement) && literal(statement.moduleSpecifier) === "swagger-express-mw") {
        const clause = statement.importClause;
        if (clause?.name) swaggerNames.add(clause.name.text);
        if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) swaggerNames.add(clause.namedBindings.name.text);
      }
      if (ts.isImportDeclaration(statement) && literal(statement.moduleSpecifier) === "express") {
        const clause = statement.importClause;
        if (clause?.name) expressNames.add(clause.name.text);
        if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) expressNames.add(clause.namedBindings.name.text);
      }
    }
    if (shadowsRequire) continue;
    const appNames = new Set<string>();
    for (const statement of source.statements) if (ts.isVariableStatement(statement))
      for (const declaration of statement.declarationList.declarations) {
        const initializer = declaration.initializer;
        if ((statement.declarationList.flags & ts.NodeFlags.Const) && ts.isIdentifier(declaration.name)
          && initializer && ts.isCallExpression(initializer)
          && ts.isIdentifier(initializer.expression) && expressNames.has(initializer.expression.text)
          && initializer.arguments.length === 0) appNames.add(declaration.name.text);
      }
    for (const statement of source.statements) {
      if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) continue;
      const create = statement.expression;
      if (!ts.isPropertyAccessExpression(create.expression) || create.expression.name.text !== "create"
        || !ts.isIdentifier(create.expression.expression) || !swaggerNames.has(create.expression.expression.text)
        ) continue;
      createSites++;
      if (create.arguments.length !== 2) continue;
      const config = create.arguments[0];
      const callback = create.arguments[1];
      if (!config || !callback || !ts.isObjectLiteralExpression(config) || config.properties.length > 2
        || config.properties.some(property => !ts.isPropertyAssignment(property))
        || !(ts.isFunctionExpression(callback) || ts.isArrowFunction(callback))
        || !ts.isBlock(callback.body) || callback.parameters.length < 2
        || !ts.isIdentifier(callback.parameters[1]!.name)) continue;
      const properties = config.properties as ts.NodeArray<ts.PropertyAssignment>;
      const keys = properties.map(key);
      if (new Set(keys).size !== keys.length || keys.some(name => name !== "appRoot" && name !== "mockMode")) continue;
      const appRoot = properties.find(property => key(property) === "appRoot")?.initializer;
      if (!appRoot || !ts.isIdentifier(appRoot) || appRoot.text !== "__dirname") continue;
      const mock = properties.find(property => key(property) === "mockMode");
      if (mock && ![ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword].includes(mock.initializer.kind)) continue;
      const parameterNames = callback.parameters.map(item => ts.isIdentifier(item.name) ? item.name.text : undefined);
      if (parameterNames.some(name => name === undefined) || new Set(parameterNames).size !== parameterNames.length) continue;
      const middlewareName = callback.parameters[1]!.name.text;
      const shadowed = callback.parameters.some((parameter, index) => index !== 1
        && ts.isIdentifier(parameter.name) && appNames.has(parameter.name.text));
      let assigned = false;
      const inspect = (node: ts.Node): void => {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
          && (node.name.text === middlewareName || appNames.has(node.name.text))) assigned = true;
        if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
          && ts.isIdentifier(node.left) && (node.left.text === middlewareName || appNames.has(node.left.text))) assigned = true;
        ts.forEachChild(node, inspect);
      };
      callback.body.statements.forEach(inspect);
      if (shadowed || assigned) continue;
      const registrationIndex = callback.body.statements.findIndex(bodyStatement => {
        if (!ts.isExpressionStatement(bodyStatement) || !ts.isCallExpression(bodyStatement.expression)) return false;
        const call = bodyStatement.expression;
        return ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === "register"
          && ts.isIdentifier(call.expression.expression) && call.expression.expression.text === middlewareName
          && call.arguments.length === 1 && ts.isIdentifier(call.arguments[0]!) && appNames.has(call.arguments[0]!.text);
      });
      const firstParameter = callback.parameters[0];
      const errorName = firstParameter && ts.isIdentifier(firstParameter.name) ? firstParameter.name.text : undefined;
      const errorGuard = (item: ts.Statement): boolean => {
        if (!errorName || !ts.isIfStatement(item) || item.elseStatement
          || !ts.isIdentifier(item.expression) || item.expression.text !== errorName) return false;
        const body = ts.isBlock(item.thenStatement) ? item.thenStatement.statements : [item.thenStatement];
        return body.length === 1 && ts.isThrowStatement(body[0]!)
          && ts.isIdentifier(body[0]!.expression) && body[0]!.expression.text === errorName;
      };
      if (registrationIndex < 0 || callback.body.statements.slice(0, registrationIndex)
        .some(item => !errorGuard(item))) continue;
      matches.push({ path: relative(root, path).replaceAll("\\", "/"),
        line: source.getLineAndCharacterOfPosition(create.getStart()).line + 1,
        span: `span:${create.getStart()}:${create.getEnd()}`,
        ...(mock ? {mock_mode: {value: mock.initializer.kind === ts.SyntaxKind.TrueKeyword,
          pointer: `span:${mock.getStart()}:${mock.getEnd()}`}} : {}) });
    }
  }
  return matches.length === 1 && createSites === 1 ? matches[0] : undefined;
}
