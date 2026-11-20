import { createPool, runMigrations, runSeeds } from "./index.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required (see .env.example).");
}

const pool = createPool(databaseUrl);
try {
  await runMigrations(pool);
  await runSeeds(pool);
  console.log("seed complete");
} finally {
  await pool.end();
}
