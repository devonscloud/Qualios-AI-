import { describe, expect, it } from "vitest";
import { buildIdempotencyKey, validateJournalEntry, validateTraceLinks } from "@qualios/domain";
import {
  CANNABIS_PACK,
  FOOD_PACK,
  INDUSTRY_PACKS,
  getPack,
  importHeaderAliasesForPacks,
} from "@qualios/industry-packs";

/**
 * Pure contract tests for the integrated domain model (no database).
 * The same rules are enforced by the database triggers in migration 0012
 * and exercised against live PostgreSQL in packs-traceability-ledger.test.ts.
 */

describe("validateJournalEntry (double-entry ledger rules)", () => {
  const cash = "00000000-0000-4000-8000-000000000001";
  const revenue = "00000000-0000-4000-8000-000000000002";

  it("accepts a balanced entry", () => {
    const result = validateJournalEntry({
      entryDate: "2026-11-20",
      lines: [
        { accountId: cash, creditCents: 0, debitCents: 10000 },
        { accountId: revenue, creditCents: 10000, debitCents: 0 },
      ],
      sourceId: "sale-1",
      sourceModule: "finance",
      sourceType: "sales_invoice",
    });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.totalDebitCents).toBe(10000);
      expect(result.totalCreditCents).toBe(10000);
    }
  });

  it("rejects an unbalanced entry", () => {
    const result = validateJournalEntry({
      entryDate: "2026-11-20",
      lines: [
        { accountId: cash, creditCents: 0, debitCents: 10000 },
        { accountId: revenue, creditCents: 9000, debitCents: 0 },
      ],
      sourceId: "sale-2",
      sourceModule: "finance",
      sourceType: "sales_invoice",
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues.map((issue) => issue.code)).toContain("UNBALANCED");
    }
  });

  it("rejects a line that debits and credits, a zero line, and a negative amount", () => {
    const both = validateJournalEntry({
      entryDate: "2026-11-20",
      lines: [
        { accountId: cash, creditCents: 500, debitCents: 500 },
        { accountId: revenue, creditCents: 500, debitCents: 0 },
      ],
      sourceId: "sale-3",
      sourceModule: "finance",
      sourceType: "sales_invoice",
    });
    expect(both.valid).toBe(false);
    if (!both.valid) {
      expect(both.issues.map((issue) => issue.code)).toContain("LINE_BOTH_SIDES");
    }
    const zero = validateJournalEntry({
      entryDate: "2026-11-20",
      lines: [{ accountId: cash, creditCents: 0, debitCents: 0 }],
      sourceId: "sale-4",
      sourceModule: "finance",
      sourceType: "sales_invoice",
    });
    expect(zero.valid).toBe(false);
    if (!zero.valid) {
      expect(zero.issues.map((issue) => issue.code)).toContain("LINE_NEITHER_SIDE");
    }
    const negative = validateJournalEntry({
      entryDate: "2026-11-20",
      lines: [
        { accountId: cash, creditCents: 0, debitCents: -100 },
        { accountId: revenue, creditCents: 0, debitCents: 0 },
      ],
      sourceId: "sale-5",
      sourceModule: "finance",
      sourceType: "sales_invoice",
    });
    expect(negative.valid).toBe(false);
    if (!negative.valid) {
      expect(negative.issues.map((issue) => issue.code)).toContain("NEGATIVE_AMOUNT");
    }
  });

  it("rejects an entry with no lines", () => {
    const result = validateJournalEntry({
      entryDate: "2026-11-20",
      lines: [],
      sourceId: "sale-6",
      sourceModule: "finance",
      sourceType: "sales_invoice",
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues.map((issue) => issue.code)).toContain("NO_LINES");
    }
  });
});

describe("buildIdempotencyKey", () => {
  it("is stable for one source and distinct across sources", () => {
    expect(buildIdempotencyKey("finance", "sales_invoice", "inv-1")).toBe(
      buildIdempotencyKey("finance", "sales_invoice", "inv-1"),
    );
    expect(buildIdempotencyKey("finance", "sales_invoice", "inv-1")).not.toBe(
      buildIdempotencyKey("finance", "sales_invoice", "inv-2"),
    );
    expect(buildIdempotencyKey("finance", "sales_invoice", "inv-1")).not.toBe(
      buildIdempotencyKey("inventory", "receipt", "inv-1"),
    );
  });
});

describe("validateTraceLinks (lot genealogy rules)", () => {
  const a = "00000000-0000-4000-8000-0000000000a1";
  const b = "00000000-0000-4000-8000-0000000000b2";
  const c = "00000000-0000-4000-8000-0000000000c3";

  it("accepts an acyclic chain", () => {
    const result = validateTraceLinks([
      { childLotId: b, linkType: "PRODUCED_FROM", parentLotId: a },
      { childLotId: c, linkType: "PACKAGED_FROM", parentLotId: b },
    ]);
    expect(result.valid).toBe(true);
  });

  it("rejects a self-link, a duplicate link, and a cycle", () => {
    const self = validateTraceLinks([{ childLotId: a, linkType: "SPLIT_FROM", parentLotId: a }]);
    expect(self.valid).toBe(false);
    if (!self.valid) {
      expect(self.issues.map((issue) => issue.code)).toContain("SELF_LINK");
    }
    const duplicate = validateTraceLinks([
      { childLotId: b, linkType: "PRODUCED_FROM", parentLotId: a },
      { childLotId: b, linkType: "PRODUCED_FROM", parentLotId: a },
    ]);
    expect(duplicate.valid).toBe(false);
    if (!duplicate.valid) {
      expect(duplicate.issues.map((issue) => issue.code)).toContain("DUPLICATE_LINK");
    }
    const cycle = validateTraceLinks([
      { childLotId: b, linkType: "PRODUCED_FROM", parentLotId: a },
      { childLotId: c, linkType: "PACKAGED_FROM", parentLotId: b },
      { childLotId: a, linkType: "MERGED_INTO", parentLotId: c },
    ]);
    expect(cycle.valid).toBe(false);
    if (!cycle.valid) {
      expect(cycle.issues.map((issue) => issue.code)).toContain("CYCLE");
    }
  });
});

describe("industry pack registry (B-110 mechanism)", () => {
  it("registers three packs, and the cannabis pack is not the only one", () => {
    expect(INDUSTRY_PACKS).toHaveLength(3);
    expect(INDUSTRY_PACKS.map((pack) => pack.id)).toEqual([
      "cannabis-ca",
      "food-ca",
      "industrial-generic",
    ]);
    expect(getPack("food-ca")).toBe(FOOD_PACK);
    expect(getPack("no-such-pack")).toBeUndefined();
  });

  it("the cannabis pack registers PER_MG_THC, seed-to-sale, and THC attributes", () => {
    expect(CANNABIS_PACK.taxBases.map((basis) => basis.key)).toContain("PER_MG_THC");
    expect(CANNABIS_PACK.sourceSystems.map((source) => source.key)).toContain("SEED_TO_SALE");
    expect(CANNABIS_PACK.importHeaderAliases).toEqual({ strain: "product_name" });
    expect(CANNABIS_PACK.productAttributeKeys.map((key) => key.key)).toEqual([
      "strain_type",
      "thc_label_mg",
      "thc_label_mg_per_g",
      "thc_tested_mg_per_g",
    ]);
    expect(CANNABIS_PACK.lotDispositions.map((d) => d.key)).toEqual([
      "AWAITING_DESTRUCTION",
      "DESTROYED",
    ]);
  });

  it("the food pack contributes its own taxonomy and tax bases", () => {
    expect(FOOD_PACK.taxonomy.map((value) => value.key)).toContain("SOUP");
    expect(FOOD_PACK.taxBases.map((basis) => basis.key)).toEqual([
      "PER_UNIT",
      "PER_KG",
      "AD_VALOREM",
    ]);
    expect(FOOD_PACK.taxBases.map((basis) => basis.key)).not.toContain("PER_MG_THC");
  });

  it("pack header aliases merge with first pack winning", () => {
    expect(importHeaderAliasesForPacks(["cannabis-ca", "food-ca"])).toEqual({
      strain: "product_name",
    });
    expect(importHeaderAliasesForPacks(["food-ca"])).toEqual({});
    expect(importHeaderAliasesForPacks(["no-such-pack"])).toEqual({});
  });
});
