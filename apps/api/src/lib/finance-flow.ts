import type { PoolClient } from "pg";
import { postJournalEntry } from "./ledger.js";

/**
 * Finance posting prototype (P1, domain model §2.2).
 *
 * The prototype flow — supplier receipt + invoice -> inventory valuation
 * + AP -> production consumption + COGS -> sales invoice + AR — posts
 * every step through postJournalEntry (lib/ledger.ts). There is exactly
 * one posting path; nothing here inserts into journal_entries /
 * journal_lines directly.
 *
 *   supplier receipt / invoice : Dr Inventory / Cr Accounts Payable
 *   production consumption     : Dr COGS / Cr Inventory (lot on the lines)
 *   sales invoice              : Dr Accounts Receivable / Cr Sales Revenue
 *
 * Tax is NOT calculated here: tax rules are admin read-only and no tax
 * number is computed until a domain expert reviews the rules (ADR D-07).
 * Amounts are integer cents; valuations are integer cents per lot.
 */

export interface ChartAccount {
  id: string;
  code: string;
  name: string;
  accountType: string;
}

/** Minimal standard chart, created idempotently per tenant. */
export const STANDARD_CHART: { code: string; name: string; accountType: string }[] = [
  { accountType: "ASSET", code: "1000", name: "Cash" },
  { accountType: "ASSET", code: "1100", name: "Accounts Receivable" },
  { accountType: "ASSET", code: "1200", name: "Inventory" },
  { accountType: "LIABILITY", code: "2000", name: "Accounts Payable" },
  { accountType: "REVENUE", code: "4000", name: "Sales Revenue" },
  { accountType: "EXPENSE", code: "5000", name: "Cost of Goods Sold" },
];

export async function ensureStandardChart(
  client: PoolClient,
  organizationId: string,
): Promise<Map<string, ChartAccount>> {
  for (const account of STANDARD_CHART) {
    await client.query(
      `INSERT INTO gl_accounts (organization_id, code, name, account_type)
       VALUES ($1, $2, $3, $4) ON CONFLICT (organization_id, code) DO NOTHING`,
      [organizationId, account.code, account.name, account.accountType],
    );
  }
  const { rows } = await client.query<ChartAccount>(
    `SELECT id, code, name, account_type AS "accountType" FROM gl_accounts
     WHERE organization_id = $1 ORDER BY code`,
    [organizationId],
  );
  return new Map(rows.map((row) => [row.code, row]));
}

export interface AccountBalance extends ChartAccount {
  debitTotalCents: number;
  creditTotalCents: number;
  /** Debits minus credits (positive = net debit balance). */
  netDebitCents: number;
}

/** Per-account totals from posted journal lines (the ledger is the source). */
export async function accountBalances(
  client: PoolClient,
  organizationId: string,
): Promise<AccountBalance[]> {
  const { rows } = await client.query<{
    id: string;
    code: string;
    name: string;
    accountType: string;
    debit_total: string;
    credit_total: string;
  }>(
    `SELECT a.id, a.code, a.name, a.account_type AS "accountType",
            COALESCE(SUM(jl.debit_cents), 0) AS debit_total,
            COALESCE(SUM(jl.credit_cents), 0) AS credit_total
     FROM gl_accounts a
     LEFT JOIN journal_lines jl ON jl.account_id = a.id
       AND EXISTS (
         SELECT 1 FROM journal_entries je
         WHERE je.id = jl.journal_entry_id AND je.status = 'POSTED'
       )
     WHERE a.organization_id = $1
     GROUP BY a.id, a.code, a.name, a.account_type ORDER BY a.code`,
    [organizationId],
  );
  return rows.map((row) => ({
    accountType: row.accountType,
    code: row.code,
    creditTotalCents: Number(row.credit_total),
    debitTotalCents: Number(row.debit_total),
    id: row.id,
    name: row.name,
    netDebitCents: Number(row.debit_total) - Number(row.credit_total),
  }));
}

export interface ValuationSummary {
  id: string;
  lotId: string;
  valuationMethod: string;
  unitCostCents: number;
  totalCents: number;
  asOf: string;
  journalEntryId: string | null;
}

/** Record (or return the existing) valuation for a lot at one timestamp. */
export async function recordValuation(
  client: PoolClient,
  args: {
    organizationId: string;
    createdBy: string;
    lotId: string;
    valuationMethod?: string;
    unitCostCents: number;
    totalCents: number;
    asOf: Date;
    journalEntryId?: string | null;
  },
): Promise<ValuationSummary> {
  const method = args.valuationMethod ?? "AVERAGE";
  const inserted = await client.query<{
    id: string;
    lot_id: string;
    valuation_method: string;
    unit_cost_cents: number;
    total_cents: number;
    as_of: string;
    journal_entry_id: string | null;
  }>(
    `INSERT INTO inventory_valuations
       (organization_id, lot_id, valuation_method, unit_cost_cents, total_cents,
        as_of, journal_entry_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (organization_id, lot_id, valuation_method, as_of) DO NOTHING
     RETURNING id, lot_id, valuation_method, unit_cost_cents, total_cents, as_of, journal_entry_id`,
    [
      args.organizationId,
      args.lotId,
      method,
      args.unitCostCents,
      args.totalCents,
      args.asOf.toISOString(),
      args.journalEntryId ?? null,
      args.createdBy,
    ],
  );
  const row =
    inserted.rows[0] ??
    (
      await client.query<{
        id: string;
        lot_id: string;
        valuation_method: string;
        unit_cost_cents: number;
        total_cents: number;
        as_of: string;
        journal_entry_id: string | null;
      }>(
        `SELECT id, lot_id, valuation_method, unit_cost_cents, total_cents, as_of, journal_entry_id
         FROM inventory_valuations
         WHERE organization_id = $1 AND lot_id = $2 AND valuation_method = $3 AND as_of = $4`,
        [args.organizationId, args.lotId, method, args.asOf.toISOString()],
      )
    ).rows[0];
  return {
    asOf: row.as_of,
    id: row.id,
    journalEntryId: row.journal_entry_id,
    lotId: row.lot_id,
    totalCents: Number(row.total_cents),
    unitCostCents: Number(row.unit_cost_cents),
    valuationMethod: row.valuation_method,
  };
}

export interface FlowStepResult {
  id: string;
  status: string;
  duplicate: boolean;
}

export interface SupplierToSaleFlowInput {
  lotId: string;
  productId?: string | null;
  entryDate?: string;
  receipt: { sourceId: string; amountCents: number; unitCostCents: number };
  consumption: { sourceId: string; amountCents: number };
  sale: { sourceId: string; amountCents: number };
}

/**
 * Run the prototype flow in one transaction. Each step has its own
 * source id, so replaying the whole flow returns the original entries
 * (duplicate: true) instead of double-posting. Valuations move with the
 * steps: the receipt sets the lot's value, consumption reduces it.
 */
export async function postSupplierToSaleFlow(
  client: PoolClient,
  args: {
    organizationId: string;
    createdBy: string;
    input: SupplierToSaleFlowInput;
  },
): Promise<{
  receipt: FlowStepResult;
  consumption: FlowStepResult;
  sale: FlowStepResult;
  valuations: ValuationSummary[];
}> {
  const { organizationId, createdBy, input } = args;
  const chart = await ensureStandardChart(client, organizationId);
  const inventory = chart.get("1200") as ChartAccount;
  const payables = chart.get("2000") as ChartAccount;
  const receivables = chart.get("1100") as ChartAccount;
  const revenue = chart.get("4000") as ChartAccount;
  const cogs = chart.get("5000") as ChartAccount;
  const entryDate = input.entryDate ?? "2026-11-20";
  const asOf = new Date();

  const receipt = await postJournalEntry(client, {
    createdBy,
    entry: {
      entryDate,
      lines: [
        {
          accountId: inventory.id,
          creditCents: 0,
          debitCents: input.receipt.amountCents,
          lotId: input.lotId,
          memo: "Supplier receipt: inventory received",
          productId: input.productId ?? null,
        },
        {
          accountId: payables.id,
          creditCents: input.receipt.amountCents,
          debitCents: 0,
          memo: "Supplier invoice: accounts payable",
        },
      ],
      memo: "Supplier receipt + invoice",
      sourceId: input.receipt.sourceId,
      sourceModule: "finance",
      sourceType: "supplier_receipt",
    },
    organizationId,
  });
  const receiptValuation = await recordValuation(client, {
    organizationId,
    asOf,
    createdBy,
    journalEntryId: receipt.id,
    lotId: input.lotId,
    totalCents: input.receipt.amountCents,
    unitCostCents: input.receipt.unitCostCents,
  });

  const consumption = await postJournalEntry(client, {
    createdBy,
    entry: {
      entryDate,
      lines: [
        {
          accountId: cogs.id,
          creditCents: 0,
          debitCents: input.consumption.amountCents,
          lotId: input.lotId,
          memo: "Production consumption: cost of goods sold",
          productId: input.productId ?? null,
        },
        {
          accountId: inventory.id,
          creditCents: input.consumption.amountCents,
          debitCents: 0,
          lotId: input.lotId,
          memo: "Production consumption: inventory relieved",
          productId: input.productId ?? null,
        },
      ],
      memo: "Production consumption + COGS",
      sourceId: input.consumption.sourceId,
      sourceModule: "finance",
      sourceType: "production_consumption",
    },
    organizationId,
  });
  const consumptionValuation = await recordValuation(client, {
    organizationId,
    asOf: new Date(asOf.getTime() + 1),
    createdBy,
    journalEntryId: consumption.id,
    lotId: input.lotId,
    totalCents: Math.max(0, input.receipt.amountCents - input.consumption.amountCents),
    unitCostCents: input.receipt.unitCostCents,
  });

  const sale = await postJournalEntry(client, {
    createdBy,
    entry: {
      entryDate,
      lines: [
        {
          accountId: receivables.id,
          creditCents: 0,
          debitCents: input.sale.amountCents,
          lotId: input.lotId,
          memo: "Sales invoice: accounts receivable",
          productId: input.productId ?? null,
        },
        {
          accountId: revenue.id,
          creditCents: input.sale.amountCents,
          debitCents: 0,
          lotId: input.lotId,
          memo: "Sales invoice: revenue",
          productId: input.productId ?? null,
        },
      ],
      memo: "Sales invoice + AR",
      sourceId: input.sale.sourceId,
      sourceModule: "finance",
      sourceType: "sales_invoice",
    },
    organizationId,
  });

  return {
    consumption,
    receipt,
    sale,
    valuations: [receiptValuation, consumptionValuation],
  };
}
