/** Appended to the portal script; uses its current authorized contract selection. */
export const fieldPresenceScript=`
const presenceEnabled=__PRESENCE_ENABLED__;
const presenceSection=document.getElementById('presence'),presenceForm=document.getElementById('presence-form');
const presenceButton=presenceForm.querySelector('button'),presenceStatus=document.getElementById('presence-status'),presenceResult=document.getElementById('presence-result');
let presenceGeneration=0;
presenceSection.hidden=!presenceEnabled;
const presenceEligible=selected=>presenceEnabled&&selected&&selected.params.get('kind')==='environment'&&selected.body.pin?.checkpointVersion&&!Object.hasOwn(selected.body.pin,'selectedRevision')&&!Object.hasOwn(selected.body.pin,'pointerVersion');
const resetPresence=message=>{presenceGeneration++;presenceButton.disabled=true;presenceResult.textContent='';presenceStatus.textContent=message;};
const refreshPresence=()=>{resetPresence('View a current environment contract to read observed fields.');if(presenceEligible(currentResolved)){presenceButton.disabled=false;presenceStatus.textContent='Enter a configured policy and its version to read observed fields.';}};
contract.addEventListener('input',()=>resetPresence('Selection changed. View the contract again.'));
contract.addEventListener('submit',()=>resetPresence('Loading the selected contract…'));
presenceForm.addEventListener('input',()=>{presenceGeneration++;presenceResult.textContent='';presenceStatus.textContent='Policy changed. Read again to update observed fields.';});
const presenceKeys=(value,required,optional=[])=>value&&typeof value==='object'&&!Array.isArray(value)&&required.every(key=>Object.hasOwn(value,key))&&Object.keys(value).every(key=>required.includes(key)||optional.includes(key));
const presenceId=value=>typeof value==='string'&&value.length<=128&&/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
const presenceVersion=value=>typeof value==='string'&&/^[1-9][0-9]{0,18}$/.test(value)&&BigInt(value)<=9223372036854775807n;
const presenceDigest=value=>typeof value==='string'&&/^sha256:[0-9a-f]{64}$/.test(value);
const presenceUuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const presenceTime=value=>typeof value==='string'&&/^\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d\\.\\d{3}(?:\\d{3})?Z$/.test(value)&&Number.isFinite(Date.parse(value));
const presenceView=(body,selected,policyId,ownerPolicyRevision,limit)=>{
  if(!presenceKeys(body,['status','kind','nonNormative','pin','policy','records','truncated'])||body.status!=='resolved'||body.kind!=='observed_field_presence'||body.nonNormative!==true||typeof body.truncated!=='boolean')throw Error('invalid');
  const expected={tenantId:selected.body.selector?.tenantId,repositoryId:selected.params.get('repositoryId'),serviceId:selected.params.get('serviceId'),environment:selected.params.get('value'),snapshotId:selected.body.pin.snapshotId,revision:selected.body.pin.revision,configFingerprint:selected.body.pin.configFingerprint,checkpointVersion:selected.body.pin.checkpointVersion,sourceDigest:selected.body.sourceDigest};
  if(!presenceKeys(body.pin,Object.keys(expected))||!Object.entries(expected).every(([key,value])=>body.pin[key]===value))throw Error('stale');
  const policy=body.policy;
  if(!presenceKeys(policy,['policyId','ownerPolicyRevision','policyFingerprint','configActivationCheckpoint','endpointId','direction','mediaType','propertyPaths'],['statusCode'])||policy.policyId!==policyId||policy.ownerPolicyRevision!==ownerPolicyRevision||!presenceDigest(policy.policyFingerprint)||!presenceVersion(policy.configActivationCheckpoint)||!presenceId(policy.endpointId)||!selected.body.endpoints.some(item=>item.endpointId===policy.endpointId)||!['request','response'].includes(policy.direction)||typeof policy.mediaType!=='string'||policy.mediaType.length>128||!new RegExp('^application/(?:[a-z0-9.+-]+[+])?json$','i').test(policy.mediaType)||(policy.direction==='request'?Object.hasOwn(policy,'statusCode'):!Number.isInteger(policy.statusCode)||policy.statusCode<100||policy.statusCode>599)||!Array.isArray(policy.propertyPaths)||!policy.propertyPaths.length||policy.propertyPaths.length>32||!policy.propertyPaths.every(path=>typeof path==='string'&&path.startsWith('/')&&path.length<=512)||new Set(policy.propertyPaths).size!==policy.propertyPaths.length)throw Error('invalid');
  if(!Array.isArray(body.records)||body.records.length>limit)throw Error('invalid');
  const records=body.records.map(record=>{
    if(!presenceKeys(record,['importId','recordId','source','scope','fields'])||!presenceUuid(record.importId)||!presenceUuid(record.recordId))throw Error('invalid');
    const source=record.source,scope=record.scope;
    if(!presenceKeys(source,['sourceId','sourceVersion','windowStart','windowEnd','importedAt','expiresAt'])||!presenceId(source.sourceId)||!presenceId(source.sourceVersion)||!['windowStart','windowEnd','importedAt','expiresAt'].every(key=>presenceTime(source[key]))||!presenceKeys(scope,['sourceDigest','endpointId','direction','mediaType'],['statusCode'])||scope.sourceDigest!==expected.sourceDigest||scope.endpointId!==policy.endpointId||scope.direction!==policy.direction||scope.mediaType!==policy.mediaType||scope.statusCode!==policy.statusCode||Object.hasOwn(scope,'statusCode')!==Object.hasOwn(policy,'statusCode'))throw Error('invalid');
    if(!Array.isArray(record.fields)||record.fields.length!==policy.propertyPaths.length||!record.fields.every((field,index)=>presenceKeys(field,['path','state'])&&field.path===policy.propertyPaths[index]&&['present','absent'].includes(field.state)))throw Error('invalid');
    return {importId:record.importId,recordId:record.recordId,source,scope,fields:record.fields};
  });
  return {pin:body.pin,policy,records,truncated:body.truncated};
};
presenceForm.addEventListener('submit',async event=>{
  event.preventDefault();const generation=++presenceGeneration,selectedGeneration=selectionGeneration,selected=currentResolved;presenceResult.textContent='';
  if(!presenceEligible(selected)){presenceStatus.textContent='View a current environment contract to read observed fields.';return;}
  const data=new FormData(presenceForm),policyId=String(data.get('policyId')||''),ownerPolicyRevision=String(data.get('ownerPolicyRevision')||''),limit=Number(data.get('limit'));
  if(!presenceId(policyId)||!presenceVersion(ownerPolicyRevision)||!Number.isInteger(limit)||limit<1||limit>100){presenceStatus.textContent='Enter a valid policy, version and limit.';return;}
  presenceStatus.textContent='Reading observed fields…';
  const params=new URLSearchParams({repositoryId:selected.params.get('repositoryId'),serviceId:selected.params.get('serviceId'),environment:selected.params.get('value'),snapshotId:selected.body.pin.snapshotId,revision:selected.body.pin.revision,configFingerprint:selected.body.pin.configFingerprint,checkpointVersion:selected.body.pin.checkpointVersion,policyId,ownerPolicyRevision,limit:String(limit)});
  try{const body=await fetchJson('/api/field-presence?'+params);if(generation!==presenceGeneration||selectedGeneration!==selectionGeneration)return;const view=presenceView(body,selected,policyId,ownerPolicyRevision,limit);presenceResult.textContent=JSON.stringify(view,null,2);presenceStatus.textContent=view.records.length+' records of observed, non-normative field presence. Absence in a sample does not establish optionality.'+(view.truncated?' More records were omitted by the result limit.':'');}
  catch{if(generation===presenceGeneration&&selectedGeneration===selectionGeneration){presenceResult.textContent='';presenceStatus.textContent='Observed fields are unavailable or the selected contract changed. Reload the contract and try again.';}}
});
`;
