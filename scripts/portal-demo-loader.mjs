import {access} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
// Resolve repository source imports without generating build output.
export async function resolve(specifier,context,nextResolve){
 if(specifier.startsWith('.')&&specifier.endsWith('.js')&&context.parentURL?.startsWith('file:')){
  const candidate=new URL(specifier.slice(0,-3)+'.ts',context.parentURL);
  try{await access(fileURLToPath(candidate));return nextResolve(candidate.href,context);}catch{}
 }
 return nextResolve(specifier,context);
}
