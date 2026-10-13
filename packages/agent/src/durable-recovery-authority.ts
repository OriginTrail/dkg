import type { VmRecoveryRegisteredPublicEvidence } from "./vm-recovery-pass-authority.js";
import type { AuthenticatedGraphScopedAsset, VerifiedGraphScopedAsset } from './sync/requester/graph-scoped-materialization.js';

/** One policy owns public transport admission and authentication of recovered assets.
 * Exchange policy retains VM-pass freshness/revocation; a snapshot job is pinned
 * to its observation and ownership, and is never disguised as revocable VM evidence.
 */
export interface DurableRecoveryAuthority {
  readonly lifetime: 'exchange' | 'snapshot-job';
  readonly coalescing: 'allowed' | 'owner-only';
  isRegisteredPublic(contextGraphId: string, signal?: AbortSignal): boolean | Promise<boolean>;
  authenticate(asset: VerifiedGraphScopedAsset, deadline: number, signal?: AbortSignal):
    AuthenticatedGraphScopedAsset | Promise<AuthenticatedGraphScopedAsset>;
}

/** Compatibility is accepted only at caller entry points, never as competing internal policies. */
export type DurableRecoveryInput =
  | { recoveryAuthority: DurableRecoveryAuthority; registeredPublicEvidence?: never }
  | { recoveryAuthority?: never; registeredPublicEvidence?: VmRecoveryRegisteredPublicEvidence };

/** Successful immutable name bindings can be shared within one exchange; failures must be fresh. */
export function memoizeRecoveryBindingProof(
  verify: (id: string, onChainId: string, signal?: AbortSignal) => Promise<boolean>,
): (id: string, onChainId: bigint, signal?: AbortSignal) => Promise<boolean> {
  const proofs = new Map<string, Promise<boolean>>();
  return async (id, onChainId, signal) => {
    const key = `${id}\0${onChainId}`;
    let proof = proofs.get(key);
    if (!proof) { proof = verify(id, onChainId.toString(), signal); proofs.set(key, proof); }
    try {
      const matches = await proof;
      if (!matches && proofs.get(key) === proof) proofs.delete(key);
      return matches;
    } catch (error) {
      if (proofs.get(key) === proof) proofs.delete(key);
      throw error;
    }
  };
}
