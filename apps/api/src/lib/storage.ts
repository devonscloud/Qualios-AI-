import { createStorageFromEnv, type ObjectStorage } from "@qualios/storage";
import { env } from "./env.js";

/**
 * Object-storage singleton for the API (ADR-005).
 * Built once from environment; the local backend stores files under
 * STORAGE_LOCAL_ROOT. No cloud credentials are involved.
 */
let storage: ObjectStorage | null = null;

export function getStorage(): ObjectStorage {
  if (storage === null) {
    storage = createStorageFromEnv({
      STORAGE_BACKEND: env.storageBackend,
      STORAGE_LOCAL_ROOT: env.storageLocalRoot,
    });
  }
  return storage;
}

/** Test hook: replace the storage instance (used by the API tests). */
export function setStorageForTests(next: ObjectStorage): void {
  storage = next;
}
