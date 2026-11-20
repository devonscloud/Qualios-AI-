import { decimalToScaledInt } from "./csv.js";

/**
 * Field mapping for seed-to-sale imports (PRD FR-01, backlog Q-020).
 *
 * A file's columns are mapped to canonical fields. Mapping is explicit and
 * recorded on the import run, so an import is reproducible and auditable:
 * the run stores exactly which file header fed which canonical field.
 *
 * Two ways to get a mapping:
 *  - the caller supplies one (JSON: file header -> canonical field), or
 *  - it is auto-derived from the headers by normalized name (lowercased,
 *    non-alphanumerics stripped) against the alias lists below.
 *
 * Required canonical fields: `lot_number` and at least one quantity field.
 * A file that cannot supply them is rejected at the file level (400) — the
 * import never proceeds with a partial or guessed mapping.
 *
 * Quantity columns: a row may carry milligrams, grams, kilograms, units, or
 * a generic `quantity` plus a `quantity_unit` column (mg/g/kg/units). All
 * conversions go through exact decimal arithmetic (lib/csv.ts); a value
 * that cannot be a whole milligram or a whole unit rejects the row.
 */

export const CANONICAL_FIELDS = [
  "lot_number",
  "product_name",
  "quantity_mg",
  "quantity_units",
  "quantity",
  "quantity_unit",
  "quantity_g",
  "quantity_kg",
  "movement_type",
  "recorded_date",
  "location",
  "source_reference",
  "note",
] as const;

export type CanonicalField = (typeof CANONICAL_FIELDS)[number];

/** File header (raw, as written) -> canonical field. */
export type FieldMapping = Record<string, CanonicalField>;

export const MOVEMENT_TYPES = [
  "RECEIVE",
  "TRANSFER_IN",
  "TRANSFER_OUT",
  "CONSUME",
  "PRODUCE",
  "PACKAGE",
  "ADJUST",
  "DESTROY",
  "SHIP",
  "RETURN",
] as const;

export type MovementType = (typeof MOVEMENT_TYPES)[number];

/** Normalized header (lowercased, non-alphanumerics removed) -> canonical field. */
const HEADER_ALIASES: Record<string, CanonicalField> = {
  lot: "lot_number",
  lotnumber: "lot_number",
  lotno: "lot_number",
  batch: "lot_number",
  batchnumber: "lot_number",
  batchno: "lot_number",
  product: "product_name",
  productname: "product_name",
  item: "product_name",
  itemname: "product_name",
  strain: "product_name",
  quantitymg: "quantity_mg",
  qtymg: "quantity_mg",
  quantitymilligrams: "quantity_mg",
  quantityunits: "quantity_units",
  qtyunits: "quantity_units",
  unitcount: "quantity_units",
  units: "quantity_units",
  quantity: "quantity",
  qty: "quantity",
  amount: "quantity",
  quantityunit: "quantity_unit",
  unit: "quantity_unit",
  uom: "quantity_unit",
  unitofmeasure: "quantity_unit",
  qtyunit: "quantity_unit",
  quantityg: "quantity_g",
  qtyg: "quantity_g",
  quantitygrams: "quantity_g",
  quantitykg: "quantity_kg",
  qtykg: "quantity_kg",
  quantitykilograms: "quantity_kg",
  movementtype: "movement_type",
  movement: "movement_type",
  type: "movement_type",
  recordeddate: "recorded_date",
  date: "recorded_date",
  transactiondate: "recorded_date",
  movementdate: "recorded_date",
  location: "location",
  locationname: "location",
  room: "location",
  bin: "location",
  container: "location",
  sourcereference: "source_reference",
  reference: "source_reference",
  ref: "source_reference",
  transfer: "source_reference",
  transfernumber: "source_reference",
  packingslip: "source_reference",
  note: "note",
  notes: "note",
  comment: "note",
  comments: "note",
};

export function normalizeHeader(header: string): string {
  return header.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Derive a mapping from the file's headers. Returns the mapping plus any
 * problems: two headers mapping to the same canonical field, or a header
 * that maps nowhere (unmapped headers are ignored, not an error — a
 * seed-to-sale export carries columns the wedge does not need).
 */
export function autoMapFields(headers: string[]): {
  mapping: FieldMapping;
  errors: string[];
} {
  const mapping: FieldMapping = {};
  const errors: string[] = [];
  const claimed = new Map<CanonicalField, string>();
  for (const header of headers) {
    const canonical = HEADER_ALIASES[normalizeHeader(header)];
    if (!canonical) continue;
    const previous = claimed.get(canonical);
    if (previous !== undefined && previous !== header) {
      errors.push(
        `Columns "${previous}" and "${header}" both map to ${canonical}; supply an explicit mapping.`,
      );
      continue;
    }
    claimed.set(canonical, header);
    mapping[header] = canonical;
  }
  return { mapping, errors };
}

/** Validate a caller-supplied mapping against the file's headers. */
export function validateExplicitMapping(
  mapping: unknown,
  headers: string[],
): { mapping: FieldMapping; errors: string[] } {
  const errors: string[] = [];
  if (typeof mapping !== "object" || mapping === null || Array.isArray(mapping)) {
    return {
      mapping: {},
      errors: ["mapping must be an object of file header -> canonical field."],
    };
  }
  const result: FieldMapping = {};
  for (const [header, canonical] of Object.entries(mapping as Record<string, unknown>)) {
    if (!headers.includes(header)) {
      errors.push(`Mapping refers to column "${header}", which is not in the file.`);
      continue;
    }
    if (
      typeof canonical !== "string" ||
      !(CANONICAL_FIELDS as readonly string[]).includes(canonical)
    ) {
      errors.push(
        `Mapping for column "${header}" names unknown canonical field "${String(canonical)}". Known fields: ${CANONICAL_FIELDS.join(", ")}.`,
      );
      continue;
    }
    result[header] = canonical as CanonicalField;
  }
  return { mapping: result, errors };
}

/** The mapping must cover lot_number and at least one quantity field. */
export function validateMappingCoverage(mapping: FieldMapping): string[] {
  const errors: string[] = [];
  const covered = new Set(Object.values(mapping));
  if (!covered.has("lot_number")) {
    errors.push("No column maps to lot_number. Rename a column or supply an explicit mapping.");
  }
  const quantityFields: CanonicalField[] = [
    "quantity_mg",
    "quantity_units",
    "quantity",
    "quantity_g",
    "quantity_kg",
  ];
  if (!quantityFields.some((field) => covered.has(field))) {
    errors.push(
      "No column maps to a quantity field (quantity_mg, quantity_units, quantity, quantity_g, or quantity_kg).",
    );
  }
  return errors;
}

/** Apply a mapping to one parsed row: canonical field -> raw string value. */
export function applyMapping(
  values: Record<string, string>,
  mapping: FieldMapping,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [header, canonical] of Object.entries(mapping)) {
    const value = values[header];
    if (value !== undefined && value !== "") {
      result[canonical] = value;
    }
  }
  return result;
}

export class RowValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RowValidationError";
  }
}

export interface ResolvedQuantities {
  quantityMg: number | null;
  quantityUnits: number | null;
}

/**
 * Resolve the quantities for one mapped row. Returns milligrams and/or
 * units (at least one must be present). Throws RowValidationError when the
 * row carries no usable quantity or a quantity is invalid.
 *
 * Quantities are non-negative by default. `allowNegative` (ADJUST movements
 * only) permits a leading "-" on the quantity, which is preserved as a
 * signed value — an adjustment can take stock away as well as add it.
 */
export function resolveRowQuantities(
  mapped: Record<string, string>,
  options?: { allowNegative?: boolean },
): ResolvedQuantities {
  let quantityMg: number | null = null;
  let quantityUnits: number | null = null;
  const allowNegative = options?.allowNegative === true;

  /** Parse a decimal quantity at a scale, honouring allowNegative. */
  const parseSigned = (value: string, scale: number, label: string): number => {
    const trimmed = value.trim();
    const negative = trimmed.startsWith("-");
    const magnitude = negative ? trimmed.slice(1) : trimmed;
    if (negative && !allowNegative) {
      throw new RowValidationError(
        `${label} "${value}" must not be negative (only ADJUST movements take a signed quantity).`,
      );
    }
    const parsed = decimalToScaledInt(magnitude, scale);
    if (parsed === null) {
      throw new RowValidationError(
        `${label} "${value}" is not a valid non-negative number at this unit.`,
      );
    }
    return negative ? -parsed : parsed;
  };

  const parseMg = (value: string, scale: number, label: string): number =>
    parseSigned(value, scale, label);

  if (mapped.quantity_mg !== undefined) {
    quantityMg = parseMg(mapped.quantity_mg, 1, "quantity_mg");
  }
  if (mapped.quantity_g !== undefined) {
    const grams = parseMg(mapped.quantity_g, 1000, "quantity_g");
    quantityMg = (quantityMg ?? 0) + grams;
  }
  if (mapped.quantity_kg !== undefined) {
    const kg = parseMg(mapped.quantity_kg, 1_000_000, "quantity_kg");
    quantityMg = (quantityMg ?? 0) + kg;
  }
  if (mapped.quantity !== undefined) {
    const unit = (mapped.quantity_unit ?? "mg").toLowerCase();
    if (unit === "mg") {
      quantityMg = (quantityMg ?? 0) + parseMg(mapped.quantity, 1, "quantity");
    } else if (unit === "g") {
      quantityMg = (quantityMg ?? 0) + parseMg(mapped.quantity, 1000, "quantity");
    } else if (unit === "kg") {
      quantityMg = (quantityMg ?? 0) + parseMg(mapped.quantity, 1_000_000, "quantity");
    } else if (unit === "units" || unit === "unit") {
      quantityUnits = (quantityUnits ?? 0) + parseSigned(mapped.quantity, 1, "quantity");
    } else {
      throw new RowValidationError(
        `quantity_unit "${mapped.quantity_unit}" is not one of: mg, g, kg, units.`,
      );
    }
  }
  if (mapped.quantity_units !== undefined) {
    quantityUnits = (quantityUnits ?? 0) + parseSigned(mapped.quantity_units, 1, "quantity_units");
  }

  if (quantityMg === null && quantityUnits === null) {
    throw new RowValidationError("Row has no quantity value.");
  }
  return { quantityMg, quantityUnits };
}

/** Normalize a movement_type value, or null when the row carries none. */
export function normalizeMovementType(value: string | undefined): MovementType | null {
  if (value === undefined) return null;
  const normalized = value
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, "_");
  if ((MOVEMENT_TYPES as readonly string[]).includes(normalized)) {
    return normalized as MovementType;
  }
  throw new RowValidationError(
    `movement_type "${value}" is not one of: ${MOVEMENT_TYPES.join(", ")}.`,
  );
}

/** Parse a recorded date (YYYY-MM-DD or ISO datetime). Null when absent. */
export function parseRecordedDate(value: string | undefined): Date | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (
    !/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(trimmed)
  ) {
    throw new RowValidationError(`recorded_date "${value}" is not a YYYY-MM-DD or ISO date.`);
  }
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    throw new RowValidationError(`recorded_date "${value}" is not a valid date.`);
  }
  return parsed;
}
