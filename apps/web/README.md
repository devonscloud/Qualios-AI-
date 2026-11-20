# apps/web — QualiOS web app (scaffold)

Next.js (pages router) + React. Responsive, Android-first mobile upload is the design target (ADR-002); camera upload lands with the document flow in Days 12–18.

## Status

**Scaffold (Days 7–12) + documents (Days 12–14) + reconciliation (Days 14–18).** Real: home, login, tenant/site selection, document upload/review/detail, and reconciliation runs (list / new / detail) that render, build, and call the API with demo tenant/user headers. UI only for auth: no authentication is wired (ADR-011); the login form sends nothing anywhere; the tenant list is synthetic demo data stored in localStorage for the demo only.

## Pages

| Page                    | Purpose                                                            |
| ----------------------- | ------------------------------------------------------------------ |
| `/`                     | Home — status notice + links                                       |
| `/login`                | Sign-in form (UI only, submit shows a not-wired notice)            |
| `/select-tenant`        | Organization/site picker (synthetic tenants, local-only selection) |
| `/documents/upload`     | Upload a document (demo Ops user)                                  |
| `/documents/review`     | Review queue (demo QA approver)                                    |
| `/documents/[id]`       | Document detail + versions + download                              |
| `/reconciliations`      | Reconciliation runs list                                           |
| `/reconciliations/new`  | Upload an external record file, pick a scope, run the engine       |
| `/reconciliations/[id]` | Run detail — lines + discrepancies, propose (Ops) / approve (QA)   |

## Run

```bash
npm run dev        # next dev → http://localhost:3000
npm run build      # next build (production)
npm start          # next start
npm run typecheck  # tsc --noEmit
```

API base URL: `NEXT_PUBLIC_API_URL` (see root `.env.example`). Used by the document and reconciliation pages; the login/tenant pages still use local demo data only.
