/**
 * STUB — @qualios/ai (Days 7–12 scaffold).
 *
 * Provider abstraction (ADR-007): all AI access goes through this gateway so
 * the provider can be swapped without rewriting product code. No provider is
 * selected yet and no model is called. The cited-AI prototype lands in
 * Days 26–28 of the sprint.
 *
 * Guardrails (ADR-012): AI output is advisory. No code path here (or anywhere
 * in the wedge) posts a correction, files anything, releases a batch, or signs
 * on a person's behalf. Every grounded answer must carry citations or state
 * that evidence is insufficient.
 */

export interface Citation {
  recordType: string;
  recordId: string;
  version?: string;
  retrievedAt: string;
}

export interface GroundedAnswer {
  answer: string;
  citations: Citation[];
  evidenceSufficient: boolean;
  modelVersion: string;
}

export interface AiGateway {
  /** Answer a question using only the supplied, tenant-authorized context. */
  ask(question: string, context: string): Promise<GroundedAnswer>;
}

/** STUB: throws. Replace with a real provider behind the gateway (ADR-007). */
export function createGateway(): AiGateway {
  return {
    ask: () =>
      Promise.reject(new Error("@qualios/ai is a stub: no AI provider selected yet (ADR-007).")),
  };
}
