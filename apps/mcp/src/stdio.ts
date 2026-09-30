import { serveStdio, type StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import { createApiTruthMcpServer, type ApiTruthMcpOptions } from "./server.js";

/** Starts the official MCP stdio transport. The embedding host supplies authentication and query access. */
export const serveApiTruthMcpStdio = (options: ApiTruthMcpOptions): StdioServerHandle =>
  serveStdio(() => createApiTruthMcpServer(options));
