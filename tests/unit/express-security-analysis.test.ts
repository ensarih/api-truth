import ts from "typescript";
import {expect, test} from "vitest";
import {API_KEY_GUARD_POLICY, proveStaticApiKeyGuard} from "../../analyzers/typescript/src/security-analysis.js";

const functionFrom = (source: string): ts.FunctionLikeDeclaration => {
  const file = ts.createSourceFile("security.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let found: ts.FunctionLikeDeclaration | undefined;
  const visit = (node: ts.Node) => {
    if (!found && (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node)))
      found = node;
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (!found) throw new Error("Test fixture has no function");
  return found;
};
const exact = (name = "X-API-Key", token = "synthetic-secret") => `
  export const requireApiToken = (request: unknown, response: unknown, next: unknown) => {
    if (request.get("${name}") !== "${token}") return response.status(401).end();
    next();
  };
`;

test("proves only an exact rejecting API-key guard and omits its secret", () => {
  const proof = proveStaticApiKeyGuard(functionFrom(exact()));
  expect(API_KEY_GUARD_POLICY).toBe("express-static-api-key-1");
  expect(proof).toEqual({headerName: "x-api-key"});
  expect(JSON.stringify(proof)).not.toContain("synthetic-secret");
  expect(proveStaticApiKeyGuard(functionFrom(`function guard(req, res, next) {
    if (req.get('X-Auth-Token') !== 'another-secret') { return res.status(401).end(); }
    next();
  }`))).toEqual({headerName: "x-auth-token"});
});

test.each([
  ["no-op named guard", `const requireApiToken = (_req, _res, next) => next();`],
  ["opaque validator", `const requireApiToken = (req, res, next) => { if (!isValid(req)) return res.status(401).end(); next(); };`],
  ["missing return", `const guard = (req, res, next) => { if (req.get('X-API-Key') !== 'secret') res.status(401).end(); next(); };`],
  ["wrong status", `const guard = (req, res, next) => { if (req.get('X-API-Key') !== 'secret') return res.status(200).end(); next(); };`],
  ["wrong response method", `const guard = (req, res, next) => { if (req.get('X-API-Key') !== 'secret') return res.status(401).json({}); next(); };`],
  ["empty secret", exact("X-API-Key", "")],
  ["conditional success", `const guard = (req, res, next) => { if (req.get('X-API-Key') !== 'secret') return res.status(401).end(); if (ready) next(); };`],
  ["extra bypass statement", `const guard = (req, res, next) => { next(); if (req.get('X-API-Key') !== 'secret') return res.status(401).end(); next(); };`],
  ["else branch", `const guard = (req, res, next) => { if (req.get('X-API-Key') !== 'secret') return res.status(401).end(); else next(); next(); };`],
  ["matching condition accepts unauthorized", `const guard = (req, res, next) => { if (req.get('X-API-Key') === 'secret') return res.status(401).end(); next(); };`],
  ["dynamic expected token", `const guard = (req, res, next) => { if (req.get('X-API-Key') !== process.env.API_TOKEN) return res.status(401).end(); next(); };`],
  ["dynamic header", `const guard = (req, res, next) => { if (req.get(header) !== 'secret') return res.status(401).end(); next(); };`],
  ["next with control argument", `const guard = (req, res, next) => { if (req.get('X-API-Key') !== 'secret') return res.status(401).end(); next('route'); };`],
  ["async guard", `const guard = async (req, res, next) => { if (req.get('X-API-Key') !== 'secret') return res.status(401).end(); next(); };`],
  ["unusual header", `const guard = (req, res, next) => { if (req.get('X-${'${name}'}) !== 'secret') return res.status(401).end(); next(); };`],
  ["reserved authorization header", exact("Authorization")],
  ["invalid header field name", exact("X API Key")],
  ["destructured request binding", `const guard = ({get}, res, next) => { if (get('X-API-Key') !== 'secret') return res.status(401).end(); next(); };`],
  ["rest callback parameter", `const guard = (req, res, ...next) => { if (req.get('X-API-Key') !== 'secret') return res.status(401).end(); next(); };`],
  ["default callback parameter", `const guard = (req, res, next = () => {}) => { if (req.get('X-API-Key') !== 'secret') return res.status(401).end(); next(); };`],
  ["optional callback parameter", `const guard = (req, res, next?) => { if (req.get('X-API-Key') !== 'secret') return res.status(401).end(); next(); };`],
  ["reused parameter binding", `const guard = (req, res, req) => { if (req.get('X-API-Key') !== 'secret') return res.status(401).end(); req(); };`],
  ["optional request lookup", `const guard = (req, res, next) => { if (req?.get('X-API-Key') !== 'secret') return res.status(401).end(); next(); };`],
  ["optional request call", `const guard = (req, res, next) => { if (req.get?.('X-API-Key') !== 'secret') return res.status(401).end(); next(); };`],
  ["optional rejection", `const guard = (req, res, next) => { if (req.get('X-API-Key') !== 'secret') return res?.status(401).end(); next(); };`],
  ["rejection sends a body", `const guard = (req, res, next) => { if (req.get('X-API-Key') !== 'secret') return res.status(401).end('secret'); next(); };`],
  ["generator middleware", `function* guard(req, res, next) { if (req.get('X-API-Key') !== 'secret') return res.status(401).end(); next(); }`],
] as const)("does not infer security from %s", (_name, source) => {
  expect(proveStaticApiKeyGuard(functionFrom(source))).toBeUndefined();
});
