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
