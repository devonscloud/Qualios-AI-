import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import * as XLSX from "xlsx";
import { createPool, runMigrations, runSeeds } from "@qualios/db";
import { LocalFilesystemStorage } from "@qualios/storage";
import { createApp } from "./app.js";
import { setStorageForTests } from "./lib/storage.js";

/**
 * External record import + reconciliation engine integration tests (Days 14–18).
 *
 * Needs a real PostgreSQL (DATABASE_URL) — CI provides one. Without
 * DATABASE_URL the suite is skipped rather than failing:
 *   DATABASE_URL=postgres://qualios:qualios@127.0.0.1:5432/qualios_test npm test
 *
 * The five PRD cases are replayed here as discrepancy scenarios with
 * SYNTHETIC data in a scratch organization (Q-051). Lot numbers and
 * quantities come from the published PRD cases so the classification can be
 * checked against them; no real Herba Farms records are used. Case 5
 * (SK/MB excise) is explicitly out of scope for the reconciliation engine
 * v0 — the test asserts the excise engine is still a stub and performs no
 * calculation, rather than pretending the engine classifies it.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const hasDb = Boolean(DATABASE_URL);

const ORG_A = randomUUID();
const ORG_B = randomUUID();
const ORG_C = randomUUID();
const SITE_A = randomUUID();
const OPS = randomUUID();
const QA = randomUUID();
const RUN_ID = randomUUID().slice(0, 8);
const OPS_EMAIL = `recon-ops-${RUN_ID}@test.example`;
const QA_EMAIL = `recon-qa-${RUN_ID}@test.example`;

const BULK_LOCATION = randomUUID();
const PACKAGED_LOCATION = randomUUID();

function headers(orgId: string, userId: string): Record<string, string> {
  return { "x-organization-id": orgId, "x-user-id": userId };
}

function importForm(
  data: Buffer,
  fileName: string,
  mime: string,
  fields: Record<string, string>,
): FormData {
  const form = new FormData();
  form.append("file", new Blob([data as BlobPart], { type: mime }), fileName);
  for (const [key, value] of Object.entries(fields)) {
    form.append(key, value);
  }
  return form;
}

interface ImportRunSummary {
  id: string;
  status: string;
  rows_total: number;
  rows_accepted: number;
  rows_rejected: number;
  error: string | null;
  mapping: Record<string, string>;
}

interface DiscrepancySummary {
  id: string;
  lot_number: string | null;
  discrepancy_type: string;
  severity: string;
  status: string;
  quantity_mg: number | null;
  quantity_units: number | null;
  evidence: Record<string, unknown>;
}

interface LineSummary {
  lot_number: string | null;
  match_status: string;
  external_qty_mg: number | null;
  paper_record_qty_mg: number | null;
  allocated_qty_units: number | null;
  produced_qty_units: number | null;
  variance_mg: number | null;
  variance_units: number | null;
}

describe.skipIf(!hasDb)("external record import + reconciliation engine (DB-backed)", () => {
  let server: ReturnType<ReturnType<typeof createApp>["listen"]>;
  let baseUrl: string;
  let pool: Pool;
  let tmpRoot: string;

  const lots = new Map<string, string>(); // lot_number -> lot id
  const products = new Map<string, string>(); // key -> product id

  async function createProduct(key: string, name: string, categoryKey: string): Promise<string> {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO products (id, organization_id, name, brand, category_key, taxonomy_pack_id, format, status)
       VALUES ($1, $2, $3, 'Synthetic', $4, 'cannabis-ca', 'test', 'ACTIVE')`,
      [id, ORG_A, name, categoryKey],
    );
    products.set(key, id);
    return id;
  }

  async function createLot(lotNumber: string, productKey: string): Promise<string> {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO lots (id, organization_id, product_id, lot_number, status, approved_for_sale)
       VALUES ($1, $2, $3, $4, 'ACTIVE', true)`,
      [id, ORG_A, products.get(productKey), lotNumber],
    );
    lots.set(lotNumber, id);
    return id;
  }

  async function insertMovement(args: {
    lotNumber: string;
    locationId: string;
    movementType: string;
    quantityMg: number;
    quantityUnits: number | null;
    recordedAt: string;
  }): Promise<void> {
    await pool.query(
      `INSERT INTO inventory_movements
         (organization_id, lot_id, location_id, movement_type, quantity_mg,
          quantity_units, source_system, source_reference, recorded_at, entered_by)
       VALUES ($1, $2, $3, $4, $5, $6, 'MANUAL', 'TEST-SETUP', $7, $8)`,
      [
        ORG_A,
        lots.get(args.lotNumber),
        args.locationId,
        args.movementType,
        args.quantityMg,
        args.quantityUnits,
        args.recordedAt,
        OPS,
      ],
    );
  }

  async function importFile(
    data: Buffer,
    fileName: string,
    mime: string,
    fields: Record<string, string>,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await fetch(`${baseUrl}/api/imports`, {
      method: "POST",
      headers: headers(ORG_A, OPS),
      body: importForm(data, fileName, mime, fields),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  async function importCsv(
    csv: string,
    kind: string,
    mode = "SNAPSHOT",
  ): Promise<{ status: number; run: ImportRunSummary }> {
    const { status, body } = await importFile(Buffer.from(csv, "utf8"), "import.csv", "text/csv", {
      import_kind: kind,
      import_mode: mode,
    });
    return { status, run: body.import_run as ImportRunSummary };
  }

  async function runReconciliation(
    importRunId: string,
    scopeType: string,
    scopeReference: string,
  ): Promise<{
    reconciliationId: string;
    summary: Record<string, unknown>;
    lines: LineSummary[];
    discrepancies: DiscrepancySummary[];
  }> {
    const created = await fetch(`${baseUrl}/api/reconciliations`, {
      method: "POST",
      headers: { ...headers(ORG_A, OPS), "content-type": "application/json" },
      body: JSON.stringify({
        scope_type: scopeType,
        scope_reference: scopeReference,
        external_import_run_id: importRunId,
      }),
    });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as {
      reconciliation: { id: string };
    };
    const reconciliationId = createdBody.reconciliation.id;
    const executed = await fetch(`${baseUrl}/api/reconciliations/${reconciliationId}/run`, {
      method: "POST",
      headers: headers(ORG_A, OPS),
    });
    expect(executed.status).toBe(200);
    const executedBody = (await executed.json()) as {
      summary: Record<string, unknown>;
    };
    const detail = await fetch(`${baseUrl}/api/reconciliations/${reconciliationId}`, {
      headers: headers(ORG_A, OPS),
    });
    expect(detail.status).toBe(200);
    const detailBody = (await detail.json()) as {
      lines: LineSummary[];
      discrepancies: DiscrepancySummary[];
    };
    return {
      reconciliationId,
      summary: executedBody.summary,
      lines: detailBody.lines,
      discrepancies: detailBody.discrepancies,
    };
  }

  beforeAll(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "qualios-import-test-"));
    setStorageForTests(new LocalFilesystemStorage(tmpRoot));

    const dbPool = createPool(DATABASE_URL as string);
    await runMigrations(dbPool);
    await runSeeds(dbPool);
    await dbPool.end();

    pool = new Pool({ connectionString: DATABASE_URL });
    await pool.query(
      `INSERT INTO organizations (id, name, country, currency, status) VALUES ($1, 'Test Recon Org', 'CA', 'CAD', 'ACTIVE')`,
      [ORG_A],
    );
    await pool.query(
      `INSERT INTO organizations (id, name, country, currency, status) VALUES ($1, 'Test Other Org', 'CA', 'CAD', 'ACTIVE')`,
      [ORG_B],
    );
    await pool.query(
      `INSERT INTO organizations (id, name, country, currency, status) VALUES ($1, 'Test Third Org', 'CA', 'CAD', 'ACTIVE')`,
      [ORG_C],
    );
    // ORG_A and ORG_C enable the cannabis pack, so the pack surfaces are
    // reachable for them. ORG_B enables no pack: it is the pack-gate
    // control (403 PACK_NOT_ENABLED on every pack surface).
    await pool.query(
      `INSERT INTO organization_packs (organization_id, pack_id, status) VALUES
         ($1, 'cannabis-ca', 'ENABLED'), ($2, 'cannabis-ca', 'ENABLED')`,
      [ORG_A, ORG_C],
    );
    await pool.query(
      `INSERT INTO sites (id, organization_id, name, timezone, status) VALUES ($1, $2, 'Test Site', 'America/Regina', 'ACTIVE')`,
      [SITE_A, ORG_A],
    );
    await pool.query(
      `INSERT INTO users (id, email, display_name, status) VALUES
         ($1, $3, 'Test Ops', 'ACTIVE'),
         ($2, $4, 'Test QA', 'ACTIVE')`,
      [OPS, QA, OPS_EMAIL, QA_EMAIL],
    );
    await pool.query(
      `INSERT INTO roles (id, organization_id, name, permissions) VALUES
         ($1, $2, 'TEST_OPS', '["reconciliation.run"]'::jsonb),
         ($3, $2, 'TEST_QA', '["discrepancy.approve"]'::jsonb)`,
      [randomUUID(), ORG_A, randomUUID()],
    );
    const roleRows = await pool.query<{ id: string; name: string }>(
      "SELECT id, name FROM roles WHERE organization_id = $1",
      [ORG_A],
    );
    const opsRole = roleRows.rows.find((r) => r.name === "TEST_OPS")?.id;
    const qaRole = roleRows.rows.find((r) => r.name === "TEST_QA")?.id;
    await pool.query(
      `INSERT INTO memberships (id, user_id, organization_id, role_id, status) VALUES
         ($1, $2, $3, $4, 'ACTIVE'),
         ($5, $6, $3, $7, 'ACTIVE')`,
      [randomUUID(), OPS, ORG_A, opsRole, randomUUID(), QA, qaRole],
    );
    await pool.query(
      `INSERT INTO inventory_locations (id, organization_id, site_id, name, stock_state)
       VALUES ($1, $2, $3, 'Vault (bulk)', 'BULK'),
              ($4, $2, $3, 'Packaging (packaged)', 'PACKAGED')`,
      [BULK_LOCATION, ORG_A, SITE_A, PACKAGED_LOCATION],
    );

    // --- Synthetic case data (PRD lot numbers, scratch org) ---
    await createProduct("flower1", "Synthetic Flower — Case 1", "DRIED_FLOWER");
    await createProduct("extract2", "Synthetic Extract — Case 2", "EXTRACT");
    await createProduct("kiwi", "Synthetic Kiwi Burst", "INFUSED_PRE_ROLL");
    await createProduct("watermelon", "Synthetic Watermelon", "INFUSED_PRE_ROLL");
    await createProduct("banana", "Synthetic Banana Custard", "INFUSED_PRE_ROLL");
    await createProduct("peach", "Synthetic White Peach", "INFUSED_PRE_ROLL");
    await createProduct("jixy1", "Synthetic Jixy Flavour 1", "INFUSED_PRE_ROLL");
    await createProduct("jixy2", "Synthetic Jixy Flavour 2", "INFUSED_PRE_ROLL");
    await createProduct("jixy3", "Synthetic Jixy Flavour 3", "INFUSED_PRE_ROLL");
    await createProduct("jixy4", "Synthetic Jixy Flavour 4", "INFUSED_PRE_ROLL");
    await createProduct("honey", "Synthetic Honey Drip", "EXTRACT");

    await createLot("260824", "flower1");
    await createLot("260803", "extract2");
    await createLot("261001", "kiwi");
    await createLot("261002", "watermelon");
    await createLot("260903", "banana");
    await createLot("261003", "peach");
    await createLot("261117", "jixy1");
    await createLot("261118", "jixy2");
    await createLot("261119", "jixy3");
    await createLot("261120", "jixy4");
    await createLot("261005", "honey");

    // Case 1: 20,000,000 mg in, all consumed on paper -> net 0.
    await insertMovement({
      lotNumber: "260824",
      locationId: BULK_LOCATION,
      movementType: "RECEIVE",
      quantityMg: 20_000_000,
      quantityUnits: null,
      recordedAt: "2026-08-24",
    });
    await insertMovement({
      lotNumber: "260824",
      locationId: BULK_LOCATION,
      movementType: "CONSUME",
      quantityMg: -20_000_000,
      quantityUnits: null,
      recordedAt: "2026-09-03",
    });
    // Case 2: 500,000 mg in, all consumed -> net 0.
    await insertMovement({
      lotNumber: "260803",
      locationId: BULK_LOCATION,
      movementType: "RECEIVE",
      quantityMg: 500_000,
      quantityUnits: null,
      recordedAt: "2026-08-24",
    });
    await insertMovement({
      lotNumber: "260803",
      locationId: BULK_LOCATION,
      movementType: "CONSUME",
      quantityMg: -500_000,
      quantityUnits: null,
      recordedAt: "2026-09-03",
    });
    // Case 3: bulk unit counts per flavour (all BULK, zero packaged).
    const ceramic: [string, number][] = [
      ["261001", 1328],
      ["261002", 1008],
      ["260903", 1130],
      ["261003", 956],
    ];
    for (const [lot, units] of ceramic) {
      await insertMovement({
        lotNumber: lot,
        locationId: BULK_LOCATION,
        movementType: "RECEIVE",
        quantityMg: 0,
        quantityUnits: units,
        recordedAt: "2026-11-13",
      });
    }
    // Case 4: 2,800 packs produced per flavour (all BULK).
    for (const lot of ["261117", "261118", "261119", "261120"]) {
      await insertMovement({
        lotNumber: lot,
        locationId: BULK_LOCATION,
        movementType: "PRODUCE",
        quantityMg: 0,
        quantityUnits: 2800,
        recordedAt: "2026-11-18",
      });
    }

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
    if (tmpRoot) {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it("imports an external-system CSV snapshot and records every row", async () => {
    const { status, run } = await importCsv(
      "lot_number,quantity_mg\n260824,1338000\n260803,348000\n",
      "EXTERNAL_SNAPSHOT",
    );
    expect(status).toBe(201);
    expect(run.status).toBe("COMPLETED");
    expect(run.rows_total).toBe(2);
    expect(run.rows_accepted).toBe(2);
    expect(run.rows_rejected).toBe(0);
    expect(run.mapping).toEqual({ lot_number: "lot_number", quantity_mg: "quantity_mg" });

    const detail = await fetch(`${baseUrl}/api/imports/${run.id}`, {
      headers: headers(ORG_A, OPS),
    });
    expect(detail.status).toBe(200);
    const detailBody = (await detail.json()) as {
      rows: { row_number: number; status: string; lot_number: string; quantity_mg: number }[];
    };
    expect(detailBody.rows).toHaveLength(2);
    expect(detailBody.rows[0]).toMatchObject({
      row_number: 1,
      status: "ACCEPTED",
      lot_number: "260824",
      quantity_mg: 1338000,
    });

    // The stored original downloads back verbatim.
    const download = await fetch(`${baseUrl}/api/imports/${run.id}/download`, {
      headers: headers(ORG_A, OPS),
    });
    expect(download.status).toBe(200);
    expect(await download.text()).toBe("lot_number,quantity_mg\n260824,1338000\n260803,348000\n");
  });

  it("imports an XLSX snapshot the same way as CSV", async () => {
    const sheet = XLSX.utils.aoa_to_sheet([
      ["lot_number", "quantity_mg"],
      ["260824", 1338000],
    ]);
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, sheet, "Export");
    const buffer = Buffer.from(XLSX.write(book, { type: "buffer", bookType: "xlsx" }));
    const { status, body } = await importFile(
      buffer,
      "export.xlsx",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      {
        import_kind: "EXTERNAL_SNAPSHOT",
        import_mode: "SNAPSHOT",
      },
    );
    expect(status).toBe(201);
    const run = body.import_run as ImportRunSummary;
    expect(run.rows_accepted).toBe(1);
  });

  it("never silently drops a bad row: it is recorded REJECTED with a reason", async () => {
    const { status, run } = await importCsv(
      "lot_number,quantity_mg\n260824,1000\n260803,not-a-number\n260824,500\n",
      "EXTERNAL_SNAPSHOT",
    );
    expect(status).toBe(201);
    expect(run.status).toBe("COMPLETED_WITH_ERRORS");
    expect(run.rows_total).toBe(3);
    expect(run.rows_accepted).toBe(2);
    expect(run.rows_rejected).toBe(1);

    const rejected = await fetch(`${baseUrl}/api/imports/${run.id}?status=REJECTED`, {
      headers: headers(ORG_A, OPS),
    });
    const rejectedBody = (await rejected.json()) as {
      rows: {
        row_number: number;
        status: string;
        error: string;
        raw_data: Record<string, string>;
      }[];
    };
    expect(rejectedBody.rows).toHaveLength(1);
    expect(rejectedBody.rows[0].row_number).toBe(2);
    expect(rejectedBody.rows[0].error).toMatch(/quantity_mg/);
    expect(rejectedBody.rows[0].raw_data).toEqual({
      lot_number: "260803",
      quantity_mg: "not-a-number",
    });
  });

  it("rejects an unmappable file at the file level and records a FAILED run", async () => {
    const { status, body } = await importFile(
      Buffer.from("foo,bar\n1,2\n", "utf8"),
      "bad.csv",
      "text/csv",
      {
        import_kind: "EXTERNAL_SNAPSHOT",
        import_mode: "SNAPSHOT",
      },
    );
    expect(status).toBe(422);
    const typed = body as { error: { code: string }; import_run: ImportRunSummary };
    expect(typed.error.code).toBe("IMPORT_MAPPING_FAILED");
    expect(typed.import_run.status).toBe("FAILED");
    expect(typed.import_run.error).toMatch(/lot_number/);
  });

  it("rejects a non-tabular file for import", async () => {
    const { status, body } = await importFile(
      Buffer.from("%PDF-1.4\n"),
      "doc.pdf",
      "application/pdf",
      { import_kind: "EXTERNAL_SNAPSHOT", import_mode: "SNAPSHOT" },
    );
    expect(status).toBe(400);
    const typed = body as { error: { code: string } };
    expect(typed.error.code).toBe("FILE_TYPE_NOT_ALLOWED");
  });

  it("LEDGER mode writes movements; positions are derived from the ledger", async () => {
    const { status, run } = await importCsv(
      "lot_number,quantity_mg,movement_type,location\n261005,250000,RECEIVE,Vault (bulk)\n",
      "EXTERNAL_SNAPSHOT",
      "LEDGER",
    );
    expect(status).toBe(201);
    expect(run.rows_accepted).toBe(1);
    const positions = await pool.query<{ quantity_mg: string }>(
      `SELECT quantity_mg FROM inventory_positions WHERE lot_id = $1`,
      [lots.get("261005")],
    );
    expect(positions.rows).toHaveLength(1);
    expect(Number(positions.rows[0].quantity_mg)).toBe(250000);
  });

  it("Case 1 (Q-051): Toad Venom phantom 1.338 kg is PHANTOM_STOCK HIGH", async () => {
    const { status, run } = await importCsv(
      "lot_number,quantity_mg\n260824,1338000\n",
      "EXTERNAL_SNAPSHOT",
    );
    expect(status).toBe(201);
    const result = await runReconciliation(run.id, "SITE", "ALL");
    expect(result.summary.discrepancies_total).toBeGreaterThanOrEqual(1);
    const phantom = result.discrepancies.filter(
      (d) => d.lot_number === "260824" && d.discrepancy_type === "PHANTOM_STOCK",
    );
    expect(phantom).toHaveLength(1);
    expect(phantom[0].severity).toBe("HIGH");
    expect(phantom[0].quantity_mg).toBe(1338000);
    expect(phantom[0].status).toBe("OPEN");
    expect(phantom[0].evidence.ledger_qty_mg).toBe(0);
    expect(phantom[0].evidence.external_qty_mg).toBe(1338000);
    const line = result.lines.find((l) => l.lot_number === "260824");
    expect(line?.match_status).toBe("VARIANCE");
    expect(line?.external_qty_mg).toBe(1338000);
    expect(line?.paper_record_qty_mg).toBe(0);
    expect(line?.variance_mg).toBe(1338000);
  });

  it("Case 2 (Q-051): Sangria phantom 0.348 kg is PHANTOM_STOCK MEDIUM", async () => {
    const { status, run } = await importCsv(
      "lot_number,quantity_mg\n260803,348000\n",
      "EXTERNAL_SNAPSHOT",
    );
    expect(status).toBe(201);
    const result = await runReconciliation(run.id, "SITE", "ALL");
    const phantom = result.discrepancies.filter(
      (d) => d.lot_number === "260803" && d.discrepancy_type === "PHANTOM_STOCK",
    );
    expect(phantom).toHaveLength(1);
    expect(phantom[0].severity).toBe("MEDIUM");
    expect(phantom[0].quantity_mg).toBe(348000);
    expect(phantom[0].status).toBe("OPEN");
  });

  it("Case 3 (Q-051): ceramic tip shortages per flavour, plus bulk-vs-packaged", async () => {
    const { status, run } = await importCsv(
      "lot_number,quantity_units\n261001,1200\n261002,1200\n260903,1200\n261003,1200\n",
      "ALLOCATION",
    );
    expect(status).toBe(201);
    const result = await runReconciliation(run.id, "SITE", "ALL");
    const byLot = (lot: string, type: string): DiscrepancySummary[] =>
      result.discrepancies.filter((d) => d.lot_number === lot && d.discrepancy_type === type);

    // Watermelon short 192, White Peach short 244, Banana Custard short 70.
    expect(byLot("261002", "SHORTAGE")).toHaveLength(1);
    expect(byLot("261002", "SHORTAGE")[0].quantity_units).toBe(192);
    expect(byLot("261002", "SHORTAGE")[0].severity).toBe("MEDIUM");
    expect(byLot("261003", "SHORTAGE")).toHaveLength(1);
    expect(byLot("261003", "SHORTAGE")[0].quantity_units).toBe(244);
    expect(byLot("261003", "SHORTAGE")[0].severity).toBe("HIGH");
    expect(byLot("260903", "SHORTAGE")).toHaveLength(1);
    expect(byLot("260903", "SHORTAGE")[0].quantity_units).toBe(70);
    // Kiwi covers the allocation (1,328 on hand vs 1,200 allocated): no shortage.
    expect(byLot("261001", "SHORTAGE")).toHaveLength(0);
    // All four flavours are bulk-only: none of the allocation is shippable.
    for (const lot of ["261001", "261002", "260903", "261003"]) {
      expect(byLot(lot, "BULK_VS_PACKAGED")).toHaveLength(1);
      expect(byLot(lot, "BULK_VS_PACKAGED")[0].severity).toBe("MEDIUM");
    }
  });

  it("Case 4 (Q-051): Jixy unallocated production, 400 packs per flavour", async () => {
    const { status, run } = await importCsv(
      "lot_number,quantity_units\n261117,2400\n261118,2400\n261119,2400\n261120,2400\n",
      "ALLOCATION",
    );
    expect(status).toBe(201);
    const result = await runReconciliation(run.id, "SITE", "ALL");
    let totalUnallocated = 0;
    for (const lot of ["261117", "261118", "261119", "261120"]) {
      const found = result.discrepancies.filter(
        (d) => d.lot_number === lot && d.discrepancy_type === "UNALLOCATED_PRODUCTION",
      );
      expect(found).toHaveLength(1);
      expect(found[0].quantity_units).toBe(400);
      expect(found[0].severity).toBe("MEDIUM");
      totalUnallocated += found[0].quantity_units ?? 0;
      // No shortage: the allocation is covered by production.
      expect(
        result.discrepancies.filter(
          (d) => d.lot_number === lot && d.discrepancy_type === "SHORTAGE",
        ),
      ).toHaveLength(0);
    }
    expect(totalUnallocated).toBe(1600);
    const line = result.lines.find((l) => l.lot_number === "261117");
    expect(line?.allocated_qty_units).toBe(2400);
    expect(line?.produced_qty_units).toBe(2800);
  });

  it("Lot mismatch (Q-051): lot 260930 does not exist and is flagged, not dropped", async () => {
    const { status, run } = await importCsv(
      "lot_number,quantity_mg\n261005,1000000\n260930,500000\n",
      "EXTERNAL_SNAPSHOT",
    );
    expect(status).toBe(201);
    expect(run.status).toBe("COMPLETED_WITH_ERRORS");
    expect(run.rows_rejected).toBe(1);
    const result = await runReconciliation(run.id, "SITE", "ALL");
    const mismatch = result.discrepancies.filter((d) => d.discrepancy_type === "LOT_MISMATCH");
    expect(mismatch).toHaveLength(1);
    expect(mismatch[0].severity).toBe("HIGH");
    expect(mismatch[0].lot_number).toBeNull();
    expect(mismatch[0].description).toMatch(/260930/);
    expect(mismatch[0].evidence.lot_number).toBe("260930");
  });

  it("Case 5 (Q-051, deferred): the excise engine is NOT built — no calculation is performed", async () => {
    const res = await fetch(`${baseUrl}/api/excise/calculate`, {
      method: "POST",
      headers: { ...headers(ORG_A, OPS), "content-type": "application/json" },
      body: JSON.stringify({ lot_id: lots.get("260824"), jurisdiction: "CA-SK" }),
    });
    expect(res.status).toBe(501);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("NOT_IMPLEMENTED");
    const calcs = await pool.query(
      "SELECT count(*) AS n FROM excise_calculations WHERE organization_id = $1",
      [ORG_A],
    );
    expect(Number(calcs.rows[0].n)).toBe(0);
  });

  it("no auto-resolution: every discrepancy a run creates starts OPEN", async () => {
    const { run } = await importCsv(
      "lot_number,quantity_mg\n260824,1338000\n",
      "EXTERNAL_SNAPSHOT",
    );
    const result = await runReconciliation(run.id, "SITE", "ALL");
    expect(result.discrepancies.length).toBeGreaterThan(0);
    for (const d of result.discrepancies) {
      expect(d.status).toBe("OPEN");
    }
    const recon = await fetch(`${baseUrl}/api/reconciliations/${result.reconciliationId}`, {
      headers: headers(ORG_A, OPS),
    });
    const reconBody = (await recon.json()) as {
      reconciliation: { status: string };
    };
    // A run lands in REVIEW for a human; it is never auto-approved.
    expect(reconBody.reconciliation.status).toBe("REVIEW");
  });

  it("discrepancy workflow: propose, segregation of duties on approve, then close", async () => {
    const { run } = await importCsv("lot_number,quantity_mg\n260803,348000\n", "EXTERNAL_SNAPSHOT");
    const result = await runReconciliation(run.id, "SITE", "ALL");
    const discrepancy = result.discrepancies.find(
      (d) => d.lot_number === "260803" && d.discrepancy_type === "PHANTOM_STOCK",
    );
    expect(discrepancy).toBeDefined();
    const id = discrepancy?.id as string;

    // Resolving directly to RESOLVED is refused: use the approve endpoint.
    const direct = await fetch(`${baseUrl}/api/discrepancies/${id}`, {
      method: "PATCH",
      headers: { ...headers(ORG_A, OPS), "content-type": "application/json" },
      body: JSON.stringify({ status: "RESOLVED" }),
    });
    expect(direct.status).toBe(400);

    // Proposing without a note is refused.
    const noNote = await fetch(`${baseUrl}/api/discrepancies/${id}/resolve`, {
      method: "POST",
      headers: { ...headers(ORG_A, OPS), "content-type": "application/json" },
      body: JSON.stringify({ resolution_note: "" }),
    });
    expect(noNote.status).toBe(400);

    // Propose as Ops.
    const proposed = await fetch(`${baseUrl}/api/discrepancies/${id}/resolve`, {
      method: "POST",
      headers: { ...headers(ORG_A, OPS), "content-type": "application/json" },
      body: JSON.stringify({ resolution_note: "Reduce container to 0 kg to Destruction." }),
    });
    expect(proposed.status).toBe(200);
    const proposedBody = (await proposed.json()) as {
      discrepancy: DiscrepancySummary & { resolution_note: string; resolved_by: string };
    };
    expect(proposedBody.discrepancy.status).toBe("RESOLUTION_PROPOSED");
    expect(proposedBody.discrepancy.resolved_by).toBe(OPS);

    // The proposer cannot approve their own resolution.
    const selfApprove = await fetch(`${baseUrl}/api/discrepancies/${id}/approve`, {
      method: "POST",
      headers: { ...headers(ORG_A, OPS), "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(selfApprove.status).toBe(403);
    const selfBody = (await selfApprove.json()) as { error: { code: string } };
    expect(selfBody.error.code).toBe("SEGREGATION_OF_DUTIES");

    // A second person approves; the approval row and audit event exist.
    const approved = await fetch(`${baseUrl}/api/discrepancies/${id}/approve`, {
      method: "POST",
      headers: { ...headers(ORG_A, QA), "content-type": "application/json" },
      body: JSON.stringify({ note: "Confirmed against the paper audit." }),
    });
    expect(approved.status).toBe(200);
    const approvedBody = (await approved.json()) as {
      discrepancy: DiscrepancySummary & { approved_by: string };
      approval_id: string;
    };
    expect(approvedBody.discrepancy.status).toBe("RESOLVED");
    expect(approvedBody.discrepancy.approved_by).toBe(QA);
    expect(typeof approvedBody.approval_id).toBe("string");
    const approvals = await pool.query(
      "SELECT decision FROM approvals WHERE target_id = $1 AND organization_id = $2",
      [id, ORG_A],
    );
    expect(approvals.rows).toHaveLength(1);
    expect(approvals.rows[0].decision).toBe("APPROVED");

    // Close it.
    const closed = await fetch(`${baseUrl}/api/discrepancies/${id}`, {
      method: "PATCH",
      headers: { ...headers(ORG_A, QA), "content-type": "application/json" },
      body: JSON.stringify({ status: "CLOSED" }),
    });
    expect(closed.status).toBe(200);
    const closedBody = (await closed.json()) as { discrepancy: DiscrepancySummary };
    expect(closedBody.discrepancy.status).toBe("CLOSED");

    // A closed discrepancy is terminal.
    const reopen = await fetch(`${baseUrl}/api/discrepancies/${id}`, {
      method: "PATCH",
      headers: { ...headers(ORG_A, QA), "content-type": "application/json" },
      body: JSON.stringify({ status: "OPEN" }),
    });
    expect(reopen.status).toBe(409);
  });

  it("approve with outcome EXPLAINED ends a discrepancy as explained, not resolved", async () => {
    const { run } = await importCsv(
      "lot_number,quantity_mg\n260824,1338000\n",
      "EXTERNAL_SNAPSHOT",
    );
    const result = await runReconciliation(run.id, "SITE", "ALL");
    const discrepancy = result.discrepancies.find(
      (d) => d.lot_number === "260824" && d.discrepancy_type === "PHANTOM_STOCK",
    );
    expect(discrepancy).toBeDefined();
    const id = discrepancy?.id as string;

    const proposed = await fetch(`${baseUrl}/api/discrepancies/${id}/resolve`, {
      method: "POST",
      headers: { ...headers(ORG_A, OPS), "content-type": "application/json" },
      body: JSON.stringify({
        resolution_note: "External record counts a lot that was consumed before the cutover.",
      }),
    });
    expect(proposed.status).toBe(200);

    const approved = await fetch(`${baseUrl}/api/discrepancies/${id}/approve`, {
      method: "POST",
      headers: { ...headers(ORG_A, QA), "content-type": "application/json" },
      body: JSON.stringify({
        outcome: "EXPLAINED",
        note: "Explained by the cutover; no stock to destroy.",
      }),
    });
    expect(approved.status).toBe(200);
    const approvedBody = (await approved.json()) as {
      discrepancy: DiscrepancySummary;
    };
    expect(approvedBody.discrepancy.status).toBe("EXPLAINED");

    // EXPLAINED is terminal like RESOLVED: it can be closed, not reopened.
    const closed = await fetch(`${baseUrl}/api/discrepancies/${id}`, {
      method: "PATCH",
      headers: { ...headers(ORG_A, QA), "content-type": "application/json" },
      body: JSON.stringify({ status: "CLOSED" }),
    });
    expect(closed.status).toBe(200);
  });

  it("a run cannot be executed twice", async () => {
    const { run } = await importCsv(
      "lot_number,quantity_mg\n260824,1338000\n",
      "EXTERNAL_SNAPSHOT",
    );
    const result = await runReconciliation(run.id, "SITE", "ALL");
    const again = await fetch(`${baseUrl}/api/reconciliations/${result.reconciliationId}/run`, {
      method: "POST",
      headers: headers(ORG_A, OPS),
    });
    expect(again.status).toBe(400);
  });

  it("does not leak runs, imports, or discrepancies across tenants", async () => {
    const { run } = await importCsv(
      "lot_number,quantity_mg\n260824,1338000\n",
      "EXTERNAL_SNAPSHOT",
    );
    const result = await runReconciliation(run.id, "SITE", "ALL");
    const discrepancyId = result.discrepancies[0]?.id as string;

    // ORG_C has the pack enabled but no data: cross-tenant reads are 404.
    const otherRun = await fetch(`${baseUrl}/api/reconciliations/${result.reconciliationId}`, {
      headers: headers(ORG_C, QA),
    });
    expect(otherRun.status).toBe(404);
    const otherImport = await fetch(`${baseUrl}/api/imports/${run.id}`, {
      headers: headers(ORG_C, QA),
    });
    expect(otherImport.status).toBe(404);
    const otherDiscrepancy = await fetch(`${baseUrl}/api/discrepancies/${discrepancyId}`, {
      headers: headers(ORG_C, QA),
    });
    expect(otherDiscrepancy.status).toBe(404);
    const otherList = await fetch(`${baseUrl}/api/discrepancies`, {
      headers: headers(ORG_C, QA),
    });
    const otherListBody = (await otherList.json()) as { discrepancies: unknown[] };
    expect(otherListBody.discrepancies).toHaveLength(0);
  });

  it("pack gate: a tenant without the cannabis pack gets 403 PACK_NOT_ENABLED", async () => {
    for (const path of ["/api/imports", "/api/reconciliations", "/api/discrepancies"]) {
      const res = await fetch(`${baseUrl}${path}`, { headers: headers(ORG_B, QA) });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("PACK_NOT_ENABLED");
    }
    const excise = await fetch(`${baseUrl}/api/excise/calculate`, {
      method: "POST",
      headers: { ...headers(ORG_B, QA), "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(excise.status).toBe(403);
  });

  it("rejects SEED_TO_SALE as an import kind: the core kind is EXTERNAL_SNAPSHOT", async () => {
    const { status, body } = await importFile(
      Buffer.from("lot_number,quantity_mg\n260824,1000\n", "utf8"),
      "import.csv",
      "text/csv",
      { import_kind: "SEED_TO_SALE", import_mode: "SNAPSHOT" },
    );
    expect(status).toBe(400);
    const typed = body as { error: { code: string } };
    expect(typed.error.code).toBe("INVALID_FIELD");
  });

  it("records the pack source system on the run", async () => {
    const form = importForm(
      Buffer.from("lot_number,quantity_mg\n261005,250000\n", "utf8"),
      "import.csv",
      "text/csv",
      {
        import_kind: "EXTERNAL_SNAPSHOT",
        import_mode: "SNAPSHOT",
        source_system: "SEED_TO_SALE",
      },
    );
    const res = await fetch(`${baseUrl}/api/imports`, {
      method: "POST",
      headers: headers(ORG_A, OPS),
      body: form,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      import_run: { external_source: string | null };
    };
    expect(body.import_run.external_source).toBe("SEED_TO_SALE");
    // An unregistered source system is refused.
    const bad = await importFile(
      Buffer.from("lot_number,quantity_mg\n261005,250000\n", "utf8"),
      "import.csv",
      "text/csv",
      {
        import_kind: "EXTERNAL_SNAPSHOT",
        import_mode: "SNAPSHOT",
        source_system: "NOT_A_SYSTEM",
      },
    );
    expect(bad.status).toBe(400);
  });

  it("maps the cannabis pack's Strain header to product_name", async () => {
    const { status, run } = await importCsv(
      "Lot No,Strain,Qty (kg)\n260824,Demo Flower,1.338\n",
      "EXTERNAL_SNAPSHOT",
    );
    expect(status).toBe(201);
    expect(run.rows_accepted).toBe(1);
    expect(run.mapping).toMatchObject({ Strain: "product_name" });
  });
});
