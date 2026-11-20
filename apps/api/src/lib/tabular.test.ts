import { describe, expect, it } from "vitest";
import { decimalToScaledInt, parseCsv, parseXlsx, TabularParseError } from "./csv.js";
import {
  autoMapFields,
  resolveRowQuantities,
  RowValidationError,
  validateMappingCoverage,
} from "./imports.js";

/**
 * Unit tests for the import parsing/mapping libraries (no database).
 * These cover the exact-decimal conversion, the CSV parser's quoting
 * rules, and the field-mapping rules that decide whether a file can be
 * imported at all.
 */

describe("parseCsv", () => {
  it("parses a simple file with headers and rows", () => {
    const data = parseCsv("lot_number,quantity_mg\n260824,1338000\n260803,348000\n");
    expect(data.headers).toEqual(["lot_number", "quantity_mg"]);
    expect(data.rows).toHaveLength(2);
    expect(data.rows[0]).toEqual({
      rowNumber: 1,
      values: { lot_number: "260824", quantity_mg: "1338000" },
    });
    expect(data.rows[1]?.rowNumber).toBe(2);
  });

  it("handles quoted fields with commas and escaped quotes", () => {
    const data = parseCsv('lot_number,note\n260824,"hello, ""world"""\n');
    expect(data.rows[0]?.values).toEqual({
      lot_number: "260824",
      note: 'hello, "world"',
    });
  });

  it("handles CRLF line endings and skips blank lines", () => {
    const data = parseCsv("lot_number,quantity_mg\r\n260824,100\r\n\r\n260803,200\r\n");
    expect(data.rows).toHaveLength(2);
    expect(data.rows[1]?.values.lot_number).toBe("260803");
  });

  it("rejects an unterminated quoted field", () => {
    expect(() => parseCsv('lot_number,note\n260824,"oops\n')).toThrow(TabularParseError);
  });

  it("rejects an empty file and a file with no headers", () => {
    expect(() => parseCsv("")).toThrow(TabularParseError);
    expect(() => parseCsv("   \n   \n")).toThrow(TabularParseError);
  });
});

describe("parseXlsx", () => {
  it("reads the first sheet as tabular data", async () => {
    const { utils, write } = await import("xlsx");
    const sheet = utils.aoa_to_sheet([
      ["lot_number", "quantity_mg"],
      ["260824", 1338000],
      ["260803", 348000],
    ]);
    const book = utils.book_new();
    utils.book_append_sheet(book, sheet, "Export");
    const data = parseXlsx(Buffer.from(write(book, { type: "buffer", bookType: "xlsx" })));
    expect(data.headers).toEqual(["lot_number", "quantity_mg"]);
    expect(data.rows).toHaveLength(2);
    expect(data.rows[0]?.values).toEqual({ lot_number: "260824", quantity_mg: "1338000" });
  });

  it("rejects garbage bytes", () => {
    expect(() => parseXlsx(Buffer.from("this is not a workbook"))).toThrow(TabularParseError);
  });
});

describe("decimalToScaledInt", () => {
  it("converts kilograms and grams to milligrams exactly", () => {
    expect(decimalToScaledInt("1.338", 1_000_000)).toBe(1_338_000);
    expect(decimalToScaledInt("0.1", 1000)).toBe(100);
    expect(decimalToScaledInt("2", 1)).toBe(2);
    expect(decimalToScaledInt("0", 1_000_000)).toBe(0);
  });

  it("returns null for values that cannot be exact integers at the scale", () => {
    expect(decimalToScaledInt("1.5", 1)).toBeNull(); // half a milligram
    expect(decimalToScaledInt("0.1234567", 1_000_000)).toBeNull(); // sub-microgram
    expect(decimalToScaledInt("-5", 1)).toBeNull();
    expect(decimalToScaledInt("abc", 1)).toBeNull();
    expect(decimalToScaledInt("", 1)).toBeNull();
  });
});

describe("autoMapFields", () => {
  it("maps common seed-to-sale export headers", () => {
    const { mapping, errors } = autoMapFields([
      "Lot No",
      "Qty (kg)",
      "Movement",
      "Recorded Date",
      "Location",
    ]);
    expect(errors).toEqual([]);
    expect(mapping).toEqual({
      "Lot No": "lot_number",
      "Qty (kg)": "quantity_kg",
      Movement: "movement_type",
      "Recorded Date": "recorded_date",
      Location: "location",
    });
  });

  it("reports two headers mapping to the same canonical field", () => {
    const { errors } = autoMapFields(["Quantity", "Qty"]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/both map to quantity/);
  });

  it("ignores unmapped headers instead of failing", () => {
    const { mapping, errors } = autoMapFields(["lot_number", "internal_notes", "quantity_mg"]);
    expect(errors).toEqual([]);
    expect(mapping).toEqual({ lot_number: "lot_number", quantity_mg: "quantity_mg" });
  });
});

describe("validateMappingCoverage", () => {
  it("requires lot_number and a quantity field", () => {
    expect(validateMappingCoverage({ lot_number: "lot_number" })).toHaveLength(1);
    expect(validateMappingCoverage({ quantity_mg: "quantity_mg" })).toHaveLength(1);
    expect(
      validateMappingCoverage({ lot_number: "lot_number", quantity_mg: "quantity_mg" }),
    ).toEqual([]);
  });
});

describe("resolveRowQuantities", () => {
  it("resolves kilograms to milligrams and units", () => {
    expect(resolveRowQuantities({ quantity_kg: "1.338" })).toEqual({
      quantityMg: 1_338_000,
      quantityUnits: null,
    });
    expect(resolveRowQuantities({ quantity_units: "1200" })).toEqual({
      quantityMg: null,
      quantityUnits: 1200,
    });
    expect(resolveRowQuantities({ quantity: "2.5", quantity_unit: "kg" })).toEqual({
      quantityMg: 2_500_000,
      quantityUnits: null,
    });
    expect(resolveRowQuantities({ quantity: "400", quantity_unit: "units" })).toEqual({
      quantityMg: null,
      quantityUnits: 400,
    });
  });

  it("sums multiple quantity columns on one row", () => {
    expect(resolveRowQuantities({ quantity_mg: "100", quantity_g: "0.5" })).toEqual({
      quantityMg: 600,
      quantityUnits: null,
    });
  });

  it("rejects a row with no quantity and a bad unit", () => {
    expect(() => resolveRowQuantities({ lot_number: "260824" })).toThrow(RowValidationError);
    expect(() => resolveRowQuantities({ quantity: "5", quantity_unit: "litres" })).toThrow(
      RowValidationError,
    );
    expect(() => resolveRowQuantities({ quantity_mg: "1.5" })).toThrow(RowValidationError);
  });

  it("allows a signed quantity only when allowNegative is set", () => {
    expect(() => resolveRowQuantities({ quantity_mg: "-5" })).toThrow(RowValidationError);
    expect(resolveRowQuantities({ quantity_mg: "-5" }, { allowNegative: true })).toEqual({
      quantityMg: -5,
      quantityUnits: null,
    });
  });
});
