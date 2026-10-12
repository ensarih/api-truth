import {isProxy} from 'node:util/types';
import {parseQuerySelection,type QueryPin} from '../../../packages/query/src/index.js';
import type {ContractSnapshot} from '../../../packages/ir/src/index.js';
import {type SemanticHistoryReviewRecord,type SemanticHistoryRecord} from '../../../packages/semantics/src/index.js';
import {parseSemanticHistoryReview as parseReview} from '../../../packages/semantics/src/reviews.js';
import {SemanticServiceError} from '../../../packages/semantics/src/service.js';
import type {PortalPrincipal} from './server.js';

/** Synthetic loopback preview only. No database, model call, owner authorization or durable storage. */
export const createPortalDemoHistory=(snapshot:ContractSnapshot,principal:PortalPrincipal)=>{
 if(principal.tenantId!=='local-demo'||principal.principalId!=='local-viewer')throw new SemanticServiceError('SEMANTIC_INVALID_REQUEST');
 const endpointIds=new Set(snapshot.endpoints.map(endpoint=>endpoint.endpoint_id));
 if(!endpointIds.has('ep-get'))throw new SemanticServiceError('SEMANTIC_INVALID_REQUEST');
 const basePin=Object.freeze({snapshotId:snapshot.snapshot_id,revision:snapshot.source.immutable_revision,configFingerprint:snapshot.config.config_fingerprint});
 const histories=new Map<string,SemanticHistoryReviewRecord[]>();
 const fail=(code:SemanticServiceError['code']):never=>{throw new SemanticServiceError(code);};
 const scope=(context:unknown,rawSelection:unknown,rawIds:unknown)=>{
  if(!context||typeof context!=='object'||isProxy(context))return fail('SEMANTIC_NOT_FOUND_OR_DENIED');
  const fields=Object.getOwnPropertyDescriptors(context);
  if(Reflect.ownKeys(fields).length!==2||!fields.tenantId||!('value' in fields.tenantId)||!fields.principalId||!('value' in fields.principalId)
    ||fields.tenantId.value!==principal.tenantId||fields.principalId.value!==principal.principalId)return fail('SEMANTIC_NOT_FOUND_OR_DENIED');
  if(!rawSelection||typeof rawSelection!=='object'||isProxy(rawSelection))return fail('SEMANTIC_INVALID_REQUEST');
  const selectorField=Object.getOwnPropertyDescriptor(rawSelection,'selector');
  if(!selectorField||!('value' in selectorField)||isProxy(selectorField.value))return fail('SEMANTIC_INVALID_REQUEST');
  let selection;try{selection=parseQuerySelection(rawSelection);}catch{return fail('SEMANTIC_INVALID_REQUEST');}
  if(selection.tenantId!==principal.tenantId||selection.repositoryId!==snapshot.service.repository_id||selection.serviceId!==snapshot.service.service_id)return fail('SEMANTIC_NOT_FOUND_OR_DENIED');
  const view=selection.selector;let pin:QueryPin=basePin;
  if(view.kind==='environment'){
   if(view.environment!=='uat')return fail('SEMANTIC_NOT_FOUND_OR_DENIED');
   if(view.expectedCheckpointVersion!=='1')return fail('SEMANTIC_STALE_CONTEXT');
   pin=Object.freeze({...basePin,checkpointVersion:'1'});
  }else if(view.kind!=='revision'||view.revision!==basePin.revision)return fail('SEMANTIC_NOT_FOUND_OR_DENIED');
  if(isProxy(rawIds)||!Array.isArray(rawIds)||rawIds.length<1||rawIds.length>16)return fail('SEMANTIC_INVALID_REQUEST');
  const ids:string[]=[];
  for(let i=0;i<rawIds.length;i++){
   const field=Object.getOwnPropertyDescriptor(rawIds,String(i));
   if(!field||!('value' in field)||typeof field.value!=='string'||!endpointIds.has(field.value)||ids.includes(field.value))return fail('SEMANTIC_INVALID_REQUEST');
   ids.push(field.value);
  }
  return {selection,pin,ids,key:JSON.stringify([selection.selector,pin])};
 };
 const limit=(value:unknown):number=>typeof value==='number'&&Number.isInteger(value)&&value>=1&&value<=20?value:fail('SEMANTIC_INVALID_REQUEST');
 const review=(value:unknown)=>{try{return parseReview(value);}catch{return fail('SEMANTIC_INVALID_REQUEST');}};
 const target=(ids:readonly string[],historyId:string)=>{if(historyId!=='1'||!ids.includes('ep-get'))fail('SEMANTIC_NOT_FOUND_OR_DENIED');};
 const flags={metadataOnly:true,nonNormative:true,verification:'inferred'} as const;
 return Object.freeze({
  async readHistory(context:unknown,selection:unknown,endpointIds:unknown,rawLimit:unknown){
   limit(rawLimit);const current=scope(context,selection,endpointIds);
   const record:SemanticHistoryRecord=Object.freeze({historyId:'1',createdAt:snapshot.created_at,verification:'inferred',review:'unreviewed',normative:false,
    requestedEndpointIds:Object.freeze(['ep-get']),result:Object.freeze({status:'no_match'}),
    provenance:Object.freeze({provider:'openai',model:'synthetic-demo-no-model-call',promptVersion:'semantic-discovery-1',selector:current.selection.selector,pin:current.pin})});
   return Object.freeze({status:'resolved' as const,selector:current.selection,pin:current.pin,records:Object.freeze(current.ids.includes('ep-get')?[record]:[]),truncated:false});
  },
  async readHistoryReviews(context:unknown,selection:unknown,endpointIds:unknown,rawHistoryId:unknown,rawLimit:unknown){
   const count=limit(rawLimit),current=scope(context,selection,endpointIds);
   const rows=histories.get(current.key)??[];
   const request=review({historyId:rawHistoryId,decision:'acknowledged',expectedVersion:'0'});target(current.ids,request.historyId);
   return Object.freeze({historyId:'1',records:Object.freeze([...rows].reverse().slice(0,count)),truncated:rows.length>count,...flags});
  },
  async recordHistoryReview(context:unknown,selection:unknown,endpointIds:unknown,input:unknown){
   const request=review(input),current=scope(context,selection,endpointIds);target(current.ids,request.historyId);
   const rows=histories.get(current.key)??[];
   const existing=rows.find(row=>row.expectedVersion===request.expectedVersion);
   if(existing){if(existing.decision!==request.decision)return fail('SEMANTIC_REVIEW_CONFLICT');return Object.freeze({...existing,replayed:true});}
   if(request.expectedVersion!==(rows.at(-1)?.reviewVersion??'0'))return fail('SEMANTIC_REVIEW_CONFLICT');
   if(rows.length>=20)return fail('SEMANTIC_STORAGE_ERROR');
   const row=Object.freeze({historyId:'1',reviewVersion:(BigInt(request.expectedVersion)+1n).toString(),expectedVersion:request.expectedVersion,
    decision:request.decision,createdAt:new Date().toISOString().replace(/(\.\d{3})Z$/,'$1000Z'),...flags});
   rows.push(row);histories.set(current.key,rows);return Object.freeze({...row,replayed:false});
  },
 });
};
