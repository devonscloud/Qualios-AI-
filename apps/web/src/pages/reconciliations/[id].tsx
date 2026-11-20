import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/router";
import {
  API_URL,
  DEMO_OPS_USER_ID,
  DEMO_QA_USER_ID,
  apiFetchJson,
  apiHeaders,
  type Discrepancy,
  type ReconciliationLine,
} from "../../lib/api";

interface RunDetail {
  reconciliation: {
    id: string;
    scope_type: string;
    scope_reference: string;
    status: string;
    summary: Record<string, unknown>;
    created_at: string;
  };
  lines: ReconciliationLine[];
  discrepancies: Discrepancy[];
}

/**
 * Reconciliation run detail — Days 14–18 (PRD FR-04).
 * Shows the engine's lines and every discrepancy it opened, with the
 * evidence on both sides. Resolution is a two-person flow: Ops proposes
 * (with a note), QA approves (RESOLVED or EXPLAINED). Nothing is
 * auto-resolved, and the proposer cannot approve their own resolution.
 */
export default function ReconciliationDetail() {
  const router = useRouter();
  const { id } = router.query;
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [outcomes, setOutcomes] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (typeof id !== "string") return;
    setLoading(true);
    try {
      const body = await apiFetchJson<RunDetail>(`/api/reconciliations/${id}`, DEMO_OPS_USER_ID);
      setDetail(body);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load the run.");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const postDiscrepancy = async (
    discrepancyId: string,
    action: "resolve" | "approve",
    body: Record<string, string>,
    userId: string,
  ) => {
    setBusyId(discrepancyId);
    setError(null);
    try {
      const res = await fetch(`${API_URL}/api/discrepancies/${discrepancyId}/${action}`, {
        method: "POST",
        headers: { ...apiHeaders(userId), "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const resBody = (await res.json()) as {
        error?: { code: string; message: string };
      };
      if (!res.ok) {
        throw new Error(
          resBody.error
            ? `${resBody.error.code}: ${resBody.error.message}`
            : `Request failed (${res.status}).`,
        );
      }
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed.");
    } finally {
      setBusyId(null);
    }
  };

  const formatQty = (mg: number | null, units: number | null): string => {
    const parts: string[] = [];
    if (mg !== null) parts.push(`${mg.toLocaleString()} mg`);
    if (units !== null) parts.push(`${units.toLocaleString()} units`);
    return parts.length > 0 ? parts.join(" · ") : "—";
  };

  if (loading) {
    return (
      <main>
        <p>Loading…</p>
      </main>
    );
  }
  if (error || !detail) {
    return (
      <main>
        <p className="notice">{error ?? "Run not found."}</p>
        <p>
          <Link href="/reconciliations">Back to runs</Link>
        </p>
      </main>
    );
  }

  const { reconciliation, lines, discrepancies } = detail;
  const summary = reconciliation.summary as {
    lines_compared?: number;
    matches?: number;
    variances?: number;
    missing_source?: number;
    discrepancies_total?: number;
    discrepancies_open?: number;
  };

  return (
    <main>
      <h1>Reconciliation run</h1>
      <p>
        Scope: <strong>{reconciliation.scope_type}</strong> — {reconciliation.scope_reference}
        {" · "}Status: <strong>{reconciliation.status}</strong>
        {" · "}Created {new Date(reconciliation.created_at).toLocaleString()}
      </p>
      <p>
        Lines compared: {summary.lines_compared ?? lines.length} · Matches: {summary.matches ?? "—"}{" "}
        · Variances: {summary.variances ?? "—"} · Missing source: {summary.missing_source ?? "—"} ·
        Discrepancies: {summary.discrepancies_total ?? 0} ({summary.discrepancies_open ?? 0} open)
      </p>

      <h2>Lines</h2>
      {lines.length === 0 ? (
        <p>No lines — the scope matched nothing on either side.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Lot</th>
              <th>Match</th>
              <th>Ledger</th>
              <th>External</th>
              <th>Allocated</th>
              <th>Produced</th>
              <th>Variance</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line) => (
              <tr key={line.id}>
                <td>{line.lot_number ?? "—"}</td>
                <td>{line.match_status}</td>
                <td>{formatQty(line.paper_record_qty_mg, line.paper_record_qty_units)}</td>
                <td>{formatQty(line.seed_to_sale_qty_mg, line.seed_to_sale_qty_units)}</td>
                <td>{formatQty(line.allocated_qty_mg, line.allocated_qty_units)}</td>
                <td>{formatQty(line.produced_qty_mg, line.produced_qty_units)}</td>
                <td>{formatQty(line.variance_mg, line.variance_units)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>Discrepancies</h2>
      {discrepancies.length === 0 ? (
        <p>No discrepancies — the ledger and the external record set agree.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Lot</th>
              <th>Type</th>
              <th>Severity</th>
              <th>Quantity</th>
              <th>Status</th>
              <th>Evidence / resolution</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {discrepancies.map((d) => (
              <tr key={d.id}>
                <td>{d.lot_number ?? "—"}</td>
                <td>{d.discrepancy_type}</td>
                <td>{d.severity}</td>
                <td>{formatQty(d.quantity_mg, d.quantity_units)}</td>
                <td>{d.status}</td>
                <td>
                  <p>{d.description}</p>
                  {d.evidence && Object.keys(d.evidence).length > 0 ? (
                    <p>
                      <code>{JSON.stringify(d.evidence)}</code>
                    </p>
                  ) : null}
                  {d.resolution_note ? <p>Note: {d.resolution_note}</p> : null}
                </td>
                <td>
                  {d.status === "OPEN" || d.status === "INVESTIGATING" ? (
                    <div>
                      <input
                        aria-label={`Resolution note for ${d.id}`}
                        onChange={(event) =>
                          setNotes((prev) => ({ ...prev, [d.id]: event.target.value }))
                        }
                        placeholder="Resolution note"
                        type="text"
                        value={notes[d.id] ?? ""}
                      />
                      <button
                        disabled={busyId === d.id}
                        onClick={() =>
                          postDiscrepancy(
                            d.id,
                            "resolve",
                            { resolution_note: notes[d.id] ?? "" },
                            DEMO_OPS_USER_ID,
                          )
                        }
                        type="button"
                      >
                        Propose (Ops)
                      </button>
                    </div>
                  ) : null}
                  {d.status === "RESOLUTION_PROPOSED" ? (
                    <div>
                      <select
                        aria-label={`Outcome for ${d.id}`}
                        onChange={(event) =>
                          setOutcomes((prev) => ({ ...prev, [d.id]: event.target.value }))
                        }
                        value={outcomes[d.id] ?? "RESOLVED"}
                      >
                        <option value="RESOLVED">Resolved</option>
                        <option value="EXPLAINED">Explained</option>
                      </select>
                      <button
                        disabled={busyId === d.id}
                        onClick={() =>
                          postDiscrepancy(
                            d.id,
                            "approve",
                            { outcome: outcomes[d.id] ?? "RESOLVED" },
                            DEMO_QA_USER_ID,
                          )
                        }
                        type="button"
                      >
                        Approve (QA)
                      </button>
                    </div>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {error ? <p className="notice">{error}</p> : null}
      <p>
        <Link href="/reconciliations">Back to runs</Link> · <Link href="/">Home</Link>
      </p>
    </main>
  );
}
