/**
 * @qualios/domain — the integrated domain model (B-110 / directive §3–§4).
 *
 * Industry-neutral types and API contracts for the one connected platform:
 * traceability, quality, financial ledgers, tax, and the personal AI
 * assistant. Industry specifics are pack configuration (pack ids and
 * pack-registered keys), never core entities — see
 * docs/architecture/DOMAIN_MODEL.md for the ER model, event flows, and
 * ledger rules.
 *
 * This package holds contracts and pure validation only. It performs no
 * I/O: posting a journal entry and creating a traceability link live in
 * apps/api/src/lib/ledger.ts and apps/api/src/lib/traceability.ts, where
 * the database enforces the same rules (migration 0012 triggers).
 *
 * Money is integer cents everywhere. Quantities are integer minor units
 * (milligrams for mass, whole units for counted stock), matching the
 * inventory ledger conventions.
 */

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

/** A tenant-scoped reference to a record in another module. */
export interface CrossModuleRef {
  /** Module that owns the record: 'traceability' | 'quality' | 'finance' | 'tax' | 'inventory' | 'documents' | 'training'. */
  sourceModule: string;
  /** Record kind within the module, e.g. 'journal_entry', 'lot', 'sop'. */
  sourceType: string;
  /** Id of the source record. */
  sourceId: string;
}

/** The universal lifecycle stages a lot passes through (directive §3). */
export type TraceabilityStage =
  | "SUPPLIER"
  | "PURCHASING"
  | "RECEIVING"
  | "RAW_MATERIAL"
  | "INVENTORY"
  | "PRODUCTION"
  | "INSPECTION"
  | "LAB"
  | "FINISHED_GOODS"
  | "PACKAGING"
  | "WAREHOUSING"
  | "SHIPMENT"
  | "CUSTOMER"
  | "SALES_ACCOUNTING_TAX"
  | "RECALL";

// ---------------------------------------------------------------------------
// Traceability (migration 0012, traceability_links)
// ---------------------------------------------------------------------------

/**
 * How a child lot relates to a parent lot. Direction is always
 * parent -> child: the parent lot was consumed, split, or transformed to
 * produce the child. Backward trace follows child -> parent; forward
 * trace follows parent -> child.
 */
export type TraceLinkType =
  | "CONSUMED_IN"
  | "PRODUCED_FROM"
  | "PACKAGED_FROM"
  | "SPLIT_FROM"
  | "MERGED_INTO"
  | "SHIPPED_AS"
  | "RECEIVED_AS";

export interface TraceabilityLink {
  id: string;
  organizationId: string;
  parentLotId: string;
  childLotId: string;
  linkType: TraceLinkType;
  batchId: string | null;
  quantityMg: number | null;
  quantityUnits: number | null;
  note: string | null;
  createdBy: string;
  createdAt: string;
}

export interface CreateTraceLinkInput {
  parentLotId: string;
  childLotId: string;
  linkType: TraceLinkType;
  batchId?: string | null;
  quantityMg?: number | null;
  quantityUnits?: number | null;
  note?: string | null;
}

export interface TraceNode {
  lotId: string;
  lotNumber: string;
  depth: number;
  viaLinkType: TraceLinkType | null;
}

export interface TraceResult {
  lotId: string;
  direction: "backward" | "forward";
  nodes: TraceNode[];
}

export interface ChainValidationIssue {
  code: "SELF_LINK" | "CYCLE" | "DUPLICATE_LINK";
  message: string;
  parentLotId: string;
  childLotId: string;
}

export type ChainValidationResult =
  { valid: true; issues: [] } | { valid: false; issues: ChainValidationIssue[] };

/**
 * Validate a set of traceability links as a genealogy graph: no lot may
 * link to itself, no link may repeat, and the graph must be acyclic
 * (a lot can never be its own ancestor). Pure function — the API also
 * enforces this against the stored links before inserting.
 */
export function validateTraceLinks(
  links: { parentLotId: string; childLotId: string; linkType: TraceLinkType }[],
): ChainValidationResult {
  const issues: ChainValidationIssue[] = [];
  const seen = new Set<string>();
  for (const link of links) {
    if (link.parentLotId === link.childLotId) {
      issues.push({
        childLotId: link.childLotId,
        code: "SELF_LINK",
        message: `Lot ${link.parentLotId} cannot link to itself.`,
        parentLotId: link.parentLotId,
      });
    }
    const key = `${link.parentLotId}|${link.childLotId}|${link.linkType}`;
    if (seen.has(key)) {
      issues.push({
        childLotId: link.childLotId,
        code: "DUPLICATE_LINK",
        message: `Duplicate ${link.linkType} link from ${link.parentLotId} to ${link.childLotId}.`,
        parentLotId: link.parentLotId,
      });
    }
    seen.add(key);
  }
  // Cycle detection (iterative DFS over parent -> child edges).
  const children = new Map<string, string[]>();
  for (const link of links) {
    const list = children.get(link.parentLotId) ?? [];
    list.push(link.childLotId);
    children.set(link.parentLotId, list);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const cyclic: [string, string][] = [];
  const visit = (node: string, stack: string[]): void => {
    if (visited.has(node)) return;
    if (visiting.has(node)) {
      const at = stack.indexOf(node);
      const cycle = [...stack.slice(at), node];
      for (let i = 0; i < cycle.length - 1; i += 1) {
        cyclic.push([cycle[i], cycle[i + 1]]);
      }
      return;
    }
    visiting.add(node);
    stack.push(node);
    for (const child of children.get(node) ?? []) visit(child, stack);
    stack.pop();
    visiting.delete(node);
    visited.add(node);
  };
  for (const node of children.keys()) visit(node, []);
  for (const [parentLotId, childLotId] of cyclic) {
    issues.push({
      childLotId,
      code: "CYCLE",
      message: `Traceability cycle: lot ${parentLotId} is both an ancestor and a descendant of lot ${childLotId}.`,
      parentLotId,
    });
  }
  return issues.length === 0 ? { valid: true, issues: [] } : { valid: false, issues };
}

// ---------------------------------------------------------------------------
// Financial ledger — double-entry general ledger (migration 0012)
// ---------------------------------------------------------------------------

export type AccountType = "ASSET" | "LIABILITY" | "EQUITY" | "REVENUE" | "EXPENSE";
export type JournalEntryStatus = "DRAFT" | "POSTED" | "VOID";

export interface GlAccount {
  id: string;
  organizationId: string;
  code: string;
  name: string;
  accountType: AccountType;
  parentAccountId: string | null;
  status: "ACTIVE" | "INACTIVE";
}

export interface JournalLineInput {
  accountId: string;
  /** Integer cents. Exactly one of debit/credit is positive per line. */
  debitCents: number;
  creditCents: number;
  lotId?: string | null;
  productId?: string | null;
  memo?: string | null;
}

export interface JournalEntryInput {
  entryDate: string;
  sourceModule: string;
  sourceType: string;
  sourceId: string;
  memo?: string | null;
  lines: JournalLineInput[];
}

export interface JournalEntry extends CrossModuleRef {
  id: string;
  organizationId: string;
  entryDate: string;
  idempotencyKey: string;
  memo: string | null;
  status: JournalEntryStatus;
  postedAt: string | null;
  createdBy: string;
  createdAt: string;
  lines: (JournalLineInput & { id: string })[];
}

export interface LedgerValidationIssue {
  code: "UNBALANCED" | "NO_LINES" | "LINE_BOTH_SIDES" | "LINE_NEITHER_SIDE" | "NEGATIVE_AMOUNT";
  message: string;
}

export type LedgerValidationResult =
  | { valid: true; totalDebitCents: number; totalCreditCents: number; issues: [] }
  | {
      valid: false;
      totalDebitCents: number;
      totalCreditCents: number;
      issues: LedgerValidationIssue[];
    };

/**
 * Validate a journal entry before posting: at least two lines, every
 * line debits or credits (never both, never neither, never negative),
 * and total debits equal total credits. The database trigger in
 * migration 0012 enforces the same balance rule when an entry is
 * posted, so a bug in a caller cannot post an unbalanced entry.
 */
export function validateJournalEntry(entry: JournalEntryInput): LedgerValidationResult {
  const issues: LedgerValidationIssue[] = [];
  let totalDebitCents = 0;
  let totalCreditCents = 0;
  if (entry.lines.length === 0) {
    issues.push({ code: "NO_LINES", message: "A journal entry needs at least one line." });
  }
  for (const line of entry.lines) {
    if (line.debitCents < 0 || line.creditCents < 0) {
      issues.push({
        code: "NEGATIVE_AMOUNT",
        message: `Line for account ${line.accountId} has a negative amount; use the other side instead.`,
      });
    }
    if (line.debitCents > 0 && line.creditCents > 0) {
      issues.push({
        code: "LINE_BOTH_SIDES",
        message: `Line for account ${line.accountId} debits and credits; one line carries one side only.`,
      });
    }
    if (line.debitCents === 0 && line.creditCents === 0) {
      issues.push({
        code: "LINE_NEITHER_SIDE",
        message: `Line for account ${line.accountId} is zero on both sides.`,
      });
    }
    totalDebitCents += line.debitCents;
    totalCreditCents += line.creditCents;
  }
  if (entry.lines.length > 0 && totalDebitCents !== totalCreditCents) {
    issues.push({
      code: "UNBALANCED",
      message: `Unbalanced entry: debits ${totalDebitCents} cents, credits ${totalCreditCents} cents.`,
    });
  }
  if (issues.length > 0) {
    return { issues, totalCreditCents, totalDebitCents, valid: false };
  }
  return { issues: [], totalCreditCents, totalDebitCents, valid: true };
}

/**
 * Idempotency key for a posting: one source record posts at most one
 * journal entry per module. Replaying the same source returns the
 * original entry instead of double-posting. Stored as
 * journal_entries.idempotency_key (unique per organization) and mirrored
 * by the unique (organization, source_module, source_type, source_id)
 * index, so no duplicate entry can exist across modules.
 */
export function buildIdempotencyKey(
  sourceModule: string,
  sourceType: string,
  sourceId: string,
): string {
  return `${sourceModule}:${sourceType}:${sourceId}`;
}

/** Inventory valuation hook: a valuation may point at the entry that booked it. */
export interface InventoryValuation {
  id: string;
  organizationId: string;
  lotId: string;
  valuationMethod: "FIFO" | "AVERAGE" | "STANDARD" | "ACTUAL";
  unitCostCents: number;
  totalCents: number;
  asOf: string;
  journalEntryId: string | null;
}

// ---------------------------------------------------------------------------
// Tax (migration 0012, tax_rules / tax_calculations)
// ---------------------------------------------------------------------------

export type TaxType = "GST" | "HST" | "VAT" | "SALES_TAX" | "EXCISE" | "OTHER";
export type TaxRuleStatus = "DRAFT" | "ACTIVE" | "SUPERSEDED";

export interface TaxRule {
  id: string;
  jurisdiction: string;
  taxType: TaxType;
  /** Pack-registered basis key (e.g. PER_UNIT, PER_KG, PER_MG_THC). */
  basis: string;
  rateNumeric: number;
  rateUnit: string | null;
  flatAmountCents: number | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  packId: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  status: TaxRuleStatus;
}

export interface TaxCalculation {
  id: string;
  organizationId: string;
  taxRuleId: string;
  subjectType: string;
  subjectId: string | null;
  jurisdiction: string;
  basisSnapshot: string;
  taxableAmountCents: number;
  taxAmountCents: number;
  status: "DRAFT" | "FINAL";
  /** Entry that booked this tax, when it has been posted to the ledger. */
  journalEntryId: string | null;
}

// ---------------------------------------------------------------------------
// Quality — contract shapes over the implemented SOP/training flow
// ---------------------------------------------------------------------------

/** SOP publish lifecycle (implemented: documents + training routes). */
export interface SopContract {
  documentId: string;
  versionNumber: number;
  status: string;
  effectiveVersion: number | null;
  effectiveFrom: string | null;
}

export interface TrainingContract {
  assignmentId: string;
  documentId: string;
  versionNumber: number;
  assigneeId: string;
  status: string;
  completedAt: string | null;
  verifiedBy: string | null;
}

// ---------------------------------------------------------------------------
// API contracts (versioned paths; see docs/architecture/DOMAIN_MODEL.md §4)
// ---------------------------------------------------------------------------

export const API_CONTRACT_VERSION = "v1";

/** Traceability API contract. Implemented now: POST /links, GET backward/forward. */
export interface TraceabilityApi {
  createLink: {
    method: "POST";
    path: "/api/v1/traceability/links";
    request: CreateTraceLinkInput;
    response: { link: TraceabilityLink };
    errors: "VALIDATION_ERROR" | "LOT_NOT_FOUND" | "TRACE_CYCLE" | "PACK_NOT_ENABLED";
  };
  traceBackward: {
    method: "GET";
    path: "/api/v1/traceability/lots/:lotId/backward";
    response: TraceResult;
  };
  traceForward: {
    method: "GET";
    path: "/api/v1/traceability/lots/:lotId/forward";
    response: TraceResult;
  };
}

/** Finance ledger API contract. Posting helper implemented in lib/ledger.ts; routes land with P1. */
export interface FinanceApi {
  postJournalEntry: {
    method: "POST";
    path: "/api/v1/finance/journal-entries";
    request: JournalEntryInput;
    response: { entry: JournalEntry; duplicate: boolean };
    errors: "VALIDATION_ERROR" | "UNBALANCED_ENTRY" | "ACCOUNT_NOT_FOUND";
  };
  listAccounts: {
    method: "GET";
    path: "/api/v1/finance/accounts";
    response: { accounts: GlAccount[] };
  };
  listValuations: {
    method: "GET";
    path: "/api/v1/finance/inventory-valuations";
    response: { valuations: InventoryValuation[] };
  };
}

/** Tax API contract. Rules are configuration; calculation stays a stub until expert review (ADR D-07). */
export interface TaxApi {
  listRules: {
    method: "GET";
    path: "/api/v1/tax/rules";
    response: { rules: TaxRule[] };
  };
  calculate: {
    method: "POST";
    path: "/api/v1/tax/calculate";
    request: { ruleId: string; subjectType: string; subjectId: string | null };
    response: { calculation: TaxCalculation };
    errors: "NOT_IMPLEMENTED";
  };
}

/** Assistant API contract. Read-only first; actions are proposals until approved (directive §5). */
export interface AssistantApi {
  ask: {
    method: "POST";
    path: "/api/v1/assistant/ask";
    request: AssistantQueryRequest;
    response: AssistantQueryResponse;
    errors: "NOT_IMPLEMENTED";
  };
}

export interface AssistantCitation {
  /** What was cited: 'document' | 'record' | 'rule'. */
  kind: string;
  /** Document id + version, or record id. */
  reference: string;
  /** Exact quoted text or value. */
  excerpt: string;
}

export interface AssistantQueryRequest {
  /** The user's question, in their words. */
  question: string;
  /** Optional scope hint: 'sop' | 'lot' | 'finance' | 'tax' | 'training'. */
  scope?: string;
}

export interface AssistantQueryResponse {
  answer: string;
  citations: AssistantCitation[];
  /** 0–1; below threshold the assistant must say it does not know. */
  confidence: number;
  /** True when no authorized source covered the question. */
  unanswered: boolean;
}

/**
 * A proposed assistant action. Proposals never execute on their own:
 * financial transactions, regulated releases, signatures, and filings
 * require an explicit human approval (a separate approval record) before
 * the action runs. The action log records proposal, approval, and outcome.
 */
export interface AssistantActionProposal {
  id: string;
  organizationId: string;
  requestedBy: string;
  /** Tool the assistant wants to run, e.g. 'finance.post_entry'. */
  tool: string;
  arguments: Record<string, unknown>;
  status: "PROPOSED" | "APPROVED" | "REJECTED" | "EXECUTED" | "FAILED";
  approvedBy: string | null;
  result: Record<string, unknown> | null;
}
