import { relative, resolve } from "node:path";
import ts from "typescript";
import type { MiddlewareBinding } from "./middleware-binding.js";
import type { ConfigurationLocation } from "./routing-config.js";
import { parseStrictJson } from "./strict-json.js";

export type EnvironmentInput = {
  variable: string; operation: "read" | "write" | "opaque";
  location: {path: string; pointer: string; line: number};
};
export type StartupResolution = {
  kind: "declared"; entrypoint: string; node_version: "22.19.0"; environment_name?: string;
  evidence_locations: ConfigurationLocation[]; environment_inputs: EnvironmentInput[];
} | {kind: "unresolved"; evidence_locations: ConfigurationLocation[]; environment_inputs: EnvironmentInput[]};
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const known = new Set(["NODE_ENV", "NODE_CONFIG", "NODE_CONFIG_DIR", "NODE_CONFIG_ENV", "NODE_APP_INSTANCE",
  "NODE_CONFIG_STRICT_MODE", "NODE_OPTIONS", "NODE_PATH", "swagger_mockMode", "swagger_controllersDirs",
  "swagger_mockControllersDirs", "swagger_swaggerControllerPipe", "swagger_defaultPipe", "swagger_fittingsDirs"]);
const variableName = (name: string): string => known.has(name) ? name
  : name.startsWith("swagger_") ? "swagger_*" : name.startsWith("NODE_CONFIG_") ? "NODE_CONFIG_*" : "unknown";
const literal = (node: ts.Node | undefined): string | undefined => node
  && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined;
const envAccess = (node: ts.Node): boolean => (ts.isPropertyAccessExpression(node) && node.name.text === "env"
  || ts.isElementAccessExpression(node) && literal(node.argumentExpression) === "env")
  && ts.isIdentifier(node.expression) && node.expression.text === "process";

/** Syntactic declarations and environment hazards only; this never executes startup or reads host environment. */
export function resolveSwaggerStartup(files: Map<string, string>, root: string, binding: MiddlewareBinding | undefined,
  budget: () => void = () => {}): StartupResolution {
  const environment_inputs: EnvironmentInput[] = [];
  let nodes = 0;
  for (const [absolute, text] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    if (!/\.[cm]?[jt]sx?$/.test(absolute)) continue;
    budget();
    const path = relative(root, absolute).replaceAll("\\", "/");
    const opaque = () => environment_inputs.push({variable: "unknown", operation: "opaque",
      location: {path, pointer: "/", line: 1}});
    if (Buffer.byteLength(text) > 1_000_000) { opaque(); continue; }
    const source = ts.createSourceFile(absolute, text, ts.ScriptTarget.Latest, true);
    if (((source as ts.SourceFile & {parseDiagnostics?: readonly ts.Diagnostic[]}).parseDiagnostics ?? []).length) {
      opaque(); continue;
    }
    const add = (node: ts.Node, variable: string, operation: EnvironmentInput["operation"]) => {
      environment_inputs.push({variable, operation, location: {path,
        pointer: `span:${node.getStart()}:${node.getEnd()}`, line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1}});
    };
    const stack: ts.Node[] = [source];
    while (stack.length) {
      const node = stack.pop()!;
      if (++nodes > 200_000) { opaque(); break; }
      if (nodes % 512 === 0) budget();
      if (envAccess(node)) {
        const parent = node.parent;
        let name: string | undefined;
        if (ts.isPropertyAccessExpression(parent) && parent.expression === node) name = parent.name.text;
        if (ts.isElementAccessExpression(parent) && parent.expression === node) name = literal(parent.argumentExpression);
        if (name === undefined) add(node, "unknown", "opaque");
        else {
          const variable = variableName(name);
          if (variable) {
            const operationNode = parent.parent;
            const write = ts.isBinaryExpression(operationNode) && operationNode.left === parent
              && operationNode.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && operationNode.operatorToken.kind <= ts.SyntaxKind.LastAssignment
              || ts.isDeleteExpression(operationNode)
              || (ts.isPrefixUnaryExpression(operationNode) || ts.isPostfixUnaryExpression(operationNode))
                && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(operationNode.operator);
            add(parent, variable, write ? "write" : "read");
          }
        }
      } else if (ts.isIdentifier(node) && node.text === "process" && ts.isVariableDeclaration(node.parent)
        && node.parent.initializer === node) add(node, "unknown", "opaque");
      else if (ts.isImportDeclaration(node) && ["process", "node:process"].includes(literal(node.moduleSpecifier) ?? "")
        || ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "require"
          && ["process", "node:process"].includes(literal(node.arguments[0]) ?? "")) add(node, "unknown", "opaque");
      ts.forEachChild(node, child => { stack.push(child); });
    }
    if (nodes > 200_000) break;
  }
  environment_inputs.sort((a, b) => a.location.path.localeCompare(b.location.path)
    || a.location.line - b.location.line || a.location.pointer.localeCompare(b.location.pointer));
  const evidence_locations: ConfigurationLocation[] = [];
  const unresolved = (): StartupResolution => ({kind: "unresolved", evidence_locations, environment_inputs});
  if (!binding) return unresolved();
  try {
    const text = files.get(resolve(root, "package.json"));
    if (!text || Buffer.byteLength(text) > 1_000_000) return unresolved();
    const manifest = parseStrictJson(text);
    if (!object(manifest) || manifest.type !== "commonjs" || !object(manifest.scripts) || !object(manifest.engines)
      || manifest.engines.node !== "22.19.0" || manifest.scripts.prestart !== undefined || manifest.scripts.poststart !== undefined
      || typeof manifest.scripts.start !== "string") return unresolved();
    const match = /^(?:NODE_ENV=(development|test|production|staging|uat) )?node ([A-Za-z0-9_-]+\.(?:js|cjs))$/.exec(manifest.scripts.start);
    if (!match || match[0] !== manifest.scripts.start || match[2] !== binding.path || !files.has(resolve(root, binding.path))) return unresolved();
    evidence_locations.push({path: "package.json", pointer: "/scripts/start"},
      {path: "package.json", pointer: "/type"}, {path: "package.json", pointer: "/engines/node"});
    return {kind: "declared", entrypoint: binding.path, node_version: "22.19.0", ...(match[1] ? {environment_name: match[1]} : {}), evidence_locations, environment_inputs};
  } catch { return unresolved(); }
}
