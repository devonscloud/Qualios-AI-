import { useState } from "react";
import Link from "next/link";

/**
 * Tenant / site selection — UI ONLY (Days 7–12 scaffold).
 * The two tenants below are SYNTHETIC demo data. Selecting one stores the
 * organization id in localStorage for the demo only; the API stub reads
 * x-organization-id headers, and real tenant switching will be driven by
 * the managed auth provider (ADR-011).
 */
const DEMO_TENANTS = [
  {
    name: "Herba Farms Ltd. — Demo Tenant (synthetic)",
    organizationId: "11111111-1111-4111-8111-111111111111",
    sites: ["Regina Processing Facility (demo)"],
  },
  {
    name: "Prairie Foods Co. — Demo Tenant (synthetic)",
    organizationId: "22222222-2222-4222-8222-222222222222",
    sites: ["Winnipeg Production Kitchen (demo)"],
  },
];

export default function SelectTenant() {
  const [selected, setSelected] = useState<string | null>(null);

  const select = (organizationId: string) => {
    window.localStorage.setItem("qualios.organizationId", organizationId);
    setSelected(organizationId);
  };

  return (
    <main>
      <h1>Select organization</h1>
      <p className="notice">
        Demo only — these are synthetic tenants. Real organizations will appear here once auth is
        wired (ADR-011).
      </p>
      <ul>
        {DEMO_TENANTS.map((tenant) => (
          <li key={tenant.organizationId}>
            <button onClick={() => select(tenant.organizationId)} type="button">
              {tenant.name}
            </button>
            <span> — {tenant.sites.join(", ")}</span>
            {selected === tenant.organizationId ? <strong> Selected (local only)</strong> : null}
          </li>
        ))}
      </ul>
      <p>
        <Link href="/">Back to home</Link>
      </p>
    </main>
  );
}
