import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool, type PoolClient } from "pg";

const here = dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = join(here, "..", "migrations");
export const SEEDS_DIR = join(here, "..", "seeds");

export function createPool(databaseUrl: string): Pool {
  return new Pool({ connectionString: databaseUrl, max: 5 });
}

/** The "up" part of a migration file: everything before a line that is exactly `-- DOWN`. */
export function splitUp(sql: string): string {
  const lines = sql.split("\n");
  const downIndex = lines.findIndex((line) => line.trim() === "-- DOWN");
  return (downIndex === -1 ? lines : lines.slice(0, downIndex)).join("\n");
}

export function listMigrationFiles(dir: string = MIGRATIONS_DIR): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort();
}

async function ensureMigrationsTable(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

/** Apply all pending migrations in filename order. Safe to re-run: applied files are skipped. */
export async function runMigrations(pool: Pool): Promise<string[]> {
  const client = await pool.connect();
  try {
    await ensureMigrationsTable(client);
    const applied = new Set(
      (await client.query<{ filename: string }>("SELECT filename FROM schema_migrations")).rows.map(
        (row) => row.filename,
      ),
    );
    const appliedNow: string[] = [];
    for (const filename of listMigrationFiles()) {
      if (applied.has(filename)) continue;
      const sql = splitUp(readFileSync(join(MIGRATIONS_DIR, filename), "utf8"));
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [filename]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${filename} failed: ${(error as Error).message}`);
      }
      appliedNow.push(filename);
      console.log(`applied migration ${filename}`);
    }
    return appliedNow;
  } finally {
    client.release();
  }
}

/** Apply seed files in order. Seeds are idempotent (ON CONFLICT DO NOTHING). */
export async function runSeeds(pool: Pool): Promise<string[]> {
  const client = await pool.connect();
  try {
    const files = readdirSync(SEEDS_DIR)
      .filter((name) => name.endsWith(".sql"))
      .sort();
    for (const filename of files) {
      const sql = readFileSync(join(SEEDS_DIR, filename), "utf8");
      await client.query(sql);
      console.log(`applied seed ${filename}`);
    }
    return files;
  } finally {
    client.release();
  }
}
