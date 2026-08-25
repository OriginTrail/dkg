// P5 subscription rail — Appendix A objects, verbatim shapes.
// The tab rail is retired; nothing here refunds, routes, or renews.

export type OfferingUnit = "tokens" | "query-units";

/** A seller's per-period price commitment, published in the offer KA.
 *  Edits queue for the next cycle boundary; subscribers keep their frozen
 *  price until their period expires. */
export interface AskCommitment {
  seller: string;                    // provider node identity (address)
  offeringId: string;                // model or query service id
  unit: OfferingUnit;
  askMicroPerUnit: number;           // µTRAC per token / per query unit
  effectiveFromCycle: number;        // cycle index this ask takes effect
}

export type FundingSource = "trac_payment" | "conviction_allowance" | "fiat";
// conviction_allowance and fiat are reserved seams — NOT built in P5
// (PCA funding is RFC-gated; fiat exists only inside the CP3 spike).

export interface PlanAllocation {
  offeringId: string;
  seller: string;                    // ONE provider, chosen at plan time
  unit: OfferingUnit;
  allocationMicroTrac: number;       // the slice of the payment for this offering
  frozenAskMicroPerUnit: number;     // the committed ask at purchase — frozen
}

/** One buyer-side plan for one period. Nothing renews by itself: a new
 *  period begins only with a new consented payment. */
export interface Plan {
  planId: string;
  buyer: string;                     // buyer principal (this node's wallet)
  periodId: string;                  // e.g. p-2026-09-06T14:00Z
  periodMs: number;                  // config: minutes…monthly
  startedAt: string;                 // ISO — set at consented payment
  expiresAt: string;                 // startedAt + periodMs
  cycle: number;                     // monotonic cycle index per buyer
  fundingSource: FundingSource;
  allocations: PlanAllocation[];
  paymentTxBySeller: Record<string, string>;  // seller → on-chain tx (I4)
}

export type AllowanceState = "active" | "exhausted" | "expired";

/** Always per (offering, seller); never shared, never value-denominated.
 *  Plan totals are display aggregates, never limits (I5). */
export interface Allowance {
  planId: string;
  offeringId: string;
  seller: string;
  unit: OfferingUnit;
  guaranteedUnits: number;           // = floor(allocation ÷ frozen ask)
  consumedUnits: number;
  state: AllowanceState;
}

export type JournalKind = "paid" | "consumed" | "expired" | "toppedUp" | "disputed";

export interface JournalEntry {
  kind: JournalKind;
  at: string;
  planId: string;
  // I5: every `consumed` entry references exactly ONE (offering, seller)
  // allowance — cross-offering decrements cannot be expressed.
  offeringId?: string;
  seller?: string;
  units?: number;                    // native units for consumed/toppedUp
  microTrac?: number;                // for paid / expired (value recognized)
  keyId?: string;                    // I2: per-key attribution
  callId?: string;                   // links to the hash-chained call log
  phase?: "admission" | "delivery";  // query decrement split
  detail?: string;
}

/** Hash-chained per-call log entry — the dispute engine's raw material and
 *  the checkpoint chain's substrate. Both seats keep one independently. */
export interface CallLogEntry {
  callId: string;
  at: string;
  pair: string;                      // buyer↔seller pairId
  offeringId: string;
  unit: OfferingUnit;
  units: number;                     // this seat's count for this call
  phase: "admission" | "delivery" | "void";  // void = failed/undelivered: decrements nothing
  requestDigest: string;             // sha256 over canonical request bytes
  responseDigest?: string;           // present on delivery
  keyId?: string;
  prevDigest: string;                // chain: sha256(prev ‖ this-without-prev)
  digest: string;
}

/** Running totals exchanged over SWM gossip in the pair CG — never VM (I6). */
export interface Checkpoint {
  pair: string;
  periodId: string;
  seq: number;
  at: string;
  totals: Record<string, number>;    // offeringId → running units (this seat)
  callLogHead: string;               // this seat's chain head digest
  prevDigest: string;                // checkpoint chain
  digest: string;
  signature?: string;                // emitting seat's signature
  counterSignature?: string;         // present once the peer verified
}

export type StatementResolution = "agreed" | "disputed" | "resolved";

export interface StatementItem {
  offeringId: string;
  unit: OfferingUnit;
  buyerCount: number;
  sellerCount: number;
}

/** The once-per-period reconciliation — the ONLY Verifiable Memory publish
 *  in the clean path (I6), into the pair CG. */
export interface Statement {
  pair: string;
  periodId: string;
  items: StatementItem[];
  checkpointChainRoot: string;
  resolution: StatementResolution;
  resolutionDetail?: string;         // dispute engine's recorded outcome
  buyerSignature?: string;
  sellerSignature?: string;
  publishedKaUal?: string;
}

export interface PairCg {
  pair: string;                      // `${buyerAddr}~${sellerAddr}` lowercased
  contextGraphId: string;            // curated, exactly the two members
  createdAt: string;
}
