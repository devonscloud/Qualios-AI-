import Link from "next/link";

export default function Home() {
  return (
    <main>
      <h1>QualiOS AI</h1>
      <p>
        AI-assisted operating system for regulated manufacturing. First wedge: cannabis inventory
        reconciliation + excise.
      </p>
      <p className="notice">
        <strong>Scaffold only (v0.1.0).</strong> Nothing here is a finished product. The login and
        tenant selection pages are UI placeholders — no authentication is wired yet (ADR-011).
      </p>
      <ul>
        <li>
          <Link href="/login">Sign in</Link>
        </li>
        <li>
          <Link href="/select-tenant">Select organization / site</Link>
        </li>
        <li>
          <Link href="/documents/upload">Upload a document</Link>
        </li>
        <li>
          <Link href="/documents/review">Review queue</Link>
        </li>
        <li>
          <Link href="/reconciliations">Reconciliation runs</Link>
        </li>
        <li>
          <Link href="/reconciliations/new">Run a new reconciliation</Link>
        </li>
      </ul>
    </main>
  );
}
