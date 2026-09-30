import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { QueryReader } from "@api-truth/query";

export type PortalPrincipal = Readonly<{ tenantId: string; principalId: string }>;
export type PortalOptions = Readonly<{
  authenticate(request: IncomingMessage): Promise<PortalPrincipal | undefined>;
  query: Pick<QueryReader, "searchServices">;
}>;

const page = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>API Truth</title><link rel="stylesheet" href="/style.css"></head>
<body><main><h1>API Truth</h1><p>Browse the APIs available to you.</p>
<form id="search"><label>Service <input name="query" maxlength="128" autocomplete="off"></label>
<label>Environment <input name="environment" maxlength="512" placeholder="e.g. uat"></label>
<button type="submit">Search</button></form><p id="status" role="status"></p><ul id="results"></ul></main>
<script src="/app.js" defer></script></body></html>`;
const script = `const form=document.getElementById('search');
const status=document.getElementById('status');
const results=document.getElementById('results');
form.addEventListener('submit',async event=>{event.preventDefault();results.replaceChildren();status.textContent='Loading…';
  const data=new FormData(form);const params=new URLSearchParams({query:String(data.get('query')||''),limit:'20'});
  const environment=String(data.get('environment')||'').trim();if(environment)params.set('environment',environment);
  try{const response=await fetch('/api/services?'+params.toString(),{credentials:'same-origin'});
    if(!response.ok){status.textContent='The service list is unavailable.';return;}
    const body=await response.json();status.textContent=body.services.length?'Results':'No matching services in this scope.';
    for(const service of body.services){const row=document.createElement('li');
      row.textContent=service.repositoryId+' / '+service.serviceId+
        (service.environment?' — '+service.environment.name+': '+service.environment.status:'');results.append(row);}
  }catch{status.textContent='The service list is unavailable.';}});`;
const style = `:root{font-family:system-ui,sans-serif;color:#17212b;background:#f7f9fb}main{max-width:48rem;margin:3rem auto;padding:1.5rem;background:white;border:1px solid #dce3e9;border-radius:.75rem}form{display:flex;flex-wrap:wrap;gap:1rem;align-items:end}label{display:grid;gap:.35rem}input,button{font:inherit;padding:.55rem .7rem}button{cursor:pointer}li{padding:.45rem 0}`;

const safeId = (value: unknown): value is string => typeof value === "string"
  && /^[^\u0000-\u001f\u007f]{1,512}$/.test(value);
const send = (response: ServerResponse, status: number, body: string, contentType: string): void => {
  response.writeHead(status, { "content-type": contentType, "cache-control": "no-store",
    "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
    "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'" });
  response.end(body);
};
const json = (response: ServerResponse, status: number, body: unknown): void =>
  send(response, status, JSON.stringify(body), "application/json; charset=utf-8");
const validSearch = (url: URL): { query: string; limit: number; environment?: string } | undefined => {
  const params = url.searchParams;
  if ([...params.keys()].some((key) => !["query", "limit", "environment"].includes(key))
    || ["query", "limit", "environment"].some((key) => params.getAll(key).length > 1)) return undefined;
  const query = params.get("query") ?? "";
  const limitText = params.get("limit") ?? "20";
  const environment = params.get("environment");
  if (query.length > 128 || /[\u0000-\u001f\u007f]/.test(query)
    || !/^(?:[1-9]|[1-4][0-9]|50)$/.test(limitText)
    || environment !== null && !safeId(environment)) return undefined;
  return { query, limit: Number(limitText), ...(environment === null ? {} : { environment }) };
};

/** The host must supply authentication; no request header is treated as a principal by this package. */
export const createPortalServer = (options: PortalOptions): Server => {
  if (!options || typeof options.authenticate !== "function" || typeof options.query?.searchServices !== "function")
    throw new Error("PORTAL_HOST_REQUIRED");
  return createServer(async (request, response) => {
    let principal: PortalPrincipal | undefined;
    try { principal = await options.authenticate(request); } catch { /* Fail closed. */ }
    if (!principal || !safeId(principal.tenantId) || !safeId(principal.principalId)) {
      json(response, 401, { error: "NOT_AUTHORIZED" }); return;
    }
    if (request.method !== "GET" || !request.url || request.url.length > 2048) {
      json(response, 400, { error: "INVALID_REQUEST" }); return;
    }
    let url: URL;
    try { url = new URL(request.url, "http://localhost"); } catch {
      json(response, 400, { error: "INVALID_REQUEST" }); return;
    }
    if (url.pathname === "/") { send(response, 200, page, "text/html; charset=utf-8"); return; }
    if (url.pathname === "/app.js") { send(response, 200, script, "text/javascript; charset=utf-8"); return; }
    if (url.pathname === "/style.css") { send(response, 200, style, "text/css; charset=utf-8"); return; }
    if (url.pathname !== "/api/services") { json(response, 404, { error: "NOT_FOUND" }); return; }
    const search = validSearch(url);
    if (!search) { json(response, 400, { error: "INVALID_REQUEST" }); return; }
    try {
      const result = await options.query.searchServices(principal,
        { tenantId: principal.tenantId, ...search });
      json(response, 200, result);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error
        && error.code === "QUERY_RESULT_LIMIT_EXCEEDED") json(response, 422, { error: "RESULT_LIMIT_EXCEEDED" });
      else json(response, 503, { error: "QUERY_UNAVAILABLE" });
    }
  });
};
