import {expect,test,vi} from "vitest";
import {createGitHubCurrentStateReader,GitHubCurrentStateError,type GitHubCurrentStateBinding,
  type GitHubExactBranchRequest}
  from "../../connectors/reference/src/github-current-state.js";

const shaA="a".repeat(40),shaB="b".repeat(40);
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,
  headers:{"content-type":"application/json"}});
const repo=()=>json({id:42,full_name:"sample/api"});
const ref=(branch:string,sha=shaB)=>json({ref:`refs/heads/${branch}`,object:{type:"commit",sha}});
const binding=(fetchImpl:typeof fetch)=>({tenantId:"tenant",repositoryId:"repo",githubRepositoryId:42,
  fullName:"sample/api",intendedBranches:["main","release/1"],resolveToken:vi.fn(async()=>"synthetic-token"),
  fetch:fetchImpl,timeoutMs:1000,maxResponseBytes:16_384});
const target=(branch="main")=>({tenantId:"tenant",repositoryId:"repo",branch});

test("reads only an explicitly configured exact branch and returns an orderless immutable commit",async()=>{
  const calls:string[]=[];
  const transport=vi.fn(async(input:string|URL|Request,init?:RequestInit)=>{
    const url=String(input);calls.push(url);
    expect(init?.method).toBe("GET");expect(init?.redirect).toBe("error");
    expect((init?.headers as Record<string,string>)["Authorization"]).toBe("Bearer synthetic-token");
    expect((init?.headers as Record<string,string>)["X-GitHub-Api-Version"]).toBe("2026-03-10");
    return url.endsWith("/repos/sample/api")?repo():ref("release/1");
  }) as typeof fetch;
  const host=binding(transport);
  const reader=createGitHubCurrentStateReader(host);
  const result=await reader.readExactBranch(target("release/1"));
  expect(result).toEqual({state:"present",immutableRevision:shaB,
    providerEvidence:{provider:"github",provider_reference:`ref:42:release/1:${shaB}`}});
  expect(calls).toEqual(["https://api.github.com/repos/sample/api",
    "https://api.github.com/repos/sample/api/git/ref/heads/release/1"]);
  expect(host.resolveToken).toHaveBeenCalledOnce();
  expect(JSON.stringify(result)).not.toContain("synthetic-token");
});

test("404 remains unknown even after repository identity is confirmed",async()=>{
  const transport=vi.fn(async(input:string|URL|Request)=>String(input).endsWith("/repos/sample/api")
    ?repo():new Response("not found",{status:404})) as typeof fetch;
  const result=await createGitHubCurrentStateReader(binding(transport)).readExactBranch(target());
  expect(result).toEqual({state:"unknown",reason:"unconfirmed_absence"});
  expect(transport).toHaveBeenCalledTimes(2);
});

test("optional comparison proves only ancestry between two immutable SHAs",async()=>{
  const transport=vi.fn(async(input:string|URL|Request)=>{
    const url=String(input);
    if(url.endsWith("/repos/sample/api"))return repo();
    if(url.includes("/git/ref/heads/"))return ref("main");
    if(url.includes("/compare/"))return json({status:"ahead",ahead_by:1,behind_by:0,
      base_commit:{sha:shaA},head_commit:{sha:shaB}});
    throw new Error("unexpected request");
  }) as typeof fetch;
  const result=await createGitHubCurrentStateReader(binding(transport)).readExactBranch({...target(),compareWithRevision:shaA});
  expect(result).toMatchObject({state:"present",immutableRevision:shaB,
    ancestry:{baseRevision:shaA,headRevision:shaB,relation:"ahead"}});
  expect(JSON.stringify(result)).not.toMatch(/sequence|timestamp|effective_order/);
  expect(transport).toHaveBeenCalledTimes(3);
});

test("a mismatched immutable comparison base is rejected",async()=>{
  const transport=vi.fn(async(input:string|URL|Request)=>{
    const url=String(input);
    return url.endsWith("/repos/sample/api")?repo():url.includes("/git/ref/heads/")?ref("main")
      :json({status:"ahead",ahead_by:1,behind_by:0,base_commit:{sha:shaB}});
  }) as typeof fetch;
  await expect(createGitHubCurrentStateReader(binding(transport))
    .readExactBranch({...target(),compareWithRevision:shaA}))
    .rejects.toThrow("GITHUB_CURRENT_STATE_INVALID_RESPONSE");
});

test.each([
  ["identical with a different head","identical",0,0,shaB,false],
  ["identical with nonzero counts","identical",1,0,shaA,false],
  ["ahead without commits","ahead",0,0,shaB,false],
  ["ahead with commits behind","ahead",1,1,shaB,false],
  ["ahead with the same head","ahead",1,0,shaA,false],
  ["behind with commits ahead","behind",1,1,shaB,false],
  ["diverged without behind commits","diverged",1,0,shaB,false],
  ["valid identical","identical",0,0,shaA,true],
  ["valid behind","behind",0,1,shaB,true],
  ["valid diverged","diverged",1,1,shaB,true],
] as const)("comparison %s must have consistent counts and identity",async(_label,status,ahead_by,behind_by,head,valid)=>{
  const transport=vi.fn(async(input:string|URL|Request)=>{
    const url=String(input);
    return url.endsWith("/repos/sample/api")?repo():url.includes("/git/ref/heads/")?ref("main",head)
      :json({status,ahead_by,behind_by,base_commit:{sha:shaA}});
  }) as typeof fetch;
  const result=createGitHubCurrentStateReader(binding(transport))
    .readExactBranch({...target(),compareWithRevision:shaA});
  if(valid)await expect(result).resolves.toMatchObject({state:"present",ancestry:{baseRevision:shaA,headRevision:head,relation:status}});
  else await expect(result).rejects.toThrow("GITHUB_CURRENT_STATE_INVALID_RESPONSE");
});

test("an optional conflicting comparison head is rejected",async()=>{
  const transport=vi.fn(async(input:string|URL|Request)=>{
    const url=String(input);
    return url.endsWith("/repos/sample/api")?repo():url.includes("/git/ref/heads/")?ref("main")
      :json({status:"ahead",ahead_by:1,behind_by:0,base_commit:{sha:shaA},head_commit:{sha:shaA}});
  }) as typeof fetch;
  await expect(createGitHubCurrentStateReader(binding(transport))
    .readExactBranch({...target(),compareWithRevision:shaA}))
    .rejects.toThrow("GITHUB_CURRENT_STATE_INVALID_RESPONSE");
});

test.each([404,403] as const)("streaming %s response is cancelled without reading its body",async(status)=>{
  let cancelled=false;
  const body=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new Uint8Array([1]));},
    cancel(){cancelled=true;}});
  const transport=vi.fn(async(input:string|URL|Request)=>String(input).endsWith("/repos/sample/api")
    ?repo():new Response(body,{status})) as typeof fetch;
  const result=createGitHubCurrentStateReader(binding(transport)).readExactBranch(target());
  if(status===404)await expect(result).resolves.toEqual({state:"unknown",reason:"unconfirmed_absence"});
  else await expect(result).rejects.toThrow("GITHUB_CURRENT_STATE_UNAVAILABLE");
  await vi.waitFor(()=>expect(cancelled).toBe(true));
});

test("unconfigured or forged scope rejects before credential resolution or network",async()=>{
  const transport=vi.fn(async()=>repo()) as typeof fetch;
  const host=binding(transport),reader=createGitHubCurrentStateReader(host);
  for(const input of [target("other"),{...target(),tenantId:"other"},
    {...target(),repositoryId:"other"},{...target(),branch:"../main"}])
    await expect(reader.readExactBranch(input)).rejects.toThrow("GITHUB_CURRENT_STATE_INVALID_REQUEST");
  expect(host.resolveToken).not.toHaveBeenCalled();expect(transport).not.toHaveBeenCalled();
});

test.each([
  ["repository identity",json({id:99,full_name:"sample/api"}),"GITHUB_CURRENT_STATE_INVALID_RESPONSE"],
  ["repository denial",new Response("private",{status:404}),"GITHUB_CURRENT_STATE_UNAVAILABLE"],
  ["redirect",new Response(null,{status:302,headers:{location:"https://example.test/leak"}}),"GITHUB_CURRENT_STATE_UNAVAILABLE"],
] as const)("%s failure is fixed and does not query a branch",async(_name,response,code)=>{
  const transport=vi.fn(async()=>response) as typeof fetch;
  const host=binding(transport);
  await expect(createGitHubCurrentStateReader(host).readExactBranch(target())).rejects.toThrow(code);
  expect(transport).toHaveBeenCalledOnce();
});

test.each([
  ["wrong ref",ref("other")],
  ["tag object",json({ref:"refs/heads/main",object:{type:"tag",sha:shaB}})],
  ["bad SHA",json({ref:"refs/heads/main",object:{type:"commit",sha:"short"}})],
] as const)("%s never becomes a present branch",async(_name,bad)=>{
  const transport=vi.fn(async(input:string|URL|Request)=>String(input).endsWith("/repos/sample/api")?repo():bad) as typeof fetch;
  await expect(createGitHubCurrentStateReader(binding(transport)).readExactBranch(target()))
    .rejects.toThrow("GITHUB_CURRENT_STATE_INVALID_RESPONSE");
});

test("oversize and duplicate-key provider JSON fail with fixed errors",async()=>{
  const huge=()=>new Response(`{"id":42,"full_name":"sample/api","unused":"${"X".repeat(20_000)}"}`,{status:200});
  const duplicate=()=>new Response('{"id":42,"id":99,"full_name":"sample/api"}',{status:200});
  for(const [response,code] of [[huge(),"GITHUB_CURRENT_STATE_RESPONSE_TOO_LARGE"],
    [duplicate(),"GITHUB_CURRENT_STATE_INVALID_RESPONSE"]] as const){
    const transport=vi.fn(async()=>response) as typeof fetch;
    try{await createGitHubCurrentStateReader(binding(transport)).readExactBranch(target());throw new Error("expected rejection");}
    catch(error){expect(error).toBeInstanceOf(GitHubCurrentStateError);expect(String(error)).toContain(code);
      expect(String(error)).not.toContain("XXXXX");}
  }
});

test("hostile accessors and proxies do not run before validation",async()=>{
  const transport=vi.fn(async()=>repo()) as typeof fetch;
  const host=binding(transport),reader=createGitHubCurrentStateReader(host);
  const accessor={...target(),get branch(){throw new Error("PRIVATE_GETTER_CANARY");}};
  await expect(reader.readExactBranch(accessor as unknown as GitHubExactBranchRequest))
    .rejects.toThrow("GITHUB_CURRENT_STATE_INVALID_REQUEST");
  await expect(reader.readExactBranch(new Proxy(target(),{}))).rejects.toThrow("GITHUB_CURRENT_STATE_INVALID_REQUEST");
  expect(host.resolveToken).not.toHaveBeenCalled();expect(transport).not.toHaveBeenCalled();
});

test("constructor detaches branch selection and transport references",async()=>{
  const original=vi.fn(async(input:string|URL|Request)=>String(input).endsWith("/repos/sample/api")?repo():ref("main")) as typeof fetch;
  const changed=vi.fn(async()=>new Response("private",{status:403})) as typeof fetch;
  const host=binding(original),reader=createGitHubCurrentStateReader(host);
  host.intendedBranches.push("other");host.resolveToken=vi.fn(async()=>"changed-token");host.fetch=changed;
  await expect(reader.readExactBranch(target("other"))).rejects.toThrow("GITHUB_CURRENT_STATE_INVALID_REQUEST");
  await expect(reader.readExactBranch(target())).resolves.toMatchObject({state:"present",immutableRevision:shaB});
  expect(original).toHaveBeenCalledTimes(2);expect(changed).not.toHaveBeenCalled();
});

test("constructor rejects hostile accessors and duplicate branch configuration",()=>{
  const transport=vi.fn(async()=>repo()) as typeof fetch;
  const hostile={...binding(transport),get fullName(){throw new Error("PRIVATE_CONFIGURATION_CANARY");}};
  expect(()=>createGitHubCurrentStateReader(hostile as unknown as GitHubCurrentStateBinding))
    .toThrow("GITHUB_CURRENT_STATE_INVALID_CONFIGURATION");
  expect(()=>createGitHubCurrentStateReader({...binding(transport),intendedBranches:["main","main"]}))
    .toThrow("GITHUB_CURRENT_STATE_INVALID_CONFIGURATION");
  expect(transport).not.toHaveBeenCalled();
});

test("total deadline covers a stalled credential resolver",async()=>{
  const transport=vi.fn(async()=>repo()) as typeof fetch;
  const host=binding(transport);
  host.timeoutMs=5;host.resolveToken=vi.fn(()=>new Promise<string>(()=>{}));
  await expect(createGitHubCurrentStateReader(host).readExactBranch(target()))
    .rejects.toThrow("GITHUB_CURRENT_STATE_TIMEOUT");
  expect(transport).not.toHaveBeenCalled();
});

test("total deadline covers a stalled transport",async()=>{
  const transport=vi.fn(()=>new Promise<Response>(()=>{})) as typeof fetch;
  const host=binding(transport);host.timeoutMs=5;
  await expect(createGitHubCurrentStateReader(host).readExactBranch(target()))
    .rejects.toThrow("GITHUB_CURRENT_STATE_TIMEOUT");
  expect(transport).toHaveBeenCalledOnce();
});
