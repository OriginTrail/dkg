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
   * observed registration block plus optional asset metadata. An ordinal stays
   * here when it completed out of order (a lower ordinal is still missing) OR
   * when it is not yet buried by `confirmationDepth`. In-memory only — on
   * restart the sweep re-derives everything from chain + the persisted watermark.
   */
  ahead: Map<number, HeldCompletion>;
}

/** A reconciled ordinal plus the chain block its registration was observed at. */
export interface CompletedOrdinal {
  ordinal: number;
  blockNumber: number;
  assetUal?: string;
  kaId?: string;
}

export interface HeldCompletion {
  blockNumber: number;
  assetUal?: string;
  kaId?: string;
}

export function createCursorState(watermark = 0): CursorState {
  return { watermark: Math.max(0, watermark), ahead: new Map() };
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
  onAbsorbed?: (completed: CompletedOrdinal) => void,
): number {
  while (state.ahead.has(state.watermark)) {
    const ordinal = state.watermark;
    const held = state.ahead.get(ordinal)!;
    const registrationBlock = held.blockNumber;
    if (confirmationDepth > 0 && chainHeadBlock - registrationBlock < confirmationDepth) {
      // Next contiguous ordinal is reconciled but not yet buried deeply
      // enough — stop here; a later tick (higher head) will absorb it.
      break;
    }
    state.ahead.delete(ordinal);
    state.watermark += 1;
    onAbsorbed?.({
      ordinal,
      blockNumber: held.blockNumber,
      ...(held.assetUal ? { assetUal: held.assetUal } : {}),
      ...(held.kaId ? { kaId: held.kaId } : {}),
    });
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
  onAbsorbed?: (completed: CompletedOrdinal) => void,
): number {
  // Already absorbed (a duplicate/late event for an ordinal below the
  // watermark) — nothing to do.
  if (completed.ordinal < state.watermark) return state.watermark;
  state.ahead.set(completed.ordinal, {
    blockNumber: completed.blockNumber,
    ...(completed.assetUal ? { assetUal: completed.assetUal } : {}),
    ...(completed.kaId ? { kaId: completed.kaId } : {}),
  });
  return absorbConfirmed(state, chainHeadBlock, confirmationDepth, onAbsorbed);
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
