/**
 * Phase B — per-CG VM reconciliation cursor (contiguous watermark + reorg depth).
 *
 * The cursor key is the **per-CG registration ordinal** (resolved by the B.0
 * spike): `getContextGraphKCCount(cgId)` is the chain-head ordinal, and
 * `getContextGraphKCAt(cgId, i)` maps ordinal `i` (0-based) to a kaId. Ordinals
 * are dense, monotonic, and comparable — so the cursor is plain integer math,
 * no merkle-hash ordering anywhere.
 *
 * Two invariants this module enforces (both are correctness bugs if violated):
 *
 *   1. **No gap is ever permanently skipped.** Events and active fetches can
 *      complete out of order — ordinal 45 might promote before 44's payload is
 *      available. We must NOT advance the watermark past 44 while 44 is still
 *      missing, or 44 is skipped forever. So the watermark only advances over a
 *      *contiguous* run; out-of-order completions wait in `ahead` until the gap
 *      below them fills.
 *
 *   2. **Reorg safety.** Base/Sepolia can reorg shallowly. Promotion itself is
 *      verified against chain at the time and may happen eagerly, but the
 *      *watermark advance* waits until the completed ordinal's registration
 *      block is buried by `confirmationDepth`. A reorg that drops a shallow
 *      registration therefore just means the sweep re-checks that ordinal — the
 *      cursor never strands ahead of canonical state.
 *
 * Semantics: `watermark === N` means ordinals `[0, N)` are durably in VM, and
 * `N` is the next ordinal to reconcile. The chain-head ordinal is the CG's KC
 * count, so the gap to reconcile is `[watermark, head)`.
 *
 * Pure + side-effect-free so the watermark logic is unit-testable without a
 * chain / libp2p / store harness. The agent owns persistence (it writes the
 * watermark to SQLite only when it changes) and the in-memory `ahead` map.
 */

export interface CursorState {
  /**
   * Contiguous watermark: ordinals `[0, watermark)` are durably promoted to
   * VM. Persisted (survives restarts) — this is `ContextGraphSub.lastReconciledOrdinal`.
   */
  watermark: number;
  /**
   * Completed-but-not-yet-absorbed ordinals above the watermark, mapped to the
   * chain block their registration was observed at. An ordinal stays here when
   * it completed out of order (a lower ordinal is still missing) OR when it is
   * not yet buried by `confirmationDepth`. In-memory only — on restart the
   * sweep re-derives everything from chain + the persisted watermark.
   */
  ahead: Map<number, number>;
  /**
   * Per-ordinal skip-backoff: ordinals that keep returning `pending`/`skip`
   * (no local SWM snapshot yet, or a transient chain-read failure) mapped to
   * `{ untilMs, attempts }`. Without this, a never-matching ordinal (e.g. a KA
   * whose SWM this node never received) is re-attempted on EVERY sweep, each
   * attempt re-running the expensive finalization SWM search — the reconcile
   * storm in #1609. This is purely an attempt-rate limiter: it NEVER advances or
   * blocks the watermark, so invariant 1 (no gap permanently skipped) is
   * untouched — a backed-off ordinal is still `[watermark, head)`, just probed
   * less often. In-memory only (a restart re-derives it with one extra attempt).
   */
  backoff: Map<number, { untilMs: number; attempts: number }>;
}

/** A reconciled ordinal plus the chain block its registration was observed at. */
export interface CompletedOrdinal {
  ordinal: number;
  blockNumber: number;
}

export function createCursorState(watermark = 0): CursorState {
  return { watermark: Math.max(0, watermark), ahead: new Map(), backoff: new Map() };
}

// Exponential, capped skip-backoff schedule. First skip → 30s, then ×2 up to a
// 15-min ceiling. Early windows stay short so a KA whose SWM merely lags the
// chain event still materialises within a few minutes; the ceiling is what
// tames a permanently-never-matching ordinal (probed ~every 15 min instead of
// every sweep). The reconcile sweep is a backstop — a bounded materialisation
// delay for a late-synced KA is acceptable (the primary path materialises when
// the SWM is already present on the first attempt).
export const RECONCILE_BACKOFF_BASE_MS = 30_000;
export const RECONCILE_BACKOFF_FACTOR = 2;
export const RECONCILE_BACKOFF_CAP_MS = 900_000;

/** True if `ordinal` is inside an active backoff window (skip it this pass). */
export function isOrdinalBackedOff(state: CursorState, ordinal: number, nowMs: number): boolean {
  const entry = state.backoff.get(ordinal);
  return entry !== undefined && entry.untilMs > nowMs;
}

/** Record a not-actionable outcome for `ordinal`, growing its backoff window. */
export function recordOrdinalBackoff(state: CursorState, ordinal: number, nowMs: number): void {
  const attempts = (state.backoff.get(ordinal)?.attempts ?? 0) + 1;
  const delay = Math.min(
    RECONCILE_BACKOFF_BASE_MS * RECONCILE_BACKOFF_FACTOR ** (attempts - 1),
    RECONCILE_BACKOFF_CAP_MS,
  );
  state.backoff.set(ordinal, { untilMs: nowMs + delay, attempts });
}

/** Clear an ordinal's backoff (it reconciled — no longer a retry candidate). */
export function clearOrdinalBackoff(state: CursorState, ordinal: number): void {
  state.backoff.delete(ordinal);
}

/**
 * Absorb as many consecutive completed ordinals into the watermark as the
 * contiguity + confirmation-depth rules allow. Returns the (possibly advanced)
 * watermark. Idempotent — safe to call on every sweep tick so depth-held
 * ordinals get absorbed as the chain head advances, even without new
 * completions.
 *
 * `chainHeadBlock` is the current chain head; an ordinal is buried deeply
 * enough when `chainHeadBlock - registrationBlock >= confirmationDepth`. A
 * non-positive `confirmationDepth` disables the reorg gate (absorb as soon as
 * contiguous) — useful for chains that can't reorg (mock / no-chain).
 */
export function absorbConfirmed(
  state: CursorState,
  chainHeadBlock: number,
  confirmationDepth: number,
): number {
  while (state.ahead.has(state.watermark)) {
    const registrationBlock = state.ahead.get(state.watermark)!;
    if (confirmationDepth > 0 && chainHeadBlock - registrationBlock < confirmationDepth) {
      // Next contiguous ordinal is reconciled but not yet buried deeply
      // enough — stop here; a later tick (higher head) will absorb it.
      break;
    }
    state.ahead.delete(state.watermark);
    state.watermark += 1;
  }
  return state.watermark;
}

/**
 * Record a successful reconciliation of `completed` and absorb as far as the
 * rules allow. Returns the new watermark; the caller persists iff it changed
 * (compare against the value before the call).
 */
export function recordCompletion(
  state: CursorState,
  completed: CompletedOrdinal,
  chainHeadBlock: number,
  confirmationDepth: number,
): number {
  // Already absorbed (a duplicate/late event for an ordinal below the
  // watermark) — nothing to do.
  if (completed.ordinal < state.watermark) return state.watermark;
  state.ahead.set(completed.ordinal, completed.blockNumber);
  return absorbConfirmed(state, chainHeadBlock, confirmationDepth);
}

/**
 * The ordinals the sweep still needs to reconcile: `[watermark, head)` minus
 * the ones already completed and waiting in `ahead` (those are reconciled —
 * they're just held back from the watermark by the confirmation-depth or a
 * lower gap, and re-fetching them would be wasted work). Ascending order so
 * the watermark fills bottom-up.
 */
export function ordinalsToReconcile(state: CursorState, headOrdinal: number): number[] {
  const out: number[] = [];
  for (let i = state.watermark; i < headOrdinal; i += 1) {
    if (!state.ahead.has(i)) out.push(i);
  }
  return out;
}
