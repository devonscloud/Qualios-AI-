# packages/storage — QualiOS object storage abstraction

S3-shaped interface for storing original documents (ADR-005). The interface
is deliberately small — `put`, `get`, `exists`, `delete` — so a real
S3-compatible backend can replace the local one without changing callers.

## Key scheme

Every key is tenant-scoped and built by `buildStorageKey`:

```
orgs/{organizationId}/[sites/{siteId}/]documents/{documentId}/v{version}/{safeFileName}
```

Keys are validated (`isValidStorageKey`) and the local backend refuses any
key that escapes its root directory. Storage does not enforce permissions;
the API enforces tenant scoping before calling it (ADR-008 layer 1).

## Backends

| Backend | Status                                                                                                                                          |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `local` | Real — `LocalFilesystemStorage`, files under `STORAGE_LOCAL_ROOT`. Development only; never for real customer data.                              |
| `s3`    | **Not wired** — `createStorageFromEnv` throws. Needs an S3 client, bucket, and credentials (ADR-005), plus presigned-URL support for downloads. |

## Environment

- `STORAGE_BACKEND` — `local` (default) or `s3`.
- `STORAGE_LOCAL_ROOT` — filesystem root for the local backend (required when `local`). The default in `.env.example` is a `.storage/` directory in the repo root, which is gitignored — uploaded files are never committed.

## Run

```bash
npm run build      # tsc → dist/
npm run typecheck
```

The API imports this package as `@qualios/storage`; `dist/` is built on
`npm install` via the `prepare` script, and CI builds workspace packages
explicitly before running tests.
