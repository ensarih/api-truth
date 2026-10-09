import ts from "typescript";

/** A deliberately narrow, versioned proof of an Express header API-key guard. */
export const API_KEY_GUARD_POLICY = "express-static-api-key-1";

export interface StaticApiKeyGuardProof {
  /** Lowercase HTTP field name. The expected key is never returned. */
  readonly headerName: string;
}

const simpleCall = (node: ts.Node): node is ts.CallExpression =>
  ts.isCallExpression(node) && node.questionDotToken === undefined;

const simpleProperty = (node: ts.Node, name: string): node is ts.PropertyAccessExpression =>
  ts.isPropertyAccessExpression(node) && node.questionDotToken === undefined && node.name.text === name;

const simpleParameterName = (parameter: ts.ParameterDeclaration): string | undefined => {
  if (!ts.isIdentifier(parameter.name) || parameter.dotDotDotToken || parameter.questionToken || parameter.initializer)
    return undefined;
  return parameter.name.text;
};

const staticString = (node: ts.Node): string | undefined =>
  ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : undefined;

const isRejectingReturn = (statement: ts.Statement, responseName: string): boolean => {
  const only = ts.isBlock(statement)
    ? statement.statements.length === 1 ? statement.statements[0] : undefined
    : statement;
  if (!only || !ts.isReturnStatement(only) || !only.expression || !simpleCall(only.expression)) return false;

  const end = only.expression;
  if (end.arguments.length !== 0 || !simpleProperty(end.expression, "end")) return false;
  const status = end.expression.expression;
  if (!simpleCall(status) || status.arguments.length !== 1 || !simpleProperty(status.expression, "status")) return false;
  if (!ts.isNumericLiteral(status.arguments[0]!) || status.arguments[0]!.text !== "401") return false;
  const response = status.expression.expression;
  return ts.isIdentifier(response) && response.text === responseName;
};

/**
 * Accepts only: `if (req.get("Header") !== "nonempty key") return res.status(401).end(); next();`
 * The caller must resolve the middleware binding and verify its registration path.
 */
export const proveStaticApiKeyGuard = (fn: ts.FunctionLikeDeclaration): StaticApiKeyGuardProof | undefined => {
  if (!(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn) || ts.isFunctionDeclaration(fn))) return undefined;
  if (fn.asteriskToken || ts.getModifiers(fn)?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword))
    return undefined;
  if (fn.parameters.length !== 3 || !fn.body || !ts.isBlock(fn.body)) return undefined;

  const names = fn.parameters.map(simpleParameterName);
  if (names.some(name => name === undefined) || new Set(names).size !== 3) return undefined;
  const [requestName, responseName, nextName] = names as [string, string, string];

  const statements = fn.body.statements;
  if (statements.length !== 2) return undefined;
  const [guard, continuation] = statements;
  if (!guard || !ts.isIfStatement(guard) || guard.elseStatement) return undefined;
  if (!continuation || !ts.isExpressionStatement(continuation) || !simpleCall(continuation.expression))
    return undefined;
  const next = continuation.expression;
  if (next.arguments.length !== 0 || !ts.isIdentifier(next.expression) || next.expression.text !== nextName)
    return undefined;
  if (!isRejectingReturn(guard.thenStatement, responseName)) return undefined;

  const condition = guard.expression;
  if (!ts.isBinaryExpression(condition) || condition.operatorToken.kind !== ts.SyntaxKind.ExclamationEqualsEqualsToken)
    return undefined;
  const expectedKey = staticString(condition.right);
  if (!expectedKey?.trim()) return undefined;
  if (!simpleCall(condition.left) || condition.left.arguments.length !== 1) return undefined;
  const lookup = condition.left;
  if (!simpleProperty(lookup.expression, "get")) return undefined;
  const request = lookup.expression.expression;
  if (!ts.isIdentifier(request) || request.text !== requestName) return undefined;
  const headerName = staticString(lookup.arguments[0]!);
  if (!headerName || !/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(headerName)) return undefined;
  const normalized = headerName.toLowerCase();
  if (normalized === "authorization" || normalized === "proxy-authorization") return undefined;
  return {headerName: normalized};
};
