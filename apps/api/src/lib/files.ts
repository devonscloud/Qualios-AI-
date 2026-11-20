/**
 * Uploaded-file validation (PRD FR-02).
 *
 * Two checks, both required:
 *  1. Declared type: the MIME type and file extension must be on the
 *     allowlist for wedge documents (scans, photos, PDFs, CSV/XLSX).
 *  2. Content sniff: the first bytes must match the claimed format for
 *     binary types (PDF, PNG, JPEG, XLSX-as-ZIP). Text types (CSV/TXT)
 *     must decode as UTF-8 without NUL bytes. This stops a crafted file
 *     that claims to be a PDF but is not — the declared MIME comes from
 *     the client and is not trusted on its own.
 *
 * The allowlist is deliberately narrow. Anything else is rejected with
 * 400; the caller never sees the file.
 */

export const ALLOWED_TYPES: ReadonlyArray<{ mime: string; extensions: string[] }> = [
  { mime: "application/pdf", extensions: ["pdf"] },
  { mime: "image/jpeg", extensions: ["jpg", "jpeg"] },
  { mime: "image/png", extensions: ["png"] },
  { mime: "image/tiff", extensions: ["tif", "tiff"] },
  { mime: "text/csv", extensions: ["csv"] },
  {
    mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    extensions: ["xlsx"],
  },
  { mime: "text/plain", extensions: ["txt"] },
];

export type FileValidationError = { code: string; message: string };

function extensionOf(fileName: string): string {
  const parts = fileName.split(".");
  return parts.length > 1 ? (parts[parts.length - 1] ?? "").toLowerCase() : "";
}

/** Magic-byte / content check for the claimed MIME type. */
function contentMatches(mime: string, data: Buffer): boolean {
  if (mime === "application/pdf") {
    return data.subarray(0, 5).toString("ascii") === "%PDF-";
  }
  if (mime === "image/png") {
    return (
      data.length >= 8 &&
      data[0] === 0x89 &&
      data[1] === 0x50 &&
      data[2] === 0x4e &&
      data[3] === 0x47 &&
      data[4] === 0x0d &&
      data[5] === 0x0a &&
      data[6] === 0x1a &&
      data[7] === 0x0a
    );
  }
  if (mime === "image/jpeg") {
    return data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
  }
  if (mime === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") {
    // XLSX is a ZIP archive.
    return (
      data.length >= 4 &&
      data[0] === 0x50 &&
      data[1] === 0x4b &&
      data[2] === 0x03 &&
      data[3] === 0x04
    );
  }
  if (mime === "image/tiff") {
    // II*\0 (little-endian) or MM\0* (big-endian).
    return (
      data.length >= 4 &&
      ((data[0] === 0x49 && data[1] === 0x49 && data[2] === 0x2a && data[3] === 0x00) ||
        (data[0] === 0x4d && data[1] === 0x4d && data[2] === 0x00 && data[3] === 0x2a))
    );
  }
  if (mime === "text/csv" || mime === "text/plain") {
    // Must be valid UTF-8 text without NUL bytes (binary disguised as text).
    if (data.includes(0)) return false;
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(data);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

export function validateUpload(
  fileName: string,
  mimeType: string,
  data: Buffer,
): FileValidationError | null {
  const allowed = ALLOWED_TYPES.find((entry) => entry.mime === mimeType);
  if (!allowed) {
    return {
      code: "FILE_TYPE_NOT_ALLOWED",
      message: `MIME type ${mimeType} is not allowed. Allowed: ${ALLOWED_TYPES.map((entry) => entry.mime).join(", ")}.`,
    };
  }
  const extension = extensionOf(fileName);
  if (!allowed.extensions.includes(extension)) {
    return {
      code: "FILE_EXTENSION_MISMATCH",
      message: `File extension .${extension} does not match MIME type ${mimeType}.`,
    };
  }
  if (!contentMatches(mimeType, data)) {
    return {
      code: "FILE_CONTENT_MISMATCH",
      message: `File content does not match its declared type ${mimeType}.`,
    };
  }
  return null;
}
