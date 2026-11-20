/**
 * STUB — workers/document-processing (Days 7–12 scaffold).
 *
 * Async job worker (ADR-006): the API enqueues jobs (OCR, AI review, import,
 * scheduled report, integration retry); this worker processes them with
 * retries, dead-letter handling, and per-job status. No queue is configured
 * and no jobs are processed yet — that work lands in Days 12–18 (documents)
 * and Days 24–26 (OCR pipeline).
 */

export type JobType = "OCR" | "AI_REVIEW" | "IMPORT" | "SCHEDULED_REPORT" | "INTEGRATION_RETRY";

export interface Job {
  id: string;
  type: JobType;
  organizationId: string;
  payload: Record<string, unknown>;
}

/** STUB: throws. Job processing lands with the document flow (Days 12–18). */
export function processJob(_job: Job): Promise<void> {
  return Promise.reject(
    new Error("document-processing worker is a stub: no queue configured yet (ADR-006)."),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log("qualios document-processing worker — STUB. No queue configured; exiting.");
}
