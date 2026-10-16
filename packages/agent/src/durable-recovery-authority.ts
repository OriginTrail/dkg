import type { ChainAdapter } from '@origintrail-official/dkg-chain';
import type { RegisteredContextGraphAuthority } from './registered-context-graph-authority.js';
import { authenticateDurableGraphScopedAsset } from './durable-recovery-authentication.js';
import type { partitionVerifiedGraphScopedAssets } from './sync/requester/verified-asset-preparation.js';
import type { VmRecoveryRegisteredPublicEvidence } from "./vm-recovery-pass-authority.js";
import type { AuthenticatedGraphScopedAsset, VerifiedGraphScopedAsset } from './sync/requester/graph-scoped-materialization.js';

/** One policy owns public transport admission and authentication of recovered assets.
 * Exchange policy retains VM-pass freshness/revocation; a snapshot job is pinned
 * to its observation and ownership, and is never disguised as revocable VM evidence.
 */
export interface DurableRecoveryAuthority {
  admitVerifiedPage(page: ReturnType<typeof partitionVerifiedGraphScopedAssets>): void;
  readonly coalescing: 'allowed' | 'owner-only';
  isRegisteredPublic(contextGraphId: string, signal?: AbortSignal): boolean | Promise<boolean>;
  authenticate(asset: VerifiedGraphScopedAsset, deadline: number, signal?: AbortSignal):
    AuthenticatedGraphScopedAsset | Promise<AuthenticatedGraphScopedAsset>;
}

/** Public compatibility evidence; authentication strategies remain internal. */
export interface DurableRecoveryInput { registeredPublicEvidence?: VmRecoveryRegisteredPublicEvidence }

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

export interface RecoveryAuthorityDependencies {
  readonly chain: ChainAdapter;
  verifyContextGraphBinding(id: string, onChainId: string, signal?: AbortSignal): Promise<boolean>;
  resolveAuthority(id: string, signal?: AbortSignal): Promise<RegisteredContextGraphAuthority>;
  warn(message: string): void;
}

/** Construct an exchange-owned policy without exposing lifecycle internals on DKGAgent. */
export function createRecoveryAuthority(
  dependencies: RecoveryAuthorityDependencies, input: DurableRecoveryInput = {},
): DurableRecoveryAuthority {
  const evidence = input.registeredPublicEvidence;
  const verifyContextGraphBinding = memoizeRecoveryBindingProof(dependencies.verifyContextGraphBinding);
  return {
    admitVerifiedPage() { /* Ordinary exchanges preserve verified legacy compatibility. */ },
    coalescing: evidence ? 'owner-only' : 'allowed',
    isRegisteredPublic: async (id, signal) => evidence?.usableFor(id, signal) === true
      || (await dependencies.resolveAuthority(id, signal)).kind === 'public',
    authenticate: (asset, deadline, signal) => authenticateDurableGraphScopedAsset({
      chain: dependencies.chain, asset, verifyContextGraphBinding, deadline, signal,
      onRetry: (error, attempt, maxAttempts) => dependencies.warn(
        `Retrying graph-scoped durable authentication for ${asset.ual} `
        + `after transient chain verification failure (${attempt}/${maxAttempts}): `
        + `${error instanceof Error ? error.message : String(error)}`),
    }),
  };
}
