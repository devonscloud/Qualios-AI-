# Auth Provider Evaluation — QualiOS AI (OD-1)

**Date:** 20 November 2026
**Status:** Evaluation complete — recommendation made, awaiting Devon's approval (OD-1 stays open until he approves).
**Decision record:** `docs/architecture/DECISIONS.md` — OD-1 (Managed auth provider and MFA approach), ADR-011 (managed auth with MFA; enterprise SSO is a roadmap item). This document does **not** change the decision record; it is the research input OD-1 asked for.
**Directive:** ChatGPT "Master Product Correction & Build Directive", 20 Nov 2026, §8 P0 — "Resolve managed authentication choice (evaluate Clerk against enterprise, pricing and data requirements)".
**Current state:** Auth is a header stub with no token verification; `verifyToken` throws; the API refuses to start in production (ADR-011). Nothing can be demonstrated to a real customer until this is resolved.
**Scope of this document:** Research and recommendation only. No code was changed, no account was created, no credentials exist, no money was spent.

## Method and sources

Prices and limits were read from the vendors' own pricing pages and docs, plus third-party guides that cite those pages, on 20 November 2026. All prices are USD list prices, monthly billing unless stated. Where a price is not publicly listed (all Enterprise tiers), that is stated explicitly — no figure is guessed.

Primary sources consulted:

- Clerk pricing — https://clerk.com/pricing (via Clerk's own pricing explainer, https://clerk.com/articles/clerk-pricing-explained, and https://clerk.com/articles/auth-platforms-with-sso-and-scim-in-the-base-tier-2)
- Clerk docs — Require MFA: https://clerk.com/changelog/2026-02-20-require-mfa; session tasks: https://clerk.com/docs/guides/configure/session-tasks
- Auth0 pricing — https://auth0.com/pricing (read directly 20 Nov 2026)
- Supabase pricing — https://supabase.com/pricing (via guides checked against it Oct–Nov 2026)
- Supabase Auth MFA docs — https://supabase.com/docs/guides/platform/multi-factor-authentication
- Firebase / Identity Platform pricing — https://firebase.google.com/pricing and Google Cloud Identity Platform pricing (via guides checked against them 2 Nov 2026)
- Google Cloud docs — Identity Platform vs Firebase Auth: https://cloud.google.com/identity-platform/docs/product-comparison
- AWS Cognito pricing — https://aws.amazon.com/cognito/pricing (via guides checked against it Oct 2026; US East / us-east-1 rates)

**Caution on staleness:** every one of these vendors restructured pricing between 2024 and 2026. Two traps this evaluation verified rather than repeated:

- Clerk's old "10,000 free users" tier was retired 5 Feb 2026; the free tier is now **50,000 monthly retained users (MRU)**.
- Cognito's old "50,000 free MAU" tier was replaced in Nov 2024 by Lite/Essentials/Plus; the free tier is now **10,000 MAU** on Lite/Essentials.

## What QualiOS needs from auth

QualiOS is a commercial, multi-tenant, quality-assurance AI platform sold by subscription to independent organisations (all industries; Herba Farms is pilot only). The auth provider must support, now or on a credible path:

1. **Multi-tenancy:** one organisation = one tenant; users belong to orgs, switch between orgs, and are invited into orgs. Tenant identity must be trustworthy enough to drive the database RLS layer (`organization_id` / `app.current_organization_id`, ADR-004/ADR-008).
2. **Per-tenant roles and permissions:** at minimum Admin / Member; custom roles (e.g. QAP, QA reviewer, auditor, finance) as the product matures.
3. **Invites:** org admins invite users by email; invited users join the right org, not a personal account.
4. **MFA enforced per org:** MFA must be require-able for an organisation's members (at minimum for admin roles from day one; ideally per-org policy).
5. **Audit trail of auth events:** sign-ins, MFA enrolment/changes, invites, role changes, SSO connections — visible in the provider and/or streamable into QualiOS's own audit ledger.
6. **Enterprise path:** SSO/SAML (and later SCIM) for larger customers, without a forced re-platform.
7. **Data requirements:** a public DPA, SOC 2 Type 2, GDPR posture; data residency options matter for EU customers; HIPAA BAA only matters if QualiOS ever touches PHI (not a current market — noted, not required now).
8. **Developer fit:** first-class Next.js / TypeScript SDK (the stack is Next.js + TypeScript Node + PostgreSQL), server-side session verification, webhooks to sync users/orgs into QualiOS's own Postgres, and a realistic migration/exit path.

Two cost scenarios are used throughout:

- **Startup:** 1 org, ~10 users (Herba pilot + internal team).
- **Scale:** 100 orgs, ~5,000 users (≈50 users per org). A 100,000-user reference point is included where it changes the ranking.

Clerk bills **monthly retained users (MRU)** — a user who returns at least one day / 24 hours after signing up. Auth0, Supabase, Firebase and Cognito bill **monthly active users (MAU)** — anyone active in the month, including one-time sign-ups. MRU is the narrower unit, so Clerk's bill for the same sign-up cohort is normally lower than its MAU equivalent.

## Pricing as found (20 Nov 2026)

### Clerk — clerk.com/pricing

| Plan         | Price                                         | Included                                                                    | Notes                                                                                              |
| ------------ | --------------------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Hobby (Free) | $0                                            | 50,000 MRU per app; 100 monthly retained orgs (MROs), up to 20 members each | No MFA, no passkeys, no branding removal, 1-day log retention                                      |
| Pro          | $25/mo ($20/mo billed annually)               | 50,000 MRU; 1 enterprise SSO connection                                     | MFA, passkeys, custom sessions, white-labelling                                                    |
| Business     | $300/mo ($250/mo annual)                      | Same MRU allotment as Pro                                                   | 10 dashboard seats, priority support, 30-day log retention, SOC 2 report access, admin audit trail |
| Enterprise   | Custom, annual only — **not publicly listed** | Negotiated                                                                  | 99.99% uptime SLA, HIPAA BAA, volume discounting                                                   |

- Overage above 50,000 MRU: $0.02/MRU (50,001–100,000), $0.018 (100,001–1,000,000), $0.015 (1,000,001–10,000,000), $0.012 (10,000,000+).
- Organisations: first 100 MROs included on every plan; overage $1.00/MRO (101–1,000), $0.90 (1,001–10,000), $0.75 (10,001–100,000), $0.60 (100,001+). Overage billing requires the B2B Authentication add-on.
- Enterprise SSO connections: 1 included on Pro/Business; additional $75/mo each (2–15), $60 (16–100), $30 (101–500), $15 (501+). SCIM / Directory Sync is included free with each connection (GA 16 Apr 2026; groups + custom attributes 21 May 2026; Okta and Microsoft Entra ID).
- Add-ons: B2B Authentication ("Enhanced") $100/mo ($85/mo annual) — unlimited members per org, verified domains, custom roles and rolesets, linking enterprise connections to orgs. Administration add-on $100/mo. Satellite domains $10/mo. SMS MFA $0.01 per SMS (US/Canada).
- Full user-data export (CSV) is available on **every** plan, including Hobby.

### Auth0 — auth0.com/pricing (read directly)

Auth0 sells B2C and B2B variants of the paid plans. Prices below are the lowest published tier (500 MAU), monthly billing. Auth0 prices in **discrete MAU tiers, not a per-MAU rate**; usage between tiers is billed at the next tier up.

| Plan         | B2C price                        | B2B price                        | Notes                                                                                                                                                    |
| ------------ | -------------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Free         | $0 — up to 25,000 MAU            | —                                | 5 orgs, 1 enterprise connection, self-service SSO, SCIM; no Pro MFA factors, no role management                                                          |
| Essentials   | $35/mo (500 MAU)                 | $150/mo (500 MAU)                | Pro MFA, RBAC per org, log streaming, standard support; B2C: 10 orgs, **no** enterprise connections; B2B: unlimited orgs, 3 enterprise connections, SCIM |
| Professional | $240/mo (500 MAU)                | $800/mo (500 MAU)                | Enterprise MFA, enhanced attack protection, custom DB connections; B2B: 5 enterprise connections                                                         |
| Enterprise   | **Custom — not publicly listed** | **Custom — not publicly listed** | 99.99% SLA, custom user & SSO tiers, enterprise rate limits, HIPAA/BAA add-on, private deployment add-on                                                 |

- MAU tier ladder (published): 500 / 1,000 / 2,500 / 5,000 / 7,500 / 10,000 / 20,000 / 30,000+. B2C Essentials: $70 @1,000 MAU, $350 @5,000, $700 @10,000, $3,500 @50,000 (self-serve ceiling; 100,000 MAU = contact sales). B2B Essentials: $300 @1,000, $1,300 @5,000, $2,100 @10,000, $3,800 @20,000; B2B Professional $1,500 @5,000, $2,400 @10,000. Past 30,000 MAU, paid B2B and Professional plans show "Get in touch" instead of a price.
- Extra enterprise connections on B2B: $100/mo each, capped at 30 total on self-serve plans.
- Log retention: 1 day Free, 5 days Essentials, 10 days Professional, 30 days Enterprise. Log streaming to Datadog/Splunk/AWS/Azure from Essentials.
- **Trap:** the Free tier includes an enterprise connection, SSO and SCIM, but the paid **B2C** plans drop them — the pricing page says "Upgrade to B2B to continue using EC, Self-Service SSO, and SCIM."

### Supabase Auth — supabase.com/pricing (bundled with the Supabase platform)

| Plan       | Price                            | Included MAU               | Notes                                                                                                                                  |
| ---------- | -------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Free       | $0                               | 50,000                     | 500 MB DB, 2 active projects, project pauses after 7 days idle, 1-hour audit log, no SAML SSO, no custom domain, no SLA                |
| Pro        | $25/mo + usage                   | 100,000, then $0.00325/MAU | 8 GB DB per project, 100 GB storage, daily backups kept 7 days, $10/mo compute credit, email support                                   |
| Team       | $599/mo + usage                  | 100,000, then $0.00325/MAU | Pro limits + SOC 2 Type II / ISO 27001, dashboard SSO/SAML, 14-day backups, priority support with SLAs; HIPAA available as paid add-on |
| Enterprise | **Custom — not publicly listed** | Custom                     | Dedicated support, BYO cloud, uptime SLAs, custom data residency                                                                       |

- SAML 2.0 SSO: paid plans only; 50 SSO MAU included, then **$0.015 per SSO MAU**. No SCIM.
- MFA: TOTP (authenticator apps) included; phone/SMS MFA is a paid add-on ($75/mo first project, $10/mo each further project). Leaked-password protection is a paid feature.
- Compute is billed per project per hour on top of the plan fee (Micro ≈ $10/mo, covered by the $10/mo credit on paid plans).
- Auth is bundled with a Supabase project (Postgres + Storage + Realtime). Using Supabase Auth without the Supabase platform means self-hosting GoTrue — that is self-managed, not managed auth.

### Firebase Authentication / Google Cloud Identity Platform

| Item                          | Price                                                                                                                                                                                           |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Spark plan (no-cost)          | $0; email/social/anonymous sign-in free to 50,000 MAU; no phone sign-in; Identity Platform upgrade capped at 3,000 daily active users                                                           |
| Blaze plan (pay-as-you-go)    | $0 base fee; first 50,000 MAU free, then Tier 1 (email/social/phone/anonymous) $0.0055/MAU (50,001–100,000), $0.0046 (100,001–1,000,000), $0.0032 (1,000,001–10,000,000), $0.0025 (10,000,000+) |
| Tier 2 (SAML / OIDC)          | First 50 MAU free, then **$0.015/MAU**; requires Identity Platform upgrade                                                                                                                      |
| SMS (phone sign-in / SMS MFA) | Per SMS sent, by country: US/Canada $0.01; first 10 SMS/day free; requires Blaze                                                                                                                |

- The Identity Platform upgrade itself has no price tag — it unlocks MFA, blocking functions, SAML/OIDC and multi-tenancy, and usage is then billed at the rates above.
- Multi-tenancy (tenants = isolated user silos in one project) is included in the upgrade at no additional cost. There is **no native Organisations / B2B model** — no org roles, invites or org switching.
- No SCIM. No passkeys/WebAuthn documented as of Sep 2026. MFA factors: SMS and TOTP (Identity Platform).

### AWS Cognito — aws.amazon.com/cognito/pricing (us-east-1 rates)

User pools are billed per MAU on one of three feature tiers, chosen per pool. New pools start on Essentials.

| Tier       | Free tier  | Price above free tier                                                                                             |
| ---------- | ---------- | ----------------------------------------------------------------------------------------------------------------- |
| Lite       | 10,000 MAU | $0.0055/MAU (10,001–100,000), $0.0046 (100,001–1,000,000), $0.00325 (1,000,001–10,000,000), $0.0025 (10,000,000+) |
| Essentials | 10,000 MAU | **$0.015/MAU flat**                                                                                               |
| Plus       | None       | **$0.020/MAU flat**                                                                                               |

- SAML 2.0 / OIDC federated users are priced separately on every tier: first 50 MAU free, then **$0.015/MAU**.
- Lite: password/social/SAML-OIDC sign-in, MFA (SMS or authenticator apps), Lambda triggers. Essentials adds managed login with visual editor, passwordless/passkeys, email MFA, access-token customisation, refresh-token rotation. Plus adds threat protection (adaptive auth, compromised-credential detection) and **exportable user activity logs**.
- Identity Pools (federated AWS credentials) are free. Machine-to-machine tokens: $0.00225 per token issued (first 250,000/month band).
- No SCIM. No native Organisations model.

## Cost at the two QualiOS scales

Assumptions: startup = 1 org, 10 users, all active/retained. Scale = 100 orgs, 5,000 users, all active/retained. SSO users at scale assumed 500 (10% of users via customer IdPs) where a per-SSO-user meter applies. SMS MFA cost excluded (TOTP is free everywhere it is offered); if SMS MFA were used for all 5,000 users once a month, add ≈ $50/mo on Clerk/Firebase.

| Provider          | Startup (1 org, ~10 users)                                                                                                             | Scale (100 orgs, ~5,000 users)                                                                                                                                   | 100,000-user reference                                                                                |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| **Clerk**         | **$25/mo** (Pro; Hobby $0 has no MFA)                                                                                                  | **$125/mo** — Pro $25 + B2B Enhanced add-on $100 (custom roles, unlimited members/org, org-linked SSO). 5,000 MRU and 100 orgs both inside included allotments   | $1,025/mo Pro ($25 + 50,000 × $0.02)                                                                  |
| **Auth0**         | **$35/mo** (B2C Essentials @500 MAU — Pro MFA + RBAC per org; Free $0 has no Pro MFA/roles. B2B Essentials $150/mo if SSO/SCIM needed) | **$1,300/mo** (B2B Essentials @5,000 MAU — unlimited orgs, 3 connections). B2C Essentials is $350/mo but capped at **10 orgs**, so it fails the 100-org scenario | B2C Essentials $3,500/mo @50,000 (self-serve ceiling); 100,000 MAU = contact sales / Enterprise quote |
| **Supabase Auth** | **$25/mo** (Pro; Free $0 but idle projects pause, 1-hour audit log, no SAML) — plus ≈$0 compute (Micro covered by $10 credit)          | **≈$25/mo** (Pro; 5,000 MAU inside 100,000 included) + ≈$6.75/mo if 500 SSO users. Team $599/mo if SOC 2/ISO/HIPAA attestation is required                       | $25/mo Pro (100,000 included); 200,000 MAU ≈ $350/mo                                                  |
| **Firebase Auth** | **$0/mo** (Blaze; 50,000 MAU free; MFA via Identity Platform)                                                                          | **$0/mo** (5,000 MAU inside free tier) + ≈$6.75/mo if 500 SAML/OIDC users                                                                                        | $275/mo (50,000 × $0.0055)                                                                            |
| **AWS Cognito**   | **$0/mo** (Essentials; 10,000 MAU free)                                                                                                | **$0/mo** (Essentials; 5,000 MAU inside free tier) + ≈$6.75/mo if 500 federated users. Plus tier (exportable logs, threat protection) would be $100/mo           | Lite $495/mo; Essentials $1,350/mo; Plus $2,000/mo                                                    |

Reading: at QualiOS's real scales, Clerk costs $25 → $125/mo; Auth0 is 10× Clerk at the 100-org scale ($1,300 vs $125) because its B2B pricing is per-MAU-tiered; Supabase, Firebase and Cognito are near-free on metered auth — but all three lack the B2B organisation layer, so the saving is paid for in engineering time building it (see below).

## Provider-by-provider evaluation

### 1. Clerk — recommended

**Enterprise fit.** SSO/SAML + OIDC via Enterprise Connections (1 included on Pro; $75/mo each for connections 2–15, then volume discounts). SCIM / Directory Sync included free with each connection (Okta, Microsoft Entra ID; groups + custom attributes GA May 2026). MFA: TOTP authenticator apps, SMS codes, backup codes, passkeys — on Pro. App-wide "Require MFA" toggle (Feb 2026, enforced as a post-sign-in session task). **Per-org MFA is not a native dashboard toggle** — it is enforced in application code (org setting in QualiOS + server-side check of the user's MFA state before granting org access). Audit logs: application logs kept 1 day (Hobby) / 7 days (Pro) / 30 days (Business); a workspace admin audit trail is Business-only, 30 days. No SLA below Enterprise (99.99%). Priority support on Business; SOC 2 report access on Business and above; HIPAA BAA on Enterprise only.

**Pricing.** $25/mo at startup, $125/mo at 100 orgs / 5,000 users (with the B2B add-on), $1,025/mo at 100,000 MRU. Predictable, flat, published to 10M+ users. No per-MAU cliff.

**Data requirements.** **US-only hosting — no regional data residency or region selection on any plan.** EU personal data is transferred to US infrastructure under the EU–US Data Privacy Framework; public DPA available; GDPR/CCPA compliant; SOC 2 Type 2 held since May 2022 (report on Business+). **No own ISO 27001 certification** (listed as "via cloud providers" only). HIPAA BAA only on Enterprise (custom quote). This is Clerk's one material weakness for QualiOS: an EU enterprise customer that contractually requires EU data residency cannot be served on Clerk as it stands.

**Developer fit.** Best-in-class for this stack. `@clerk/nextjs` with prebuilt `<SignIn/>`, `<SignUp/>`, `<OrganizationSwitcher/>`, `<UserButton/>`; server-side `auth()` / `currentUser()` returning `orgId` and `has()` permission checks; webhooks (Svix-signed) for user/org sync; custom session-token claims to carry the QualiOS `organization_id` into the API. Note: Clerk Core 3 (Mar 2026) deprecated `<SignedIn/>`/`<SignedOut/>`/`<Protect/>` (replaced by `<Show>`) and deprecated `createRouteMatcher()` middleware gating — protection now belongs per-resource on the server, which matches ADR-008's defence-in-depth anyway. Migration/exit: full user export on every plan (low data lock-in); password hashes are not exportable (standard for managed auth — migrating away means password resets).

**QualiOS needs.** Native Organisations are the deciding factor: memberships, invitations, org switching, Admin/Member roles and custom permissions out of the box; 100 orgs included, 20 members each by default; the $100/mo B2B add-on removes the member cap and adds custom roles/rolesets, verified domains and org-linked SSO. Invites native. Per-tenant roles: base roles included, custom roles need the add-on. MFA per org: code-enforced (see above). Audit trail: Clerk's own logs are short-lived (7 days on Pro) — QualiOS must stream auth events via webhooks into its own audit ledger regardless of provider; plan for that from day one.

### 2. Auth0 (Okta) — strongest enterprise platform, wrong price curve for now

**Enterprise fit.** The deepest enterprise feature set of the five: Organisations, enterprise connections (SAML/OIDC), SCIM (users + groups, GA Jun 2026), adaptive MFA, attack protection, Actions extensibility, log streaming to SIEMs, private-cloud deployment, 99.99% SLA on Enterprise. Log retention up to 30 days (Enterprise).

**Pricing.** The problem is the curve, not the entry price: $35/mo B2C Essentials at startup, but $1,300/mo B2B Essentials at 5,000 MAU / 100 orgs, $2,100/mo at 10,000 MAU, and self-serve pricing ends past 30,000 MAU. B2C paid tiers cap orgs at 10 and drop SSO/SCIM, so any real B2B deployment is forced onto the B2B price list. Enterprise pricing is unpublished.

**Data requirements.** Best residency story: per-tenant regions US, EU, UK, Japan, Australia, Canada; private cloud on AWS/Azure. SOC 2 Type II, ISO 27001, PCI DSS, GDPR; HIPAA BAA available (Enterprise add-on, not on Azure deployments); public DPA.

**Developer fit.** Mature SDKs including Next.js (`@auth0/nextjs-auth0`); Actions/Forms extensibility; larger configuration surface and steeper learning curve than Clerk. User export via Management API; password-hash export is support-assisted.

**QualiOS needs.** Organisations + RBAC per org + invites are all native and mature. Per-org MFA enforcement is available (MFA policies / Actions). The blocker is purely commercial: at the scale QualiOS expects to reach in its first year or two, Auth0 B2B costs ~10× Clerk for the same users, and the bill grows with MAU tiers whether or not those users are paying customers.

**Verdict:** the provider to revisit if/when an enterprise customer contractually requires EU data residency, ISO 27001, or a private deployment — i.e. when the deal size justifies the price. Not the starting provider.

### 3. Supabase Auth — cheapest metered auth, but no B2B layer and a platform decision attached

**Enterprise fit.** Weakest enterprise story: SAML SSO only on paid plans at $0.015/SSO MAU after 50 included; **no SCIM**; no SLA below Enterprise; SOC 2 / ISO 27001 only on Team ($599/mo); HIPAA only as a paid add-on on Team+. Audit log 1 hour on Free.

**Pricing.** Cheapest at scale on paper: $25/mo Pro covers 100,000 MAU; ≈$25/mo at both QualiOS scales. But the plan fee is per Supabase organisation and compute is billed per project on top.

**Data requirements.** Region choice per project (US, EU, CA, APAC regions available); SOC 2 Type II / ISO 27001 on Team+; DPA available; HIPAA add-on on Team+.

**Developer fit.** The one structural advantage: users live in your own Postgres (`auth.users`) and RLS policies can key off `auth.uid()` directly — a natural fit for QualiOS's RLS architecture (ADR-004). But QualiOS already runs its own PostgreSQL; adopting Supabase Auth means either (a) moving the database onto the Supabase platform, or (b) self-hosting GoTrue (self-managed, defeats "managed auth"), or (c) using Supabase as a third-party auth consumer of another provider's tokens (which still needs a provider). That is a platform decision, not just an auth decision, and it is out of scope for OD-1. Supabase Auth has **no native organisations or multi-tenancy** — tenancy is built with RLS on a `tenant_id` column or `app_metadata`, which QualiOS would be building itself. MFA is TOTP per user; the "enforce MFA for organisation members" setting in Supabase docs applies to **Supabase dashboard organisation members, not to QualiOS end-users** — per-tenant end-user MFA enforcement would be custom code.

**QualiOS needs.** Invites, org roles, per-org MFA, org switching: all custom-built. Only the sign-in itself is managed.

**Verdict:** best value if QualiOS were already a Supabase-platform app with simple B2C auth. For a B2B multi-tenant product that needs organisations on day one, it trades $100/mo of vendor cost for weeks of B2B auth engineering and an unmade platform decision.

### 4. Firebase Authentication (Identity Platform) — cheapest metered auth, B2C-first

**Enterprise fit.** SAML/OIDC via Identity Platform ($0.015/MAU after 50 free); multi-tenancy via tenants at no extra cost; **no native Organisations, no SCIM**; no passkeys documented; enterprise support/SLA via Google Cloud support plans. Audit logging via Cloud Logging (retention configurable).

**Pricing.** $0 at both QualiOS scales; $275/mo at 100,000 MAU. The cheapest metered option in this evaluation.

**Data requirements.** Google Cloud BAA available (verify Identity Platform scope at contracting). Listed as US-only for data residency in third-party spec checks — **verify with Google before relying on any EU residency claim**. SOC 2 Type II and ISO 27001 at Google Cloud level.

**Developer fit.** Firebase Admin SDK (Node) with `TenantAwareAuth`; solid for B2C/mobile; no org primitives, no prebuilt B2B UI. Password hashes exportable via Admin SDK (with scrypt parameters) — the cleanest exit of the five.

**QualiOS needs.** Tenants give isolated user silos, but organisations, roles, invites, per-org MFA and org switching are all custom-built on top. No SCIM path for enterprise customers.

**Verdict:** excellent if QualiOS were a B2C/mobile-first product on Google Cloud. For a B2B SaaS whose core unit is the organisation, it leaves the entire B2B layer to be built and maintained in-house.

### 5. AWS Cognito — best compliance footprint, weakest B2B ergonomics

**Enterprise fit.** SAML/OIDC on all tiers ($0.015/MAU after 50 free); MFA (SMS/authenticator apps) on Lite/Essentials; passwordless + passkeys on Essentials; **no SCIM**; **no native Organisations** — multi-tenancy is groups in one pool or a pool per tenant, both operationally heavy at 100 orgs. Exportable user activity logs only on Plus ($0.020/MAU, no free tier). AWS service SLA applies; support via AWS Support plans.

**Pricing.** $0 at both QualiOS scales on Essentials; $495/mo (Lite) / $1,350/mo (Essentials) / $2,000/mo (Plus) at 100,000 MAU. Plus is the tier that buys the audit-log export QualiOS would want — $100/mo at 5,000 users.

**Data requirements.** Broadest compliance footprint: SOC 2 Type II, ISO 27001/27018, HIPAA-eligible under the AWS BAA, PCI DSS Level 1, FedRAMP High. Data residency by region — user pools exist in US, EU, APAC and other AWS regions; pick the region per pool.

**Developer fit.** AWS SDKs; managed login (Essentials) is now properly brandable; Lambda triggers for customisation; but no hosted org UI, no prebuilt B2B components, and per-pool configuration is operationally heavy. Password hashes are not exportable — migrating away means password resets.

**QualiOS needs.** Sign-in, MFA and federation are solid; organisations, roles, invites, per-org MFA and org switching are all custom-built. The compliance story is the best of the five, but QualiOS's regulated customers are buying quality/compliance software, not asking QualiOS to be HIPAA/FedRAMP certified on day one — that footprint is not worth the B2B engineering cost at this stage.

**Verdict:** the right choice if QualiOS were already deep in AWS and needed FedRAMP/HIPAA-grade attestation early. Not the starting provider for a Next.js B2B SaaS.

## Comparison matrix

| Criterion                            | Clerk                                                 | Auth0                                        | Supabase Auth                                | Firebase Auth                       | Cognito                               |
| ------------------------------------ | ----------------------------------------------------- | -------------------------------------------- | -------------------------------------------- | ----------------------------------- | ------------------------------------- |
| Native organisations / multi-tenancy | Yes — best in class                                   | Yes                                          | No (build on RLS)                            | Tenants only, no orgs               | No (groups / pool per tenant)         |
| Per-tenant roles & permissions       | Base roles incl.; custom roles need $100/mo add-on    | Yes, RBAC per org (Essentials+)              | No — custom                                  | No — custom                         | No — custom (groups)                  |
| Invites                              | Native                                                | Native                                       | Custom                                       | Custom                              | Custom                                |
| MFA enforced per org                 | App-wide toggle native; per-org = code check          | Yes (policies/Actions)                       | Dashboard members only; end-users = custom   | Custom (per-tenant config + code)   | Custom (per-pool/group + code)        |
| SSO / SAML                           | 1 incl. on Pro; $75/mo extra (2–15)                   | B2B: 3 incl. Essentials; $100/mo extra       | $0.015/SSO MAU after 50                      | $0.015/MAU after 50                 | $0.015/MAU after 50                   |
| SCIM                                 | Included free per connection                          | Included (Free/B2B)                          | No                                           | No                                  | No                                    |
| Audit logs                           | 1d/7d/30d by plan; admin trail Business-only          | 1d/5d/10d/30d; streaming from Essentials     | 1h Free; longer on paid                      | Cloud Logging                       | Plus tier for exportable logs         |
| SLA                                  | 99.99% Enterprise only                                | 99.99% Enterprise only                       | Enterprise only                              | Via Google Cloud support            | AWS service SLA                       |
| Data residency                       | **US only**                                           | US/EU/UK/JP/AU/CA                            | Per-project region choice                    | US only (verify)                    | Per-region pools                      |
| SOC 2 Type 2                         | Yes (report Business+)                                | Yes                                          | Team+ ($599/mo)                              | Yes (Google Cloud)                  | Yes (AWS)                             |
| ISO 27001                            | No own cert ("via cloud providers")                   | Yes                                          | Team+ ($599/mo)                              | Yes (Google Cloud)                  | Yes                                   |
| HIPAA BAA                            | Enterprise only                                       | Enterprise add-on                            | Team+ paid add-on                            | Via Google Cloud BAA (verify scope) | Yes (AWS BAA)                         |
| DPA                                  | Public                                                | Available                                    | Available                                    | Google Cloud DPA                    | AWS DPA                               |
| Next.js / TS SDK                     | Best — `@clerk/nextjs`, prebuilt UI                   | Mature — `@auth0/nextjs-auth0`               | JS client; no B2B UI                         | Admin SDK; no B2B UI                | AWS SDKs; no B2B UI                   |
| Cost: startup (1 org, 10 users)      | $25/mo                                                | $35/mo (B2C Ess.)                            | $25/mo                                       | $0/mo                               | $0/mo                                 |
| Cost: scale (100 orgs, 5,000 users)  | **$125/mo**                                           | **$1,300/mo** (B2B Ess.)                     | ≈$25/mo                                      | $0/mo                               | $0/mo                                 |
| Cost: 100,000 users                  | $1,025/mo                                             | $3,500/mo @50k; 100k = quote                 | $25/mo                                       | $275/mo                             | $495–$2,000/mo                        |
| Lock-in / exit                       | User export all plans; password hashes not exportable | Export via API; hash export support-assisted | Users in own Postgres; GoTrue self-host exit | Hash export via Admin SDK           | Export via API; hashes not exportable |

## Recommendation

**Adopt Clerk (Pro plan, $25/mo) as the QualiOS managed auth provider, with the B2B Authentication add-on ($100/mo) added when custom roles or >20 members per org are needed — expected at the 100-org scale, total $125/mo.**

Reasons, in order:

1. **It is the only provider where the B2B organisation layer already exists.** Organisations, invitations, org switching, roles/permissions and SSO/SCIM are native. The directive's P0 is "implement real sign-up, tenant creation, invites, MFA, roles and tenant isolation tests" — Clerk delivers four of those five out of the box. Every other provider leaves invites, roles and org switching as custom engineering on top of a sign-in service, which is exactly the work the P0 is trying to avoid.
2. **It fits the stack.** `@clerk/nextjs` is the strongest Next.js/TypeScript integration of the five, with server-side `auth()` returning `orgId` — the exact value QualiOS's RLS layer needs as `app.current_organization_id`. Prebuilt sign-in/sign-up/org-switcher UI means the P1 flow (register company → SOP → training → audit export) can be built instead of an auth UI.
3. **The price is flat and survivable.** $25/mo from the pilot through 50,000 retained users; $125/mo at 100 orgs / 5,000 users with the B2B add-on. There is no per-MAU cliff, and the bill does not grow just because trial sign-ups bounce (MRU excludes them).
4. **Lock-in is bounded.** Full user export on every plan; the integration is isolated behind QualiOS's own session/tenant mapping, so a future move (e.g. to Auth0 for EU residency) is a migration project, not a rewrite.
5. **The enterprise path exists without re-platforming.** One SSO connection is included on Pro; SCIM is free per connection; Business ($300/mo) adds the SOC 2 report, admin audit trail and priority support when enterprise buyers ask for them; Enterprise (custom quote) adds the 99.99% SLA and HIPAA BAA.

**Known risks and mitigations:**

- **US-only data residency (biggest risk).** Clerk offers no region selection. Mitigation: disclose it in the DPA/security posture now; keep QualiOS's own data (Postgres, storage) region-flexible so only the identity data is US-hosted; revisit Auth0 (EU regions, ISO 27001) if/when a paying customer contractually requires EU residency. Do not promise EU residency to any customer until that move is made.
- **No own ISO 27001.** Mitigation: SOC 2 Type 2 (Business+) covers most early security questionnaires; ISO 27001 becomes a decision point alongside the residency question.
- **Short audit-log retention (7 days on Pro).** Mitigation: stream Clerk webhook events (sign-in, MFA, invite, role change) into QualiOS's own append-only audit ledger from day one — this is required by ADR-012/§6 of the directive regardless of provider, and it makes the provider's retention a non-issue.
- **Per-org MFA is code-enforced, not a dashboard toggle.** Mitigation: implement it as an org setting in QualiOS + a server-side check (user MFA state) on org access; default MFA required for org admins from launch.
- **SaaS-only, no self-hosting.** Accepted: QualiOS is a SaaS product; self-hosting auth is explicitly out of scope.
- **HIPAA BAA only on Enterprise.** Not a current requirement (QualiOS's markets are quality/compliance software, not PHI handling). Revisit if a healthcare/pharma customer requires it.

**Runner-up:** Auth0 — revisit when EU residency, ISO 27001, or private deployment becomes a contractual requirement on a deal large enough to carry $1,300+/mo. Supabase Auth is the fallback if QualiOS later moves its platform onto Supabase, and only then.

## What implementation needs from Devon

No Clerk account, keys, or configuration exist yet. Nothing can be implemented until Devon provides the following. **This is the exact ask:**

1. **Create a Clerk account** at https://clerk.com — sign up with the Herba Farms / QualiOS business email Devon wants as the account owner (recommend a shared company address, not a personal inbox, so the account survives any single person).
2. **Create one Clerk application** (instance) for QualiOS — name it `QualiOS` (production instance; a separate development instance is created automatically by Clerk).
3. **Provide the two API keys** for the production instance — the **Publishable Key** (`pk_live_…`) and the **Secret Key** (`sk_live_…`) — via Muse's secure credential flow, **not** in chat or email. The Secret Key must never be committed to the repo or pasted into a document.
4. **Approve the spend:** Pro plan **$25/mo** (or $20/mo billed annually — $240/yr), charged to a company card in the Clerk dashboard. The B2B Authentication add-on (**$100/mo**) is **not** needed on day one; approve it later when custom roles or >20 members per org are required.
5. **Decide (Devon's call, needed before configuration):**
   - Sign-in methods at launch: email + password and/or Google OAuth and/or magic links?
   - MFA policy at launch: require MFA for **all** users, or only for org admins? (Recommendation: all users — it is a compliance product.)
   - May users have Personal Accounts, or must every user belong to an Organisation? (Recommendation: organisations only — a QualiOS user without a tenant is a support problem.)
   - Custom domain for sign-in (e.g. `auth.qualios.ai`) — needs DNS access; can be added after launch.
6. **Accept Clerk's DPA** in the Clerk dashboard (available on Pro; required before any customer data flows through it).

Estimated implementation work once the above is provided (for planning, not committed here): replace the header auth stub with Clerk middleware + server-side `auth()`; map Clerk `orgId` → QualiOS `organization_id` for RLS; sync users/orgs via Svix-verified webhooks; enforce MFA-per-org in code; add tenant-isolation tests. That work is a separate build task (B-101 in the directive's terms) and is **not** part of this evaluation.

## What remains blocked until then

- **OD-1 stays open** until Devon approves this recommendation (or picks another provider) **and** provides the account/keys above.
- The API's production-start refusal stays in place — by design — until real auth lands.
- No customer can be onboarded, no pilot tenant created, and no end-to-end signup → SOP → training flow demonstrated until then.
- The B-110 core-cleanup and domain-model work can proceed in parallel; they do not depend on the auth choice, but their tenant-isolation tests do need a real `organization_id` source, which is Clerk's `orgId` under this recommendation.

## Notes for the implementer (not decisions)

- Keep QualiOS's own `users` / `organizations` / `memberships` tables as the system of record for tenant data; treat Clerk as the identity source and sync via webhooks. Never trust a tenant id from a request body or query string (ADR-008).
- Carry the Clerk `orgId` into the session token as a custom claim and resolve it to `app.current_organization_id` server-side; the API must still refuse in production if no verified session exists.
- Stream Clerk webhook events into QualiOS's audit ledger (sign-in, MFA enrolment, invite accepted, role changed, org created). Clerk's 7-day Pro log retention is not an audit trail.
- Per-org MFA: store `mfa_required` on the QualiOS organisation; on org access, verify the Clerk session's MFA state server-side and redirect to MFA enrolment when missing.
- Do not use Clerk's prebuilt components as the only protection: protect per-resource on the server (Clerk Core 3 guidance), not only in middleware.
- Re-check all prices on the vendor pages before the first invoice is budgeted; all five vendors changed pricing within the last two years.

---

_Prepared 20 Nov 2026 by Worker B (auth provider evaluation). Prices verified against vendor pricing pages and docs as cited; Enterprise tiers are unpublished by all five vendors and are stated as such. No account was created and no keys exist._
