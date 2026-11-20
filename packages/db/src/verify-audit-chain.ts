/**
 * verify-audit-chain CLI — recompute the audit-event hash chain and report.
 *
 * Usage: DATABASE_URL=postgres://... npm run audit:verify
 * Exit 0 when the chain is intact; exit 1 on the first broken event, with
 * the event id, organization, sequence number, and reason printed.
 */
import { createPool } from "./index.js";
import { verifyAuditChain } from "./audit.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required (see .env.example).");
}

const pool = createPool(databaseUrl);
try {
  const result = await verifyAuditChain(pool);
  if (result.ok) {
    console.log(
      `AUDIT CHAIN OK — ${result.totalEvents} event(s) across ${result.organizations} organization(s); every link recomputes and every previous_hash matches.`,
    );
  } else {
    const broken = result.brokenAt;
    console.error(
      `AUDIT CHAIN BROKEN at event ${broken?.eventId} (organization ${broken?.organizationId}, seq ${broken?.seq}): ${broken?.reason}`,
    );
    console.error(
      `Checked ${result.totalEvents} event(s) across ${result.organizations} organization(s) before the break.`,
    );
    process.exitCode = 1;
  }
} finally {
  await pool.end();
}
