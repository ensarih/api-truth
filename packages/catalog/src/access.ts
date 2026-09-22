import type { Pool } from "pg";

import { quoteSchemaIdentifier, withCatalogTransaction } from "./database.js";
import { CatalogError } from "./errors.js";
import { booleanValue, nonEmptyString, withCatalogInputBoundary } from "./input.js";
import type { AccessPolicyStore, TenantContext } from "./types.js";

type ScopeMutation = { tenantId: string; scopeId: string; active: boolean };
type GrantMutation = ScopeMutation & { principalId: string };

const scopeMutation = (
  context: TenantContext,
  input: { scopeId: string; active: boolean },
): ScopeMutation => withCatalogInputBoundary(() => ({
  tenantId: nonEmptyString(context.tenantId),
  scopeId: nonEmptyString(input.scopeId),
  active: booleanValue(input.active),
}));

const grantMutation = (
  context: TenantContext,
  input: { principalId: string; scopeId: string; active: boolean },
): GrantMutation => withCatalogInputBoundary(() => ({
  ...scopeMutation(context, input),
  principalId: nonEmptyString(input.principalId),
}));

export const createAccessPolicyStore = (
  pool: Pool,
  options: { schema: string },
): AccessPolicyStore => {
  const schema = withCatalogInputBoundary(() => {
    quoteSchemaIdentifier(options.schema);
    return options.schema;
  });

  return {
    async putScope(context, input): Promise<void> {
      const mutation = scopeMutation(context, input);
      await withCatalogTransaction(pool, { schema }, async (client) => {
        await client.query(
          `INSERT INTO access_scopes (tenant_id, access_scope_id, active)
           VALUES ($1, $2, $3)
           ON CONFLICT (tenant_id, access_scope_id) DO UPDATE
           SET active = EXCLUDED.active, updated_at = clock_timestamp()`,
          [mutation.tenantId, mutation.scopeId, mutation.active],
        );
      });
    },

    async putGrant(context, input): Promise<void> {
      const mutation = grantMutation(context, input);
      await withCatalogTransaction(pool, { schema }, async (client) => {
        const write = await client.query(
          `INSERT INTO principal_scope_grants (
             tenant_id, principal_id, access_scope_id, active
           )
           SELECT tenant_id, $2, access_scope_id, $3
           FROM access_scopes
           WHERE tenant_id = $1 AND access_scope_id = $4
           ON CONFLICT (tenant_id, principal_id, access_scope_id) DO UPDATE
           SET active = EXCLUDED.active, updated_at = clock_timestamp()`,
          [mutation.tenantId, mutation.principalId, mutation.active, mutation.scopeId],
        );
        if (write.rowCount !== 1) throw new CatalogError("UNKNOWN_ACCESS_SCOPE");
      });
    },
  };
};
