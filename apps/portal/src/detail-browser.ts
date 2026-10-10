/** All source values are rendered as text; source JSON remains available separately. */
export const detailScript=`
const renderDetail=data=>{
 const target=document.getElementById('detail-view');target.replaceChildren();
 const node=(tag,text,className)=>{const element=document.createElement(tag);element.textContent=String(text??'Unknown');if(className)element.className=className;return element;};
 const table=(headers,rows)=>{const element=document.createElement('table'),head=document.createElement('thead'),tr=document.createElement('tr');for(const header of headers)tr.append(node('th',header));head.append(tr);element.append(head);const body=document.createElement('tbody');for(const cells of rows){const row=document.createElement('tr');for(const cell of cells)row.append(node('td',cell));body.append(row);}element.append(body);return element;};
 const schemaType=schema=>schema?.type||schema?.$ref?.split('/').pop()||(schema?.oneOf?'Union':'Unknown');
 if(data.status!=='resolved'){target.append(node('p','No details are available for this contract.'));return;}
 if(data.endpoint){const endpoint=data.endpoint,header=document.createElement('div');header.className='operation-title';header.append(node('span',endpoint.identity?.method,'method'),node('h3',endpoint.application_path));target.append(header);
 target.append(node('h4','Parameters'));const parameters=endpoint.parameters||[];target.append(parameters.length?table(['Name','Location','Type','Presence'],parameters.map(item=>[item.name,item.in,schemaType(item.schema),item.presence?.state||'unknown'])):node('p','No parameters were recorded.'));
 if(endpoint.request_bodies?.length){target.append(node('h4','Request body'));target.append(table(['Media type','Schema','Presence'],endpoint.request_bodies.map(item=>[item.media_type,schemaType(item.schema),item.presence?.state||'unknown'])));}
 target.append(node('h4','Responses'));const responses=endpoint.responses||[];target.append(responses.length?table(['Status','Media type','Schema'],responses.flatMap(response=>(response.content?.length?response.content:[{}]).map(content=>[response.status?.code||response.status?.kind||'unknown',content.media_type||'—',schemaType(content.schema)]))):node('p','No response schema was recorded.'));
 target.append(node('h4','Evidence'));target.append(node('p',(endpoint.evidence_ids||[]).join(', ')||'No source evidence recorded.'));target.append(node('p','Presence reflects recorded evidence. Unknown does not mean optional.'));
 }else if(data.schema){target.append(node('h3',data.schema.schema_id||'Schema'));const schema=data.schema.schema||{},properties=schema.properties||{};target.append(table(['Property','Type','Declared presence'],Object.entries(properties).map(([name,value])=>[name,schemaType(value),Array.isArray(schema.required)&&schema.required.includes(name)?'Required by schema':'Not marked required'])));target.append(node('p','Schema declarations do not prove runtime validation.'));}
 else {target.append(node('h3',data.evidence?'Source evidence':'Runtime activity'));target.append(node('p','Inspect the source JSON below for the complete record.'));document.getElementById('raw-detail').open=true;}
};
`;
