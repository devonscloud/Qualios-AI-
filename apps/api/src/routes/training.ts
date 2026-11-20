import { Router, type Request, type Response } from "express";
import { recordAuditEvent } from "@qualios/db";
import { isTenantMember, isUuid, withTenant } from "../lib/db.js";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors.js";

/**
 * Training routes — Phase 2 (B-202–B-204, Data Model §4).
 *
 *  POST   /api/training/assignments                 Assign an SOP version to a user
 *  GET    /api/training/assignments                 List assignments (tenant-scoped)
 *  GET    /api/training/assignments/:id             One assignment + completion
 *  POST   /api/training/assignments/:id/complete    Assignee completes (acknowledgement)
 *  POST   /api/training/assignments/:id/verify      Manager verifies a completion
 *  GET    /api/training/review                      Manager review list + counts
 *  GET    /api/training/audit-trail/export          Dated CSV export of every SOP/training step
 *
 * Industry-neutral core: training is always on one specific version of a
 * generic document (an SOP). Assignments are only made against the
 * EFFECTIVE version of an SOP — an employee trains on the version that is
 * currently in force, never on a draft or superseded version.
 *
 * Segregation of duties (T-02, mirrored from document review): the person
 * who verifies a completion must differ from the person who completed it.
 * In particular, a user who assigned training to themselves cannot verify
 * their own completion. (A manager assigning to an employee and then
 * verifying that employee's completion is the normal flow and is allowed.)
 *
 * Every step writes a hash-chained audit event in the same transaction
 * (Data Model §7). The export endpoint reads those events back as a dated
 * CSV: upload → versions → approval → publish → assignment → completion →
 * verification, in chain order.
 *
 * OVERDUE is a derived flag, not a stored transition in this increment:
 * an assignment is overdue when its due date has passed and it is still
 * open (ASSIGNED or IN_PROGRESS). The status enum carries OVERDUE for a
 * future batch job; no code writes it yet.
 */

export const trainingRouter = Router();

const ASSIGNMENT_STATUSES = [
  "ASSIGNED",
  "IN_PROGRESS",
  "COMPLETED",
  "OVERDUE",
  "EXEMPTED",
] as const;

/** Audit event types that belong to the SOP/training trail. */
const TRAIL_EVENT_TYPES = [
  "DOCUMENT_UPLOADED",
  "DOCUMENT_VERSION_UPLOADED",
  "DOCUMENT_APPROVED",
  "DOCUMENT_REJECTED",
  "SOP_PUBLISHED",
  "TRAINING_ASSIGNED",
  "TRAINING_COMPLETED",
  "TRAINING_VERIFIED",
] as const;

interface AssignmentRow {
  id: string;
  organization_id: string;
  document_id: string;
  document_file_name: string;
  document_type: string;
  version_number: number;
  assignee_id: string;
  assignee_name: string | null;
  assigned_by: string;
  assigned_by_name: string | null;
  due_at: string;
  status: string;
  completed_at: string | null;
  verified_by: string | null;
  verified_by_name: string | null;
  verified_at: string | null;
  created_at: string;
  updated_at: string;
}

interface CompletionRow {
  id: string;
  assignment_id: string;
  user_id: string;
  document_id: string;
  version_number: number;
  acknowledgement: boolean;
  assessment_score: number | null;
  completed_at: string;
}

const ASSIGNMENT_SELECT = `
  a.id, a.organization_id, a.document_id, d.file_name AS document_file_name,
  d.document_type, a.version_number,
  a.assignee_id, assignee.display_name AS assignee_name,
  a.assigned_by, assigner.display_name AS assigned_by_name,
  a.due_at, a.status, a.completed_at,
  a.verified_by, verifier.display_name AS verified_by_name, a.verified_at,
  a.created_at, a.updated_at
  FROM training_assignments a
  JOIN documents d ON d.id = a.document_id
  LEFT JOIN users assignee ON assignee.id = a.assignee_id
  LEFT JOIN users assigner ON assigner.id = a.assigned_by
  LEFT JOIN users verifier ON verifier.id = a.verified_by
`;

function toAssignmentSummary(
  row: AssignmentRow,
  completion: CompletionRow | null,
): Record<string, unknown> {
  const overdue =
    (row.status === "ASSIGNED" || row.status === "IN_PROGRESS") &&
    new Date(row.due_at).getTime() < Date.now();
  return {
    id: row.id,
    organization_id: row.organization_id,
    document_id: row.document_id,
    document_file_name: row.document_file_name,
    document_type: row.document_type,
    version_number: row.version_number,
    assignee_id: row.assignee_id,
    assignee_name: row.assignee_name,
    assigned_by: row.assigned_by,
    assigned_by_name: row.assigned_by_name,
    due_at: row.due_at,
    status: row.status,
    overdue,
    completed_at: row.completed_at,
    verified_by: row.verified_by,
    verified_by_name: row.verified_by_name,
    verified_at: row.verified_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    completion:
      completion === null
        ? null
        : {
            id: completion.id,
            user_id: completion.user_id,
            document_id: completion.document_id,
            version_number: completion.version_number,
            acknowledgement: completion.acknowledgement,
            assessment_score: completion.assessment_score,
            completed_at: completion.completed_at,
          },
  };
}

function requireTenant(req: Request): {
  organizationId: string;
  userId: string;
} {
  const tenant = req.tenant;
  if (!tenant) throw new Error("tenant middleware did not run");
  return tenant;
}

/** Express 5 types route params as string | string[]; a repeated param is a client error. */
function paramString(value: string | string[], field: string): string {
  if (Array.isArray(value)) {
    throw badRequest("INVALID_ID", `${field} must be a single value.`);
  }
  return value;
}

function parseDueAt(value: unknown): Date {
  if (typeof value !== "string" || value === "") {
    throw badRequest("INVALID_FIELD", "due_at is required as an ISO 8601 date-time string.");
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw badRequest("INVALID_FIELD", "due_at must be an ISO 8601 date-time.");
  }
  return date;
}

function parseOptionalScore(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 100) {
    throw badRequest("INVALID_FIELD", "assessment_score must be an integer from 0 to 100.");
  }
  return value;
}

async function loadCompletion(
  client: { query: (text: string, values: unknown[]) => Promise<{ rows: CompletionRow[] }> },
  assignmentId: string,
): Promise<CompletionRow | null> {
  const { rows } = await client.query(
    `SELECT id, assignment_id, user_id, document_id, version_number,
            acknowledgement, assessment_score, completed_at
     FROM training_completions WHERE assignment_id = $1`,
    [assignmentId],
  );
  return rows[0] ?? null;
}

/** Assign training on an SOP's effective version to an employee. */
trainingRouter.post("/assignments", async (req: Request, res: Response) => {
  const { organizationId, userId } = requireTenant(req);
  const documentId = req.body?.document_id;
  if (typeof documentId !== "string" || !isUuid(documentId)) {
    throw badRequest("INVALID_FIELD", "document_id must be a UUID.");
  }
  const assigneeId = req.body?.assignee_id;
  if (typeof assigneeId !== "string" || !isUuid(assigneeId)) {
    throw badRequest("INVALID_FIELD", "assignee_id must be a UUID.");
  }
  const dueAt = parseDueAt(req.body?.due_at);
  const requestedVersion = req.body?.version_number;
  if (
    requestedVersion !== undefined &&
    requestedVersion !== null &&
    (!Number.isInteger(requestedVersion) || requestedVersion < 1)
  ) {
    throw badRequest("INVALID_FIELD", "version_number must be a positive integer.");
  }

  const result = await withTenant(organizationId, async (client) => {
    if (!(await isTenantMember(client, organizationId, userId))) {
      throw forbidden(
        "USER_NOT_IN_TENANT",
        "The calling user is not a member of this organization.",
      );
    }
    if (!(await isTenantMember(client, organizationId, assigneeId))) {
      throw badRequest(
        "ASSIGNEE_NOT_IN_TENANT",
        "The assignee is not a member of this organization.",
      );
    }
    const doc = await client.query<{
      id: string;
      document_type: string;
      effective_version: number | null;
    }>(
      `SELECT d.id, d.document_type,
              (SELECT v.version_number FROM document_versions v WHERE v.id = d.effective_version_id)
                AS effective_version
       FROM documents d WHERE d.id = $1 AND d.organization_id = $2`,
      [documentId, organizationId],
    );
    if (doc.rows.length === 0) {
      throw notFound("DOCUMENT_NOT_FOUND", "No document with this id in this organization.");
    }
    const current = doc.rows[0];
    if (current.document_type !== "SOP") {
      throw conflict(
        "DOCUMENT_NOT_SOP",
        "Training can only be assigned on an SOP. Publish the document as an SOP first.",
      );
    }
    if (current.effective_version === null) {
      throw conflict(
        "SOP_NOT_EFFECTIVE",
        "This SOP has no effective version yet. Approve and publish a version first.",
      );
    }
    const versionNumber =
      requestedVersion === undefined || requestedVersion === null
        ? current.effective_version
        : requestedVersion;
    if (versionNumber !== current.effective_version) {
      throw conflict(
        "TRAINING_VERSION_NOT_EFFECTIVE",
        `Only the effective version (v${current.effective_version}) can be assigned for training.`,
      );
    }
    const inserted = await client
      .query<{ id: string }>(
        `INSERT INTO training_assignments
         (organization_id, document_id, version_number, assignee_id, assigned_by, due_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
        [organizationId, documentId, versionNumber, assigneeId, userId, dueAt.toISOString()],
      )
      .catch((error: { code?: string }) => {
        if (error.code === "23505") {
          throw conflict(
            "ASSIGNMENT_ALREADY_OPEN",
            "This user already has an open assignment for this SOP version.",
          );
        }
        throw error;
      });
    const assignmentId = inserted.rows[0].id;
    await recordAuditEvent(client, {
      organizationId,
      actorId: userId,
      eventType: "TRAINING_ASSIGNED",
      targetType: "training_assignment",
      targetId: assignmentId,
      payload: {
        document_id: documentId,
        version_number: versionNumber,
        assignee_id: assigneeId,
        due_at: dueAt.toISOString(),
      },
      modelVersion: null,
      createdAt: new Date(),
    });
    const { rows } = await client.query<AssignmentRow>(
      `SELECT ${ASSIGNMENT_SELECT} WHERE a.id = $1 AND a.organization_id = $2`,
      [assignmentId, organizationId],
    );
    return rows[0];
  });
  res.status(201).json({ assignment: toAssignmentSummary(result, null) });
});

/** Manager review list: completed assignments (verified or awaiting verification) + counts. */
trainingRouter.get("/review", async (req: Request, res: Response) => {
  const { organizationId } = requireTenant(req);
  const { assignments, counts } = await withTenant(organizationId, async (client) => {
    const { rows } = await client.query<AssignmentRow>(
      `SELECT ${ASSIGNMENT_SELECT}
       WHERE a.organization_id = $1 AND a.status = 'COMPLETED'
       ORDER BY a.completed_at DESC NULLS LAST, a.due_at ASC LIMIT 100`,
      [organizationId],
    );
    const countRows = await client.query<{ status: string; count: string }>(
      `SELECT status, count(*) AS count FROM training_assignments
       WHERE organization_id = $1 GROUP BY status`,
      [organizationId],
    );
    const counts: Record<string, number> = {
      assigned: 0,
      in_progress: 0,
      completed: 0,
      verified: 0,
      overdue: 0,
      exempted: 0,
    };
    for (const row of countRows.rows) {
      if (row.status === "ASSIGNED") counts.assigned = Number(row.count);
      if (row.status === "IN_PROGRESS") counts.in_progress = Number(row.count);
      if (row.status === "COMPLETED") counts.completed = Number(row.count);
      if (row.status === "EXEMPTED") counts.exempted = Number(row.count);
    }
    const verified = await client.query<{ count: string }>(
      `SELECT count(*) AS count FROM training_assignments
       WHERE organization_id = $1 AND status = 'COMPLETED' AND verified_by IS NOT NULL`,
      [organizationId],
    );
    counts.verified = Number(verified.rows[0]?.count ?? 0);
    const overdue = await client.query<{ count: string }>(
      `SELECT count(*) AS count FROM training_assignments
       WHERE organization_id = $1 AND status IN ('ASSIGNED', 'IN_PROGRESS') AND due_at < now()`,
      [organizationId],
    );
    counts.overdue = Number(overdue.rows[0]?.count ?? 0);
    const withCompletions = [];
    for (const row of rows) {
      withCompletions.push({
        assignment: row,
        completion: await loadCompletion(client, row.id),
      });
    }
    return { assignments: withCompletions, counts };
  });
  res.status(200).json({
    assignments: assignments.map(({ assignment, completion }) =>
      toAssignmentSummary(assignment, completion),
    ),
    counts,
  });
});

/**
 * Dated CSV export of the full SOP/training audit trail for this tenant:
 * every step from SOP upload through publish, assignment, completion, and
 * verification, in hash-chain order. Optional ?document_id= narrows the
 * export to one SOP (document events for that SOP plus training events
 * that reference it).
 */
trainingRouter.get("/audit-trail/export", async (req: Request, res: Response) => {
  const { organizationId } = requireTenant(req);
  const documentId =
    typeof req.query.document_id === "string" && req.query.document_id !== ""
      ? req.query.document_id
      : null;
  if (documentId !== null && !isUuid(documentId)) {
    throw badRequest("INVALID_ID", "document_id must be a UUID.");
  }
  const events = await withTenant(organizationId, async (client) => {
    if (documentId !== null) {
      const doc = await client.query<{ id: string }>(
        "SELECT id FROM documents WHERE id = $1 AND organization_id = $2 AND document_type = 'SOP'",
        [documentId, organizationId],
      );
      if (doc.rows.length === 0) {
        throw notFound("DOCUMENT_NOT_FOUND", "No SOP with this id in this organization.");
      }
    }
    const values: unknown[] = [organizationId];
    const conditions = ["e.organization_id = $1", `e.event_type = ANY ($2)`];
    values.push([...TRAIL_EVENT_TYPES]);
    if (documentId !== null) {
      values.push(documentId);
      conditions.push(
        `(e.target_id = $${values.length} OR (e.target_type = 'training_assignment' AND (e.payload->>'document_id') = $${values.length}::text))`,
      );
    } else {
      conditions.push(
        `(e.target_type = 'training_assignment' OR e.target_id IN
           (SELECT id FROM documents WHERE organization_id = $1 AND document_type = 'SOP'))`,
      );
    }
    values.push(1000);
    const { rows } = await client.query<{
      seq: string;
      created_at: string;
      event_type: string;
      actor_id: string | null;
      actor_name: string | null;
      target_type: string | null;
      target_id: string | null;
      payload: Record<string, unknown>;
      event_hash: string;
    }>(
      `SELECT e.seq, e.created_at, e.event_type, e.actor_id,
              u.display_name AS actor_name, e.target_type, e.target_id,
              e.payload, e.event_hash
       FROM audit_events e
       LEFT JOIN users u ON u.id = e.actor_id
       WHERE ${conditions.join(" AND ")}
       ORDER BY e.seq ASC LIMIT $${values.length}`,
      values,
    );
    return rows;
  });
  const csvCell = (value: string): string => {
    const text = value ?? "";
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = [
    "seq,created_at,event_type,actor_id,actor_name,target_type,target_id,event_hash,payload",
    ...events.map((event) =>
      [
        event.seq,
        new Date(event.created_at).toISOString(),
        event.event_type,
        event.actor_id ?? "",
        event.actor_name ?? "",
        event.target_type ?? "",
        event.target_id ?? "",
        event.event_hash,
        JSON.stringify(event.payload),
      ]
        .map(csvCell)
        .join(","),
    ),
  ];
  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="qualios-sop-training-audit-trail-${stamp}.csv"`,
  );
  res.status(200).send(lines.join("\n") + "\n");
});

/** List assignments for this tenant, newest first. Filters: ?assignee_id= ?status= ?document_id= */
trainingRouter.get("/assignments", async (req: Request, res: Response) => {
  const { organizationId } = requireTenant(req);
  const assigneeId =
    typeof req.query.assignee_id === "string" && req.query.assignee_id !== ""
      ? req.query.assignee_id
      : null;
  const documentId =
    typeof req.query.document_id === "string" && req.query.document_id !== ""
      ? req.query.document_id
      : null;
  const status =
    typeof req.query.status === "string" && req.query.status !== "" ? req.query.status : null;
  if (assigneeId !== null && !isUuid(assigneeId)) {
    throw badRequest("INVALID_ID", "assignee_id must be a UUID.");
  }
  if (documentId !== null && !isUuid(documentId)) {
    throw badRequest("INVALID_ID", "document_id must be a UUID.");
  }
  if (status !== null && !(ASSIGNMENT_STATUSES as readonly string[]).includes(status)) {
    throw badRequest("INVALID_FIELD", `status must be one of: ${ASSIGNMENT_STATUSES.join(", ")}.`);
  }
  const limit = Math.min(Math.max(Number(req.query.limit ?? 50) || 50, 1), 100);
  const offset = Math.max(Number(req.query.offset ?? 0) || 0, 0);
  const { assignments } = await withTenant(organizationId, async (client) => {
    const conditions = ["a.organization_id = $1"];
    const values: unknown[] = [organizationId];
    if (assigneeId !== null) {
      values.push(assigneeId);
      conditions.push(`a.assignee_id = $${values.length}`);
    }
    if (documentId !== null) {
      values.push(documentId);
      conditions.push(`a.document_id = $${values.length}`);
    }
    if (status !== null) {
      values.push(status);
      conditions.push(`a.status = $${values.length}`);
    }
    values.push(limit, offset);
    const { rows } = await client.query<AssignmentRow>(
      `SELECT ${ASSIGNMENT_SELECT} WHERE ${conditions.join(" AND ")}
       ORDER BY a.created_at DESC LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    );
    const withCompletions = [];
    for (const row of rows) {
      withCompletions.push({
        assignment: row,
        completion: await loadCompletion(client, row.id),
      });
    }
    return { assignments: withCompletions };
  });
  res.status(200).json({
    assignments: assignments.map(({ assignment, completion }) =>
      toAssignmentSummary(assignment, completion),
    ),
    limit,
    offset,
  });
});

/** One assignment with its completion record, if any. */
trainingRouter.get("/assignments/:id", async (req: Request, res: Response) => {
  const { organizationId } = requireTenant(req);
  const assignmentId = paramString(req.params.id, "assignment id");
  if (!isUuid(assignmentId)) {
    throw badRequest("INVALID_ID", "Assignment id must be a UUID.");
  }
  const found = await withTenant(organizationId, async (client) => {
    const { rows } = await client.query<AssignmentRow>(
      `SELECT ${ASSIGNMENT_SELECT} WHERE a.id = $1 AND a.organization_id = $2`,
      [assignmentId, organizationId],
    );
    if (rows.length === 0) return null;
    return { assignment: rows[0], completion: await loadCompletion(client, rows[0].id) };
  });
  if (found === null) {
    throw notFound("ASSIGNMENT_NOT_FOUND", "No assignment with this id in this organization.");
  }
  res.status(200).json({ assignment: toAssignmentSummary(found.assignment, found.completion) });
});

/**
 * Complete an assignment: only the assignee can complete their own
 * training. An explicit acknowledgement is required; an assessment score
 * (0–100) is optional. Completion is recorded against the assigned SOP
 * version, with the timestamp and the identity of the completer.
 */
trainingRouter.post("/assignments/:id/complete", async (req: Request, res: Response) => {
  const { organizationId, userId } = requireTenant(req);
  const assignmentId = paramString(req.params.id, "assignment id");
  if (!isUuid(assignmentId)) {
    throw badRequest("INVALID_ID", "Assignment id must be a UUID.");
  }
  if (req.body?.acknowledgement !== true) {
    throw badRequest(
      "ACKNOWLEDGEMENT_REQUIRED",
      "Completion requires an explicit acknowledgement (acknowledgement: true).",
    );
  }
  const assessmentScore = parseOptionalScore(req.body?.assessment_score);

  const result = await withTenant(organizationId, async (client) => {
    if (!(await isTenantMember(client, organizationId, userId))) {
      throw forbidden(
        "USER_NOT_IN_TENANT",
        "The calling user is not a member of this organization.",
      );
    }
    const { rows } = await client.query<{
      id: string;
      document_id: string;
      version_number: number;
      assignee_id: string;
      status: string;
    }>(
      `SELECT id, document_id, version_number, assignee_id, status
       FROM training_assignments WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
      [assignmentId, organizationId],
    );
    if (rows.length === 0) {
      throw notFound("ASSIGNMENT_NOT_FOUND", "No assignment with this id in this organization.");
    }
    const assignment = rows[0];
    if (assignment.assignee_id !== userId) {
      throw forbidden(
        "NOT_ASSIGNEE",
        "Only the assigned employee can complete their own training.",
      );
    }
    if (assignment.status !== "ASSIGNED" && assignment.status !== "IN_PROGRESS") {
      throw conflict(
        "ASSIGNMENT_NOT_COMPLETABLE",
        `Assignment is ${assignment.status} and cannot be completed.`,
      );
    }
    const completedAt = new Date();
    await client.query(
      `INSERT INTO training_completions
         (assignment_id, organization_id, user_id, document_id, version_number,
          acknowledgement, assessment_score, completed_at)
       VALUES ($1, $2, $3, $4, $5, true, $6, $7)`,
      [
        assignmentId,
        organizationId,
        userId,
        assignment.document_id,
        assignment.version_number,
        assessmentScore,
        completedAt.toISOString(),
      ],
    );
    await client.query(
      `UPDATE training_assignments SET status = 'COMPLETED', completed_at = $2
       WHERE id = $1 AND organization_id = $3`,
      [assignmentId, completedAt.toISOString(), organizationId],
    );
    await recordAuditEvent(client, {
      organizationId,
      actorId: userId,
      eventType: "TRAINING_COMPLETED",
      targetType: "training_assignment",
      targetId: assignmentId,
      payload: {
        document_id: assignment.document_id,
        version_number: assignment.version_number,
        acknowledgement: true,
        assessment_score: assessmentScore,
      },
      modelVersion: null,
      createdAt: new Date(),
    });
    const updated = await client.query<AssignmentRow>(
      `SELECT ${ASSIGNMENT_SELECT} WHERE a.id = $1 AND a.organization_id = $2`,
      [assignmentId, organizationId],
    );
    return {
      assignment: updated.rows[0],
      completion: await loadCompletion(client, assignmentId),
    };
  });
  res.status(200).json({ assignment: toAssignmentSummary(result.assignment, result.completion) });
});

/**
 * Verify a completion: a manager records that they reviewed the employee's
 * completion. The verifier must differ from the completer (segregation of
 * duties, T-02) — so a user who assigned training to themselves cannot
 * verify their own completion. Recorded as a TRAINING_VERIFY approval row
 * plus a hash-chained audit event.
 */
trainingRouter.post("/assignments/:id/verify", async (req: Request, res: Response) => {
  const { organizationId, userId } = requireTenant(req);
  const assignmentId = paramString(req.params.id, "assignment id");
  if (!isUuid(assignmentId)) {
    throw badRequest("INVALID_ID", "Assignment id must be a UUID.");
  }
  const note = typeof req.body?.note === "string" ? req.body.note : null;

  const result = await withTenant(organizationId, async (client) => {
    if (!(await isTenantMember(client, organizationId, userId))) {
      throw forbidden(
        "USER_NOT_IN_TENANT",
        "The calling user is not a member of this organization.",
      );
    }
    const { rows } = await client.query<{
      id: string;
      document_id: string;
      version_number: number;
      assignee_id: string;
      status: string;
      verified_by: string | null;
    }>(
      `SELECT id, document_id, version_number, assignee_id, status, verified_by
       FROM training_assignments WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
      [assignmentId, organizationId],
    );
    if (rows.length === 0) {
      throw notFound("ASSIGNMENT_NOT_FOUND", "No assignment with this id in this organization.");
    }
    const assignment = rows[0];
    if (assignment.status !== "COMPLETED") {
      throw conflict(
        "ASSIGNMENT_NOT_COMPLETED",
        `Assignment is ${assignment.status}; only a completed assignment can be verified.`,
      );
    }
    if (assignment.verified_by !== null) {
      throw conflict("ALREADY_VERIFIED", "This completion has already been verified.");
    }
    if (assignment.assignee_id === userId) {
      throw forbidden(
        "SEGREGATION_OF_DUTIES",
        "The employee who completed the training cannot verify their own completion.",
      );
    }
    const approval = await client.query<{ id: string }>(
      `INSERT INTO approvals
         (organization_id, action_type, target_id, target_type, approver_id, decision, note)
       VALUES ($1, 'TRAINING_VERIFY', $2, 'training_assignment', $3, 'APPROVED', $4)
       RETURNING id`,
      [organizationId, assignmentId, userId, note],
    );
    const verifiedAt = new Date();
    await client.query(
      `UPDATE training_assignments SET verified_by = $2, verified_at = $3
       WHERE id = $1 AND organization_id = $4`,
      [assignmentId, userId, verifiedAt.toISOString(), organizationId],
    );
    await recordAuditEvent(client, {
      organizationId,
      actorId: userId,
      eventType: "TRAINING_VERIFIED",
      targetType: "training_assignment",
      targetId: assignmentId,
      payload: {
        document_id: assignment.document_id,
        version_number: assignment.version_number,
        approval_id: approval.rows[0].id,
        note,
      },
      modelVersion: null,
      createdAt: new Date(),
    });
    const updated = await client.query<AssignmentRow>(
      `SELECT ${ASSIGNMENT_SELECT} WHERE a.id = $1 AND a.organization_id = $2`,
      [assignmentId, organizationId],
    );
    return {
      assignment: updated.rows[0],
      completion: await loadCompletion(client, assignmentId),
    };
  });
  res.status(200).json({ assignment: toAssignmentSummary(result.assignment, result.completion) });
});
