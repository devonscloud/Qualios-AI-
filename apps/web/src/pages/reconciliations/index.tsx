import { useEffect, useState } from "react";
import Link from "next/link";
import { DEMO_OPS_USER_ID, apiFetchJson, getOrganizationId } from "../../lib/api";

/**
 * Reconciliation runs — Days 14–18 (PRD FR-04).
 * Lists runs in the current organization and links to the new-run page
 * and to each run's lines + discrepancies.
 */
export default function Reconciliations() {
  const [runs, setRuns] = useState<
    {
      id: string;
      scope_type: string;
      scope_reference: string;
      status: string;
      created_at: string;
    }[]
  >([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiFetchJson<{ reconciliations: typeof runs }>("/api/reconciliations", DEMO_OPS_USER_ID)
      .then((body) => setRuns(body.reconciliations))
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  return (
    <main>
      <h1>Reconciliation runs</h1>
      <p className="notice">
        Demo only — viewing as the demo Ops user in organization {getOrganizationId()}. A run
        compares the QualiOS movement ledger against an uploaded external record set (a seed-to-sale
        export, an allocation, or a paper count sheet) and opens a discrepancy for every mismatch.
        Nothing is auto-resolved.
      </p>
      <p>
        <Link href="/reconciliations/new">Run a new reconciliation</Link>
      </p>
      {loading ? <p>Loading…</p> : null}
      {error ? <p className="notice">{error}</p> : null}
      {!loading && runs.length === 0 ? <p>No reconciliation runs yet.</p> : null}
      {runs.length > 0 ? (
        <table>
          <thead>
            <tr>
              <th>Run</th>
              <th>Scope</th>
              <th>Status</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => (
              <tr key={run.id}>
                <td>
                  <Link href={`/reconciliations/${run.id}`}>
                    <code>{run.id.slice(0, 8)}…</code>
                  </Link>
                </td>
                <td>
                  {run.scope_type} — {run.scope_reference}
                </td>
                <td>{run.status}</td>
                <td>{new Date(run.created_at).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      <p>
        <Link href="/">Back to home</Link>
      </p>
    </main>
  );
}
