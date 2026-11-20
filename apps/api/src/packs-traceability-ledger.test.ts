import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { createPool, runMigrations, runSeeds } from "@qualios/db";
import { createApp } from "./app.js";
import { withTenant } from "./lib/db.js";
import { postJournalEntry } from "./lib/ledger.js";

/**
 * Pack gate + traceability + ledger integration tests (B-110, domain model).
 * Needs a real PostgreSQL (DATABASE_URL) — CI provides one. Without
 * DATABASE_URL the suite is skipped rather than failing.
 *
 * Uses the two seeded demo tenants: Herba Farms (cannabis pack) and
 * Prairie Foods Co. (food pack). The food tenant proves the generic core
 * — traceability and the ledger — works for a non-cannabis industry, and
 * that the cannabis pack surfaces refuse it.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const hasDb = Boolean(DATABASE_URL);

const HERBA_ORG = "11111111-1111-4111-8111-111111111111";
const HERBA_OPS = "11111111-1111-4111-8111-111111111119";
const FOOD_ORG = "22222222-2222-4222-8222-222222222222";
const FOOD_QA = "22222222-2222-4222-8222-222222222224";
const FOOD_PRODUCT = "22222222-2222-4222-8222-222222222227";
const FOOD_LOT_PARENT = "22222222-2222-4222-8222-222222222228";

function headers(orgId: string, userId: string): Record<string, string> {
  return { "x-organization-id": orgId, "x-user-id": userId };
}

describe.skipIf(!hasDb)("pack gate + traceability + ledger (DB-backed)", () => {
  let server: ReturnType<ReturnType<typeof createApp>["listen"]>;
  let baseUrl: string;
  let pool: Pool;
  let childLotId: string;
  let cashAccountId: string;
  let revenueAccountId: string;
  let cogsAccountId: string;

  beforeAll(async () => {
    const dbPool = createPool(DATABASE_URL as string);
    await runMigrations(dbPool);
    await runSeeds(dbPool);
    await dbPool.end();

    pool = new Pool({ connectionString: DATABASE_URL });

    // A second food lot, produced from the seeded FS-1001 lot.
    childLotId = randomUUID();
    await pool.query(
      `INSERT INTO lots (id, organization_id, product_id, lot_number, status, approved_for_sale)
       VALUES ($1, $2, $3, 'FS-1002', 'ACTIVE', true)
       ON CONFLICT (id) DO NOTHING`,
      [childLotId, FOOD_ORG, FOOD_PRODUCT],
    );

    // A minimal chart of accounts for the food tenant.
    const accounts = await pool.query<{ id: string; code: string }>(
      `INSERT INTO gl_accounts (organization_id, code, name, account_type) VALUES
         ($1, '1000', 'Cash', 'ASSET'),
         ($1, '4000', 'Sales revenue', 'REVENUE'),
         ($1, '5000', 'Cost of goods sold', 'EXPENSE')
       ON CONFLICT (organization_id, code) DO NOTHING
       RETURNING id, code`,
      [FOOD_ORG],
    );
    const byCode = new Map(accounts.rows.map((row) => [row.code, row.id]));
    if (byCode.size < 3) {
      // Re-run safe: the accounts already existed from an earlier run.
      const existing = await pool.query<{ id: string; code: string }>(
        `SELECT id, code FROM gl_accounts WHERE organization_id = $1`,
        [FOOD_ORG],
      );
      for (const row of existing.rows) byCode.set(row.code, row.id);
    }
    cashAccountId = byCode.get("1000") as string;
    revenueAccountId = byCode.get("4000") as string;
    cogsAccountId = byCode.get("5000") as string;

    const app = createApp();
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (typeof address !== "object" || address === null) {
      throw new Error("test server did not bind");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
    if (pool) {
      await pool.end();
    }
  });

  it("the seed carries two demo tenants and pack-scoped cannabis attributes", async () => {
    const orgs = await pool.query<{ id: string; name: string }>(
      `SELECT id, name FROM organizations WHERE id IN ($1, $2) ORDER BY id`,
      [HERBA_ORG, FOOD_ORG],
    );
    expect(orgs.rows).toHaveLength(2);
    expect(orgs.rows[0].name).toMatch(/Herba Farms/);
    expect(orgs.rows[1].name).toMatch(/Prairie Foods/);
    const packs = await pool.query<{ organization_id: string; pack_id: string }>(
      `SELECT organization_id, pack_id FROM organization_packs ORDER BY organization_id`,
    );
    expect(packs.rows).toContainEqual({ organization_id: HERBA_ORG, pack_id: "cannabis-ca" });
    expect(packs.rows).toContainEqual({ organization_id: FOOD_ORG, pack_id: "food-ca" });
    // The core product table has no THC column; THC lives in pack attributes.
    const columns = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'products' AND column_name LIKE '%thc%'`,
    );
    expect(columns.rows).toHaveLength(0);
    const herbaProduct = await pool.query<{ category_key: string; taxonomy_pack_id: string }>(
      `SELECT category_key, taxonomy_pack_id FROM products
       WHERE id = '11111111-1111-4111-8111-111111111116'`,
    );
    expect(herbaProduct.rows[0]).toEqual({
      category_key: "DRIED_FLOWER",
      taxonomy_pack_id: "cannabis-ca",
    });
    const attributes = await pool.query(
      `SELECT count(*) AS n FROM product_attributes
       WHERE product_id = '11111111-1111-4111-8111-111111111116'`,
    );
    expect(Number(attributes.rows[0].n)).toBe(3);
    const taxonomy = await pool.query<{ n: string }>(`SELECT count(*) AS n FROM product_taxonomy`);
    expect(Number(taxonomy.rows[0].n)).toBe(21);
  });

  it("GET /api/packs reports each tenant's enabled packs", async () => {
    const herba = await fetch(`${baseUrl}/api/packs`, { headers: headers(HERBA_ORG, HERBA_OPS) });
    expect(herba.status).toBe(200);
    const herbaBody = (await herba.json()) as {
      packs: { id: string; enabled: boolean }[];
    };
    expect(herbaBody.packs).toHaveLength(3);
    expect(herbaBody.packs.find((pack) => pack.id === "cannabis-ca")?.enabled).toBe(true);
    expect(herbaBody.packs.find((pack) => pack.id === "food-ca")?.enabled).toBe(false);
    const food = await fetch(`${baseUrl}/api/packs`, { headers: headers(FOOD_ORG, FOOD_QA) });
    expect(food.status).toBe(200);
    const foodBody = (await food.json()) as {
      packs: { id: string; enabled: boolean }[];
    };
    expect(foodBody.packs.find((pack) => pack.id === "food-ca")?.enabled).toBe(true);
    expect(foodBody.packs.find((pack) => pack.id === "cannabis-ca")?.enabled).toBe(false);
  });

  it("the food tenant is refused the cannabis pack surfaces", async () => {
    for (const path of ["/api/imports", "/api/reconciliations", "/api/discrepancies"]) {
      const res = await fetch(`${baseUrl}${path}`, { headers: headers(FOOD_ORG, FOOD_QA) });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("PACK_NOT_ENABLED");
    }
    const excise = await fetch(`${baseUrl}/api/excise/calculate`, {
      body: JSON.stringify({}),
      headers: { ...headers(FOOD_ORG, FOOD_QA), "content-type": "application/json" },
      method: "POST",
    });
    expect(excise.status).toBe(403);
    // …while the Herba tenant reaches the same surfaces (excise is a stub, 501).
    const herbaExcise = await fetch(`${baseUrl}/api/excise/calculate`, {
      body: JSON.stringify({}),
      headers: { ...headers(HERBA_ORG, HERBA_OPS), "content-type": "application/json" },
      method: "POST",
    });
    expect(herbaExcise.status).toBe(501);
  });

  it("traceability: link, trace backward and forward on the food tenant", async () => {
    const created = await fetch(`${baseUrl}/api/traceability/links`, {
      body: JSON.stringify({
        child_lot_id: childLotId,
        link_type: "PRODUCED_FROM",
        parent_lot_id: FOOD_LOT_PARENT,
        quantity_units: 400,
      }),
      headers: { ...headers(FOOD_ORG, FOOD_QA), "content-type": "application/json" },
      method: "POST",
    });
    // Idempotent across re-runs: a re-created identical link is a 400
    // (the unique link already exists), which still proves it is stored.
    expect([201, 400]).toContain(created.status);
    const links = await fetch(`${baseUrl}/api/traceability/lots/${childLotId}/links`, {
      headers: headers(FOOD_ORG, FOOD_QA),
    });
    expect(links.status).toBe(200);
    const linksBody = (await links.json()) as {
      links: { parent_lot_id: string; child_lot_id: string; link_type: string }[];
    };
    expect(linksBody.links).toHaveLength(1);
    expect(linksBody.links[0]).toMatchObject({
      child_lot_id: childLotId,
      link_type: "PRODUCED_FROM",
      parent_lot_id: FOOD_LOT_PARENT,
    });

    const backward = await fetch(`${baseUrl}/api/traceability/lots/${childLotId}/backward`, {
      headers: headers(FOOD_ORG, FOOD_QA),
    });
    expect(backward.status).toBe(200);
    const backwardBody = (await backward.json()) as {
      nodes: { lotId: string; lotNumber: string; depth: number }[];
    };
    expect(backwardBody.nodes.map((node) => node.lotNumber).sort()).toEqual(["FS-1001", "FS-1002"]);
    expect(backwardBody.nodes.find((node) => node.lotNumber === "FS-1001")?.depth).toBe(1);

    const forward = await fetch(`${baseUrl}/api/traceability/lots/${FOOD_LOT_PARENT}/forward`, {
      headers: headers(FOOD_ORG, FOOD_QA),
    });
    expect(forward.status).toBe(200);
    const forwardBody = (await forward.json()) as {
      nodes: { lotNumber: string; depth: number }[];
    };
    expect(forwardBody.nodes.map((node) => node.lotNumber).sort()).toEqual(["FS-1001", "FS-1002"]);
  });

  it("traceability: a reverse link is refused as a cycle, and cross-tenant lots are 404", async () => {
    const cycle = await fetch(`${baseUrl}/api/traceability/links`, {
      body: JSON.stringify({
        child_lot_id: FOOD_LOT_PARENT,
        link_type: "MERGED_INTO",
        parent_lot_id: childLotId,
      }),
      headers: { ...headers(FOOD_ORG, FOOD_QA), "content-type": "application/json" },
      method: "POST",
    });
    expect(cycle.status).toBe(400);
    const cycleBody = (await cycle.json()) as { error: { code: string } };
    expect(cycleBody.error.code).toBe("TRACE_CYCLE");

    const crossTenant = await fetch(`${baseUrl}/api/traceability/links`, {
      body: JSON.stringify({
        child_lot_id: childLotId,
        link_type: "PRODUCED_FROM",
        parent_lot_id: "11111111-1111-4111-8111-111111111117",
      }),
      headers: { ...headers(FOOD_ORG, FOOD_QA), "content-type": "application/json" },
      method: "POST",
    });
    expect(crossTenant.status).toBe(404);

    const otherTenant = await fetch(`${baseUrl}/api/traceability/lots/${childLotId}/backward`, {
      headers: headers(HERBA_ORG, HERBA_OPS),
    });
    expect(otherTenant.status).toBe(404);
  });

  it("ledger: a balanced entry posts, and replaying its source returns the original", async () => {
    const sourceId = randomUUID();
    const first = await withTenant(FOOD_ORG, async (client) =>
      postJournalEntry(client, {
        createdBy: FOOD_QA,
        entry: {
          entryDate: "2026-11-20",
          lines: [
            { accountId: cashAccountId, creditCents: 0, debitCents: 25000 },
            { accountId: revenueAccountId, creditCents: 25000, debitCents: 0 },
          ],
          memo: "Soup sale, test",
          sourceId,
          sourceModule: "finance",
          sourceType: "sales_invoice",
        },
        organizationId: FOOD_ORG,
      }),
    );
    expect(first.duplicate).toBe(false);
    expect(first.status).toBe("POSTED");
    const replay = await withTenant(FOOD_ORG, async (client) =>
      postJournalEntry(client, {
        createdBy: FOOD_QA,
        entry: {
          entryDate: "2026-11-20",
          lines: [
            { accountId: cashAccountId, creditCents: 0, debitCents: 25000 },
            { accountId: revenueAccountId, creditCents: 25000, debitCents: 0 },
          ],
          memo: "Soup sale, test",
          sourceId,
          sourceModule: "finance",
          sourceType: "sales_invoice",
        },
        organizationId: FOOD_ORG,
      }),
    );
    expect(replay.duplicate).toBe(true);
    expect(replay.id).toBe(first.id);
    const count = await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM journal_entries WHERE organization_id = $1 AND source_id = $2`,
      [FOOD_ORG, sourceId],
    );
    expect(Number(count.rows[0].n)).toBe(1);
  });

  it("ledger: an unbalanced entry cannot post, at the API or the database", async () => {
    await expect(
      withTenant(FOOD_ORG, async (client) =>
        postJournalEntry(client, {
          createdBy: FOOD_QA,
          entry: {
            entryDate: "2026-11-20",
            lines: [
              { accountId: cashAccountId, creditCents: 0, debitCents: 25000 },
              { accountId: revenueAccountId, creditCents: 24000, debitCents: 0 },
            ],
            sourceId: randomUUID(),
            sourceModule: "finance",
            sourceType: "sales_invoice",
          },
          organizationId: FOOD_ORG,
        }),
      ),
    ).rejects.toThrow(/Unbalanced/);

    // Database backstop: a DRAFT entry with unbalanced lines cannot be
    // flipped to POSTED by raw SQL either.
    const entryId = randomUUID();
    await pool.query(
      `INSERT INTO journal_entries
         (id, organization_id, entry_date, source_module, source_type, source_id,
          idempotency_key, status, created_by)
       VALUES ($1, $2, '2026-11-20', 'finance', 'sales_invoice', $3, $4, 'DRAFT', $5)`,
      [entryId, FOOD_ORG, randomUUID(), `finance:sales_invoice:${randomUUID()}`, FOOD_QA],
    );
    await pool.query(
      `INSERT INTO journal_lines (journal_entry_id, account_id, debit_cents, credit_cents)
       VALUES ($1, $2, 100, 0), ($1, $3, 0, 90)`,
      [entryId, cashAccountId, revenueAccountId],
    );
    await expect(
      pool.query(`UPDATE journal_entries SET status = 'POSTED' WHERE id = $1`, [entryId]),
    ).rejects.toThrow(/unbalanced/i);
    // …and a posted entry's lines are immutable.
    const posted = await pool.query<{ id: string }>(
      `SELECT id FROM journal_entries WHERE organization_id = $1 AND status = 'POSTED' LIMIT 1`,
      [FOOD_ORG],
    );
    await expect(
      pool.query(
        `INSERT INTO journal_lines (journal_entry_id, account_id, debit_cents, credit_cents)
         VALUES ($1, $2, 1, 0)`,
        [posted.rows[0].id, cogsAccountId],
      ),
    ).rejects.toThrow(/immutable/i);
  });

  it("tax: a generic versioned rule and a calculation hook to the ledger", async () => {
    const rule = await pool.query<{ id: string }>(
      `INSERT INTO tax_rules
         (jurisdiction, tax_type, basis, rate_numeric, rate_unit, effective_from, pack_id, status)
       VALUES ('CA-MB', 'SALES_TAX', 'PER_KG', 0.07, 'kg', '2026-01-01', 'food-ca', 'ACTIVE')
       RETURNING id`,
    );
    const ruleId = rule.rows[0].id;
    const entry = await withTenant(FOOD_ORG, async (client) =>
      postJournalEntry(client, {
        createdBy: FOOD_QA,
        entry: {
          entryDate: "2026-11-20",
          lines: [
            { accountId: cogsAccountId, creditCents: 0, debitCents: 700 },
            { accountId: cashAccountId, creditCents: 700, debitCents: 0 },
          ],
          sourceId: randomUUID(),
          sourceModule: "tax",
          sourceType: "tax_calculation",
        },
        organizationId: FOOD_ORG,
      }),
    );
    const calc = await pool.query<{ id: string }>(
      `INSERT INTO tax_calculations
         (organization_id, tax_rule_id, subject_type, subject_id, jurisdiction,
          basis_snapshot, taxable_amount_cents, tax_amount_cents, calculated_by,
          status, journal_entry_id)
       VALUES ($1, $2, 'sales_invoice', $3, 'CA-MB', 'PER_KG @ 0.07', 10000, 700, $4, 'DRAFT', $5)
       RETURNING id`,
      [FOOD_ORG, ruleId, randomUUID(), FOOD_QA, entry.id],
    );
    expect(calc.rows).toHaveLength(1);
    // The cannabis pack's excise tables carry their pack id (B-110, leak 6).
    const exciseColumns = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'excise_rules' AND column_name = 'pack_id'`,
    );
    expect(exciseColumns.rows).toHaveLength(1);
  });
});
