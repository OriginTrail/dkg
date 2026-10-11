// SPDX-License-Identifier: Apache-2.0
import { normalizeAuthoritativeContextGraphId } from '../context-graph-binding-state.js';

export interface CgMetaState {
  seqno: number;
  registered: boolean;
  contextGraphId: string;
  /**
   * OT-RFC-38 LU-6 B3 — true when the agent has actively engaged
   * host-mode for this CG (subscribed to its SWM gossip topic in
   * opaque-ciphertext mode). Persisted so a restart can re-engage
   * the gossip handler before the chain-event poller catches up
   * (chain events outside the lookback window would otherwise be
   * silently lost, stranding hosted CGs without an apply path).
   *
   * Distinct from `registered` (which tracks on-chain registration
   * for limits + rate-limit purposes). A CG can be host-mode
   * subscribed but unregistered (pre-registration auto-host via
   * beacon) and vice-versa (registered but the curator revoked
   * this core via off-protocol means — the next reconcile loop
   * will clear `hostModeSubscribed`).
   */
  hostModeSubscribed?: boolean;
  /**
   * Numeric chain id captured when host mode was engaged. Host-only cores can
   * know a graph solely by its wire hash; retaining this binding lets a cold
   * restart re-check the public/open policy without replaying an old creation
   * event or inventing a cleartext graph id.
   */
  hostModeOnChainId?: string;
  /** Independent of active subscription hints; unsubscribe does not change retained custody. */
  retainedOnChainId?: string;
  /** Entries at or below this cursor belong to an earlier/unknown authority binding. */
  retainedBindingStartSeqno?: number;
}


/** A new authority never inherits entries retained under an earlier or unproven binding. */
export function nextHostModeBinding(meta: CgMetaState, options: { onChainId?: string }): CgMetaState {
  const bindingSpecified = Object.prototype.hasOwnProperty.call(options, 'onChainId');
  const onChainId = normalizeAuthoritativeContextGraphId(options.onChainId);
  if (meta.hostModeSubscribed === true && (!bindingSpecified
    || (meta.hostModeOnChainId === onChainId && meta.retainedOnChainId === onChainId && meta.retainedBindingStartSeqno !== undefined))) return meta;
  const next = { ...meta, hostModeSubscribed: true };
  if (bindingSpecified) {
    if (meta.retainedOnChainId !== onChainId || meta.retainedBindingStartSeqno === undefined) {
      // Unknown pre-registration history may remain privately readable; it never proves a public binding.
      next.retainedBindingStartSeqno = onChainId === undefined && meta.retainedOnChainId === undefined ? 0 : meta.seqno;
    }
    if (onChainId === undefined) delete next.retainedOnChainId;
    else next.retainedOnChainId = onChainId;
    if (onChainId === undefined) delete next.hostModeOnChainId;
    else next.hostModeOnChainId = onChainId;
  }
  return next;
}
