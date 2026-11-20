/**
 * STUB — @qualios/integrations (Days 7–12 scaffold).
 *
 * The wedge imports from seed-to-sale systems by FILE first (CSV/XLSX).
 * Live connectors are a P1 item and are designed against the REST API surface
 * (ADR-013: OpenAPI, webhook signatures, idempotency keys, scoped tokens).
 * Whether CertiCraft or other vendors expose a live API is unconfirmed —
 * a P1 investigation item (backlog Q-108).
 */

export type ImportFormat = "CSV" | "XLSX";

export interface FileImport {
  id: string;
  organizationId: string;
  format: ImportFormat;
  sourceSystem: string;
  documentId: string;
  status: "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED";
  rowsImported: number;
  rowsRejected: number;
}

/** STUB: throws. File import lands in Days 14–16 of the sprint. */
export function importFile(_file: FileImport): Promise<FileImport> {
  return Promise.reject(
    new Error("@qualios/integrations is a stub: file import lands in Days 14–16."),
  );
}
