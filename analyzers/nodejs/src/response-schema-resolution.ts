export type ResponseSchemaResolution = {kind:"resolved"; schema:unknown; pointers:string[]} | {kind:"unresolved"; pointers:string[]};
/** Resolve only contained Swagger definition references; never load files or URLs. */
export function resolveResponseSchema(schema: unknown, definitions: unknown): ResponseSchemaResolution {
  const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==="object"&&!Array.isArray(value);
  const pointers=new Set<string>(), active=new Set<string>();
  let nodes=0;
  const visit=(value:unknown,depth:number):unknown=>{
    if(++nodes>10000||depth>64||!object(value))throw new Error("Unsupported schema");
    if(Object.hasOwn(value,"$ref")){
      if(Object.keys(value).length!==1||typeof value.$ref!=="string"||!value.$ref.startsWith("#/definitions/"))throw new Error("Unsupported reference");
      const component=value.$ref.slice("#/definitions/".length);
      if(!component||component.includes("/")||component.includes("%")||/~(?![01])/.test(component))throw new Error("Unsupported pointer");
      const name=component.replaceAll("~1","/").replaceAll("~0","~");
      if(["__proto__","prototype","constructor"].includes(name)||!object(definitions)||!Object.hasOwn(definitions,name)||active.has(name))throw new Error("Unresolved definition");
      const pointer=`/definitions/${component}`;
      pointers.add(pointer);
      if(pointers.size>128)throw new Error("Reference limit");
      active.add(name);
      const resolved=visit(definitions[name],depth+1);
      active.delete(name);
      return resolved;
    }
    const result:Record<string,unknown>={...value};
    if(value.allOf!==undefined){
      if(!Array.isArray(value.allOf)||value.allOf.length===0||value.allOf.length>32)throw new Error("Unsupported composition");
      result.allOf=value.allOf.map(child=>visit(child,depth+1));
    }
    if(value.properties!==undefined){
      if(!object(value.properties))throw new Error("Unsupported properties");
      const properties:Record<string,unknown>={};
      for(const [name,child] of Object.entries(value.properties)){
        if(["__proto__","prototype","constructor"].includes(name))throw new Error("Unsupported property");
        properties[name]=visit(child,depth+1);
      }
      result.properties=properties;
    }
    if(value.items!==undefined)result.items=visit(value.items,depth+1);
    return result;
  };
  try{return {kind:"resolved",schema:visit(schema,0),pointers:[...pointers].sort()};}
  catch{return {kind:"unresolved",pointers:[...pointers].sort()};}
}

export type ResponseObjectResolution = {kind:"resolved"; response:Record<string,unknown>; pointers:string[]; terminalPointer?:string} | {kind:"unresolved"; pointers:string[]};
/** Local reusable response objects are resolved separately from schema definitions. */
export function resolveResponseObject(response:unknown,responses:unknown):ResponseObjectResolution {
  const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==="object"&&!Array.isArray(value);
  const pointers=new Set<string>(),active=new Set<string>();
  let terminalPointer:string|undefined;
  let value=response;
  for(let depth=0;depth<=64;depth++){
    if(!object(value))return {kind:"unresolved",pointers:[...pointers].sort()};
    if(!Object.hasOwn(value,"$ref")){
      const allowed=new Set(["description","schema","headers","examples"]);
      if(typeof value.description!=="string"||Object.keys(value).some(key=>!allowed.has(key)&&!key.startsWith("x-"))
        ||value.headers!==undefined&&!object(value.headers)||value.examples!==undefined&&!object(value.examples))break;
      return {kind:"resolved",response:value,pointers:[...pointers].sort(),...(terminalPointer?{terminalPointer}:{})};
    }
    if(Object.keys(value).length!==1||typeof value.$ref!=="string"||!value.$ref.startsWith("#/responses/"))break;
    const component=value.$ref.slice("#/responses/".length);
    if(!component||component.includes("/")||component.includes("%")||/~(?![01])/.test(component))break;
    const name=component.replaceAll("~1","/").replaceAll("~0","~");
    if(["__proto__","prototype","constructor"].includes(name)||!object(responses)||!Object.hasOwn(responses,name)||active.has(name))break;
    active.add(name);terminalPointer=`/responses/${component}`;pointers.add(terminalPointer);
    value=responses[name];
  }
  return {kind:"unresolved",pointers:[...pointers].sort()};
}
