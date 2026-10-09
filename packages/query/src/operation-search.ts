import {isProxy} from "node:util/types";
import {parseContractSnapshot,type Claim,type ContractSnapshot,type Evidence} from "../../ir/src/index.js";
import {parseQuerySelection,type QuerySelection} from "./selector.js";
import type {QueryPin} from "./reader.js";

export type OperationCandidate=Readonly<{endpointId:string;method:string;path:string;label:string;
  evidenceIds:readonly string[];score:number}>;
export type OperationSearchOptions=Readonly<{intentQuery:string;limit?:number}>;
export type OperationSearchResult=
  | Readonly<{status:"candidates";matchMode:"keyword";selector:QuerySelection;pin:QueryPin;candidates:readonly OperationCandidate[];truncated:boolean;complete:boolean}>
  | Readonly<{status:"no_match";matchMode:"keyword";scope:"selected_contract";selector:QuerySelection;pin:QueryPin;truncated:false}>
  | Readonly<{status:"unknown";reason:"invalid_input"|"unresolved_selection"|"incomplete_snapshot"|"no_usable_context"|"scan_limit";
      selector?:QuerySelection;pin?:QueryPin}>;

const MAX_INPUT_BYTES=4*1024*1024,MAX_NODES=100_000,MAX_DEPTH=64,MAX_ENDPOINTS=5_000,MAX_CLAIMS=50_000;
const secretLike=/-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:api[_-]?key|secret|password|token|authorization)\s*[:=]\s*\S+|[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/]+@|\bBearer\s+\S+|\b(?:sk_live_[A-Za-z0-9]+|sk-[A-Za-z0-9_-]{10,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/i;
const safeText=(value:unknown,max=2_048):value is string=>typeof value==="string"&&value.trim().length>0
  &&value.length<=max&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)&&!secretLike.test(value);
const plain=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==="object"&&!Array.isArray(value)
  &&!isProxy(value)&&Object.getPrototypeOf(value)===Object.prototype;
const descriptors=(value:unknown):Record<string,PropertyDescriptor>|undefined=>{
  try{if(!plain(value))return undefined;const result=Object.getOwnPropertyDescriptors(value);
    if(Reflect.ownKeys(result).some(key=>typeof key!=="string"||!("value" in result[key as string]!)))return undefined;
    return result;}catch{return undefined;}
};
const cloneJson=(input:unknown):unknown=>{
  const active=new Set<object>();let nodes=0,bytes=0;
  const add=(value:string)=>{bytes+=Buffer.byteLength(value,"utf8");if(bytes>MAX_INPUT_BYTES)throw new Error();};
  const visit=(value:unknown,depth:number):unknown=>{
    if(++nodes>MAX_NODES||depth>MAX_DEPTH)throw new Error();
    if(typeof value==="string"){if(value.length>65_536)throw new Error();add(value);return value;}
    if(typeof value==="number"){if(!Number.isFinite(value))throw new Error();return value;}
    if(value===null||typeof value==="boolean")return value;
    if(typeof value!=="object"||isProxy(value)||active.has(value))throw new Error();
    active.add(value);const array=Array.isArray(value),proto=Object.getPrototypeOf(value);
    if(array?proto!==Array.prototype:proto!==Object.prototype)throw new Error();
    const keys=Reflect.ownKeys(value);if(keys.length>10_001)throw new Error();
    const entries:Array<[string,unknown]>=[];
    for(const key of keys){if(typeof key!=="string")throw new Error();add(key);
      if(array&&key==="length")continue;
      const descriptor=Object.getOwnPropertyDescriptor(value,key);
      if(!descriptor||!("value" in descriptor))throw new Error();
      entries.push([key,visit(descriptor.value,depth+1)]);
    }
    active.delete(value);
    if(array){if(keys.length-1!==value.length)throw new Error();const output:unknown[]=[];
      for(let index=0;index<entries.length;index++){if(entries[index]?.[0]!==String(index))throw new Error();output.push(entries[index]![1]);}
      return output;}
    return Object.fromEntries(entries);
  };
  return visit(input,0);
};

const termsFor=(value:string):string[]=>{
  const stop=new Set(["a","an","and","are","as","at","by","for","from","how","i","in","is","it","of","on","or","the","to","with"]);
  const terms=value.normalize("NFKC").replace(/([a-z0-9])([A-Z])/g,"$1 $2").toLocaleLowerCase("en-US").match(/[\p{L}\p{N}]+/gu)??[];
  return [...new Set(terms.filter(term=>term.length>1&&!stop.has(term)).slice(0,32))];
};
export const validateOperationSearchOptions=(input:unknown):OperationSearchOptions|undefined=>{
  const props=descriptors(input);if(!props)return undefined;
  const names=Object.keys(props).sort().join(",");if(names!=="intentQuery"&&names!=="intentQuery,limit")return undefined;
  const intentQuery=props.intentQuery?.value,limit=Object.hasOwn(props,"limit")?props.limit!.value:20;
  if(!safeText(intentQuery,512)||/[\r\n]|\b[A-Za-z][A-Za-z0-9+.-]*:(?:\/\/|\S)/i.test(intentQuery)
    ||typeof limit!=="number"||!Number.isInteger(limit)||limit<1||limit>20)return undefined;
  return Object.freeze({intentQuery,limit});
};
const tokenSet=(value:string):Set<string>=>new Set(termsFor(value));
const countMatches=(text:string,terms:readonly string[]):number=>{
  const words=tokenSet(text);return terms.reduce((count,term)=>count+(words.has(term)?1:0),0);
};
const evidenceMatches=(evidence:Evidence|undefined,snapshot:ContractSnapshot,endpointId:string,
  sourceKind:"api_document"|"source_code",method:"type_declaration"|"deterministic_analysis"):boolean=>!!evidence
  &&evidence.source.kind===sourceKind&&evidence.source.source_id===snapshot.source.repository_id
  &&evidence.source_version===snapshot.source.immutable_revision&&evidence.method===method
  &&evidence.scope.service_id===snapshot.service.service_id&&evidence.scope.snapshot_id===snapshot.snapshot_id
  &&evidence.scope.endpoint_id===endpointId&&evidence.scope.revision===snapshot.source.immutable_revision;
const claimEvidence=(claim:Claim,evidenceById:Map<string,Evidence>,snapshot:ContractSnapshot,endpointId:string,
  kind:"api_document"|"source_code",method:"type_declaration"|"deterministic_analysis"):string[]|undefined=>{
  if(claim.subject.service_id!==snapshot.service.service_id||claim.subject.endpoint_id!==endpointId
    ||claim.subject.schema_pointer!==undefined||claim.evidence_ids.length<1||claim.evidence_ids.length>8)return undefined;
  if(kind==="api_document"&&claim.verification!=="declared"
    ||kind==="source_code"&&claim.verification!=="established_by_analysis")return undefined;
  if(!claim.evidence_ids.every(id=>evidenceMatches(evidenceById.get(id),snapshot,endpointId,kind,method)))return undefined;
  return [...claim.evidence_ids];
};
const routingDeclarationEvidence=(claim:Claim,evidenceById:Map<string,Evidence>,snapshot:ContractSnapshot,
  endpointId:string):string[]|undefined=>{
  if(claim.verification!=="declared"||claim.subject.service_id!==snapshot.service.service_id
    ||claim.subject.endpoint_id!==endpointId||claim.subject.schema_pointer!==undefined
    ||claim.evidence_ids.length<2||claim.evidence_ids.length>8)return undefined;
  const entries=claim.evidence_ids.map(id=>evidenceById.get(id));
  if(entries.some(item=>!item||item.source.kind!=="source_code"||item.source.source_id!==snapshot.source.repository_id
    ||item.source_version!==snapshot.source.immutable_revision||item.scope.service_id!==snapshot.service.service_id
    ||item.scope.snapshot_id!==snapshot.snapshot_id||item.scope.endpoint_id!==endpointId
    ||item.scope.revision!==snapshot.source.immutable_revision
    ||(item.method!=="type_declaration"&&item.method!=="deterministic_analysis")))return undefined;
  if(!entries.some(item=>item?.method==="type_declaration")
    ||!entries.some(item=>item?.method==="deterministic_analysis"))return undefined;
  return [...claim.evidence_ids];
};
type SearchInput=Readonly<{snapshot:ContractSnapshot;selector:QuerySelection;pin:QueryPin}>;
const resolvedInput=(input:unknown):SearchInput=>{
  const outer=descriptors(input);
  if(!outer||(Object.keys(outer).length!==4&&Object.keys(outer).length!==5)||Object.keys(outer).some(key=>!(["status","selector","pin","snapshot","publication"] as string[]).includes(key))
    ||outer.status?.value!=="resolved")throw new Error();
  const selector=cloneJson(outer.selector?.value) as QuerySelection;
  const pin=cloneJson(outer.pin?.value) as QueryPin;
  const snapshotInput=cloneJson(outer.snapshot?.value);
  const parsedSelection=parseQuerySelection(selector);
  const parsedSnapshot=parseContractSnapshot(snapshotInput);
  if(!parsedSnapshot.ok)throw new Error();
  const snapshot=parsedSnapshot.value;
  const pinProps=descriptors(pin);
  if(!pinProps||!(["snapshotId","revision","configFingerprint","checkpointVersion"].every(key=>Object.hasOwn(pinProps,key)))
    ||Object.keys(pinProps).length!==4||parsedSelection.selector.kind!=="environment"
    ||!parsedSelection.selector.expectedCheckpointVersion
    ||pin.snapshotId!==snapshot.snapshot_id||pin.revision!==snapshot.source.immutable_revision
    ||pin.configFingerprint!==snapshot.config.config_fingerprint
    ||pin.checkpointVersion!==parsedSelection.selector.expectedCheckpointVersion
    ||parsedSelection.repositoryId!==snapshot.source.repository_id
    ||parsedSelection.repositoryId!==snapshot.service.repository_id
    ||parsedSelection.serviceId!==snapshot.service.service_id)throw new Error();
  return {snapshot,selector:parsedSelection,pin};
};

/** Pure bounded matcher for a caller-authorized resolved environment contract; it does not authorize a read. */
export const searchOperationCandidates=(input:unknown,optionsInput:unknown):OperationSearchResult=>{
  const options=validateOperationSearchOptions(optionsInput);
  if(!options)return {status:"unknown",reason:"invalid_input"};
  const {intentQuery}=options;const limit=options.limit??20;
  let selected:SearchInput;
  try{selected=resolvedInput(input);}catch{
    const outer=descriptors(input);const state=outer?.status?.value;
    return {status:"unknown",reason:!outer?"invalid_input":state==="resolved"?"invalid_input":"unresolved_selection"};
  }
  const {snapshot,selector,pin}=selected;
  const terms=termsFor(intentQuery);if(terms.length===0)return {status:"unknown",reason:"no_usable_context",selector,pin};
  if(snapshot.endpoints.length===0)return {status:"unknown",reason:"no_usable_context",selector,pin};
  if(snapshot.endpoints.length>MAX_ENDPOINTS||snapshot.claims.length>MAX_CLAIMS)return {status:"unknown",reason:"scan_limit",selector,pin};
  const evidenceById=new Map(snapshot.evidence.map(item=>[item.evidence_id,item]));
  const claimsByEndpoint=new Map<string,Claim[]>();
  for(const claim of snapshot.claims){const endpointId=claim.subject.endpoint_id;if(!endpointId)continue;
    const list=claimsByEndpoint.get(endpointId)??[];list.push(claim);claimsByEndpoint.set(endpointId,list);}
  const candidates:OperationCandidate[]=[];
  let hasUsableContext=false;
  let allEndpointsCovered=snapshot.coverage.status==="complete";
  for(const endpoint of snapshot.endpoints){
    let score=0;const cited=new Set<string>();let summaryLabel:string|undefined,descriptionLabel:string|undefined,
      operationIdLabel:string|undefined,pathLabel:string|undefined;let endpointHasContext=false;
    if(!safeText(endpoint.application_path,512)||endpoint.application_path.startsWith("//")){allEndpointsCovered=false;continue;}
    const pathMatches=countMatches(endpoint.application_path,terms);
    const endpointClaims=claimsByEndpoint.get(endpoint.endpoint_id)??[];
    const routeInputs=endpointClaims.filter(claim=>claim.predicate==="route.declaration"||claim.predicate==="route.registration");
    const routeClaims=routeInputs.flatMap(claim=>{
      const doc=claim.predicate==="route.declaration";
      const codeDeclaration=doc&&claim.value&&typeof claim.value==="object"&&!Array.isArray(claim.value)
        &&(claim.value as {controller?:unknown}).controller!==undefined;
      const ids=codeDeclaration?routingDeclarationEvidence(claim,evidenceById,snapshot,endpoint.endpoint_id)
        :claimEvidence(claim,evidenceById,snapshot,endpoint.endpoint_id,
          doc?"api_document":"source_code",doc?"type_declaration":"deterministic_analysis");
      return ids?[{claim,ids,doc,codeDeclaration}]:[];
    });
    const routeUnambiguous=routeInputs.length>0&&routeClaims.length===routeInputs.length&&routeClaims.every(({claim})=>claim.value&&typeof claim.value==="object"
      &&!Array.isArray(claim.value)&&(claim.value as {method?:unknown}).method===endpoint.identity.method
      &&(claim.value as {path?:unknown}).path===endpoint.application_path);
    const pathClaim=routeUnambiguous?routeClaims[0]:undefined;
    if(routeClaims.length>0&&!routeUnambiguous)allEndpointsCovered=false;
    const pathIds=pathClaim?.ids??[];
    if(pathIds.length)for(const id of pathIds)cited.add(id);
    else allEndpointsCovered=false;
    if(pathIds.length){endpointHasContext=true;hasUsableContext=true;}
    if(pathMatches&&pathIds.length){score+=2*pathMatches;pathLabel=endpoint.application_path.slice(0,160);}
    for(const claim of endpointClaims){
      if(claim.predicate==="operation.summary"||claim.predicate==="operation.description"){
        if(!safeText(claim.value))continue;
        const valid=claimEvidence(claim,evidenceById,snapshot,endpoint.endpoint_id,"api_document","type_declaration");
        if(!valid||!valid.every(id=>evidenceById.get(id)?.location.pointer?.endsWith(
          claim.predicate==="operation.summary"?"/summary":"/description")))continue;
        const matches=countMatches(claim.value,terms);endpointHasContext=true;hasUsableContext=true;
        if(matches){score+=(claim.predicate==="operation.summary"?8:3)*matches;for(const id of valid)cited.add(id);
          if(claim.predicate==="operation.summary")summaryLabel??=claim.value.slice(0,160);
          else descriptionLabel??=claim.value.slice(0,160);}
      }else if(claim.predicate==="route.declaration"&&claim.value&&typeof claim.value==="object"&&!Array.isArray(claim.value)){
        const route=routeClaims.find(item=>item.claim===claim);if(!route||!routeUnambiguous)continue;
        endpointHasContext=true;hasUsableContext=true;const value=claim.value as {operationId?:unknown;controller?:unknown;action?:unknown};
        const operationId=value.operationId;
        if(!route.codeDeclaration&&safeText(operationId,128)){const matches=countMatches(operationId,terms);if(matches){score+=5*matches;for(const id of route.ids)cited.add(id);
          operationIdLabel??=operationId.slice(0,160);}}
        if(route.codeDeclaration){
          const controller=value.controller,action=value.action;
          if(safeIdentifier(controller)&&safeIdentifier(action)){
            const matches=countMatches(`${controller} ${action}`,terms);
            if(matches){score+=2*matches;for(const id of route.ids)cited.add(id);}
          }
        }
      }else if(claim.predicate==="route.registration"&&claim.value&&typeof claim.value==="object"&&!Array.isArray(claim.value)){
        if(routeClaims.some(item=>item.claim===claim)&&routeUnambiguous){endpointHasContext=true;hasUsableContext=true;}
      }else if(claim.predicate==="handler.symbol"&&claim.value&&typeof claim.value==="object"&&!Array.isArray(claim.value)){
        const valid=claimEvidence(claim,evidenceById,snapshot,endpoint.endpoint_id,"source_code","deterministic_analysis");
        if(!valid)continue;const symbol=(claim.value as {symbol?:unknown}).symbol;
        if(safeText(symbol,128)){endpointHasContext=true;hasUsableContext=true;
          const matches=countMatches(symbol,terms);if(matches){score+=2*matches;for(const id of valid)cited.add(id);}}
      }
    }
    if(!endpointHasContext||!pathIds.length)allEndpointsCovered=false;
    if(endpointHasContext&&score>0&&pathIds.length){
      candidates.push({endpointId:endpoint.endpoint_id,method:endpoint.identity.method,path:endpoint.application_path,
        label:summaryLabel??descriptionLabel??operationIdLabel??pathLabel??`${endpoint.identity.method} operation`,
        evidenceIds:[...cited].sort(),score});
    }
  }
  const complete=allEndpointsCovered;
  if(!hasUsableContext)return {status:"unknown",reason:"no_usable_context",selector,pin};
  candidates.sort((left,right)=>right.score-left.score||Buffer.compare(Buffer.from(left.endpointId),Buffer.from(right.endpointId)));
  if(candidates.length===0)return complete?{status:"no_match",matchMode:"keyword",scope:"selected_contract",selector,pin,truncated:false}
    :{status:"unknown",reason:"incomplete_snapshot",selector,pin};
  return {status:"candidates",matchMode:"keyword",selector,pin,candidates:candidates.slice(0,limit),truncated:candidates.length>limit,complete};
};
const safeIdentifier=(value:unknown):value is string=>typeof value==="string"&&value.length<=128
  &&/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value)&&!secretLike.test(value);
