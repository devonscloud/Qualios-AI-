/** Environment for apps/api. Reads from process.env with local-dev defaults. No secrets are committed. */
export const env = {
  host: process.env.API_HOST ?? "127.0.0.1",
  port: Number(process.env.API_PORT ?? 3001),
  databaseUrl: process.env.DATABASE_URL ?? "postgres://qualios:qualios@localhost:5432/qualios_dev",
  // Object storage (ADR-005). Local backend default root is the repo's
  // .storage/ directory, resolved by the caller via STORAGE_LOCAL_ROOT.
  storageBackend: process.env.STORAGE_BACKEND ?? "local",
  storageLocalRoot: process.env.STORAGE_LOCAL_ROOT ?? "",
  /** Max upload size in bytes (default 25 MB). Overridable via MAX_UPLOAD_MB. */
  maxUploadBytes: Number(process.env.MAX_UPLOAD_MB ?? 25) * 1024 * 1024,
} as const;
