/** Environment for apps/api. Reads from process.env with local-dev defaults. No secrets are committed. */
export const env = {
  host: process.env.API_HOST ?? "127.0.0.1",
  port: Number(process.env.API_PORT ?? 3001),
  databaseUrl: process.env.DATABASE_URL ?? "postgres://qualios:qualios@localhost:5432/qualios_dev",
} as const;
