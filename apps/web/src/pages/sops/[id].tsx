import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/router";
import Link from "next/link";
import {
  ApiCallError,
  DEMO_EMPLOYEE_USER_ID,
  DEMO_MANAGER_USER_ID,
  DEMO_QA_USER_ID,
  apiFetchJson,
  type AuditEvent,
  type DocumentSummary,
  type DocumentVersion,
} from "../../lib/api";

/**
 * SOP detail — Phase 2 (B-201, B-202).
 * Shows metadata, the effective version, the full version history, and the
 * audit trail. As the demo QA approver/manager: approve the SOP (review),
 * publish an approved version as effective, and assign training on the
 * effective version to an employee with a due date. The uploader cannot
 * approve or publish their own SOP — the API enforces that (T-02).
 */
export default function SopDetail() {
  const router = useRouter();
  const documentId = typeof router.query.id === "string" ? router.query.id : null;

  const [document, setDocument] = useState<DocumentSummary | null>(null);
  const [versions, setVersions] = useState<DocumentVersion[]>([]);
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
  const [assigneeId, setAssigneeId] = useState(DEMO_EMPLOYEE_USER_ID);
  const [dueDate, setDueDate] = useState(
    new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
  );
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
        err instanceof ApiCallError ? `${err.code}: ${err.message}` : "Could not load the SOP.",
      );
    } finally {
      setLoading(false);
    }
  }, [documentId]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (label: string, run: () => Promise<void>) => {
    setError(null);
    setMessage(null);
    try {
      await run();
      setMessage(label);
      await load();
    } catch (err) {
      setError(err instanceof ApiCallError ? `${err.code}: ${err.message}` : `${label} failed.`);
    }
  };

  const approve = () =>
    act("SOP approved.", async () => {
      await apiFetchJson(`/api/documents/${documentId}/review`, DEMO_QA_USER_ID, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "APPROVED", note: "Approved from the SOP page." }),
      });
    });

  const publish = () =>
    act("SOP published as effective.", async () => {
      if (!document) return;
      await apiFetchJson(`/api/documents/${documentId}/publish`, DEMO_QA_USER_ID, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version_number: document.latest_version }),
      });
    });

  const assignTraining = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!documentId || assigneeId.trim() === "" || dueDate === "") {
      setError("An assignee and a due date are required.");
      return;
    }
    await act("Training assigned.", async () => {
      await apiFetchJson("/api/training/assignments", DEMO_MANAGER_USER_ID, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          document_id: documentId,
          assignee_id: assigneeId.trim(),
          due_at: new Date(`${dueDate}T00:00:00Z`).toISOString(),
        }),
      });
    });
  };

  if (loading) {
    return (
      <main>
        <h1>SOP</h1>
        <p>Loading…</p>
      </main>
    );
  }

  if (!document) {
    return (
      <main>
        <h1>SOP</h1>
        {error ? <p className="notice">{error}</p> : <p>Not found.</p>}
        <p>
          <Link href="/sops">Back to SOPs</Link>
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
        Effective version:{" "}
        {document.effective_version !== null
          ? `v${document.effective_version} from ${new Date(document.effective_from ?? "").toLocaleString()}`
          : "none yet — approve and publish a version first"}
      </p>
      <p>
        SHA-256 (latest version): <code>{document.sha256}</code>
      </p>
      {message ? <p>{message}</p> : null}
      {error ? <p className="notice">{error}</p> : null}

      <h2>Approve &amp; publish</h2>
      <p>
        <button onClick={() => void approve()} type="button">
          Approve (as QA)
        </button>{" "}
        <button onClick={() => void publish()} type="button">
          Publish latest version as effective (as QA)
        </button>
      </p>

      <h2>Assign training</h2>
      {document.effective_version === null ? (
        <p>No effective version yet — training can only be assigned on the effective version.</p>
      ) : (
        <form onSubmit={assignTraining}>
          <label>
            Assignee user id
            <input
              onChange={(event) => setAssigneeId(event.target.value)}
              type="text"
              value={assigneeId}
            />
          </label>
          <label>
            Due date
            <input
              onChange={(event) => setDueDate(event.target.value)}
              type="date"
              value={dueDate}
            />
          </label>
          <button type="submit">Assign training on v{document.effective_version}</button>
        </form>
      )}

      <h2>Versions</h2>
      <ul>
        {versions.map((version) => (
          <li key={version.id}>
            v{version.version_number} — {new Date(version.created_at).toLocaleString()}
            {version.change_note ? ` — ${version.change_note}` : ""}
            {version.version_number === document.latest_version ? " (latest)" : ""}
            {version.version_number === document.effective_version ? " (effective)" : ""}
          </li>
        ))}
      </ul>

      <h2>Audit trail</h2>
      {auditEvents.length === 0 ? (
        <p>No audit events for this SOP.</p>
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
        <Link href="/sops">Back to SOPs</Link> · <Link href="/training">Training</Link> ·{" "}
        <Link href="/">Back to home</Link>
      </p>
    </main>
  );
}
