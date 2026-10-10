import {detailScript} from "./detail-browser.js";
import {page} from "./layout.js";
import {style} from "./style.js";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {isProxy} from "node:util/types";
import {validateOperationSearchOptions, type QueryReader, type QueryObservationReader,
  type QueryOperationReader, type QueryCorpusOperationReader, type QuerySelection,
  type QueryContractResult, type createLoadedDocumentVerificationReadStore} from "@api-truth/query";
import { parseStrictJson } from "../../../packages/ir/src/strict-json.js";
import {isSemanticIntentQuerySafe} from "../../../packages/semantics/src/egress.js";
import {parseSemanticHistoryReview,type SemanticHistoryReviewRequest} from "../../../packages/semantics/src/reviews.js";
import type { createSemanticService } from "../../../packages/semantics/src/service.js";
import type { createSemanticCorpusService } from "../../../packages/semantics/src/corpus-service.js";
import type { createSyntheticExampleService } from "../../../packages/observations/src/example-service.js";
import type {createFieldPresenceQueryStore} from "../../../packages/observations/src/field-presence-query-store.js";
import {fieldPresenceScript} from "./field-presence-browser.js";
import {corpusDiscoveryScript} from "./corpus-discovery-browser.js";

export type PortalPrincipal = Readonly<{ tenantId: string; principalId: string }>;
export type PortalOptions = Readonly<{
  authenticate(request: IncomingMessage): Promise<PortalPrincipal | undefined>;
  query: Pick<QueryReader, "searchServices" | "readContract" | "compareContracts" | "readPublication">
    & Partial<QueryObservationReader & QueryOperationReader & QueryCorpusOperationReader>;
  /** Return only configured environment names visible to the authenticated principal. */
  environments?: (principal: PortalPrincipal) => Promise<readonly string[]>;
  semantic?: Pick<ReturnType<typeof createSemanticService>, "discover">;
  /** Trusted public origin when serving history writes behind an HTTPS proxy. */
  semanticHistoryWriteOrigin?: string;
  semanticHistory?: Partial<Pick<ReturnType<typeof createSemanticService>, "readHistory" | "readHistoryReviews" | "recordHistoryReview">>;
  corpusSemantic?: Pick<ReturnType<typeof createSemanticCorpusService>, "discoverAcrossServices">;
  examples?: Pick<ReturnType<typeof createSyntheticExampleService>, "generate">;
  presence?: Pick<ReturnType<typeof createFieldPresenceQueryStore>, "readForPrincipal">;
  loadedDocumentVerification?: Pick<ReturnType<typeof createLoadedDocumentVerificationReadStore>, "readForPrincipal">;
}>;

const script = detailScript+`const runtimeEnabled=__OBSERVATION_READER_ENABLED__,semanticEnabled=__SEMANTIC_ENABLED__,candidateEnabled=__CANDIDATE_ENABLED__,corpusEnabled=__CORPUS_ENABLED__,examplesEnabled=__EXAMPLES_ENABLED__;
const search=document.getElementById('search'),contract=document.getElementById('contract'),compare=document.getElementById('compare');
const discovery=document.getElementById('discovery'),discover=document.getElementById('discover'),discoveryEndpoints=document.getElementById('discovery-endpoints'),discoveryStatus=document.getElementById('discovery-status'),discoveryResults=document.getElementById('discovery-results');
const candidates=document.getElementById('candidates'),candidateStatus=document.getElementById('candidate-status'),candidateResults=document.getElementById('candidate-results');
const corpusSection=document.getElementById('corpus-section'),corpus=document.getElementById('corpus'),corpusStatus=document.getElementById('corpus-status'),corpusResults=document.getElementById('corpus-results');corpusSection.hidden=!corpusEnabled;
const examples=document.getElementById('examples'),exampleForm=document.getElementById('example-form'),exampleButton=exampleForm.querySelector('button'),exampleStatus=document.getElementById('example-status'),exampleResult=document.getElementById('example-result');examples.hidden=!examplesEnabled;
if(semanticEnabled||candidateEnabled)discovery.hidden=false;discover.hidden=!semanticEnabled;candidates.hidden=!candidateEnabled;
let currentResolved=null,searchGeneration=0,detailGeneration=0,selectionGeneration=0,discoveryGeneration=0,candidateGeneration=0,corpusGeneration=0,exampleGeneration=0,pendingCorpusCandidate=null;const resetExample=(message)=>{exampleGeneration++;exampleResult.textContent='';exampleButton.disabled=true;exampleStatus.textContent=message;};exampleStatus.textContent='View a current environment contract before generating an example.';exampleForm.addEventListener('input',()=>{exampleGeneration++;exampleResult.textContent='';exampleStatus.textContent='Policy changed. Generate again to update the example.';});discover.addEventListener('input',()=>{discoveryGeneration++;discoveryResults.replaceChildren();discoveryStatus.textContent='Discovery inputs changed. Submit again to update results.';});candidates.addEventListener('input',()=>{candidateGeneration++;candidateResults.replaceChildren();candidateStatus.textContent='Candidate inputs changed. Submit again to update results.';});corpus.addEventListener('input',()=>{corpusGeneration++;corpusResults.replaceChildren();corpusStatus.textContent='Corpus search inputs changed. Submit again to update results.';});contract.addEventListener('input',()=>{detailGeneration++;summary.replaceChildren();endpoints.replaceChildren();schemas.replaceChildren();evidence.replaceChildren();detail.textContent='';download.hidden=true;document.getElementById('detail-view').textContent='Select a service to explore its operations.';document.getElementById('selected-service').textContent='No service selected';delete contract.dataset.expectedVersion;pendingCorpusCandidate=null;selectionGeneration++;discoveryGeneration++;candidateGeneration++;currentResolved=null;resetExample('View a current environment contract before generating an example.');discoveryResults.replaceChildren();candidateResults.replaceChildren();discoveryStatus.textContent='View the selected contract again before discovery.';candidateStatus.textContent='View the selected contract again before candidate search.';});
const status=document.getElementById('search-status'),results=document.getElementById('results');
const contractStatus=document.getElementById('contract-status'),summary=document.getElementById('contract-summary');
const endpoints=document.getElementById('endpoints'),schemas=document.getElementById('schemas'),evidence=document.getElementById('evidence'),detail=document.getElementById('detail');
const download=document.getElementById('download'),compareStatus=document.getElementById('compare-status'),changes=document.getElementById('changes');
const selection=()=>{const data=new FormData(contract),params=new URLSearchParams({repositoryId:String(data.get('repositoryId')||''),
  serviceId:String(data.get('serviceId')||''),kind:String(data.get('kind')||''),value:String(data.get('value')||'')});if(contract.dataset.expectedVersion)params.set('expectedVersion',contract.dataset.expectedVersion);return params;};
const fetchJson=async(path,init={})=>{const response=await fetch(path,{...init,credentials:'same-origin'});if(!response.ok)throw Error('unavailable');return response.json();};
const loadEnvironments=async()=>{const controls=[...document.querySelectorAll('[data-environment-select]')],message=document.getElementById('environment-status');for(const control of controls)if(control.required)control.form.querySelector('button[type=submit]').disabled=true;try{const body=await fetchJson('/api/environments');if(!Array.isArray(body.environments)||body.environments.length>128||body.environments.some(name=>typeof name!=='string'||!name.length||name.length>512||/[\\u0000-\\u001f\\u007f]/.test(name)))throw Error('invalid');for(const control of controls){for(const name of body.environments){const option=document.createElement('option');option.value=name;option.textContent=name;control.append(option);}control.disabled=control.required&&!body.environments.length;if(control.required)control.form.querySelector('button[type=submit]').disabled=control.disabled;}message.textContent=body.environments.length?'':'No environment choices are configured for your access.';}catch{for(const control of controls){control.disabled=control.required;if(control.required)control.form.querySelector('button[type=submit]').disabled=true;}message.textContent='Environment choices are unavailable. Service search can still use all environments.';}};loadEnvironments();
const showDetail=async(path)=>{const generation=++detailGeneration,selected=selectionGeneration;detail.textContent='Loading…';try{const data=await fetchJson(path);if(generation!==detailGeneration||selected!==selectionGeneration)return;detail.textContent=JSON.stringify(data,null,2);renderDetail(data);}
  catch{if(generation!==detailGeneration||selected!==selectionGeneration)return;detail.textContent='Details are unavailable.';document.getElementById('detail-view').textContent='Details are unavailable. Reload the contract and try again.';}};
search.addEventListener('input',()=>{searchGeneration++;results.replaceChildren();status.textContent='Search inputs changed.';});search.elements.namedItem('environment').addEventListener('change',()=>{contract.dispatchEvent(new Event('input',{bubbles:true}));contractStatus.textContent='Select a service from this environment.';search.requestSubmit();});
search.addEventListener('submit',async event=>{event.preventDefault();const generation=++searchGeneration;results.replaceChildren();status.textContent='Loading…';
  const data=new FormData(search),params=new URLSearchParams({query:String(data.get('query')||''),limit:'20'});
  const environment=String(data.get('environment')||'').trim();if(environment)params.set('environment',environment);
  try{const body=await fetchJson('/api/services?'+params);if(generation!==searchGeneration)return;status.textContent=body.services.length?'Results':'No matching services in this scope.';
    for(const service of body.services){const row=document.createElement('li'),button=document.createElement('button');
      button.type='button';button.className='service-result';button.setAttribute('aria-label',service.repositoryId+' / '+service.serviceId+(service.environment?' — '+service.environment.name+': '+service.environment.status:''));const title=document.createElement('strong'),repo=document.createElement('span'),badge=document.createElement('span');title.textContent=service.serviceId;repo.className='service-repository';repo.textContent=service.repositoryId+' / '+service.serviceId;badge.className='service-state';badge.textContent=service.environment?service.environment.name+' · '+service.environment.status:'All environments';button.append(title,repo,badge);
      button.addEventListener('click',()=>{delete contract.dataset.expectedVersion;pendingCorpusCandidate=null;contract.elements.namedItem('repositoryId').value=service.repositoryId;
        contract.elements.namedItem('serviceId').value=service.serviceId;
        if(service.environment){contract.elements.namedItem('kind').value='environment';contract.elements.namedItem('value').value=service.environment.name;}
        contract.requestSubmit();});
      row.append(button);results.append(row);}}
  catch{if(generation===searchGeneration)status.textContent='The service list is unavailable.';}});
corpus.addEventListener('submit',async event=>{event.preventDefault();const generation=++corpusGeneration;corpusResults.replaceChildren();const data=new FormData(corpus),environment=String(data.get('environment')||''),intentQuery=String(data.get('intentQuery')||'');corpusStatus.textContent='Searching current authorized services…';try{const body=await fetchJson('/api/corpus-candidates',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({environment,intentQuery,limit:20})});if(generation!==corpusGeneration)return;if(body.environment!==environment)throw Error('stale');if(body.status==='candidates'){corpusStatus.textContent=body.candidates.length+' keyword candidates across visible authorized services.'+(body.complete?'':' Search context is incomplete.')+(body.truncated?' More candidates were omitted by the result limit.':'');for(const item of body.candidates){if(item.selector?.repositoryId!==item.repositoryId||item.selector?.serviceId!==item.serviceId||item.selector?.selector?.kind!=='environment'||item.selector.selector.environment!==environment||item.selector.selector.expectedCheckpointVersion!==item.pin?.checkpointVersion)continue;const row=document.createElement('li'),button=document.createElement('button');button.type='button';button.textContent='Load pinned contract';button.addEventListener('click',()=>{if(generation!==corpusGeneration)return;pendingCorpusCandidate={item,generation};contract.elements.namedItem('repositoryId').value=item.repositoryId;contract.elements.namedItem('serviceId').value=item.serviceId;contract.elements.namedItem('kind').value='environment';contract.elements.namedItem('value').value=environment;contract.dataset.expectedVersion=item.pin.checkpointVersion;contract.requestSubmit();});row.append(document.createTextNode(item.repositoryId+' / '+item.serviceId+' — '+item.method+' '+item.path+' — '+item.label+' (checkpoint '+item.pin.checkpointVersion+', keyword score '+item.score+', evidence '+item.evidenceIds.join(', ')+') '),button);corpusResults.append(row);}}else if(body.status==='no_match')corpusStatus.textContent='No keyword overlap was found in the complete visible authorized scope. This does not rule out a semantic match.';else corpusStatus.textContent='Corpus search could not make a complete determination.';}catch{if(generation===corpusGeneration)corpusStatus.textContent='Corpus search is unavailable.';}});
contract.addEventListener('submit',async event=>{event.preventDefault();const generation=++selectionGeneration,requestedCandidate=pendingCorpusCandidate;pendingCorpusCandidate=null;discoveryGeneration++;candidateGeneration++;currentResolved=null;resetExample('View a current environment contract before generating an example.');discoveryResults.replaceChildren();candidateResults.replaceChildren();candidateStatus.textContent='';discoveryStatus.textContent='';discoveryEndpoints.replaceChildren();summary.replaceChildren();endpoints.replaceChildren();
  schemas.replaceChildren();evidence.replaceChildren();detail.textContent='';download.hidden=true;document.getElementById('detail-view').textContent='Select an operation to view its details.';document.getElementById('selected-service').textContent='Loading contract';contractStatus.textContent='Loading…';
  try{const params=selection(),body=await fetchJson('/api/contract?'+params);if(generation!==selectionGeneration)return;
    if(body.status!=='resolved'){document.getElementById('selected-service').textContent='No contract available';contractStatus.textContent='Contract state: '+body.status+'. No contract is available here.';return;}
    if(requestedCandidate){const item=requestedCandidate.item;if(requestedCandidate.generation!==corpusGeneration||params.get('repositoryId')!==item.repositoryId||params.get('serviceId')!==item.serviceId||params.get('kind')!=='environment'||params.get('value')!==item.selector.selector.environment||params.get('expectedVersion')!==item.pin.checkpointVersion||!['snapshotId','revision','configFingerprint','checkpointVersion','selectedRevision'].every(field=>body.pin?.[field]===item.pin[field])||body.selector?.repositoryId!==item.repositoryId||body.selector?.serviceId!==item.serviceId||body.selector?.selector?.kind!=='environment'||body.selector.selector.environment!==item.selector.selector.environment||body.selector.selector.expectedCheckpointVersion!==item.pin.checkpointVersion||!body.endpoints.some(endpoint=>endpoint.endpointId===item.endpointId)){contractStatus.textContent='Pinned candidate is stale. Search again.';return;}}
    contractStatus.textContent='Contract available. Analyzed at '+body.analyzedAt+'.';currentResolved={params,body};document.getElementById('selected-service').textContent=params.get('serviceId')+' / '+params.get('value');if(params.get('kind')==='environment'&&body.pin?.checkpointVersion)params.set('expectedVersion',body.pin.checkpointVersion);refreshPresence();
    if(examplesEnabled&&params.get('kind')==='environment'&&body.pin?.checkpointVersion){exampleButton.disabled=false;exampleStatus.textContent='Enter a configured policy ID to generate a synthetic, non-normative example.';}
    else if(examplesEnabled)exampleStatus.textContent='Synthetic examples require a current environment selection with a serving checkpoint.';
    const coverage=document.createElement('p');coverage.textContent='Coverage: '+body.coverage.status+'.';summary.append(coverage);
    if(body.pin?.selectedRevision){const lineage=document.createElement('p');lineage.textContent='Selected revision: '+body.pin.selectedRevision+'. Evidence from revision: '+body.pin.revision+'.';summary.append(lineage);}
    if(runtimeEnabled&&params.get('kind')==='environment'&&body.pin&&body.pin.checkpointVersion){
      const activity=document.createElement('button');activity.type='button';activity.textContent='View runtime activity';
      const runtimeParams=new URLSearchParams({repositoryId:params.get('repositoryId'),serviceId:params.get('serviceId'),
        environment:params.get('value'),expectedCheckpointVersion:body.pin.checkpointVersion,limit:'20'});
      activity.addEventListener('click',()=>showDetail('/api/observations?'+runtimeParams));summary.append(activity);}
    for(const item of body.endpoints){const row=document.createElement('li'),button=document.createElement('button');
      button.type='button';button.className='operation-button';button.dataset.method=item.method;const method=document.createElement('span'),path=document.createElement('span');method.className='method';method.textContent=item.method;path.textContent=item.path;button.append(method,document.createTextNode(' '),path);
      button.addEventListener('click',()=>{for(const operation of endpoints.querySelectorAll('button'))operation.setAttribute('aria-pressed',String(operation===button));showDetail('/api/endpoint?'+params+'&endpointId='+encodeURIComponent(item.endpointId));});
      row.append(button);endpoints.append(row);if(semanticEnabled){const label=document.createElement('label'),check=document.createElement('input');check.type='checkbox';check.name='endpointId';check.value=item.endpointId;check.checked=!candidateEnabled&&!corpusEnabled&&body.endpoints.length<=16;label.append(check,document.createTextNode(item.method+' '+item.path));discoveryEndpoints.append(label);}}
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
exampleForm.addEventListener('submit',async event=>{event.preventDefault();const generation=++exampleGeneration,selectedGeneration=selectionGeneration;exampleResult.textContent='';const selected=currentResolved;if(!examplesEnabled||!selected||selected.params.get('kind')!=='environment'||!selected.body.pin?.checkpointVersion){exampleStatus.textContent='View a current environment contract before generating an example.';return;}const policyId=String(new FormData(exampleForm).get('policyId')||'');exampleStatus.textContent='Generating synthetic example…';try{const body=await fetchJson('/api/examples',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({repositoryId:selected.params.get('repositoryId'),serviceId:selected.params.get('serviceId'),environment:selected.params.get('value'),expectedCheckpointVersion:selected.body.pin.checkpointVersion,policyId})});if(generation!==exampleGeneration||selectedGeneration!==selectionGeneration)return;if(body.status==='withheld'){if(Object.keys(body).sort().join(',')!=='diagnostics,status'||!Array.isArray(body.diagnostics)||body.diagnostics.length>64||!body.diagnostics.every(item=>item&&typeof item==='object'&&!Array.isArray(item)&&Object.keys(item).sort().join(',')==='count,ruleId'&&typeof item.ruleId==='string'&&/^[a-z][a-z0-9_]{0,127}$/.test(item.ruleId)&&Number.isInteger(item.count)&&item.count>0&&item.count<=12000))throw Error('invalid');exampleStatus.textContent='No synthetic example is available for this policy and contract.';return;}const scope=body.scope,pin=selected.body.pin;if(body.status!=='generated'||body.kind!=='synthetic_example'||body.nonNormative!==true||!scope||scope.tenantId!==selected.body.selector?.tenantId||scope.repositoryId!==selected.params.get('repositoryId')||scope.serviceId!==selected.params.get('serviceId')||scope.environment!==selected.params.get('value')||scope.checkpointVersion!==pin.checkpointVersion||scope.snapshotId!==pin.snapshotId||scope.revision!==pin.revision||scope.configFingerprint!==pin.configFingerprint||scope.sourceDigest!==selected.body.sourceDigest||typeof scope.endpointId!=='string'||!selected.body.endpoints.some(item=>item.endpointId===scope.endpointId))throw Error('stale');exampleStatus.textContent='Synthetic, non-normative example for endpoint '+scope.endpointId+'.';exampleResult.textContent=JSON.stringify({scope,value:body.value},null,2);}catch{if(generation===exampleGeneration&&selectedGeneration===selectionGeneration){exampleResult.textContent='';exampleStatus.textContent='Example is unavailable or the selected contract changed. Reload the contract and try again.';}}});
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
  catch{compareStatus.textContent='The comparison is unavailable.';}});`+fieldPresenceScript+corpusDiscoveryScript;


const MAX_JSON_BYTES = 1_000_000;
const MAX_OPENAPI_BYTES = 5_000_000;
const safeId = (value: unknown): value is string => typeof value === "string"
  && /^[^\u0000-\u001f\u007f]{1,512}$/.test(value);
const decimalVersion = (value: string): boolean => /^[1-9][0-9]{0,18}$/.test(value)
  && BigInt(value) <= 9223372036854775807n;
const loadedDocumentIdentifier = (value:unknown):value is string=>typeof value==="string"
  &&/^[A-Za-z0-9_.-]{1,128}$/.test(value);
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
  let code:unknown;
  try{if(failure&&typeof failure==="object"&&!isProxy(failure)){
    const descriptor=Object.getOwnPropertyDescriptor(failure,"code");
    if(descriptor&&"value" in descriptor)code=descriptor.value;
  }}catch{code=undefined;}
  if (code === "QUERY_NOT_FOUND_OR_DENIED") json(response, 404, { error: "NOT_FOUND" });
  else if (code === "QUERY_STALE_SELECTION" || code === "SEMANTIC_STALE_CONTEXT") json(response, 409, { error: "STALE_SELECTION" });
  else if (code === "QUERY_RESULT_LIMIT_EXCEEDED") json(response, 422, { error: "RESULT_LIMIT_EXCEEDED" });
  else if (code === "SEMANTIC_NOT_FOUND_OR_DENIED") json(response, 404, { error: "NOT_FOUND" });
  else if (code === "SEMANTIC_INVALID_REQUEST") json(response, 400, { error: "INVALID_REQUEST" });
  else if (code === "SEMANTIC_REVIEW_CONFLICT") json(response, 409, {error: "REVIEW_CONFLICT"});
  else if (code === "SEMANTIC_STORAGE_ERROR") json(response, 503, { error: "SEMANTIC_UNAVAILABLE" });
  else if (code === "SEMANTIC_CORPUS_INVALID_REQUEST") json(response, 400, {error:"INVALID_REQUEST"});
  else if (code === "SEMANTIC_CORPUS_STALE_CONTEXT") json(response, 409, {error:"STALE_SELECTION"});
  else if (code === "SEMANTIC_CORPUS_UNAVAILABLE") json(response, 503, {error:"SEMANTIC_UNAVAILABLE"});
  else if (code === "EXAMPLE_NOT_FOUND_OR_DENIED") json(response, 404, { error: "NOT_FOUND" });
  else if (code === "EXAMPLE_STALE_CONTEXT") json(response, 409, { error: "STALE_SELECTION" });
  else if (code === "EXAMPLE_INVALID_REQUEST") json(response, 400, { error: "INVALID_REQUEST" });
  else if (code === "EXAMPLE_STORAGE_ERROR") json(response, 503, { error: "EXAMPLE_UNAVAILABLE" });
  else if (code === "FIELD_PRESENCE_QUERY_UNAUTHORIZED") json(response, 404, {error:"NOT_FOUND"});
  else if (code === "FIELD_PRESENCE_QUERY_STALE") json(response, 409, {error:"STALE_SELECTION"});
  else if (code === "FIELD_PRESENCE_QUERY_INVALID_REQUEST") json(response, 400, {error:"INVALID_REQUEST"});
  else if (code === "LOADED_DOCUMENT_READ_UNAUTHORIZED") json(response, 404, {error:"NOT_FOUND"});
  else if (code === "LOADED_DOCUMENT_READ_STALE") json(response, 409, {error:"STALE_SELECTION"});
  else if (code === "INVALID_LOADED_DOCUMENT_READ_REQUEST") json(response, 400, {error:"INVALID_REQUEST"});
  else if (code === "LOADED_DOCUMENT_READ_UNAVAILABLE" || code === "LOADED_DOCUMENT_READ_STORAGE_ERROR")
    json(response,503,{error:"QUERY_UNAVAILABLE"});
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
  return ["snapshotId", "revision", "configFingerprint", "checkpointVersion", "pointerVersion", "selectedRevision"]
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
const validCorpusResult=(input:unknown,principal:PortalPrincipal,environment:string):boolean=>{
  try{
    if(!input||typeof input!=="object"||Array.isArray(input))return false;
    const result=input as Record<string,unknown>;
    if(result.matchMode!=="keyword"||result.scope!=="visible_authorized_services"
      ||result.environment!==environment)return false;
    if(result.status==="unknown")return ["no_visible_services","incomplete_scan","scan_limit"].includes(result.reason as string);
    if(result.status==="no_match")return result.complete===true&&result.truncated===false;
    if(result.status!=="candidates"||!Array.isArray(result.candidates)
      ||result.candidates.length>20||typeof result.complete!=="boolean"
      ||typeof result.truncated!=="boolean")return false;
    return result.candidates.every((candidate:unknown)=>{
      if(!candidate||typeof candidate!=="object"||Array.isArray(candidate))return false;
      const item=candidate as Record<string,unknown>,pin=item.pin as Record<string,unknown>|undefined;
      const selector=item.selector as Record<string,unknown>|undefined;
      const view=selector?.selector as Record<string,unknown>|undefined;
      return safeId(item.repositoryId)&&safeId(item.serviceId)&&safeId(item.endpointId)
        &&pin!==undefined&&Object.getPrototypeOf(pin)===Object.prototype
        &&["snapshotId","revision","configFingerprint","checkpointVersion"].every(key=>Object.hasOwn(pin,key))
        &&Reflect.ownKeys(pin).every(key=>typeof key==="string"&&["snapshotId","revision","configFingerprint","checkpointVersion","selectedRevision"].includes(key))
        &&safeId(pin.snapshotId)&&safeId(pin.revision)
        &&(!Object.hasOwn(pin,"selectedRevision")||typeof pin.selectedRevision==="string"
          &&/^[a-fA-F0-9]{12,128}$/.test(pin.selectedRevision)&&pin.selectedRevision!==pin.revision)
        &&safeId(pin.configFingerprint)&&typeof pin.checkpointVersion==="string"
        &&decimalVersion(pin.checkpointVersion)&&selector?.version==="1"
        &&selector.tenantId===principal.tenantId&&selector.repositoryId===item.repositoryId
        &&selector.serviceId===item.serviceId&&view?.kind==="environment"
        &&view.environment===environment&&view.expectedCheckpointVersion===pin.checkpointVersion;
    });
  }catch{return false;}
};
const summary = (result: Extract<QueryContractResult, { status: "resolved" }>) => ({
  status: "resolved", selector: result.selector, pin: result.pin, publication: result.publication,
  coverage: result.snapshot.coverage, analyzedAt: result.snapshot.created_at,
  sourceDigest: result.snapshot.source.source_digest,
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
const parseCorpusBody=(input:unknown):{environment:string;intentQuery:string;limit:number}|undefined=>{
  if(!input||typeof input!=="object"||Array.isArray(input)
    ||Object.getPrototypeOf(input)!==Object.prototype)return undefined;
  const body=input as Record<string,unknown>;
  const keys=Object.keys(body).sort().join(",");
  if(keys!=="environment,intentQuery"&&keys!=="environment,intentQuery,limit")return undefined;
  if(!safeId(body.environment)||!isSemanticIntentQuerySafe(body.intentQuery))return undefined;
  const options=validateOperationSearchOptions({intentQuery:body.intentQuery,
    ...(Object.hasOwn(body,"limit")?{limit:body.limit}:{})});
  return options?{environment:body.environment,intentQuery:options.intentQuery,limit:options.limit??20}:undefined;
};
const parseCorpusDiscoveryBody=(input:unknown):{environment:string;intentQuery:string;limit:number}|undefined=>{
  if(!input||typeof input!=="object"||Array.isArray(input)||Object.getPrototypeOf(input)!==Object.prototype
    ||Object.keys(input).sort().join(",")!=="environment,intentQuery,limit")return undefined;
  const result=parseCorpusBody(input);
  return result&&result.limit>=1&&result.limit<=16?result:undefined;
};
const parseExampleBody=(input:unknown,principal:PortalPrincipal):
  {selection:QuerySelection;policyId:string}|undefined=>{
  if(!input||typeof input!=="object"||Array.isArray(input)
    ||Object.getPrototypeOf(input)!==Object.prototype)return undefined;
  const body=input as Record<string,unknown>;
  if(Object.keys(body).sort().join(",")!=="environment,expectedCheckpointVersion,policyId,repositoryId,serviceId"
    ||!safeId(body.repositoryId)||!safeId(body.serviceId)||!safeId(body.environment)
    ||typeof body.expectedCheckpointVersion!=="string"||!decimalVersion(body.expectedCheckpointVersion)
    ||typeof body.policyId!=="string"||body.policyId.length>128
    ||!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(body.policyId))return undefined;
  const selected=selection(principal,body.repositoryId,body.serviceId,"environment",
    body.environment,body.expectedCheckpointVersion);
  return selected?{selection:selected,policyId:body.policyId}:undefined;
};

const historyRoutes=["/api/semantic-history","/api/semantic-history/reviews","/api/semantic-history/review"] as const;
const parseHistoryBody=(input:unknown,principal:PortalPrincipal,mode:"history"|"reviews"|"write"):
 {selected:QuerySelection;endpointIds:string[];limit?:number;historyId?:string;request?:SemanticHistoryReviewRequest}|undefined=>{
  try{
    if(!input||typeof input!=="object"||Array.isArray(input)||Object.getPrototypeOf(input)!==Object.prototype)return undefined;
    const body=input as Record<string,unknown>;
    const keys=["repositoryId","serviceId","view","endpointIds",...(mode==="write"?["historyId","decision","expectedVersion"]
      :mode==="reviews"?["historyId","limit"]:["limit"])];
    if(Object.keys(body).sort().join(",")!==keys.sort().join(","))return undefined;
    const parsed=parseDiscoveryBody({repositoryId:body.repositoryId,serviceId:body.serviceId,view:body.view,
      endpointIds:body.endpointIds,intentQuery:"Read private semantic history"},principal);
    if(!parsed)return undefined;
    if(mode==="write")return {...parsed,request:parseSemanticHistoryReview({historyId:body.historyId,
      decision:body.decision,expectedVersion:body.expectedVersion})};
    if(typeof body.limit!=="number"||!Number.isInteger(body.limit)||body.limit<1||body.limit>20)return undefined;
    const historyId=mode==="reviews"?parseSemanticHistoryReview({historyId:body.historyId,decision:"acknowledged",expectedVersion:"0"}).historyId:undefined;
    return {...parsed,limit:body.limit,...(historyId===undefined?{}:{historyId})};
  }catch{return undefined;}
};
/** JSON-only write requests additionally reject browser cross-origin and same-site requests. */
const sameOriginWrite=(request:IncomingMessage,configuredOrigin?:string):boolean=>{
  const site=request.headers["sec-fetch-site"],origin=request.headers.origin;
  if(site!==undefined&&site!=="same-origin"&&site!=="none")return false;
  if(origin===undefined)return true; // Authenticated non-browser clients need not send Origin.
  try{
    const parsed=new URL(origin);
    return (parsed.protocol==="http:"||parsed.protocol==="https:")&&parsed.origin===origin
      &&parsed.origin===(configuredOrigin??`http://${request.headers.host}`);
  }catch{return false;}
};

/** The host supplies authentication. No request header becomes a principal by itself. */
export const createPortalServer = (options: PortalOptions): Server => {
  if (!options || typeof options.authenticate !== "function" || !options.query
    || ["searchServices", "readContract", "compareContracts", "readPublication"].some((name) =>
      typeof options.query[name as keyof PortalOptions["query"]] !== "function"))
    throw new Error("PORTAL_HOST_REQUIRED");
  if(options.semanticHistoryWriteOrigin!==undefined){
    try{
      const origin=new URL(options.semanticHistoryWriteOrigin);
      if(options.semanticHistoryWriteOrigin.length>2048||!["http:","https:"].includes(origin.protocol)
        ||origin.origin!==options.semanticHistoryWriteOrigin)throw new Error();
    }catch{throw new Error("PORTAL_HOST_REQUIRED");}
  }
  const semanticDiscover = typeof options.semantic?.discover === "function"
    ? options.semantic.discover.bind(options.semantic) : undefined;
  const readHistory=typeof options.semanticHistory?.readHistory==="function"
    ?options.semanticHistory.readHistory.bind(options.semanticHistory):undefined;
  const readHistoryReviews=typeof options.semanticHistory?.readHistoryReviews==="function"
    ?options.semanticHistory.readHistoryReviews.bind(options.semanticHistory):undefined;
  const recordHistoryReview=typeof options.semanticHistory?.recordHistoryReview==="function"
    ?options.semanticHistory.recordHistoryReview.bind(options.semanticHistory):undefined;
  const generateExample=typeof options.examples?.generate==="function"
    ? options.examples.generate.bind(options.examples):undefined;
  const readPresence=typeof options.presence?.readForPrincipal==="function"
    ? options.presence.readForPrincipal.bind(options.presence):undefined;
  const readLoadedDocument=typeof options.loadedDocumentVerification?.readForPrincipal==="function"
    ? options.loadedDocumentVerification.readForPrincipal.bind(options.loadedDocumentVerification):undefined;
  const discoverCorpus=typeof options.corpusSemantic?.discoverAcrossServices==="function"
    ? options.corpusSemantic.discoverAcrossServices.bind(options.corpusSemantic):undefined;
  return createServer(async (request, response) => {
    let principal: PortalPrincipal | undefined;
    try { principal = await options.authenticate(request); } catch { /* Fail closed. */ }
    if (!principal || !safeId(principal.tenantId) || !safeId(principal.principalId)) {
      (request.method === "POST" ? jsonClose : json)(response, 401, { error: "NOT_AUTHORIZED" }); return;
    }
    if (!request.url || request.url.length > 2048 || (request.method !== "GET"
      && !(request.method === "POST" && ["/api/discover", "/api/candidates", "/api/corpus-candidates", "/api/corpus-discover", "/api/examples", ...historyRoutes]
        .includes(request.url.split("?", 1)[0]!)))) {
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
        .replace("__CORPUS_DISCOVERY_ENABLED__",String(discoverCorpus !== undefined))
        .replace("__CANDIDATE_ENABLED__", String(typeof options.query.readOperationCandidates === "function"))
        .replace("__CORPUS_ENABLED__", String(typeof options.query.searchOperationCandidatesAcrossServices === "function"))
        .replace("__EXAMPLES_ENABLED__", String(generateExample !== undefined))
        .replace("__PRESENCE_ENABLED__", String(readPresence !== undefined)),
      "text/javascript; charset=utf-8"); return; }
    if (url.pathname === "/style.css") { send(response, 200, style, "text/css; charset=utf-8"); return; }
    try {
      if (url.pathname === "/api/environments") {
        if (url.search.length) { json(response, 400, {error: "INVALID_REQUEST"}); return; }
        const names = options.environments ? await options.environments(Object.freeze({...principal})) : [];
        if (!Array.isArray(names) || names.length > 128 || names.some(name => !safeId(name))) {
          json(response, 503, {error: "QUERY_UNAVAILABLE"}); return;
        }
        json(response, 200, {environments: [...new Set(names)].sort((a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b)))}); return;
      }
      if (["/api/discover", "/api/candidates", "/api/corpus-candidates", "/api/corpus-discover", "/api/examples", ...historyRoutes].includes(url.pathname)) {
        if (url.search.length > 0) { jsonClose(response, 400, {error: "INVALID_REQUEST"}); return; }
        const historyMode=url.pathname===historyRoutes[0]?"history":url.pathname===historyRoutes[1]?"reviews":url.pathname===historyRoutes[2]?"write":undefined;
        const historyPort=historyMode==="history"?readHistory:historyMode==="reviews"?readHistoryReviews:recordHistoryReview;
        const candidate = url.pathname === "/api/candidates";
        const corpus = url.pathname === "/api/corpus-candidates";
        const corpusDiscovery = url.pathname === "/api/corpus-discover";
        const example=url.pathname === "/api/examples";
        if (request.method !== "POST" || (historyMode?historyPort===undefined:corpusDiscovery?discoverCorpus===undefined:example?generateExample===undefined:candidate
          ? typeof options.query.readOperationCandidates !== "function"
          : corpus?typeof options.query.searchOperationCandidatesAcrossServices !== "function"
            : semanticDiscover === undefined)) {
          (request.method === "POST" ? jsonClose : json)(response, 404, {error: "NOT_FOUND"}); return;
        }
        if(historyMode==="write"&&!sameOriginWrite(request,options.semanticHistoryWriteOrigin)){
          jsonClose(response,403,{error:"NOT_AUTHORIZED"});return;
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
        if(historyMode){
          const requestData=parseHistoryBody(body,principal,historyMode);
          if(!requestData){json(response,400,{error:"INVALID_REQUEST"});return;}
          const {selected,endpointIds}=requestData;
          const result=historyMode==="history"?await readHistory!(principal,selected,endpointIds,requestData.limit!)
            :historyMode==="reviews"?await readHistoryReviews!(principal,selected,endpointIds,requestData.historyId!,requestData.limit!)
              :await recordHistoryReview!(principal,selected,endpointIds,requestData.request!);
          json(response,200,result);return;
        }
        if(example){
          const requestData=parseExampleBody(body,principal);
          if(!requestData){json(response,400,{error:"INVALID_REQUEST"});return;}
          json(response,200,await generateExample!(principal,requestData));return;
        }
        if(corpus){
          const requestData=parseCorpusBody(body);
          if(!requestData){json(response,400,{error:"INVALID_REQUEST"});return;}
          const found=await options.query.searchOperationCandidatesAcrossServices!(principal,
            {tenantId:principal.tenantId,...requestData});
          if(!validCorpusResult(found,principal,requestData.environment)){
            json(response,409,{error:"STALE_SELECTION"});return;
          }
          json(response,200,found);return;
        }
        if(corpusDiscovery){
          const requestData=parseCorpusDiscoveryBody(body);
          if(!requestData){json(response,400,{error:"INVALID_REQUEST"});return;}
          json(response,200,await discoverCorpus!(principal,requestData));return;
        }
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
      if(url.pathname==="/api/field-presence"&&readPresence){
        const values=params(url,["repositoryId","serviceId","environment","snapshotId","revision",
          "configFingerprint","checkpointVersion","policyId","ownerPolicyRevision","limit"]);
        const id=(value:unknown)=>typeof value==="string"&&value.length<=128&&/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
        if(!values||!["repositoryId","serviceId","environment","snapshotId","revision","policyId"].every(key=>id(values[key]))
          ||!/^sha256:[0-9a-f]{64}$/.test(values.configFingerprint!)||!decimalVersion(values.checkpointVersion!)
          ||!decimalVersion(values.ownerPolicyRevision!)||!/^(?:[1-9]|[1-9][0-9]|100)$/.test(values.limit!)){
          json(response,400,{error:"INVALID_REQUEST"});return;
        }
        json(response,200,await readPresence(request,principal,{policyId:values.policyId,
          ownerPolicyRevision:values.ownerPolicyRevision,limit:Number(values.limit),expectedPin:{tenantId:principal.tenantId,
            repositoryId:values.repositoryId,serviceId:values.serviceId,environment:values.environment,
            snapshotId:values.snapshotId,revision:values.revision,configFingerprint:values.configFingerprint,
            checkpointVersion:values.checkpointVersion}}));return;
      }
      if(url.pathname==="/api/loaded-document-verification"&&readLoadedDocument){
        const values=params(url,["repositoryId","serviceId","environment","snapshotId","revision",
          "configFingerprint","checkpointVersion","configActivationCheckpoint","loadIdentityDigest"]);
        if(!values||!["repositoryId","serviceId","environment","snapshotId"].every(key=>loadedDocumentIdentifier(values[key]))
          ||!/^[A-Fa-f0-9]{12,128}$/.test(values.revision!)||!/^sha256:[0-9a-f]{64}$/.test(values.configFingerprint!)
          ||!decimalVersion(values.checkpointVersion!)||!decimalVersion(values.configActivationCheckpoint!)
          ||!/^sha256:[0-9a-f]{64}$/.test(values.loadIdentityDigest!)){
          json(response,400,{error:"INVALID_REQUEST"});return;
        }
        json(response,200,await readLoadedDocument(request,principal,{loadIdentityDigest:values.loadIdentityDigest,
          expectedPin:{tenantId:principal.tenantId,repositoryId:values.repositoryId,serviceId:values.serviceId,
            environment:values.environment,snapshotId:values.snapshotId,revision:values.revision,
            configFingerprint:values.configFingerprint,checkpointVersion:values.checkpointVersion},
          configActivationCheckpoint:values.configActivationCheckpoint}));return;
      }
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
