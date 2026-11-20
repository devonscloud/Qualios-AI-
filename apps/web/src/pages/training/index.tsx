import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  API_URL,
  ApiCallError,
  DEMO_EMPLOYEE_USER_ID,
  DEMO_MANAGER_USER_ID,
  apiFetchJson,
  apiHeaders,
  type TrainingAssignment,
} from "../../lib/api";

/**
 * Training page — Phase 2 (B-202–B-204, B-207).
 * Two views on one page (demo users are fixed):
 * - "My training": assignments for the demo employee, who completes them
 *   with an explicit acknowledgement and an optional assessment score.
 * - "Manager review": completed assignments awaiting verification, which
 *   the demo manager verifies. The completer cannot verify their own
 *   completion — the API enforces that (T-02).
 * A dated CSV export of the full SOP/training audit trail is downloadable
 * from here.
 */
export default function Training() {
  const [mine, setMine] = useState<TrainingAssignment[]>([]);
  const [review, setReview] = useState<TrainingAssignment[]>([]);
  const [counts, setCounts] = useState<Record<string, number> | null>(null);
  const [scores, setScores] = useState<Record<string, string>>({});
  const [acknowledged, setAcknowledged] = useState<Record<string, boolean>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const mineBody = await apiFetchJson<{ assignments: TrainingAssignment[] }>(
        `/api/training/assignments?assignee_id=${DEMO_EMPLOYEE_USER_ID}`,
        DEMO_EMPLOYEE_USER_ID,
      );
      setMine(mineBody.assignments);
      const reviewBody = await apiFetchJson<{
        assignments: TrainingAssignment[];
        counts: Record<string, number>;
      }>("/api/training/review", DEMO_MANAGER_USER_ID);
      setReview(reviewBody.assignments);
      setCounts(reviewBody.counts);
    } catch (err) {
      setError(
        err instanceof ApiCallError ? `${err.code}: ${err.message}` : "Could not load training.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const complete = async (assignmentId: string) => {
    if (!acknowledged[assignmentId]) {
      setError("Tick the acknowledgement to complete the training.");
      return;
    }
    const scoreRaw = scores[assignmentId] ?? "";
    const score = scoreRaw === "" ? undefined : Number(scoreRaw);
    if (score !== undefined && (!Number.isInteger(score) || score < 0 || score > 100)) {
      setError("Assessment score must be a whole number from 0 to 100.");
      return;
    }
    setError(null);
    setMessage(null);
    try {
      await apiFetchJson(
        `/api/training/assignments/${assignmentId}/complete`,
        DEMO_EMPLOYEE_USER_ID,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            acknowledgement: true,
            ...(score === undefined ? {} : { assessment_score: score }),
          }),
        },
      );
      setMessage("Training completed.");
      await load();
    } catch (err) {
      setError(err instanceof ApiCallError ? `${err.code}: ${err.message}` : "Completion failed.");
    }
  };

  const verify = async (assignmentId: string) => {
    setError(null);
    setMessage(null);
    try {
      await apiFetchJson(`/api/training/assignments/${assignmentId}/verify`, DEMO_MANAGER_USER_ID, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      setMessage("Completion verified.");
      await load();
    } catch (err) {
      setError(
        err instanceof ApiCallError ? `${err.code}: ${err.message}` : "Verification failed.",
      );
    }
  };

  const downloadExport = async () => {
    setError(null);
    try {
      const res = await fetch(`${API_URL}/api/training/audit-trail/export`, {
        headers: apiHeaders(DEMO_MANAGER_USER_ID),
      });
      if (!res.ok) {
        const body = (await res.json()) as { error?: { code: string; message: string } };
        throw new Error(
          body.error ? `${body.error.code}: ${body.error.message}` : "Export failed.",
        );
      }
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const anchor = window.document.createElement("a");
      anchor.href = url;
      anchor.download =
        res.headers.get("content-disposition")?.match(/filename="([^"]+)"/)?.[1] ??
        "qualios-sop-training-audit-trail.csv";
      anchor.click();
      window.URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Export failed.");
    }
  };

  return (
    <main>
      <h1>Training</h1>
      <p className="notice">
        Demo only — “My training” acts as the demo employee; “Manager review” acts as the demo
        manager. Completion needs an explicit acknowledgement and is recorded against the exact SOP
        version assigned.
      </p>
      {loading ? <p>Loading…</p> : null}
      {error ? <p className="notice">{error}</p> : null}
      {message ? <p>{message}</p> : null}

      <h2>My training</h2>
      {mine.length === 0 && !loading ? <p>No training assigned to the demo employee.</p> : null}
      <ul>
        {mine.map((assignment) => (
          <li key={assignment.id}>
            <p>
              <Link href={`/sops/${assignment.document_id}`}>{assignment.document_file_name}</Link>{" "}
              — v{assignment.version_number} · {assignment.status}
              {assignment.overdue ? " · OVERDUE" : ""} · due{" "}
              {new Date(assignment.due_at).toLocaleDateString()}
              {assignment.completion
                ? ` · completed ${new Date(assignment.completion.completed_at).toLocaleString()}${assignment.completion.assessment_score !== null ? ` (score ${assignment.completion.assessment_score})` : ""}`
                : ""}
              {assignment.verified_at
                ? ` · verified by ${assignment.verified_by_name ?? assignment.verified_by}`
                : ""}
            </p>
            {assignment.status === "ASSIGNED" || assignment.status === "IN_PROGRESS" ? (
              <p>
                <label>
                  <input
                    checked={acknowledged[assignment.id] ?? false}
                    onChange={(event) =>
                      setAcknowledged((prev) => ({
                        ...prev,
                        [assignment.id]: event.target.checked,
                      }))
                    }
                    type="checkbox"
                  />{" "}
                  I acknowledge I have read and understood this SOP version.
                </label>{" "}
                <label>
                  Assessment score (optional, 0–100)
                  <input
                    onChange={(event) =>
                      setScores((prev) => ({ ...prev, [assignment.id]: event.target.value }))
                    }
                    type="number"
                    value={scores[assignment.id] ?? ""}
                  />
                </label>{" "}
                <button onClick={() => void complete(assignment.id)} type="button">
                  Complete training
                </button>
              </p>
            ) : null}
          </li>
        ))}
      </ul>

      <h2>Manager review</h2>
      {counts ? (
        <p>
          Assigned: {counts.assigned} · Completed: {counts.completed} · Verified: {counts.verified}{" "}
          · Overdue: {counts.overdue}
        </p>
      ) : null}
      {review.length === 0 && !loading ? <p>No completed training awaiting review.</p> : null}
      <ul>
        {review.map((assignment) => (
          <li key={assignment.id}>
            <p>
              {assignment.document_file_name} — v{assignment.version_number} ·{" "}
              {assignment.assignee_name ?? assignment.assignee_id} · completed{" "}
              {assignment.completed_at ? new Date(assignment.completed_at).toLocaleString() : "—"}
              {assignment.verified_at
                ? ` · verified by ${assignment.verified_by_name ?? assignment.verified_by}`
                : " · awaiting verification"}
            </p>
            {assignment.verified_at === null ? (
              <button onClick={() => void verify(assignment.id)} type="button">
                Verify completion
              </button>
            ) : null}
          </li>
        ))}
      </ul>

      <h2>Audit-trail export</h2>
      <p>
        <button onClick={() => void downloadExport()} type="button">
          Download dated audit-trail CSV
        </button>
      </p>
      <p>
        <Link href="/sops">SOPs</Link> · <Link href="/">Back to home</Link>
      </p>
    </main>
  );
}
