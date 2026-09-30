import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { QueryReader, QuerySelection, QueryContractResult } from "@api-truth/query";

export type PortalPrincipal = Readonly<{ tenantId: string; principalId: string }>;
export type PortalOptions = Readonly<{
  authenticate(request: IncomingMessage): Promise<PortalPrincipal | undefined>;
  query: Pick<QueryReader, "searchServices" | "readContract" | "compareContracts" | "readPublication">;
}>;

const page = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>API Truth</title><link rel="stylesheet" href="/style.css"></head>
<body><main><h1>API Truth</h1><p>Browse the APIs available to you.</p>
<section><h2>Find a service</h2><form id="search"><label>Service <input name="query" maxlength="128" autocomplete="off"></label>
<label>Environment <input name="environment" maxlength="512" placeholder="e.g. uat"></label>
<button type="submit">Search</button></form><p id="search-status" role="status"></p><ul id="results"></ul></section>
<section><h2>View a contract</h2><form id="contract"><label>Repository <input name="repositoryId" maxlength="512" required></label>
<label>Service <input name="serviceId" maxlength="512" required></label><label>Selection
<select name="kind"><option value="environment">Environment</option><option value="branch">Branch</option>
<option value="revision">Revision</option></select></label>
<label>Name or revision <input name="value" maxlength="512" required placeholder="e.g. uat"></label>
<button type="submit">View contract</button></form><p id="contract-status" role="status"></p>
<div id="contract-summary"></div><ul id="endpoints"></ul><ul id="schemas"></ul><ul id="evidence"></ul>
<a id="download" hidden>Download this published OpenAPI version</a><pre id="detail"></pre></section>
<section><h2>Compare contracts</h2><form id="compare"><label>From
<select name="fromKind"><option value="environment">Environment</option><option value="branch">Branch</option>
<option value="revision">Revision</option></select></label><label>Name or revision <input name="fromValue" maxlength="512" required></label>
<label>To<select name="toKind"><option value="environment">Environment</option><option value="branch">Branch</option>
<option value="revision">Revision</option></select></label><label>Name or revision <input name="toValue" maxlength="512" required></label>
<button type="submit">Compare</button></form><p id="compare-status" role="status"></p><pre id="changes"></pre></section>
</main><script src="/app.js" defer></script></body></html>`;
const script = `const search=document.getElementById('search'),contract=document.getElementById('contract'),compare=document.getElementById('compare');
const status=document.getElementById('search-status'),results=document.getElementById('results');
const contractStatus=document.getElementById('contract-status'),summary=document.getElementById('contract-summary');
const endpoints=document.getElementById('endpoints'),schemas=document.getElementById('schemas'),evidence=document.getElementById('evidence'),detail=document.getElementById('detail');
const download=document.getElementById('download'),compareStatus=document.getElementById('compare-status'),changes=document.getElementById('changes');
const selection=()=>{const data=new FormData(contract);return new URLSearchParams({repositoryId:String(data.get('repositoryId')||''),
  serviceId:String(data.get('serviceId')||''),kind:String(data.get('kind')||''),value:String(data.get('value')||'')});};
const fetchJson=async(path)=>{const response=await fetch(path,{credentials:'same-origin'});if(!response.ok)throw Error('unavailable');return response.json();};
const showDetail=async(path)=>{detail.textContent='Loading…';try{const data=await fetchJson(path);detail.textContent=JSON.stringify(data,null,2);}
  catch{detail.textContent='Details are unavailable.';}};
search.addEventListener('submit',async event=>{event.preventDefault();results.replaceChildren();status.textContent='Loading…';
  const data=new FormData(search),params=new URLSearchParams({query:String(data.get('query')||''),limit:'20'});
  const environment=String(data.get('environment')||'').trim();if(environment)params.set('environment',environment);
  try{const body=await fetchJson('/api/services?'+params);status.textContent=body.services.length?'Results':'No matching services in this scope.';
    for(const service of body.services){const row=document.createElement('li'),button=document.createElement('button');
      button.type='button';button.textContent=service.repositoryId+' / '+service.serviceId+
        (service.environment?' — '+service.environment.name+': '+service.environment.status:'');
      button.addEventListener('click',()=>{contract.elements.namedItem('repositoryId').value=service.repositoryId;
        contract.elements.namedItem('serviceId').value=service.serviceId;
        if(service.environment){contract.elements.namedItem('kind').value='environment';contract.elements.namedItem('value').value=service.environment.name;}});
      row.append(button);results.append(row);}}
  catch{status.textContent='The service list is unavailable.';}});
contract.addEventListener('submit',async event=>{event.preventDefault();summary.replaceChildren();endpoints.replaceChildren();
  schemas.replaceChildren();evidence.replaceChildren();detail.textContent='';download.hidden=true;contractStatus.textContent='Loading…';
  try{const params=selection(),body=await fetchJson('/api/contract?'+params);
    if(body.status!=='resolved'){contractStatus.textContent='Contract state: '+body.status+'. No contract is available here.';return;}
    contractStatus.textContent='Contract available. Analyzed at '+body.analyzedAt+'.';
    const coverage=document.createElement('p');coverage.textContent='Coverage: '+body.coverage.status+'.';summary.append(coverage);
    for(const item of body.endpoints){const row=document.createElement('li'),button=document.createElement('button');
      button.type='button';button.textContent=item.method+' '+item.path;
      button.addEventListener('click',()=>showDetail('/api/endpoint?'+params+'&endpointId='+encodeURIComponent(item.endpointId)));
      row.append(button);endpoints.append(row);}
    for(const id of body.schemas){const row=document.createElement('li'),button=document.createElement('button');
      button.type='button';button.textContent='Schema: '+id;
      button.addEventListener('click',()=>showDetail('/api/schema?'+params+'&schemaId='+encodeURIComponent(id)));
      row.append(button);schemas.append(row);}
    for(const id of body.evidence){const row=document.createElement('li'),button=document.createElement('button');
      button.type='button';button.textContent='Evidence: '+id;
      button.addEventListener('click',()=>showDetail('/api/evidence?'+params+'&evidenceId='+encodeURIComponent(id)));
      row.append(button);evidence.append(row);}
    if(body.publication.status==='current'){download.href='/api/openapi/'+encodeURIComponent(body.publication.publicationId)+
      '?repositoryId='+encodeURIComponent(params.get('repositoryId'))+'&serviceId='+encodeURIComponent(params.get('serviceId'));
      download.hidden=false;download.textContent='Download published OpenAPI version '+body.publication.publicationId.slice(7,19);}}
  catch{contractStatus.textContent='The contract is unavailable.';}});
compare.addEventListener('submit',async event=>{event.preventDefault();compareStatus.textContent='Loading…';changes.textContent='';
  const contractData=new FormData(contract),data=new FormData(compare),params=new URLSearchParams({
    repositoryId:String(contractData.get('repositoryId')||''),serviceId:String(contractData.get('serviceId')||''),
    fromKind:String(data.get('fromKind')||''),fromValue:String(data.get('fromValue')||''),
    toKind:String(data.get('toKind')||''),toValue:String(data.get('toValue')||'')});
  try{const body=await fetchJson('/api/compare?'+params);compareStatus.textContent=body.status==='compared'?'Comparison ready.':
      'Comparison unavailable: '+body.beforeStatus+' / '+body.afterStatus+'.';
    if(body.status==='compared')changes.textContent=JSON.stringify(body.differences,null,2);}
  catch{compareStatus.textContent='The comparison is unavailable.';}});`;
const style = `:root{font-family:system-ui,sans-serif;color:#17212b;background:#f7f9fb}main{max-width:54rem;margin:3rem auto;padding:1.5rem;background:white;border:1px solid #dce3e9;border-radius:.75rem}section{margin-top:2rem;border-top:1px solid #dce3e9;padding-top:1rem}form{display:flex;flex-wrap:wrap;gap:1rem;align-items:end}label{display:grid;gap:.35rem}input,select,button{font:inherit;padding:.55rem .7rem}button{cursor:pointer}li{padding:.45rem 0}pre{white-space:pre-wrap;overflow-wrap:anywhere}#download{display:inline-block;margin:1rem 0}#download[hidden]{display:none}`;

const MAX_JSON_BYTES = 1_000_000;
const MAX_OPENAPI_BYTES = 5_000_000;
const safeId = (value: unknown): value is string => typeof value === "string"
  && /^[^\u0000-\u001f\u007f]{1,512}$/.test(value);
const decimalVersion = (value: string): boolean => /^[1-9][0-9]{0,18}$/.test(value)
  && BigInt(value) <= 9223372036854775807n;
const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer", "content-security-policy":
  "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'" };
const send = (response: ServerResponse, status: number, body: string, contentType: string): void => {
  response.writeHead(status, { ...headers, "content-type": contentType }); response.end(body);
};
const json = (response: ServerResponse, status: number, body: unknown): void => {
  const text = JSON.stringify(body);
  if (Buffer.byteLength(text) > MAX_JSON_BYTES) {
    send(response, 422, '{"error":"RESULT_LIMIT_EXCEEDED"}', "application/json; charset=utf-8"); return;
  }
  send(response, status, text, "application/json; charset=utf-8");
};
const error = (response: ServerResponse, failure: unknown): void => {
  const code = failure && typeof failure === "object" && "code" in failure ? failure.code : undefined;
  if (code === "QUERY_NOT_FOUND_OR_DENIED") json(response, 404, { error: "NOT_FOUND" });
  else if (code === "QUERY_STALE_SELECTION") json(response, 409, { error: "STALE_SELECTION" });
  else if (code === "QUERY_RESULT_LIMIT_EXCEEDED") json(response, 422, { error: "RESULT_LIMIT_EXCEEDED" });
  else if (code === "INVALID_QUERY_SELECTION" || code === "INVALID_QUERY_CONTEXT"
    || code === "INVALID_QUERY_DETAIL" || code === "INVALID_QUERY_SEARCH")
    json(response, 400, { error: "INVALID_REQUEST" });
  else json(response, 503, { error: "QUERY_UNAVAILABLE" });
};
const params = (url: URL, required: readonly string[], optional: readonly string[] = []): Record<string, string> | undefined => {
  const allowed = [...required, ...optional];
  if ([...url.searchParams.keys()].some((key) => !allowed.includes(key)
    || url.searchParams.getAll(key).length !== 1)
    || required.some((key) => !url.searchParams.has(key))) return undefined;
  return Object.fromEntries(allowed.flatMap((key) => {
    const value = url.searchParams.get(key); return value === null ? [] : [[key, value]];
  }));
};
const selection = (principal: PortalPrincipal, repositoryId: string, serviceId: string,
  kind: string, value: string, expectedVersion?: string): QuerySelection | undefined => {
  if (!safeId(repositoryId) || !safeId(serviceId) || !safeId(value)
    || expectedVersion !== undefined && !decimalVersion(expectedVersion)) return undefined;
  const base = { version: "1" as const, tenantId: principal.tenantId, repositoryId, serviceId };
  if (kind === "environment") return { ...base, selector: { kind, environment: value,
    ...(expectedVersion === undefined ? {} : { expectedCheckpointVersion: expectedVersion }) } };
  if (kind === "branch") return { ...base, selector: { kind, branch: value,
    ...(expectedVersion === undefined ? {} : { expectedPointerVersion: expectedVersion }) } };
  if (kind === "revision" && expectedVersion === undefined) return { ...base, selector: { kind, revision: value } };
  return undefined;
};
const requestSelection = (principal: PortalPrincipal, url: URL, extra?: string):
  { selected: QuerySelection; extra?: string } | undefined => {
  const values = params(url, ["repositoryId", "serviceId", "kind", "value", ...(extra ? [extra] : [])],
    ["expectedVersion"]);
  if (!values) return undefined;
  const selected = selection(principal, values.repositoryId!, values.serviceId!, values.kind!, values.value!,
    values.expectedVersion);
  if (!selected || extra && !safeId(values[extra])) return undefined;
  return { selected, ...(extra ? { extra: values[extra] } : {}) };
};
const validSearch = (url: URL): { query: string; limit: number; environment?: string } | undefined => {
  const values = params(url, [], ["query", "limit", "environment"]);
  if (!values) return undefined;
  const query = values.query ?? "";
  const limitText = values.limit ?? "20";
  if (query.length > 128 || /[\u0000-\u001f\u007f]/.test(query)
    || !/^(?:[1-9]|[1-4][0-9]|50)$/.test(limitText)
    || values.environment !== undefined && !safeId(values.environment)) return undefined;
  return { query, limit: Number(limitText), ...(values.environment === undefined ? {} : { environment: values.environment }) };
};
const selectedResult = (result: QueryContractResult): result is Extract<QueryContractResult, { status: "resolved" }> =>
  result.status === "resolved";
const summary = (result: Extract<QueryContractResult, { status: "resolved" }>) => ({
  status: "resolved", selector: result.selector, pin: result.pin, publication: result.publication,
  coverage: result.snapshot.coverage, analyzedAt: result.snapshot.created_at,
  endpoints: result.snapshot.endpoints.map((endpoint) => ({ endpointId: endpoint.endpoint_id,
    method: endpoint.identity.method, path: endpoint.application_path })),
  schemas: Object.keys(result.snapshot.schemas).sort(),
  evidence: result.snapshot.evidence.map((item) => item.evidence_id).sort(),
});
const evidenceFor = (result: Extract<QueryContractResult, { status: "resolved" }>, ids: readonly string[]) => {
  const wanted = new Set(ids);
  return result.snapshot.evidence.filter((item) => wanted.has(item.evidence_id));
};

/** The host supplies authentication. No request header becomes a principal by itself. */
export const createPortalServer = (options: PortalOptions): Server => {
  if (!options || typeof options.authenticate !== "function" || !options.query
    || ["searchServices", "readContract", "compareContracts", "readPublication"].some((name) =>
      typeof options.query[name as keyof PortalOptions["query"]] !== "function"))
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
    try {
      if (url.pathname === "/api/services") {
        const search = validSearch(url);
        if (!search) { json(response, 400, { error: "INVALID_REQUEST" }); return; }
        json(response, 200, await options.query.searchServices(principal,
          { tenantId: principal.tenantId, ...search })); return;
      }
      if (url.pathname === "/api/compare") {
        const values = params(url, ["repositoryId", "serviceId", "fromKind", "fromValue", "toKind", "toValue"],
          ["fromExpectedVersion", "toExpectedVersion"]);
        const before = values && selection(principal, values.repositoryId!, values.serviceId!,
          values.fromKind!, values.fromValue!, values.fromExpectedVersion);
        const after = values && selection(principal, values.repositoryId!, values.serviceId!,
          values.toKind!, values.toValue!, values.toExpectedVersion);
        if (!before || !after) { json(response, 400, { error: "INVALID_REQUEST" }); return; }
        json(response, 200, await options.query.compareContracts(principal, before, after)); return;
      }
      if (url.pathname.startsWith("/api/openapi/")) {
        const publicationId = url.pathname.slice("/api/openapi/".length);
        const values = params(url, ["repositoryId", "serviceId"]);
        if (!/^sha256:[0-9a-f]{64}$/.test(publicationId) || !values
          || !safeId(values.repositoryId) || !safeId(values.serviceId)) {
          json(response, 400, { error: "INVALID_REQUEST" }); return;
        }
        const published = await options.query.readPublication(principal,
          { tenantId: principal.tenantId, repositoryId: values.repositoryId!,
            serviceId: values.serviceId!, publicationId });
        if (published.publicationId !== publicationId
          || published.selector.repositoryId !== values.repositoryId
          || published.selector.serviceId !== values.serviceId) {
          json(response, 404, { error: "NOT_FOUND" }); return;
        }
        if (published.bytes.length > MAX_OPENAPI_BYTES) {
          json(response, 422, { error: "RESULT_LIMIT_EXCEEDED" }); return;
        }
        response.writeHead(200, { ...headers, "content-type": "application/json; charset=utf-8",
          "content-disposition": `attachment; filename="openapi-${publicationId.slice(7,19)}.json"`,
          "content-length": published.bytes.length });
        response.end(published.bytes); return;
      }
      if (["/api/contract", "/api/endpoint", "/api/schema", "/api/evidence"].includes(url.pathname)) {
        const extraName = url.pathname === "/api/endpoint" ? "endpointId"
          : url.pathname === "/api/schema" ? "schemaId"
            : url.pathname === "/api/evidence" ? "evidenceId" : undefined;
        const parsed = requestSelection(principal, url, extraName);
        if (!parsed) { json(response, 400, { error: "INVALID_REQUEST" }); return; }
        const result = await options.query.readContract(principal, parsed.selected);
        if (!selectedResult(result)) { json(response, 200, result); return; }
        if (url.pathname === "/api/contract") {
          if (result.snapshot.endpoints.length > 200 || Object.keys(result.snapshot.schemas).length > 200
            || result.snapshot.evidence.length > 200) {
            json(response, 422, { error: "RESULT_LIMIT_EXCEEDED" }); return;
          }
          json(response, 200, summary(result)); return;
        }
        const pin = { status: "resolved", selector: result.selector, pin: result.pin,
          publication: result.publication };
        if (url.pathname === "/api/endpoint") {
          const endpoint = result.snapshot.endpoints.find((item) => item.endpoint_id === parsed.extra);
          if (!endpoint) { json(response, 404, { error: "NOT_FOUND" }); return; }
          json(response, 200, { ...pin, endpoint,
            evidence: evidenceFor(result, endpoint.evidence_ids) }); return;
        }
        if (url.pathname === "/api/schema") {
          if (!Object.hasOwn(result.snapshot.schemas, parsed.extra!)) {
            json(response, 404, { error: "NOT_FOUND" }); return;
          }
          const schema = result.snapshot.schemas[parsed.extra!]!;
          json(response, 200, { ...pin, schema,
            evidence: evidenceFor(result, schema.evidence_ids) }); return;
        }
        const evidence = result.snapshot.evidence.find((item) => item.evidence_id === parsed.extra);
        if (!evidence) { json(response, 404, { error: "NOT_FOUND" }); return; }
        json(response, 200, { ...pin, evidence }); return;
      }
      json(response, 404, { error: "NOT_FOUND" });
    } catch (failure) { error(response, failure); }
  });
};
