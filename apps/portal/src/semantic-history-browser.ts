/** Optional private history UI; annotation decisions never approve API claims or retained prose. */
export const semanticHistoryMarkup=`<section id="semantic-history" class="card" hidden>
<p class="eyebrow">PRIVATE SEMANTIC HISTORY</p><h2>History and decisions</h2>
<p class="muted">Your archived discovery metadata stays inferred and unreviewed. A decision does not approve semantic prose or establish API behavior.</p>
<form id="history-form"><fieldset id="history-endpoints"><legend>Choose operations for history</legend></fieldset>
<button type="submit" disabled>Read private history</button></form>
<p id="history-status" role="status">View a contract and choose operations.</p><ul id="history-results"></ul>
<div id="history-review" hidden><h3>Metadata decisions</h3><p id="history-review-status" role="status"></p><ul id="history-review-results"></ul>
<form id="history-review-form"><label>Decision<select id="history-decision"><option value="acknowledged">Acknowledged</option><option value="follow_up">Follow up</option><option value="dismissed">Dismissed</option></select></label><button type="submit" disabled>Save decision</button></form></div></section>`;

export const semanticHistoryScript=String.raw`
document.getElementById('synthetic-demo-notice').hidden=!__SYNTHETIC_DEMO_ENABLED__;
const historyEnabled=__HISTORY_ENABLED__,historyReviewsEnabled=__HISTORY_REVIEWS_ENABLED__,historyWriteEnabled=__HISTORY_WRITE_ENABLED__;
const historySection=document.getElementById('semantic-history'),historyForm=document.getElementById('history-form'),historyEndpoints=document.getElementById('history-endpoints'),historyButton=historyForm.querySelector('button'),historyStatus=document.getElementById('history-status'),historyResults=document.getElementById('history-results');
const historyReview=document.getElementById('history-review'),historyReviewForm=document.getElementById('history-review-form'),historySave=historyReviewForm.querySelector('button'),historyDecision=document.getElementById('history-decision'),historyReviewStatus=document.getElementById('history-review-status'),historyReviewResults=document.getElementById('history-review-results');
historySection.hidden=!historyEnabled;historyReviewForm.hidden=!historyWriteEnabled;
let historyGeneration=0,historyReviewGeneration=0,historySelected=null,historyExpectedVersion=null;
const historyKeys=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===[...keys].sort().join(',');
const historyVersion=(value,zero=false)=>typeof value==='string'&&(zero?/^(0|[1-9][0-9]{0,18})$/:/^[1-9][0-9]{0,18}$/).test(value)&&BigInt(value)<=9223372036854775807n;
const historySamePin=(a,b)=>a&&b&&['snapshotId','revision','configFingerprint','pointerVersion','checkpointVersion','selectedRevision'].every(key=>a[key]===b[key]);
const historyView=selected=>{const kind=selected.params.get('kind'),value=selected.params.get('value');return kind==='revision'?{kind,revision:value}:kind==='branch'?{kind,branch:value,expectedPointerVersion:selected.body.pin.pointerVersion}:{kind,environment:value,expectedCheckpointVersion:selected.body.pin.checkpointVersion};};
const historySameView=(a,b)=>a&&b&&Object.keys(b).every(key=>a[key]===b[key])&&Object.keys(a).length===Object.keys(b).length;
const historyReset=message=>{historyGeneration++;historyReviewGeneration++;historySelected=null;historyExpectedVersion=null;historyResults.replaceChildren();historyReviewResults.replaceChildren();historyReview.hidden=true;historySave.disabled=true;historyButton.disabled=!currentResolved;historyStatus.textContent=message;};
const refreshSemanticHistory=()=>{historyReset('Choose between 1 and 16 operations to read private history.');historyEndpoints.replaceChildren();if(!historyEnabled||!currentResolved){historyButton.disabled=true;return;}for(const operation of currentResolved.body.endpoints){const label=document.createElement('label'),check=document.createElement('input');check.type='checkbox';check.value=operation.endpointId;label.append(check,document.createTextNode(operation.method+' '+operation.path));historyEndpoints.append(label);}};
contract.addEventListener('input',()=>{historyReset('Selection changed. View the contract again.');historyEndpoints.replaceChildren();historyButton.disabled=true;});
contract.addEventListener('submit',()=>{historyReset('Loading the selected contract…');historyEndpoints.replaceChildren();historyButton.disabled=true;});
historyEndpoints.addEventListener('input',()=>historyReset('Operations changed. Read history again.'));
const historyPost=async(path,body)=>{const response=await fetch(path,{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify(body)});if(!response.ok)throw Error(response.status===409?'conflict':'unavailable');return response.json();};
const historyBase=selected=>({repositoryId:selected.params.get('repositoryId'),serviceId:selected.params.get('serviceId'),view:historyView(selected),endpointIds:[...historyEndpoints.querySelectorAll('input:checked')].map(input=>input.value)});
const historyFlags=value=>value?.metadataOnly===true&&value.nonNormative===true&&value.verification==='inferred';
const historyRecordValid=(row,id)=>historyKeys(row,['historyId','reviewVersion','expectedVersion','decision','createdAt','metadataOnly','nonNormative','verification'])&&row.historyId===id&&historyVersion(row.reviewVersion)&&historyVersion(row.expectedVersion,true)&&BigInt(row.reviewVersion)===BigInt(row.expectedVersion)+1n&&['acknowledged','follow_up','dismissed'].includes(row.decision)&&typeof row.createdAt==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(row.createdAt)&&historyFlags(row);
const historyLabels={acknowledged:'Acknowledged',follow_up:'Follow up',dismissed:'Dismissed'};
const historyLoadReviews=async(target)=>{
 const generation=++historyReviewGeneration,selectionAtStart=selectionGeneration;
 historyExpectedVersion=null;historySave.disabled=true;historyReviewResults.replaceChildren();historyReviewStatus.textContent='Loading metadata decisions…';
 try{
  const body=await historyPost('/api/semantic-history/reviews',{...target.base,historyId:target.historyId,limit:20});
  if(generation!==historyReviewGeneration||selectionAtStart!==selectionGeneration||historySelected!==target)return;
  if(!historyKeys(body,['historyId','records','truncated','metadataOnly','nonNormative','verification'])||body.historyId!==target.historyId||!historyFlags(body)||!Array.isArray(body.records)||body.records.length>20||typeof body.truncated!=='boolean'||body.truncated&&!body.records.length||!body.records.every(row=>historyRecordValid(row,target.historyId)))throw Error('invalid');
  for(let i=1;i<body.records.length;i++)if(BigInt(body.records[i-1].reviewVersion)!==BigInt(body.records[i].reviewVersion)+1n)throw Error('invalid');
  historyExpectedVersion=body.records[0]?.reviewVersion||'0';
  historySave.disabled=!historyWriteEnabled||BigInt(historyExpectedVersion)>=9223372036854775807n;
  historyReviewStatus.textContent=(body.records.length?'Metadata decisions only.':'No decisions yet. Metadata only.')+(body.truncated?' Older decisions are omitted.':'');
  for(const item of body.records){const row=document.createElement('li');row.textContent=historyLabels[item.decision]+' · version '+item.reviewVersion+' · '+item.createdAt;historyReviewResults.append(row);}
 }catch{if(generation===historyReviewGeneration&&selectionAtStart===selectionGeneration&&historySelected===target){historyExpectedVersion=null;historySave.disabled=true;historyReviewResults.replaceChildren();historyReviewStatus.textContent='Decisions unavailable or owner access denied. Reload decisions before saving.';}}
};
historyForm.addEventListener('submit',async event=>{
 event.preventDefault();historyReset('Loading private history…');const generation=historyGeneration,selectionAtStart=selectionGeneration,selected=currentResolved;
 if(!historyEnabled||!selected){historyStatus.textContent='View a contract first.';return;}
 const base=historyBase(selected);if(base.endpointIds.length<1||base.endpointIds.length>16){historyStatus.textContent='Choose between 1 and 16 operations.';return;}
 if(base.view.kind!=='revision'&&!historyVersion(base.view.expectedPointerVersion||base.view.expectedCheckpointVersion)){historyStatus.textContent='Reload a pinned contract first.';return;}
 try{
  const body=await historyPost('/api/semantic-history',{...base,limit:20});
  if(generation!==historyGeneration||selectionAtStart!==selectionGeneration)return;
  if(body.status!=='resolved'||!historySamePin(body.pin,selected.body.pin)||body.selector?.tenantId!==selected.body.selector?.tenantId||body.selector?.repositoryId!==base.repositoryId||body.selector?.serviceId!==base.serviceId||!historySameView(body.selector?.selector,base.view)||!Array.isArray(body.records)||body.records.length>20||typeof body.truncated!=='boolean')throw Error('stale');
  const ids=new Set();
  for(const item of body.records){if(!historyVersion(item.historyId)||ids.has(item.historyId)||item.verification!=='inferred'||item.review!=='unreviewed'||item.normative!==false||!['suggestions','ambiguous','no_match'].includes(item.result?.status)||!historySamePin(item.provenance?.pin,selected.body.pin)||!historySameView(item.provenance?.selector,base.view)||!Array.isArray(item.requestedEndpointIds)||!item.requestedEndpointIds.length||item.requestedEndpointIds.length>16||new Set(item.requestedEndpointIds).size!==item.requestedEndpointIds.length||!item.requestedEndpointIds.every(id=>base.endpointIds.includes(id)))throw Error('invalid');ids.add(item.historyId);}
  historyStatus.textContent=body.records.length?'Private, inferred, unreviewed history.':'No private history for these operations and this version.';if(body.truncated)historyStatus.textContent+=' Older records are omitted.';
  for(const item of body.records){const row=document.createElement('li'),label=document.createElement('p');label.textContent='History '+item.historyId+' · '+({suggestions:'API suggestions',ambiguous:'Multiple candidates',no_match:'No match'})[item.result.status]+' · '+item.requestedEndpointIds.map(id=>{const operation=selected.body.endpoints.find(item=>item.endpointId===id);return operation?operation.method+' '+operation.path:id;}).join(', ');row.append(label);
   if(historyReviewsEnabled){const button=document.createElement('button');button.type='button';button.textContent='View decisions';button.addEventListener('click',()=>{if(generation!==historyGeneration||selectionAtStart!==selectionGeneration)return;historyReview.hidden=false;historySelected={historyId:item.historyId,base};historyLoadReviews(historySelected);});row.append(button);}historyResults.append(row);}
 }catch{if(generation===historyGeneration&&selectionAtStart===selectionGeneration){historyResults.replaceChildren();historyStatus.textContent='History unavailable or the selected contract changed. Read again.';}}
});
historyReviewForm.addEventListener('submit',async event=>{
 event.preventDefault();const target=historySelected,expectedVersion=historyExpectedVersion;
 if(!historyWriteEnabled||!target||expectedVersion===null||historySave.disabled)return;
 const generation=++historyReviewGeneration,selectionAtStart=selectionGeneration,decision=historyDecision.value;
 historySave.disabled=true;historyExpectedVersion=null;historyReviewStatus.textContent='Saving metadata decision…';
 try{
  const receipt=await historyPost('/api/semantic-history/review',{...target.base,historyId:target.historyId,decision,expectedVersion});
  if(generation!==historyReviewGeneration||selectionAtStart!==selectionGeneration||historySelected!==target)return;
  const {replayed,...record}=receipt;
  if(typeof replayed!=='boolean'||!historyRecordValid(record,target.historyId)||record.expectedVersion!==expectedVersion||record.decision!==decision)throw Error('invalid');
  await historyLoadReviews(target);
 }catch(failure){if(generation===historyReviewGeneration&&selectionAtStart===selectionGeneration&&historySelected===target){historyReviewResults.replaceChildren();historyReviewStatus.textContent=(failure.message==='conflict'?'Decision version changed. ':'Could not confirm the saved decision. ')+'Reload decisions before retrying.';}}
});
`;
