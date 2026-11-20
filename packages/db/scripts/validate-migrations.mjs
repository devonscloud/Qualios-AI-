/**
 * Static structural validation for packages/db/migrations/*.sql.
 * This does NOT replace applying the migrations to a live PostgreSQL
 * (see CI, which applies them against a postgres:16 service). It checks:
 *  - every file has an UP section and exactly one `-- DOWN` marker line
 *  - the UP section creates the expected tables/views/types/policies
 *  - the DOWN section drops them
 *  - parentheses are balanced in the UP section (rough syntax sanity)
 *  - no DROP TABLE / DROP TYPE appears in the UP section
 * Usage: node scripts/validate-migrations.mjs (run from packages/db)
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = new URL("../migrations/", import.meta.url).pathname;

const EXPECTED = {
  "0001_tenancy.sql": {
    creates: ["organizations", "sites", "users", "roles", "memberships"],
    policies: 4,
  },
  "0002_products_inventory.sql": {
    creates: [
      "products",
      "lots",
      "batches",
      "batch_inputs",
      "inventory_locations",
      "inventory_movements",
      "inventory_positions",
    ],
    policies: 6,
  },
  "0003_documents.sql": {
    creates: ["documents", "document_versions", "extractions"],
    policies: 3,
  },
  "0004_reconciliation.sql": {
    creates: ["reconciliations", "reconciliation_lines", "discrepancies"],
    policies: 3,
  },
  "0005_excise.sql": {
    creates: ["excise_rules", "excise_calculations"],
    policies: 1,
  },
  "0006_listings.sql": {
    creates: ["distributor_listings", "listing_lines"],
    policies: 2,
  },
  "0007_approvals_audit.sql": {
    creates: ["approvals", "audit_events", "ai_interactions"],
    policies: 3,
  },
  // 0008 adds no tables and no policies. It recreates the
  // approval_action_type enum (to add DOCUMENT_REVIEW) inside its UP
  // section — ALTER TYPE ... ADD VALUE cannot run inside the transaction
  // the migrate runner uses, so recreation is the transactional way.
  // allowDropTypeInUp is the documented exception for exactly that.
  "0008_audit_chain.sql": {
    creates: [],
    policies: 0,
    allowDropTypeInUp: true,
  },
  // 0009 adds the import run/row tables (2 policies). Its ALTER TABLE
  // additions to reconciliations / reconciliation_lines / discrepancies are
  // not CREATE statements, so they are not listed in `creates`. The
  // discrepancy_status enum gains EXPLAINED via ALTER TYPE ... ADD VALUE —
  // safe here because no statement in this migration uses the new value
  // (it cannot be used until after this migration's transaction commits).
  "0009_imports.sql": {
    creates: ["import_runs", "import_rows"],
    policies: 2,
    contains: ["ALTER TYPE discrepancy_status ADD VALUE IF NOT EXISTS 'EXPLAINED'"],
  },
  // 0010 adds the SOP publish fields and the training tables (2 policies).
  // Its ALTER TYPE ... ADD VALUE statements follow the 0009 pattern: the
  // new values are not used by any statement in the migration itself.
  "0010_sop_training.sql": {
    creates: ["training_assignments", "training_completions"],
    policies: 2,
    contains: [
      "ALTER TYPE document_type ADD VALUE IF NOT EXISTS 'SOP'",
      "ALTER TYPE approval_action_type ADD VALUE IF NOT EXISTS 'SOP_PUBLISH'",
    ],
  },
  // 0011 removes the cannabis leaks from the core (B-110): pack enablement
  // and pack extension tables (4 policies). Its UP drops the old cannabis
  // enum types after converting the columns that used them — the documented
  // exception, same as 0008: no data is lost, values are preserved in pack
  // tables or converted to generic values first.
  "0011_b110_core_neutrality.sql": {
    creates: [
      "organization_packs",
      "product_taxonomy",
      "listing_types",
      "product_attributes",
      "lot_attributes",
      "lot_dispositions",
    ],
    policies: 4,
    allowDropTypeInUp: true,
  },
  // 0012 adds the integrated domain model: traceability links, the
  // double-entry ledger, inventory valuations, and the generic tax engine
  // (6 policies; tax_rules is shared reference configuration, no RLS).
  "0012_domain_model.sql": {
    creates: [
      "traceability_links",
      "gl_accounts",
      "journal_entries",
      "journal_lines",
      "inventory_valuations",
      "tax_rules",
      "tax_calculations",
    ],
    policies: 6,
  },
};

let failures = 0;
const fail = (file, msg) => {
  failures += 1;
  console.error(`FAIL ${file}: ${msg}`);
};

for (const file of readdirSync(dir)
  .filter((f) => f.endsWith(".sql"))
  .sort()) {
  const sql = readFileSync(join(dir, file), "utf8");
  const lines = sql.split("\n");
  const downAt = lines.findIndex((l) => l.trim() === "-- DOWN");
  if (downAt === -1) {
    fail(file, "no '-- DOWN' marker line");
    continue;
  }
  if (lines.filter((l) => l.trim() === "-- DOWN").length !== 1) {
    fail(file, "more than one '-- DOWN' marker line");
  }
  const up = lines.slice(0, downAt).join("\n");
  const down = lines.slice(downAt + 1).join("\n");
  const expected = EXPECTED[file];
  if (!expected) {
    fail(file, "unexpected migration file (not in EXPECTED list)");
    continue;
  }
  for (const name of expected.creates) {
    const re = new RegExp(`CREATE\\s+(TABLE|VIEW)\\s+${name}\\b`, "i");
    if (!re.test(up)) fail(file, `UP section does not CREATE ${name}`);
    const dropRe = new RegExp(`DROP\\s+(TABLE|VIEW)\\s+IF\\s+EXISTS\\s+${name}\\b`, "i");
    if (!dropRe.test(down)) fail(file, `DOWN section does not DROP ${name}`);
  }
  for (const snippet of expected.contains ?? []) {
    if (!up.includes(snippet)) fail(file, `UP section does not contain: ${snippet}`);
  }
  const policyCount = (up.match(/CREATE POLICY/g) ?? []).length;
  if (policyCount !== expected.policies) {
    fail(file, `expected ${expected.policies} CREATE POLICY in UP, found ${policyCount}`);
  }
  // UP must not drop tables/views. Dropping a TYPE in UP is only allowed
  // where the migration explicitly documents an enum recreation
  // (allowDropTypeInUp) — the old type is dropped after the new one is
  // created and the column is converted, so no data is lost.
  if (/DROP\s+(TABLE|VIEW)\s/i.test(up)) {
    fail(file, "UP section contains a DROP TABLE/VIEW statement");
  }
  if (/DROP\s+TYPE\s/i.test(up) && !expected.allowDropTypeInUp) {
    fail(file, "UP section contains a DROP TYPE statement");
  }
  const opens = (up.match(/\(/g) ?? []).length;
  const closes = (up.match(/\)/g) ?? []).length;
  if (opens !== closes) {
    fail(file, `unbalanced parentheses in UP: ${opens} '(' vs ${closes} ')'`);
  }
  console.log(`OK ${file}`);
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll migration files pass static validation.");
