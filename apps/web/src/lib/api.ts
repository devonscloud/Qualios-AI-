/**
 * Minimal API client for the demo pages (Days 12–18).
 *
 * Tenant context comes from localStorage (set on /select-tenant) and the
 * demo user ids below. This is DEMO ONLY: the tenant middleware is a stub
 * (ADR-011) — there is no real authentication yet, and the user id in the
 * header is only as trustworthy as the caller. The upload page acts as the
 * demo Ops uploader and the review pages act as the demo QA approver, so
 * the segregation-of-duties check can be exercised end to end.
 */

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

export const DEMO_ORG_ID = "11111111-1111-4111-8111-111111111111";
export const DEMO_OPS_USER_ID = "11111111-1111-4111-8111-111111111119";
export const DEMO_QA_USER_ID = "11111111-1111-4111-8111-111111111113";

export function getOrganizationId(): string {
  if (typeof window === "undefined") return DEMO_ORG_ID;
  return window.localStorage.getItem("qualios.organizationId") ?? DEMO_ORG_ID;
}

export function apiHeaders(userId: string): Record<string, string> {
  return {
    "x-organization-id": getOrganizationId(),
    "x-user-id": userId,
  };
}

export interface DocumentSummary {
  id: string;
  file_name: string;
  mime_type: string;
  sha256: string;
  document_type: string;
  linked_lot_id: string | null;
  linked_batch_id: string | null;
  status: string;
  uploaded_by: string;
  uploaded_by_name: string | null;
  created_at: string;
  updated_at: string;
  version_count: number;
  latest_version: number | null;
}

export interface DocumentVersion {
  id: string;
  document_id: string;
  version_number: number;
  storage_key: string;
  created_by: string;
  created_at: string;
  change_note: string | null;
}

export interface AuditEvent {
  id: string;
  event_type: string;
  actor_id: string | null;
  target_type: string | null;
  target_id: string | null;
  payload: Record<string, unknown>;
  created_at: string;
  previous_hash: string | null;
  event_hash: string;
  seq: number;
}

export class ApiCallError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function apiFetchJson<T>(
  path: string,
  userId: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { ...apiHeaders(userId), ...(init?.headers ?? {}) },
  });
  const body = (await res.json()) as {
    error?: { code: string; message: string };
  } & T;
  if (!res.ok) {
    throw new ApiCallError(
      res.status,
      body.error?.code ?? "UNKNOWN_ERROR",
      body.error?.message ?? `Request failed (${res.status}).`,
    );
  }
  return body as T;
}
