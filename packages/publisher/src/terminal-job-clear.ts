// #1837 — shared contract for the atomic by-exact-jobId TERMINAL clear OUTCOME, owned by
// NEITHER queue (lift nor promote) so a generic admin-clear result is not coupled to one
// implementation family's type module. (The job-id grammar guard lives in `./job-id.ts`.)

/**
 * Bounded outcome of a terminal clear, shared by the lift publisher and the SWM promote
 * queue. The control method owns every reason INCLUDING `malformed` (a corrupt persisted
 * payload — or an unsafe jobId — is only detectable inside the method, never at the HTTP
 * route). Never throws and never mutates on a reject. `already_absent` is a SUCCESS
 * (idempotent repeat), distinct from a rejection.
 */
export type TerminalJobClearOutcome =
  | { readonly outcome: 'cleared' }
  | { readonly outcome: 'already_absent' }
  | { readonly outcome: 'rejected'; readonly reason: 'nonterminal' | 'unknown' | 'malformed' };

/**
 * Authenticated authority for the destructive, exact-job pending-transaction override.
 *
 * The variants are deliberately mutually exclusive: an agent accepts risk only for its own
 * admission lane, while the node operator owns the queue and needs no agent identity.
 */
export type PendingTransactionClearOverride =
  | { readonly kind: 'agent'; readonly agentAddress: string }
  | { readonly kind: 'nodeOperator' };

export interface TargetedLiftJobClearOptions {
  readonly pendingTransactionOverride?: PendingTransactionClearOverride;
}
