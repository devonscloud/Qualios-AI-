# apps/web — QualiOS web app (scaffold)

Next.js (pages router) + React. Responsive, Android-first mobile upload is the design target (ADR-002); camera upload lands with the document flow in Days 12–18.

## Status

**Scaffold only (Days 7–12).** Real: three pages (home, login, tenant/site selection) that render and build. UI only: no authentication is wired (ADR-011), no API calls are made yet. The login form sends nothing anywhere; the tenant list is synthetic demo data stored in localStorage for the demo only.

## Pages

| Page             | Purpose                                                            |
| ---------------- | ------------------------------------------------------------------ |
| `/`              | Home — status notice + links                                       |
| `/login`         | Sign-in form (UI only, submit shows a not-wired notice)            |
| `/select-tenant` | Organization/site picker (synthetic tenants, local-only selection) |

## Run

```bash
npm run dev        # next dev → http://localhost:3000
npm run build      # next build (production)
npm start          # next start
npm run typecheck  # tsc --noEmit
```

API base URL: `NEXT_PUBLIC_API_URL` (see root `.env.example`). Not used by any page yet.
