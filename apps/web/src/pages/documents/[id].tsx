import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/router";
import Link from "next/link";
import {
  API_URL,
  ApiCallError,
  DEMO_OPS_USER_ID,
  DEMO_QA_USER_ID,
  apiFetchJson,
  apiHeaders,
  type AuditEvent,
  type DocumentSummary,
  type DocumentVersion,
} from "../../lib/api";

/**
 * Document detail — Days 12–14.
 * Shows metadata, the full version history (each version downloadable as
 * the original file), the audit trail for the document, and a form to
 * upload a new version. A new version never overwrites an earlier one.
 */
export default function DocumentDetail() {
  const router = useRouter();
  const documentId = typeof router.query.id === "string" ? router.query.id : null;

  const [document, setDocument] = useState<DocumentSummary | null>(null);
  const [versions, setVersions] = useState<DocumentVersion[]>([]);
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [changeNote, setChangeNote] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!documentId) return;
    setLoading(true);
    setError(null);
    try {
      const detail = await apiFetchJson<{
        document: DocumentSummary;
        versions: DocumentVersion[];
      }>(`/api/documents/${documentId}`, DEMO_QA_USER_ID);
      setDocument(detail.document);
      setVersions(detail.versions);
      const audit = await apiFetchJson<{ audit_events: AuditEvent[] }>(
        `/api/audit-events?target_type=document&target_id=${documentId}`,
        DEMO_QA_USER_ID,
      );
      setAuditEvents(audit.audit_events);
    } catch (err) {
      setError(
        err instanceof ApiCallError
          ? `${err.code}: ${err.message}`
          : "Could not load the document.",
      );
    } finally {
      setLoading(false);
    }
  }, [documentId]);

  useEffect(() => {
    void load();
  }, [load]);

  const download = async (versionNumber: number, fileName: string) => {
    if (!documentId) return;
    setError(null);
    try {
      const res = await fetch(
        `${API_URL}/api/documents/${documentId}/versions/${versionNumber}/download`,
        { headers: apiHeaders(DEMO_QA_USER_ID) },
      );
      if (!res.ok) {
        const body = (await res.json()) as { error?: { code: string; message: string } };
        throw new Error(
          body.error ? `${body.error.code}: ${body.error.message}` : "Download failed.",
        );
      }
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const anchor = window.document.createElement("a");
      anchor.href = url;
      anchor.download = fileName;
      anchor.click();
      window.URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Download failed.");
    }
  };

  const uploadVersion = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!documentId || !file) {
      setError("Choose a file first.");
      return;
    }
    const form = new FormData();
    form.append("file", file);
    if (changeNote.trim() !== "") form.append("change_note", changeNote.trim());
    setError(null);
    setMessage(null);
    try {
      const res = await fetch(`${API_URL}/api/documents/${documentId}/versions`, {
        method: "POST",
        headers: apiHeaders(DEMO_OPS_USER_ID),
        body: form,
      });
      const body = (await res.json()) as {
        version_number?: number;
        error?: { code: string; message: string };
      };
      if (!res.ok) {
        throw new Error(
          body.error ? `${body.error.code}: ${body.error.message}` : "Upload failed.",
        );
      }
      setMessage(`Version ${body.version_number} uploaded. The document is awaiting review again.`);
      setFile(null);
      setChangeNote("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed.");
    }
  };

  if (loading) {
    return (
      <main>
        <h1>Document</h1>
        <p>Loading…</p>
      </main>
    );
  }

  if (!document) {
    return (
      <main>
        <h1>Document</h1>
        {error ? <p className="notice">{error}</p> : <p>Not found.</p>}
        <p>
          <Link href="/documents/review">Back to the review queue</Link>
        </p>
      </main>
    );
  }

  return (
    <main>
      <h1>{document.file_name}</h1>
      <p>
        Type: {document.document_type} · Status: {document.status} · MIME: {document.mime_type}
      </p>
      <p>
        Uploaded by {document.uploaded_by_name ?? document.uploaded_by} on{" "}
        {new Date(document.created_at).toLocaleString()}
      </p>
      <p>
        SHA-256 (latest version): <code>{document.sha256}</code>
      </p>

      <h2>Versions</h2>
      <ul>
        {versions.map((version) => (
          <li key={version.id}>
            v{version.version_number} — {new Date(version.created_at).toLocaleString()}
            {version.change_note ? ` — ${version.change_note}` : ""}
            {version.version_number === document.latest_version ? " (latest)" : ""}{" "}
            <button
              onClick={() => void download(version.version_number, document.file_name)}
              type="button"
            >
              Download original
            </button>
          </li>
        ))}
      </ul>

      <h2>Upload a new version</h2>
      <form onSubmit={uploadVersion}>
        <label>
          File
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
        <button type="submit">Upload new version</button>
      </form>
      {message ? <p>{message}</p> : null}
      {error ? <p className="notice">{error}</p> : null}

      <h2>Audit trail</h2>
      {auditEvents.length === 0 ? (
        <p>No audit events for this document.</p>
      ) : (
        <ul>
          {auditEvents.map((event) => (
            <li key={event.id}>
              {event.event_type} — {new Date(event.created_at).toLocaleString()} — hash{" "}
              <code>{event.event_hash.slice(0, 12)}…</code>
            </li>
          ))}
        </ul>
      )}
      <p>
        <Link href="/documents/review">Back to the review queue</Link> ·{" "}
        <Link href="/">Back to home</Link>
      </p>
    </main>
  );
}
