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
const HERBA_SITE = "11111111-1111-4111-8111-111111111112";
const HERBA_LOCATION = "11111111-1111-4111-8111-111111111118";
const HERBA_PRODUCT = "11111111-1111-4111-8111-111111111116";
const FOOD_ORG = "22222222-2222-4222-8222-222222222222";
const FOOD_QA = "22222222-2222-4222-8222-222222222224";
const FOOD_SITE = "22222222-2222-4222-8222-222222222223";
const FOOD_LOCATION = "22222222-2222-4222-8222-222222222229";
const FOOD_PRODUCT = "22222222-2222-4222-8222-222222222227";
const FOOD_LOT_PARENT = "22222222-2222-4222-8222-222222222228";
const P1_RUN = randomUUID().slice(0, 8);

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
    // Re-run safe: (organization_id, lot_number) is unique, so a second run
    // against the same database must not re-insert FS-1002.
    const insertedLot = await pool.query<{ id: string }>(
      `INSERT INTO lots (id, organization_id, product_id, lot_number, status, approved_for_sale)
       VALUES ($1, $2, $3, 'FS-1002', 'ACTIVE', true)
       ON CONFLICT (organization_id, lot_number) DO NOTHING
       RETURNING id`,
      [randomUUID(), FOOD_ORG, FOOD_PRODUCT],
    );
    if (insertedLot.rows.length > 0) {
      childLotId = insertedLot.rows[0].id;
    } else {
      const existingLot = await pool.query<{ id: string }>(
        `SELECT id FROM lots WHERE organization_id = $1 AND lot_number = 'FS-1002'`,
        [FOOD_ORG],
      );
      childLotId = existingLot.rows[0].id;
    }

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

  /**
   * Run the full P1 traceability chain over HTTP for one tenant and return
   * the ids, positions, traces, and consistency checks. Lot numbers are
   * run-scoped (P1_RUN), so consecutive runs against the same database
   * never collide with an earlier run's lots.
   */
  async function runTraceChain(args: {
    orgId: string;
    userId: string;
    productId: string;
    siteId: string;
    locationId: string;
    tag: string;
  }): Promise<{
    rawLotId: string;
    rawLotNumber: string;
    finishedLotId: string;
    shipmentLotId: string;
    batchId: string;
    batch: { status: string };
    positions: { rawMg: number; finishedMg: number; shipmentMg: number };
    backwardLotNumbers: string[];
    forwardLotNumbers: string[];
    traceCheck: {
      raw: { consistent: boolean };
      finished: { consistent: boolean };
      shipment: { consistent: boolean };
    };
  }> {
    const { orgId, userId, productId, siteId, locationId, tag } = args;
    const auth = { ...headers(orgId, userId), "content-type": "application/json" };
    const post = async (path: string, body: unknown): Promise<Response> =>
      fetch(`${baseUrl}${path}`, {
        body: JSON.stringify(body),
        headers: auth,
        method: "POST",
      });
    const rawLotNumber = `${tag}-RAW`;
    const finLotNumber = `${tag}-FIN`;
    const shipLotNumber = `${tag}-SHIP`;

    const received = await post("/api/v1/traceability/receive", {
      location_id: locationId,
      lot_number: rawLotNumber,
      product_id: productId,
      quantity_mg: 10000,
      quantity_units: 100,
    });
    expect(received.status).toBe(201);
    const receivedBody = (await received.json()) as {
      lot: { id: string; lot_number: string };
      movement: { movement_type: string; quantity_mg: number };
    };
    expect(receivedBody.movement.movement_type).toBe("RECEIVE");
    const rawLotId = receivedBody.lot.id;

    const batch = await post("/api/v1/traceability/batches", {
      inputs: [{ lot_id: rawLotId, quantity_mg: 4000, quantity_units: 40 }],
      output_lot_number: finLotNumber,
      output_product_id: productId,
      planned_quantity_mg: 4000,
      site_id: siteId,
    });
    expect(batch.status).toBe(201);
    const batchBody = (await batch.json()) as {
      batch: { id: string; status: string };
      outputLot: { id: string };
      links: { link_type: string }[];
    };
    expect(batchBody.batch.status).toBe("PLANNED");
    expect(batchBody.links).toHaveLength(1);
    expect(batchBody.links[0].link_type).toBe("CONSUMED_IN");
    const finishedLotId = batchBody.outputLot.id;

    const completed = await post(`/api/v1/traceability/batches/${batchBody.batch.id}/complete`, {
      location_id: locationId,
      produced_quantity_mg: 4000,
      produced_quantity_units: 40,
    });
    expect(completed.status).toBe(200);
    const completedBody = (await completed.json()) as {
      batch: { status: string };
      movements: { movement_type: string; quantity_mg: number }[];
      outputLot: { approved_for_sale: boolean };
    };
    expect(completedBody.batch.status).toBe("COMPLETED");
    expect(completedBody.outputLot.approved_for_sale).toBe(true);
    expect(
      completedBody.movements.map((m) => `${m.movement_type}:${m.quantity_mg}`).sort(),
    ).toEqual(["CONSUME:-4000", "PRODUCE:4000"]);

    const shipped = await post("/api/v1/traceability/ship", {
      location_id: locationId,
      lot_id: finishedLotId,
      quantity_mg: 1000,
      quantity_units: 10,
      shipment_lot_number: shipLotNumber,
      shipment_reference: `SHIP-${tag}`,
    });
    expect(shipped.status).toBe(201);
    const shippedBody = (await shipped.json()) as {
      shipmentLot: { id: string };
      link: { link_type: string };
      movements: { movement_type: string; quantity_mg: number }[];
    };
    expect(shippedBody.link.link_type).toBe("SHIPPED_AS");
    const shipmentLotId = shippedBody.shipmentLot.id;

    const positionOf = async (lotId: string): Promise<number> => {
      const res = await fetch(`${baseUrl}/api/v1/traceability/lots/${lotId}/positions`, {
        headers: headers(orgId, userId),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { position: { quantityMg: number } };
      return body.position.quantityMg;
    };
    const traceOf = async (lotId: string, direction: "backward" | "forward"): Promise<string[]> => {
      const res = await fetch(`${baseUrl}/api/v1/traceability/lots/${lotId}/${direction}`, {
        headers: headers(orgId, userId),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { nodes: { lotNumber: string; depth: number }[] };
      return body.nodes.sort((a, b) => a.depth - b.depth).map((node) => node.lotNumber);
    };
    const checkOf = async (lotId: string): Promise<{ consistent: boolean }> => {
      const res = await fetch(`${baseUrl}/api/v1/traceability/lots/${lotId}/trace-check`, {
        headers: headers(orgId, userId),
      });
      expect(res.status).toBe(200);
      return (await res.json()) as { consistent: boolean };
    };
    return {
      backwardLotNumbers: await traceOf(shipmentLotId, "backward"),
      batch: completedBody.batch,
      batchId: batchBody.batch.id,
      finishedLotId,
      forwardLotNumbers: await traceOf(rawLotId, "forward"),
      positions: {
        finishedMg: await positionOf(finishedLotId),
        rawMg: await positionOf(rawLotId),
        shipmentMg: await positionOf(shipmentLotId),
      },
      rawLotId,
      rawLotNumber,
      shipmentLotId,
      traceCheck: {
        finished: await checkOf(finishedLotId),
        raw: await checkOf(rawLotId),
        shipment: await checkOf(shipmentLotId),
      },
    };
  }

  it("traceability POC: receive -> batch -> finish -> ship on the Herba tenant", async () => {
    const chain = await runTraceChain({
      locationId: HERBA_LOCATION,
      orgId: HERBA_ORG,
      productId: HERBA_PRODUCT,
      siteId: HERBA_SITE,
      tag: `HF-${P1_RUN}`,
      userId: HERBA_OPS,
    });
    expect(chain.rawLotNumber).toBe(`HF-${P1_RUN}-RAW`);
    expect(chain.batch.status).toBe("COMPLETED");
    expect(chain.positions.rawMg).toBe(6000);
    expect(chain.positions.finishedMg).toBe(3000);
    expect(chain.positions.shipmentMg).toBe(1000);
    expect(chain.traceCheck.finished.consistent).toBe(true);
    expect(chain.traceCheck.raw.consistent).toBe(true);
    expect(chain.traceCheck.shipment.consistent).toBe(true);
    // Recall-style backward trace from the shipped lot reaches the source.
    // Backward trace lists depth 0 first: the shipped lot, then the
    // finished lot, then the source lot.
    expect(chain.backwardLotNumbers).toEqual([
      `HF-${P1_RUN}-SHIP`,
      `HF-${P1_RUN}-FIN`,
      `HF-${P1_RUN}-RAW`,
    ]);
    expect(chain.forwardLotNumbers).toEqual([
      `HF-${P1_RUN}-RAW`,
      `HF-${P1_RUN}-FIN`,
      `HF-${P1_RUN}-SHIP`,
    ]);
    // Shipping more than the ledger holds is refused; completing twice is refused.
    const overship = await fetch(`${baseUrl}/api/v1/traceability/ship`, {
      body: JSON.stringify({
        lot_id: chain.finishedLotId,
        location_id: HERBA_LOCATION,
        quantity_mg: 999999,
        quantity_units: 10,
        shipment_lot_number: `HF-${P1_RUN}-SHIP2`,
      }),
      headers: { ...headers(HERBA_ORG, HERBA_OPS), "content-type": "application/json" },
      method: "POST",
    });
    expect(overship.status).toBe(409);
    const overshipBody = (await overship.json()) as { error: { code: string } };
    expect(overshipBody.error.code).toBe("INSUFFICIENT_STOCK");
    const reComplete = await fetch(
      `${baseUrl}/api/v1/traceability/batches/${chain.batchId}/complete`,
      {
        body: JSON.stringify({
          location_id: HERBA_LOCATION,
          produced_quantity_mg: 4000,
          produced_quantity_units: 40,
        }),
        headers: { ...headers(HERBA_ORG, HERBA_OPS), "content-type": "application/json" },
        method: "POST",
      },
    );
    expect(reComplete.status).toBe(409);
  });

  it("traceability POC: the same generic chain runs on the food tenant", async () => {
    const chain = await runTraceChain({
      locationId: FOOD_LOCATION,
      orgId: FOOD_ORG,
      productId: FOOD_PRODUCT,
      siteId: FOOD_SITE,
      tag: `PF-${P1_RUN}`,
      userId: FOOD_QA,
    });
    expect(chain.positions.rawMg).toBe(6000);
    expect(chain.positions.finishedMg).toBe(3000);
    expect(chain.positions.shipmentMg).toBe(1000);
    expect(chain.traceCheck.finished.consistent).toBe(true);
    expect(chain.backwardLotNumbers).toEqual([
      `PF-${P1_RUN}-SHIP`,
      `PF-${P1_RUN}-FIN`,
      `PF-${P1_RUN}-RAW`,
    ]);
    // The food tenant's chain is invisible to Herba (tenant isolation).
    const otherTenant = await fetch(
      `${baseUrl}/api/v1/traceability/lots/${chain.shipmentLotId}/backward`,
      { headers: headers(HERBA_ORG, HERBA_OPS) },
    );
    expect(otherTenant.status).toBe(404);
  });

  it("finance routes: a balanced entry posts, replays idempotently, unbalanced is refused", async () => {
    const chartRes = await fetch(`${baseUrl}/api/v1/finance/accounts/ensure-chart`, {
      headers: { ...headers(FOOD_ORG, FOOD_QA), "content-type": "application/json" },
      method: "POST",
    });
    expect(chartRes.status).toBe(200);
    const accountsBody = (await fetch(`${baseUrl}/api/v1/finance/accounts`, {
      headers: headers(FOOD_ORG, FOOD_QA),
    }).then((res) => res.json())) as {
      accounts: { id: string; code: string }[];
    };
    const byCode = new Map(accountsBody.accounts.map((account) => [account.code, account.id]));
    const inventoryId = byCode.get("1200") as string;
    const payablesId = byCode.get("2000") as string;
    expect(inventoryId).toBeTruthy();
    expect(payablesId).toBeTruthy();

    const sourceId = randomUUID();
    const entryBody = {
      entry_date: "2026-11-20",
      lines: [
        { account_id: inventoryId, credit_cents: 0, debit_cents: 10000 },
        { account_id: payablesId, credit_cents: 10000, debit_cents: 0 },
      ],
      memo: "Supplier receipt, route test",
      source_id: sourceId,
      source_module: "finance",
      source_type: "supplier_receipt",
    };
    const first = await fetch(`${baseUrl}/api/v1/finance/journal-entries`, {
      body: JSON.stringify(entryBody),
      headers: { ...headers(FOOD_ORG, FOOD_QA), "content-type": "application/json" },
      method: "POST",
    });
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as {
      duplicate: boolean;
      entry: { id: string; status: string; lines: unknown[] };
    };
    expect(firstBody.duplicate).toBe(false);
    expect(firstBody.entry.status).toBe("POSTED");
    expect(firstBody.entry.lines).toHaveLength(2);

    const replay = await fetch(`${baseUrl}/api/v1/finance/journal-entries`, {
      body: JSON.stringify(entryBody),
      headers: { ...headers(FOOD_ORG, FOOD_QA), "content-type": "application/json" },
      method: "POST",
    });
    expect(replay.status).toBe(200);
    const replayBody = (await replay.json()) as {
      duplicate: boolean;
      entry: { id: string };
    };
    expect(replayBody.duplicate).toBe(true);
    expect(replayBody.entry.id).toBe(firstBody.entry.id);

    const unbalanced = await fetch(`${baseUrl}/api/v1/finance/journal-entries`, {
      body: JSON.stringify({
        ...entryBody,
        lines: [
          { account_id: inventoryId, credit_cents: 0, debit_cents: 10000 },
          { account_id: payablesId, credit_cents: 9999, debit_cents: 0 },
        ],
        source_id: randomUUID(),
      }),
      headers: { ...headers(FOOD_ORG, FOOD_QA), "content-type": "application/json" },
      method: "POST",
    });
    expect(unbalanced.status).toBe(400);
    const unbalancedBody = (await unbalanced.json()) as { error: { code: string } };
    expect(unbalancedBody.error.code).toBe("UNBALANCED_ENTRY");

    const unknownAccount = await fetch(`${baseUrl}/api/v1/finance/journal-entries`, {
      body: JSON.stringify({
        ...entryBody,
        lines: [
          { account_id: randomUUID(), credit_cents: 0, debit_cents: 10000 },
          { account_id: payablesId, credit_cents: 10000, debit_cents: 0 },
        ],
        source_id: randomUUID(),
      }),
      headers: { ...headers(FOOD_ORG, FOOD_QA), "content-type": "application/json" },
      method: "POST",
    });
    expect(unknownAccount.status).toBe(404);
  });

  it("finance flow: supplier receipt -> consumption/COGS -> sale/AR moves valuation and AP/AR", async () => {
    await fetch(`${baseUrl}/api/v1/finance/accounts/ensure-chart`, {
      headers: { ...headers(HERBA_ORG, HERBA_OPS), "content-type": "application/json" },
      method: "POST",
    });
    const readBalances = async (): Promise<Map<string, { debit: number; credit: number }>> => {
      const res = await fetch(`${baseUrl}/api/v1/finance/accounts`, {
        headers: headers(HERBA_ORG, HERBA_OPS),
      });
      const body = (await res.json()) as {
        accounts: { code: string; debitTotalCents: number; creditTotalCents: number }[];
      };
      return new Map(
        body.accounts.map((account) => [
          account.code,
          { credit: account.creditTotalCents, debit: account.debitTotalCents },
        ]),
      );
    };
    const before = await readBalances();
    const flowBody = {
      entry_date: "2026-11-20",
      lot_id: "11111111-1111-4111-8111-111111111117",
      product_id: HERBA_PRODUCT,
      receipt: { amount_cents: 20000, source_id: randomUUID(), unit_cost_cents: 200 },
      consumption: { amount_cents: 8000, source_id: randomUUID() },
      sale: { amount_cents: 30000, source_id: randomUUID() },
    };
    const first = await fetch(`${baseUrl}/api/v1/finance/flows/supplier-to-sale`, {
      body: JSON.stringify(flowBody),
      headers: { ...headers(HERBA_ORG, HERBA_OPS), "content-type": "application/json" },
      method: "POST",
    });
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as {
      receipt: { status: string; duplicate: boolean };
      consumption: { status: string; duplicate: boolean };
      sale: { status: string; duplicate: boolean };
      valuations: { totalCents: number }[];
    };
    expect(firstBody.receipt.status).toBe("POSTED");
    expect(firstBody.consumption.status).toBe("POSTED");
    expect(firstBody.sale.status).toBe("POSTED");
    expect(firstBody.receipt.duplicate).toBe(false);
    // Valuation moves with the steps: receipt sets 20000, consumption leaves 12000.
    expect(firstBody.valuations.map((v) => v.totalCents)).toEqual([20000, 12000]);
    const valuationsRes = await fetch(
      `${baseUrl}/api/v1/finance/inventory-valuations?lot_id=11111111-1111-4111-8111-111111111117`,
      { headers: headers(HERBA_ORG, HERBA_OPS) },
    );
    expect(valuationsRes.status).toBe(200);
    const valuationsBody = (await valuationsRes.json()) as {
      valuations: { totalCents: number }[];
    };
    expect(valuationsBody.valuations.map((v) => v.totalCents)).toContain(12000);
    // AP/AR/inventory balances match the postings (deltas, so re-runs stay green).
    const after = await readBalances();
    const delta = (code: string, side: "debit" | "credit"): number =>
      (after.get(code)?.[side] ?? 0) - (before.get(code)?.[side] ?? 0);
    expect(delta("2000", "credit")).toBe(20000); // AP: supplier invoice
    expect(delta("1200", "debit") - delta("1200", "credit")).toBe(12000); // Inventory net
    expect(delta("1100", "debit")).toBe(30000); // AR: sales invoice
    expect(delta("4000", "credit")).toBe(30000); // Revenue
    expect(delta("5000", "debit")).toBe(8000); // COGS
    // Replaying the whole flow returns the originals and moves nothing.
    const replay = await fetch(`${baseUrl}/api/v1/finance/flows/supplier-to-sale`, {
      body: JSON.stringify(flowBody),
      headers: { ...headers(HERBA_ORG, HERBA_OPS), "content-type": "application/json" },
      method: "POST",
    });
    expect(replay.status).toBe(200);
    const replayBody = (await replay.json()) as {
      receipt: { duplicate: boolean };
      consumption: { duplicate: boolean };
      sale: { duplicate: boolean };
    };
    expect(replayBody.receipt.duplicate).toBe(true);
    expect(replayBody.consumption.duplicate).toBe(true);
    expect(replayBody.sale.duplicate).toBe(true);
    const afterReplay = await readBalances();
    expect(afterReplay.get("2000")?.credit).toBe(after.get("2000")?.credit);
    expect(afterReplay.get("1100")?.debit).toBe(after.get("1100")?.debit);
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
