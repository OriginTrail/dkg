import { pcaAgentAccount, fetchPca } from '../api.js';

// B1 pre-flight wallet-binding probe (PLAN §9.5) — READ-ONLY.
//
// Self-coverage collides with one-wallet-one-PCA (invariant 5): `registerAgent` reverts
// `AgentAlreadyRegistered` if a wallet is already bound, and `deregisterAgent` is owner-gated.
// Before (and during) a create's self-coverage, we must know, per operational wallet, whether
// it is: UNBOUND (register freely), bound to a PCA THIS NODE OWNS (deregister-first, then
// register — hot→cold migration), or bound to a PCA the node CANNOT own (a sponsor's — skip,
// it's already discounted free). #9: a probe that can't be read is INCONCLUSIVE — never
// asserted as unbound/ownable (it must not drive a destructive deregister or a false claim).

const eq = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

export interface WalletBinding {
  wallet: string;
  /** The accountId this wallet is currently an approved agent on, or null when unbound. */
  boundTo: string | null;
  /** boundTo is owned by this node (owner == ownerWallet) → the daemon can deregister-first. */
  canOwn: boolean;
  /** The probe failed to resolve (transport / adapter gap) — treat as "couldn't read" (#9). */
  inconclusive: boolean;
}

/** Resolve one wallet's current binding (read-only). Used per-wallet in the self-coverage loop. */
export async function resolveWalletBinding(wallet: string, ownerWallet?: string): Promise<WalletBinding> {
  const acct = await pcaAgentAccount(wallet).catch(() => undefined);
  if (acct === undefined) return { wallet, boundTo: null, canOwn: false, inconclusive: true };
  const boundTo = acct.accountId;
  if (boundTo == null) return { wallet, boundTo: null, canOwn: false, inconclusive: false };
  // Bound — determine ownability from the bound account's owner (the daemon signs with
  // ownerWallet, so it can only deregister from a PCA whose owner == ownerWallet).
  const snap = await fetchPca(boundTo).catch(() => null);
  if (snap === null) return { wallet, boundTo, canOwn: false, inconclusive: true };
  return { wallet, boundTo, canOwn: eq(snap.owner, ownerWallet), inconclusive: false };
}

/** Probe every operational wallet's binding (read-only). Used at wizard-open for the B1 preview. */
export async function probeWalletBindings(wallets: string[], ownerWallet?: string): Promise<WalletBinding[]> {
  return Promise.all(wallets.map((w) => resolveWalletBinding(w, ownerWallet)));
}

/**
 * Self-coverage outlook from a set of bindings:
 *  - `selfCoverable` — wallets that CAN end up covered (unbound, or own-bound → deregister-first).
 *  - `sponsorBound`  — bound to a PCA the node can't own (already discounted free → skipped).
 *  - `zeroSelfCoverage` — at least one wallet, NONE self-coverable, NONE inconclusive (every wallet
 *    is sponsor-bound): the new PCA would discount NONE of this node's own publishes. Not a hard
 *    block (a node may create purely to sponsor others) — drives a loud informed-consent warning.
 */
export function selfCoverageOutlook(bindings: WalletBinding[]): {
  selfCoverable: WalletBinding[];
  sponsorBound: WalletBinding[];
  inconclusive: WalletBinding[];
  zeroSelfCoverage: boolean;
} {
  const selfCoverable = bindings.filter((b) => !b.inconclusive && (b.boundTo == null || b.canOwn));
  const sponsorBound = bindings.filter((b) => !b.inconclusive && b.boundTo != null && !b.canOwn);
  const inconclusive = bindings.filter((b) => b.inconclusive);
  const zeroSelfCoverage =
    bindings.length > 0 && selfCoverable.length === 0 && inconclusive.length === 0;
  return { selfCoverable, sponsorBound, inconclusive, zeroSelfCoverage };
}
