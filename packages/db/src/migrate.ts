import { createPool, runMigrations } from "./index.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required (see .env.example).");
}

const pool = createPool(databaseUrl);
try {
  const applied = await runMigrations(pool);
  console.log(
    applied.length === 0 ? "database is up to date" : `applied ${applied.length} migration(s)`,
  );
} finally {
  await pool.end();
}
