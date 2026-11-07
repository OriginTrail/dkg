// Shapes the marketplace section renders. They mirror what a buyer or seller
// node reports; the fixture data module (data.ts) fills them today, and a later
// step swaps it for the node API without touching the views.

// ── plan, meters, activity ──────────────────────────────────────────────────

export type Unit = 'tokens' | 'query-units';

/** One meter: what the plan guarantees for one offering from one provider. */
export interface Allowance {
  planId: string;
  offeringId: string;
  seller: string;
  unit: Unit;
  guaranteedUnits: number;
  consumedUnits: number;
  state: 'active' | 'exhausted' | 'expired';
  /** Provider-side enrollment of this line: a blocked line cannot be served. */
  enrollment?: 'enrolled' | 'pending' | 'blocked';
  enrollmentError?: string | null;
}

export interface Plan {
  planId: string;
  buyer: string;
  periodId: string;
  periodMs: number;
  startedAt: string;
  expiresAt: string;
  cycle: number;
  allocations: Array<{
    offeringId: string;
    seller: string;
    unit: string;
    allocationMicroTrac: number;
    frozenAskMicroPerUnit: number;
  }>;
}

export interface Activity {
  kind: string;
  at: string;
  planId: string;
  offeringId?: string;
  seller?: string;
  units?: number;
  keyId?: string;
  phase?: 'admission' | 'delivery';
}

export interface Statement {
  pair: string;
  periodId: string;
  items: Array<{ offeringId: string; unit: string; buyerCount: number; sellerCount: number }>;
  resolution: 'agreed' | 'disputed' | 'resolved';
  resolutionDetail?: string;
}

export interface KeyScopes {
  label?: string;
  budgetMicroTrac: number;
  expiresAt: string | null;
  modelAllowlist: string[] | null;
  allowQuery: boolean;
  rps: number;
}

export interface AccessKey {
  keyId: string;
  scopes: KeyScopes;
  mintedAt: string;
  implicit?: boolean;
  revoked: boolean;
  spentMicroTrac: number;
}

export interface PendingSwitch { planId: string; offeringId: string; toSeller: string; requestedAt: string }

export interface PlanHistory {
  count: number;
  last: { planId: string; periodId: string; expiresAt: string; lines: PurchaseLine[] } | null;
}

export interface BuyerSeat { configured: boolean; buyer: string | null; rpc: boolean }

export interface PlanStatus {
  plan: Plan | null;
  meters: Allowance[];
  summaryPct: number | null;
  activity: Activity[];
  freshness: Array<{ pair: string; agree: boolean; checkedAgoMs: number | null }>;
  statements: Statement[];
  keys: AccessKey[];
  pendingSwitches?: PendingSwitch[];
  cycle?: number;
  openPurchase?: PurchaseIntent | null;
  planHistory?: PlanHistory;
  seat?: BuyerSeat;
}

// ── catalog ─────────────────────────────────────────────────────────────────

export interface Ask { askMicroPerUnit: number; unit: Unit; effectiveFromCycle: number }

export interface Offer {
  offeringId: string;
  modelId: string;
  provenanceClass: string;
  tokenizerBundleRef: string | null;
  weightsDigest: string | null;
  offeringUal?: string | null;
  ask: Ask | null;
  queuedAsk: { askMicroPerUnit: number } | null;
  available?: boolean;
  ctx?: number;
  unavailableReason?: string;
  /** The node's own verdict; when present it wins over any inference. */
  purchasable?: boolean;
  blockedReason?: string;
}

export interface ShelfRow {
  seller: string;
  apiBase?: string;
  ok: boolean;
  fetchedAt?: string;
  source?: 'live' | 'cache';
  error?: string;
  sellerClaimed?: string;
  identityMismatch?: boolean;
  notSelling?: boolean;
  staleSince?: string;
  revenueWallet: string | null;
  chainId: number | null;
  tracContract: string | null;
  confirmationDepth?: number;
  purchasable?: boolean;
  blockedReason?: string;
  /** The provider serves add-on lines for a running plan. */
  addOn?: boolean;
  offers: Offer[];
}

/** A reference TRAC/USD rate; a null rate hides USD. */
export interface Fx { tracUsd: number | null; source: string; asOf: number | null }

export interface Catalog {
  shelves: ShelfRow[];
  meters: Allowance[];
  plan: { periodId: string; expiresAt: string } | null;
  fx?: Fx;
}

// ── seller side ─────────────────────────────────────────────────────────────

export interface OperateStatus {
  sellerActive: boolean;
  cycle?: number;
  offerings: Array<{
    id: string;
    modelId: string;
    tokenizerBundleRef: string;
    offeringUal: string | null;
    ask: Ask | null;
    queuedAsk: { askMicroPerUnit: number; effectiveFromCycle?: number } | null;
  }>;
  subscribers: Array<{ buyer: string; periodId: string; expiresAt: string; offerings: string[]; paymentIdentity: string }>;
  revenueWallet: string | null;
  statements: Statement[];
  checkpointChains: Array<{ pair: string; length: number; freshness: { agree: boolean; checkedAgoMs: number | null } }>;
  keys: AccessKey[];
}

// ── purchases ───────────────────────────────────────────────────────────────

export type PurchaseKind = 'subscribe' | 'topup' | 'new-period' | 'addon';

export type PurchaseState =
  | 'draft' | 'terms_frozen' | 'binding_required' | 'binding_signed'
  | 'paying' | 'payment_confirming' | 'payment_confirmed' | 'plan_built'
  | 'enrolling' | 'active' | 'cancelled' | 'wallet_rejected'
  | 'payment_failed' | 'enrollment_blocked' | 'expired';

export type NextAction =
  | 'connect_wallet' | 'freeze_terms' | 'sign_binding' | 'pay' | 'wait_confirmations'
  | 'enroll' | 'activate' | 'done' | 'recover' | 'none';

export interface PurchaseLine { offeringId: string; seller: string; allocationMicroTrac: number }

export interface FrozenLine {
  offeringId: string;
  unit: string;
  askMicroPerUnit: number;
  effectiveFromCycle: number;
  allocationMicroTrac: number;
  guaranteedUnits: number;
}

export interface FrozenSeller {
  apiBase: string;
  revenueWallet: string;
  confirmationDepth: number;
  sellerCycle: number;
  lines: FrozenLine[];
  amountMicroTrac: number;
  amountWei: string;
  revenueWalletUnpinned?: boolean;
  revenueWalletConfirmed?: boolean;
}

export interface FrozenTerms {
  at: string;
  validUntil: string;
  chainId: number;
  tracContract: string;
  sellers: Record<string, FrozenSeller>;
  balances: { tracMicro: number; ethWei: string; gasEstimateWei: string; source: string; checkedAt: string } | null;
  /** Add-on purchases only: the running plan this line joins. */
  plan?: { planId: string; expiresAt: string };
}

export type PaymentLineState =
  | 'pending' | 'prompted' | 'submitted' | 'confirming' | 'confirmed' | 'misdirected' | 'rejected' | 'failed';

export interface IntentError {
  code: string;
  detail?: string;
  retryable: boolean;
  status?: number;
  seller?: string;
  diff?: TermsDiff[];
}

export interface EnrollmentRecord {
  state: 'pending' | 'enrolled' | 'blocked' | 'retry';
  at?: string;
  alreadyEnrolled?: boolean;
  error?: string | IntentError | null;
}

export interface PaymentRecord {
  state: PaymentLineState;
  promptedAt?: string;
  txHash?: string;
  logIndex?: number;
  blockNumber?: number;
  confirmations?: number;
  required?: number;
  identity?: string;
  reason?: 'dropped' | 'replaced' | string;
  attestAllowed?: boolean;
  attestBlockedReason?: string;
  revenueWalletConfirmed?: boolean;
  enrollment?: EnrollmentRecord;
}

export interface PurchaseIntent {
  id: string;
  kind: PurchaseKind;
  createdAt: string;
  updatedAt: string;
  state: PurchaseState;
  buyer: string | null;
  periodMs: number;
  lines: PurchaseLine[];
  /** Top-up and add-on purchases: the single line bought. */
  topUp: { planId: string | null; offeringId: string; seller: string; microTrac: number } | null;
  frozen: FrozenTerms | null;
  bindingStatement: string | null;
  payments: Record<string, PaymentRecord>;
  planId: string | null;
  error: IntentError | null;
  nextAction: NextAction;
  nextPaySeller: string | null;
  addedUnits?: number;
  revenueWalletUnpinned?: boolean | string[];
  revenueWalletConfirmations?: Record<string, { revenueWallet: string; at: string }>;
  acknowledged?: { reason: string; at: string } | null;
}

export interface TermsDiff { field: string; frozen: unknown; live: unknown }

/** Chain facts that accompany frozen terms. */
export interface ChainInfo { chainId: number; chainIdHex: string; name: string; walletRpcUrls: string[] }

/** The playground's "switch to another offering" choices. */
export interface ForkOption { offeringId: string; pctLeft: number }

/** Every state that is not final: the purchase can still move. */
export const OPEN_STATES = new Set<PurchaseState>([
  'draft', 'terms_frozen', 'binding_required', 'binding_signed', 'paying', 'payment_confirming',
  'payment_confirmed', 'plan_built', 'enrolling', 'wallet_rejected', 'payment_failed', 'enrollment_blocked',
]);

export const hasAnyTxHash = (i: PurchaseIntent): boolean =>
  Object.values(i.payments ?? {}).some((p) => typeof p.txHash === 'string' && p.txHash.length > 0);
