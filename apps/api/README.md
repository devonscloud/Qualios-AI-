# apps/api — QualiOS API (scaffold)

TypeScript Node.js + Express API for the cannabis inventory wedge.

## Status

**Scaffold only (Days 7–12).** Real: health endpoint, tenant-context middleware, route placeholders. Stub: the tenant middleware reads `x-organization-id` headers and verifies **no token** — it must be replaced by managed auth with MFA (ADR-011) before any real tenant data is served. `src/index.ts` refuses to start in production while the stub is in place.

## Routes

| Route                                                                                         | Status                                                |
| --------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `GET /health`                                                                                 | Real — `{"service":"qualios-api","status":"ok"}`      |
| `GET /api/reconciliations`, `POST /api/reconciliations`, `GET /api/reconciliations/:id`       | 501 stub — engine lands Days 12–18                    |
| `GET /api/discrepancies`, `GET /api/discrepancies/:id`, `POST /api/discrepancies/:id/resolve` | 501 stub — workflow lands Days 18–24                  |
| `POST /api/excise/calculate`, `GET /api/excise/rules`                                         | 501 stub — rules need expert review first (ADR, D-07) |

All `/api/*` routes require a valid `x-organization-id` UUID header (stub mechanism). Requests without one get 401 `TENANT_CONTEXT_MISSING`.

## Run

```bash
npm run dev      # tsx watch src/index.ts → http://localhost:3001
npm run build    # tsc → dist/
npm start        # node dist/index.js
npm test         # vitest smoke tests
npm run typecheck
```
