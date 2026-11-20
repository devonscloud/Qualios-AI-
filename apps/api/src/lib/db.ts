import { Pool, type PoolClient } from "pg";
import { env } from "./env.js";

/**
 * Database access for apps/api (ADR-004 / ADR-008).
 *
 * Layer 1 (application scoping) is enforced here: every query the API runs
 * includes `organization_id = $orgId` explicitly, and `withTenant` runs the
 * work in a transaction with the RLS session setting applied, so layer 2
 * (row-level security) also applies where the connection is subject to it.
 *
 * Honest limit: locally the API connects as the `qualios` role, which owns
 * the tables and is a superuser — PostgreSQL does not apply RLS to table
 * owners or superusers. In local dev, application scoping is the enforcement
 * that actually bites. Production must connect as a non-superuser, non-owner
 * app role (and use FORCE RLS on tenant tables) for layer 2 to hold.
 * The tenant-isolation tests in documents.test.ts verify layer 1; the RLS
 * behaviour for a non-owner role is verified separately against a scratch
 * role (see packages/db/README.md).
 */

export const pool = new Pool({ connectionString: env.databaseUrl, max: 5 });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/**
 * Run `fn` inside a transaction with the tenant RLS setting applied for
 * that transaction only (set_config with is_local=true). The setting is
 * validated as a UUID first — it is never interpolated into SQL.
 */
export async function withTenant<T>(
  organizationId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  if (!isUuid(organizationId)) {
    throw new Error("withTenant: organizationId must be a UUID");
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_organization_id', $1, true)", [
      organizationId,
    ]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * The tenant middleware (header stub, ADR-011) supplies a user id, but it
 * verifies nothing. Before a route writes tenant data it must confirm the
 * user exists AND has an ACTIVE membership in this organization — otherwise
 * any UUID in a header could write rows attributed to a nonexistent user
 * (and would fail the users FK anyway). Returns true when the user is a
 * member; callers turn false into 403.
 */
export async function isTenantMember(
  client: PoolClient,
  organizationId: string,
  userId: string,
): Promise<boolean> {
  if (!isUuid(userId)) return false;
  const { rows } = await client.query<{ ok: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM users u
       JOIN memberships m ON m.user_id = u.id
       WHERE u.id = $1 AND m.organization_id = $2 AND m.status = 'ACTIVE'
     ) AS ok`,
    [userId, organizationId],
  );
  return rows[0]?.ok === true;
}
