import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {validateOperationSearchOptions, type QueryReader, type QueryObservationReader,
  type QueryOperationReader, type QuerySelection, type QueryContractResult} from "@api-truth/query";
import { parseStrictJson } from "../../../packages/ir/src/strict-json.js";
import {isSemanticIntentQuerySafe} from "../../../packages/semantics/src/egress.js";
import type { createSemanticService } from "../../../packages/semantics/src/service.js";

export type PortalPrincipal = Readonly<{ tenantId: string; principalId: string }>;
export type PortalOptions = Readonly<{
  authenticate(request: IncomingMessage): Promise<PortalPrincipal | undefined>;
  query: Pick<QueryReader, "searchServices" | "readContract" | "compareContracts" | "readPublication">
    & Partial<QueryObservationReader & QueryOperationReader>;
  semantic?: Pick<ReturnType<typeof createSemanticService>, "discover">;
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
<section id="discovery" hidden><h2>Find an API for this task</h2><form id="candidates" hidden><p>Find keyword candidates in the current authorized environment. This checks words in existing API context; it does not use an inference provider.</p><label>Task or intent<textarea name="intentQuery" maxlength="512" required></textarea></label><button type="submit">Find candidate APIs</button></form><p id="candidate-status" role="status"></p><ul id="candidate-results"></ul><form id="discover"><p>Selected endpoint documentation, source route and handler identifiers, and your task text may be sent to the host-configured inference provider.</p><fieldset id="discovery-endpoints"><legend>Choose API operations</legend></fieldset><label>Task or intent<textarea name="intentQuery" maxlength="512" required></textarea></label><button type="submit">Find an API for this task</button></form><p id="discovery-status" role="status"></p><ul id="discovery-results"></ul></section>
<section><h2>Compare contracts</h2><form id="compare"><label>From
<select name="fromKind"><option value="environment">Environment</option><option value="branch">Branch</option>
<option value="revision">Revision</option></select></label><label>Name or revision <input name="fromValue" maxlength="512" required></label>
<label>To<select name="toKind"><option value="environment">Environment</option><option value="branch">Branch</option>
<option value="revision">Revision</option></select></label><label>Name or revision <input name="toValue" maxlength="512" required></label>
<button type="submit">Compare</button></form><p id="compare-status" role="status"></p><pre id="changes"></pre></section>
</main><script src="/app.js" defer></script></body></html>`;
const script = `const runtimeEnabled=__OBSERVATION_READER_ENABLED__,semanticEnabled=__SEMANTIC_ENABLED__,candidateEnabled=__CANDIDATE_ENABLED__;
const search=document.getElementById('search'),contract=document.getElementById('contract'),compare=document.getElementById('compare');
const discovery=document.getElementById('discovery'),discover=document.getElementById('discover'),discoveryEndpoints=document.getElementById('discovery-endpoints'),discoveryStatus=document.getElementById('discovery-status'),discoveryResults=document.getElementById('discovery-results');
const candidates=document.getElementById('candidates'),candidateStatus=document.getElementById('candidate-status'),candidateResults=document.getElementById('candidate-results');
if(semanticEnabled||candidateEnabled)discovery.hidden=false;discover.hidden=!semanticEnabled;candidates.hidden=!candidateEnabled;
let currentResolved=null,selectionGeneration=0,discoveryGeneration=0,candidateGeneration=0;discover.addEventListener('input',()=>{discoveryGeneration++;discoveryResults.replaceChildren();discoveryStatus.textContent='Discovery inputs changed. Submit again to update results.';});candidates.addEventListener('input',()=>{candidateGeneration++;candidateResults.replaceChildren();candidateStatus.textContent='Candidate inputs changed. Submit again to update results.';});contract.addEventListener('input',()=>{selectionGeneration++;discoveryGeneration++;candidateGeneration++;currentResolved=null;discoveryResults.replaceChildren();candidateResults.replaceChildren();discoveryStatus.textContent='View the selected contract again before discovery.';candidateStatus.textContent='View the selected contract again before candidate search.';});
const status=document.getElementById('search-status'),results=document.getElementById('results');
const contractStatus=document.getElementById('contract-status'),summary=document.getElementById('contract-summary');
const endpoints=document.getElementById('endpoints'),schemas=document.getElementById('schemas'),evidence=document.getElementById('evidence'),detail=document.getElementById('detail');
const download=document.getElementById('download'),compareStatus=document.getElementById('compare-status'),changes=document.getElementById('changes');
const selection=()=>{const data=new FormData(contract);return new URLSearchParams({repositoryId:String(data.get('repositoryId')||''),
  serviceId:String(data.get('serviceId')||''),kind:String(data.get('kind')||''),value:String(data.get('value')||'')});};
const fetchJson=async(path,init={})=>{const response=await fetch(path,{...init,credentials:'same-origin'});if(!response.ok)throw Error('unavailable');return response.json();};
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
        if(service.environment){contract.elements.namedItem('kind').value='environment';contract.elements.namedItem('value').value=service.environment.name;}
        contract.requestSubmit();});
      row.append(button);results.append(row);}}
  catch{status.textContent='The service list is unavailable.';}});
contract.addEventListener('submit',async event=>{event.preventDefault();const generation=++selectionGeneration;discoveryGeneration++;candidateGeneration++;currentResolved=null;discoveryResults.replaceChildren();candidateResults.replaceChildren();candidateStatus.textContent='';discoveryStatus.textContent='';discoveryEndpoints.replaceChildren();summary.replaceChildren();endpoints.replaceChildren();
  schemas.replaceChildren();evidence.replaceChildren();detail.textContent='';download.hidden=true;contractStatus.textContent='Loading…';
  try{const params=selection(),body=await fetchJson('/api/contract?'+params);if(generation!==selectionGeneration)return;
    if(body.status!=='resolved'){contractStatus.textContent='Contract state: '+body.status+'. No contract is available here.';return;}
    contractStatus.textContent='Contract available. Analyzed at '+body.analyzedAt+'.';currentResolved={params,body};
    const coverage=document.createElement('p');coverage.textContent='Coverage: '+body.coverage.status+'.';summary.append(coverage);
    if(runtimeEnabled&&params.get('kind')==='environment'&&body.pin&&body.pin.checkpointVersion){
      const activity=document.createElement('button');activity.type='button';activity.textContent='View runtime activity';
      const runtimeParams=new URLSearchParams({repositoryId:params.get('repositoryId'),serviceId:params.get('serviceId'),
        environment:params.get('value'),expectedCheckpointVersion:body.pin.checkpointVersion,limit:'20'});
      activity.addEventListener('click',()=>showDetail('/api/observations?'+runtimeParams));summary.append(activity);}
    for(const item of body.endpoints){const row=document.createElement('li'),button=document.createElement('button');
      button.type='button';button.textContent=item.method+' '+item.path;
      button.addEventListener('click',()=>showDetail('/api/endpoint?'+params+'&endpointId='+encodeURIComponent(item.endpointId)));
      row.append(button);endpoints.append(row);if(semanticEnabled){const label=document.createElement('label'),check=document.createElement('input');check.type='checkbox';check.name='endpointId';check.value=item.endpointId;check.checked=!candidateEnabled&&body.endpoints.length<=16;label.append(check,document.createTextNode(item.method+' '+item.path));discoveryEndpoints.append(label);}}
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
  catch{if(generation===selectionGeneration)contractStatus.textContent='The contract is unavailable.';}});
candidates.addEventListener('submit',async event=>{event.preventDefault();const generation=++candidateGeneration;candidateResults.replaceChildren();if(!currentResolved){candidateStatus.textContent='View a resolved, pinned contract first.';return;}const selected=currentResolved;if(selected.params.get('kind')!=='environment'||!selected.body.pin?.checkpointVersion){candidateStatus.textContent='Select a pinned environment to search candidates.';return;}const intentQuery=String(new FormData(candidates).get('intentQuery')||'');candidateStatus.textContent='Checking keyword candidates…';try{const body=await fetchJson('/api/candidates',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({repositoryId:selected.params.get('repositoryId'),serviceId:selected.params.get('serviceId'),view:{kind:'environment',environment:selected.params.get('value'),expectedCheckpointVersion:selected.body.pin.checkpointVersion},intentQuery,limit:20})});if(generation!==candidateGeneration)return;if(body.status==='candidates'){candidateStatus.textContent=body.candidates.length+' keyword candidates in the selected contract.'+(body.complete?'':' Search context is incomplete.')+(body.truncated?' More candidates were omitted by the result limit.':'');for(const item of body.candidates){const row=document.createElement('li'),label=document.createElement('label'),check=document.createElement('input');check.type='checkbox';check.value=item.endpointId;check.addEventListener('change',()=>{const target=[...discoveryEndpoints.querySelectorAll('input[name=endpointId]')].find(input=>input.value===item.endpointId);if(!target||!semanticEnabled)return;const count=discoveryEndpoints.querySelectorAll('input[name=endpointId]:checked').length;if(check.checked&&count>=16){check.checked=false;candidateStatus.textContent='Choose at most 16 operations for provider discovery.';return;}target.checked=check.checked;target.dispatchEvent(new Event('input',{bubbles:true}));});if(semanticEnabled)label.append(check);label.append(document.createTextNode(item.method+' '+item.path+' — '+item.label+' (keyword score '+item.score+', evidence '+item.evidenceIds.join(', ')+')'));row.append(label);candidateResults.append(row);}}else if(body.status==='no_match')candidateStatus.textContent='No keyword overlap was found in the selected contract. This does not rule out a semantic match.';else candidateStatus.textContent='Candidate search could not make a complete determination.';}catch{if(generation===candidateGeneration)candidateStatus.textContent='Candidate search is unavailable.';}});
discover.addEventListener('submit',async event=>{event.preventDefault();const generation=++discoveryGeneration;discoveryResults.replaceChildren();if(!currentResolved){discoveryStatus.textContent='View a resolved, pinned contract first.';return;}const ids=[...discovery.querySelectorAll('input[name=endpointId]:checked')].map(input=>input.value);if(ids.length<1||ids.length>16){discoveryStatus.textContent='Choose between 1 and 16 API operations.';return;}const selected=currentResolved,kind=selected.params.get('kind'),value=selected.params.get('value'),view={kind};if(kind==='revision')view.revision=value;else if(kind==='branch'){view.branch=value;view.expectedPointerVersion=selected.body.pin.pointerVersion;}else{view.environment=value;view.expectedCheckpointVersion=selected.body.pin.checkpointVersion;}const intentQuery=String(new FormData(discover).get('intentQuery')||'');discoveryStatus.textContent='Checking selected operations…';try{const body=await fetchJson('/api/discover',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({repositoryId:selected.params.get('repositoryId'),serviceId:selected.params.get('serviceId'),view,endpointIds:ids,intentQuery})});if(generation!==discoveryGeneration)return;const labels={disabled:'Semantic discovery is disabled for this service.',no_context:'No usable semantic context is available.',no_match:'No matching operation was found. Any inference is unreviewed and non-normative.',ambiguous:'Several operations may match. Inference is unreviewed and non-normative.',suggestions:'Suggestions are inferred, unreviewed, and non-normative.'};const coverage=body.contextCoverage;const partial=coverage?.status==='partial';const baseLabel=partial&&body.status==='no_match'?'No matching operation was found among the analyzed operations. Any inference is unreviewed and non-normative.':labels[body.status]||'Discovery returned no usable result.';const coverageLabel=partial?' Coverage: '+coverage.analyzedEndpointIds.length+' of '+coverage.requestedEndpointIds.length+' selected operations analyzed; omitted: '+coverage.omittedEndpointIds.join(', ')+'.':'';discoveryStatus.textContent=baseLabel+coverageLabel;const items=body.status==='suggestions'?body.suggestions:body.status==='ambiguous'?body.candidateEndpointIds.map(endpointId=>({endpointId,intent:'Ambiguous candidate',summary:body.reason,evidenceIds:[]})):[];for(const item of items){const row=document.createElement('li');row.textContent=item.endpointId+' — '+item.intent+': '+item.summary+' (evidence: '+item.evidenceIds.join(', ')+')';discoveryResults.append(row);}}catch{if(generation===discoveryGeneration)discoveryStatus.textContent='Discovery is unavailable.';}});
compare.addEventListener('submit',async event=>{event.preventDefault();compareStatus.textContent='Loading…';changes.textContent='';
  const contractData=new FormData(contract),data=new FormData(compare),params=new URLSearchParams({
    repositoryId:String(contractData.get('repositoryId')||''),serviceId:String(contractData.get('serviceId')||''),
    fromKind:String(data.get('fromKind')||''),fromValue:String(data.get('fromValue')||''),
    toKind:String(data.get('toKind')||''),toValue:String(data.get('toValue')||'')});
  try{const body=await fetchJson('/api/compare?'+params);compareStatus.textContent=body.status==='compared'?'Comparison ready.':
      'Comparison unavailable: '+body.beforeStatus+' / '+body.afterStatus+'.';
    if(body.status==='compared')changes.textContent=JSON.stringify(body.differences,null,2);}
  catch{compareStatus.textContent='The comparison is unavailable.';}});`;
const style = `:root{font-family:system-ui,sans-serif;color:#17212b;background:#f7f9fb}main{max-width:54rem;margin:3rem auto;padding:1.5rem;background:white;border:1px solid #dce3e9;border-radius:.75rem}section{margin-top:2rem;border-top:1px solid #dce3e9;padding-top:1rem}form{display:flex;flex-wrap:wrap;gap:1rem;align-items:end}form[hidden]{display:none}label{display:grid;gap:.35rem}input,select,button,textarea{font:inherit;padding:.55rem .7rem}button{cursor:pointer}li{padding:.45rem 0}pre{white-space:pre-wrap;overflow-wrap:anywhere}#download{display:inline-block;margin:1rem 0}#download[hidden]{display:none}`;

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
const jsonClose = (response: ServerResponse, status: number, body: unknown): void => {
  const text = JSON.stringify(body);
  response.writeHead(status, {...headers, connection: "close", "content-type": "application/json; charset=utf-8"});
  response.end(text);
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
  else if (code === "QUERY_STALE_SELECTION" || code === "SEMANTIC_STALE_CONTEXT") json(response, 409, { error: "STALE_SELECTION" });
  else if (code === "QUERY_RESULT_LIMIT_EXCEEDED") json(response, 422, { error: "RESULT_LIMIT_EXCEEDED" });
  else if (code === "SEMANTIC_NOT_FOUND_OR_DENIED") json(response, 404, { error: "NOT_FOUND" });
  else if (code === "SEMANTIC_INVALID_REQUEST") json(response, 400, { error: "INVALID_REQUEST" });
  else if (code === "SEMANTIC_STORAGE_ERROR") json(response, 503, { error: "SEMANTIC_UNAVAILABLE" });
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
const samePin = (left: unknown, right: unknown): boolean => {
  if (!left || typeof left !== "object" || Array.isArray(left) || !right || typeof right !== "object" || Array.isArray(right)) return false;
  const a = left as Record<string, unknown>, b = right as Record<string, unknown>;
  return ["snapshotId", "revision", "configFingerprint", "checkpointVersion", "pointerVersion"]
    .every(field => a[field] === b[field]);
};
const sameSelector = (left: unknown, right: unknown): boolean => {
  if (!left || typeof left !== "object" || Array.isArray(left) || !right || typeof right !== "object" || Array.isArray(right)) return false;
  const a = left as Record<string, unknown>, b = right as Record<string, unknown>;
  if (a.kind !== b.kind) return false;
  const fields = a.kind === "revision" ? ["kind", "revision"]
    : a.kind === "branch" ? ["kind", "branch", "expectedPointerVersion"]
      : a.kind === "environment" ? ["kind", "environment", "expectedCheckpointVersion"] : [];
  return fields.length > 0 && fields.every(field => a[field] === b[field]);
};
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

const readBoundedBody = (request: IncomingMessage, maxBytes: number, timeoutMs: number): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let bytes = 0; let settled = false;
    const finish = (failure?: Error) => { if (settled) return; settled = true; clearTimeout(timer);
      request.removeListener("data", onData); request.removeListener("end", onEnd);
      request.removeListener("error", onError); request.removeListener("aborted", onError);
      failure ? reject(failure) : resolve(Buffer.concat(chunks, bytes)); };
    const onData = (chunk: Buffer | string) => { const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += value.length; if (bytes > maxBytes) finish(new Error("BODY_LIMIT")); else chunks.push(value); };
    const onEnd = () => finish(); const onError = () => finish(new Error("BODY_READ"));
    const timer = setTimeout(() => finish(new Error("BODY_TIMEOUT")), timeoutMs); timer.unref();
    request.on("data", onData); request.once("end", onEnd); request.once("error", onError); request.once("aborted", onError);
  });
const parseDiscoveryBody = (input: unknown, principal: PortalPrincipal): {selected: QuerySelection; endpointIds: string[]; intentQuery: string} | undefined => {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype) return undefined;
  const body = input as Record<string, unknown>;
  if (Object.keys(body).sort().join(",") !== "endpointIds,intentQuery,repositoryId,serviceId,view")
    return undefined;
  if (typeof body.repositoryId !== "string" || typeof body.serviceId !== "string"
    || !Array.isArray(body.endpointIds) || body.endpointIds.length < 1 || body.endpointIds.length > 16
    || !body.endpointIds.every(safeId) || new Set(body.endpointIds).size !== body.endpointIds.length
    || !isSemanticIntentQuerySafe(body.intentQuery)) return undefined;
  const view = body.view;
  if (!view || typeof view !== "object" || Array.isArray(view) || Object.getPrototypeOf(view) !== Object.prototype) return undefined;
  const fields = view as Record<string, unknown>;
  let kind: string, value: unknown, version: unknown;
  if (fields.kind === "revision" && Object.keys(fields).sort().join(",") === "kind,revision") {
    kind = "revision"; value = fields.revision;
  } else if (fields.kind === "branch" && Object.keys(fields).sort().join(",") === "branch,expectedPointerVersion,kind") {
    kind = "branch"; value = fields.branch; version = fields.expectedPointerVersion;
  } else if (fields.kind === "environment" && Object.keys(fields).sort().join(",") === "environment,expectedCheckpointVersion,kind") {
    kind = "environment"; value = fields.environment; version = fields.expectedCheckpointVersion;
  } else return undefined;
  if (version !== undefined && (typeof version !== "string" || !decimalVersion(version))) return undefined;
  if ((kind === "branch" || kind === "environment") && version === undefined) return undefined;
  const selected = selection(principal, body.repositoryId, body.serviceId, kind,
    typeof value === "string" ? value : "", typeof version === "string" ? version : undefined);
  return selected ? {selected, endpointIds: body.endpointIds as string[], intentQuery: body.intentQuery} : undefined;
};
const parseCandidateBody = (input: unknown, principal: PortalPrincipal):
  {selected: QuerySelection; intentQuery: string; limit: number} | undefined => {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.getPrototypeOf(input) !== Object.prototype) return undefined;
  const body = input as Record<string, unknown>;
  const keys = Object.keys(body).sort().join(",");
  if (keys !== "intentQuery,repositoryId,serviceId,view"
    && keys !== "intentQuery,limit,repositoryId,serviceId,view") return undefined;
  if (typeof body.repositoryId !== "string" || typeof body.serviceId !== "string") return undefined;
  const view = body.view;
  if (!view || typeof view !== "object" || Array.isArray(view)
    || Object.getPrototypeOf(view) !== Object.prototype) return undefined;
  const fields = view as Record<string, unknown>;
  if (Object.keys(fields).sort().join(",") !== "environment,expectedCheckpointVersion,kind"
    || fields.kind !== "environment" || typeof fields.environment !== "string"
    || typeof fields.expectedCheckpointVersion !== "string") return undefined;
  const selected = selection(principal, body.repositoryId, body.serviceId, "environment",
    fields.environment, fields.expectedCheckpointVersion);
  const options = validateOperationSearchOptions({intentQuery: body.intentQuery,
    ...(Object.hasOwn(body, "limit") ? {limit: body.limit} : {})});
  return selected && options ? {selected, intentQuery: options.intentQuery, limit: options.limit ?? 20} : undefined;
};

/** The host supplies authentication. No request header becomes a principal by itself. */
export const createPortalServer = (options: PortalOptions): Server => {
  if (!options || typeof options.authenticate !== "function" || !options.query
    || ["searchServices", "readContract", "compareContracts", "readPublication"].some((name) =>
      typeof options.query[name as keyof PortalOptions["query"]] !== "function"))
    throw new Error("PORTAL_HOST_REQUIRED");
  const semanticDiscover = typeof options.semantic?.discover === "function"
    ? options.semantic.discover.bind(options.semantic) : undefined;
  return createServer(async (request, response) => {
    let principal: PortalPrincipal | undefined;
    try { principal = await options.authenticate(request); } catch { /* Fail closed. */ }
    if (!principal || !safeId(principal.tenantId) || !safeId(principal.principalId)) {
      (request.method === "POST" ? jsonClose : json)(response, 401, { error: "NOT_AUTHORIZED" }); return;
    }
    if (!request.url || request.url.length > 2048 || (request.method !== "GET"
      && !(request.method === "POST" && ["/api/discover", "/api/candidates"].includes(request.url.split("?", 1)[0]!)))) {
      (request.method === "POST" ? jsonClose : json)(response, 400, { error: "INVALID_REQUEST" }); return;
    }
    let url: URL;
    try { url = new URL(request.url, "http://localhost"); } catch {
      (request.method === "POST" ? jsonClose : json)(response, 400, { error: "INVALID_REQUEST" }); return;
    }
    if (url.pathname === "/" && request.method === "GET") { send(response, 200, page, "text/html; charset=utf-8"); return; }
    if (url.pathname === "/app.js") { send(response, 200,
      script.replace("__OBSERVATION_READER_ENABLED__", String(typeof options.query.readMetadataObservations === "function"))
        .replace("__SEMANTIC_ENABLED__", String(semanticDiscover !== undefined))
        .replace("__CANDIDATE_ENABLED__", String(typeof options.query.readOperationCandidates === "function")),
      "text/javascript; charset=utf-8"); return; }
    if (url.pathname === "/style.css") { send(response, 200, style, "text/css; charset=utf-8"); return; }
    try {
      if (url.pathname === "/api/discover" || url.pathname === "/api/candidates") {
        if (url.search.length > 0) { jsonClose(response, 400, {error: "INVALID_REQUEST"}); return; }
        const candidate = url.pathname === "/api/candidates";
        if (request.method !== "POST" || (candidate
          ? typeof options.query.readOperationCandidates !== "function"
          : semanticDiscover === undefined)) {
          (request.method === "POST" ? jsonClose : json)(response, 404, {error: "NOT_FOUND"}); return;
        }
        const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
        const length = request.headers["content-length"];
        if (contentType !== "application/json" || length !== undefined
          && (!/^(?:0|[1-9][0-9]*)$/.test(length) || Number(length) > 8192)) {
          jsonClose(response, 400, {error: "INVALID_REQUEST"}); return;
        }
        let raw: Buffer;
        try { raw = await readBoundedBody(request, 8192, 3000); }
        catch (failure) {
          const code = failure instanceof Error && failure.message === "BODY_TIMEOUT" ? "REQUEST_TIMEOUT" : "INVALID_REQUEST";
          jsonClose(response, code === "REQUEST_TIMEOUT" ? 408 : 400, {error: code}); return;
        }
        let body: unknown;
        try { body = parseStrictJson(new TextDecoder("utf-8", {fatal: true}).decode(raw), {maxDepth: 8, maxNodes: 128}); }
        catch { json(response, 400, {error: "INVALID_REQUEST"}); return; }
        if (candidate) {
          const requestData = parseCandidateBody(body, principal);
          if (!requestData) {json(response, 400, {error: "INVALID_REQUEST"}); return;}
          const selectedContract = await options.query.readContract(principal, requestData.selected);
          if (!selectedResult(selectedContract)) {json(response, 409, {error: "STALE_SELECTION"}); return;}
          const candidates = await options.query.readOperationCandidates!(principal, requestData.selected,
            {intentQuery: requestData.intentQuery, limit: requestData.limit});
          if (candidates.status === "candidates" || candidates.status === "no_match"
            || candidates.pin !== undefined || candidates.selector !== undefined) {
            if (!candidates.pin || !candidates.selector || !samePin(candidates.pin, selectedContract.pin)
              || candidates.selector.tenantId !== requestData.selected.tenantId
              || candidates.selector.repositoryId !== requestData.selected.repositoryId
              || candidates.selector.serviceId !== requestData.selected.serviceId
              || !sameSelector(candidates.selector.selector, requestData.selected.selector)) {
              json(response, 409, {error: "STALE_SELECTION"}); return;
            }
          }
          json(response, 200, candidates); return;
        }
        const requestData = parseDiscoveryBody(body, principal);
        if (!requestData) { json(response, 400, {error: "INVALID_REQUEST"}); return; }
        const selectedContract = await options.query.readContract(principal, requestData.selected);
        if (!selectedResult(selectedContract)) { json(response, 409, {error: "STALE_SELECTION"}); return; }
        if (requestData.endpointIds.some(id => !selectedContract.snapshot.endpoints.some(item => item.endpoint_id === id))) {
          json(response, 400, {error: "INVALID_REQUEST"}); return;
        }
        const discovered = await semanticDiscover!(principal, requestData.selected,
          requestData.endpointIds, requestData.intentQuery);
        if ("provenance" in discovered && (!samePin(discovered.provenance.pin, selectedContract.pin)
          || !sameSelector(discovered.provenance.selector, requestData.selected.selector))) {
          json(response, 409, {error: "STALE_SELECTION"}); return;
        }
        json(response, 200, discovered); return;
      }
      if (request.method !== "GET") { (request.method === "POST" ? jsonClose : json)(response, 400, {error: "INVALID_REQUEST"}); return; }
      if (url.pathname === "/api/observations" && typeof options.query.readMetadataObservations === "function") {
        const values = params(url, ["repositoryId", "serviceId", "environment"],
          ["expectedCheckpointVersion", "limit", "endpointId"]);
        const limit = values?.limit ?? "20";
        const selected = values && selection(principal, values.repositoryId!, values.serviceId!,
          "environment", values.environment!, values.expectedCheckpointVersion);
        if (!values || !selected || !/^(?:[1-9]|[1-9][0-9]|100)$/.test(limit)
          || values.endpointId !== undefined && !safeId(values.endpointId)) {
          json(response, 400, {error: "INVALID_REQUEST"}); return;
        }
        json(response, 200, await options.query.readMetadataObservations(principal, selected,
          {limit: Number(limit), ...(values.endpointId === undefined ? {} : {endpointId: values.endpointId})})); return;
      }
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
        let publicationId: string;
        try { publicationId = decodeURIComponent(url.pathname.slice("/api/openapi/".length)); }
        catch { json(response, 400, { error: "INVALID_REQUEST" }); return; }
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
