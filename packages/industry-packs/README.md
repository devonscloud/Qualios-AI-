# packages/industry-packs

The industry-pack mechanism (B-110). The shared core is industry-neutral;
a pack contributes taxonomy values, listing types, tax bases, lot
dispositions, import file header aliases, product attribute keys, and
source systems — without any core code change.

Packs registered here:

- `cannabis-ca` — Canadian cannabis (IN_PROGRESS). Registers
  `PER_MG_THC` as a tax basis, the seed-to-sale source system, the
  `strain` import header alias, THC/strain product attributes, and the
  destruction dispositions. Validated on the Herba Farms pilot.
- `food-ca` — Food & beverage (IN_PROGRESS). Demo pack for the second
  synthetic tenant (Prairie Foods Co.).
- `industrial-generic` — Industrial manufacturing (STUB). Proves the
  mechanism works with more than one pack.

Tenants enable packs in `organization_packs` (migration 0011). Pack
surfaces in the API (imports, reconciliations, discrepancies, excise)
are gated on the tenant's enabled packs — see
`apps/api/src/lib/packs.ts`.

Each new pack requires a jurisdictional gap assessment and domain-expert
review before being sold as compliance-ready (blueprint §6).
