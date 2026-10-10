import type {ContractSnapshot} from '../../../packages/ir/src/index.js';
import type {QuerySelection} from '../../../packages/query/src/index.js';
import type {PortalOptions,PortalPrincipal} from './server.js';

/** Synthetic local fixture adapter. Never use as a production query or authentication host. */
export const createPortalDemoQuery=(snapshot:ContractSnapshot,principal:PortalPrincipal):PortalOptions['query']=>{
 const authorized=(input:unknown)=>input!==null&&typeof input==='object'
   &&(input as PortalPrincipal).tenantId===principal.tenantId&&(input as PortalPrincipal).principalId===principal.principalId;
 const pin={snapshotId:snapshot.snapshot_id,revision:snapshot.source.immutable_revision,configFingerprint:snapshot.config.config_fingerprint};
 return {
  async searchServices(context,input){
   const request=input as {tenantId:string;query:string;environment?:string};
   const matches=authorized(context)&&request.tenantId===principal.tenantId
     &&[snapshot.service.repository_id,snapshot.service.service_id].some(id=>id.toLowerCase().includes(request.query.toLowerCase()))
     &&(request.environment===undefined||request.environment==='uat');
   return {services:matches?[{repositoryId:snapshot.service.repository_id,serviceId:snapshot.service.service_id,
     ...(request.environment===undefined?{}:{environment:{name:'uat',status:'resolved' as const,pin:{...pin,checkpointVersion:'1'},publication:{status:'absent' as const}}})}]:[],truncated:false};
  },
  async readContract(context,input){
   const selection=input as QuerySelection;
   if(!authorized(context)||selection.tenantId!==principal.tenantId||selection.repositoryId!==snapshot.service.repository_id||selection.serviceId!==snapshot.service.service_id)
     throw Object.assign(Error('Unavailable'),{code:'QUERY_NOT_FOUND_OR_DENIED'});
   const view=selection.selector;
   if(view.kind==='branch'||view.kind==='environment'&&view.environment!=='uat'||view.kind==='revision'&&view.revision!==pin.revision)
     return {status:'unknown',selector:selection};
   if(view.kind==='environment'&&view.expectedCheckpointVersion!==undefined&&view.expectedCheckpointVersion!=='1')throw Object.assign(Error('Stale'),{code:'QUERY_STALE_SELECTION'});
   return {status:'resolved',selector:selection,pin:{...pin,...(view.kind==='environment'?{checkpointVersion:'1'}:{})},publication:{status:'absent'},snapshot};
  },
  async compareContracts(){return {status:'unavailable',beforeStatus:'unknown',afterStatus:'unknown'};},
  async readPublication(){throw Object.assign(Error('No demo publication'),{code:'QUERY_NOT_FOUND_OR_DENIED'});},
 };
};
