import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

/**
 * Object storage abstraction (ADR-005).
 *
 * The interface is S3-shaped on purpose: objects are addressed by key,
 * storage is private (no public reads), and a real S3-compatible backend
 * can replace the local one without changing callers. The local backend is
 * the development implementation; it stores objects as files under a
 * configured root directory. It must never be used for real customer data
 * beyond local development.
 *
 * Key scheme (enforced by buildStorageKey): every key is tenant-scoped —
 *   orgs/{organizationId}/[sites/{siteId}/]documents/{documentId}/v{version}/{safeFileName}
 * Keys never contain `..` and never escape the storage root. The storage
 * layer does not know about users or permissions; the API enforces tenant
 * scoping before calling it (ADR-008 layer 1), and keys are validated here
 * as a second check.
 */

export interface ObjectStorage {
  put(key: string, data: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Strip any path and unsafe characters from an uploaded filename. */
export function sanitizeFileName(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? "file";
  const cleaned = base.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "");
  return cleaned.length > 0 ? cleaned : "file";
}

/**
 * Build a tenant-scoped storage key. Throws on a malformed organization,
 * site, or document id, so a caller cannot build a key outside its tenant.
 */
export function buildStorageKey(options: {
  organizationId: string;
  siteId: string | null;
  documentId: string;
  versionNumber: number;
  fileName: string;
}): string {
  const { organizationId, siteId, documentId, versionNumber, fileName } = options;
  if (!UUID_RE.test(organizationId)) throw new Error("buildStorageKey: invalid organizationId");
  if (siteId !== null && !UUID_RE.test(siteId)) throw new Error("buildStorageKey: invalid siteId");
  if (!UUID_RE.test(documentId)) throw new Error("buildStorageKey: invalid documentId");
  if (!Number.isInteger(versionNumber) || versionNumber < 1) {
    throw new Error("buildStorageKey: versionNumber must be a positive integer");
  }
  const sitePart = siteId === null ? "" : `sites/${siteId}/`;
  return `orgs/${organizationId}/${sitePart}documents/${documentId}/v${versionNumber}/${sanitizeFileName(fileName)}`;
}

/** Validate that a key is a well-formed tenant-scoped key (no escapes). */
export function isValidStorageKey(key: string): boolean {
  if (key.includes("..") || key.startsWith("/") || key.includes("\\")) return false;
  const pattern =
    /^orgs\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/(sites\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/)?documents\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/v[1-9][0-9]*\/[^/]+$/i;
  return pattern.test(key);
}

export class LocalFilesystemStorage implements ObjectStorage {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private resolveKey(key: string): string {
    if (!isValidStorageKey(key)) {
      throw new Error(`LocalFilesystemStorage: invalid storage key: ${key}`);
    }
    const fullPath = resolve(this.root, ...key.split("/"));
    if (fullPath !== this.root && !fullPath.startsWith(this.root + sep)) {
      throw new Error(`LocalFilesystemStorage: key escapes storage root: ${key}`);
    }
    return fullPath;
  }

  async put(key: string, data: Buffer, _contentType: string): Promise<void> {
    const fullPath = this.resolveKey(key);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, data);
  }

  async get(key: string): Promise<Buffer> {
    const fullPath = this.resolveKey(key);
    try {
      return await readFile(fullPath);
    } catch {
      throw new Error(`LocalFilesystemStorage: object not found: ${key}`);
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await stat(this.resolveKey(key));
      return true;
    } catch {
      return false;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.resolveKey(key), { force: true });
  }
}

export type StorageBackend = "local" | "s3";

/**
 * Build the storage backend from environment. `local` (default) uses the
 * filesystem root in STORAGE_LOCAL_ROOT. `s3` is NOT wired yet (ADR-005):
 * there is no S3 client, bucket, or credentials configured, and the factory
 * refuses rather than silently storing objects nowhere.
 */
export function createStorageFromEnv(env: {
  STORAGE_BACKEND?: string;
  STORAGE_LOCAL_ROOT?: string;
}): ObjectStorage {
  const backend = (env.STORAGE_BACKEND ?? "local").toLowerCase();
  if (backend === "local") {
    const root = env.STORAGE_LOCAL_ROOT;
    if (!root) {
      throw new Error(
        "STORAGE_LOCAL_ROOT is required for the local storage backend (see .env.example).",
      );
    }
    return new LocalFilesystemStorage(root);
  }
  if (backend === "s3") {
    throw new Error(
      "S3 storage backend is not configured (ADR-005): no S3 client, bucket, or credentials are wired. Use STORAGE_BACKEND=local for development.",
    );
  }
  throw new Error(`Unknown STORAGE_BACKEND: ${backend} (expected "local" or "s3").`);
}
