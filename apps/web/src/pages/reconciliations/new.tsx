import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/router";
import {
  API_URL,
  DEMO_OPS_USER_ID,
  apiHeaders,
  getOrganizationId,
  type ImportRun,
} from "../../lib/api";

/**
 * New reconciliation run — Days 14–18 (PRD FR-01 / FR-04).
 * Uploads the external record file (an external-system snapshot, an allocation,
 * or a paper count sheet), picks a scope, creates the run, and executes the
 * engine — then lands on the run detail page. The upload is a SNAPSHOT: its
 * rows are the external record set; nothing is written into the ledger.
 */
export default function NewReconciliation() {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [importKind, setImportKind] = useState("EXTERNAL_SNAPSHOT");
  const [scopeType, setScopeType] = useState("SITE");
  const [scopeReference, setScopeReference] = useState("ALL");
  const [step, setStep] = useState<string | null>(null);
  const [importRun, setImportRun] = useState<ImportRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const scopeHelp: Record<string, string> = {
    SITE: 'Site UUID, or "ALL" for every site.',
    LOT: "A lot number, e.g. 260824.",
    PRODUCT: "A product UUID.",
    DATE_RANGE: "Two dates, e.g. 2026-08-01..2026-11-30.",
  };

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setImportRun(null);
    if (!file) {
      setError("Choose a file first.");
      return;
    }
    setBusy(true);
    try {
      // 1. Upload the external record set.
      setStep("Uploading the external record file…");
      const form = new FormData();
      form.append("file", file);
      form.append("import_kind", importKind);
      form.append("import_mode", "SNAPSHOT");
      const uploadRes = await fetch(`${API_URL}/api/imports`, {
        method: "POST",
        headers: apiHeaders(DEMO_OPS_USER_ID),
        body: form,
      });
      const uploadBody = (await uploadRes.json()) as {
        import_run?: ImportRun;
        error?: { code: string; message: string };
      };
      if (!uploadRes.ok) {
        throw new Error(
          uploadBody.error
            ? `${uploadBody.error.code}: ${uploadBody.error.message}`
            : `Import failed (${uploadRes.status}).`,
        );
      }
      if (!uploadBody.import_run) throw new Error("Import succeeded but returned no run.");
      setImportRun(uploadBody.import_run);
      if (uploadBody.import_run.rows_rejected > 0) {
        throw new Error(
          `Import rejected ${uploadBody.import_run.rows_rejected} of ` +
            `${uploadBody.import_run.rows_total} rows. ` +
            `Fix the file and try again — rejected rows are listed on the import, never silently dropped.`,
        );
      }

      // 2. Create the run, then execute the engine.
      setStep("Creating the reconciliation run…");
      const createRes = await fetch(`${API_URL}/api/reconciliations`, {
        method: "POST",
        headers: { ...apiHeaders(DEMO_OPS_USER_ID), "content-type": "application/json" },
        body: JSON.stringify({
          scope_type: scopeType,
          scope_reference: scopeReference.trim(),
          external_import_run_id: uploadBody.import_run.id,
        }),
      });
      const createBody = (await createRes.json()) as {
        reconciliation?: { id: string };
        error?: { code: string; message: string };
      };
      if (!createRes.ok) {
        throw new Error(
          createBody.error
            ? `${createBody.error.code}: ${createBody.error.message}`
            : `Run creation failed (${createRes.status}).`,
        );
      }
      const reconciliationId = createBody.reconciliation?.id;
      if (!reconciliationId) throw new Error("Run creation succeeded but returned no run.");
      setStep("Running the reconciliation engine…");
      const runRes = await fetch(`${API_URL}/api/reconciliations/${reconciliationId}/run`, {
        method: "POST",
        headers: apiHeaders(DEMO_OPS_USER_ID),
      });
      const runBody = (await runRes.json()) as {
        error?: { code: string; message: string };
      };
      if (!runRes.ok) {
        throw new Error(
          runBody.error
            ? `${runBody.error.code}: ${runBody.error.message}`
            : `Engine run failed (${runRes.status}).`,
        );
      }
      await router.push(`/reconciliations/${reconciliationId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Run failed.");
    } finally {
      setBusy(false);
      setStep(null);
    }
  };

  return (
    <main>
      <h1>Run a new reconciliation</h1>
      <p className="notice">
        Demo only — running as the demo Ops user in organization {getOrganizationId()}. The file is
        the external record set: an external-system snapshot, an allocation, or a paper count sheet
        (CSV or XLSX, max 25 MB). Columns map automatically by header name — lot, product, quantity
        (mg, g, kg, or units), movement type, date, location.
      </p>
      <form onSubmit={onSubmit}>
        <label>
          External record file (CSV or XLSX)
          <input
            accept=".csv,.xlsx"
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            required
            type="file"
          />
        </label>
        <label>
          Record kind
          <select onChange={(event) => setImportKind(event.target.value)} value={importKind}>
            <option value="EXTERNAL_SNAPSHOT">External system snapshot</option>
            <option value="ALLOCATION">Allocation</option>
            <option value="PAPER_COUNT">Paper count sheet</option>
          </select>
        </label>
        <label>
          Scope type
          <select
            onChange={(event) => {
              setScopeType(event.target.value);
              if (event.target.value === "SITE") setScopeReference("ALL");
              else setScopeReference("");
            }}
            value={scopeType}
          >
            <option value="SITE">Site</option>
            <option value="LOT">Lot</option>
            <option value="PRODUCT">Product</option>
            <option value="DATE_RANGE">Date range</option>
          </select>
        </label>
        <label>
          Scope reference — {scopeHelp[scopeType]}
          <input
            onChange={(event) => setScopeReference(event.target.value)}
            required
            type="text"
            value={scopeReference}
          />
        </label>
        <button disabled={busy} type="submit">
          {busy ? "Working…" : "Upload and run"}
        </button>
      </form>
      {step ? <p>{step}</p> : null}
      {error ? <p className="notice">{error}</p> : null}
      {importRun ? (
        <p>
          Import {importRun.id}: {importRun.rows_accepted}/{importRun.rows_total} rows accepted
          {importRun.rows_rejected > 0 ? `, ${importRun.rows_rejected} rejected` : ""}.
        </p>
      ) : null}
      <p>
        <Link href="/reconciliations">Back to runs</Link> · <Link href="/">Home</Link>
      </p>
    </main>
  );
}
