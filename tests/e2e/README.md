# tests/e2e — End-to-end tests (placeholder)

End-to-end tests for the vertical slice land here once the slice exists (Days 24–30):

1. Login → document upload → OCR review → reconciliation run → discrepancy flags → approval → audit log → cited AI answer.

## Why this folder is empty for now

E2E tests need a running stack (web + API + PostgreSQL + object storage). The Days 7–12 scaffold has the web UI and API stubs but no working flows to drive end to end. Writing e2e tests against stubs would only test the stubs.

## Planned scenarios (from the sprint plan demo)

- Login with MFA into the Herba demo tenant.
- Upload a paper batch record; original stored and hashed.
- OCR review: a below-threshold field routes to the verification queue; a reviewer confirms it.
- Reconciliation run flags the Toad Venom phantom (1.338 kg), Sangria phantom (0.348 kg), a ceramic tip shortage, and the Jixy allocation gap.
- A discrepancy resolution is proposed and approved by a second person (segregation of duties).
- The audit log shows the complete attributable trail.
- The AI assistant answers "Which lots have unresolved discrepancies?" with citations.

Tooling decision (Playwright vs alternatives) is open — to be made when the first e2e test is written.
