import * as XLSX from "xlsx";

/**
 * Tabular file parsing for external record imports (PRD FR-01).
 *
 * Both supported formats produce the same shape: a header row plus data
 * rows, each row carrying its 1-based data-row number (header excluded) so
 * an import log can point at the exact file line a rejection came from.
 *
 * CSV is parsed here (quoted fields, escaped quotes, CRLF/LF) rather than
 * pulled in as a dependency. XLSX is read with the `xlsx` package (first
 * sheet only — an external-system export is one table per file).
 *
 * Quantities are integers in the database (milligrams or units — Data Model
 * conventions), but files routinely carry decimals (1.338 kg). Conversion
 * is done in exact decimal arithmetic on the string, never through a float,
 * so 1.338 kg is exactly 1,338,000 mg and a value that cannot be an integer
 * number of milligrams (e.g. 0.0000001 kg) is rejected instead of rounded.
 */

export interface TabularRow {
  /** 1-based data-row number (header row excluded). */
  rowNumber: number;
  /** Values keyed by the file's header text, exactly as written. */
  values: Record<string, string>;
}

export interface TabularData {
  headers: string[];
  rows: TabularRow[];
}

export class TabularParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TabularParseError";
  }
}

/** Parse CSV text. Throws TabularParseError on an unterminated quoted field. */
export function parseCsv(text: string): TabularData {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let inQuotes = false;
  let fieldStarted = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
        } else {
          inQuotes = false;
          i += 1;
        }
      } else {
        field += ch;
        i += 1;
      }
      continue;
    }
    if (ch === '"') {
      if (fieldStarted && field.length > 0) {
        // A quote mid-field (not at the start) is literal text.
        field += ch;
        i += 1;
      } else {
        inQuotes = true;
        fieldStarted = true;
        i += 1;
      }
      continue;
    }
    if (ch === ",") {
      record.push(field);
      field = "";
      fieldStarted = false;
      i += 1;
      continue;
    }
    if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
      record.push(field);
      records.push(record);
      record = [];
      field = "";
      fieldStarted = false;
      i += 1;
      continue;
    }
    field += ch;
    fieldStarted = true;
    i += 1;
  }
  if (inQuotes) {
    throw new TabularParseError("CSV has an unterminated quoted field.");
  }
  if (fieldStarted || field.length > 0 || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  // Drop trailing blank lines (a final newline leaves an empty record).
  while (
    records.length > 0 &&
    (records[records.length - 1] ?? []).every((cell) => cell.trim() === "")
  ) {
    records.pop();
  }
  if (records.length === 0) {
    throw new TabularParseError("CSV file is empty.");
  }
  const headers = (records[0] ?? []).map((h) => h.trim());
  if (headers.length === 0 || headers.every((h) => h === "")) {
    throw new TabularParseError("CSV file has no header row.");
  }
  const rows: TabularRow[] = [];
  for (let r = 1; r < records.length; r += 1) {
    const cells = records[r] ?? [];
    if (cells.every((cell) => cell.trim() === "")) continue;
    const values: Record<string, string> = {};
    headers.forEach((header, idx) => {
      values[header] = (cells[idx] ?? "").trim();
    });
    rows.push({ rowNumber: r, values });
  }
  return { headers, rows };
}

/** Read the first sheet of an XLSX workbook as tabular data. */
export function parseXlsx(data: Buffer): TabularData {
  // A genuine .xlsx file is a ZIP archive. SheetJS's reader is lenient and
  // will happily "parse" arbitrary text as a one-column sheet, so check the
  // magic bytes first — otherwise a mislabelled text file would import as a
  // header-only sheet with no rows and no error.
  if (
    data.length < 4 ||
    data[0] !== 0x50 ||
    data[1] !== 0x4b ||
    data[2] !== 0x03 ||
    data[3] !== 0x04
  ) {
    throw new TabularParseError("Not an XLSX workbook (missing ZIP signature).");
  }
  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(data, { type: "buffer" });
  } catch {
    throw new TabularParseError("Could not parse the XLSX workbook.");
  }
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) {
    throw new TabularParseError("XLSX workbook has no sheets.");
  }
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) {
    throw new TabularParseError("XLSX workbook has no first sheet.");
  }
  const grid = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    defval: "",
    raw: true,
  });
  // Drop trailing blank rows.
  while (
    grid.length > 0 &&
    (grid[grid.length - 1] ?? []).every(
      (cell) => cell === "" || cell === null || cell === undefined,
    )
  ) {
    grid.pop();
  }
  if (grid.length === 0) {
    throw new TabularParseError("XLSX sheet is empty.");
  }
  const cellToString = (cell: unknown): string => {
    if (cell === null || cell === undefined) return "";
    if (typeof cell === "number") {
      // Numbers arrive as doubles. Integer milligrams/units up to 2^53 are
      // exact; decimals keep their shortest round-trip form.
      return String(cell);
    }
    if (cell instanceof Date) return cell.toISOString().slice(0, 10);
    return String(cell).trim();
  };
  const headers = (grid[0] ?? []).map(cellToString);
  if (headers.length === 0 || headers.every((h) => h === "")) {
    throw new TabularParseError("XLSX sheet has no header row.");
  }
  const rows: TabularRow[] = [];
  for (let r = 1; r < grid.length; r += 1) {
    const cells = grid[r] ?? [];
    if (cells.every((cell) => cellToString(cell) === "")) continue;
    const values: Record<string, string> = {};
    headers.forEach((header, idx) => {
      values[header] = cellToString(cells[idx]);
    });
    rows.push({ rowNumber: r, values });
  }
  return { headers, rows };
}

/**
 * Parse a CSV or XLSX buffer by MIME type. The caller has already validated
 * the MIME type and content (lib/files.ts); this only dispatches.
 */
export function parseTabularFile(data: Buffer, mimeType: string): TabularData {
  if (mimeType === "text/csv") {
    return parseCsv(data.toString("utf8"));
  }
  if (mimeType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") {
    return parseXlsx(data);
  }
  throw new TabularParseError(`Unsupported tabular MIME type: ${mimeType}.`);
}

/**
 * Convert a decimal string to a scaled integer exactly.
 * `scale` must be a power of 10 (1, 1000, 1_000_000). Returns null when the
 * value is not a decimal, is negative, or cannot be represented exactly at
 * this scale (e.g. 1.5 mg at scale 1, or 0.1234567 kg at scale 1_000_000).
 */
export function decimalToScaledInt(value: string, scale: number): number | null {
  const digits = Math.round(Math.log10(scale));
  if (scale <= 0 || 10 ** digits !== scale) return null;
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) return null;
  const negative = match[1] === "-";
  const intPart = match[2] ?? "0";
  const fracPart = match[3] ?? "";
  if (negative) return null;
  if (fracPart.length > digits) return null;
  const scaled = Number(intPart) * scale + Number(fracPart.padEnd(digits, "0") || "0");
  if (!Number.isSafeInteger(scaled)) return null;
  return scaled;
}
