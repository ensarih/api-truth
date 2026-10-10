import {describe,expect,it,vi} from "vitest";
import type {PoolClient,Pool} from "pg";
import {parseSemanticHistoryReview,recordSemanticHistoryReview,readSemanticHistoryReviews,
  SemanticHistoryReviewError} from "../../packages/semantics/src/reviews.js";
import {applySemanticHistoryMigrations} from "../../packages/semantics/src/migrations.js";
import type {SemanticHistoryRecord,SemanticHistoryScope} from "../../packages/semantics/src/history.js";

const invalid="SEMANTIC_HISTORY_REVIEW_INVALID",conflict="SEMANTIC_HISTORY_REVIEW_CONFLICT",
  storage="SEMANTIC_HISTORY_REVIEW_STORAGE";
const request={historyId:"17",decision:"acknowledged",expectedVersion:"0"} as const;
const scope:SemanticHistoryScope={tenantId:"tenant",principalId:"principal",
  selection:{version:"1",tenantId:"tenant",repositoryId:"repo",serviceId:"service",selector:{kind:"revision",revision:"revision"}},
  pin:{snapshotId:"snapshot",revision:"revision",configFingerprint:"fingerprint"},
  configurationHash:`sha256:${"0".repeat(64)}`,provider:"openai",model:"fixture-model",endpointIds:["endpoint"]};
const history:SemanticHistoryRecord={historyId:"17",createdAt:"2026-01-01T00:00:00.123456Z",
  verification:"inferred",review:"unreviewed",normative:false,result:{status:"no_match"},
  requestedEndpointIds:["endpoint"],provenance:{provider:"openai",model:"fixture-model",
    promptVersion:"semantic-discovery-1",selector:scope.selection.selector,pin:scope.pin}};
const errorCode=(fn:()=>unknown,code:string)=>{
  try{fn();throw new Error("accepted invalid value");}catch(error){
    expect(error).toBeInstanceOf(SemanticHistoryReviewError);expect((error as SemanticHistoryReviewError).code).toBe(code);
  }
};
const fixture=()=>{
  let rows:Record<string,unknown>[]=[];
  const query=vi.fn(async(sql:string,values?:unknown[])=>{
    if(sql.includes("INSERT INTO semantic_history_reviews")){
      const row={review_version:values![3],expected_version:values![4],decision:values![5],
        record_sha256:values![6],created_at:"2026-01-01T00:00:00.123456Z"};rows.push(row);return {rows:[row]};
    }
    if(sql.includes("FROM semantic_history_reviews"))return {rows:sql.includes("AND expected_version=")
      ?rows.filter(row=>row.expected_version===values![3]):[...rows].reverse().slice(0,sql.includes("LIMIT 1")?1:Number(values![3]))};
    return {rows:[]};
  });
  return {client:{query} as unknown as PoolClient,query,rows,setRows:(value:Record<string,unknown>[])=>{rows=value;}};
};

describe("semantic history review parsing",()=>{
  it("accepts only bounded canonical metadata and returns an immutable copy",()=>{
    for(const decision of ["acknowledged","follow_up","dismissed"]){
      const input={...request,decision};const parsed=parseSemanticHistoryReview(input);
      expect(parsed).toEqual(input);expect(Object.isFrozen(parsed)).toBe(true);expect(parsed).not.toBe(input);
    }
    expect(parseSemanticHistoryReview({...request,historyId:"9223372036854775807",
      expectedVersion:"9223372036854775806"})).toBeTruthy();
    expect(parseSemanticHistoryReview(Object.assign(Object.create(null),request))).toEqual(request);
  });
  it.each([null,[],"review",{...request,decision:"approved"},{...request,historyId:"0"},
    {...request,historyId:"01"},{...request,historyId:17},{...request,historyId:"9223372036854775808"},
    {...request,expectedVersion:"-1"},{...request,expectedVersion:"00"},
    {...request,expectedVersion:"9223372036854775807"},{...request,expectedVersion:"9223372036854775808"},
    {...request,prose:"private"},{...request,tenantId:"other"},{...request,[Symbol("spoof")]:true}])(
    "rejects invalid or extra input %#",input=>errorCode(()=>parseSemanticHistoryReview(input),invalid));
  it("does not invoke getters or proxy traps, including revoked proxies",()=>{
    const getter=vi.fn(()=>"17"),trap=vi.fn(()=>{throw new Error("sensitive");});
    const accessor={...request};Object.defineProperty(accessor,"historyId",{get:getter,enumerable:true});
    const proxy=new Proxy({...request},{ownKeys:trap,get:trap,getPrototypeOf:trap});
    const revoked=Proxy.revocable({...request},{});revoked.revoke();
    for(const input of [accessor,proxy,revoked.proxy,Object.create(request)])
      errorCode(()=>parseSemanticHistoryReview(input),invalid);
    expect(getter).not.toHaveBeenCalled();expect(trap).not.toHaveBeenCalled();
  });
});

describe("semantic history review storage",()=>{
  it("appends metadata, preserves UTC microseconds, replays identically, and conflicts on changed decisions",async()=>{
    const f=fixture();const first=await recordSemanticHistoryReview(f.client,scope,history,parseSemanticHistoryReview(request));
    expect(first).toMatchObject({historyId:"17",reviewVersion:"1",expectedVersion:"0",decision:"acknowledged",
      createdAt:"2026-01-01T00:00:00.123456Z",metadataOnly:true,nonNormative:true,verification:"inferred",replayed:false});
    const replay=await recordSemanticHistoryReview(f.client,scope,history,parseSemanticHistoryReview(request));
    expect(replay).toEqual({...first,replayed:true});
    await expect(recordSemanticHistoryReview(f.client,scope,history,
      parseSemanticHistoryReview({...request,decision:"dismissed"}))).rejects.toMatchObject({code:conflict});
    expect(f.query.mock.calls.filter(([sql])=>sql.includes("INSERT INTO semantic_history_reviews"))).toHaveLength(1);
    const inserted=f.query.mock.calls.find(([sql])=>sql.includes("INSERT INTO semantic_history_reviews"))!;
    expect(inserted[1]).toHaveLength(7);expect(JSON.stringify(inserted[1])).not.toContain("private");
    expect(f.query.mock.calls[0]![0]).toContain("pg_advisory_xact_lock");
  });
  it("requires the current version and rejects history mismatch before querying",async()=>{
    const f=fixture();await expect(recordSemanticHistoryReview(f.client,scope,history,
      parseSemanticHistoryReview({...request,expectedVersion:"1"}))).rejects.toMatchObject({code:conflict});
    f.query.mockClear();await expect(recordSemanticHistoryReview(f.client,scope,history,
      parseSemanticHistoryReview({...request,historyId:"18"}))).rejects.toMatchObject({code:invalid});
    expect(f.query).not.toHaveBeenCalled();
  });
  it("replays an older exact decision and remains stable under broader authorized endpoint selections",async()=>{
    const f=fixture();const first=await recordSemanticHistoryReview(f.client,scope,history,parseSemanticHistoryReview(request));
    await recordSemanticHistoryReview(f.client,scope,history,parseSemanticHistoryReview({...request,expectedVersion:"1",decision:"follow_up"}));
    const broader={...scope,endpointIds:["endpoint","additional"]};
    expect(await recordSemanticHistoryReview(f.client,broader,history,parseSemanticHistoryReview(request)))
      .toEqual({...first,replayed:true});
    expect((await readSemanticHistoryReviews(f.client,broader,history,20)).records).toHaveLength(2);
  });
  it("rejects mismatched validated source provenance before SQL",async()=>{
    for(const altered of [{...scope,provider:"claude" as const},{...scope,model:"other"},
      {...scope,pin:{...scope.pin,revision:"other"}},{...scope,endpointIds:["other"]},
      {...scope,selection:{...scope.selection,selector:{kind:"revision" as const,revision:"other"}}}]){
      const f=fixture();await expect(recordSemanticHistoryReview(f.client,altered,history,parseSemanticHistoryReview(request)))
        .rejects.toMatchObject({code:storage});
      expect(f.query).not.toHaveBeenCalled();
    }
  });
  it("reads bounded newest metadata and detects altered digest-bound fields",async()=>{
    const f=fixture();await recordSemanticHistoryReview(f.client,scope,history,parseSemanticHistoryReview(request));
    await recordSemanticHistoryReview(f.client,scope,history,parseSemanticHistoryReview({...request,expectedVersion:"1",decision:"follow_up"}));
    const read=await readSemanticHistoryReviews(f.client,scope,history,1);
    expect(read.records.map(record=>record.reviewVersion)).toEqual(["2"]);expect(read.truncated).toBe(true);
    expect(read).toMatchObject({metadataOnly:true,nonNormative:true,verification:"inferred"});
    for(const altered of [{...scope,principalId:"other"},{...scope,configurationHash:`sha256:${"1".repeat(64)}`}])
      await expect(readSemanticHistoryReviews(f.client,altered,history,20)).rejects.toMatchObject({code:storage});
    await expect(readSemanticHistoryReviews(f.client,scope,{...history,result:{status:"ambiguous",candidateEndpointIds:["endpoint","other"]}},20))
      .rejects.toMatchObject({code:storage});
    f.rows[0]!.decision="dismissed";
    await expect(recordSemanticHistoryReview(f.client,scope,history,parseSemanticHistoryReview(request)))
      .rejects.toMatchObject({code:storage});
  });
  it.each([0,21,1.5,NaN,Infinity])("rejects unbounded read limit %s before SQL",async limit=>{
    const f=fixture();await expect(readSemanticHistoryReviews(f.client,scope,history,limit)).rejects.toMatchObject({code:invalid});
    expect(f.query).not.toHaveBeenCalled();
  });
  it("normalizes raw database errors",async()=>{
    const query=vi.fn(async()=>{throw new Error("private-db-password");});const client={query} as unknown as PoolClient;
    for(const action of [()=>recordSemanticHistoryReview(client,scope,history,parseSemanticHistoryReview(request)),
      ()=>readSemanticHistoryReviews(client,scope,history,20)]){
      await expect(action()).rejects.toMatchObject({code:storage,message:storage});
    }
  });
  it("normalizes hostile database rejections without invoking proxy traps or code getters",async()=>{
    const trap=vi.fn(()=>{throw new Error("sensitive proxy trap");}),getter=vi.fn(()=>{throw new Error("sensitive code getter");});
    const proxy=new Proxy(new Error("private database failure"),{getPrototypeOf:trap,get:trap,
      getOwnPropertyDescriptor:trap,ownKeys:trap});
    const revoked=Proxy.revocable(new Error("private database failure"),{});revoked.revoke();
    const accessor=Object.defineProperty(new Error("private database failure"),"code",{get:getter});
    const hostilePrototype=Object.create(new Proxy({},{getPrototypeOf:trap,get:trap}));
    for(const rejection of [proxy,revoked.proxy,accessor,hostilePrototype,{code:conflict},null,"private failure"]){
      const client={query:vi.fn(async()=>{throw rejection;})} as unknown as PoolClient;
      for(const action of [()=>recordSemanticHistoryReview(client,scope,history,parseSemanticHistoryReview(request)),
        ()=>readSemanticHistoryReviews(client,scope,history,20)]){
        await expect(action()).rejects.toMatchObject({code:storage,message:storage});
      }
    }
    expect(trap).not.toHaveBeenCalled();expect(getter).not.toHaveBeenCalled();
  });
});

describe("semantic history ordered migration upgrade",()=>{
  it.each([false,true])("applies reviews after checksum-valid history (existing=%s)",async existing=>{
    const {createHash}=await import("node:crypto"),{readFile}=await import("node:fs/promises");
    const body=await readFile(new URL("../../packages/semantics/migrations/0001_inferred_history.sql",import.meta.url),"utf8");
    const checksum=`sha256:${createHash("sha256").update(body).digest("hex")}`;
    const query=vi.fn(async(sql:string,values?:unknown[])=>{
      if(sql.includes("AS environment"))return {rows:[{environment:"1",catalog:"1",orchestration:"1"}]};
      if(sql.includes("SELECT checksum_sha256"))return {rows:existing&&values?.[0]==="0001_inferred_history"?[{checksum_sha256:checksum}]:[]};
      return {rows:[]};
    });
    const release=vi.fn();await applySemanticHistoryMigrations({connect:async()=>({query,release})} as unknown as Pool,{schema:"review_fixture"});
    const applied=query.mock.calls.filter(([sql])=>sql.includes("INSERT INTO semantic_history_schema_migrations")).map(([,values])=>values?.[0]);
    expect(applied).toEqual(existing?["0002_history_reviews"]:["0001_inferred_history","0002_history_reviews"]);
    expect(query.mock.calls.find(([sql])=>sql.includes("CREATE TABLE semantic_history_reviews"))?.[0]).toContain("orchestration_immutable_row");
    expect(release).toHaveBeenCalledOnce();
  });
  it("rolls back checksum mismatch and never applies a later migration",async()=>{
    const query=vi.fn(async(sql:string)=>{
      if(sql.includes("AS environment"))return {rows:[{environment:"1",catalog:"1",orchestration:"1"}]};
      if(sql.includes("SELECT checksum_sha256"))return {rows:[{checksum_sha256:`sha256:${"0".repeat(64)}`}]};
      return {rows:[]};
    });
    const release=vi.fn();await expect(applySemanticHistoryMigrations({connect:async()=>({query,release})} as unknown as Pool,
      {schema:"review_fixture"})).rejects.toMatchObject({code:"SEMANTIC_HISTORY_STORAGE_ERROR"});
    expect(query.mock.calls.some(([sql])=>sql.includes("CREATE TABLE semantic_history_reviews"))).toBe(false);
    expect(query.mock.calls.some(([sql])=>sql==="ROLLBACK")).toBe(true);expect(release).toHaveBeenCalledOnce();
  });
});
