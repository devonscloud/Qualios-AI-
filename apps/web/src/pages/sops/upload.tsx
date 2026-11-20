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
 * SOP upload page — Phase 2 (B-201).
 * Uploads a file as an SOP (document_type=SOP, version 1) as the demo Ops
 * uploader. The SOP then needs approval by a different user (review queue)
 * and publishing before it becomes effective and assignable for training.
 */
export default function UploadSop() {
  const [file, setFile] = useState<File | null>(null);
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
    form.append("document_type", "SOP");
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
      <h1>Upload an SOP</h1>
      <p className="notice">
        Demo only — uploading as the demo Ops user in organization {getOrganizationId()}. Accepted:
        PDF, JPEG, PNG, TIFF, CSV, XLSX, TXT (max 25 MB). The original is stored verbatim and
        hashed. Next steps: a different user approves it in the review queue, then publishes it as
        the effective version.
      </p>
      <form onSubmit={onSubmit}>
        <label>
          File (the SOP document)
          <input
            accept=".pdf,.jpg,.jpeg,.png,.tif,.tiff,.csv,.xlsx,.txt"
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            required
            type="file"
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
          {busy ? "Uploading…" : "Upload SOP"}
        </button>
      </form>
      {error ? <p className="notice">{error}</p> : null}
      {result ? (
        <section>
          <h2>Uploaded</h2>
          <p>
            SOP <strong>{result.id}</strong> — {result.file_name} ({result.mime_type})
          </p>
          <p>
            Status: {result.status} · Version {result.latest_version} · SHA-256:{" "}
            <code>{result.sha256}</code>
          </p>
          <p>
            <Link href={`/sops/${result.id}`}>View SOP</Link> ·{" "}
            <Link href="/documents/review">Go to the review queue</Link>
          </p>
        </section>
      ) : null}
      <p>
        <Link href="/sops">All SOPs</Link> · <Link href="/">Back to home</Link>
      </p>
    </main>
  );
}
