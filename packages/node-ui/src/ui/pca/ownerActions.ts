import { createPca, pcaAddAgent, pcaRemoveAgent, pcaTopUp, pcaSettle } from '../api.js';

/**
 * OWNER-ACTION SEAM (plan §2.3 — forward-compat for the §9 hardware/external-wallet
 * feature, folded into P0 while these call sites are the only ones).
 *
 * Every PCA owner-WRITE — create / approve (registerAgent) / deregister / top-up /
 * settle — routes through this ONE indirection. The future §9 feature signs PCA
 * owner-writes CLIENT-SIDE for wallet-owned accounts; with the seam in place that
 * becomes a contained add-on (a second submitter + a real resolver) with ZERO
 * call-site changes.
 *
 * READS (fetchPca, agents, enumeration) deliberately do NOT route through here —
 * only owner-writes.
 *
 * Method types are `typeof` the existing api.ts helpers, so the wire calls are
 * byte-identical to calling them directly (pure indirection in P0).
 */
export interface OwnerActionSubmitter {
  create: typeof createPca;
  registerAgent: typeof pcaAddAgent;
  deregisterAgent: typeof pcaRemoveAgent;
  topUp: typeof pcaTopUp;
  settle: typeof pcaSettle;
}

/**
 * The P0 submitter: the daemon EOA signs every owner-write (it owns the PCA when
 * the owner is the node's primary operational wallet). Thin delegation — each
 * method IS the existing api.ts helper, so behavior is byte-identical.
 */
export const daemonOwnerActionSubmitter: OwnerActionSubmitter = {
  create: createPca,
  registerAgent: pcaAddAgent,
  deregisterAgent: pcaRemoveAgent,
  topUp: pcaTopUp,
  settle: pcaSettle,
};

/**
 * Resolve the owner-action submitter for a specific PCA, keyed PER-PCA by
 * `accountId` (NOT a global mode) so node-managed and wallet-managed PCAs can
 * coexist in one list.
 *
 * P0 ALWAYS returns the daemon submitter regardless of `accountId`. §9 will
 * resolve here by the PCA's owner — the daemon for a `wallets[0]`-owned PCA, the
 * connected external/hardware wallet for a wallet-owned PCA, a read-only/no-op
 * submitter otherwise. Because every owner-write call site already passes its
 * `accountId`, that future change lands with zero call-site churn.
 */
export function useOwnerActionSubmitter(accountId?: string): OwnerActionSubmitter {
  // P0: single daemon submitter. `accountId` is the §9 resolution key (unused here).
  void accountId;
  return daemonOwnerActionSubmitter;
}
