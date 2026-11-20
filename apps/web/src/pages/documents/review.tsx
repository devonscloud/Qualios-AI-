import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ApiCallError, DEMO_QA_USER_ID, apiFetchJson, type DocumentSummary } from "../../lib/api";

/**
 * Reviewer dashboard — Days 12–14 (PRD FR-02 review queue).
 * Lists documents awaiting a review decision and lets the demo QA approver
 * approve or reject each one. A rejection requires a reason. The uploader
 * cannot approve their own document (segregation of duties, T-02) — the
 * API enforces that and returns 403.
 */
export default function ReviewQueue() {
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const body = await apiFetchJson<{ documents: DocumentSummary[] }>(
        "/api/documents/review-queue",
        DEMO_QA_USER_ID,
      );
      setDocuments(body.documents);
    } catch (err) {
      setError(
        err instanceof ApiCallError
          ? `${err.code}: ${err.message}`
          : "Could not load the review queue.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const review = async (documentId: string, decision: "APPROVED" | "REJECTED") => {
    const note = notes[documentId] ?? "";
    if (decision === "REJECTED" && note.trim() === "") {
      setError("A reason is required to reject a document.");
      return;
    }
    setError(null);
    setMessage(null);
    try {
      await apiFetchJson(`/api/documents/${documentId}/review`, DEMO_QA_USER_ID, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision, note: note.trim() === "" ? null : note.trim() }),
      });
      setMessage(`Document ${decision === "APPROVED" ? "approved" : "rejected"}: ${documentId}.`);
      await load();
    } catch (err) {
      setError(err instanceof ApiCallError ? `${err.code}: ${err.message}` : "Review failed.");
    }
  };

  return (
    <main>
      <h1>Review queue</h1>
      <p className="notice">
        Demo only — reviewing as the demo QA approver. Documents uploaded by the Ops user appear
        here until a reviewer approves or rejects them.
      </p>
      {loading ? <p>Loading…</p> : null}
      {error ? <p className="notice">{error}</p> : null}
      {message ? <p>{message}</p> : null}
      {!loading && documents.length === 0 ? <p>No documents awaiting review.</p> : null}
      <ul>
        {documents.map((doc) => (
          <li key={doc.id}>
            <p>
              <Link href={`/documents/${doc.id}`}>{doc.file_name}</Link> — {doc.document_type} ·{" "}
              {doc.status} · v{doc.latest_version} · uploaded by{" "}
              {doc.uploaded_by_name ?? doc.uploaded_by} ·{" "}
              {new Date(doc.created_at).toLocaleString()}
            </p>
            <label>
              Reason (required to reject)
              <input
                onChange={(event) =>
                  setNotes((prev) => ({ ...prev, [doc.id]: event.target.value }))
                }
                type="text"
                value={notes[doc.id] ?? ""}
              />
            </label>
            <p>
              <button onClick={() => void review(doc.id, "APPROVED")} type="button">
                Approve
              </button>{" "}
              <button onClick={() => void review(doc.id, "REJECTED")} type="button">
                Reject
              </button>
            </p>
          </li>
        ))}
      </ul>
      <p>
        <Link href="/documents/upload">Upload a document</Link> · <Link href="/">Back to home</Link>
      </p>
    </main>
  );
}
