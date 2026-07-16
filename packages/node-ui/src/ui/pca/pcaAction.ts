import { useState, type Dispatch, type SetStateAction } from 'react';

/**
 * Shared owner-action feedback state for the PCA detail view (top-up / remove).
 * `busy`/`error`/`result` are the base states; `warning` is the W2 extension.
 */
export interface ActionState {
  busy: boolean;
  error: string | null;
  result: { txHash?: string; message: string } | null;
  /**
   * W2 — an ambiguous-broadcast warning (e.g. a top-up 504 carrying a txHash): the tx
   * MAY be on-chain, so we surface it role=alert with the tx + a recheck, NOT a benign
   * "try again" that would invite a second fund-locking submit.
   */
  warning?: { txHash?: string; message: string } | null;
}

export const IDLE: ActionState = { busy: false, error: null, result: null };

/** `useState` for a PCA owner-action feedback state, seeded to IDLE (fund / remove). */
export function usePcaAction(): [ActionState, Dispatch<SetStateAction<ActionState>>] {
  return useState<ActionState>(IDLE);
}
