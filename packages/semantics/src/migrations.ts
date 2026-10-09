import {createHash} from "node:crypto";
import {readFile} from "node:fs/promises";
import type {Pool} from "pg";
import {quoteEnvironmentSchema} from "../../environment/src/migrations.js";

const version="0001_inferred_history";
export class SemanticHistoryStorageError extends Error {
  readonly code="SEMANTIC_HISTORY_STORAGE_ERROR";
  constructor(){super("SEMANTIC_HISTORY_STORAGE_ERROR");this.name="SemanticHistoryStorageError";}
}

/** Explicit, checksum-verified migration. Semantic service construction never applies it. */
export const applySemanticHistoryMigrations=async(pool:Pool,options:{schema:string}):Promise<void>=>{
  let schema:string,schemaName:string;
  try{schemaName=options.schema;schema=quoteEnvironmentSchema(schemaName);}catch{throw new SemanticHistoryStorageError();}
  const body=await readFile(new URL(`../migrations/${version}.sql`,import.meta.url),"utf8")
    .catch(()=>{throw new SemanticHistoryStorageError();});
  const checksum=`sha256:${createHash("sha256").update(body).digest("hex")}`;
  const client=await pool.connect().catch(()=>{throw new SemanticHistoryStorageError();});
  try{
    await client.query("BEGIN");
    await client.query(`SET LOCAL search_path TO ${schema}, pg_catalog`);
    await client.query("SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1,0))",
      [`api-truth:semantic-history-migrations:${schemaName}`]);
    const prerequisites=await client.query<{environment:string;catalog:string;orchestration:string}>(
      `SELECT (SELECT count(*)::text FROM environment_schema_migrations
         WHERE version='0006_environment_requests') AS environment,
        (SELECT count(*)::text FROM catalog_schema_migrations
         WHERE version='0001_catalog_core') AS catalog,
        (SELECT count(*)::text FROM orchestration_schema_migrations
         WHERE version='0001_orchestration_core') AS orchestration`);
    if(prerequisites.rows[0]?.environment!=="1"||prerequisites.rows[0]?.catalog!=="1"
      ||prerequisites.rows[0]?.orchestration!=="1")throw new SemanticHistoryStorageError();
    await client.query(`CREATE TABLE IF NOT EXISTS semantic_history_schema_migrations (
      version text PRIMARY KEY,checksum_sha256 text NOT NULL
        CHECK (checksum_sha256 ~ '^sha256:[0-9a-f]{64}$'),
      applied_at timestamptz NOT NULL DEFAULT clock_timestamp())`);
    const stored=await client.query<{checksum_sha256:string}>(
      "SELECT checksum_sha256 FROM semantic_history_schema_migrations WHERE version=$1",[version]);
    if(!stored.rows.length){
      await client.query(body);
      await client.query("INSERT INTO semantic_history_schema_migrations(version,checksum_sha256) VALUES($1,$2)",
        [version,checksum]);
    }else if(stored.rows[0]?.checksum_sha256!==checksum)throw new SemanticHistoryStorageError();
    await client.query("COMMIT");
  }catch{await client.query("ROLLBACK").catch(()=>undefined);throw new SemanticHistoryStorageError();}
  finally{client.release();}
};
