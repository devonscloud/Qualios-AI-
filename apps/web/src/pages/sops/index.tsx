import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ApiCallError, DEMO_QA_USER_ID, apiFetchJson, type DocumentSummary } from "../../lib/api";

/**
 * SOP list — Phase 2 (B-201, B-207).
 * Lists documents of type SOP for this tenant, with their publish state:
 * which version (if any) is currently effective and from when. An SOP with
 * no effective version cannot be assigned for training yet.
 */
export default function SopList() {
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const body = await apiFetchJson<{ documents: DocumentSummary[] }>(
        "/api/documents?document_type=SOP",
        DEMO_QA_USER_ID,
      );
      setDocuments(body.documents);
    } catch (err) {
      setError(
        err instanceof ApiCallError
          ? `${err.code}: ${err.message}`
          : "Could not load the SOP list.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <main>
      <h1>Standard operating procedures</h1>
      <p className="notice">
        Demo only — viewing as the demo QA approver. An SOP is a document of type SOP; a version
        becomes the effective version only after approval and publishing.
      </p>
      {loading ? <p>Loading…</p> : null}
      {error ? <p className="notice">{error}</p> : null}
      {!loading && documents.length === 0 ? (
        <p>No SOPs yet. Upload one to start the approve → publish flow.</p>
      ) : null}
      <ul>
        {documents.map((doc) => (
          <li key={doc.id}>
            <p>
              <Link href={`/sops/${doc.id}`}>{doc.file_name}</Link> — {doc.status} · v
              {doc.latest_version}
              {doc.effective_version !== null
                ? ` · effective v${doc.effective_version} from ${new Date(doc.effective_from ?? "").toLocaleDateString()}`
                : " · no effective version yet"}
            </p>
          </li>
        ))}
      </ul>
      <p>
        <Link href="/sops/upload">Upload an SOP</Link> · <Link href="/training">Training</Link> ·{" "}
        <Link href="/">Back to home</Link>
      </p>
    </main>
  );
}
