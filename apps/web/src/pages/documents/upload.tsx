import { useState, type FormEvent } from "react";
import Link from "next/link";
import {
  API_URL,
  DEMO_OPS_USER_ID,
  apiHeaders,
  getOrganizationId,
  type DocumentSummary,
} from "../../lib/api";

/**
 * Document upload page — Days 12–14 (PRD FR-02).
 * Uploads a scan, photo, PDF, or CSV as the demo Ops uploader. The API
 * validates the file type and content, stores the original, and creates
 * version 1. Uploading a new version of an existing document is done from
 * the document detail page.
 */
export default function UploadDocument() {
  const [file, setFile] = useState<File | null>(null);
  const [documentType, setDocumentType] = useState("BATCH_RECORD");
  const [linkedLotId, setLinkedLotId] = useState("");
  const [changeNote, setChangeNote] = useState("");
  const [result, setResult] = useState<DocumentSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setResult(null);
    if (!file) {
      setError("Choose a file first.");
      return;
    }
    const form = new FormData();
    form.append("file", file);
    form.append("document_type", documentType);
    if (linkedLotId.trim() !== "") form.append("linked_lot_id", linkedLotId.trim());
    if (changeNote.trim() !== "") form.append("change_note", changeNote.trim());
    setBusy(true);
    try {
      const res = await fetch(`${API_URL}/api/documents`, {
        method: "POST",
        headers: apiHeaders(DEMO_OPS_USER_ID),
        body: form,
      });
      const body = (await res.json()) as {
        document?: DocumentSummary;
        error?: { code: string; message: string };
      };
      if (!res.ok) {
        throw new Error(
          body.error
            ? `${body.error.code}: ${body.error.message}`
            : `Upload failed (${res.status}).`,
        );
      }
      if (!body.document) throw new Error("Upload succeeded but returned no document.");
      setResult(body.document);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main>
      <h1>Upload a document</h1>
      <p className="notice">
        Demo only — uploading as the demo Ops user in organization {getOrganizationId()}. Accepted:
        PDF, JPEG, PNG, TIFF, CSV, XLSX, TXT (max 25 MB). The original is stored verbatim and
        hashed.
      </p>
      <form onSubmit={onSubmit}>
        <label>
          File (scan, photo, PDF, CSV)
          <input
            accept=".pdf,.jpg,.jpeg,.png,.tif,.tiff,.csv,.xlsx,.txt"
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            required
            type="file"
          />
        </label>
        <label>
          Document type
          <select onChange={(event) => setDocumentType(event.target.value)} value={documentType}>
            <option value="BATCH_RECORD">Batch record</option>
            <option value="PACKING_SLIP">Packing slip</option>
            <option value="COA">Certificate of analysis (COA)</option>
            <option value="TRANSFER_RECORD">Transfer record</option>
            <option value="INVOICE">Invoice</option>
            <option value="LISTING_FORM">Listing form</option>
            <option value="OTHER">Other</option>
          </select>
        </label>
        <label>
          Linked lot id (optional UUID)
          <input
            onChange={(event) => setLinkedLotId(event.target.value)}
            placeholder="e.g. 11111111-1111-4111-8111-111111111117"
            type="text"
            value={linkedLotId}
          />
        </label>
        <label>
          Change note (optional)
          <input
            onChange={(event) => setChangeNote(event.target.value)}
            type="text"
            value={changeNote}
          />
        </label>
        <button disabled={busy} type="submit">
          {busy ? "Uploading…" : "Upload"}
        </button>
      </form>
      {error ? <p className="notice">{error}</p> : null}
      {result ? (
        <section>
          <h2>Uploaded</h2>
          <p>
            Document <strong>{result.id}</strong> — {result.file_name} ({result.mime_type})
          </p>
          <p>
            Status: {result.status} · Version {result.latest_version} · SHA-256:{" "}
            <code>{result.sha256}</code>
          </p>
          <p>
            <Link href={`/documents/${result.id}`}>View document</Link> ·{" "}
            <Link href="/documents/review">Go to the review queue</Link>
          </p>
        </section>
      ) : null}
      <p>
        <Link href="/">Back to home</Link>
      </p>
    </main>
  );
}
