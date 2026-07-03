import { pcaAgentAccount, fetchPca } from '../api.js';
import { isPcaDead, hasPcaBudget } from './coverage.js';

// Pre-flight wallet-binding probe — READ-ONLY.
//
// Self-coverage collides with the one-wallet-one-PCA rule: `registerAgent` reverts
// `AgentAlreadyRegistered` if a wallet is already bound, and `deregisterAgent` is owner-gated.
// Before (and during) a create's self-coverage, we must know, per operational wallet, whether
// it is: UNBOUND (register freely), bound to a PCA THIS NODE OWNS (deregister-first, then
// register — hot→cold migration), or bound to a PCA the node CANNOT own (a sponsor's). A sponsor
// binding is "already discounted free" ONLY if that sponsor PCA actually COVERS — an
// EXPIRED/insolvent one doesn't (the agent mapping persists but publishing falls to direct cost),
// so it must NOT be skipped as free. A probe that can't be read is INCONCLUSIVE — never
// asserted as unbound/ownable/covered (it must not drive a destructive deregister or a false claim).

const eq = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

export type SignableOwnerKind = 'daemon' | 'wallet';
export type SignableOwner =
  | string
  | { address?: string | null; kind?: SignableOwnerKind };

function normalizeSignableOwners(input?: SignableOwner | SignableOwner[]): Array<{ address: string; kind: SignableOwnerKind }> {
  const items = Array.isArray(input) ? input : input != null ? [input] : [];
  return items.flatMap((item) => {
    if (typeof item === 'string') return item ? [{ address: item, kind: 'daemon' as const }] : [];
    return item.address ? [{ address: item.address, kind: item.kind ?? 'daemon' }] : [];
  });
}

export interface WalletBinding {
  wallet: string;
  /** The accountId this wallet is currently an approved agent on, or null when unbound. */
  boundTo: string | null;
  /** boundTo is owned by this node (owner == ownerWallet) → the daemon can deregister-first. */
  canOwn: boolean;
  /** Which available signer can free boundTo, when canOwn=true. */
  signerKind?: SignableOwnerKind;
  /** boundTo is LIVE (not expired/swept AND has budget), so the binding actually covers.
   *  Meaningful only when `boundTo != null`. A sponsor binding only counts as "already free" when
   *  this is true; a dead one is uncovered (and, being a sponsor's, unfreeable by this node). */
  boundLive: boolean;
  /** The probe failed to resolve (transport / adapter gap) — treat as "couldn't read", never
   *  asserted as covered/free. */
  inconclusive: boolean;
}

/** Resolve one wallet's current binding (read-only). Used per-wallet in the self-coverage loop. */
export async function resolveWalletBinding(wallet: string, ownerWallet?: SignableOwner | SignableOwner[]): Promise<WalletBinding> {
  const signableOwners = normalizeSignableOwners(ownerWallet);
  const acct = await pcaAgentAccount(wallet).catch(() => undefined);
  if (acct === undefined) return { wallet, boundTo: null, canOwn: false, boundLive: false, inconclusive: true };
  const boundTo = acct.accountId;
  if (boundTo == null) return { wallet, boundTo: null, canOwn: false, boundLive: false, inconclusive: false };
  // Bound — read the bound account's snapshot for ownership (the daemon signs with ownerWallet, so
  // it can only deregister from a PCA it owns) AND coverage state (expiry/solvency).
  const snap = await fetchPca(boundTo).catch(() => null);
  if (snap === null) return { wallet, boundTo, canOwn: false, boundLive: false, inconclusive: true };
  const signer = signableOwners.find((owner) => eq(snap.owner, owner.address));
  return {
    wallet,
    boundTo,
    canOwn: !!signer,
    signerKind: signer?.kind,
    boundLive: !isPcaDead(snap) && hasPcaBudget(snap),
    inconclusive: false,
  };
}

/** Probe every operational wallet's binding (read-only). Used at wizard-open for the preview. */
export async function probeWalletBindings(wallets: string[], ownerWallet?: SignableOwner | SignableOwner[]): Promise<WalletBinding[]> {
  return Promise.all(wallets.map((w) => resolveWalletBinding(w, ownerWallet)));
}

/**
 * The per-wallet self-coverage PLAN (classification only; the modal loop executes it). The single
 * source of self-coverage policy — the wizard preview and the wallet-managed signing branch both
 * derive from this rather than re-classifying.
 *  - `register` — unbound, OR inconclusive (fall through to register; the AgentAlreadyRegistered
 *    backstop resolves a still-bound wallet — never asserted off an unread probe).
 *  - `deregisterThenRegister` — bound to a PCA THIS NODE OWNS → free it first, then register.
 *  - `skipSponsored` — bound to a LIVE sponsor PCA → already discounted free; leave it.
 *  - `conflictSponsorDead` — bound to an EXPIRED/insolvent sponsor PCA → NOT covered, and the
 *    node can't free it (not the owner) → a distinct conflict (never the benign "already free" skip).
 */
export type SelfCoverageAction =
  | { kind: 'register' }
  | { kind: 'deregisterThenRegister'; prevAccountId: string }
  | { kind: 'skipSponsored'; prevAccountId: string }
  | { kind: 'conflictSponsorDead'; prevAccountId: string };

export function planSelfCoverage(b: WalletBinding): SelfCoverageAction {
  if (b.inconclusive || b.boundTo == null) return { kind: 'register' };
  if (b.canOwn) return { kind: 'deregisterThenRegister', prevAccountId: b.boundTo };
  // Sponsor-bound (not ownable): free only if the sponsor PCA actually covers.
  return b.boundLive
    ? { kind: 'skipSponsored', prevAccountId: b.boundTo }
    : { kind: 'conflictSponsorDead', prevAccountId: b.boundTo };
}

/**
 * Self-coverage outlook from a set of bindings (the wizard-open preview):
 *  - `selfCoverable` — wallets that CAN end up covered (unbound, or own-bound → deregister-first).
 *  - `ownBound` — bound to a PCA THIS NODE OWNS (deregister-first MOVE — must be disclosed).
 *  - `sponsorBound` — bound to a LIVE sponsor PCA (already discounted free → skipped).
 *  - `sponsorDead` — bound to an EXPIRED/insolvent sponsor PCA (uncovered + unfreeable).
 *  - `zeroSelfCoverage` — at least one wallet, NONE self-coverable, NONE inconclusive: the new PCA
 *    would discount NONE of this node's own publishes. Not a hard block (create-to-sponsor is valid)
 *    — drives a loud informed-consent warning.
 */
export function selfCoverageOutlook(bindings: WalletBinding[]): {
  selfCoverable: WalletBinding[];
  ownBound: WalletBinding[];
  sponsorBound: WalletBinding[];
  sponsorDead: WalletBinding[];
  inconclusive: WalletBinding[];
  zeroSelfCoverage: boolean;
} {
  // Derive the preview buckets FROM the single policy source (`planSelfCoverage`) — no parallel
  // re-classification. Group bindings by their planned action; the only sub-split the planner
  // intentionally collapses is unbound-vs-inconclusive (both → `register`), so we read the
  // binding's `inconclusive` flag to separate those two within that group.
  const planned = bindings.map((b) => ({ binding: b, kind: planSelfCoverage(b).kind }));
  const ofKind = (k: SelfCoverageAction['kind']) => planned.filter((p) => p.kind === k).map((p) => p.binding);

  const registerable = ofKind('register'); // unbound OR inconclusive (fall through to register)
  const inconclusive = registerable.filter((b) => b.inconclusive);
  const unbound = registerable.filter((b) => !b.inconclusive);
  const ownBound = ofKind('deregisterThenRegister'); // migrate (own-bound)
  const sponsorBound = ofKind('skipSponsored'); // already discounted free (live sponsor)
  const sponsorDead = ofKind('conflictSponsorDead'); // uncovered + unfreeable (dead sponsor)
  const selfCoverable = [...unbound, ...ownBound]; // can end up covered (register or migrate-then-register)
  const zeroSelfCoverage =
    bindings.length > 0 && selfCoverable.length === 0 && inconclusive.length === 0;
  return { selfCoverable, ownBound, sponsorBound, sponsorDead, inconclusive, zeroSelfCoverage };
}
